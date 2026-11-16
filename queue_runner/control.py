"""One switch per lane (ticket 30; `.scratch/queue-runner/dashboard-live.md`, One switch).

`<state_dir>/control.json` is the one record of whether Stefan stopped a lane: the dashboard's
Stop and Resume write it (`dashboard/serve.py`, `apply_control`) and so do `--pause` and
`--resume` (`ask`), in the same format:

    {"version": 1, "written_at": "<ISO>", "lanes": {"claude": {"stop": "after-job", "at": "<ISO>"}},
     "repo_order": [...]}

`lanes.<id>.stop` is "after-job" (the lane's job finishes, and it starts nothing after), "now"
(read as "after-job" until ticket 34) or null (it carries on). The runner reads it (`read`) before
each lane starts a job; an unreadable file (an entry without a `stop` included) starts nothing
in either lane until it's fixed, and a write over it lets go only of what it names (`repaired`).

`repo_order` (ticket 33) is the order both lanes go through the served repos, read at the start
of each pass (`ordered`): used when it names every served repo exactly once, and otherwise
ignored (config.toml's order stands) without making the file unreadable.

`asks.<id>` (ticket 36) is what Stefan did with one ask in the Inbox: `read` (true or false) and
`snooze_until` (an ISO time or null), beside other keys other tickets keep there (35's `open`).
The page writes them; the runner only reads them into the snapshot's asks (`Switch.asks`), and
an entry it can't use is left out without making the file unreadable.

`repos.<name>.stop` (ticket 37) is "after-job" or null, with its `at`: a stopped repo gets nothing
from either lane (a job already running on it finishes), taken up at the start of each pass
(`stopped_repos`). A name that isn't served is ignored; an entry the page couldn't have written
makes the file unreadable, as a lane's does.

`asks.<id>.open` (ticket 35, `{"at"}`) asks the runner to start a T3 thread to decide that ask in
(`ask_threads.py`), read as `Switch.opened`; one the page couldn't have written is ignored.

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
REPO_STOPS = (None, 'after-job')   # a repo's: Stop now stays a lane's (ticket 37)
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
    order: object = None   # `repo_order` as written (None: not there); `ordered` judges it
    repos: dict = field(default_factory=dict)   # repo name: Stop, as written (ticket 37)
    opened: dict = field(default_factory=dict)  # ask id: when Stefan asked to open it (ticket 35)
    asks: dict = field(default_factory=dict)    # ask id: its entry, a dict (ticket 36)

    def stop(self, lane: str) -> Stop:
        return self.lanes.get(lane) or Stop()

    def repo_stop(self, name: str) -> Stop:
        return self.repos.get(name) or Stop()

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


def _usable(entry, stops) -> bool:
    """A lane's or repo's entry as the page writes it: an object whose `stop` is one of `stops`.
    One without a `stop` is not a Resume: it can't be used."""
    return isinstance(entry, dict) and 'stop' in entry and entry['stop'] in stops


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
    lanes = raw.get('lanes', {})
    if not isinstance(lanes, dict):
        raise Unreadable('its "lanes" is not an object')
    for id, entry in lanes.items():
        if not _usable(entry, STOPS):
            raise Unreadable(f'lane "{id}" is not {{"stop": "after-job", "now" or null}}')
    repos = raw.get('repos', {})
    if not isinstance(repos, dict):
        raise Unreadable('its "repos" is not an object')
    for name, entry in repos.items():
        if not _usable(entry, REPO_STOPS):
            raise Unreadable(f'repo "{name}" is not {{"stop": "after-job" or null}}')
    return raw


def repaired(raw, now: str) -> dict:
    """What a write starts from, as the page's does (`dashboard/serve.py`'s `usable`): `raw` is
    control.json as parsed (`MISSING` when there is none, `BROKEN` when it isn't JSON; JSON
    `null` parses to None, which is no more an object than `[]` is: review 2's F9). What can be
    read is kept, and nothing the unreadable file held is let go by a write that doesn't name it:
    a lane's or repo's entry that can't be used is written stopped ("after-job", at `now`), and
    with no lanes to read (not JSON, not an object, `lanes` not one) each lane is. A `repos` that
    isn't an object names no repo, and an order or ask that can't be used is dropped (neither
    held anything)."""
    if raw is MISSING:
        raw = {}
    broken = not isinstance(raw, dict)
    raw = {} if broken else raw
    stopped = {'stop': 'after-job', 'at': now}
    lanes, entries = {}, raw.get('lanes', {})
    if isinstance(entries, dict):
        for id, entry in entries.items():
            if _usable(entry, STOPS):
                lanes[id] = entry
            elif id in LANES:
                lanes[id] = dict(stopped)
    if broken or not isinstance(entries, dict):
        for id in LANES:
            lanes.setdefault(id, dict(stopped))
    repos, entries = {}, raw.get('repos', {})
    for name, entry in (entries.items() if isinstance(entries, dict) else ()):
        repos[name] = entry if _usable(entry, REPO_STOPS) else dict(stopped)
    order = raw.get('repo_order')
    marks = raw.get('asks')
    return {'version': 1, 'written_at': raw.get('written_at'), 'lanes': lanes,
            'repo_order': [r for r in order if isinstance(r, str)] if isinstance(order, list)
            else [], 'repos': repos,
            'asks': {k: v for k, v in marks.items() if isinstance(v, dict)}
            if isinstance(marks, dict) else {}}


