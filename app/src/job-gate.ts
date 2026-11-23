// The usage gate, ported from `queue_runner/gate.py` (#263): a Claude job starts only when it fits
// (`docs/flow.md`, Limits). Sol isn't gated.
//
// - **The 5-hour window:** the job's expected cost must fit in what's left of it, or the Claude
//   lane waits for its reset. A window not yet started (nothing used) takes any job.
// - **The weekly reserve:** `reserve` percent of the week (5 unless Stefan changes it) stays
//   unspent until 24 hours before the weekly reset; inside those 24 hours the queue may spend it.
//   A job that wouldn't fit the week even then waits for the weekly reset.
// - **Stefan's knob** is `<state_dir>/gate.json` (`reserve`), set with `--reserve N`; the runner
//   reads it before every Claude job, so it works while it runs. Stopping a lane isn't the gate's:
//   it's `control.json` (`control.py`).
// - **Expected cost** per job kind (build, fix, decision), in percent of each window, is learned
//   from `<state_dir>/usage.jsonl`: one record per Claude job pass, usage before and after. With
//   fewer than `SAMPLES` usable records it's the cautious `DEFAULTS`; then the largest of the last
//   `RECENT`. A pass that ran beside another Claude job (`shared_with`, #50) measured both, so it
//   teaches nothing.
// - **Jobs still running** (#50: each repo runs its own Claude job at once): a job starts only
//   when its expected cost fits after the expected cost of every Claude job still running
//   (`Running`), counted whole, whatever they have spent so far, so it errs high. One that would
//   fit alone but not beside them waits for one of them to end (`RUNNING`), not for a reset.
// - **The reading** (issue 66) is `CachedUsage`'s (`src/claude-usage.ts`), shared with the
//   snapshot: the endpoint is asked at most once every 5 minutes. A check decides only on a
//   reading taken after the last Claude job ended and no older than `STALE_AFTER`, even if the
//   latest call failed; with none, the lane waits until the endpoint may be asked again. The
//   after-job read waits for that too.
//
// Python's `Gate` takes a lock in `job_ended`, since both lanes may say a job ended at once from
// two threads. Here `job_ended` never awaits, so in Node's one thread no other caller can run
// inside it, and the lock has nothing to guard.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CachedUsage, type Clock, type Endpoint, local_minutes, STALE_AFTER, Usage, UsageError, type Window } from './claude-usage.ts';
import { type Json, float_repr, format_g, get, is_dict, py_float, truthy } from './python.ts';
import { wall_sleep } from './run.ts';
import { append_record, read_records, stamp } from './state.ts';

export const DEFAULT_RESERVE = 5.0;
const HOUR = 3_600_000;
const MINUTE = 60_000;
export const RESERVE_RELEASE = 24 * HOUR;   // before the weekly reset, the reserve is free
export const AFTER_RESET = 2 * MINUTE;      // wait this past a reset before reading again
export const SAME_WINDOW = 10 * MINUTE;     // two reads' resets this close: the same window
export const SAMPLES = 3;
export const RECENT = 5;
export const CLAUDE_KINDS = ['build', 'fix', 'decision'] as const;
// The Opus review while Sol is out of usage (issue #69) runs in the Sol lane, gated as `review`.
// It isn't one of the Claude lane's kinds: that lane's measurement counts only its own jobs.
export const FALLBACK_REVIEW = 'review';
export const GATED_KINDS = [...CLAUDE_KINDS, FALLBACK_REVIEW] as const;

// Gate verdicts: why a job starts or waits.
export const FITS = 'fits';
export const RELEASED = 'reserve-released';   // fits only because the last 24 hours release the reserve
export const FIVE_HOUR = 'five-hour';         // waits for the 5-hour reset
export const RESERVE = 'weekly-reserve';      // waits for the reserve's release, 24 hours before the weekly reset
export const WEEKLY = 'weekly-full';          // waits for the weekly reset
// No reading to decide on (none, from before the last job, or stale), or gate.json or usage.jsonl
// unreadable: nothing starts until the endpoint may be asked again, or the next pass.
export const UNREADABLE = 'unreadable';
export const RUNNING = 'running';             // fits alone, not beside the Claude jobs still running (#50)

export class Cost {
  readonly five_hour: number;   // percent of the 5-hour window
  readonly seven_day: number;   // percent of the week
  constructor(five_hour: number, seven_day: number) {
    [this.five_hour, this.seven_day] = [five_hour, seven_day];
    Object.freeze(this);
  }

