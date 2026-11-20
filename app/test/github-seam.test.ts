// The GitHub seam, ported from `tests/test_github.py` case for case (#215): what each `gh api`
// call asks and how its answer is read, from canned answers keyed by endpoint.
import { describe, expect, test } from 'vitest';
import { Checks, Comment, GhCli, GhError, Issue, PullRequest, type Repo, WorkflowRun } from '../src/github-seam.ts';

const REPO: Repo & { name: string; path: string } = { name: 'demo', github: 'owner/demo', path: 'C:/demo' };

/** Answers `gh api` calls from canned REST responses, keyed by endpoint. */
class FakeGh {
  responses: Record<string, unknown>;
  calls: string[][] = [];
  inputs: unknown[] = [];   // each write's JSON body, sent on stdin
  constructor(responses: Record<string, unknown>) {
    this.responses = responses;
  }

  run = async (args: string[], input?: string): Promise<string> => {
    this.calls.push(args);
    if (input !== undefined) this.inputs.push(JSON.parse(input));
    const endpoint = args.find((a) => a.startsWith('repos/') || a === 'graphql');
    if (endpoint === undefined || !(endpoint in this.responses)) throw new Error(`KeyError: '${endpoint}'`);
    const data = this.responses[endpoint];
    // --paginate --slurp wraps each page in an outer list
    return JSON.stringify(args.includes('--slurp') ? [data] : data);
  };
}

const cli = (gh: FakeGh) => new GhCli(gh.run);

