// The job log (#154; today's `queue_runner/state.py` and its doc's The job log):
// `jobs.jsonl` in the state folder, one JSON event a line, appended. A job's `start`, the
// `thread` T3 gave it once launched, and its `end`. A torn last line (a crash mid-write) is cut
// off; a bad line anywhere else is an error.
//
// - **Held issues:** every build that got as far as a start holds its issue, so the picker skips
//   it (releasing one is a later ticket). Only `not-started` (T3 or git failed before any thread)
//   holds nothing, so the next pass tries it again.
// - **Who waited longest:** a repo's last job end, a `not-started` aside (#50).
// - **Open jobs:** a start with no end, left by an app that stopped mid-job.
// - **Waiting:** a `waiting` end (a question to the user) is followed by the job's real end, a
//   second `end` line, once its thread has finished again (#210 F5).
// - **Needing the user:** a `needs-user` end (T3 may have started a thread the app has no id of)
//   holds its repo until an `answered` line says the user has answered.
// - **To settle:** a job ended on a thread the app launched, that its end says to settle, with no
//   `settled` line yet: an app that stopped between the two settles it on its next start (F9).
// - **PR owed:** a build ended `done` whose PR lookup failed has no `pr` yet: it's looked up again
//   until GitHub answers, and a `pr` line then records the PR or, with none, `done-no-pr` (F13).
// - **PR steps** (#156): a merge the app made or noticed, and a `ready-to-merge` mark put on or
//   taken off, each a `step` line and its `step-end`; a merge's clean-up after it (worktrees and
//   branches removed, the PR's threads settled) is a `cleaned` line, and its folders T3 still held
//   then are a `swept` line once they're gone. A merge started with no end (the app stopped
//   mid-merge) is read from GitHub on the next pass; one merged and not cleaned is cleaned then.
// - **Stops** (#157, for the stops ticket #158): a PR left for the user on its head H, with why: a
//   conflict a conflict round couldn't resolve (it ended without a push), one back on the same base
//   tip the last round merged, or too many rounds as the base keeps moving. One `stop` line per
//   PR, head and cause; nothing more happens to it yet.
import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Cost, Reading } from './costs.ts';
import type { JobKind, ModelChoice } from './jobs.ts';

export type Outcome = 'done' | 'done-no-pr' | 'waiting' | 'usage-limit' | 'failed' | 'branch-exists' | 'not-started'
  // a review's (#155): H reviewed (its decision), or nothing counts
  | ReviewedOutcome | 'out-of-usage' | 'head-moved'
  /** T3 may have started its thread, and the app has no id of it (#154, After a restart, don't
   *  guess): its repo starts nothing until the user answers. */
  | 'needs-user';
/** A review whose comment is on the PR: its head was reviewed. */
export type ReviewedOutcome = 'clean' | 'blocking' | 'stop' | 'approach-note';
export const REVIEWED: readonly Outcome[] = ['clean', 'blocking', 'stop', 'approach-note'];

export type JobStart = {
  kind: JobKind;
  /** The T3 project's id. */
  repo: string;
  /** `owner/name`, or null for a repo with no GitHub (the live check's sandbox). */
  github: string | null;
  issue: number;
  branch: string;
  base: string;
  title: string;
  choice: ModelChoice;
  onFallback: boolean;
  /** A review's: the commit it reviews, its round, and who reviews as its comment names them;
   *  its run folder, its checkout and the repo's folder that checkout is of, so a review the app
   *  was cut off from carries on with its thread after a restart. */
  sha?: string;
  round?: number;
  reviewer?: string;
  runDir?: string;
  checkout?: string;
  folder?: string;
  /** A fix round's (#156): sent to the thread `to` (the PR's builder, or the fresh fixer that took
   *  over), whose runs before the send were `knownRuns`, so its new run is told apart from them
   *  after a restart; or `fresh`, a new thread on the fix kind's settings, with why. A fresh fixer
   *  in a new worktree works on the local branch `workBranch` and pushes to `branch`. */
  to?: string;
  knownRuns?: string[];
  fresh?: string;
  workBranch?: string;
  /** A conflict round's (#157): the base branch's own tip as GitHub had it when the round started
   *  (its branches API, never the PR's `base.sha`), the base the round merges in. */
  baseSha?: string;
  /** What the usage gate let the job in at, and T3's reading it was let in on: a job watched
   *  again after a restart is reserved and measured from these. Absent on a line an older app
   *  wrote, and on a job no gate let in (the live check's). */
  cost?: Cost;
  before?: Reading;
};
export type JobThread = { threadId: string; runId: string | null; link: string | null };
export type JobEnd = {
  outcome: Outcome;
  /** T3's status for the run (`completed`, `failed`...), when it ran. */
  status?: string;
  error?: string | null;
  /** The PR opened from the job's branch, or null for none. Absent on a `done` end of a repo on
   *  GitHub, its lookup failed and is owed (F13). */
  pr?: { number: number; url: string; state: string } | null;
  /** When the provider's limit resets, as T3 has it (a usage-limit end). */
  resetAt?: string | null;
  /** The question's kind (a waiting end). */
  request?: string;
  /** A review's: its verdict, why it stops, its comment and its run folder. */
  verdict?: 'clean' | 'blocking';
  signals?: string[];
  link?: string | null;
  runDir?: string;
  /** A fix or conflict round's: the PR's head once it ended (null when GitHub couldn't say). */
  head?: string | null;
};
export type Job = JobStart & { id: string; startedAt: string } & Partial<JobThread>
  & { end?: JobEnd & { at: string }; answeredAt?: string; settledAt?: string;
    /** The local branches the app's own launch for this job made, with the worktree T3 put on
     *  each (`made` lines, #156 F15): what a merge's clean-up may remove, and nothing else. */
    made?: string[] };

