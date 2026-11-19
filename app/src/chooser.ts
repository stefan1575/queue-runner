// The chooser (#210; today's `Runner.plan`, `choose` and `_choose_in` in `queue_runner/run.py`,
// ported): one job per served repo at a time (a build, a fix round or a conflict round: the jobs
// that write to the repo; reviews and merges run beside them), repos side by side, chosen in one
// place (#50). The lanes that start such jobs (fix rounds, conflict rounds, builds) keep
// everything they decide about a job: which PR gets a round, its brief, its model, the gate. They
// don't decide when to start: each answers "your next job in this repo, if any"
// (`RepoJobLane.next`), and the chooser starts at most one per repo each pass.
//
//   settle first: every job the log shows open is recovered by its lane (`recover`) before the
//   first choice  ->  each pass: each lane's owed bookkeeping (settles, PR lookups)  ->  the
//   served repos that have no job open (in the log or under way in a lane), none needing
//   the user, no done build's PR lookup owed, and no job a usage limit cut off before its reset
//   ->  the repo that waited longest first (`waited`), the served order breaking a tie
//   ->  in each: a fix round, a conflict round, a build, the first lane with one; a lane whose
//       job waits (the gate, a fork's PR now needing the user) leaves the repo for the next pass,
//       as does a read that fails, which never holds back another repo
//
// A job a usage limit cut off comes first in its repo, as today's: resuming it is the limits
// ticket's, so until then it holds its repo till its reset. Passes don't overlap: one asked for
// while one runs runs once after it.
import type { BuildRepo } from './build-lane.ts';
import { AFTER_RESET_MS, LIMIT_UNKNOWN_MS } from './gate.ts';
import type { Job, JobLog } from './job-log.ts';
import type { JobKind } from './jobs.ts';

/** What a lane answers for a repo: a job to start (`launch` resolves once T3 has it, or once it
 *  started nothing; the lane tracks it to its end), a job that waits (the repo starts nothing else
 *  this pass), or nothing of this lane's. A read that fails throws. */
export type Next = { launch: () => Promise<void> } | { waits: string } | null;

/** A lane that starts a repo's jobs, as the chooser asks it. */
export interface RepoJobLane {
  /** Watches again each of its jobs the log shows open, and settles each ended one not settled. */
  recover(): void;
  /** Its bookkeeping each pass, before any choice: settles and lookups owed. */
  owed(): void;
  /** Whether a job of this lane is under way in the repo (recovering, starting or running). */
  busy(repo: BuildRepo): boolean;
  /** Its next job in the repo, if any (see `Next`). */
  next(repo: BuildRepo): Promise<Next>;
  /** T3 read new usage: whether a job of this lane waits on the gate (a pass is owed). */
  usageChanged(): boolean;
  stop(): void;
  idle(): Promise<void>;
}

/** The kinds that are a repo's one job at a time (#158's jobs join them). */
export const REPO_JOB_KINDS: readonly JobKind[] = ['build', 'fix', 'conflict'];

export type ChooserDoors = {
  repos: () => BuildRepo[];
  /** In today's order within a repo: fix rounds, conflict rounds, builds. */
  lanes: RepoJobLane[];
  log: JobLog;
  say: (line: string) => void;
  now?: () => Date;
};

export class Chooser {
  private d: ChooserDoors;
  private now: () => Date;
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** The reason each repo got nothing last pass, so it's said once. */
  private said = new Map<string, string>();

  constructor(doors: ChooserDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
  }

  /** Settle first: each lane recovers the jobs the log shows open, then the first pass. */
  start(): Promise<void> {
    for (const lane of this.d.lanes) lane.recover();
    return this.pass();
  }

  stop() {
    this.stopped = true;
    for (const lane of this.d.lanes) lane.stop();
  }

  /** T3 read new usage: a pass, if a lane's job waits on the gate. */
  usageChanged(): void {
    // every lane is told (the build lane reads tickets again on it), then one pass
    const owed = this.d.lanes.map((l) => l.usageChanged()).some(Boolean);
    if (owed) void this.pass();
  }

  /** The user has answered a job that needed them (the Inbox ticket's to ask): its repo is free
   *  again, and a pass runs. */
  async answered(jobId: string): Promise<void> {
    if (!this.d.log.get(jobId)?.answeredAt) await this.d.log.answered(jobId);
    await this.pass();
  }

