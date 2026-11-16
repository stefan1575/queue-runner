"""The dashboard's snapshot: `<state_dir>/snapshot.json`, written whole by the running runner
(ticket 28; `.scratch/queue-runner/dashboard-live.md`). Its shape is `dashboard/sample.py`'s.

- `build(facts)` is pure: plain data in (`Facts`), the snapshot out. Each part has its own small
  function. The work lists (asks, issues, PRs, activity, each lane's queue) are `_work` and
  `_queue`: the asks are `asks.py`'s, from the Sol lane's last Inbox read (ticket 31); the rest
  stay empty until ticket 32 fills them from facts it adds to `Facts`.
- `Snapshots` gathers the facts: the job log, `gate.json`, the learned costs, what the runner's
  passes last saw (`Calls`, `Watch`) and the runner's own state. GitHub is read by the passes, never
  for the snapshot; Claude's and ChatGPT's usage are read for it at most every `READ_EVERY`, and
  Claude's through the gate's own reader (`usage.CachedUsage`), which asks the endpoint at most
  once every 5 minutes whoever asks (issue 66).
- `Publisher` writes it (a temp file, then `os.replace`) after every pass of either lane and every
  `WRITE_EVERY` seconds from its own thread, so it goes on while a lane is blocked in a job.
"""
import contextlib
import datetime
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field

from . import control
from .config import toml_order
from .gate import RECENT, RESERVE_RELEASE, SAMPLES, Knob
from .state import when
from .usage import STALE_AFTER, Reading

VERSION = 1
WRITE_EVERY = 30    # seconds: the longest the runner goes between writes
READ_EVERY = 300    # seconds: the snapshot reads usage itself no more often than this


CLAUDE_KINDS = ('build', 'fix', 'decision', 'live')   # the Claude lane's jobs (gate.CLAUDE_KINDS)
SOL_KINDS = ('review', 'merge')                       # the reviewing lane's
SOL_MODEL = 'GPT-6.1 Sol'   # codex-sol.sh's model (`~/Code/docs/sol.md`)
# A job whose `issue` is a PR (a live run's: its batch's newest).
ON_PR = ('fix', 'review', 'merge', 'live')
NO_STOP_NOW = {'available': False, 'note': "Stop now isn't built yet: stop after the job instead.",
               'effect': None}


@dataclass(frozen=True)
class Wait:
    until: datetime.datetime | None
    reason: str


START_HINT = ('Double-click Queue runner.lnk in ~/.queue-runner, or run pythonw -m queue_runner '
              'in the repo.')
COST_LABELS = {'build': ('Build', 'builds'), 'fix': ('Fix round', 'fix rounds'),
               'decision': ('Decision', 'decisions'), 'live': ('Live steps', 'live runs')}
ROLES = [
    {'job': 'Build', 'what': 'A new issue becomes a PR', 'lane': 'claude'},
    {'job': 'Fix', 'what': 'Answers a blocking review, or merges main into a PR that conflicts',
     'lane': 'claude'},
    {'job': 'Decision', 'what': "Decides a case the fixed flow doesn't cover", 'lane': 'claude'},
    {'job': 'Live steps', 'what': 'After a merge, makes it live', 'lane': 'claude'},
    {'job': 'Review', 'what': 'Reviews each PR head', 'lane': 'sol'},
]
# The sources, in the page's order: (id, group, name, short, what an answer is called).
SOURCES = [
    ('claude_usage', 'provider', 'Claude usage', 'Claude', 'Read'),
    ('sol_usage', 'provider', 'ChatGPT usage', 'ChatGPT', 'Read through Codex'),
    ('t3', 'local', 'T3 Code', 'T3 Code', 'Answered'),
    ('github', 'external', 'GitHub', 'GitHub', 'Answered'),
]
WINDOW_LABELS = {300: ('five_hour', 'Session'), 10080: ('week', 'Weekly')}


@dataclass(frozen=True)
class Call:
    """The last real call of one kind (a source): when, whether it answered, and when one last
    did."""
    at: datetime.datetime
    ok: bool
    note: str | None                       # what went wrong, when it failed
    good_at: datetime.datetime | None      # the last call that answered


