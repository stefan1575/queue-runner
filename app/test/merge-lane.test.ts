// The merge lane (#156) on fake GitHub, fake git and fake T3: a clean review on the newest commit,
// checks passed on it and nothing open merges with the expected head; a head that moved before the
// merge is reviewed again, not merged (GitHub's 409 in the fake). Where the user merges, a clean
// PR gets `ready-to-merge` and the app never merges it, and the user's merge is noticed. After a
// merge the PR's worktrees and branches are gone and its threads settled.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BuildRepo } from '../src/build-lane.ts';
import type { MergePull, ReviewPull } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import type { ModelChoice } from '../src/jobs.ts';
import { MergeLane, READY, type MergeLaneDoors } from '../src/merge-lane.ts';
import { mark } from '../src/review/ledger.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { FakeMergeGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';

const CHOICE: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const H2 = '1234567890abcdef1234567890abcdef12345678';
const BRANCH = 'claude/add-a-thing-3';
const WT = 'C:/t3/worktrees/app/claude-add-a-thing-3';
const RUNNER: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app', merge: 'runner' };
const ME: BuildRepo = { ...RUNNER, merge: 'me' };

const listed = (part: Partial<ReviewPull> = {}): ReviewPull =>
  ({ number: 4, title: 'Add a thing', body: 'Closes #3', branch: BRANCH, base: 'main', headSha: H, draft: false, url: 'https://github.com/owner/app/pull/4', ...part });
const github = (part: Partial<MergePull> = {}): MergePull =>
  ({ number: 4, title: 'Add a thing', url: 'https://github.com/owner/app/pull/4', state: 'open', headSha: H, branch: BRANCH, base: 'main', draft: false, mergeable: true, labels: [], ...part });

class FakeGit {
  calls: string[] = [];
  trees: { path: string; branch: string | null }[] = [{ path: 'C:/code/app', branch: 'main' }, { path: WT, branch: BRANCH }];
  /** Worktrees git keeps listing after a remove (locked). */
  stuck = new Set<string>();
  async worktrees() { return structuredClone(this.trees); }
  async removeWorktree(_f: string, path: string) {
    this.calls.push(`removeWorktree ${path}`);
    if (this.stuck.has(path)) return false;
    this.trees = this.trees.filter((t) => t.path !== path);
    return true;
  }
  async deleteBranch(_f: string, branch: string) { this.calls.push(`deleteBranch ${branch}`); }
}

let dir: string;
let t3: FakeT3;
let gh: FakeMergeGitHub;
let git: FakeGit;
let log: JobLog;
let mcp: T3Mcp;
let lines: string[];
let repo: BuildRepo;
let merged: string[];
let moved: number;
let folders: Set<string>;
let lane: MergeLane;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-merge-'));
  t3 = new FakeT3();
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
  mcp = new T3Mcp(runtimeAddress(join(dir, 'server-runtime.json')), t3.cli, t3.http);
  gh = new FakeMergeGitHub();
  gh.reviewPulls['owner/app'] = [listed()];
  gh.prs['owner/app#4'] = github();
  gh.checkStates[H] = { state: 'passed', pending: [], failed: [] };
  git = new FakeGit();
  // a clock that ticks a millisecond each read, so every line is later than the one before
  let tick = 0;
  log = await JobLog.open(join(dir, 'state', 'jobs.jsonl'), () => new Date(Date.UTC(2026, 10, 19, 12, 0, 0, ++tick)));
  lines = [];
  merged = [];
  moved = 0;
  folders = new Set();
  repo = RUNNER;
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<MergeLaneDoors> = {}) {
  lane = new MergeLane({
    repos: () => [repo], github: gh, git, mcp, log, say: (l) => lines.push(l),
    exists: (p) => folders.has(p), removeFolder: async (p) => !folders.has(p),
    merged: (r) => merged.push(r.id), headMoved: () => { moved++; }, ...part,
  });
  return lane;
}

