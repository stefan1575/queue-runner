"""Screenshots of the dashboard's sample states, as a PR's evidence.

    python3 scripts/shoot.py --out DIR STATE[/PAGE] ...               # the code in this checkout
    python3 scripts/shoot.py --commit REF --out DIR STATE[/PAGE] ...  # the page as it was at REF

Each shot is `?sample=STATE&page=PAGE` (PAGE defaults to the Overview), saved as
`DIR/STATE-PAGE.png`. The dashboard runs from the checkout, or from a throwaway worktree at REF,
on a free port of its own, so the one already running on 5289 (possibly older code) doesn't
matter. Shooting and publishing are `~/Code/tools/evidence/evidence.py`; the rule for when a PR
needs screenshots is `~/Code/docs/evidence.md`, and this repo's part is `docs/dashboard.md`,
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
sys.path.insert(0, str(Path.home() / "Code" / "tools" / "evidence"))
import evidence  # noqa: E402


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


def shoot_from(src: Path, shots: list[str], out: Path, size: str) -> list[Path]:
    port = free_port()
    with tempfile.TemporaryDirectory() as state:
        server = subprocess.Popen([sys.executable, "-m", "dashboard", "--port", str(port), "--state-dir", state],
                                  cwd=src, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            base = f"http://localhost:{port}/"
            wait_up(base)
            made = []
            for shot in shots:
                st, _, page = shot.partition("/")
                f = out / f"{st}-{page or 'overview'}.png"
                evidence.shoot(f"{base}?sample={st}" + (f"&page={page}" if page else ""), f, size)
                made.append(f)
            return made
        finally:
            server.terminate()
            server.wait(10)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="shoot")
    ap.add_argument("--commit")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--size", default="1440x900")
    ap.add_argument("shots", nargs="+", help="STATE or STATE/PAGE, e.g. reconnecting/usage")
    a = ap.parse_args(argv)
    if not a.commit:
        made = shoot_from(REPO, a.shots, a.out, a.size)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            wt = Path(tmp) / "wt"
            subprocess.run(["git", "-C", str(REPO), "worktree", "add", "--detach", "--quiet", str(wt), a.commit], check=True)
            try:
                made = shoot_from(wt, a.shots, a.out, a.size)
            finally:
                subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force", str(wt)], check=False)
    print("\n".join(str(f) for f in made))


if __name__ == "__main__":
    main()
