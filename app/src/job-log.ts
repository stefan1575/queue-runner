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
// - **Needing the user:** a `needs-user` end (T3 may have started a thread the app has no id of)
//   holds its repo until an `answered` line says the user has answered.
import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Cost, Reading } from './costs.ts';
import type { JobKind, ModelChoice } from './jobs.ts';

export type Outcome = 'done' | 'done-no-pr' | 'waiting' | 'usage-limit' | 'failed' | 'branch-exists' | 'not-started'
  /** T3 may have started its thread, and the app has no id of it (#154, After a restart, don't
   *  guess): its repo starts nothing until the user answers. */
  | 'needs-user';

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
  pr?: { number: number; url: string; state: string } | null;
  /** When the provider's limit resets, as T3 has it (a usage-limit end). */
  resetAt?: string | null;
  /** The question's kind (a waiting end). */
  request?: string;
};
export type Job = JobStart & { id: string; startedAt: string } & Partial<JobThread>
  & { end?: JobEnd & { at: string }; answeredAt?: string };

export class JobLogError extends Error {}

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
  | { event: 'answered'; job: string; at: string };

export class JobLog {
  private file: string;
  private files: JobLogFiles;
  private all = new Map<string, Job>();
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
    if (e.event === 'start') {
      const { event, job, at, ...start } = e;
      this.all.set(job, { ...start, id: job, startedAt: at });
    } else {
      const job = this.all.get(e.job);
      if (!job) return;
      if (e.event === 'thread') this.all.set(e.job, { ...job, threadId: e.threadId, runId: e.runId, link: e.link });
      else if (e.event === 'answered') this.all.set(e.job, { ...job, answeredAt: e.at });
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

  jobs(): Job[] {
    return [...this.all.values()];
  }

  get(id: string): Job | undefined {
    return this.all.get(id);
  }

  /** Builds started and not ended: left by an app that stopped mid-job, or running now. */
  open(): Job[] {
    return this.jobs().filter((j) => !j.end);
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

  /** When the repo's last job ended (one that never reached a thread aside), or null for none. */
  lastEnded(repo: string): string | null {
    const ends = this.jobs().filter((j) => j.repo === repo && j.end && j.end.outcome !== 'not-started').map((j) => j.end!.at);
    return ends.sort().at(-1) ?? null;
  }
}
