// The fake T3's threads behave as T3 0.1.9's do (the map behind PR #211's fix round 4: T3's own
// server code and live reads), so a test that passes on the fake passes on T3: each case here is
// one the map saw live or read in T3's code.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { T3Error } from '../src/t3/seams.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let t3: FakeT3;
let ws: T3Ws;
let events: any[];

beforeEach(async () => {
  t3 = new FakeT3();
  ws = new T3Ws(t3.address, t3.cli, t3.http, t3.connect);
  t3.threadState.t = { id: 't', projectId: 'p', title: 'T', runtimeRequests: [], turnItems: [], runs: [] };
  t3.userWrites('t'); // its first run, running
  events = [];
});

const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); });
/** Opens a stream on the thread that keeps every event it's sent. */
const listen = async () => {
  ws.subscribe('orchestration.subscribeThread', { threadId: 't' }, (v) => { if (v?.kind === 'event') events.push(v.event); });
  await until(() => t3.threadStreamCount('t') === 1);
};
const snapshot = async () => (await ws.first('orchestration.subscribeThread', { threadId: 't' })).projection;
const types = () => events.map((e) => `${e.type}${e.payload?.status ? ` ${e.payload.status}` : ''}`);
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('runs and the queue', () => {
  test('a send to a busy thread is queued and sends only run.created, then starts when the run ahead ends (seen live, A)', async () => {
    await listen();
    const q = t3.queueMessage('t');
    await settle();
    expect(q).toMatchObject({ status: 'queued', queuePosition: 1, startedAt: null });
    expect(types()).toEqual(['run.created queued']);
    t3.endRun('t', 'completed');
    await settle();
    expect(types().slice(1)).toEqual(['run.updated completed', 'run.updated starting', 'run.updated running']);
    expect(events.at(-2).payload).toMatchObject({ id: q.id, queuePosition: null });
  });

  test('a send to an idle thread starts at once: run.created starting, then running', async () => {
    t3.endRun('t', 'completed');
    await listen();
    t3.queueMessage('t');
    await settle();
    expect(types()).toEqual(['run.created starting', 'run.updated running']);
  });

  test('a stop holds the queue; a later send starts ahead of it, and the held run then runs with a new ordinal (seen live, B)', async () => {
    const held = t3.queueMessage('t');
    t3.stop('t');
    let p = await snapshot();
    expect(p.runs.find((r: any) => r.id === held.id)).toMatchObject({ status: 'queued', queueHeld: true, startedAt: null });
    const next = t3.queueMessage('t');
    expect(next.status).toBe('starting');
    t3.endRun('t', 'completed'); // releases a held run no user typed
    p = await snapshot();
    const ran = p.runs.find((r: any) => r.id === held.id);
    expect(ran).toMatchObject({ status: 'running', queueHeld: false });
    expect(ran.ordinal).toBeGreaterThan(p.runs.find((r: any) => r.id === next.id).ordinal);
  });

  test("a queued run cancelled before it ran keeps the highest ordinal, with no start (seen live, A)", async () => {
    const q = t3.queueMessage('t');
    t3.cancelQueued('t', q.id);
    const p = await snapshot();
    expect(p.runs.find((r: any) => r.id === q.id)).toMatchObject({ status: 'cancelled', startedAt: null, ordinal: 2 });
  });

  test('a usage limit leaves the queue queued and unheld, waiting; another provider failure holds it', async () => {
    const q = t3.queueMessage('t');
    t3.hitUsageLimit('t', '2026-11-19T15:00:00.000Z');
    let p = await snapshot();
    expect(p.runs.find((r: any) => r.id === q.id)).toMatchObject({ status: 'queued', queueHeld: false });
    t3.threadState.t!.runs = [];
    t3.userWrites('t');
    const q2 = t3.queueMessage('t');
    t3.failRun('t', { class: 'provider_error', message: 'boom' });
    p = await snapshot();
    expect(p.runs.find((r: any) => r.id === q2.id)).toMatchObject({ status: 'queued', queueHeld: true });
  });
});