  /** `cost + other`. */
  add(other: Cost): Cost {
    return new Cost(this.five_hour + other.five_hour, this.seven_day + other.seven_day);
  }

  /** `cost == other`. */
  equals(other: Cost): boolean {
    return this.five_hour === other.five_hour && this.seven_day === other.seven_day;
  }
}

// Cautious until learned: a build is a long Opus thread, a fix round shorter, a decision one call.
// An Opus review reads the diff and the code around it and may run the tests: about a decision's
// cost to start with (issue #76), until three real reviews are learned.
export const DEFAULTS: Readonly<Record<string, Cost>> = {
  build: new Cost(60, 15), fix: new Cost(40, 10), decision: new Cost(15, 4), [FALLBACK_REVIEW]: new Cost(15, 4),
};

/** The Claude jobs still running (#50), as the gate counts them: their expected cost, summed, and
 *  what each is (`build game-backdrop#5`), for the log. */
export class Running {
  readonly cost: Cost;
  readonly jobs: readonly string[];
  constructor(cost: Cost = new Cost(0, 0), jobs: readonly string[] = []) {
    [this.cost, this.jobs] = [cost, jobs];
    Object.freeze(this);
  }

  /** `bool(running)`: whether any job is running. */
  bool(): boolean {
    return this.jobs.length > 0;
  }

  plus(label: string, cost: Cost): Running {
    return new Running(this.cost.add(cost), [...this.jobs, label]);
  }

  text(): string {
    const n = this.jobs.length;
    const one = n === 1;
    return `${one ? 'the' : `the ${n}`} Claude job${one ? '' : 's'} running `
      + `(${this.jobs.join(', ')}) ${one ? 'is' : 'are'} expected to take `
      + `${_pct(this.cost.five_hour)} of 5 hours, ${_pct(this.cost.seven_day)} of the week`;
  }
}

export class Knob {
  readonly reserve: number;
  constructor(reserve: number = DEFAULT_RESERVE) {
    this.reserve = reserve;
    Object.freeze(this);
  }
}

export class Verdict {
  readonly go: boolean;
  readonly why: string;
  readonly text: string;          // what the log says
  readonly until: Date | null;    // when to look again (null: next pass)
  readonly usage: Usage | null;
  constructor(go: boolean, why: string, text: string, until: Date | null = null, usage: Usage | null = null) {
    [this.go, this.why, this.text, this.until, this.usage] = [go, why, text, until, usage];
    Object.freeze(this);
  }
}

const _local = local_minutes;

function _pct(x: number): string {
  return `${format_g(x)}%`;
}

const later = (t: Date, ms: number) => new Date(t.getTime() + ms);

/** Whether a `kind` job expected to take `cost` fits now, beside the Claude jobs `running`. One
 *  that doesn't fit alone waits as it always has (for a reset or the reserve's release); one that
 *  fits alone but not beside them waits for one of them to end. */
export function decide(usage: Usage, kind: string, cost: Cost, knob: Knob, now: Date, running: Running = new Running()): Verdict {
  const alone = _decide(usage, kind, cost, knob, now);
  if (!alone.go || !running.bool()) return alone;
  const together = _decide(usage, kind, cost.add(running.cost), knob, now, false);
  if (together.go) {
    return new Verdict(true, together.why, `${alone.text}; ${running.text()}, and it fits beside them`, null, usage);
  }
  return new Verdict(false, RUNNING, `${kind} would fit alone, but ${running.text()}: it waits for one of them to end`, null, usage);
}

/** `decide` for one job alone. With `any_in_new`, a window with nothing used takes any job;
 *  beside running jobs it doesn't (they are spending it already). */
