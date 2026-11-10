"""A review checkout's JavaScript dependencies, so Sol can run the repo's tests (ticket 16).

Installing into every checkout would slow every review, so each lockfile is installed once, into
`<deps_dir>/<repo>-<key>/node_modules`, and linked into the checkout as a junction. The key is the
lockfile plus package.json's dependency fields, so a PR that changes neither reuses the cache, and
one that changes them gets its own install, as CI would. bun.lock installs with
`bun install --frozen-lockfile` (leads-dashboard's CI does), package-lock.json with `npm ci`.

**Unlink before git removes a checkout:** `git worktree remove --force` follows a junction and
empties its target (checked 2026-11-10), so `unlink` comes first (`GitCli.remove_checkout`).

Sol runs tests in its sandbox with only `node_modules/.vite-temp` and `.vite` writable in the
cache (vitest writes its bundled config there), so a test can't change the packages. A marker
inside `node_modules` is checked on every use: a cache whose marker is gone is installed again.
"""
import dataclasses
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

HOME = os.path.expanduser('~')
INSTALL_TIMEOUT_S = 15 * 60
KEEP = 3   # caches kept per repo, the most recently used
STALE_S = 4 * INSTALL_TIMEOUT_S   # a temp install folder this old was left by a dead runner
READY = '.queue-runner-ready'   # in node_modules once an install finished
# package.json fields that change what an install puts in node_modules.
DEP_FIELDS = ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
              'overrides', 'resolutions', 'patchedDependencies', 'trustedDependencies',
              'workspaces')
# Files an install reads besides package.json and the lockfile (and `patches/`).
EXTRA = ('.npmrc', 'bunfig.toml')
# Where vite and vitest write inside node_modules: the only part of the cache Sol may write, so a
# test can't change the installed packages that later reviews reuse.
WRITES = ('.vite-temp', '.vite')


def node_dir() -> str | None:
    """fnm's default Node (`~/.claude/docs/node-toolchain.md`), else the node on PATH. The runner
    starts at logon under pythonw, without fnm's per-shell PATH."""
    fnm = os.environ.get('FNM_DIR') or os.path.join(HOME, 'scoop', 'apps', 'fnm', 'current')
    default = os.path.join(fnm, 'aliases', 'default')
    if os.path.isfile(os.path.join(default, 'node.exe')):
        return default
    found = shutil.which('node')
    return os.path.dirname(found) if found else None


def find_bun() -> str | None:
    """bun on PATH, else where bun's own installer puts it (`~/.bun/bin`, as on this PC since
    2026-11-10: scoop's install stalled on its second download), else scoop's shim."""
    for path in (os.path.join(HOME, '.bun', 'bin', 'bun.exe'),
                 os.path.join(HOME, 'scoop', 'shims', 'bun.exe')):
        if os.path.isfile(path):
            return shutil.which('bun') or path
    return shutil.which('bun')


def find_npm() -> str | None:
    d = node_dir()
    npm = os.path.join(d, 'npm.cmd') if d else None
    return npm if npm and os.path.isfile(npm) else shutil.which('npm')


def run_install(cmd: list[str], cwd: str, out_path: str, timeout: float) -> int:
    """Runs an install with no window and Node on PATH; tree-kills it past `timeout` (exit -1)."""
    env = dict(os.environ)
    d = node_dir()
    if d:
        env['PATH'] = d + os.pathsep + env.get('PATH', '')
    no_window = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    with open(out_path, 'w', encoding='utf-8') as f:
        p = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=f, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, creationflags=no_window)
        try:
            return p.wait(timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True,
                           creationflags=no_window)
            p.wait()
            return -1


def _bytes(path: str) -> bytes:
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return b''


def _link(target: str, link: str) -> None:
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(target, link)
    else:
        os.symlink(target, link, target_is_directory=True)


@dataclasses.dataclass(frozen=True)
class Prepared:
    ready: bool               # node_modules is linked into the checkout
    note: str | None = None   # for Sol's brief; None when the repo has no package.json
    how: str = ''             # for the log: installed (with its time) or cached
    writable: tuple = ()      # the cache folders Sol may write in (WRITES)


