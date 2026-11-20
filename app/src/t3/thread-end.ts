// How a job's run ended, learned from T3's thread events (#154; #68: the runner reacts to T3's
// events, no polling): `orchestration.subscribeThread {threadId}` sends the thread's projection
// (`runs`, `runtimeRequests`, `turnItems`...), then each change as a `run.updated`,
// `runtime-request.updated` or `turn-item.updated` event (docs/app.md, The WebSocket API; seen live
// 2026-11-19 against T3 0.1.9). A stream that ends or fails before the end is known is opened again
// after a wait: its new snapshot holds whatever happened meanwhile.
//
// - **Done:** the run `completed`.
// - **Waiting on a question:** the run hasn't ended and a runtime request is `pending` (a question
//   to the user, or an approval). A run is `waiting` for a moment on its way to `completed` too
//   (seen live), so `waiting` alone isn't a question.
// - **Usage limit:** the run `failed` and its root node's latest failed `error` item has the
//   failure class `usage_limit` (T3's own `latestRootProviderFailure`), with `resetAt` when T3 has it.
// - **Failed:** any other end (`failed`, `interrupted`, `cancelled`, `rolled_back`).
//
// A repo's job (a build, a fix or a conflict round) is followed by `watchJobThread` instead
// (#210): T3 pushes the thread's changes, and on each one, at the start and whenever the stream
// opens again, the app reads the thread's current state (`orchestration.getThreadProjection`) and
// decides from that read alone (`threadNow`), never from the order events came in. Nothing reads
// it on a timer. A job whose run waits on the user in T3 (a pending request: a question, a login
// or secret card) hasn't ended: it's followed on until its runs have finished. A thread whose
// read fails is gone only when T3's thread list reads fine without it (`threadListed`); any
// other failure, whatever its text, leaves it unreadable, read again on its next change or when
// its stream opens again.
import { retryAfter, type Retry } from './project-feed.ts';
import type { T3Ws } from './ws.ts';

export type ThreadEnd =
  | { outcome: 'done'; status: string }
  | { outcome: 'waiting'; status: string; request: string }
  | { outcome: 'usage-limit'; status: string; resetAt: string | null; error: string | null }
  | { outcome: 'failed'; status: string; error: string | null; gone?: true };

const ENDED = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back']);

type State = { runs: Map<string, any>; requests: Map<string, any>; errors: Map<string, any> };

const byId = (list: unknown) => new Map((Array.isArray(list) ? list : []).filter((x) => typeof x?.id === 'string').map((x) => [x.id, x]));

/** The end of `runId` (the thread's latest run when null, leaving out the runs in `known`: a
 *  message sent to a thread that had them starts a new one) as the state shows it, or null while
 *  it runs or before that new run shows. */
export function endOf(state: State, runId: string | null, known: ReadonlySet<string> = new Set()): ThreadEnd | null {
  const run = runId ? state.runs.get(runId)
    : [...state.runs.values()].filter((r) => !known.has(r.id)).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1);
  if (!run) return null;
  const status: string = run.status;
  if (!ENDED.has(status)) {
    const asked = [...state.requests.values()].find((r) => r.status === 'pending');
    return asked ? { outcome: 'waiting', status, request: asked.kind ?? 'request' } : null;
  }
  return endedRun(run, state.errors);
}

/** How a run T3 shows ended (`ENDED`) ended: done, its usage limit, or failed with its error. */
function endedRun(run: any, errors: Map<string, any>): ThreadEnd {
  const status: string = run.status;
  if (status === 'completed') return { outcome: 'done', status };
  const failure = [...errors.values()]
    .filter((i) => i.status === 'failed' && i.runId === run.id && i.nodeId === run.rootNodeId)
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')) || (a.ordinal ?? 0) - (b.ordinal ?? 0))
    .at(-1)?.failure;
  const error = typeof failure?.message === 'string' ? failure.message : null;
  if (status === 'failed' && failure?.class === 'usage_limit') {
    return { outcome: 'usage-limit', status, resetAt: typeof failure.resetAt === 'string' ? failure.resetAt : null, error };
  }
  return { outcome: 'failed', status, error };
}

