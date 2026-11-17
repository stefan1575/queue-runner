"""Live steps after merges (ticket 11; `docs/flow.md`, Merge), in the Claude lane.

A repo whose `config.toml` entry names a `live_doc` (leads-dashboard: `docs/agents/lovable-cloud.md`)
needs an AI to make a merge live: the Lovable connector's `deploy_project`, `query_database` for each
migration, then `npm run check:live-schema`. The runner starts one Claude thread per batch: every PR
merged into the base since the last live run. It waits until no other merge is about to land (no
open merge, review or fix job in the repo, and no open PR that's clean on its head and merging, or
waiting only for its checks), so chained migrations go live in order. Cost over speed.

The runner's state is the job log (kind `live`): `sha` where the last live run reached, `head` the
base's commit this run brings live, and at the end `applied` (the migrations its thread applied)
and `prs`. A run that went live moves the reach to `head`. One that didn't keeps it, and the
migrations it applied are left out of the next run's list, so a restart neither repeats nor skips
one; a run that ended with no readable answer (or on a usage limit) marks its batch's migrations
as maybe applied, for the next thread to check first. On first sight of a repo the runner records
`assumed`: everything up to the base's head now counts as live (the steps before the runner were
Stefan's).

The thread answers in a fixed block, ```` ```queue-runner-live ````: `live`, `partial` (with what
failed) or `stop` (with the question). Anything but `live`, or an answer the runner can't read,
files a `needs-info` stop (`live`) on the batch's newest PR, and no live run starts in that repo
until Stefan answers it (closes its issue or replies) or releases that PR. `live` comments on each
PR of the batch; steps it lists for Stefan (`stefan`) file a `live-todo` stop that holds nothing.
Merged and live are reported apart: the merge pass says merged, this says live.
"""
import datetime
import json
import re
from dataclasses import dataclass, field
from importlib import resources
from string import Template

from .ledger import RUNNER_MARK, said_since
from .state import NOT_STARTED, USAGE_LIMIT, Job, JobLog, when
from .stops import number_of, positions, utc
from .t3 import T3Error

VERSION = 1
FENCE = re.compile(r'^[ \t]*```+[ \t]*queue-runner-live[ \t]*\r?\n(.*?)^[ \t]*```+[ \t]*$',
                   re.M | re.S)
RESULTS = ('live', 'partial', 'stop')
ASSUMED = 'assumed'     # first sight: what's on the base now counts as live
LIVE = 'live'
FAILED = 'failed'       # the thread failed, or its answer can't be read
NEEDS_STEFAN = ('partial', 'stop', FAILED)   # outcomes that file a `live` stop
UNSURE = (FAILED, USAGE_LIMIT)               # outcomes whose thread may have applied some
PR_SUBJECT = re.compile(r'^Merge pull request #(\d+)\b|\(#(\d+)\)\s*$')
CLIP = 3000
EXAMPLE = {'version': VERSION, 'result': 'live',
           'applied': ['supabase/migrations/20261106035800_callsling_fill_in.sql'],
           'stefan': [], 'notes': 'deployment 01J...; check:live-schema passed'}


def live_title(repo) -> str:
    return f'Queue runner live: {repo.name}'


def live_branch(target: str, job_id: str) -> str:
    """The thread's local branch: never pushed, removed with its worktree."""
    return f'claude/live-{target[:7]}-{job_id[-6:]}'


def _clip(text: str | None, n: int = CLIP) -> str:
    text = (text or '').strip()
    return text if len(text) <= n else text[:n] + f'\n[... {len(text) - n} more characters]'


# --- the answer ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Answer:
    result: str                 # live, partial, stop; FAILED when it can't be read
    applied: tuple = ()
    stefan: tuple = ()
    text: str = ''              # partial: what failed; stop: the question; FAILED: why
    notes: str = ''


def unreadable(why: str, applied=()) -> Answer:
    return Answer(FAILED, tuple(applied), text=why)