@dataclass(frozen=True)
class RunnerInfo:
    pid: int | None
    started_at: datetime.datetime | None
    commit: str | None


@dataclass(frozen=True)
class Facts:
    """Everything `build` needs, as plain data. Later tickets add theirs with a default."""
    now: datetime.datetime
    # config.Repo in the build order: control.json's repo_order, else config.toml's (ticket 33).
    # The features and each lane's queue go through the repos in this order too.
    repos: list = field(default_factory=list)
    jobs: list = field(default_factory=list)     # state.Job, the job log folded
    knob: Knob | None = Knob()                   # gate.json; None: unreadable
    # Each lane's stop (control.json, or gate.json's older pause), as read for this snapshot.
    switch: control.Switch = control.Switch()
    claude_model: str = 'claude-opus-5-5'
    # The gate's verdict or a limit's resume, as the Claude lane's last pass left it.
    claude_wait: Wait | None = None
    sol_wait: Wait | None = None      # ChatGPT out of usage: when reviews start again
    # (repo, n): the issue's or PR's title, as the pass that started a job on it read it.
    titles: dict = field(default_factory=dict)
    threads: dict = field(default_factory=dict)   # job id: its T3 thread's link, once found
    runner: RunnerInfo | None = None
    calls: dict = field(default_factory=dict)     # source id: Call
    claude_usage: Reading | None = None
    sol_usage: Reading | None = None
    costs: dict = field(default_factory=dict)     # kind: (gate.Cost, learned or the default)
    # The Inbox (ticket 31): the Sol lane's last collection (inbox.Inbox, None before one), the
    # releases in the job log as (repo, n, at), and the repos it couldn't read GitHub for since
    # then (inbox.Reader.stale).
    inbox: object | None = None
    releases: list = field(default_factory=list)
    released: frozenset = frozenset()   # the jobs a release settled (`JobLog.released_ids`)
    inbox_stale: dict = field(default_factory=dict)
    # The work (ticket 32): the last read of each repo (`work.Reader.last()`: name -> RepoRead,
    # None before one), the repos it couldn't read since (`stale`), and the jobs a usage limit
    # cut off, in the order they resume (`JobLog.limited_jobs`).
    work: dict | None = None
    work_stale: dict = field(default_factory=dict)
    limited: list = field(default_factory=list)
    # Refresh on the Usage card (ticket 42): the request the publisher last acted on, and when
    # it read (`Snapshots`); None before one.
    usage_refresh: tuple | None = None


def _iso(t: datetime.datetime | None) -> str | None:
    return t.astimezone().isoformat(timespec='seconds') if t else None


def build(facts: Facts) -> dict:
    snap = {
        'version': VERSION,
        'written_at': _iso(facts.now),
        'write_every': WRITE_EVERY,
        # The control file this snapshot's lanes obey: each lane reads it again before it
        # starts anything, so what's shown here is what they do (ticket 30).
        'control_read_at': facts.switch.written_at if facts.switch.error is None else None,
        'runner': _runner(facts),
        'start_hint': START_HINT,
        'sources': _sources(facts),
        'repos': _repos(facts),
        'lanes': _lanes(facts),
        'usage': [_claude_usage(facts), _sol_usage(facts)],
        'usage_refresh': {'asked_at': _iso(facts.usage_refresh[0]),
                          'done_at': _iso(facts.usage_refresh[1])} if facts.usage_refresh else None,
        'knob': _knob(facts),
        'costs': _costs(facts),
        'roles': [dict(r) for r in ROLES],
    }
    snap.update(_work(facts))
    from .asks import stale_github
    stale_github(snap['sources'], facts.inbox_stale)   # the Inbox from an older read, said
    if facts.work_stale:
        from .work import stale_github as work_stale
        work_stale(snap['sources'], facts.work_stale)   # ... and the work lists
    return snap


def _repos(facts: Facts) -> list[dict]:
    """In the build order, each with `stopped` (ticket 37): when Stefan stopped it, or None."""
    return [{'name': r.name, 'github': f'https://github.com/{r.github}' if r.github else None,
             'merge': r.merge, 'stopped': _repo_stopped(facts, r.name)} for r in facts.repos]


