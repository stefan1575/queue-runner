// The picker (#154; today's `picker.py`, docs/layout.md) on a fake GitHub: an open
// `ready-for-agent` issue, every blocker closed, not already in flight, not a spec with open
// sub-issues, lowest number first.
import { describe, expect, test } from 'vitest';
import type { GitHubWork, Issue } from '../src/github.ts';
import { blockers, closedIssues, inFlight, pick, pickable, slug } from '../src/picker.ts';
import { FakeGitHub } from './fake-github.ts';

const REPO = 'owner/app';
const issue = (number: number, part: Partial<Issue> = {}): Issue =>
  ({ number, title: `Ticket ${number}`, body: '', openBlockers: 0, openSubIssues: 0, openLinkedPulls: 0, ...part });
const numbers = async (gh: GitHubWork, held = new Set<number>()) => {
  const out: number[] = [];
  for await (const t of pickable(gh, REPO, 'main', held)) out.push(t.issue.number);
  return out;
};

describe('slug', () => {
  test('the first four words of the title, lower case', () => {
    expect(slug('The runner builds a ticket: it picks it')).toBe('the-runner-builds-a');
    expect(slug('Fix: `T3` (MCP)!')).toBe('fix-t3-mcp');
    expect(slug('!!!')).toBe('issue');
  });
});

describe('blockers', () => {
  test('a Blocked by line names this repo, another repo and a URL', () => {
    expect(blockers('Blocked by: #3, other/lib#4 and https://github.com/a/b/issues/5', REPO))
      .toEqual([['a/b', 5], ['other/lib', 4], ['owner/app', 3]]);
  });
  test('a Blocked by heading takes the refs up to the next heading; other refs block nothing', () => {
    const body = 'See #1.\n\n## Blocked by\n\n- #2\n- #3\n\n## Notes\n\n#4';
    expect(blockers(body, REPO)).toEqual([['owner/app', 2], ['owner/app', 3]]);
  });
  test('bold and list markers before it still count', () => {
    expect(blockers('- **Blocked by** #7', REPO)).toEqual([['owner/app', 7]]);
  });
});

describe('closedIssues', () => {
  test('Closes, Fixes and Resolves, any case, with a colon or not', () => {
    expect(closedIssues('Closes #1. fixes: other/lib#2, Resolved https://github.com/owner/app/issues/3; see #4', 'Owner/App'))
      .toEqual([['other/lib', 2], ['owner/app', 1], ['owner/app', 3]]);
  });
});

describe('pick', () => {
  test('the lowest-numbered ready issue is built: on claude/<slug>-<n> from origin/<base>', async () => {
    const gh = new FakeGitHub();
    gh.ready[REPO] = [issue(12, { title: 'Second thing' }), issue(10, { title: 'First thing to build' })];
    expect(await pick(gh, REPO, 'main', new Set())).toMatchObject({
      issue: { number: 10 }, branch: 'claude/first-thing-to-build-10', base: 'origin/main',
    });
  });

  test('a natively blocked one, a spec with open sub-issues and one already in flight are skipped', async () => {
    const gh = new FakeGitHub();
    gh.ready[REPO] = [issue(1, { openBlockers: 1 }), issue(2, { openSubIssues: 3 }), issue(3), issue(4), issue(5), issue(6, { openLinkedPulls: 1 }), issue(7)];
    gh.branchList[REPO] = ['claude/ticket-3-3', 'claude/not-a-job'];
    gh.pulls[REPO] = [{ number: 50, branch: 'someone/else', body: 'Closes #4', url: '' }, { number: 51, branch: 'claude/x-5', body: '', url: '' }];
    expect(await numbers(gh)).toEqual([7]);
    expect((await pick(gh, REPO, 'main', new Set()))?.issue.number).toBe(7);
  });

  test('a Blocked by line holds it while its blocker is open, anywhere on GitHub', async () => {
    const gh = new FakeGitHub();
    gh.ready[REPO] = [issue(1, { body: 'Blocked by: #9' }), issue(2, { body: 'Blocked by other/lib#3' }), issue(4)];
    gh.states = { 'owner/app#9': 'open', 'other/lib#3': 'closed' };
    expect(await numbers(gh)).toEqual([2, 4]);
  });

  test('issues the job log holds are skipped', async () => {
    const gh = new FakeGitHub();
    gh.ready[REPO] = [issue(1), issue(2)];
    expect(await numbers(gh, new Set([1]))).toEqual([2]);
  });

  test('no ready issue: nothing to build', async () => {
    expect(await pick(new FakeGitHub(), REPO, 'main', new Set())).toBeNull();
  });

  test('in flight: a job branch, an open PR on one, or one that closes it here', async () => {
    const gh = new FakeGitHub();
    gh.branchList[REPO] = ['claude/a-1'];
    gh.pulls[REPO] = [{ number: 9, branch: 'claude/b-2', body: 'Fixes other/lib#5, closes #3', url: '' }];
    expect([...await inFlight(gh, REPO)].sort()).toEqual([1, 2, 3]);
  });
});
