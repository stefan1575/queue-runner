// The build brief (#154): today's template ported, self-contained (docs/app.md, Rules: today's
// tests/test_templates.py, ported with it), with the user's name from Settings.
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { BUILD_TEMPLATE, buildBrief, type BuildBriefInput } from '../src/briefs/build.ts';
import { BEFORE_YOU_PUSH, SCREENSHOTS, USERS_TO_DECIDE } from '../src/briefs/rules.ts';

const input: BuildBriefInput = {
  github: 'owner/app', number: 42, title: 'Add a thing', body: '  Do the thing.\n', branch: 'claude/add-a-thing-42',
  base: 'origin/main', agentsFile: 'AGENTS.md', user: 'Robin',
  comments: [{ author: 'sam', createdAt: '2026-11-19T10:00:00Z', body: 'Also $title stays as written.\n' }],
};

describe('the template', () => {
  test('names no skill and starts no slash command', () => {
    expect(BUILD_TEMPLATE).not.toMatch(/\bskills?\b/i);
    expect(BUILD_TEMPLATE).not.toMatch(/^\s*\/[a-z][\w-]*\b/m);
    expect(BUILD_TEMPLATE).not.toMatch(/`\/[a-z][\w-]*`/);
  });

  test('points at nothing outside the repo: no home folder, no drive, no absolute path', () => {
    expect(BUILD_TEMPLATE).not.toMatch(/~\//);
    expect(BUILD_TEMPLATE).not.toMatch(/\b[A-Za-z]:[\\/]/);
    expect(BUILD_TEMPLATE).not.toMatch(/(^|[\s`(])\/(Users|home|tmp)\b/m);
    expect(BUILD_TEMPLATE).not.toMatch(/evidence\.py|scripts\//);
  });

  test('names no person: the user comes from Settings', () => {
    expect(BUILD_TEMPLATE).not.toContain('Stefan');
    expect(BUILD_TEMPLATE).toContain('$user');
  });

  test('holds screenshots to the review\'s finish line and publishes where the review reads them', () => {
    const text = BUILD_TEMPLATE.split(/\s+/).join(' ');
    expect(text).toContain('reading only the PR');
    expect(text).toContain('see the change the');
    expect(text).toContain('`pr-<the PR\'s number>/`');
  });
});

describe('buildBrief', () => {
  const brief = buildBrief(input);

  test('is filled from the issue, the branch and the user', () => {
    expect(brief.startsWith('Build GitHub issue #42 in owner/app: Add a thing\n')).toBe(true);
    expect(brief).toContain("Robin isn't watching it live");
    expect(brief).toContain('If something only Robin can decide');
    expect(brief).toContain('on branch `claude/add-a-thing-42`, made from `origin/main`');
    expect(brief).toContain("Read the repo's `AGENTS.md` first");
    expect(brief).toContain('## The issue: #42 Add a thing\n\nDo the thing.\n\n## Comments');
    expect(brief).toContain('`Closes #42`');
    // nothing left unfilled (the comment's own `$title` aside)
    expect(brief.replace('$title stays', '')).not.toMatch(/\$[a-z]+/);
  });

  test('a comment is quoted with its author and time, and a $ in it is left as written', () => {
    expect(brief).toContain('**sam**, 2026-11-19T10:00:00Z:\n\nAlso $title stays as written.');
  });

  test('no body, no comments, no AGENTS.md', () => {
    const bare = buildBrief({ ...input, body: '  ', comments: [], agentsFile: null });
    expect(bare).toContain('(The issue has no body.)');
    expect(bare).toContain('## Comments on the issue\n\nNo comments.');
    expect(bare).toContain('The repo has no `AGENTS.md`; follow its README');
  });
});

describe('each rule is written once (#154)', () => {
  const brief = buildBrief(input);
  const flat = (t: string) => t.split(/\s+/).join(' ');

  test('the brief ends with the Before you push list, and goes through it before the push', () => {
    expect(brief).toContain(BEFORE_YOU_PUSH);
    expect(brief.trimEnd().endsWith(BEFORE_YOU_PUSH.trimEnd())).toBe(true);
    const text = flat(brief);
    expect(text).toContain('go through Before you push (below), then push');
    expect(text).toContain('read to its last page');
    expect(text).toContain("Don't run a review");
    expect(text).not.toContain("Don't review your own work");
  });

  test('it carries the screenshot rule and what is the user\'s to decide from the same file, filled', () => {
    expect(brief).toContain(SCREENSHOTS.replaceAll('$github', input.github));
    expect(brief).toContain(USERS_TO_DECIDE.replaceAll('$user', input.user));
    expect(flat(brief)).toContain('Output that is only text');
  });

  test('no brief file but the rules file writes a shared rule out', async () => {
    const dir = new URL('../src/briefs/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && f !== 'rules.ts');
    expect(files).toContain('build.ts');
    // a line from each rule, as written: found in a brief file means the rule was copied there
    const marks = [BEFORE_YOU_PUSH, SCREENSHOTS, USERS_TO_DECIDE].map((r) => r.split('\n').find((l) => l.length > 60)!);
    for (const f of files) {
      const text = await readFile(new URL(f, dir), 'utf8');
      for (const m of marks) expect(text, `${f} copies "${m}"`).not.toContain(m);
    }
  });
});
