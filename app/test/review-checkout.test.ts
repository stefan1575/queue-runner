// A review's checkout (#155) on real git in a temp folder (no network: origin is a bare repo
// beside it): the PR's head fetched from refs/pull/<n>/head, checked out detached, the
// dependencies linked in from the cache, and removed again without emptying the cache.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
// These run real git (and npm) processes: how long one takes is the machine's load, not what's
// tested, so a full parallel run on a busy PC must not fail them on the default 5 seconds (#158 N1).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
import { GitCli, prRef } from '../src/git.ts';
import { Deps, READY, testsNote, type Install } from '../src/review/deps.ts';

let dir: string;
let clone: string;
let base: string;
let head: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-checkout-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main', work);
  await writeFile(join(work, 'package.json'), '{"devDependencies":{"x":"1"}}');
  await writeFile(join(work, 'package-lock.json'), '{}');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'base');
  base = git(work, 'rev-parse', 'HEAD');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  await writeFile(join(work, 'a.txt'), 'the change\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'change');
  head = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/pull/4/head');
  clone = join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the PR's head is fetched, checked out detached, diffed and removed with its ref", async () => {
  const g = new GitCli();
  expect(await g.fetchPr(clone, 4, 'main')).toBe(head);
  const wt = join(dir, 'checkouts', 'app-pr4');
  await g.checkout(clone, prRef(4), wt);
  expect(await readFile(join(wt, 'a.txt'), 'utf8')).toMatch(/^the change\r?\n$/);
  expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
  expect(await g.isAncestor(clone, base, head)).toBe(true);
  expect(await g.isAncestor(clone, 'f'.repeat(40), head)).toBe(false);
  expect(await g.diff(clone, 'origin/main', head, true)).toContain('+the change');
  await g.removeCheckout(clone, wt, prRef(4));
  await expect(stat(wt)).rejects.toThrow();
  expect(git(clone, 'worktree', 'list')).not.toContain('app-pr4');
});

test('no evidence branch is no screenshots; one with the PR folder is copied out', async () => {
  const g = new GitCli();
  expect(await g.evidence(clone, 4, join(dir, 'ev'))).toEqual([]);
  const work = join(dir, 'work');
  git(work, 'checkout', '-q', '--orphan', 'evidence');
  git(work, 'rm', '-rq', '--cached', '.');
  await mkdir(join(work, 'pr-4'), { recursive: true });
  await writeFile(join(work, 'pr-4', 'after-x.png'), Buffer.from([0x89, 0x50, 0x00, 0xff]));
  git(work, 'add', 'pr-4');
  git(work, 'commit', '-qm', 'shots');
  git(work, 'push', '-q', 'origin', 'evidence');
  expect(await g.evidence(clone, 4, join(dir, 'ev'))).toEqual(['after-x.png']);
  expect([...(await readFile(join(dir, 'ev', 'after-x.png')))]).toEqual([0x89, 0x50, 0x00, 0xff]);
});

test('dependencies install once into the cache, link into the checkout and survive its removal', async () => {
  const g = new GitCli();
  await g.fetchPr(clone, 4, 'main');
  const wt = join(dir, 'checkouts', 'app-pr4');
  await g.checkout(clone, prRef(4), wt);
  const installs: string[][] = [];
  const install: Install = async (command, cwd) => {
    installs.push(command);
    await mkdir(join(cwd, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(cwd, 'node_modules', 'x', 'index.js'), '1');
    return { code: 0, output: 'added 1 package' };
  };
  const deps = new Deps(join(dir, 'deps'), install);
  const p = await deps.prepare('app', wt);
  expect(p).toMatchObject({ ready: true });
  expect(p.how).toMatch(/^installed in \d+s \(app-[0-9a-f]{12}\)$/);
  expect(installs).toEqual([['npm', 'ci', '--no-audit', '--no-fund']]);
  expect(await readFile(join(wt, 'node_modules', 'x', 'index.js'), 'utf8')).toBe('1');
  expect(testsNote(p)).toContain("so run the repo's tests here: `npm test`");
  await g.removeCheckout(clone, wt, prRef(4));
  const cache = join(dir, 'deps', p.how.match(/\((.+)\)/)![1]!, 'node_modules');
  expect(await readFile(join(cache, 'x', 'index.js'), 'utf8')).toBe('1');
  await stat(join(cache, READY));
  // the next review of the same lockfile reuses it
  await g.checkout(clone, head, wt);
  expect((await deps.prepare('app', wt)).how).toMatch(/^cached /);
  expect(installs).toHaveLength(1);
  await g.removeCheckout(clone, wt);
});

test('a failed install is a note, and the review goes on without it', async () => {
  const wt = join(dir, 'clone');
  const deps = new Deps(join(dir, 'deps'), async () => ({ code: 1, output: 'npm ERR! boom' }));
  const p = await deps.prepare('app', wt);
  expect(p).toMatchObject({ ready: false, how: 'failed' });
  expect(p.note).toContain('the install failed (`ci --no-audit --no-fund` from `package-lock.json`: exit 1: npm ERR! boom)');
  expect(testsNote(p)).toContain("so its JavaScript tests can't run here");
});
