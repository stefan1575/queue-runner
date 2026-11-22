// The build brief, ported from `tests/test_brief.py` case for case (#219), on the ported GitHub
// fake (`test/fakes.ts`) and a repo folder in a temp folder.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { build_brief, EVIDENCE, type Job } from '../src/build-brief.ts';
import { pick, type Repo as PickerRepo } from '../src/build-picker.ts';
import { Repo } from '../src/config.ts';
import { Comment } from '../src/github-seam.ts';
import { FakeGitHub, issue } from './fakes.ts';

describe('BuildBriefTest', () => {
  let tmp: string;
  let job: Job;
  let comments: Comment[];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'qr-brief-'));
    const repo = new Repo({ name: 'demo', github: 'owner/demo', path: tmp });
    const body = 'Make the widget blue.\n\n## Acceptance\n\n- [ ] It costs $5';
    job = (await pick(repo as PickerRepo, new FakeGitHub({ issues: [issue(42, 'Blue widget', body)] }))) as Job;
    comments = [new Comment({ author: 'stefan', created_at: '2026-11-01T10:00:00Z', body: 'Navy, not sky blue.' })];
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const brief = () => build_brief(job, comments);

  test('starts with the issue', () => {
    expect(brief().startsWith('Build GitHub issue #42 in owner/demo')).toBe(true);
  });

  test('carries the issue title body and comments', () => {
    const text = brief();
    expect(text).toContain('Blue widget');
    expect(text).toContain('Make the widget blue.\n\n## Acceptance\n\n- [ ] It costs $5');
    expect(text).toContain('stefan');
    expect(text).toContain('2026-11-01T10:00:00Z');
    expect(text).toContain('Navy, not sky blue.');
  });

  test('says when the issue has no comments', () => {
    comments = [];
    expect(brief()).toContain('No comments.');
  });

  test('names the branch and its base', () => {
    const text = brief();
    expect(text).toContain('`claude/blue-widget-42`');
    expect(text).toContain('`origin/main`');
  });

  test('points at the repos agents md when it has one', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '');
    expect(brief()).toContain("Read the repo's `AGENTS.md` first");
  });

  test('falls back to claude md', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '');
    expect(brief()).toContain("Read the repo's `CLAUDE.md` first");
  });

  test('tells the job to commit each step and open the pr', () => {
    const text = brief();
    expect(text).toContain('Commit after every step');
    expect(text).toContain('decision');
    expect(text).toContain('open the PR with the body below');
    expect(text).toContain('## Merge Danger');
    expect(text).toContain('Closes #42');
  });

  test('says how to work without naming a skill', () => {
    const text = brief();
    expect(text).toContain('Write a failing test first where one fits');
    expect(text).toContain('the full test suite once at the end');
  });

  test('names the runners own screenshot script', () => {
    const text = brief();
    expect(text).toContain(`python3 -I ${EVIDENCE} shoot URL OUT.png`);
    // PR #115 review 1, F1: GitCli.evidence reads pr-<number>/, so a build publishes there,
    // once the PR is open and has its number, never into issue-<number>/.
    expect(text).toContain("--into pr-<the PR's number>");
    expect(text).not.toContain('issue-42');
  });
});