def _repo_stopped(facts: Facts, name: str) -> dict | None:
    stop = facts.switch.repo_stop(name)
    if facts.switch.error is not None or not stop.stopped:
        return None
    return {'at': _iso(stop.at) if stop.at else None}


def _work(facts: Facts) -> dict:
    """The work lists: the Inbox's asks (`asks.py`, ticket 31); the features, issues, PRs and
    activity (`work.py`, ticket 32)."""
    from .asks import render
    from .work import lists
    asks, answered = render(facts.inbox, facts.jobs, facts.releases, facts.repos)
    _decide(facts, asks, answered)
    for a in asks + answered:
        a.update(_marks(facts, a['id']))
    return {'asks': asks, 'answered': answered,
            **lists(_view(facts), asks, facts.releases, facts.inbox)}


def _decide(facts: Facts, asks: list, answered: list) -> None:
    """Each ask's `decide` and `also` (ticket 35: decided in a T3 thread)."""
    from .ask_threads import mark, waits_text
    job, wait = _open_job(facts, CLAUDE_KINDS), facts.claude_wait
    mark(asks, answered, facts.jobs, facts.switch.opened,
         lambda repo: waits_text(facts.switch, repo, job, wait.reason if wait else None),
         released=facts.released)


def _marks(facts: Facts, id: str) -> dict:
    """What Stefan did with an ask in the Inbox (ticket 36: control.json's `asks.<id>`): `read`,
    and `snoozed_until` while that time is still ahead (a snooze whose time has passed is over).
    A snoozed ask stays listed: it still holds its work up, and the page leaves it out of the
    count."""
    entry = facts.switch.asks.get(id) or {}
    until = control._when(entry.get('snooze_until'))
    return {'read': entry.get('read') is True,
            'snoozed_until': _iso(until) if until is not None and until > facts.now else None}


def _view(facts: Facts):
    """What the work lists are written from (`work.View`), or None before the first read."""
    from .work import View
    if facts.work is None:
        return None
    off = frozenset(r.name for r in facts.repos if _repo_stopped(facts, r.name) is not None)
    return View(reads=facts.work, jobs=facts.jobs, repos=facts.repos, off=off,
                limited=facts.limited, titles=facts.titles, released=facts.released,
                lane_jobs={'claude': _open_job(facts, CLAUDE_KINDS),
                           'sol': _open_job(facts, SOL_KINDS)})


def _queue(facts: Facts, lane: str) -> tuple[list[dict], str]:
    """A lane's queue, in the order it takes them up, and what to say when it's empty."""
    from .work import queue
    return queue(_view(facts), lane)


def _model(model: str) -> str:
    """claude-opus-5-5 as Stefan reads it: Opus 5.5."""
    m = re.fullmatch(r'claude-([a-z]+)-(\d+)-(\d+)', model)
    return f'{m[1].title()} {m[2]}.{m[3]}' if m else model


def _sentence(text: str) -> str:
    text = text.strip()
    return text[:1].upper() + text[1:] + ('' if text.endswith(('.', '!', '?')) else '.')


def _open_job(facts: Facts, kinds) -> object | None:
    found = [j for j in facts.jobs if j.open and j.kind in kinds]
    return max(found, key=lambda j: j.started_at, default=None)


def _job(facts: Facts, job) -> dict:
    on_pr = job.kind in ON_PR or (job.kind == 'decision' and job.sha)
    return {
        'kind': 'conflict' if job.kind == 'fix' and job.cause == 'conflict' else job.kind,
        'repo': job.repo,
        'ref': f'PR #{job.issue}' if on_pr else f'#{job.issue}',
        'title': facts.titles.get((job.repo, job.issue), ''),
        'started_at': _iso(datetime.datetime.fromisoformat(job.started_at.replace('Z', '+00:00'))),
        'sha': job.sha[:7] if job.sha and job.kind != 'live' else None,
        'pr': job.issue if on_pr else None,
        'thread': facts.threads.get(job.id) or job.link,
    }


