"""The dashboard's server: one page, the runner's snapshot, and the control file.

Standard library only. It imports nothing from the runner and calls neither T3 nor GitHub, so
neither can break it, and it can say truthfully that the runner has stopped writing.

    python3 -m dashboard    # one process, two kinds of address on one port (5289):
                            #   http://queue.localhost/ (through ~/Code/tools/localhost-proxy on port 80)
                            #   or http://queue.localhost:5289/  the runner's snapshot (--state-dir) and controls
                            #   http://localhost:5289/ and http://127.0.0.1:5289/  sample data, controls in a temp folder

The request's Host picks which. Its port is bound alone, so a second start exits 3.

The contract is two files in the state folder:

- `snapshot.json`: the runner writes it whole, the page only reads it. `dashboard/sample.py`
  builds one in every state the page has to show.
- `control.json`: what Stefan asked for from the page (stop a lane or a repo, which asks he has read or snoozed, a usage refresh). The page writes it whole, the runner reads it and says in the snapshot's
  `control_read_at` which write it has acted on.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import tempfile
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
EARLIER = HERE / "earlier"   # takes of the page before this one, served on the sample addresses only
DEFAULT_STATE_DIR = "~/.queue-runner/state"   # config.toml's state_dir; --state-dir for another
DEFAULT_PORT = 5289
MAX_BODY = 16_384

# What the page says when the runner hasn't written a snapshot yet. Its logon shortcut is made by
# scripts/make_shortcut.py; the dashboard can't tell whether the runner is up, only that no file is.
START_RUNNER = (f"Start it with its shortcut, ~/.queue-runner/Queue runner.lnk (a copy in the Startup folder starts it "
                f"at logon), or run pythonw -m queue_runner in {HERE.parent}. It writes one on every pass, "
                "and this page fills in by itself.")

NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
STOPS = (None, "after-job", "now")
REPO_STOPS = (None, "after-job")   # a repo's (ticket 37): Stop now stays a lane's
LANES = ("claude", "sol")   # the runner's lanes (queue_runner/control.py's LANES)
BROKEN = object()    # control.json is there but isn't JSON (`usable`)
MISSING = object()   # there is no control.json (`usable`); not None, which JSON null parses to
ASK = re.compile(r"^[A-Za-z0-9._-]{1,200}$")   # an ask's id: `stop-<job>`, `merge-<repo>-<n>-<head7>`...


class Refused(Exception):
    """A control request the page shouldn't have sent."""


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _snooze_until(value: object) -> str | None:
    """An ISO time with its offset (the page sends `toISOString()`), in this PC's offset; or null."""
    if value is None:
        return None
    try:
        t = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        t = None
    if t is None or t.tzinfo is None:
        raise Refused("snooze_until must be an ISO time with its offset, or null")
    return t.astimezone().isoformat(timespec="seconds")


def _usable_entry(entry: object, stops: tuple) -> bool:
    return isinstance(entry, dict) and "stop" in entry and entry["stop"] in stops


def usable(raw: object, now: str) -> dict:
    """control.json as the page and its writes read it, from `raw` as parsed (MISSING when there is
    none, BROKEN when it isn't JSON; JSON null is None, unreadable as `[]` is: review 2's F9),
    the same as the runner's `control.repaired`: what can be
    read is kept, and nothing an unreadable file held is let go by a write that doesn't name it.
    A lane's or repo's entry that can't be used reads as stopped ("after-job", at `now`), and
    with no lanes to read (not JSON, not an object, `lanes` not one) each lane does. A `repos`
    that isn't an object names no repo; an ask that can't be used is dropped, and so is an old
    `repo_order` (#50: the runner no longer reads one)."""
    broken = not isinstance(raw, dict) and raw is not MISSING
    raw = raw if isinstance(raw, dict) else {}
    stopped = {"stop": "after-job", "at": now}
    lanes, entries = {}, raw.get("lanes", {})
    if isinstance(entries, dict):
        for lane, entry in entries.items():
            if _usable_entry(entry, STOPS):
                lanes[lane] = entry
            elif lane in LANES:
                lanes[lane] = dict(stopped)
    if broken or not isinstance(entries, dict):
        for lane in LANES:
            lanes.setdefault(lane, dict(stopped))
    repos, entries = {}, raw.get("repos", {})
    for name, entry in (entries.items() if isinstance(entries, dict) else ()):
        repos[name] = entry if _usable_entry(entry, REPO_STOPS) else dict(stopped)
    marks, usage = raw.get("asks"), raw.get("usage")
    kept = {"version": 1, "written_at": raw.get("written_at"), "lanes": lanes, "repos": repos,
            "asks": {k: v for k, v in marks.items() if isinstance(v, dict)} if isinstance(marks, dict) else {}}
    # A Refresh asked (ticket 42) is kept through every read, or the page reading it back after
    # its POST loses it (PR #57's review 1, F1); one the page couldn't have written is dropped.
    if isinstance(usage, dict) and _is_time(usage.get("refresh_at")):
        kept["usage"] = {"refresh_at": usage["refresh_at"]}
    return kept


