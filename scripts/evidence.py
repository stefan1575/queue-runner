"""Screenshots as proof on a PR or issue, without a model ever looking at them.

    python3 -I evidence.py shoot URL OUT.png [--size 1440x900]
    python3 -I evidence.py screen OUT.png
    python3 -I evidence.py publish --repo DIR --into pr-113 FILE.png [FILE.png ...]

`shoot` renders a page in headless Edge. `screen` captures the whole desktop (a Windows app such
as game-backdrop; it fails while the PC is locked). `publish` commits the files to the repo's
`evidence` branch on origin, never touching the working tree or the checked-out branch, and
prints one Markdown image line per file, pinned to that commit, for a PR body or comment.

Standard library only. Build jobs use it as `templates/build.md` says.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

EDGE = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe"
BRANCH = "evidence"


def shoot(url: str, out: Path, size: str) -> None:
    w, h = size.lower().split("x")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            [str(EDGE), "--headless=new", f"--user-data-dir={profile}", "--hide-scrollbars",
             "--force-device-scale-factor=1", f"--window-size={w},{h}",
             "--virtual-time-budget=5000", f"--screenshot={out.resolve()}", url],
            check=True, capture_output=True, timeout=60)
    if not out.exists() or out.stat().st_size < 2000:
        sys.exit(f"evidence: {out} came out empty; is {url} up?")


SCREEN_PS = r"""
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
"""


def screen(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                        "& {" + SCREEN_PS + "}", str(out.resolve())], capture_output=True, text=True)
    if r.returncode or not out.exists():
        sys.exit("evidence: the desktop can't be captured (locked, or no one signed in): "
                 "mark the PR 'screenshot owed'.\n" + r.stderr)


def git(repo: Path, *args: str, env: dict | None = None, check: bool = True) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                       env={**os.environ, **(env or {})})
    if check and r.returncode:
        sys.exit(f"evidence: git {' '.join(args)} failed:\n{r.stderr}")
    return r.stdout.strip()


def owner_repo(repo: Path) -> str:
    url = git(repo, "remote", "get-url", "origin")
    m = re.search(r"github\.com[:/](.+?)(?:\.git)?$", url)
    if not m:
        sys.exit(f"evidence: origin isn't on GitHub: {url}")
    return m.group(1)


def image_lines(slug: str, commit: str, paths: list[str]) -> list[str]:
    return [f"![{Path(p).stem}](https://github.com/{slug}/blob/{commit}/{p}?raw=true)" for p in paths]


def publish(repo: Path, into: str, files: list[Path]) -> list[str]:
    into = into.strip("/")
    paths = [f"{into}/{f.name}" for f in files]
    for attempt in range(4):
        has_remote = git(repo, "fetch", "--quiet", "origin", f"+refs/heads/{BRANCH}:refs/evidence/remote",
                         check=False) == "" and git(repo, "rev-parse", "--verify", "--quiet",
                                                    "refs/evidence/remote", check=False)
        with tempfile.TemporaryDirectory() as tmp:
            env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
            if has_remote:
                git(repo, "read-tree", "refs/evidence/remote", env=env)
            for f, p in zip(files, paths):
                blob = git(repo, "hash-object", "-w", str(f.resolve()))
                git(repo, "update-index", "--add", "--cacheinfo", f"100644,{blob},{p}", env=env)
            tree = git(repo, "write-tree", env=env)
        parent = ["-p", "refs/evidence/remote"] if has_remote else []
        commit = git(repo, "commit-tree", tree, *parent, "-m", f"Evidence for {into}")
        if subprocess.run(["git", "-C", str(repo), "push", "--quiet", "origin",
                           f"{commit}:refs/heads/{BRANCH}"], capture_output=True).returncode == 0:
            return image_lines(owner_repo(repo), commit, paths)
        time.sleep(2 + attempt * 3)  # another job pushed evidence first: rebuild on top of it
    sys.exit("evidence: couldn't push to the evidence branch after 4 tries")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="evidence")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("shoot")
    s.add_argument("url")
    s.add_argument("out", type=Path)
    s.add_argument("--size", default="1440x900")
    c = sub.add_parser("screen")
    c.add_argument("out", type=Path)
    p = sub.add_parser("publish")
    p.add_argument("--repo", type=Path, default=Path("."))
    p.add_argument("--into", required=True, help="folder on the evidence branch, e.g. pr-113 or issue-40")
    p.add_argument("files", type=Path, nargs="+")
    a = ap.parse_args(argv)
    if a.cmd == "shoot":
        shoot(a.url, a.out, a.size)
    elif a.cmd == "screen":
        screen(a.out)
    else:
        print("\n".join(publish(a.repo, a.into, a.files)))


if __name__ == "__main__":
    main()
