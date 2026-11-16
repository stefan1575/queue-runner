"""An ask opens a T3 thread to decide in (ticket 35; `.scratch/queue-runner/dashboard-live.md`).

On a stopped PR's ask in the dashboard's Inbox, Stefan clicks "Decide in T3": the page writes
`asks.<ask id>.open` in control.json (`dashboard/serve.py`'s `apply_control`). The Claude lane's
next pass starts one thread for it, `Decide: Queue runner ask: <repo>#<n>` (issue #71), in the
repo's T3 project with no worktree, and doesn't wait on it (`t3 thread start` without
`--wait`): Stefan talks it through there. Its brief (`templates/ask.md`) is the ask as the Inbox
writes it, the PR's open findings and the earlier threads, and it tells the thread to end with a
`queue-runner-decision` block once Stefan has decided.

- **Only on his click**, once per ask (an `ask` job, `about` the stop, ended `opened` with the
  thread). It's a Claude job, gated as a decision; a stopped Claude lane or repo keeps the request
  and starts nothing until Resume.
- **Its answer** is the `reply` question's (`decisions.QUESTIONS`): `fix`, `carry-on`, `hold` or
  `stop`. Each pass the Claude lane reads the thread's newest message; once it's the thread's reply
  (not still running) and holds a readable block, the stop is recorded `answered` (`answer`
  `thread`) and a `reply` decision (`about` the stop, `link` the thread) acts on it as a decision
  thread on Stefan's reply does (`Decider.act`). No block yet changes nothing.
- **An answer on GitHub meanwhile still counts:** a stop no longer `filed` (closed, replied),
  released (`JobLog.released_ids`: its outcome stays `filed`), or already decided, is the other
  answer's; the thread's is never acted on then, and a request to open one is dropped.

Asks that can be opened are the PR stops a reply would answer (`OPENS`): not a live run's.

**A stale thread opened afresh** (issue #72). A thread that waits on Stefan goes cold once its
prompt cache expires (`limits.stale`), and `prefixes.py` settles it. Its Inbox item stays, and
its button then asks for a fresh thread (`asks.<id>.fresh` in control.json, `Switch.fresh`)
instead of opening the cold one, which would re-read its whole context uncached. The Claude
lane, gated as a decision, starts that fresh thread, briefed as the cold one was plus the cold
one's link and its last 3 messages (`templates/stale.md`), as limit restarts are:

- **An ask thread** (`stop-<id>`): a new `ask` job on the same stop, with the ask's brief. The
  newest ask thread on a stop is the one read and prefixed; the cold one's "Decide: " comes off.
- **A thread waiting for his answer** (`thread-<id>`, a build or fix whose question a decision
  left to him): a conversation thread with no worktree, `Answer: Queue runner answer:
  <repo>#<n>` (an `ask` job `about` the waiting job, `question` `waiting`), briefed with the
  question, the job's sources and `templates/answer.md`. Its `answer` block (`text`) is sent to
  the waiting job as his answer (`Runner.continue_job`, in place or fresh as for any, gated as
  the job's kind): the job ends `continued` with `reason` `thread`. Answering on GitHub
  meanwhile still counts (`waiting.py`), and the fresh thread's block is then never read.

Only a request made after the newest thread on that ask was opened, while that thread is stale,
is taken; one for a thread that isn't stale (T3 reports no expiry, or it's still warm) is said
once and left, so the page's button is the thread's own link again.
"""
import datetime
import json
from dataclasses import dataclass
from importlib import resources
from string import Template

from . import limits as lim
from .decisions import ACTIONS, QUESTIONS, VERSION, Answer, Case, _clip, _quote, parse
from .prefixes import ANSWER as ANSWER_PREFIX, DECIDE, titled
from .state import NOT_STARTED, when
from .t3 import RunResult, T3Error, settle_quietly

