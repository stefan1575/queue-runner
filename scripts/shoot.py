"""Screenshots of the dashboard's sample states, or of a state folder, as a PR's evidence.

    python3 scripts/shoot.py --out DIR STATE[/PAGE] ...               # after: the code in this checkout
    python3 scripts/shoot.py --commit REF --out DIR STATE[/PAGE] ...  # before: the page as it was at REF
    python3 scripts/shoot.py [--commit REF] --state-dir SDIR --out DIR NAME[/PAGE] ...

Each shot is `?sample=STATE&page=PAGE` (PAGE defaults to the Overview). With `--state-dir`, the
dashboard serves SDIR instead and the shot is the runner's own address,
`http://queue.localhost:<port>/?page=PAGE` (`localhost:<port>` only ever serves sample data,
issue #136); NAME then only names the file. Each is saved as
`DIR/LABEL-STATE-PAGE.png`: LABEL is `before` with `--commit` and `after` without (`--label`
names it), so a before and an after into the same DIR never overwrite each other. The dashboard runs from the checkout, or from a throwaway worktree at REF,
on a free port of its own, so the one already running on 5289 (possibly older code) doesn't
matter. Shooting and publishing are `scripts/evidence.py`; the rule for when a PR
needs screenshots is `templates/build.md`, Screenshots, and this repo's part is `docs/dashboard.md`,
Screenshots.
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_up(url: str, seconds: float = 20) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except OSError:
            time.sleep(0.3)
    sys.exit(f"shoot: the dashboard didn't answer on {url}")


def shot_name(label: str, shot: str) -> str:
    st, _, page = shot.partition("/")
    return f"{label}-{st}-{page or 'overview'}.png"


def label(a: argparse.Namespace) -> str:
    return a.label or ("before" if a.commit else "after")


def load_evidence():
    """`scripts/evidence.py` beside this script, which does the shooting."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import evidence
    return evidence


def shot_url(port: int, shot: str, real: bool) -> str:
    """A sample state on `localhost`, or with `real` the state folder on `queue.localhost`: the
    request's Host is what picks the data (`docs/dashboard.md`, One process)."""
    st, _, page = shot.partition("/")
    if real:
        return f"http://queue.localhost:{port}/" + (f"?page={page}" if page else "")
    return f"http://localhost:{port}/?sample={st}" + (f"&page={page}" if page else "")


def shoot_from(src: Path, shots: list[str], out: Path, size: str, label: str,
               state_dir: Path | None = None) -> list[Path]:
    evidence = load_evidence()
    port = free_port()
    with tempfile.TemporaryDirectory() as tmp:
        state = str(state_dir.resolve()) if state_dir else tmp
        server = subprocess.Popen([sys.executable, "-m", "dashboard", "--port", str(port), "--state-dir", state],
                                  cwd=src, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            # urllib may not resolve *.localhost; any address answers once the server is up
            wait_up(f"http://127.0.0.1:{port}/")
            made = []
            for shot in shots:
                f = out / shot_name(label, shot)
                evidence.shoot(shot_url(port, shot, state_dir is not None), f, size)
                made.append(f)
            return made
        finally:
            server.terminate()
            server.wait(10)


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="shoot")
    ap.add_argument("--commit")
    ap.add_argument("--label", choices=("before", "after"),
                    help="the file names' prefix (default: before with --commit, else after)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--size", default="1440x900")
    ap.add_argument("--state-dir", type=Path,
                    help="a state folder to shoot on the runner's address instead of sample states")
    ap.add_argument("shots", nargs="+",
                    help="STATE or STATE/PAGE, e.g. reconnecting/usage; with --state-dir, NAME/PAGE")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    a = parse(argv)
    if not a.commit:
        made = shoot_from(REPO, a.shots, a.out, a.size, label(a), a.state_dir)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            wt = Path(tmp) / "wt"
            subprocess.run(["git", "-C", str(REPO), "worktree", "add", "--detach", "--quiet", str(wt), a.commit], check=True)
            try:
                made = shoot_from(wt, a.shots, a.out, a.size, label(a), a.state_dir)
            finally:
                subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force", str(wt)], check=False)
    print("\n".join(str(f) for f in made))


if __name__ == "__main__":
    main()
