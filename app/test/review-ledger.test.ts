// The review ledger, ported from `tests/test_ledger.py` case for case (#220): earlier reviews read
// from a PR's comments, and decide(), which works out a review's verdict and outcome from Sol's
// sol-findings block, never from its prose.
import { describe, expect, test } from 'vitest';
import { Comment } from '../src/github-seam.ts';
import { decide, next_round, read_reviews, SolFailed, state, type DecideOptions, type Finding } from '../src/review-ledger.ts';

const REPO = 'owner/repo', N = 7;
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), H3 = 'c'.repeat(40);

/** Python's `json.dumps` with its default separators, as the old script wrote its markers. */
const dumps = (x: unknown): string => JSON.stringify(x).replace(/("(?:[^"\\]|\\.)*")|([,:])/g, (_, s, p) => s ?? `${p} `);

function old_marker(rnd: number, verdict: string, sha: string, findings: unknown[]): string {
  const data = Buffer.from(dumps(findings)).toString('base64');
  return `<!-- sol-pr-review round=${rnd} verdict=${verdict} sha=${sha} findings=${data} tokens=0 -->`;
}

const comment = (body: string, at = '2026-11-06T00:00:00Z', author = 'stefan1575') => new Comment({ author, created_at: at, body });

function reply({ findings = [] as Finding[], earlier = null as unknown[] | null, prose = 'Looks fine.' } = {}): string {
  const data: Record<string, unknown> = { findings: [...findings] };
  if (earlier !== null) data.earlier = earlier;
  return `${prose}\n\n\`\`\`sol-findings\n${dumps(data)}\n\`\`\`\n`;
}

function important(fid: string, { cls = 'write logged wrongly', file = 'src/a.ts', line = 10 as number | null,
  scenario = 'this input, that wrong result' } = {}): Finding {
  return { id: fid, tag: 'important', class: cls, file, line, scenario };
}

const nit = (fid: string): Finding => ({ id: fid, tag: 'nit', class: 'naming', file: 'src/a.ts', line: 1 });

/** The PR's comments after the old script's review 1 raised `findings` (each open). */
function review1(findings: Finding[], verdict = 'blocking', sha = H1): Comment[] {
  const state_ = findings.map((f) => ({ ...f, status: 'open', raised: 1 }));
  return [comment(`## Sol review 1 · ${verdict[0]!.toUpperCase()}${verdict.slice(1)}\n\n...\n\n` + old_marker(1, verdict, sha, state_))];
}

describe('ReadReviewsTest', () => {
  test("reads the old script's marker with its base64 findings", () => {
    const comments = [comment('Opened.'), ...review1([important('F1')])];
    const [r, ...rest] = read_reviews(comments);
    expect(rest).toEqual([]);
    expect([r!.round, r!.verdict, r!.sha]).toEqual([1, 'blocking', H1]);
    expect(r!.findings.map((f) => f.id)).toEqual(['F1']);
  });

  test('reads a hand run review with its visible ledger', () => {
    // PR #168's format: posted by Sol itself from a T3 child, 2026-11-06.
    const body = `<!-- sol-review round=1 head=${H1} -->\n## Sol review 1 · Blocking\n\nProse.\n\n`
      + '```sol-findings\n' + dumps({ round: 1, head: H1, findings: [{ ...important('F1'), status: 'open' }] }) + '\n```\n';
    const reviews = read_reviews([comment(body)]);
    expect(reviews).toHaveLength(1);
    const r = reviews[0]!;
    expect([r.round, r.verdict, r.sha]).toEqual([1, 'blocking', H1]);
    const fs = state([r]);
    expect(fs).toHaveLength(1);
    expect([fs[0]!.id, fs[0]!.status, fs[0]!.raised]).toEqual(['F1', 'open', 1]);
  });

  test('a failed review and other comments are not reviews', () => {
    const comments = [comment('## Sol review failed\n\nNo block.\n\n<!-- sol-pr-review failed -->'), comment('Thanks!')];
    expect(read_reviews(comments)).toEqual([]);
    expect(next_round([])).toBe(1);
  });

  test("a review whose ledger can't be read isn't counted", () => {
    // Sol review F1: it replaced the PR's state with no findings, so F1 was lost.
    const hand = `<!-- sol-review round=2 head=${H2} -->\n## Sol review 2 · Clean\n\n`
      + '```sol-findings\n{"findings": [oops\n```\n';
    const corrupt = '<!-- sol-pr-review round=2 verdict=clean sha=' + H2 + ' findings=!!notbase64 -->';
    const empty = '<!-- sol-pr-review round=2 verdict=clean sha=' + H2 + ' findings= tokens=0 -->';
    for (const bad of [hand, `<!-- sol-review round=2 head=${H2} -->\nNo block.`, corrupt, empty]) {
      const earlier = read_reviews([...review1([important('F1')]), comment(bad)]);
      expect(earlier.map((r) => r.round), bad.slice(0, 40)).toEqual([1]);
      expect(state(earlier).map((f) => f.id), bad.slice(0, 40)).toEqual(['F1']);
    }
  });

  test('a marker from before findings were recorded counts with none', () => {
    // The old script's markers before 2026-11-05 (leads-dashboard #139) end at sha=, e.g. #88.
    const reviews = read_reviews([comment(`<!-- sol-pr-review round=1 verdict=clean sha=${H1} -->`)]);
    expect(reviews.map((r) => [r.round, r.findings])).toEqual([[1, []]]);
  });

  test('numbering carries on from the newest review', () => {
    const comments = [...review1([important('F1')]), comment('## Sol review 2 · Clean\n\n' + old_marker(2, 'clean', H2, []))];
    expect(next_round(read_reviews(comments))).toBe(3);
  });

  test('an old marker without statuses counts pre existing as filed', () => {
    const body = old_marker(1, 'blocking', H1, [important('F1'), { id: 'F2', tag: 'pre-existing', class: 'x' }]);
    const found = Object.fromEntries(state(read_reviews([comment(body)])).map((f) => [f.id, f.status]));
    expect(found).toEqual({ F1: 'open', F2: 'filed' });
  });
});

