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
"""
import datetime
import json
from importlib import resources
from string import Template

from .decisions import ACTIONS, QUESTIONS, VERSION, Answer, Case, parse
from .prefixes import DECIDE, titled
from .state import NOT_STARTED
from .t3 import RunResult, T3Error

KIND = 'ask'          # its job's kind
OPENED = 'opened'     # the thread started; its outcome
ANSWER = 'thread'     # a stop's `answer` when the thread decided it
QUESTION = 'reply'
OPENS = ('review', 'approach-note', 'no-push', 'conflict', 'failed-check', 'decision')
PREFIX = 'stop-'      # an ask on a stop: `stop-<the stop job's id>` (`asks._id`)
EXAMPLE = {'version': VERSION, 'action': 'fix', 'add': 'Stefan chose fix on: fix F2 only, ...'}


def title(repo, n: int) -> str:
    return f'Queue runner ask: {repo.name}#{n}'


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


class AskThreads:
    """The Claude lane's part: which asks to open, opening one, and reading the answers."""

    def __init__(self, config, *, github, t3, jobs, say, decider):
        self.config, self.github, self.t3, self.jobs = config, github, t3, jobs
        self.say, self.decider = say, decider
        self._said: dict[str, str] = {}

    def _once(self, key: str, text: str) -> None:
        if self._said.get(key) != text:
            self.say(text)
        self._said[key] = text

    def _stop_of(self, ask_id: str, by_id: dict):
        if not ask_id.startswith(PREFIX):
            return None
        s = by_id.get(ask_id[len(PREFIX):])
        return s if opens(s) else None

    def next(self, switch):
        """(repo, the stop, its PR open now) for the first ask Stefan asked to open, oldest
        request first, whose stop still waits on him and has no thread yet; or None."""
        from .config import working
        repos = {r.name: r for r in working(self.config) if r.github}
        all_jobs, gone = self.jobs.jobs(), self.jobs.released_ids()
        by_id = {j.id: j for j in all_jobs}
        for ask_id, _ in sorted(switch.opened.items(), key=lambda kv: kv[1]):
            s = self._stop_of(ask_id, by_id)
            if (s is None or s.repo not in repos or s.outcome != 'filed' or s.id in gone
                    or opened(all_jobs, s.id) or self.jobs.decided(s.id)):
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
            return repo, s, pr
        return None

    # --- opening --------------------------------------------------------------------------

    def brief(self, repo, stop, pr) -> str:
        case = Case(QUESTION, repo, pr.number, stop, pr)
        allowed = QUESTIONS[QUESTION]
        return _template().substitute(
            subject=f'{repo.github}#{pr.number}', path=repo.path, version=VERSION,
            ask=self._ask(repo, stop, pr),
            sources='\n\n'.join([self.decider._try('The PR', lambda: self.decider._pr_part(case)),
                                 self.decider._threads(case)]),
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

    def open(self, repo, stop, pr) -> str:
        """Starts the ask's thread and returns at once: 'started', or 'idle' if T3 started none
        (the request stands, and the next pass tries again)."""
        n = pr.number
        job = self.jobs.started(kind=KIND, repo=repo.name, issue=n, branch=None,
                                title=title(repo, n), sha=stop.sha, about=stop.id,
                                question=QUESTION)
        try:
            # Started as every Claude job is (ticket 39): on the project's default model when
            # that is the config's model at its effort, else with --model.
            # Titled "Decide: ..." from the start: it waits on Stefan's decision (issue #71).
            launched = self.t3.launch(repo.path, self.brief(repo, stop, pr),
                                      title=titled(DECIDE, job.title),
                                      **self.decider.effort.flags(repo))
        except Exception as e:   # T3 down, or the brief couldn't be built
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'{type(e).__name__}: {e}')
            self.say(f'ask {repo.name}#{n} not started: {e}')
            return 'idle'
        link = None
        try:
            link = self.t3.show(launched.thread_id, 1)[0].link
        except T3Error:
            pass
        self.jobs.ended(job.id, exit_code=None, outcome=OPENED, thread_id=launched.thread_id,
                        run_id=launched.run_id, link=link)
        self.say(f'ask {repo.name}#{n}: a thread to decide it in is open for Stefan'
                 + (f' {link}' if link else ''))
        return 'started'

    # --- the answers ----------------------------------------------------------------------

    def read_answers(self) -> None:
        """Each open ask thread's newest reply: a readable block is acted on, once."""
        from .config import working
        repos = {r.name: r for r in working(self.config) if r.github}
        all_jobs, gone = self.jobs.jobs(), self.jobs.released_ids()
        by_id = {j.id: j for j in all_jobs}
        for j in all_jobs:
            stop = by_id.get(j.about) if j.kind == KIND and j.outcome == OPENED else None
            if (stop is None or stop.repo not in repos or stop.outcome != 'filed'
                    or stop.id in gone or self.jobs.decided(stop.id)
                    or opened(all_jobs, stop.id) is not j):
                continue   # answered on GitHub, released or decided: that answer counts
            try:
                self._read(repos[stop.repo], stop, j)
            except Exception as e:
                self._once(j.id, f'ask {stop.repo}#{stop.issue}: reading its thread failed '
                                 f'({type(e).__name__}: {e}); next pass')

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
        if pr is None:
            return
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


def mark(asks: list, answered: list, jobs, opened_at: dict, waits, released=frozenset()) -> None:
    """Each ask's `decide` (whether it can be decided in a T3 thread, and where that stands) and
    `also` (the other place to answer it), in place. `opened_at`: control.json's requests (ask id:
    when); `waits(repo)`: why the Claude lane wouldn't start the thread now, or None;
    `released`: the jobs a release settled (`JobLog.released_ids`), whose asks offer no thread."""
    by_id = {j.id: j for j in jobs}

    def stop_of(a):
        s = by_id.get(a['id'][len(PREFIX):]) if a['id'].startswith(PREFIX) else None
        return s if opens(s) and s.id not in released else None
    for a in asks:
        a['decide'], a['also'] = None, None
        s = stop_of(a)
        if s is None:
            continue
        j = opened(jobs, s.id)
        if j is not None and j.link:
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
    """Why the Claude lane wouldn't start an asked thread now: what the page says."""
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