describe('GhCliTest', () => {
  test('writes send their json on stdin and return the url', async () => {
    const repo = { name: 'demo', github: 'owner/demo', path: '.' };
    const gh = new FakeGh({
      'repos/owner/demo/issues/4/comments': { html_url: 'C' },
      'repos/owner/demo/issues': { html_url: 'I' },
      [`repos/owner/demo/statuses/${'a'.repeat(40)}`]: {},
      'repos/owner/demo/pulls/4': {},
    });
    const c = cli(gh);
    const body = `${'A long comment'.repeat(2000)}<!-- marker é -->`;
    expect(await c.post_comment(repo, 4, body)).toBe('C');
    expect(await c.create_issue(repo, 'T', 'B', ['needs-triage'])).toBe('I');
    await c.set_status(repo, 'a'.repeat(40), 'success', 'x'.repeat(200), 'C');
    await c.edit_pull_body(repo, 4, 'New body');
    expect(gh.calls.map((call) => call.slice(0, 3))).toStrictEqual([...Array(3).fill(['api', '-X', 'POST']), ['api', '-X', 'PATCH']]);
    expect(gh.calls.every((call) => JSON.stringify(call.slice(-2)) === JSON.stringify(['--input', '-']))).toBe(true);
    expect(gh.inputs).toStrictEqual([
      { body },
      { title: 'T', body: 'B', labels: ['needs-triage'] },
      { state: 'success', context: 'sol-review', description: 'x'.repeat(140), target_url: 'C' },
      { body: 'New body' }]);
  });

  test('blocking lists the open issues an issue blocks by githubs dependencies', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/issues/115/dependencies/blocking?per_page=100': [
      { number: 116, title: 'Recipients', body: 'b', state: 'open', html_url: 'https://github.com/owner/demo/issues/116' },
      { number: 117, title: 'Done', body: null, state: 'closed' }] });
    expect(await cli(gh).blocking(REPO, 115)).toStrictEqual([
      new Issue({ number: 116, title: 'Recipients', body: 'b', url: 'https://github.com/owner/demo/issues/116' })]);
  });

  test('ready issues skip pull requests and count open blockers and sub issues', async () => {
    const gh = new FakeGh({
      'repos/owner/demo/issues?state=open&labels=ready-for-agent&per_page=100': [
        { number: 7, title: 'T', body: null,
          issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 2 },
          sub_issues_summary: { total: 5, completed: 2 } },
        { number: 8, title: 'A PR', body: '', pull_request: { url: 'x' } },
        { number: 9, title: 'Old', body: 'b' },
      ],
      graphql: { data: { repository: { issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ number: 9, closedByPullRequestsReferences: { nodes: [{ state: 'OPEN' }, { state: 'MERGED' }, { state: 'OPEN' }] } },
          { number: 7, closedByPullRequestsReferences: { nodes: [] } }] } } } },
    });
    expect(await cli(gh).ready_issues(REPO)).toStrictEqual([
      new Issue({ number: 7, title: 'T', body: '', open_blockers: 1, open_sub_issues: 3 }),
      new Issue({ number: 9, title: 'Old', body: 'b', open_linked_pulls: 2 }),
    ]);
    const query = gh.calls.find((c) => c.includes('graphql'))!;
    expect(query).toContain('owner=owner');
    expect(query).toContain('name=demo');
  });

  test('ready issues with every native blocker closed count none open', async () => {
    // #73, checked live on 2026-11-16: `blocked_by` is the open count (queue-runner #50 has
    // `{"blocked_by": 0, "total_blocked_by": 3}` with its three blockers closed).
    const gh = new FakeGh({
      'repos/owner/demo/issues?state=open&labels=ready-for-agent&per_page=100': [
        { number: 50, title: 'T', body: '',
          issue_dependencies_summary: { blocked_by: 0, blocking: 0, total_blocked_by: 3, total_blocking: 0 } },
      ],
      graphql: { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
    });
    expect(await cli(gh).ready_issues(REPO)).toStrictEqual([new Issue({ number: 50, title: 'T', body: '' })]);
  });

  test('issue state', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/issues/3': { number: 3, state: 'closed' } });
    expect(await cli(gh).issue_state('owner/demo', 3)).toBe('closed');
  });

  test('open pulls', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/pulls?state=open&per_page=100': [
      { number: 20, head: { ref: 'claude/x-5' }, body: null }] });
    expect(await cli(gh).open_pulls(REPO)).toStrictEqual([new PullRequest({ number: 20, branch: 'claude/x-5', body: '' })]);
  });

  test('open pulls carry what a review needs', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/pulls?state=open&per_page=100': [
      { number: 20, title: 'Red', body: 'Closes #5', draft: false,
        html_url: 'https://github.com/owner/demo/pull/20',
        head: { ref: 'claude/x-5', sha: 'a'.repeat(40) }, base: { ref: 'claude/y-4' },
        labels: [{ name: 'sol-reviewed' }] }] });
    const [p] = await cli(gh).open_pulls(REPO);
    expect([p!.title, p!.head_sha, p!.base, p!.url, p!.labels])
      .toStrictEqual(['Red', 'a'.repeat(40), 'claude/y-4', 'https://github.com/owner/demo/pull/20', ['sol-reviewed']]);
  });

  const checks = (runs: [string, string, string | null][], statuses: [string, string][]) => {
    const sha = 'a'.repeat(40);
    return new GhCli(new FakeGh({
      [`repos/owner/demo/commits/${sha}/check-runs?per_page=100`]: {
        total_count: runs.length, check_runs: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })) },
      [`repos/owner/demo/commits/${sha}/status`]: {
        state: 'x', statuses: statuses.map(([context, state]) => ({ context, state })) },
    }).run).checks(REPO, sha);
  };

  test('checks pass when every check and status passed leaving out sol review', async () => {
    const c = await checks([['check', 'completed', 'success'], ['lint', 'completed', 'skipped']],
      [['sol-review', 'failure'], ['deploy', 'success']]);
    expect(c).toStrictEqual(new Checks({ state: 'passed', failed: [], pending: [] }));
  });

  test('checks fail when any failed and wait while any runs', async () => {
    expect((await checks([['check', 'completed', 'failure'], ['e2e', 'in_progress', null]], [])).state).toBe('failed');
    const c = await checks([['check', 'in_progress', null]], [['deploy', 'pending']]);
    expect([c.state, c.pending]).toStrictEqual(['pending', ['check', 'deploy']]);
    expect((await checks([], [['ci', 'error']])).failed).toStrictEqual(['ci']);
  });

  test('a failed actions check names its run so it can be re run', async () => {
    const sha = 'a'.repeat(40);
    const runs = [
      { name: 'tests', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' },
        details_url: 'https://github.com/owner/demo/actions/runs/437/job/9' },
      { name: 'lint', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' },
        details_url: 'https://github.com/owner/demo/actions/runs/437/job/10' },
      { name: 'build', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
        details_url: 'https://github.com/owner/demo/actions/runs/438/job/11' }];

    const check = (statuses: object[] = [], more: object[] = []) => new GhCli(new FakeGh({
      [`repos/owner/demo/commits/${sha}/check-runs?per_page=100`]: { check_runs: [...runs, ...more] },
      [`repos/owner/demo/commits/${sha}/status`]: { statuses: [...statuses] },
    }).run).checks(REPO, sha);
    expect((await check()).runs).toStrictEqual([437]);
    // Each run's own failed checks (PR #105's F5).
    const lint2 = { name: 'e2e', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' },
      details_url: 'https://github.com/owner/demo/actions/runs/440/job/12' };
    const c = await check([], [lint2]);
    expect([c.runs, c.by_run]).toStrictEqual([[437, 440], [[437, ['tests', 'lint']], [440, ['e2e']]]]);
    expect([c.failed_in(440), c.failed_in(999)]).toStrictEqual([['e2e'], []]);
    // A failed commit status, or a check run from outside Actions, can't be re-run: no runs.
    expect((await check([{ context: 'deploy', state: 'failure' }])).runs).toStrictEqual([]);
    expect((await check([], [{ name: 'x', status: 'completed', conclusion: 'failure', app: { slug: 'circleci' },
      details_url: 'https://circleci.com/1' }])).runs).toStrictEqual([]);
  });

  test('a workflow run s attempt and its re run', async () => {
    const gh = new FakeGh({
      'repos/owner/demo/actions/runs/437': { id: 437, run_attempt: 2, status: 'in_progress', conclusion: null,
        html_url: 'https://github.com/owner/demo/actions/runs/437' },
      'repos/owner/demo/actions/runs/437/rerun-failed-jobs': {},
    });
    const c = cli(gh);
    expect(await c.workflow_run(REPO, 437)).toStrictEqual(new WorkflowRun({ id: 437, attempt: 2, status: 'in_progress', conclusion: null,
      url: 'https://github.com/owner/demo/actions/runs/437' }));
    await c.rerun_failed(REPO, 437);
    expect(gh.calls.at(-1)).toStrictEqual(['api', '-X', 'POST', 'repos/owner/demo/actions/runs/437/rerun-failed-jobs']);
  });

  test('no checks yet', async () => {
    expect((await checks([], [['sol-review', 'success']])).state).toBe('none');
  });

  test('a pull request with a conflict', async () => {
    const gh = new FakeGh({
      'repos/owner/demo/pulls/20': { mergeable: false, mergeable_state: 'dirty' },
      'repos/owner/demo/pulls/21': { mergeable: null, mergeable_state: 'unknown' },
    });
    expect(await cli(gh).has_conflict(REPO, 20)).toBe(true);
    expect(await cli(gh).has_conflict(REPO, 21)).toBe(false);
  });

  test('review threads and review bodies as replies', async () => {
    const gh = new FakeGh({
      'repos/owner/demo/pulls/20/comments?per_page=100': [
        { user: { login: 'claude' }, created_at: '2026-11-02T00:00:00Z', body: 'F1 declined', path: 'src/a.ts', line: null, original_line: 9 }],
      'repos/owner/demo/pulls/20/reviews?per_page=100': [
        { user: { login: 'stefan' }, submitted_at: '2026-11-03T00:00:00Z', body: '' },
        { user: { login: 'stefan' }, submitted_at: '2026-11-04T00:00:00Z', body: 'Looks odd' }],
    });
    expect(await cli(gh).review_replies(REPO, 20)).toStrictEqual([
      new Comment({ author: 'claude', created_at: '2026-11-02T00:00:00Z', body: 'F1 declined', path: 'src/a.ts', line: 9 }),
      new Comment({ author: 'stefan', created_at: '2026-11-04T00:00:00Z', body: 'Looks odd' })]);
  });

  test('an issue in any repo', async () => {
    const gh = new FakeGh({ 'repos/other/x/issues/3': { number: 3, title: 'T', body: null } });
    expect(await cli(gh).issue('other/x', 3)).toStrictEqual(new Issue({ number: 3, title: 'T', body: '' }));
  });

  test('branches under a prefix', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/git/matching-refs/heads/claude/': [
      { ref: 'refs/heads/claude/x-5' }, { ref: 'refs/heads/claude/y-6' }] });
    expect(await cli(gh).branches(REPO, 'claude/')).toStrictEqual(['claude/x-5', 'claude/y-6']);
  });

  test('issue comments', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/issues/4/comments?per_page=100': [
      { user: { login: 'stefan' }, created_at: '2026-11-01T10:00:00Z', body: 'Hi' }] });
    expect(await cli(gh).issue_comments(REPO, 4))
      .toStrictEqual([new Comment({ author: 'stefan', created_at: '2026-11-01T10:00:00Z', body: 'Hi' })]);
  });

  test('the newest pull request from a branch in any state', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/pulls?head=owner:claude/x-5&state=all&per_page=100': [
      { number: 21, html_url: 'https://github.com/owner/demo/pull/21', state: 'open', merged_at: null, head: { ref: 'claude/x-5' } },
      { number: 20, html_url: 'https://github.com/owner/demo/pull/20', state: 'closed', merged_at: null, head: { ref: 'claude/x-5' } }] });
    expect(await cli(gh).pull_for_branch(REPO, 'claude/x-5'))
      .toStrictEqual({ number: 21, url: 'https://github.com/owner/demo/pull/21', state: 'open' });
  });

  test('no pull request from a branch', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/pulls?head=owner:claude/x-5&state=all&per_page=100': [] });
    expect(await cli(gh).pull_for_branch(REPO, 'claude/x-5')).toBeNull();
  });
});

