// The run loop: two lanes side by side, one Claude job per working repo and one Sol job at a time.
// Ported from `queue_runner/run.py` (#219): the `Runner`, its names (snake_case, as Python has
// them), its passes, choices and log lines, with `tests/test_run.py`, `tests/test_side_by_side.py`,
// `tests/test_gating.py` and `tests/test_usage_budget.py` ported case for case in
// `test/run.test.ts`, `test/side-by-side.test.ts`, `test/gating.test.ts` and
// `test/usage-budget.test.ts`.
//
// The Claude lane settles what earlier passes left open, then chooses each working repo's job (#50:
// the repos run side by side, each in a worker of its own that waits on its T3 thread's run while
// its job runs): a decision on a case the flow doesn't cover, then a fix round on a PR the runner
// found blocking, before any new build, so open PRs finish first. The usage gate lets each in only
// when it fits beside the jobs still running, the repo whose work has waited longest first. The lane
// plans again whenever a job ends. The Sol lane reviews at most one PR a pass. A second runner
// process is kept out by a lock on `<state_dir>/runner.lock`.
//
// What changes with TypeScript: Python's threads are async tasks (a worker's `thread` is its
// `task`, `join` an await), and `threading.Event` is `Event` below. Python's locks guard state two
// threads share; in Node's one thread a section with no await in it can't interleave with another,
// so only `_gate_lock`, held across the gate's async checks, is kept, as `Lock`.
//
// The parts of Python's run loop that later tickets port (decisions, ask threads, answers on
// GitHub, thread titles, fix rounds, limit recovery, the switches, the effort read-back, reviews,
// the snapshot, wake tasks, serving itself) are called where Python calls them, through
// `src/later-parts.ts`, which answers "nothing to do" for each until its ticket ports it. A
// stand-in may do less than Python, never something Python wouldn't: where Python would start a
// part not ported yet (a decision, a limited job's recovery), the repo is held for the pass
// (`_hold`). The Runner's own methods that only those parts reach (`continue_job`, `recover`,
// `_restart`, `run_fix`, `finish_fix`) come with their tickets; `_limit` reads a limit stop from
// what the run said, as Python does with no `T3Store`, until #227 ports the store.
import { join as join_path } from 'node:path';
import type { Usage } from './claude-usage.ts';
import { build_brief } from './build-brief.ts';
import { type BuildJob, pick } from './build-picker.ts';
import { type Config, type Repo, set_stopped, stopped, working } from './config.ts';
import type { Comment, GhCli, PullRequest } from './github-seam.ts';
import type { GitCli } from './git-seam.ts';
import { CLAUDE_KINDS, FALLBACK_REVIEW, type Gate, type RunningJob } from './job-gate.ts';
import * as control from './later-parts.ts';
import {
  AskThreads, Decider, Effort, Fixer, GitHubAnswers, NoToaster, NoWaker, NotPorted, OPUS_KINDS, Prefixes,
  type Reviewer, Wait, gate_label, limit_stop, red_base, resume_at, resume_choice,
} from './later-parts.ts';
import { KeyError, err_str, py_repr, type_name } from './python.ts';
import { type Job, JobLog, NOT_SENT, NOT_STARTED, USAGE_LIMIT, when } from './state.ts';
import { type Message, T3Error, type T3, type Thread, find_job_thread, settle_quietly } from './t3-seam.ts';

// What a pass did: started (it started jobs), busy (a Claude job is still running from an earlier
// runner, so none was started where it runs, and nothing elsewhere), idle (nothing to start),
// gated (the usage gate held the chosen Claude jobs back: `Runner.gate_until` says when to look
// again).
export const STARTED = 'started', BUSY = 'busy', IDLE = 'idle', GATED = 'gated';
export const STOPPED = 'stopped';   // Stefan stopped the lane (`control.py`), or control.json is unreadable
export const RESTART = 'restart';   // run_forever's end when the runner's own code moved (`restart.py`)

export const WALL_STEP = 30;      // a long sleep looks at the wall clock this often (seconds)
export const T3_RETRY = 30;       // waiting for T3's server at logon: how often to look again (seconds)

export type Sleep = (seconds: number) => Promise<void>;

const real_sleep: Sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));
const real_time = () => Date.now() / 1000;

/** Sleeps until `seconds` of wall-clock time have passed, in steps of at most `step`, so a PC that
 *  slept and was woken for this time doesn't sleep on (Windows' timers may not count the time the
 *  PC was asleep). */
export async function wall_sleep(seconds: number, sleep: Sleep = real_sleep, clock: () => number = real_time,
  step: number = WALL_STEP): Promise<void> {
  const end = clock() + seconds;
  for (let left = end - clock(); left > 0; left = end - clock()) await sleep(Math.min(step, left));
}

export function job_title(repo: Repo, issue: number): string {
  return `Queue runner build: ${repo.name}#${issue}`;
}

/** What `--wait` would have exited with, for a thread whose run has ended. */
function _exit_code(thread: Thread): number {
  if (thread.status === 'waiting' || thread.pending_requests) return 2;
  return thread.status === 'completed' ? 0 : 1;
}

const _when = when;

const pad = (n: number) => String(n).padStart(2, '0');

/** `t.astimezone():%Y-%m-%d %H:%M`, in this machine's time zone. */
function local_minute(t: Date): string {
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** `t.isoformat(timespec='seconds')` of a time in UTC, as `Runner.now` gives it. */
function utc_seconds(t: Date): string {
  return `${t.toISOString().slice(0, 19)}+00:00`;
}

/** `t.astimezone():%H:%M:%S`. */
function local_second(t: Date): string {
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

/** `traceback.format_exc()`: the error with where it was thrown. */
export function format_exc(e: unknown): string {
  return e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
}

/** A key for a (repo, number) pair, where Python keys a dict by the tuple. */
const ref = (repo: string, n: number | null) => `${repo}#${n}`;

/** Python's `threading.Event`: set, cleared and waited on, with a timeout in seconds. */
export class Event {
  private flag = false;
  private waiters: (() => void)[] = [];

  is_set(): boolean {
    return this.flag;
  }

  set(): void {
    this.flag = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  clear(): void {
    this.flag = false;
  }

  /** True once set; false when `timeout` seconds pass first. */
  wait(timeout: number): Promise<boolean> {
    if (this.flag) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, timeout * 1000);
      this.waiters.push(wake);
    });
  }
}

/** Python's `threading.Lock` for async callers: each `hold` runs after the one before it ends. */
export class Lock {
  private tail: Promise<void> = Promise.resolve();

  async hold<R>(f: () => Promise<R> | R): Promise<R> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await before;
    try {
      return await f();
    } finally {
      release();
    }
  }
}

