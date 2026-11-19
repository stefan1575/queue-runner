// A run's end learned from T3's thread events (#154): `orchestration.subscribeThread` on fake T3.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { watchThreadEnd } from '../src/t3/thread-end.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let dir: string;
let t3: FakeT3;
let ws: T3Ws;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-thread-end-'));
  t3 = new FakeT3();
  ws = new T3Ws(t3.address, t3.cli, t3.http, t3.connect);
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