def parse(reply: str | None, pending) -> Answer:
    """The last `queue-runner-live` block of the reply. `live` must have applied every pending
    migration, else it's read as `partial`; an applied file not in `pending` makes it unreadable."""
    blocks = FENCE.findall(reply or '')
    if not blocks:
        return unreadable('its reply has no queue-runner-live block')
    try:
        raw = json.loads(blocks[-1])
    except ValueError as e:
        return unreadable(f'its block is not JSON ({e})')
    if not isinstance(raw, dict):
        return unreadable('its block is not a JSON object')
    if raw.get('version') != VERSION:
        return unreadable(f'version {raw.get("version")!r}, not {VERSION}')
    applied, stefan = raw.get('applied'), raw.get('stefan', [])
    if not isinstance(applied, list) or not all(isinstance(a, str) for a in applied):
        return unreadable('"applied" is not a list of file names')
    applied = [a.strip().replace('\\', '/') for a in applied if a.strip()]
    if not isinstance(stefan, list) or not all(isinstance(a, str) for a in stefan):
        return unreadable('"stefan" is not a list of sentences', applied)
    stefan = tuple(s.strip() for s in stefan if s.strip())
    if extra := [a for a in applied if a not in pending]:
        return unreadable(f'it says it applied {", ".join(extra)}, which this run did not list '
                          'to apply', [a for a in applied if a in pending])
    result, notes = raw.get('result'), raw.get('notes')
    notes = notes.strip() if isinstance(notes, str) else ''
    if result not in RESULTS:
        return unreadable(f'result {result!r} is not one of {", ".join(RESULTS)}', applied)
    if result == 'live':
        if missing := [p for p in pending if p not in applied]:
            return Answer('partial', tuple(applied), stefan,
                          'it said live, but did not apply ' + ', '.join(missing), notes)
        return Answer('live', tuple(applied), stefan, '', notes)
    key = 'failed' if result == 'partial' else 'question'
    text = raw.get(key)
    if not isinstance(text, str) or not text.strip():
        return unreadable(f'{result} needs a non-empty "{key}"', applied)
    return Answer(result, tuple(applied), stefan, text.strip(), notes)


# --- the batch ----------------------------------------------------------------------------------

@dataclass(frozen=True)
class Batch:
    start: str                  # where the last live run reached
    target: str                 # the base's commit this run brings live
    prs: tuple                  # PR numbers merged in start..target, oldest first
    commits: tuple              # first-parent commits: ({sha, subject}, ...)
    pending: tuple              # migrations to apply, in order
    applied: tuple = ()         # migrations of this batch an earlier run applied
    unsure: tuple = ()          # (links of) earlier runs that may have applied some
    changed: tuple = ()         # migrations changed or deleted after reaching the base
    functions: tuple = ()       # edge functions changed
    last_link: str | None = None


def pr_numbers(commits) -> list[int]:
    found = []
    for c in commits:
        if m := PR_SUBJECT.search(c['subject']):
            n = int(m.group(1) or m.group(2))
            if n not in found:
                found.append(n)
    return found