def _is_time(stamp) -> bool:
    """An ISO time, as the runner's `control._when` reads one (so both ends keep the same)."""
    try:
        return isinstance(stamp, str) and bool(datetime.fromisoformat(stamp.replace("Z", "+00:00")))
    except ValueError:
        return False


def apply_control(control: object, body: object, now: str, asks: set | None = None) -> dict:
    """The control file after one request: `{"lane", "stop"}`, `{"repo", "stop"}` (ticket 37),
    or an ask's `{"ask", "read"}` and `{"ask", "snooze_until"}` (ticket 36) and
    `{"ask", "open": true}` (ticket 35: decide that ask in a T3 thread), kept under `asks.<id>`
    beside that object's other keys, or `{"usage": "refresh"}` (ticket 42: read both plans'
    usage now), kept as `usage.refresh_at`. `{"repo_order"}` is refused: the page can't reorder
    the repos (#61), and the runner reads no order (#50), so one already in the file is dropped.
    `control` is the file as parsed, repaired first
    (`usable`) if the runner couldn't read it. With `asks`, the ids the snapshot
    lists now, entries for any other ask are dropped."""
    if not isinstance(body, dict):
        raise Refused("a JSON object is expected")
    control = usable(control, now)   # an unreadable file is written afresh from what can be read
    refresh = control["usage"]["refresh_at"] if "usage" in control else None
    lanes, repos = dict(control["lanes"]), dict(control["repos"])
    marks = {k: dict(v) for k, v in control["asks"].items()}
    keys = set(body)
    if keys == {"lane", "stop"}:
        lane, stop = body["lane"], body["stop"]
        if not isinstance(lane, str) or not NAME.match(lane):
            raise Refused("lane must be a lane's id")
        if stop not in STOPS:
            raise Refused('stop must be "after-job", "now" or null')
        lanes[lane] = {"stop": stop, "at": now}
    elif keys == {"repo", "stop"}:
        repo, stop = body["repo"], body["stop"]
        if not isinstance(repo, str) or not NAME.match(repo):
            raise Refused("repo must be a repo's name")
        if stop not in REPO_STOPS:
            raise Refused('a repo\'s stop must be "after-job" or null')
        repos[repo] = {"stop": stop, "at": now}
    elif keys in ({"ask", "read"}, {"ask", "snooze_until"}):
        ask = body["ask"]
        if not isinstance(ask, str) or not ASK.match(ask):
            raise Refused("ask must be an ask's id")
        if "read" in body:
            if not isinstance(body["read"], bool):
                raise Refused("read must be true or false")
            marks.setdefault(ask, {})["read"] = body["read"]
        else:
            marks.setdefault(ask, {})["snooze_until"] = _snooze_until(body["snooze_until"])
    elif keys == {"ask", "open"}:   # ticket 35: the runner starts a thread to decide it in, once
        ask = body["ask"]
        if not isinstance(ask, str) or not ASK.match(ask):
            raise Refused("ask must be an ask's id")
        if body["open"] is not True:
            raise Refused("open must be true")
        record = marks.setdefault(ask, {})
        if not isinstance(record.get("open"), dict):   # asked again: the first time stands
            record["open"] = {"at": now}
    elif keys == {"usage"}:   # ticket 42: Refresh on the Usage card
        if body["usage"] != "refresh":
            raise Refused('usage must be "refresh"')
        refresh = now
    else:
        raise Refused('send {"lane", "stop"}, {"repo", "stop"}, {"ask", "read"}, '
                      '{"ask", "snooze_until"}, {"ask", "open": true} or {"usage": "refresh"}')
    if asks is not None:   # an ask that's gone takes its entry with it
        marks = {k: v for k, v in marks.items() if k in asks}
    new = {"version": 1, "written_at": now, "lanes": lanes, "repos": repos, "asks": marks}
    if refresh is not None:
        new["usage"] = {"refresh_at": refresh}
    return new


