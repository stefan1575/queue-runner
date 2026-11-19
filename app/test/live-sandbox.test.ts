import { describe, expect, it } from 'vitest';
import { notStartedLine, sandboxRepo } from '../live/sandbox.ts';
import type { GitHub } from '../src/github.ts';

const mcpOf = (projects: object[]) => ({ call: async () => ({ projects, nextCursor: null }) });
const githubOf = (remotes: Record<string, string>): Pick<GitHub, 'remoteOf'> => ({
  remoteOf: async (f) => (remotes[f] ? { nameWithOwner: remotes[f]!, url: `https://github.com/${remotes[f]}` } : null),
});
// the build check's sandbox (a local bare origin, no GitHub) and the review check's GitHub clone
const build = { id: 'p1', title: 'queue-runner sandbox', workspaceRoot: 'C:/sandbox/repo' };
const review = { id: 'p2', title: 'queue-runner sandbox GitHub', workspaceRoot: 'C:/gh-sandbox/repo' };
const remotes = { 'C:/gh-sandbox/repo': 'stefan1575/queue-runner-sandbox', 'C:/o': 'stefan1575/queue-runner' };

describe("the live review check's sandbox repo (#155 F18, F21)", () => {
  it("is the one project cloned from the GitHub sandbox, by its remote, not the build check's by title", async () => {
    const repo = await sandboxRepo(mcpOf([build, review, { id: 'p3', title: 'other', workspaceRoot: 'C:/o' }]), githubOf(remotes));
    expect(repo).toEqual({ id: 'p2', title: 'queue-runner-sandbox', folder: 'C:/gh-sandbox/repo', github: 'stefan1575/queue-runner-sandbox' });
  });

  it('refuses no such project, or two', async () => {
    await expect(sandboxRepo(mcpOf([build]), githubOf(remotes))).rejects.toThrow('clone of stefan1575/queue-runner-sandbox, found 0: refusing');
    const twice = { ...review, id: 'p4', title: 'another', workspaceRoot: 'C:/again' };
    await expect(sandboxRepo(mcpOf([review, twice]), githubOf({ ...remotes, 'C:/again': 'stefan1575/queue-runner-sandbox' })))
      .rejects.toThrow('found 2 (queue-runner sandbox GitHub at C:/gh-sandbox/repo), (another at C:/again): refusing');
  });

  it("says plainly when T3 didn't start the review, and nothing otherwise", () => {
    expect(notStartedLine({ outcome: 'not-started', error: "worktreePath must be one of the project's git worktrees." }))
      .toBe("T3 didn't start the review: worktreePath must be one of the project's git worktrees.");
    expect(notStartedLine({ outcome: 'clean' })).toBeNull();
    expect(notStartedLine(null)).toBeNull();
  });
});
