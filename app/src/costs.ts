// What a job is expected to cost, in percent of each of its provider's windows (#153, #122's
// design, today's `gate.py` ported): learned from the app's own records of usage before and after
// each job, per provider, model, effort and kind, with cautious defaults until there are enough.
// Plan-agnostic (#118, closed): costs are percents of each window, so a plan change shows in the
// next measured jobs without the app knowing the plan.
// The records are kept by `src/cost-log.ts`. Shared with the renderer, so nothing here touches Node.
import type { JobKind } from './jobs.ts';
import type { UsageWindow, WindowKind } from './usage.ts';

/** Expected percent of each window, by T3's window id. */
export type Cost = Record<string, number>;

/** Cautious until learned (today's `gate.DEFAULTS`): a build is a long thread, a fix or conflict
 *  round shorter, a decision, a review or an ask about one call's worth. `session` is the short
 *  window, `long` every longer one (the week, a month). */
export const DEFAULT_COSTS: Record<JobKind, { session: number; long: number }> = {
  build: { session: 60, long: 15 },
  fix: { session: 40, long: 10 },
  conflict: { session: 40, long: 10 },
  decision: { session: 15, long: 4 },
  review: { session: 15, long: 4 },
  ask: { session: 15, long: 4 },
};
/** Records a window needs before its cost is learned, and how many recent ones count. */
export const SAMPLES = 3;
export const RECENT = 5;
/** Two readings whose resets are this close are the same window. */
const SAME_WINDOW_MS = 10 * 60_000;

/** Who ran a job: what its learned cost is kept under. */
export type CostKey = { provider: string; model: string; effort: string | null; kind: JobKind };

/** A window as a record keeps it. */
export type Reading = { checkedAt: string | null; windows: Record<string, { used: number; resetsAt: string | null }> };

export type UsageRecord = CostKey & {
  /** When the job ended. */
  at: string;
  job: string;
  before: Reading;
  after: Reading | null;
  /** What it spent of each window: null for a window that reset while it ran. */
  spent: Record<string, number | null> | null;
  /** Other jobs that ran on the same login meanwhile: their spending is in it too, so it
   *  teaches nothing. */
  sharedWith?: string[];
};

export const reading = (checkedAt: string | null, windows: UsageWindow[]): Reading => ({
  checkedAt,
  windows: Object.fromEntries(windows.map((w) => [w.id, { used: w.usedPercent, resetsAt: w.resetsAt }])),
});

/** What a job spent of each window it saw before and after (today's `gate._spent`). */
export function spentOf(before: Reading, after: Reading): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [id, a] of Object.entries(after.windows)) {
    const b = before.windows[id];
    if (!b || b.resetsAt === null || b.used === 0) out[id] = a.used; // a window that started during the job
    else if (a.resetsAt === null || Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) > SAME_WINDOW_MS) out[id] = null;
    else out[id] = Math.max(0, a.used - b.used);
  }
  return out;
}

const sameKey = (r: CostKey, k: CostKey) => r.provider === k.provider && r.model === k.model && r.effort === k.effort && r.kind === k.kind;

/** The default for a kind in a window of this kind. */
export const defaultCost = (kind: JobKind, w: { kind: WindowKind }) => DEFAULT_COSTS[kind][w.kind === 'session' ? 'session' : 'long'];

/** Each window's expected cost for this provider, model, effort and kind: the largest of the last
 *  `RECENT` solo records that measured it, once there are `SAMPLES`; else the cautious default. */
export function expectedCost(records: UsageRecord[], key: CostKey, windows: Pick<UsageWindow, 'id' | 'kind'>[]): { cost: Cost; learned: Record<string, boolean> } {
  const mine = records.filter((r) => sameKey(r, key) && r.spent && !r.sharedWith?.length);
  const cost: Cost = {};
  const learned: Record<string, boolean> = {};
  for (const w of windows) {
    const spent = mine.map((r) => r.spent![w.id]).filter((s): s is number => typeof s === 'number');
    learned[w.id] = spent.length >= SAMPLES;
    cost[w.id] = learned[w.id] ? Math.max(...spent.slice(-RECENT)) : defaultCost(key.kind, w);
  }
  return { cost, learned };
}
