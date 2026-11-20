// The build lane (#154) end to end on fake T3, fake GitHub and fake git: a served repo's next
// ticket is picked, let in by the usage gate, launched in a worktree from origin/<base> on the
// build kind's model, its end learned from T3's thread events and recorded, then its thread
// settled. Two served repos build side by side, one build each.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chooser } from '../src/chooser.ts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BuildLane, servedRepos, type BuildLaneDoors, type BuildRepo } from '../src/build-lane.ts';
import { CostLog } from '../src/cost-log.ts';
import type { Git } from '../src/git.ts';
import type { Issue } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.ts';
import { UsageGate } from '../src/usage-gate.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';
import { memoryJobFiles } from './memory-files.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const BUILD: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' };
const SOL: ModelChoice = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const LIB: BuildRepo = { id: 'p-lib', title: 'lib', folder: 'C:/code/lib', github: 'owner/lib' };

const issue = (number: number, part: Partial<Issue> = {}): Issue =>
  ({ number, title: `Ticket number ${number}`, body: `Do ${number}.`, openBlockers: 0, openSubIssues: 0, openLinkedPulls: 0, ...part });

class FakeGit implements Git {
  calls: string[] = [];
  leftover = new Set<string>();
  /** While set, a fetch waits on it (one under way). */
  slow: Promise<void> | null = null;
  async fetch(folder: string, base: string) { this.calls.push(`fetch ${folder} ${base}`); await this.slow; }
  async hasBranch(folder: string, branch: string) { this.calls.push(`hasBranch ${folder} ${branch}`); return this.leftover.has(branch); }
}

/** A gate with room for every job, recording what the lane tells it. It lets jobs in on
 *  `admits`, its own model unless said otherwise. */
class RoomyGate {
  calls: string[] = [];
  admits: { choice: ModelChoice; onFallback: boolean } = { choice: BUILD, onFallback: false };
  pick(id: string) { this.calls.push(`pick ${id}`); return { fits: true as const, ...this.admits, cost: { five_hour: 10 } }; }
  reading() { return { checkedAt: null, windows: {} }; }
  started(job: { id: string }) { this.calls.push(`started ${job.id}`); }
  finished(id: string, limit?: { resetAt: string | null }) { this.calls.push(`finished ${id}${limit ? ` out of usage until ${limit.resetAt}` : ''}`); }
  dropped(id: string) { this.calls.push(`dropped ${id}`); }
  forget() {}
}

let dir: string;
let t3: FakeT3;
let gh: FakeGitHub;
let git: FakeGit;
let log: JobLog;
let mcp: T3Mcp;
let ws: T3Ws;
let jobFiles: ReturnType<typeof memoryJobFiles>;
let lines: string[];
/** The lane's retry waits, run when the test says: no real timer (#202). */
let retries: Set<() => void>;
const retryNow = () => { const due = [...retries]; retries.clear(); for (const f of due) f(); };
let served: BuildRepo[];
let jobs: Jobs;
let lane: BuildLane;
/** The lane behind a chooser of its own: the chooser starts its jobs (#210). */
let chooser: Chooser;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-lane-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  // T3's address and the job log are the test's own, so each wait is on a fake (#202 F2); the
  // usage gate's cost log stays on disk, and its tests await it
  mcp = new T3Mcp(t3.address, t3.cli, t3.http);
  ws = new T3Ws(t3.address, t3.cli, t3.http, t3.connect);
  gh = new FakeGitHub();
  git = new FakeGit();
  jobFiles = memoryJobFiles();
  log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
  lines = [];
  retries = new Set();
  served = [APP];
  jobs = { ...DEFAULT_JOBS, build: { own: BUILD, fallback: null } };
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<BuildLaneDoors> = {}): Chooser {
  lane = new BuildLane({
    repos: () => served, github: gh, git, mcp, ws, gate: new RoomyGate() as any, catalog: () => catalog, jobs: () => jobs,
    user: async () => 'Robin', log, exists: (p) => p === 'C:/code/app/AGENTS.md', say: (l) => lines.push(l),
    retry: (again) => { retries.add(again); return () => { retries.delete(again); }; },
    freed: () => void chooser.pass(), ...part,
  });
  chooser = new Chooser({ repos: () => lane['d'].repos(), lanes: [lane], log, say: (l) => lines.push(l), now: lane['now'] });
  return chooser;
}

const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });
const organized = () => t3.toolCalls.filter((c) => c.tool === 't3_thread_organize').map((c) => c.args);
/** The thread's subscription is open, so an end T3 sends now reaches the lane. */
const watching = (threadId: string) => until(() => t3.threadStreamCount(threadId) > 0);

