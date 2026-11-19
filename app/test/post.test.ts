// Posting a review (#155; today's `tests/test_post.py`): follow-ups filed once as `needs-triage`
// issues, the comment with its ledger, `sol-review` on the reviewed commit only, and the Review
// row in the PR's description naming who reviewed. A gh that fails mid-way leaves what's posted.
import { describe, expect, test } from 'vitest';
import { GhGitHub, type Gh } from '../src/github.ts';
import { decide, readReviews } from '../src/review/ledger.ts';
import { GitHubPoster, PostFailed, reviewRow, withReviewRow } from '../src/review/post.ts';
import { FakeReviewGitHub } from './fake-github.ts';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const block = (findings: unknown[]) => `Fine.\n\n\`\`\`sol-findings\n${JSON.stringify({ findings })}\n\`\`\``;
const PRE = { id: 'F1', tag: 'pre-existing', class: 'temp folder never removed', file: 'src/x.ts', line: 4, scenario: 'disk fills' };
const d = (findings: unknown[] = [], reviewer = 'Model X high') =>
  decide({ repo: 'owner/app', sha: SHA, round: 1, earlier: [], hasReviewMd: false, reply: block(findings), reviewer, user: 'Pat' });
const AT = new Date('2026-11-19T12:34:00Z');

describe('GitHubPoster', () => {
  test('files a follow-up, posts the comment linking it, sets sol-review on H and adds the row', async () => {
    const gh = new FakeReviewGitHub();
    gh.bodies['owner/app#4'] = '## Summary\n\nx\n\n## Evidence\n\ny\n\n## Merge Danger\n\nz\n';
    const said: string[] = [];
    const url = await new GitHubPoster(gh, (l) => said.push(l), async () => {}, () => AT).post('owner/app', 4, d([PRE]));
    expect(gh.posted.map((p) => p.what)).toEqual(['issue', 'comment', 'status', 'body']);
    const [issue, comment, status, body] = gh.posted;
    expect(issue).toMatchObject({ labels: ['needs-triage'], title: 'temp folder never removed (src/x.ts)' });
    expect(issue!.body).toContain('<!-- sol-finding owner/app#4 F1 -->');
    expect(comment!.body).toContain(`F1 → [#101](${issue!.url})`);
    expect(readReviews([{ author: 'me', createdAt: '1', body: comment!.body }])[0]!.findings[0]).toMatchObject({ issue: issue!.url });
    expect(status).toMatchObject({ sha: SHA, context: 'sol-review', state: 'success', url });
    expect(body!.body).toContain(`## Evidence\n\ny\n\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| [Review 1](${url}) | Model X high | 2026-11-19 12:34 | \`abcdef1\` | **Clean**, to merge; filed as follow-ups: F1 |\n\n## Merge Danger`);
  });

  test('a finding open as an issue already is linked, not filed again', async () => {
    const gh = new FakeReviewGitHub();
    gh.open['owner/app'] = [{ number: 7, title: 'other', body: 'x <!-- sol-finding owner/app#4 F1 -->', url: 'https://github.com/owner/app/issues/7' }];
    await new GitHubPoster(gh, () => {}).post('owner/app', 4, d([PRE]));
    expect(gh.posted.map((p) => p.what)).toEqual(['comment', 'status', 'body']);
    expect(gh.posted[0]!.body).toContain('F1 → [#7]');
  });

  test("a comment that can't be posted fails the review; a failed filing is marked unfiled", async () => {
    const gh = new FakeReviewGitHub();
    gh.failing.add('comment');
    await expect(new GitHubPoster(gh, () => {}).post('owner/app', 4, d())).rejects.toThrow(PostFailed);
    const gh2 = new FakeReviewGitHub();
    gh2.failing.add('issue');
    await new GitHubPoster(gh2, () => {}).post('owner/app', 4, d([PRE]));
    expect(gh2.posted[0]!.body).toContain('Filing F1 as a follow-up issue failed; the next review files it.');
    expect(readReviews([{ author: 'me', createdAt: '1', body: gh2.posted[0]!.body }])[0]!.findings[0]).toMatchObject({ unfiled: true });
  });

  test('the status or the row failing is said, and the review stands', async () => {
    const gh = new FakeReviewGitHub();
    gh.failing.add('status');
    gh.failing.add('body');
    const said: string[] = [];
    await expect(new GitHubPoster(gh, (l) => said.push(l)).post('owner/app', 4, d())).resolves.toContain('issuecomment');
    expect(said.join('\n')).toMatch(/setting sol-review on abcdef1 failed[\s\S]*adding the Review row to the PR body failed/);
  });
});

