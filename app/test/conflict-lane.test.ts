// The conflict lane (#157) on fake T3, fake GitHub and fake git: a PR whose head conflicts with its
// base gets one fresh thread on the conflict kind's settings, in the PR's worktree, that merges the
// base in and pushes; the review lane is told so the pushed head is reviewed next. One conflicted PR
// at a time, oldest first. A conflict back after the base moved gets another round; one back on the
// same base tip, or a round that ends without a push, is a stop recorded for the stops ticket.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BuildRepo } from '../src/build-lane.ts';
import { CAP } from '../src/cap.ts';
import { ConflictLane, NO_CHECKS_GRACE_MS, type ConflictLaneDoors } from '../src/conflict-lane.ts';
import { MAX_FAILED_MERGES } from '../src/merge-lane.ts';
import { MAX_FAILED } from '../src/review-lane.ts';
import { GitHubError, type ReviewPull } from '../src/github.ts';
import { JobLog, type Job, type JobStart } from '../src/job-log.ts';
import type { ModelChoice } from '../src/jobs.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { mark } from '../src/review/ledger.ts';
import { FakeReviewGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const CONFLICT: ModelChoice = { provider: 'claudeAgent', model: 'claude-haiku-5-5', effort: 'low' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const H2 = '1234567890abcdef1234567890abcdef12345678';
const H3 = '9'.repeat(40);
const B1 = 'b1'.repeat(20);
const B2 = 'b2'.repeat(20);
const pull = (n: number, part: Partial<ReviewPull> = {}): ReviewPull =>
  ({ number: n, title: `PR ${n}`, body: `Closes #${n - 1}`, branch: `claude/thing-${n - 1}`, base: 'main', headSha: H, draft: false, url: `https://github.com/owner/app/pull/${n}`, headRepo: 'owner/app', ...part });

class ConflictGitHub extends FakeReviewGitHub {
  /** The base branch's own tip, as the branches API has it. */
  tip = B1;
  tipFails = 0;
  pullFails = 0;
  tipReads = 0;
  threads: Record<string, number> = {};
  async openThreads(repo: string, n: number) { return this.threads[`${repo}#${n}`] ?? 0; }
  async branchHead(_repo: string, branch: string) {
    this.tipReads++;
    if (this.tipFails > 0) { this.tipFails--; throw new GitHubError('gh api branches failed (1): HTTP 502'); }
    if (branch !== 'main') throw new GitHubError(`no branch ${branch}`);
    return this.tip;
  }
  async pull(repo: string, n: number) {
    if (this.pullFails > 0) { this.pullFails--; throw new GitHubError('gh api failed (1): HTTP 502'); }
    return super.pull(repo, n);
  }
  /** The PR's head moves (a push), and it conflicts or not after. */
  push(n: number, sha: string, conflicts: boolean) {
    this.reviewPulls['owner/app'] = this.reviewPulls['owner/app']!.map((p) => (p.number === n ? { ...p, headSha: sha } : p));
    if (conflicts) this.conflicting.add(`owner/app#${n}`); else this.conflicting.delete(`owner/app#${n}`);
  }
}

class FakeGit {
  calls: string[] = [];
  trees: { path: string; branch: string | null }[] = [{ path: 'C:/code/app', branch: 'main' }];
  branches = new Set<string>();
  private gh: ConflictGitHub;
  constructor(gh: ConflictGitHub) { this.gh = gh; }
  async fetchPr(folder: string, n: number, base: string) {
    this.calls.push(`fetchPr ${folder} ${n} ${base}`);
    return this.gh.reviewPulls['owner/app']!.find((p) => p.number === n)!.headSha;
  }
  async log(_f: string, a: string, b: string) { this.calls.push(`log ${a.slice(0, 7)}..${b.slice(0, 7)}`); return a === 'origin/main' ? [{ sha: H, subject: 'Add it' }] : [{ sha: B1, subject: 'Landed on main' }]; }
  async diffstat() { return ' src/a.ts | 3 ++\n'; }
  async worktrees() { return structuredClone(this.trees); }
  async hasBranch(_f: string, b: string) { return this.branches.has(b); }
}

class FakeGate {
  calls: string[] = [];
  room = true;
  pick(id: string, kind: string) {
    this.calls.push(`pick ${id} ${kind}`);
    return this.room ? { fits: true as const, choice: CONFLICT, onFallback: false, cost: { five_hour: 40 } }
      : { fits: false as const, until: null, hold: { why: 'reading' as const, provider: 'Claude', checkedAt: null, stale: 'none' as const } };
  }
  started(job: { id: string; kind: string; choice: ModelChoice }) { this.calls.push(`started ${job.kind} ${job.choice.model}`); }
  finished(id: string) { this.calls.push(`finished ${id}`); }
  dropped(id: string) { this.calls.push(`dropped ${id}`); }
  forget() {}
}

const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

let dir: string;
let t3: FakeT3;
let gh: ConflictGitHub;
let git: FakeGit;
let gate: FakeGate;
let log: JobLog;
let mcp: T3Mcp;
let ws: T3Ws;
let lines: string[];
let ended: Job[];
let lane: ConflictLane;
let repoNow: BuildRepo;
/** The one clock the lane and the job log read. */
let clock: Date;
const PASSED = { state: 'passed' as const, pending: [], failed: [] };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-conflict-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
  const address = runtimeAddress(join(dir, 'server-runtime.json'));
  mcp = new T3Mcp(address, t3.cli, t3.http);
  ws = new T3Ws(address, t3.cli, t3.http, t3.connect);
  gh = new ConflictGitHub();
  gh.reviewPulls['owner/app'] = [pull(4)];
  gh.conflicting.add('owner/app#4');
  git = new FakeGit(gh);
  gate = new FakeGate();
  clock = new Date('2026-11-19T12:00:00Z');
  log = await JobLog.open(join(dir, 'state', 'jobs.jsonl'), () => clock);
  lines = [];
  ended = [];
  repoNow = APP;
});
afterEach(async () => {
  lane?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeLane(part: Partial<ConflictLaneDoors> = {}) {
  lane = new ConflictLane({
    repos: () => [repoNow], github: gh, git, mcp, ws, gate, catalog: () => catalog, user: async () => 'Pat', log,
    exists: () => true, say: (l) => lines.push(l), ended: (j) => ended.push(j), retry: () => () => {},
    now: () => clock, ...part,
  });
  return lane;
}

const rounds = () => log.jobs().filter((j) => j.kind === 'conflict');
const job = (part: Partial<JobStart>): JobStart => ({
  kind: 'conflict', repo: APP.id, github: 'owner/app', issue: 4, branch: 'claude/thing-3', base: 'main', title: 'Queue runner conflict: app#4',
  choice: CONFLICT, onFallback: false, sha: H, ...part,
});

/** The round on thread `thread` ends; pushing `to` first, conflicting after or not. */
async function finish(thread: string, n: number, to: string | null, conflictsAfter = false) {
  await until(() => t3.threadStreamCount(thread) > 0);
  if (to) gh.push(n, to, conflictsAfter);
  t3.endRun(thread, 'completed');
  await until(() => rounds().some((j) => j.threadId === thread && j.end));
}

describe('a conflict round', () => {
  test("a conflicting PR gets one thread on the conflict kind's settings, in the PR's worktree; its pushed head is reviewed next", async () => {
    git.trees.push({ path: 'C:/t3/worktrees/app/thing-3', branch: 'claude/thing-3' });
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(gate.calls).toContain('pick conflict:owner/app#4 conflict');
    expect(gate.calls).toContain('started conflict claude-haiku-5-5');
    expect(t3.launches[0]).toMatchObject({
      projectId: APP.id, title: 'Queue runner conflict: app#4',
      modelSelection: { instanceId: CONFLICT.provider, model: CONFLICT.model },
      workspaceStrategy: { type: 'existing_worktree', worktreePath: 'C:/t3/worktrees/app/thing-3' },
    });
    expect(t3.launches[0].message).toContain('Conflict round on PR #4 in owner/app: PR 4');
    expect(t3.launches[0].message).toContain('- `b1b1b1b` Landed on main');
    const r = rounds()[0]!;
    expect(r).toMatchObject({ sha: H, baseSha: B1, threadId: 'thread-1', choice: CONFLICT });
    expect(r.made).toBeUndefined(); // the PR's own worktree: nothing made (#156 F15)
    // a pass while it runs starts nothing beside it
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
    await finish('thread-1', 4, H2);
    await lane.idle();
    expect(log.get(r.id)).toMatchObject({ end: { outcome: 'done', head: H2 }, settledAt: expect.any(String) });
    expect(ended.map((j) => j.id)).toEqual([r.id]);
    expect(lines.some((l) => l.includes('pushed 1234567: reviewed next'))).toBe(true);
    expect(log.stops()).toEqual([]);
    // the pushed head doesn't conflict: no round on it
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
  });

  test('with no worktree on the PR\'s branch, a new one at H on its own branch, recorded as made, pushing to the PR\'s', async () => {
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].workspaceStrategy).toEqual({ type: 'worktree', baseRef: H, branch: 'claude/conflict-pr4-abcdef1-b1b1b1b' });
    expect(t3.launches[0].message).toContain('`git push origin HEAD:claude/thing-3`');
    await until(() => rounds()[0]?.made !== undefined);
    expect(rounds()[0]).toMatchObject({ workBranch: 'claude/conflict-pr4-abcdef1-b1b1b1b', made: ['claude/conflict-pr4-abcdef1-b1b1b1b'] });
  });

  test('a round that ends without a push files no stop: H gets another round once the base moves, and not before (#158)', async () => {
    makeLane();
    await lane.pass();
    await finish('thread-1', 4, null);
    await lane.idle();
    expect(log.stops()).toEqual([]);
    expect(lines.some((l) => l.includes('without a push: another round once main moves'))).toBe(true);
    await lane.pass();
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
    expect(lines.at(-1)).toContain("the conflict round on abcdef1 couldn't resolve it (it ended done without a push), and main is still at b1b1b1b, which that round merged: another round once main moves");
    // main moves: another round on the same head, on a branch of its own
    gh.tip = B2;
    await lane.pass();
    await until(() => t3.launches.length === 2);
    expect(rounds()[1]).toMatchObject({ sha: H, baseSha: B2 });
    expect(t3.launches[1].workspaceStrategy).toEqual({ type: 'worktree', baseRef: H, branch: 'claude/conflict-pr4-abcdef1-b2b2b2b' });
    expect(log.stops()).toEqual([]);
  });

  test('a conflict back after the base moved gets another round; back on the same tip, it waits for the base, with no stop', async () => {
    makeLane();
    await lane.pass();
    // main moves on while round 1 runs, after it merged main at B1: its push conflicts again
    gh.tip = B2;
    await finish('thread-1', 4, H2, true);
    await until(() => t3.launches.length === 2);
    expect(rounds()[1]).toMatchObject({ sha: H2, baseSha: B2 });
    // round 2's push conflicts again, and main is still at B2: it waits, no stop
    await finish('thread-2', 4, H3, true);
    await lane.idle();
    await lane.pass();
    expect(t3.launches).toHaveLength(2);
    expect(log.stops()).toEqual([]);
    expect(lines.at(-1)).toContain('it conflicts again after the round on 1234567, and main is still at b2b2b2b');
  });

  test('a round that failed without a push gets another at once; each counts toward the cap', async () => {
    makeLane();
    await lane.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.endRun('thread-1', 'failed');
    await until(() => t3.launches.length === 2);
    expect(rounds()[0]!.end).toMatchObject({ outcome: 'failed', head: H });
    expect(log.stops()).toEqual([]);
  });

  test("the base's tip is read from the branch, never the PR's base: a read that fails starts nothing and stops nothing", async () => {
    makeLane();
    await lane.pass();
    gh.tipFails = 1000;
    await finish('thread-1', 4, H2, true);
    await lane.idle();
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
    expect(log.stops()).toEqual([]);
    expect(lines.some((l) => l.includes('no conflict round now, reading it failed') && l.includes('HTTP 502'))).toBe(true);
    gh.tipFails = 0;
    gh.tip = B2;
    await lane.pass();
    await until(() => t3.launches.length === 2);
  });

  test(`the cap: past ${CAP - 1} rounds since the user's last answer, a conflict is a cap stop for a rethink, not another round`, async () => {
    for (let k = 0; k < CAP - 1; k++) {
      const j = await log.started(job({ sha: String(k).repeat(40), baseSha: `${k}`.repeat(40) }));
      await log.ended(j.id, { outcome: 'done', head: String(k + 1).repeat(40) });
    }
    gh.tip = B2;
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(log.openStops(APP.id, 4)).toEqual([expect.objectContaining({ cause: 'cap', sha: H, why: expect.stringContaining(`${CAP - 1} rounds since your last answer`) })]);
    // answered: the count starts again, and the round goes
    clock = new Date('2026-11-19T12:05:00Z');
    await log.stopAnswered(log.openStops(APP.id, 4)[0]!.id, 'replied', 'go on');
    clock = new Date('2026-11-19T12:06:00Z');
    await lane.pass();
    await until(() => t3.launches.length === 1);
  });
});