class Deps:
    def __init__(self, cache_dir: str, *, run=run_install, bun=..., npm=...,
                 timeout_s: int = INSTALL_TIMEOUT_S):
        self.cache_dir, self.run, self.timeout_s = cache_dir, run, timeout_s
        self.bun = find_bun() if bun is ... else bun
        self.npm = find_npm() if npm is ... else npm

    def prepare(self, repo: str, worktree: str) -> Prepared:
        """Links the checkout's dependencies into it, installing them first if no cache has them.
        Never raises: what went wrong is the note."""
        try:
            return self._prepare(repo, worktree)
        except Exception as e:   # a review goes on without them
            return Prepared(False, f"its dependencies couldn't be set up ({type(e).__name__}: "
                                   f'{e})', 'failed')

    def _prepare(self, repo, worktree):
        pkg_path = os.path.join(worktree, 'package.json')
        if not os.path.isfile(pkg_path):
            return Prepared(False)
        if os.path.lexists(os.path.join(worktree, 'node_modules')):
            return Prepared(False, 'the checkout has its own `node_modules`, left as it is',
                            'own')
        if os.path.isfile(os.path.join(worktree, 'bun.lock')):
            lock, cmd = 'bun.lock', [self.bun, 'install', '--frozen-lockfile'] if self.bun else None
            tool = 'bun'
        elif os.path.isfile(os.path.join(worktree, 'package-lock.json')):
            lock, cmd = 'package-lock.json', [self.npm, 'ci', '--no-audit', '--no-fund'] \
                if self.npm else None
            tool = 'npm'
        else:
            return Prepared(False, 'its dependencies aren\'t installed: no lockfile '
                                   '(`bun.lock` or `package-lock.json`) to install from', 'none')
        if cmd is None:
            return Prepared(False, f"its dependencies aren't installed: {tool} isn't on this "
                                   f'machine (`{lock}` needs it)', 'none')
        with open(pkg_path, 'rb') as f:
            pkg = json.loads(f.read().decode('utf-8-sig'))
        with open(os.path.join(worktree, lock), 'rb') as f:
            h = hashlib.sha256(f.read())
        h.update(json.dumps({k: pkg.get(k) for k in DEP_FIELDS}, sort_keys=True).encode())
        for name in EXTRA:   # install settings change what's installed too
            h.update(f'\0{name}\0'.encode() + _bytes(os.path.join(worktree, name)))
        patches = os.path.join(worktree, 'patches')
        for top, dirs, names in sorted(os.walk(patches)):
            dirs.sort()
            for name in sorted(names):
                path = os.path.join(top, name)
                rel = os.path.relpath(path, worktree).replace(os.sep, '/')
                h.update(f'\0{rel}\0'.encode() + _bytes(path))
        key = h.hexdigest()[:12]
        final = os.path.join(self.cache_dir, f'{repo}-{key}')
        modules = os.path.join(final, 'node_modules')
        how = 'cached'
        if not os.path.isfile(os.path.join(modules, READY)):
            started = time.monotonic()
            failed = self._install(worktree, final, lock, cmd)
            if failed:
                return Prepared(False, f"its dependencies aren't installed: the install failed "
                                       f'(`{" ".join(cmd[1:])}` from `{lock}`: {failed})',
                                'failed')
            how = f'installed in {time.monotonic() - started:.0f}s'
        os.utime(final)   # most recently used: kept by the prune
        writable = tuple(os.path.join(modules, w) for w in WRITES)
        for w in writable:
            os.makedirs(w, exist_ok=True)
        _link(modules, os.path.join(worktree, 'node_modules'))
        self._prune(repo)
        return Prepared(True, f'its dependencies are installed in `node_modules` (from `{lock}`, '
                              f'as CI installs them)', f'{how} ({repo}-{key})', writable)

    def _install(self, worktree, final, lock, cmd) -> str | None:
        """Installs into a fresh folder, then moves it into place. The error's tail, or None."""
        os.makedirs(self.cache_dir, exist_ok=True)
        # Its own folder: another install of the same key may be running (live_review.py).
        tmp = tempfile.mkdtemp(prefix=f'{os.path.basename(final)}.tmp-', dir=self.cache_dir)
        for name in ('package.json', lock, *EXTRA):
            src = os.path.join(worktree, name)
            if os.path.isfile(src):
                shutil.copy2(src, tmp)
        if os.path.isdir(os.path.join(worktree, 'patches')):
            shutil.copytree(os.path.join(worktree, 'patches'), os.path.join(tmp, 'patches'))
        log = f'{final}.log'
        code = self.run(cmd, tmp, log, self.timeout_s)
        modules = os.path.join(tmp, 'node_modules')
        if code != 0 or not os.path.isdir(modules):
            shutil.rmtree(tmp, ignore_errors=True)
            try:
                with open(log, encoding='utf-8', errors='replace') as f:
                    tail = ' / '.join(f.read().strip().splitlines()[-3:])
            except OSError:
                tail = ''
            why = 'timed out' if code == -1 else f'exit {code}'
            return f'{why}{": " + tail if tail else ""}'
        with open(os.path.join(modules, READY), 'w', encoding='utf-8') as f:
            f.write(' '.join(cmd[1:]) + '\n')
        if os.path.isfile(os.path.join(final, 'node_modules', READY)):
            # Another runner (live_review.py) published this key meanwhile, and a review may be
            # using it: keep that one.
            shutil.rmtree(tmp, ignore_errors=True)
            return None
        shutil.rmtree(final, ignore_errors=True)   # an emptied cache's leftovers
        os.replace(tmp, final)
        return None

    def _prune(self, repo):
        name = re.compile(re.escape(repo) + r'-[0-9a-f]{12}')
        mine = [os.path.join(self.cache_dir, n) for n in os.listdir(self.cache_dir)
                if name.fullmatch(n)]
        mine.sort(key=os.path.getmtime, reverse=True)
        stale = re.compile(re.escape(repo) + r'-[0-9a-f]{12}\.tmp-.*')
        for n in os.listdir(self.cache_dir):   # an install a dead runner left
            path = os.path.join(self.cache_dir, n)
            if stale.fullmatch(n) and time.time() - os.path.getmtime(path) > STALE_S:
                shutil.rmtree(path, ignore_errors=True)
        for old in mine[KEEP:]:
            shutil.rmtree(old, ignore_errors=True)
            try:
                os.remove(f'{old}.log')
            except OSError:
                pass

    @staticmethod
    def unlink(worktree: str) -> None:
        """Removes the checkout's node_modules link, never what it points to."""
        link = os.path.join(worktree, 'node_modules')
        if os.path.isjunction(link):
            os.rmdir(link)
        elif os.path.islink(link):
            os.unlink(link)