/** Where a job's runs are, as one read of its thread shows them (`threadNow`). */
export type ThreadNow =
  /** No run of the job's shows yet (a send's new run not there yet). */
  | { state: 'none' }
  /** A run of the job's is under way, or queued to go next. */
  | { state: 'running' }
  /** A request is pending in the thread: it waits on the user in T3 (a question, a login or
   *  secret card), and its run goes on once they answer, also in a new turn. */
  | { state: 'asking'; request: string }
  /** Every run of the job's has ended: the end of the one that ran last. */
  | { state: 'ended'; end: ThreadEnd };

/** Where the job's runs are (the thread's runs but those in `known`, which it had before the job's
 *  send), decided from this one read (#210):
 *  - a request pending in the thread: `asking`, whatever its runs say. T3 restarted while a run
 *    waited on a card can cancel the run and keep the request, and the answer starts a new turn
 *    (F16);
 *  - a run executing (any status but an end or `queued`, `waiting` included, which a run passes
 *    through on its way to `completed` too; an unknown one too): `running`;
 *  - none executing and one queued: `running` (it goes next), unless the run that ran last ended on
 *    a usage limit: then that's the end, since the queued run waits behind the limit (F17);
 *  - every one ended: the end of the one that ran last (the highest ordinal among the ended), so a
 *    run queued after it never hides it (F17). */
export function threadNow(projection: any, known: ReadonlySet<string> = new Set()): ThreadNow {
  const requests: any[] = Array.isArray(projection?.runtimeRequests) ? projection.runtimeRequests : [];
  const asked = requests.find((r) => r?.status === 'pending');
  if (asked) return { state: 'asking', request: typeof asked.kind === 'string' ? asked.kind : 'request' };
  const runs: any[] = (Array.isArray(projection?.runs) ? projection.runs : []).filter((r: any) => typeof r?.id === 'string' && !known.has(r.id));
  if (!runs.length) return { state: 'none' };
  if (runs.some((r) => !ENDED.has(r.status) && r.status !== 'queued')) return { state: 'running' };
  const errors = byId((Array.isArray(projection?.turnItems) ? projection.turnItems : []).filter((i: any) => i?.type === 'error'));
  const last = runs.filter((r) => ENDED.has(r.status)).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1);
  const lastEnd = last ? endedRun(last, errors) : null;
  if (runs.some((r) => r.status === 'queued')) return lastEnd?.outcome === 'usage-limit' ? { state: 'ended', end: lastEnd } : { state: 'running' };
  return { state: 'ended', end: lastEnd! };
}

/** What one read of a thread gave: its projection; `gone`, T3's thread list read fine without it;
 *  or `unreadable`, with why (T3 down, the read failing for any reason, the list not read). */
export type ThreadRead = { projection: any } | { gone: true } | { unreadable: string };

/** Whether T3's thread list has the thread: the whole snapshot `orchestration.subscribeShell`
 *  sends first, its `threads` and `archivedThreads` (docs/app.md, The WebSocket API). Only a whole
 *  snapshot with both lists answers; anything else (a partial snapshot, no lists, the stream
 *  failing) throws: no answer. */
export async function threadListed(ws: Pick<T3Ws, 'first'>, threadId: string): Promise<boolean> {
  const item = await ws.first('orchestration.subscribeShell', {});
  const snap = item?.kind === 'snapshot' && item.resolvedRepositoryIdentityRoots === undefined ? item.snapshot : null;
  if (!Array.isArray(snap?.threads) || !Array.isArray(snap?.archivedThreads)) {
    throw new Error("T3's thread list came back without its threads");
  }
  return [...snap.threads, ...snap.archivedThreads].some((t: any) => t?.id === threadId);
}