describe('one conflicted PR at a time, oldest first', () => {
  test('two conflicting PRs: the lower number goes first; the other waits until it has merged', async () => {
    gh.reviewPulls['owner/app'] = [pull(5), pull(4)];
    gh.conflicting.add('owner/app#5');
    makeLane();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].title).toBe('Queue runner conflict: app#4');
    await until(() => lines.includes('conflict app#5: no conflict round now, the conflict round on PR #4 runs first: one conflicted PR at a time'));
    gh.checkStates[H2] = PASSED;
    await finish('thread-1', 4, H2);
    await lane.idle();
    // #4 is on its way to merging (reviewed next): #5 waits to resolve against what it lands on
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
    expect(lines).toContain('conflict app#5: no conflict round now, PR #4 had a conflict round and is still on its way to merging (1234567 is reviewed next): one conflicted PR at a time');
    // #4 merged: gone from the open list
    gh.reviewPulls['owner/app'] = [pull(5)];
    await lane.pass();
    await until(() => t3.launches.length === 2);
    expect(t3.launches[1].title).toBe('Queue runner conflict: app#5');
  });

  describe('a PR that had a round holds the others only while the loop moves it (F6)', () => {
    /** #4 had its round and pushed H2, which merges; #5 conflicts. */
    async function afterRound4() {
      gh.reviewPulls['owner/app'] = [pull(4), pull(5)];
      gh.conflicting.add('owner/app#5');
      gh.checkStates[H2] = PASSED;
      makeLane();
      await lane.pass();
      await finish('thread-1', 4, H2);
      await lane.idle();
      expect(t3.launches).toHaveLength(1);
    }
    async function review4(outcome: 'clean' | 'blocking') {
      const url = `https://github.com/owner/app/pull/4#issuecomment-1`;
      (gh.comments['owner/app#4'] ??= []).push({ author: 'me', createdAt: '2026-11-19T11:00:00Z', body: mark(1, outcome, H2, []), url });
      const r = await log.started({ ...job({ kind: 'review', round: 1, sha: H2 }), title: 'Queue runner review: app#4' });
      await log.ended(r.id, { outcome, verdict: outcome, link: url });
    }
    const goes5 = async () => {
      await lane.pass();
      await until(() => t3.launches.length === 2);
      expect(t3.launches[1].title).toBe('Queue runner conflict: app#5');
    };

    test('a draft holds nothing', async () => {
      await afterRound4();
      gh.reviewPulls['owner/app'] = gh.reviewPulls['owner/app']!.map((p) => (p.number === 4 ? { ...p, draft: true } : p));
      await goes5();
    });

    test('a failed check on its head holds the others while its re-run or fix round is to come, and nothing once it is stopped for the user (#158)', async () => {
      await afterRound4();
      gh.checkStates[H2] = { state: 'failed', pending: [], failed: ['tests'] };
      await lane.pass();
      expect(t3.launches).toHaveLength(1);
      expect(lines.some((l) => l.includes('a check failed on 1234567 (tests): its re-run or fix round comes first'))).toBe(true);
      await log.stopped({ cause: 'question', repo: APP.id, github: 'owner/app', pr: 4, sha: H2, why: 'the fix round asked', link: null });
      await goes5();
    });

    test('a question to the user on its branch holds nothing', async () => {
      await afterRound4();
      const fix = await log.started(job({ kind: 'fix', title: 'Queue runner fix: app#4', sha: H2, round: 1 }));
      await log.ended(fix.id, { outcome: 'waiting', request: 'user_input' });
      await goes5();
    });

    test('a clean review where the user merges holds nothing, marked or not', async () => {
      await afterRound4();
      await review4('clean');
      await goes5();
    });

    test('a clean review where the app merges holds the others until a reply or an open thread leaves it for the user', async () => {
      repoNow = { ...APP, merge: 'runner' };
      await afterRound4();
      await review4('clean');
      await lane.pass();
      expect(t3.launches).toHaveLength(1);
      expect(lines.at(-1)).toContain('PR #4 had a conflict round and is still on its way to merging (clean at 1234567, merged next)');
      gh.threads['owner/app#4'] = 1;
      await goes5();
    });

    test("reviews that failed past the review lane's cut-off hold nothing; one failed review still holds (F7)", async () => {
      await afterRound4();
      const failed = async () => {
        const r = await log.started({ ...job({ kind: 'review', round: 1, sha: H2 }), title: 'Queue runner review: app#4' });
        await log.ended(r.id, { outcome: 'failed', error: 'the thread failed' });
      };
      for (let k = 1; k < MAX_FAILED; k++) await failed();
      await lane.pass();
      expect(t3.launches).toHaveLength(1);
      expect(lines.at(-1)).toContain('(1234567 is reviewed next)');
      await failed(); // the review lane leaves H2 until a new head
      await goes5();
    });

    test('a head with no checks reported holds the others for NO_CHECKS_GRACE_MS after its round pushed it, then nothing (F7)', async () => {
      await afterRound4();
      delete gh.checkStates[H2];
      await lane.pass();
      expect(t3.launches).toHaveLength(1);
      expect(lines.at(-1)).toContain('(no checks reported on 1234567 yet, held until 2026-11-19T12:10:00.000Z at most)');
      clock = new Date(clock.getTime() + NO_CHECKS_GRACE_MS);
      await goes5();
    });

    test('checks still running hold the others however long they take (F7)', async () => {
      await afterRound4();
      gh.checkStates[H2] = { state: 'pending', pending: ['tests'], failed: [] };
      clock = new Date(clock.getTime() + 2 * NO_CHECKS_GRACE_MS);
      await lane.pass();
      expect(t3.launches).toHaveLength(1);
      expect(lines.at(-1)).toContain('(checks still running on 1234567 (tests))');
    });

    test('a review of its head on GitHub the log lacks holds nothing: no lane acts on it (F7)', async () => {
      await afterRound4();
      (gh.comments['owner/app#4'] ??= []).push({ author: 'me', createdAt: '2026-11-19T11:00:00Z', body: mark(1, 'blocking', H2, []), url: 'u' });
      await goes5();
    });

    test('a blocking review whose fix round ended on its head holds nothing (F7)', async () => {
      await afterRound4();
      await review4('blocking');
      const fix = await log.started(job({ kind: 'fix', title: 'Queue runner fix: app#4', sha: H2, round: 1 }));
      await log.ended(fix.id, { outcome: 'failed', error: 'it failed' });
      await goes5();
    });

    test("merges that failed past the merge lane's cut-off hold nothing (F7)", async () => {
      repoNow = { ...APP, merge: 'runner' };
      await afterRound4();
      await review4('clean');
      for (let k = 0; k < MAX_FAILED_MERGES; k++) {
        const step = await log.stepStarted({ kind: 'merge', repo: APP.id, github: 'owner/app', pr: 4, branch: 'claude/thing-3', sha: H2 });
        await log.stepEnded(step.id, { outcome: 'failed', error: 'HTTP 405' });
      }
      await goes5();
    });

    test('a blocking review still holds the others: its fix round comes', async () => {
      await afterRound4();
      await review4('blocking');
      await lane.pass();
      expect(t3.launches).toHaveLength(1);
      expect(lines.at(-1)).toContain('(review 1 of 1234567 gets its fix round)');
    });
  });

  test('a PR whose conflict waits for the base to move holds no other back: the next merge is what moves it', async () => {
    gh.reviewPulls['owner/app'] = [pull(4), pull(5)];
    gh.conflicting.add('owner/app#5');
    makeLane();
    await lane.pass();
    await finish('thread-1', 4, null); // no push: #4 waits for main to move
    await until(() => t3.launches.length === 2);
    expect(t3.launches[1].title).toBe('Queue runner conflict: app#5');
  });

  test('the gate holding the first holds the rest; it says why once', async () => {
    gh.reviewPulls['owner/app'] = [pull(4), pull(5)];
    gh.conflicting.add('owner/app#5');
    gate.room = false;
    makeLane();
    await lane.pass();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines.filter((l) => l.startsWith('conflict app#4: no conflict round now, waits:'))).toHaveLength(1);
    expect(lines).toContain('conflict app#5: no conflict round now, PR #4 resolves its conflict first: one conflicted PR at a time');
  });
});

