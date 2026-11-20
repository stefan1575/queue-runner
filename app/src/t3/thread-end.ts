// How a job's run ended, learned from T3's threads, read the way T3 0.1.9 itself reads them
// (docs/app.md, The WebSocket API; the map of T3's thread model behind PR #211's fix round 4,
// from T3's own server code and live reads).
//
// **The read.** `orchestration.subscribeThread {threadId}` sends the thread's whole projection
// first (`runs`, `nodes`, `runtimeRequests`, `turnItems`, `messages`, `thread`...), then each
// change as an event. `getThreadProjection` is windowed (its newest 77 turn items, and only some
// runs), so it's never read: an old card or an old ended run can be missing from it.
//
// **What the read says**, decided as T3's `threadShellFromProjection` does:
// - **Waiting on the user** (T3's `pendingRuntimeRequest`): a `pending` runtime request (a
//   question or an approval), or a waiting card: a `secret_request` turn item while its run is
//   live, or a `link_request` one, which waits after its run ended until the user writes in the
//   thread after it. Cards are turn items, never runtime requests (seen live).
// - **The run that ran last** (T3's `latestExecutedRun`): queued runs and runs cancelled before
//   they started skipped, then the latest `completedAt`, an unfinished run the latest, ties by
//   ordinal. Ordinals are renumbered when a held run starts, so order is never read from ids.
// - **Done:** that run `completed`. **Usage limit:** it `failed` and its root node's latest failed
//   `error` item has the class `usage_limit` (T3's `latestRootProviderFailure`, cross-checked with
//   the provider session's `lastError` as `threadErrorSummary` does), with `resetAt` when T3 has
//   it. **Failed:** any other end.
// - **A held queue isn't running:** a `queued` run with `queueHeld: true` never starts on its own,
//   nor does any queued run in an archived thread. An unheld queued run goes next, unless the run
//   that ran last failed on a usage limit: T3's queue waits behind it.
// - **Deleted** only when the snapshot has `thread.deletedAt` (T3 deletes softly, and the thread
//   still reads), or when a read fails and `orchestration.getThreadTitles` answers without the
//   thread. An archived thread is never deleted: it still reads, and the titles list it.
//
// A repo's job (a build, a fix or a conflict round) is followed by `watchJobThread` (#210): T3
// pushes the thread's changes, and on each one, and whenever its stream opens, the app reads the
// thread's current state and decides from that read alone (`threadNow`), never from the order
// events came in. Nothing reads it on a timer: a read that fails opens the stream again, and the
// new stream's snapshot starts the next read.
import { retryAfter, type Retry } from './project-feed.ts';
import { T3Error } from './seams.ts';
import type { T3Ws } from './ws.ts';

export type ThreadEnd =
  | { outcome: 'done'; status: string }
  | { outcome: 'waiting'; status: string; request: string }
  | { outcome: 'usage-limit'; status: string; resetAt: string | null; error: string | null }
  | { outcome: 'failed'; status: string; error: string | null; gone?: true };

/** T3 0.1.9's typed code for a thread it doesn't have (`T3Error.codes`, seen live). */
const NOT_FOUND = 'ProjectionStoreThreadNotFoundError';
const ENDED = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back']);
/** T3's live run statuses (`isActivityRunForShell`). */
const LIVE = new Set(['preparing', 'starting', 'running', 'waiting']);

const list = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const ms = (at: unknown): number => {
  const n = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isNaN(n) ? 0 : n;
};

/** The run that ran last among `runs`, as T3 takes it (`latestExecutedRun`, `runRanAfter`), or
 *  null when none ran. */
export function lastExecuted(runs: any[]): any | null {
  const end = (r: any) => (r.completedAt ? ms(r.completedAt) : Infinity);
  let latest: any = null;
  for (const r of runs) {
    if (r?.status === 'queued' || (r?.status === 'cancelled' && !r.startedAt)) continue;
    if (!latest || end(r) > end(latest) || (end(r) === end(latest) && (r.ordinal ?? 0) > (latest.ordinal ?? 0))) latest = r;
  }
  return latest;
}