KIND = 'ask'          # its job's kind
OPENED = 'opened'     # the thread started; its outcome
ANSWER = 'thread'     # a stop's `answer` when the thread decided it
QUESTION = 'reply'
OPENS = ('review', 'approach-note', 'no-push', 'conflict', 'failed-check', 'decision')
PREFIX = 'stop-'      # an ask on a stop: `stop-<the stop job's id>` (`asks._id`)
WAITS = 'thread-'     # an ask on a waiting thread: `thread-<the waiting job's id>` (`asks._id`)
EXAMPLE = {'version': VERSION, 'action': 'fix', 'add': 'Stefan chose fix on: fix F2 only, ...'}
ANSWER_EXAMPLE = {'version': VERSION, 'action': 'answer',
                  'text': 'Stefan says: use the darker blue, and keep the old name.'}
ANSWERED = 'thread'   # a waiting job's `reason` when it was answered in a fresh thread (#72)


def title(repo, n: int) -> str:
    return f'Queue runner ask: {repo.name}#{n}'


def answer_title(repo, n: int) -> str:
    return f'Queue runner answer: {repo.name}#{n}'


@dataclass(frozen=True)
class Opening:
    """A thread for Stefan to open: on `about` (a stop, or a waiting build or fix), in `repo`;
    `pr` the PR open now (None for a build's question); `old` the stale thread's job it takes
    over from (an ask job, or the waiting job itself), None for a first opening, and `cold`
    when its prompt cache expired."""
    repo: object
    about: object
    pr: object = None
    old: object = None
    cold: datetime.datetime | None = None

    @property
    def number(self) -> int:
        return self.pr.number if self.pr is not None else self.about.issue

    def __iter__(self):   # (repo, stop, pr), as `next` gave before issue #72
        return iter((self.repo, self.about, self.pr))


def opens(stop) -> bool:
    """Whether this stop's ask can be decided in a thread."""
    return stop is not None and stop.kind == 'stop' and stop.stop in OPENS


def ask_jobs(jobs, stop_id: str) -> list:
    """The ask jobs on this stop, oldest first."""
    return [j for j in jobs if j.kind == KIND and j.about == stop_id]


def opened(jobs, stop_id: str):
    """The ask job whose thread was started for this stop, or None."""
    found = [j for j in ask_jobs(jobs, stop_id) if j.outcome == OPENED]
    return found[-1] if found else None


def _template() -> Template:
    return Template(resources.files(__package__).joinpath('templates/ask.md')
                    .read_text(encoding='utf-8'))


def _ask_text(a: dict) -> str:
    """The ask as the Inbox shows it, in Markdown."""
    lines = [f"**{a['situation']}**", '']
    if a.get('about'):
        lines += [f"What it is: {a['about']}", '']
    if a.get('because'):
        lines += [a['because'], '']
    if a.get('timeline'):
        lines += ['So far:', ''] + [f"- {t['at'][:16].replace('T', ' ') if t.get('at') else ''}"
                                    f" {t['text']}" for t in a['timeline']] + ['']
    lines += [f"The question: {a['question']}", '']
    if a.get('options'):
        lines += [f"- **{o['say']}**{' (recommended)' if o.get('recommended') else ''}: "
                  f"{o['means']}" for o in a['options']] + ['']
    if a.get('holds_up'):
        lines += ['It holds up: ' + '; '.join(a['holds_up']) + '.', '']
    lines.append(f"Its needs-info issue: {a['go']['url']}")
    return '\n'.join(lines)


def _answered(stop, all_jobs, gone, log) -> str | None:
    """Why this stop no longer waits on Stefan, or None: answered (GitHub's issue closed or a
    reply, or its thread), released, or decided. A thread's answer is never acted on then."""
    if stop.outcome == 'answered':
        return 'answered in its T3 thread' if stop.answer == ANSWER else 'answered on GitHub'
    if stop.outcome != 'filed':
        return f'marked {stop.outcome}'
    if stop.id in gone:
        return 'released'
    if log.decided(stop.id):
        return 'decided already'
    return None


