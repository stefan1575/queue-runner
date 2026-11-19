// The chooser (#210) on fake T3, fake GitHub and fake git, with the real fix, conflict and build
// lanes: one Claude job per served repo at a time, chosen in one place, in today's order within a
// repo (a fix round, a conflict round, a build), repos side by side, the one that waited longest
// first. Recovery comes before the first choice, a read that fails leaves the repo for the next
// pass, and passes never overlap.
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BuildLane, type BuildRepo } from '../src/build-lane.ts';
import { Chooser } from '../src/chooser.ts';
import { ConflictLane } from '../src/conflict-lane.ts';
import { FixLane } from '../src/fix-lane.ts';
import type { Issue, ReviewPull } from '../src/github.ts';
import { JobLog, type Job } from '../src/job-log.ts';
import { DEFAULT_JOBS, type Jobs, type ModelChoice } from '../src/jobs.ts';
import { mark } from '../src/review/ledger.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeMergeGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';
import { memoryJobFiles } from './memory-files.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const BUILD: ModelChoice = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const LIB: BuildRepo = { id: 'p-lib', title: 'lib', folder: 'C:/code/lib', github: 'owner/lib' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const H2 = '1234567890abcdef1234567890abcdef12345678';
const B1 = 'b1'.repeat(20);

const issue = (number: number): Issue =>
  ({ number, title: `Ticket number ${number}`, body: `Do ${number}.`, openBlockers: 0, openSubIssues: 0, openLinkedPulls: 0 });
const pull = (repo: BuildRepo, n: number, part: Partial<ReviewPull> = {}): ReviewPull =>
  ({ number: n, title: `PR ${n}`, body: `Closes #${n - 1}`, branch: `claude/thing-${n - 1}`, base: 'main', headSha: H, draft: false,
    url: `https://github.com/${repo.github}/pull/${n}`, headRepo: repo.github, ...part });

/** The lanes' GitHub: open PRs as the review, fix and conflict lanes list them (`reviewPulls`),
 *  each read as listed; a repo's PR list can fail to read. */
class LanesGitHub extends FakeMergeGitHub {
  /** Repos whose PR list fails to read, while they're named. */
  listFails = new Set<string>();
  async pullsToReview(repo: string) {
    if (this.listFails.has(repo)) throw new Error('gh api failed (1): HTTP 502');
    return super.pullsToReview(repo);
  }
  async openPulls(repo: string) {
    return (this.reviewPulls[repo] ?? []).map((p) => ({ number: p.number, branch: p.branch, body: p.body, url: p.url }));
  }
  async pull(repo: string, n: number) {
    const p = (this.reviewPulls[repo] ?? []).find((x) => x.number === n);
    if (!p) throw new Error(`gh api failed (1): HTTP 404 (${repo}#${n})`);
    return { number: n, title: p.title, url: p.url, state: 'open' as const, headSha: p.headSha, branch: p.branch, base: p.base, draft: p.draft,
      mergeable: !this.conflicting.has(`${repo}#${n}`), labels: [] };
  }
  async branchHead() { return B1; }
  push(repo: string, n: number, sha: string) {
    this.reviewPulls[repo] = this.reviewPulls[repo]!.map((p) => (p.number === n ? { ...p, headSha: sha } : p));
  }
}

class FakeGit {
  private gh: LanesGitHub;
  constructor(gh: LanesGitHub) { this.gh = gh; }
  async fetch() {}
  async hasBranch() { return false; }
  async fetchPr(folder: string, n: number) {
    const repo = folder.endsWith('lib') ? 'owner/lib' : 'owner/app';
    return this.gh.reviewPulls[repo]!.find((p) => p.number === n)!.headSha;
  }
  async log() { return [{ sha: H, subject: 'Add it' }]; }
  async diffstat() { return ' src/a.ts | 3 ++\n'; }
  async worktrees() { return []; }
}