/** Ticket 05: one PR afresh, its unresolved review threads, and the expected-head merge. */
describe('MergeCallsTest', () => {
  test('a pr read afresh has its state and whether it can merge', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/pulls/4': {
      number: 4, head: { ref: 'claude/x-1', sha: 'b'.repeat(40) }, base: { ref: 'main' },
      state: 'closed', merged_at: '2026-11-10T00:00:00Z', mergeable: null,
      draft: false, labels: [], title: 'X', body: null, html_url: 'U' } });
    const pr = await cli(gh).pull(REPO, 4);
    expect([pr.head_sha, pr.state, pr.mergeable, pr.base]).toStrictEqual(['b'.repeat(40), 'merged', null, 'main']);
  });

  test('unresolved review threads are counted', async () => {
    const gh = new FakeGh({ graphql: { data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ isResolved: true }, { isResolved: false }] } } } } } });
    expect(await cli(gh).open_threads(REPO, 4)).toBe(1);
    expect(gh.calls[0]).toContain('number=4');
    expect(gh.calls[0]).toContain('-F');   // an Int, not a string
  });

  test('the merge sends the expected head and a merge commit', async () => {
    const gh = new FakeGh({ 'repos/owner/demo/pulls/4/merge': { sha: 'm'.repeat(40), merged: true } });
    expect(await cli(gh).merge(REPO, 4, 'b'.repeat(40))).toBe('m'.repeat(40));
    expect(gh.calls[0]!.slice(0, 3)).toStrictEqual(['api', '-X', 'PUT']);
    expect(gh.inputs).toStrictEqual([{ sha: 'b'.repeat(40), merge_method: 'merge' }]);
  });
});

