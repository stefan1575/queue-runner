// The review ledger (#155; today's `tests/test_ledger.py`, the cases that decide a verdict):
// the comment the app posts is read back as the PR's state, and the verdict and outcome come from
// the reply's sol-findings block, never its prose.
import { describe, expect, test } from 'vitest';
import { decide, nextRound, readReview, readReviews, ReviewFailed, runnerPost, state, withIssues, type DecideInput, type Review } from '../src/review/ledger.ts';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const SHA2 = '1234567abcdef1234567abcdef1234567abcdef1';
const reply = (findings: unknown[], earlier?: unknown[], prose = 'Looked at it all.') =>
  `${prose}\n\n\`\`\`sol-findings\n${JSON.stringify({ findings, ...(earlier ? { earlier } : {}) })}\n\`\`\`\n`;
const important = (id: string, part: object = {}) =>
  ({ id, tag: 'important', class: 'unchecked input', file: 'src/a.ts', line: 10, scenario: 'empty input crashes', ...part });
const input = (part: Partial<DecideInput>): DecideInput =>
  ({ repo: 'owner/app', sha: SHA, round: 1, earlier: [], hasReviewMd: false, reply: reply([]), reviewer: 'Model X high', user: 'Pat', ...part });
/** The review the comment of `d` reads back as. */
const posted = (body: string, at = '2026-11-19T10:00:00Z'): Review => readReview(body, at)!;

