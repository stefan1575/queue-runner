// In place or fresh (#158; today's `limits.resume_choice`, docs/usage.md In place or fresh): the
// one rule for picking a job up in the thread it ran in, or in a fresh one. It reads only what T3
// measures at the moment the job resumes, from the thread's projection
// (`orchestration.getThreadProjection`): its provider turns, each with `startedAt` and
// `tokenUsage.usedTokens` (T3's schema, read in its server 2026-11-20). Today's runner read the
// provider's own transcripts for the same two numbers; the app reads only T3.
//
// - **Warm** (its last request started under WARM_FOR_MS ago): in place, any size. The provider's
//   prompt cache lasts an hour from a request's start; 55 minutes is the research's margin under it.
// - **Cold and under COLD_FRESH_MIN tokens:** in place.
// - **Cold and COLD_FRESH_MIN or more:** a fresh thread (the research's cold break-even, rounded up
//   toward continuing).
// - An unknown age is cold; an unknown size is large.
import type { T3Ws } from './t3/ws.ts';

export const WARM_FOR_MS = 55 * 60_000;
export const COLD_FRESH_MIN = 120_000;

export type ResumeChoice = { inPlace: boolean; why: string };

const age = (mins: number) => (mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`);

export function resumeChoice(lastRequest: Date | null, tokens: number | null, now: Date): ResumeChoice {
  const idle = lastRequest ? Math.max(0, Math.floor((now.getTime() - lastRequest.getTime()) / 60_000)) : null;
  if (lastRequest && now.getTime() - lastRequest.getTime() < WARM_FOR_MS) {
    return { inPlace: true, why: `warm (its last request started ${age(idle!)} ago): continuing it in place is cheaper at any size` };
  }
  const when = idle === null ? 'when its last request started is unknown' : `its last request started ${age(idle)} ago`;
  if (tokens === null) return { inPlace: false, why: `cold (${when}) and its size unknown: a fresh thread` };
  return tokens < COLD_FRESH_MIN
    ? { inPlace: true, why: `cold (${when}) and ${tokens.toLocaleString('en-US')} tokens, under ${COLD_FRESH_MIN.toLocaleString('en-US')}: continuing it in place is cheaper` }
    : { inPlace: false, why: `cold (${when}) and ${tokens.toLocaleString('en-US')} tokens, at least ${COLD_FRESH_MIN.toLocaleString('en-US')}: a fresh thread is cheaper` };
}

/** What picking a thread up needs from T3: when its last request started and its context (from
 *  its newest provider turn), its runs (oldest first), and the question it waits on, if any: the
 *  pending `user_input` request and its questions' ids. */
export type ThreadNow = {
  lastRequest: Date | null; tokens: number | null; runs: string[];
  pending: { requestId: string; questions: string[] } | null;
};

export async function threadNow(ws: Pick<T3Ws, 'request'>, threadId: string): Promise<ThreadNow> {
  const p = await ws.request('orchestration.getThreadProjection', { threadId });
  if (!p || typeof p !== 'object') throw new Error(`T3 gave no projection of thread ${threadId}`);
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const turns = list(p.providerTurns).filter((t) => typeof t?.startedAt === 'string' && !Number.isNaN(Date.parse(t.startedAt)))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const last = turns.at(-1);
  const used = last?.tokenUsage?.usedTokens;
  const request = list(p.runtimeRequests).find((r) => r?.status === 'pending' && r?.kind === 'user_input' && typeof r.id === 'string');
  const asked = request ? list(p.turnItems).filter((i) => i?.type === 'user_input_request' && i.requestId === request.id).at(-1) : null;
  return {
    lastRequest: last ? new Date(last.startedAt) : null,
    tokens: typeof used === 'number' ? used : null,
    runs: [...list(p.runs)].sort((a, b) => (a?.ordinal ?? 0) - (b?.ordinal ?? 0)).map((r) => r?.id).filter((x): x is string => typeof x === 'string'),
    pending: request ? { requestId: request.id, questions: list(asked?.questions).map((q) => q?.id).filter((x): x is string => typeof x === 'string') } : null,
  };
}
