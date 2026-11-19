// Posting a review (#155; today's `tests/test_post.py`): follow-ups filed once as `needs-triage`
// issues, the comment with its ledger, `sol-review` on the reviewed commit only, and the Review
// row in the PR's description naming who reviewed. A gh that fails mid-way leaves what's posted.
import { describe, expect, test } from 'vitest';
import { GhGitHub, type Gh } from '../src/github.ts';
import { decide, readReviews } from '../src/review/ledger.ts';
import { FinishFailed, GitHubPoster, PostFailed, reviewRow, TABLE_END, TABLE_START, withReviewRow } from '../src/review/post.ts';
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
    const poster = new GitHubPoster(gh, (l) => said.push(l), async () => {}, () => AT);
    const url = await poster.post('owner/app', 4, d([PRE]));
    expect(gh.posted.map((p) => p.what)).toEqual(['issue', 'comment']); // post ends at the comment
    await poster.finish('owner/app', 4, d([PRE]), url);
    expect(gh.posted.map((p) => p.what)).toEqual(['issue', 'comment', 'status', 'body']);
    const [issue, comment, status, body] = gh.posted;
    expect(issue).toMatchObject({ labels: ['needs-triage'], title: 'temp folder never removed (src/x.ts)' });
    expect(issue!.body).toContain('<!-- queue-runner-app finding owner/app#4 F1 -->');
    expect(comment!.body).toContain(`F1 → [#101](${issue!.url})`);
    expect(readReviews([{ author: 'me', createdAt: '1', body: comment!.body }])[0]!.findings[0]).toMatchObject({ issue: issue!.url });
    expect(status).toMatchObject({ sha: SHA, context: 'sol-review', state: 'success', url });
    expect(body!.body).toContain(`## Evidence\n\ny\n\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n${TABLE_START}\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| [Review 1](${url}) | Model X high | 2026-11-19 12:34 | \`abcdef1\` | **Clean**, to merge; filed as follow-ups: F1 |\n\n${TABLE_END}\n\n## Merge Danger`);
  });

  test('a finding open as an issue already is linked, not filed again', async () => {
    const gh = new FakeReviewGitHub();
    gh.open['owner/app'] = [{ number: 7, title: 'other', body: 'x <!-- queue-runner-app finding owner/app#4 F1 -->', url: 'https://github.com/owner/app/issues/7' }];
    await new GitHubPoster(gh, () => {}).post('owner/app', 4, d([PRE]));
    expect(gh.posted.map((p) => p.what)).toEqual(['comment']);
    expect(gh.posted[0]!.body).toContain('F1 → [#7]');
  });

  test("another runner's follow-up for the same PR and ID isn't this finding: its IDs are its own reviews'", async () => {
    const gh = new FakeReviewGitHub();
    gh.open['owner/app'] = [
      { number: 7, title: 'other', body: 'x <!-- sol-finding owner/app#4 F1 -->', url: 'https://github.com/owner/app/issues/7' },
      { number: 8, title: 'else', body: 'From https://github.com/owner/app/pull/4\n<sub>Finding F1, filed by sol-pr-review.</sub>', url: 'https://github.com/owner/app/issues/8' },
    ];
    await new GitHubPoster(gh, () => {}).post('owner/app', 4, d([PRE]));
    expect(gh.posted.map((p) => p.what)).toEqual(['issue', 'comment']);
  });

  test('finishing a comment already posted sets sol-review again, and adds its row only if the body lacks it', async () => {
    const gh = new FakeReviewGitHub();
    const url = 'https://github.com/owner/app/pull/4#issuecomment-9';
    gh.bodies['owner/app#4'] = `## Review\n\n${TABLE_START}\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| [Review 1](${url}) | M | t | c | v |\n\n${TABLE_END}\n`;
    await new GitHubPoster(gh, () => {}).finish('owner/app', 4, d(), url);
    expect(gh.posted.map((p) => p.what)).toEqual(['status']);
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

  test('the status or the row failing throws FinishFailed after trying both; finishing again lands them (F14)', async () => {
    const gh = new FakeReviewGitHub();
    const poster = new GitHubPoster(gh, () => {});
    const url = await poster.post('owner/app', 4, d());
    gh.failing.add('status');
    gh.failing.add('body');
    const tried = poster.finish('owner/app', 4, d(), url);
    await expect(tried).rejects.toThrow(FinishFailed);
    await expect(tried).rejects.toThrow(/setting sol-review on abcdef1 failed .*; adding the Review row to the PR body failed/);
    gh.failing.delete('body');
    await expect(poster.finish('owner/app', 4, d(), url)).rejects.toThrow(/^setting sol-review/);
    expect(gh.posted.map((p) => p.what)).toEqual(['comment', 'body']);
    gh.failing.delete('status');
    await poster.finish('owner/app', 4, d(), url);
    expect(gh.posted.map((p) => p.what)).toEqual(['comment', 'body', 'status']); // the row isn't added twice
  });
});

