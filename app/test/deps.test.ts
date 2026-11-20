// A review checkout's dependencies: installed once per lockfile into the cache, linked into each
// checkout as a junction, with the install command faked (no bun or npm runs here). Ported from
// `tests/test_deps.py` case for case (#221).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Deps, type Run } from '../src/deps.ts';

const PACKAGE = {
  name: 'app', scripts: { test: 'vitest run' },
  dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '^4.1.10' },
};

/** Plays `bun install`: writes node_modules in the folder it runs in, or fails. */
class FakeInstall {
  code: number;
  calls: [string[], string][] = [];
  constructor(code = 0) {
    this.code = code;
  }

  run: Run = async (cmd, cwd, out_path) => {
    this.calls.push([cmd, cwd]);
    await writeFile(out_path, this.code === 0 ? 'installed\n' : 'error: lockfile had changes\n');
    if (this.code === 0) await mkdir(join(cwd, 'node_modules', 'react'), { recursive: true });
    return this.code;
  };
}

/** `addCleanup`: run after each test, newest first. */
let cleanups: (() => unknown)[] = [];
const addCleanup = (f: () => unknown) => cleanups.push(f);

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** `os.path.isjunction`: a link on Windows that `dir` lists as a junction. */
function isjunction(path: string): boolean {
  if (process.platform !== 'win32' || !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/AL', join(path, '..')], { encoding: 'utf8' });
  return listing.split(/\r?\n/).some((line) => line.includes('<JUNCTION>') && line.includes(` ${basename(path)} [`));
}

// Each case writes a few folders; on a loaded Windows runner that can pass Vitest's 5s default.
describe('DepsTest', { timeout: 30_000 }, () => {
  let dir: string, cache: string, install: FakeInstall, n: number;

  beforeEach(async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'qr-deps-'));
    addCleanup(() => rm(tmp, { recursive: true, force: true }));
    dir = tmp;
    cache = join(dir, 'deps');
    install = new FakeInstall();
    n = 0;
  });

  const deps = (kw: { timeout_s?: number } = {}) =>
    new Deps(cache, { run: install.run, bun: 'C:/scoop/shims/bun.exe', npm: 'C:/node/npm.cmd', ...kw });

  async function checkout({ pkg = PACKAGE as object | null, lock = 'bun.lock' as string | null, lock_text = '{"lockfileVersion": 1}' } = {}) {
    n += 1;
    const wt = join(dir, `wt${n}`);
    await mkdir(wt);
    if (pkg !== null) await writeFile(join(wt, 'package.json'), JSON.stringify(pkg));
    if (lock) await writeFile(join(wt, lock), lock_text);
    return wt;
  }

  test('test_installs_from_bun_lock_once_and_links_it_into_the_checkout', async () => {
    const wt = await checkout();
    const got = await deps().prepare('app', wt);
    expect(got.ready).toBe(true);
    expect(got.note).toContain('bun.lock');
    expect(install.calls).toHaveLength(1);
    const [[cmd, cwd]] = install.calls as [[string[], string]];
    expect(cmd).toEqual(['C:/scoop/shims/bun.exe', 'install', '--frozen-lockfile']);
    expect(cwd.startsWith(cache)).toBe(true);
    if (process.platform === 'win32') expect(isjunction(join(wt, 'node_modules'))).toBe(true);
    else expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(statSync(join(wt, 'node_modules', 'react')).isDirectory()).toBe(true);

    const again = await deps().prepare('app', await checkout());   // same lockfile: no install
    expect(again.ready).toBe(true);
    expect(install.calls).toHaveLength(1);
    expect(again.how).toContain('cached');
  });

  test('test_a_changed_lockfile_or_dependency_installs_again_but_a_script_change_does_not', async () => {
    await deps().prepare('app', await checkout());
    await deps().prepare('app', await checkout({
      pkg: { ...PACKAGE, scripts: { test: 'vitest run --reporter dot' } } }));
    expect(install.calls).toHaveLength(1);
    await deps().prepare('app', await checkout({ lock_text: '{"lockfileVersion": 2}' }));
    expect(install.calls).toHaveLength(2);
    await deps().prepare('app', await checkout({
      pkg: { ...PACKAGE, dependencies: { react: '^19.1.0' } } }));
    expect(install.calls).toHaveLength(3);
  });

  test('test_a_cache_emptied_since_installs_again', async () => {
    const wt = await checkout();
    await deps().prepare('app', wt);
    await unlink(join(wt, 'node_modules', '.queue-runner-ready'));   // e.g. a test run
    await deps().prepare('app', await checkout());
    expect(install.calls).toHaveLength(2);
  });

  test('test_package_lock_uses_npm_ci', async () => {
    await deps().prepare('app', await checkout({ lock: 'package-lock.json' }));
    expect(install.calls[0]![0]).toEqual(['C:/node/npm.cmd', 'ci', '--no-audit', '--no-fund']);
  });

  test('test_no_lockfile_or_a_failed_install_links_nothing_and_says_why', async () => {
    let got = await deps().prepare('app', await checkout({ lock: null }));
    expect(got.ready).toBe(false);
    expect(got.note).toContain('no lockfile');
    install.code = 1;
    const wt = await checkout();
    got = await deps().prepare('app', wt);
    expect(got.ready).toBe(false);
    expect(got.note).toContain('install failed');
    expect(got.note).toContain('lockfile had changes');
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
    expect(readdirSync(cache).filter((name) => !name.endsWith('.log'))).toEqual([]);
  });

  test('test_no_package_json_needs_nothing', async () => {
    const got = await deps().prepare('app', await checkout({ pkg: null, lock: null }));
    expect(got.ready).toBe(false);
    expect(got.note).toBeNull();
    expect(install.calls).toEqual([]);
  });

  test('test_no_bun_says_so', async () => {
    const got = await new Deps(cache, { run: install.run, bun: null, npm: null }).prepare('app', await checkout());
    expect(got.ready).toBe(false);
    expect(got.note).toContain('bun');
    expect(install.calls).toEqual([]);
  });

  test('test_keeps_the_three_newest_caches_per_repo', async () => {
    for (let v = 0; v < 5; v++) await deps().prepare('app', await checkout({ lock_text: `{"v": ${v}}` }));
    const kept = readdirSync(cache).filter((name) => name.startsWith('app-') && !name.includes('.'));
    expect(kept).toHaveLength(3);
    await deps().prepare('app', await checkout({ lock_text: '{"v": 4}' }));   // the newest stayed
    expect(install.calls).toHaveLength(5);
  });

  test('test_an_install_setting_or_patch_is_part_of_the_key', async () => {
    await deps().prepare('app', await checkout());
    let wt = await checkout();
    await writeFile(join(wt, '.npmrc'), 'omit=dev\n');
    await deps().prepare('app', wt);
    expect(install.calls).toHaveLength(2);
    wt = await checkout();
    await mkdir(join(wt, 'patches'));
    await writeFile(join(wt, 'patches', 'react.patch'), '--- a\n');
    await deps().prepare('app', wt);
    expect(install.calls).toHaveLength(3);
  });

  test('test_sol_may_write_only_where_vite_writes_not_the_packages', async () => {
    const got = await deps().prepare('app', await checkout());
    expect(got.writable.map((w) => basename(w))).toEqual(['.vite-temp', '.vite']);
    for (const w of got.writable) {
      expect(statSync(w).isDirectory()).toBe(true);
      expect(w.startsWith(cache)).toBe(true);
    }
  });

  test('test_an_install_that_finishes_second_keeps_the_one_already_in_use', async () => {
    const wt = await checkout();
    const first = deps();
    const inner = install.run;

    const slow: Run = async (cmd, cwd, out_path, timeout) => {   // another runner publishes the same key meanwhile
      const code = await inner(cmd, cwd, out_path, timeout);
      if (install.calls.length === 1) {
        await new Deps(cache, { run: inner, bun: 'bun', npm: 'npm' }).prepare('app', await checkout());
        await writeFile(join(wt, 'in-use'), 'x');
      }
      return code;
    };
    first.run = slow;
    expect((await first.prepare('app', wt)).ready).toBe(true);
    const caches = readdirSync(cache).filter((name) => !name.includes('.'));
    expect(caches).toHaveLength(1);
    expect(install.calls).toHaveLength(2);
    expect(statSync(join(cache, caches[0]!, 'node_modules', '.queue-runner-ready')).isFile()).toBe(true);
    expect(readdirSync(cache).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  test('test_pruning_leaves_a_repo_whose_name_starts_the_same', async () => {
    await deps().prepare('app-tools', await checkout());
    for (let v = 0; v < 4; v++) await deps().prepare('app', await checkout({ lock_text: `{"v": ${v}}` }));
    expect(readdirSync(cache).filter((name) => name.startsWith('app-tools-') && !name.includes('.'))).toHaveLength(1);
  });

  test('test_an_install_a_dead_runner_left_is_swept_once_it_is_old', async () => {
    await mkdir(cache);
    const old = join(cache, 'app-0123456789ab.tmp-dead');
    const young = join(cache, 'app-0123456789ab.tmp-running');
    await mkdir(old);
    await mkdir(young);
    await utimes(old, 0, 0);
    await deps().prepare('app', await checkout());
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  test.skipIf(process.platform !== 'win32')('test_the_cache_inherits_its_folders_permissions_so_the_sandbox_can_read_it', async () => {
    // tempfile.mkdtemp gave an owner-only ACL, and Codex's sandbox user couldn't read
    // node_modules through the junction (EPERM on stat).
    await deps().prepare('app', await checkout());
    const caches = readdirSync(cache).filter((name) => !name.includes('.'));
    expect(caches).toHaveLength(1);
    // Compared with a folder made plainly beside it, not with a fixed "(I)": what a folder
    // inherits depends on the machine (GitHub's Windows runner gives this temp folder's
    // children explicit entries, 2026-11-10), but the cache must get the same as any other.
    const control = join(cache, 'control');
    await mkdir(control);

    const aces = (path: string) => {
      const out = execFileSync('icacls', [path], { encoding: 'utf8' });
      const lines = out.split(/\r?\n/).map((l) => l.replace(path, '').trim());
      return lines.filter((l) => l && !l.startsWith('Successfully')).sort();
    };
    expect(aces(join(cache, caches[0]!))).toEqual(aces(control));
  });

  test('test_unlink_removes_the_junction_and_keeps_the_cache', async () => {
    const wt = await checkout();
    await deps().prepare('app', wt);
    await Deps.unlink(wt);
    expect(lstatSync(join(wt, 'node_modules'), { throwIfNoEntry: false })).toBeUndefined();
    expect((await deps().prepare('app', await checkout())).ready).toBe(true);
    expect(install.calls).toHaveLength(1);
  });
});
