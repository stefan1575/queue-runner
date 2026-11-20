// A review checkout's JavaScript dependencies, so Sol can run the repo's tests (ticket 16).
//
// Installing into every checkout would slow every review, so each lockfile is installed once, into
// `<deps_dir>/<repo>-<key>/node_modules`, and linked into the checkout as a junction. The key is the
// lockfile plus package.json's dependency fields, so a PR that changes neither reuses the cache, and
// one that changes them gets its own install, as CI would. bun.lock installs with
// `bun install --frozen-lockfile`, package-lock.json with `npm ci`.
//
// **Unlink before git removes a checkout:** `git worktree remove --force` follows a junction and
// empties its target (checked 2026-11-10), so `unlink` comes first (`GitCli.remove_checkout`).
//
// Sol runs tests in its sandbox with only `node_modules/.vite-temp` and `.vite` writable in the
// cache (vitest writes its bundled config there), so a test can't change the packages. A marker
// inside `node_modules` is checked on every use: a cache whose marker is gone is installed again.
//
// Ported from `queue_runner/deps.py` (#221): the same commands, folders, notes and names
// (snake_case, as Python has them), with `tests/test_deps.py` ported case for case in
// `test/deps.test.ts`. The differences are TypeScript's only. `run_install`, `prepare`, `unlink`
// and `run` are async, where Python's lanes block on their own threads. Python's `bun=...` (find
// it) is the option left out, and its `None` is `null`. A caught error's note names Node's error
// (`Error: ENOENT: ...`) where Python names its own (`FileNotFoundError: ...`). `package.json`
// is read by JavaScript's JSON: a number past 2^53 loses digits, a float like `1.0` keys as the
// int 1, and `NaN` doesn't parse. Deleting goes by Python's calls on Windows
// (`src/python-files.ts`).
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, openSync, statSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir, readFile, rename, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { EOL, homedir, constants as os_constants } from 'node:os';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { by_code_point, err_str, format_0f, get, is_dict, json_dumps, splitlines, strip, type_name } from './python.ts';
import { isdir, isfile, lexists, permission_error, read_only, remove_quietly, rmtree } from './python-files.ts';

export const HOME = homedir();
export const INSTALL_TIMEOUT_S = 15 * 60;
export const KEEP = 3;   // caches kept per repo, the most recently used
export const STALE_S = 4 * INSTALL_TIMEOUT_S;   // a temp install folder this old was left by a dead runner
export const READY = '.queue-runner-ready';   // in node_modules once an install finished
// package.json fields that change what an install puts in node_modules.
export const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'overrides', 'resolutions', 'patchedDependencies', 'trustedDependencies',
  'workspaces'] as const;
// Files an install reads besides package.json and the lockfile (and `patches/`).
export const EXTRA = ['.npmrc', 'bunfig.toml'] as const;
// Where vite and vitest write inside node_modules: the only part of the cache Sol may write, so a
// test can't change the installed packages that later reviews reuse.
export const WRITES = ['.vite-temp', '.vite'] as const;

/** One install: `cmd` run in `cwd`, its output written to `out_path`, stopped past `timeout`
 *  seconds. Its exit code, -1 when it timed out. */
export type Run = (cmd: string[], cwd: string, out_path: string, timeout: number) => Promise<number>;

const WIN = process.platform === 'win32';

/** fnm's default Node, else the node on PATH. The runner
 *  starts at logon under pythonw, without fnm's per-shell PATH. */
export function node_dir(): string | null {
  const fnm = process.env.FNM_DIR || join(HOME, 'scoop', 'apps', 'fnm', 'current');
  const dflt = join(fnm, 'aliases', 'default');
  if (isfile_sync(join(dflt, 'node.exe'))) return dflt;
  const found = which('node');
  return found ? dirname(found) : null;
}

/** bun on PATH, else where bun's own installer puts it (`~/.bun/bin`, as on this PC since
 *  2026-11-10: scoop's install stalled on its second download), else scoop's shim. */
export function find_bun(): string | null {
  for (const path of [join(HOME, '.bun', 'bin', 'bun.exe'), join(HOME, 'scoop', 'shims', 'bun.exe')]) {
    if (isfile_sync(path)) return which('bun') || path;
  }
  return which('bun');
}

export function find_npm(): string | null {
  const d = node_dir();
  const npm = d ? join(d, 'npm.cmd') : null;
  return npm && isfile_sync(npm) ? npm : which('npm');
}

