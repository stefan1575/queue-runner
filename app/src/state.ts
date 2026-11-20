// The runner's own state, ported from `queue_runner/state.py` (#214): an append-only job log
// (`<state_dir>/jobs.jsonl`), one JSON object per line, so a restarted runner knows what ran and
// what's still open. The records are Python's, field for field (snake_case), so the app reads a
// copy of the Python runner's state folder and the Python runner reads the app's.
//
// Job kinds: `build` (an issue), `review` (Sol on a PR's head H), `fix` (a builder's fix round on a
// blocking PR, from H; `cause` `conflict` for a round that merges a conflicted PR's base in),
// `merge` (the runner merging a clean PR at H, or Stefan's merge noticed), `ready` (in a repo
// Stefan merges: the PR at H `marked` ready for him, or `unmarked`), `stop` (a stop filed for
// Stefan on a PR at H: `filed`, then `answered` once he closes its `needs-info` issue or replies
// on the PR or the issue; `failed` if the issue couldn't be filed, so the next pass files it) and
// `rerun` (one failed Actions run on a PR's head H re-run once before it's a stop; its start
// record has the run and the failed checks, so a runner cut off before asking GitHub is settled
// from the run: `rerun`, then `passed` once its re-run passed and that was said on the PR;
// `failed` if GitHub refused it; `not-started` if GitHub was never asked), `base` (the repo's
// base branch failing its checks, issue #98: `issue` null, `branch` the base; `filed` (or
// `failed`, its issue not filed: still red, filed next pass), then `closed` once the base passed)
// and `base-hold` (a PR held on H because the base fails the same checks: `held`, then
// `updated`, `update-failed` (GitHub refused: a conflict) or `moved`, or `own-failure` (a check
// the base doesn't fail failed on H too) or `cleared` (nothing fails on H any more)) and
// `decision` (a one-off decision thread, or Stefan's reply read directly, on a case the
// flow doesn't cover: `about` the job it decides on, its outcome the action taken) and `live` (a
// repo's live steps after merges: `sha` where the last live run reached, `head` the base's commit
// this one brings live).
//
// A build or fix started by a decision continues an earlier job's thread: its start record has
// `thread_id` (that thread) and `about` (the earlier job). A job that picks up an earlier one (a
// decision's retry or answer, a limit's recovery) also has `resume`: in place or fresh and why; a
// fresh one has no `thread_id`.
//
// Events: `start` (a job is about to start), `end` (how it ended; a later `end` for the same job
// replaces the earlier one, e.g. when a waiting thread later completes), `release` (Stefan
// handled a held issue, so the picker may take it again) and `sol-back` (a usage reading taken
// after Sol's out-of-usage review `job`, with every window under full, ended that review's wait
// before the `resume_at` it recorded: issue #130; `read_at` and `windows` are that reading).
//
// Python takes a lock per file because two lanes write the log from one process on two threads.
// Every read and write here is synchronous, so in Node's one thread none can interleave with
// another, and the lock has nothing to guard.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// An ended build job holds its issue, so a failed or waiting run never loops, unless it never got
// a thread to begin with.
export const NOT_STARTED = 'not-started';
// A decision's message that never reached the earlier job's thread: the new job counts for
// nothing, and the earlier one stands (its issue stays held).
export const NOT_SENT = 'not-sent';

// A review job's outcomes. These four mean Sol reviewed the head: it isn't reviewed again.
export const REVIEWED: ReadonlySet<string> = new Set(['clean', 'blocking', 'stop', 'approach-note']);
// Not a review: `failed` (no readable ledger, Sol's run failed, or the runner failed around it),
// `out-of-usage` (the Sol lane waits until resume_at) and `head-moved` (a push between listing
// the PR and fetching it).
export const FAILED_REVIEW = 'failed';
export const OUT_OF_USAGE = 'out-of-usage';
// A build or fix whose thread stopped on a usage limit: it waits until `resume_at`, then a
// later job of its kind (`about` it) continues the thread or starts afresh.
export const USAGE_LIMIT = 'usage-limit';
// A fresh restart after a limit whose brief or branch couldn't be made: the limited job stays the
// PR's writer, and the runner doesn't try again, until a release.
export const RESTART_FAILED = 'restart-failed';

