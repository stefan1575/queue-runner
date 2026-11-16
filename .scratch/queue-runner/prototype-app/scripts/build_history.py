"""Build the earlier prototype rounds from git into public/history/, so the dev server serves them
next to the current one (the sidebar's "Earlier rounds" links). Run from prototype-app:

    python3 scripts/build_history.py

Each round is exported with `git archive`, shares this folder's node_modules (same dependencies),
gets its tiny router taught the /history/rN/ base, and is built with Vite. public/history/ is
gitignored: rebuild it rather than commit it. Round 0 is the single-file HTML prototype.
"""
import io
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
REPO = APP.parents[2]
OUT = APP / "public" / "history"
REL = ".scratch/queue-runner/prototype-app"

ROUNDS = [("r1", "69fd88b"), ("r2", "9206e6c"), ("r3", "78fc98b")]

ROUTER_FROM = (
    "  const url = new URL(s, location.origin);\n  return { path: url.pathname, params: url.searchParams };",
    "  const next = new URL(path ?? cur.pathname, location.origin);",
)
ROUTER_TO = (
    "  const url = new URL(s, location.origin);\n"
    "  const B = import.meta.env.BASE_URL;\n"
    "  return { path: '/' + url.pathname.slice(B.length).replace(/index\\.html$/, ''), params: url.searchParams };",
    "  const next = new URL(path !== null ? import.meta.env.BASE_URL + path.replace(/^\\//, '') : cur.pathname, location.origin);",
)


def build(name: str, commit: str) -> None:
    work = Path(tempfile.mkdtemp(prefix=f"proto-{name}-"))
    tar = subprocess.run(["git", "-C", str(REPO), "archive", commit, REL], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        t.extractall(work, filter="data")
    src = work / REL
    router = src / "src" / "lib" / "router.ts"
    text = router.read_text(encoding="utf-8")
    for a, b in zip(ROUTER_FROM, ROUTER_TO):
        if a not in text:
            sys.exit(f"{name}: router line not found, can't set its base")
        text = text.replace(a, b)
    router.write_text(text, encoding="utf-8")
    subprocess.run(["cmd", "/c", "mklink", "/J", str(src / "node_modules"), str(APP / "node_modules")], check=True, capture_output=True)
    try:
        subprocess.run(
            ["cmd", "/c", "npx", "vite", "build", f"--base=/history/{name}/", "--outDir", str(OUT / name), "--emptyOutDir", "--logLevel", "warn"],
            cwd=src, check=True,
        )
    finally:
        (src / "node_modules").rmdir()  # the junction only, never what it points to
        shutil.rmtree(work, ignore_errors=True)
    print(f"{name}: {commit} -> /history/{name}/index.html")


def round0() -> None:
    d = OUT / "r0"
    d.mkdir(parents=True, exist_ok=True)
    for f in ("index.html", "app.html"):
        shutil.copy(APP.parent / "prototype-dashboard" / f, d / f)
    print("r0: prototype-dashboard -> /history/r0/index.html, /history/r0/app.html")


if __name__ == "__main__":
    round0()
    for n, c in ROUNDS:
        build(n, c)