def _lane(facts: Facts, id: str, job, wait: Wait | None) -> dict:
    stop = facts.switch.stop(id)
    if facts.switch.error is not None:   # nothing starts until it's fixed: say so
        wait = Wait(None, control.unreadable_text(facts.switch))
        stop = control.Stop()
    if job is not None:
        state = 'stopping' if stop.stopped else 'working'
    elif stop.stopped:
        state = 'stopped'
    else:
        state = 'waiting' if wait else 'idle'
    queue, empty = _queue(facts, id)
    lane = {
        'id': id,
        'provider': 'claude' if id == 'claude' else 'chatgpt',
        'name': 'Claude' if id == 'claude' else 'ChatGPT',
        'does': 'builds and fixes' if id == 'claude' else 'reviews',
        # A review the Opus fallback runs while Sol is out of usage (issue #69) is Claude's.
        'model': _model(facts.claude_model) if id == 'claude' or getattr(job, 'reviewer', None)
        else SOL_MODEL,
        'state': state,
        'job': _job(facts, job) if job is not None else None,
        'next': None,   # read by the page's earlier takes only
        'wait': {'until': _iso(wait.until), 'reason': _sentence(wait.reason)}
        if wait and state == 'waiting' else None,
        'stop_now': dict(NO_STOP_NOW),
        'queue': queue,
        'queue_empty': empty,
    }
    if state == 'stopped':
        lane['stopped'] = {'at': _iso(stop.at), 'during': None}   # "now" is ticket 34's
    return lane


def _lanes(facts: Facts) -> list[dict]:
    return [_lane(facts, 'claude', _open_job(facts, CLAUDE_KINDS), facts.claude_wait),
            _lane(facts, 'sol', _open_job(facts, SOL_KINDS), facts.sol_wait)]


def _knob(facts: Facts) -> dict:
    """gate.json's reserve, and `paused` in the switch's word: whether Stefan stopped the Claude
    lane."""
    return {'paused': facts.switch.stop('claude').stopped,
            'reserve': facts.knob.reserve if facts.knob else None}


def _runner(facts: Facts) -> dict:
    r = facts.runner or RunnerInfo(None, None, None)
    return {'pid': r.pid, 'started_at': _iso(r.started_at), 'commit': r.commit}


def _sources(facts: Facts) -> list[dict]:
    out = []
    for id, group, name, short, answered in SOURCES:
        call = facts.calls.get(id)
        if call is None:
            note, ok, at = 'Not called yet', True, None
        elif call.ok:
            note, ok, at = answered, True, call.at
        elif id == 'claude_usage' and _claude_stands(facts):
            # A failed call beside a recent Claude reading isn't shown (issue 66): it stands.
            note, ok, at = answered, True, call.good_at
        else:   # the page shows a failing source's time as its last good one
            note, ok, at = call.note or 'Failed', False, call.good_at
        out.append({'id': id, 'group': group, 'name': name, 'short': short, 'ok': ok,
                    'note': note, 'checked_at': _iso(at)})
    return out


def _claude_stands(facts: Facts) -> bool:
    """Whether Claude's reading stands though its latest call failed: it's good, under
    `STALE_AFTER` old, and the login isn't the trouble (`usage.Reading.failing`)."""
    r = facts.claude_usage
    return r is not None and r.value is not None and not r.failing(facts.now)


def _plan(id: str, provider: str, name: str, reading: Reading | None, windows,
          plan=None, error: str | None = None, next_read_at=None) -> dict:
    """`resets` (ticket 42): the reset credits the plan has left, from the same read as its
    windows, or None when it has none to give (or isn't read yet). `error`: what to say instead
    of the reading's own ('' for nothing). `next_read_at` (issue 66): when the endpoint may be
    asked again, while that's ahead; None for a plan that's read whenever it's asked."""
    good = reading is not None and reading.value is not None
    if error is None:
        error = reading.error if reading and reading.error else None if good else 'Not read yet'
    resets = getattr(reading.value, 'resets', None) if good else None
    return {'id': id, 'provider': provider, 'name': name, 'plan': plan,
            'read_at': _iso(reading.at) if good else None,
            'error': _sentence(error) if error else None, 'windows': windows,
            'resets': {'available': resets} if resets is not None else None,
            'next_read_at': _iso(next_read_at)}


