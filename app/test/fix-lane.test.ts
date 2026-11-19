// The fix lane (#156) on fake T3, fake GitHub and fake git: a blocking review's findings go back to
// the thread that built the PR (t3_thread_send), its new run is watched to its end, and the review
// lane is told so a fresh reviewer reviews the pushed head. A review that marks an earlier finding
// still not fixed, a PR with no builder thread, or a send T3 turns down gets a fresh fixer on the
// fix kind's settings instead. After a restart nothing is guessed.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BuildRepo } from '../src/build-lane.ts';
import { CAP } from '../src/cap.ts';
import { FixLane, type FixLaneDoors } from '../src/fix-lane.ts';
import type { MergePull, ReviewPull } from '../src/github.ts';
import { JobLog, type Job } from '../src/job-log.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { mark, type Finding } from '../src/review/ledger.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeReviewGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';
import { memoryJobFiles } from './memory-files.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const BUILD: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium' };
const FIX: ModelChoice = { provider: 'claudeAgent', model: 'claude-haiku-5-5', effort: 'low' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const H2 = '1234567890abcdef1234567890abcdef12345678';
const BRANCH = 'claude/add-a-thing-3';
const pull = (part: Partial<ReviewPull> = {}): ReviewPull =>
  ({ number: 4, title: 'Add a thing', body: 'Closes #3', branch: BRANCH, base: 'main', headSha: H, draft: false, url: 'https://github.com/owner/app/pull/4', headRepo: 'Owner/App', ...part });
// (the PR's own repo, as GitHub may case it: no fork, so every round here is sent or launched)
const finding = (part: Partial<Finding>): Finding => ({
  id: 'F1', tag: 'important', class: 'unchecked input', file: 'src/a.ts', line: 3, scenario: 'empty input crashes', cost: '', rule: '', status: 'open', raised: 1, ...part,
});

class FixGitHub extends FakeReviewGitHub {
  heads: Record<number, string> = {};
  async pull(_repo: string, n: number): Promise<MergePull> {
    return { number: n, title: 'Add a thing', url: '', state: 'open', headSha: this.heads[n] ?? H, branch: BRANCH, base: 'main', draft: false, mergeable: true, labels: [] };
  }
}

class FakeGit {
  calls: string[] = [];
  heads: Record<number, string> = {};
  trees: { path: string; branch: string | null }[] = [{ path: 'C:/code/app', branch: 'main' }];
  branches = new Set<string>();
  async fetchPr(folder: string, n: number, base: string) { this.calls.push(`fetchPr ${folder} ${n} ${base}`); return this.heads[n] ?? H; }
  async log() { return [{ sha: H, subject: 'Add it' }]; }
  async diffstat() { return ' src/a.ts | 3 ++\n'; }
  async worktrees() { return structuredClone(this.trees); }
  async hasBranch(_f: string, b: string) { return this.branches.has(b); }
}

class FakeGate {
  calls: string[] = [];
  room = true;
  pick(id: string) {
    this.calls.push(`pick ${id}`);
    return this.room ? { fits: true as const, choice: FIX, onFallback: false, cost: { five_hour: 40 } }
      : { fits: false as const, until: null, hold: { why: 'reading' as const, provider: 'Claude', checkedAt: null, stale: 'none' as const } };
  }
  check(job: { id: string; choice: ModelChoice }) {
    this.calls.push(`check ${job.id} ${job.choice.model}`);
    return this.room ? { fits: true as const, cost: { five_hour: 40 } }
      : { fits: false as const, until: null, hold: { why: 'reading' as const, provider: 'Claude', checkedAt: null, stale: 'none' as const } };
  }
  started(job: { id: string; choice: ModelChoice }) { this.calls.push(`started ${job.id} ${job.choice.model}`); }
  finished(id: string) { this.calls.push(`finished ${id}`); }
  dropped(id: string) { this.calls.push(`dropped ${id}`); }
  forget() {}
}

const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

let dir: string;
let t3: FakeT3;
let gh: FixGitHub;
let git: FakeGit;
let gate: FakeGate;
let log: JobLog;
let mcp: T3Mcp;
let ws: T3Ws;
let lines: string[];
let jobs: Jobs;
let ended: Job[];
let lane: FixLane;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-fix-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  const address = t3.address;
  mcp = new T3Mcp(address, t3.cli, t3.http);
  ws = new T3Ws(address, t3.cli, t3.http, t3.connect);
  gh = new FixGitHub();
  gh.reviewPulls['owner/app'] = [pull()];
  git = new FakeGit();
  gate = new FakeGate();
  log = await JobLog.open(join(dir, 'state', 'jobs.jsonl'), undefined, memoryJobFiles());
  lines = [];
  ended = [];
  jobs = { ...DEFAULT_JOBS, build: { own: BUILD, fallback: null }, fix: { own: FIX, fallback: null } };
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<FixLaneDoors> = {}) {
  lane = new FixLane({
    repos: () => [APP], github: gh, git, mcp, ws, gate, catalog: () => catalog, jobs: () => jobs, user: async () => 'Pat', log,
    exists: () => true, say: (l) => lines.push(l), ended: (j) => ended.push(j), retry: () => () => {},
    now: () => new Date('2026-11-19T12:00:00Z'), ...part,
  });
  return lane;
}

