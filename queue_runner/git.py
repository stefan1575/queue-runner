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
