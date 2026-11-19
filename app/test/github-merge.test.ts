// What merging asks of GitHub through `gh api` (#156), on a fake gh: the PR read afresh, the merge
// with the expected head (GitHub's 409 when it moved), unresolved review threads every page, and
// the ready-to-merge label.
import { describe, expect, test } from 'vitest';
import { GhGitHub, GitHubError, HeadMoved, type Gh } from '../src/github.ts';

type Answer = { code: number; stdout?: string; stderr?: string };
function fakeGh(answer: (args: string[], input?: string) => Answer, calls: { args: string[]; input?: string }[] = []): Gh {
  return async (args, _cwd, input) => {
    calls.push({ args, input });
    const a = answer(args, input);
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
}
const json = (v: unknown): Answer => ({ code: 0, stdout: JSON.stringify(v) });

describe('pull', () => {
  test('its state, head, draft, mergeable and labels', async () => {
    const gh = new GhGitHub(fakeGh(() => json({
      number: 4, title: 'T', html_url: 'u', state: 'closed', merged_at: '2026-11-19T00:00:00Z', draft: false, mergeable: null,
      head: { sha: 'abc', ref: 'claude/x-3' }, base: { ref: 'main' }, labels: [{ name: 'ready-to-merge' }],
    })), () => true);
    expect(await gh.pull('o/r', 4)).toEqual({
      number: 4, title: 'T', url: 'u', state: 'merged', headSha: 'abc', branch: 'claude/x-3', base: 'main', draft: false, mergeable: null, labels: ['ready-to-merge'],
    });
  });

  test('an answer with no head is a GitHubError', async () => {
    await expect(new GhGitHub(fakeGh(() => json({ message: 'odd' })), () => true).pull('o/r', 4)).rejects.toThrow(GitHubError);
  });
});

describe('pullsToReview', () => {
  test("names the repo each head is in, null for a fork GitHub no longer has (N2)", async () => {
    const gh = new GhGitHub(fakeGh(() => json([[
      { number: 4, head: { ref: 'x', sha: 'a', repo: { full_name: 'o/r' } }, base: { ref: 'main' } },
      { number: 5, head: { ref: 'main', sha: 'b', repo: { full_name: 'someone/r' } }, base: { ref: 'main' } },
      { number: 6, head: { ref: 'y', sha: 'c', repo: null }, base: { ref: 'main' } },
    ]])), () => true);
    expect((await gh.pullsToReview('o/r')).map((p) => p.headRepo)).toEqual(['o/r', 'someone/r', null]);
  });
});

describe('merge', () => {
  test('names the expected head and a merge commit, on stdin', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const gh = new GhGitHub(fakeGh(() => json({ merged: true, sha: 'm1' }), calls), () => true);
    expect(await gh.merge('o/r', 4, 'abc')).toBe('m1');
    expect(calls[0]!.args).toEqual(['api', '-X', 'PUT', 'repos/o/r/pulls/4/merge', '--input', '-']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ sha: 'abc', merge_method: 'merge' });
  });

  test("GitHub's 409 on the old head is HeadMoved; any other failure a GitHubError", async () => {
    const moved = new GhGitHub(fakeGh(() => ({ code: 1, stderr: 'gh: Head branch was modified. Review and try the merge again. (HTTP 409)\n' })), () => true);
    await expect(moved.merge('o/r', 4, 'abc')).rejects.toThrow(HeadMoved);
    const refused = new GhGitHub(fakeGh(() => ({ code: 1, stderr: 'gh: Pull Request is not mergeable (HTTP 405)\n' })), () => true);
    const e = await refused.merge('o/r', 4, 'abc').catch((x) => x);
    expect(e).toBeInstanceOf(GitHubError);
    expect(e).not.toBeInstanceOf(HeadMoved);
    const notMerged = new GhGitHub(fakeGh(() => json({ merged: false, message: 'nope' })), () => true);
    await expect(notMerged.merge('o/r', 4, 'abc')).rejects.toThrow(/nope/);
  });
});

describe('openThreads', () => {
  test('counts unresolved threads on every page', async () => {
    const page = (resolved: boolean[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: resolved.map((isResolved) => ({ isResolved })) } } } } });
    const calls: { args: string[] }[] = [];
    const gh = new GhGitHub(fakeGh(() => json([page([true, false]), page([false])]), calls), () => true);
    expect(await gh.openThreads('o/r', 4)).toBe(2);
    expect(calls[0]!.args).toContain('--paginate');
    expect(calls[0]!.args).toContain('n=4');
  });

  test('a page without its threads is an error, never none open', async () => {
    const gh = new GhGitHub(fakeGh(() => json([{ errors: [{ message: 'rate limited' }] }])), () => true);
    await expect(gh.openThreads('o/r', 4)).rejects.toThrow(GitHubError);
  });
});

describe('labels', () => {
  test('added on stdin; removing one that is not there is fine; any other failure is an error', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const gh = new GhGitHub(fakeGh((args) => (args.includes('DELETE') ? { code: 1, stderr: 'gh: Label does not exist (HTTP 404)\n' } : json([])), calls), () => true);
    await gh.addLabel('o/r', 4, 'ready-to-merge');
    expect(calls[0]!.args).toEqual(['api', '-X', 'POST', 'repos/o/r/issues/4/labels', '--input', '-']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ labels: ['ready-to-merge'] });
    await gh.removeLabel('o/r', 4, 'ready-to-merge');
    expect(calls[1]!.args).toEqual(['api', '-X', 'DELETE', 'repos/o/r/issues/4/labels/ready-to-merge']);
    const down = new GhGitHub(fakeGh(() => ({ code: 1, stderr: 'HTTP 502\n' })), () => true);
    await expect(down.removeLabel('o/r', 4, 'ready-to-merge')).rejects.toThrow(GitHubError);
  });
});
