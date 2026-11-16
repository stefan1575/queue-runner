"""The usage gate: a Claude job starts only when it fits (`~/Code/docs/orchestration.md`,
Limits). Sol isn't gated.

- **The 5-hour window:** the job's expected cost must fit in what's left of it, or the Claude lane
  waits for its reset. A window not yet started (nothing used) takes any job.
- **The weekly reserve:** `reserve` percent of the week (5 unless Stefan changes it) stays unspent
  until 24 hours before the weekly reset; inside those 24 hours the queue may spend it. A job that
  wouldn't fit the week even then waits for the weekly reset.
- **Stefan's knob** is `<state_dir>/gate.json` (`reserve`), set with `--reserve N`; the runner
  reads it before every Claude job, so it works while it runs. Stopping a lane isn't the gate's:
  it's `control.json` (`control.py`), and an older `paused` here is read there.
- **Expected cost** per job kind (build, fix, decision), in percent of each window, is learned from
  `<state_dir>/usage.jsonl`: one record per Claude job pass, usage before and after. With fewer
  than `SAMPLES` usable records it's the cautious `DEFAULTS`; then the largest of the last `RECENT`.
- **The reading** (issue 66) is `usage.CachedUsage`'s, shared with the snapshot: the endpoint is
  asked at most once every 5 minutes. A check decides only on a reading taken after the last
  Claude job ended and no older than `STALE_AFTER`, even if the latest call failed; with none,
  the lane waits until the endpoint may be asked again. The after-job read waits for that too.
"""
import datetime
import json
import os
from dataclasses import dataclass

from .state import append_record, read_records
from .usage import STALE_AFTER, CachedUsage, Usage, UsageError, Window

DEFAULT_RESERVE = 5.0
RESERVE_RELEASE = datetime.timedelta(hours=24)   # before the weekly reset, the reserve is free
AFTER_RESET = datetime.timedelta(minutes=2)      # wait this past a reset before reading again
SAME_WINDOW = datetime.timedelta(minutes=10)     # two reads' resets this close: the same window
SAMPLES, RECENT = 3, 5
CLAUDE_KINDS = ('build', 'fix', 'decision', 'live')
# The Opus review while Sol is out of usage (issue #69) runs in the Sol lane, gated as `review`.
# It isn't one of the Claude lane's kinds: that lane's measurement counts only its own jobs.
FALLBACK_REVIEW = 'review'
GATED_KINDS = CLAUDE_KINDS + (FALLBACK_REVIEW,)

# Gate verdicts: why a job starts or waits.
FITS = 'fits'
RELEASED = 'reserve-released'   # fits only because the last 24 hours release the reserve
FIVE_HOUR = 'five-hour'         # waits for the 5-hour reset
RESERVE = 'weekly-reserve'      # waits for the reserve's release, 24 hours before the weekly reset
WEEKLY = 'weekly-full'          # waits for the weekly reset
# No reading to decide on (none, from before the last job, or stale), or gate.json or usage.jsonl
# unreadable: nothing starts until the endpoint may be asked again, or the next pass.
UNREADABLE = 'unreadable'


@dataclass(frozen=True)
class Cost:
    five_hour: float   # percent of the 5-hour window
    seven_day: float   # percent of the week

    def __add__(self, other: 'Cost') -> 'Cost':
        return Cost(self.five_hour + other.five_hour, self.seven_day + other.seven_day)


# Cautious until learned: a build is a long Opus thread, a fix round shorter, a decision one call.
# A live run reads the live doc, runs a few connector calls and one check: a little over a decision.
# A fallback review reads the diff and the code around it and may run the tests: between a
# decision and a fix round.
DEFAULTS = {'build': Cost(60, 15), 'fix': Cost(40, 10), 'decision': Cost(15, 4),
            'live': Cost(20, 5), FALLBACK_REVIEW: Cost(30, 8)}


@dataclass(frozen=True)
class Knob:
    reserve: float = DEFAULT_RESERVE


@dataclass(frozen=True)
class Verdict:
    go: bool
    why: str
    text: str                                # what the log says
    until: datetime.datetime | None = None   # when to look again (None: next pass)
    usage: Usage | None = None


def _local(t: datetime.datetime) -> str:
    return t.astimezone().isoformat(timespec='minutes')


def _pct(x: float) -> str:
    return f'{x:g}%'