def _claude_usage(facts: Facts) -> dict:
    reading = facts.claude_usage
    windows = []
    if reading and reading.value is not None:
        five, week = reading.value.five_hour, reading.value.seven_day
        windows = [
            {'id': 'five_hour', 'label': 'Session', 'used': five.used,
             'resets_at': _iso(five.resets_at), 'gates': True},
            {'id': 'week', 'label': 'Weekly', 'used': week.used, 'resets_at': _iso(week.resets_at),
             'gates': True, 'reserve': facts.knob.reserve if facts.knob else None,
             'reserve_opens_at': _iso(week.resets_at - RESERVE_RELEASE)
             if week.resets_at else None},
        ]
    return _plan('claude', 'claude', 'Claude', reading, windows, error=_claude_error(facts),
                 next_read_at=getattr(reading, 'next_at', None))


def _claude_error(facts: Facts) -> str:
    """What Claude's plan says went wrong (issue 66): nothing while a failed call stands beside
    a recent reading; a stale reading says no Claude job starts on it."""
    r = facts.claude_usage
    if r is None or r.value is None and r.error is None:
        return 'Not read yet'
    if not r.failing(facts.now):
        return ''
    if r.value is not None and not r.login:
        return (f'{r.error}; the reading is over {STALE_AFTER.total_seconds() / 60:g} minutes '
                'old, so no Claude job starts until a read answers')
    return r.error


def _sol_usage(facts: Facts) -> dict:
    reading = facts.sol_usage
    limits = reading.value if reading else None
    windows = []
    for w in (limits.windows if limits else ()):
        id, label = WINDOW_LABELS.get(w.minutes, (f'{w.minutes}m', f'{w.minutes} minutes'))
        windows.append({'id': id, 'label': label, 'used': w.used, 'resets_at': _iso(w.resets_at),
                        'gates': True})
    plan = limits.plan.title() if limits and limits.plan else None
    return _plan('sol', 'chatgpt', 'ChatGPT', reading, windows, plan)


def _costs(facts: Facts) -> list[dict]:
    rows = []
    for kind, (label, many) in COST_LABELS.items():
        if kind not in facts.costs:
            continue
        cost, learned = facts.costs[kind]
        rows.append({'kind': kind, 'label': label, 'session': cost.five_hour,
                     'week': cost.seven_day,
                     'basis': f'The largest of the last {RECENT}' if learned else
                     f'The cautious default, until {SAMPLES} {many} are recorded'})
    return rows


# --- what the passes last saw -------------------------------------------------------------------

def _short(e: BaseException) -> str:
    """An error's first line, short enough for the page."""
    text = (str(e).strip().splitlines() or [type(e).__name__])[0]
    return text[:200]


class Calls:
    """The last real call of each kind (`SOURCES`), from both lanes and the publisher."""

    def __init__(self, clock):
        self.clock = clock
        self._lock = threading.Lock()
        self._calls: dict[str, Call] = {}

    def record(self, id: str, ok: bool, note: str | None = None) -> None:
        with self._lock:
            now = self.clock()
            last = self._calls.get(id)
            good = now if ok else (last.good_at if last else None)
            self._calls[id] = Call(now, ok, None if ok else note, good)

    def all(self) -> dict[str, Call]:
        with self._lock:
            return dict(self._calls)

    def watch(self, adapter, id: str) -> 'Watched':
        return Watched(adapter, self, id)


class Watched:
    """An adapter (GitHub, T3) whose every method call is recorded as its source's last call.
    Its error is re-raised as it was; anything that isn't a call passes straight through."""

    def __init__(self, inner, calls: Calls, id: str):
        object.__setattr__(self, '_inner', inner)
        object.__setattr__(self, '_calls', calls)
        object.__setattr__(self, '_id', id)

    def __getattr__(self, name):
        attr = getattr(self._inner, name)
        if not callable(attr):
            return attr

        def call(*args, **kwargs):
            try:
                result = attr(*args, **kwargs)
            except Exception as e:
                self._calls.record(self._id, False, _short(e))
                raise
            self._calls.record(self._id, True)
            return result
        return call

    def __setattr__(self, name, value):
        setattr(self._inner, name, value)


