"""In-memory T3 and git for tests: no T3 server, no git."""
from queue_runner.t3 import Launched, RunResult, T3Error, Thread


def decision_reply(action, version=1, prose='I read the sources.', **fields) -> str:
    """A decision thread's reply ending in its answer block."""
    import json
    block = json.dumps({'version': version, 'action': action, **fields})
    return f'{prose}\n\n```queue-runner-decision\n{block}\n```\n'


class FakeT3:
    """`outcomes` are what successive `start` calls do: (exit code, status), or a T3Error.
    Each started thread is kept, so `show` and `list` can find it; tests change its status
    to play a thread that moves on (Stefan answered it, or it was still running)."""

    def __init__(self, outcomes=()):
        self.outcomes = list(outcomes)   # (code, status) or (code, status, reply), or a T3Error
        self.starts = []
        self.sends = []
        self.threads: dict[str, Thread] = {}
        self.messages: dict[str, list] = {}   # thread id -> its last messages (Message)
        self.launches = []        # threads started without waiting (ticket 35's ask threads)
        self.launch_error = None  # a T3Error the next launch raises
        self.settles = []         # thread ids settled, in order (ticket 70)
        self.settle_error = None  # an exception every settle raises
        self.renames = []

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
        thread_id = f'mcp:t{len(self.starts)}'
        self.add(thread_id, title, outcome[1], branch=branch,
                 worktree_path=f'C:/t3/worktrees/{thread_id}')
        return self._result(thread_id, outcome)

    @staticmethod
    def _result(thread_id, outcome):
        code, status = outcome[:2]
        reply = outcome[2] if len(outcome) > 2 else ('Done.' if code == 0 else None)
        return RunResult(exit_code=code, thread_id=thread_id, run_id=f'run:{thread_id}:1',
                         status=status, reply=reply, error='It broke.' if code == 1 else None)

    def launch(self, project, message, *, title, provider=None, model=None):
        """A thread started without waiting: it's running, with no reply yet."""
        self.launches.append(dict(project=project, message=message, title=title,
                                  provider=provider, model=model))
        if self.launch_error is not None:
            error, self.launch_error = self.launch_error, None
            raise error
        thread_id = f'mcp:a{len(self.launches)}'
        self.add(thread_id, title, 'running')
        return Launched(thread_id=thread_id, run_id=f'run:{thread_id}:1')

    def send(self, thread_id, message):
        """A message to an existing thread: the next outcome is how its new run ends."""
        self.sends.append(dict(thread_id=thread_id, message=message))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        from dataclasses import replace   # a new turn unsettles a settled thread, as in T3
        self.threads[thread_id] = replace(self.threads[thread_id], status=outcome[1],
                                          settled=False)
        return self._result(thread_id, outcome)

    def show(self, thread_id, messages=3):
        if thread_id not in self.threads:
            raise T3Error(f'no thread {thread_id}')
        return self.threads[thread_id], list(self.messages.get(thread_id, []))[-messages:]

    def settle(self, thread_id):
        """Settled threads stay readable (`show`, `list`), as in T3 (checked 2026-11-16)."""
        from dataclasses import replace
        if self.settle_error is not None:
            raise self.settle_error
        self.settles.append(thread_id)
        if thread_id in self.threads:
            self.threads[thread_id] = replace(self.threads[thread_id], settled=True)

    def rename(self, thread_id, title):
        self.renames.append((thread_id, title))

    def list(self, project):
        return sorted(self.threads.values(), key=lambda t: t.created_at, reverse=True)


class FakeGit:
    def __init__(self, branches=(), commits=None):
        self.local_branches = set(branches)
        self.commit_log = dict(commits or {})
        self.fetches = []
        self.tips = {}    # branch -> its tip, for free_branch (an exception: it fails)
        self.uncommitted = {}   # branch -> the commit keeping what its worktree left
        self.freed = []   # (branch, worktree) freed after a usage limit

    def fetch(self, path, branch):
        self.fetches.append((path, branch))

    def has_branch(self, path, branch):
        return branch in self.local_branches

    def commits(self, path, base, branch):
        return list(self.commit_log.get(branch, []))

    def free_branch(self, path, branch, worktree):
        self.freed.append((branch, worktree))
        self.local_branches.discard(branch)
        if isinstance(self.tips, Exception):
            raise self.tips
        return self.tips.get(branch), self.uncommitted.get(branch)


class FakeReviewGit(FakeGit):
    """FakeGit plus a review's checkout: `heads` is what fetching each PR finds (default: the
    sha the test says), `files` what the checkout holds, `ancestors` the (older, newer) pairs
    in history."""

    def __init__(self, *args, heads=None, files=None, ancestors=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.heads = dict(heads or {})
        self.files = dict(files or {})
        self.ancestors = set(ancestors)
        self.checkouts, self.removed = [], []
        self.removed_worktrees = []
        self.stuck = set()   # worktrees git can't remove
        self.moved_aside = {}   # a review checkout git can't delete: where it's moved
        self.stale = []         # what sweep_stale can't delete

    def sweep_stale(self, checkouts_dir):
        return list(self.stale)

    def fetch_pr(self, path, number, base):
        self.fetches.append((path, f'pr{number}', base))
        return f'refs/queue-runner/pr{number}', self.heads[number]

    def checkout(self, path, ref, worktree):
        import os
        os.makedirs(worktree, exist_ok=True)
        for name, text in self.files.items():
            with open(os.path.join(worktree, name), 'w', encoding='utf-8') as f:
                f.write(text)
        self.checkouts.append((path, ref, worktree))

    def remove_checkout(self, path, worktree, ref=None):
        import shutil
        shutil.rmtree(worktree, ignore_errors=True)
        self.removed.append((worktree, ref))
        return self.moved_aside.get(worktree)

    def is_ancestor(self, path, older, newer):
        return (older, newer) in self.ancestors

    def diff(self, path, a, b, merge_base=False):
        return f'diff {a}{"..." if merge_base else ".."}{b}\n'

    def log(self, path, a, b):
        return list(self.commit_log.get((a, b), []))

    def diffstat(self, path, a, b):
        return f' src/a.ts | 2 +-\n 1 file changed ({a}...{b})\n'

    def remove_worktree(self, path, worktree, branch=None):
        self.removed_worktrees.append((worktree, branch))
        return worktree not in self.stuck


class FakeSol:
    """Plays Sol: each review returns the next reply, or raises it if it's an exception."""

    def __init__(self, replies=()):
        self.replies = list(replies)
        self.briefs = []

    def review(self, brief, reply, workdir, out, writable=()):
        with open(brief, encoding='utf-8') as f:
            self.briefs.append({'brief': f.read(), 'workdir': workdir,
                                'writable': list(writable)})
        r = self.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        with open(reply, 'w', encoding='utf-8') as f:
            f.write(r)
        return r.strip()