/** A repo's Claude job, chosen and not yet started: `kind` the gate's (null for a decision Stefan's
 *  own words answer, which starts no thread), `then` the kind of job a decision may continue in the
 *  same pass, `run` what runs it, `label` what the log calls it, and `usage` the gate's read when it
 *  let the job in (what its cost is measured against). */
export class Start {
  readonly repo: string;
  readonly kind: string | null;
  readonly then: string | null;
  readonly run: () => Promise<string>;
  readonly label: string;
  readonly usage: Usage | null;
  constructor(repo: string, kind: string | null, then: string | null, run: () => Promise<string>, label: string,
    usage: Usage | null = null) {
    [this.repo, this.kind, this.then, this.run, this.label, this.usage] = [repo, kind, then, run, label, usage];
    Object.freeze(this);
  }
}

/** A repo's Claude job running in its own task (#50): `did` what its run returned, and `shared` the
 *  other Claude jobs that ran beside it (so its usage teaches nothing). */
export class Worker {
  readonly start: Start;
  task: Promise<void> | null = null;
  did: string | null = null;
  readonly shared = new Set<string>();
  constructor(start: Start) {
    this.start = start;
  }
}

/** The GitHub calls the run loop and its builds make. */
export type GitHub = Pick<GhCli, 'ready_issues' | 'issue_state' | 'open_pulls' | 'branches' | 'issue_comments' | 'pull_for_branch'>;
/** The git calls the run loop and its builds make. */
export type Git = Pick<GitCli, 'fetch' | 'has_branch' | 'commits'>;
/** The usage gate's calls (`job-gate.ts`'s `Gate`). */
export type UsageGate = Pick<Gate, 'check' | 'after_wait' | 'measured' | 'job_ended'>;

export type RunnerOptions = {
  github: GitHub; t3: Pick<T3, 'start' | 'show' | 'list' | 'settle'>; git: Git;
  out: (s: string) => void; log_line: (line: string) => void;
  toaster?: NoToaster | null; gate?: UsageGate | null; now?: (() => Date) | null; waker?: NoWaker | null;
  effort?: Effort | null;
};

export class Runner {
  readonly config: Config;
  readonly github: GitHub;
  readonly t3: RunnerOptions['t3'];
  readonly git: Git;
  // restart.SelfUpdate (#237): the runner's own checkout, restarted on when its base moves
  // (continuous mode, and only when the runner serves its own repo). None until #237.
  readonly self_update: { due(): boolean; update(): string | null } | null = null;
  restart_sha: string | null = null;
  // wake.Waker: the Windows wake tasks for the times the lanes wait for (continuous mode)
  readonly waker: NoWaker;
  private readonly _wake_lock = new Lock();
  private _claude_waits: Date | null = null;   // gate_until as the last pass left it
  // effort.Effort (ticket 39): the provider, model and effort a job's thread names (#119), and
  // the effort its run used read back into its end record; none with no T3 files.
  readonly effort: Effort;
  readonly now: () => Date;
  readonly gate: UsageGate | null;   // job-gate.Gate; null starts every Claude job (tests, the live checks)
  gate_until: Date | null = null;
  // What the gate last said, per repo (null: the account's usage limit), so it's said once.
  private _last_gate = new Map<string | null, string>();
  // The Claude jobs running in this runner's workers, one per repo (#50), and an event set
  // whenever one ends, so the lane plans again; the jobs a dead runner left running (`settle`);
  // and in the run loop, when each repo whose job started no thread may be tried again.
  private readonly _workers = new Map<string, Worker>();
  private readonly _ended = new Event();
  private _busy = new Map<string, [string, string]>();
  // The jobs the gate let in this pass and not yet in a worker, and the Sol lane's Opus review
  // while it runs (label: the Claude jobs it ran beside), so each lane's gate counts the other's
  // Claude jobs (PR #74's review 1, F1). `_gate_lock` keeps one lane's check and its admission
  // together, so neither lets a job in unseen by the other.
  private _admitted: RunningJob[] = [];
  private readonly _reviews = new Map<string, Set<string>>();
  private readonly _gate_lock = new Lock();
  private _rests = false;
  private readonly _rest = new Map<string, Date>();
  // Each repo's wait as the last pass left it (a snapshot.Wait), for the Repositories card.
  repo_waits = new Map<string, Wait>();
  // A dead runner's Opus fallback review still running in T3: the Claude lane starts nothing
  // beside it until it ends (PR 67's review 2, F2; `_fallback_runs`).
  private _orphan_review = false;
  readonly out: (s: string) => void;
  readonly log_line: (line: string) => void;
  readonly jobs: JobLog;
  readonly repos: Map<string, Repo>;
  readonly toaster: NoToaster;
  // The Sol lane's reviewer (`review.Reviewer`, #222): Python builds one when it has Sol; the app
  // has none until #222, so its Sol lane's pass is IDLE.
  readonly reviewer: Reviewer | null = null;
  readonly fixer: Fixer;
  readonly decider: Decider;
  readonly asking: AskThreads;   // an ask decided in a T3 thread (ticket 35)
  readonly prefixes: Prefixes;   // "Decide: " and "Answer: " on threads that need him (71), and stale ones settled (#72)
  readonly answers: GitHubAnswers;   // a waiting thread's question answered on GitHub
  private readonly _last_why = new Map<string, string | null>();
  // For the dashboard's snapshot (`snapshot.py`, continuous mode, #230): the Claude lane's wait as
  // its last pass left it (a snapshot.Wait, or null), the titles of the issues and PRs the passes
  // started jobs on, and the publisher the loop writes it with (null: no snapshot).
  claude_wait: Wait | null = null;
  readonly titles: Map<string, string>;
  readonly publisher: { start(): void; stop(): void; publish(): void } | null = null;
  // What each lane last said about its switch (`control.py`), so it's said once.
  private readonly _said_switch = new Map<string, string | null>();
  private _said_unknown: string | null = null;   // control.json stops a repo not served (37)
  private readonly _said_red = new Map<string, string>();   // a repo's red base, said once per head (#98)
  private readonly _said_held = new Map<string, string>();   // a repo held for a part not ported yet (`_hold`)

  constructor(config: Config, { github, t3, git, out, log_line, toaster = null, gate = null, now = null, waker = null,
    effort = null }: RunnerOptions) {
    [this.config, this.github, this.t3, this.git] = [config, github, t3, git];
    this.waker = waker ?? new NoWaker();
    this.effort = effort ?? new Effort(config);
    this.now = now ?? (() => new Date());
    this.gate = gate;
    [this.out, this.log_line] = [out, log_line];
    this.jobs = new JobLog(join_path(config.state_dir, 'jobs.jsonl'));
    this.repos = new Map(config.repos.map((r) => [r.name, r]));
    if (this.effort.say === null) this.effort.say = (line) => this.say(line);
    this.toaster = toaster ?? new NoToaster();
    this.fixer = new Fixer();
    this.decider = new Decider(config, { github, jobs: this.jobs, say: (line) => this.say(line) });
    this.asking = new AskThreads();
    this.prefixes = new Prefixes();
    this.answers = new GitHubAnswers();
    this.titles = this.reviewer !== null ? this.reviewer.titles : new Map();
  }