class Watch:
    """A usage reader whose reads are kept (ChatGPT's): `read()`, `reading()` for the snapshot,
    and `due(seconds)` once the last read (good or not) is that old. With `timed`, `read_fn`
    returns (when it was read, the value). Claude's is `usage.CachedUsage`, which has the same
    three and a 5-minute budget (issue 66)."""

    def __init__(self, read_fn, calls: Calls, id: str, clock, timed: bool = False):
        self.read_fn, self.calls, self.id, self.clock, self.timed = read_fn, calls, id, clock, timed
        self._lock = threading.Lock()
        self._good: Reading | None = None
        self._error: str | None = None
        self._tried: datetime.datetime | None = None

    def read(self):
        with self._lock:
            self._tried = self.clock()
            try:
                got = self.read_fn()
            except Exception as e:
                self._error = _short(e)
                self.calls.record(self.id, False, self._error)
                raise
            at, value = got if self.timed else (self._tried, got)
            self._good, self._error = Reading(value, at), None
            self.calls.record(self.id, True)
            return value

    def reading(self) -> Reading | None:
        with self._lock:
            if self._good is None and self._error is None:
                return None
            good = self._good or Reading(None, None)
            return Reading(good.value, good.at, self._error)

    def due(self, seconds: float) -> bool:
        with self._lock:
            return self._tried is None or \
                (self.clock() - self._tried).total_seconds() >= seconds


# --- writing it -------------------------------------------------------------------------------

