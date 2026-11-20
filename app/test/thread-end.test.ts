// A run's end learned from T3's thread events (#154): `orchestration.subscribeThread` on fake T3;
// a repo job's thread followed by reads of its current state on each change T3 pushes (#210),
// decided as T3 0.1.9 decides it (fake-t3.ts follows T3's own model).
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { followThread, lastExecuted, readThread, threadKept, threadNow, waitingOn, watchJobThread, watchThreadEnd, type GithubHold } from '../src/t3/thread-end.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let t3: FakeT3;
let ws: T3Ws;

const run = (id: string, ordinal: number, status: string, extra: object = {}) => ({ id, threadId: 't', ordinal, rootNodeId: `n-${id}`, status, queueHeld: false, startedAt: status === 'queued' ? null : '2026-11-19T11:00:00.000Z', ...extra });

beforeEach(() => {
  t3 = new FakeT3();
  // the fake's own address, answered in memory: no file on the machine (F27)
  ws = new T3Ws(t3.address, t3.cli, t3.http, t3.connect);
  t3.threadState.t = {
    id: 't', projectId: 'p', runtimeRequests: [], turnItems: [],
    runs: [run('r1', 1, 'completed', { completedAt: '2026-11-19T11:30:00.000Z' }), { ...run('r2', 2, 'running'), rootNodeId: 'n2' }],
  };
});

/** Waits on the fake T3's own state, never on real time (#202). */
const until = (f: () => boolean) => vi.waitFor(() => { if (!f()) throw new Error('not yet'); });
/** The watch's stream is open on the fake, so an event T3 sends now reaches it. */
const streaming = () => until(() => t3.threadStreamCount('t') === 1);
/** The fake answers in microtasks: once they have all run, a watch that hasn't ended is pending. */
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
/** Resolves `watch.end` or says it's still pending. */
const settled = (p: Promise<unknown>) => Promise.race([p, flush().then(() => 'pending')]);
/** A retry the test fires by hand. */
const byHand = () => {
  const r: { fire: (() => void) | null; seam: (f: () => void) => () => void } = { fire: null, seam: (f) => { r.fire = f; return () => {}; } };
  return r;
};

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

  test("with no run named, a new run arriving as run.created is the one watched; the runs known before aren't (#156, map item 8)", async () => {
    t3.endRun('t', 'completed');
    const w = watchThreadEnd(ws, 't', null, undefined, undefined, new Set(['r1', 'r2']));
    await streaming();
    expect(await settled(w.end)).toBe('pending');
    t3.queueMessage('t'); // run.created starting, then running
    expect(await settled(w.end)).toBe('pending');
    t3.endRun('t', 'completed');
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test('a pending question to the user, or a secret card (a turn item), is waiting', async () => {
    const w = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    t3.askUser('t');
    expect(await w.end).toEqual({ outcome: 'waiting', status: 'running', request: 'user_input' });
    t3.answerInT3('t');
    const card = watchThreadEnd(ws, 't', 'r2');
    await streaming();
    t3.secretCard('t');
    expect(await card.end).toEqual({ outcome: 'waiting', status: 'running', request: 'a secret card' });
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
    t3.failRun('t', { class: 'provider_error', message: 'boom' });
    expect(await w.end).toEqual({ outcome: 'failed', status: 'failed', error: 'boom' });
  });

  test('a stream that drops is opened again, and its snapshot holds the end that came meanwhile', async () => {
    const downs: string[] = [];
    const again = byHand();
    const w = watchThreadEnd(ws, 't', 'r2', again.seam, (why) => downs.push(why));
    await streaming();
    t3.endThreadStreams();
    await until(() => downs.length === 1);
    t3.endRun('t', 'completed'); // while no stream is open
    again.fire!();
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

describe('waitingOn: what the thread waits on the user for, as T3 presents it (map item 1)', () => {
  test('a secret card waits while its run is live, and not once it ended', () => {
    const card = { id: 'c', type: 'secret_request', status: 'waiting', runId: 'r', secretStatus: 'pending', updatedAt: '2026-11-19T12:00:00.000Z' };
    expect(waitingOn({ runs: [run('r', 1, 'running')], turnItems: [card] })).toBe('a secret card');
    expect(waitingOn({ runs: [run('r', 1, 'cancelled')], turnItems: [card] })).toBeNull();
  });

  test("a link card waits after its run ended, until the user writes in the thread after it (F16)", () => {
    const card = { id: 'c', type: 'link_request', status: 'waiting', runId: 'r', linkStatus: 'pending', startedAt: '2026-11-19T12:00:00.000Z' };
    expect(waitingOn({ runs: [run('r', 1, 'completed')], turnItems: [card] })).toBe('a link card');
    const wrote = (at: string, createdBy = 'user') => ({ id: 'm', role: 'user', createdBy, updatedAt: at });
    expect(waitingOn({ runs: [run('r', 1, 'completed')], turnItems: [card], messages: [wrote('2026-11-19T12:01:00.000Z', 'agent')] })).toBe('a link card');
    expect(waitingOn({ runs: [run('r', 1, 'completed')], turnItems: [card], messages: [wrote('2026-11-19T12:01:00.000Z')] })).toBeNull();
  });

  test('a pending runtime request waits, approvals first; a resolved one does not', () => {
    expect(waitingOn({ runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'pending' }, { id: 'a', kind: 'approval', status: 'pending' }] })).toBe('approval');
    expect(waitingOn({ runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'resolved' }] })).toBeNull();
  });
});

