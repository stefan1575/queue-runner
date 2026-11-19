// The conflict brief (#157): today's conflict template ported, self-contained, with the Before you
// push list from the same file as the other briefs'.
import { describe, expect, test } from 'vitest';
import { BASE_COMMITS, CONFLICT_TEMPLATE, conflictBrief, type ConflictBriefInput } from '../src/briefs/conflict.ts';
import { BEFORE_YOU_PUSH, USERS_TO_DECIDE_ON_PR } from '../src/briefs/rules.ts';

const H = 'abcdef1234567890abcdef1234567890abcdef12';
const input: ConflictBriefInput = {
  github: 'owner/app', number: 4, title: 'Add a thing', sha: H, branch: 'claude/add-a-thing-3', base: 'main', user: 'Robin',
  where: { kind: 'new', work: 'claude/conflict-pr4-abcdef1' }, agentsFile: 'AGENTS.md', body: 'Closes #3\n', closes: ['#3'],
  commits: [{ sha: H, subject: 'Add it' }], landed: [{ sha: '1'.repeat(40), subject: 'Change the same file' }],
  diffstat: ' src/a.ts | 3 ++\n',
  threads: [{ kind: 'build', startedAt: '2026-11-19T10:00:00.000Z', outcome: 'done', link: 't3://thread/thread-1' }],
};
const flat = (t: string) => t.split(/\s+/).join(' ');

describe('the template', () => {
  test('names no skill, no slash command, no path outside the repo, no person', () => {
    expect(CONFLICT_TEMPLATE).not.toMatch(/\bskills?\b/i);
    expect(CONFLICT_TEMPLATE).not.toMatch(/^\s*\/[a-z][\w-]*\b/m);
    expect(CONFLICT_TEMPLATE).not.toMatch(/~\/|\b[A-Za-z]:[\\/]|evidence\.py|scripts\//);
    expect(CONFLICT_TEMPLATE).not.toContain('Stefan');
    expect(CONFLICT_TEMPLATE).not.toContain('Sol');
  });
});

describe('conflictBrief', () => {
  const brief = conflictBrief(input);

  test('merges the base in from a new worktree at H and pushes to the PR\'s branch, never its own', () => {
    expect(brief.startsWith('Conflict round on PR #4 in owner/app: Add a thing\n')).toBe(true);
    expect(flat(brief)).toContain("the PR's head abcdef1 conflicts with `main`");
    expect(brief).toContain(`at the PR's head \`${H}\` on a local branch \`claude/conflict-pr4-abcdef1\``);
    expect(brief).toContain('`git push origin HEAD:claude/add-a-thing-3`');
    expect(brief).toContain('`git merge origin/main`');
    expect(brief).toContain("Robin isn't watching it live");
    expect(brief).not.toMatch(/\$[a-z]+/);
  });

  test('lists the PR\'s commits, its files and what landed on the base since, the oldest cut past the limit', () => {
    expect(brief).toContain('### Its commits (`main..abcdef1`)\n\n- `abcdef1` Add it');
    expect(brief).toContain('### Landed on `main` since the PR left it\n\n- `1111111` Change the same file');
    expect(brief).toContain('- build job, 2026-11-19T10:00, ended done: t3://thread/thread-1');
    const many = Array.from({ length: BASE_COMMITS + 2 }, (_, k) => ({ sha: String(k).padStart(40, '0'), subject: `c${k}` }));
    const cut = conflictBrief({ ...input, landed: many });
    expect(cut).toContain('(2 older ones not shown)\n');
    expect(cut).not.toContain(' c1\n');
    expect(cut).toContain(` c${BASE_COMMITS + 1}`);
  });

  test("in the PR's own worktree it checks HEAD is at H first", () => {
    const own = conflictBrief({ ...input, where: { kind: 'worktree' } });
    expect(own).toContain("in the PR's own worktree on its branch `claude/add-a-thing-3`");
    expect(own).toContain(`check \`HEAD\` is at the PR's head \`${H}\``);
  });

  test("a conflict it can't resolve is never pushed: it aborts, says why on the PR, and ends as a stop", () => {
    const text = flat(brief);
    expect(text).toContain("don't push. Abort the merge (`git merge --abort`)");
    expect(text).toContain('A round that ends without a push goes to Robin as a stop.');
    // the shared rule pushes what it has: not this brief's
    expect(brief).not.toContain(USERS_TO_DECIDE_ON_PR.replaceAll('$user', 'Robin'));
  });

  test('ends with the Before you push list, gone through before the push', () => {
    expect(brief.trimEnd().endsWith(BEFORE_YOU_PUSH.trimEnd())).toBe(true);
    expect(flat(brief)).toContain('go through Before you push (below), then push');
  });
});
