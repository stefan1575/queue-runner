// The run loop: two lanes side by side, one builder job per working repo and one reviewer job at a
// time. Ported from `queue_runner/run.py`'s `Runner` (#219): the same pass, the same choices and the
// same names (snake_case, as Python has them), with `tests/test_run.py`, `tests/test_side_by_side.py`,
// `tests/test_gating.py` and `tests/test_usage_budget.py` ported case for case in `test/run.test.ts`.
//
// The builder lane settles what earlier passes left open, then chooses each working repo's job
// (#50: the repos run side by side, each in a worker of its own that waits on its T3 thread's run
// while its job runs), and the usage gate lets each in only when it fits beside the jobs still
// running, the repo whose work has waited longest first. The lane plans again whenever a job ends.
// Each pass reads the job log, GitHub and T3 fresh: a restart is just another pass.
//
// What's ported so far: settling, builds, and the gate around them. The parts Python chooses before
// a build come with their own tickets, and until then they choose nothing here: a job a usage limit
// cut off (limit recovery), an ask thread, a reply on GitHub and a decision (decisions), the live
// steps (dropped from the port), a fix or conflict round (#223), a red base (stops), Stefan's
// switches (switches), and the reviewer lane's pass, which answers "nothing to do" until the reviews
// ticket (#222). A thread's facts from T3's database (a limit stop and its reset, #227; the effort a
// run used, #228) are read as Python reads them when it has none: no limit stop, no effort.
//
// The differences are TypeScript's and the app's:
// - Python's threads are async tasks: a worker is a promise, and the lane's "a job ended" is a
//   signal the loop waits on. Node runs one thing at a time, so Python's locks have nothing to guard.
// - The usage gate is the app's (`src/usage-gate.ts`), called where Python calls `gate.Gate`: `pick`
//   for `check` (it also names the model the job runs on, its kind's or the fallback), `started`
//   for a job let in, `finished` for `measured`, `dropped` for a job that reached no thread, and
//   `job_ended` for a thread seen to end outside a measured pass. The app's gate keeps the jobs it
//   let in itself; what it doesn't know of (a stopped runner's jobs) is passed to `pick`.
// - The lanes are the builder's and the reviewer's (#68's rule: the runner names its roles, never a
//   provider), where Python names each lane for its provider.
import { buildBrief } from './briefs/build.ts';
import { BuildJob, pick, type GitHub as PickerGitHub } from './build-picker.ts';
import type { Commit } from './git-seam.ts';
import type { Comment as SeamComment, GhCli, PullState, Repo as SeamRepo } from './github-seam.ts';
import { holdText } from './gate.ts';
import type { JobKind, ModelChoice } from './jobs.ts';
import type { Merger } from './settings.ts';
import { NOT_SENT, NOT_STARTED, USAGE_LIMIT, when, type Job, type JobLog } from './state.ts';
import { find_job_thread, settle_quietly, T3Error, type T3, type Thread } from './t3-seam.ts';
import type { Cost } from './costs.ts';
import type { Elsewhere, UsageGate } from './usage-gate.ts';

/** A job still running that this runner didn't start (`settle`): its label, kind and record. */
type Busy = [string, string, Job];

/** The model a job was launched on, as its start record has it (`choice`), or null for one whose
 *  record names none (the gate then takes its kind's model now). */
export function launched_on(job: Job): ModelChoice | null {
  const c = job.choice as Partial<ModelChoice> | null;
  return c && typeof c.provider === 'string' && typeof c.model === 'string'
    ? { provider: c.provider, model: c.model, effort: c.effort ?? null } : null;
}

// What a pass did: started (it started jobs), busy (a builder job is still running from an earlier
// runner, so none was started where it runs, and nothing elsewhere), idle (nothing to start),
// gated (the usage gate held the chosen builder jobs back: `Runner.gate_until` says when to look
// again).
export const STARTED = 'started';
export const BUSY = 'busy';
export const IDLE = 'idle';
export const GATED = 'gated';
export const STOPPED = 'stopped';   // the user stopped the lane (the switches ticket's)
export const RESTART = 'restart';   // run_forever's end when the runner's own code moved (serving itself)
export type Did = typeof STARTED | typeof BUSY | typeof IDLE | typeof GATED | typeof STOPPED;

export const WALL_STEP = 30;   // a long wait looks at the wall clock this often (seconds)
/** How long a worker waits for T3's usage reading after its job, to measure it (Python's after-job
 *  read waits at most the usage endpoint's five-minute budget; T3 reads usage on its own now). A
 *  measurement still unread then is recorded with no `after`, as Python records a failed read. */
export const MEASURE_WAIT = 300;

/** The builder lane's kinds (Python's in `gate.py`): what its measurement counts. */
export const BUILDER_KINDS: readonly string[] = ['build', 'fix', 'decision', 'live'];
/** The fallback review while the reviewer is out of usage (issue #69), gated as `review`. */
export const FALLBACK_REVIEW = 'review';

/** A served repo (Python's `config.Repo`): its name (the app names it by its GitHub `owner/name`,
 *  `src/run-wiring.ts`), `owner/name` on GitHub, its folder, its base branch and who merges its
 *  clean PRs (Settings' choice: the runner, or the user, Python's `stefan`). */