/** One read of the thread's current state (`ThreadRead`). A projection read that fails says
 *  nothing about the thread, whatever its text (F15): only the thread list decides it's gone.
 *  Never throws. */
export async function readThread(ws: Pick<T3Ws, 'request' | 'first'>, threadId: string): Promise<ThreadRead> {
  let why: string;
  try {
    const p = await ws.request('orchestration.getThreadProjection', { threadId });
    if (Array.isArray(p?.runs)) return { projection: p };
    why = `T3 gave thread ${threadId} no runs`;
  } catch (e) {
    why = (e as Error).message;
  }
  try {
    return (await threadListed(ws, threadId)) ? { unreadable: why } : { gone: true };
  } catch (e) {
    return { unreadable: `${why}; T3's thread list couldn't be read either (${(e as Error).message})` };
  }
}

/** The thread events that may change what a read decides: a run, a request, an error item, the
 *  thread itself. The rest (messages as they stream, checkpoints...) start no read. */
const readsOn = (item: any): boolean => {
  if (item?.kind === 'snapshot') return true;
  if (item?.kind !== 'event') return false;
  const type = String(item.event?.type ?? '');
  return type === 'run.updated' || type === 'runtime-request.updated' || type.startsWith('thread.')
    || (type === 'turn-item.updated' && item.event?.payload?.type === 'error');
};

export type Following<T> = {
  /** Settles with what `decide` returned; rejects only when `stop()` is called first. */
  end: Promise<T>;
  stop(): void;
};

/** Follows one thread as T3 pushes its changes: the stream (`orchestration.subscribeThread`) only
 *  says when to read. The thread is read (`readThread`) each time its stream is opened (at the
 *  start, and again after a drop, `retry` later) and on each change it pushes, never on a timer;
 *  `decide` gets each read and ends the following with what it returns, or null to go on. One
 *  read at a time: a change during one is read once after it, so every decision is on a read
 *  newer than the changes before it. `onDown` hears why a stream dropped. */
export function followThread<T>(ws: Pick<T3Ws, 'subscribe' | 'request' | 'first'>, threadId: string,
  decide: (read: ThreadRead) => T | null, retry: Retry = retryAfter(5_000), onDown: (why: string) => void = () => {}): Following<T> {
  let stopped = false;
  let done = false;
  let reading = false;
  let again = false;
  let close = () => {};
  let rejectStop: (e: Error) => void = () => {};
  const end = new Promise<T>((resolve, reject) => {
    rejectStop = reject;
    const read = () => {
      if (done || stopped) return;
      if (reading) { again = true; return; }
      reading = true;
      void (async () => {
        do {
          again = false;
          const got = await readThread(ws, threadId);
          if (done || stopped) break;
          const v = decide(got);
          if (v !== null) {
            done = true;
            close();
            resolve(v);
          }
        } while (again && !done && !stopped);
        // released in the continuation that made the last check, so a change at any moment is
        // either seen by that check or finds no read under way (F2's rule)
        reading = false;
      })();
    };
    const open = () => {
      if (done || stopped) return;
      const sub = ws.subscribe('orchestration.subscribeThread', { threadId }, (item) => { if (readsOn(item)) read(); });
      close = () => sub.close();
      const down = (why: string) => {
        if (done || stopped) return;
        onDown(why);
        close = retry(open);
      };
      sub.done.then(() => down(`T3 ended the stream of thread ${threadId}`), (e: Error) => down(e.message));
      read();
    };
    open();
  });
  return {
    end,
    stop: () => {
      if (stopped || done) return;
      stopped = true;
      close();
      rejectStop(new Error(`stopped watching thread ${threadId}`));
    },
  };
}

/** The job a thread watch is for: its title and thread, the runs its thread had before it (a
 *  fix round's send), and its repo, for the lines it says. */
