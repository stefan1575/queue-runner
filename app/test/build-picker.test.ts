// The picker, ported from `tests/test_picker.py` case for case (#218), on the ported GitHub fake
// (`test/fakes.ts`).
import { describe, expect, test } from 'vitest';
import { pick, pickable, type Repo } from '../src/build-picker.ts';
import { FakeGitHub, issue, pr, stateKey } from './fakes.ts';

const REPO: Repo & { name: string; path: string } = { name: 'demo', github: 'owner/demo', path: 'C:/demo', base: 'main' };

describe('PickerTest', () => {
  test('picks the lowest numbered ready issue', async () => {
    const gh = new FakeGitHub({ issues: [issue(12), issue(7), issue(30)] });
    expect((await pick(REPO, gh))!.issue.number).toBe(7);
  });

  test('nothing ready picks nothing', async () => {
    expect(await pick(REPO, new FakeGitHub())).toBeNull();
  });

  test('skips an issue whose blocked by line names an open issue', async () => {
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', 'Blocked by: #3, #4'), issue(9)],
      states: { 3: 'closed', 4: 'open' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('picks an issue whose blockers are all closed', async () => {
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', '**Blocked by:** #3, #4'), issue(9)],
      states: { 3: 'closed', 4: 'closed' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(5);
  });

  test('reads a blocked by section', async () => {
    const body = '## What to build\n\nSee #2.\n\n## Blocked by\n\n- #3\n- #4\n\n'
      + '## Acceptance\n\n#8 too';
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', body), issue(9)],
      states: { 2: 'open', 3: 'closed', 4: 'open', 8: 'open' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test("refs outside the blocked by section don't block", async () => {
    const body = 'Follows #2.\n\n## Blocked by\n\nNone (can start immediately).\n\n'
      + '## Notes\n\n#8';
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', body)], states: { 2: 'open', 8: 'open' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(5);
  });

  test('skips an issue with an open native blocker', async () => {
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', '', 1), issue(9)] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('an issue whose native blockers are all closed is picked', async () => {
    // GitHub's summary counts only open blockers: closed ones leave open_blockers at 0.
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', '', 0), issue(9)] });
    expect((await pick(REPO, gh))!.issue.number).toBe(5);
  });

  describe('an issue blocked either way waits', () => {
    // #73: GitHub's native links and `Blocked by:` lines both count; either one open blocks.
    const cases: Record<string, [number, string, string, number]> = {
      'native open, line closed': [1, 'Blocked by: #3', 'closed', 9],
      'native closed, line open': [0, 'Blocked by: #3', 'open', 9],
      'both open': [2, 'Blocked by: #3', 'open', 9],
      'both closed': [0, 'Blocked by: #3', 'closed', 5],
    };
    for (const [name, [native, body, state, want]] of Object.entries(cases)) {
      test(name, async () => {
        const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', body, native), issue(9)], states: { 3: state } });
        expect((await pick(REPO, gh))!.issue.number).toBe(want);
      });
    }
  });

  test('the queue leaves out natively blocked issues', async () => {
    // `pickable` is the dashboard's queue of builds: a natively blocked issue isn't in it.
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', '', 1), issue(7, 'A ticket', 'Blocked by: #3'),
      issue(9)], states: { 3: 'open' } });
    const numbers: number[] = [];
    for await (const j of pickable(REPO, gh)) numbers.push(j.issue.number);
    expect(numbers).toEqual([9]);
  });

  test('skips an issue with an open pr on its branch', async () => {
    const gh = new FakeGitHub({ issues: [issue(5), issue(9)], prs: [pr(20, 'claude/thing-5')],
      branches: ['claude/thing-5'] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('skips an issue an open pr closes', async () => {
    const gh = new FakeGitHub({ issues: [issue(5), issue(9)], prs: [pr(20, 'lovable/x', 'Fixes #5.')] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test("a pr that only mentions the issue doesn't count", async () => {
    const gh = new FakeGitHub({ issues: [issue(5)], prs: [pr(20, 'lovable/x', 'Part of #5; closes #50')] });
    expect((await pick(REPO, gh))!.issue.number).toBe(5);
  });

  test('skips an issue that already has a claude branch', async () => {
    const gh = new FakeGitHub({ issues: [issue(5), issue(9)], branches: ['claude/old-try-5', 'claude/x-95'] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('skips an issue with an open pr linked by hand', async () => {
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', '', 0, 0, 1), issue(9)] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('a qualified blocker in this repo counts', async () => {
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', 'Blocked by: owner/demo#3'), issue(9)],
      states: { 3: 'open' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('a blocker in another repo is checked there', async () => {
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', 'Blocked by: other/lib#3'), issue(9)],
      states: { 3: 'closed', [stateKey('other/lib', 3)]: 'open' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('a blocker given as a url counts', async () => {
    const body = '## Blocked by\n\n- https://github.com/other/lib/issues/3';
    const gh = new FakeGitHub({ issues: [issue(5, 'A ticket', body), issue(9)], states: { [stateKey('other/lib', 3)]: 'open' } });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test('skips an issue a pr closes by qualified ref', async () => {
    const gh = new FakeGitHub({ issues: [issue(5), issue(9)], prs: [pr(20, 'feature/x', 'Fixes owner/demo#5')] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });

  test("a pr closing the same number in another repo doesn't count", async () => {
    const gh = new FakeGitHub({ issues: [issue(5)], prs: [pr(20, 'feature/x', 'Fixes other/lib#5')] });
    expect((await pick(REPO, gh))!.issue.number).toBe(5);
  });

  test('skips a spec with open sub issues', async () => {
    const gh = new FakeGitHub({ issues: [issue(2, 'A ticket', '', 0, 4), issue(9)] });
    expect((await pick(REPO, gh))!.issue.number).toBe(9);
  });
});

describe('BuildJobTest', () => {
  test('the job branches from origin main with a slug and the issue number', async () => {
    const title = "Duplicated code: four judgement calls from #60's, #79's and #85's reviews";
    const job = (await pick(REPO, new FakeGitHub({ issues: [issue(159, title)] })))!;
    expect(job.branch).toBe('claude/duplicated-code-four-judgement-159');
    expect(job.base).toBe('origin/main');
    expect(job.repo).toBe(REPO);
  });

  test('a title without letters still makes a branch', async () => {
    const job = (await pick(REPO, new FakeGitHub({ issues: [issue(4, '!!!')] })))!;
    expect(job.branch).toBe('claude/issue-4');
  });
});
