"""A repo's favicon, for its mark on the dashboard (Stefan, 2026-11-16: "the repository favicon
should be included if applicable. Otherwise, just the first two letters").

Found the way T3 Code finds a project's (its `ProjectFaviconResolver`, read from T3 Code's
server bundle on 2026-11-16): the well-known paths below in order, then a `<link rel="icon">` (or
a `rel: "icon"` object) in the source files below, its href looked up under `public/` and then
the repo's root. T3's macOS `.icns` candidates are left out: a browser can't draw one.

The snapshot carries it as a data: URL (`repo_icon`), so the dashboard stays a page that reads
one file. One over `MAX_BYTES` is left out (the page draws the letters), so a large icon never
bloats the snapshot written every 30 seconds. Each repo's answer is kept 10 minutes, a miss 1
minute, as T3 keeps them.
"""

import base64
import os
import re
import threading
import time

CANDIDATES = (
    'favicon.svg', 'favicon.ico', 'favicon.png',
    'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png',
    'app/favicon.ico', 'app/favicon.png', 'app/icon.svg', 'app/icon.png', 'app/icon.ico',
    'src/favicon.ico', 'src/favicon.svg', 'src/app/favicon.ico', 'src/app/icon.svg', 'src/app/icon.png',
    'assets/icon.svg', 'assets/icon.png', 'assets/logo.svg', 'assets/logo.png',
    '.idea/icon.svg',
)
SOURCES = ('index.html', 'public/index.html', 'app/routes/__root.tsx', 'src/routes/__root.tsx',
           'app/root.tsx', 'src/root.tsx', 'src/index.html')
TYPES = {'.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
         '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
MAX_BYTES = 64 * 1024
FOUND_FOR, MISSED_FOR = 600.0, 60.0   # seconds an answer is kept

_LINK_HTML = re.compile(r'''<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>''', re.I)
_REL = re.compile(r'''\brel\s*:\s*["'](?:icon|shortcut icon)["']''', re.I)
_HREF = re.compile(r'''\bhref\s*:\s*["']([^"'?]+)''', re.I)

_kept: dict[str, tuple[float, str | None]] = {}
_lock = threading.Lock()


def repo_icon(path: str, clock=time.monotonic) -> str | None:
    """The repo's favicon as a data: URL, or None (none found, unreadable, a type a browser
    can't draw, or over `MAX_BYTES`). Never raises."""
    root = os.path.realpath(os.path.expanduser(path))
    now = clock()
    with _lock:
        kept = _kept.get(root)
        if kept and now < kept[0]:
            return kept[1]
    try:
        icon = _data_url(_find(root))
    except Exception:
        icon = None
    with _lock:
        _kept[root] = (now + (FOUND_FOR if icon else MISSED_FOR), icon)
    return icon


def _find(root: str) -> str | None:
    if not os.path.isdir(root):
        return None
    for rel in CANDIDATES:
        if (found := _inside(root, rel)):
            return found
    for rel in SOURCES:
        source = _inside(root, rel)
        if not source:
            continue
        with open(source, encoding='utf-8', errors='replace') as f:
            href = _href(f.read())
        if href and not re.match(r'^[a-z][a-z0-9+.-]*:|^//', href, re.I):   # a local file only
            clean = href.lstrip('/')
            for rel in (os.path.join('public', clean), clean):
                if (found := _inside(root, rel)):
                    return found
    return None


def _href(source: str) -> str | None:
    if (m := _LINK_HTML.search(source)):
        return m.group(1)
    for run in source.split('}'):
        if _REL.search(run) and (m := _HREF.search(run)):
            return m.group(1)
    return None


def _inside(root: str, rel: str) -> str | None:
    """`rel` under `root` when it's a file there; never a path that leads out of the repo, by
    `..` or through a link (a symlink or a Windows junction, at any step): the path is resolved
    before it's compared with the resolved root (Sol's review 1 of PR #103, F1)."""
    path = os.path.realpath(os.path.join(root, rel))
    try:
        inside = os.path.commonpath([os.path.normcase(root), os.path.normcase(path)]) == os.path.normcase(root)
    except ValueError:   # another drive
        return None
    if not inside or not os.path.isfile(path):
        return None
    return path


def _data_url(path: str | None) -> str | None:
    if path is None:
        return None
    kind = TYPES.get(os.path.splitext(path)[1].lower())
    if kind is None or os.path.getsize(path) > MAX_BYTES:
        return None
    with open(path, 'rb') as f:
        return f'data:{kind};base64,{base64.b64encode(f.read()).decode("ascii")}'