BROKEN = object()    # control.json is there but isn't JSON (`repaired`)
MISSING = object()   # there is no control.json (`repaired`); not None, which JSON null parses to


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
    repos = {name: Stop(e.get('stop'), _when(e.get('at')), 'control')
             for name, e in (raw.get('repos') or {}).items()}
    marks = raw.get('asks') if isinstance(raw.get('asks'), dict) else {}
    return Switch(lanes, written if isinstance(written, str) else None,
                  order=raw.get('repo_order'), repos=repos,
                  asks={k: v for k, v in marks.items() if isinstance(v, dict)},
                  opened=_opened(raw))


def _opened(raw: dict) -> dict:
    """Each ask Stefan asked to open in a T3 thread (`asks.<id>.open.at`), and when."""
    asks = raw.get('asks')
    found = {}
    for id, record in (asks.items() if isinstance(asks, dict) else ()):
        at = _when(record.get('open', {}).get('at')) if isinstance(record, dict) and isinstance(
            record.get('open'), dict) else None
        if at is not None:
            found[id] = at
    return found


def ordered(repos: list, order) -> tuple[list, str | None]:
    """`repos` (config.toml's order) in `order`, control.json's `repo_order`, when it names each
    of them exactly once; else `repos` as they are, and why the order was ignored (None when
    none was set: missing or empty)."""
    if order is None or order == []:
        return list(repos), None
    names = [r.name for r in repos]
    if not isinstance(order, list) or not all(isinstance(n, str) for n in order):
        why = 'it is not a list of repo names'
    elif dupes := sorted({n for n in order if order.count(n) > 1}):
        why = f'it names {", ".join(dupes)} more than once'
    elif unknown := [n for n in order if n not in names]:
        verb = 'is' if len(unknown) == 1 else 'are'
        why = f'it names {", ".join(unknown)}, which {verb} not served'
    elif missing := [n for n in names if n not in order]:
        why = f'it leaves out {", ".join(missing)}'
    else:
        return sorted(repos, key=lambda r: order.index(r.name)), None
    return list(repos), why


def stopped_repos(repos: list, switch: Switch) -> tuple[list[str], list[str]]:
    """The served repos Stefan stopped (in `repos`' order), and the names control.json stops
    that aren't served (ignored)."""
    names = [r.name for r in repos]
    stopped = [n for n in names if switch.repo_stop(n).stopped]
    unknown = sorted(n for n, s in switch.repos.items() if s.stopped and n not in names)
    return stopped, unknown


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


def ask(state_dir: str, lanes, stop: str | None, now: str, repos=()) -> dict:
    """control.json after Stefan asks `stop` of each of `lanes` and `repos` (served repos' names,
    ticket 37) at `now` (an ISO time), in the page's format (`dashboard/serve.py`'s
    `apply_control`), written whole. An unreadable file is
    written afresh from what can be read (`repaired`), as the page does. gate.json's older
    pause, with no Claude entry yet, is carried over first (since gate.json was written), and
    gate.json is left with its reserve only."""
    if stop not in STOPS or (repos and stop not in REPO_STOPS):
        raise ValueError(f'stop must be one of {REPO_STOPS if repos else STOPS}')
    try:   # as the page reads it (`serve.App.control`): what it can't use is repaired
        with open(path(state_dir), encoding='utf-8') as f:
            raw = json.load(f)
    except FileNotFoundError:
        raw = MISSING
    except (OSError, ValueError):
        raw = BROKEN
    base = repaired(raw, now)
    entries, order, stops, marks = base['lanes'], base['repo_order'], base['repos'], base['asks']
    old = _old_pause(state_dir)
    if old is not None and 'claude' not in entries:
        entries['claude'] = {'stop': 'after-job', 'at': _iso(old)}
    for lane in lanes:
        entries[lane] = {'stop': stop, 'at': now}
    for name in repos:
        stops[name] = {'stop': stop, 'at': now}
    data = {'version': 1, 'written_at': now, 'lanes': entries, 'repo_order': order,
            'repos': stops, 'asks': marks}
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


def order_text(repos: list, why: str | None) -> str:
    """What a lane says when it takes up an order: Stefan's (`why` None), or config.toml's
    because his can't be used."""
    names = ', '.join(r.name for r in repos)
    if why is None:
        return f"Repos are taken in Stefan's build order now: {names}"
    return (f"control.json's repo_order is ignored ({why}): repos are taken in config.toml's "
            f'order, {names}. Reorder them on the dashboard to set it afresh')


def repo_stopped_text(name: str) -> str:
    return (f'{name} is stopped by Stefan: neither lane takes up its work, and a job already '
            f'running on it finishes (Resume it on the dashboard, or python3 -m queue_runner '
            f'--resume {name})')


def repo_resumed_text(name: str) -> str:
    return f'{name} runs again: Stefan resumed it'


def unknown_repos_text(names: list[str]) -> str:
    verb = 'is' if len(names) == 1 else 'are'
    return f"control.json stops {', '.join(names)}, which {verb} not served: ignored"


def unreadable_text(switch: Switch) -> str:
    return (f'Neither lane starts anything: {switch.error}, and until it is fixed nothing '
            'starts (a Stop or Resume on the dashboard, or --pause or --resume, writes it afresh)')
