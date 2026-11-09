"""In-memory T3 and git for tests: no T3 server, no git."""
from queue_runner.t3 import RunResult, T3Error, Thread


class FakeT3:
    """`outcomes` are what successive `start` calls do: (exit code, status), or a T3Error.
    Each started thread is kept, so `show` and `list` can find it; tests change its status
    to play a thread that moves on (Stefan answered it, or it was still running)."""

    def __init__(self, outcomes=()):
        self.outcomes = list(outcomes)
        self.starts = []
        self.threads: dict[str, Thread] = {}

    def add(self, thread_id, title, status, created_at='2099-01-01T00:00:00.000Z', **extra):
        self.threads[thread_id] = Thread(
            thread_id=thread_id, title=title, status=status, settled=False,
            link=f'https://app.t3.codes/threads/env/{thread_id}', created_at=created_at,
            latest_run_id=f'run:{thread_id}:1', **extra)
        return self.threads[thread_id]

    def set_status(self, thread_id, status):
        from dataclasses import replace
        self.threads[thread_id] = replace(self.threads[thread_id], status=status)

    def start(self, project, message, *, title, provider=None, model=None, worktree=None,
              branch=None):
        self.starts.append(dict(project=project, message=message, title=title,
                                provider=provider, model=model, worktree=worktree, branch=branch))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        code, status = outcome
        thread_id = f'mcp:t{len(self.starts)}'
        self.add(thread_id, title, status, branch=branch,
                 worktree_path=f'C:/t3/worktrees/{thread_id}')
        return RunResult(exit_code=code, thread_id=thread_id, run_id=f'run:{thread_id}:1',
                         status=status, reply='Done.' if code == 0 else None,
                         error='It broke.' if code == 1 else None)

    def show(self, thread_id, messages=3):
        if thread_id not in self.threads:
            raise T3Error(f'no thread {thread_id}')
        return self.threads[thread_id], []

    def list(self, project):
        return sorted(self.threads.values(), key=lambda t: t.created_at, reverse=True)


class FakeGit:
    def __init__(self, branches=(), commits=None):
        self.local_branches = set(branches)
        self.commit_log = dict(commits or {})
        self.fetches = []

    def fetch(self, path, branch):
        self.fetches.append((path, branch))

    def has_branch(self, path, branch):
        return branch in self.local_branches

    def commits(self, path, base, branch):
        return list(self.commit_log.get(branch, []))