/** `os.path.isfile`, for the finders, which run in the constructor as Python's do. */
function isfile_sync(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `shutil.which(cmd)`: the first match on PATH, with PATHEXT's extensions on Windows and the
 *  current folder first there (Windows' `NeedCurrentDirectoryForExePath`), else null. */
function which(cmd: string): string | null {
  const path = process.env.PATH;
  if (!path) return null;
  const dirs = path.split(delimiter);
  let files = [cmd];
  if (WIN) {
    if (process.env.NoDefaultCurrentDirectoryInExePath === undefined) dirs.unshift('.');
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC').split(delimiter)
      .filter((e) => e).map((e) => e.replace(/\.+$/, ''));
    files = pathext.map((ext) => cmd + ext);
    if (pathext.some((ext) => cmd.toUpperCase().endsWith(ext.toUpperCase()))) files.unshift(cmd);
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    const norm = WIN ? dir.split('/').join('\\').toLowerCase() : dir;   // `os.path.normcase`
    if (seen.has(norm)) continue;
    seen.add(norm);
    for (const file of files) {
      const name = pyjoin(dir, file);
      if (access_check(name)) return name;
    }
  }
  return null;
}

/** `os.path.join(a, b)` for a bare name `b`: a separator only where `a` has none. */
function pyjoin(a: string, b: string): string {
  if (!a || a.endsWith(sep) || a.endsWith('/') || (WIN && /^[A-Za-z]:$/.test(a))) return a + b;
  return a + sep + b;
}

/** `shutil._access_check`: there, runnable (on Windows, there is enough), and not a folder. */
function access_check(name: string): boolean {
  try {
    accessSync(name, WIN ? constants.F_OK : constants.X_OK);
    return !statSync(name).isDirectory();
  } catch {
    return false;
  }
}

/** Runs an install with no window and Node on PATH; tree-kills it past `timeout` (exit -1). */
export const run_install: Run = async (cmd, cwd, out_path, timeout) => {
  // `dict(os.environ)`: Windows' Python holds every name upper case, so PATH is one entry.
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) env[WIN ? k.toUpperCase() : k] = v;
  const d = node_dir();
  if (d) env.PATH = d + delimiter + (env.PATH ?? '');
  const f = openSync(out_path, 'w');
  try {
    return await new Promise<number>((resolve, reject) => {
      // CreateProcess runs a .cmd or .bat through cmd.exe, which Node's spawn won't do by itself.
      const batch = WIN && /\.(cmd|bat)$/i.test(cmd[0]!);
      const p = batch
        ? spawn(env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${list2cmdline(cmd)}"`],
          { cwd, env, stdio: ['ignore', f, f], windowsHide: true, windowsVerbatimArguments: true })
        : spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ['ignore', f, f], windowsHide: true });
      let timed_out = false;
      const timer = setTimeout(() => {
        timed_out = true;
        const kill = spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true });
        kill.on('error', reject);   // no taskkill: Python's subprocess.run raises
      }, timeout * 1000);
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timed_out) return resolve(-1);
        resolve(code ?? -(signal ? os_constants.signals[signal] : 0));   // Popen's -N for a signal N
      });
    });
  } finally {
    closeSync(f);
  }
};

/** `subprocess.list2cmdline`: the command line Windows' CreateProcess gets from Python's list. */
function list2cmdline(seq: string[]): string {
  const result: string[] = [];
  for (const arg of seq) {
    let bs: string[] = [];
    if (result.length) result.push(' ');
    const needquote = /[ \t]/.test(arg) || !arg;
    if (needquote) result.push('"');
    for (const c of arg) {
      if (c === '\\') {
        bs.push(c);
      } else if (c === '"') {
        result.push('\\'.repeat(bs.length * 2), '\\"');
        bs = [];
      } else {
        if (bs.length) {
          result.push(...bs);
          bs = [];
        }
        result.push(c);
      }
    }
    if (bs.length) result.push(...bs);
    if (needquote) {
      result.push(...bs);
      result.push('"');
    }
  }
  return result.join('');
}

/** `_bytes`: a file's bytes, or none when it can't be read. */
const _bytes = (path: string): Promise<Buffer> => readFile(path).catch(() => Buffer.alloc(0));

async function _link(target: string, link: string): Promise<void> {
  await symlink(target, link, 'junction');   // `_winapi.CreateJunction`; a folder symlink elsewhere
}

/** `sorted(os.walk(top))`: each folder with its files, in code-point order of the folders'
 *  paths. A link to a folder counts as a folder and isn't walked into (a checkout from git holds
 *  symlinks, never junctions, which Python would walk into). */
