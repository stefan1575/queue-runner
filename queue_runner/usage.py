"""Claude's plan windows, read the way T3 reads them: `GET api.anthropic.com/api/oauth/usage` with
the Claude login's OAuth token (T3's `readClaudeResetCredits`, `resources/server.asar`).

The token is `claudeAiOauth.accessToken` in `<config dir>/.credentials.json`, the config dir being
`$CLAUDE_CONFIG_DIR` or `~/.claude` (T3's `readAccessToken`; on Windows Claude Code keeps it in
that file). Claude Code refreshes it whenever it runs. The token is only ever put in the request
header: never logged, copied or put in an error.

The response's `five_hour` and `seven_day` windows are `{utilization: 0-100, resets_at: ISO time
or null}`; a window that's null hasn't started (nothing used).

Reset credits (ticket 42) come in the same response when it's asked with `cedar_ember=1`, as T3
asks it (`readClaudeResetCredits`): the `cedar_ember` block's grants, counted as T3 counts them
(`claudeResetCreditsToContract`). Redeeming one is T3's (it spends the credit); the runner only
counts them.
"""
import datetime
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
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
    resets: int | None = None   # reset credits left; None: the account has none to give

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


GRANT_ID = re.compile(r'^[a-z0-9_-]{1,40}$')


def _ends_ahead(value, now: datetime.datetime) -> bool:
    if value is None:
        return True
    try:
        return _time(value) > now
    except (TypeError, ValueError):
        return False


def resets(block, now: datetime.datetime) -> int | None:
    """The reset credits left in a `cedar_ember` block, as T3 counts them: None when there's no
    block or the account isn't eligible; else every usable grant's `resets_left` (not paused,
    `usable_now`, not ended), or 0 when the grant to be used next isn't one of them."""
    if not isinstance(block, dict) or block.get('eligible') is not True:
        return None
    live = [g for g in block.get('grants') or [] if isinstance(g, dict)
            and isinstance(g.get('id'), str) and GRANT_ID.match(g['id'])
            and isinstance(g.get('resets_left'), int) and not isinstance(g['resets_left'], bool)
            and g['resets_left'] >= 0 and g.get('paused') is not True
            and g.get('usable_now') is True and _ends_ahead(g.get('ends_at'), now)]
    if not any(g['id'] == block.get('next_grant_id') for g in live):
        return 0
    return sum(g['resets_left'] for g in live)


def parse(body: bytes | str, now: datetime.datetime | None = None) -> Usage:
    try:
        data = json.loads(body)
    except ValueError as e:
        raise UsageError(f'the usage response is not JSON: {e}') from None
    if not isinstance(data, dict):
        raise UsageError('the usage response is not a JSON object')
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return Usage(_window(data.get('five_hour')), _window(data.get('seven_day')),
                 resets(data.get('cedar_ember'), now))


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
        return parse(body, self.clock())
