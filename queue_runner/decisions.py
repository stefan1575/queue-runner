"""Decision threads (ticket 07; `~/Code/docs/orchestration.md`, Judgement), in the Claude lane.

When the fixed flow can't say what to do next, the runner starts a one-off Claude thread with one
narrow question and the state it needs (`templates/decision.md`). The thread ends its reply with a
`queue-runner-decision` block: one JSON object, `"version": VERSION`, whose `action` comes from
the closed set the runner knows (ACTIONS) and that question allows (QUESTIONS). The runner acts on
it. Anything else (no block, bad JSON, another version, an action the question doesn't allow, a
missing field, a thread that failed or asked back) is a stop for Stefan. There's no resident
orchestrator: each thread decides one case and is never sent to again.

The cases, in the order a pass takes them, each decided once (`JobLog.decided`):

- `approach-note`: the runner's review 3 or later of a PR's head is still blocking. The thread
  writes the Approach note; the runner posts it on the PR and files the `approach-note` stop.
  `stops.held` keeps the PR from any further review or fix round until Stefan answers.
- `reply`: Stefan replied to a stop (on the PR or its `needs-info` issue). To an Approach note,
  a reply that starts with `rework`, `fix on` or `hold` is read here, with no thread; any other
  reply goes to a thread. `fix` orders one more fix round on the head (`fix.Fixer.order`; rework
  is a fix round told to rework the approach), `hold` leaves the PR until `--release`,
  `carry-on` lets the loop go on as it is.
- `failed`, `waiting`, `no-pr`: a build or fix thread ended failed (exit 1), waiting for an answer
  (exit 2), or (a build) done without a PR. `retry` and `answer` pick up the earlier job as a
  new job of its kind (`Runner.continue_job`): a message to its thread, or, when that thread is
  cold and large (`limits.resume_choice`), a fresh thread with the decision's text first and,
  for an answer, the question it answers; `close` closes the issue as not
  planned. After MAX_CHAIN such decisions on one issue or PR, the next goes straight to Stefan.

A decision job (kind `decision`, `about` the job it decides on, `question`) ends with the action
taken as its outcome and the text acted on as its `reason`; `not-started` if T3 failed before
any thread, so the next pass tries again. All posts are automated posts in the repo's own issues
and PRs (`~/Code/AGENTS.md`).
"""
import json
import re
from dataclasses import dataclass, replace
from importlib import resources
from string import Template

from .ledger import OPEN, RUNNER_MARK, norm, read_reviews, said_since, state
from .review import _open_line
from .state import NOT_SENT, NOT_STARTED, Job
from .stops import KINDS, approach_review, number_of, undecided_replies, utc
from .t3 import T3Error, settle_quietly

VERSION = 1
FENCE = re.compile(r'^[ \t]*```+[ \t]*queue-runner-decision[ \t]*\r?\n(.*?)^[ \t]*```+[ \t]*$',
                   re.M | re.S)
# Each action: the fields it needs (non-empty strings), and what the runner does with it.
ACTIONS = {
    'retry': (('add',), 'the runner sends `add` to the earlier thread, which carries on in its '
                        'own worktree from its commits (or, if that thread has gone cold and '
                        'large, gives `add` first to a fresh thread on the same branch)'),
    'answer': (('text',), 'the runner sends `text` to the waiting thread as the answer to its '
                          'question (or, if that thread has gone cold and large, gives its '
                          'question and `text` first to a fresh thread on the same branch)'),
    'fix': (('add',), "one more fix round on the PR's head, with `add` first in its brief"),
    'carry-on': ((), 'nothing to do: the loop carries on as it is'),
    'hold': ((), 'the PR is left alone until Stefan releases it'),
    'close': (('reason',), 'the issue isn\'t needed: the runner comments `reason` on it and '
                           'closes it as not planned'),
    'approach-note': (('note', 'recommend'), 'the runner posts `note` (Markdown, no heading) on '
                      'the PR under "## Approach note" with `recommend` ("rework", "fix on" or '
                      '"hold"), and stops for Stefan to choose'),
    'stop': (('question',), 'the runner files `question` for Stefan and leaves the case to him'),
}
QUESTIONS = {
    'approach-note': ('approach-note', 'stop'),
    'reply': ('fix', 'carry-on', 'hold', 'stop'),
    'failed': ('retry', 'close', 'stop'),
    'waiting': ('answer', 'stop'),
    'no-pr': ('retry', 'close', 'stop'),
}
ENDED = {'failed': 'failed', 'waiting': 'waiting', 'done-no-pr': 'no-pr'}   # job outcome -> case
RECOMMEND = ('rework', 'fix on', 'hold')
WORDS = re.compile(r'^\W*(rework|fix on|hold)\b', re.I)   # Stefan's answer to an Approach note
MAX_CHAIN = 3
CLIP = 3000        # characters of any one source in a brief
MAX_SAID = 5       # Stefan's newest comments quoted in a reply's brief
MAX_FINDINGS = 12  # open findings listed in a brief
EXAMPLES = {
    'retry': {'add': 'The test failed because ...; run it with ... and carry on.'},
    'answer': {'text': 'Use the existing ... helper; ...'},
    'fix': {'add': 'Fix F2 only; Stefan accepted the decline of F1.'},
    'close': {'reason': 'PR #12 already did this (merged as ...).'},
    'approach-note': {'note': 'The approach ...', 'recommend': 'rework'},
    'stop': {'question': 'Should ...? I recommend ..., because ...'},
}