/** What a PR step ended in: a merge `merged` (by the app, or noticed as the user's: `by`),
 *  `failed`, or `head-moved` (GitHub refused the old head: it's reviewed again); a mark `marked` or
 *  `unmarked`. */
export type StepOutcome = 'merged' | 'failed' | 'head-moved' | 'marked' | 'unmarked'
  /** A PR the app reviewed, closed without merging: noticed once, done with (#156 F14). */
  | 'closed';
export type StepStart = { kind: 'merge' | 'ready'; repo: string; github: string; pr: number; branch: string; sha: string };
export type StepEnd = { outcome: StepOutcome; error?: string | null; by?: 'app' | 'user'; commit?: string | null; why?: string };
export type Step = StepStart & { id: string; startedAt: string; end?: StepEnd & { at: string }; cleanedAt?: string; left?: string[]; sweptAt?: string };

/** A PR left for the user on its head (#157; the stops ticket, #158, acts on them). */
export type StopStart = { cause: 'conflict'; repo: string; github: string; pr: number; sha: string; why: string; link: string | null };
export type Stop = StopStart & { id: string; at: string };

export class JobLogError extends Error {}

/** Whether a job's end settles its thread (#68 story 5): a question to the user and a usage limit
 *  are later tickets' to handle, so their threads are left as they are. */
export const settles = (outcome: Outcome) => outcome !== 'waiting' && outcome !== 'usage-limit';

/** The file calls the log makes: the disk, or a test's own in-memory folder (#202 F2). A missing
 *  file is read as an error with `code` 'ENOENT', as Node's is. */
export type JobLogFiles = {
  read(file: string): Promise<string>;
  append(file: string, text: string): Promise<void>;
  truncate(file: string, bytes: number): Promise<void>;
};

export const DISK: JobLogFiles = {
  read: (file) => readFile(file, 'utf8'),
  append: async (file, text) => { await mkdir(dirname(file), { recursive: true }); await appendFile(file, text); },
  truncate: (file, bytes) => truncate(file, bytes),
};

type Event =
  | ({ event: 'start'; job: string; at: string } & JobStart)
  | ({ event: 'thread'; job: string; at: string } & JobThread)
  | ({ event: 'end'; job: string; at: string } & JobEnd)
  | { event: 'answered'; job: string; at: string }
  | { event: 'settled'; job: string; at: string }
  | { event: 'made'; job: string; at: string; branch: string }
  | { event: 'pr'; job: string; at: string; pr: JobEnd['pr'] }
  | ({ event: 'step'; step: string; at: string } & StepStart)
  | ({ event: 'step-end'; step: string; at: string } & StepEnd)
  | { event: 'cleaned'; step: string; at: string; left: string[] }
  | { event: 'swept'; step: string; at: string }
  | ({ event: 'stop'; stop: string; at: string } & StopStart);

export class JobLog {
  private file: string;
  private files: JobLogFiles;
  private all = new Map<string, Job>();
  private steps_ = new Map<string, Step>();
  private stops_ = new Map<string, Stop>();
  private writing: Promise<void> = Promise.resolve();
  private now: () => Date;
  private n = 0;