describe('threadNow: where a job is, from one read of its thread (#210)', () => {
  const limit = (runId: string) => ({ id: `e-${runId}`, type: 'error', status: 'failed', runId, nodeId: `n-${runId}`, failure: { class: 'usage_limit', message: 'limit', resetAt: '2026-11-19T15:00:00.000Z' } });
  const limited = { outcome: 'usage-limit', status: 'failed', resetAt: '2026-11-19T15:00:00.000Z', error: 'limit' };

  test('the thread waiting on the user is asking, whatever the runs say', () => {
    expect(threadNow({ runs: [run('r1', 1, 'cancelled')], runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'pending', responseCapability: { type: 'message' } }] })).toEqual({ state: 'asking', request: 'user_input' });
    expect(threadNow({ runs: [run('r1', 1, 'waiting')], runtimeRequests: [{ id: 'q', kind: 'user_input', status: 'resolved' }] })).toEqual({ state: 'running' });
  });

  test("the run that ran last is T3's: a queued run cancelled before it started never hides a usage limit (F17, map item 2)", () => {
    const runs = [run('r1', 1, 'failed', { completedAt: '2026-11-19T12:00:00.000Z' }), run('r2', 2, 'cancelled', { startedAt: null, completedAt: '2026-11-19T12:05:00.000Z' })];
    expect(threadNow({ runs, turnItems: [limit('r1')] })).toEqual({ state: 'ended', end: limited });
    expect(lastExecuted(runs).id).toBe('r1');
  });

  test('the latest completedAt is the last, whatever the ordinals say: a held run renumbered when it ran (seen live, B)', () => {
    const runs = [run('r2', 4, 'completed', { completedAt: '2026-11-19T12:10:00.000Z' }), run('r3', 3, 'failed', { completedAt: '2026-11-19T12:05:00.000Z' })];
    expect(threadNow({ runs, turnItems: [limit('r3')] })).toEqual({ state: 'ended', end: { outcome: 'done', status: 'completed' } });
    const older = [run('r2', 4, 'failed', { completedAt: '2026-11-19T12:01:00.000Z' }), run('r3', 3, 'completed', { completedAt: '2026-11-19T12:05:00.000Z' })];
    expect(threadNow({ runs: older })).toEqual({ state: 'ended', end: { outcome: 'done', status: 'completed' } });
  });

  test('a held queue is not running: the end of the run that ran last, or failed when none ran (F17, map item 3)', () => {
    const held = run('r2', 2, 'queued', { queueHeld: true, startedAt: null });
    expect(threadNow({ runs: [run('r1', 1, 'interrupted', { completedAt: '2026-11-19T12:00:00.000Z' }), held] })).toEqual({ state: 'ended', end: { outcome: 'failed', status: 'interrupted', error: null } });
    expect(threadNow({ runs: [run('r1', 1, 'completed'), held] }, new Set(['r1']))).toEqual({ state: 'ended', end: { outcome: 'failed', status: 'queued', error: expect.stringContaining('held') } });
    // unheld, it goes next; behind a usage limit it waits, and the limit is the end
    const queued = run('r2', 2, 'queued', { startedAt: null });
    expect(threadNow({ runs: [run('r1', 1, 'completed'), queued] })).toEqual({ state: 'running' });
    expect(threadNow({ runs: [run('r1', 1, 'failed'), queued], turnItems: [limit('r1')] })).toEqual({ state: 'ended', end: limited });
    // in an archived thread no queued run starts
    expect(threadNow({ thread: { archivedAt: '2026-11-19T12:00:00.000Z' }, runs: [run('r1', 1, 'completed'), queued] }, new Set(['r1']))).toEqual({ state: 'ended', end: { outcome: 'failed', status: 'queued', error: expect.stringContaining('archived') } });
  });

  test("the runs a thread had before the job's send are left out; none of its own yet is none", () => {
    const known = new Set(['r1']);
    expect(threadNow({ runs: [run('r1', 1, 'completed')] }, known)).toEqual({ state: 'none' });
    expect(threadNow({ runs: [run('r1', 1, 'completed'), run('r2', 2, 'interrupted')] }, known)).toEqual({ state: 'ended', end: { outcome: 'failed', status: 'interrupted', error: null } });
  });

  test("a usage limit the provider session has since failed past isn't the limit (T3's threadErrorSummary)", () => {
    const p = { runs: [run('r1', 1, 'failed')], turnItems: [limit('r1')], providerSessions: [{ lastError: 'something else', updatedAt: '2026-11-19T12:00:00.000Z' }] };
    expect(threadNow(p)).toEqual({ state: 'ended', end: { outcome: 'failed', status: 'failed', error: null } });
  });
});