/** The PR's build and its threads, and review `round` of `sha` as the review lane leaves it. */
async function built() {
  const build = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'Queue runner build: app#3', choice: CHOICE, onFallback: false });
  await log.thread(build.id, { threadId: 'thread-b', runId: 'r', link: null });
  t3.threadState['thread-b'] = { id: 'thread-b', projectId: 'p-app', runs: [], runtimeRequests: [], turnItems: [] };
  // a question the builder asked, left unsettled at its end: the merge settles it
  await log.ended(build.id, { outcome: 'waiting', request: 'user_input' });
  // so the lanes don't see it as writing: the user answered and it pushed (a later fix ended done)
  const fix = await log.started({ kind: 'fix', repo: 'p-app', github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner fix: app#4', choice: CHOICE, onFallback: false, sha: 'f'.repeat(40), round: 1, workBranch: 'claude/fix-pr4-fffffff', fresh: 'x' });
  await log.thread(fix.id, { threadId: 'thread-f', runId: 'r', link: null });
  t3.threadState['thread-f'] = { id: 'thread-f', projectId: 'p-app', runs: [], runtimeRequests: [], turnItems: [] };
  await log.ended(fix.id, { outcome: 'done' });
  await log.settled(fix.id);
  return build;
}
async function review(round: number, sha: string, verdict: 'clean' | 'blocking') {
  (gh.comments['owner/app#4'] ??= []).push({ author: 'me', createdAt: `2026-11-19T11:0${round}:00Z`, body: mark(round, verdict, sha, []) });
  const job = await log.started({ kind: 'review', repo: 'p-app', github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner review: app#4', choice: CHOICE, onFallback: false, sha, round, reviewer: 'r' });
  await log.thread(job.id, { threadId: `thread-r${round}`, runId: 'r', link: null });
  t3.threadState[`thread-r${round}`] = { id: `thread-r${round}`, projectId: 'p-app', runs: [], runtimeRequests: [], turnItems: [] };
  await log.ended(job.id, { outcome: verdict, verdict });
  await log.settled(job.id);
}
const steps = (kind: string) => log.steps().filter((s) => s.kind === kind);
const settledThreads = () => t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args.threadId);
// the builder's question was answered: nothing writes to the branch
const answered = async () => { const b = log.jobs().find((j) => j.kind === 'build')!; await log.ended(b.id, { outcome: 'done', pr: { number: 4, url: '', state: 'open' } }); };

describe('in a repo where the runner merges', () => {
  test('a clean review on H with checks passed merges at H with a merge commit; worktrees, branches and threads after', async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    await makeLane().pass();
    await lane.idle();
    expect(gh.posted.filter((p) => p.what === 'merge')).toEqual([{ what: 'merge', repo: 'owner/app', n: 4, sha: H }]);
    expect(steps('merge')[0]).toMatchObject({ sha: H, end: { outcome: 'merged', by: 'app', commit: 'm'.repeat(40) }, cleanedAt: expect.any(String), left: [] });
    expect(git.calls).toEqual([`removeWorktree ${WT}`, `deleteBranch ${BRANCH}`, 'deleteBranch claude/fix-pr4-fffffff']);
    expect(settledThreads()).toEqual(['thread-b']);
    expect(merged).toEqual(['p-app']);
    await lane.pass();
    expect(gh.posted.filter((p) => p.what === 'merge')).toHaveLength(1);
  });

  test("a head that moved between the re-check and the merge is reviewed again, not merged (GitHub's 409)", async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    gh.beforeMerge = () => { gh.prs['owner/app#4']!.headSha = H2; };
    await makeLane().pass();
    expect(gh.posted.filter((p) => p.what === 'merge')).toEqual([]);
    expect(steps('merge')[0]).toMatchObject({ sha: H, end: { outcome: 'head-moved' } });
    expect(gh.prs['owner/app#4']!.state).toBe('open');
    expect(moved).toBe(1);
    expect(git.calls).toEqual([]);
    // GitHub lists the new head now: no clean review of it, so nothing merges until it's reviewed
    gh.beforeMerge = () => {};
    gh.reviewPulls['owner/app'] = [listed({ headSha: H2 })];
    await lane.pass();
    expect(gh.posted.filter((p) => p.what === 'merge')).toEqual([]);
  });

  test('the re-check reads the PR afresh: a moved head, a draft, a writer, failed checks, a conflict, a reply since or an open thread holds it', async () => {
    await built();
    await review(1, H, 'clean');
    makeLane();
    const why = () => lane.whyNot(repo, 4, H);
    expect(await why()).toBe('a build job is writing to claude/add-a-thing-3');
    await answered();
    gh.prs['owner/app#4'] = github({ headSha: H2 });
    expect(await why()).toMatch(/the head moved from abcdef1 to 1234567/);
    gh.prs['owner/app#4'] = github({ draft: true });
    expect(await why()).toBe('it is a draft');
    gh.prs['owner/app#4'] = github();
    gh.checkStates[H] = { state: 'failed', pending: [], failed: ['tests'] };
    expect(await why()).toBe('checks on abcdef1 are failed (tests)');
    gh.checkStates[H] = { state: 'passed', pending: [], failed: [] };
    gh.prs['owner/app#4'] = github({ mergeable: false });
    expect(await why()).toBe('it conflicts with main');
    gh.prs['owner/app#4'] = github();
    gh.replies['owner/app#4'] = [{ author: 'sam', createdAt: '2026-11-19T11:30:00Z', body: 'wait, one thing' }];
    expect(await why()).toBe('1 reply since the clean review (sam): you read it first');
    gh.replies['owner/app#4'] = [{ author: 'ci[bot]', createdAt: '2026-11-19T11:30:00Z', body: 'deployed' }];
    gh.threads['owner/app#4'] = 2;
    expect(await why()).toBe('2 unresolved review threads');
    gh.threads['owner/app#4'] = 0;
    expect(await why()).toBeNull();
    // a later blocking review replaces the clean one
    gh.comments['owner/app#4']!.push({ author: 'me', createdAt: '2026-11-19T11:40:00Z', body: mark(2, 'blocking', H, []) });
    expect(await why()).toBe('its newest review comment is not a clean review of abcdef1');
  });

  test('a repo switched to the user merging while the re-check reads GitHub is marked, never merged', async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    const checks = gh.checks.bind(gh);
    gh.checks = async (r, sha) => { repo = ME; return checks(r, sha); };
    await makeLane().pass();
    expect(gh.posted.filter((p) => p.what === 'merge')).toEqual([]);
    expect(steps('ready').map((s) => s.end?.outcome)).toEqual(['marked']);
  });

  test("a merge whose answer was lost is never taken as failed: GitHub is read again, and a merge that landed is recorded", async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    // the merge lands on GitHub, its answer is lost, and GitHub can't be read for a moment
    gh.beforeMerge = () => {
      gh.prs['owner/app#4']!.state = 'merged';
      gh.pullFails = 1;
      gh.beforeMerge = () => {};
      throw new Error('gh api PUT merge failed (-1): socket hang up');
    };
    await makeLane().pass();
    expect(steps('merge')[0]!.end).toBeUndefined();
    gh.reviewPulls['owner/app'] = [];
    await lane.pass();
    await lane.idle();
    expect(steps('merge')).toHaveLength(1);
    expect(steps('merge')[0]).toMatchObject({ end: { outcome: 'merged' }, cleanedAt: expect.any(String) });
    expect(merged).toEqual(['p-app']);
  });

  test('a merge that failed with GitHub answering and the PR still at H is failed, and two leave H alone', async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    gh.mergeFails = 2;
    await makeLane().pass();
    await lane.pass();
    await lane.pass();
    expect(steps('merge').map((s) => s.end?.outcome)).toEqual(['failed', 'failed']);
    expect(lines.some((l) => l.includes('2 merges failed on abcdef1: left until a new head'))).toBe(true);
  });

  test('a blocking review never merges', async () => {
    await review(1, H, 'blocking');
    await makeLane().pass();
    expect(gh.posted).toEqual([]);
    expect(log.steps()).toEqual([]);
  });

  test('a merge the app stopped in the middle of is read from GitHub: merged, it is cleaned up', async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    await log.stepStarted({ kind: 'merge', repo: 'p-app', github: 'owner/app', pr: 4, branch: BRANCH, sha: H });
    gh.prs['owner/app#4'] = github({ state: 'merged' });
    gh.reviewPulls['owner/app'] = [];
    gh.pullFails = 1;
    await makeLane().pass();
    expect(steps('merge')[0]!.end).toBeUndefined(); // GitHub couldn't say: never taken as merged or not
    await lane.pass();
    await lane.idle();
    expect(steps('merge')[0]).toMatchObject({ end: { outcome: 'merged' }, cleanedAt: expect.any(String) });
    expect(merged).toEqual(['p-app']);
  });

  test("a folder T3 still holds is swept on a later pass; a worktree git keeps listing leaves the clean-up owed", async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    git.stuck.add(WT);
    await makeLane().pass();
    await lane.idle();
    expect(steps('merge')[0]!.cleanedAt).toBeUndefined();
    git.stuck.clear();
    folders.add(WT);
    await lane.pass();
    expect(steps('merge')[0]).toMatchObject({ cleanedAt: expect.any(String), left: [WT] });
    await lane.pass();
    expect(steps('merge')[0]!.sweptAt).toBeUndefined();
    folders.delete(WT);
    await lane.pass();
    expect(steps('merge')[0]!.sweptAt).toEqual(expect.any(String));
  });
});

