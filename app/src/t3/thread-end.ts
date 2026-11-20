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
// - **Gone:** a stream that drops on a thread T3 confirms isn't there (deleted in T3) is a failed
//   end with status `gone`, never opened again (#210 F11). Only T3's MCP answering `t3_thread_read`
//   for the thread with "not found" confirms it; a stream failure, or T3 down or busy, says nothing
//   about the thread, and the stream is opened again.
import { ToolFailed, type T3Mcp } from './mcp.ts';
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

/** How T3's MCP says a thread isn't there: its `not_found` (or `thread_not_found`) failure. */
const NOT_THERE = /not[_ ]?found|no such thread|does not exist|was deleted/i;

/** Whether T3 confirms the thread isn't there: its MCP answers `t3_thread_read` with "not found".
 *  Any other answer, a read that works or one that fails otherwise (T3 down, busy, a timeout),
 *  confirms nothing: false. Never throws. */
export async function threadGone(mcp: Pick<T3Mcp, 'call'>, threadId: string): Promise<boolean> {
  try {
    await mcp.call('t3_thread_read', { threadId, limit: 1 });
    return false;
  } catch (e) {
    return e instanceof ToolFailed && (NOT_THERE.test(e.code ?? '') || NOT_THERE.test(e.message));
  }
}

/** Watches one thread until `runId` ends or stops on a question (with no `runId`, its newest run
 *  not in `known`). `onDown` hears why a stream dropped, before it's opened again. With
 *  `questions: 'wait'` a question isn't an end: the watch goes on until the run has ended (a job
 *  left waiting, which runs again once the user answers it in T3; #210 F5). With `gone`, a stream
 *  that drops is opened again only once `gone` says T3 hasn't confirmed the thread missing; one it
 *  has ends the watch, failed with status `gone` (#210 F11). */
export function watchThreadEnd(ws: Pick<T3Ws, 'subscribe'>, threadId: string, runId: string | null,
  retry: Retry = retryAfter(5_000), onDown: (why: string) => void = () => {}, known: ReadonlySet<string> = new Set(),
  questions: 'end' | 'wait' = 'end', gone?: () => Promise<boolean>): Watch {
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
        if (!got || (got.outcome === 'waiting' && questions === 'wait')) return;
        found = true;
        sub.close();
        resolve(got);
      });
      close = () => sub.close();
      const again = (why: string) => {
        onDown(why);
        close = retry(open);
      };
      const down = (why: string) => {
        if (found || stopped) return;
        if (!gone) return again(why);
        // a thread T3 confirms isn't there never comes back: its watch ends (#210 F11)
        let cancelled = false;
        close = () => { cancelled = true; };
        void gone().then((missing) => {
          if (found || stopped || cancelled) return;
          if (!missing) return again(why);
          found = true;
          resolve({ outcome: 'failed', status: 'gone', error: `thread ${threadId} is gone in T3 (its stream: ${why})`, gone: true });
        }, () => { if (!found && !stopped && !cancelled) again(why); });
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
