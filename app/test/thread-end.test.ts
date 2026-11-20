// A run's end learned from T3's thread events (#154): `orchestration.subscribeThread` on fake T3;
// a repo job's thread followed by reads of its current state on each change T3 pushes (#210).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runtimeAddress } from '../src/t3/real.ts';
import { followThread, readThread, threadListed, threadNow, watchJobThread, watchThreadEnd } from '../src/t3/thread-end.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let dir: string;
let t3: FakeT3;
let ws: T3Ws;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-thread-end-'));
  t3 = new FakeT3();
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
  ws = new T3Ws(runtimeAddress(join(dir, 'server-runtime.json')), t3.cli, t3.http, t3.connect);
  t3.threadState.t = {
    id: 't', projectId: 'p', runtimeRequests: [], turnItems: [],
    runs: [{ id: 'r1', ordinal: 1, rootNodeId: 'n1', status: 'completed' }, { id: 'r2', ordinal: 2, rootNodeId: 'n2', status: 'running' }],
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Waits on the fake T3's own state, never on real time (#202). */
const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); });
/** The watch's stream is open on the fake, so an event T3 sends now reaches it. */
const streaming = () => until(() => t3.threadStreamCount('t') === 1);
/** The fake answers in microtasks: once they have all run, a watch that hasn't ended is pending. */
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
/** Resolves `watch.end` or says it's still pending. */
const settled = (p: Promise<unknown>) => Promise.race([p, flush().then(() => 'pending')]);