describe('the Review table', () => {
  const row = reviewRow(d([], 'Model Y medium, fallback while Prov A is out of usage'), 'https://u', AT);
  test('a body without the section gets it at the end; one with the table gets a row', () => {
    const once = withReviewRow('Some text', row);
    expect(once).toBe(`Some text\n\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n${row}\n`);
    expect(withReviewRow(once, 'ROW2')).toBe(once.replace(`${row}\n`, `${row}\nROW2\n`));
  });

  // a row's cells, split on the pipes that aren't escaped
  const cells = (r: string) => r.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());

  test('the reviewer has a column of its own; the Step cell is only the link', () => {
    expect(cells(row).slice(0, 4)).toEqual(['[Review 1](https://u)', 'Model Y medium, fallback while Prov A is out of usage', '2026-11-19 12:34', '`abcdef1`']);
    expect(cells(row)).toHaveLength(5);
  });

  test('a reviewer with a pipe in its name stays in its own cell', () => {
    expect(cells(reviewRow(d([], 'Model | Z'), 'https://u', AT)).slice(0, 2)).toEqual(['[Review 1](https://u)', 'Model \\| Z']);
  });

  test("today's runner's table gets the Reviewer column, its own rows blank in it", () => {
    const old = '## Review\n\n| Step | Time (UTC) | Commit | Verdict |\n|---|---|---|---|\n| [Review 1](https://a) | 2026-11-18 10:00 | `1234567` | **Blocking** \\| odd |\n';
    expect(withReviewRow(old, row)).toBe(`## Review\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| [Review 1](https://a) |  | 2026-11-18 10:00 | \`1234567\` | **Blocking** \\| odd |\n${row}\n`);
  });

  test("today's runner's rows name their reviewer in the Reviewer column, not the Step link", () => {
    const old = '## Review\n\n| Step | Time (UTC) | Commit | Verdict |\n|---|---|---|---|\n'
      + '| [Sol review 1](https://a) | 2026-11-18 10:00 | `1234567` | **Blocking** |\n'
      + '| [Review 2, Opus 5.5 high, fallback while Codex is out of usage](https://b) | 2026-11-18 11:00 | `89abcde` | **Clean** |\n';
    const got = withReviewRow(old, row).split('\n');
    expect(got.slice(4, 6)).toEqual([
      '| [Review 1](https://a) | Sol | 2026-11-18 10:00 | `1234567` | **Blocking** |',
      '| [Review 2](https://b) | Opus 5.5 high, fallback while Codex is out of usage | 2026-11-18 11:00 | `89abcde` | **Clean** |',
    ]);
    for (const l of got.filter((x) => x.startsWith('|'))) expect(cells(l)).toHaveLength(5);
  });

  test("another table after today's runner's table is left as it is, and the row goes in the review table", () => {
    const other = '| Area | Owner |\n|---|---|\n| app | me |';
    const old = `## Review\n\n| Step | Time (UTC) | Commit | Verdict |\n|---|---|---|---|\n| [Sol review 1](https://a) | 2026-11-18 10:00 | \`1234567\` | **Blocking** |\n\n${other}\n`;
    expect(withReviewRow(old, row)).toBe(`## Review\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| [Review 1](https://a) | Sol | 2026-11-18 10:00 | \`1234567\` | **Blocking** |\n${row}\n\n${other}\n`);
  });

  test('a hand-written table before the review table: the next row goes in the review table, not a new one', () => {
    const once = withReviewRow('## Review\n\n| A | B |\n|---|---|\n| 1 | 2 |\n', '| r1 |');
    expect(withReviewRow(once, '| r2 |')).toBe('## Review\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| r1 |\n| r2 |\n');
  });

  test('text right after a hand-written table stays out of the new review table', () => {
    expect(withReviewRow('## Review\n\n| A | B |\n|---|---|\nNotes.\n', 'R')).toBe('## Review\n\n| A | B |\n|---|---|\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\nR\n\nNotes.\n');
  });

  test('a hand-written table keeps its rows; ours starts below it', () => {
    expect(withReviewRow('## Review\n\n| A | B |\n|---|---|\n| 1 | 2 |\n', 'R')).toContain('| 1 | 2 |\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\nR\n');
  });
});

