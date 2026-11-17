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

**One reading, one budget** (issue 66): `CachedUsage` is the one reader the gate, its after-job
read, the snapshot and Refresh share. It asks the endpoint at most once every `CALL_EVERY`
seconds, failed calls counted, and in between gives back the cached reading with the time it was
taken; a failed call keeps the last good reading, with its error beside it (T3's
`CAPABILITIES_PROBE_TTL` and `resolveUsageLimitsAfterProbe`, read 2026-11-16). The endpoint
answers 429 when it's asked about once a minute, per login, and T3 and Claude Code share it.
"""
import datetime
import json
import os
import re
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass

URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
# T3's headers for this call; the user agent names a Claude Code version as T3's does.
HEADERS = {'anthropic-beta': 'oauth-2025-04-20',
           'user-agent': 'claude-cli/2.1.319 (external, cli)'}


CALL_EVERY = 300   # seconds: the endpoint is asked no more often than this, failed calls counted
# A reading older than this isn't decided on (the gate), and its failure is shown (the page).
STALE_AFTER = datetime.timedelta(minutes=30)
# A failure isn't shown until it has lasted this long, two more tries at the usual 5 minutes
# apart. The first reads after the PC wakes fail and the next ones answer: the network isn't
# back, a login expired while it slept (a Claude Code session refreshes it within minutes), Codex
# starts slow (Stefan, 2026-11-17: "I'm not supposed to see this in the first place").
SHOW_AFTER = datetime.timedelta(minutes=10)


def lasted(since: datetime.datetime | None, now: datetime.datetime) -> bool:
    """Whether a failure that began at `since` has lasted long enough to show; one whose start
    isn't known has."""
    return since is None or now - since >= SHOW_AFTER


def failing_since(stale: dict, repo: str, now: datetime.datetime) -> datetime.datetime | None:
    """When `repo`'s reads began failing, for a stale entry (`inbox.Reader.stale`,
    `work.Reader.stale`): the entry it has already, or now for a first failure."""
    was = stale.get(repo)
    return was[2] if was and len(was) > 2 else now


class UsageError(Exception):
    """Usage couldn't be read. Its message never holds the token. `login`: the Claude login is
    the trouble (none readable, or HTTP 401); `called`: the endpoint was asked, so the call
    counts against the budget."""

    def __init__(self, message: str = '', *, login: bool = False, called: bool = True):
        super().__init__(message)
        self.login, self.called = login, called


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
    call_every = CALL_EVERY   # how often this endpoint may be asked: `CachedUsage`'s budget

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
                             f'({type(e).__name__})', login=True, called=False) from None
        token = str(oauth.get('accessToken') or '').strip()
        if not token:
            raise UsageError(f'no Claude login in {self.credentials}', login=True, called=False)
        note = ''
        expires = oauth.get('expiresAt')
        if isinstance(expires, (int, float)):
            at = datetime.datetime.fromtimestamp(expires / 1000, datetime.timezone.utc)
            if at <= self.clock():
                note = (f'; the login expired at {at.astimezone().isoformat(timespec="minutes")}'
                        ' (any Claude Code session refreshes it)')
        return token, note

    def plan(self) -> 'Plan | None':
        """The login's plan (`read_plan`); None when it can't be read."""
        return read_plan(self.credentials)

    def read(self) -> Usage:
        token, note = self._login()
        request = urllib.request.Request(URL, headers={**HEADERS,
                                                       'authorization': f'Bearer {token}'})
        try:
            body = self.fetch(request)
        except urllib.error.HTTPError as e:
            e.close()   # it holds the response open
            raise UsageError(f'the usage endpoint answered HTTP {e.code}{note}',
                             login=e.code == 401) from None
        except Exception as e:   # the message is ours: an exception's own could echo the request
            raise UsageError(f'reading usage failed ({type(e).__name__}){note}') from None
        return parse(body, self.clock())


@dataclass(frozen=True)
class Reading:
    """A usage reading: the last good value (a `Usage`, or ChatGPT's `sol.Limits`) and when it
    was read, the newest read's error if that one failed, whether that error is the login's,
    (Claude's) when the endpoint may be asked again, None for now, and since when the reads have
    failed without one answering (None: not known)."""
    value: object | None
    at: datetime.datetime | None
    error: str | None = None
    login: bool = False
    next_at: datetime.datetime | None = None
    since: datetime.datetime | None = None

    def failing(self, now: datetime.datetime) -> bool:
        """Whether its error is worth showing: it has lasted `SHOW_AFTER`, and there's no good
        value, the login is the trouble, or the good value is older than `STALE_AFTER`. A failed
        call beside a recent good reading isn't: the reading stands, as in T3."""
        return self.error is not None and lasted(self.since, now) and (
            self.value is None or self.at is None or self.login or now - self.at > STALE_AFTER)