describe("the PR's build is found by its branch too (F11, F12)", () => {
  for (const end of [
    { outcome: 'usage-limit' as const, resetAt: null },
    { outcome: 'failed' as const, error: 'it stopped after opening the PR' },
    { outcome: 'done' as const }, // a PR lookup the live check's build never made
  ]) {
    test(`a build that opened its PR and ended ${end.outcome}, with no PR on its end: its worktree and branch go after the merge`, async () => {
      const build = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'Queue runner build: app#3', choice: CHOICE, onFallback: false });
      await log.thread(build.id, { threadId: 'thread-b', runId: 'r', link: null });
      t3.threadState['thread-b'] = { id: 'thread-b', projectId: 'p-app', runs: [], runtimeRequests: [], turnItems: [] };
      await log.ended(build.id, end);
      await review(1, H, 'clean');
      repo = RUNNER;
      // the usage-limited build would hold the merge as writing: the user merges it instead
      if (end.outcome === 'usage-limit') {
        repo = ME;
        await log.stepStarted({ kind: 'ready', repo: 'p-app', github: 'owner/app', pr: 4, branch: BRANCH, sha: H }).then((s) => log.stepEnded(s.id, { outcome: 'marked' }));
        gh.reviewPulls['owner/app'] = [];
        gh.prs['owner/app#4'] = github({ state: 'merged' });
      }
      await makeLane().pass();
      await lane.idle();
      expect(steps('merge')[0]).toMatchObject({ end: { outcome: 'merged' }, cleanedAt: expect.any(String) });
      expect(git.calls).toContain(`removeWorktree ${WT}`);
      expect(git.calls).toContain(`deleteBranch ${BRANCH}`);
      expect(settledThreads()).toContain('thread-b');
    });
  }

  test("a build on the branch that started after the merge is never the PR's, even ended without a PR", async () => {
    await review(1, H, 'clean');
    await makeLane().pass();
    await lane.idle();
    expect(steps('merge')[0]!.end?.outcome).toBe('merged');
    const later = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'b', choice: CHOICE, onFallback: false });
    await log.ended(later.id, { outcome: 'failed', error: 'x' });
    expect(git.calls).toEqual([]); // no build of this PR's: nothing on the branch was its
  });
});