  private constructor(file: string, now: () => Date, files: JobLogFiles) {
    this.file = file;
    this.now = now;
    this.files = files;
  }

  static async open(file: string, now = () => new Date(), files: JobLogFiles = DISK): Promise<JobLog> {
    let text = '';
    try {
      text = await files.read(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new JobLogError(`${file} can't be read: ${(e as Error).message}`);
    }
    const log = new JobLog(file, now, files);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let e: Event;
      try {
        e = JSON.parse(line);
      } catch {
        if (lines.slice(i + 1).some((l) => l.trim())) throw new JobLogError(`${file} line ${i + 1} isn't an event`);
        return;
      }
      log.fold(e);
    });
    if (text && !text.endsWith('\n')) await files.truncate(file, Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1)));
    return log;
  }

  private fold(e: Event) {
    if (e.event === 'stop') {
      const { event, stop, ...rest } = e;
      this.stops_.set(stop, { ...rest, id: stop });
      return;
    }
    if (e.event === 'step') {
      const { event, step, at, ...start } = e;
      this.steps_.set(step, { ...start, id: step, startedAt: at });
      return;
    }
    if (e.event === 'step-end' || e.event === 'cleaned' || e.event === 'swept') {
      const st = this.steps_.get(e.step);
      if (!st) return;
      if (e.event === 'cleaned') this.steps_.set(e.step, { ...st, cleanedAt: e.at, left: e.left });
      else if (e.event === 'swept') this.steps_.set(e.step, { ...st, sweptAt: e.at });
      else {
        const { event, step, ...end } = e;
        this.steps_.set(e.step, { ...st, end });
      }
      return;
    }
    if (e.event === 'start') {
      const { event, job, at, ...start } = e;
      this.all.set(job, { ...start, id: job, startedAt: at });
    } else {
      const job = this.all.get(e.job);
      if (!job) return;
      if (e.event === 'thread') this.all.set(e.job, { ...job, threadId: e.threadId, runId: e.runId, link: e.link });
      else if (e.event === 'answered') this.all.set(e.job, { ...job, answeredAt: e.at });
      else if (e.event === 'settled') this.all.set(e.job, { ...job, settledAt: e.at });
      else if (e.event === 'made') this.all.set(e.job, { ...job, made: [...new Set([...(job.made ?? []), e.branch])] });
      else if (e.event === 'pr') {
        if (!job.end) return;
        const { error: _, ...end } = job.end;
        this.all.set(e.job, { ...job, end: { ...end, outcome: e.pr ? 'done' : 'done-no-pr', pr: e.pr } });
      }
      else {
        const { event, job: _, ...end } = e;
        this.all.set(e.job, { ...job, end });
      }
    }
  }

  private append(e: Event): Promise<void> {
    this.fold(e);
    const write = this.writing.then(() => this.files.append(this.file, `${JSON.stringify(e)}\n`));
    this.writing = write.catch(() => {});
    return write;
  }

  /** A new job's start, written; its id. */
  async started(start: JobStart): Promise<Job> {
    const at = this.now().toISOString();
    const id = `${start.kind}-${at.replace(/[-:.]/g, '')}-${++this.n}`;
    await this.append({ event: 'start', job: id, at, ...start });
    return this.all.get(id)!;
  }

  async thread(id: string, thread: JobThread): Promise<void> {
    await this.append({ event: 'thread', job: id, at: this.now().toISOString(), ...thread });
  }

  async ended(id: string, end: JobEnd): Promise<Job> {
    await this.append({ event: 'end', job: id, at: this.now().toISOString(), ...end });
    return this.all.get(id)!;
  }

  /** The user has answered a job that needed them: its repo is free again. */
  async answered(id: string): Promise<Job> {
    await this.append({ event: 'answered', job: id, at: this.now().toISOString() });
    return this.all.get(id)!;
  }

  /** The app's own launch for the job made this local branch (and T3 its worktree on it): written
   *  right after the launch, so a merge's clean-up removes only what the app made (F15). */
  async made(id: string, branch: string): Promise<Job> {
    await this.append({ event: 'made', job: id, at: this.now().toISOString(), branch });
    return this.all.get(id)!;
  }

  /** The job's thread is settled in T3. */
  async settled(id: string): Promise<Job> {
    await this.append({ event: 'settled', job: id, at: this.now().toISOString() });
    return this.all.get(id)!;
  }

  /** A done build's PR, looked up after a lookup that failed: with none it's `done-no-pr`. */
  async pr(id: string, pr: JobEnd['pr']): Promise<Job> {
    await this.append({ event: 'pr', job: id, at: this.now().toISOString(), pr: pr ?? null });
    return this.all.get(id)!;
  }

  jobs(): Job[] {
    return [...this.all.values()];
  }

  /** A PR step's start (a merge, a mark), written. */
  async stepStarted(start: StepStart): Promise<Step> {
    const at = this.now().toISOString();
    const id = `${start.kind}-${at.replace(/[-:.]/g, '')}-${++this.n}`;
    await this.append({ event: 'step', step: id, at, ...start });
    return this.steps_.get(id)!;
  }

  async stepEnded(id: string, end: StepEnd): Promise<Step> {
    await this.append({ event: 'step-end', step: id, at: this.now().toISOString(), ...end });
    return this.steps_.get(id)!;
  }

  /** A merge's clean-up is done; `left` are folders T3 still held, swept later. */
  async cleaned(id: string, left: string[]): Promise<Step> {
    await this.append({ event: 'cleaned', step: id, at: this.now().toISOString(), left });
    return this.steps_.get(id)!;
  }

  async swept(id: string): Promise<Step> {
    await this.append({ event: 'swept', step: id, at: this.now().toISOString() });
    return this.steps_.get(id)!;
  }

  steps(): Step[] {
    return [...this.steps_.values()];
  }

  /** A PR left for the user on its head, written once: a stop already there for the same PR, head
   *  and cause is that one, and nothing is written. */
  async stopped(start: StopStart): Promise<Stop> {
    const there = this.stopOn(start.repo, start.pr, start.sha, start.cause);
    if (there) return there;
    const at = this.now().toISOString();
    const id = `stop-${at.replace(/[-:.]/g, '')}-${++this.n}`;
    await this.append({ event: 'stop', stop: id, at, ...start });
    return this.stops_.get(id)!;
  }

  stops(): Stop[] {
    return [...this.stops_.values()];
  }

  /** The stop recorded on the PR's head for `cause`, if any. */
  stopOn(repo: string, pr: number, sha: string, cause: StopStart['cause']): Stop | undefined {
    return this.stops().find((s) => s.repo === repo && s.pr === pr && s.sha === sha && s.cause === cause);
  }

  get(id: string): Job | undefined {
    return this.all.get(id);
  }

  /** Jobs started and not ended: left by an app that stopped mid-job, or running now. */
  open(): Job[] {
    return this.jobs().filter((j) => !j.end);
  }

  /** Jobs ended on a thread the app launched whose thread isn't settled yet: a question or a usage
   *  limit aside, which are left for the user (later tickets). */
  toSettle(): Job[] {
    return this.jobs().filter((j) => j.end && j.threadId && !j.settledAt && settles(j.end.outcome));
  }

  /** Jobs whose end is a question to the user: their thread runs again once the user answers it
   *  in T3, so each is watched until its thread has finished again, and that end recorded in its
   *  place (#210 F5). */
  waiting(): Job[] {
    return this.jobs().filter((j) => j.end?.outcome === 'waiting');
  }

  /** Builds ended `done` in a repo on GitHub whose PR lookup failed: looked up again (F13). */
  prOwed(): Job[] {
    return this.jobs().filter((j) => j.github && j.end?.outcome === 'done' && j.end.pr === undefined);
  }

  /** The repo's jobs that need the user and haven't had an answer: while there's one, the repo
   *  starts nothing. */
  needingUser(repo: string): Job[] {
    return this.jobs().filter((j) => j.repo === repo && j.end?.outcome === 'needs-user' && !j.answeredAt);
  }

  /** Issues the picker leaves alone in this repo: a build open on them, or one that ended any
   *  way but `not-started`. */
  heldIssues(repo: string): Set<number> {
    return new Set(this.jobs().filter((j) => j.kind === 'build' && j.repo === repo && j.end?.outcome !== 'not-started').map((j) => j.issue));
  }

  /** When the repo's last job of `kinds` (every kind if none named) ended, one that never reached
   *  a thread aside, or null for none. */
  lastEnded(repo: string, kinds?: readonly JobKind[]): string | null {
    const ends = this.jobs().filter((j) => j.repo === repo && (!kinds || kinds.includes(j.kind)) && j.end && j.end.outcome !== 'not-started').map((j) => j.end!.at);
    return ends.sort().at(-1) ?? null;
  }
}