export type Repo = { readonly name: string; readonly github: string | null; readonly path: string; readonly base: string;
  readonly merge: Merger; readonly local_issues?: boolean };

/** Python's `Config`, from the app's Settings and Repositories, read once at start as Python reads
 *  config.toml (`src/run-wiring.ts`): the served repos, the state folder and the pause after an idle
 *  pass. */
export type Config = { readonly repos: readonly Repo[]; readonly state_dir: string; readonly poll_seconds: number };

export type GitHub = PickerGitHub & Pick<GhCli, 'issue_comments' | 'pull_for_branch' | 'pull'>;
export type Git = {
  fetch(path: string, branch: string): Promise<void>;
  has_branch(path: string, branch: string): Promise<boolean>;
  commits(path: string, base: string, branch: string): Promise<Commit[]>;
  fetch_pr(path: string, number: number, base: string): Promise<[string, string]>;
  log(path: string, a: string, b: string): Promise<Commit[]>;
};
export type Gate = Pick<UsageGate, 'pick' | 'started' | 'finished' | 'measured' | 'unmeasured' | 'dropped' | 'forget' | 'job_ended'>;

/** A wait the gate or a limit set (Python's `snapshot.Wait`): until when, and why. */
export type Wait = { until: Date | null; reason: string };

/** A repo's builder job, chosen and not yet started: `kind` the gate's (null for a decision the
 *  user's own words answer, which starts no thread), `run` what runs it, on `choice` (the model the
 *  gate let it in on), `label` what the log calls it, and `cost` what the gate let it in at (null:
 *  not let in by the gate). */
export class Start {
  readonly repo!: string;
  readonly kind!: JobKind | null;
  readonly then!: string | null;
  readonly run!: (choice: ModelChoice | null) => Promise<Did>;
  readonly label!: string;
  readonly choice: ModelChoice | null = null;
  readonly cost: Cost | null = null;
  constructor(fields: Pick<Start, 'repo' | 'kind' | 'then' | 'run' | 'label'> & Partial<Pick<Start, 'choice' | 'cost'>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/** A repo's builder job running as a task of its own (#50): `did` what its run returned. */
export class Worker {
  start: Start;
  task: Promise<void> | null = null;
  did: Did | null = null;
  constructor(start: Start) {
    this.start = start;
  }
}

/** Python's `threading.Event`: set, cleared, and waited on with a timeout. */
export class Signal {
  private on = false;
  private waiters = new Set<() => void>();

  set(): void {
    this.on = true;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  clear(): void {
    this.on = false;
  }

  is_set(): boolean {
    return this.on;
  }

  /** Until it's set, or `seconds` pass. */
  wait(seconds: number): Promise<void> {
    if (this.on) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, seconds) * 1000);
      this.waiters.add(done);
    });
  }
}

/** Sleeps until `seconds` of wall-clock time have passed, in steps of at most `step`, so a PC that
 *  slept and was woken for this time doesn't sleep on (Windows' timers may not count the time the
 *  PC was asleep). */
