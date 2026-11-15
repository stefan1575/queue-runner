"""The dashboard's server: one page, the runner's snapshot, and the control file.

Standard library only. It imports nothing from the runner and calls neither T3 nor GitHub, so
neither can break it, and it can say truthfully that the runner has stopped writing.

    python3 -m dashboard             # the runner's own snapshot, in ~/.queue-runner/state
    python3 -m dashboard --sample    # sample data, no runner needed

The contract is two files in the state folder:

- `snapshot.json`: the runner writes it whole, the page only reads it. `dashboard/sample.py`
  builds one in every state the page has to show.
- `control.json`: what Stefan asked for from the page (stop a lane, the order repos are built
  in). The page writes it whole, the runner reads it and says in the snapshot's
  `control_read_at` which write it has acted on.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
EARLIER = HERE / "earlier"   # takes of the page before this one, served with sample data only
DEFAULT_STATE_DIR = "~/.queue-runner/state"   # config.toml's state_dir; --state-dir for another
DEFAULT_PORT = 5289
MAX_BODY = 16_384

NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
STOPS = (None, "after-job", "now")


class Refused(Exception):
    """A control request the page shouldn't have sent."""


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def apply_control(control: dict, body: object, now: str) -> dict:
    """The control file after one request: `{"lane", "stop"}` or `{"repo_order"}`."""
    if not isinstance(body, dict):
        raise Refused("a JSON object is expected")
    lanes = {k: v for k, v in (control.get("lanes") or {}).items() if isinstance(v, dict)}
    order = [r for r in (control.get("repo_order") or []) if isinstance(r, str)]
    keys = set(body)
    if keys == {"lane", "stop"}:
        lane, stop = body["lane"], body["stop"]
        if not isinstance(lane, str) or not NAME.match(lane):
            raise Refused("lane must be a lane's id")
        if stop not in STOPS:
            raise Refused('stop must be "after-job", "now" or null')
        lanes[lane] = {"stop": stop, "at": now}
    elif keys == {"repo_order"}:
        order = body["repo_order"]
        if (not isinstance(order, list) or not 1 <= len(order) <= 50
                or not all(isinstance(r, str) and NAME.match(r) for r in order)
                or len(set(order)) != len(order)):
            raise Refused("repo_order must list each repo's name once")
    else:
        raise Refused('send {"lane", "stop"} or {"repo_order"}')
    return {"version": 1, "written_at": now, "lanes": lanes, "repo_order": order}


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
            json.loads(raw)
        except FileNotFoundError:
            return 404, json.dumps({"error": "missing", "path": str(self.snapshot_path)}).encode()
        except (OSError, ValueError) as e:
            # The runner writes the file whole, so this is a real fault, not a torn read.
            return 500, json.dumps({"error": "unreadable", "path": str(self.snapshot_path), "detail": str(e)}).encode()
        return 200, raw

    def control(self) -> dict:
        try:
            data = json.loads(self.control_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"version": 1, "lanes": {}, "repo_order": []}
        return data if isinstance(data, dict) else {"version": 1, "lanes": {}, "repo_order": []}

    def write_control(self, body: object) -> dict:
        with self.lock:
            new = apply_control(self.control(), body, self.clock())
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


def make_handler(app: App, port: int):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

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

        def local(self) -> bool:
            # Only this PC's own address: a web page elsewhere can't reach the runner's controls
            # by pointing a name at 127.0.0.1.
            if self.headers.get("Host") not in hosts:
                self.refuse(403, "this page is served on 127.0.0.1 only")
                return False
            return True

        def do_GET(self):
            if not self.local():
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
            if not self.local():
                return
            origin = self.headers.get("Origin")
            if origin is not None and origin not in {f"http://{h}" for h in hosts}:
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


def serve(app: App, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app, port))
    if port == 0:   # a test's free port: the handler checks Host against the real one
        server.RequestHandlerClass = make_handler(app, server.server_address[1])
    return server


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python3 -m dashboard", description="The queue runner's dashboard.")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--state-dir", default=DEFAULT_STATE_DIR, help="where the runner writes snapshot.json")
    p.add_argument("--sample", action="store_true", help="serve sample data; controls go to a temp folder")
    args = p.parse_args(argv)

    state_dir = Path(tempfile.mkdtemp(prefix="queue-runner-dashboard-")) if args.sample else Path(args.state_dir).expanduser()
    app = App(state_dir, sample=args.sample)
    try:
        server = serve(app, args.port)
    except OSError as e:
        print(f"Port {args.port} is taken ({e}). Another dashboard may be running.")
        return 3
    print(f"Queue runner dashboard: http://127.0.0.1:{args.port}/" + ("  (sample data)" if args.sample else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
