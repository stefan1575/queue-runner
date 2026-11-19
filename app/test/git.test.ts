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

test("worktrees are read from git's porcelain list, each with its branch or none (#156)", async () => {
  const git = new GitCli(async () => ({
    code: 0, stderr: '',
    stdout: 'worktree C:/code/app\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/t3/wt/claude-x-3\nHEAD 2\nbranch refs/heads/claude/x-3\n\nworktree C:/state/checkouts/app-pr4\nHEAD 3\ndetached\n\n',
  }));
  expect(await git.worktrees('C:/code/app')).toEqual([
    { path: 'C:/code/app', branch: 'main' }, { path: 'C:/t3/wt/claude-x-3', branch: 'claude/x-3' }, { path: 'C:/state/checkouts/app-pr4', branch: null },
  ]);
});

test('a worktree is removed once git no longer lists it, whatever remove itself answered', async () => {
  const calls: string[][] = [];
  let listed = true;
  const git = new GitCli(async (args) => {
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'remove') { listed = false; return { code: 1, stderr: "error: failed to delete 'C:/t3/wt/x': Permission denied" }; }
    if (args[0] === 'worktree' && args[1] === 'list') return { code: 0, stderr: '', stdout: `worktree C:/code/app\n\n${listed ? 'worktree C:\\t3\\wt\\x\n' : ''}` };
    return { code: 0, stderr: '' };
  });
  expect(await git.removeWorktree('C:/code/app', 'C:/t3/wt/x')).toBe(true);
  listed = true;
  const stuck = new GitCli(async (args) => (args[1] === 'list' ? { code: 0, stderr: '', stdout: 'worktree C:\\t3\\wt\\x\n' } : { code: 1, stderr: 'locked' }));
  expect(await stuck.removeWorktree('C:/code/app', 'C:/t3/wt/x')).toBe(false);
});

test('a branch is deleted only when it is there; git log reads each commit oldest first', async () => {
  const calls: string[][] = [];
  const git = new GitCli(async (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { code: args.at(-1) === 'refs/heads/gone' ? 1 : 0, stderr: '' };
    if (args[0] === 'log') return { code: 0, stderr: '', stdout: 'aaa\tFirst\nbbb\tSecond: with\ttab\n' };
    return { code: 0, stderr: '' };
  });
  await git.deleteBranch('C:/r', 'gone');
  expect(calls.some((c) => c[0] === 'branch')).toBe(false);
  await git.deleteBranch('C:/r', 'claude/x-3');
  expect(calls.at(-1)).toEqual(['branch', '-D', 'claude/x-3']);
  expect(await git.log('C:/r', 'origin/main', 'abc')).toEqual([{ sha: 'aaa', subject: 'First' }, { sha: 'bbb', subject: 'Second: with\ttab' }]);
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