function _decide(usage: Usage, kind: string, cost: Cost, knob: Knob, now: Date, any_in_new = true): Verdict {
  const wait = (why: string, text: string, until: Date | null = null) => new Verdict(false, why, text, until, usage);
  const five = usage.five_hour, week = usage.seven_day;
  const expect = `a ${kind} is expected to take ${_pct(cost.five_hour)} of 5 hours, `
    + `${_pct(cost.seven_day)} of the week`;
  let released = false;
  if ((week.used > 0 || !any_in_new) && week.used + cost.seven_day > 100) {
    const reset = week.resets_at && week.resets_at.getTime() > now.getTime() ? week.resets_at : null;
    const until = reset ? later(reset, AFTER_RESET) : null;
    return wait(WEEKLY, `the week is ${_pct(week.used)} used and ${expect}: waiting for the `
      + 'weekly reset' + (reset ? ` at ${_local(reset)}` : ''), until);
  }
  if ((week.used > 0 || !any_in_new) && week.used + cost.seven_day > 100 - knob.reserve) {
    const release = week.resets_at ? later(week.resets_at, -RESERVE_RELEASE) : null;
    if (release === null || now.getTime() < release.getTime()) {
      return wait(RESERVE, `the weekly reserve holds: the week is ${_pct(week.used)} used, `
        + `${expect}, and ${_pct(knob.reserve)} is kept for Stefan`
        + (release ? ` until ${_local(release)}` : ''), release);
    }
    released = true;
  }
  if ((five.used > 0 || !any_in_new) && five.used + cost.five_hour > 100) {
    const reset = five.resets_at && five.resets_at.getTime() > now.getTime() ? five.resets_at : null;
    return wait(FIVE_HOUR, `the 5-hour window is ${_pct(five.used)} used and ${expect}: `
      + 'waiting for its reset' + (reset ? ` at ${_local(reset)}` : ''),
    reset ? later(reset, AFTER_RESET) : null);
  }
  const state = `5 hours ${_pct(five.used)} used, the week ${_pct(week.used)}; ${expect}`;
  if (released) {
    return new Verdict(true, RELEASED, `${kind} fits (${state}); the weekly reserve is released `
      + 'in the last 24 hours before the weekly reset', null, usage);
  }
  return new Verdict(true, FITS, `${kind} fits (${state})`, null, usage);
}

// --- Stefan's knob ------------------------------------------------------------------------------

function _knob_path(state_dir: string): string {
  return join(state_dir, 'gate.json');
}

/** Python's `AttributeError`: `.get` on a value that isn't a dict. */
function no_get(x: Json): Error {
  const e = new Error(`'${x === null ? 'NoneType' : Array.isArray(x) ? 'list' : typeof x}' object has no attribute 'get'`);
  e.name = 'AttributeError';
  return e;
}

/** Throws as Python's does: a file error, JSON's `SyntaxError` (Python's `ValueError`), or
 *  `float()`'s `ValueError` or `TypeError` for a `reserve` that isn't a number. */