describe('what waits', () => {
  test('a blocking review on H waits for its fix round; a job writing to the branch, or a review running, waits', async () => {
    const review = await log.started({ ...job({ kind: 'review', round: 1 }), title: 'Queue runner review: app#4' });
    makeLane();
    await lane.pass();
    expect(lines.at(-1)).toBe('conflict app#4: no conflict round now, a review of PR #4 is running');
    await log.ended(review.id, { outcome: 'blocking', verdict: 'blocking' });
    await lane.pass();
    expect(lines.at(-1)).toBe('conflict app#4: no conflict round now, review 1 of abcdef1 is blocking: its fix round comes first');
    const fix = await log.started(job({ kind: 'fix', title: 'Queue runner fix: app#4', round: 1 }));
    await lane.pass();
    expect(lines.at(-1)).toBe('conflict app#4: no conflict round now, a fix job is writing to claude/thing-3');
    // the fix round ended without a push: H is the user's, not a conflict round's
    await log.ended(fix.id, { outcome: 'done', head: H });
    await lane.pass();
    expect(lines.at(-1)).toBe('conflict app#4: no conflict round now, left for you: a fix round on abcdef1 ended done without a push');
    expect(t3.launches).toEqual([]);
  });

  test("GitHub still working out whether a PR merges (null) is not known yet: neither it nor a newer conflicting PR goes first (F5)", async () => {
    gh.reviewPulls['owner/app'] = [pull(4), pull(5)];
    gh.computing.add('owner/app#4');
    gh.conflicting.add('owner/app#5');
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines).toEqual([
      "conflict app#4: no conflict round now, GitHub hasn't worked out yet whether abcdef1 conflicts with main; read again next pass",
      "conflict app#5: no conflict round now, GitHub hasn't said yet whether the older PR #4 conflicts: oldest first",
    ]);
    // GitHub answers: #4 conflicts, and it goes first
    gh.computing.clear();
    await lane.pass();
    await until(() => t3.launches.length === 1);
    expect(t3.launches[0].title).toBe('Queue runner conflict: app#4');
  });

  test("a PR read that fails starts nothing", async () => {
    gh.pullFails = 1;
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines.some((l) => l.includes("GitHub couldn't be read for conflicts"))).toBe(true);
    await lane.pass();
    await until(() => t3.launches.length === 1);
  });

  test("a fork's PR gets no round, since it would push to this repo's branch of that name: it's left for the user", async () => {
    gh.reviewPulls['owner/app'] = [pull(4, { headRepo: 'someone/app', branch: 'main' })];
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(lines.at(-1)).toContain("its head is in someone/app, not owner/app: no conflict round pushes to a fork's branch");
  });

  test('a fix round another lane starts on the branch while the round is fetched: the round starts nothing', async () => {
    const fetch = git.fetchPr.bind(git);
    git.fetchPr = async (f, n, b) => {
      await log.started(job({ kind: 'fix', title: 'Queue runner fix: app#4', round: 1 }));
      return fetch(f, n, b);
    };
    makeLane();
    await lane.pass();
    await lane.idle();
    expect(t3.launches).toEqual([]);
    expect(rounds()[0]!.end).toMatchObject({ outcome: 'not-started', error: 'a fix job started on PR #4 meanwhile' });
    expect(gate.calls.some((c) => c.startsWith('dropped conflict-'))).toBe(true);
  });

  test('a head that moved since listing starts nothing; the PR rests', async () => {
    git.fetchPr = async () => H2;
    makeLane();
    await lane.pass();
    expect(t3.launches).toEqual([]);
    expect(rounds()).toEqual([]);
    expect(lines.some((l) => l.includes('the head moved from abcdef1 to 1234567'))).toBe(true);
  });
});

