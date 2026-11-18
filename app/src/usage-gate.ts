// The usage gate as the runner holds it (#153): T3's readings of each provider's usage (kept current
// by `providerStatuses` events), the jobs running on each provider's login, and the records their
// costs are learned from. Every job asks it before it starts, reviews included; the lanes that
// start jobs are later tickets. `src/gate.ts` decides; this keeps the state around it.
//
// - **Which model:** a job runs on its kind's model, or on the kind's fallback while that one's
//   provider has no room (`pick`). Without a fallback, it waits.
// - **Held:** each held job keeps its one reason and since when (`holds`), for the dashboard,
//   until it's let in or forgotten.
// - **Measured:** a job's usage before (the reading it was let in on) and after (T3's first
//   reading taken after it ended) is appended to the cost log, with the other jobs that ran on
//   the same login meanwhile (then it teaches nothing).
import type { CostLog } from './cost-log.ts';
import { reading, spentOf, type Cost, type Reading } from './costs.ts';
import { checkJob, type GateJob, type Hold, type RunningJob, type Verdict } from './gate.ts';
import { kindModels, model, type JobKind, type ModelChoice } from './jobs.ts';
import type { Settings } from './settings.ts';
import type { CatalogSource } from './t3/catalog-source.ts';
import type { ProviderUsage } from './usage.ts';

export type Held = { hold: Hold; until: Date | null; since: Date };
/** Where a job runs, once the gate lets it in: its kind's model, or its fallback. */
export type Pick =
  | { fits: true; choice: ModelChoice; onFallback: boolean; cost: Cost }
  | { fits: false; until: Date | null; hold: Hold };

type Running = RunningJob & { job: GateJob; before: Reading; started: Date; beside: Set<string> };
type Ended = Running & { ended: Date };

export class UsageGate {
  private source: CatalogSource;
  private settings: () => Settings;
  private log: CostLog;
  private now: () => Date;
  private running = new Map<string, Running>();
  private toMeasure: Ended[] = [];
  private lastEnd = new Map<string, Date>();
  private held = new Map<string, Held>();
  private listeners = new Set<() => void>();

  constructor(source: CatalogSource, settings: () => Settings, log: CostLog, now = () => new Date()) {
    this.source = source;
    this.settings = settings;
    this.log = log;
    this.now = now;
    source.onChange(() => {
      void this.measure();
      for (const l of this.listeners) l();
    });
  }

  /** Called when T3's usage changes: a held job may fit now. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private usage(provider: string): ProviderUsage | undefined {
    return this.source.current().usage.find((u) => u.provider === provider);
  }

  /** Whether this job, on this model, fits now. */
  check(job: GateJob): Verdict {
    const u = this.usage(job.choice.provider);
    const catalog = this.source.current().catalog;
    const m = catalog ? model(catalog, job.choice) : undefined;
    return checkJob({
      job, usage: u, model: { id: job.choice.model, ...(m ? { label: m.label } : {}) },
      running: [...this.running.values()], shares: this.settings().shares, records: this.log.records(),
      now: this.now(), lastEnd: u ? this.lastEnd.get(u.account) ?? null : null,
    });
  }

  /** Where a job of this kind runs now: its own model when that fits, else its fallback when that
   *  fits, else held with its own model's reason. Held jobs are kept in `holds()`. */
  pick(id: string, kind: JobKind): Pick {
    const catalog = this.source.current().catalog;
    const models = catalog ? kindModels(this.settings().jobs, kind, catalog) : null;
    if (!models?.choice) {
      return this.hold(id, { fits: false, until: null, hold: { why: 'reading', provider: 'any provider', checkedAt: null, stale: 'none' } });
    }
    const own = this.check({ id, kind, choice: models.choice });
    if (own.fits) return this.letIn(id, { fits: true, choice: models.choice, onFallback: false, cost: own.cost });
    if (models.fallback) {
      const fb = this.check({ id, kind, choice: models.fallback });
      if (fb.fits) return this.letIn(id, { fits: true, choice: models.fallback, onFallback: true, cost: fb.cost });
    }
    return this.hold(id, own);
  }

  private letIn(id: string, p: Pick): Pick {
    this.held.delete(id);
    return p;
  }

  private hold(id: string, v: Extract<Verdict, { fits: false }>): Pick {
    const was = this.held.get(id);
    this.held.set(id, { hold: v.hold, until: v.until, since: was?.since ?? this.now() });
    return v;
  }

  /** Each held job's one reason, and since when it's been held. */
  holds(): ReadonlyMap<string, Held> {
    return this.held;
  }

  /** A held job that won't be asked about again (its PR closed, say). */
  forget(id: string) {
    this.held.delete(id);
  }

  /** T3's reading of this choice's provider now: the `before` a job let in now is measured from. */
  reading(choice: ModelChoice): Reading {
    const u = this.usage(choice.provider);
    return reading(u?.checkedAt ?? null, u?.windows ?? []);
  }

  /** The job started on `choice`, let in at `cost` on the reading `before` (T3's reading now
   *  unless given: a job watched again after a restart passes the one it was let in on, never one
   *  taken mid-run). It counts as running until `finished`. */
  started(job: GateJob, cost: Cost, before: Reading = this.reading(job.choice)) {
    const u = this.usage(job.choice.provider);
    const account = u?.account ?? `${job.choice.provider}:${job.choice.provider}`;
    const r: Running = { id: job.id, account, cost, job, before, started: this.now(), beside: new Set() };
    for (const other of this.running.values()) {
      if (other.account !== account) continue;
      other.beside.add(job.id);
      r.beside.add(other.id);
    }
    this.held.delete(job.id);
    this.running.set(job.id, r);
  }

  /** The job's thread ended: it's measured on T3's next reading of its provider. */
  finished(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    const at = this.now();
    this.lastEnd.set(r.account, at);
    this.toMeasure.push({ ...r, ended: at });
    void this.measure();
  }

  /** A job let in that never reached a thread (T3 refused it, a leftover branch): it stops
   *  counting and, having spent nothing, teaches nothing. */
  dropped(id: string) {
    if (!this.running.delete(id)) return;
    for (const other of this.running.values()) other.beside.delete(id);
  }

  /** The jobs counted as running, by id. */
  runningJobs(): string[] {
    return [...this.running.keys()];
  }

  private measuring: Promise<void> = Promise.resolve();

  /** Each ended job whose provider T3 has read since it ended gets its record. */
  private measure(): Promise<void> {
    this.measuring = this.measuring.then(async () => {
      const ready = this.toMeasure.filter((e) => {
        const at = this.usage(e.job.choice.provider)?.checkedAt;
        return at !== null && at !== undefined && Date.parse(at) > e.ended.getTime();
      });
      this.toMeasure = this.toMeasure.filter((e) => !ready.includes(e));
      for (const e of ready) {
        const u = this.usage(e.job.choice.provider)!;
        const after = reading(u.checkedAt, u.windows);
        await this.log.append({
          ...e.job.choice, kind: e.job.kind, at: e.ended.toISOString(), job: e.id,
          before: e.before, after, spent: e.before.checkedAt ? spentOf(e.before, after) : null,
          ...(e.beside.size ? { sharedWith: [...e.beside] } : {}),
        });
      }
    });
    return this.measuring;
  }

  /** Settles once every measurement under way is written (the tests wait on it). */
  settled(): Promise<void> {
    return this.measuring;
  }
}
