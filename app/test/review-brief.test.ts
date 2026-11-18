// The review brief (#155): today's review template ported, self-contained (docs/app.md, Rules),
// working in the app's checkout of H; from review 2 it carries the open findings, the classes so
// far, the IDs used and the replies since.
import { describe, expect, test } from 'vitest';
import { REVIEW_TEMPLATE, reviewBrief, type ReviewBriefInput } from '../src/briefs/review.ts';
import { decide, readReview } from '../src/review/ledger.ts';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const input: ReviewBriefInput = {
  github: 'owner/app', number: 4, title: 'Add a thing', branch: 'claude/add-4', base: 'main', sha: SHA, round: 1,
  earlier: [], gone: false, checkout: 'C:/state/checkouts/app-pr4', runDir: 'C:/state/runs/app-pr4-r1', projectFolder: 'C:/code/app',
  files: ["`change.diff`: the PR's whole diff against `main`"], hasAgents: true, guidelines: null, tests: 'Run `npm test`.', since: [],
};

describe('the template', () => {
  test('names no skill, starts no slash command, points at nothing outside the repo and names no person', () => {
    expect(REVIEW_TEMPLATE).not.toMatch(/\bskills?\b/i);
    expect(REVIEW_TEMPLATE).not.toMatch(/^\s*\/[a-z][\w-]*\b/m);
    expect(REVIEW_TEMPLATE).not.toMatch(/~\/|\b[A-Za-z]:[\\/]/);
    expect(REVIEW_TEMPLATE).not.toContain('Stefan');
  });
});

describe('reviewBrief', () => {
  test('review 1: the checkout, the exact commit, the inputs, and nothing left unfilled', () => {
    const b = reviewBrief(input);
    expect(b).toContain('it means `C:/state/checkouts/app-pr4`');
    expect(b).toContain("starts in the repo's own clone (`C:/code/app`)");
    expect(b).toContain(`exactly ${SHA} (abcdef1)`);
    expect(b).toContain("- `change.diff`: the PR's whole diff against `main`");
    expect(b).toContain('4. **Tests:** do the tests cover the behaviour it changes? Run `npm test`.');
    expect(b).toContain('holding every finding as JSON (an empty list if there are none).');
    expect(b).not.toMatch(/\$[a-z]+/);
    expect(b).not.toContain('This is review');
  });

  test('review 2: the earlier findings, classes, IDs and replies, and REVIEW.md in full', () => {
    const r1 = decide({ repo: 'owner/app', sha: SHA, round: 1, earlier: [], hasReviewMd: false, reviewer: 'M', user: 'Pat',
      reply: '```sol-findings\n{"findings":[{"id":"F1","tag":"important","class":"unchecked input","file":"src/a.ts","line":3,"scenario":"crash"}]}\n```' });
    const b = reviewBrief({ ...input, round: 2, earlier: [readReview(r1.body, '2026-11-19T10:00:00Z')!], guidelines: 'Never report style.\n',
      since: [{ author: 'sam', createdAt: '2026-11-19T11:00:00Z', body: 'F1 declined: see test', path: 'src/a.ts', line: 3 }] });
    expect(b).toContain('6. **This is review 2.** You last reviewed abcdef1.');
    expect(b).toContain('(used so far: F1)');
    expect(b).toContain('8. **Classes raised so far:** "unchecked input".');
    expect(b).toContain("## This repo's review guidelines (`REVIEW.md`)");
    expect(b).toContain('Never report style.');
    expect(b).toContain('- **F1** · Important · unchecked input · `src/a.ts:3` · open, raised in review 1\n  Scenario: crash');
    expect(b).toContain('**sam**, 2026-11-19T11:00:00Z on `src/a.ts:3`:\n\nF1 declined: see test');
    expect(b).toContain('every new finding as JSON');
    expect(b).toContain('"id": "F2"');
    expect(b).not.toMatch(/\$[a-z]+/);
  });

  test('a force-push says the whole diff is read again', () => {
    const r1 = readReview('<!-- sol-pr-review round=1 verdict=clean sha=1234567 findings=W10= -->', '')!;
    expect(reviewBrief({ ...input, round: 2, earlier: [r1], gone: true })).toContain("1234567, isn't in this branch's history any more");
  });
});
