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
// - **Out of usage:** a job that ended on its provider's usage limit holds that provider until the
//   reset T3 gave (and `AFTER_RESET_MS`), or `LIMIT_UNKNOWN_MS` with none, so the next job goes to
//   the fallback, even on a provider T3 reads no usage for (#155 F22). A reading T3 takes after
//   the hold began decides instead, and one with room ends it (a reset credit gives usage back
//   early, #155 F25); a provider T3 reads no usage for has no such reading. (After a restart the
//   run loop reads the limits the job log recorded itself, as Python's `Runner.choose` does.)
// - **Ended elsewhere:** a job's thread the gate didn't let in, seen to end (a stopped runner's
//   job settled, one the user answered in T3): the next check on its login decides on a reading
//   T3 takes after now, as after a job it let in (`job_ended`, Python's `gate.job_ended`).
// - **Running elsewhere:** the jobs a stopped runner left running are passed to `pick`, each
//   counted at its kind's model and expected cost (Python's `check(..., running=...)`).
// - **Whose login:** a job started before T3 has named its provider's login (a build watched again
//   on a cold start, before T3's first catalog) is given it once T3 does, so it counts against
//   that login whichever came first (#154 F10).
import type { CostLog } from './cost-log.ts';
import { expectedCost, reading, spentOf, type Cost, type Reading } from './costs.ts';
import { AFTER_RESET_MS, checkJob, LIMIT_UNKNOWN_MS, type GateJob, type Hold, type RunningJob, type Verdict } from './gate.ts';
import { kindModels, model, type JobKind, type ModelChoice } from './jobs.ts';
import type { Settings } from './settings.ts';
import type { CatalogSource } from './t3/catalog-source.ts';
import type { ProviderUsage } from './usage.ts';

export type Held = { hold: Hold; until: Date | null; since: Date };
/** A job running that the gate didn't let in (a stopped runner's): its id and kind. */
/** A job running that the gate didn't let in: `choice` the model it was launched on, when its
 *  record names one (else its kind's model now). */
export type Elsewhere = { id: string; kind: JobKind; choice?: ModelChoice | null };
/** Where a job runs, once the gate lets it in: its kind's model, or its fallback. */
export type Pick =
  | { fits: true; choice: ModelChoice; onFallback: boolean; cost: Cost }
  | { fits: false; until: Date | null; hold: Hold };

/** `account` is null until T3 names the login of the job's provider. */
type Running = Omit<RunningJob, 'account'> & { account: string | null; job: GateJob; before: Reading; started: Date; beside: Set<string> };
type Ended = Running & { ended: Date; recorded: () => void };

export class UsageGate {
  private source: CatalogSource;
  private settings: () => Settings;
  private log: CostLog;
  private now: () => Date;
  private running = new Map<string, Running>();
  private toMeasure: Ended[] = [];
  private lastEnd = new Map<string, Date>();
  /** Ends of jobs whose login T3 hadn't named yet, by provider: their login's `lastEnd` once it does. */
  private unplacedEnd = new Map<string, Date>();
  private held = new Map<string, Held>();
  /** Each provider a job ran out of usage on: since when (the job's end) and until when it's
   *  held, and the reset T3 gave. */
  private limited = new Map<string, { since: Date; until: Date; resetAt: string | null }>();
  private listeners = new Set<() => void>();
  /** The keys `job_ended` was told, so each counts once. */
  private told = new Set<string>();
  /** Each ended job waiting for its measurement: settled once its record is written. */
  private recording = new Map<string, Promise<void>>();