/** The snapshot's work lists (ticket 32): a repo's open issues with their labels, parent,
 *  sub-issues and blockers, in one paged GraphQL query. */
describe('WorkIssuesTest', () => {
  test('open issues with labels parent sub issues and blockers', async () => {
    type Kw = { body?: string; labels?: string[]; parent?: object; subs?: object[]; blocked?: object[] };
    const node = (n: number, kw: Kw = {}) => ({
      number: n, title: `T${n}`, body: kw.body ?? '',
      url: `https://github.com/owner/demo/issues/${n}`,
      labels: { nodes: (kw.labels ?? []).map((name) => ({ name })) },
      parent: kw.parent ?? null,
      subIssues: { nodes: kw.subs ?? [] },
      blockedBy: { nodes: kw.blocked ?? [] },
    });
    const here = { nameWithOwner: 'owner/demo' };
    const page = { data: { repository: { issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        node(1, { labels: ['spec'], subs: [
          { number: 2, title: 'T2', state: 'CLOSED', repository: here, url: 'https://github.com/owner/demo/issues/2' },
          { number: 4, title: 'T4', state: 'OPEN', repository: here, url: 'https://github.com/owner/demo/issues/4' }] }),
        node(4, { labels: ['ready-for-agent'], parent: { number: 1 }, body: 'Blocked by: #9',
          blocked: [{ number: 2, state: 'CLOSED', repository: here },
            { number: 7, state: 'OPEN', repository: { nameWithOwner: 'other/x' } }] }),
      ] } } } };
    const gh = new FakeGh({ graphql: page });
    const got = await cli(gh).work_issues(REPO);
    expect(got.map((i) => i.number)).toStrictEqual([1, 4]);
    const [spec, four] = got as [typeof got[0], typeof got[0]];
    expect(spec.labels).toStrictEqual(['spec']);
    expect(spec.parent).toBeNull();
    expect(spec.sub_issues.map((s) => [s.number, s.state, s.title])).toStrictEqual([[2, 'closed', 'T2'], [4, 'open', 'T4']]);
    expect(four.parent).toBe(1);
    expect(four.body).toBe('Blocked by: #9');
    expect(four.blocked_by).toStrictEqual([['owner/demo', 2, 'closed'], ['other/x', 7, 'open']]);
    expect(four.url).toBe('https://github.com/owner/demo/issues/4');
    expect(gh.calls[0]).toContain('--paginate');
  });
});

// Not a Python case: Python's merge report prints `type(e).__name__`, so a gh failure must name itself GhError.
describe('GhErrorTest', () => {
  test('a gh failure prints as GhError, as Python names it', () => {
    expect(String(new GhError('HTTP 404'))).toBe('GhError: HTTP 404');
  });
});
