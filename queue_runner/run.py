"""The run loop: settle what earlier passes left open, then start at most one Claude job.

A pass blocks on `t3 thread start --wait` while its job runs, so at most one Claude job runs at
a time; a second runner process is kept out by a lock on `<state_dir>/runner.lock`.
"""
import contextlib
import datetime
import os
import traceback

from .brief import build_brief
from .config import Config, Repo
from .picker import BuildJob, pick
from .state import NOT_STARTED, Job, JobLog
from .t3 import T3Error, Thread

# What a pass did: started (a job ran to its end), busy (a Claude job is still running from an
# earlier runner, so none was started), idle (nothing to start).
STARTED, BUSY, IDLE = 'started', 'busy', 'idle'


class RunnerBusy(RuntimeError):
    pass


@contextlib.contextmanager
def runner_lock(state_dir: str):
    """Held for the runner's whole life. The OS drops it if the process dies."""
    os.makedirs(state_dir, exist_ok=True)
    f = open(os.path.join(state_dir, 'runner.lock'), 'a+')
    try:
        try:
            if os.name == 'nt':
                import msvcrt
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RunnerBusy(f'another queue runner holds {f.name}') from None
        try:
            yield
        finally:
            if os.name == 'nt':
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        f.close()


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
    def __init__(self, config: Config, *, github, t3, git, out, log_line):
        self.config, self.github, self.t3, self.git = config, github, t3, git
        self.out, self.log_line = out, log_line
        self.jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
        self.repos = {r.name: r for r in config.repos}

    def say(self, line: str) -> None:
        self.log_line(line)
        print(line, file=self.out)

    # --- one pass -------------------------------------------------------------------------

    def run_pass(self) -> str:
        if self.settle() == BUSY:
            return BUSY
        for repo in self.config.repos:
            if not repo.github:
                continue   # no GitHub issues to pick from (local-issue repos come in ticket 12)
            job = pick(repo, self.github, held=self.jobs.held_issues(repo.name))
            if job is not None:
                return self.run_build(job)
        self.say('Nothing to start: no repo has an unblocked ready-for-agent issue that isn\'t '
                 'already being built or held.')
        return IDLE

    def settle(self) -> str | None:
        """Records how jobs left open by a dead runner, or left waiting for an answer, ended.
        BUSY if one of their threads is still running."""
        busy = None
        for job in self.jobs.open_jobs():
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
        try:
            result = self.t3.start(repo.path, brief, title=job.title,
                                   provider=self.config.claude_provider,
                                   model=self.config.claude_model, worktree=build.base,
                                   branch=build.branch)
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

    def finish(self, job: Job, thread_id: str, exit_code: int, status: str, error: str | None,
               run_id: str | None) -> Job:
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

    def run_forever(self, sleep) -> None:
        while True:
            try:
                did = self.run_pass()
            except Exception:
                self.log_line('pass failed:\n' + traceback.format_exc())
                did = IDLE
            if did != STARTED:
                sleep(self.config.poll_seconds)
