"""The run loop: two lanes side by side, one Claude job and one Sol job at a time.

The Claude lane settles what earlier passes left open, then starts at most one job: a decision on a
case the flow doesn't cover (`decisions.py`), then a fix round on a PR the runner found blocking
(`fix.py`), before any new build, so open PRs finish first. It
blocks on `t3 thread start --wait` while the job runs. The Sol lane (`review.py`) reviews at most one
PR a pass, under `<state_dir>/sol.lock`. A second runner process is kept out by a lock on
`<state_dir>/runner.lock`.
"""
import datetime
import os
import threading
import traceback

from .brief import build_brief
from .config import Config, Repo
from .decisions import Decider
from .fix import Fixer, fix_branch, fix_title
from .lock import RunnerBusy, runner_lock  # noqa: F401 (the CLI takes them from here)
from .picker import BuildJob, pick
from .review import Reviewer
from .state import NOT_SENT, NOT_STARTED, Job, JobLog
from .stops import Stopper
from .t3 import T3Error, Thread
from .toast import NoToaster

# What a pass did: started (a job ran to its end), busy (a Claude job is still running from an
# earlier runner, so none was started), idle (nothing to start), gated (the usage gate held the
# chosen Claude job back: `Runner.gate_until` says when to look again).
STARTED, BUSY, IDLE, GATED = 'started', 'busy', 'idle', 'gated'
CLAUDE_KINDS = ('build', 'fix', 'decision')


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
                 toaster=None, gate=None):
        self.config, self.github, self.t3, self.git = config, github, t3, git
        self.gate = gate   # gate.Gate; None starts every Claude job (tests, the live checks)
        self.gate_until: datetime.datetime | None = None
        self._last_gate: str | None = None
        self.out, self.log_line = out, log_line
        self.jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
        self.repos = {r.name: r for r in config.repos}
        self._say_lock = threading.Lock()
        self.toaster = toaster or NoToaster()
        self.reviewer = Reviewer(config, github=github, git=git, sol=sol, jobs=self.jobs,
                                 say=self.say, toaster=self.toaster) if sol is not None else None
        self.fixer = Fixer(config, github=github, git=git, jobs=self.jobs)
        self.decider = Decider(config, github=github, t3=t3, jobs=self.jobs, say=self.say,
                               stopper=Stopper(config, github=github, jobs=self.jobs,
                                               say=self.say, toaster=self.toaster))
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
        if self.settle() == BUSY:
            return BUSY
        chosen = self.choose()
        return self._gated(*chosen) if isinstance(chosen, tuple) else chosen

    def choose(self):
        """(kind, a callable that runs it), or IDLE. The kind is the gate's: None for a
        decision Stefan's own words answer, which starts no thread."""
        if case := self.decider.next_case():
            kind = None if self.decider.direct_answer(case) else 'decision'
            return kind, lambda: self.decider.run(case, self.continue_job)
        if fix := self.next_fix():
            return 'fix', lambda: self.run_fix(*fix)
        for repo in self.config.repos:
            if not repo.github:
                continue   # no GitHub issues to pick from (local-issue repos come in ticket 12)
            job = pick(repo, self.github, held=self.jobs.held_issues(repo.name))
            if job is not None:
                return 'build', lambda: self.run_build(job)
        self.say('Nothing to start: no PR needs a fix round, and no repo has an unblocked '
                 'ready-for-agent issue that isn\'t already being built or held.')
        return IDLE

    def _gated(self, kind, run):
        """The usage gate before a Claude job (`gate.py`): GATED, saying why and until when
        (once, until that changes), or a callable that runs the job and records usage before
        and after it."""
        self.gate_until = None
        if kind is None or self.gate is None:
            return run
        verdict = self.gate.check(kind)
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
                ids = [j.id for j in self.jobs.jobs()[since:] if j.kind in CLAUDE_KINDS]
                self.gate.measured(kind, ids, verdict.usage)
            return did
        return measured

    def idle_seconds(self) -> float:
        """The pause after a pass that started nothing: `poll_seconds`, or less when the gate
        opens sooner (pause, resume and the reserve are read again each pass)."""
        poll = self.config.poll_seconds
        if self.gate_until is None or self.gate is None:
            return poll
        left = (self.gate_until - self.gate.clock()).total_seconds()
        return max(1.0, min(poll, left))

    def next_fix(self):
        """(repo, PR, its blocking review job) for the first PR that needs a fix round now."""
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
                                thread_id=old.thread_id, about=old.id)
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

    def run_fix(self, repo: Repo, pr, review: Job) -> str:
        """A fresh Claude thread in a new T3 worktree at the PR's head H, on a local branch from
        which it pushes to the PR's. IDLE if none was started."""
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
        job = self.jobs.started(kind='fix', repo=repo.name, issue=n, branch=pr.branch,
                                title=fix_title(repo, n), sha=h, round=review.round)
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
        self.say(f'Starting {self._name(job)} ({repo.github}#{n}) after review {review.round}, '
                 f'from {h[:7]} on {work}, pushing to {pr.branch}')
        return self._start(job, repo, brief, h, work)

    def finish_fix(self, job: Job, thread_id: str, exit_code: int, status: str,
                   error: str | None, run_id: str | None) -> Job:
        """Records a fix round: `pushed` if the PR's head moved, `no-push` if it ended at H
        (reviewed already, so the PR waits for Stefan), `head-unknown` if GitHub couldn't say,
        else `failed` or `waiting`."""
        repo = self.repos[job.repo]
        link = worktree = head = pr = None
        commits = []
        try:
            thread, _ = self.t3.show(thread_id)
            link, worktree = thread.link, thread.worktree_path
        except T3Error as e:
            error = error or f'thread show failed: {e}'
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
        outcome = ('waiting' if exit_code == 2 else 'failed' if exit_code else
                   'head-unknown' if head is None else 'pushed' if pushed else 'no-push')
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, commits=commits, pr=pr,
                        worktree=worktree, error=error, head=head)
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
        try:
            thread, _ = self.t3.show(thread_id)
            link, worktree = thread.link, thread.worktree_path
        except T3Error as e:
            error = error or f'thread show failed: {e}'
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
            outcome = 'waiting' if exit_code == 2 else 'failed'
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, commits=commits, pr=pr,
                        worktree=worktree, error=error)
        pr_note = f', PR #{pr["number"]}' if pr else ''
        self.say(f'{self._name(job)} ended: {outcome} (exit {exit_code}, {len(commits)} commits'
                 f'{pr_note}) {link or thread_id}')
        return job

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

    def _sol_lane(self, stop: threading.Event) -> None:
        while not stop.is_set():
            if self._sol_pass() != STARTED:
                stop.wait(self.config.poll_seconds)

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

    def run_forever(self, sleep) -> None:
        """The Claude lane here; the Sol lane in a thread that stops when this loop does."""
        stop = threading.Event()
        sol = threading.Thread(target=self._sol_lane, args=(stop,), name='sol-lane', daemon=True)
        sol.start()
        try:
            while True:
                try:
                    did = self.run_pass()
                except Exception:
                    self.log_line('pass failed:\n' + traceback.format_exc())
                    did = IDLE
                if did != STARTED:
                    sleep(self.idle_seconds())
        finally:
            stop.set()
            sol.join(timeout=5)