  /** Settles once no pass runs and every lane is idle (the tests wait on it). */
  async idle(): Promise<void> {
    do {
      await this.passing;
      await Promise.all(this.d.lanes.map((l) => l.idle()));
    } while (this.passing);
  }

  /** One pass: at most one job started in each served repo. A pass asked for while one
   *  runs runs once more after it, never beside it. */
  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.passing) {
      this.again = true;
      return this.passing;
    }
    // the last check for another pass and the release are in one continuation, so a pass asked
    // for at any moment either sets `again` before that check or finds no pass running (F2)
    this.passing = (async () => {
      try {
        do {
          this.again = false;
          await this.passOnce();
        } while (this.again && !this.stopped);
      } finally {
        this.passing = null;
      }
    })();
    return this.passing;
  }

  /** Since when the repo's work has waited for a job: when its last one ended (one that
   *  never reached a thread aside), or 0 (the longest) for none (`_waited`). */
  private waited(repo: BuildRepo): number {
    const at = this.d.log.lastEnded(repo.id, REPO_JOB_KINDS);
    return at ? Date.parse(at) : 0;
  }

  /** Why the repo gets no new job this pass before any lane is asked, or null. */
  private held(repo: BuildRepo): string | null {
    const jobs = this.d.log.jobs().filter((j) => j.repo === repo.id);
    const open = jobs.find((j) => REPO_JOB_KINDS.includes(j.kind) && !j.end);
    if (open) return `${open.title} is its job (one job per repo)`;
    if (this.d.lanes.some((l) => l.busy(repo))) return 'its job is under way (one job per repo)';
    const user = this.d.log.needingUser(repo.id)[0];
    if (user) return `${user.title} needs you first`;
    const lookUp = jobs.find((j) => j.kind === 'build' && j.github && j.end?.outcome === 'done' && j.end.pr === undefined);
    if (lookUp) return `${lookUp.title}'s PR isn't known yet (its lookup failed; looked up again)`;
    const cut = jobs.filter((j) => REPO_JOB_KINDS.includes(j.kind) && j.end?.outcome === 'usage-limit').at(-1);
    if (cut && resumesAt(cut) > this.now().getTime()) {
      return `${cut.title} was cut off by a usage limit and comes first, after ${new Date(resumesAt(cut)).toISOString()}`;
    }
    return null;
  }

  private note(repo: BuildRepo, why: string | null) {
    if (why === null) { this.said.delete(repo.id); return; }
    if (this.said.get(repo.id) !== why) this.d.say(`${repo.title}: no new job now, ${why}`);
    this.said.set(repo.id, why);
  }

  private async passOnce() {
    for (const lane of this.d.lanes) lane.owed();
    const repos = this.d.repos().map((r, i) => ({ r, i }))
      .filter(({ r }) => r.github)
      .sort((a, b) => this.waited(a.r) - this.waited(b.r) || a.i - b.i)
      .map(({ r }) => r);
    for (const repo of repos) {
      if (this.stopped) return;
      const held = this.held(repo);
      if (held) { this.note(repo, held); continue; }
      let failed: string | null = null;
      for (const lane of this.d.lanes) {
        let next: Next;
        try {
          next = await lane.next(repo);
        } catch (e) {
          // a read that failed is never "nothing to do": the repo is left for the next pass
          failed = `${(e as Error).message}; tried again next pass`;
          break;
        }
        if (this.stopped) return;
        if (next === null) continue;
        // the job let in is counted by the gate from now: the pass goes on once T3 has it, so the
        // next repo's verdict counts this one
        if ('launch' in next) await next.launch();
        break;
      }
      this.note(repo, failed);
    }
  }
}

/** When a job a usage limit cut off may go on: T3's reset (and AFTER_RESET_MS), or
 *  LIMIT_UNKNOWN_MS after its end with none, as the gate holds its provider. */
function resumesAt(job: Job): number {
  const reset = job.end!.resetAt ? Date.parse(job.end!.resetAt) : NaN;
  return Number.isNaN(reset) ? Date.parse(job.end!.at) + LIMIT_UNKNOWN_MS : reset + AFTER_RESET_MS;
}