describe('decide', () => {
  test('no findings is clean, to merge, and its comment reads back as the PR state', () => {
    const d = decide(input({}));
    expect(d).toMatchObject({ verdict: 'clean', outcome: 'merge', status: { state: 'success' } });
    expect(d.status.description).toBe('Model X high: Clean: no Important finding, 0 nits');
    expect(d.body).toMatch(/^## Sol review 1 · Clean · Model X high\n/);
    expect(d.body).toContain("Posted by the queue runner from Pat's PC.");
    expect(d.body).toContain('```sol-findings');
    expect(posted(d.body)).toMatchObject({ round: 1, verdict: 'clean', sha: SHA, findings: [] });
  });

  test('an Important finding with its evidence blocks, to fix; the next round reads it open', () => {
    const d = decide(input({ reply: reply([important('F1')]) }));
    expect(d).toMatchObject({ verdict: 'blocking', outcome: 'fix', status: { state: 'failure' } });
    expect(d.status.description).toContain('Blocking: 1 Important finding (F1)');
    expect(d.body).toContain('[`src/a.ts:10`](https://github.com/owner/app/blob/' + SHA + '/src/a.ts#L10)');
    const earlier = [posted(d.body)];
    expect(state(earlier)).toMatchObject([{ id: 'F1', status: 'open', raised: 1 }]);
    expect(nextRound(earlier)).toBe(2);
  });

  test('an Important finding without file and line or a scenario counts as a nit', () => {
    const d = decide(input({ reply: reply([important('F1', { line: null })]) }));
    expect(d.verdict).toBe('clean');
    expect(d.findings[0]).toMatchObject({ tag: 'nit', was: 'important' });
  });

  test("an Important finding that doesn't say how it comes up in real use is read as a nit and doesn't block", () => {
    const d = decide(input({ reply: reply([important('F1', { scenario: '' })]) }));
    expect(d).toMatchObject({ verdict: 'clean', outcome: 'merge' });
    expect(d.findings[0]).toMatchObject({ tag: 'nit', was: 'important' });
    expect(d.body).toContain('F1 was tagged Important without a file and line plus how it comes up in real use');
  });

  test('a finding the reviewer marks as a missing or thin screenshot never blocks on its own; a wrong one does', () => {
    const missing = important('F1', { class: 'visible change without screenshots', scenario: '', cost: 'a reader cannot see the new table', rule: 'a visible change needs screenshots', missing_screenshot: true });
    const thin = important('F2', { class: 'too few for the states changed', scenario: '', cost: 'the empty state is unseen', rule: 'docs/flow.md', missing_screenshot: true });
    const d = decide(input({ reply: reply([missing, thin]) }));
    expect(d.verdict).toBe('clean');
    expect(d.findings.map((f) => [f.id, f.tag, f.was])).toEqual([['F1', 'nit', 'important'], ['F2', 'nit', 'important']]);
    expect(d.body).toContain('F1, F2 were tagged Important for screenshots that are missing or thin, which never block on their own, so they count as a nit.');
    expect(JSON.stringify(d.findings)).not.toContain('"shots"');
    const wrong = important('F3', { class: 'screenshot taken before the change', scenario: '', cost: 'a reader is told the old table is the new one', rule: 'a screenshot shows the screen as it is' });
    expect(decide(input({ reply: reply([wrong]) }))).toMatchObject({ verdict: 'blocking', findings: [{ id: 'F3', tag: 'important' }] });
  });

  test('a wrong shot worded like a missing one still blocks: only the mark makes a missing screenshot (F16)', () => {
    const wrong = important('F1', { class: 'screenshot shows a missing Save button', scenario: '', cost: 'the Settings shot shows a missing Save button the change keeps', rule: 'a screenshot shows the screen as it is' });
    const d = decide(input({ reply: reply([wrong]) }));
    expect(d).toMatchObject({ verdict: 'blocking', findings: [{ id: 'F1', tag: 'important' }] });
    expect(d.body).not.toContain('screenshots that are missing or thin');
    const unmarked = important('F2', { class: 'visible change without screenshots', scenario: '', cost: 'a reader cannot see it', rule: 'no screenshots for a visible change' });
    expect(decide(input({ reply: reply([unmarked]) })).verdict).toBe('blocking');
  });

  test('a fixed finding clears the block in review 2', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const d = decide(input({ round: 2, sha: SHA2, earlier: [r1], reply: reply([], [{ id: 'F1', status: 'fixed' }]) }));
    expect(d).toMatchObject({ verdict: 'clean', outcome: 'merge' });
    expect(d.findings).toMatchObject([{ id: 'F1', status: 'fixed', closed: 2 }]);
    expect(d.body).toContain(`the change since ${SHA.slice(0, 7)}`);
  });

  test('an earlier finding given no status stays open, and is said', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const d = decide(input({ round: 2, earlier: [r1], reply: reply([]) }));
    expect(d.verdict).toBe('blocking');
    expect(d.unaddressed).toEqual(['F1']);
  });

  test('a new Important finding in an earlier class stops for the user', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const d = decide(input({ round: 2, earlier: [r1], reply: reply([important('F2', { file: 'src/b.ts' })], [{ id: 'F1', status: 'fixed' }]) }));
    expect(d.outcome).toBe('stop');
    expect(d.signals.map((s) => s.signal)).toEqual(['repeated-class']);
    expect(d.body).toContain('the loop stops here for Pat');
  });

  test('a fixed finding raised again is reopened, a stop', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const r2 = posted(decide(input({ round: 2, earlier: [r1], reply: reply([], [{ id: 'F1', status: 'fixed' }]) })).body);
    const d = decide(input({ round: 3, earlier: [r1, r2], reply: reply([important('F1')]) }));
    expect(d.signals.map((s) => s.signal)).toEqual(['reopened']);
  });

  test('a decline kept open is a stop', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const d = decide(input({ round: 2, earlier: [r1], reply: reply([], [{ id: 'F1', status: 'decline-kept' }]) }));
    expect(d.outcome).toBe('stop');
    expect(d.kept).toEqual(['F1']);
  });

  test('review 3 still blocking is an approach note', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const r2 = posted(decide(input({ round: 2, earlier: [r1], reply: reply([], [{ id: 'F1', status: 'open' }]) })).body);
    const d = decide(input({ round: 3, earlier: [r1, r2], reply: reply([], [{ id: 'F1', status: 'open' }]) }));
    expect(d.outcome).toBe('approach-note');
  });

  test('a finding listed again under a new ID keeps its old one', () => {
    const r1 = posted(decide(input({ reply: reply([important('F1')]) })).body);
    const d = decide(input({ round: 2, earlier: [r1], reply: reply([important('F7')]) }));
    expect(d.findings.map((f) => f.id)).toEqual(['F1']);
    expect(d.outcome).toBe('fix');
  });

  test('nits past five are dropped and named', () => {
    const nits = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `F${n}`, tag: 'nit', class: 'style' }));
    const d = decide(input({ reply: reply(nits) }));
    expect(d.findings).toHaveLength(5);
    expect(d.body).toContain('Nits past the first 5 are left out: F6.');
  });

  test('a Pre-existing finding is to be filed, once, and a data-losing one tagged Important blocks', () => {
    const pre = { id: 'F1', tag: 'pre-existing', class: 'unbounded cache', file: 'src/c.ts', line: 3, scenario: 'memory grows' };
    const d = decide(input({ reply: reply([pre]) }));
    expect(d.verdict).toBe('clean');
    expect(d.issues).toMatchObject([{ id: 'F1', title: 'unbounded cache (src/c.ts)' }]);
    const body = withIssues(d, new Map([['F1', 'https://github.com/owner/app/issues/9']]));
    expect(body).toContain('F1 → [#9](https://github.com/owner/app/issues/9)');
    const r1 = posted(body);
    expect(r1.findings[0]).toMatchObject({ id: 'F1', status: 'filed', issue: 'https://github.com/owner/app/issues/9' });
    expect(decide(input({ round: 2, earlier: [r1], reply: reply([pre]) })).issues).toEqual([]);
  });

  test('a filing that failed is unfiled, and the next review files it', () => {
    const pre = { id: 'F1', tag: 'pre-existing', class: 'leak', file: 'src/c.ts', line: 3, scenario: 'x' };
    const d = decide(input({ reply: reply([pre]) }));
    const r1 = posted(withIssues(d, new Map(), ['F1']));
    expect(decide(input({ round: 2, earlier: [r1], reply: reply([]) })).issues.map((i) => i.id)).toEqual(['F1']);
  });

  test('local paths become GitHub links at H', () => {
    const d = decide(input({ wt: 'C:/state/checkouts/app-pr4', runDir: 'C:/state/runs/app-pr4-r1', reply: reply([important('F1', { file: 'C:\\state\\checkouts\\app-pr4\\src\\a.ts:12', line: null })], undefined, 'See [x](C:/state/checkouts/app-pr4/src/a.ts:12) and [the diff](C:/state/runs/app-pr4-r1/change.diff).') }));
    expect(d.findings[0]).toMatchObject({ file: 'src/a.ts', line: 12 });
    expect(d.body).toContain(`See [x](https://github.com/owner/app/blob/${SHA}/src/a.ts#L12) and the diff.`);
  });

  test('a reply without a readable block fails', () => {
    expect(() => decide(input({ reply: 'Looks good to me.' }))).toThrow(ReviewFailed);
    expect(() => decide(input({ reply: '```sol-findings\n{not json\n```' }))).toThrow(ReviewFailed);
    expect(() => decide(input({ reply: reply([{ id: 'F1', tag: 'blocker' }]) }))).toThrow(/not one of/);
  });
});

