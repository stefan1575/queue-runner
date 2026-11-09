"""Claude's plan windows, read the way T3 reads them: `GET api.anthropic.com/api/oauth/usage` with
the Claude login's OAuth token (T3's `readClaudeResetCredits`, `resources/server.asar`).

The token is `claudeAiOauth.accessToken` in `<config dir>/.credentials.json`, the config dir being
`$CLAUDE_CONFIG_DIR` or `~/.claude` (T3's `readAccessToken`; on Windows Claude Code keeps it in
that file). Claude Code refreshes it whenever it runs. The token is only ever put in the request
header: never logged, copied or put in an error.

The response's `five_hour` and `seven_day` windows are `{utilization: 0-100, resets_at: ISO time
or null}`; a window that's null hasn't started (nothing used).
"""
import datetime
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass

URL = 'https://api.anthropic.com/api/oauth/usage'
# T3's headers for this call; the user agent names a Claude Code version as T3's does.
HEADERS = {'anthropic-beta': 'oauth-2025-04-20',
           'user-agent': 'claude-cli/2.1.319 (external, cli)'}


class UsageError(Exception):
    """Usage couldn't be read. Its message never holds the token."""


@dataclass(frozen=True)
class Window:
    used: float                              # percent of the window used, 0-100
    resets_at: datetime.datetime | None      # None: the window hasn't started


@dataclass(frozen=True)
class Usage:
    five_hour: Window
    seven_day: Window

    def record(self) -> dict:
        return {name: {'used': w.used,
                       'resets_at': w.resets_at.isoformat() if w.resets_at else None}
                for name, w in (('five_hour', self.five_hour), ('seven_day', self.seven_day))}

    @classmethod
    def from_record(cls, rec: dict) -> 'Usage':
        return cls(*(Window(float(rec[n]['used']), _time(rec[n]['resets_at']))
                     for n in ('five_hour', 'seven_day')))


def _time(value) -> datetime.datetime | None:
    if not value:
        return None
    t = datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def _window(raw) -> Window:
    if raw is None:
        return Window(0.0, None)
    used = raw.get('utilization') if isinstance(raw, dict) else None
    if not isinstance(used, (int, float)) or isinstance(used, bool):
        raise UsageError(f'a usage window has no utilization: {str(raw)[:200]}')
    try:
        return Window(float(used), _time(raw.get('resets_at')))
    except ValueError as e:
        raise UsageError(f'a usage window has an unreadable reset time: {e}') from None


def parse(body: bytes | str) -> Usage:
    try:
        data = json.loads(body)
    except ValueError as e:
        raise UsageError(f'the usage response is not JSON: {e}') from None
    if not isinstance(data, dict):
        raise UsageError('the usage response is not a JSON object')
    return Usage(_window(data.get('five_hour')), _window(data.get('seven_day')))


def _fetch(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=15) as r:
        return r.read()


class OAuthUsage:
    def __init__(self, config_dir: str | None = None, fetch=_fetch, clock=None):
        self.config_dir = config_dir or os.environ.get('CLAUDE_CONFIG_DIR', '').strip() or \
            os.path.join(os.path.expanduser('~'), '.claude')
        self.fetch = fetch
        self.clock = clock or (lambda: datetime.datetime.now(datetime.timezone.utc))

    @property
    def credentials(self) -> str:
        return os.path.join(self.config_dir, '.credentials.json')

    def _login(self) -> tuple[str, str]:
        """The token, and a note on its expiry for an error message."""
        try:
            with open(self.credentials, encoding='utf-8') as f:
                oauth = json.load(f).get('claudeAiOauth') or {}
        except (OSError, ValueError, AttributeError) as e:
            raise UsageError(f'no Claude login readable in {self.credentials} '
                             f'({type(e).__name__})') from None
        token = str(oauth.get('accessToken') or '').strip()
        if not token:
            raise UsageError(f'no Claude login in {self.credentials}')
        note = ''
        expires = oauth.get('expiresAt')
        if isinstance(expires, (int, float)):
            at = datetime.datetime.fromtimestamp(expires / 1000, datetime.timezone.utc)
            if at <= self.clock():
                note = (f'; the login expired at {at.astimezone().isoformat(timespec="minutes")}'
                        ' (any Claude Code session refreshes it)')
        return token, note

    def read(self) -> Usage:
        token, note = self._login()
        request = urllib.request.Request(URL, headers={**HEADERS,
                                                       'authorization': f'Bearer {token}'})
        try:
            body = self.fetch(request)
        except urllib.error.HTTPError as e:
            raise UsageError(f'the usage endpoint answered HTTP {e.code}{note}') from None
        except Exception as e:   # the message is ours: an exception's own could echo the request
            raise UsageError(f'reading usage failed ({type(e).__name__}){note}') from None
        return parse(body)
