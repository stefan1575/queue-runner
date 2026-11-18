// Local git around a build (#154), on a fake git: what it runs and how its exit codes read; and
// the fetch on a real git, in temp folders, for the remote-tracking ref T3 makes its worktree from.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { GitCli, GitError } from '../src/git.ts';

test('fetch asks origin for the base into origin/<base>; a failure is a GitError with what git said', async () => {
  const calls: string[][] = [];
  const ok = new GitCli(async (args) => { calls.push(args); return { code: 0, stderr: '' }; });
  await ok.fetch('C:/r', 'main');
  expect(calls).toEqual([['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']]);
  const down = new GitCli(async () => ({ code: 128, stderr: "fatal: unable to access 'x'\n" }));
  await expect(down.fetch('C:/r', 'main')).rejects.toThrow(GitError);
  await expect(down.fetch('C:/r', 'main')).rejects.toThrow(/unable to access/);
});

test('a local branch: exit 0 is there, 1 is not, anything else is a GitError', async () => {
  const answer = (code: number) => new GitCli(async () => ({ code, stderr: code > 1 ? 'fatal: not a git repository' : '' }));
  expect(await answer(0).hasBranch('C:/r', 'claude/x-1')).toBe(true);
  expect(await answer(1).hasBranch('C:/r', 'claude/x-1')).toBe(false);
  await expect(answer(128).hasBranch('C:/r', 'claude/x-1')).rejects.toThrow(/not a git repository/);
});

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tracking = (clone: string, base: string) => {
  try {
    return git(clone, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`);
  } catch {
    return null;
  }
};

/** A bare origin with `main` and `trunk` (one commit ahead), and a clone of it. */
async function origin(cloneArgs: string[]) {
  dir = await mkdtemp(join(tmpdir(), 'qr-git-'));
  const work = join(dir, 'work');
  git(dir, 'init', '--quiet', '-b', 'main', work);
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'one');
  git(work, 'branch', 'trunk');
  git(work, 'checkout', '--quiet', 'trunk');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'two');
  git(dir, 'clone', '--quiet', '--bare', work, join(dir, 'origin.git'));
  git(dir, 'clone', '--quiet', ...cloneArgs, join(dir, 'origin.git'), join(dir, 'clone'));
  return { clone: join(dir, 'clone'), trunk: git(work, 'rev-parse', 'trunk') };
}

test("a single-branch clone of main fetching trunk gets origin/trunk, which its refspec alone wouldn't make", async () => {
  const { clone, trunk } = await origin(['--single-branch', '--branch', 'main']);
  expect(tracking(clone, 'trunk')).toBeNull();
  await new GitCli().fetch(clone, 'trunk');
  expect(tracking(clone, 'trunk')).toBe(trunk);
});

test("a clone whose origin/<base> is behind has it moved to origin's newest", async () => {
  const { clone, trunk } = await origin(['--branch', 'main']);
  git(clone, 'update-ref', 'refs/remotes/origin/trunk', 'refs/remotes/origin/main');
  await new GitCli().fetch(clone, 'trunk');
  expect(tracking(clone, 'trunk')).toBe(trunk);
});