def decide(usage: Usage, kind: str, cost: Cost, knob: Knob,
           now: datetime.datetime) -> Verdict:
    def wait(why, text, until=None):
        return Verdict(False, why, text, until, usage)

    five, week = usage.five_hour, usage.seven_day
    expect = f'a {kind} is expected to take {_pct(cost.five_hour)} of 5 hours, ' \
             f'{_pct(cost.seven_day)} of the week'
    released = False
    if week.used > 0 and week.used + cost.seven_day > 100:
        reset = week.resets_at if week.resets_at and week.resets_at > now else None
        until = reset + AFTER_RESET if reset else None
        return wait(WEEKLY, f'the week is {_pct(week.used)} used and {expect}: waiting for the '
                    f'weekly reset' + (f' at {_local(reset)}' if reset else ''),
                    until)
    if week.used > 0 and week.used + cost.seven_day > 100 - knob.reserve:
        release = week.resets_at - RESERVE_RELEASE if week.resets_at else None
        if release is None or now < release:
            return wait(RESERVE, f'the weekly reserve holds: the week is {_pct(week.used)} used, '
                        f'{expect}, and {_pct(knob.reserve)} is kept for Stefan'
                        + (f' until {_local(release)}' if release else ''), release)
        released = True
    if five.used > 0 and five.used + cost.five_hour > 100:
        reset = five.resets_at if five.resets_at and five.resets_at > now else None
        return wait(FIVE_HOUR, f'the 5-hour window is {_pct(five.used)} used and {expect}: '
                    f'waiting for its reset' + (f' at {_local(reset)}' if reset else ''),
                    reset + AFTER_RESET if reset else None)
    state = (f'5 hours {_pct(five.used)} used, the week {_pct(week.used)}; {expect}')
    if released:
        return Verdict(True, RELEASED, f'{kind} fits ({state}); the weekly reserve is released '
                       'in the last 24 hours before the weekly reset', None, usage)
    return Verdict(True, FITS, f'{kind} fits ({state})', None, usage)


# --- Stefan's knob ------------------------------------------------------------------------------

def _knob_path(state_dir: str) -> str:
    return os.path.join(state_dir, 'gate.json')


def read_knob(state_dir: str) -> Knob:
    try:
        with open(_knob_path(state_dir), encoding='utf-8') as f:
            raw = json.load(f)
    except FileNotFoundError:
        return Knob()
    # An older `paused` in it is control.py's to read.
    return Knob(reserve=float(raw.get('reserve', DEFAULT_RESERVE)))


def write_knob(state_dir: str, knob: Knob) -> None:
    """Written whole and swapped in, so a runner reading it never sees half a file."""
    os.makedirs(state_dir, exist_ok=True)
    path = _knob_path(state_dir)
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump({'reserve': knob.reserve}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + '.tmp', path)


# --- learned costs ------------------------------------------------------------------------------

def _spent(before: Window, after: Window) -> float | None:
    """What a job used of one window: None if the window reset while it ran."""
    if before.resets_at is None or before.used == 0:
        return after.used   # no window yet: one started during the job
    if after.resets_at is None or abs(after.resets_at - before.resets_at) > SAME_WINDOW:
        return None
    return max(0.0, after.used - before.used)


class CostBook:
    def __init__(self, path: str):
        self.path = path

    @staticmethod
    def default(kind: str) -> Cost:
        return DEFAULTS[kind]

    def record(self, kind: str, jobs: list, before: Usage, after: Usage | None,
               error: str | None = None) -> None:
        rec = {'at': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
               'kind': kind, 'jobs': jobs, 'before': before.record(),
               'after': after.record() if after else None}
        if after:
            rec['spent'] = {'five_hour': _spent(before.five_hour, after.five_hour),
                            'seven_day': _spent(before.seven_day, after.seven_day)}
        if error:
            rec['error'] = error
        append_record(self.path, rec)

    def _spent(self, kind: str, window: str) -> list[float]:
        return [r['spent'][window] for r in read_records(self.path)
                if r.get('kind') == kind and r.get('spent')
                and r['spent'].get(window) is not None]

    def expected(self, kind: str) -> Cost:
        """Raises ValueError if usage.jsonl has a bad line (other than a torn last one)."""
        default = self.default(kind)

        def learned(window, fallback):
            got = self._spent(kind, window)
            return max(got[-RECENT:]) if len(got) >= SAMPLES else fallback
        return Cost(learned('five_hour', default.five_hour),
                    learned('seven_day', default.seven_day))

    def learned(self, kind: str) -> bool:
        """Whether `expected(kind)` is learned in both windows, not the cautious default."""
        return all(len(self._spent(kind, w)) >= SAMPLES for w in ('five_hour', 'seven_day'))