/** A gate with room for `room` jobs at once: each let in takes one until it ends. */
class RoomGate {
  room = Infinity;
  private on = new Set<string>();
  private verdict() {
    return this.on.size < this.room ? { fits: true as const, choice: BUILD, onFallback: false, cost: { five_hour: 10 } }
      : { fits: false as const, until: null, hold: { why: 'reading' as const, provider: 'Claude', checkedAt: null, stale: 'none' as const } };
  }
  pick() { return this.verdict(); }
  check() { return this.verdict(); }
  reading() { return { checkedAt: null, windows: {} }; }
  started(job: { id: string }) { this.on.add(job.id); }
  finished(id: string) { this.on.delete(id); }
  dropped(id: string) { this.on.delete(id); }
  forget() {}
}

const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

let t3: FakeT3;
let gh: LanesGitHub;
let gate: RoomGate;
let log: JobLog;
let mcp: T3Mcp;
let ws: T3Ws;
let lines: string[];
let served: BuildRepo[];
let clock: Date;
let chooser: Chooser;
let builds: BuildLane;
let jobs: Jobs;

beforeEach(async () => {
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  mcp = new T3Mcp(t3.address, t3.cli, t3.http);
  ws = new T3Ws(t3.address, t3.cli, t3.http, t3.connect);
  gh = new LanesGitHub();
  gate = new RoomGate();
  clock = new Date('2026-11-20T12:00:00Z');
  log = await JobLog.open('C:/state/jobs.jsonl', () => clock, memoryJobFiles());
  lines = [];
  served = [APP];
  jobs = { ...DEFAULT_JOBS, default: BUILD };
});
afterEach(() => chooser?.stop());

function makeChooser() {
  const git = new FakeGit(gh);
  const common = {
    repos: () => served, github: gh, git, mcp, ws, gate: gate as any, catalog: () => catalog, user: async () => 'Pat', log,
    exists: () => true, say: (l: string) => lines.push(l), retry: () => () => {}, now: () => clock,
    freed: () => void chooser.pass(),
  };
  const fixes = new FixLane({ ...common, jobs: () => jobs });
  const conflicts = new ConflictLane(common);
  builds = new BuildLane({ ...common, jobs: () => jobs });
  chooser = new Chooser({ repos: () => served, lanes: [fixes, conflicts, builds], log, say: (l) => lines.push(l), now: () => clock });
  return chooser;
}

/** PR #n's builder: a build job with its thread, which T3 has, done. */
async function builder(repo: BuildRepo, n: number, thread: string): Promise<Job> {
  const job = await log.started({ kind: 'build', repo: repo.id, github: repo.github, issue: n - 1, branch: `claude/thing-${n - 1}`, base: 'main', title: `Queue runner build: ${repo.title}#${n - 1}`, choice: BUILD, onFallback: false });
  await log.thread(job.id, { threadId: thread, runId: `${thread}-run-1`, link: `t3://thread/${thread}` });
  t3.threadState[thread] = { id: thread, projectId: repo.id, runtimeRequests: [], turnItems: [], runs: [{ id: `${thread}-run-1`, threadId: thread, ordinal: 1, rootNodeId: 'node', status: 'completed' }] };
  return log.ended(job.id, { outcome: 'done', pr: { number: n, url: '', state: 'open' } });
}

/** Review 1 of PR #n's head, blocking, as the review lane leaves it. */
async function blocking(repo: BuildRepo, n: number, sha = H) {
  const url = `https://github.com/${repo.github}/pull/${n}#issuecomment-1`;
  const findings = [{ id: 'F1', tag: 'important' as const, class: 'unchecked input', file: 'src/a.ts', line: 3, scenario: 'empty input crashes', cost: '', rule: '', status: 'open' as const, raised: 1 }];
  (gh.comments[`${repo.github}#${n}`] ??= []).push({ author: 'me', createdAt: '2026-11-20T11:00:00Z', body: `## Sol review 1\n\n${mark(1, 'blocking', sha, findings)}`, url });
  const job = await log.started({ kind: 'review', repo: repo.id, github: repo.github, issue: n, branch: `claude/thing-${n - 1}`, base: 'main', title: `Queue runner review: ${repo.title}#${n}`, choice: BUILD, onFallback: false, sha, round: 1, reviewer: 'r' });
  return log.ended(job.id, { outcome: 'blocking', verdict: 'blocking', link: url });
}