describe('gh', () => {
  test('a comment goes on stdin as JSON, never on the command line', async () => {
    const runs: { args: string[]; input?: string }[] = [];
    const gh: Gh = async (args, _cwd, input) => {
      runs.push({ args, input });
      return { code: 0, stdout: JSON.stringify({ html_url: 'https://github.com/o/a/pull/4#c1' }), stderr: '' };
    };
    const body = 'x'.repeat(40_000);
    await expect(new GhGitHub(gh).postComment('o/a', 4, body)).resolves.toBe('https://github.com/o/a/pull/4#c1');
    expect(runs[0]!.args).toEqual(['api', '-X', 'POST', 'repos/o/a/issues/4/comments', '--input', '-']);
    expect(JSON.parse(runs[0]!.input!)).toEqual({ body });
  });

  // gh --paginate --slurp answers every page, each one GitHub's object for that page
  const paged = (answers: Record<string, unknown[]>): Gh => async (args) => {
    const key = args.find((a) => a.startsWith('repos/'))!;
    if (!args.includes('--paginate') || !args.includes('--slurp')) return { code: 0, stdout: JSON.stringify(answers[key]![0]), stderr: '' };
    return { code: 0, stdout: JSON.stringify(answers[key]), stderr: '' };
  };
  const ok = (name: string) => ({ name, status: 'completed', conclusion: 'success' });

  test('checks leave sol-review out, and wait on any still running', async () => {
    const answers: Record<string, unknown[]> = {
      'repos/o/a/commits/h/check-runs?per_page=100': [{ check_runs: [ok('tests')] }],
      'repos/o/a/commits/h/status?per_page=100': [{ statuses: [{ context: 'sol-review', state: 'failure' }, { context: 'lint', state: 'pending' }] }],
    };
    expect(await new GhGitHub(paged(answers)).checks('o/a', 'h')).toEqual({ state: 'pending', pending: ['lint'], failed: [] });
    answers['repos/o/a/commits/h/status?per_page=100'] = [{ statuses: [{ context: 'sol-review', state: 'failure' }] }];
    expect(await new GhGitHub(paged(answers)).checks('o/a', 'h')).toEqual({ state: 'passed', pending: [], failed: [] });
  });

  test('a check run that failed on a later page fails the checks', async () => {
    const answers: Record<string, unknown[]> = {
      'repos/o/a/commits/h/check-runs?per_page=100': [
        { check_runs: Array.from({ length: 100 }, (_, i) => ok(`job ${i}`)) },
        { check_runs: [{ name: 'deploy', status: 'completed', conclusion: 'failure' }] },
      ],
      'repos/o/a/commits/h/status?per_page=100': [{ statuses: [] }],
    };
    expect(await new GhGitHub(paged(answers)).checks('o/a', 'h')).toEqual({ state: 'failed', pending: [], failed: ['deploy'] });
  });

  test('a status still pending on a later page holds the checks', async () => {
    const answers: Record<string, unknown[]> = {
      'repos/o/a/commits/h/check-runs?per_page=100': [{ check_runs: [ok('tests')] }],
      'repos/o/a/commits/h/status?per_page=100': [
        { statuses: Array.from({ length: 100 }, (_, i) => ({ context: `ci ${i}`, state: 'success' })) },
        { statuses: [{ context: 'e2e', state: 'pending' }] },
      ],
    };
    expect(await new GhGitHub(paged(answers)).checks('o/a', 'h')).toEqual({ state: 'pending', pending: ['e2e'], failed: [] });
  });
});