describe("after a restart, don't guess", () => {
  test('a launch whose answer was lost needs the user: its repo starts nothing until they answer', async () => {
    t3.launchAnswerLost = true;
    makeLane();
    await lane.pass();
    await lane.idle();
    const r = rounds()[0]!;
    expect(log.get(r.id)!.end).toMatchObject({ outcome: 'needs-user' });
    expect(log.needingUser(APP.id).map((j) => j.id)).toEqual([r.id]);
    await lane.pass();
    expect(t3.launches).toHaveLength(1);
  });

  test('a launch answer that names no thread needs the user, never a watch on no thread (N1)', async () => {
    t3.launchOmitsThreadId = true;
    makeLane();
    await lane.pass();
    await lane.idle();
    const r = rounds()[0]!;
    expect(log.get(r.id)).toMatchObject({ end: { outcome: 'needs-user', error: expect.stringContaining('named no thread') } });
    expect(log.get(r.id)!.threadId).toBeUndefined();
    expect(log.needingUser(APP.id).map((j) => j.id)).toEqual([r.id]);
  });

  test('a round the log shows open is watched again on its thread; one with no thread line needs the user', async () => {
    const open = await log.started(job({ baseSha: B1 }));
    await log.thread(open.id, { threadId: 'thread-x', runId: 'run-x', link: null });
    t3.threadState['thread-x'] = { id: 'thread-x', projectId: APP.id, runtimeRequests: [], turnItems: [], runs: [{ id: 'run-x', threadId: 'thread-x', ordinal: 1, rootNodeId: 'n', status: 'running' }] };
    makeLane();
    void lane.start();
    await finish('thread-x', 4, H2);
    await lane.idle();
    expect(log.get(open.id)!.end).toMatchObject({ outcome: 'done', head: H2 });
    expect(t3.launches).toEqual([]);

    lane.stop();
    const lost = await log.started(job({ sha: H2 }));
    makeLane();
    await lane.start();
    await lane.idle();
    expect(log.get(lost.id)!.end).toMatchObject({ outcome: 'needs-user', error: expect.stringContaining('before T3 named its thread') });
    expect(t3.launches).toEqual([]);
  });
});