def write(path: str, snap: dict) -> None:
    """Whole: a temp file beside it, then swapped in, so the page never reads half a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}.{threading.get_ident()}.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(snap, f, ensure_ascii=False, indent=1)
        for attempt in range(3):   # the page may be reading it just then (Windows)
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 2:
                    raise
                time.sleep(0.05)
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)


class Publisher:
    """Writes `make(fresh)`'s snapshot to `path`. `publish()` after each pass of either lane
    (fresh False: only what's already known); its own thread, from `start()` to `stop()`, writes
    every `every` seconds with fresh True (usage read when due, open jobs' threads looked up).
    A write that fails is said once, until one succeeds again, and never raises."""

    def __init__(self, path: str, make, say, every: float = WRITE_EVERY):
        self.path, self.make, self.say, self.every = path, make, say, every
        self._lock = threading.Lock()
        self._failing: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def publish(self, fresh: bool = False) -> bool:
        with self._lock:
            try:
                write(self.path, self.make(fresh))
            except Exception as e:
                if self._failing is None:
                    self.say(f'The dashboard snapshot was not written ({type(e).__name__}: '
                             f'{_short(e)}); the runner goes on and tries again')
                self._failing = _short(e)
                return False
            if self._failing is not None:
                self.say('The dashboard snapshot is written again')
            self._failing = None
            return True

    def start(self) -> None:
        self.publish()
        self._stop.clear()
        self._thread = threading.Thread(target=self._tick, name='snapshot', daemon=True)
        self._thread.start()

    def _tick(self) -> None:
        while not self._stop.wait(self.every):
            self.publish(fresh=True)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=30)
            self._thread = None


# --- gathering the facts ----------------------------------------------------------------------

def _when(stamp: str) -> datetime.datetime:
    return when(stamp)


class Snapshots:
    """The facts from the state folder and what the runner knows, and the snapshot built from
    them. `runner` is the running `run.Runner` (its `claude_wait`, `titles` and `find_thread`), or
    None for `--snapshot`, which then reads a limit's wait from the job log. `claude` and `sol`
    are the usage `Watch`es. Nothing here reads GitHub."""

    def __init__(self, config, *, calls: Calls, claude: Watch | None, sol: Watch | None,
                 info: RunnerInfo, clock, runner=None, readers=None):
        self.config, self.calls, self.claude, self.sol = config, calls, claude, sol
        self.info, self.clock, self.runner = info, clock, runner
        # With no runner (`--snapshot`): the Inbox's and the work's readers, each read once.
        self.readers = dict(readers or {})
        self._threads: dict[str, str] = {}
        self._lock = threading.Lock()
        self._refreshed: tuple | None = None   # (the Refresh acted on, when it read)

    def build(self, fresh: bool = False) -> dict:
        return build(self.facts(fresh))

    def facts(self, fresh: bool = False) -> Facts:
        """With `fresh`, usage is read when `READ_EVERY` has passed since the last read, or when
        Stefan asked for a Refresh since the last one acted on (ticket 42), and an open Claude
        job's thread is looked up in T3 until it's found. Claude's reader asks its endpoint only
        when its 5-minute budget allows (issue 66), so a Refresh inside it is taken and gives
        back the cached reading; ChatGPT's is read."""
        from .gate import CLAUDE_KINDS as KINDS, CostBook, read_knob
        from .state import JobLog
        state = self.config.state_dir
        log = JobLog(os.path.join(state, 'jobs.jsonl'))
        jobs = log.jobs()
        now = self.clock()
        switch = control.read(state)   # once: the stops, the build order (ticket 33), a Refresh
        if fresh:
            asked = self._refresh(switch)
            for watch in (self.claude, self.sol):
                if watch is not None and (asked or watch.due(READ_EVERY)):
                    with contextlib.suppress(Exception):   # kept in the reading as its error
                        watch.read()
            if asked:
                self._refreshed = (switch.refresh_at, self.clock())
            self._find_threads(jobs)
        try:
            knob = read_knob(state)
        except (OSError, ValueError):
            knob = None
        book = CostBook(os.path.join(state, 'usage.jsonl'))
        try:
            costs = {k: (book.expected(k), book.learned(k)) for k in KINDS}
        except (OSError, ValueError):
            costs = {}
        with self._lock:
            threads = dict(self._threads)
        runner = self.runner
        repos, _ = control.ordered(toml_order(self.config), switch.order)
        return Facts(
            now=now, repos=repos, jobs=jobs, knob=knob,
            switch=switch,
            claude_model=self.config.claude_model,
            claude_wait=runner.claude_wait if runner is not None else self._limit_wait(log, now),
            sol_wait=self._sol_wait(log, now),
            titles=dict(runner.titles) if runner is not None else {},
            threads=threads, runner=self.info, calls=self.calls.all(),
            claude_usage=self.claude.reading() if self.claude else None,
            sol_usage=self.sol.reading() if self.sol else None, costs=costs,
            usage_refresh=self._refreshed,
            **self._inbox(log))

    def _refresh(self, switch) -> bool:
        """Whether a Refresh asked on the page is to be taken now: newer than the last one acted
        on."""
        asked = switch.refresh_at if switch.error is None else None
        return asked is not None and (self._refreshed is None or asked > self._refreshed[0])

    def _inbox(self, log) -> dict:
        """The Sol lane's last Inbox read (ticket 31) and work read (ticket 32), the releases
        their timelines tell, and the jobs a limit cut off. `--snapshot` has no runner: it gives
        `readers`, read once."""
        found = {'releases': log.releases(), 'limited': log.limited_jobs(),
                 'released': frozenset(log.released_ids())}
        inbox = self.readers.get('inbox') or getattr(self.runner, 'inbox', None)
        if inbox is not None:
            found.update(inbox=inbox.last(), inbox_stale=inbox.stale())
        work = self.readers.get('work') or getattr(self.runner, 'work', None)
        if work is not None:
            found.update(work=work.last(), work_stale=work.stale())
        return found

    def _find_threads(self, jobs) -> None:
        if self.runner is None:
            return
        for job in jobs:
            if not job.open or job.kind not in CLAUDE_KINDS or job.link or job.id in self._threads:
                continue
            try:
                thread = self.runner.find_thread(job)
            except Exception:   # T3's own failure is its source's last call
                continue
            if thread is not None:
                with self._lock:
                    self._threads[job.id] = thread.link

    @staticmethod
    def _limit_wait(log, now) -> Wait | None:
        """A job a usage limit cut off: the Claude lane starts nothing until it resumes (as
        `run.Runner.choose` says it)."""
        limited = log.limited_jobs()
        if not limited or not limited[0].resume_at or _when(limited[0].resume_at) <= now:
            return None
        j = limited[0]
        return Wait(_when(j.resume_at), f'{j.kind} {j.repo}#{j.issue} was cut off by a usage '
                    'limit; it resumes after this')

    @staticmethod
    def _sol_wait(log, now) -> Wait | None:
        resume = log.sol_resume_at()
        if resume and _when(resume) > now:
            return Wait(_when(resume), 'ChatGPT ran out of usage: Opus reviews in its place, '
                        "through Claude's usage gate, until 10 minutes after its reset")
        return None