/** The provider session's last error, as T3 reads it for the thread (`threadErrorSummary`): the
 *  newest session on the thread's provider instance. */
function sessionError(projection: any): string | null {
  const instance = projection?.thread?.providerInstanceId;
  const s = list(projection?.providerSessions).filter((x) => instance === undefined || x?.providerInstanceId === instance)
    .sort((a, b) => ms(b?.updatedAt) - ms(a?.updatedAt))[0];
  return typeof s?.lastError === 'string' ? s.lastError : null;
}

/** A failed run's current failure (`latestRootProviderFailure`, then `threadErrorSummary`): its
 *  root node's latest failed `error` item, unless the provider session has since failed on
 *  something else. */
function failureOf(run: any, projection: any): any | null {
  if (run?.status !== 'failed') return null;
  let latest: any = null;
  for (const i of list(projection?.turnItems)) {
    if (i?.type !== 'error' || i.status !== 'failed' || i.runId !== run.id || i.nodeId !== run.rootNodeId) continue;
    if (!latest || ms(i.updatedAt) > ms(latest.updatedAt)
      || (ms(i.updatedAt) === ms(latest.updatedAt) && ((i.ordinal ?? 0) > (latest.ordinal ?? 0) || ((i.ordinal ?? 0) === (latest.ordinal ?? 0) && String(i.id) > String(latest.id))))) latest = i;
  }
  const failure = latest?.failure ?? null;
  const session = sessionError(projection);
  return session !== null && session !== failure?.message ? null : failure;
}

/** How a run T3 shows ended (`ENDED`) ended: done, its usage limit, or failed with its error. */
function endedRun(run: any, projection: any): ThreadEnd {
  const status: string = run.status;
  if (status === 'completed') return { outcome: 'done', status };
  const failure = failureOf(run, projection);
  const error = typeof failure?.message === 'string' ? failure.message : null;
  if (status === 'failed' && failure?.class === 'usage_limit') {
    return { outcome: 'usage-limit', status, resetAt: typeof failure.resetAt === 'string' ? failure.resetAt : null, error };
  }
  return { outcome: 'failed', status, error };
}

/** What the thread waits on the user for, as T3's shell presents it (`pendingRuntimeRequest`), or
 *  null: a pending runtime request (approvals before questions), or the newest waiting card. A
 *  secret card waits while its run is live; a link card after its run, until the user writes in
 *  the thread after it (`waitsOnUser`). A question T3 restarted under (its capability `message`)
 *  still waits: its answer goes as a message. */
export function waitingOn(projection: any): string | null {
  const request = list(projection?.runtimeRequests).filter((r) => r?.status === 'pending')
    .sort((a, b) => Number(a.kind === 'user_input') - Number(b.kind === 'user_input') || ms(b.createdAt) - ms(a.createdAt))[0];
  if (request && request.kind !== 'user_input') return String(request.kind ?? 'request');
  const live = new Set(list(projection?.runs).filter((r) => LIVE.has(r?.status)).map((r) => r.id));
  const wrote = list(projection?.messages).filter((m) => m?.role === 'user' && m.createdBy === 'user')
    .reduce((at, m) => Math.max(at, ms(m.updatedAt)), -Infinity);
  const card = list(projection?.turnItems)
    .filter((i) => i?.status === 'waiting' && (
      (i.type === 'secret_request' && i.runId != null && live.has(i.runId))
      || (i.type === 'link_request' && !(wrote > ms(i.startedAt ?? i.updatedAt)))))
    .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt))[0];
  if (card && (!request || ms(card.startedAt ?? card.updatedAt) >= ms(request.createdAt))) {
    return card.type === 'secret_request' ? 'a secret card' : 'a link card';
  }
  return request ? String(request.kind) : null;
}

/** The end of `runId` (the thread's newest run when null, leaving out the runs in `known`) as a
 *  thread's state shows it, or null while it runs or before that run shows. A thread waiting on
 *  the user is `waiting`, also after its run ended (a link card waits then). */
