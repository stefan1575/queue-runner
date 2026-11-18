"""Screenshots of the dashboard's sample states, or of a state folder, as a PR's evidence.

    python3 scripts/shoot.py --out DIR STATE[/PAGE] ...               # after: the code in this checkout
    python3 scripts/shoot.py --commit REF --out DIR STATE[/PAGE] ...  # before: the page as it was at REF
    python3 scripts/shoot.py [--commit REF] --state-dir SDIR --out DIR NAME[/PAGE] ...

Each shot is `?sample=STATE&page=PAGE` (PAGE defaults to the Overview), in a window wider than
the page's breakpoints that hide the rail (`--size WxH` overrides). With `--state-dir`, the
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
import re
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


# A shot is wider than every breakpoint that hides the rail on its page (PR #147 review 1, F1:
# 1440x900 was under the 1480px one, so a rail change's 12 shots showed no rail). The widths are
# read from the page being shot, so a moved breakpoint moves the window, and a before shot is
# sized from its own commit's page.
MEDIA = re.compile(r"^@media \(max-width: (\d+)px\) \{\n(.*?)^\}", re.S | re.M)
HIDES = re.compile(r"^\s*([^{}\n]*?)\s*\{\s*display:\s*none;\s*\}", re.M)
RAIL = re.compile(r"(?:body\.page-([\w-]+) )?\.rail")
MARGIN, HEIGHT, LEAST = 120, 900, 1440


def rail_breakpoints(css: str) -> list[tuple[int, str | None]]:
    """Each max-width that hides `.rail`, with the one page it's scoped to (None: every page)."""
    out = []
    for m in MEDIA.finditer(css):
        for sel in HIDES.findall(m.group(2)):
            for one in sel.split(","):
                r = RAIL.fullmatch(one.strip())
                if r:
                    out.append((int(m.group(1)), r.group(1)))
    return out


def rail_width(css: str, page: str) -> int:
    page = page or "overview"
    widest = max([px for px, only in rail_breakpoints(css) if only in (None, page)], default=0)
    return max(LEAST, widest + MARGIN)


def shot_size(css: str, shot: str, size: str | None) -> str:
    """`--size` when named, else a window that shows the rail on the shot's page."""
    return size or f"{rail_width(css, shot.partition('/')[2])}x{HEIGHT}"


def shoot_from(src: Path, shots: list[str], out: Path, size: str | None, label: str,
               state_dir: Path | None = None) -> list[Path]:
    evidence = load_evidence()
    page = src / "dashboard" / "index.html"   # absent only in a test's faked worktree
    css = page.read_text(encoding="utf-8") if page.exists() else ""
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
                evidence.shoot(shot_url(port, shot, state_dir is not None), f, shot_size(css, shot, size))
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
    ap.add_argument("--size", help="WxH; by default wide enough to show the rail on the shot's page")
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