const claude = () => log.jobs().filter((j) => j.kind !== 'review');
const started = (kind: string) => log.jobs().filter((j) => j.kind === kind && j.end?.outcome !== 'not-started');

describe('one job per repo', () => {
  test('a PR with a blocking review and a conflict at once gets one job, the fix round; its conflict round comes only after that round ends', async () => {
    gh.reviewPulls['owner/app'] = [pull(APP, 4)];
    gh.conflicting.add('owner/app#4');
    await builder(APP, 4, 'thread-b');
    await blocking(APP, 4);
    makeChooser();
    await Promise.all([chooser.start(), chooser.pass()]);
    await until(() => t3.sends.length === 1);
    expect(started('fix')).toHaveLength(1);
    expect(started('conflict')).toHaveLength(0);
    // more passes while the round runs start nothing beside it
    await chooser.pass();
    await chooser.pass();
    expect(t3.launches).toHaveLength(0);
    // the round pushes H2, which still conflicts: then the conflict round
    await until(() => t3.threadStreamCount('thread-b') > 0);
    gh.push('owner/app', 4, H2);
    t3.endRun('thread-b', 'completed');
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].title).toBe('Queue runner conflict: app#4');
    expect(started('conflict')[0]).toMatchObject({ sha: H2 });
  });

  test('two passes asked for at once start at most one job per repo', async () => {
    gh.reviewPulls['owner/app'] = [pull(APP, 4), pull(APP, 6)];
    await builder(APP, 4, 'thread-b4');
    await builder(APP, 6, 'thread-b6');
    await blocking(APP, 4);
    await blocking(APP, 6);
    makeChooser();
    await Promise.all([chooser.pass(), chooser.pass(), chooser.pass()]);
    await until(() => t3.sends.length >= 1);
    await chooser.pass();
    expect(t3.sends).toHaveLength(1);
    expect(started('fix')).toHaveLength(1);
    expect(started('fix')[0]!.issue).toBe(4); // lowest number first
  });

  test('after a restart with a fix round open, nothing else starts in that repo until the round is recovered', async () => {
    // a fix round on PR #4 the log shows open (its thread is still running in T3), PR #6
    // conflicting and a ready ticket: none of them goes beside the round
    gh.reviewPulls['owner/app'] = [pull(APP, 4), pull(APP, 6)];
    gh.conflicting.add('owner/app#6');
    gh.ready['owner/app'] = [issue(20)];
    await builder(APP, 4, 'thread-b');
    await blocking(APP, 4);
    const round = await log.started({ kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: 'claude/thing-3', base: 'main', title: 'Queue runner fix: app#4', choice: BUILD, onFallback: false, sha: H, round: 1, to: 'thread-b', knownRuns: ['thread-b-run-1'] });
    t3.threadState['thread-b']!.runs.push({ id: 'thread-b-run-2', threadId: 'thread-b', ordinal: 2, rootNodeId: 'node-2', status: 'running' });
    await log.thread(round.id, { threadId: 'thread-b', runId: 'thread-b-run-2', link: 't3://thread/thread-b' });
    makeChooser();
    await chooser.start();
    await until(() => t3.threadStreamCount('thread-b') > 0);
    await chooser.pass();
    expect(t3.launches).toHaveLength(0);
    expect(t3.sends).toHaveLength(0);
    expect(lines.some((l) => l.includes('Queue runner fix: app#4 is its job'))).toBe(true);
    // the round ends (no push: PR #4 waits for the user), and the next job goes: #6's conflict round
    t3.endRun('thread-b', 'completed');
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].title).toBe('Queue runner conflict: app#6');
  });

  test('two served repos get a job each side by side; with room for one, the repo that waited longest goes first', async () => {
    served = [APP, LIB];
    gh.ready['owner/app'] = [issue(1)];
    gh.ready['owner/lib'] = [issue(2)];
    makeChooser();
    await chooser.pass();
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: app#1', 'Queue runner build: lib#2']);
  });

  test('with room for one, the repo whose last Claude job ended longest ago goes first, whatever its lane', async () => {
    served = [APP, LIB];
    gate.room = 1;
    // lib's last job ended an hour ago, app's (its PR's build) a minute ago: lib has waited longer
    clock = new Date('2026-11-20T11:00:00Z');
    const l = await log.started({ kind: 'build', repo: LIB.id, github: 'owner/lib', issue: 8, branch: 'claude/x-8', base: 'main', title: 'Queue runner build: lib#8', choice: BUILD, onFallback: false });
    await log.ended(l.id, { outcome: 'done-no-pr' });
    clock = new Date('2026-11-20T11:59:00Z');
    // app has a fix round to start, lib a build
    gh.reviewPulls['owner/app'] = [pull(APP, 4)];
    await builder(APP, 4, 'thread-b');
    await blocking(APP, 4);
    clock = new Date('2026-11-20T12:00:00Z');
    gh.ready['owner/lib'] = [issue(2)];
    makeChooser();
    await chooser.pass();
    expect(t3.launches.map((x) => x.title)).toEqual(['Queue runner build: lib#2']);
    expect(t3.sends).toHaveLength(0);
  });

  test('a GitHub read that fails while choosing starts nothing in that repo, holds back no other, and the next pass tries again', async () => {
    served = [APP, LIB];
    gh.ready['owner/app'] = [issue(1)];
    gh.ready['owner/lib'] = [issue(2)];
    gh.listFails.add('owner/app'); // the fix lane can't list app's PRs
    makeChooser();
    await chooser.pass();
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: lib#2']);
    expect(lines.filter((l) => l.startsWith("app: no new job now, GitHub couldn't be read for fix rounds") && l.endsWith('tried again next pass'))).toHaveLength(1);
    gh.listFails.clear();
    await chooser.pass();
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: lib#2', 'Queue runner build: app#1']);
  });

  test("a conflict lane read that fails leaves the repo too: it's never taken as nothing to do, so no build goes", async () => {
    gh.ready['owner/app'] = [issue(1)];
    gh.reviewPulls['owner/app'] = [];
    makeChooser();
    // the PR list reads for fix rounds, then fails for conflicts
    let reads = 0;
    const list = gh.pullsToReview.bind(gh);
    gh.pullsToReview = async (repo: string) => { if (++reads === 2) throw new Error('gh api failed (1): HTTP 502'); return list(repo); };
    await chooser.pass();
    expect(t3.launches).toHaveLength(0);
    await chooser.pass();
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: app#1']);
  });

  test('new tickets are read from GitHub no more often than every 5 minutes, unless a build ended or a merge asks', async () => {
    makeChooser();
    await chooser.pass();
    expect(gh.reads.filter((r) => r === 'readyIssues owner/app')).toHaveLength(1);
    clock = new Date('2026-11-20T12:01:00Z');
    await chooser.pass();
    expect(gh.reads.filter((r) => r === 'readyIssues owner/app')).toHaveLength(1);
    builds.ticketsDue(); // a merge, or the served repos changing
    await chooser.pass();
    expect(gh.reads.filter((r) => r === 'readyIssues owner/app')).toHaveLength(2);
    clock = new Date('2026-11-20T12:06:00Z');
    await chooser.pass();
    expect(gh.reads.filter((r) => r === 'readyIssues owner/app')).toHaveLength(3);
  });

  test('a job a usage limit cut off holds its repo until its reset', async () => {
    gh.ready['owner/app'] = [issue(1)];
    const cut = await log.started({ kind: 'build', repo: APP.id, github: 'owner/app', issue: 9, branch: 'claude/x-9', base: 'main', title: 'Queue runner build: app#9', choice: BUILD, onFallback: false });
    await log.ended(cut.id, { outcome: 'usage-limit', resetAt: '2026-11-20T13:00:00Z' });
    makeChooser();
    await chooser.pass();
    expect(t3.launches).toHaveLength(0);
    expect(lines.some((l) => l.includes('Queue runner build: app#9 was cut off by a usage limit'))).toBe(true);
    clock = new Date('2026-11-20T13:03:00Z');
    await chooser.pass();
    expect(t3.launches.map((l) => l.title)).toEqual(['Queue runner build: app#1']);
  });
});