async function _walk(top: string): Promise<[string, string[]][]> {
  const entries = await readdir(top, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const dirs: string[] = [], names: string[] = [];
  for (const e of entries) {
    const is_dir = e.isDirectory() || (e.isSymbolicLink() && await isdir(join(top, e.name)));
    (is_dir ? dirs : names).push(e.name);
  }
  const found: [string, string[]][] = [[top, names]];
  for (const d of dirs) {
    const path = join(top, d);
    if (!(await lstat(path).then((s) => s.isSymbolicLink(), () => false))) found.push(...await _walk(path));
  }
  return found.sort(([a], [b]) => by_code_point(a, b));
}

/** `shutil.copy2(src, folder)`: the file's bytes and its times. */
async function copy2(src: string, folder: string): Promise<void> {
  const dst = join(folder, basename(src));
  await copyFile(src, dst);
  const st = await stat(src);
  await utimes(dst, st.atime, st.mtime);
}

/** The checkout's dependencies, as `prepare` left them. */
export class Prepared {
  readonly ready: boolean;                // node_modules is linked into the checkout
  readonly note: string | null;           // for Sol's brief; null when the repo has no package.json
  readonly how: string;                   // for the log: installed (with its time) or cached
  readonly writable: readonly string[];   // the cache folders Sol may write in (WRITES)
  constructor(ready: boolean, note: string | null = null, how = '', writable: readonly string[] = []) {
    this.ready = ready;
    this.note = note;
    this.how = how;
    this.writable = Object.freeze([...writable]);
    Object.freeze(this);
  }
}

class AttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributeError';
  }
}

/** Python's type name of a JSON value, for its errors. */
const py_type = (x: unknown) => (x === null ? 'NoneType' : Array.isArray(x) ? 'list' : typeof x === 'string' ? 'str'
  : typeof x === 'boolean' ? 'bool' : Number.isInteger(x) ? 'int' : 'float');

export class Deps {
  cache_dir: string;
  run: Run;
  timeout_s: number;
  bun: string | null;   // null when it isn't on this machine
  npm: string | null;

  constructor(cache_dir: string, { run = run_install, bun, npm, timeout_s = INSTALL_TIMEOUT_S }:
    { run?: Run; bun?: string | null; npm?: string | null; timeout_s?: number } = {}) {
    this.cache_dir = cache_dir;
    this.run = run;
    this.timeout_s = timeout_s;
    this.bun = bun === undefined ? find_bun() : bun;   // left out: found, as Python's `bun=...`
    this.npm = npm === undefined ? find_npm() : npm;
  }

  /** Links the checkout's dependencies into it, installing them first if no cache has them.
   *  Never throws: what went wrong is the note. */
  async prepare(repo: string, worktree: string): Promise<Prepared> {
    try {
      return await this._prepare(repo, worktree);
    } catch (e) {   // a review goes on without them
      return new Prepared(false, `its dependencies couldn't be set up (${type_name(e)}: ${err_str(e)})`, 'failed');
    }
  }

