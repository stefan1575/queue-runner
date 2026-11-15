"""ChatGPT's usage and reset credits, read the way T3 reads them (ticket 42): `codex app-server`
started for one call, JSON-RPC over its stdin and stdout (one JSON object a line): `initialize`,
`initialized`, then `account/rateLimits/read` (T3's `probeCodexAppServerProvider`,
`resources/server.asar`, read 2026-11-16). Codex reads its own login; the runner never sees it.

The answer's `rateLimitsByLimitId.codex` (else `rateLimits`) has the plan and its windows
(`primary` the session, `secondary` the week: `usedPercent`, `windowDurationMins`, `resetsAt` in
epoch seconds), and `rateLimitResetCredits.availableCount` the reset credits left (T3's
`codexResetCreditsToContract`). Redeeming one is T3's: the runner only counts them.

It answers in about a second. Starting the app server refreshes Codex's shared model list
(`~/.codex/models_cache.json`) as any plain Codex start does (a Sol review's too).
"""
import datetime
import glob
import json
import os
import queue
import shutil
import subprocess
import threading
import time

from .sol import LimitWindow, Limits

TIMEOUT = 20   # seconds for the whole call: T3 allows 20 for its probe
CLIENT = {'name': 'queue-runner', 'title': 'Queue runner', 'version': '1'}
# A window whose length isn't given takes its place's (T3's `codexRateLimitsToWindows`).
PLACES = (('primary', 300), ('secondary', 10080))


class CodexUsageError(Exception):
    """ChatGPT's usage couldn't be read through Codex."""


def find_codex() -> str | None:
    """Codex on PATH, else the newest copy the Codex app keeps (codex-sol.sh looks there too)."""
    found = shutil.which('codex')
    if found:
        return found
    bundled = glob.glob(os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'OpenAI',
                                     'Codex', 'bin', '*', 'codex.exe'))
    return max(bundled, key=os.path.getmtime) if bundled else None


def _window(raw, minutes: int) -> LimitWindow | None:
    if not isinstance(raw, dict):
        return None
    used = raw.get('usedPercent')
    if not isinstance(used, (int, float)) or isinstance(used, bool):
        return None
    length, reset = raw.get('windowDurationMins'), raw.get('resetsAt')
    return LimitWindow(length if isinstance(length, int) and length > 0 else minutes, float(used),
                       datetime.datetime.fromtimestamp(reset, datetime.timezone.utc)
                       if isinstance(reset, (int, float)) and not isinstance(reset, bool) else None)


def parse(result) -> Limits:
    """`account/rateLimits/read`'s result as the plan's windows and reset credits."""
    if not isinstance(result, dict):
        raise CodexUsageError("Codex's usage answer is not an object")
    snap = (result.get('rateLimitsByLimitId') or {}).get('codex') or result.get('rateLimits')
    if not isinstance(snap, dict):
        raise CodexUsageError("Codex's usage answer has no rate limits")
    windows = tuple(w for name, minutes in PLACES if (w := _window(snap.get(name), minutes)))
    if not windows:
        raise CodexUsageError("Codex's usage answer has no window")
    credits = result.get('rateLimitResetCredits')
    count = credits.get('availableCount') if isinstance(credits, dict) else None
    resets = max(0, count) if isinstance(count, int) and not isinstance(count, bool) else None
    plan = snap.get('planType')
    return Limits(plan if isinstance(plan, str) else None, windows, resets)


class CodexUsage:
    """`read()` gives (when it was read, Limits), as `snapshot.Watch(timed=True)` takes it.
    `command` is the app server's command line (a test's stand-in); by default it's the Codex
    `find` finds, with `app-server`."""

    def __init__(self, command: list[str] | None = None, timeout: float = TIMEOUT, clock=None,
                 find=find_codex):
        self.command, self.timeout, self.find = command, timeout, find
        self.clock = clock or (lambda: datetime.datetime.now(datetime.timezone.utc))

    def read(self) -> tuple[datetime.datetime, Limits]:
        command = self.command
        if command is None:
            codex = self.find()
            if not codex:
                raise CodexUsageError('Codex is not installed where the runner looks (PATH, or '
                                      "the Codex app's own copy)")
            command = [codex, 'app-server']
        try:
            proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                                    errors='replace',
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except OSError as e:
            raise CodexUsageError(f"Codex's app server didn't start ({type(e).__name__})") from None
        lines: queue.Queue = queue.Queue()

        def pump():
            try:
                for line in proc.stdout:
                    lines.put(line)
            except (OSError, ValueError):   # closed under it, once the call is over
                pass
            lines.put(None)
        reader = threading.Thread(target=pump, name='codex-usage', daemon=True)
        reader.start()
        deadline = time.monotonic() + self.timeout
        try:
            self._send(proc, {'id': 1, 'method': 'initialize',
                              'params': {'clientInfo': CLIENT,
                                         'capabilities': {'experimentalApi': True}}})
            self._answer(lines, 1, deadline, 'initialize')
            self._send(proc, {'method': 'initialized'})
            self._send(proc, {'id': 2, 'method': 'account/rateLimits/read', 'params': None})
            got = self._answer(lines, 2, deadline, 'the usage request')
            return self.clock(), parse(got)
        finally:
            for close in (proc.stdin.close, proc.kill):
                try:
                    close()
                except OSError:
                    pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            reader.join(timeout=5)
            proc.stdout.close()

    @staticmethod
    def _send(proc, message: dict) -> None:
        try:
            proc.stdin.write(json.dumps(message) + '\n')
            proc.stdin.flush()
        except OSError:
            raise CodexUsageError("Codex's app server stopped before it answered") from None

    @staticmethod
    def _answer(lines: queue.Queue, id: int, deadline: float, what: str):
        """The result of request `id`; notifications and anything else are skipped."""
        while True:
            left = deadline - time.monotonic()
            try:
                if left <= 0:
                    raise queue.Empty
                line = lines.get(timeout=left)
            except queue.Empty:
                raise CodexUsageError(f"Codex's app server did not answer {what} in time") from None
            if line is None:   # its output ended
                raise CodexUsageError(f"Codex's app server stopped before it answered {what}")
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if not isinstance(message, dict) or message.get('id') != id:
                continue
            if 'error' in message:
                error = message['error']
                text = error.get('message') if isinstance(error, dict) else error
                raise CodexUsageError(f'Codex refused {what}: {str(text)[:200]}')
            return message.get('result')