/** The PR's builder: a build job with its thread, which T3 has. */
async function builder(thread = 'thread-b'): Promise<Job> {
  const job = await log.started({ kind: 'build', repo: APP.id, github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'Queue runner build: app#3', choice: BUILD, onFallback: false });
  await log.thread(job.id, { threadId: thread, runId: 'run-b', link: `t3://thread/${thread}` });
  t3.threadState[thread] = { id: thread, projectId: APP.id, runtimeRequests: [], turnItems: [], runs: [{ id: 'run-b', threadId: thread, ordinal: 1, rootNodeId: 'node-b', status: 'completed' }] };
  return log.ended(job.id, { outcome: 'done', pr: { number: 4, url: '', state: 'open' } });
}

/** Review `round` of `sha`, blocking on `findings`, as the review lane leaves it: its job in the
 *  log and its comment on the PR. */
async function blocking(round: number, sha: string, findings: Finding[]) {
  const url = `https://github.com/owner/app/pull/4#issuecomment-${round}`;
  (gh.comments['owner/app#4'] ??= []).push({ author: 'me', createdAt: `2026-11-19T11:0${round}:00Z`, body: `## Sol review ${round}\n\n${mark(round, 'blocking', sha, findings)}`, url });
  const job = await log.started({ kind: 'review', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner review: app#4', choice: BUILD, onFallback: false, sha, round, reviewer: 'r' });
  return log.ended(job.id, { outcome: 'blocking', verdict: 'blocking', link: url });
}

const fixes = () => log.jobs().filter((j) => j.kind === 'fix');

describe('a fix round', () => {
  test("goes back to the builder's thread, on its model, and its new run is watched to its end; the review lane is told", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    makeLane();
    await lane.pass();
    await until(() => t3.sends.length === 1);
    expect(t3.sends[0]).toMatchObject({ threadId: 'thread-b', mode: 'queue' });
    expect(t3.sends[0].message).toContain('Fix round on PR #4 in owner/app: Add a thing');
    expect(t3.sends[0].message).toContain('comes back to the thread that wrote the PR');
    expect(t3.sends[0].message).toContain('**F1** · Important · unchecked input');
    expect(t3.launches).toEqual([]);
    expect(gate.calls.some((c) => c.startsWith('check fix:owner/app#4 claude-opus-5-5'))).toBe(true);
    const job = fixes()[0]!;
    expect(job).toMatchObject({ to: 'thread-b', knownRuns: ['run-b'], sha: H, round: 1, threadId: 'thread-b', runId: 'thread-b-run-2', choice: BUILD });
    await until(() => t3.threadStreamCount('thread-b') > 0);
    gh.heads[4] = H2;
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(log.get(job.id)).toMatchObject({ end: { outcome: 'done', head: H2 }, settledAt: expect.any(String) });
    expect(ended.map((j) => j.id)).toEqual([job.id]);
    expect(lines.some((l) => l.includes('pushed 1234567: reviewed next'))).toBe(true);
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize')).toEqual([{ tool: 't3_thread_organize', args: { threadId: 'thread-b', action: 'settle' } }]);
  });

  test('a send T3 answers with no run id waits for the run that came after the send, not the build run that ended', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.sendOmitsRunId = true;
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    const job = fixes()[0]!;
    expect(job.runId).toBeNull();
    expect(log.get(job.id)!.end).toBeUndefined();
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'done' });
  });

  test('one round per head: a round on H that ended without a push leaves the PR for the user', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(lines.some((l) => l.includes('without a push: the PR waits for you'))).toBe(true);
    await lane.pass();
    expect(t3.sends).toHaveLength(1);
    expect(lines.some((l) => l.includes('ended done and the head is still abcdef1: left for you'))).toBe(true);
  });

  test('no round while a job writes to the branch, while the newest review comment is not the blocking one, or on a clean review', async () => {
    const build = await log.started({ kind: 'build', repo: APP.id, github: 'owner/app', issue: 3, branch: BRANCH, base: 'main', title: 'b', choice: BUILD, onFallback: false });
    await log.thread(build.id, { threadId: 'thread-b', runId: 'run-b', link: null });
    await blocking(1, H, [finding({})]);
    makeLane();
    await lane.pass();
    expect(lines.some((l) => l.includes('a build job is writing to claude/add-a-thing-3'))).toBe(true);
    await log.ended(build.id, { outcome: 'done' });
    gh.comments['owner/app#4']!.push({ author: 'me', createdAt: '2026-11-19T11:30:00Z', body: mark(2, 'clean', H2, []) });
    await lane.pass();
    expect(lines.some((l) => l.includes('its newest review comment is not the blocking review 1 of abcdef1'))).toBe(true);
    expect(t3.sends).toEqual([]);
  });

  test('a repo switched off while the round is fetched and briefed sends nothing; a head that moved starts nothing', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    let served = [APP];
    const fetch = git.fetchPr.bind(git);
    git.fetchPr = async (f, n, b) => { served = []; return fetch(f, n, b); };
    makeLane({ repos: () => served });
    await lane.pass();
    await lane.idle();
    expect(t3.sends).toEqual([]);
    expect(fixes()[0]!.end).toMatchObject({ outcome: 'not-started', error: 'app is no longer served' });
    expect(gate.calls).toContain(`dropped ${fixes()[0]!.id}`);

    git.fetchPr = async () => H2;
    served = [APP];
    makeLane({ repos: () => served });
    await lane.pass();
    await lane.idle();
    expect(t3.sends).toEqual([]);
    expect(lines.some((l) => l.includes('the head moved from abcdef1 to 1234567'))).toBe(true);
  });

  test("a fork's PR gets no fixer: it needs the user, nothing is sent or launched, and H gets no round after (N2)", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    gh.reviewPulls['owner/app'] = [pull({ branch: 'main', headRepo: 'someone/app' })];
    makeLane();
    await lane.pass();
    await lane.idle();
    expect(t3.sends).toEqual([]);
    expect(t3.launches).toEqual([]);
    const job = fixes()[0]!;
    expect(job.end).toMatchObject({ outcome: 'needs-user', error: expect.stringContaining('head is in someone/app, not owner/app') });
    expect(log.needingUser(APP.id)).toHaveLength(1);
    await lane.answered(job.id);
    expect(fixes()).toHaveLength(1);
  });

  test("the gate holds a send on the builder's model: it waits and says why once", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    gate.room = false;
    makeLane();
    await lane.pass();
    await lane.pass();
    expect(t3.sends).toEqual([]);
    expect(lines.filter((l) => l.includes('no fix round now, waits:'))).toHaveLength(1);
  });
});

