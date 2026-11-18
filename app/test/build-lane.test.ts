// The build lane (#154) end to end on fake T3, fake GitHub and fake git: a served repo's next
// ticket is picked, let in by the usage gate, launched in a worktree from origin/<base> on the
// build kind's model, its end learned from T3's thread events and recorded, then its thread
// settled. Two served repos build side by side, one build each.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BuildLane, servedRepos, type BuildLaneDoors, type BuildRepo } from '../src/build-lane.ts';
import { CostLog } from '../src/cost-log.ts';
import type { Git } from '../src/git.ts';
import type { Issue } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Catalog } from '../src/t3/catalog-source.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.ts';
import { UsageGate } from '../src/usage-gate.ts';
import { FakeGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const BUILD: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const LIB: BuildRepo = { id: 'p-lib', title: 'lib', folder: 'C:/code/lib', github: 'owner/lib' };

const issue = (number: number, part: Partial<Issue> = {}): Issue =>
  ({ number, title: `Ticket number ${number}`, body: `Do ${number}.`, openBlockers: 0, openSubIssues: 0, openLinkedPulls: 0, ...part });

class FakeGit implements Git {
  calls: string[] = [];
  leftover = new Set<string>();
  async fetch(folder: string, base: string) { this.calls.push(`fetch ${folder} ${base}`); }
  async hasBranch(folder: string, branch: string) { this.calls.push(`hasBranch ${folder} ${branch}`); return this.leftover.has(branch); }
}

/** A gate with room for every job, recording what the lane tells it. */
class RoomyGate {
  calls: string[] = [];
  pick(id: string) { this.calls.push(`pick ${id}`); return { fits: true as const, choice: BUILD, onFallback: false, cost: { five_hour: 10 } }; }
  check() { return { fits: true as const, cost: { five_hour: 10 } }; }
  started(job: { id: string }) { this.calls.push(`started ${job.id}`); }
  finished(id: string) { this.calls.push(`finished ${id}`); }
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
let lines: string[];
let served: BuildRepo[];
let jobs: Jobs;
let lane: BuildLane;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-lane-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
  const address = runtimeAddress(join(dir, 'server-runtime.json'));
  mcp = new T3Mcp(address, t3.cli, t3.http);
  ws = new T3Ws(address, t3.cli, t3.http, t3.connect);
  gh = new FakeGitHub();
  git = new FakeGit();
  log = await JobLog.open(join(dir, 'jobs.jsonl'));
  lines = [];
  served = [APP];
  jobs = { ...DEFAULT_JOBS, build: { own: BUILD, fallback: null } };
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<BuildLaneDoors> = {}): BuildLane {
  lane = new BuildLane({
    repos: () => served, github: gh, git, mcp, ws, gate: new RoomyGate() as any, catalog: () => catalog, jobs: () => jobs,
    user: async () => 'Robin', log, exists: (p) => p === 'C:/code/app/AGENTS.md', say: (l) => lines.push(l),
    retry: (again) => { const t = setTimeout(again, 5); return () => clearTimeout(t); }, ...part,
  });
  return lane;
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

  test('no ticket: nothing launched', async () => {
    await makeLane().pass();
    expect(t3.launches).toEqual([]);
  });
});

