"""Sol as the runner sees it: one review through `scripts/codex-sol.sh`, the Codex adapter.

A review whose `[jobs.review]` provider is Codex runs here, at its model and effort (issue #120),
not as a T3 thread: codex-sol.sh starts a fresh Codex session each time with only the checkout
and the dependency cache writable and the network off (ticket 16), which a T3 thread can't be
held to.

codex-sol.sh's watchdog ends the run once its caller is gone, and launched straight from Windows
it has none, so it runs under a Git bash that waits for it (as `~/sol-pr-review.py` did).
"""
import datetime
import glob
import json
import os
import re
import subprocess
from dataclasses import dataclass

from .ledger import SolFailed

HOME = os.path.expanduser('~')
SOL_SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts',
                          'codex-sol.sh').replace(os.sep, '/')
# Git's bash by full path: 'bash' on PATH here is WSL's (System32\bash.exe).
GIT_BASH = r'C:\Program Files\Git\bin\bash.exe'
MODEL, EFFORT = 'gpt-6.1-sol', 'high'   # codex-sol.sh's own, when config.toml names none
TIMEOUT_S = 75 * 60
SESSIONS = os.path.join(HOME, '.codex', 'sessions')   # Codex's rollouts, YYYY/MM/DD/rollout-*.jsonl
FULL = 99   # used percent at which a window counts as the one that ran out

OUT_OF_USAGE = re.compile(r'hit your usage limit', re.I)
# "try again at 8:55 AM" or "try again at Oct 27th, 2026 12:01 AM", in this PC's time.
TRY_AGAIN = re.compile(r'try again at (?:(?P<mon>[A-Z][a-z]{2})[a-z]* (?P<day>\d{1,2})'
                       r'(?:st|nd|rd|th)?, (?P<year>\d{4}) )?(?P<h>\d{1,2}):(?P<m>\d{2}) ?'
                       r'(?P<ap>[AP]M)', re.I)


@dataclass(frozen=True)
class LimitWindow:
    minutes: int                          # the window's length: 300 is the session, 10080 the week
    used: float                           # percent used
    resets_at: datetime.datetime | None


@dataclass(frozen=True)
class Limits:
    """ChatGPT's plan windows, as Codex last reported them in a rollout's `rate_limits`, or as
    its app server read them (`codex_usage.py`, with `resets`: reset credits left, None if
    unknown)."""
    plan: str | None
    windows: tuple
    resets: int | None = None


class SolOutOfUsage(Exception):
    """The reviewer's plan hit its limit until `back` (None if it didn't say): Sol's, or a review
    thread's provider (`fallback.ReviewThread`, named `who`). Not a review: nothing counts."""

    def __init__(self, back: datetime.datetime | None, who: str = 'Sol'):
        super().__init__(f'{who} is out of usage until {back or "an unknown time"}')
        self.back, self.who = back, who


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
    """When Sol's plan resets, from its own run's rollout:
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


LIMITS_FILES = 20   # latest_limits looks in this many of the newest rollouts at most


def _window(raw) -> LimitWindow | None:
    if not isinstance(raw, dict) or not isinstance(raw.get('used_percent'), (int, float)):
        return None
    reset = raw.get('resets_at')
    return LimitWindow(int(raw.get('window_minutes') or 0), float(raw['used_percent']),
                       datetime.datetime.fromtimestamp(reset, datetime.timezone.utc)
                       if isinstance(reset, (int, float)) else None)


def latest_limits(sessions: str = SESSIONS) -> tuple[datetime.datetime, Limits]:
    """ChatGPT's plan windows as Codex last reported them: the `rate_limits` record with a window
    whose own timestamp is newest (any session: the plan is the account's), and when, among the
    LIMITS_FILES rollouts touched last (file times only bound the search: a file touched last
    may hold an older reading). Raises LookupError if none has. Reads local files only."""
    found = glob.glob(os.path.join(glob.escape(sessions), '*', '*', '*', 'rollout-*.jsonl'))
    best = None
    for path in sorted(found, key=os.path.getmtime, reverse=True)[:LIMITS_FILES]:
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"rate_limits"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                    raw = rec['payload']['rate_limits']
                    windows = tuple(w for w in (_window(raw.get('primary')),
                                                _window(raw.get('secondary'))) if w)
                    at = datetime.datetime.fromisoformat(rec['timestamp'].replace('Z', '+00:00'))
                except (KeyError, TypeError, ValueError, AttributeError):
                    continue
                if windows and (best is None or at >= best[0]):
                    best = at, Limits(raw.get('plan_type'), windows)
    if best is None:
        raise LookupError('No Codex session has reported ChatGPT usage yet')
    return best


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
                 sessions: str = SESSIONS, model: str = MODEL, effort: str = EFFORT):
        self.script, self.bash, self.timeout_s = script, bash, timeout_s
        self.model, self.effort = model, effort   # `[jobs.review]`'s (issue #120)
        self.sessions = sessions
        self._run, self._now = run, now

    def review(self, brief: str, reply: str, workdir: str, out: str,
               writable: list[str] | tuple = ()) -> str:
        """Sol's reply to `brief`, reviewing in `workdir`, a throwaway checkout it may write in
        (`--write`: running tests writes, and Sol may add one), as it may in each `writable`
        folder (the dependency cache behind the checkout's node_modules). Nothing else is
        writable, and the network stays off. Raises SolOutOfUsage when Sol's plan is out,
        SolFailed for any other failed run."""
        roots = [a for d in writable for a in ('--writable-root', _slash(d))]
        cmd = [self.bash, '-c', 'bash "$0" "$@"; exit $?', _slash(self.script),
               '--job', 'review', '--model', self.model, '--effort', self.effort, '--write',
               *roots, _slash(brief),
               _slash(reply), _slash(workdir)]
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