def decision_title(repo, number: int) -> str:
    return f'Queue runner decision: {repo.name}#{number}'


def _clip(text: str | None, n: int = CLIP) -> str:
    text = (text or '').strip()
    return text if len(text) <= n else text[:n] + f'\n[... {len(text) - n} more characters]'


def _quote(text: str) -> str:
    return '\n'.join('> ' + line for line in _clip(text, 1500).splitlines())


# --- the answer ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Answer:
    action: str
    fields: dict
    unreadable: str | None = None   # why the reply couldn't be acted on (then it's a stop)

    @property
    def text(self) -> str:
        """The text the runner acts on: what it sends, orders, posts or asks."""
        f = self.fields
        return f.get('add') or f.get('text') or f.get('reason') or f.get('question') or ''


def stop_answer(why: str) -> Answer:
    return Answer('stop', {'question': f"the decision thread's answer can't be acted on: {why}"},
                  unreadable=why)


def parse(reply: str | None, allowed) -> Answer:
    """The action in the reply's last `queue-runner-decision` block, if it's one of `allowed`
    with its fields; else a stop that says why."""
    blocks = FENCE.findall(reply or '')
    if not blocks:
        return stop_answer('it has no queue-runner-decision block')
    try:
        raw = json.loads(blocks[-1])
    except ValueError as e:
        return stop_answer(f'its block is not JSON ({e})')
    if not isinstance(raw, dict):
        return stop_answer('its block is not a JSON object')
    if raw.get('version') != VERSION:
        return stop_answer(f'version {raw.get("version")!r}, not {VERSION}')
    action = raw.get('action')
    if action not in allowed:
        return stop_answer(f'action {action!r} is not one this question allows '
                           f'({", ".join(allowed)})')
    fields = {}
    for name in ACTIONS[action][0]:
        value = raw.get(name)
        if not isinstance(value, str) or not value.strip():
            return stop_answer(f'{action} needs a non-empty "{name}"')
        fields[name] = value.strip()
    if action == 'approach-note':
        fields['recommend'] = fields['recommend'].lower()
        if fields['recommend'] not in RECOMMEND:
            return stop_answer(f'recommend {fields["recommend"]!r} is not one of '
                               f'{", ".join(RECOMMEND)}')
    return Answer(action, fields)


def read_reply(said) -> Answer | None:
    """Stefan's answer to an Approach note, when his newest word starts with rework, fix on or
    hold; else None (a decision thread reads it)."""
    if not said:
        return None
    m = WORDS.match(said[-1].body.strip())
    if not m:
        return None
    word, quoted = m.group(1).lower(), _quote(said[-1].body)
    if word == 'hold':
        return Answer('hold', {})
    if word == 'fix on':
        return Answer('fix', {'add': 'Stefan chose **fix on**: fix the open findings below, as '
                                     f'in any fix round. His reply:\n\n{quoted}'})
    return Answer('fix', {'add': "Stefan chose **rework**: the approach is what's wrong. Rework "
                                 "it as the PR's Approach note and his reply say, on this "
                                 'branch, rather than patching the findings one by one. His '
                                 f'reply:\n\n{quoted}'})


# --- the cases ----------------------------------------------------------------------------------