describe('the Review table', () => {
  const row = reviewRow(d([], 'Model Y medium, fallback while Prov A is out of usage'), 'https://u', AT);
  const ours = (...rows: string[]) => `${TABLE_START}\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n${TABLE_END}`;

  test('a body without the section gets it at the end; one with the table gets a row', () => {
    const once = withReviewRow('Some text', row);
    expect(once).toBe(`Some text\n\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n${ours(row)}\n`);
    expect(withReviewRow(once, 'ROW2')).toBe(`Some text\n\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n${ours(row, 'ROW2')}\n`);
  });

  test('the section goes after Evidence, before what follows it', () => {
    expect(withReviewRow('## Summary\n\nx\n\n## Evidence\n\ny\n\n## Merge Danger\n\nz\n', row))
      .toBe(`## Summary\n\nx\n\n## Evidence\n\ny\n\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n${ours(row)}\n\n## Merge Danger\n\nz\n`);
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

  test("the Python runner's Review table is neither read nor rewritten: the app's own table goes below it", () => {
    const python = '## Review\n\n| Step | Time (UTC) | Commit | Verdict |\n|---|---|---|---|\n| [Sol review 1](https://a) | 2026-11-18 10:00 | `1234567` | **Blocking** |\n';
    const once = withReviewRow(`## Summary\n\nx\n\n${python}\n## Notes\n\nn\n`, row);
    expect(once).toBe(`## Summary\n\nx\n\n${python}\n${ours(row)}\n\n## Notes\n\nn\n`);
    // its rows never move into the app's table, however many reviews follow
    expect(withReviewRow(once, 'ROW2')).toBe(`## Summary\n\nx\n\n${python}\n${ours(row, 'ROW2')}\n\n## Notes\n\nn\n`);
  });

  test('a table headed like the app\'s but not between its markers is left as it is', () => {
    const lookalike = '## Review\n\n| Step | Reviewer | Time (UTC) | Commit | Verdict |\n|---|---|---|---|---|\n| hand | x | y | z | w |\n';
    expect(withReviewRow(lookalike, row)).toBe(`${lookalike}\n${ours(row)}\n`);
  });

  test('markers and headings inside a fenced block are only text', () => {
    const fenced = `## Summary\n\n\`\`\`md\n## Review\n\n${ours('| example |')}\n\`\`\`\n`;
    const got = withReviewRow(fenced, row);
    expect(got.startsWith(fenced)).toBe(true); // the example is untouched
    expect(got).toBe(`${fenced}\n## Review\n\n_Rows from the review loop, one per review; each links its comment._\n\n${ours(row)}\n`);
    // and the next review goes in the real one, not the example
    expect(withReviewRow(got, 'ROW2')).toBe(got.replace(`${row}\n`, `${row}\nROW2\n`));
  });

  test('a start marker with no end marker is no table: a new one is added', () => {
    const broken = `## Review\n\n${TABLE_START}\n| r0 |\n`;
    expect(withReviewRow(broken, row)).toBe(`${broken}\n${ours(row)}\n`);
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