  say(line: string): void {
    this.log_line(line);
    this.out(`${line}\n`);
  }

  // --- one pass -------------------------------------------------------------------------

  /** One pass of the Claude lane, waiting for the jobs it started (`--once`, the tests): STARTED if
   *  any of them ran a thread, IDLE if none did, or what `plan` said when it started none. */
  async run_pass(): Promise<string> {
    const [did, workers] = await this.dispatch();
    for (const w of workers) await w.task;
    if (workers.length) return workers.some((w) => w.did === STARTED) ? STARTED : IDLE;
    return did;
  }

  /** Plans, then starts each job `plan` let in, each in a worker of its own (#50): (what the pass
   *  did, the workers it started). It returns once they've started. */
  async dispatch(): Promise<[string, Worker[]]> {
    const starts = await this.plan();
    if (!Array.isArray(starts)) return [starts, []];
    return [STARTED, starts.map((s) => this._launch(s))];
  }

  /** Settles, then chooses each working repo's Claude job (a repo with one running gets none: one
   *  Claude job per repo, #50) and asks the gate whether each fits beside the jobs still running:
   *  the Starts it lets in, in the order they're let in, or BUSY, IDLE, GATED or STOPPED when none.
   *  Starts nothing itself. */
  async plan(): Promise<Start[] | string> {
    this.gate_until = null;   // a wait from an earlier pass is that pass's
    const busy = await this.settle();
    // Not a job: titles are kept right while a dead runner's job runs on, and while the lane is
    // stopped (issue #71).
    await this.prefixes.sync();
    this.take_stops();
    if (this._orphan_review) {   // a dead runner's Opus review runs on: nothing starts beside it
      [this.repo_waits, this.claude_wait] = [new Map(), null];
      return BUSY;
    }
    if (this.held('claude')) {
      [this.repo_waits, this.claude_wait] = [new Map(), null];
      return STOPPED;
    }
    await this.asking.read_answers();   // an ask thread's answer, before anything is chosen (35)
    await this.answers.read();   // a waiting thread's question answered on GitHub (71)
    await this.prefixes.sync();   // an answer just read takes its thread's prefix off (71)
    const taken = new Set([...busy.keys(), ...this._alive()]);
    const chosen = await this.choose(taken);
    if (!Array.isArray(chosen)) {
      this.repo_waits = new Map();
      this.claude_wait = chosen === GATED ? new Wait(this.gate_until, this._last_gate.get(null) || '') : null;
      return chosen === IDLE && busy.size ? BUSY : chosen;
    }
    const starts = await this._admit(chosen, busy);
    if (starts.length) return starts;
    return this.repo_waits.size ? GATED : busy.size ? BUSY : IDLE;
  }

