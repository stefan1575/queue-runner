"""Sol as the runner sees it: one review through `~/codex-sol.sh`.

Not a T3 thread: a thread from `t3 thread start --provider codex --model gpt-6.1-sol` ran at
effort low (checked 2026-11-09 in its rollout: `configuration_update` `reasoning.effort: "low"`),
and T3's CLI has no effort flag. codex-sol.sh starts a fresh Codex session each time, read-only,
at the effort it's given; Stefan's rule is high for every Sol run.

codex-sol.sh's watchdog ends the run once its caller is gone, and launched straight from Windows
it has none, so it runs under a Git bash that waits for it (as `~/sol-pr-review.py` did).
"""
import datetime
import glob
import json
import os
import re
import subprocess

from .ledger import SolFailed

HOME = os.path.expanduser('~')
SOL_SCRIPT = os.path.join(HOME, 'codex-sol.sh')
# Git's bash by full path: 'bash' on PATH here is WSL's (System32\bash.exe).
GIT_BASH = r'C:\Program Files\Git\bin\bash.exe'
EFFORT = 'high'   # ~/.claude/CLAUDE.md: high for every Sol run, never lower
TIMEOUT_S = 75 * 60
SESSIONS = os.path.join(HOME, '.codex', 'sessions')   # Codex's rollouts, YYYY/MM/DD/rollout-*.jsonl
FULL = 99   # used percent at which a window counts as the one that ran out

OUT_OF_USAGE = re.compile(r'hit your usage limit', re.I)
# "try again at 8:55 AM" or "try again at Oct 27th, 2026 12:01 AM", in this PC's time.
TRY_AGAIN = re.compile(r'try again at (?:(?P<mon>[A-Z][a-z]{2})[a-z]* (?P<day>\d{1,2})'
                       r'(?:st|nd|rd|th)?, (?P<year>\d{4}) )?(?P<h>\d{1,2}):(?P<m>\d{2}) ?'
                       r'(?P<ap>[AP]M)', re.I)


class SolOutOfUsage(Exception):
    """Sol's plan hit its limit until `back` (None if Sol didn't say). Not a review: nothing counts."""

    def __init__(self, back: datetime.datetime | None):
        super().__init__(f'Sol is out of usage until {back or "an unknown time"}')
        self.back = back


def usage_back(text: str, now: datetime.datetime) -> datetime.datetime | None:
    """When Sol's error says it can be asked again, in this PC's local time; None if it doesn't."""
    m = TRY_AGAIN.search(text)
    if not m:
        return None
    h = int(m['h']) % 12 + (12 if m['ap'].upper() == 'PM' else 0)
    if m['year']:
        month = datetime.datetime.strptime(m['mon'][:3].title(), '%b').month
        return datetime.datetime(int(m['year']), month, int(m['day']), h, int(m['m']))
    back = now.replace(hour=h, minute=int(m['m']), second=0, microsecond=0)
    return back if back > now - datetime.timedelta(minutes=1) else back + datetime.timedelta(days=1)


def rollout_reset(log: str, sessions: str = SESSIONS) -> datetime.datetime | None:
    """When Sol's plan resets, from its own run's rollout (`~/.claude/docs/sol.md`, Gotchas):
    the session id codex-sol.sh logs, that session's newest `rate_limits` record, and the reset
    of the window that ran out (the later one if both did), in this PC's local time. None if
    any of that is missing."""
    m = re.search(r'^session id: ([\w-]+)', log, re.M)
    if not m:
        return None
    found = glob.glob(os.path.join(glob.escape(sessions), '*', '*', '*',
                                   f'rollout-*-{m[1]}.jsonl'))
    limits = None
    for path in found:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"rate_limits"' not in line:
                    continue
                try:
                    limits = json.loads(line)['payload']['rate_limits'] or limits
                except (KeyError, TypeError, ValueError):
                    continue
    if not limits:
        return None
    full = [w['resets_at'] for w in (limits.get('primary'), limits.get('secondary'))
            if w and (w.get('used_percent') or 0) >= FULL and w.get('resets_at')]
    return datetime.datetime.fromtimestamp(max(full)) if full else None


def _slash(p: str) -> str:
    return str(p).replace('\\', '/')


def run_detached(cmd: list[str], out_path: str, timeout: float) -> int:
    """Runs `cmd` with no window, its output in `out_path`; tree-kills it past `timeout`."""
    with open(out_path, 'w', encoding='utf-8') as f:
        p = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            return p.wait(timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            p.wait()
            raise TimeoutError from None


def _read(path: str) -> str:
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return ''


class SolCli:
    """`run(cmd, out_path, timeout)` runs the command and returns its exit code, raising
    TimeoutError if it ran past `timeout` seconds."""

    def __init__(self, script: str = SOL_SCRIPT, bash: str = GIT_BASH,
                 timeout_s: int = TIMEOUT_S, run=run_detached, now=datetime.datetime.now,
                 sessions: str = SESSIONS):
        self.script, self.bash, self.timeout_s = script, bash, timeout_s
        self.sessions = sessions
        self._run, self._now = run, now

    def review(self, brief: str, reply: str, workdir: str, out: str) -> str:
        """Sol's reply to `brief`, reviewing read-only in `workdir`. Raises SolOutOfUsage when
        Sol's plan is out, SolFailed for any other failed run."""
        cmd = [self.bash, '-c', 'bash "$0" "$@"; exit $?', _slash(self.script),
               '--job', 'review', '--effort', EFFORT, _slash(brief), _slash(reply),
               _slash(workdir)]
        try:
            code = self._run(cmd, out, self.timeout_s)
        except TimeoutError:
            raise SolFailed(f'Sol ran past {self.timeout_s // 60} minutes and was stopped.') from None
        said = _read(out) + _read(reply + '.log')
        if code != 0 and OUT_OF_USAGE.search(said):
            # The rollout's reset first; else the time Sol's error names.
            raise SolOutOfUsage(rollout_reset(_read(reply + '.log'), self.sessions)
                                or usage_back(said, self._now()))
        if code != 0:
            tail = ' / '.join(_read(out).strip().splitlines()[-3:])
            raise SolFailed(f"Sol's run failed (codex-sol exit {code}): {tail}")
        text = _read(reply).strip()
        if not text:
            raise SolFailed('Sol exited 0 with an empty reply.')
        return text
