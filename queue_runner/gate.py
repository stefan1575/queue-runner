"""The usage gate: a Claude job starts only when it fits (`~/.claude/docs/orchestration.md`,
Limits). Sol isn't gated.

- **The 5-hour window:** the job's expected cost must fit in what's left of it, or the Claude lane
  waits for its reset. A window not yet started (nothing used) takes any job.
- **The weekly reserve:** `reserve` percent of the week (5 unless Stefan changes it) stays unspent
  until 24 hours before the weekly reset; inside those 24 hours the queue may spend it. A job that
  wouldn't fit the week even then waits for the weekly reset.
- **Stefan's knob** is `<state_dir>/gate.json` (`paused`, `reserve`), set with `--pause`, `--resume`
  and `--reserve N`; the runner reads it before every Claude job, so it works while it runs.
- **Expected cost** per job kind (build, fix, decision), in percent of each window, is learned from
  `<state_dir>/usage.jsonl`: one record per Claude job pass, usage before and after. With fewer
  than `SAMPLES` usable records it's the cautious `DEFAULTS`; then the largest of the last `RECENT`.
"""
import datetime
import json
import os
from dataclasses import dataclass

from .usage import Usage, UsageError, Window

DEFAULT_RESERVE = 5.0
RESERVE_RELEASE = datetime.timedelta(hours=24)   # before the weekly reset, the reserve is free
AFTER_RESET = datetime.timedelta(minutes=2)      # wait this past a reset before reading again
SAME_WINDOW = datetime.timedelta(minutes=10)     # two reads' resets this close: the same window
SAMPLES, RECENT = 3, 5

# Gate verdicts: why a job starts or waits.
FITS = 'fits'
RELEASED = 'reserve-released'   # fits only because the last 24 hours release the reserve
FIVE_HOUR = 'five-hour'         # waits for the 5-hour reset
RESERVE = 'weekly-reserve'      # waits for the reserve's release, 24 hours before the weekly reset
WEEKLY = 'weekly-full'          # waits for the weekly reset
PAUSED = 'paused'
UNREADABLE = 'unreadable'       # usage couldn't be read: nothing starts; read again next pass


@dataclass(frozen=True)
class Cost:
    five_hour: float   # percent of the 5-hour window
    seven_day: float   # percent of the week


# Cautious until learned: a build is a long Opus thread, a fix round shorter, a decision one call.
DEFAULTS = {'build': Cost(60, 15), 'fix': Cost(40, 10), 'decision': Cost(15, 4)}


@dataclass(frozen=True)
class Knob:
    paused: bool = False
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

    if knob.paused:
        return wait(PAUSED, 'paused by Stefan: no Claude job starts '
                    '(python3 -m queue_runner --resume to go on)')
    five, week = usage.five_hour, usage.seven_day
    expect = f'a {kind} is expected to take {_pct(cost.five_hour)} of 5 hours, ' \
             f'{_pct(cost.seven_day)} of the week'
    released = False
    if week.used > 0 and week.used + cost.seven_day > 100:
        until = week.resets_at + AFTER_RESET if week.resets_at else None
        return wait(WEEKLY, f'the week is {_pct(week.used)} used and {expect}: waiting for the '
                    f'weekly reset' + (f' at {_local(week.resets_at)}' if week.resets_at else ''),
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
    return Knob(paused=bool(raw.get('paused', False)),
                reserve=float(raw.get('reserve', DEFAULT_RESERVE)))


def write_knob(state_dir: str, knob: Knob) -> None:
    """Written whole and swapped in, so a runner reading it never sees half a file."""
    os.makedirs(state_dir, exist_ok=True)
    path = _knob_path(state_dir)
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump({'paused': knob.paused, 'reserve': knob.reserve}, f)
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
        return DEFAULTS.get(kind, DEFAULTS['build'])

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
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec) + '\n')

    def _records(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                lines = f.read().split('\n')
        except FileNotFoundError:
            return
        for line in lines:
            try:
                yield json.loads(line)
            except ValueError:   # blank, or torn by a crash
                continue

    def expected(self, kind: str) -> Cost:
        spent = [r['spent'] for r in self._records() if r.get('kind') == kind and r.get('spent')]
        default = self.default(kind)

        def learned(window, fallback):
            got = [s[window] for s in spent if s.get(window) is not None]
            return max(got[-RECENT:]) if len(got) >= SAMPLES else fallback
        return Cost(learned('five_hour', default.five_hour),
                    learned('seven_day', default.seven_day))


class Gate:
    """`check(kind)` before a Claude job; `measured(...)` after it."""

    def __init__(self, state_dir: str, reader, clock=None):
        self.state_dir, self.reader = state_dir, reader
        self.clock = clock or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.book = CostBook(os.path.join(state_dir, 'usage.jsonl'))

    def knob(self) -> Knob:
        return read_knob(self.state_dir)

    def check(self, kind: str) -> Verdict:
        try:
            knob = self.knob()
        except (OSError, ValueError) as e:
            return Verdict(False, UNREADABLE, f'gate.json is unreadable ({e}): no Claude job '
                           'starts until it is fixed or removed')
        if knob.paused:   # no usage read needed
            return decide(Usage(Window(0, None), Window(0, None)), kind, self.default(kind),
                          knob, self.clock())
        try:
            usage = self.reader.read()
        except UsageError as e:
            return Verdict(False, UNREADABLE, f'Claude usage is unreadable ({e}): no Claude job '
                           'starts; trying again next pass')
        return decide(usage, kind, self.book.expected(kind), knob, self.clock())

    default = staticmethod(CostBook.default)

    def measured(self, kind: str, jobs: list, before: Usage) -> None:
        """Records usage after a Claude job pass, against `before` (read by its check)."""
        try:
            after, error = self.reader.read(), None
        except UsageError as e:
            after, error = None, str(e)
        self.book.record(kind, jobs, before, after, error)