describe('cards and questions', () => {
  test('a secret card is a waiting turn item on the running run, never a runtime request; its answer returns into the same run (seen live, D)', async () => {
    const card = t3.secretCard('t');
    let p = await snapshot();
    expect(p.runtimeRequests).toEqual([]);
    expect(p.turnItems).toContainEqual(expect.objectContaining({ id: card.id, type: 'secret_request', status: 'waiting', secretStatus: 'pending' }));
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0].status).toBe('running');
    t3.answerSecret('t', 'saved');
    p = await snapshot();
    expect(p.runs).toHaveLength(1);
    expect(p.turnItems[0]).toMatchObject({ status: 'completed', secretStatus: 'saved' });
  });

  test('a link card stays waiting after its run ended; its answer is a new run (src)', async () => {
    t3.linkCard('t');
    t3.endRun('t', 'completed');
    let p = await snapshot();
    expect(p.turnItems[0]).toMatchObject({ type: 'link_request', status: 'waiting', linkStatus: 'pending' });
    t3.answerLink('t');
    p = await snapshot();
    expect(p.runs.map((r: any) => r.status)).toEqual(['completed', 'running']);
  });

  test("a question is a pending user_input request on a child node, with no runId (src)", async () => {
    t3.askUser('t');
    const p = await snapshot();
    const run = p.runs[0];
    const node = p.nodes.find((n: any) => n.kind === 'user_input_request');
    expect(node).toMatchObject({ parentNodeId: run.rootNodeId, status: 'waiting' });
    expect(p.runtimeRequests[0]).toMatchObject({ kind: 'user_input', status: 'pending', nodeId: node.id, responseCapability: { type: 'live' } });
    expect(p.runtimeRequests[0].runId).toBeUndefined();
  });

  test('a restart cancels live runs and secret cards, keeps a question pending as a message, leaves link cards, holds the queue (src)', async () => {
    t3.askUser('t');
    t3.secretCard('t');
    t3.linkCard('t');
    const q = t3.queueMessage('t');
    t3.restart();
    const p = await snapshot();
    expect(p.runs.find((r: any) => r.id !== q.id).status).toBe('cancelled');
    expect(p.runs.find((r: any) => r.id === q.id)).toMatchObject({ status: 'queued', queueHeld: true });
    expect(p.runtimeRequests[0]).toMatchObject({ status: 'pending', responseCapability: { type: 'message' } });
    expect(p.turnItems.find((i: any) => i.type === 'secret_request')).toMatchObject({ status: 'cancelled', secretStatus: 'cancelled' });
    expect(p.turnItems.find((i: any) => i.type === 'link_request')).toMatchObject({ status: 'waiting' });
    t3.answerInT3('t'); // answered as a message: a new turn
    expect((await snapshot()).runs.at(-1).status).toBe('running');
  });
});

describe('the reads', () => {
  test("getThreadProjection is windowed: an old card and an old ended run drop out; subscribeThread's snapshot has everything (src SRV)", async () => {
    const card = t3.secretCard('t');
    t3.endRun('t', 'completed');
    t3.userWrites('t');
    for (let i = 0; i < 100; i++) t3.threadEvent('t', 'turn-item', { id: `i${i}`, type: 'assistant_message', status: 'completed', runId: t3.threadState.t!.runs[1].id });
    const windowed = await ws.request('orchestration.getThreadProjection', { threadId: 't' });
    expect(windowed.turnItems).toHaveLength(77);
    expect(windowed.turnItems.some((i: any) => i.id === card.id)).toBe(false);
    expect(windowed.runs).toHaveLength(1);
    const whole = await snapshot();
    expect(whole.turnItems).toHaveLength(101);
    expect(whole.runs).toHaveLength(2);
  });

  test('a deleted thread is soft deleted: thread.deleted, its runs cancelled, its projection readable with deletedAt, absent from getThreadTitles (seen live, C)', async () => {
    await listen();
    t3.deleteThread('t');
    await settle();
    expect(types()).toEqual(['thread.deleted', 'run.updated cancelled']);
    expect((await snapshot()).thread.deletedAt).toEqual(expect.any(String));
    expect((await ws.request('orchestration.getThreadProjection', { threadId: 't' })).thread.deletedAt).toEqual(expect.any(String));
    expect(await ws.request('orchestration.getThreadTitles', { threadIds: ['t'] })).toEqual({});
  });

  test('an archived thread is listed by getThreadTitles and getArchivedShellSnapshot, not by subscribeShell, whose archivedThreads is empty (seen live, A)', async () => {
    t3.archiveThread('t');
    expect(await ws.request('orchestration.getThreadTitles', { threadIds: ['t', 'nope'] })).toEqual({ t: 'T' });
    expect((await ws.request('orchestration.getArchivedShellSnapshot', {})).threads.map((x: any) => x.id)).toEqual(['t']);
    const shell = await ws.first('orchestration.subscribeShell', {});
    expect(shell.snapshot.threads.some((x: any) => x.id === 't')).toBe(false);
    expect(shell.snapshot.archivedThreads).toEqual([]);
    expect((await snapshot()).thread.archivedAt).toEqual(expect.any(String));
  });

  test("a thread T3 never had fails with T3's tagged error, its code two causes deep (seen live)", async () => {
    const e = await ws.request('orchestration.getThreadProjection', { threadId: 'nope' }).catch((x) => x);
    expect(e).toBeInstanceOf(T3Error);
    expect(e.codes).toEqual(['OrchestrationV2GetThreadProjectionError', 'OrchestratorProjectionError', 'ProjectionStoreThreadNotFoundError']);
  });
});
