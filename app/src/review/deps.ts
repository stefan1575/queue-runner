// A review checkout's JavaScript dependencies, so the reviewer can run the repo's tests (#155;
// today's `queue_runner/deps.py`, ported). Each lockfile is installed once, into
// `<cache>/<repo>-<key>/node_modules`, and linked into the checkout as a junction. The key is the
// lockfile, package.json's dependency fields and the install's settings files, so a PR that
// changes none of them reuses the cache and one that does gets its own install, as CI would.
// `bun.lock` installs with `bun install --frozen-lockfile`, `package-lock.json` with `npm ci`.
//
// **Unlink before git removes a checkout:** `git worktree remove --force` follows a junction and
// empties its target (`unlinkModules`, src/git.ts). Today's sandbox-only parts (writable roots,
// owner-only folders) are gone: a review is a T3 thread running as the user.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile, copyFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const READY = '.queue-runner-ready';
/** Caches kept per repo, the most recently used. */
const KEEP = 3;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions', 'patchedDependencies', 'trustedDependencies', 'workspaces'];
const EXTRA = ['.npmrc', 'bunfig.toml'];

/** The checkout's dependencies: linked (`ready`), and what the brief and the log say of them. */
export type Prepared = { ready: boolean; note: string | null; how: string };

/** One install run in `cwd`: its exit code (-1 when it timed out) and its output's tail. */
export type Install = (command: string[], cwd: string) => Promise<{ code: number; output: string }>;

const exists = (p: string) => stat(p).then(() => true, () => false);

export const installCli = (timeoutMs = 15 * 60_000): Install => (command, cwd) => new Promise((resolve) => {
  // npm is a .cmd on Windows, which only cmd.exe runs
  const [program, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', ...command]] : [command[0]!, command.slice(1)];
  execFile(program, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = error ? (error.killed ? -1 : typeof error.code === 'number' ? error.code : 1) : 0;
    resolve({ code, output: `${stdout}${stderr}` });
  });
});

export class Deps {
  private cache: string;
  private install: Install;
  constructor(cacheDir: string, install: Install = installCli()) {
    this.cache = cacheDir;
    this.install = install;
  }

  /** Links the checkout's dependencies into it, installing them first if no cache has them.
   *  Never throws: what went wrong is the note. */
  async prepare(repo: string, checkout: string): Promise<Prepared> {
    try {
      return await this.prepared(repo, checkout);
    } catch (e) {
      return { ready: false, note: `its dependencies couldn't be set up (${(e as Error).message})`, how: 'failed' };
    }
  }

  private async prepared(repo: string, wt: string): Promise<Prepared> {
    if (!(await exists(join(wt, 'package.json')))) return { ready: false, note: null, how: '' };
    if (await exists(join(wt, 'node_modules'))) return { ready: false, note: 'the checkout has its own `node_modules`, left as it is', how: 'own' };
    const [lock, command] = await exists(join(wt, 'bun.lock')) ? ['bun.lock', ['bun', 'install', '--frozen-lockfile']]
      : await exists(join(wt, 'package-lock.json')) ? ['package-lock.json', ['npm', 'ci', '--no-audit', '--no-fund']] : [null, null];
    if (!lock || !command) return { ready: false, note: "its dependencies aren't installed: no lockfile (`bun.lock` or `package-lock.json`) to install from", how: 'none' };
    const pkg = JSON.parse((await readFile(join(wt, 'package.json'), 'utf8')).replace(/^﻿/, ''));
    const h = createHash('sha256').update(await readFile(join(wt, lock)));
    h.update(JSON.stringify(Object.fromEntries(DEP_FIELDS.sort().map((k) => [k, pkg[k] ?? null]))));
    for (const name of EXTRA) h.update(`\0${name}\0`).update(await readFile(join(wt, name)).catch(() => Buffer.alloc(0)));
    for (const file of await files(join(wt, 'patches'))) h.update(`\0${relative(wt, file).replace(/\\/g, '/')}\0`).update(await readFile(file));
    const key = h.digest('hex').slice(0, 12);
    const final = join(this.cache, `${repo}-${key}`);
    const modules = join(final, 'node_modules');
    let how = 'cached';
    if (!(await exists(join(modules, READY)))) {
      const started = Date.now();
      const failed = await this.installInto(wt, final, lock, command);
      if (failed) return { ready: false, note: `its dependencies aren't installed: the install failed (\`${command.slice(1).join(' ')}\` from \`${lock}\`: ${failed})`, how: 'failed' };
      how = `installed in ${Math.round((Date.now() - started) / 1000)}s`;
    }
    const now = new Date();
    await utimes(final, now, now); // most recently used: kept by the prune
    await symlink(modules, join(wt, 'node_modules'), 'junction');
    await this.prune(repo);
    return { ready: true, note: `its dependencies are installed in \`node_modules\` (from \`${lock}\`, as CI installs them)`, how: `${how} (${repo}-${key})` };
  }

