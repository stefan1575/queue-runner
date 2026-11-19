// The fix brief (#156): today's fix template ported, self-contained, with the Before you push list
// and the other shared rules from the same file as the build brief's.
import { describe, expect, test } from 'vitest';
import { FIX_TEMPLATE, fixBrief, LOG_CHARS, type FixBriefInput } from '../src/briefs/fix.ts';
import { buildBrief } from '../src/briefs/build.ts';
import { BEFORE_YOU_PUSH, SCREENSHOTS, USERS_TO_DECIDE_ON_PR } from '../src/briefs/rules.ts';
import type { Finding } from '../src/review/ledger.ts';

const H = 'abcdef1234567890abcdef1234567890abcdef12';
const finding = (part: Partial<Finding>): Finding => ({
  id: 'F1', tag: 'important', class: 'unchecked input', file: 'src/a.ts', line: 3, scenario: 'empty input crashes',
  cost: '', rule: '', status: 'open', raised: 1, ...part,
});
const input: FixBriefInput = {
  github: 'owner/app', number: 4, title: 'Add a thing', round: 2, sha: H, branch: 'claude/add-a-thing-3', base: 'main',
  user: 'Robin', where: { kind: 'thread' }, fresh: null, agentsFile: 'AGENTS.md', reviewLink: 'https://github.com/owner/app/pull/4#issuecomment-1',
  findings: [
    finding({}), finding({ id: 'F2', class: 'unchecked input', file: 'src/b.ts', line: 9 }),
    finding({ id: 'F3', tag: 'nit', class: 'naming', scenario: '' }),
    finding({ id: 'F0', class: 'off by one', status: 'fixed' }),
  ],
  body: 'Closes #3\n', closes: ['#3'], commits: [{ sha: H, subject: 'Add it' }], diffstat: ' src/a.ts | 3 ++\n',
  threads: [{ kind: 'build', startedAt: '2026-11-19T10:00:00.000Z', outcome: 'done', link: 't3://thread/thread-1' }],
};
const flat = (t: string) => t.split(/\s+/).join(' ');

describe('the template', () => {
  test('names no skill, no slash command, no path outside the repo, no person', () => {
    expect(FIX_TEMPLATE).not.toMatch(/\bskills?\b/i);
    expect(FIX_TEMPLATE).not.toMatch(/^\s*\/[a-z][\w-]*\b/m);
    expect(FIX_TEMPLATE).not.toMatch(/~\/|\b[A-Za-z]:[\\/]|evidence\.py|scripts\//);
    expect(FIX_TEMPLATE).not.toContain('Stefan');
    expect(FIX_TEMPLATE).not.toContain('Sol');
  });
});

describe('fixBrief', () => {
  const brief = fixBrief(input);

  test('lists the open Important findings, their classes, the nits and what earlier reviews settled', () => {
    expect(brief.startsWith('Fix round on PR #4 in owner/app: Add a thing\n')).toBe(true);
    expect(brief).toContain('review 2 of the PR\'s head abcdef1 is blocking');
    expect(brief).toContain('- **F1** · Important · unchecked input · `src/a.ts:3` · open, raised in review 1\n  Scenario: empty input crashes');
    expect(brief).toContain('**F2**');
    expect(brief).toContain('**Classes to fix:** "unchecked input".');
    expect(brief).toContain('- **F3** · Nit · naming');
    expect(brief).toContain('- **F0** · off by one · fixed');
    expect(brief).toContain('The review: https://github.com/owner/app/pull/4#issuecomment-1');
    expect(brief).toContain('- `abcdef1` Add it');
    expect(brief).toContain('- build job, 2026-11-19T10:00, ended done: t3://thread/thread-1');
    expect(brief).not.toMatch(/\$[a-z][a-z0-9]*\b/);
  });

  test("sent to the thread that wrote the PR, it works in its own worktree and pushes to the PR's branch", () => {
    expect(brief).toContain('comes back to the thread that wrote the PR');
    expect(brief).toContain('in your worktree on the PR\'s branch `claude/add-a-thing-3`');
    expect(brief).toContain('`git push origin HEAD:claude/add-a-thing-3`');
  });

  test('a fresh fixer is told why; in a new worktree it pushes HEAD to the PR\'s branch', () => {
    const fresh = fixBrief({ ...input, fresh: 'F1 is still open after a round', where: { kind: 'new', work: 'claude/fix-pr4-abcdef1' } });
    expect(fresh).toContain("You're a fresh fixer, called in for this round: F1 is still open after a round.");
    expect(fresh).toContain('on a local branch `claude/fix-pr4-abcdef1`');
    expect(fresh).toContain("**Push to the PR's branch, not to `claude/fix-pr4-abcdef1`:** `git push origin HEAD:claude/add-a-thing-3`");
    expect(fixBrief({ ...input, fresh: 'gone', where: { kind: 'worktree' } })).toContain("in the PR's own worktree");
  });

  test('ends with the Before you push list from the same file as the build brief, gone through before the push', () => {
    const build = buildBrief({ github: 'owner/app', number: 3, title: 't', body: '', comments: [], branch: 'b', base: 'origin/main', agentsFile: null, user: 'Robin' });
    expect(brief.trimEnd().endsWith(BEFORE_YOU_PUSH.trimEnd())).toBe(true);
    expect(build.trimEnd().endsWith(BEFORE_YOU_PUSH.trimEnd())).toBe(true);
    expect(flat(brief)).toContain('go through Before you push (below), then end the round by pushing');
    expect(brief).toContain(SCREENSHOTS.replaceAll('$github', 'owner/app'));
    expect(brief).toContain(USERS_TO_DECIDE_ON_PR.replaceAll('$user', 'Robin'));
  });

  test('nothing open, no commits, no threads, no body', () => {
    const bare = fixBrief({ ...input, findings: [], commits: [], threads: [], body: ' ', closes: [], reviewLink: null, agentsFile: null });
    expect(bare).toContain('### Important (each one blocks the merge)\n\nNone.');
    expect(bare).toContain('**Classes to fix:** none named.');
    expect(bare).toContain('The review: review 2 on the PR');
    expect(bare).toContain('None started by the runner.');
    expect(bare).toContain('(The PR has no description.)');
    expect(bare).toContain('It closes: no issue');
  });
});

describe('a round with no review behind it, and one after the user answered (#158)', () => {
  test("a check that failed again after its re-run: the brief says so and carries the end of its log, no review's findings", () => {
    const log = `${'x'.repeat(LOG_CHARS)}\nError: expected 2, got 3`;
    const brief = fixBrief({ ...input, round: null, findings: [], reviewLink: null, checks: [{ name: 'tests', log }] });
    expect(flat(brief)).toContain("because checks on the PR's head abcdef1 failed, and failed again after their one re-run (tests)");
    expect(brief).toContain('## What failed');
    expect(brief).toContain('### tests');
    expect(brief).toContain('Error: expected 2, got 3');
    expect(brief).toContain(`(the first ${log.length - LOG_CHARS} characters left out)`);
    expect(brief).not.toContain('## What review');
    expect(brief).not.toContain('$');
  });

  test("the user's answer to the PR's stop comes first, quoted", () => {
    const brief = fixBrief({ ...input, direction: 'Drop the cache.\nKeep the API.' });
    expect(brief).toContain("## Direction first\n\nRobin answered the PR's stop, and this round starts from it:\n\n> Drop the cache.\n> Keep the API.");
    expect(brief.indexOf('## Direction first')).toBeLessThan(brief.indexOf('## Where you are'));
    expect(fixBrief(input)).not.toContain('Direction first');
  });
});
