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
import { retryAfter, type Retry } from './project-feed.ts';
import type { T3Ws } from './ws.ts';

export type ThreadEnd =
  | { outcome: 'done'; status: string }
  | { outcome: 'waiting'; status: string; request: string }
  | { outcome: 'usage-limit'; status: string; resetAt: string | null; error: string | null }
  | { outcome: 'failed'; status: string; error: string | null };

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
  if (status === 'completed') return { outcome: 'done', status };
  const failure = [...state.errors.values()]
    .filter((i) => i.status === 'failed' && i.runId === run.id && i.nodeId === run.rootNodeId)
    .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')) || (a.ordinal ?? 0) - (b.ordinal ?? 0))
    .at(-1)?.failure;
  const error = typeof failure?.message === 'string' ? failure.message : null;
  if (status === 'failed' && failure?.class === 'usage_limit') {
    return { outcome: 'usage-limit', status, resetAt: typeof failure.resetAt === 'string' ? failure.resetAt : null, error };
  }
  return { outcome: 'failed', status, error };
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