  /** Installs into a fresh folder, then moves it into place: the error's tail, or null. */
  private async installInto(wt: string, final: string, lock: string, command: string[]): Promise<string | null> {
    await mkdir(this.cache, { recursive: true });
    const tmp = `${final}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await mkdir(tmp);
    for (const name of ['package.json', lock, ...EXTRA]) if (await exists(join(wt, name))) await copyFile(join(wt, name), join(tmp, name));
    if (await exists(join(wt, 'patches'))) await cp(join(wt, 'patches'), join(tmp, 'patches'), { recursive: true });
    const { code, output } = await this.install(command, tmp);
    await writeFile(`${final}.log`, output);
    if (code !== 0 || !(await exists(join(tmp, 'node_modules')))) {
      await rm(tmp, { recursive: true, force: true });
      const tail = output.trim().split(/\r?\n/).slice(-3).join(' / ');
      return `${code === -1 ? 'timed out' : `exit ${code}`}${tail ? `: ${tail}` : ''}`;
    }
    await writeFile(join(tmp, 'node_modules', READY), `${command.slice(1).join(' ')}\n`);
    if (await exists(join(final, 'node_modules', READY))) { // another install of this key won meanwhile
      await rm(tmp, { recursive: true, force: true });
      return null;
    }
    await rm(final, { recursive: true, force: true });
    await rename(tmp, final);
    return null;
  }

  private async prune(repo: string) {
    const name = new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{12}$`);
    const mine = await Promise.all((await readdir(this.cache)).filter((n) => name.test(n))
      .map(async (n) => ({ path: join(this.cache, n), at: (await stat(join(this.cache, n))).mtimeMs })));
    for (const old of mine.sort((a, b) => b.at - a.at).slice(KEEP)) {
      await rm(old.path, { recursive: true, force: true });
      await rm(`${old.path}.log`, { force: true });
    }
  }
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
}

/** Step 4 of the brief: what the reviewer can run here. */
export function testsNote(p: Prepared | null): string {
  const said = 'In your review, name each command you ran and quote its summary line (for example `Tests  301 passed (310)`), and say which checks you couldn\'t run.';
  if (p?.ready) {
    return `${p.note}, so run the repo's tests here: \`npm test\`, and the other \`package.json\` scripts the change touches; not browser tests (CI runs them). To confirm a suspected bug, add a test that fails and run it. The workdir is a throwaway copy of H, deleted afterwards. ${said} A failure the change doesn't explain (one that only happens on Windows, say) is no finding: say so. CI runs too, and still gates the merge.`
      .replace(/^./, (c) => c.toUpperCase());
  }
  let lead = "The workdir is a throwaway copy of H, deleted afterwards: you may write in it to run the repo's checks. ";
  if (p?.note) lead += `${p.note[0]!.toUpperCase()}${p.note.slice(1)}, so its JavaScript tests can't run here: say so. `;
  return lead + said;
}