describe("readThread: the thread's whole state; deleted only on T3's word (#210 F15, map items 4 to 6)", () => {
  test("it reads subscribeThread's whole snapshot, not getThreadProjection's window: an old card is still there", async () => {
    t3.secretCard('t');
    for (let i = 0; i < 100; i++) t3.threadEvent('t', 'turn-item', { id: `i${i}`, type: 'assistant_message', status: 'completed', runId: 'r2' });
    const read = await readThread(ws, 't');
    expect('projection' in read && waitingOn(read.projection)).toBe('a secret card');
  });

  test('a deleted thread reads, with deletedAt: gone. An archived one is not gone', async () => {
    t3.archiveThread('t');
    expect(await readThread(ws, 't')).toEqual({ projection: expect.objectContaining({ runs: expect.any(Array) }) });
    expect(await threadKept(ws, 't')).toBe(true);
    t3.deleteThread('t');
    expect(await readThread(ws, 't')).toEqual({ gone: true, why: expect.stringContaining('deleted it at') });
  });

  test("a read that fails, whatever its text or code, is unreadable while T3's titles have the thread, or can't be read", async () => {
    t3.failReads = 1;
    expect(await readThread(ws, 't')).toEqual({ unreadable: expect.stringContaining('SqlError') });
    t3.failReads = 1;
    t3.wsMethods['orchestration.getThreadTitles'] = () => { throw new Error('busy'); };
    expect(await readThread(ws, 't')).toEqual({ unreadable: expect.stringContaining("T3's thread titles couldn't be read either") });
    t3.wsMethods['orchestration.getThreadTitles'] = () => [];
    await expect(threadKept(ws, 't')).rejects.toThrow(/no record/);
  });

  test("a thread T3 never had fails with its typed code, and T3's titles answering without it make it gone", async () => {
    expect(await readThread(ws, 'nope')).toEqual({ gone: true, why: "T3's thread titles don't have it" });
  });
});