describe('picking and launching', () => {
  test('of two ready tickets the lower-numbered one with no open blocker is built, in a worktree from origin/<base> on the build kind\'s model', async () => {
    gh.ready['owner/app'] = [issue(8, { openBlockers: 1 }), issue(9, { openSubIssues: 2 }), issue(11), issue(12), issue(10)];
    gh.branchList['owner/app'] = ['claude/ticket-number-10-10'];
    gh.defaults['owner/app'] = 'trunk';
    gh.comments['owner/app#11'] = [{ author: 'sam', createdAt: '2026-11-19T09:00:00Z', body: 'Mind the edge case.' }];
    await makeLane().pass();
    expect(t3.launches).toHaveLength(1);
    const launch = t3.launches[0];
    expect(launch).toMatchObject({
      projectId: 'p-app', title: 'Queue runner build: app#11', runtimeMode: 'full-access',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] },
      workspaceStrategy: { type: 'worktree', baseRef: 'origin/trunk', branch: 'claude/ticket-number-11-11' },
    });
    expect(git.calls.slice(0, 2)).toEqual(['fetch C:/code/app trunk', 'hasBranch C:/code/app claude/ticket-number-11-11']);
    // the brief: the issue, its comment, the user, and nothing outside the repo
    expect(launch.message).toContain('Build GitHub issue #11 in owner/app: Ticket number 11');
    expect(launch.message).toContain('Mind the edge case.');
    expect(launch.message).toContain("Robin isn't watching it live");
    expect(launch.message).toContain("Read the repo's `AGENTS.md` first");
    expect(launch.message).not.toMatch(/\bskills?\b|~\/|\b[A-Za-z]:[\\/]|evidence\.py/i);
    expect(lane.running()).toEqual(['p-app']);
    // T3 made the branch and its worktree for this launch: recorded as the app's (#156 F15)
    await until(() => Boolean(log.jobs()[0]!.made));
    expect(log.jobs()[0]!.made).toEqual(['claude/ticket-number-11-11']);
  });

  test('a setting changed after the gate let the build in leaves it on the model let in', async () => {
    gh.ready['owner/app'] = [issue(11)];
    const other = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' };
    git.fetch = async () => { jobs = { ...jobs, build: { own: other, fallback: null } }; };
    await makeLane().pass();
    expect(t3.launches[0].modelSelection).toMatchObject({ instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    expect(log.jobs()[0]!.choice).toEqual(BUILD);
  });

  test("an unserved repo's tickets are never picked", async () => {
    gh.ready['owner/app'] = [issue(1)];
    gh.ready['owner/lib'] = [issue(2)];
    const list = [
      { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app', checking: false, served: true, merge: 'me' as const, isNew: false },
      { id: 'p-lib', title: 'lib', folder: 'C:/code/lib', github: 'owner/lib', checking: false, served: false, merge: 'me' as const, isNew: false },
      { id: 'p-none', title: 'none', folder: 'C:/code/none', github: null, checking: false, served: true, merge: 'me' as const, isNew: false },
    ];
    served = servedRepos(list);
    expect(served.map((r) => r.id)).toEqual(['p-app']);
    await makeLane().pass();
    expect(gh.reads).toEqual(['readyIssues owner/app']);
    expect(t3.launches.map((l) => l.projectId)).toEqual(['p-app']);
  });

  test('a repo switched off while its build fetches is not launched: the job is not-started and the gate drops it', async () => {
    gh.ready['owner/app'] = [issue(5)];
    let fetched!: () => void;
    git.slow = new Promise((r) => { fetched = r; });
    const gate = new RoomyGate();
    makeLane({ gate: gate as any });
    void chooser.pass();
    await until(() => git.calls.length > 0);
    served = [];
    fetched();
    await chooser.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'not-started', error: expect.stringMatching(/no longer served/) });
    expect(log.heldIssues('p-app')).toEqual(new Set());
    expect(gate.calls.at(-1)).toMatch(/^dropped /);
  });

  test('a repo switched off while the brief is written (the user name read) is not launched either', async () => {
    gh.ready['owner/app'] = [issue(5)];
    let named!: (name: string) => void;
    makeLane({ user: () => new Promise((r) => { named = r; }) });
    void chooser.pass();
    await until(() => named !== undefined);
    served = [];
    named('Robin');
    await chooser.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()[0]!.end?.outcome).toBe('not-started');
  });

  test('a repo switched off while GitHub is read for its ticket is never let in by the gate', async () => {
    gh.ready['owner/app'] = [issue(5)];
    const gate = new RoomyGate();
    const read = gh.defaultBranch.bind(gh);
    gh.defaultBranch = async (repo: string) => { served = []; return read(repo); };
    await makeLane({ gate: gate as any }).pass();
    expect(gate.calls).toEqual([]);
    expect(log.jobs()).toEqual([]);
  });

  test('the launch runs on the model the gate let the job in on, though Settings changed it meanwhile', async () => {
    gh.ready['owner/app'] = [issue(5)];
    let fetched!: () => void;
    git.slow = new Promise((r) => { fetched = r; });
    makeLane();
    void chooser.pass();
    await until(() => git.calls.length > 0);
    jobs = { ...jobs, build: { own: SOL, fallback: null } };
    fetched();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].modelSelection).toMatchObject({ instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
    expect(log.jobs()[0]!.choice).toEqual(BUILD);
  });

  test("a job let in on its kind's fallback runs on that fallback, though Settings dropped the fallback meanwhile", async () => {
    gh.ready['owner/app'] = [issue(5)];
    jobs = { ...jobs, build: { own: BUILD, fallback: SOL } };
    const gate = new RoomyGate();
    gate.admits = { choice: SOL, onFallback: true };
    let fetched!: () => void;
    git.slow = new Promise((r) => { fetched = r; });
    makeLane({ gate: gate as any });
    void chooser.pass();
    await until(() => git.calls.length > 0);
    jobs = { ...jobs, build: { own: BUILD, fallback: null } };
    fetched();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].modelSelection).toMatchObject({ instanceId: 'codex', model: 'gpt-6.2-sol' });
    expect(log.jobs()[0]).toMatchObject({ choice: SOL, onFallback: true });
  });

  test('one ticket at a time: no build while the repo has an open PR, whoever opened it; the next once it is gone (#179)', async () => {
    served = [APP, LIB];
    gh.ready['owner/app'] = [issue(5)];
    gh.ready['owner/lib'] = [issue(3)];
    gh.pulls['owner/app'] = [{ number: 40, branch: 'someone/their-change', body: 'Their own change.', url: 'https://github.com/owner/app/pull/40' }];
    await makeLane().pass();
    await chooser.pass();
    // app waits on its open PR; lib, with none, builds side by side as ever
    expect(t3.launches.map((l) => l.projectId)).toEqual(['p-lib']);
    expect(lines.filter((l) => /app: no build while PR #40 is open/.test(l))).toHaveLength(1);
    gh.pulls['owner/app'] = []; // merged: the merge lane asks for the tickets again (#210)
    lane.ticketsDue();
    await chooser.pass();
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: lib#3', 'Queue runner build: app#5']);
  });

  test('a PR opened while the build fetches holds it too: not launched, not-started', async () => {
    gh.ready['owner/app'] = [issue(5)];
    let fetched!: () => void;
    git.slow = new Promise((r) => { fetched = r; });
    makeLane();
    void chooser.pass();
    await until(() => git.calls.length > 0);
    gh.pulls['owner/app'] = [{ number: 41, branch: 'someone/else', body: '', url: 'u' }];
    fetched();
    await chooser.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'not-started', error: expect.stringMatching(/PR #41 was opened/) });
  });

  test('no ticket: nothing launched', async () => {
    await makeLane().pass();
    expect(t3.launches).toEqual([]);
  });
});

describe('the end', () => {
  test("a usage-limit end tells the gate its provider is out until T3's reset (#155 F22)", async () => {
    gh.ready['owner/app'] = [issue(5)];
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any }).pass();
    await watching('thread-1');
    t3.hitUsageLimit('thread-1', '2026-11-19T15:00:00.000Z');
    await chooser.idle();
    const [job] = log.jobs();
    expect(gate.calls).toContain(`finished ${job!.id} out of usage until 2026-11-19T15:00:00.000Z`);
  });

  test("a thread's end arrives as a T3 event and is recorded; then the thread is settled", async () => {
    gh.ready['owner/app'] = [issue(5)];
    gh.pullsFromBranch['owner/app:claude/ticket-number-5-5'] = { number: 77, url: 'https://github.com/owner/app/pull/77', state: 'open' };
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any }).pass();
    await watching('thread-1');
    expect(organized()).toEqual([]);
    t3.endRun('thread-1', 'completed');
    await chooser.idle();
    const [job] = log.jobs();
    expect(job).toMatchObject({ issue: 5, threadId: 'thread-1', runId: 'run-1', choice: BUILD, end: { outcome: 'done', status: 'completed', pr: { number: 77 } } });
    // recorded, then settled: the settle is the last call, on the thread the app launched
    expect(organized()).toEqual([{ threadId: 'thread-1', action: 'settle' }]);
    expect(t3.toolCalls.at(-1)!.tool).toBe('t3_thread_organize');
    const saved = jobFiles.files.get(join(dir, 'jobs.jsonl'))!.trim().split('\n').map((l) => JSON.parse(l));
    expect(saved.map((e) => e.event)).toEqual(['start', 'thread', 'made', 'end', 'settled']);
    expect(gate.calls).toEqual(['pick build:owner/app#5', `started ${job!.id}`, `finished ${job!.id}`]);
    // the issue stays held: a pass after the end builds nothing more
    expect(t3.launches).toHaveLength(1);
  });

  test('done with no PR is done-no-pr; a failed run keeps its error; both settled', async () => {
    gh.ready['owner/app'] = [issue(5), issue(6)];
    await makeLane().pass();
    await watching('thread-1');
    t3.endRun('thread-1', 'completed');
    await until(() => t3.launches.length === 2);
    await watching('thread-2');
    t3.threadEvent('thread-2', 'turn-item', { id: 'e', type: 'error', status: 'failed', runId: 'run-2', nodeId: 'node-2', failure: { class: 'provider_error', message: 'boom' } });
    t3.endRun('thread-2', 'failed');
    await chooser.idle();
    expect(log.jobs().map((j) => [j.issue, j.end?.outcome, j.end?.error ?? null])).toEqual([[5, 'done-no-pr', null], [6, 'failed', 'boom']]);
    expect(organized().map((a) => a.threadId)).toEqual(['thread-1', 'thread-2']);
  });

  test('a failed PR lookup is never taken as no PR: the end owes it, and a later pass records the PR (F13)', async () => {
    gh.ready['owner/app'] = [issue(5)];
    gh.pullsFromBranch['owner/app:claude/ticket-number-5-5'] = { number: 77, url: 'https://github.com/owner/app/pull/77', state: 'open' };
    gh.pullLookupFails = 2; // the end's lookup and the pass right after it
    await makeLane().pass();
    await watching('thread-1');
    t3.endRun('thread-1', 'completed');
    await chooser.idle();
    const [job] = log.jobs();
    expect(job!.end).toMatchObject({ outcome: 'done', error: expect.stringMatching(/PR lookup failed/) });
    expect(job!.end!.pr).toBeUndefined();
    expect(organized()).toEqual([{ threadId: 'thread-1', action: 'settle' }]);
    await chooser.pass();
    await chooser.idle();
    expect(log.get(job!.id)!.end).toMatchObject({ outcome: 'done', pr: { number: 77 } });
    expect(log.get(job!.id)!.end!.error).toBeUndefined();
    // looked up once it's found: a pass after that reads nothing more
    expect(log.prOwed()).toEqual([]);
  });

  test("a PR lookup owed when the app stopped is done on the next start; a read that finds none is done-no-pr (F13)", async () => {
    gh.ready['owner/app'] = [issue(5)];
    gh.pullLookupFails = 2;
    await makeLane().pass();
    await watching('thread-1');
    t3.endRun('thread-1', 'completed');
    await chooser.idle();
    lane.stop();
    expect(log.jobs()[0]!.end!.outcome).toBe('done');
    // restarted: the log as the stopped app left it
    log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
    await makeLane().start();
    await chooser.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'done-no-pr', pr: null });
    log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'done-no-pr', pr: null });
    expect(log.prOwed()).toEqual([]);
  });

  test('a question to the user and a usage limit are recorded as such and left unsettled', async () => {
    gh.ready['owner/app'] = [issue(5), issue(6)];
    await makeLane().pass();
    await watching('thread-1');
    t3.askUser('thread-1');
    await until(() => log.jobs()[0]!.end?.outcome === 'waiting');
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'waiting', request: 'user_input' });
    expect(organized()).toEqual([]);
    // answered in T3 and finished: then the next build, which a usage limit stops
    t3.answerInT3('thread-1');
    t3.endRun('thread-1', 'completed');
    await until(() => t3.launches.length === 2);
    await watching('thread-2');
    t3.hitUsageLimit('thread-2', '2026-11-19T15:00:00.000Z');
    await chooser.idle();
    expect(log.jobs()[1]!.end).toMatchObject({ outcome: 'usage-limit', resetAt: '2026-11-19T15:00:00.000Z' });
    expect(organized().map((a) => a.threadId)).toEqual(['thread-1']);
  });

  test("a build waiting on a question holds its repo while it runs again on an answer given in T3, and its real end is recorded in the question's place (#210 F5)", async () => {
    gh.ready['owner/app'] = [issue(5), issue(6)];
    await makeLane().pass();
    await watching('thread-1');
    t3.askUser('thread-1');
    await until(() => log.jobs()[0]!.end?.outcome === 'waiting');
    await chooser.pass();
    expect(t3.launches).toHaveLength(1);
    expect(lines).toContain("app: no new job now, Queue runner build: app#5 waits on a question, and runs again once it's answered: held until its thread finishes");
    // the user answers in T3, not through the app: the thread runs again, and nothing starts beside it
    t3.answerInT3('thread-1');
    await chooser.pass();
    expect(t3.launches).toHaveLength(1);
    // it asks again, and is answered again: still held
    t3.askUser('thread-1');
    t3.answerInT3('thread-1');
    await chooser.pass();
    expect(t3.launches).toHaveLength(1);
    gh.pullsFromBranch['owner/app:claude/ticket-number-5-5'] = { number: 9, url: 'https://github.com/owner/app/pull/9', state: 'open' };
    t3.endRun('thread-1', 'completed');
    await until(() => log.jobs()[0]!.end?.outcome === 'done');
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'done', pr: { number: 9 } });
    await until(() => organized().length === 1);
    expect(organized()[0]).toEqual({ threadId: 'thread-1', action: 'settle' });
  });

  test("after a restart a build left waiting holds its repo, also while its thread can't be read, until the thread shows it finished (#210 F5)", async () => {
    gh.ready['owner/app'] = [issue(6)];
    const waiting = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 5, branch: 'claude/x-5', base: 'main', title: 'Queue runner build: app#5', choice: BUILD, onFallback: false });
    await log.thread(waiting.id, { threadId: 'thread-w', runId: 'run-w', link: 't3://thread/thread-w' });
    await log.ended(waiting.id, { outcome: 'waiting', request: 'user_input' });
    // T3 can't read the thread yet
    await makeLane().start();
    await chooser.pass();
    expect(t3.launches).toEqual([]);
    await until(() => lines.some((l) => l.startsWith("Queue runner build: app#5: T3's thread stream dropped")));
    expect(t3.launches).toEqual([]);
    // the user answers through the app: the repo is still held, its thread may run on the answer
    await chooser.answered(waiting.id);
    expect(t3.launches).toEqual([]);
    // T3 reads it again: its run ran on the answer and has finished
    t3.threadState['thread-w'] = { id: 'thread-w', projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [{ id: 'run-w', threadId: 'thread-w', ordinal: 1, rootNodeId: 'n', status: 'completed' }] };
    retryNow();
    await until(() => t3.launches.length === 1);
    expect(log.get(waiting.id)!.end).toMatchObject({ outcome: 'done-no-pr' });
    expect(t3.launches[0].title).toBe('Queue runner build: app#6');
  });

  test("after a restart a repo with a build left waiting and another build open watches both: the waiting one isn't left holding the repo once the other ends (#210 F12)", async () => {
    gh.ready['owner/app'] = [issue(7)];
    // an older app left build A waiting on a question and started build B beside it in the repo
    const a = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 5, branch: 'claude/x-5', base: 'main', title: 'Queue runner build: app#5', choice: BUILD, onFallback: false });
    await log.thread(a.id, { threadId: 'thread-a', runId: 'run-a', link: 't3://thread/thread-a' });
    await log.ended(a.id, { outcome: 'waiting', request: 'user_input' });
    const b = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 6, branch: 'claude/x-6', base: 'main', title: 'Queue runner build: app#6', choice: BUILD, onFallback: false });
    await log.thread(b.id, { threadId: 'thread-b', runId: 'run-b', link: 't3://thread/thread-b' });
    for (const [id, run] of [['thread-a', 'run-a'], ['thread-b', 'run-b']] as const) {
      t3.threadState[id] = { id, projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [{ id: run, threadId: id, ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    }
    t3.askUser('thread-a');
    void makeLane().start();
    await watching('thread-b');
    await watching('thread-a');
    t3.endRun('thread-b', 'completed');
    await until(() => log.get(b.id)!.end?.outcome === 'done-no-pr');
    await chooser.pass();
    expect(t3.launches).toEqual([]); // A still waits on its question: held
    t3.answerInT3('thread-a');
    t3.endRun('thread-a', 'completed');
    await until(() => t3.launches.length === 1);
    expect(log.get(a.id)!.end).toMatchObject({ outcome: 'done-no-pr' });
    expect(t3.launches[0].title).toBe('Queue runner build: app#7');
  });

  test("a leftover branch of the job's name holds the job and says so; T3 is never asked", async () => {
    gh.ready['owner/app'] = [issue(5)];
    git.leftover.add('claude/ticket-number-5-5');
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any }).pass();
    await chooser.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'branch-exists' });
    expect(log.jobs()[0]!.made).toBeUndefined(); // the branch was there before: never the app's (#156 F15)
    expect(log.heldIssues('p-app')).toEqual(new Set([5]));
    expect(lines.join('\n')).toMatch(/not started: A local branch claude\/ticket-number-5-5 is left from an earlier run/);
    expect(gate.calls.at(-1)).toMatch(/^dropped /);
  });

  test('T3 refusing the launch is not-started: it holds nothing, and the repo rests', async () => {
    gh.ready['owner/app'] = [issue(5)];
    t3.launchFailure = { code: 'invalid_request', message: 'The project was not found.' };
    await makeLane({ restMs: 60_000 }).pass();
    await chooser.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'not-started', error: expect.stringMatching(/project was not found/) });
    expect(log.heldIssues('p-app')).toEqual(new Set());
    t3.launchFailure = null;
    await chooser.pass();
    expect(t3.launches).toEqual([]); // resting
  });

  test("a launch whose answer never came needs the user: nothing is adopted, and its repo starts nothing else until the user answers", async () => {
    gh.ready['owner/app'] = [issue(5), issue(6)];
    t3.launchAnswerLost = true; // T3 starts thread-1, and its answer is lost on the way
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any, restMs: 0 }).pass();
    await chooser.idle();
    const [job] = log.jobs();
    expect(job).toMatchObject({ issue: 5, end: { outcome: 'needs-user', error: expect.stringMatching(/answer was lost/) } });
    expect(job!.threadId).toBeUndefined();
    // T3 has a thread of this job's title and branch, and the lane never touches it
    expect(t3.threadState['thread-1']).toMatchObject({ title: 'Queue runner build: app#5', branch: 'claude/ticket-number-5-5' });
    expect(t3.threadStreamCount('thread-1')).toBe(0);
    expect(organized()).toEqual([]);
    expect(lines.join('\n')).toMatch(/app#5 needs you/);
    expect(gate.calls.at(-1)).toBe(`dropped ${job!.id}`);
    expect(log.heldIssues('p-app')).toEqual(new Set([5]));
    // no second build in the repo, however many passes, until the user answers
    t3.launchAnswerLost = false;
    await chooser.pass();
    await chooser.pass();
    expect(t3.launches).toHaveLength(1);
    await chooser.answered(job!.id); // its pass waits for the launch
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: app#5', 'Queue runner build: app#6']);
  });

  test('a review that needs the user holds builds in its repo too, and only there', async () => {
    gh.ready['owner/app'] = [issue(5)];
    const review = await log.started({ kind: 'review', repo: 'p-app', github: 'owner/app', issue: 4, branch: 'claude/x-3', base: 'main', title: 'Queue runner review: app#4', choice: BUILD, onFallback: false });
    await log.ended(review.id, { outcome: 'needs-user', error: 'lost' });
    await makeLane().pass();
    expect(t3.launches).toEqual([]);
    await chooser.answered(review.id);
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: app#5']);
  });

  test("a launch that never reached T3's tool call is not-started: nothing can have begun", async () => {
    gh.ready['owner/app'] = [issue(5)];
    const down = { call: async () => { throw new Error("T3's server can't be reached"); } };
    await makeLane({ mcp: down as any }).pass();
    await chooser.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'not-started' });
  });

  test('a stream that drops is opened again and still hears the end', async () => {
    gh.ready['owner/app'] = [issue(5)];
    await makeLane().pass();
    await watching('thread-1');
    t3.endThreadStreams();
    await until(() => lines.some((l) => /stream dropped/.test(l)) && retries.size > 0);
    retryNow();
    await watching('thread-1');
    t3.endRun('thread-1', 'completed');
    await chooser.idle();
    expect(log.jobs()[0]!.end?.outcome).toBe('done-no-pr');
  });
});