def _settled(stop, all_jobs, gone, log) -> str | None:
    """Why this stop's ask opens no thread now, or None: `_answered`, or it has a thread."""
    if why := _answered(stop, all_jobs, gone, log):
        return why
    if opened(all_jobs, stop.id):
        return 'given a thread already'
    return None


class AskThreads:
    """The Claude lane's part: which asks to open, opening one, and reading the answers."""

    def __init__(self, config, *, github, t3, jobs, say, decider, limits=None, now=None):
        self.config, self.github, self.t3, self.jobs = config, github, t3, jobs
        self.say, self.decider = say, decider
        # limits.T3Store, for when a thread's prompt cache expires (issue #72); None: never stale
        self.limits = limits
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self._said: dict[str, str] = {}
        self._replies: list = []   # (waiting job, message, marks): answered in a fresh thread

    def _once(self, key: str, text: str) -> None:
        if self._said.get(key) != text:
            self.say(text)
        self._said[key] = text

    def _stop_of(self, ask_id: str, by_id: dict):
        if not ask_id.startswith(PREFIX):
            return None
        s = by_id.get(ask_id[len(PREFIX):])
        return s if opens(s) else None

    def next(self, switch, only=None) -> Opening | None:
        """The first ask Stefan asked to open, oldest request first, whose stop still waits on
        him and has no thread yet; else the first he asked to open afresh whose newest thread
        has gone stale since (`_fresh`, issue #72); or None. With `only`, in those repos' names
        alone (#50: each repo's job is chosen apart)."""
        from .config import working
        repos = {r.name: r for r in working(self.config)
                 if r.github and (only is None or r.name in only)}
        all_jobs, gone = self.jobs.jobs(), self.jobs.released_ids()
        by_id = {j.id: j for j in all_jobs}
        for ask_id, _ in sorted(switch.opened.items(), key=lambda kv: kv[1]):
            s = self._stop_of(ask_id, by_id)
            if s is None or s.repo not in repos or _settled(s, all_jobs, gone, self.jobs):
                continue
            repo = repos[s.repo]
            try:
                pr = next((p for p in self.github.open_pulls(repo) if p.number == s.issue), None)
            except Exception as e:
                self.say(f'ask {repo.name}#{s.issue}: reading its PR failed '
                         f'({type(e).__name__}: {e}); next pass')
                continue
            if pr is None:
                self._once(ask_id, f'ask {repo.name}#{s.issue}: the PR is closed, so no thread '
                                   'is started for it')
                continue
            return Opening(repo, s, pr)
        for ask_id, at in sorted(switch.fresh.items(), key=lambda kv: kv[1]):
            found = self._fresh(ask_id, at, repos, all_jobs, gone, by_id)
            if found is not None:
                return found
        return None

    def newest(self, about, all_jobs):
        """The job whose thread is the newest Stefan has on `about` (a stop or a waiting job):
        its newest ask thread, else (a waiting job) its own; None if there's none."""
        j = opened(all_jobs, about.id)
        return j if j is not None else about if about.kind in ('build', 'fix') else None

    def target(self, ask_id: str, by_id: dict, gone):
        """What an ask's fresh thread would be about, if it still needs Stefan: its stop (filed,
        not released or decided), or its waiting build or fix (left to him, not released)."""
        from .waiting import left_to_stefan
        if ask_id.startswith(PREFIX):
            s = self._stop_of(ask_id, by_id)
            ok = (s is not None and s.outcome == 'filed' and s.id not in gone
                  and not self.jobs.decided(s.id))
            return s if ok else None
        if ask_id.startswith(WAITS):
            j = by_id.get(ask_id[len(WAITS):])
            if (j is not None and j.outcome == 'waiting' and j.id not in gone
                    and left_to_stefan(self.jobs, j)):
                return j
        return None

    def _fresh(self, ask_id, at, repos, all_jobs, gone, by_id) -> Opening | None:
        about = self.target(ask_id, by_id, gone)
        if about is None or about.repo not in repos:
            return None
        old = self.newest(about, all_jobs)
        if old is None or not old.thread_id or at <= when(old.started_at):
            return None   # nothing to replace, or that request was taken already
        repo, name = repos[about.repo], f'ask {about.repo}#{about.issue}'
        cold = lim.stale(self.limits, old.thread_id, self.now())
        if cold is None:
            self._once(f'fresh {ask_id}', f'{name}: Stefan asked for a fresh thread, but '
                                          f'{old.thread_id} has not gone stale; its Inbox item '
                                          'opens it')
            return None
        pr = None
        if about.kind != 'build':   # a stop's PR, or a fix round's
            try:
                pr = next((p for p in self.github.open_pulls(repo) if p.number == about.issue),
                          None)
            except Exception as e:
                self.say(f'{name}: reading its PR failed ({type(e).__name__}: {e}); next pass')
                return None
            if pr is None:
                self._once(f'fresh {ask_id}', f'{name}: the PR is closed, so no fresh thread is '
                                              'started for it')
                return None
        return Opening(repo, about, pr, old, cold)

    # --- opening --------------------------------------------------------------------------

    def brief_for(self, o: Opening) -> str:
        """The brief of the thread `o` opens: the ask's, or for a waiting job's question the
        answer thread's; after a stale thread, with its link and last messages (#72)."""
        if o.about.kind == 'stop':
            return self.brief(o.repo, o.about, o.pr, earlier=self._earlier(o))
        return self.answer_brief(o)

    def _earlier(self, o: Opening) -> str | None:
        if o.old is None:
            return None
        _, messages = self.t3.show(o.old.thread_id, 3)
        said = '\n\n'.join(f'**{m.role}**:\n\n{_clip(m.text, 1500)}' for m in messages) or 'None.'
        return Template(resources.files(__package__).joinpath('templates/stale.md')
                        .read_text(encoding='utf-8')).substitute(
            what='ask' if o.about.kind == 'stop' else 'question',
            expired=f'at {o.cold.astimezone():%Y-%m-%d %H:%M}' if o.cold else 'a while ago',
            link=o.old.link or o.old.thread_id, messages=said).rstrip('\n')

    def answer_brief(self, o: Opening) -> str:
        """A fresh thread to answer a waiting job's question in (#72): the question (the
        waiting thread's last reply), the job's sources, and the cold thread it replaces."""
        job, repo, d = o.about, o.repo, self.decider
        _, said = self.t3.show(job.thread_id, 3)
        asked = [m.text for m in said if m.role == 'assistant'][-1:]
        case = Case('waiting', repo, job.issue, job, o.pr)
        parts = []
        if o.pr is not None:
            parts.append(d._try('The PR', lambda: d._pr_part(case)))
        else:
            parts.append(d._try('The issue', lambda: d._issue_part(repo, job.issue)))
        parts += [d._job_part(job), d._threads(case), self._earlier(o)]
        return Template(resources.files(__package__).joinpath('templates/answer.md')
                        .read_text(encoding='utf-8')).substitute(
            subject=f'{repo.github}#{job.issue}', kind=job.kind, path=repo.path,
            version=VERSION,
            question=_quote(asked[0]) if asked else '(It asked nothing readable.)',
            sources='\n\n'.join(p for p in parts if p),
            example=json.dumps(ANSWER_EXAMPLE, ensure_ascii=False))

    def brief(self, repo, stop, pr, earlier: str | None = None) -> str:
        case = Case(QUESTION, repo, pr.number, stop, pr)
        allowed = QUESTIONS[QUESTION]
        return _template().substitute(
            subject=f'{repo.github}#{pr.number}', path=repo.path, version=VERSION,
            ask=self._ask(repo, stop, pr),
            sources='\n\n'.join([self.decider._try('The PR', lambda: self.decider._pr_part(case)),
                                 self.decider._threads(case)] + ([earlier] if earlier else [])),
            actions='\n'.join(f'- `{a}`' + (' with ' + ', '.join(f'`{f}`' for f in ACTIONS[a][0])
                                            if ACTIONS[a][0] else '') + f': {ACTIONS[a][1]}.'
                              for a in allowed),
            example=json.dumps(EXAMPLE, ensure_ascii=False))

    def _ask(self, repo, stop, pr) -> str:
        """The ask, written as the Inbox writes it (`asks.ask`), from the PR read now."""
        from .asks import Story, ask
        from .inbox import Waiting, _Reader, reviews
        errors = []
        try:
            issues = {i.number: i for i in self.github.open_issues(repo)}
        except Exception:
            issues = {}
        w = _Reader(self.github, repo, {pr.number: pr}, issues, errors).fill(
            Waiting('stop', repo.name, pr.number, True, stop))
        all_jobs = self.jobs.jobs()
        story = Story(all_jobs, self.jobs.releases(), reviews(all_jobs, {(repo.name, pr.number)}))
        return _ask_text(ask(story, w, {repo.name: repo}))

    def _now(self, stop_id: str, why) -> str | None:
        """`why(stop, ...)` for the stop as the job log has it now, or 'gone'. The Sol lane runs
        alongside and may answer a stop (or Stefan release it) at any moment, so a check that
        guards an action is made with this, after every slow read the action needs (issue #84,
        review 1's F1)."""
        all_jobs = self.jobs.jobs()
        now = next((j for j in all_jobs if j.id == stop_id), None)
        return why(now, all_jobs, self.jobs.released_ids(), self.jobs) if now else 'gone'

    def _gone(self, o: Opening, before: bool) -> str | None:
        """Why `o` no longer needs Stefan, read from the job log now (#84), or None. `before`
        the launch, a thread on it opened since `next` chose it counts too: a first opening
        needs none yet (`_settled`), a fresh one (#72) needs `o.old` to be the newest still."""
        about = o.about
        if about.kind == 'stop':
            if why := self._now(about.id, _settled if before and o.old is None else _answered):
                return why
        else:
            all_jobs = self.jobs.jobs()
            if self.target(f'{WAITS}{about.id}', {j.id: j for j in all_jobs},
                           self.jobs.released_ids()) is None:
                return 'answered or released'
        if before and o.old is not None:
            newest = self.newest(about, self.jobs.jobs())
            if newest is not None and newest.id != o.old.id:
                return 'given a fresh thread already'
        return None

    def open(self, o: Opening) -> str:
        """Starts the ask's thread and returns at once: 'started', or 'idle' if T3 started none
        (the request stands, and the next pass tries again) or if what it's on no longer waits
        on Stefan when read again here (the request is dropped, as next() would have)."""
        repo, about, n = o.repo, o.about, o.number
        on_stop = about.kind == 'stop'
        # A fresh thread in place of a stale one says so as a fresh restart does (`resume`).
        extra = ({'resume': {'how': 'fresh', 'after': o.old.id,
                             'cold': o.cold.isoformat(timespec='seconds'),
                             'why': 'stale: its prompt cache expired, and Stefan asked for a '
                                    'fresh thread from the Inbox'}}
                 if o.old is not None and o.cold is not None else {})
        # Everything slow the start needs (the brief reads GitHub and T3) comes before the job
        # log is read again, so nothing but its own write lies between that check and the launch.
        failed = None
        try:
            # Started as every Claude job is (ticket 39): on the project's default model when
            # that is the config's model at its effort, else with --model.
            brief, flags = self.brief_for(o), self.decider.effort.flags(repo)
        except Exception as e:   # the brief couldn't be built
            failed = e
        if why := self._gone(o, before=True):
            key = f'{PREFIX if on_stop else WAITS}{about.id}'
            self._once(key, f'ask {repo.name}#{n}: it was {why} before its thread started, so '
                            'none is started')
            return 'idle'
        job = self.jobs.started(kind=KIND, repo=repo.name, issue=n, branch=None,
                                title=(title if on_stop else answer_title)(repo, n),
                                sha=about.sha, about=about.id,
                                question=QUESTION if on_stop else 'waiting', **extra)
        if failed is None:
            try:
                # Titled "Decide: ..." (or "Answer: ...") from the start: it waits on Stefan
                # (issue #71).
                launched = self.t3.launch(repo.path, brief,
                                          title=titled(DECIDE if on_stop else ANSWER_PREFIX,
                                                       job.title),
                                          **flags)
            except Exception as e:   # T3 down
                failed = e
        if failed is not None:
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'{type(failed).__name__}: {failed}')
            self.say(f'ask {repo.name}#{n} not started: {failed}')
            return 'idle'
        link = None
        try:
            link = self.t3.show(launched.thread_id, 1)[0].link
        except T3Error:
            pass
        self.jobs.ended(job.id, exit_code=None, outcome=OPENED, thread_id=launched.thread_id,
                        run_id=launched.run_id, link=link)
        # Answered while T3 started it: the thread stays on record, its answer is never acted
        # on (read_answers), and it leaves Stefan's sidebar.
        if why := self._gone(o, before=False):
            settle_quietly(self.t3, launched.thread_id, f'ask {repo.name}#{n}', self.say)
            self.say(f'ask {repo.name}#{n}: it was {why} while its thread started, so the '
                     "thread is settled and its answer won't be acted on")
            return 'started'
        what = 'decide it' if on_stop else 'answer its question'
        fresh = (f', fresh in place of {o.old.link or o.old.thread_id}, which went stale'
                 if o.old is not None else '')
        self.say(f'ask {repo.name}#{n}: a thread to {what} in is open for Stefan'
                 + (f' {link}' if link else '') + fresh)
        return 'started'

    # --- the answers ----------------------------------------------------------------------

    def read_answers(self) -> None:
        """Each open ask thread's newest reply: a readable block is acted on, once. A fresh
        thread's answer to a waiting job's question (#72) is kept for `reply`, which the lane
        sends as a job of that job's kind."""
        from .config import working
        repos = {r.name: r for r in working(self.config) if r.github}
        all_jobs, gone = self.jobs.jobs(), self.jobs.released_ids()
        by_id = {j.id: j for j in all_jobs}
        self._replies = []
        for j in all_jobs:
            about = by_id.get(j.about) if j.kind == KIND and j.outcome == OPENED else None
            if about is None or about.kind not in ('build', 'fix'):
                continue
            if (about.repo not in repos or self.target(WAITS + about.id, by_id, gone) is None
                    or opened(all_jobs, about.id) is not j):
                continue   # answered on GitHub, released, or a newer thread: that one counts
            try:
                self._read_answer(about, j)
            except Exception as e:
                self._once(j.id, f'ask {about.repo}#{about.issue}: reading its thread failed '
                                 f'({type(e).__name__}: {e}); next pass')
        for j in all_jobs:
            stop = by_id.get(j.about) if j.kind == KIND and j.outcome == OPENED else None
            if (stop is None or stop.repo not in repos
                    or _answered(stop, all_jobs, gone, self.jobs)
                    or opened(all_jobs, stop.id) is not j):
                continue   # answered on GitHub, released or decided: that answer counts
            try:
                self._read(repos[stop.repo], stop, j)
            except Exception as e:
                self._once(j.id, f'ask {stop.repo}#{stop.issue}: reading its thread failed '
                                 f'({type(e).__name__}: {e}); next pass')

    def _read_answer(self, job, j) -> None:
        thread, messages = self.t3.show(j.thread_id, 1)
        if not j.link and thread.link:
            self.jobs.ended(j.id, exit_code=None, outcome=OPENED, thread_id=j.thread_id,
                            run_id=j.run_id, link=thread.link)
        if thread.active or not messages or messages[-1].role != 'assistant':
            return
        answer = parse(messages[-1].text, ('answer',))
        if answer.unreadable:
            if 'no queue-runner-decision block' not in answer.unreadable:
                self._once(j.id, f'ask {job.repo}#{job.issue}: its thread ended with a block the '
                                 f"runner can't act on ({answer.unreadable}); waiting for another")
            return
        link = j.link or thread.link or j.thread_id
        quoted = '\n'.join(f'> {line}' if line else '>' for line in answer.text.splitlines())
        message = (f'Stefan answered your question in a T3 thread ({link}):\n\n{quoted}\n\n'
                   'Carry on with that as his answer.')
        marks = {'reason': ANSWERED, 'answer': self.now().isoformat(timespec='seconds')}
        self._replies.append((job, message, marks))

    def reply(self, repos=None):
        """(the waiting job, the message to send it, the marks for its `continued` end) for the
        first answered in a fresh thread (#72), or None. With `repos`, in those repos alone."""
        return next((r for r in self._replies if repos is None or r[0].repo in repos), None)

    def _read(self, repo, stop, j) -> None:
        thread, messages = self.t3.show(j.thread_id, 1)
        if not j.link and thread.link:   # T3 didn't say where at the start: recorded now
            self.jobs.ended(j.id, exit_code=None, outcome=OPENED, thread_id=j.thread_id,
                            run_id=j.run_id, link=thread.link)
        if thread.active or not messages or messages[-1].role != 'assistant':
            return   # still running, or Stefan spoke last: no reply to read yet
        answer = parse(messages[-1].text, QUESTIONS[QUESTION])
        if answer.unreadable:
            if 'no queue-runner-decision block' not in answer.unreadable:
                self._once(j.id, f'ask {repo.name}#{stop.issue}: its thread ended with a block '
                                 f"the runner can't act on ({answer.unreadable}); waiting for "
                                 'another')
            return
        pr = next((p for p in self.github.open_pulls(repo) if p.number == stop.issue), None)
        if pr is None or self._now(stop.id, _answered):
            return   # answered on GitHub (or released) while the thread and PR were read
        self.act(repo, stop, pr, j, thread, answer)

    def act(self, repo, stop, pr, j, thread, answer: Answer) -> None:
        """The stop answered in the thread, and a `reply` decision on it, acted on."""
        self.jobs.ended(stop.id, exit_code=None, outcome='answered', link=stop.link,
                        reason=stop.reason, answer=ANSWER)
        self.say(f'stop {repo.name}#{stop.issue}: answered in its T3 thread ({answer.action})')
        case = Case(QUESTION, repo, pr.number, stop, pr)
        decision = self.jobs.started(kind='decision', repo=repo.name, issue=pr.number,
                                     branch=None, title=j.title, sha=pr.head_sha, about=stop.id,
                                     question=QUESTION)
        result = RunResult(exit_code=0, thread_id=j.thread_id,
                           run_id=thread.latest_run_id or j.run_id, status=thread.status,
                           reply=None, error=None)
        self.decider.act(case, decision, answer, result, lambda job, message: 'idle')