export function endOf(projection: any, runId: string | null, known: ReadonlySet<string> = new Set()): ThreadEnd | null {
  const runs = list(projection?.runs).filter((r) => typeof r?.id === 'string');
  const run = runId ? runs.find((r) => r.id === runId)
    : runs.filter((r) => !known.has(r.id)).sort((a, b) => ms(a.requestedAt) - ms(b.requestedAt) || (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1);
  if (!run) return null;
  const asked = waitingOn(projection);
  if (asked) return { outcome: 'waiting', status: run.status, request: asked };
  return ENDED.has(run.status) ? endedRun(run, projection) : null;
}

/** Where a job's runs are, as one read of its thread shows them (`threadNow`). */
export type ThreadNow =
  /** No run of the job's shows yet (a send's new run not there yet). */
  | { state: 'none' }
  /** A run of the job's is live, or queued to go next. */
  | { state: 'running' }
  /** The thread waits on the user in T3 (a question, an approval, a secret or link card), and
   *  its run goes on, or a new one starts, once they answer. */
  | { state: 'asking'; request: string }
  /** Every run of the job's has ended, or waits in a queue that won't start on its own: the end
   *  of the one that ran last. */
  | { state: 'ended'; end: ThreadEnd };

/** Where the job's runs are (the thread's runs but those in `known`, which it had before the job's
 *  send), decided from this one read as T3 decides it (see the top of this file):
 *  - the thread waiting on the user: `asking`, whatever its runs say;
 *  - a run of the job's live (`waiting` too, which a run passes through on its way to
 *    `completed`; a status that's neither an end nor `queued` too): `running`;
 *  - one queued that will start (unheld, in a thread not archived): `running`, unless the
 *    thread's run that ran last failed on a usage limit, which its queue waits behind: that end;
 *  - otherwise the end of the job's run that ran last. A job whose runs never ran (cancelled
 *    before they started, or held in the queue) ended failed. */
export function threadNow(projection: any, known: ReadonlySet<string> = new Set()): ThreadNow {
  const asked = waitingOn(projection);
  if (asked) return { state: 'asking', request: asked };
  const all = list(projection?.runs).filter((r) => typeof r?.id === 'string');
  const runs = all.filter((r) => !known.has(r.id));
  if (!runs.length) return { state: 'none' };
  // live, or a status T3 may add that isn't an end
  if (runs.some((r) => !ENDED.has(r.status) && r.status !== 'queued')) return { state: 'running' };
  const archived = Boolean(projection?.thread?.archivedAt);
  if (!archived && runs.some((r) => r.status === 'queued' && r.queueHeld !== true)) {
    const blocking = lastExecuted(all);
    const end = blocking && ENDED.has(blocking.status) ? endedRun(blocking, projection) : null;
    return end?.outcome === 'usage-limit' ? { state: 'ended', end } : { state: 'running' };
  }
  const last = lastExecuted(runs);
  if (last) return { state: 'ended', end: endedRun(last, projection) };
  const held = runs.some((r) => r.status === 'queued');
  return {
    state: 'ended',
    end: held
      ? { outcome: 'failed', status: 'queued', error: archived ? 'its run is queued in an archived thread, where T3 starts none' : "its run is held in T3's queue, which doesn't start on its own" }
      : { outcome: 'failed', status: 'cancelled', error: 'its run was cancelled before it started' },
  };
}

/** What one read of a thread gave: its whole projection; `gone`, deleted in T3 (`deletedAt`, or
 *  T3's titles read fine without it); or `unreadable`, with why. */
export type ThreadRead = { projection: any } | { gone: true; why: string } | { unreadable: string };

/** Whether T3 still has the thread, archived or not: `orchestration.getThreadTitles`, which leaves
 *  out deleted and unknown ids (T3's typed answer). An answer that isn't a record throws. */
export async function threadKept(ws: Pick<T3Ws, 'request'>, threadId: string): Promise<boolean> {
  const titles = await ws.request('orchestration.getThreadTitles', { threadIds: [threadId] });
  if (titles === null || typeof titles !== 'object' || Array.isArray(titles)) throw new T3Error("T3's thread titles came back as no record");
  return Object.hasOwn(titles, threadId);
}

/** One read of the thread's whole current state (`ThreadRead`): `subscribeThread`'s snapshot.
 *  A read that fails, whatever its text or code, says nothing about the thread: only T3's titles
 *  decide it's gone. Never throws. */
export async function readThread(ws: Pick<T3Ws, 'request' | 'first'>, threadId: string): Promise<ThreadRead> {
  let why: string;
  try {
    const item = await ws.first('orchestration.subscribeThread', { threadId });
    const p = item?.kind === 'snapshot' ? item.projection : null;
    if (Array.isArray(p?.runs)) {
      if (p.thread?.deletedAt) return { gone: true, why: `T3 deleted it at ${p.thread.deletedAt}` };
      return { projection: p };
    }
    why = `T3 sent thread ${threadId} no snapshot of its runs`;
  } catch (e) {
    why = (e as Error).message;
  }
  try {
    return (await threadKept(ws, threadId)) ? { unreadable: why } : { gone: true, why: "T3's thread titles don't have it" };
  } catch (e) {
    return { unreadable: `${why}; T3's thread titles couldn't be read either (${(e as Error).message})` };
  }
}

/** The thread changes that may change what a read decides (the events T3's own usage-limit worker
 *  wakes on, and cards): a run made or changed, a request, the thread itself, the provider
 *  session (its `lastError`), and turn items that are cards, questions, interrupts or errors. The
 *  rest (messages as they stream, checkpoints...) start no read. */
const READS_ON_ITEMS = new Set(['error', 'secret_request', 'link_request', 'user_input_request', 'approval_request', 'run_interrupt_request', 'run_interrupt_result']);
const readsOn = (item: any): boolean => {
  if (item?.kind === 'snapshot') return true;
  if (item?.kind !== 'event') return false;
  const type = String(item.event?.type ?? '');
  return type === 'run.created' || type === 'run.updated' || type === 'runtime-request.updated' || type.startsWith('thread.')
    || type === 'provider-session.updated' || (type === 'turn-item.updated' && READS_ON_ITEMS.has(item.event?.payload?.type));
};

export type Following<T> = {
  /** Settles with what `decide` returned; rejects only when `stop()` is called first. */
  end: Promise<T>;
  stop(): void;
  /** Decides again on the newest read, with no new read: what `decide` hangs on beside T3 has
   *  changed (GitHub's answer). A read under way decides anyway, so it does nothing then. */
  recheck(): void;
};

/** Follows one thread as T3 pushes its changes: the stream (`orchestration.subscribeThread`) only
 *  says when to read. The thread is read (`readThread`) when its stream sends its snapshot (at the
 *  start, and each time it opens again) and on each change it pushes, never on a timer: a stream
 *  that drops, or a read that fails, opens the stream again `retry` later, and only its snapshot
 *  reads; a stream T3 fails with its typed "no such thread" is read once (`readThread` asks T3's
 *  titles whether it's deleted). `decide` gets each read and ends the following with what it returns, or null to go on.
 *  One read at a time, and a read that a change came during is read again before anything is
 *  decided on it, so every decision is on a read newer than the changes before it. `onDown`
 *  hears why a stream was opened again. */
export function followThread<T>(ws: Pick<T3Ws, 'subscribe' | 'request' | 'first'>, threadId: string,
  decide: (read: ThreadRead) => T | null, retry: Retry = retryAfter(5_000), onDown: (why: string) => void = () => {}): Following<T> {
  let stopped = false;
  let done = false;
  let reading = false;
  let again = false;
  let last: ThreadRead | null = null;
  /** Each stream opened has its own number: a drop or a failed read of an older one is past. */
  let generation = 0;
  let close = () => {};
  let finish: (v: T) => void = () => {};
  let rejectStop: (e: Error) => void = () => {};
  const end = new Promise<T>((resolve, reject) => {
    rejectStop = reject;
    finish = (v) => {
      done = true;
      close();
      resolve(v);
    };
  });
  /** The stream opened again `retry` later, the one open now closed first. */
  const reopen = (why: string) => {
    if (done || stopped) return;
    generation++;
    close();
    onDown(why);
    close = retry(open);
  };
  const read = () => {
    if (done || stopped) return;
    if (reading) { again = true; return; }
    reading = true;
    void (async () => {
      do {
        again = false;
        const at = generation;
        const got = await readThread(ws, threadId);
        if (done || stopped) break;
        // a change came while it read: its answer may be older than the change, so it's read
        // again and nothing is decided on this one (F20)
        if (again) continue;
        last = got;
        const v = decide(got);
        if (v !== null) { finish(v); break; }
        // a read that fails while its stream stays up would leave nothing to read again: the
        // stream is opened again, and its snapshot reads (F21)
        if ('unreadable' in got && at === generation) reopen(`the thread couldn't be read (${got.unreadable})`);
      } while (again && !done && !stopped);
      // released in the continuation that made the last check, so a change at any moment is
      // either seen by that check or finds no read under way (F2's rule)
      reading = false;
    })();
  };
  // a stream is opened only: its snapshot, once T3 sends it, starts the read, so a stream that
  // never opens reads nothing (F23)
  const open = () => {
    if (done || stopped) return;
    const mine = ++generation;
    const sub = ws.subscribe('orchestration.subscribeThread', { threadId }, (item) => { if (mine === generation && readsOn(item)) read(); });
    close = () => sub.close();
    const down = (why: string) => { if (mine === generation) reopen(why); };
    sub.done.then(() => down(`T3 ended the stream of thread ${threadId}`), (e: Error) => {
      // T3's typed answer that it has no such thread (its code, never its text) is read on: T3's
      // titles say whether it's deleted. Any other failure only opens the stream again
      if (mine === generation && e instanceof T3Error && e.codes.includes(NOT_FOUND)) read();
      down(e.message);
    });
  };
  open();
  return {
    end,
    stop: () => {
      if (stopped || done) return;
      stopped = true;
      close();
      rejectStop(new Error(`stopped watching thread ${threadId}`));
    },
    recheck: () => {
      if (done || stopped || reading || last === null) return;
      const v = decide(last);
      if (v !== null) finish(v);
    },
  };
}

/** The job a thread watch is for: its title and thread, the runs its thread had before it (a
 *  fix round's send), and its repo, for the lines it says. */
export type WatchedJob = { title: string; threadId: string; link?: string | null; knownRuns?: string[]; github?: string | null; repo: string };

/** What holds a job whose runs have ended beside T3: a question it put on GitHub (#211's
 *  decision: the issue's `needs-info`), read on GitHub's timer. */
export type GithubHold = {
  /** The question open on GitHub now, null for none, undefined while not read since the job's
   *  runs last ended. */
  open(): string | null | undefined;
  /** The job's runs have just ended: GitHub is read again, and the watch rechecked on its answer. */
  ended(): void;
};

/** A repo job's thread followed (`followThread`) until the job's runs have all ended
 *  (`threadNow`), through any wait on the user in T3, and, with `hold`, until no question it put
 *  on GitHub is open: their end. A thread deleted in T3 ends failed, with status `gone` (F11,
 *  F15), whatever GitHub says: no run can go on in it; one that can't be read is followed on.
 *  `say` hears each change worth a line, once per change. */
export function watchJobThread(ws: Pick<T3Ws, 'subscribe' | 'request' | 'first'>, job: WatchedJob,
  say: (line: string) => void, retry?: Retry, hold?: GithubHold): Following<ThreadEnd> {
  const known = new Set(job.knownRuns ?? []);
  const where = job.link ?? job.threadId;
  const repo = job.github ?? job.repo;
  let told: string | null = null;
  let ended = false;
  const tell = (what: string, line: string) => { if (told !== what) say(line); told = what; };
  return followThread<ThreadEnd>(ws, job.threadId, (read) => {
    if ('gone' in read) {
      say(`${job.title}: thread ${job.threadId} is deleted in T3 (${read.why}): the job has ended`);
      return { outcome: 'failed', status: 'gone', error: `thread ${job.threadId} is deleted in T3 (${read.why})`, gone: true };
    }
    if ('unreadable' in read) {
      tell('unreadable', `${job.title}: its thread ${where} can't be read now (${read.unreadable}); read again when its stream opens again, and nothing else starts in ${repo} meanwhile`);
      return null;
    }
    const now = threadNow(read.projection, known);
    if (now.state !== 'ended') ended = false;
    if (now.state === 'asking') {
      tell('asking', `${job.title} waits on you in T3 (${now.request}): ${where}. Nothing else starts in ${repo} until its run has finished`);
      return null;
    }
    if (now.state === 'ended') {
      if (!hold) return now.end;
      if (!ended) { ended = true; hold.ended(); }
      const open = hold.open();
      if (open === null) return now.end;
      if (open !== undefined) tell(`github ${open}`, `${job.title} waits on you on GitHub (${open}). Nothing else starts in ${repo} until it's answered and its run has finished: ${where}`);
      return null;
    }
    if (told !== null) say(`${job.title}: its thread ${where} goes on`);
    told = null;
    return null;
  }, retry, (why) => say(`${job.title}: T3's thread stream opened again (${why})`));
}

export type Watch = {
  /** Settles with the run's end; rejects only when `stop()` is called first. */
  end: Promise<ThreadEnd>;
  stop(): void;
};

/** Watches one thread until `runId` ends or the thread waits on the user (with no `runId`, its
 *  newest run not in `known`), keeping the thread's state from its stream: the snapshot, then
 *  each event's item in place of the one with its id (a run made or changed, a request, a node, a
 *  turn item). `onDown` hears why a stream dropped, before it's opened again. */
export function watchThreadEnd(ws: Pick<T3Ws, 'subscribe'>, threadId: string, runId: string | null,
  retry: Retry = retryAfter(5_000), onDown: (why: string) => void = () => {}, known: ReadonlySet<string> = new Set()): Watch {
  let stopped = false;
  let close = () => {};
  let rejectStop: (e: Error) => void = () => {};
  const LISTS: Record<string, string> = {
    'run.created': 'runs', 'run.updated': 'runs', 'runtime-request.updated': 'runtimeRequests', 'node.updated': 'nodes',
    'turn-item.updated': 'turnItems', 'message.updated': 'messages', 'provider-session.updated': 'providerSessions',
  };
  const end = new Promise<ThreadEnd>((resolve, reject) => {
    rejectStop = reject;
    const open = () => {
      if (stopped) return;
      let state: any = null;
      let found = false;
      const sub = ws.subscribe('orchestration.subscribeThread', { threadId }, (item) => {
        if (found) return;
        if (item?.kind === 'snapshot') {
          state = structuredClone(item.projection ?? {});
        } else if (item?.kind === 'event' && state) {
          const { type, payload } = item.event ?? {};
          const key = LISTS[type];
          if (type?.startsWith('thread.') && payload && typeof payload === 'object') state.thread = { ...state.thread, ...payload };
          else if (!key || typeof payload?.id !== 'string') return;
          else {
            const items: any[] = Array.isArray(state[key]) ? state[key] : (state[key] = []);
            const at = items.findIndex((x) => x?.id === payload.id);
            if (at >= 0) items[at] = payload; else items.push(payload);
          }
        } else return;
        const got = endOf(state, runId, known);
        if (!got) return;
        found = true;
        sub.close();
        resolve(got);
      });
      close = () => sub.close();
      const down = (why: string) => {
        if (found || stopped) return;
        onDown(why);
        close = retry(open);
      };
      sub.done.then(() => down(`T3 ended the stream of thread ${threadId}`), (e: Error) => down(e.message));
    };
    open();
  });
  return {
    end,
    stop: () => {
      if (stopped) return;
      stopped = true;
      close();
      rejectStop(new Error(`stopped watching thread ${threadId}`));
    },
  };
}
