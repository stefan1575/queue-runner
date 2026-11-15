"""One switch per lane (ticket 30; `.scratch/queue-runner/dashboard-live.md`, One switch).

`<state_dir>/control.json` is the one record of whether Stefan stopped a lane: the dashboard's
Stop and Resume write it (`dashboard/serve.py`, `apply_control`) and so do `--pause` and
`--resume` (`ask`), in the same format:

    {"version": 1, "written_at": "<ISO>", "lanes": {"claude": {"stop": "after-job", "at": "<ISO>"}},
     "repo_order": [...]}

`lanes.<id>.stop` is "after-job" (the lane's job finishes, and it starts nothing after), "now"
(read as "after-job" until ticket 34) or null (it carries on). The runner reads it (`read`) before
each lane starts a job; an unreadable file starts nothing in either lane until it's fixed.

**The older code's pause** was `gate.json`'s `paused`. With `paused: true` there and no entry for
the Claude lane here, the Claude lane is stopped (since gate.json was written); an entry, either
way, wins. `ask` carries such a pause over into this file and drops it from gate.json, which then
keeps only `reserve`.
"""
import datetime
import json
import os
from dataclasses import dataclass, field

LANES = ('claude', 'sol')
STOPS = (None, 'after-job', 'now')
NAMES = {'claude': 'Claude', 'sol': 'reviewing'}


@dataclass(frozen=True)
class Stop:
    """What Stefan last asked of one lane: `asked` "after-job", "now" or None, and when."""
    asked: str | None = None
    at: datetime.datetime | None = None
    by: str | None = None   # 'control' (control.json) or 'gate' (gate.json's old pause)

    @property
    def stopped(self) -> bool:
        return self.asked is not None   # "now" stops after the job too, until ticket 34


@dataclass(frozen=True)
class Switch:
    """Both lanes' stops as read now, and the control file's own `written_at` (what the runner
    has acted on). `error`: control.json is unreadable, and nothing starts in either lane."""
    lanes: dict = field(default_factory=dict)   # lane id: Stop
    written_at: str | None = None
    error: str | None = None

    def stop(self, lane: str) -> Stop:
        return self.lanes.get(lane) or Stop()

    def holds(self, lane: str) -> bool:
        """Whether the lane may start nothing now."""
        return self.error is not None or self.stop(lane).stopped


def path(state_dir: str) -> str:
    return os.path.join(state_dir, 'control.json')


def _gate_path(state_dir: str) -> str:
    return os.path.join(state_dir, 'gate.json')


def _when(stamp) -> datetime.datetime | None:
    if not isinstance(stamp, str):
        return None
    try:
        t = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return None
    return t if t.tzinfo else t.astimezone()


def _old_pause(state_dir: str) -> datetime.datetime | None:
    """When gate.json was written, if it holds the older code's `paused: true`. An unreadable
    gate.json is the gate's to say (it starts no Claude job either)."""
    p = _gate_path(state_dir)
    try:
        with open(p, encoding='utf-8') as f:
            raw = json.load(f)
        at = os.path.getmtime(p)
    except (OSError, ValueError):
        return None
    if isinstance(raw, dict) and raw.get('paused') is True:
        return datetime.datetime.fromtimestamp(at, datetime.timezone.utc)
    return None


class Unreadable(ValueError):
    pass


def _load(state_dir: str) -> dict:
    """control.json as a dict ({} when there is none); Unreadable if it isn't one the page could
    have written."""
    try:
        with open(path(state_dir), encoding='utf-8') as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise Unreadable(str(e)) from None
    if not isinstance(raw, dict):
        raise Unreadable('it is not a JSON object')
    lanes = raw.get('lanes') or {}
    if not isinstance(lanes, dict):
        raise Unreadable('its "lanes" is not an object')
    for id, entry in lanes.items():
        if not isinstance(entry, dict) or entry.get('stop') not in STOPS:
            raise Unreadable(f'lane "{id}" is not {{"stop": "after-job", "now" or null}}')
    return raw


def read(state_dir: str) -> Switch:
    """Never raises: an unreadable control.json is the Switch's `error`."""
    try:
        raw = _load(state_dir)
    except Unreadable as e:
        return Switch(error=f'control.json is unreadable ({e})')
    entries = raw.get('lanes') or {}
    lanes = {}
    for id in LANES:
        if id in entries:
            lanes[id] = Stop(entries[id].get('stop'), _when(entries[id].get('at')), 'control')
        elif id == 'claude' and (at := _old_pause(state_dir)) is not None:
            lanes[id] = Stop('after-job', at, 'gate')
        else:
            lanes[id] = Stop()
    written = raw.get('written_at')
    return Switch(lanes, written if isinstance(written, str) else None)


# --- asking: --pause and --resume --------------------------------------------------------------

def _iso(t: datetime.datetime) -> str:
    return t.astimezone().isoformat(timespec='seconds')


def _write(state_dir: str, data: dict) -> None:
    """Whole: a temp file beside it, then swapped in, so a lane never reads half a file."""
    os.makedirs(state_dir, exist_ok=True)
    tmp = f'{path(state_dir)}.{os.getpid()}.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path(state_dir))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def ask(state_dir: str, lanes, stop: str | None, now: str) -> dict:
    """control.json after Stefan asks `stop` of each of `lanes` at `now` (an ISO time), in the
    page's format (`dashboard/serve.py`'s `apply_control`), written whole. An unreadable file is
    started afresh and entries it can't use are dropped, as the page does. gate.json's older
    pause, with no Claude entry yet, is carried over first (since gate.json was written), and
    gate.json is left with its reserve only."""
    if stop not in STOPS:
        raise ValueError(f'stop must be one of {STOPS}')
    try:   # as leniently as the page reads it (`serve.App.control`): what it can't use goes
        with open(path(state_dir), encoding='utf-8') as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    entries = {k: v for k, v in (raw.get('lanes') or {}).items() if isinstance(v, dict)}
    order = [r for r in (raw.get('repo_order') or []) if isinstance(r, str)]
    old = _old_pause(state_dir)
    if old is not None and 'claude' not in entries:
        entries['claude'] = {'stop': 'after-job', 'at': _iso(old)}
    for lane in lanes:
        entries[lane] = {'stop': stop, 'at': now}
    data = {'version': 1, 'written_at': now, 'lanes': entries, 'repo_order': order}
    _write(state_dir, data)
    if old is not None:
        from .gate import Knob, read_knob, write_knob
        write_knob(state_dir, Knob(reserve=read_knob(state_dir).reserve))
    return data


def carry_over(state_dir: str, now: str) -> bool:
    """Moves gate.json's older pause into control.json, if it holds one (before gate.json is
    written with the reserve only)."""
    if _old_pause(state_dir) is None:
        return False
    ask(state_dir, (), None, now)
    return True


# --- what the runner says -----------------------------------------------------------------------

def resume_hint(lane: str) -> str:
    cli = 'python3 -m queue_runner --resume' + ('' if lane == 'claude' else f' {lane}')
    return f"Resume on the dashboard, or {cli}"


def stopped_text(lane: str) -> str:
    what = 'starts no job' if lane == 'claude' else 'starts no review and merges nothing'
    return f'The {NAMES[lane]} lane is stopped by Stefan: it {what} ({resume_hint(lane)})'


def unreadable_text(switch: Switch) -> str:
    return (f'Neither lane starts anything: {switch.error}, and until it is fixed nothing '
            'starts (a Stop or Resume on the dashboard, or --pause or --resume, writes it afresh)')