# --- the snapshot -------------------------------------------------------------------------------

def _iso(t) -> str | None:
    if t is None:
        return None
    if isinstance(t, str):
        t = datetime.datetime.fromisoformat(t.replace('Z', '+00:00'))
    return t.astimezone().isoformat(timespec='seconds')


def _stale_decide(a, old, cold, fresh: dict, waits, label: str) -> dict:
    """A stale thread's `decide` (issue #72): `stale`, offering a fresh thread, until Stefan
    asked for one after `old` (the newest thread) opened; then `asked` until it's open."""
    asked = fresh.get(a['id'])
    if asked is not None and asked > when(old.started_at):
        return {'state': 'asked', 'at': _iso(asked), 'label': label,
                'note': waits(a['repo']) or "A fresh thread starts on the Claude lane's next pass."}
    return {'state': 'stale', 'at': _iso(cold), 'label': label,
            'note': (f'Its thread went cold (its prompt cache expired {_iso(cold)[11:16]}), so '
                     'the runner settled it. A fresh thread starts from its brief and the cold '
                     "one's last messages, so nothing is re-read uncached.")}


def mark(asks: list, answered: list, jobs, opened_at: dict, waits, released=frozenset(),
         stale=None, fresh=None) -> None:
    """Each ask's `decide` (whether it can be decided in a T3 thread, and where that stands) and
    `also` (the other place to answer it), in place. `opened_at`: control.json's requests (ask id:
    when); `waits(repo)`: why the Claude lane wouldn't start the thread now, or None;
    `released`: the jobs a release settled (`JobLog.released_ids`), whose asks offer no thread.
    `stale`: thread id -> when its prompt cache expired, for the threads that have (#72), and
    `fresh` control.json's requests for a fresh thread (ask id: when): a stale item offers one,
    an ask on a stop and a thread waiting for his answer alike."""
    by_id = {j.id: j for j in jobs}
    stale, fresh = stale or {}, fresh or {}

    def stop_of(a):
        s = by_id.get(a['id'][len(PREFIX):]) if a['id'].startswith(PREFIX) else None
        return s if opens(s) and s.id not in released else None
    for a in asks:
        a['decide'], a['also'] = None, None
        if a['id'].startswith(WAITS):   # a thread waiting for his answer (#72)
            job = by_id.get(a['id'][len(WAITS):])
            if job is None or job.kind not in ('build', 'fix') or job.id in released:
                continue
            newest = opened(jobs, job.id)
            if newest is not None and newest.link:
                a['go'] = {'label': 'Answer in T3', 'where': 't3', 'url': newest.link}
            newest = newest or job
            if stale.get(newest.thread_id) is not None:
                a['decide'] = _stale_decide(a, newest, stale[newest.thread_id], fresh, waits,
                                            'Answer in a fresh T3 thread')
            elif newest is not job:
                a['decide'] = {'state': 'open', 'at': _iso(newest.ended_at), 'note': None}
            continue
        s = stop_of(a)
        if s is None:
            continue
        j = opened(jobs, s.id)
        if j is not None and j.link and stale.get(j.thread_id) is not None:
            a['decide'] = _stale_decide(a, j, stale[j.thread_id], fresh, waits,
                                        'Decide in a fresh T3 thread')
        elif j is not None and j.link:
            a['also'] = a['go']
            a['go'] = {'label': 'Decide in T3', 'where': 't3', 'url': j.link}
            a['decide'] = {'state': 'open', 'at': _iso(j.ended_at), 'note': None}
        elif j is not None or a['id'] in opened_at:
            tried = ask_jobs(jobs, s.id)
            failed = tried[-1] if tried and tried[-1].outcome == NOT_STARTED else None
            note = (f"T3 couldn't start it ({failed.error}); the runner tries again on its next "
                    'pass.' if failed else waits(a['repo']) or
                    "It starts on the Claude lane's next pass.")
            if j is not None:
                note = "It's open, but T3 hasn't said where yet."
            a['decide'] = {'state': 'asked', 'at': _iso(opened_at.get(a['id'])), 'note': note}
        else:
            a['decide'] = {'state': 'offered', 'at': None, 'note': None}
    for a in answered:
        a['decide'], a['also'] = None, None
        s = stop_of(a)
        j = opened(jobs, s.id) if s is not None else None
        if j is not None and j.link and s.answer == ANSWER:
            a['also'] = a['go']
            a['go'] = {'label': 'Open the T3 thread', 'where': 't3', 'url': j.link}


def waits_text(switch, repo: str, lane_job, wait_reason: str | None) -> str | None:
    """Why the Claude lane wouldn't start an asked thread now: what the page says. `lane_job`
    is the Claude job running in that repo (one per repo, #50), or None."""
    if switch.error is not None:
        return 'It starts once control.json is readable again.'
    if switch.stop('claude').stopped:
        return 'It starts when you resume the Claude lane.'
    if switch.repo_stop(repo).stopped:
        return f'It starts when you resume {repo}.'
    if lane_job is not None:
        return f"It starts once Claude's current {lane_job.kind} ends."
    if wait_reason:
        return f'It starts once the Claude lane may start a job: {wait_reason.rstrip(".")}.'
    return None