export type WatchedJob = { title: string; threadId: string; link?: string | null; knownRuns?: string[]; github?: string | null; repo: string };

/** A repo job's thread followed (`followThread`) until the job's runs have all ended
 *  (`threadNow`), through any wait on the user in T3: their end. A thread T3's list reads fine
 *  without (deleted in T3) ends failed, with status `gone` (F11, F15); one that can't be read is
 *  followed on. `say` hears each change worth a line, once per change: the run waiting on the
 *  user, going on after, the thread unreadable. */
export function watchJobThread(ws: Pick<T3Ws, 'subscribe' | 'request' | 'first'>, job: WatchedJob,
  say: (line: string) => void, retry?: Retry): Following<ThreadEnd> {
  const known = new Set(job.knownRuns ?? []);
  const where = job.link ?? job.threadId;
  const repo = job.github ?? job.repo;
  let told: 'asking' | 'unreadable' | null = null;
  return followThread<ThreadEnd>(ws, job.threadId, (read) => {
    if ('gone' in read) {
      say(`${job.title}: T3's thread list has no thread ${job.threadId}, deleted in T3: the job has ended`);
      return { outcome: 'failed', status: 'gone', error: `thread ${job.threadId} is gone in T3 (its thread list doesn't have it)`, gone: true };
    }
    if ('unreadable' in read) {
      if (told !== 'unreadable') say(`${job.title}: its thread ${where} can't be read now (${read.unreadable}); read again on its next change or when its stream opens again, and nothing else starts in ${repo} meanwhile`);
      told = 'unreadable';
      return null;
    }
    const now = threadNow(read.projection, known);
    if (now.state === 'ended') return now.end;
    if (now.state === 'asking') {
      if (told !== 'asking') say(`${job.title} waits on you in T3 (${now.request}): ${where}. Nothing else starts in ${repo} until its run has finished`);
      told = 'asking';
      return null;
    }
    if (told !== null) say(`${job.title}: its thread ${where} goes on`);
    told = null;
    return null;
  }, retry, (why) => say(`${job.title}: T3's thread stream dropped (${why}); opening it again`));
}

export type Watch = {
  /** Settles with the run's end; rejects only when `stop()` is called first. */
  end: Promise<ThreadEnd>;
  stop(): void;
};

/** Watches one thread until `runId` ends or stops on a question (with no `runId`, its newest run
 *  not in `known`). `onDown` hears why a stream dropped, before it's opened again. */
export function watchThreadEnd(ws: Pick<T3Ws, 'subscribe'>, threadId: string, runId: string | null,
  retry: Retry = retryAfter(5_000), onDown: (why: string) => void = () => {}, known: ReadonlySet<string> = new Set()): Watch {
  let stopped = false;
  let close = () => {};
  let rejectStop: (e: Error) => void = () => {};
  const end = new Promise<ThreadEnd>((resolve, reject) => {
    rejectStop = reject;
    const open = () => {
      if (stopped) return;
      const state: State = { runs: new Map(), requests: new Map(), errors: new Map() };
      let found = false;
      const sub = ws.subscribe('orchestration.subscribeThread', { threadId }, (item) => {
        if (found) return;
        if (item?.kind === 'snapshot') {
          const p = item.projection ?? {};
          state.runs = byId(p.runs);
          state.requests = byId(p.runtimeRequests);
          state.errors = byId((Array.isArray(p.turnItems) ? p.turnItems : []).filter((i: any) => i?.type === 'error'));
        } else if (item?.kind === 'event') {
          const { type, payload } = item.event ?? {};
          if (typeof payload?.id !== 'string') return;
          if (type === 'run.updated') state.runs.set(payload.id, payload);
          else if (type === 'runtime-request.updated') state.requests.set(payload.id, payload);
          else if (type === 'turn-item.updated' && payload.type === 'error') state.errors.set(payload.id, payload);
          else return;
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