class LiveSteps:
    def __init__(self, config, *, github, git, t3, jobs: JobLog, say, stopper, merger,
                 limit=None, find_thread=None, now=None, effort=None):
        self.config, self.github, self.git, self.t3, self.jobs = config, github, git, t3, jobs
        from .effort import Effort   # ticket 39: how its thread starts, its effort read back
        self.effort = effort or Effort(config)
        self.say, self.stopper, self.merger = say, stopper, merger
        self.limit = limit or (lambda *a: None)          # Runner._limit: a usage-limit stop
        self.find_thread = find_thread                   # Runner._find_thread
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self._last_why: dict[str, str | None] = {}
        self.wait_until: datetime.datetime | None = None   # a live run's usage-limit resume

    def served(self):
        """The repos whose live steps run, in config.toml's order; a repo Stefan stopped has none
        (`config.working`, ticket 37)."""
        from .config import working
        return [r for r in working(self.config) if r.live_doc and r.github]

    # --- where the last run reached ------------------------------------------------------------

    def reach(self, repo, before: Job | None = None):
        """(the newest live or assumed job, the live jobs after it): before `before`, if given."""
        lives = self.jobs.live(repo.name)
        if before is not None:
            lives = lives[:next(i for i, j in enumerate(lives) if j.id == before.id)]
        base = next((i for i in range(len(lives) - 1, -1, -1)
                     if lives[i].outcome in (LIVE, ASSUMED)), None)
        if base is None:
            return None, lives
        return lives[base], lives[base + 1:]

    def make_batch(self, repo, start: str, target: str, before: Job | None = None,
                   last: Job | None = None, since=()) -> Batch:
        """The batch start..target, from git and the job log."""
        commits = self.git.first_parent(repo.path, start, target)
        mig = repo.live_migrations.strip('/') + '/'
        fun = repo.live_functions.strip('/') + '/'
        added, changed, functions = [], [], []
        for status, path in self.git.name_status(repo.path, start, target):
            path = path.replace('\\', '/')
            if path.startswith(mig) and path.endswith('.sql'):
                (added if status == 'A' else changed).append(path)
            elif path.startswith(fun) and '/' in path[len(fun):]:
                name = path[len(fun):].split('/', 1)[0]
                if name not in functions and not name.startswith('_'):
                    functions.append(name)
        applied = [a for j in since for a in j.applied if a in added]
        for j in since:   # applied at j.head, then edited by a later merge: the repo forbids it
            if j.applied and j.head and j.head != target:
                edited = {p.replace('\\', '/') for s, p in
                          self.git.name_status(repo.path, j.head, target) if s != 'A'}
                changed += [a for a in j.applied if a in edited and a not in changed]
        unsure = tuple(j.link or j.id for j in since if j.outcome in UNSURE)
        return Batch(start=start, target=target, prs=tuple(pr_numbers(commits)),
                     commits=tuple(commits), pending=tuple(a for a in sorted(added)
                                                           if a not in applied),
                     applied=tuple(dict.fromkeys(applied)), unsure=unsure,
                     changed=tuple(sorted(changed)), functions=tuple(sorted(functions)),
                     last_link=last.link if last else None)

    # --- whether a run starts now --------------------------------------------------------------

    def about_to_land(self, repo) -> str | None:
        """Why another merge may land soon in this repo, or None. From the job log and GitHub."""
        for j in self.jobs.open_jobs():
            if j.repo == repo.name and j.kind in ('merge', 'review', 'fix'):
                what = {'merge': 'a merge of', 'review': 'Sol is reviewing',
                        'fix': 'a fix round is running on'}[j.kind]
                return f'{what} #{j.issue}'
        if repo.stefan_merges:   # when Stefan merges a ready PR is his call: the batch goes on
            return None
        for pr in sorted(self.github.open_pulls(repo), key=lambda p: p.number):
            if not self.merger.clean_on_head(repo, pr):
                continue
            why = self.merger.why_not(repo, pr.number, pr.head_sha)
            if why is None:
                return f'#{pr.number} is clean and merging'
            if (self.github.checks(repo, pr.head_sha).state in ('pending', 'none')
                    and self.merger.why_not(repo, pr.number, pr.head_sha, checks=False) is None):
                return f'#{pr.number} is clean, waiting for its checks'
        return None

    def held(self, repo) -> str | None:
        """Why the repo's live runs wait for Stefan or a limit, or None. Files a `live` stop
        that a run needed and didn't get filed."""
        lives = self.jobs.live(repo.name)
        last = next((j for j in reversed(lives) if j.outcome != NOT_STARTED), None)
        if last is None or last.outcome in (LIVE, ASSUMED):
            return None
        if last.open:
            return f'the live run {last.id} is still open'
        if last.outcome == USAGE_LIMIT:
            at = when(last.resume_at) if last.resume_at else None
            if at and self.now() < at:
                self.wait_until = min(filter(None, (self.wait_until, at)))
                return (f'the last live run was cut off by a usage limit; again after '
                        f'{at.astimezone():%Y-%m-%d %H:%M}')
            return None
        if last.outcome not in NEEDS_STEFAN:
            return None
        if last.id not in {j.id for j in self.jobs.live(repo.name, released=False)}:
            return None   # Stefan released the batch's PR
        pos = positions(self.jobs)
        stops = [s for s in self.jobs.on('stop', repo.name, last.issue)
                 if s.stop == 'live' and pos[s.id] > pos[last.id]]
        if any(s.outcome == 'answered' for s in stops):
            return None
        if filed := next((s for s in stops if s.outcome == 'filed'), None):
            return (f'waiting for Stefan on {filed.link} (close it, reply, or --release '
                    f'{repo.name}#{last.issue})')
        self._stop(repo, last, last.reason or f'the live run ended {last.outcome}')
        return f'the live run ended {last.outcome}: stopped for Stefan'

    def batch(self, repo, record: bool = True) -> Batch | None:
        """This repo's batch, if its live steps should run now; None (saying why, once) if not.
        On first sight, records the base's head as `assumed` live (unless `record` is False)."""
        if self.reach(repo)[0] is None:
            # First, before anything may hold it: a merge after this point is a live run's.
            target = self.target(repo)
            if record:
                job = self.jobs.started(kind='live', repo=repo.name, issue=None,
                                        branch=repo.base, title=live_title(repo), sha=target,
                                        head=target)
                self.jobs.ended(job.id, exit_code=None, outcome=ASSUMED)
            return self._note(repo, f'first sight: everything up to {target[:7]} on {repo.base} '
                                    'counts as live')
        why = self.held(repo) or self.about_to_land(repo)
        if why is None:
            target = self.target(repo)
            last, since = self.reach(repo)
            if last.head == target:
                return self._note(repo, f'nothing merged since {target[:7]}', quiet=True)
            elif not self.git.is_ancestor(repo.path, last.head, target):
                why = (f'{repo.base} at {target[:7]} no longer holds {last.head[:7]}, where the '
                       'last live run reached: Stefan sorts it out')
            else:
                found = self.make_batch(repo, last.head, target, last=last, since=since)
                if found.prs:
                    self._last_why.pop(repo.name, None)
                    return found
                why = f'no PR merged since {last.head[:7]}'
        return self._note(repo, why)

    def target(self, repo) -> str:
        """The base's head on origin now."""
        self.git.fetch(repo.path, repo.base)
        return self.git.sha(repo.path, f'origin/{repo.base}')

    def _note(self, repo, why: str, quiet: bool = False) -> None:
        if self._last_why.get(repo.name) != why and not quiet:
            self.say(f'live {repo.name}: not now, {why}')
        self._last_why[repo.name] = why
        return None

    def next(self, repos=None):
        """(repo, batch) for the first repo whose live steps run now (in `repos`' names, if
        given: #50), or None. `wait_until` is then the soonest a live run cut off by a usage
        limit may run again."""
        self.wait_until = None
        for repo in self.served():
            if repos is not None and repo.name not in repos:
                continue
            try:
                if found := self.batch(repo):
                    return repo, found
            except Exception as e:   # git or GitHub down: the next pass looks again
                self._note(repo, f'reading its state failed ({type(e).__name__}: {e})')
        return None

    # --- the brief -----------------------------------------------------------------------------

    def brief(self, repo, b: Batch) -> str:
        def lines(items, empty):
            return '\n'.join(items) or empty
        prs = []
        for n in b.prs:
            try:
                p = self.github.pull(repo, n)
                prs.append(f'- #{n} {p.title} ({p.url})')
            except Exception:
                prs.append(f'- #{n}')
        applied = (('Already applied by an earlier live run of this batch (don\'t run them '
                    'again):\n\n' + '\n'.join(f'- `{a}`' for a in b.applied) + '\n\n')
                   if b.applied else '')
        uncertain = (('**Maybe applied already:** an earlier live run of this batch ended '
                      'without an answer the runner could read (' + ', '.join(b.unsure) + '). '
                      'Before running each migration above, check through `query_database` '
                      'whether it already ran (its tables, columns, functions or jobs exist); '
                      'skip one that did, and list it under `applied`. If you can\'t tell, '
                      'answer `stop`.\n\n') if b.unsure and b.pending else '')
        changed = (('**Changed after reaching the base**, which the repo forbids (a merged '
                    'migration is never edited): ' + ', '.join(f'`{c}`' for c in b.changed)
                    + '. Don\'t apply them; answer `stop` with what changed.\n\n')
                   if b.changed else '')
        functions = (lines([f'- `{f}`' for f in b.functions], '') + '\n\nEdge functions don\'t '
                     'deploy on merge. Check each as the live doc says (deployed, it answers '
                     'its own 401; missing, 404), and list it under `stefan` for Lovable to '
                     'deploy unchanged in its chat: a changed one needs it even if it answers.'
                     if b.functions else 'None.')
        return Template(resources.files(__package__).joinpath('templates/live.md')
                        .read_text(encoding='utf-8')).substitute(
            github=repo.github, base=repo.base, target=b.target, target7=b.target[:7],
            start7=b.start[:7], live_doc=repo.live_doc,
            last_link=f' ({b.last_link})' if b.last_link else '',
            prs=lines(prs, 'None.'),
            commits=lines([f"- `{c['sha'][:7]}` {c['subject']}" for c in b.commits], 'None.'),
            pending=lines([f'{i}. `{p}`' for i, p in enumerate(b.pending, 1)],
                          'None: no migration to apply.'),
            applied=applied, uncertain=uncertain, changed=changed, functions=functions,
            said=self._said(repo), version=VERSION,
            example=json.dumps(EXAMPLE, ensure_ascii=False))

    def _said(self, repo) -> str:
        """What Stefan said since the newest `live` stop he answered by a reply."""
        stops = [s for s in self.jobs.jobs() if s.kind == 'stop' and s.repo == repo.name
                 and s.stop == 'live' and s.outcome == 'answered']
        if not stops:
            return ''
        s = stops[-1]
        try:
            said = self.github.issue_comments(repo, s.issue)
            if s.link:
                said += self.github.issue_comments(repo, number_of(s.link))
            said = sorted(said_since(said, utc(s.started_at)), key=lambda c: c.created_at)[-5:]
        except Exception as e:
            return f'\n## The last stop\n\n{s.reason} (reading Stefan\'s answer failed: {e})\n'
        how = ('he closed its issue' if s.answer == 'issue-closed' else 'he replied')
        return (f'\n## The last stop\n\nThe last live run stopped for Stefan: {s.reason} '
                f'({s.link}), and {how}. Act on what he says:\n\n' + ('\n\n'.join(
                    f'**{c.author}**, {c.created_at}:\n\n' + '\n'.join(
                        '> ' + ln for ln in _clip(c.body, 1500).splitlines()) for c in said)
                    or '(Nothing said.)') + '\n')

    # --- a run ---------------------------------------------------------------------------------

    def run(self, repo, b: Batch) -> str:
        """Starts the batch's thread in a T3 worktree at the target and records how it ended.
        'started', or 'idle' if T3 started no thread."""
        job = self.jobs.started(kind='live', repo=repo.name, issue=b.prs[-1], branch=repo.base,
                                title=live_title(repo), sha=b.start, head=b.target)
        name = f'live {repo.name}'
        # From the start record on, the Sol lane merges nothing in this repo (merge.why_not).
        # A merge that landed or began since the batch was read makes it stale: next pass.
        try:
            moved = self.about_to_land(repo) or (
                None if self.target(repo) == b.target else f'{repo.base} moved past {b.target[:7]}')
        except Exception as e:
            moved = f'reading it again failed ({type(e).__name__}: {e})'
        if moved:
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'the batch went stale before its thread: {moved}')
            self.say(f'{name} not started: {moved}; the next pass reads the batch again')
            return 'idle'
        try:
            brief = self.brief(repo, b)
        except Exception as e:
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'building the brief failed: {type(e).__name__}: {e}')
            self.say(f'{name} not started: building the brief failed ({e})')
            return 'idle'
        prs = ', '.join(f'#{n}' for n in b.prs)
        self.say(f'Starting {name}: {prs} merged ({b.start[:7]}..{b.target[:7]}), '
                 f'{len(b.pending)} migration(s) to apply')
        try:
            result = self.t3.start(repo.path, brief, title=job.title, worktree=b.target,
                                   branch=live_branch(b.target, job.id),
                                   **self.effort.job())
        except T3Error as e:
            try:
                thread = self.find_thread(job) if self.find_thread else None
            except T3Error:
                thread = job   # T3 can't say: leave it open for the next pass to settle
            if thread is None:
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED, error=str(e))
                self.say(f'{name} not started: {e}')
                return 'idle'
            self.say(f'{name}: lost track of its thread ({e}); the next pass settles it')
            return 'started'
        self.finish(repo, job, result.thread_id, result.exit_code, result.status, result.reply,
                    result.error, result.run_id)
        return 'started'

    def settle(self, job: Job) -> bool:
        """A live job left open by a dead runner: True while its thread still runs."""
        repo = next(r for r in self.config.repos if r.name == job.repo)
        thread = self.find_thread(job)
        if thread is None:
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error='No T3 thread was found for this job.')
            self.say(f'live {job.repo}: no thread was started; closed as not-started')
            return False
        if thread.active and not thread.pending_requests:
            self.say(f'live {job.repo} is still running in {thread.link}: no other Claude job '
                     'starts')
            return True
        _, said = self.t3.show(thread.thread_id, 1)
        reply = next((m.text for m in reversed(said) if m.role == 'assistant'), None)
        code = 2 if thread.status == 'waiting' or thread.pending_requests else (
            0 if thread.status == 'completed' else 1)
        self.finish(repo, job, thread.thread_id, code, thread.status, reply, None,
                    thread.latest_run_id)
        return False

    def finish(self, repo, job: Job, thread_id, exit_code, status, reply, error, run_id) -> None:
        name = f'live {repo.name}'
        last, since = self.reach(repo, before=job)
        b = self.make_batch(repo, job.sha, job.head, before=job, last=last, since=since)
        link = worktree = branch = None
        said = []
        try:
            thread, said = self.t3.show(thread_id)
            link, worktree, branch = thread.link, thread.worktree_path, thread.branch
        except T3Error as e:
            error = error or f'thread show failed: {e}'
        limit = self.limit(thread_id, run_id, exit_code, error, said)
        if limit:
            answer = unreadable('the thread stopped on a usage limit')
        elif exit_code == 0:
            answer = parse(reply, b.pending)
        else:
            answer = unreadable(f'the live thread ended {status} (exit {exit_code})'
                                + (f': {_clip(reply or error, 600)}' if reply or error else ''))
        outcome = USAGE_LIMIT if limit else answer.result
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, worktree=worktree,
                        applied=list(answer.applied), prs=list(b.prs),
                        reason=answer.text or None, error=error, **(limit or {}),
                        **self.effort.used(repo.name, name, thread_id, run_id))
        prs = ', '.join(f'#{n}' for n in b.prs)
        if outcome == LIVE:
            self.say(f'{name}: {prs} live at {b.target[:7]} ({len(answer.applied)} migration(s) '
                     f'applied) {link or thread_id}')
            self._comment(repo, b, answer, link)
            if answer.stefan:
                self._stop(repo, job, '; '.join(answer.stefan), link, kind='live-todo')
        elif outcome == USAGE_LIMIT:
            self.say(f'{name}: {prs} merged, not live yet: the thread stopped on a usage limit; '
                     'the next run checks what it applied')
        else:
            self.say(f'{name}: {prs} merged, not live yet ({outcome}: {_clip(answer.text, 300)}) '
                     f'{link or thread_id}')
            self._stop(repo, job, answer.text, link)
        if worktree:
            try:
                gone = self.git.remove_worktree(repo.path, worktree, branch)
            except Exception as e:
                gone = False
                self.say(f'{name}: removing its worktree failed ({e})')
            if not gone:
                self.say(f'{name}: worktree {worktree} not removed; remove it by hand')

    def _comment(self, repo, b: Batch, answer: Answer, link) -> None:
        mine = [a for a in answer.applied]
        for n in b.prs:
            try:
                self.github.post_comment(repo, n, (
                    f'**Live.** The queue runner\'s live run brought `{repo.base}` live at '
                    f'`{b.target[:7]}`, with ' + (', '.join(f'#{m}' for m in b.prs if m != n)
                                                  or 'no other PR') + '.'
                    + (' Migrations applied: ' + ', '.join(f'`{a}`' for a in mine) + '.'
                       if mine else '')
                    + (f' Notes: {_clip(answer.notes, 500)}' if answer.notes else '')
                    + (f' ([the live thread]({link}))' if link else '')
                    + f'\n\n{RUNNER_MARK}live sha={b.target} -->\n'))
            except Exception as e:
                self.say(f'live {repo.name}: commenting on #{n} failed ({e})')

    def _stop(self, repo, job: Job, why: str, link=None, kind: str = 'live') -> None:
        try:
            pr = self.github.pull(repo, job.issue)
        except Exception as e:
            self.say(f'live {repo.name}: reading #{job.issue} to file the stop failed ({e}); '
                     'next pass')
            return
        after = ('No live run starts in this repo until that issue is closed, Stefan replies '
                 f'here or on it, or `--release {repo.name}#{job.issue}`; the next one picks up '
                 'from here.' if kind == 'live' else
                 'The live run is done; these are the steps it left for Stefan.')
        self.stopper.file(repo, pr, kind, why, link, after=after)