export async function wall_sleep(seconds: number, sleep: (s: number) => Promise<void> = (s) => new Promise((r) => setTimeout(r, s * 1000)),
  clock: () => number = () => Date.now() / 1000, step = WALL_STEP): Promise<void> {
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

const pad = (n: number) => String(n).padStart(2, '0');
/** A time as Python's `f'{t.astimezone():%Y-%m-%d %H:%M}'` writes it: local, to the minute. */
export const local_minute = (t: Date) =>
  `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;

/** Python's `f'{type(e).__name__}: {e}'`-style text of an error, and its traceback. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const traceback = (e: unknown) => (e instanceof Error && e.stack ? e.stack : String(e));

/** A job as the log names it (`Runner._name`). */
const name_of = (job: Job) => `${job.kind} ${job.repo}#${job.issue ?? 'None'}`;

export type RunnerOptions = {
  github: GitHub;
  t3: T3;
  git: Git;
  jobs: JobLog;
  /** What's said goes to the app's log (`log_line`) and the command line's output (`out`). */
  out: (line: string) => void;
  log_line: (line: string) => void;
  /** The usage gate; null starts every builder job (tests, the live checks) on `job_choice`. */
  gate?: Gate | null;
  /** The model a job of this kind runs on when no gate names one. */
  job_choice?: (kind: JobKind) => ModelChoice | null;
  /** The user's name for the brief (Settings, Name; else the gh account's). */
  user?: () => Promise<string>;
  /** Whether a file exists (the repo's agent instructions file, for the brief). */
  exists?: (path: string) => boolean;
  now?: () => Date;
  /** The wall clock in seconds (Python's `time.time`): what a long wait checks its end against. */
  clock?: () => number;
  /** How long a worker waits for its job's measurement (`MEASURE_WAIT`). */
  measure_wait?: number;
};

export class Runner {
  config: Config;
  github: GitHub;
  t3: T3;
  git: Git;
  jobs: JobLog;
  gate: Gate | null;
  now: () => Date;
  clock: () => number;
  measure_wait: number;
  out: (line: string) => void;
  log_line: (line: string) => void;
  job_choice: (kind: JobKind) => ModelChoice | null;
  user: () => Promise<string>;
  exists: (path: string) => boolean;
  gate_until: Date | null = null;
  /** What the gate last said, per repo (null key: the account's usage limit), so it's said once. */
  private _last_gate = new Map<string | null, string>();
  /** The builder jobs running in this runner's workers, one per repo (#50), and a signal set
   *  whenever one ends, so the lane plans again; the jobs a stopped runner left running (`settle`);
   *  and in the run loop, when each repo whose job started no thread may be tried again. */
  private _workers = new Map<string, Worker>();
  private _ended = new Signal();
  private _busy = new Map<string, Busy>();
  /** The jobs the gate let in this pass and not yet in a worker. */
  private _admitted: [string, JobKind | null, string | null][] = [];
  private _rests = false;
  private _rest = new Map<string, Date>();
  /** Each repo's wait as the last pass left it, for the Repositories card. */
  repo_waits = new Map<string, Wait>();
  /** A stopped runner's fallback review still running in T3: the builder lane starts nothing
   *  beside it until it ends (PR 67's review 2, F2; `_fallback_runs`). */
  private _orphan_review = false;
  /** The builder lane's wait as its last pass left it, or null. */
  builder_wait: Wait | null = null;
  /** The titles of the issues and PRs the passes started jobs on. */
  titles = new Map<string, string>();
  /** The reviewer lane (`review.py`'s `Reviewer`): the reviews ticket's (#222). */
  reviewer: { live: string | null } | null = null;
  restart_sha: string | null = null;

  constructor(config: Config, o: RunnerOptions) {
    this.config = config;
    this.github = o.github;
    this.t3 = o.t3;
    this.git = o.git;
    this.jobs = o.jobs;
    this.gate = o.gate ?? null;
    this.now = o.now ?? (() => new Date());
    this.clock = o.clock ?? (() => Date.now() / 1000);
    this.measure_wait = o.measure_wait ?? MEASURE_WAIT;
    this.out = o.out;
    this.log_line = o.log_line;
    this.job_choice = o.job_choice ?? (() => null);
    this.user = o.user ?? (async () => 'the user');
    this.exists = o.exists ?? (() => false);
  }

  say(line: string): void {
    this.log_line(line);
    this.out(line);
  }

  /** A job's own repo (Python's `self.repos.get`). */
  private _repo(name: string): Repo | undefined {
    return this.config.repos.find((r) => r.name === name);
  }

  /** A job's own repo, for recording its end: it throws when the config has none, as Python's
   *  `self.repos[job.repo]` raises KeyError. */
  private _based(name: string): Repo {
    const repo = this._repo(name);
    if (!repo) throw new Error(`KeyError: '${name}'`);
    return repo;
  }

  // --- one pass -------------------------------------------------------------------------

  /** One pass of the builder lane, waiting for the jobs it started (`--once`, the tests): STARTED
   *  if any of them ran a thread, IDLE if none did, or what `plan` said when it started none. */
  async run_pass(): Promise<Did> {
    const [did, workers] = await this.dispatch();
    for (const w of workers) await w.task;
    if (workers.length) return workers.some((w) => w.did === STARTED) ? STARTED : IDLE;
    return did;
  }

  /** Plans, then starts each job `plan` let in, each in a worker of its own (#50): (what the pass
   *  did, the workers it started). It returns once they've started. */
  async dispatch(): Promise<[Did, Worker[]]> {
    const starts = await this.plan();
    if (!Array.isArray(starts)) return [starts, []];
    return [STARTED, starts.map((s) => this._launch(s))];
  }

  /** Settles, then chooses each working repo's builder job (a repo with one running gets none: one
   *  builder job per repo, #50) and asks the gate whether each fits beside the jobs still running:
   *  the Starts it lets in, in the order they're let in, or BUSY, IDLE, GATED or STOPPED when none.
   *  Starts nothing itself. */
  async plan(): Promise<Start[] | Did> {
    this.gate_until = null;   // a wait from an earlier pass is that pass's
    const busy = await this.settle();
    // (thread titles' prefixes are the decisions ticket's; the user's stops the switches ticket's)
    if (this._orphan_review) {   // a stopped runner's fallback review runs on: nothing starts beside it
      this.repo_waits = new Map();
      this.builder_wait = null;
      return BUSY;
    }
    const taken = new Set([...busy.keys(), ...this._alive()]);
    const chosen = await this.choose(taken);
    if (!Array.isArray(chosen)) {
      this.repo_waits = new Map();
      this.builder_wait = chosen === GATED ? { until: this.gate_until, reason: this._last_gate.get(null) ?? '' } : null;
      return chosen === IDLE && busy.size ? BUSY : chosen;
    }
    const starts = this._admit(chosen, busy);
    if (starts.length) return starts;
    return this.repo_waits.size ? GATED : busy.size ? BUSY : IDLE;
  }

  /** Each working repo's builder job, but those in `skip` (one is running there): a list of
   *  Starts, the repo whose work has waited longest first (`_waited`), or IDLE when none has one,
   *  or GATED while a job a usage limit cut off may not resume yet (the limit is the whole
   *  account's: nothing starts in any repo). In each repo, as Python has it: a job a limit cut off,
   *  an ask thread, a decision, the repo's live steps, a fix round, a build, in that order; the
   *  parts not ported yet choose nothing. */
  async choose(skip: ReadonlySet<string> = new Set()): Promise<Start[] | Did> {
    const limited = this.jobs.limited_jobs();   // (a stopped repo's waits for its Resume: switches)
    const ahead = limited.filter((j) => j.resume_at && this.now() < when(j.resume_at));
    if (ahead.length) {
      // Python's max: the first of the latest
      const old = ahead.reduce((a, j) => (when(j.resume_at!) > when(a.resume_at!) ? j : a));
      const at = when(old.resume_at!);
      this.gate_until = at;
      const text = `${name_of(old)} was cut off by a usage limit; it resumes after ${local_minute(at)}`;
      if (text !== this._last_gate.get(null)) this.say(`Builder lane waits: ${text}`);
      this._last_gate = new Map([[null, text]]);
      return GATED;
    }
    this._last_gate.delete(null);
    const found: Start[] = [];
    for (const repo of this.config.repos) {
      if (skip.has(repo.name) || this._resting(repo.name)) continue;
      const start = await this._choose_in(repo, limited);
      if (start !== null) found.push(start);
    }
    if (!found.length) {
      if (!skip.size) {
        this.say("Nothing to start: no PR needs a fix round, and no repo has an unblocked ready-for-agent issue that isn't already being built or held.");
      }
      this.gate_until = null;   // (a live run's limit: the live steps are dropped from the port)
      return IDLE;
    }
    const order = this.config.repos.map((r) => r.name);
    return found
      .map((s) => ({ s, key: [this._waited(s.repo), order.indexOf(s.repo)] as const }))
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
      .map(({ s }) => s);
  }

  /** This repo's builder job now, as a Start, or null. */
  private async _choose_in(repo: Repo, limited: Job[]): Promise<Start | null> {
    const name = repo.name;
    // A job a limit cut off is recovered first, in its own repo: limit recovery's to port. Until
    // then the repo gets nothing else, as Python starts nothing else beside its recovery.
    if (limited.some((j) => j.repo === name)) return null;
    // (an ask thread, a reply on GitHub or in a fresh thread, and a decision: the decisions ticket's;
    // the live steps: dropped; a fix or conflict round: #223's)
    if (!repo.github || repo.local_issues) return null;
    // (no build from a red base, #98: the stops ticket's)
    const held = [...this.jobs.held_issues(name)].filter((n): n is number => n !== null);
    const job = await pick(repo as Repo & { github: string }, this.github, held);
    if (job !== null) {
      return new Start({ repo: name, kind: 'build', then: null, run: (choice) => this.run_build(job, choice),
        label: `build ${name}#${job.issue.number}` });
    }
    return null;
  }

  /** Since when the repo's work has waited for a builder job: when its last one ended (one that
   *  never reached a thread aside), as a timestamp, or 0 (the longest) if it has had none. When the
   *  gate has room for one more job, the repo that has waited longest gets it, so neither starves
   *  (#50); the repos' order breaks a tie. */
  private _waited(repo: string): number {
    const ended = this.jobs.jobs().filter((j) => j.repo === repo && BUILDER_KINDS.includes(j.kind) && j.ended_at
      && j.outcome !== NOT_STARTED && j.outcome !== NOT_SENT).map((j) => when(j.ended_at!).getTime() / 1000);
    return ended.length ? Math.max(...ended) : 0;
  }

  /** The usage gate before each chosen job, in order: a job starts only when its expected cost fits
   *  after the cost of every builder job still running and every one let in before it this pass
   *  (#50). One that waits is said once per repo (until that changes) and doesn't hold back a later
   *  repo's job that fits. */
  private _admit(chosen: Start[], busy: Map<string, Busy>): Start[] {
    this._admitted = [];   // an earlier pass's are in their workers by now
    const running = this._running(busy);
    const starts: Start[] = [];
    const waits = new Map<string, Wait>();
    for (const start of chosen) {
      if (start.kind === null || this.gate === null) {
        starts.push(this.gate === null && start.kind !== null ? new Start({ ...start, choice: this.job_choice(start.kind) }) : start);
        continue;
      }
      const verdict = this.gate.pick(start.label, start.kind, running);
      if (!verdict.fits) {
        const text = holdText(verdict.hold, local_minute);
        waits.set(start.repo, { until: verdict.until, reason: text });
        if (verdict.until && (this.gate_until === null || verdict.until < this.gate_until)) this.gate_until = verdict.until;
        if (text !== this._last_gate.get(start.repo)) this.say(`Builder lane waits on ${start.repo}: ${text}`);
        this._last_gate.set(start.repo, text);
        continue;
      }
      this._last_gate.delete(start.repo);
      this.gate.forget(start.label);
      this.say(`Usage gate, ${start.repo}: ${start.kind} fits${verdict.onFallback ? ', on its fallback' : ''}`);
      // counted from now, so the next repo's verdict counts this one; the jobs a stopped runner
      // left running spend beside it (`shared_with`)
      this.gate.started({ id: start.label, kind: start.kind, choice: verdict.choice }, verdict.cost, undefined, running);
      this._admitted.push([start.label, start.kind, start.then]);
      starts.push(new Start({ ...start, choice: verdict.choice, cost: verdict.cost }));
    }
    this.repo_waits = waits;
    const first = waits.values().next();
    this.builder_wait = !starts.length && !first.done ? first.value : null;
    return starts;
  }

  /** The builder jobs still running that the gate doesn't hold itself, as (label, kind) each: those
   *  a stopped runner left running (`settle`), and the reviewer lane's fallback review open in the
   *  job log (a stopped runner's, before the reviewer lane settles it). This runner's own workers
   *  and the jobs let in this pass the gate counts already: it let them in. */
  private _running(busy: Map<string, Busy>): Elsewhere[] {
    const jobs = [...busy.values()].filter(([, kind]) => BUILDER_KINDS.includes(kind) && kind !== 'live')
      .map(([label, kind, job]) => ({ id: label, kind: kind as JobKind, choice: launched_on(job) }));
    return [...jobs, ...this._open_reviews().map((label) => ({ id: label, kind: FALLBACK_REVIEW as JobKind }))];
  }

  /** The fallback reviews open in the job log, by label (`review <repo>#<PR>`). A review job names
   *  its `reviewer` only when the fallback reviewed in the reviewer's place (Python's `OPUS_KINDS`,
   *  the only values it writes there). */
  private _open_reviews(): string[] {
    return this.jobs.open_jobs().filter((j) => j.kind === 'review' && j.reviewer !== null)
      .map((j) => `review ${j.repo}#${j.issue}`);
  }

  // --- workers: one builder job per repo at once (#50) ------------------------------------

  /** The repos whose builder job is running in one of this runner's workers. */
  _alive(): string[] {
    return [...this._workers.keys()];
  }

  /** In the run loop, a repo whose last job started no thread rests `poll_seconds` before it's
   *  tried again, while the others go on. */
  private _resting(repo: string): boolean {
    const until = this._rest.get(repo);
    return until !== undefined && this.now() < until;
  }

  private _launch(start: Start): Worker {
    const w = new Worker(start);
    this._admitted = this._admitted.filter((a) => a[0] !== start.label);
    this._workers.set(start.repo, w);
    w.task = this._work(w);
    return w;
  }

  /** A worker's task: runs its job, tells the gate it ended (the gate records what it cost; a job
   *  that ran beside another teaches nothing, which the gate keeps itself), and says it ended. */
  private async _work(w: Worker): Promise<void> {
    const start = w.start;
    const since = this.jobs.jobs().length;
    try {
      w.did = await start.run(start.choice);
    } catch (e) {
      this.log_line(`${start.label}: the job failed:\n${traceback(e)}`);
      w.did = IDLE;
    }
    try {
      const fresh = this.jobs.jobs().slice(since).filter((j) => BUILDER_KINDS.includes(j.kind) && j.repo === start.repo);
      if (this.gate !== null && start.cost !== null) {
        if (w.did === STARTED && fresh.length) {
          // A thread ran: what it cost teaches the next estimate. The worker waits for T3's reading
          // after the job and its record, as Python's `gate.measured` reads usage before the worker
          // ends (so `--once` records it before it returns).
          this.gate.finished(start.label);
          await this._measured(this.gate, start.label);
        } else {
          this.gate.dropped(start.label);
          // A thread ran though the pass started nothing (a decision whose retry never reached its
          // job): what it spent isn't learned, but no reading before it serves.
          if (fresh.some((j) => j.thread_id && j.outcome !== NOT_SENT)) this.gate.job_ended(start.kind!, null, start.choice);
        }
      }
    } catch (e) {
      this.log_line(`${start.label}: recording its usage failed:\n${traceback(e)}`);
    } finally {
      if (this._workers.get(start.repo) === w) this._workers.delete(start.repo);
      if (this._rests && w.did !== STARTED) {
        this._rest.set(start.repo, new Date(this.now().getTime() + this.config.poll_seconds * 1000));
      }
      this._ended.set();
    }
  }

  /** Until the job's measurement is recorded: on T3's reading after it, or, with none within
   *  `measure_wait` seconds, with no `after` and the error (Python's `gate.measured`). Rejects when
   *  the record can't be written. */
  private async _measured(gate: Gate, label: string): Promise<void> {
    const recorded = gate.measured(label);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<'unread'>((resolve) => { timer = setTimeout(() => resolve('unread'), this.measure_wait * 1000); });
    try {
      if (await Promise.race([recorded, waited]) !== 'unread') return;
    } finally {
      clearTimeout(timer);
    }
    void gate.unmeasured(label, 'no reading after the job');
    await recorded;
  }

  /** A builder job's thread was seen to end outside a measured pass (`settle`): the next check
   *  waits for a usage reading taken after now (PR 67's review 1, F1). With `key` (a run id), only
   *  the first telling counts. */
  private _thread_ended(job: Job, key: string | null = null): void {
    if (this.gate !== null) this.gate.job_ended(job.kind as JobKind, key, launched_on(job));
  }

  /** The pause after a pass that started nothing, or while jobs run: `poll_seconds`, or less when
   *  the gate opens sooner. */
  idle_seconds(): number {
    const poll = this.config.poll_seconds;
    if (this.gate_until === null) return poll;
    const left = (this.gate_until.getTime() - this.now().getTime()) / 1000;
    return left >= 1 ? Math.min(poll, left) : poll;
  }

  /** Records how jobs left open by a stopped runner, or left waiting for an answer, ended. The
   *  repos where one of their threads is still running: {repo: [label, kind]}, each of which gets
   *  no other builder job (one per repo, #50) and whose cost the gate counts. A repo with a job
   *  running in one of this runner's own workers is left alone: that job is its worker's to
   *  record. */
  async settle(): Promise<Map<string, Busy>> {
    const busy = new Map<string, Busy>();
    this._orphan_review = false;
    const mine = new Set(this._alive());
    for (const job of this.jobs.open_jobs()) {
      if (job.kind === 'review' && job.reviewer !== null) {   // the reviewer lane's, not a repo's
        if (await this._fallback_runs(job)) this._orphan_review = true;
        continue;
      }
      if (mine.has(job.repo)) continue;
      if (job.kind === 'decision') {   // cut off with its runner: decided again
        this.jobs.ended(job.id, { exit_code: null, outcome: NOT_STARTED, error: 'The runner stopped mid-decision.' });
        this.say(`${name_of(job)}: cut off with its runner; decided again`);
        continue;
      }
      if (job.kind === 'live') continue;   // the live steps are dropped from the port
      if (job.kind !== 'build' && job.kind !== 'fix') continue;   // an open review or merge is the reviewer lane's
      const thread = await this._find_thread(job);
      if (thread === null) {
        this.jobs.ended(job.id, { exit_code: null, outcome: NOT_STARTED, error: 'No T3 thread was found for this job.' });
        this.say(`${name_of(job)}: no thread was started; closed as not-started`);
        this._uncontinue(job);
      } else if (thread.active && !thread.pending_requests) {
        this.say(`${name_of(job)} is still running in ${thread.link}: no other builder job starts in ${job.repo}`);
        busy.set(job.repo, [name_of(job), job.kind, job]);
      } else {
        await this.finish(job, thread.thread_id, _exit_code(thread), thread.status, null, thread.latest_run_id);
        this._thread_ended(job);
      }
    }
    for (const job of this.jobs.waiting_jobs()) {
      if (mine.has(job.repo)) continue;
      let thread: Thread;
      try {
        [thread] = await this.t3.show(job.thread_id!);
      } catch (e) {
        if (!(e instanceof T3Error)) throw e;
        // The user may have answered it and set it running: start nothing until T3 says.
        this.say(`${name_of(job)}: cannot read ${job.thread_id} (${e.message}); no other builder job starts in ${job.repo}`);
        busy.set(job.repo, [name_of(job), job.kind, job]);
        continue;
      }
      if (thread.active && !thread.pending_requests) {
        busy.set(job.repo, [name_of(job), job.kind, job]);   // answered, and running again
      } else if (_exit_code(thread) === 2) {
        // A run newer than the one that asked ran on the user's answer and asks again, seen
        // running or not (#85): the gate is told once, keyed on that run.
        if (thread.latest_run_id && thread.latest_run_id !== job.run_id) this._thread_ended(job, thread.latest_run_id);
      } else {
        await this.finish(job, thread.thread_id, _exit_code(thread), thread.status, null, thread.latest_run_id);
        this._thread_ended(job);   // the user's answer set it running again, and it ended
      }
    }
    this._busy = busy;
    return busy;
  }

  /** A stopped runner's fallback review, left open while its thread runs on (PR 67's review 2,
   *  F2): true while that thread runs (or T3 can't say), so no builder job starts beside it; once
   *  it has ended the gate is told, once per job, and the reviewer lane counts the review failed.
   *  The reviewer lane's own review now isn't a stopped runner's. */
  private async _fallback_runs(job: Job): Promise<boolean> {
    if (this.reviewer !== null && job.id === this.reviewer.live) return false;
    let thread: Thread | null;
    try {
      thread = await this._find_thread(job);
    } catch (e) {
      if (!(e instanceof T3Error)) throw e;
      this.say(`review ${job.repo}#${job.issue} (fallback): cannot read its thread (${e.message}); no other builder job starts`);
      return true;
    }
    if (thread === null) return false;   // it never started a thread: the reviewer lane counts it failed
    if (thread.active && !thread.pending_requests) {
      this.say(`review ${job.repo}#${job.issue} (fallback, a stopped runner's) is still running in ${thread.link}: no other builder job starts`);
      return true;
    }
    if (this.gate !== null) this.gate.job_ended(FALLBACK_REVIEW as JobKind, job.id);
    return false;
  }

  /** The T3 thread of a job, by its id or else its title (the snapshot's link). */
  find_thread(job: Job): Promise<Thread | null> {
    return this._find_thread(job);
  }

  private _find_thread(job: Job): Promise<Thread | null> {
    const repo = this._repo(job.repo);
    return find_job_thread(this.t3, job, repo ? repo.path : null);
  }

  // --- a build job ----------------------------------------------------------------------

  /** STARTED once a thread ran (or may still be running); IDLE if none was started, so the loop
   *  pauses before trying again. */
  async run_build(build: BuildJob, choice: ModelChoice | null): Promise<Did> {
    const repo = build.repo as unknown as Repo;   // the served repo `_choose_in` picked in
    const n = build.issue.number;
    this.titles.set(`${repo.name}#${n}`, build.issue.title);
    await this.git.fetch(repo.path, repo.base);
    const job = this.jobs.started({ kind: 'build', repo: repo.name, issue: n, branch: build.branch, title: job_title(repo, n),
      choice });
    if (await this.git.has_branch(repo.path, build.branch)) {
      this.jobs.ended(job.id, { exit_code: null, outcome: 'branch-exists', error: `A local branch ${build.branch} is left from an earlier run.` });
      this.say(`${name_of(job)} not started: local branch ${build.branch} already exists (held until released)`);
      return IDLE;
    }
    const comments = await this.github.issue_comments(repo as SeamRepo, n);
    const brief = buildBrief({
      github: repo.github ?? repo.name, number: n, title: build.issue.title, body: build.issue.body,
      comments: comments.map((c: SeamComment) => ({ author: c.author, createdAt: c.created_at, body: c.body })),
      branch: build.branch, base: build.base, user: await this.user(),
      agentsFile: this.exists(join(repo.path, 'AGENTS.md')) ? 'AGENTS.md' : this.exists(join(repo.path, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
    });
    const where = repo.github ? ` (${repo.github}#${n})` : '';
    this.say(`Starting ${name_of(job)}${where} on ${build.branch} from ${build.base}`);
    return this._start(job, repo, brief, build.base, build.branch, choice);
  }

  /** Runs the job's thread in a new T3 worktree on `branch` from `base`, on `choice`, and records
   *  how it ended. */
  private async _start(job: Job, repo: Repo, brief: string, base: string, branch: string, choice: ModelChoice | null): Promise<Did> {
    let result;
    try {
      if (choice === null) throw new T3Error(`no model is chosen for a ${job.kind} job`);
      result = await this.t3.start(repo.path, brief, {
        title: job.title, worktree: base, branch, provider: choice.provider, model: choice.model, effort: choice.effort,
      });
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
        this.say(`${name_of(job)} not started: ${e.message}`);
        return IDLE;
      }
      this.say(`${name_of(job)}: lost track of its thread (${e.message}); the next pass settles it`);
      return STARTED;
    }
    await this.finish(job, result.thread_id, result.exit_code, result.status, result.error, result.run_id);
    return STARTED;
  }

  // --- a fix round's end (its start is #223's) -------------------------------------------

  /** Records a fix round: `pushed` if the PR's head moved, `no-push` if it ended at H (reviewed
   *  already, so the PR waits for the user), `head-unknown` if GitHub couldn't say, else `failed` or
   *  `waiting`. */
  async finish_fix(job: Job, thread_id: string, exit_code: number, status: string, error: string | null,
    run_id: string | null): Promise<Job> {
    const repo = this._based(job.repo);
    let link: string | null = null;
    let worktree: string | null = null;
    let head: string | null = null;
    let pr: Record<string, unknown> | null = null;
    let commits: Commit[] = [];
    try {
      const [thread] = await this.t3.show(thread_id);
      link = thread.link;
      worktree = thread.worktree_path;
    } catch (e) {
      if (!(e instanceof T3Error)) throw e;
      error = error || `thread show failed: ${e.message}`;
    }
    const limit = this._limit(exit_code);
    try {
      const now = await this.github.pull(repo as SeamRepo, job.issue!);
      head = now.head_sha;
      pr = { number: now.number, url: now.url, state: now.state };
      if (head !== job.sha) {
        await this.git.fetch_pr(repo.path, job.issue!, now.base);
        commits = await this.git.log(repo.path, job.sha!, head);
      }
    } catch (e) {   // the record matters more than its commit list
      error = error || `reading the PR after the round failed: ${(e as Error)?.constructor?.name ?? 'Error'}: ${message(e)}`;
    }
    const pushed = head !== null && head !== job.sha;
    const outcome = exit_code === 2 ? 'waiting' : limit ? USAGE_LIMIT : exit_code ? 'failed'
      : head === null ? 'head-unknown' : pushed ? 'pushed' : 'no-push';
    this.jobs.ended(job.id, { exit_code, outcome, thread_id, link, run_id, status, commits, pr, worktree, error, head, ...(limit ?? {}) });
    const moved = pushed ? `, head ${job.sha!.slice(0, 7)} -> ${head!.slice(0, 7)}, ${commits.length} commits`
      : head ? `, head still ${job.sha!.slice(0, 7)}` : ', head unknown';
    this.say(`${name_of(job)} ended: ${outcome} (exit ${exit_code}${moved}) ${link || thread_id}`);
    await this._settle_ended(job, thread_id, outcome);
    return job;
  }

  async finish(job: Job, thread_id: string, exit_code: number, status: string, error: string | null,
    run_id: string | null): Promise<Job> {
    if (job.kind === 'fix') return this.finish_fix(job, thread_id, exit_code, status, error, run_id);
    const repo = this._based(job.repo);
    let link: string | null = null;
    let worktree: string | null = null;
    try {
      const [thread] = await this.t3.show(thread_id);
      link = thread.link;
      worktree = thread.worktree_path;
    } catch (e) {
      if (!(e instanceof T3Error)) throw e;
      error = error || `thread show failed: ${e.message}`;
    }
    const limit = this._limit(exit_code);
    let commits: Commit[] = [];
    try {
      commits = await this.git.commits(repo.path, `origin/${repo.base}`, job.branch!);
    } catch (e) {   // the record matters more than its commit list
      error = error || `reading commits failed: ${message(e)}`;
    }
    let pr: PullState | null = null;
    if (repo.github) {   // a job may open its PR and fail or stop after
      try {
        pr = await this.github.pull_for_branch(repo as SeamRepo, job.branch!);
      } catch (e) {
        error = error || `PR lookup failed: ${message(e)}`;
      }
    }
    const outcome = exit_code === 0 ? (pr || !repo.github ? 'done' : 'done-no-pr')
      : exit_code === 2 ? 'waiting' : limit ? USAGE_LIMIT : 'failed';
    this.jobs.ended(job.id, { exit_code, outcome, thread_id, link, run_id, status, commits, pr, worktree, error, ...(limit ?? {}) });
    const pr_note = pr ? `, PR #${pr.number}` : '';
    this.say(`${name_of(job)} ended: ${outcome} (exit ${exit_code}, ${commits.length} commits${pr_note}) ${link || thread_id}`);
    await this._settle_ended(job, thread_id, outcome);
    return job;
  }

  /** A build, fix or conflict thread is settled once its end is recorded (ticket 70), unless it
   *  waits for an answer: that one is the user's, or a decision's, to answer in the thread. */
  private async _settle_ended(job: Job, thread_id: string, outcome: string): Promise<void> {
    if (outcome !== 'waiting') await settle_quietly(this.t3, thread_id, name_of(job), (line) => this.say(line));
  }

  /** For a failed run that stopped on a usage limit: the end record's `resume_at` and `context`.
   *  None for any other end. Telling a limit stop takes T3's record of the run's failure and its
   *  reset (#227) and the limit's own reading of the thread (limit recovery): until they're
   *  ported, no run is a limit stop, as Python has none when nothing says so. */
  private _limit(exit_code: number): { resume_at: string; context: number | null; last_request: string | null } | null {
    if (exit_code !== 1) return null;
    return null;
  }

  /** A job that picked up a waiting one (`about`) never reached a thread: the waiting job was marked
   *  `continued` before it, so it waits again as it did, and its case is decided again. */
  private _uncontinue(job: Job): void {
    const old = job.about ? this.jobs.jobs().find((j) => j.id === job.about) ?? null : null;
    if (old !== null && old.outcome === 'continued') this.jobs.ended(old.id, { exit_code: old.exit_code, outcome: 'waiting' });
  }

  // --- the loop ---------------------------------------------------------------------------

  /** The reviewer lane's pass: "nothing to do" until the reviews ticket (#222). */
  async _reviewer_pass(): Promise<Did> {
    try {
      if (this.reviewer === null) return IDLE;
      return IDLE;
    } catch (e) {
      this.log_line(`Reviewer pass failed:\n${traceback(e)}`);
      return IDLE;
    }
  }

  private async _reviewer_lane(stop: Signal): Promise<void> {
    while (!stop.is_set()) {
      const did = await this._reviewer_pass();
      if (did !== STARTED) await stop.wait(this.config.poll_seconds);
    }
  }

  /** One pass of each lane, side by side: at most one builder job per working repo (#50) and one
   *  review. The builder lane chooses its jobs before the reviewer lane starts, so what this pass's
   *  review decides waits for the next pass. */
  async run_once(): Promise<void> {
    const [, workers] = await this.dispatch();
    const reviewer = this._reviewer_pass();
    try {
      for (const w of workers) await w.task;
    } finally {
      await reviewer;
    }
  }

  /** While builder jobs run in their workers: until one ends, or `idle_seconds` pass (the other
   *  repos' work is looked at again then), by the wall clock, looked at every `WALL_STEP` seconds at
   *  most, so a PC that slept doesn't hold the planner past its time (Windows' timers may not count
   *  the time the PC was asleep). */
  private async _wait_for_a_job(): Promise<void> {
    const end = this.clock() + this.idle_seconds();
    for (let left = end - this.clock(); this._alive().length && !this._ended.is_set() && left > 0; left = end - this.clock()) {
      await this._ended.wait(Math.min(WALL_STEP, left));
    }
  }


  /** The builder lane here, starting each repo's job in a worker of its own (#50) and planning
   *  again whenever one ends; the reviewer lane beside it, stopped when this loop is. `sleep` is
   *  the pause after a pass that started nothing. (New code for the runner itself, and the wake
   *  tasks and the snapshot after each pass, are later tickets': serving itself, the snapshot.) */
  async run_forever(sleep: (seconds: number) => Promise<void>): Promise<string> {
    const stop = new Signal();
    this._rests = true;
    const reviewer = this._reviewer_lane(stop);
    try {
      for (;;) {
        this._ended.clear();
        let did: Did = IDLE;
        try {
          [did] = await this.dispatch();
        } catch (e) {
          this.log_line(`pass failed:\n${traceback(e)}`);
        }
        if (this._alive().length) await this._wait_for_a_job();
        else if (did !== STARTED && !this._ended.is_set()) {
          // (a job that ended since this pass planned: plan again at once)
          await sleep(this.idle_seconds());
        }
      }
    } finally {
      stop.set();
      await reviewer;
    }
  }
}

/** A folder and a name in it, as the old build lane joined them for the brief's instructions file. */
const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;
