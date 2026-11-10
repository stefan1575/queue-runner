"""The run loop: two lanes side by side, one Claude job and one Sol job at a time.

The Claude lane settles what earlier passes left open, then starts at most one job: a decision on a
case the flow doesn't cover (`decisions.py`), then a repo's live steps after merges (`live.py`),
then a fix round on a PR the runner found blocking (`fix.py`), before any new build, so open PRs
finish first. It
blocks on `t3 thread start --wait` while the job runs. The Sol lane (`review.py`) reviews at most one
PR a pass, under `<state_dir>/sol.lock`. A second runner process is kept out by a lock on
`<state_dir>/runner.lock`.
"""
import datetime
import os
import threading
import time
import traceback

from .brief import build_brief
from .config import Config, Repo
from .decisions import Decider
from .fix import Fixer, fix_branch, fix_title
from .stops import CONFLICT
from .gate import CLAUDE_KINDS
from . import limits as lim
from .live import LiveSteps
from .lock import RunnerBusy, runner_lock  # noqa: F401 (the CLI takes them from here)
from .merge import Merger
from .picker import BuildJob, pick
from .review import Reviewer
from .state import NOT_SENT, NOT_STARTED, RESTART_FAILED, USAGE_LIMIT, Job, JobLog
from .stops import Stopper
from .t3 import T3Error, Thread
from .toast import NoToaster
from .wake import NoWaker

# What a pass did: started (a job ran to its end), busy (a Claude job is still running from an
# earlier runner, so none was started), idle (nothing to start), gated (the usage gate held the
# chosen Claude job back: `Runner.gate_until` says when to look again).
STARTED, BUSY, IDLE, GATED = 'started', 'busy', 'idle', 'gated'
RESTART = 'restart'   # run_forever's end when the runner's own code moved (`restart.py`)

WALL_STEP = 30      # a long sleep looks at the wall clock this often (seconds)
T3_RETRY = 30       # waiting for T3's server at logon: how often to look again (seconds)


def wall_sleep(seconds: float, sleep=time.sleep, clock=time.time, step: float = WALL_STEP) -> None:
    """Sleeps until `seconds` of wall-clock time have passed, in steps of at most `step`, so a
    PC that slept and was woken for this time doesn't sleep on (Windows' timers may not count
    the time the PC was asleep)."""
    end = clock() + seconds
    while (left := end - clock()) > 0:
        sleep(min(step, left))


def job_title(repo: Repo, issue: int) -> str:
    return f'Queue runner build: {repo.name}#{issue}'


def _exit_code(thread: Thread) -> int:
    """What `--wait` would have exited with, for a thread whose run has ended."""
    if thread.status == 'waiting' or thread.pending_requests:
        return 2
    return 0 if thread.status == 'completed' else 1


