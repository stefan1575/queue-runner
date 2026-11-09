"""Local git, as the runner needs it around a build job: fetch the base, spot a leftover branch,
read the branch's commits afterwards. T3 worktrees share their repo's refs, so the repo's own
path sees the job's branch."""
import subprocess


class GitError(RuntimeError):
    pass


def run_git(args: list[str]) -> tuple[int, str, str]:
    p = subprocess.run(['git', *args], capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=300, stdin=subprocess.DEVNULL,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return p.returncode, p.stdout, p.stderr


class GitCli:
    def __init__(self, run=run_git):
        self._run = run

    def _ok(self, args) -> str:
        code, out, err = self._run(args)
        if code:
            raise GitError(f"git {' '.join(args)} failed ({code}): {err.strip()}")
        return out

    def fetch(self, path: str, branch: str) -> None:
        """Updates `origin/<branch>`: T3 makes a job's worktree from it without fetching."""
        self._ok(['-C', path, 'fetch', '--quiet', 'origin', branch])

    def has_branch(self, path: str, branch: str) -> bool:
        code, _, _ = self._run(['-C', path, 'rev-parse', '--verify', '--quiet',
                                f'refs/heads/{branch}'])
        return code == 0

    def commits(self, path: str, base: str, branch: str) -> list[dict]:
        """The branch's commits not on `base`, oldest first: [{sha, subject}]."""
        if not self.has_branch(path, branch):
            return []
        out = self._ok(['-C', path, 'log', '--reverse', '--format=%H%x09%s',
                        f'{base}..refs/heads/{branch}'])
        return [dict(zip(('sha', 'subject'), line.split('\t', 1)))
                for line in out.splitlines() if line]

    # --- a review's checkout ------------------------------------------------------------------

    def fetch_pr(self, path: str, number: int, base: str) -> tuple[str, str]:
        """Fetches the PR's head into a runner ref, and its base branch. Returns (ref, sha)."""
        ref = f'refs/queue-runner/pr{number}'
        self._ok(['-C', path, 'fetch', '--quiet', 'origin', f'+refs/pull/{number}/head:{ref}',
                  f'+refs/heads/{base}:refs/remotes/origin/{base}'])
        return ref, self._ok(['-C', path, 'rev-parse', ref]).strip()

    def checkout(self, path: str, ref: str, worktree: str) -> None:
        """A detached worktree at `ref` for Sol to read, made afresh."""
        self.remove_checkout(path, worktree)
        self._ok(['-C', path, 'worktree', 'add', '--detach', worktree, ref])

    def remove_checkout(self, path: str, worktree: str, ref: str | None = None) -> None:
        import os
        if os.path.exists(worktree):
            self._run(['-C', path, 'worktree', 'remove', '--force', worktree])
        self._run(['-C', path, 'worktree', 'prune'])
        if ref:
            self._run(['-C', path, 'update-ref', '-d', ref])

    def is_ancestor(self, path: str, older: str, newer: str) -> bool:
        """Whether `older` is in `newer`'s history; False for a commit this clone lacks."""
        return self._run(['-C', path, 'merge-base', '--is-ancestor', older, newer])[0] == 0

    def diff(self, path: str, a: str, b: str, merge_base: bool = False) -> str:
        """`git diff a..b`, or with `merge_base` the PR-style `a...b` (from where b left a)."""
        return self._ok(['-C', path, 'diff', f'{a}...{b}' if merge_base else a, *(
            [] if merge_base else [b])])