  constructor(source: CatalogSource, settings: () => Settings, log: CostLog, now = () => new Date()) {
    this.source = source;
    this.settings = settings;
    this.log = log;
    this.now = now;
    source.onChange(() => {
      this.placeJobs();
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

  /** Gives each running job T3 hadn't named the login of yet its login, now T3 has, and counts
   *  it beside the jobs already running there. */
  private placeJobs() {
    for (const [provider, at] of this.unplacedEnd) {
      const account = this.usage(provider)?.account;
      if (!account) continue;
      if (at > (this.lastEnd.get(account) ?? new Date(0))) this.lastEnd.set(account, at);
      this.unplacedEnd.delete(provider);
    }
    for (const r of this.running.values()) {
      if (r.account !== null) continue;
      const account = this.usage(r.job.choice.provider)?.account;
      if (!account) continue;
      for (const other of this.running.values()) {
        if (other === r || other.account !== account) continue;
        other.beside.add(r.id);
        r.beside.add(other.id);
      }
      r.account = account;
    }
  }

  /** Whether this job, on this model, fits now, beside the jobs running `elsewhere` too. */
  check(job: GateJob, elsewhere: readonly Elsewhere[] = []): Verdict {
    const u = this.usage(job.choice.provider);
    const limit = this.limited.get(job.choice.provider);
    // a reading taken since the hold began decides instead of it: one with room ends the hold
    const fresher = Boolean(limit && u?.windows.length && u.checkedAt && Date.parse(u.checkedAt) > limit.since.getTime());
    if (limit && this.now() < limit.until && !fresher) {
      return { fits: false, until: limit.until, hold: { why: 'limit', kind: job.kind, provider: u?.name ?? job.choice.provider, at: limit.resetAt } };
    }
    const v = this.checkReading(job, u, elsewhere);
    if (limit && (v.fits || this.now() >= limit.until)) this.limited.delete(job.choice.provider);
    return v;
  }

  private checkReading(job: GateJob, u: ProviderUsage | undefined, elsewhere: readonly Elsewhere[]): Verdict {
    this.placeJobs();
    const catalog = this.source.current().catalog;
    const m = catalog ? model(catalog, job.choice) : undefined;
    const running: RunningJob[] = [...this.running.values()].filter((r): r is Running & RunningJob => r.account !== null);
    return checkJob({
      job, usage: u, model: { id: job.choice.model, ...(m ? { label: m.label } : {}) },
      running: [...running, ...this.runningElsewhere(elsewhere)], shares: this.settings().shares, records: this.log.records(),
      now: this.now(), lastEnd: u ? this.lastEnd.get(u.account) ?? null : null,
    });
  }

  /** The jobs running elsewhere that the gate doesn't hold, each on the model it was launched on
   *  (else its kind's own model) at its expected cost there. One T3 hasn't named the login of yet
   *  counts nowhere. */
  private runningElsewhere(elsewhere: readonly Elsewhere[]): RunningJob[] {
    const catalog = this.source.current().catalog;
    if (!catalog) return [];
    const out: RunningJob[] = [];
    for (const e of elsewhere) {
      if (this.running.has(e.id)) continue;
      const choice = e.choice ?? kindModels(this.settings().jobs, e.kind, catalog).choice;
      const u = choice ? this.usage(choice.provider) : undefined;
      if (!choice || !u?.account) continue;
      out.push({ id: e.id, account: u.account, cost: expectedCost(this.log.records(), { ...choice, kind: e.kind }, u.windows).cost });
    }
    return out;
  }

  /** A job of this kind the gate didn't let in was seen to end now (a stopped runner's, one the
   *  user answered in T3): the next check on the login it ran on (`choice`, the model it was
   *  launched on; else its kind's model now) waits for a reading T3 takes after now. With `key`,
   *  only the first telling counts. */
  job_ended(kind: JobKind, key: string | null = null, launched: ModelChoice | null = null) {
    if (key !== null) {
      if (this.told.has(key)) return;
      this.told.add(key);
    }
    const catalog = this.source.current().catalog;
    const choice = launched ?? (catalog ? kindModels(this.settings().jobs, kind, catalog).choice : null);
    if (!choice) return;
    const at = this.now();
    const account = this.usage(choice.provider)?.account;
    if (account) {
      if (at > (this.lastEnd.get(account) ?? new Date(0))) this.lastEnd.set(account, at);
    } else this.unplacedEnd.set(choice.provider, at);
  }

  /** Where a job of this kind runs now: its own model when that fits, else its fallback when that
   *  fits, else held with its own model's reason, beside the jobs running `elsewhere` too. Held
   *  jobs are kept in `holds()`. */
  pick(id: string, kind: JobKind, elsewhere: readonly Elsewhere[] = []): Pick {
    const catalog = this.source.current().catalog;
    const models = catalog ? kindModels(this.settings().jobs, kind, catalog) : null;
    if (!models?.choice) {
      return this.hold(id, { fits: false, until: null, hold: { why: 'reading', provider: 'any provider', checkedAt: null, stale: 'none' } });
    }
    const own = this.check({ id, kind, choice: models.choice }, elsewhere);
    if (own.fits) return this.letIn(id, { fits: true, choice: models.choice, onFallback: false, cost: own.cost });
    if (models.fallback) {
      const fb = this.check({ id, kind, choice: models.fallback }, elsewhere);
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
    this.placeJobs();
    const account = this.usage(job.choice.provider)?.account ?? null;
    const r: Running = { id: job.id, account, cost, job, before, started: this.now(), beside: new Set() };
    // a login T3 hasn't named yet is one per provider: jobs on it are beside each other already
    for (const other of this.running.values()) {
      if (account !== null ? other.account !== account : other.account !== null || other.job.choice.provider !== job.choice.provider) continue;
      other.beside.add(job.id);
      r.beside.add(other.id);
    }
    this.held.delete(job.id);
    this.running.set(job.id, r);
  }

  /** The provider ran out of usage at `endedAt`, resetting at `resetAt` as T3 has it: held till then. */
  outOfUsage(provider: string, resetAt: string | null, endedAt: Date = this.now()) {
    const reset = resetAt ? Date.parse(resetAt) : NaN;
    const until = new Date(Number.isNaN(reset) ? endedAt.getTime() + LIMIT_UNKNOWN_MS : reset + AFTER_RESET_MS);
    const was = this.limited.get(provider);
    if (!was || until > was.until) this.limited.set(provider, { since: endedAt, until, resetAt: Number.isNaN(reset) ? null : resetAt });
  }

  /** The job's thread ended: it's measured on T3's next reading of its provider (`measured`).
   *  Ended on its usage limit (`limit`), its provider is held until the reset. */
  finished(id: string, limit?: { resetAt: string | null }) {
    const r = this.running.get(id);
    if (!r) return;
    if (limit) this.outOfUsage(r.job.choice.provider, limit.resetAt);
    this.placeJobs();
    this.running.delete(id);
    const at = this.now();
    if (r.account !== null) this.lastEnd.set(r.account, at);
    else this.unplacedEnd.set(r.job.choice.provider, at);
    let recorded = () => {};
    this.recording.set(id, new Promise<void>((resolve) => { recorded = resolve; }));
    this.toMeasure.push({ ...r, ended: at, recorded: () => { this.recording.delete(id); recorded(); } });
    void this.measure();
  }

  /** Settles once the ended job `id`'s record is written (at once for one not waiting to be
   *  measured), so the run loop's worker can wait for it, as Python's `gate.measured` records a
   *  job's usage before its worker ends. */
  measured(id: string): Promise<void> {
    return this.recording.get(id) ?? Promise.resolve();
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
        e.recorded();

      }
    });
    return this.measuring;
  }

  /** Settles once every measurement under way is written (the tests wait on it). */
  settled(): Promise<void> {
    return this.measuring;
  }
}