describe('the end', () => {
  test("a thread's end arrives as a T3 event and is recorded; then the thread is settled", async () => {
    gh.ready['owner/app'] = [issue(5)];
    gh.pullsFromBranch['owner/app:claude/ticket-number-5-5'] = { number: 77, url: 'https://github.com/owner/app/pull/77', state: 'open' };
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any }).pass();
    await watching('thread-1');
    expect(organized()).toEqual([]);
    t3.endRun('thread-1', 'completed');
    await lane.idle();
    const [job] = log.jobs();
    expect(job).toMatchObject({ issue: 5, threadId: 'thread-1', runId: 'run-1', choice: BUILD, end: { outcome: 'done', status: 'completed', pr: { number: 77 } } });
    // recorded, then settled: the settle is the last call, on the thread the app launched
    expect(organized()).toEqual([{ threadId: 'thread-1', action: 'settle' }]);
    expect(t3.toolCalls.at(-1)!.tool).toBe('t3_thread_organize');
    const saved = (await readFile(join(dir, 'jobs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(saved.map((e) => e.event)).toEqual(['start', 'thread', 'end']);
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
    await lane.idle();
    expect(log.jobs().map((j) => [j.issue, j.end?.outcome, j.end?.error ?? null])).toEqual([[5, 'done-no-pr', null], [6, 'failed', 'boom']]);
    expect(organized().map((a) => a.threadId)).toEqual(['thread-1', 'thread-2']);
  });

  test('a question to the user and a usage limit are recorded as such and left unsettled', async () => {
    gh.ready['owner/app'] = [issue(5), issue(6)];
    await makeLane().pass();
    await watching('thread-1');
    t3.askUser('thread-1');
    await until(() => t3.launches.length === 2);
    await watching('thread-2');
    t3.hitUsageLimit('thread-2', '2026-11-19T15:00:00.000Z');
    await lane.idle();
    expect(log.jobs().map((j) => j.end)).toMatchObject([
      { outcome: 'waiting', request: 'user_input' },
      { outcome: 'usage-limit', resetAt: '2026-11-19T15:00:00.000Z' },
    ]);
    expect(organized()).toEqual([]);
  });

  test("a leftover branch of the job's name holds the job and says so; T3 is never asked", async () => {
    gh.ready['owner/app'] = [issue(5)];
    git.leftover.add('claude/ticket-number-5-5');
    const gate = new RoomyGate();
    await makeLane({ gate: gate as any }).pass();
    await lane.idle();
    expect(t3.launches).toEqual([]);
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'branch-exists' });
    expect(log.heldIssues('p-app')).toEqual(new Set([5]));
    expect(lines.join('\n')).toMatch(/not started: A local branch claude\/ticket-number-5-5 is left from an earlier run/);
    expect(gate.calls.at(-1)).toMatch(/^dropped /);
  });

  test('T3 refusing the launch is not-started: it holds nothing, and the repo rests', async () => {
    gh.ready['owner/app'] = [issue(5)];
    t3.launchFailure = { code: 'invalid_request', message: 'The project was not found.' };
    await makeLane({ restMs: 60_000 }).pass();
    await lane.idle();
    expect(log.jobs()[0]!.end).toMatchObject({ outcome: 'not-started', error: expect.stringMatching(/project was not found/) });
    expect(log.heldIssues('p-app')).toEqual(new Set());
    t3.launchFailure = null;
    await lane.pass();
    expect(t3.launches).toEqual([]); // resting
  });

  test('a stream that drops is opened again and still hears the end', async () => {
    gh.ready['owner/app'] = [issue(5)];
    await makeLane().pass();
    await watching('thread-1');
    t3.endThreadStreams();
    await until(() => lines.some((l) => /stream dropped/.test(l)));
    await watching('thread-1');
    t3.endRun('thread-1', 'completed');
    await lane.idle();
    expect(log.jobs()[0]!.end?.outcome).toBe('done-no-pr');
  });
});

describe('an app that stopped mid-build', () => {
  test("a build the log shows open is watched again to its end, and holds its repo meanwhile; one T3 never named is not-started", async () => {
    gh.ready['owner/app'] = [issue(7)];
    const start = (issue: number, repo = 'p-app') => ({ kind: 'build' as const, repo, github: 'owner/app', issue, branch: `claude/x-${issue}`, base: 'origin/main', title: `Queue runner build: app#${issue}`, choice: BUILD, onFallback: false });
    const open = await log.started(start(5));
    await log.thread(open.id, { threadId: 'old-thread', runId: 'old-run', link: null });
    const lost = await log.started(start(6, 'p-other'));
    t3.threadState['old-thread'] = { id: 'old-thread', projectId: 'p-app', runtimeRequests: [], turnItems: [], runs: [{ id: 'old-run', ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    await makeLane().start();
    expect(t3.launches).toEqual([]); // app's one build is the open one
    expect(log.get(lost.id)!.end).toMatchObject({ outcome: 'not-started' });
    await watching('old-thread');
    t3.endRun('old-thread', 'completed');
    await until(() => t3.launches.length === 1); // then app's next ticket
    expect(log.get(open.id)!.end?.outcome).toBe('done-no-pr');
    expect(organized()[0]).toEqual({ threadId: 'old-thread', action: 'settle' });
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
    await lane.pass(); // another pass while both run starts nothing
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
    gate.onChange(() => void lane.pass());
    await lane.pass();
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