describe('DecideTest', () => {
  const run = (reply_text: string, earlier: Comment[] = [], { rnd = null as number | null, sha = H2, ...kw }: DecideOptions & { rnd?: number | null; sha?: string } = {}) => {
    const reviews = read_reviews(earlier);
    return decide(REPO, N, sha, rnd || next_round(reviews), reviews, false, reply_text, kw);
  };

  test('no important finding is clean and merges', () => {
    const d = run(reply({ findings: [nit('F1')] }));
    expect([d.verdict, d.outcome, d.signals]).toEqual(['clean', 'merge', []]);
    expect(d.status.state).toBe('success');
  });

  test('an important finding with evidence blocks and goes back to fix', () => {
    const d = run(reply({ findings: [important('F1')] }));
    expect([d.verdict, d.outcome]).toEqual(['blocking', 'fix']);
    expect(d.status.state).toBe('failure');
    expect(d.status.description).toContain('F1');
  });

  test('the verdict comes from the ledger not the prose', () => {
    let d = run(reply({ findings: [important('F1')], prose: 'All clean, ship it!' }));
    expect(d.verdict).toBe('blocking');
    d = run(reply({ prose: 'Blocking: this is badly broken.' }));
    expect(d.verdict).toBe('clean');
  });

  test('an important finding without evidence counts as a nit', () => {
    const d = run(reply({ findings: [important('F1', { line: null })] }));
    expect(d.verdict).toBe('clean');
    expect(d.body).toContain('F1 was tagged Important without');
  });

  test('nits past five are left out and named', () => {
    const d = run(reply({ findings: [1, 2, 3, 4, 5, 6, 7].map((i) => nit(`F${i}`)) }));
    expect(d.findings.map((f) => f.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    expect(d.body).toContain('Nits past the first 5 are left out: F6, F7.');
  });

  test('a reply without a readable ledger fails', () => {
    for (const bad of ['No block at all.', '```sol-findings\nnot json\n```',
      reply({ findings: [{ id: 'F1', tag: 'major' }] }),
      reply({ findings: [nit('F1'), nit('F1')] }),
      '```sol-findings\n{"verdict": "clean"}\n```']) {
      expect(() => run(bad), bad).toThrow(SolFailed);
    }
  });

  test('a fixed finding closes and a clean review follows', () => {
    const d = run(reply({ earlier: [{ id: 'F1', status: 'fixed' }] }), review1([important('F1')]));
    expect([d.verdict, d.outcome]).toEqual(['clean', 'merge']);
    expect(d.findings).toHaveLength(1);
    expect([d.findings[0]!.status, d.findings[0]!.closed]).toEqual(['fixed', 2]);
  });

  test('an earlier finding given no status stays open', () => {
    const d = run(reply(), review1([important('F1')]));
    expect([d.verdict, d.unaddressed]).toEqual(['blocking', ['F1']]);
  });

  test('a new important finding in an earlier class stops', () => {
    const d = run(reply({ findings: [important('F2', { cls: 'Write  logged, wrongly' })], earlier: [{ id: 'F1', status: 'fixed' }] }),
      review1([important('F1', { cls: 'write logged wrongly' })]));
    expect(d.outcome).toBe('stop');
    expect(d.signals.map((s) => [s.signal, s.ids])).toEqual([['repeated-class', ['F2']]]);
  });

  test('a closed finding raised again reopens and stops', () => {
    const comments = [...review1([important('F1')]), comment('## Sol review 2 · Clean\n\n' + old_marker(2, 'clean', H2, [
      { ...important('F1'), status: 'fixed', raised: 1, closed: 2 }]))];
    const d = run(reply({ findings: [important('F1')] }), comments, { sha: H3 });
    expect(d.outcome).toBe('stop');
    expect(d.signals.map((s) => s.signal)).toEqual(['reopened']);
    expect(d.body).toContain('F1 (fixed in review 2)');
  });

  test('a decline sol keeps stops', () => {
    const d = run(reply({ earlier: [{ id: 'F1', status: 'decline-kept' }] }), review1([important('F1')]));
    expect([d.outcome, d.kept]).toEqual(['stop', ['F1']]);
    expect(d.signals.map((s) => s.signal)).toEqual(['decline-kept']);
  });

  test('an accepted decline closes', () => {
    const d = run(reply({ earlier: [{ id: 'F1', status: 'decline-accepted' }] }), review1([important('F1')]));
    expect([d.verdict, d.outcome]).toEqual(['clean', 'merge']);
  });

  test('review 3 still blocking gets the approach note instead of a fix', () => {
    let d = run(reply({ earlier: [{ id: 'F1', status: 'open' }] }), review1([important('F1')]), { rnd: 3 });
    expect([d.verdict, d.outcome]).toEqual(['blocking', 'approach-note']);
    // and so does every blocking review after it: there's no spend guard any more
    d = run(reply({ earlier: [{ id: 'F1', status: 'open' }] }), review1([important('F1')]), { rnd: 4 });
    expect(d.outcome).toBe('approach-note');
  });

  test('review 2 still blocking goes back to fix', () => {
    const d = run(reply({ earlier: [{ id: 'F1', status: 'open' }] }), review1([important('F1')]));
    expect(d.outcome).toBe('fix');
  });

  test('a pre existing finding is filed once', () => {
    const pre = { id: 'F2', tag: 'pre-existing', class: 'old bug', file: 'src/b.ts', line: 3, scenario: 's' };
    let d = run(reply({ findings: [pre] }));
    expect(d.issues.map((i) => i.id)).toEqual(['F2']);
    expect(d.verdict).toBe('clean');
    const comments = [comment(old_marker(1, 'clean', H1, [{ ...pre, status: 'filed', raised: 1 }]))];
    d = run(reply({ findings: [pre] }), comments);
    expect(d.issues).toEqual([]);
  });

  test('a finding listed again under a new id keeps its earlier one', () => {
    const d = run(reply({ findings: [important('F7')] }), review1([important('F1')]));
    expect(d.findings.map((f) => f.id)).toEqual(['F1']);
    expect(d.body).toContain('F7 is F1');
    expect(d.signals).toEqual([]);   // not a new finding in an earlier class
  });

  test('an unchanged finding is not reposted as new', () => {
    const d = run(reply({ findings: [important('F1')] }), review1([important('F1')]));
    const [above, findings] = d.body.split('### Findings');
    expect(findings).toContain('No new findings.');
    expect(above).toContain('Still open (listed again)');
  });

  test('a filed finding listed again keeps its issue url', () => {
    const url = 'https://github.com/owner/repo/issues/40';
    const pre = { id: 'F2', tag: 'pre-existing', class: 'old bug', file: 'src/b.ts', line: 3, scenario: 's' };
    const comments = [comment(old_marker(1, 'clean', H1, [{ ...pre, status: 'filed', raised: 1, issue: url }]))];
    const d = run(reply({ findings: [pre] }), comments);
    expect(d.issues).toEqual([]);
    const reviews = read_reviews([comment(d.body)]);
    expect(reviews).toHaveLength(1);
    expect(state(reviews).map((f) => f.issue ?? null)).toEqual([url]);
  });

  test("the comment carries a ledger that reads back as the PR's state", () => {
    const d = run(reply({ findings: [important('F1'), nit('F2')], prose: 'Two things.' }));
    expect(d.body.startsWith('## Sol review 1 · Blocking')).toBe(true);
    expect(d.body).toContain('Two things.');
    expect(d.body).toContain('```sol-findings');
    const reviews = read_reviews([comment(d.body)]);
    expect(reviews).toHaveLength(1);
    const r = reviews[0]!;
    expect([r.round, r.verdict, r.sha]).toEqual([1, 'blocking', H2]);
    expect(Object.fromEntries(state([r]).map((f) => [f.id, f.status]))).toEqual({ F1: 'open', F2: 'open' });
  });

  test('local paths in findings become repo relative', () => {
    const f = important('F1', { file: 'C:/wt/pr7/src/a.ts:12', line: null });
    const d = run(reply({ findings: [f] }), [], { wt: 'C:/wt/pr7', rundir: 'C:/runs/r1' });
    expect(d.findings).toHaveLength(1);
    expect([d.findings[0]!.file, d.findings[0]!.line]).toEqual(['src/a.ts', 12]);
  });

  test('a force push is said in the comment', () => {
    const d = run(reply(), review1([]), { gone: true });
    expect(d.body).toContain("isn't in this branch's history any more");
  });
});