export function read_knob(state_dir: string): Knob {
  let raw: Json;
  try {
    raw = JSON.parse(utf8.decode(readFileSync(_knob_path(state_dir))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return new Knob();
    throw e;
  }
  if (!is_dict(raw)) throw no_get(raw);
  return new Knob(py_float(Object.hasOwn(raw, 'reserve') ? raw.reserve : DEFAULT_RESERVE));
}

// A file opened as `utf-8` keeps a BOM, and `json.load` refuses it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Written whole and swapped in, so a runner reading it never sees half a file. */
export function write_knob(state_dir: string, knob: Knob): void {
  mkdirSync(state_dir, { recursive: true });
  const path = _knob_path(state_dir);
  const fd = openSync(`${path}.tmp`, 'w');
  try {
    writeSync(fd, `{"reserve": ${json_float(knob.reserve)}}`);   // `json.dump`'s spacing
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${path}.tmp`, path);
}

/** `json.dumps` of a float: `5.0`, not `5`. */
function json_float(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity';
  return float_repr(x);
}

/** Whether a caught error is one Python's `except (OSError, ValueError)` takes: a file error, or
 *  JSON's (`SyntaxError`), UTF-8's (`ERR_ENCODING_INVALID_ENCODED_DATA`) or `float()`'s
 *  `ValueError`. */
export function os_or_value_error(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  return e instanceof SyntaxError || e.name === 'ValueError' || typeof (e as NodeJS.ErrnoException).code === 'string';
}

// --- learned costs ------------------------------------------------------------------------------

/** What a job used of one window: null if the window reset while it ran. */
function _spent(before: Window, after: Window): number | null {
  if (before.resets_at === null || before.used === 0) return after.used;   // no window yet: one started during the job
  if (after.resets_at === null || Math.abs(after.resets_at.getTime() - before.resets_at.getTime()) > SAME_WINDOW) return null;
  return Math.max(0.0, after.used - before.used);
}

/** `max(xs)` of numbers. */
const max = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a));

export class CostBook {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  static default(kind: string): Cost {
    if (!Object.hasOwn(DEFAULTS, kind)) throw new Error(`KeyError: '${kind}'`);
    return DEFAULTS[kind]!;
  }

  record(kind: string, jobs: readonly string[], before: Usage, after: Usage | null,
    error: string | null = null, shared_with: readonly string[] | null = null): void {
    const rec: Record<string, unknown> = {
      at: stamp(new Date()), kind, jobs, before: before.record(), after: after ? after.record() : null,
    };
    if (shared_with && shared_with.length) rec.shared_with = shared_with;   // other Claude jobs ran meanwhile: their spending is in it too (#50)
    if (after) {
      rec.spent = { five_hour: _spent(before.five_hour, after.five_hour), seven_day: _spent(before.seven_day, after.seven_day) };
    }
    if (error) rec.error = error;
    append_record(this.path, rec);
  }

  _spent(kind: string, window: string): number[] {
    return read_records(this.path).filter((r) => is_dict(r as Json) || throw_(no_get(r as Json))).filter((r) => get(r, 'kind') === kind && truthy(get(r, 'spent')) && !truthy(get(r, 'shared_with'))
      && spent_get(r.spent, window) !== null).map((r) => (r.spent as Record<string, number>)[window]!);
  }

  /** Throws as `read_records` does if usage.jsonl has a bad line (other than a torn last one). */
  expected(kind: string): Cost {
    const def = CostBook.default(kind);
    const learned = (window: string, fallback: number) => {
      const got = this._spent(kind, window);
      return got.length >= SAMPLES ? max(got.slice(-RECENT)) : fallback;
    };
    return new Cost(learned('five_hour', def.five_hour), learned('seven_day', def.seven_day));
  }

  /** Whether `expected(kind)` is learned in both windows, not the cautious default. */
  learned(kind: string): boolean {
    return ['five_hour', 'seven_day'].every((w) => this._spent(kind, w).length >= SAMPLES);
  }
}

const throw_ = (e: Error): never => {
  throw e;
};

/** `r['spent'].get(window)`: `AttributeError` for a `spent` that isn't a dict. */
function spent_get(spent: unknown, window: string): unknown {
  if (!is_dict(spent as Json)) throw no_get(spent as Json);
  return get(spent as Record<string, Json>, window);
}

/** A Claude job still running, as `check` and `running` take it: (label, kind, then). */
export type RunningJob = readonly [label: string, kind: string, then: string | null];
export type Sleep = (seconds: number) => Promise<void>;

/** `check(kind)` before a Claude job; `measured(...)` after it. `reader` is the shared
 *  `CachedUsage` (an endpoint's reader is wrapped in one); `sleep` waits on the wall clock for the
 *  after-job read (`wall_sleep` unless given). */
export class Gate {
  readonly state_dir: string;
  readonly clock: Clock;
  readonly reader: CachedUsage<Usage>;
  sleep: Sleep | null;
  readonly book: CostBook;
  ended: Date | null = null;   // when the last measured Claude job ended
  private readonly _told = new Map<string, Date>();   // job_ended(job_id): each told once

  constructor(state_dir: string, reader: CachedUsage<Usage> | Endpoint<Usage>, clock: Clock | null = null, sleep: Sleep | null = null) {
    this.state_dir = state_dir;
    this.clock = clock ?? (() => new Date());
    this.reader = reader instanceof CachedUsage ? reader : new CachedUsage(reader, this.clock);
    this.sleep = sleep;
    this.book = new CostBook(join(state_dir, 'usage.jsonl'));
  }

  knob(): Knob {
    return read_knob(this.state_dir);
  }

  /** A `kind` job's expected cost, with the `then` job it may continue. Throws a file or JSON
   *  error when usage.jsonl can't be read. */
  cost(kind: string, then: string | null = null): Cost {
    const cost = this.book.expected(kind);
    return then ? cost.add(this.book.expected(then)) : cost;
  }

  /** The Claude jobs still running, as (label, kind, then) each, counted for `check`. Throws as
   *  `cost` does. */
  running(jobs: Iterable<RunningJob>): Running {
    let found = new Running();
    for (const [label, kind, then] of jobs) found = found.plus(label, this.cost(kind, then));
    return found;
  }

  /** Whether a `kind` job fits now. With `then`, the kind of job it may continue in the same pass
   *  (a decision's retry or answer), whose cost counts too. `running`: the Claude jobs still
   *  running, as (label, kind, then) each (#50), whose costs count first. */
  async check(kind: string, then: string | null = null, running: Iterable<RunningJob> = []): Promise<Verdict> {
    const label = then ? `${kind} (and the ${then} it may continue)` : kind;
    let knob: Knob;
    try {
      knob = this.knob();
    } catch (e) {
      if (!os_or_value_error(e)) throw e;
      return new Verdict(false, UNREADABLE, `gate.json is unreadable (${e.message}): no Claude job starts until it is fixed or removed`);
    }
    const [usage, wait] = await this.usage();
    if (usage === null) return wait!;
    let cost: Cost, others: Running;
    try {
      [cost, others] = [this.cost(kind, then), this.running(running)];
    } catch (e) {
      if (!os_or_value_error(e)) throw e;
      return new Verdict(false, UNREADABLE, `usage.jsonl is unreadable (${e.message}): no Claude job starts until it is fixed or removed`);
    }
    return decide(usage, label, cost, knob, this.clock(), others);
  }

  /** The reading a check decides on (the endpoint asked if the budget allows), or null and the
   *  wait: until the endpoint may be asked again, or the next pass when it may be now. */
  async usage(): Promise<[Usage, null] | [null, Verdict]> {
    try {
      await this.reader.read();
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;   // kept in the reading
    }
    const r = await this.reader.reading(), now = this.clock(), next_at = await this.reader.next_call_at();
    const then = next_at ? `until the next read at ${_local(next_at)}` : 'trying again next pass';
    const failed = r !== null && r.error ? ` (the latest read failed: ${r.error})` : '';
    let text: string;
    if (r === null || r.value === null) {
      text = `Claude usage is unreadable (${r ? r.error : 'not read yet'}): no Claude job starts, ${then}`;
    } else if (this.ended !== null && r.at!.getTime() < this.ended.getTime()) {
      text = `Claude usage was last read at ${_local(r.at!)}, before the last Claude job ended${failed}: no Claude job starts, ${then}`;
    } else if (now.getTime() - r.at!.getTime() > STALE_AFTER) {
      text = `Claude usage was last read at ${_local(r.at!)}, over ${format_g(STALE_AFTER / MINUTE)} minutes ago${failed}: `
        + `no Claude job starts, ${then}`;
    } else {
      return [r.value, null];
    }
    return [null, new Verdict(false, UNREADABLE, text, next_at)];
  }

  /** A Claude job's thread has ended (now): the next check decides only on a reading taken after
   *  it. `measured` says so itself; the runner says so for a thread that ended outside a measured
   *  pass (a dead runner's job settled, a decision whose retry never ran). With `job_id`, a job
   *  already told is told nothing again: both lanes may see a dead runner's Opus fallback review
   *  end (PR 67's review 2, F2), and a second telling would discard a reading taken since the
   *  first. Returns when this job's end counts from. */
  job_ended(job_id: string | null = null): Date {
    if (job_id !== null) {
      const told = this._told.get(job_id);
      if (told !== undefined) return told;
      this._told.set(job_id, this.clock());
      this.ended = this._told.get(job_id)!;
      return this.ended;
    }
    this.ended = this.clock();
    return this.ended;
  }

  /** How long the after-job read will wait for the endpoint's budget, in seconds. */
  after_wait(): Promise<number> {
    return this.reader.wait_seconds();
  }

  /** Records usage after a Claude job pass, against `before` (read by its check). `shared_with`:
   *  the other Claude jobs that ran meanwhile (#50), so it teaches nothing. The read after it
   *  waits for the endpoint's budget (a job under 5 minutes), since the next check waits for that
   *  reading anyway; a reading another caller took after the job ended serves too. A failed read
   *  is recorded with its error and no `after`. */
  async measured(kind: string, jobs: readonly string[], before: Usage, shared_with: readonly string[] | null = null): Promise<void> {
    // Its own end, not `this.ended`: the other lane may say a job ended while this one reads, and
    // this job's reading is still its own (PR 67's review 2, a nit).
    const ended = this.job_ended();
    const wait = await this.reader.wait_seconds();
    if (wait > 0) {
      if (this.sleep === null) this.sleep = (seconds) => wall_sleep(seconds);
      await this.sleep(wait);
    }
    try {
      await this.reader.read();
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
    }
    const r = await this.reader.reading();
    let after: Usage | null, error: string | null;
    if (r !== null && r.value !== null && r.at!.getTime() >= ended.getTime()) [after, error] = [r.value, null];
    else [after, error] = [null, r && r.error ? r.error : 'no reading after the job'];
    this.book.record(kind, jobs, before, after, error, shared_with);
  }
}
