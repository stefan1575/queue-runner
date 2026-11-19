import { describe, expect, it } from 'vitest';
import { notStartedLine, sandboxRepo } from '../live/sandbox.ts';
import type { GitHub } from '../src/github.ts';

const mcpOf = (projects: object[]) => ({ call: async () => ({ projects, nextCursor: null }) });
const githubOf = (remotes: Record<string, string>): Pick<GitHub, 'remoteOf'> => ({
  remoteOf: async (f) => (remotes[f] ? { nameWithOwner: remotes[f]!, url: `https://github.com/${remotes[f]}` } : null),
});

describe("the live review check's sandbox repo (#155 F18)", () => {
  it("is the sandbox T3 project's own folder, so its checkouts are that project's worktrees", async () => {
    const repo = await sandboxRepo(mcpOf([{ id: 'p1', title: 'queue-runner sandbox', workspaceRoot: 'C:/sandbox' }, { id: 'p2', title: 'other', workspaceRoot: 'C:/o' }]),
      githubOf({ 'C:/sandbox': 'stefan1575/queue-runner-sandbox' }));
    expect(repo).toEqual({ id: 'p1', title: 'queue-runner-sandbox', folder: 'C:/sandbox', github: 'stefan1575/queue-runner-sandbox' });
  });

  it('refuses no sandbox project, or two', async () => {
    const one = { id: 'p1', title: 'queue-runner sandbox', workspaceRoot: 'C:/sandbox' };
    const github = githubOf({ 'C:/sandbox': 'stefan1575/queue-runner-sandbox' });
    await expect(sandboxRepo(mcpOf([]), github)).rejects.toThrow('found 0: refusing');
    await expect(sandboxRepo(mcpOf([one, { ...one, id: 'p2' }]), github)).rejects.toThrow('found 2: refusing');
  });

  it("refuses a sandbox project whose folder isn't a clone of the sandbox", async () => {
    const projects = [{ id: 'p1', title: 'queue-runner sandbox', workspaceRoot: 'C:/sandbox' }];
    await expect(sandboxRepo(mcpOf(projects), githubOf({ 'C:/sandbox': 'stefan1575/queue-runner' }))).rejects.toThrow('is stefan1575/queue-runner, not stefan1575/queue-runner-sandbox: refusing');
    await expect(sandboxRepo(mcpOf(projects), githubOf({}))).rejects.toThrow('no GitHub clone');
  });

  it("says plainly when T3 didn't start the review, and nothing otherwise", () => {
    expect(notStartedLine({ outcome: 'not-started', error: "worktreePath must be one of the project's git worktrees." }))
      .toBe("T3 didn't start the review: worktreePath must be one of the project's git worktrees.");
    expect(notStartedLine({ outcome: 'clean' })).toBeNull();
    expect(notStartedLine(null)).toBeNull();
  });
});