class Gate:
    """`check(kind)` before a Claude job; `measured(...)` after it. `reader` is the shared
    `usage.CachedUsage` (an endpoint's reader is wrapped in one); `sleep` waits on the wall clock
    for the after-job read (`run.wall_sleep` unless given)."""

    def __init__(self, state_dir: str, reader, clock=None, sleep=None):
        self.state_dir = state_dir
        self.clock = clock or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.reader = reader if isinstance(reader, CachedUsage) else \
            CachedUsage(reader, self.clock)
        self.sleep = sleep
        self.book = CostBook(os.path.join(state_dir, 'usage.jsonl'))
        self.ended: datetime.datetime | None = None   # when the last measured Claude job ended

    def knob(self) -> Knob:
        return read_knob(self.state_dir)

    def check(self, kind: str, then: str | None = None) -> Verdict:
        """Whether a `kind` job fits now. With `then`, the kind of job it may continue in the
        same pass (a decision's retry or answer), whose cost counts too."""
        label = f'{kind} (and the {then} it may continue)' if then else kind
        try:
            knob = self.knob()
        except (OSError, ValueError) as e:
            return Verdict(False, UNREADABLE, f'gate.json is unreadable ({e}): no Claude job '
                           'starts until it is fixed or removed')
        usage, wait = self.usage()
        if usage is None:
            return wait
        try:
            cost = self.book.expected(kind)
            if then:
                cost = cost + self.book.expected(then)
        except (OSError, ValueError) as e:
            return Verdict(False, UNREADABLE, f'usage.jsonl is unreadable ({e}): no Claude job '
                           'starts until it is fixed or removed')
        return decide(usage, label, cost, knob, self.clock())

    def usage(self) -> tuple[Usage | None, Verdict | None]:
        """The reading a check decides on (the endpoint asked if the budget allows), or None and
        the wait: until the endpoint may be asked again, or the next pass when it may be now."""
        try:
            self.reader.read()
        except UsageError:
            pass   # kept in the reading
        r, now, next_at = self.reader.reading(), self.clock(), self.reader.next_call_at()
        then = f'until the next read at {_local(next_at)}' if next_at else 'trying again next pass'
        failed = f' (the latest read failed: {r.error})' if r is not None and r.error else ''
        if r is None or r.value is None:
            text = (f'Claude usage is unreadable ({r.error if r else "not read yet"}): no Claude '
                    f'job starts, {then}')
        elif self.ended is not None and r.at < self.ended:
            text = (f'Claude usage was last read at {_local(r.at)}, before the last Claude job '
                    f'ended{failed}: no Claude job starts, {then}')
        elif now - r.at > STALE_AFTER:
            text = (f'Claude usage was last read at {_local(r.at)}, over '
                    f'{STALE_AFTER.total_seconds() / 60:g} minutes ago{failed}: no Claude job '
                    f'starts, {then}')
        else:
            return r.value, None
        return None, Verdict(False, UNREADABLE, text, next_at)

    def job_ended(self) -> None:
        """A Claude job's thread has ended (now): the next check decides only on a reading taken
        after it. `measured` says so itself; the runner says so for a thread that ended outside
        a measured pass (a dead runner's job settled, a decision whose retry never ran)."""
        self.ended = self.clock()

    def after_wait(self) -> float:
        """How long the after-job read will wait for the endpoint's budget, in seconds."""
        return self.reader.wait_seconds()

    def measured(self, kind: str, jobs: list, before: Usage) -> None:
        """Records usage after a Claude job pass, against `before` (read by its check). The read
        after it waits for the endpoint's budget (a job under 5 minutes), since the next check
        waits for that reading anyway; a reading another caller took after the job ended serves
        too. A failed read is recorded with its error and no `after`."""
        self.job_ended()
        wait = self.reader.wait_seconds()
        if wait > 0:
            if self.sleep is None:
                from .run import wall_sleep
                self.sleep = wall_sleep
            self.sleep(wait)
        try:
            self.reader.read()
        except UsageError:
            pass
        r = self.reader.reading()
        if r is not None and r.value is not None and r.at >= self.ended:
            after, error = r.value, None
        else:
            after, error = None, (r.error if r and r.error else 'no reading after the job')
        self.book.record(kind, jobs, before, after, error)