@dataclass(frozen=True)
class Case:
    question: str      # QUESTIONS
    repo: object
    number: int        # the issue (a build) or the PR
    about: Job         # the review (approach-note), the stop (reply), the build or fix job
    pr: object = None  # the PR, open now (none for a build)
    said: tuple = ()   # reply: what Stefan said since the stop, oldest first

    @property
    def allowed(self) -> tuple:
        acts = QUESTIONS[self.question]
        return tuple(a for a in acts if a != 'close' or self.about.kind == 'build')

    @property
    def name(self) -> str:
        return f'decision {self.repo.name}#{self.number} ({self.question})'


def _template() -> Template:
    return Template(resources.files(__package__).joinpath('templates/decision.md')
                    .read_text(encoding='utf-8'))


class Decider:
    def __init__(self, config, *, github, t3, jobs, say, stopper, effort=None):
        self.config, self.github, self.t3, self.jobs = config, github, t3, jobs
        self.say, self.stopper = say, stopper
        from .effort import Effort   # ticket 39: how its thread starts, its effort read back
        self.effort = effort or Effort(config)

    def next_case(self, repos=None) -> Case | None:
        """The first case to decide, in the working repos (or in `repos` of them: the Claude
        lane chooses each repo's job apart, #50)."""
        from .config import working   # a repo Stefan stopped gets no decision (ticket 37)
        for repo in working(self.config):
            if repos is not None and repo.name not in repos:
                continue
            if not repo.github:
                continue
            try:
                for case in self.cases(repo):
                    return case
            except Exception as e:   # GitHub down: fix rounds and builds may still go on
                self.say(f'decisions on {repo.name}: reading GitHub failed '
                         f'({type(e).__name__}: {e})')
        return None

    def cases(self, repo):
        """The cases waiting for a decision in this repo, in the order they're taken."""
        jobs = self.jobs
        prs = {p.number: p for p in self.github.open_pulls(repo)}
        for n in sorted(prs):
            pr = prs[n]
            if jobs.writer(repo.name, pr.branch):
                continue
            # The newest review, on whatever head it was (the PR may have moved since): the
            # note is about that review, and the PR is held until it's written.
            r = approach_review(jobs, repo, n)
            if (r and not jobs.decided(r.id)
                    and not jobs.stopped(repo.name, n, r.sha, 'approach-note')):
                yield Case('approach-note', repo, n, r, replace(pr, head_sha=r.sha))
        for n in sorted(prs):
            # One reply may answer several stops: one decision reads it, about the newest
            # Approach note among them if there is one (its answer may need no thread).
            if waiting := undecided_replies(jobs, repo, n):
                s = next((s for s in reversed(waiting) if s.stop == 'approach-note'),
                         waiting[-1])
                yield Case('reply', repo, n, s, prs[n], tuple(self._said(repo, n, s)))
        newest = {}   # each issue's newest build and each PR's newest fix: earlier ones are past
        for j in jobs.jobs():   # one that never reached a thread is no newer job: it never ran
            if (j.kind in ('build', 'fix') and j.repo == repo.name
                    and j.outcome not in (NOT_SENT, NOT_STARTED)):
                newest[(j.kind, j.issue)] = j
        for (kind, n), j in sorted(newest.items(), key=lambda kv: kv[0][1]):
            if (j.open or j.outcome not in ENDED or not j.thread_id or jobs.decided(j.id)
                    or j not in jobs.on(kind, repo.name, n)):   # a release settled it
                continue
            pr = prs.get(n) if kind == 'fix' else None
            if kind == 'fix' and (pr is None or (j.outcome == 'failed' and pr.head_sha != j.sha)):
                continue   # closed, or it pushed before failing: Sol reviews the new head
            yield Case(ENDED[j.outcome], repo, n, j, pr)

    def _said(self, repo, n, stop: Job) -> list:
        said = self.github.issue_comments(repo, n) + self.github.review_replies(repo, n)
        if stop.link:
            said += self.github.issue_comments(repo, number_of(stop.link))
        return sorted(said_since(said, utc(stop.started_at)),
                      key=lambda c: c.created_at)[-MAX_SAID:]

    @staticmethod
    def direct_answer(case: Case) -> Answer | None:
        """Stefan's answer to an Approach note, when it needs no thread (`read_reply`)."""
        if case.question == 'reply' and case.about.stop == 'approach-note':
            return read_reply(case.said)
        return None

    # --- the brief --------------------------------------------------------------------------

    def brief(self, case: Case) -> str:
        repo, n = case.repo, case.number
        if case.question == 'approach-note':
            r = case.about
            question = (f"Sol's review {r.round} of PR #{n}'s head `{r.sha[:7]}` is still "
                        'blocking, so the loop stops for Stefan with an Approach note, and no '
                        'further review or fix round runs without his answer. Write the note: is '
                        'the approach wrong, which class of finding keeps recurring and why, what '
                        'would change, and do you recommend **rework** (redo the approach on this '
                        'PR), **fix on** (another fix round on the open findings) or **hold**?')
            subject = f'Approach note for {repo.github}#{n}'
        elif case.question == 'reply':
            s = case.about
            question = (f'The loop stopped on PR #{n} for Stefan ({KINDS.get(s.stop, s.stop)}: '
                        f'{s.reason}), and he has replied (below). What does his reply ask the '
                        'runner to do?')
            subject = f"Stefan's reply on {repo.github}#{n}"
        else:
            j = case.about
            what = f'the {j.kind} thread for ' + (f'PR #{n}' if j.kind == 'fix' else f'issue #{n}')
            question = {
                'failed': f'{what} ended failed (exit 1). Retry it with something added, '
                          + ('close the issue as not needed, ' if j.kind == 'build' else '')
                          + 'or does Stefan need to decide?',
                'waiting': f'{what} asked a question and waits for an answer (its last messages '
                           'are below). Answer it if the sources settle it (mechanics: schema, '
                           'settings, tests, file layout), or stop for Stefan if it changes what '
                           'the app does or how its parts connect.',
                'no-pr': f'{what} ended without opening a PR. Retry it with an instruction, close '
                         'the issue as not needed (e.g. the work is already done), or stop for '
                         'Stefan?',
            }[case.question]
            subject = f'{j.kind} {repo.github}#{n} ended {j.outcome}'
        allowed = case.allowed
        return _template().substitute(
            subject=subject, path=repo.path, question=question, version=VERSION,
            sources=self._sources(case),
            actions='\n'.join(f'- `{a}`'
                              + (' with ' + ', '.join(f'`{f}`' for f in ACTIONS[a][0])
                                 if ACTIONS[a][0] else '') + f': {ACTIONS[a][1]}.'
                              for a in allowed),
            example=json.dumps({'version': VERSION, 'action': allowed[0],
                                **EXAMPLES.get(allowed[0], {})}, ensure_ascii=False))

    def _try(self, label: str, fn) -> str:
        try:
            return fn()
        except Exception as e:
            return f'### {label}\n\n(Couldn\'t read it: {type(e).__name__}: {e}.)'

    def _sources(self, case: Case) -> str:
        repo, n = case.repo, case.number
        parts = []
        if case.pr is not None:
            parts.append(self._try('The PR', lambda: self._pr_part(case)))
        if case.question == 'reply':
            s = case.about
            parts.append(f'### The stop\n\n{KINDS.get(s.stop, s.stop)}: {s.reason} '
                         f'(its issue: {s.link or "none"})')
            parts.append("### What Stefan said since\n\n" + '\n\n'.join(
                f'**{c.author}**, {c.created_at}:\n\n{_quote(c.body)}' for c in case.said))
        if case.question in ENDED.values():
            j = case.about
            if j.kind == 'build':
                parts.append(self._try('The issue', lambda: self._issue_part(repo, n)))
            parts.append(self._job_part(j))
            parts.append(self._try('Its last 3 messages', lambda: self._messages(j)))
        parts.append(self._threads(case))
        return '\n\n'.join(parts)

    def _pr_part(self, case: Case) -> str:
        pr, repo = case.pr, case.repo
        found = state(read_reviews(self.github.issue_comments(repo, pr.number)))
        important = [f for f in found if f['tag'] == 'important' and f['status'] in OPEN]
        classes = list(dict.fromkeys(f['class'] for f in important if norm(f['class'])))
        reviews = [j for j in self.jobs.on('review', repo.name, pr.number, released=True)
                   if j.link and j.round]
        return (f'### The PR\n\n#{pr.number} {pr.title} ({pr.url}), head `{pr.head_sha[:7]}`, '
                f'branch `{pr.branch}` into `{pr.base}`.\n\n{_clip(pr.body) or "(No description.)"}'
                '\n\n### Open Important findings (from the newest review\'s ledger)\n\n'
                + ('\n'.join(map(_open_line, important[:MAX_FINDINGS])) or 'None.')
                + (f'\n- ... and {len(important) - MAX_FINDINGS} more'
                   if len(important) > MAX_FINDINGS else '')
                + '\n\nClasses so far: ' + ('; '.join(f'"{c}"' for c in classes) or 'none')
                + '\n\nThe runner\'s reviews: ' + (', '.join(
                    f'[review {j.round}]({j.link}) {j.outcome}' for j in reviews) or 'none'))

    def _issue_part(self, repo, n) -> str:
        i = self.github.issue(repo.github, n)
        return f'### The issue\n\n#{n} {i.title}\n\n{_clip(i.body) or "(No body.)"}'

    @staticmethod
    def _job_part(j: Job) -> str:
        commits = '\n'.join(f"- `{c['sha'][:7]}` {c['subject']}" for c in j.commits
                            if isinstance(c, dict)) or 'None.'
        return (f'### The {j.kind} job\n\nThread: {j.link or j.thread_id}. Ended '
                f'{j.outcome} (exit {j.exit_code}, T3 status {j.status}), branch '
                f'`{j.branch}`' + (f', PR {j.pr["url"]}' if j.pr else '')
                + (f'.\n\nError: {_clip(j.error, 800)}' if j.error else '.')
                + f'\n\nIts commits:\n\n{commits}')

    def _messages(self, j: Job) -> str:
        _, messages = self.t3.show(j.thread_id, 3)
        return '### Its last 3 messages\n\n' + ('\n\n'.join(
            f'**{m.role}**:\n\n{_clip(m.text, 1500)}' for m in messages) or 'None.')

    def _threads(self, case: Case) -> str:
        repo, n = case.repo, case.number
        if case.pr is not None:
            ran = self.jobs.pr_jobs(repo.name, n, case.pr.branch)
        else:
            ran = self.jobs.on('build', repo.name, n, released=True)
        ran += [j for j in self.jobs.on('decision', repo.name, n, released=True) if j.link]
        return '### Earlier threads\n\n' + ('\n'.join(
            f'- {j.kind} job, {j.started_at[:16]}, ended {j.outcome}: {j.link}'
            for j in ran if j.link) or 'None.')

    # --- deciding ---------------------------------------------------------------------------

    def run(self, case: Case, continue_thread) -> str:
        """Decides the case and acts. `continue_thread(job, message)` sends an earlier job's
        thread a message as a new job (`Runner.continue_job`). 'started', or 'idle' if T3
        started no thread."""
        repo, n = case.repo, case.number
        sha = case.pr.head_sha if case.pr is not None else case.about.sha
        job = self.jobs.started(kind='decision', repo=repo.name, issue=n, branch=None,
                                title=decision_title(repo, n), sha=sha, about=case.about.id,
                                question=case.question)
        if answer := self.direct_answer(case):
            self.say(f'{case.name}: Stefan answered the Approach note: {answer.action}')
            return self.act(case, job, answer, None, continue_thread)
        chain = [d for d in self.jobs.on('decision', repo.name, n)
                 if d.question in ENDED.values() and d.id != job.id and d.outcome != NOT_STARTED]
        if case.question in ENDED.values() and len(chain) >= MAX_CHAIN:
            return self.act(case, job, Answer('stop', {'question': (
                f'{len(chain)} decisions on this {case.about.kind} already, and it ended '
                f'{case.about.outcome} again')}), None, continue_thread)
        try:
            brief = self.brief(case)
            result = self.t3.start(repo.path, brief, title=job.title,
                                   **self.effort.flags(repo))
        except Exception as e:   # T3 down, or the brief couldn't be built: the next pass
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'{type(e).__name__}: {e}')
            self.say(f'{case.name} not started: {e}')
            return 'idle'
        if result.exit_code == 0:
            answer = parse(result.reply, case.allowed)
        else:
            why = (f'the decision thread ended {result.status} (exit {result.exit_code})'
                   + (f': {_clip(result.reply or result.error, 600)}'
                      if result.reply or result.error else ''))
            answer = Answer('stop', {'question': why}, unreadable=why)
        if result.exit_code != 2:   # read: settled (ticket 70); one that asked back is left
            settle_quietly(self.t3, result.thread_id, case.name, self.say)
        return self.act(case, job, answer, result, continue_thread)

    def act(self, case: Case, job: Job, answer: Answer, result, continue_thread) -> str:
        repo, n, a, fields = case.repo, case.number, answer.action, answer.fields
        link = None
        if result is not None:
            try:
                link = self.t3.show(result.thread_id, 1)[0].link
            except T3Error:
                pass
        ran = {} if result is None else dict(
            thread_id=result.thread_id, run_id=result.run_id, status=result.status,
            **self.effort.used(repo.name, case.name, result.thread_id, result.run_id))
        code = None if result is None else result.exit_code
        text = answer.text

        def end(outcome, **extra):
            fields = dict(ran, link=link, reason=text or None, error=answer.unreadable)
            fields.update(extra)
            self.jobs.ended(job.id, exit_code=code, outcome=outcome, **fields)
            self.say(f'{case.name}: {outcome}' + (f' ({_clip(text, 200)})' if text else '')
                     + (f' {link}' if link else ''))

        if a == 'approach-note':
            return self._approach_note(case, end, fields, link)
        if a == 'stop':   # filed first: the decision ends once its stop exists
            end('stop', reason=self._stop(case, text, link))
            return 'started'
        if a == 'close':
            end('close')
            try:
                self.github.post_comment(repo, n, (
                    f'The queue runner closed this issue as not needed: {text}\n\n'
                    + (f'Decided in {link}.\n\n' if link else '')
                    + f'{RUNNER_MARK}decision close -->\n'))
                self.github.close_not_planned(repo, n)
            except Exception as e:
                self.say(f'{case.name}: closing the issue failed ({e}); it stays held until '
                         f'--release {repo.name}#{n}')
            return 'started'
        if a in ('fix', 'carry-on', 'hold'):
            end(a)
            return 'started'
        # retry or answer: the earlier thread carries on, as a new job of its kind
        end(a)
        by = f' ({link})' if link else ''
        message = (f'The queue runner decided to retry this job{by}:\n\n{text}\n\nCarry on from '
                   "your commits in this worktree, and end as the job's brief says."
                   if a == 'retry' else
                   f"The answer to your question, from the queue runner's decision{by}:\n\n"
                   f"{text}\n\nCarry on, and end as the job's brief says.")
        if continue_thread(case.about, message) == 'idle':   # never reached the thread
            self.jobs.ended(job.id, exit_code=code, outcome=NOT_STARTED, link=link,
                            reason=text or None, error='the earlier job was not continued')
            return 'idle'
        return 'started'

    def _approach_note(self, case: Case, end, fields, link) -> str:
        repo, pr, r = case.repo, case.pr, case.about
        h7 = pr.head_sha[:7]
        body = (f'## Approach note\n\n{fields["note"]}\n\n'
                f'**Recommendation:** {fields["recommend"]}.\n\n'
                f'Review {r.round} on `{h7}` is still blocking, so no further review or fix round '
                'runs on this PR until Stefan answers: reply **rework**, **fix on** or **hold**, '
                'here or on its `needs-info` issue.'
                + (f' Written by a decision thread: {link}.' if link else '')
                + f'\n\n{RUNNER_MARK}approach-note sha={pr.head_sha} round={r.round} -->\n')
        try:
            url = self.github.post_comment(repo, pr.number, body)
        except Exception as e:
            why = (f'review {r.round} on {h7} is still blocking; posting the Approach note '
                   f'failed ({e}), so it is in the decision thread')
            self.stopper.file(repo, pr, 'approach-note', why, link)
            end('stop', reason=why)
            return 'started'
        why = (f'review {r.round} on {h7} is still blocking; the Approach note recommends '
               f'{fields["recommend"]}: reply rework, fix on or hold')
        # If filing fails, the Sol lane's stop pass files it from this record (stops.detect).
        self.stopper.file(repo, pr, 'approach-note', why, url)
        end('approach-note', link=url, reason=why)
        return 'started'

    def _stop(self, case: Case, why: str, link: str | None) -> str:
        """Files the decision's question for Stefan where he answers it; returns the stop's
        text."""
        repo, n, j = case.repo, case.number, case.about
        if case.question == 'approach-note':
            why = (f'review {j.round} on {case.pr.head_sha[:7]} is still blocking, and no '
                   f'Approach note was written ({why})')
            self.stopper.file(repo, case.pr, 'approach-note', why, link)
        elif case.question == 'waiting':
            self.stopper.file_on_issue(
                repo, n, why, link, open_url=j.link,
                after=f'Answer it in the waiting thread ({j.link}), or reply here: the runner '
                      'sends your reply to it.')
        elif case.pr is not None:
            self.stopper.file(repo, case.pr, 'decision', why, link)
        else:
            self.stopper.file_on_issue(repo, n, why, link)
        return why
