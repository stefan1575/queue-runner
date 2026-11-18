// The usage gate's decision (#153; today's `gate.py` ported per provider, docs/usage.md): before
// any job, reviews included (#106), the job's expected cost must fit each window of the provider
// it runs on that counts its model, beside the jobs already running on that provider's login, and
// leave your share of a weekly window until its release. A held job has one reason, kept for the
// dashboard. Pure: `src/usage-gate.ts` feeds it T3's readings and keeps what's running. Shared
// with the renderer, so nothing here touches Node.
import { expectedCost, type Cost, type UsageRecord } from './costs.ts';
import type { JobKind, ModelChoice } from './jobs.ts';
import { heldPercent, releaseAt, shareOf, type Shares } from './shares.ts';
import { windowCounts, windowName, type ProviderUsage } from './usage.ts';

/** A reading older than this decides nothing. */
export const STALE_AFTER_MS = 30 * 60_000;
/** A job held to a reset waits this long past it, for T3's next reading. */
export const AFTER_RESET_MS = 2 * 60_000;

export type GateJob = { id: string; kind: JobKind; choice: ModelChoice };
/** A job running: its login (`ProviderUsage.account`) and its expected cost there, counted whole
 *  until it ends, whatever it has spent so far, so the gate errs high. */
export type RunningJob = { id: string; account: string; cost: Cost };

export type Hold =
  /** No room in a window: it waits for the reset. */
  | { why: 'window'; kind: JobKind; window: string; used: number; need: number; at: string | null }
  /** It fits only into your share: it waits for the release, at no known time when T3 gives no
   *  reset (the share then keeps, `heldPercent`). */
  | { why: 'share'; kind: JobKind; window: string; kept: number; need: number; at: string | null }
  /** It fits alone but not beside the jobs running there: it waits for one to end. */
  | { why: 'running'; kind: JobKind; window: string; running: number; need: number; jobs: string[] }
  /** No reading to decide on: it waits for T3's next one. */
  | { why: 'reading'; provider: string; checkedAt: string | null; stale: 'none' | 'before-end' | 'old' };

export type Verdict =
  | { fits: true; cost: Cost; ungated?: true }
  | { fits: false; until: Date | null; hold: Hold };

export type GateInput = {
  job: GateJob;
  /** The usage of the provider the job runs on; undefined when T3 doesn't list it as connected. */
  usage: ProviderUsage | undefined;
  /** The job's model as T3 names it, for windows that count some models only. */
  model: { id: string; label?: string };
  /** Every job running, on any provider: only those on the same login count. */
  running: RunningJob[];
  shares: Shares;
  records: UsageRecord[];
  now: Date;
  /** When the last job on this login ended, if one has since the app started. */
  lastEnd: Date | null;
};

const pct = (n: number) => `${Math.ceil(n)}%`;

export function checkJob(i: GateInput): Verdict {
  const { job, usage: u, now } = i;
  if (u && u.unavailable === 'unsupported') return { fits: true, cost: {}, ungated: true };
  const checked = u?.checkedAt ? new Date(u.checkedAt) : null;
  if (!u || !checked || !u.windows.length || (i.lastEnd && checked < i.lastEnd) || now.getTime() - checked.getTime() > STALE_AFTER_MS) {
    const stale = !checked || !u?.windows.length ? 'none' : i.lastEnd && checked < i.lastEnd ? 'before-end' : 'old';
    return { fits: false, until: null, hold: { why: 'reading', provider: u?.name ?? job.choice.provider, checkedAt: u?.checkedAt ?? null, stale } };
  }
  const windows = u.windows.filter((w) => windowCounts(w, i.model));
  const { cost } = expectedCost(i.records, { ...job.choice, kind: job.kind }, windows);
  const beside = i.running.filter((r) => r.account === u.account && r.id !== job.id);
  const holds: { until: Date | null; hold: Hold }[] = [];
  for (const w of windows) {
    const need = cost[w.id]!;
    const others = beside.reduce((sum, r) => sum + (r.cost[w.id] ?? 0), 0);
    const share = shareOf(i.shares, u.driver, w.id);
    const kept = w.kind === 'weekly' ? heldPercent(share, w, now) : 0;
    const used = w.usedPercent;
    const window = windowName(u.name, w);
    if ((used === 0 && others === 0) || used + others + need <= 100 - kept) continue;
    if (used + need <= 100 - kept) {
      holds.push({ until: null, hold: { why: 'running', kind: job.kind, window, running: others, need, jobs: beside.filter((r) => r.cost[w.id]).map((r) => r.id) } });
    } else if (kept > 0 && used + need <= 100) {
      const until = releaseAt(share, w.resetsAt);
      holds.push({ until, hold: { why: 'share', kind: job.kind, window, kept, need, at: until?.toISOString() ?? null } });
    } else {
      const until = w.resetsAt ? new Date(Date.parse(w.resetsAt) + AFTER_RESET_MS) : null;
      holds.push({ until, hold: { why: 'window', kind: job.kind, window, used, need, at: w.resetsAt } });
    }
  }
  if (!holds.length) return { fits: true, cost };
  // the one that holds longest: a wait with a time over one for a running job to end
  const timed = holds.filter((h) => h.until).sort((a, b) => b.until!.getTime() - a.until!.getTime());
  const h = timed[0] ?? holds[0]!;
  return { fits: false, until: h.until, hold: h.hold };
}

/** The hold as the log and the dashboard say it, with times written by `when`. */
export function holdText(h: Hold, when: (d: Date) => string): string {
  if (h.why === 'reading') {
    if (h.stale === 'none') return `T3 has no reading of ${h.provider}'s usage yet`;
    const at = when(new Date(h.checkedAt!));
    return h.stale === 'before-end'
      ? `T3 hasn't read ${h.provider}'s usage since the last job there ended (last read ${at})`
      : `T3 last read ${h.provider}'s usage at ${at}, over ${STALE_AFTER_MS / 60_000} minutes ago`;
  }
  const needs = `this ${h.kind} needs about ${pct(h.need)}`;
  if (h.why === 'window') return h.at ? `${h.window} resets at ${when(new Date(h.at))}; ${needs}` : `${h.window} is ${pct(h.used)} used; ${needs}`;
  if (h.why === 'share') return `${pct(h.kept)} of ${h.window} is kept for you${h.at ? ` until ${when(new Date(h.at))}` : ', and T3 gives no time it resets'}; ${needs}`;
  return `${h.window} would fit this ${h.kind} alone, but the jobs running there (${h.jobs.join(', ')}) are expected to take ${pct(h.running)}`;
}