describe('a fresh fixer', () => {
  test("a review that marks an earlier finding still not fixed: a new thread on the fix kind's settings, in the PR's worktree", async () => {
    await builder();
    await blocking(1, 'f'.repeat(40), [finding({})]);
    await blocking(2, H, [finding({ status: 'open', raised: 1 })]);
    git.trees.push({ path: 'C:/t3/worktrees/app/claude-add-a-thing-3', branch: BRANCH });
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.sends).toEqual([]);
    expect(t3.launches[0]).toMatchObject({
      projectId: APP.id, title: 'Queue runner fix: app#4',
      modelSelection: { instanceId: FIX.provider, model: FIX.model },
      workspaceStrategy: { type: 'existing_worktree', worktreePath: 'C:/t3/worktrees/app/claude-add-a-thing-3' },
    });
    expect(t3.launches[0].message).toContain("You're a fresh fixer, called in for this round: review 2 marks F1 still not fixed after an earlier round.");
    expect(gate.calls).toContain('pick fix:owner/app#4');
    const job = fixes()[0]!;
    expect(job.made).toBeUndefined(); // the PR's own worktree: the fixer made nothing (#156 F15)
    expect(job).toMatchObject({ fresh: expect.stringContaining('F1 still not fixed'), choice: FIX, threadId: 'thread-1' });
    // the fresh fixer writes the PR from now on: the next round goes back to it
    t3.endRun('thread-1', 'completed');
    gh.heads[4] = H2;
    await lane.idle();
    const H3 = '9'.repeat(40);
    gh.reviewPulls['owner/app'] = [pull({ headSha: H3 })];
    git.heads[4] = H3;
    await blocking(3, H3, [finding({ id: 'F9', raised: 3 })]);
    await lane.pass();
    await until(() => t3.sends.length === 1);
    expect(t3.sends[0].threadId).toBe('thread-1');
  });

  test("a PR no app thread wrote, with no worktree on its branch: a new worktree at H on the fix's own branch, pushing to the PR's", async () => {
    await blocking(1, H, [finding({})]);
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].workspaceStrategy).toEqual({ type: 'worktree', baseRef: H, branch: 'claude/fix-pr4-abcdef1' });
    expect(t3.launches[0].message).toContain('`git push origin HEAD:claude/add-a-thing-3`');
    expect(fixes()[0]).toMatchObject({ workBranch: 'claude/fix-pr4-abcdef1', fresh: "no thread of the app's wrote this PR", made: ['claude/fix-pr4-abcdef1'] });
  });

  test("the builder's thread deleted in T3 before the round: a fresh fixer, never a send (F3)", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    delete t3.threadState['thread-b'];
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.sends).toEqual([]);
    expect(t3.launches[0].message).toContain("the PR's writer thread thread-b is gone in T3");
    expect(fixes().map((j) => j.fresh ? 'fresh' : 'sent')).toEqual(['fresh']);
  });

  test('a thread T3 reads fine but whose projection fails for a moment is no fresh fixer: the PR rests and tries the send again', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.wsMethods['orchestration.getThreadProjection'] = () => { throw new Error('busy'); };
    makeLane();
    await lane.pass();
    await lane.idle();
    expect(t3.launches).toEqual([]);
    expect(t3.sends).toEqual([]);
    expect(lines.some((l) => l.includes('not started'))).toBe(true);
  });

  test("the thread deleted as the send arrives (T3 says not found): nothing counts, and the next pass sends a fresh fixer", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.beforeSend = () => { delete t3.threadState['thread-b']; };
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(fixes()[0]!.end).toMatchObject({ outcome: 'not-started', error: expect.stringContaining('is gone in T3') });
    expect(t3.launches[0].message).toContain("the PR's writer thread thread-b is gone in T3");
  });
});

