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

    def _ref(self, path: str, ref: str) -> str | None:
        code, out, _ = self._run(['-C', path, 'rev-parse', '--verify', '--quiet', ref])
        return out.strip() if code == 0 else None

    def free_branch(self, path: str, branch: str,
                    worktree: str | None) -> tuple[str | None, str | None]:
        """Frees a job's branch and its worktree's folder for a fresh T3 worktree after a usage
        limit: T3 can't make a worktree on a branch that exists, and it makes it at the same
        folder (`~/.t3/worktrees/<project>/<branch>`). Keeps the branch's tip under
        `refs/queue-runner/limit/<branch>` and anything left uncommitted (untracked files
        included) as a stash-like commit under `.../<branch>-uncommitted`, removes the old
        worktree and deletes the branch, so T3 makes it again at the tip.

        Returns (tip, uncommitted): the kept ones if the branch is gone already (an earlier try
        whose thread never started); None for either there isn't. Raises GitError if the old
        worktree can't be removed."""
        import os
        keep, wip_ref = f'refs/queue-runner/limit/{branch}', f'refs/queue-runner/limit/{branch}-uncommitted'
        tip = self._ref(path, f'refs/heads/{branch}')
        if tip is None:
            return self._ref(path, keep), self._ref(path, wip_ref)
        self._ok(['-C', path, 'update-ref', keep, tip])
        wip = None
        if worktree and os.path.isdir(worktree):
            if self._ok(['-C', worktree, 'status', '--porcelain']).strip():
                self._ok(['-C', worktree, 'add', '-A'])
                wip = self._ok(['-C', worktree, 'stash', 'create',
                                'left uncommitted by a thread a usage limit cut off']).strip() or None
                if wip:
                    self._ok(['-C', path, 'update-ref', wip_ref, wip])
            if not self.remove_worktree(path, worktree):
                raise GitError(f'the old worktree {worktree} could not be removed')
        self._run(['-C', path, 'worktree', 'prune'])
        if self._ref(path, f'refs/heads/{branch}'):
            self._ok(['-C', path, 'branch', '-D', branch])
        return tip, wip

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

    def checkout(self, path: str, ref: str, worktree: str) -> str | None:
        """A detached worktree at `ref` for Sol to read, made afresh. Returns where a leftover
        at `worktree` was moved aside, if it was (`remove_checkout`)."""
        moved = self.remove_checkout(path, worktree)
        self._ok(['-C', path, 'worktree', 'add', '--detach', worktree, ref])
        return moved

    def remove_checkout(self, path: str, worktree: str, ref: str | None = None) -> str | None:
        """Removes Sol's checkout. A folder git unregistered but couldn't delete (owner-only
        folders Sol's sandbox user left: AGENTS.md, Sol runs tests) is moved aside to
        `<worktree>.stale-<time>`, so the next `worktree add` finds the path free; returns where
        it went, else None. `sweep_stale` deletes it later if it can."""
        import datetime
        import os
        from .deps import Deps
        moved = None
        if os.path.exists(worktree):
            # First: git follows the node_modules junction and empties the dependency cache.
            Deps.unlink(worktree)
            self._run(['-C', path, 'worktree', 'remove', '--force', worktree])
            if os.path.exists(worktree):
                stamp = f'{worktree}.stale-{datetime.datetime.now():%Y%m%d-%H%M%S}'
                moved, n = stamp, 1
                while os.path.exists(moved):
                    n += 1
                    moved = f'{stamp}-{n}'
                os.rename(worktree, moved)
        self._run(['-C', path, 'worktree', 'prune'])
        if ref:
            self._run(['-C', path, 'update-ref', '-d', ref])
        return moved

    @staticmethod
    def sweep_stale(checkouts_dir: str) -> list[str]:
        """Deletes the checkouts `remove_checkout` moved aside, where it can. Returns the ones
        still there (their owner-only folders can't be deleted by Stefan's account)."""
        import os
        import shutil
        try:
            names = sorted(os.listdir(checkouts_dir))
        except FileNotFoundError:
            return []
        kept = []
        for name in names:
            folder = os.path.join(checkouts_dir, name)
            if '.stale-' in name and os.path.isdir(folder):
                shutil.rmtree(folder, ignore_errors=True)
                if os.path.exists(folder):
                    kept.append(folder)
        return kept

    def is_ancestor(self, path: str, older: str, newer: str) -> bool:
        """Whether `older` is in `newer`'s history; False for a commit this clone lacks."""
        return self._run(['-C', path, 'merge-base', '--is-ancestor', older, newer])[0] == 0

    def diff(self, path: str, a: str, b: str, merge_base: bool = False) -> str:
        """`git diff a..b`, or with `merge_base` the PR-style `a...b` (from where b left a)."""
        return self._ok(['-C', path, 'diff', f'{a}...{b}' if merge_base else a, *(
            [] if merge_base else [b])])

    # --- a fix round, and after a merge -------------------------------------------------------

    def log(self, path: str, a: str, b: str) -> list[dict]:
        """The commits in `b` not in `a`, oldest first: [{sha, subject}]."""
        out = self._ok(['-C', path, 'log', '--reverse', '--format=%H%x09%s', f'{a}..{b}'])
        return [dict(zip(('sha', 'subject'), line.split('\t', 1)))
                for line in out.splitlines() if line]

    def diffstat(self, path: str, a: str, b: str) -> str:
        """`git diff --stat a...b`: the files a PR changes, from where b left a."""
        return self._ok(['-C', path, 'diff', '--stat', f'{a}...{b}'])

    def remove_worktree(self, path: str, worktree: str, branch: str | None = None) -> bool:
        """Removes a job's worktree and its local branch. True once git no longer lists the
        worktree: T3 can hold the empty folder open, so `worktree remove` may fail after git
        has unregistered it and deleted its files (AGENTS.md, T3 as a script sees it)."""
        self._run(['-C', path, 'worktree', 'remove', '--force', worktree])
        self._run(['-C', path, 'worktree', 'prune'])
        listed = self._ok(['-C', path, 'worktree', 'list', '--porcelain'])
        want = _same_path(worktree)
        gone = not any(_same_path(line[len('worktree '):]) == want
                       for line in listed.splitlines() if line.startswith('worktree '))
        if gone and branch:
            self._run(['-C', path, 'branch', '-D', branch])
        return gone


    # --- live steps after merges ----------------------------------------------------------------

    def sha(self, path: str, ref: str) -> str:
        return self._ok(['-C', path, 'rev-parse', '--verify', f'{ref}^{{commit}}']).strip()

    def first_parent(self, path: str, a: str, b: str) -> list[dict]:
        """The commits on `b`'s first-parent line since `a`, oldest first (a merged PR is one
        merge commit): [{sha, subject}]."""
        out = self._ok(['-C', path, 'log', '--reverse', '--first-parent', '--format=%H%x09%s',
                        f'{a}..{b}'])
        return [dict(zip(('sha', 'subject'), line.split('	', 1)))
                for line in out.splitlines() if line]

    def name_status(self, path: str, a: str, b: str) -> list[tuple[str, str]]:
        """The files `b` changed since `a`: [(status letter, path)], renames as their new path."""
        out = self._ok(['-C', path, 'diff', '--name-status', '--no-renames', a, b])
        found = []
        for line in out.splitlines():
            parts = line.split('	')
            if len(parts) >= 2:
                found.append((parts[0][:1], parts[-1]))
        return found


def _same_path(p: str) -> str:
    import os
    return os.path.normcase(os.path.normpath(p.strip()))
