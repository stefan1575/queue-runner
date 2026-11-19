// The build lane's GitHub reads through `gh api` (#154), on a fake gh: what each asks and how
// GitHub's answer is read.
import { describe, expect, test } from 'vitest';
import { GhGitHub, GitHubError, type Gh } from '../src/github.ts';

function fakeGh(answers: Record<string, unknown>, calls: string[][] = []): Gh {
  return async (args) => {
    calls.push(args);
    const key = args.find((a) => a.startsWith('repos/') || a === 'graphql') ?? '';
    if (!(key in answers)) return { code: 1, stdout: '', stderr: `HTTP 404: Not Found (${key})\n` };
    return { code: 0, stdout: JSON.stringify(answers[key]), stderr: '' };
  };
}

describe('readyIssues', () => {
  test('open ready issues with their native blockers, open sub-issues and linked open PRs; PRs left out', async () => {
    const calls: string[][] = [];
    const gh = new GhGitHub(fakeGh({
      graphql: [{ data: { repository: { issues: { nodes: [
        { number: 3, closedByPullRequestsReferences: { nodes: [{ state: 'OPEN' }, { state: 'CLOSED' }] } },
      ] } } } }],
      'repos/o/r/issues?state=open&labels=ready-for-agent&per_page=100': [[
        { number: 3, title: 'Three', body: null, issue_dependencies_summary: { blocked_by: 2 }, sub_issues_summary: { total: 4, completed: 1 } },
        { number: 4, title: 'A PR', pull_request: {} },
        { number: 5, title: 'Five', body: 'b' },
      ]],
    }, calls), () => true);
    expect(await gh.readyIssues('o/r')).toEqual([
      { number: 3, title: 'Three', body: '', openBlockers: 2, openSubIssues: 3, openLinkedPulls: 1 },
      { number: 5, title: 'Five', body: 'b', openBlockers: 0, openSubIssues: 0, openLinkedPulls: 0 },
    ]);
    expect(calls.some((c) => c.includes('--paginate') && c.includes('--slurp'))).toBe(true);
  });
});

describe('the rest', () => {
  const gh = new GhGitHub(fakeGh({
    'repos/o/r/issues/9': { state: 'open' },
    'repos/o/r/git/matching-refs/heads/claude/': [[{ ref: 'refs/heads/claude/a-1' }]],
    'repos/o/r/pulls?state=open&per_page=100': [[{ number: 7, head: { ref: 'claude/a-1' }, body: null, html_url: 'u7' }]],
    'repos/o/r/issues/1/comments?per_page=100': [[{ user: { login: 'sam' }, created_at: '2026-11-19T00:00:00Z', body: 'hi' }]],
    'repos/o/r/pulls?head=o:claude%2Fa-1&state=all&per_page=100': [[{ number: 7, html_url: 'u7', state: 'closed', merged_at: null }, { number: 8, html_url: 'u8', state: 'closed', merged_at: '2026' }]],
    'repos/o/r': { default_branch: 'trunk' },
  }), () => true);

  test('issue state, branches, open PRs, comments, the PR from a branch and the default branch', async () => {
    expect(await gh.issueState('o/r', 9)).toBe('open');
    expect(await gh.branches('o/r', 'claude/')).toEqual(['claude/a-1']);
    expect(await gh.openPulls('o/r')).toEqual([{ number: 7, branch: 'claude/a-1', body: '', url: 'u7' }]);
    expect(await gh.issueComments('o/r', 1)).toEqual([{ author: 'sam', createdAt: '2026-11-19T00:00:00Z', body: 'hi' }]);
    expect(await gh.pullForBranch('o/r', 'claude/a-1')).toEqual({ number: 8, url: 'u8', state: 'merged' });
    expect(await gh.defaultBranch('o/r')).toBe('trunk');
  });

  test("an answer that isn't a list of pages is a GitHubError, never no PR (F13)", async () => {
    const odd = new GhGitHub(fakeGh({ 'repos/o/r/pulls?head=o:b&state=all&per_page=100': { message: 'Server Error' } }), () => true);
    await expect(odd.pullForBranch('o/r', 'b')).rejects.toThrow(GitHubError);
  });

  test('gh failing is a GitHubError with what it said', async () => {
    await expect(gh.issueState('o/r', 404)).rejects.toThrow(GitHubError);
    await expect(gh.issueState('o/r', 404)).rejects.toThrow(/HTTP 404/);
  });
});