def _when(stamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


class Runner:
    def __init__(self, config: Config, *, github, t3, git, out, log_line, sol=None,
                 toaster=None, gate=None, limits=None, now=None, waker=None, self_update=None,
                 deps=None):
        self.config, self.github, self.t3, self.git = config, github, t3, git
        # restart.SelfUpdate: the runner's own checkout, restarted on when its base moves
        # (continuous mode, and only when the runner serves its own repo)
        self.self_update = self_update
        self.restart_sha: str | None = None
        # wake.Waker: the Windows wake tasks for the times the lanes wait for (continuous mode)
        self.waker = waker or NoWaker()
        self._wake_lock = threading.Lock()
        self._claude_waits: datetime.datetime | None = None   # gate_until as the last pass left it
        # limits.T3Store, where T3 keeps a usage-limit stop's reset; None reads only what the
        # thread said (tests, the live checks).
        self.limits = limits
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.gate = gate   # gate.Gate; None starts every Claude job (tests, the live checks)
        self.gate_until: datetime.datetime | None = None
        self._last_gate: str | None = None
        self.out, self.log_line = out, log_line
        self.jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
        self.repos = {r.name: r for r in config.repos}
        self._say_lock = threading.Lock()
        self.toaster = toaster or NoToaster()
        self.reviewer = Reviewer(config, github=github, git=git, sol=sol, jobs=self.jobs,
                                 say=self.say, toaster=self.toaster,
                                 deps=deps) if sol is not None else None
        self.fixer = Fixer(config, github=github, git=git, jobs=self.jobs)
        stopper = Stopper(config, github=github, jobs=self.jobs, say=self.say,
                          toaster=self.toaster)
        self.decider = Decider(config, github=github, t3=t3, jobs=self.jobs, say=self.say,
                               stopper=stopper)
        self.live = LiveSteps(config, github=github, git=git, t3=t3, jobs=self.jobs,
                              say=self.say, stopper=stopper,
                              merger=Merger(config, github=github, git=git, jobs=self.jobs,
                                            say=self.say),
                              limit=self._limit, find_thread=self._find_thread, now=self.now)
        self._last_why: dict[tuple[str, int], str | None] = {}

    def say(self, line: str) -> None:
        with self._say_lock:   # both lanes say things
            self.log_line(line)
            print(line, file=self.out)

    # --- one pass -------------------------------------------------------------------------

    def run_pass(self) -> str:
        job = self.plan()
        return job() if callable(job) else job

    def plan(self):
        """Settles, then chooses this pass's Claude job: a callable that runs it, or BUSY, IDLE
        or GATED. A decision comes first, then a fix round, then a build."""
        self.gate_until = None   # a wait from an earlier pass is that pass's
        if self.settle() == BUSY:
            return BUSY
        chosen = self.choose()
        return self._gated(*chosen) if isinstance(chosen, tuple) else chosen

    def choose(self):
        """(kind, then, a callable that runs it), or IDLE, for the gate (a decision, a repo's
        live steps, a fix round, a build, in that order): `kind` None for a
        decision Stefan's own words answer, which starts no thread; `then` the kind of job a
        decision may continue in the same pass (a retry or an answer). A job cut off by a usage
        limit comes before all of them, and until it may resume nothing else starts: the limit
        is the whole account's."""
        if limited := self.jobs.limited_jobs():
            old = limited[0]
            at = _when(old.resume_at) if old.resume_at else self.now()
            if self.now() < at:
                self.gate_until = at
                text = (f'{self._name(old)} was cut off by a usage limit; it resumes after '
                        f'{at.astimezone():%Y-%m-%d %H:%M}')
                if text != self._last_gate:
                    self.say(f'Claude lane waits: {text}')
                self._last_gate = text
                return GATED
            return old.kind, None, lambda: self.recover(old)
        if case := self.decider.next_case():
            if self.decider.direct_answer(case):
                return None, None, lambda: self.decider.run(case, self.continue_job)
            then = case.about.kind if {'retry', 'answer'} & set(case.allowed) else None
            return 'decision', then, lambda: self.decider.run(case, self.continue_job)
        if live := self.live.next():
            return 'live', None, lambda: self.live.run(*live)
        if fix := self.next_fix():
            return 'fix', None, lambda: self.run_fix(*fix)
        for repo in self.config.repos:
            if not repo.github or repo.local_issues:
                # No GitHub issues to pick from: a local-ticket repo (`tickets.py`) is only
                # named by --dry-run.
                continue
            job = pick(repo, self.github, held=self.jobs.held_issues(repo.name))
            if job is not None:
                return 'build', None, lambda: self.run_build(job)
        self.say('Nothing to start: no PR needs a fix round, and no repo has an unblocked '
                 'ready-for-agent issue that isn\'t already being built or held.')
        self.gate_until = self.live.wait_until   # a live run's limit: the wake task for it
        return IDLE

    def _gated(self, kind, then, run):
        """The usage gate before a Claude job (`gate.py`): GATED, saying why and until when
        (once, until that changes), or a callable that runs the job and records usage before
        and after it."""
        if kind is None or self.gate is None:
            return run
        verdict = self.gate.check(kind, then)
        if not verdict.go:
            self.gate_until = verdict.until
            if verdict.text != self._last_gate:
                self.say(f'Claude lane waits: {verdict.text}')
            self._last_gate = verdict.text
            return GATED
        self._last_gate = None
        self.say(f'Usage gate: {verdict.text}')

        def measured():
            since = len(self.jobs.jobs())
            did = run()
            if did == STARTED:   # a thread ran: what it cost teaches the next estimate
                new = [j for j in self.jobs.jobs()[since:] if j.kind in CLAUDE_KINDS]
                # A decision that continued a build or fix counts as that job's cost, so a
                # plain decision's estimate stays a decision's.
                learned = next((j.kind for j in new if j.kind != 'decision'), kind)
                self.gate.measured(learned, [j.id for j in new], verdict.usage)
            return did
        return measured

    def idle_seconds(self) -> float:
        """The pause after a pass that started nothing: `poll_seconds`, or less when the gate
        opens sooner (pause, resume and the reserve are read again each pass)."""
        poll = self.config.poll_seconds
        if self.gate_until is None:
            return poll
        left = (self.gate_until - self.now()).total_seconds()
        return min(poll, left) if left >= 1 else poll

    def next_fix(self):
        """(repo, PR, its blocking review job) for the first PR that needs a fix round now;
        the review is None for a conflict round."""
        for repo in self.config.repos:
            if not repo.github:
                continue
            try:
                found = list(self.fixer.candidates(repo))
            except Exception as e:   # GitHub down on PRs: a build may still be picked
                self.say(f'fix rounds on {repo.name}: reading PRs failed ({type(e).__name__}: '
                         f'{e})')
                continue
            for pr, review, why in found:
                key = (repo.name, pr.number)
                if why and self._last_why.get(key) != why:
                    self.say(f'fix {repo.name}#{pr.number}: not now, {why}')
                self._last_why[key] = why
                if why is None:
                    return repo, pr, review
        return None

    def settle(self) -> str | None:
        """Records how jobs left open by a dead runner, or left waiting for an answer, ended.
        BUSY if one of their threads is still running."""
        busy = None
        for job in self.jobs.open_jobs():
            if job.kind == 'decision':   # cut off with its runner: decided again
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                                error='The runner stopped mid-decision.')
                self.say(f'{self._name(job)}: cut off with its runner; decided again')
                continue
            if job.kind == 'live':
                if self.live.settle(job):
                    busy = BUSY
                continue
            if job.kind not in ('build', 'fix'):
                continue   # an open review or merge is the Sol lane's to settle
            thread = self._find_thread(job)
            if thread is None:
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                                error='No T3 thread was found for this job.')
                self.say(f'{self._name(job)}: no thread was started; closed as not-started')
            elif thread.active and not thread.pending_requests:
                self.say(f'{self._name(job)} is still running in {thread.link}: '
                         'no other Claude job starts')
                busy = BUSY
            else:
                self.finish(job, thread.thread_id, _exit_code(thread), thread.status, None,
                            thread.latest_run_id)
        for job in self.jobs.waiting_jobs():
            try:
                thread, _ = self.t3.show(job.thread_id)
            except T3Error as e:
                # Stefan may have answered it and set it running: start nothing until T3 says.
                self.say(f'{self._name(job)}: cannot read {job.thread_id} ({e}); '
                         'no other Claude job starts')
                busy = BUSY
                continue
            if thread.active and not thread.pending_requests:
                busy = BUSY   # answered, and running again
            elif _exit_code(thread) != 2:
                self.finish(job, thread.thread_id, _exit_code(thread), thread.status, None,
                            thread.latest_run_id)
        return busy

    def _find_thread(self, job: Job) -> Thread | None:
        if job.thread_id:
            return self.t3.show(job.thread_id)[0]
        since = _when(job.started_at) - datetime.timedelta(seconds=5)
        repo = self.repos.get(job.repo)
        if repo is None:
            return None
        found = [t for t in self.t3.list(repo.path)
                 if t.title == job.title and _when(t.created_at) >= since]
        if not found:
            return None
        newest = max(found, key=lambda t: _when(t.created_at))
        return self.t3.show(newest.thread_id)[0]

    # --- a build job ----------------------------------------------------------------------

    def run_build(self, build: BuildJob) -> str:
        """STARTED once a thread ran (or may still be running); IDLE if none was started, so
        the loop pauses before trying again."""
        repo, n = build.repo, build.issue.number
        self.git.fetch(repo.path, repo.base)
        job = self.jobs.started(kind='build', repo=repo.name, issue=n, branch=build.branch,
                                title=job_title(repo, n))
        if self.git.has_branch(repo.path, build.branch):
            self.jobs.ended(job.id, exit_code=None, outcome='branch-exists',
                            error=f'A local branch {build.branch} is left from an earlier run.')
            self.say(f'{self._name(job)} not started: local branch {build.branch} already exists '
                     f'(held until released)')
            return IDLE
        brief = build_brief(build, self.github.issue_comments(repo, n))
        where = f' ({repo.github}#{n})' if repo.github else ''
        self.say(f'Starting {self._name(job)}{where} on {build.branch} from {build.base}')
        return self._start(job, repo, brief, build.base, build.branch)

    def _start(self, job: Job, repo: Repo, brief: str, base: str, branch: str) -> str:
        """Runs the job's thread in a new T3 worktree on `branch` from `base`, and records how
        it ended."""
        try:
            result = self.t3.start(repo.path, brief, title=job.title,
                                   provider=self.config.claude_provider,
                                   model=self.config.claude_model, worktree=base,
                                   branch=branch)
        except T3Error as e:
            try:
                thread = self._find_thread(job)
            except T3Error:
                thread = job   # T3 can't say: leave the job open for the next pass to settle
            if thread is None:
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED, error=str(e))
                self.say(f'{self._name(job)} not started: {e}')
                return IDLE
            self.say(f'{self._name(job)}: lost track of its thread ({e}); '
                     'the next pass settles it')
            return STARTED
        self.finish(job, result.thread_id, result.exit_code, result.status, result.error,
                    result.run_id)
        return STARTED

    # --- a decision's retry or answer ------------------------------------------------------

    def continue_job(self, old: Job, message: str) -> str:
        """Sends `message` to an earlier build or fix job's thread (a decision's retry, or the
        answer to its question) and records the run as a new job of its kind, which carries the
        thread in its start record so a dead runner's settle finds it. The earlier job, if it
        was waiting, ends `continued`."""
        job = self.jobs.started(kind=old.kind, repo=old.repo, issue=old.issue, branch=old.branch,
                                title=old.title, sha=old.sha, round=old.round,
                                thread_id=old.thread_id, about=old.id, cause=old.cause)
        if old.outcome == 'waiting':
            self.jobs.ended(old.id, exit_code=old.exit_code, outcome='continued')
        self.say(f'Continuing {self._name(job)} in {old.link or old.thread_id}')
        try:
            result = self.t3.send(old.thread_id, message)
        except T3Error as e:
            try:
                running = self.t3.show(old.thread_id)[0].active
            except T3Error:
                running = True   # T3 can't say: leave the job open for the next pass to settle
            if running:
                self.say(f'{self._name(job)}: lost track of its thread ({e}); '
                         'the next pass settles it')
                return STARTED
            # The message never reached a run: as it was, and the case is decided again.
            # (`not-sent`, not `not-started`: the issue stays held.)
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_SENT, error=str(e))
            if old.outcome == 'waiting':
                self.jobs.ended(old.id, exit_code=old.exit_code, outcome='waiting')
            self.say(f'{self._name(job)} not continued: {e}')
            return IDLE
        self.finish(job, result.thread_id, result.exit_code, result.status, result.error,
                    result.run_id)
        return STARTED

    # --- a fix round ----------------------------------------------------------------------

    def run_fix(self, repo: Repo, pr, review: Job | None) -> str:
        """A fresh Claude thread in a new T3 worktree at the PR's head H, on a local branch from
        which it pushes to the PR's. With no review, a conflict round: it merges the base in.
        IDLE if none was started."""
        n, h = pr.number, pr.head_sha
        try:
            _, fetched = self.git.fetch_pr(repo.path, n, pr.base)
        except Exception as e:
            self.say(f'fix {repo.name}#{n}: fetching the PR failed ({e}); next pass')
            return IDLE
        if fetched != h:
            self.say(f'fix {repo.name}#{n}: the head moved from {h[:7]} to {fetched[:7]}; '
                     'Sol reviews it first')
            return IDLE
        work = fix_branch(n, h)
        cause = CONFLICT if review is None else None
        job = self.jobs.started(kind='fix', repo=repo.name, issue=n, branch=pr.branch,
                                title=fix_title(repo, n, cause), sha=h,
                                round=review and review.round, cause=cause)
        if self.git.has_branch(repo.path, work):
            self.jobs.ended(job.id, exit_code=None, outcome='branch-exists',
                            error=f'A local branch {work} is left from an earlier run.')
            self.say(f'{self._name(job)} not started: local branch {work} already exists '
                     '(held until released)')
            return IDLE
        try:
            brief = self.fixer.brief(repo, pr, review)
        except Exception as e:
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'building the brief failed: {type(e).__name__}: {e}')
            self.say(f'{self._name(job)} not started: building the brief failed ({e})')
            return IDLE
        why = (f'to resolve its conflict with {pr.base}' if review is None else
               f'after review {review.round}')
        self.say(f'Starting {self._name(job)} ({repo.github}#{n}) {why}, '
                 f'from {h[:7]} on {work}, pushing to {pr.branch}')
        return self._start(job, repo, brief, h, work)

    def finish_fix(self, job: Job, thread_id: str, exit_code: int, status: str,
                   error: str | None, run_id: str | None) -> Job:
        """Records a fix round: `pushed` if the PR's head moved, `no-push` if it ended at H
        (reviewed already, so the PR waits for Stefan), `head-unknown` if GitHub couldn't say,
        else `failed` or `waiting`."""
        repo = self.repos[job.repo]
        link = worktree = head = pr = None
        commits, said = [], []
        try:
            thread, said = self.t3.show(thread_id)
            link, worktree = thread.link, thread.worktree_path
        except T3Error as e:
            error = error or f'thread show failed: {e}'
        limit = self._limit(thread_id, run_id, exit_code, error, said)
        try:
            now = self.github.pull(repo, job.issue)
            head = now.head_sha
            pr = {'number': now.number, 'url': now.url, 'state': now.state}
            if head != job.sha:
                self.git.fetch_pr(repo.path, job.issue, now.base)
                commits = self.git.log(repo.path, job.sha, head)
        except Exception as e:   # the record matters more than its commit list
            error = error or f'reading the PR after the round failed: {type(e).__name__}: {e}'
        pushed = head is not None and head != job.sha
        outcome = ('waiting' if exit_code == 2 else USAGE_LIMIT if limit else
                   'failed' if exit_code else
                   'head-unknown' if head is None else 'pushed' if pushed else 'no-push')
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, commits=commits, pr=pr,
                        worktree=worktree, error=error, head=head, **(limit or {}))
        moved = (f', head {job.sha[:7]} -> {head[:7]}, {len(commits)} commits' if pushed else
                 f', head still {job.sha[:7]}' if head else ', head unknown')
        self.say(f'{self._name(job)} ended: {outcome} (exit {exit_code}{moved}) '
                 f'{link or thread_id}')
        return job

    def finish(self, job: Job, thread_id: str, exit_code: int, status: str, error: str | None,
               run_id: str | None) -> Job:
        if job.kind == 'fix':
            return self.finish_fix(job, thread_id, exit_code, status, error, run_id)
        repo = self.repos[job.repo]
        link = worktree = None
        said = []
        try:
            thread, said = self.t3.show(thread_id)
            link, worktree = thread.link, thread.worktree_path
        except T3Error as e:
            error = error or f'thread show failed: {e}'
        limit = self._limit(thread_id, run_id, exit_code, error, said)
        commits = []
        try:
            commits = self.git.commits(repo.path, f'origin/{repo.base}', job.branch)
        except Exception as e:   # the record matters more than its commit list
            error = error or f'reading commits failed: {e}'
        pr = None
        if repo.github:   # a job may open its PR and fail or stop after
            try:
                pr = self.github.pull_for_branch(repo, job.branch)
            except Exception as e:
                error = error or f'PR lookup failed: {e}'
        if exit_code == 0:
            outcome = 'done' if pr or not repo.github else 'done-no-pr'
        else:
            outcome = 'waiting' if exit_code == 2 else USAGE_LIMIT if limit else 'failed'
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, commits=commits, pr=pr,
                        worktree=worktree, error=error, **(limit or {}))
        pr_note = f', PR #{pr["number"]}' if pr else ''
        self.say(f'{self._name(job)} ended: {outcome} (exit {exit_code}, {len(commits)} commits'
                 f'{pr_note}) {link or thread_id}')
        return job

    def _limit(self, thread_id: str, run_id: str | None, exit_code: int, error: str | None,
               said) -> dict | None:
        """For a failed run that stopped on a usage limit: the end record's `resume_at` and
        `context` (`limits.py`), said once in the log. None for any other end."""
        if exit_code != 1:
            return None
        # Only this run's own message: an earlier run's limit message may still be the last.
        last = [m.text for m in said if m.role == 'assistant'
                and (m.run_id is None or run_id is None or m.run_id == run_id)][-1:]
        stop = lim.limit_stop(self.limits, thread_id, run_id, [error, *last])
        if stop is None:
            return None
        resume = lim.resume_at(self.now(), stop.reset_at)
        tokens = self.limits.context_tokens(thread_id) if self.limits else None
        known = (f'T3 says it resets at {stop.reset_at.astimezone():%Y-%m-%d %H:%M}'
                 if stop.reset_at else "T3 doesn't say when it resets: 5h05m from now")
        how = ('continued in place' if lim.in_place(tokens) else 'a fresh thread') + (
            f', context {tokens:,} tokens' if tokens is not None else ', context unknown')
        self.say(f'{thread_id} stopped on a usage limit; {known}. It resumes after '
                 f'{resume.astimezone():%Y-%m-%d %H:%M} ({how}).')
        return {'resume_at': resume.isoformat(timespec='seconds'), 'context': tokens}

    # --- recovering a job cut off by a usage limit -----------------------------------------

    def recover(self, old: Job) -> str:
        """A build or fix cut off by a usage limit, once the limit has reset: its thread
        continued in place when its context is about 50k tokens or less, else a fresh thread
        from the job's own brief plus the old thread's link and last 3 messages, in a new
        worktree on the same branch at the old thread's newest commit. The old thread is left
        as it is: a script can't settle a T3 thread (AGENTS.md)."""
        if lim.in_place(old.context):
            return self.continue_job(old, lim.RESUME_MESSAGE)
        try:
            _, messages = self.t3.show(old.thread_id, 3)
        except T3Error as e:
            self.say(f'{self._name(old)}: reading its thread failed ({e}); next pass')
            return IDLE
        repo = self.repos[old.repo]
        work = fix_branch(old.issue, old.sha) if old.kind == 'fix' else old.branch
        job = self.jobs.started(kind=old.kind, repo=old.repo, issue=old.issue, branch=old.branch,
                                title=old.title, sha=old.sha, round=old.round, about=old.id,
                                cause=old.cause)
        try:
            brief = self._brief_again(repo, old)
            tip, wip = self.git.free_branch(repo.path, work, old.worktree)
        except Exception as e:
            # Not `not-started`, which would retry every pass. The old job stays the PR's
            # writer (nothing reviews or merges what it pushed) until Stefan releases it.
            why = f'{type(e).__name__}: {e}'
            self.jobs.ended(job.id, exit_code=None, outcome=RESTART_FAILED,
                            error=f'restarting after the usage limit failed: {why}')
            self.say(f'{self._name(job)}: restarting after the usage limit failed ({why}); '
                     f'held until --release {old.repo}#{old.issue}')
            self.toaster.toast(f'{old.repo} #{old.issue} needs you',
                               f'Restarting its {old.kind} after a usage limit failed: '
                               f'{why}'[:250], old.link or '', tag=f'restart-{old.id}'[-60:])
            return IDLE
        if tip is None:   # it made no commit: from where the old thread started
            tip = old.sha if old.kind == 'fix' else f'origin/{repo.base}'
        brief += lim.restart_section(old, work, tip, wip, messages)
        self.say(f'Restarting {self._name(job)} fresh after the usage limit, on {work} at '
                 f'{tip[:7]}; the old thread was {old.link or old.thread_id}')
        return self._start(job, repo, brief, tip, work)

    def _brief_again(self, repo: Repo, old: Job) -> str:
        """The job's brief, built afresh from its sources as when it started."""
        if old.kind == 'build':
            self.git.fetch(repo.path, repo.base)
            issue = self.github.issue(repo.github, old.issue)
            build = BuildJob(repo=repo, issue=issue, branch=old.branch,
                             base=f'origin/{repo.base}')
            return build_brief(build, self.github.issue_comments(repo, old.issue))
        from dataclasses import replace
        pr = self.github.pull(repo, old.issue)
        self.git.fetch_pr(repo.path, old.issue, pr.base)
        if old.cause == CONFLICT:
            return self.fixer.conflict_brief(repo, replace(pr, head_sha=old.sha))
        review = next((j for j in reversed(self.jobs.on('review', repo.name, old.issue, old.sha,
                                                        released=True))
                       if j.round == old.round), None)
        if review is None:   # a review from before the cutover (`Fixer.adopted`)
            review = self.fixer.adopted(repo, old.issue, old.sha, old.round)
        if review is None:
            raise ValueError(f'no review {old.round} of {old.sha[:7]} in the job log')
        return self.fixer.brief(repo, replace(pr, head_sha=old.sha), review)

    @staticmethod
    def _name(job: Job) -> str:
        return f'{job.kind} {job.repo}#{job.issue}'

    # --- the loop ---------------------------------------------------------------------------

    def _sol_pass(self) -> str:
        try:
            return self.reviewer.review_pass() if self.reviewer else IDLE
        except Exception:
            self.log_line('Sol pass failed:\n' + traceback.format_exc())
            return IDLE

    def wake_times(self) -> list[datetime.datetime]:
        """The times the lanes wait for now: the Claude lane's gate or limit, Sol's resume."""
        times = [self._claude_waits]
        if resume := self.jobs.sol_resume_at():
            times.append(_when(resume))
        return [t for t in times if t is not None and t > self.now()]

    def _wake(self) -> None:
        try:
            with self._wake_lock:   # both lanes sync after their passes
                self.waker.sync(self.wake_times())
        except Exception:
            self.log_line('wake sync failed:\n' + traceback.format_exc())

    def wait_for_t3(self, sleep) -> None:
        """At logon T3 may not be up yet: look until its server answers (`thread list` on the
        first repo's project), saying once why it waits, and again only when that changes."""
        said = None
        while True:
            try:
                self.t3.list(self.config.repos[0].path)
            except T3Error as e:
                if 'No T3 Code project matches' in str(e):   # the server answered: it's up
                    self.say(f"T3's server is up, but: {e}")
                    return
                if str(e) != said:
                    self.say(f"Waiting for T3's server: {e}")
                said = str(e)
                sleep(T3_RETRY)
                continue
            if said is not None:
                self.say("T3's server is up")
            return

    def _sol_lane(self, stop: threading.Event) -> None:
        while not stop.is_set():
            did = self._sol_pass()
            self._wake()
            if did != STARTED:
                end = time.time() + self.config.poll_seconds
                while not stop.is_set() and (left := end - time.time()) > 0:
                    stop.wait(min(WALL_STEP, left))

    def run_once(self) -> None:
        """One pass of each lane, side by side. The Claude lane chooses its job before the Sol
        lane starts, so what this pass's review decides waits for the next pass."""
        job = self.plan()
        sol = threading.Thread(target=self._sol_pass, name='sol-lane')
        sol.start()
        try:
            if callable(job):
                job()
        finally:
            sol.join()

    def _start_sol_lane(self, stop: threading.Event) -> threading.Thread:
        sol = threading.Thread(target=self._sol_lane, args=(stop,), name='sol-lane', daemon=True)
        sol.start()
        return sol

    def _update_due(self) -> bool:
        try:
            return self.self_update is not None and self.self_update.due()
        except Exception:
            self.log_line('self-update check failed:\n' + traceback.format_exc())
            return False

    def run_forever(self, sleep) -> str:
        """The Claude lane here; the Sol lane in a thread that stops when this loop does. After
        each pass of either lane the wake tasks are set to the times they wait for. Between
        Claude jobs, when the runner's own checkout is behind its base (`restart.py`), it lets
        the Sol lane finish its pass, updates the checkout and returns RESTART, with the new
        commit in `restart_sha`; if git won't update it, both lanes carry on."""
        stop = threading.Event()
        sol = self._start_sol_lane(stop)
        try:
            while True:
                try:
                    did = self.run_pass()
                except Exception:
                    self.log_line('pass failed:\n' + traceback.format_exc())
                    did = IDLE
                self._claude_waits = self.gate_until
                self._wake()
                if self._update_due():
                    self.say("The runner's own code moved: restarting on the new code once the "
                             'Sol lane ends its pass')
                    stop.set()
                    sol.join()
                    if sha := self.self_update.update():
                        self.restart_sha = sha
                        return RESTART
                    stop = threading.Event()
                    sol = self._start_sol_lane(stop)
                if did != STARTED:
                    sleep(self.idle_seconds())
        finally:
            stop.set()
            sol.join(timeout=5)