describe('in a repo where the user merges', () => {
  beforeEach(() => { repo = ME; });

  test('a clean PR gets ready-to-merge once and is never merged by the app; the user\'s merge is noticed', async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    await makeLane().pass();
    await lane.pass();
    expect(gh.posted).toEqual([{ what: 'label', repo: 'owner/app', n: 4, label: READY }]);
    expect(steps('ready').map((s) => s.end?.outcome)).toEqual(['marked']);
    expect(steps('merge')).toEqual([]);
    // the user merges on GitHub: gone from the open list, merged
    gh.reviewPulls['owner/app'] = [];
    gh.prs['owner/app#4'] = github({ state: 'merged', labels: [READY] });
    await lane.pass();
    await lane.idle();
    expect(gh.posted.filter((p) => p.what === 'merge')).toEqual([]);
    expect(gh.posted.at(-1)).toEqual({ what: 'unlabel', repo: 'owner/app', n: 4, label: READY });
    expect(steps('merge')[0]).toMatchObject({ end: { outcome: 'merged', by: 'user' }, cleanedAt: expect.any(String) });
    expect(git.calls).toContain(`removeWorktree ${WT}`);
    expect(settledThreads()).toEqual(['thread-b']);
    expect(merged).toEqual(['p-app']);
    expect(lines.some((l) => l.includes('you merged it'))).toBe(true);
  });

  test("the user's merge is noticed once: later passes record nothing, and a new build on the same branch name keeps its worktree (F2)", async () => {
    await built();
    await answered();
    await review(1, H, 'clean');
    // the PR's build ended with its PR, so the clean-up knows it as this PR's job
    const b = log.jobs().find((j) => j.kind === 'build')!;
    await log.ended(b.id, { outcome: 'done', pr: { number: 4, url: '', state: 'open' } });
    await makeLane().pass();
    gh.reviewPulls['owner/app'] = [];
    gh.prs['owner/app#4'] = github({ state: 'merged' });
    await lane.pass();
    await lane.idle();
    expect(steps('merge')).toHaveLength(1);
    // the issue reopened and rebuilt on the same branch name: a new build, its own worktree
    const again = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'Queue runner build: app#3', choice: CHOICE, onFallback: false });
    await log.thread(again.id, { threadId: 'thread-new', runId: 'r', link: null });
    git.trees.push({ path: 'C:/t3/worktrees/app/claude-add-a-thing-3-again', branch: BRANCH });
    git.calls = [];
    await lane.pass();
    await lane.pass();
    await lane.idle();
    expect(steps('merge')).toHaveLength(1);
    expect(git.calls).toEqual([]);
    expect(settledThreads()).not.toContain('thread-new');
  });

  test("a merge's clean-up owed after a new build reused the branch name leaves that build's worktree and branch alone (F2)", async () => {
    await built();
    await answered();
    const b = log.jobs().find((j) => j.kind === 'build')!;
    await log.ended(b.id, { outcome: 'done', pr: { number: 4, url: '', state: 'open' } });
    await review(1, H, 'clean');
    repo = RUNNER;
    git.stuck.add(WT); // the clean-up is owed: git keeps listing the PR's worktree
    await makeLane().pass();
    await lane.idle();
    expect(steps('merge')[0]!.cleanedAt).toBeUndefined();
    // meanwhile the old worktree went, and a new build took the branch name
    git.stuck.clear();
    git.trees = git.trees.filter((t) => t.path !== WT);
    const again = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'Queue runner build: app#3', choice: CHOICE, onFallback: false });
    await log.thread(again.id, { threadId: 'thread-new', runId: 'r', link: null });
    git.trees.push({ path: 'C:/t3/worktrees/app/claude-add-a-thing-3-again', branch: BRANCH });
    git.calls = [];
    await lane.pass();
    await lane.idle();
    expect(git.calls.filter((c) => c.includes('again') || c === `deleteBranch ${BRANCH}`)).toEqual([]);
    expect(settledThreads()).not.toContain('thread-new');
    expect(steps('merge')[0]!.cleanedAt).toEqual(expect.any(String));
  });

  test('the mark comes off when the head moves; a marked PR closed unmerged loses it too', async () => {
    await review(1, H, 'clean');
    await makeLane().pass();
    gh.reviewPulls['owner/app'] = [listed({ headSha: H2 })];
    gh.prs['owner/app#4'] = github({ headSha: H2, labels: [READY] });
    await lane.pass();
    expect(steps('ready').map((s) => s.end?.outcome)).toEqual(['marked', 'unmarked']);
    expect(gh.prs['owner/app#4']!.labels).toEqual([]);
    expect(lines.some((l) => l.includes('no longer ready for you (the head moved from abcdef1 to 1234567'))).toBe(true);
  });

  test('a label that fails to go on is tried again next pass', async () => {
    await review(1, H, 'clean');
    gh.failing.add('label');
    await makeLane().pass();
    expect(steps('ready').map((s) => s.end?.outcome)).toEqual(['failed']);
    gh.failing.delete('label');
    await lane.pass();
    expect(steps('ready').map((s) => s.end?.outcome)).toEqual(['failed', 'marked']);
  });
});