describe("a send T3 refuses because the thread can't take a turn (F9)", () => {
  // what the installed T3 answers before it dispatches anything (sendToThread in its server):
  // archived, deleted, or its provider instance switched off
  for (const failure of [
    { code: 'thread_not_sendable', message: 'Thread thread-b is archived.' },
    { code: 'thread_not_found', message: 'Thread thread-b was not found.' },
    { code: 'invalid_request', message: 'Provider instance claudeAgent is disabled.' },
  ]) {
    test(`${failure.code}: nothing counts, and the next pass sends a fresh fixer, not the user`, async () => {
      await builder();
      await blocking(1, H, [finding({})]);
      t3.sendFailure = failure;
      makeLane();
      await lane.pass();
      await until(() => t3.launches.length === 1);
      expect(fixes()[0]!.end).toMatchObject({ outcome: 'not-started', error: expect.stringContaining("can't take another turn") });
      expect(log.needingUser(APP.id)).toEqual([]);
      expect(t3.launches[0].message).toContain("can't take another turn");
    });
  }
});

describe('a send whose outcome is not known (F4)', () => {
  test('T3 takes the send and answers orchestration_error: its new run is the round, watched to its end; no fresh fixer beside it', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.sendFailure = { code: 'orchestration_error', message: "The run couldn't be read back." };
    t3.sendTaken = true;
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    const job = fixes()[0]!;
    expect(job).toMatchObject({ threadId: 'thread-b', runId: 'thread-b-run-2' });
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'done' });
    expect(t3.launches).toEqual([]);
  });

  test('a failed send on a thread that shows no new run needs the user: no fresh fixer, the repo starts nothing', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.sendFailure = { code: 'orchestration_error', message: 'Something went wrong.' };
    makeLane();
    await lane.pass();
    await lane.idle();
    expect(fixes()[0]!.end).toMatchObject({ outcome: 'needs-user' });
    expect(log.needingUser(APP.id)).toHaveLength(1);
    await lane.pass();
    expect(t3.launches).toEqual([]);
  });

  test('a send whose answer was lost and whose new run shows on the thread is watched, not left for the user', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.sendAnswerLost = true;
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    const job = fixes()[0]!;
    expect(job.runId).toBe('thread-b-run-2');
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'done' });
  });
});