class App:
    """What the server serves, apart from HTTP: the snapshot, and the control file's reads and writes."""

    def __init__(self, state_dir: Path, sample: bool = False, clock=now_iso):
        self.state_dir = Path(state_dir)
        self.sample = sample
        self.clock = clock
        self.started = datetime.now().astimezone()
        self.lock = threading.Lock()

    @property
    def snapshot_path(self) -> Path:
        return self.state_dir / "snapshot.json"

    @property
    def control_path(self) -> Path:
        return self.state_dir / "control.json"

    def snapshot(self, state: str | None = None) -> tuple[int, bytes]:
        if self.sample:
            from . import sample   # only ever loaded for sample data
            name = state if state in sample.STATES else sample.DEFAULT
            data = sample.build(name, base=self.started, control=self.control())
            return 200, json.dumps(data).encode()
        try:
            raw = self.snapshot_path.read_bytes()
            data = json.loads(raw)
            if isinstance(data, dict) and "sample" in data:   # the sample menu and the variant pill: never here
                del data["sample"]
                raw = json.dumps(data).encode()
        except FileNotFoundError:
            return 404, json.dumps({"error": "missing", "path": str(self.snapshot_path), "start": START_RUNNER}).encode()
        except (OSError, ValueError) as e:
            # The runner writes the file whole, so this is a real fault, not a torn read.
            return 500, json.dumps({"error": "unreadable", "path": str(self.snapshot_path), "detail": str(e)}).encode()
        return 200, raw

    def raw_control(self) -> object:
        """control.json as parsed: MISSING when there is none, BROKEN when it isn't JSON."""
        try:
            return json.loads(self.control_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return MISSING
        except (OSError, ValueError):
            return BROKEN

    def control(self) -> dict:
        """control.json as the page reads it (`usable`), whatever is in the file."""
        return usable(self.raw_control(), self.clock())

    def ask_ids(self) -> set | None:
        """The asks the snapshot lists now (waiting and answered), whose control entries are
        kept; None when there's no snapshot to go by, or it hasn't read the Inbox yet (`asks` null:
        issue #92). The sample's: every state's that lists asks."""
        if self.sample:
            from . import sample
            snaps = [sample.build(name, base=self.started) for name in sample.STATES]
        else:
            try:
                snaps = [json.loads(self.snapshot_path.read_bytes())]
            except (OSError, ValueError):
                return None
        # A snapshot whose `asks` is null hasn't read the Inbox yet (issue #92): it lists nothing
        # to go by, so it drops nothing. The sample goes by the states that list asks.
        snaps = [s for s in snaps if not isinstance(s, dict) or s.get("asks") is not None]
        if not snaps:
            return None
        try:
            return {a["id"] for s in snaps for a in (s.get("asks") or []) + (s.get("answered") or [])}
        except (AttributeError, KeyError, TypeError):   # not the snapshot's shape: drop nothing
            return None

    def write_control(self, body: object) -> dict:
        with self.lock:
            new = apply_control(self.raw_control(), body, self.clock(), asks=self.ask_ids())
            self.state_dir.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.state_dir, prefix="control.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(new, f, indent=1)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.control_path)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
            return new


REAL_HOST = "queue.localhost"            # the runner's own snapshot and controls
SAMPLE_HOSTS = ("localhost", "127.0.0.1")  # sample data, for judging the page


def addresses(port: int) -> dict[str, bool]:
    """Each address the dashboard answers on, and whether it's sample data. `queue.localhost`
    with no port is the runner's page at http://queue.localhost/: ~/Code/tools/localhost-proxy
    holds port 80 and passes the browser's Host on as it was sent (Stefan, 2026-11-16)."""
    return {REAL_HOST: False, f"{REAL_HOST}:{port}": False,
            **{f"{h}:{port}": True for h in SAMPLE_HOSTS}}


def make_handler(real: App, sample: App, port: int):
    apps = {host: sample if is_sample else real for host, is_sample in addresses(port).items()}

    class Handler(BaseHTTPRequestHandler):
        server_version = "QueueRunnerDashboard"

        def log_message(self, *args):   # pythonw has no console
            pass

        def send(self, status: int, body: bytes, kind: str = "application/json"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def refuse(self, status: int, why: str):
            self.send(status, json.dumps({"error": why}).encode())

        def app(self) -> App | None:
            # Only this PC's own addresses, and the Host picks the data: a web page elsewhere
            # can't reach the runner's controls by pointing a name at 127.0.0.1.
            app = apps.get(self.headers.get("Host"))
            if app is None:
                self.refuse(403, f"this page is served on {', '.join(apps)} only")
            return app

        def do_GET(self):
            if not (app := self.app()):
                return
            url = urlsplit(self.path)
            if url.path in ("/", "/index.html"):
                self.send(200, (HERE / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif url.path == "/snapshot.json":
                state = (parse_qs(url.query).get("sample") or [None])[0]
                self.send(*app.snapshot(state))
            elif url.path == "/control.json":
                self.send(200, json.dumps(app.control()).encode())
            elif app.sample and (take := re.fullmatch(r"/earlier/(take-\d+\.html)", url.path)) and (EARLIER / take[1]).is_file():
                self.send(200, (EARLIER / take[1]).read_bytes(), "text/html; charset=utf-8")
            else:
                self.refuse(404, "no such page")

        def do_POST(self):
            if not (app := self.app()):
                return
            if self.headers.get("Origin") != f"http://{self.headers.get('Host')}":
                return self.refuse(403, "controls are written from this page only")
            if urlsplit(self.path).path != "/control":
                return self.refuse(404, "no such page")
            if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
                return self.refuse(415, "send JSON")
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if not 0 < length <= MAX_BODY:
                return self.refuse(400, "a small JSON body is expected")
            try:
                body = json.loads(self.rfile.read(length))
                new = app.write_control(body)
            except (ValueError, Refused) as e:
                return self.refuse(400, str(e))
            self.send(200, json.dumps(new).encode())

    return Handler


class Server(ThreadingHTTPServer):
    """Binds its port alone. Python's HTTPServer sets SO_REUSEADDR, which on Windows lets a second
    process bind a port already listened on (three dashboards were found on 5289 at once)."""

    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):   # Windows
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(real: App, sample: App, port: int) -> ThreadingHTTPServer:
    server = Server(("127.0.0.1", port), make_handler(real, sample, port))
    if port == 0:   # a test's free port: the handler checks Host against the real one
        server.RequestHandlerClass = make_handler(real, sample, server.server_address[1])
    return server


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python3 -m dashboard", description="The queue runner's dashboard: "
                                f"the runner's own on {REAL_HOST}, sample data on localhost and 127.0.0.1.")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--state-dir", default=DEFAULT_STATE_DIR, help="where the runner writes snapshot.json")
    args = p.parse_args(argv)

    with tempfile.TemporaryDirectory(prefix="queue-runner-dashboard-") as sample_dir:   # the sample's controls
        real = App(Path(args.state_dir).expanduser())
        sample = App(Path(sample_dir), sample=True)
        try:
            server = serve(real, sample, args.port)
        except OSError as e:
            print(f"A dashboard is already running on port {args.port} ({e}). Stop it first, or use --port.", flush=True)
            return 3
        print(f"Queue runner dashboard: http://{REAL_HOST}/ (through the localhost proxy) and "
              f"http://{REAL_HOST}:{args.port}/ are the runner's ({real.state_dir}); "
              f"http://localhost:{args.port}/ and http://127.0.0.1:{args.port}/ are sample data.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    return 0