@dataclass(frozen=True)
class Plan:
    """Claude's plan (issue #118): the login file's `subscriptionType` (`pro`, `max`) and
    `rateLimitTier` (`default_claude_max_20x`), the two fields Claude Code keeps beside the
    token. Learned costs are percents of a plan's windows, so they count only on their plan."""
    subscription: str | None
    tier: str | None

    def __str__(self) -> str:
        return self.subscription or self.tier or 'unknown'

    @property
    def title(self) -> str:
        """For the Usage card: `Max 20x`, `Pro`."""
        size = re.search(r'_(\d+x)$', self.tier or '')
        return str(self).title() + (f' {size.group(1)}' if size and self.subscription else '')

    def record(self) -> dict:
        return {'subscriptionType': self.subscription, 'rateLimitTier': self.tier}

    @classmethod
    def from_record(cls, rec) -> 'Plan | None':
        if not isinstance(rec, dict):
            return None
        return cls(rec.get('subscriptionType'), rec.get('rateLimitTier'))


def plan_change(now: Plan | None, was: Plan | None) -> str:
    """`pro (was max)`; by their tiers too when the subscription is the same."""
    def name(p, tier):
        return 'not read' if p is None else f'{p} ({p.tier})' if tier and p.tier else str(p)
    tier = now is not None and was is not None and str(now) == str(was)
    return f'{name(now, tier)} (was {name(was, tier)})'


def read_plan(credentials: str) -> Plan | None:
    """The plan in a Claude login file, or None when it can't be read or names none. Only the
    two plan fields are kept: the token is never copied out of the parsed file."""
    try:
        with open(credentials, encoding='utf-8') as f:
            oauth = json.load(f).get('claudeAiOauth') or {}
        sub, tier = oauth.get('subscriptionType'), oauth.get('rateLimitTier')
    except (OSError, ValueError, AttributeError):
        return None
    sub = sub if isinstance(sub, str) and sub.strip() else None
    tier = tier if isinstance(tier, str) and tier.strip() else None
    return Plan(sub, tier) if sub or tier else None


def _first_line(e: BaseException) -> str:
    return (str(e).strip().splitlines() or [type(e).__name__])[0][:200]


class CachedUsage:
    """Claude's usage, asked of `endpoint` at most once every `endpoint.call_every` seconds
    (`CALL_EVERY` for the real one) whoever asks: the gate, its after-job read, the snapshot's
    read and Refresh. A failed call counts against the budget; a login that can't be read asks
    nothing, so it doesn't. `on_call(ok, note)` hears every attempt (the dashboard's source)."""

    def __init__(self, endpoint, clock=None, on_call=None):
        self.endpoint = endpoint
        self.every = datetime.timedelta(seconds=getattr(endpoint, 'call_every', CALL_EVERY))
        self.clock = clock or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.on_call = on_call
        self._lock = threading.Lock()
        self._good: tuple[object, datetime.datetime] | None = None
        self._error: UsageError | None = None
        self._called: datetime.datetime | None = None   # the last call to the endpoint
        self._tried: datetime.datetime | None = None    # the last attempt, a login's too
        self._since: datetime.datetime | None = None    # the first failure since one answered

    def _next(self, now) -> datetime.datetime | None:
        at = self._called + self.every if self._called is not None else None
        return at if at is not None and at > now else None

    def next_call_at(self) -> datetime.datetime | None:
        """When the endpoint may be asked again; None: now."""
        with self._lock:
            return self._next(self.clock())

    def wait_seconds(self) -> float:
        """How long until the endpoint may be asked again."""
        with self._lock:
            now = self.clock()
            at = self._next(now)
            return (at - now).total_seconds() if at else 0.0

    def due(self, seconds: float) -> bool:
        """Whether a read now would ask the endpoint, and the last attempt is `seconds` old."""
        with self._lock:
            now = self.clock()
            return self._next(now) is None and (
                self._tried is None or (now - self._tried).total_seconds() >= seconds)

    def read(self):
        """Asks the endpoint if the budget allows, then gives the last good value, which may be
        the cached one. Raises UsageError only while there's no good value."""
        with self._lock:   # held through the call: two callers never ask at once
            now = self.clock()
            if self._next(now) is None:
                self._call(now)
            if self._good is None:
                raise self._error or UsageError('Claude usage is not read yet', called=False)
            return self._good[0]

    def _call(self, now) -> None:
        self._tried = now
        try:
            value = self.endpoint.read()
        except Exception as e:   # anything but ours is said by its type: its text could echo more
            err = e if isinstance(e, UsageError) else \
                UsageError(f'reading usage failed ({type(e).__name__})')
            if err.called:
                self._called = now
            self._error = err
            self._since = self._since or now
            if self.on_call:
                self.on_call(False, _first_line(err))
            return
        self._called, self._good, self._error, self._since = now, (value, now), None, None
        if self.on_call:
            self.on_call(True, None)

    def plan(self) -> 'Plan | None':
        """The endpoint's login plan (issue #118), read from its login file, asking no call; None
        for an endpoint that has none to give (a test's fake)."""
        read = getattr(self.endpoint, 'plan', None)
        return read() if read else None

    def reading(self) -> Reading | None:
        """The cached reading, asking nothing; None before any attempt."""
        with self._lock:
            if self._good is None and self._error is None:
                return None
            value, at = self._good or (None, None)
            err = self._error
            return Reading(value, at, _first_line(err) if err else None,
                           bool(err and err.login), self._next(self.clock()), self._since)