describe('followThread: read on what T3 pushes, never on a timer (#210)', () => {
  test('reads when its stream sends its snapshot and on each change pushed, and on nothing else', async () => {
    const seen: string[] = [];
    const f = followThread(ws, 't', (read) => {
      if (!('projection' in read)) return null;
      seen.push(read.projection.runs.map((r: any) => r.status).join());
      return read.projection.runs.every((r: any) => r.status === 'completed') ? 'done' : null;
    }, () => () => {});
    await streaming();
    await until(() => seen.length >= 1);
    await flush();
    const reads = t3.projectionReads;
    t3.say('t', 'a message as it streams'); // no event the decision hangs on
    t3.threadEvent('t', 'turn-item', { id: 'x', type: 'assistant_message', status: 'running', runId: 'r2' });
    await flush();
    expect(t3.projectionReads).toBe(reads);
    t3.endRun('t', 'completed');
    expect(await f.end).toBe('done');
    expect(seen.at(-1)).toBe('completed,completed');
  });

  test('run.created and card items start a read (map item 7, F22)', async () => {
    const seen: string[] = [];
    const f = followThread(ws, 't', (read) => {
      if ('projection' in read) seen.push(threadNow(read.projection, new Set(['r1', 'r2'])).state);
      return null;
    }, () => () => {});
    await streaming();
    await until(() => seen.length === 1);
    t3.queueMessage('t'); // queued behind r2: run.created only
    await until(() => seen.length === 2);
    expect(seen.at(-1)).toBe('running');
    t3.secretCard('t');
    await until(() => seen.at(-1) === 'asking');
    f.stop();
    await f.end.catch(() => {});
  });

  test('a stream that never opens sends no read on its retries (F23)', async () => {
    const again = byHand();
    const downs: string[] = [];
    t3.failReads = 1; // the watch's stream fails at once
    const f = followThread(ws, 't', () => null, again.seam, (why) => downs.push(why));
    await until(() => downs.length === 1);
    expect(t3.projectionReads).toBe(0);
    t3.running = false; // T3 down: the retry's stream never opens
    again.fire!();
    await until(() => downs.length === 2);
    expect(t3.projectionReads).toBe(0);
    f.stop();
    await f.end.catch(() => {});
  });

  test('a read that fails while the stream stays up opens the stream again, and its snapshot reads (F21)', async () => {
    const again = byHand();
    const w = watchJobThread(ws, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, () => {}, again.seam);
    await streaming();
    await flush();
    t3.failReads = 1;
    t3.endRun('t', 'completed'); // its read fails
    await until(() => again.fire !== null);
    expect(await settled(w.end)).toBe('pending');
    again.fire!();
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test('a stream that drops is read again when it opens again, which decides from what T3 has then', async () => {
    const again = byHand();
    const w = watchJobThread(ws, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, () => {}, again.seam);
    await streaming();
    t3.endThreadStreams();
    await until(() => again.fire !== null);
    t3.threadState.t!.runs[1]!.status = 'completed'; // while no stream is open: no event
    expect(await settled(w.end)).toBe('pending');
    again.fire!();
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test("an end read while a change came is read again before it's taken: the job that went on isn't ended (F20)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const first = ws.first.bind(ws);
    let held = false;
    const slow = {
      subscribe: ws.subscribe.bind(ws), request: ws.request.bind(ws),
      first: async (tag: string, p: object) => {
        const got = await first(tag, p);
        if (!held && got?.projection?.runs?.every((r: any) => r.status !== 'running')) { held = true; await gate; }
        return got;
      },
    };
    const ends: string[] = [];
    const w = watchJobThread(slow as any, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, () => {}, () => () => {});
    void w.end.then((e) => ends.push(e.status));
    await streaming();
    t3.endRun('t', 'completed'); // its read sees the end, and is held
    await until(() => held);
    t3.queueMessage('t'); // the job goes on meanwhile
    release();
    await flush();
    expect(ends).toEqual([]); // the held read's end wasn't taken
    t3.endRun('t', 'completed');
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });
});

describe('watchJobThread', () => {
  test('a thread deleted in T3 ends the job, gone; one archived does not (F15)', async () => {
    const said: string[] = [];
    const w = watchJobThread(ws, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, (l) => said.push(l));
    await streaming();
    t3.archiveThread('t');
    expect(await settled(w.end)).toBe('pending');
    t3.deleteThread('t');
    expect(await w.end).toMatchObject({ outcome: 'failed', status: 'gone', gone: true });
  });

  test("a stream T3 fails with its typed \"no such thread\" is read, and T3's titles without it make it gone; any other failure reads nothing (map item 10)", async () => {
    const w = watchJobThread(ws, { title: 'job', threadId: 'nope', repo: 'p' }, () => {}, () => () => {});
    expect(await w.end).toMatchObject({ outcome: 'failed', status: 'gone' });
  });

  test('a link card on an ended run holds the job until the user answers it, and its wake run ends (F16)', async () => {
    const said: string[] = [];
    const w = watchJobThread(ws, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, (l) => said.push(l));
    await streaming();
    t3.linkCard('t');
    t3.endRun('t', 'completed');
    await until(() => said.some((l) => l.includes('waits on you in T3 (a link card)')));
    expect(await settled(w.end)).toBe('pending');
    t3.answerLink('t');
    await until(() => said.some((l) => l.includes('goes on')));
    t3.endRun('t', 'completed');
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
  });

  test('a question open on GitHub holds the ended job; its answer, rechecked, ends it, with no T3 read (the GitHub hold)', async () => {
    let open: string | null | undefined;
    let endedTold = 0;
    const hold: GithubHold = { open: () => open, ended: () => { endedTold++; open = undefined; } };
    const said: string[] = [];
    const w = watchJobThread(ws, { title: 'job', threadId: 't', repo: 'p', knownRuns: ['r1'] }, (l) => said.push(l), undefined, hold);
    await streaming();
    t3.endRun('t', 'completed');
    await until(() => endedTold === 1);
    expect(await settled(w.end)).toBe('pending'); // GitHub not read yet: held
    open = "the issue's needs-info label";
    w.recheck();
    expect(said.at(-1)).toContain('waits on you on GitHub');
    expect(await settled(w.end)).toBe('pending');
    const reads = t3.projectionReads;
    open = null;
    w.recheck();
    expect(await w.end).toEqual({ outcome: 'done', status: 'completed' });
    expect(t3.projectionReads).toBe(reads);
  });
});
