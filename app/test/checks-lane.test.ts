// The checks lane (#158) on fake GitHub: a failed check is re-run once; failing again it's recorded
// for a fix round with its log; one the base fails too waits, and the PR is brought up to date
// once the base moves. None of it files a stop.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { BuildRepo } from '../src/build-lane.ts';
import { ChecksLane } from '../src/checks-lane.ts';
import type { ReviewPull } from '../src/github.ts';
import { JobLog } from '../src/job-log.ts';
import { FakeMergeGitHub } from './fake-github.ts';
import { memoryJobFiles } from './memory-files.ts';

const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const H2 = '1234567890abcdef1234567890abcdef12345678';
const B1 = 'b1'.repeat(20);
const B2 = 'b2'.repeat(20);
const pull = (part: Partial<ReviewPull> = {}): ReviewPull =>
  ({ number: 4, title: 'Add a thing', body: 'Closes #3', branch: 'claude/add-a-thing-3', base: 'main', headSha: H, draft: false, url: '', headRepo: 'owner/app', ...part });
const FAILED = (...failed: string[]) => ({ state: 'failed' as const, pending: [], failed });

let dir: string;
let gh: FakeMergeGitHub;
let log: JobLog;
let lines: string[];
let lane: ChecksLane;
let failedAgain: number;
let tick: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-checks-'));
  tick = 0;
  log = await JobLog.open(join(dir, 'jobs.jsonl'), () => new Date(Date.UTC(2026, 10, 19, 12, 0, tick++)), memoryJobFiles());
  gh = new FakeMergeGitHub();
  gh.reviewPulls['owner/app'] = [pull()];
  gh.tips['owner/app:main'] = B1;
  gh.checkStates[H] = FAILED('tests');
  gh.checkStates[B1] = { state: 'passed', pending: [], failed: [] };
  gh.failedRunsOn[H] = { tests: 77 };
  gh.runs[77] = { id: 77, attempt: 1, status: 'completed', conclusion: 'failure' };
  lines = [];
  failedAgain = 0;
  lane = new ChecksLane({ repos: () => [APP], github: gh, log, say: (l) => lines.push(l), failedAgain: () => failedAgain++ });
});
afterEach(async () => {
  lane.stop();
  await rm(dir, { recursive: true, force: true });
});

const steps = (kind: string) => log.steps().filter((s) => s.kind === kind);

describe('a failed check', () => {
  test('is re-run once; failing again, recorded for a fix round with its run; no stop', async () => {
    await lane.pass();
    expect(gh.posted.filter((p) => p.what === 'rerun')).toEqual([{ what: 'rerun', repo: 'owner/app', id: 77 }]);
    expect(steps('rerun')).toEqual([expect.objectContaining({ sha: H, run: 77, attempt: 1, end: expect.objectContaining({ outcome: 'rerun' }) })]);
    // the re-run runs: nothing more
    await lane.pass();
    expect(gh.posted.filter((p) => p.what === 'rerun')).toHaveLength(1);
    expect(steps('check-failed')).toEqual([]);
    // its attempt 2 fails too
    gh.runs[77] = { id: 77, attempt: 2, status: 'completed', conclusion: 'failure' };
    await lane.pass();
    expect(steps('check-failed')).toEqual([expect.objectContaining({ sha: H, failed: ['tests'], runs: [77] })]);
    expect(failedAgain).toBe(1);
    await lane.pass();
    expect(steps('check-failed')).toHaveLength(1);
    expect(gh.posted.filter((p) => p.what === 'rerun')).toHaveLength(1);
    expect(log.stops()).toEqual([]);
    expect(lines).toContain('checks app#4: tests failed again on abcdef1 after the re-run: a fix round with the failing log');
  });

  test('passing on its re-run, nothing more happens', async () => {
    await lane.pass();
    gh.runs[77] = { id: 77, attempt: 2, status: 'completed', conclusion: 'success' };
    await lane.pass();
    expect(steps('check-failed')).toEqual([]);
  });

  test("a check no re-run reaches (a commit status, another app's) fails again at once", async () => {
    gh.failedRunsOn[H] = {};
    await lane.pass();
    expect(steps('check-failed')).toEqual([expect.objectContaining({ failed: ['tests'], runs: [0] })]);
    expect(gh.posted.filter((p) => p.what === 'rerun')).toEqual([]);
  });

  test('a run re-run by hand already (past attempt 1) fails again at once', async () => {
    gh.runs[77] = { id: 77, attempt: 2, status: 'completed', conclusion: 'failure' };
    await lane.pass();
    expect(steps('check-failed')).toEqual([expect.objectContaining({ failed: ['tests'], runs: [77] })]);
    expect(gh.posted.filter((p) => p.what === 'rerun')).toEqual([]);
  });

  test('a re-run GitHub refused (its 4xx) is failed, so it never loops', async () => {
    gh.rerunRefused = 'HTTP 403: Unable to re-run this workflow run';
    await lane.pass();
    expect(steps('rerun')[0]!.end).toMatchObject({ outcome: 'failed' });
    await lane.pass();
    expect(steps('check-failed')).toHaveLength(1);
  });

  test("a re-run request that failed for a moment didn't count: it's asked again, and the check gets no fix round meanwhile (#158 F7)", async () => {
    gh.rerunFails = 1;
    await lane.pass();
    expect(steps('rerun')).toEqual([expect.objectContaining({ run: 77 })]);
    expect(steps('rerun')[0]!.end).toBeUndefined();
    await lane.pass();
    expect(steps('check-failed')).toEqual([]);
    expect(gh.posted.filter((p) => p.what === 'rerun')).toHaveLength(1);
    expect(steps('rerun')[0]!.end).toMatchObject({ outcome: 'rerun' });
    // its attempt 2 fails: now it's a fix round's
    gh.runs[77] = { id: 77, attempt: 2, status: 'completed', conclusion: 'failure' };
    await lane.pass();
    expect(steps('check-failed')).toHaveLength(1);
  });

  test('a new head gets its own re-run', async () => {
    await lane.pass();
    gh.reviewPulls['owner/app'] = [pull({ headSha: H2 })];
    gh.checkStates[H2] = FAILED('tests');
    gh.failedRunsOn[H2] = { tests: 78 };
    gh.runs[78] = { id: 78, attempt: 1, status: 'completed', conclusion: 'failure' };
    await lane.pass();
    expect(gh.posted.filter((p) => p.what === 'rerun').map((p) => p.id)).toEqual([77, 78]);
  });

  test('the app stopped between writing a re-run and GitHub answering: GitHub says whether it took', async () => {
    const st = await log.stepStarted({ kind: 'rerun', repo: APP.id, github: 'owner/app', pr: 4, branch: 'claude/add-a-thing-3', sha: H, run: 77, attempt: 1 });
    await lane.pass();
    expect(gh.posted.filter((p) => p.what === 'rerun')).toHaveLength(1); // it hadn't: asked now
    expect(log.steps().find((s) => s.id === st.id)!.end).toMatchObject({ outcome: 'rerun' });
  });
});