describe('watchThreadEnd', () => {
  test('waits on the run named, through a passing waiting status, until it completes', async () => {
    const w = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    t3.threadEvent('t', 'run', { ...t3.threadState.t!.runs[1], status: 'waiting' });
    expect(await settled(w.end)).toBe('pending');
    t3.endRun('t', 'completed');
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
    await until(() => t3.threadStreamCount('t') === 0);
  });

  test('a run that already ended is known from the snapshot', async () => {
    expect(await watchThreadEnd(ws, 't', 'r1').end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test("with no run named, the runs known before a send are left out: their end isn't the new run's (#156)", async () => {
    t3.threadState.t!.runs = [{ id: 'r1', ordinal: 1, rootNodeId: 'n1', status: 'completed' }];
    const w = watchThreadEnd(ws, 't', null, undefined, undefined, new Set(['r1']));
    await streaming();
    expect(await settled(w.end)).toBe('pending');
    t3.threadEvent('t', 'run', { id: 'r3', ordinal: 2, rootNodeId: 'n3', status: 'running' });
    expect(await settled(w.end)).toBe('pending');
    t3.endRun('t', 'completed');
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test('a pending question to the user is waiting', async () => {
    const w = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    t3.askUser('t');
    expect(await w.end).toEqual({ outcome: 'waiting', status: 'running', request: 'user_input' });
  });

  test("a failure of class usage_limit on the run's root is a usage limit, with T3's reset", async () => {
    const w = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    t3.hitUsageLimit('t', '2026-11-19T15:00:00.000Z');
    expect(await w.end).toEqual({ outcome: 'usage-limit', status: 'failed', resetAt: '2026-11-19T15:00:00.000Z', error: "You've hit your limit" });
  });

  test('any other end is failed, with its error', async () => {
    const w = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    t3.threadEvent('t', 'turn-item', { id: 'e', type: 'error', status: 'failed', runId: 'r2', nodeId: 'n2', failure: { class: 'provider_error', message: 'boom' } });
    t3.endRun('t', 'failed');
    expect(await w.end).toEqual({ outcome: 'failed', status: 'failed', error: 'boom' });
    const later = watchThreadEnd(ws, 't', 'r2');
    expect(await later.end).toMatchObject({ outcome: 'failed' });
    t3.threadEvent('t', 'run', { ...t3.threadState.t!.runs[1], status: 'interrupted' });
    expect(await watchThreadEnd(ws, 't', 'r2').end).toEqual({ outcome: 'failed', status: 'interrupted', error: 'boom' });
  });

  test('a stream that drops is opened again, and its snapshot holds the end that came meanwhile', async () => {
    const downs: string[] = [];
    let again: (() => void) | null = null;
    const w = watchThreadEnd(ws, 't', 'r2', (f) => { again = f; return () => {}; }, (why) => downs.push(why));
    await streaming();
    t3.endThreadStreams();
    await until(() => downs.length === 1);
    t3.endRun('t', 'completed'); // while no stream is open
    again!();
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test('stop() ends the watch and closes its stream', async () => {
    const w = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    w.stop();
    await expect(w.end).rejects.toThrow(/stopped watching/);
    await until(() => t3.threadStreamCount('t') === 0);
  });
});

describe('threadNow: where a job is, from one read of its thread (#210)', () => {
  const run = (id: string, ordinal: number, status: string) => ({ id, ordinal, rootNodeId: `n-${id}`, status });
  const limit = (runId: string) => ({ id: `e-${runId}`, type: 'error', status: 'failed', runId, nodeId: `n-${runId}`, failure: { class: 'usage_limit', message: 'limit', resetAt: '2026-11-19T15:00:00.000Z' } });

  test('a pending request is asking, whatever the runs say: T3 cancels a run on a restart and keeps its card (F16)', () => {
    expect(threadNow({ runs: [run('r1', 1, 'cancelled')], runtimeRequests: [{ id: 'q', kind: 'secret', status: 'pending' }] })).toEqual({ state: 'asking', request: 'secret' });
    expect(threadNow({ runs: [run('r1', 1, 'waiting')], runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'resolved' }] })).toEqual({ state: 'running' });
  });

  test("a run queued after the one that ran last never hides that one's end (F17)", () => {
    // the executing run's limit ends the job; the queued one waits behind it
    expect(threadNow({ runs: [run('r1', 1, 'failed'), run('r2', 2, 'queued')], turnItems: [limit('r1')] }))
      .toEqual({ state: 'ended', end: { outcome: 'usage-limit', status: 'failed', resetAt: '2026-11-19T15:00:00.000Z', error: 'limit' } });
    // while it runs, or once it completed with the follow-up still to go, the job goes on
    expect(threadNow({ runs: [run('r1', 1, 'running'), run('r2', 2, 'queued')] })).toEqual({ state: 'running' });
    expect(threadNow({ runs: [run('r1', 1, 'completed'), run('r2', 2, 'queued')] })).toEqual({ state: 'running' });
    // every run ended: the one with the highest ordinal among them
    expect(threadNow({ runs: [run('r2', 2, 'completed'), run('r1', 1, 'failed')], turnItems: [limit('r1')] })).toEqual({ state: 'ended', end: { outcome: 'done', status: 'completed' } });
  });

  test("the runs a thread had before the job's send are left out; none of its own yet is none", () => {
    const known = new Set(['r1']);
    expect(threadNow({ runs: [run('r1', 1, 'completed')] }, known)).toEqual({ state: 'none' });
    expect(threadNow({ runs: [run('r1', 1, 'completed'), run('r2', 2, 'interrupted')] }, known)).toEqual({ state: 'ended', end: { outcome: 'failed', status: 'interrupted', error: null } });
  });
});

describe('readThread: a thread is gone only on its thread list (#210 F15)', () => {
  test("a projection read that fails, whatever its text, is unreadable while T3's list has the thread, or can't be read", async () => {
    t3.wsMethods['orchestration.getThreadProjection'] = () => { throw new Error('orchestration_error: run r2 not found'); };
    expect(await readThread(ws, 't')).toEqual({ unreadable: expect.stringContaining('not found') });
    t3.shellDown = true;
    expect(await readThread(ws, 't')).toEqual({ unreadable: expect.stringContaining("T3's thread list couldn't be read either") });
  });

  test('a thread the list reads fine without is gone; one T3 reads is its projection', async () => {
    expect(await readThread(ws, 't')).toEqual({ projection: expect.objectContaining({ runs: expect.any(Array) }) });
    delete t3.threadState.t;
    expect(await readThread(ws, 't')).toEqual({ gone: true });
  });

  test("a list without both of its thread lists answers nothing", async () => {
    const fake = { first: async () => ({ kind: 'snapshot', snapshot: { threads: [] } }) };
    await expect(threadListed(fake as any, 't')).rejects.toThrow(/without its threads/);
    const partial = { first: async () => ({ kind: 'snapshot', resolvedRepositoryIdentityRoots: [], snapshot: { threads: [], archivedThreads: [] } }) };
    await expect(threadListed(partial as any, 't')).rejects.toThrow(/without its threads/);
  });
});

describe('followThread: read on what T3 pushes, never on a timer (#210)', () => {
  test('reads when its stream opens and on each change pushed, and on nothing else', async () => {
    const seen: string[] = [];
    const f = followThread(ws, 't', (read) => {
      if (!('projection' in read)) return null;
      seen.push(read.projection.runs.map((r: any) => r.status).join());
      return read.projection.runs.every((r: any) => r.status === 'completed') ? 'done' : null;
    }, () => () => {});
    await streaming();
    await until(() => seen.length >= 1);
    const reads = t3.projectionReads;
    await flush();
    expect(t3.projectionReads).toBe(reads); // nothing pushed, nothing read
    t3.say('t', 'a message as it streams'); // no event the decision hangs on
    await flush();
    expect(t3.projectionReads).toBe(reads);
    t3.endRun('t', 'completed');
    expect(await f.end).toBe('done');
    expect(seen.at(-1)).toBe('completed,completed');
  });

  test('a stream that drops is read again when it opens again, which decides from what T3 has then', async () => {
    let again: (() => void) | null = null;
    const w = watchJobThread(ws, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, () => {}, (f) => { again = f; return () => {}; });
    await streaming();
    t3.endThreadStreams();
    await until(() => again !== null);
    t3.threadState.t!.runs[1]!.status = 'completed'; // while no stream is open: no event
    expect(await settled(w.end)).toBe('pending');
    again!();
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test('changes that come during a read are read once after it, and the decision is on that later read', async () => {
    let block: () => void = () => {};
    const gate = new Promise<void>((r) => { block = r; });
    const request = ws.request.bind(ws);
    let n = 0;
    const slow = { subscribe: ws.subscribe.bind(ws), first: ws.first.bind(ws), request: async (tag: string, p: object) => { if (n++ === 0) await gate; return request(tag, p); } };
    const reads: string[] = [];
    const f = followThread(slow as any, 't', (read) => {
      if (!('projection' in read)) return null;
      const now = threadNow(read.projection, new Set(['r1']));
      reads.push(now.state);
      return now.state === 'ended' ? now.end : null;
    }, () => () => {});
    await streaming();
    t3.askUser('t');
    t3.answerInT3('t');
    t3.endRun('t', 'completed');
    block();
    expect(await f.end).toEqual({ outcome: 'done', status: 'completed' });
    // the first read was held across every change; one read after it saw them all
    expect(reads.length).toBeLessThanOrEqual(2);
  });
});