describe('earlier reviews', () => {
  test("only the app's own reviews are read: the Python runner's, the old script's and hand-posted ones are not", () => {
    const hand = '## Sol review 2 · Blocking\n\n<!-- sol-review round=2 head=1234567 -->\n```sol-findings\n{"findings":[{"id":"F1","tag":"important","status":"open"}]}\n```';
    const python = '<!-- sol-pr-review round=3 verdict=blocking sha=abc findings=W10= -->';
    const own = '<!-- queue-runner-app review round=1 verdict=clean sha=def findings=W10= -->';
    const reviews = readReviews([
      { author: 'a', createdAt: '1', body: 'Nice work' },
      { author: 'a', createdAt: '2', body: python },
      { author: 'a', createdAt: '3', body: hand },
      { author: 'a', createdAt: '4', body: own },
    ]);
    expect(reviews.map((r) => [r.round, r.verdict, r.sha])).toEqual([[1, 'clean', 'def']]);
    // a PR only the Python runner reviewed starts at review 1
    expect(nextRound(readReviews([{ author: 'a', createdAt: '2', body: python }]))).toBe(1);
    // every one of them is the runner's, not something a person said
    for (const b of [hand, python, own, '<!-- queue-runner stop -->']) expect(runnerPost(b)).toBe(true);
    expect(runnerPost('Thanks!')).toBe(false);
  });

  test("the app's comment carries its own marker, and reads back", () => {
    const got = decide(input({ reply: reply([]) }));
    expect(got.body).toContain('<!-- queue-runner-app review round=1 verdict=clean sha=');
    expect(got.body).not.toContain('sol-pr-review');
    expect(readReviews([{ author: 'a', createdAt: '1', body: got.body }])).toMatchObject([{ round: 1, verdict: 'clean' }]);
  });

  test("a marker whose findings can't be read isn't a review", () => {
    expect(readReview('<!-- queue-runner-app review round=1 verdict=clean sha=abc findings=!!! -->')).toBeNull();
  });
});