describe('a check the base fails too', () => {
  test('waits, with no re-run and no stop; once the base moves, the PR is brought up to date, once per base tip', async () => {
    gh.checkStates[B1] = FAILED('tests');
    await lane.pass();
    expect(gh.posted).toEqual([]);
    expect(steps('base-hold')).toEqual([expect.objectContaining({ sha: H, baseSha: B1 })]);
    expect(lines).toContain('checks app#4: tests fails on main at b1b1b1b too: abcdef1 waits, and is brought up to date once main moves');
    await lane.pass();
    expect(steps('base-hold')).toHaveLength(1);
    // main moves
    gh.tips['owner/app:main'] = B2;
    await lane.pass();
    expect(gh.posted).toEqual([{ what: 'update', repo: 'owner/app', n: 4, sha: H, answer: 'updated' }]);
    await lane.pass();
    expect(gh.posted).toHaveLength(1);
    expect(log.stops()).toEqual([]);
  });

  test('GitHub refusing the update (a conflict) is left to the conflict round; one failing for a moment is tried again', async () => {
    gh.checkStates[B1] = FAILED('tests');
    await lane.pass();
    gh.tips['owner/app:main'] = B2;
    gh.updateFails = 1;
    await lane.pass();
    expect(steps('update')).toEqual([]);
    expect(lines.at(-1)).toContain("GitHub couldn't be read");
    gh.updateAnswer = 'refused';
    await lane.pass();
    expect(steps('update')).toEqual([expect.objectContaining({ baseSha: B2, end: expect.objectContaining({ outcome: 'refused' }) })]);
  });

  test('one the PR fails more than the base does is the PR\'s: re-run', async () => {
    gh.checkStates[B1] = FAILED('lint');
    await lane.pass();
    expect(steps('base-hold')).toEqual([]);
    expect(gh.posted.filter((p) => p.what === 'rerun')).toHaveLength(1);
  });
});

test('a PR with a stop open, or a job writing to its branch, is left alone', async () => {
  const stop = await log.stopped({ cause: 'question', repo: APP.id, github: 'owner/app', pr: 4, sha: H, why: 'asked', link: null });
  await lane.pass();
  expect(gh.posted).toEqual([]);
  await log.stopAnswered(stop.id, 'replied', 'ok');
  await log.started({ kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: 'claude/add-a-thing-3', base: 'main', title: 't', choice: { provider: 'p', model: 'm', effort: null }, onFallback: false });
  await lane.pass();
  expect(gh.posted).toEqual([]);
});
