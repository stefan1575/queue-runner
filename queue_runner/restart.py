"""The runner restarting on its own new code (ticket 14).

The runner serves its own repo. When its checkout's base moves on GitHub (its own merge, or anyone
else's push), the Claude lane notices between jobs (`SelfUpdate.due`), lets the Sol lane finish its
pass, fast-forwards the checkout (`SelfUpdate.update`) and ends the loop. The CLI then lets go of
`runner.lock` and starts the same command again (`relaunch`), and waits until the new runner holds
the lock and stays up. New code that won't start can't fix itself, so the old one toasts Stefan
with its error, which is in `<log_dir>/restart.err`, and exits.

Only a checkout on its base branch that fast-forwards is updated: one on another branch, or with
commits of its own, is left as it is (said once).
"""
import os
import subprocess
import time

from .git import run_git

EXIT_LOCKED = 3          # the CLI's exit code when another runner holds runner.lock
START_TIMEOUT = 120      # seconds the new runner has to take runner.lock
STAY_UP = 20             # seconds it must stay up after taking it
POLL = 1


class SelfUpdate:
    """The runner's own repo's checkout (the folder its code runs from) against `origin/<base>`."""

    def __init__(self, repo, say, run=run_git):
        self.repo, self.say, self._run = repo, say, run
        self._said: str | None = None
        self._failed: str | None = None   # an update to this commit failed: not due again

    def _git(self, *args) -> tuple[int, str, str]:
        code, out, err = self._run(['-C', self.repo.path, *args])
        return code, out.strip(), err.strip()

    def _once(self, line: str) -> None:
        if line != self._said:
            self.say(line)
        self._said = line

    def due(self) -> bool:
        """Fetches the base; True when the checkout is on it and `origin/<base>` is ahead of it
        and fast-forwards from it."""
        base = self.repo.base
        code, _, err = self._git('fetch', '--quiet', 'origin', base)
        if code:
            self._once(f"Self-update: can't fetch {self.repo.name}'s {base}: {err}")
            return False
        _, head, _ = self._git('rev-parse', 'HEAD')
        _, target, _ = self._git('rev-parse', f'refs/remotes/origin/{base}')
        if not target or head == target or target == self._failed:
            return False
        _, branch, _ = self._git('symbolic-ref', '--quiet', '--short', 'HEAD')
        if branch != base:
            self._once(f'Self-update: {self.repo.path} is on {branch or "a detached head"}, '
                       f'not {base}: not restarting on origin/{base} ({target[:7]})')
            return False
        code, _, _ = self._git('merge-base', '--is-ancestor', head, target)
        if code:
            self._once(f"Self-update: {base} in {self.repo.path} has commits origin/{base} "
                       f"hasn't, so it can't fast-forward to {target[:7]}: not restarting")
            return False
        return True

    def update(self) -> str | None:
        """Fast-forwards the checkout to `origin/<base>`: the new commit, or None (said) if git
        refused, and that commit isn't due again."""
        target_ref = f'refs/remotes/origin/{self.repo.base}'
        _, target, _ = self._git('rev-parse', target_ref)
        code, _, err = self._git('merge', '--ff-only', '--quiet', target_ref)
        if code:
            self._failed = target
            self.say(f'Self-update: could not update {self.repo.path} to {target[:7]}, so the '
                     f'runner carries on with the code it has: {err}')
            return None
        _, head, _ = self._git('rev-parse', 'HEAD')
        return head


def _spawn(cmd: list[str], cwd: str, err: str):
    """The new runner, detached from this one, its stderr in `err` (pythonw has no console)."""
    flags = (getattr(subprocess, 'DETACHED_PROCESS', 0)
             | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
    with open(err, 'w', encoding='utf-8') as f:
        return subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=f, creationflags=flags)


def _last_line(path: str) -> str:
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            lines = [line.strip() for line in f if line.strip()]
    except OSError:
        return ''
    return lines[-1] if lines else ''


def _pid(path: str) -> str | None:
    try:
        with open(path, encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return None


def relaunch(cmd, *, cwd, sha, github, pid_file, err_file, toaster, say, spawn=_spawn,
             sleep=time.sleep, clock=time.monotonic, timeout=START_TIMEOUT,
             stay_up=STAY_UP) -> bool:
    """Starts the runner again on the updated checkout, once this one has let go of
    runner.lock: True when the new one took the lock and stayed up `stay_up` seconds (or another
    runner holds the lock), else False after toasting Stefan the new code's error."""
    short = sha[:7]
    p = spawn(cmd, cwd, err_file)
    started = None
    end = clock() + timeout
    why = None
    while True:
        code = p.poll()
        if started is None and _pid(pid_file) == str(p.pid):
            started = clock()
        if code is not None:
            if code == EXIT_LOCKED and started is None:
                say(f'Restart on {short}: another runner holds the lock, so it runs instead')
                return True
            why = _last_line(err_file) or f'it exited with code {code}'
            break
        if started is not None and clock() - started >= stay_up:
            say(f'runner restarted on {short} (pid {p.pid})')
            return True
        if started is None and clock() >= end:
            why = f"it didn't take runner.lock in {timeout // 60} minutes (pid {p.pid})"
            break
        sleep(POLL)
    say(f'Restart on {short}: the new code failed to start: {why} (the whole error is in '
        f'{err_file})')
    try:
        toaster.toast("Queue runner didn't restart",
                      f'Its new code ({short}) failed to start: {why}',
                      f'https://github.com/{github}/commit/{sha}', tag='restart')
    except Exception as e:
        say(f'Restart on {short}: the toast failed: {e}')
    return False