  private async _prepare(repo: string, worktree: string): Promise<Prepared> {
    const pkg_path = join(worktree, 'package.json');
    if (!(await isfile(pkg_path))) return new Prepared(false);
    if (await lexists(join(worktree, 'node_modules'))) {
      return new Prepared(false, 'the checkout has its own `node_modules`, left as it is', 'own');
    }
    let lock: string, cmd: string[] | null, tool: string;
    if (await isfile(join(worktree, 'bun.lock'))) {
      lock = 'bun.lock';
      cmd = this.bun ? [this.bun, 'install', '--frozen-lockfile'] : null;
      tool = 'bun';
    } else if (await isfile(join(worktree, 'package-lock.json'))) {
      lock = 'package-lock.json';
      cmd = this.npm ? [this.npm, 'ci', '--no-audit', '--no-fund'] : null;
      tool = 'npm';
    } else {
      return new Prepared(false, 'its dependencies aren\'t installed: no lockfile '
        + '(`bun.lock` or `package-lock.json`) to install from', 'none');
    }
    if (cmd === null) {
      return new Prepared(false, `its dependencies aren't installed: ${tool} isn't on this `
        + `machine (\`${lock}\` needs it)`, 'none');
    }
    // `.decode('utf-8-sig')`: strict UTF-8, one leading BOM dropped.
    const pkg = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(pkg_path)));
    if (!is_dict(pkg)) throw new AttributeError(`'${py_type(pkg)}' object has no attribute 'get'`);
    const h = createHash('sha256').update(await readFile(join(worktree, lock)));
    h.update(json_dumps(Object.fromEntries(DEP_FIELDS.map((k) => [k, get(pkg, k)]))));
    for (const name of EXTRA) {   // install settings change what's installed too
      h.update(`\0${name}\0`).update(await _bytes(join(worktree, name)));
    }
    const patches = join(worktree, 'patches');
    for (const [top, names] of await _walk(patches)) {
      for (const name of names.sort(by_code_point)) {
        const path = join(top, name);
        const rel = relative(worktree, path).split(sep).join('/');
        h.update(`\0${rel}\0`).update(await _bytes(path));
      }
    }
    const key = h.digest('hex').slice(0, 12);
    const final = join(this.cache_dir, `${repo}-${key}`);
    const modules = join(final, 'node_modules');
    let how = 'cached';
    if (!(await isfile(join(modules, READY)))) {
      const started = performance.now();
      const failed = await this._install(worktree, final, lock, cmd);
      if (failed) {
        return new Prepared(false, 'its dependencies aren\'t installed: the install failed '
          + `(\`${cmd.slice(1).join(' ')}\` from \`${lock}\`: ${failed})`, 'failed');
      }
      how = `installed in ${format_0f((performance.now() - started) / 1000)}s`;
    }
    const now = new Date();
    await utimes(final, now, now);   // most recently used: kept by the prune
    const writable = WRITES.map((w) => join(modules, w));
    for (const w of writable) await mkdir(w, { recursive: true });
    await _link(modules, join(worktree, 'node_modules'));
    await this._prune(repo);
    return new Prepared(true, `its dependencies are installed in \`node_modules\` (from \`${lock}\`, `
      + 'as CI installs them)', `${how} (${repo}-${key})`, writable);
  }

  /** Installs into a fresh folder, then moves it into place. The error's tail, or null. */
  private async _install(worktree: string, final: string, lock: string, cmd: string[]): Promise<string | null> {
    await mkdir(this.cache_dir, { recursive: true });
    // Its own folder: another install of the same key may be running (live_review.py). Made
    // plainly, not as an owner-only temp folder: it inherits deps_dir's permissions, which
    // the reviewer's sandbox user can read through the junction.
    const tmp = `${final}.tmp-${process.pid}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await mkdir(tmp);
    for (const name of ['package.json', lock, ...EXTRA]) {
      const src = join(worktree, name);
      if (await isfile(src)) await copy2(src, tmp);
    }
    if (await isdir(join(worktree, 'patches'))) {
      // `shutil.copytree`: links followed, times kept
      await cp(join(worktree, 'patches'), join(tmp, 'patches'), { recursive: true, dereference: true, preserveTimestamps: true });
    }
    const log = `${final}.log`;
    const code = await this.run(cmd, tmp, log, this.timeout_s);
    const modules = join(tmp, 'node_modules');
    if (code !== 0 || !(await isdir(modules))) {
      await rmtree(tmp);
      let tail: string;
      try {   // errors='replace'; `splitlines` reads text mode's newlines
        tail = splitlines(strip(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await readFile(log)))).slice(-3).join(' / ');
      } catch {
        tail = '';
      }
      const why = code === -1 ? 'timed out' : `exit ${code}`;
      return `${why}${tail ? ': ' + tail : ''}`;
    }
    await writeFile(join(modules, READY), cmd.slice(1).join(' ') + EOL);   // text mode's newline
    if (await isfile(join(final, 'node_modules', READY))) {
      // Another runner (live_review.py) published this key meanwhile, and a review may be
      // using it: keep that one.
      await rmtree(tmp);
      return null;
    }
    await rmtree(final);   // an emptied cache's leftovers
    await rename(tmp, final);
    return null;
  }

  private async _prune(repo: string): Promise<void> {
    const name = new RegExp(`^${re_escape(repo)}-[0-9a-f]{12}$`);
    const mine: { path: string; at: number }[] = [];
    for (const n of await readdir(this.cache_dir)) {
      const path = join(this.cache_dir, n);
      if (name.test(n)) mine.push({ path, at: (await stat(path)).mtimeMs });
    }
    mine.sort((a, b) => b.at - a.at);   // stable, as Python's sort is
    const stale = new RegExp(`^${re_escape(repo)}-[0-9a-f]{12}\\.tmp-[^\\n]*$`);
    for (const n of await readdir(this.cache_dir)) {   // an install a dead runner left
      const path = join(this.cache_dir, n);
      if (stale.test(n) && Date.now() / 1000 - (await stat(path)).mtimeMs / 1000 > STALE_S) await rmtree(path);
    }
    for (const old of mine.slice(KEEP)) {
      await rmtree(old.path);
      await remove_quietly(`${old.path}.log`);
    }
  }

  /** Removes the checkout's node_modules link, never what it points to. Node's `lstat` sees a
   *  junction and a symlink both as a link; a read-only one raises, as Python's `os.rmdir` does
   *  (Node's `unlink` would clear the flag and delete it). */
  static async unlink(worktree: string): Promise<void> {
    const link = join(worktree, 'node_modules');
    const st = await lstat(link).catch(() => null);
    if (!st?.isSymbolicLink()) return;
    if (read_only(st)) throw permission_error('rmdir', link);
    await unlink(link);
  }
}

/** `re.escape`, for a JavaScript pattern. */
const re_escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