describe("after a restart, don't guess", () => {
  test("a send whose answer was lost, on a thread that can't be read after, needs the user: its repo starts nothing until they answer", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    t3.sendAnswerLost = true;
    t3.beforeSend = () => { t3.wsMethods['orchestration.getThreadProjection'] = () => { throw new Error('busy'); }; };
    makeLane();
    await lane.pass();
    await lane.idle();
    const job = fixes()[0]!;
    expect(log.get(job.id)!.end).toMatchObject({ outcome: 'needs-user' });
    expect(log.needingUser(APP.id).map((j) => j.id)).toEqual([job.id]);
    t3.sendAnswerLost = false;
    await lane.pass();
    expect(t3.sends).toHaveLength(1); // the lost one T3 got; no other
  });

  test('a round the log shows open is watched again on its new run; one with no thread line needs the user', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    const open = await log.started({ kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner fix: app#4', choice: BUILD, onFallback: false, sha: H, round: 1, to: 'thread-b', knownRuns: ['run-b'] });
    await log.thread(open.id, { threadId: 'thread-b', runId: null, link: null });
    t3.threadState['thread-b']!.runs.push({ id: 'run-new', threadId: 'thread-b', ordinal: 2, rootNodeId: 'n2', status: 'running' });
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    expect(log.get(open.id)!.end).toBeUndefined();
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(log.get(open.id)!.end).toMatchObject({ outcome: 'done' });
    expect(t3.sends).toEqual([]);

    lane.stop();
    // the thread shows no run it didn't have before the send: the user's
    const lost = await log.started({ kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner fix: app#4', choice: BUILD, onFallback: false, sha: H2, round: 2, to: 'thread-b', knownRuns: ['run-b', 'run-new'] });
    makeLane();
    await lane.start();
    await lane.idle();
    expect(log.get(lost.id)!.end).toMatchObject({ outcome: 'needs-user', error: expect.stringContaining('before T3 answered') });
  });

  test('a round the app stopped before T3 answered, whose thread shows the new run, is watched on it (F4)', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    const open = await log.started({ kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner fix: app#4', choice: BUILD, onFallback: false, sha: H, round: 1, to: 'thread-b', knownRuns: ['run-b'] });
    t3.threadState['thread-b']!.runs.push({ id: 'run-taken', threadId: 'thread-b', ordinal: 2, rootNodeId: 'n2', status: 'running' });
    makeLane();
    void lane.start();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    expect(log.get(open.id)).toMatchObject({ threadId: 'thread-b', runId: 'run-taken' });
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(log.get(open.id)!.end).toMatchObject({ outcome: 'done' });
    expect(t3.sends).toEqual([]);
  });
});

describe('what never reaches the user, the cap, and an answer (#158)', () => {
  // a clock that moves a second each read, so the log's times order what happened
  let tick = 0;
  beforeEach(async () => {
    tick = 0;
    log = await JobLog.open(join(dir, 'state', 'ticking.jsonl'), () => new Date(Date.UTC(2026, 10, 19, 12, 0, tick++)), memoryJobFiles());
  });

  /** A check on H that failed again after its re-run, as the checks lane records it. */
  const checkFailed = () => log.stepStarted({ kind: 'check-failed', repo: APP.id, github: 'owner/app', pr: 4, branch: BRANCH, sha: H, failed: ['tests', 'lint'], runs: [77, 0] });

  test('a check that failed again after its re-run gets a fix round with its failing log, and no review', async () => {
    await builder();
    gh.logs[77] = 'FAIL src/a.test.ts\nexpected 2, got 3';
    await checkFailed();
    makeLane();
    await lane.pass();
    await until(() => t3.sends.length === 1);
    expect(t3.sends[0].message).toContain("because checks on the PR's head abcdef1 failed, and failed again after their one re-run (tests, lint)");
    expect(t3.sends[0].message).toContain('expected 2, got 3');
    expect(t3.sends[0].message).toContain('### lint\n\n```\n(GitHub gave no log for it)');
    expect(fixes()[0]).toMatchObject({ cause: 'check', sha: H });
    expect(fixes()[0]!.round).toBeUndefined();
    expect(log.stops()).toEqual([]);
  });

  test('a round that failed gets another round on the same head; it files nothing', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    t3.endRun('thread-b', 'failed');
    await until(() => t3.sends.length === 2);
    expect(log.stops()).toEqual([]);
  });

  test(`the cap: with ${CAP - 1} rounds since the last answer, review ${CAP} still blocking gets no round but a cap stop; no round while it's open`, async () => {
    await builder();
    for (const k of [1, 2]) {
      const r = await log.started({ kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 't', choice: BUILD, onFallback: false, sha: `${k}`.repeat(40), round: k });
      await log.ended(r.id, { outcome: 'done', head: `${k + 1}`.repeat(40) });
    }
    await blocking(3, H, [finding({})]);
    makeLane();
    await lane.pass();
    await lane.pass();
    expect(t3.sends).toEqual([]);
    expect(log.openStops(APP.id, 4)).toEqual([expect.objectContaining({ cause: 'cap', sha: H, why: expect.stringContaining('review 3 of abcdef1 is still blocking') })]);
    expect(lines.filter((l) => l.includes("it's stopped for you"))).toHaveLength(1);
  });

  test("an Approach note's stop answered on GitHub releases the PR: one more round on H, the user's words first", async () => {
    await builder();
    const url = 'https://github.com/owner/app/pull/4#issuecomment-3';
    (gh.comments['owner/app#4'] ??= []).push({ author: 'me', createdAt: '2026-11-19T11:03:00Z', body: mark(3, 'blocking', H, [finding({})]), url });
    const review = await log.started({ kind: 'review', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner review: app#4', choice: BUILD, onFallback: false, sha: H, round: 3, reviewer: 'r' });
    await log.ended(review.id, { outcome: 'approach-note', verdict: 'blocking', link: url });
    const stop = await log.stopped({ cause: 'cap', repo: APP.id, github: 'owner/app', pr: 4, sha: H, why: 'the cap', link: null, job: review.id });
    makeLane();
    await lane.pass();
    expect(t3.sends).toEqual([]);
    expect(t3.launches).toEqual([]);
    await log.stopAnswered(stop.id, 'replied', 'Rework it: drop the cache.');
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].message).toContain("## Direction first\n\nPat answered the PR's stop, and this round starts from it:\n\n> Rework it: drop the cache.");
    expect(fixes()[0]).toMatchObject({ sha: H, round: 3 });
  });

  test('a question the round asked, answered on GitHub, gives the head another round; unanswered, none', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    t3.endRun('thread-b', 'completed'); // no push: the round asked on the PR
    await lane.idle();
    const stop = await log.stopped({ cause: 'question', repo: APP.id, github: 'owner/app', pr: 4, sha: H, why: 'it asked', link: null, job: fixes()[0]!.id });
    await lane.pass();
    expect(t3.sends).toHaveLength(1);
    await log.stopAnswered(stop.id, 'replied', 'Use the second option.');
    await lane.pass();
    await until(() => t3.sends.length === 2);
    expect(t3.sends[1].message).toContain('> Use the second option.');
  });
});

describe("a fixer's question (#158 F2)", () => {
  const asks = (q: string) => `I pushed what I have.\n\n\`\`\`queue-runner-question\n${q}\n\`\`\`\n`;

  test('a round that pushes and asks is a stop on the PR, recorded before the review lane hears of the end', async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    let stopsAtEnd: number | null = null;
    makeLane({ ended: (j) => { ended.push(j); stopsAtEnd = log.openStops(APP.id, 4).length; } });
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    gh.heads[4] = H2;
    t3.say('thread-b', asks('Keep v1 working too, or drop it?'));
    t3.endRun('thread-b', 'completed');
    await lane.idle();
    expect(fixes()[0]!.end).toMatchObject({ outcome: 'done', head: H2, question: 'Keep v1 working too, or drop it?' });
    expect(log.openStops(APP.id, 4)).toEqual([expect.objectContaining({ cause: 'question', job: fixes()[0]!.id, sha: H, why: expect.stringContaining('asks you: Keep v1 working too') })]);
    expect(stopsAtEnd).toBe(1);
  });

  test("a reply with no question block asks nothing; one T3 can't read is read again, never taken as none", async () => {
    await builder();
    await blocking(1, H, [finding({})]);
    const waits: (() => void)[] = [];
    makeLane({ retry: (again) => { waits.push(again); return () => {}; } });
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    gh.heads[4] = H2;
    t3.say('thread-b', asks('Which one?'));
    t3.readFailures = 1;
    t3.endRun('thread-b', 'completed');
    await until(() => lines.some((l) => l.includes("couldn't be read for a question")));
    expect(fixes()[0]!.end).toBeUndefined();
    for (const w of waits.splice(0)) w();
    await lane.idle();
    expect(fixes()[0]!.end).toMatchObject({ question: 'Which one?' });
  });
});
