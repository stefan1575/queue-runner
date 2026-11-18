// Local git around a build (#154), on a fake git: what it runs and how its exit codes read.
import { expect, test } from 'vitest';
import { GitCli, GitError } from '../src/git.ts';

test('fetch asks origin for the base; a failure is a GitError with what git said', async () => {
  const calls: string[][] = [];
  const ok = new GitCli(async (args) => { calls.push(args); return { code: 0, stderr: '' }; });
  await ok.fetch('C:/r', 'main');
  expect(calls).toEqual([['fetch', '--quiet', 'origin', 'main']]);
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