describe('an app that stopped mid-build', () => {
  test("a build the log shows open with no thread id needs the user: no thread is adopted by its title, branch or project, and its repo starts nothing", async () => {
    gh.ready['owner/app'] = [issue(7)];
    const open = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 5, branch: 'claude/x-5', base: 'origin/main', title: 'Queue runner build: app#5', choice: BUILD, onFallback: false });
    // a thread of the same title, branch and project: maybe this job's, maybe another client's
    t3.threadState['look-alike'] = { id: 'look-alike', projectId: 'p-app', title: 'Queue runner build: app#5', branch: 'claude/x-5', runtimeRequests: [], turnItems: [], runs: [{ id: 'r', ordinal: 1, rootNodeId: 'n', status: 'completed' }] };
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any }).start();
    await chooser.idle();
    expect(log.get(open.id)).toMatchObject({ end: { outcome: 'needs-user', error: expect.stringMatching(/stopped before T3 named its thread/) } });
    expect(log.get(open.id)!.threadId).toBeUndefined();
    expect(t3.threadStreamCount('look-alike')).toBe(0);
    expect(organized()).toEqual([]);
    expect(t3.launches).toEqual([]);
    expect(gate.calls).toEqual([`started ${open.id}`, `dropped ${open.id}`]);
    // a later start (the app restarted again) still holds the repo: the answer is the user's
    lane.stop();
    log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
    await makeLane().start();
    expect(t3.launches).toEqual([]);
    await chooser.answered(open.id);
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: app#7']);
  });

  test("a build the log shows open is watched again to its end, and holds its repo meanwhile; one T3 never named needs the user", async () => {
    gh.ready['owner/app'] = [issue(7)];
    const start = (issue: number, repo = 'p-app') => ({ kind: 'build' as const, repo, github: 'owner/app', issue, branch: `claude/x-${issue}`, base: 'origin/main', title: `Queue runner build: app#${issue}`, choice: BUILD, onFallback: false });
    const open = await log.started(start(5));
    await log.thread(open.id, { threadId: 'old-thread', runId: 'old-run', link: null });
    const lost = await log.started(start(6, 'p-other'));
    t3.threadState['old-thread'] = { id: 'old-thread', projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [{ id: 'old-run', ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    await makeLane().start();
    expect(t3.launches).toEqual([]); // app's one build is the open one
    expect(log.get(lost.id)!.end).toMatchObject({ outcome: 'needs-user' });
    await watching('old-thread');
    t3.endRun('old-thread', 'completed');
    await until(() => t3.launches.length === 1); // then app's next ticket
    expect(log.get(open.id)!.end?.outcome).toBe('done-no-pr');
    expect(organized()[0]).toEqual({ threadId: 'old-thread', action: 'settle' });
  });
});

describe('an app that stopped between recording an end and settling its thread (F9)', () => {
  const start = (issue: number) => ({ kind: 'build' as const, repo: 'p-app', github: 'owner/app', issue, branch: `claude/x-${issue}`, base: 'origin/main', title: `Queue runner build: app#${issue}`, choice: BUILD, onFallback: false });
  const ended = async (issue: number, outcome: 'done' | 'failed' | 'waiting' | 'usage-limit', thread: string | null = `t-${issue}`) => {
    const job = await log.started(start(issue));
    if (thread) {
      await log.thread(job.id, { threadId: thread, runId: null, link: null });
      t3.threadState[thread] = { id: thread, projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [{ id: 'r', ordinal: 1, rootNodeId: 'n', status: 'completed' }] };
    }
    await log.ended(job.id, { outcome });
    return job;
  };

  test("the next start settles the thread of an ended job with no settle recorded, and only that job's", async () => {
    const done = await ended(1, 'done');
    const failed = await ended(2, 'failed');
    await ended(3, 'waiting');
    await ended(4, 'usage-limit');
    const already = await ended(5, 'done');
    await log.settled(already.id);
    await log.started(start(6)).then((j) => log.ended(j.id, { outcome: 'needs-user', error: 'x' }));
    // restarted: the log as an app that stopped before settling left it
    log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
    await makeLane().start();
    await chooser.idle();
    // the question's thread shows its run finished: its real end replaces the question, and it's
    // settled as that end says (#210 F5); the usage limit and the job needing the user are left
    expect(organized().map((a) => a.threadId).sort()).toEqual(['t-1', 't-2', 't-3']);
    expect([done, failed].map((j) => log.get(j.id)!.settledAt)).toEqual([expect.any(String), expect.any(String)]);
    // recorded on disk, so a start after this one settles nothing again
    log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
    lane.stop();
    t3.toolCalls.length = 0;
    await makeLane().start();
    await chooser.idle();
    expect(organized()).toEqual([]);
  });

  test('a settle that fails is said and left unrecorded, so the next pass tries it again', async () => {
    const job = await ended(1, 'done', 'gone-thread');
    delete t3.threadState['gone-thread'];
    await makeLane().start();
    await chooser.idle();
    expect(lines.join('\n')).toMatch(/settling its thread gone-thread failed/);
    expect(log.get(job.id)!.settledAt).toBeUndefined();
    t3.threadState['gone-thread'] = { id: 'gone-thread', projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [] };
    await chooser.pass();
    await chooser.idle();
    expect(organized().map((a) => a.threadId)).toEqual(['gone-thread', 'gone-thread']);
    expect(log.get(job.id)!.settledAt).toEqual(expect.any(String));
  });
});

describe('an app that stopped mid-build, measured', () => {
  let source: T3Catalog;
  afterEach(() => source?.stop());

  const readAt = async (checkedAt: string, used: number) => {
    const providers = structuredClone(snapshot.config.providers);
    for (const p of providers) {
      if (!p.usageLimits) continue;
      p.usageLimits.checkedAt = checkedAt;
      for (const w of p.usageLimits.windows) w.usedPercent = used;
    }
    t3.pushConfig('providerStatuses', { providers });
    await until(() => source.current().usage.some((u) => u.checkedAt === checkedAt));
  };

  test("a build watched again after a restart is measured from the reading it was let in on, at the cost it was let in at", async () => {
    let now = new Date('2026-11-18T19:05:00Z');
    const settings: Settings = { ...DEFAULT_SETTINGS, jobs };
    source = T3Catalog.start(ws, 10);
    await until(() => source.current().usage.length > 0);
    await readAt('2026-11-18T19:04:30.000Z', 0);
    const costs = join(dir, 'usage.jsonl');
    gh.ready['owner/app'] = [issue(5)];
    const gate = new UsageGate(source, () => settings, await CostLog.open(costs), () => now);
    await makeLane({ gate, catalog: () => source.current().catalog }).pass();
    expect(t3.launches).toHaveLength(1);
    const admitted = log.jobs()[0]!;
    expect(admitted.before).toMatchObject({ checkedAt: '2026-11-18T19:04:30.000Z' });
    lane.stop();

    // the app restarts mid-run, with the provider at 25% by now
    now = new Date('2026-11-18T19:10:00Z');
    await readAt('2026-11-18T19:09:00.000Z', 25);
    log = await JobLog.open(join(dir, 'jobs.jsonl'), undefined, jobFiles);
    const again = new UsageGate(source, () => settings, await CostLog.open(costs), () => now);
    const started = vi.spyOn(again, 'started');
    makeLane({ gate: again, catalog: () => source.current().catalog });
    void chooser.start();
    await watching('thread-1');
    // reserved at the cost it was let in at, not what the gate would ask of a new build at 25%
    expect(started.mock.calls[0]![1]).toEqual(admitted.cost);
    now = new Date('2026-11-18T19:20:00Z');
    t3.endRun('thread-1', 'completed');
    await until(() => log.get(admitted.id)!.end !== undefined);
    await readAt('2026-11-18T19:30:00.000Z', 60);
    await again.settled();
    const [record] = (await CostLog.open(costs)).records();
    expect(record).toMatchObject({ job: admitted.id, before: { checkedAt: '2026-11-18T19:04:30.000Z' } });
    expect(Object.keys(record!.spent!).length).toBeGreaterThan(0);
    expect(Object.values(record!.spent!)).toEqual(Object.values(record!.spent!).map(() => 60));
  });

  test('a build left open by an app older than this record is measured as teaching nothing, not from a reading mid-run', async () => {
    const gate = new RoomyGate() as any;
    const calls: unknown[][] = [];
    gate.started = (...a: unknown[]) => calls.push(a);
    const open = await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 5, branch: 'claude/x-5', base: 'origin/main', title: 'Queue runner build: app#5', choice: BUILD, onFallback: false });
    await log.thread(open.id, { threadId: 'old-thread', runId: 'old-run', link: null });
    t3.threadState['old-thread'] = { id: 'old-thread', projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [{ id: 'old-run', ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    void makeLane({ gate }).start();
    await watching('old-thread');
    expect(calls[0]![2]).toEqual({ checkedAt: null, windows: {} });
  });
});

describe('repos side by side', () => {
  test('two served repos build side by side, one build each', async () => {
    served = [APP, LIB];
    gh.ready['owner/app'] = [issue(1), issue(2)];
    gh.ready['owner/lib'] = [issue(3), issue(4)];
    await makeLane().pass();
    expect(t3.launches.map((l) => [l.projectId, l.workspaceStrategy.branch])).toEqual([
      ['p-app', 'claude/ticket-number-1-1'], ['p-lib', 'claude/ticket-number-3-3'],
    ]);
    await chooser.pass(); // another pass while both run starts nothing
    expect(t3.launches).toHaveLength(2);
    await watching('thread-2');
    t3.endRun('thread-2', 'completed'); // lib's ends: lib takes its next, app's still runs
    await until(() => t3.launches.length === 3);
    expect(t3.launches[2]).toMatchObject({ projectId: 'p-lib', workspaceStrategy: { branch: 'claude/ticket-number-4-4' } });
    expect(lane.running().sort()).toEqual(['p-app', 'p-lib']);
  });

  test('the repo that waited longest goes first', async () => {
    served = [APP, LIB];
    gh.ready['owner/app'] = [issue(1)];
    gh.ready['owner/lib'] = [issue(3)];
    // app's last job ended just now; lib has had none
    await log.ended((await log.started({ kind: 'build', repo: 'p-app', github: 'owner/app', issue: 99, branch: 'b', base: 'origin/main', title: 't', choice: BUILD, onFallback: false })).id, { outcome: 'done' });
    await makeLane().pass();
    expect(t3.launches.map((l) => l.projectId)).toEqual(['p-lib', 'p-app']);
  });
});

describe('the usage gate', () => {
  let source: T3Catalog;
  afterEach(() => source?.stop());

  test('each build first waits for room in its provider: held, then built once T3 reads room', async () => {
    const now = new Date('2026-11-18T19:05:00Z');
    let settings: Settings = { ...DEFAULT_SETTINGS, jobs };
    source = T3Catalog.start(ws, 10);
    await until(() => source.current().usage.length > 0);
    const gate = new UsageGate(source, () => settings, await CostLog.open(join(dir, 'usage.jsonl')), () => now);
    gh.ready['owner/app'] = [issue(5)];
    makeLane({ gate, catalog: () => source.current().catalog });
    gate.onChange(() => chooser.usageChanged());
    await chooser.pass();
    // Claude's 5-hour window is 46% used and a build is expected to take 60%
    expect(t3.launches).toEqual([]);
    expect(lines.join('\n')).toMatch(/app#5 waits: .*5-hour.*resets at/i);
    const providers = structuredClone(snapshot.config.providers);
    for (const p of providers) {
      if (!p.usageLimits) continue;
      p.usageLimits.checkedAt = '2026-11-18T19:04:30.000Z';
      for (const w of p.usageLimits.windows) w.usedPercent = 0;
    }
    t3.pushConfig('providerStatuses', { providers });
    await until(() => t3.launches.length === 1);
    expect(gate.runningJobs()).toHaveLength(1);
  });
});