  /** Each working repo's Claude job, but those in `skip` (one is running there): a list of Starts,
   *  the repo whose work has waited longest first (`_waited`), or IDLE when none has one, or GATED
   *  while a job a usage limit cut off may not resume yet (the limit is the whole account's:
   *  nothing starts in any repo). In each repo: a job a limit cut off, an ask thread Stefan asked
   *  for, a decision (none needs a thread when Stefan's own words answer it: `kind` null), a fix
   *  round, a build, in that order. */
  async choose(skip: ReadonlySet<string> = new Set()): Promise<Start[] | string> {
    const off = stopped(this.config);   // a stopped repo's limited job waits for its Resume (37)
    const limited = this.jobs.limited_jobs().filter((j) => !off.has(j.repo));
    const ahead = limited.filter((j) => j.resume_at && this.now().getTime() < _when(j.resume_at).getTime());
    if (ahead.length) {
      // Python's max: the first of the latest
      const old = ahead.reduce((a, j) => (_when(j.resume_at!).getTime() > _when(a.resume_at!).getTime() ? j : a));
      const at = _when(old.resume_at!);
      this.gate_until = at;
      const text = `${Runner._name(old)} was cut off by a usage limit; it resumes after ${local_minute(at)}`;
      if (text !== this._last_gate.get(null)) this.say(`Claude lane waits: ${text}`);
      this._last_gate = new Map([[null, text]]);
      return GATED;
    }
    this._last_gate.delete(null);
    const switch_ = control.read(this.config.state_dir);
    const found: Start[] = [];
    for (const repo of working(this.config)) {
      if (skip.has(repo.name) || this._resting(repo.name)) continue;
      const start = await this._choose_in(repo, limited, switch_);
      if (start !== null) found.push(start);
    }
    if (!found.length) {
      if (!skip.size) {
        this.say('Nothing to start: no PR needs a fix round, and no repo has an '
          + 'unblocked ready-for-agent issue that isn\'t already being built or '
          + 'held.');
      }
      this.gate_until = null;
      return IDLE;
    }
    const order = this.config.repos.map((r) => r.name);
    const keyed = found.map((s) => [this._waited(s.repo), order.indexOf(s.repo), s] as const);
    return keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , s]) => s);
  }

  /** This repo's Claude job now, as a Start, or null. */
  async _choose_in(repo: Repo, limited: readonly Job[], switch_: control.Switch): Promise<Start | null> {
    const [name, only] = [repo.name, [repo.name]];
    const mine = limited.filter((j) => j.repo === name);
    if (mine.length) {   // Python recovers it here: until #227 the repo is held instead
      const old = mine[0]!;
      this._hold(name, `${Runner._name(old)} was cut off by a usage limit and may resume: limit recovery is ported `
        + `in #227, so nothing else starts in ${name} meanwhile`);
      return null;
    }
    const ask = await this.asking.next(switch_, { only });   // Stefan's click (35)
    if (ask) return new Start(name, 'decision', null, () => this.asking.open(ask), `ask ${name}#${ask.number}`);
    let answered = await this.answers.next({ repos: only });   // Stefan's reply on GitHub (71)
    if (answered) {
      const [old, text, marks] = answered;
      return new Start(name, old.kind, null, () => this.continue_job(old, text, { marks }), Runner._name(old));
    }
    answered = await this.asking.reply({ repos: only });   // his answer in a fresh thread (72);
    // a GitHub reply read in the same pass goes first: answering there still counts
    if (answered) {
      const [old, text, marks] = answered;
      return new Start(name, old.kind, null, () => this.continue_job(old, text, { marks }), Runner._name(old));
    }
    const case_ = await this.decider.next_case({ repos: only });
    if (case_) {   // Python starts a decision here: until #226 the repo is held instead
      this._hold(name, `${case_.name}: decisions are ported in #226, so nothing else starts in ${name} meanwhile`);
      return null;
    }
    const fix = await this.next_fix(only);
    if (fix) return new Start(name, 'fix', null, () => this.run_fix(...fix), `fix ${name}#${fix[1].number}`);
    if (!repo.github) return null;   // no GitHub issues to pick from
    const red = red_base(this.jobs, name, repo.base);
    if (red) {   // no build from a red base (#98)
      const text = `${name}: no build starts while ${repo.base} fails its checks (${red.reason}; `
        + `${red.link || 'its issue is not filed yet'})`;
      if (this._said_red.get(name) !== text) {
        this._said_red.set(name, text);
        this.say(text);
      }
      return null;
    }
    this._said_red.delete(name);
    this._said_held.delete(name);
    const job = await pick(repo as Repo & { github: string }, this.github, this.jobs.held_issues(name) as Set<number>);
    if (job !== null) {
      return new Start(name, 'build', null, () => this.run_build(job as BuildJob & { repo: Repo }),
        `build ${name}#${job.issue.number}`);
    }
    return null;
  }

  /** A repo held for the pass because Python would start a part here that a later ticket ports (a
   *  stand-in may do less than Python, never something else): it starts nothing, and `text` is said
   *  once, and again when it changes. */
  _hold(name: string, text: string): void {
    if (this._said_held.get(name) !== text) {
      this._said_held.set(name, text);
      this.say(text);
    }
  }

  /** Since when the repo's work has waited for a Claude job: when its last one ended (one that never
   *  reached a thread aside), as a timestamp, or 0 (the longest) if it has had none. When the gate
   *  has room for one more job, the repo that has waited longest gets it, so neither starves (#50);
   *  config.toml's order breaks a tie. */
  _waited(repo: string): number {
    const ended = this.jobs.jobs().filter((j) => j.repo === repo
      && (CLAUDE_KINDS as readonly string[]).includes(j.kind) && j.ended_at
      && j.outcome !== NOT_STARTED && j.outcome !== NOT_SENT).map((j) => j.ended_at!);
    return Math.max(0.0, ...ended.map((t) => _when(t).getTime() / 1000));
  }

  /** The usage gate before each chosen job, in order (`job-gate.ts`): a job starts only when its
   *  expected cost fits after the cost of every Claude job still running and every one let in
   *  before it this pass (#50). One that waits is said once per repo (until that changes) and
   *  doesn't hold back a later repo's job that fits. The Sol lane's Opus review counts among the
   *  jobs running, and holds off while this lane admits (`_gate_lock`). */
  _admit(chosen: readonly Start[], busy: ReadonlyMap<string, [string, string]>): Promise<Start[]> {
    return this._gate_lock.hold(() => {
      this._admitted = [];   // an earlier pass's are in their workers by now
      return this._admit_locked(chosen, busy);
    });
  }

  private async _admit_locked(chosen: readonly Start[], busy: ReadonlyMap<string, [string, string]>): Promise<Start[]> {
    let running = this._running(busy);
    const starts: Start[] = [];
    const waits = new Map<string, Wait>();
    for (const start of chosen) {
      if (start.kind === null || this.gate === null) {
        starts.push(start);
        continue;
      }
      const verdict = await this.gate.check(start.kind, start.then, running);
      if (!verdict.go) {
        waits.set(start.repo, new Wait(verdict.until, verdict.text));
        if (verdict.until && (this.gate_until === null || verdict.until.getTime() < this.gate_until.getTime())) {
          this.gate_until = verdict.until;
        }
        if (verdict.text !== this._last_gate.get(start.repo)) this.say(`Claude lane waits on ${start.repo}: ${verdict.text}`);
        this._last_gate.set(start.repo, verdict.text);
        continue;
      }
      this._last_gate.delete(start.repo);
      this.say(`Usage gate, ${start.repo}: ${verdict.text}`);
      running = [...running, [start.label, start.kind, start.then]];
      this._admitted.push([start.label, start.kind, start.then]);
      starts.push(new Start(start.repo, start.kind, start.then, start.run, start.label, verdict.usage));
    }
    this.repo_waits = waits;
    const first = waits.values().next().value ?? null;
    this.claude_wait = !starts.length ? first : null;
    return starts;
  }

  /** The Claude jobs still running, as the gate counts them: (label, kind, then) each, this runner's
   *  workers (and those let in and not yet started), the jobs a dead runner left running
   *  (`settle`), and the Sol lane's Opus review: the one it let in, or one open in the job log (a
   *  dead runner's, before the Sol lane settles it). */
  _running(busy: ReadonlyMap<string, [string, string]>): RunningJob[] {
    const jobs = this._claude_jobs(busy);
    const reviews = [...this._reviews.keys()];
    reviews.push(...this._open_reviews().filter((label) => !reviews.includes(label)));
    return [...jobs, ...reviews.map((label) => [label, FALLBACK_REVIEW, null] as const)];
  }

  /** The Claude lane's own jobs running, as (label, kind, then) each: its workers, those let in and
   *  not yet in one, and a dead runner's (`busy`). */
  _claude_jobs(busy: ReadonlyMap<string, [string, string]>): RunningJob[] {
    const mine: RunningJob[] = [...this._workers.values()].filter((w) => w.start.kind)
      .map((w) => [w.start.label, w.start.kind!, w.start.then] as const);
    const labels = new Set(mine.map((m) => m[0]));
    mine.push(...this._admitted.filter((a) => !labels.has(a[0])));
    return [...mine, ...[...busy.values()].filter(([, kind]) => (CLAUDE_KINDS as readonly string[]).includes(kind))
      .map(([label, kind]) => [label, kind, null] as const)];
  }

  /** The Opus reviews open in the job log, by label (`review <repo>#<PR>`). */
  _open_reviews(): string[] {
    return this.jobs.open_jobs().filter((j) => j.kind === 'review' && OPUS_KINDS.includes(j.reviewer ?? ''))
      .map((j) => gate_label(j.repo, j.issue));
  }

  // --- the Sol lane's Opus review, beside this lane's jobs (`fallback.OpusFallback`, #222) -----

  get gate_lock(): Lock {
    return this._gate_lock;
  }

  /** What an Opus review's gate counts: the Claude lane's jobs running now. */
  claude_jobs(): RunningJob[] {
    return this._claude_jobs(this._busy);
  }

  /** The Sol lane let an Opus review in: from now each lane's jobs count the other's spending
   *  (`shared_with`). */
  review_began(label: string): void {
    const shared = new Set([...this._workers.values()].map((w) => w.start.label));
    for (const [l] of this._busy.values()) shared.add(l);
    for (const w of this._workers.values()) w.shared.add(label);
    this._reviews.set(label, shared);
  }

  /** The Claude jobs that ran beside the Opus review `label` so far, sorted. */
  review_shared(label: string): string[] {
    return [...(this._reviews.get(label) ?? [])].sort();
  }

  review_ended(label: string): void {
    this._reviews.delete(label);
  }

  // --- workers: one Claude job per repo at once (#50) -------------------------------------

  /** The repos whose Claude job is running in one of this runner's workers. */
  _alive(): string[] {
    return [...this._workers.keys()];
  }

  /** In the run loop, a repo whose last job started no thread rests `poll_seconds` before it's tried
   *  again (as the one lane paused after such a pass), while the others go on. */
  _resting(repo: string): boolean {
    const until = this._rest.get(repo);
    return until !== undefined && this.now().getTime() < until.getTime();
  }

  _launch(start: Start): Worker {
    const w = new Worker(start);
    for (const label of this._open_reviews()) w.shared.add(label);   // an Opus review open in the job log
    for (const other of this._workers.values()) {   // each counts the other's spending
      other.shared.add(start.label);
      w.shared.add(other.start.label);
    }
    for (const [label] of this._busy.values()) w.shared.add(label);
    for (const [label, shared] of this._reviews) {   // and the Sol lane's Opus review's
      shared.add(start.label);
      w.shared.add(label);
    }
    this._admitted = this._admitted.filter((a) => a[0] !== start.label);
    this._workers.set(start.repo, w);
    w.task = this._work(w);
    return w;
  }

  /** A worker's task: runs its job, records what it cost (a pass that ran beside another Claude job
   *  teaches nothing: `shared_with`), and says it ended. */
  async _work(w: Worker): Promise<void> {
    const start = w.start;
    const since = this.jobs.jobs().length;
    try {
      w.did = await start.run();
    } catch (e) {
      this.log_line(`${start.label}: the job failed:\n${format_exc(e)}`);
      w.did = IDLE;
    }
    try {
      const fresh = this.jobs.jobs().slice(since)
        .filter((j) => (CLAUDE_KINDS as readonly string[]).includes(j.kind) && j.repo === start.repo);
      if (this.gate !== null && start.usage !== null && w.did === STARTED && fresh.length) {
        // A thread ran: what it cost teaches the next estimate (an ask's thread runs on with
        // Stefan, so it teaches nothing: ticket 35). A decision that continued a build or fix
        // counts as that job's cost, so a plain decision's stays a decision's.
        const learned = fresh.find((j) => j.kind !== 'decision')?.kind ?? start.kind!;
        const wait = await this.gate.after_wait();
        if (wait > 0) {   // one call every 5 minutes (issue 66)
          const at = new Date(this.now().getTime() + wait * 1000);
          this.say(`Reading Claude's usage after the job at ${local_second(at)} (${start.label}): the usage `
            + 'endpoint is asked at most once every 5 minutes');
        }
        const shared = [...w.shared].sort();
        await this.gate.measured(learned, fresh.map((j) => j.id), start.usage, shared.length ? shared : null);
      } else if (this.gate !== null && start.usage !== null
        && fresh.some((j) => j.thread_id && j.outcome !== NOT_SENT)) {
        // A thread ran though the pass started nothing (a decision whose retry never reached its
        // job): what it spent isn't learned, but no reading before it serves.
        this.gate.job_ended();
      }
    } catch (e) {
      this.log_line(`${start.label}: recording its usage failed:\n${format_exc(e)}`);
    } finally {
      if (this._workers.get(start.repo) === w) this._workers.delete(start.repo);
      if (this._rests && w.did !== STARTED) {
        this._rest.set(start.repo, new Date(this.now().getTime() + this.config.poll_seconds * 1000));
      }
      this._ended.set();
    }
  }

  // --- the switch ----------------------------------------------------------------------

  /** A Claude job's thread was seen to end outside a measured pass (`settle`): the next check waits
   *  for a usage reading taken after now (PR 67's review 1, F1). With `key` (a run id), only the
   *  first telling counts. */
  _thread_ended(key: string | null = null): void {
    if (this.gate !== null) this.gate.job_ended(key);
  }

  /** Whether Stefan stopped `lane` (control.json, read now), or control.json is unreadable: then the
   *  lane starts nothing. Said once, and again when it changes. */
  held(lane: string): boolean {
    const switch_ = control.read(this.config.state_dir);
    let text: string | null;
    if (switch_.error !== null) text = control.unreadable_text(switch_);
    else if (switch_.stop(lane).stopped) text = control.stopped_text(lane);
    else text = null;
    const said = this._said_switch.get(lane) ?? null;
    if (text !== null && text !== said) this.say(text);
    else if (text === null && said !== null) this.say(`The ${control.NAMES[lane]} lane runs again: Stefan resumed it`);
    this._said_switch.set(lane, text);
    return text !== null;
  }

  /** The repos Stefan stopped (ticket 37), read now from control.json: from then on every part that
   *  chooses work goes through `working`, which leaves them out. Each lane calls it at the start of
   *  its pass, so a job already running goes on. Each change is said once, and a name that isn't
   *  served once. */
  take_stops(): void {
    const switch_ = control.read(this.config.state_dir);
    if (switch_.error !== null) return;   // nothing starts until it's fixed: `held` says so
    this._take_repo_stops(switch_);
  }

  private _take_repo_stops(switch_: control.Switch): void {
    const [names, unknown] = control.stopped_repos(this.config.repos, switch_);
    const was = stopped(this.config);
    for (const name of names) if (!was.has(name)) this.say(control.repo_stopped_text(name));
    for (const name of [...was].filter((n) => !names.includes(n)).sort()) this.say(control.repo_resumed_text(name));
    set_stopped(this.config, names);
    const text = unknown.length ? control.unknown_repos_text(unknown) : null;
    if (text !== null && text !== this._said_unknown) this.say(text);
    this._said_unknown = text;
  }

  /** The pause after a pass that started nothing, or while jobs run: `poll_seconds`, or less when
   *  the gate opens sooner (pause, resume and the reserve are read again each pass). */
  idle_seconds(): number {
    const poll = this.config.poll_seconds;
    if (this.gate_until === null) return poll;
    const left = (this.gate_until.getTime() - this.now().getTime()) / 1000;
    return left >= 1 ? Math.min(poll, left) : poll;
  }

  /** (repo, PR, its blocking review job) for the first PR that needs a fix round now (in `repos`'
   *  names, if given: #50); the review is null for a conflict round. */
  async next_fix(repos: readonly string[] | null = null): Promise<[Repo, PullRequest, Job | null] | null> {
    for (const repo of working(this.config)) {
      if (!repo.github || (repos !== null && !repos.includes(repo.name))) continue;
      let found: [PullRequest, Job | null, string | null][];
      try {
        found = [];
        for await (const c of this.fixer.candidates(repo)) found.push(c);
      } catch (e) {   // GitHub down on PRs: a build may still be picked
        this.say(`fix rounds on ${repo.name}: reading PRs failed (${type_name(e)}: ${err_str(e)})`);
        continue;
      }
      for (const [pr, review, why] of found) {
        const key = ref(repo.name, pr.number);
        if (why && this._last_why.get(key) !== why) this.say(`fix ${repo.name}#${pr.number}: not now, ${why}`);
        this._last_why.set(key, why);
        if (why === null) return [repo, pr, review];
      }
    }
    return null;
  }

  /** Records how jobs left open by a dead runner, or left waiting for an answer, ended. The repos
   *  where one of their threads is still running: {repo: (label, kind)}, each of which gets no other
   *  Claude job (one per repo, #50) and whose cost the gate counts. A repo with a job running in one
   *  of this runner's own workers is left alone: that job is its worker's to record. */
  async settle(): Promise<Map<string, [string, string]>> {
    const busy = new Map<string, [string, string]>();
    this._orphan_review = false;
    const mine = new Set(this._alive());
    for (const job of this.jobs.open_jobs()) {
      if (job.kind === 'review' && OPUS_KINDS.includes(job.reviewer ?? '')) {   // the Sol lane's, not a repo's
        if (await this._fallback_runs(job)) this._orphan_review = true;
        continue;
      }
      if (mine.has(job.repo)) continue;
      if (job.kind === 'decision') {   // cut off with its runner: decided again
        this.jobs.ended(job.id, { exit_code: null, outcome: NOT_STARTED, error: 'The runner stopped mid-decision.' });
        this.say(`${Runner._name(job)}: cut off with its runner; decided again`);
        continue;
      }
      if (job.kind !== 'build' && job.kind !== 'fix') continue;   // an open review or merge is the Sol lane's to settle
      const thread = await this._find_thread(job);
      if (thread === null) {
        this.jobs.ended(job.id, { exit_code: null, outcome: NOT_STARTED, error: 'No T3 thread was found for this job.' });
        this.say(`${Runner._name(job)}: no thread was started; closed as not-started`);
        this._uncontinue(job);
      } else if (thread.active && !thread.pending_requests) {
        this.say(`${Runner._name(job)} is still running in ${thread.link}: no other Claude job starts in ${job.repo}`);
        busy.set(job.repo, [Runner._name(job), job.kind]);
      } else {
        await this.finish(job, thread.thread_id, _exit_code(thread), thread.status, null, thread.latest_run_id);
        this._thread_ended();
      }
    }
    for (const job of this.jobs.waiting_jobs()) {
      if (mine.has(job.repo)) continue;
      let thread: Thread;
      try {
        [thread] = await this.t3.show(job.thread_id!);
      } catch (e) {
        if (!(e instanceof T3Error)) throw e;
        // Stefan may have answered it and set it running: start nothing until T3 says.
        this.say(`${Runner._name(job)}: cannot read ${job.thread_id} (${e.message}); no other Claude job starts in ${job.repo}`);
        busy.set(job.repo, [Runner._name(job), job.kind]);
        continue;
      }
      if (thread.active && !thread.pending_requests) {
        busy.set(job.repo, [Runner._name(job), job.kind]);   // answered, and running again
      } else if (_exit_code(thread) === 2) {
        // A run newer than the one that asked ran on Stefan's answer and asks again, seen running
        // or not (#85): the gate is told once, keyed on that run.
        if (thread.latest_run_id && thread.latest_run_id !== job.run_id) this._thread_ended(thread.latest_run_id);
      } else {
        await this.finish(job, thread.thread_id, _exit_code(thread), thread.status, null, thread.latest_run_id);
        this._thread_ended();   // Stefan's answer set it running again, and it ended
      }
    }
    this._busy = busy;
    return busy;
  }

  /** A dead runner's Opus fallback review, left open while its thread runs on (PR 67's review 2,
   *  F2): true while that thread runs (or T3 can't say), so no Claude job starts beside it; once it
   *  has ended the gate is told, once per job, and the Sol lane counts the review failed. The Sol
   *  lane's own review now isn't a dead runner's: it runs beside the Claude lane (docs/reviews.md,
   *  The Opus fallback). */
  async _fallback_runs(job: Job): Promise<boolean> {
    if (this.reviewer !== null && job.id === this.reviewer.live) return false;
    let thread: Thread | null;
    try {
      thread = await this._find_thread(job);
    } catch (e) {
      if (!(e instanceof T3Error)) throw e;
      this.say(`review ${job.repo}#${job.issue} (Opus fallback): cannot read its thread (${e.message}); no other Claude job starts`);
      return true;
    }
    if (thread === null) return false;   // it never started a thread: the Sol lane counts it failed
    if (thread.active && !thread.pending_requests) {
      this.say(`review ${job.repo}#${job.issue} (Opus fallback, a stopped runner's) is still running in ${thread.link}: `
        + 'no other Claude job starts');
      return true;
    }
    if (this.gate !== null) this.gate.job_ended(job.id);
    return false;
  }

  /** The T3 thread of a job, by its id or else its title (the snapshot's link). */
  find_thread(job: Job): Promise<Thread | null> {
    return this._find_thread(job);
  }

  _find_thread(job: Job): Promise<Thread | null> {
    const repo = this.repos.get(job.repo);
    return find_job_thread(this.t3, job, repo ? repo.path : null);
  }

  // --- a build job ----------------------------------------------------------------------

  /** STARTED once a thread ran (or may still be running); IDLE if none was started, so the loop
   *  pauses before trying again. */
  async run_build(build: BuildJob & { readonly repo: Repo }): Promise<string> {
    const [repo, n] = [build.repo, build.issue.number];
    this.titles.set(ref(repo.name, n), build.issue.title);
    await this.git.fetch(repo.path, repo.base);
    const job = this.jobs.started({ kind: 'build', repo: repo.name, issue: n, branch: build.branch, title: job_title(repo, n) });
    if (await this.git.has_branch(repo.path, build.branch)) {
      this.jobs.ended(job.id, { exit_code: null, outcome: 'branch-exists', error: `A local branch ${build.branch} is left from an earlier run.` });
      this.say(`${Runner._name(job)} not started: local branch ${build.branch} already exists (held until released)`);
      return IDLE;
    }
    const comments: readonly Comment[] = await this.github.issue_comments(repo as Repo & { github: string }, n);
    const brief = build_brief(build, comments);
    const where = repo.github ? ` (${repo.github}#${n})` : '';
    this.say(`Starting ${Runner._name(job)}${where} on ${build.branch} from ${build.base}`);
    return this._start(job, repo, brief, build.base, build.branch);
  }

  /** Runs the job's thread in a new T3 worktree on `branch` from `base`, and records how it ended. */
  async _start(job: Job, repo: Repo, brief: string, base: string, branch: string): Promise<string> {
    let result;
    try {
      result = await this.t3.start(repo.path, brief, { title: job.title, worktree: base, branch, ...this.effort.job() });
    } catch (e) {
      if (!(e instanceof T3Error)) throw e;
      let thread: Thread | Job | null;
      try {
        thread = await this._find_thread(job);
      } catch (e2) {
        if (!(e2 instanceof T3Error)) throw e2;
        thread = job;   // T3 can't say: leave the job open for the next pass to settle
      }
      if (thread === null) {
        this.jobs.ended(job.id, { exit_code: null, outcome: NOT_STARTED, error: e.message });
        this.say(`${Runner._name(job)} not started: ${e.message}`);
        return IDLE;
      }
      this.say(`${Runner._name(job)}: lost track of its thread (${e.message}); the next pass settles it`);
      return STARTED;
    }
    await this.finish(job, result.thread_id, result.exit_code, result.status, result.error, result.run_id);
    return STARTED;
  }

  // --- what later tickets port ----------------------------------------------------------

  /** Picks up an earlier build or fix job (a decision's retry, the answer to its question, or a job
   *  cut off by a usage limit) as a new job of its kind. Ported with decisions (#226) and limit
   *  recovery (#227): until then nothing chooses a job it runs. */
  async continue_job(_old: Job, _message: string, _options: { limit?: boolean; marks?: Record<string, unknown> | null } = {}): Promise<string> {
    throw new NotPorted('Runner.continue_job', '#226 and #227');
  }

  /** A fresh Claude thread on a PR the runner found blocking, or a conflict round. Ported in #223. */
  async run_fix(_repo: Repo, _pr: PullRequest, _review: Job | null): Promise<string> {
    throw new NotPorted('Runner.run_fix', '#223');
  }

  /** Records a fix round. Ported in #223. */
  async finish_fix(_job: Job, _thread_id: string, _exit_code: number, _status: string, _error: string | null,
    _run_id: string | null): Promise<Job> {
    throw new NotPorted('Runner.finish_fix', '#223');
  }

  async finish(job: Job, thread_id: string, exit_code: number, status: string, error: string | null,
    run_id: string | null): Promise<Job> {
    if (job.kind === 'fix') return this.finish_fix(job, thread_id, exit_code, status, error, run_id);
    const repo = this.repos.get(job.repo);
    if (repo === undefined) throw new KeyError(py_repr(job.repo));
    let link: string | null = null, worktree: string | null = null;
    let said: Message[] = [];
    try {
      let thread: Thread;
      [thread, said] = await this.t3.show(thread_id);
      [link, worktree] = [thread.link, thread.worktree_path];
    } catch (e) {
      if (!(e instanceof T3Error)) throw e;
      error = error || `thread show failed: ${e.message}`;
    }
    const limit = this._limit(thread_id, run_id, exit_code, error, said);
    let commits: unknown[] = [];
    try {
      commits = await this.git.commits(repo.path, `origin/${repo.base}`, job.branch!);
    } catch (e) {   // the record matters more than its commit list
      error = error || `reading commits failed: ${err_str(e)}`;
    }
    let pr: Record<string, unknown> | null = null;
    if (repo.github) {   // a job may open its PR and fail or stop after
      try {
        pr = await this.github.pull_for_branch(repo as Repo & { github: string }, job.branch!);
      } catch (e) {
        error = error || `PR lookup failed: ${err_str(e)}`;
      }
    }
    let outcome: string;
    if (exit_code === 0) outcome = pr || !repo.github ? 'done' : 'done-no-pr';
    else outcome = exit_code === 2 ? 'waiting' : limit ? USAGE_LIMIT : 'failed';
    this.jobs.ended(job.id, {
      exit_code, outcome, thread_id, link, run_id, status, commits, pr, worktree, error, ...(limit ?? {}),
      ...this.effort.used(job.repo, Runner._name(job), thread_id, run_id),
    });
    const pr_note = pr ? `, PR #${pr.number}` : '';
    this.say(`${Runner._name(job)} ended: ${outcome} (exit ${exit_code}, ${commits.length} commits${pr_note}) ${link || thread_id}`);
    await this._settle_ended(job, thread_id, outcome);
    return job;
  }

  /** A build, fix or conflict thread is settled once its end is recorded (ticket 70), unless it
   *  waits for an answer: that one is Stefan's, or a decision's, to answer in the thread. One the
   *  runner picks up again in place is unsettled by T3 when its message lands, and settled again at
   *  its own end. */
  async _settle_ended(job: Job, thread_id: string, outcome: string): Promise<void> {
    if (outcome !== 'waiting') await settle_quietly(this.t3, thread_id, Runner._name(job), (line) => this.say(line));
  }

  /** For a failed run that stopped on a usage limit: the end record's `resume_at` and `context`
   *  (`limits.py`), said once in the log. Null for any other end. Read as Python reads it with no
   *  `T3Store` (`limits` None): from what the run said; #227 ports the store, which names the reset
   *  and the thread's last call. */
  _limit(thread_id: string, run_id: string | null, exit_code: number, error: string | null,
    said: readonly Message[]): Record<string, unknown> | null {
    if (exit_code !== 1) return null;
    // Only this run's own message: an earlier run's limit message may still be the last.
    const last = said.filter((m) => m.role === 'assistant' && (m.run_id === null || run_id === null || m.run_id === run_id))
      .map((m) => m.text).slice(-1);
    const stop = limit_stop([error, ...last]);
    if (stop === null) return null;
    const resume = resume_at(this.now(), stop.reset_at);
    const call = { started: null, tokens: null };   // lim.LastCall(None, None): no store
    const tokens = call.tokens;
    const known = stop.reset_at ? `T3 says it resets at ${local_minute(stop.reset_at)}` : "T3 doesn't say when it resets: 5h05m from now";
    // As it would be chosen then; the recovery chooses again when it runs.
    const then = resume_choice(call.started, tokens, resume);
    this.say(`${thread_id} stopped on a usage limit; ${known}. It resumes after ${local_minute(resume)} `
      + `(${then.in_place ? 'in place' : 'a fresh thread'}: ${then.why}).`);
    return { resume_at: utc_seconds(resume), context: tokens, last_request: null };
  }

  /** A job that picked up a waiting one (`about`) never reached a thread: the waiting job was marked
   *  `continued` before it, so it waits again as it did, and its case is decided again (as for a
   *  message that never reached its thread). */
  _uncontinue(job: Job): void {
    const old = job.about ? this.jobs.jobs().find((j) => j.id === job.about) ?? null : null;
    if (old !== null && old.outcome === 'continued') this.jobs.ended(old.id, { exit_code: old.exit_code, outcome: 'waiting' });
  }

  static _name(job: Job): string {
    return `${job.kind} ${job.repo}#${job.issue ?? 'None'}`;
  }

  // --- the loop ---------------------------------------------------------------------------

  async _sol_pass(): Promise<string> {
    try {
      if (this.reviewer === null) return IDLE;
      this.take_stops();
      if (this.held('sol')) return STOPPED;   // stopped: no stop filed, no merge, no review
      return await this.reviewer.review_pass();
    } catch (e) {
      this.log_line(`Sol pass failed:\n${format_exc(e)}`);
      return IDLE;
    } finally {
      this._read_inbox();
    }
  }

  /** The Inbox and the work for the snapshot, read from GitHub here in the Sol lane (never for the
   *  snapshot itself). Only while a snapshot is published, which the app does from #230. */
  _read_inbox(): void {
    if (this.publisher === null) return;
  }

  /** The times the lanes wait for now: the Claude lane's gate or limit, Sol's resume. A lane Stefan
   *  stopped waits for nothing (`control.py`), so it wakes no PC. */
  wake_times(): Date[] {
    const switch_ = control.read(this.config.state_dir);
    const times: (Date | null)[] = switch_.holds('claude') ? [] : [this._claude_waits];
    const resume = !switch_.holds('sol') ? this.jobs.sol_resume_at() : null;
    if (resume) times.push(_when(resume));
    return times.filter((t): t is Date => t !== null && t.getTime() > this.now().getTime());
  }

  async _wake(): Promise<void> {
    try {
      await this._wake_lock.hold(() => this.waker.sync(this.wake_times()));   // both lanes sync after their passes
    } catch (e) {
      this.log_line(`wake sync failed:\n${format_exc(e)}`);
    }
  }

  /** At logon T3 may not be up yet: look until its server answers (`thread list` on the first
   *  repo's project), saying once why it waits, and again only when that changes. */
  async wait_for_t3(sleep: Sleep): Promise<void> {
    let said: string | null = null;
    for (;;) {
      try {
        await this.t3.list(this.config.repos[0]!.path);
      } catch (e) {
        if (!(e instanceof T3Error)) throw e;
        if (e.message.includes('No T3 Code project matches')) {   // the server answered: it's up
          this.say(`T3's server is up, but: ${e.message}`);
          return;
        }
        if (e.message !== said) this.say(`Waiting for T3's server: ${e.message}`);
        said = e.message;
        await sleep(T3_RETRY);
        continue;
      }
      if (said !== null) this.say("T3's server is up");
      return;
    }
  }

  _publish(): void {
    if (this.publisher !== null) this.publisher.publish();   // never raises: a failed write is said once
  }

  async _sol_lane(stop: Event): Promise<void> {
    while (!stop.is_set()) {
      const did = await this._sol_pass();
      await this._wake();
      this._publish();
      if (did !== STARTED) {
        const end = real_time() + this.config.poll_seconds;
        for (let left = end - real_time(); !stop.is_set() && left > 0; left = end - real_time()) {
          await stop.wait(Math.min(WALL_STEP, left));
        }
      }
    }
  }

  /** One pass of each lane, side by side: at most one Claude job per working repo (#50) and one Sol
   *  review. The Claude lane chooses its jobs before the Sol lane starts, so what this pass's review
   *  decides waits for the next pass. */
  async run_once(): Promise<void> {
    const [, workers] = await this.dispatch();
    const sol = this._sol_pass();
    try {
      for (const w of workers) await w.task;
    } finally {
      await sol;
    }
  }

  _start_sol_lane(stop: Event): Promise<void> {
    return this._sol_lane(stop);
  }

  _update_due(): boolean {
    try {
      return this.self_update !== null && this.self_update.due();
    } catch (e) {
      this.log_line(`self-update check failed:\n${format_exc(e)}`);
      return false;
    }
  }

  /** While Claude jobs run in their workers: until one ends, or `idle_seconds` pass (the other repos'
   *  work is looked at again then), by the wall clock. */
  async _wait_for_a_job(): Promise<void> {
    const end = real_time() + this.idle_seconds();
    for (let left = end - real_time(); this._alive().length && !this._ended.is_set() && left > 0; left = end - real_time()) {
      await this._ended.wait(Math.min(WALL_STEP, left));
    }
  }

  /** The Claude lane here, starting each repo's job in a worker of its own (#50) and planning again
   *  whenever one ends; the Sol lane in a task that stops when this loop does. After each pass of
   *  either lane the wake tasks are set to the times they wait for. When the runner's own checkout
   *  is behind its base (`restart.py`, #237), the Claude lane starts nothing more; once the jobs
   *  running end, it lets the Sol lane finish its pass, updates the checkout and returns RESTART,
   *  with the new commit in `restart_sha`; if git won't update it, both lanes carry on. */
  async run_forever(sleep: Sleep): Promise<string> {
    let stop = new Event();
    this._rests = true;
    let draining = false;   // new code is due: no Claude job starts until the restart
    if (this.publisher !== null) this.publisher.start();
    let sol = this._start_sol_lane(stop);
    try {
      for (;;) {
        this._ended.clear();
        let did = IDLE;
        if (!draining) {
          try {
            [did] = await this.dispatch();
          } catch (e) {
            this.log_line(`pass failed:\n${format_exc(e)}`);
          }
          this._claude_waits = this.gate_until;
        }
        await this._wake();
        this._publish();
        if (!draining && this._update_due()) {
          draining = true;
          const running = this._alive();
          if (running.length) {
            this.say("The runner's own code moved: it starts no Claude job, and restarts on the new code once the jobs "
              + `running end (${running.join(', ')})`);
          }
        }
        if (draining && !this._alive().length) {
          this.say("The runner's own code moved: restarting on the new code once the Sol lane ends its pass");
          stop.set();
          await sol;
          const sha = this.self_update!.update();
          if (sha) {
            this.restart_sha = sha;
            return RESTART;
          }
          draining = false;
          stop = new Event();
          sol = this._start_sol_lane(stop);
        }
        if (this._alive().length) await this._wait_for_a_job();
        else if (did !== STARTED && !this._ended.is_set()) {
          // (a job that ended since this pass planned: plan again at once)
          await sleep(this.idle_seconds());
        }
      }
    } finally {
      stop.set();
      await join(sol, 5);
      if (this.publisher !== null) this.publisher.stop();
    }
  }
}

/** `thread.join(timeout)`: waits for the task, at most `timeout` seconds. */
async function join(task: Promise<void>, timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([task, new Promise<void>((r) => (timer = setTimeout(r, timeout * 1000)))]);
  } finally {
    clearTimeout(timer);
  }
}