/** One record of a `.jsonl` file: a JSON object. */
export type JsonRecord = Record<string, unknown>;

/** Appends one JSON record to a `.jsonl` file and syncs it to disk. A final record torn by a
 *  crash (no newline yet) is cut off first. */
export function append_record(path: string, record: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  // Read and write, made if missing: Windows refuses to truncate a file opened to append.
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT);
  try {
    const data = Buffer.alloc(fstatSync(fd).size);
    readSync(fd, data, 0, data.length, 0);
    let size = data.length;
    if (size && data[size - 1] !== 0x0a) {
      size = data.lastIndexOf(0x0a) + 1;
      ftruncateSync(fd, size);
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    writeSync(fd, line, 0, line.length, size);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The records of a `.jsonl` file written by `append_record`; a bad line other than a torn last
 *  one is an error (JSON's `SyntaxError`, or a `TypeError` for bytes that aren't UTF-8). */
export function read_records(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  const data = readFileSync(path);
  // Every complete record ends in a newline; what follows the last one was torn by a crash (maybe
  // inside a multibyte character), so it's cut off before decoding.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, data.lastIndexOf(0x0a) + 1));
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonRecord);
}

/** A stamp from the job log as a time. A stamp written without an offset (the Sol lane's
 *  `resume_at` before 2026-11-16) is this PC's local time, as JavaScript reads a date-time with
 *  none. */
export function when(stamp: string): Date {
  const t = new Date(stamp);
  if (Number.isNaN(t.getTime())) throw new RangeError(`Invalid isoformat string: '${stamp}'`);
  return t;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A time as Python's `datetime.now().astimezone().isoformat(timespec='seconds')` writes it:
 *  local time, to the second, with this PC's offset (`2026-11-21T10:00:00+08:00`). */
export function stamp(t: Date): string {
  const off = -t.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Python's truthiness, for the start record's optional fields: written only when set. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** A record's field that Python reads as `e[key]`: missing, it's an error. */
function need(e: JsonRecord, key: string): unknown {
  if (!(key in e)) throw new Error(`KeyError: '${key}'`);
  return e[key];
}

/** `e.get(key)`: null when missing. */
const get = <T>(e: JsonRecord, key: string): T | null => (key in e ? (e[key] as T) : null);

export type JobFields = {
  id: string;
  kind: string;                  // build, review, fix, merge, stop or decision
  repo: string;                  // the repo's name in config.toml
  issue: number | null;          // the issue; for a review, fix or merge, the PR
  branch: string | null;
  title: string;                 // the T3 thread's title; finds the thread after a crash
  started_at: string;
  ended_at: string | null;
  thread_id: string | null;
  link: string | null;
  run_id: string | null;
  exit_code: number | null;      // t3's: 0 done, 1 failed run, 2 waiting for an answer
  status: string | null;         // T3's run status
  outcome: string | null;        // done, done-no-pr, failed, waiting, branch-exists, not-started
  commits: unknown[];
  pr: Record<string, unknown> | null;
  worktree: string | null;
  error: string | null;
  sha: string | null;            // a review, fix or merge: H, the commit it starts from
  round: number | null;          // a review: its number on the PR
  verdict: string | null;        // a review: clean or blocking
  signals: unknown[];            // a review: the stop signals that fired
  run_dir: string | null;        // a review: its brief, inputs, reply and would-be comment
  resume_at: string | null;      // out-of-usage: when the Sol lane may run again
  head: string | null;           // a fix: the PR's head after it (H again if it pushed nothing)
  stop: string | null;           // a stop: its kind
  reason: string | null;         // a stop: why, as the issue and the toast say it
  answer: string | null;         // a stop: how Stefan answered (issue-closed, replied); a job his
                                 // GitHub reply continued: that reply's time
  about: string | null;          // a decision: the job it decides on; a continued job: the earlier
  question: string | null;       // a decision: which question
  context: number | null;        // usage-limit: the thread's context in tokens (null: unknown)
  last_request: string | null;   // usage-limit: when its last real request started
  applied: unknown[];            // live: the migrations its thread applied
  prs: unknown[];                // live: the PRs merged in its batch
  cause: string | null;          // a fix: `conflict` for a conflict round, else null
  resume: Record<string, unknown> | null;   // a job picking up an earlier one: in place or fresh, and why
  effort: string | null;         // a build or fix: the effort its run used, read back
  reviewer: string | null;       // a review: the fallback reviewer's name when it reviewed in Sol's place
  base: string | null;           // a conflict round: the sha of origin/<base> it merged (#91)
  runs: unknown[];               // a rerun: [{id, attempt, url}], each failed Actions run and the
                                 // attempt that failed (#93)
};

type Required_ = 'id' | 'kind' | 'repo' | 'issue' | 'branch' | 'title' | 'started_at';

const DEFAULTS: Omit<JobFields, Required_> = {
  ended_at: null, thread_id: null, link: null, run_id: null, exit_code: null, status: null,
  outcome: null, commits: [], pr: null, worktree: null, error: null, sha: null, round: null,
  verdict: null, signals: [], run_dir: null, resume_at: null, head: null, stop: null, reason: null,
  answer: null, about: null, question: null, context: null, last_request: null, applied: [],
  prs: [], cause: null, resume: null, effort: null, reviewer: null, base: null, runs: [],
};

export interface Job extends Readonly<JobFields> {}
/** A job as the log has it: frozen, changed only by making a new one (`replace`). */
export class Job {
  constructor(fields: Pick<JobFields, Required_> & Partial<JobFields>) {
    Object.assign(this, { ...DEFAULTS, commits: [], signals: [], applied: [], prs: [], runs: [] }, fields);
    Object.freeze(this);
  }

  get open(): boolean {
    return this.ended_at === null;
  }
}

/** `dataclasses.replace`: the job with these fields changed. */
const replace = (job: Job, changes: Partial<JobFields>) => new Job({ ...job, ...changes });

export const _END_FIELDS = ['thread_id', 'link', 'run_id', 'exit_code', 'status', 'outcome', 'commits', 'pr',
  'worktree', 'error', 'verdict', 'signals', 'run_dir', 'resume_at', 'head',
  'reason', 'answer', 'context', 'last_request', 'applied', 'prs', 'effort', 'runs'] as const;
/** An end record's fields besides `exit_code` and `outcome`, which `ended` takes on their own. */
export type EndFields = Partial<Pick<JobFields, Exclude<typeof _END_FIELDS[number], 'exit_code' | 'outcome'>>>;

export type StartFields = {
  kind: string; repo: string; issue: number | null; branch: string | null; title: string;
  sha?: string | null; round?: number | null; stop?: string | null; thread_id?: string | null;
  about?: string | null; question?: string | null; head?: string | null; cause?: string | null;
  resume?: Record<string, unknown> | null; reviewer?: string | null; base?: string | null;
  reason?: string | null; runs?: unknown[] | null;
};

type Fold = [Job[], Map<string, { repo: string; issue: number | null; on: boolean }>, Set<string>];
const heldKey = (repo: string, issue: unknown) => JSON.stringify([repo, issue]);

export class JobLog {
  path: string;
  /** The clock the log stamps its records with: a test passes its own. */
  private now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.path = path;
    this.now = now;
  }

  private _now(): string {
    return stamp(this.now());
  }

  /** A start record exists on disk before t3 runs. */
  private _append(record: JsonRecord): void {
    append_record(this.path, record);
  }

  private _events(): JsonRecord[] {
    return read_records(this.path);
  }

  started({ kind, repo, issue, branch, title, sha = null, round = null, stop = null, thread_id = null,
    about = null, question = null, head = null, cause = null, resume = null, reviewer = null,
    base = null, reason = null, runs = null }: StartFields): Job {
    const at = this._now();
    const stamp_ = at.slice(0, 19).replaceAll('-', '').replaceAll(':', '').replaceAll('T', '-');
    const job = new Job({
      id: `${stamp_}-${kind}-${repo}-${issue ?? 'None'}-${randomUUID().replaceAll('-', '').slice(0, 6)}`, kind,
      repo, issue, branch, title, started_at: at, sha, round, stop, thread_id, about, question,
      head, cause, resume, reviewer, base, reason, runs: [...(runs ?? [])],
    });
    const record: JsonRecord = { event: 'start', job: job.id, kind, repo, issue, branch, title, at };
    if (truthy(sha)) Object.assign(record, { sha, round });
    for (const [k, v] of [['stop', stop], ['thread_id', thread_id], ['about', about],
      ['question', question], ['head', head], ['cause', cause],
      ['resume', resume], ['reviewer', reviewer], ['base', base],
      ['reason', reason], ['runs', runs]] as const) {
      if (truthy(v)) record[k] = v;
    }
    this._append(record);
    return job;
  }

  ended(job_id: string, { exit_code, outcome, ...fields }: { exit_code: number | null; outcome: string } & EndFields): void {
    const unknown = Object.keys(fields).filter((k) => !(_END_FIELDS as readonly string[]).includes(k)).sort();
    if (unknown.length) throw new TypeError(`unknown job fields: ${JSON.stringify(unknown)}`);
    this._append({ event: 'end', job: job_id, at: this._now(), exit_code, outcome, ...fields });
  }

  released(repo: string, issue: number): void {
    this._append({ event: 'release', repo, issue, at: this._now() });
  }

  private _fold(): Fold {
    const jobs = new Map<string, Job>();
    const held: Fold[1] = new Map();
    const released = new Set<string>();   // jobs a release settled; a later build doesn't revive them
    for (const e of this._events()) {
      const kind = need(e, 'event');
      if (kind === 'start') {
        const job = new Job({
          id: need(e, 'job') as string, kind: need(e, 'kind') as string, repo: need(e, 'repo') as string,
          issue: need(e, 'issue') as number | null, branch: need(e, 'branch') as string | null,
          title: need(e, 'title') as string, started_at: need(e, 'at') as string,
          sha: get(e, 'sha'), round: get(e, 'round'), stop: get(e, 'stop'),
          thread_id: get(e, 'thread_id'), about: get(e, 'about'),
          question: get(e, 'question'), head: get(e, 'head'),
          cause: get(e, 'cause'), resume: get(e, 'resume'),
          reviewer: get(e, 'reviewer'), base: get(e, 'base'),
          reason: get(e, 'reason'), runs: truthy(e.runs) ? (e.runs as unknown[]) : [],
        });
        jobs.set(job.id, job);
        if (job.kind === 'build') held.set(heldKey(job.repo, job.issue), { repo: job.repo, issue: job.issue, on: true });
      } else if (kind === 'end' && jobs.has(need(e, 'job') as string)) {
        const changes: Record<string, unknown> = { ended_at: need(e, 'at') };
        for (const k of _END_FIELDS) if (k in e) changes[k] = e[k];
        const job = replace(jobs.get(e.job as string)!, changes as Partial<JobFields>);
        jobs.set(job.id, job);
        // A fresh build that never started holds nothing; one picking up an earlier build
        // (`about`) leaves the issue held, as that build holds it.
        if (job.kind === 'build' && job.outcome === NOT_STARTED && !job.about) {
          held.set(heldKey(job.repo, job.issue), { repo: job.repo, issue: job.issue, on: false });
        }
      } else if (kind === 'release') {
        const repo = need(e, 'repo') as string;
        const issue = need(e, 'issue') as number;
        held.set(heldKey(repo, issue), { repo, issue, on: false });
        for (const j of jobs.values()) if (j.repo === repo && j.issue === issue) released.add(j.id);
      }
    }
    return [[...jobs.values()], held, released];
  }

  jobs(): Job[] {
    return this._fold()[0];
  }

  /** The ids of the jobs a `--release` settled: each job on that issue or PR started before it.
   *  What reads the log's history to act on it, or to say where work stands, leaves them out. */
  released_ids(): Set<string> {
    return this._fold()[2];
  }

  /** Each `--release`, oldest first: [repo, issue or PR, when]. */
  releases(): [string, number, string][] {
    return this._events().filter((e) => e.event === 'release')
      .map((e) => [need(e, 'repo') as string, need(e, 'issue') as number, need(e, 'at') as string]);
  }

  open_jobs(): Job[] {
    return this.jobs().filter((j) => j.open);
  }

  waiting_jobs(): Job[] {
    const [jobs, , released] = this._fold();
    return jobs.filter((j) => j.outcome === 'waiting' && !released.has(j.id));
  }

  /** The review jobs on this PR's head H, oldest first, leaving out any a release settled. */
  reviews_of(repo: string, number: number, sha: string): Job[] {
    const [jobs, , released] = this._fold();
    return jobs.filter((j) => j.kind === 'review' && j.repo === repo && j.issue === number && j.sha === sha
      && !released.has(j.id));
  }

  /** The jobs of this kind on this issue or PR (and head H, if given), oldest first; with
   *  `released`, also those a release settled. */
  on(kind: string, repo: string, number: number | null, sha: string | null = null, released = false): Job[] {
    const [jobs, , gone] = this._fold();
    return jobs.filter((j) => j.kind === kind && j.repo === repo && j.issue === number
      && (sha === null || j.sha === sha) && (released || !gone.has(j.id)));
  }

  /** The runner's newest review that reviewed this head (clean, blocking, stop or approach-note).
   *  A release doesn't undo it: the review stands on GitHub. */
  runner_review(repo: string, number: number, sha: string): Job | null {
    const ran = this.on('review', repo, number, sha, true).filter((j) => j.outcome !== null && REVIEWED.has(j.outcome));
    return ran.at(-1) ?? null;
  }

  /** The jobs that wrote to a PR: builds on its branch and its fix rounds. */
  pr_jobs(repo: string, number: number, branch: string): Job[] {
    return this.jobs().filter((j) => j.repo === repo && (
      (j.kind === 'build' && j.branch === branch) || (j.kind === 'fix' && j.issue === number)));
  }

  /** The T3 threads the runner started for a PR, oldest first, each once (the settle at its
   *  merge): its build and fix threads, the decisions on it or on one of those jobs (a failed
   *  build's, before the PR existed), and its fallback reviews. Never an ask thread, which is
   *  settled once decided (a decision acted on from one carries its id), nor a live run's, which
   *  isn't the PR's. */
  pr_threads(repo: string, number: number, branch: string): string[] {
    const jobs = this.jobs();
    const writers = this.pr_jobs(repo, number, branch);
    const ids = new Set(writers.map((j) => j.id));
    const asks = new Set(jobs.filter((j) => j.kind === 'ask' && j.repo === repo).map((j) => j.thread_id));
    const mine = jobs.filter((j) => j.repo === repo && (
      ids.has(j.id)
      || (j.kind === 'decision' && (j.issue === number || (j.about !== null && ids.has(j.about))))
      || (j.kind === 'review' && j.issue === number)));
    const out: string[] = [];
    for (const j of mine) {
      if (j.thread_id && !asks.has(j.thread_id) && !out.includes(j.thread_id)) out.push(j.thread_id);
    }
    return out;
  }

  /** A build or fix that is writing to this branch, or may again: a build or fix still open,
   *  waiting for an answer, or cut off by a usage limit and not yet recovered (until it ends or is
   *  released). One writer per PR. */
  writer(repo: string, branch: string): Job | null {
    const [jobs, , gone] = this._fold();
    const limited = new Set(JobLog._limited(jobs, gone, true).map((j) => j.id));
    return jobs.find((j) => (j.kind === 'build' || j.kind === 'fix') && j.repo === repo
      && j.branch === branch && (j.open || limited.has(j.id) || (
        j.outcome === 'waiting' && !gone.has(j.id)))) ?? null;
  }

  /** Limited jobs not yet recovered: a recovery that never reached a thread (not-started,
   *  not-sent) doesn't count. One whose restart failed is left out, unless `stuck`. */
  private static _limited(jobs: Job[], gone: Set<string>, stuck = false): Job[] {
    const later = jobs.filter((j) => j.about && (j.kind === 'build' || j.kind === 'fix'));
    const recovered = new Set(later.filter((j) => ![NOT_STARTED, NOT_SENT, RESTART_FAILED].includes(j.outcome as string))
      .map((j) => j.about));
    const failed = new Set(later.filter((j) => j.outcome === RESTART_FAILED).map((j) => j.about));
    return jobs.filter((j) => j.outcome === USAGE_LIMIT && (j.kind === 'build' || j.kind === 'fix')
      && !gone.has(j.id)
      && !recovered.has(j.id) && (stuck || !failed.has(j.id)));
  }

  /** Builds and fixes cut off by a usage limit that no later job has picked up (and no release
   *  settled), oldest first. */
  limited_jobs(): Job[] {
    const [jobs, , gone] = this._fold();
    return JobLog._limited(jobs, gone);
  }

  /** The repo's live jobs, oldest first; without `released`, leaving out those a release settled
   *  (a release of the batch's newest PR). */
  live(repo: string, released = true): Job[] {
    const [jobs, , gone] = this._fold();
    return jobs.filter((j) => j.kind === 'live' && j.repo === repo && (released || !gone.has(j.id)));
  }

  /** Stops filed on this PR that Stefan hasn't answered (or released), oldest first: while
   *  there's one, the runner leaves the PR alone. */
  open_stops(repo: string, number: number): Job[] {
    return this.on('stop', repo, number).filter((j) => j.outcome === 'filed');
  }

  /** A stop of this kind was filed on this head already (answered or released or not): it's
   *  never filed twice. */
  stopped(repo: string, number: number, sha: string, kind: string): boolean {
    return this.on('stop', repo, number, sha, true)
      .some((j) => j.stop === kind && (j.outcome === 'filed' || j.outcome === 'answered'));
  }

  /** The decision on this job, if one ran (or is running): a release doesn't undo it, so a case
   *  is decided once. One cut off before its thread (`not-started`) doesn't count. */
  decided(job_id: string): Job | null {
    const found = this.jobs().filter((j) => j.kind === 'decision' && j.about === job_id && j.outcome !== NOT_STARTED);
    return found.at(-1) ?? null;
  }

  /** Sol's newest ended review, if it found Sol out of usage and no `sol-back` record since says
   *  Sol's provider has usage again (issue #130). The fallback's reviews meanwhile (`reviewer`)
   *  aren't Sol's, so they don't end the wait (issue #69). */
  sol_out(): Job | null {
    const ended = this.jobs().filter((j) => j.kind === 'review' && !j.open && !j.reviewer);
    // Stamps are to the second: a tie goes to the one written later. (Python's `max` over the
    // list reversed: the first greatest, compared as strings.)
    let last: Job | null = null;
    for (const j of [...ended].reverse()) if (last === null || (j.ended_at as string) > (last.ended_at as string)) last = j;
    if (!last || last.outcome !== OUT_OF_USAGE) return null;
    // A sol-back record names the review whose wait it ended (PR 131's review 2, F6): no stamp is
    // compared, so a later out-of-usage review ending in the same second as the reading starts a
    // wait of its own.
    const id = last.id;
    if (this._events().some((e) => e.event === 'sol-back' && e.job === id)) return null;
    return last;
  }

  /** When Sol may review again, if it's out of usage now (`sol_out`). */
  sol_resume_at(): string | null {
    const out = this.sol_out();
    return out ? out.resume_at : null;
  }

  /** A usage reading at `read_at`, after Sol's out-of-usage review `job` ran out, shows usage
   *  again: that review's wait, which would have lasted until `resume_at`, ends now (issue
   *  #130). */
  sol_back({ job, read_at, windows, resume_at }: { job: string; read_at: string; windows: unknown[]; resume_at: string | null }): void {
    this._append({ event: 'sol-back', at: this._now(), job, read_at, windows, resume_at });
  }

  /** Issues the build picker must leave alone: a build is open on them, or ended without a
   *  release since (failed, waiting, done...). */
  held_issues(repo: string): Set<number | null> {
    return new Set([...this._fold()[1].values()].filter((h) => h.repo === repo && h.on).map((h) => h.issue));
  }
}
