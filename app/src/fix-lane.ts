// The fix lane (#156; today's `queue_runner/fix.py`, ported, with the owner's 2026-11-19 decision
// on the ticket): a PR whose newest review, the app's own of its head H, is blocking gets one fix
// round on H. The round goes back to the thread that wrote the PR (`t3_thread_send`), so it starts
// with that thread's context instead of reading everything again; a fresh reviewer then reviews
// the new head (the review lane), and the app decides clean or blocking from that review's ledger.
//
//   the blocking review on H, still the PR's newest review comment, no round on H yet, nothing
//   writing to the branch  ->  the PR's head fetched (moved since listing: nothing starts)
//   ->  the brief (src/briefs/fix.ts)
//   ->  sent to the PR's writer thread (the builder's, or a fresh fixer's that took over), on the
//       model that thread runs on, if the gate has room there
//       or, when a review says an earlier finding is still not fixed, the PR has no writer thread
//       of the app's, or T3 turned the send down: a fresh fixer, a new thread on the fix kind's
//       settings in the PR's worktree (or a new one at H), which writes the PR from then on
//   ->  its end from T3's thread events; the PR's head read again: pushed, or left for the user
//   ->  the end recorded and the thread settled, then the review lane passes (`ended`)
//
// **When a round starts is the chooser's** (src/chooser.ts, #210): one job per repo, so no
// round starts while another job of the repo's runs. A build or fix on the branch that waits on a
// question or was cut off by a usage limit may write again: no round beside it; the review lane
// waits on a fix round too. One round per head: a round on H that ended without a push leaves the
// PR at H, which was reviewed already, so it waits for the user.
//
// **After a restart, don't guess** (#154, #155): a round is tied to a thread only by the id T3 gave
// the app's own launch, or the id it sent to, saved before the send. A round the log shows open
// with its thread line is watched again (a sent round on its new run, told apart from the runs the
// thread had before by `knownRuns`). A send whose answer was lost, or that the app stopped before T3
// answered, is decided by reading the thread: until a read succeeds it stays open, its repo held,
// and is read again on later passes; a read that leaves doubt, and a launch whose answer was lost
// (`NoAnswer`), need the user: its repo starts nothing until they answer.
import { fixBrief, type FixWhere } from './briefs/fix.ts';
import type { BuildRepo } from './build-lane.ts';
import { holdText } from './gate.ts';
import type { FixGit } from './git.ts';
import type { GitHubMerge, GitHubReview, ReviewPull } from './github.ts';
import { REVIEWED, settles, type Job, type JobEnd, type JobLog } from './job-log.ts';
import { kindModels, type Catalog, type Jobs, type ModelChoice } from './jobs.ts';
import { launchJob } from './launch.ts';
import { closedIssues, JOB_BRANCH_PREFIX } from './picker.ts';
import { readReviews, state, type Finding, type Review } from './review/ledger.ts';
import type { RepoJobLane, Next } from './chooser.ts';
import { ThreadSettler } from './settle.ts';
import { ToolFailed, type T3Mcp } from './t3/mcp.ts';
import type { Retry } from './t3/project-feed.ts';
import { NoAnswer } from './t3/seams.ts';
import { watchThreadEnd, type ThreadEnd } from './t3/thread-end.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

export type FixLaneDoors = {
  repos: () => BuildRepo[];
  github: Pick<GitHubReview, 'pullsToReview' | 'issueComments'> & Pick<GitHubMerge, 'pull'>;
  git: Pick<FixGit, 'fetchPr' | 'log' | 'diffstat' | 'worktrees'> & { hasBranch(folder: string, branch: string): Promise<boolean> };
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe' | 'request'>;
  gate: Pick<UsageGate, 'pick' | 'check' | 'started' | 'finished' | 'dropped' | 'forget'>;
  catalog: () => Catalog | null;
  jobs: () => Jobs;
  user: () => Promise<string>;
  log: JobLog;
  exists: (path: string) => boolean;
  say: (line: string) => void;
  /** A round ended (the review lane passes: its pushed head is reviewed next). */
  ended?: (job: Job) => void;
  /** A round is over, or started nothing: the chooser passes. */
  freed?: () => void;
  restMs?: number;
  retry?: Retry;
  now?: () => Date;
};

export const fixTitle = (repo: BuildRepo, n: number) => `Queue runner fix: ${repo.title}#${n}`;
/** The local branch a fresh fixer's new worktree is made on, from H; it never goes to origin: the
 *  round pushes to the PR's own branch. */
export const fixBranch = (n: number, sha: string) => `${JOB_BRANCH_PREFIX}fix-pr${n}-${sha.slice(0, 7)}`;

/** How a round's end says its thread can't take a turn (gone, archived...), so the next round
 *  goes to a fresh fixer. */
const GONE_MARK = "can't take another turn";
/** What T3 answers a send with when it refuses before it dispatches anything (its server's
 *  sendToThread, read 2026-11-19): the thread deleted, archived, or its provider instance switched
 *  off. The thread can't take a turn, and nothing ran (F9). Any other failure (`orchestration_error`
 *  can come after the turn was dispatched) leaves the outcome unknown (F4). */
const NOT_SENDABLE = new Set(['thread_not_found', 'thread_not_sendable', 'invalid_request']);
/** How T3 says a thread isn't there, on MCP (`not_found`) or in a WebSocket failure. */
const GONE = /not[_ ]?found|no such thread|does not exist|was deleted/i;
const goneText = (threadId: string, why: string) => `the PR's writer thread ${threadId} is gone in T3, so it ${GONE_MARK} (${why})`;
const refusedText = (threadId: string, why: string) => `the PR's writer thread ${threadId} ${GONE_MARK}: T3 refused the send (${why})`;

/** How long a send whose outcome isn't known waits, after its thread couldn't be read, before a
 *  pass reads the thread again (#210 F6). */
export const SEND_READ_MS = 60_000;

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;
/** A job on the branch that ended on a question or a usage limit: it may write to it again. */
const MAY_WRITE_AGAIN = (j: Job) => j.end?.outcome === 'waiting' || j.end?.outcome === 'usage-limit';

/** Whether the blocking `review` of the PR's head H gets its fix round now (the PR's reviews to
 *  brief from) or why not: the one rule for it, which the lane's pass and the conflict lane's hold
 *  both ask (#157 F7). `on` says what it waits on: `loop`, the round on H running or cut off by a
 *  usage limit, or another job that may write to the branch again; `you`, a question, a round on
 *  H that ended, or a newest review comment that isn't this review. A job running in the repo is
 *  the chooser's to wait on (one job per repo). */
export async function fixNext(d: { log: JobLog; github: Pick<GitHubReview, 'issueComments'> }, repo: BuildRepo, pr: ReviewPull, review: Job):
  Promise<{ why: string; on: 'loop' | 'you' } | { reviews: Review[] }> {
  const h7 = pr.headSha.slice(0, 7);
  const jobs = d.log.jobs().filter((j) => j.repo === repo.id);
  // one round per head: one that ran on H (any end but not-started) is the last on H
  const rounds = jobs.filter((j) => j.kind === 'fix' && j.issue === pr.number && j.sha === pr.headSha && j.end?.outcome !== 'not-started');
  const last = rounds.at(-1);
  if (last) {
    if (!last.end) return { why: 'its fix round is still running', on: 'loop' };
    if (last.end.outcome === 'waiting') return { why: 'its fix round waits for an answer', on: 'you' };
    if (last.end.outcome === 'usage-limit') return { why: 'its fix round was cut off by a usage limit and resumes after the reset', on: 'loop' };
    return { why: `a fix round on ${h7} ended ${last.end.outcome} and the head is still ${h7}: left for you`, on: 'you' };
  }
  // a job on the branch that may write to it again
  const writer = jobs.find((j) => j.kind !== 'review' && j.branch === pr.branch && MAY_WRITE_AGAIN(j));
  if (writer) return { why: `a ${writer.kind} job is writing to ${pr.branch}`, on: writer.end?.outcome === 'waiting' ? 'you' : 'loop' };
  const reviews = readReviews(await d.github.issueComments(repo.github!, pr.number));
  const newest = reviews.at(-1);
  if (!newest || newest.round !== review.round || !pr.headSha.startsWith(newest.sha) || newest.verdict !== 'blocking') {
    return { why: `its newest review comment is not the blocking review ${review.round} of ${h7}`, on: 'you' };
  }
  return { reviews };
}

/** What a round goes out on: sent to a thread, or a fresh fixer. */
type Plan =
  | { send: Job; why?: never }
  | { send?: never; why: string };

/** A round that started no thread, for a reason the lane gives. */
class NotStarted extends Error {}
/** The writer thread is gone in T3: the round goes to a fresh fixer at once (F3). */
class ThreadGone extends Error {}

export class FixLane implements RepoJobLane {
  private d: FixLaneDoors;
  private now: () => Date;
  private settler: ThreadSettler;
  /** Rounds under way, by `owner/name#n`. */
  private running = new Map<string, Promise<Job | null>>();
  private watches = new Set<{ stop(): void }>();
  private why = new Map<string, string | null>();
  private resting = new Map<string, number>();
  private stopped = false;
  /** Writer threads T3 says are gone: their PRs' rounds go to fresh fixers. */
  private gone = new Set<string>();
  /** Sends whose outcome isn't known and whose thread couldn't be read, by job id: when a pass
   *  reads it again, with the thread's link and why the send's outcome isn't known. */
  private reread = new Map<string, { at: number; link: string | null; why: string }>();

  constructor(doors: FixLaneDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Each round the log shows open is watched again (or needs the user). */
  recover(): void {
    for (const job of this.d.log.open()) {
      if (job.kind !== 'fix') continue;
      this.track(`${job.github}#${job.issue}`, this.resume(job));
    }
    // one waiting on a question: watched until its thread has finished again (#210 F5)
    for (const job of this.d.log.waiting()) {
      if (job.kind !== 'fix' || !job.threadId) continue;
      this.track(`${job.github}#${job.issue}`, this.untilFinished(job));
    }
  }

  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
  }

  usageChanged(): boolean {
    return [...this.why.values()].some((w) => w?.startsWith('waits:'));
  }

  busy(repo: BuildRepo): boolean {
    return [...this.running.keys()].some((k) => k.startsWith(`${repo.github}#`));
  }

  async idle(): Promise<void> {
    while (this.running.size || this.settler.pending().length) {
      await Promise.allSettled([...this.running.values(), ...this.settler.pending()]);
    }
  }

  private note(key: string, name: string, why: string | null) {
    if (why && this.why.get(key) !== why) this.d.say(`${name}: no fix round now, ${why}`);
    this.why.set(key, why);
  }

  private track(key: string, round: Promise<Job | null>) {
    this.running.set(key, round);
    round.then((job) => {
      if (job?.end && !this.stopped) this.d.ended?.(job);
    }, (e) => this.d.say(`a fix round on ${key} stopped: ${(e as Error).message}`)).finally(() => {
      this.running.delete(key);
      if (!this.stopped) this.d.freed?.();
    });
  }

  owed(): void {
    this.settler.owed('fix');
    // a send whose thread couldn't be read: read again once its wait is over (F6)
    const now = this.now().getTime();
    for (const [id, r] of this.reread) {
      const job = this.d.log.get(id);
      if (!job || job.end || job.threadId || !job.to) { this.reread.delete(id); continue; }
      const key = `${job.github}#${job.issue}`;
      if (r.at > now || this.running.has(key)) continue;
      this.track(key, this.unknownSend(job, job.to, r.link, job.knownRuns ?? [], new Error(r.why), () => {}));
    }
  }

  /** The repo's next fix round: the lowest-numbered PR whose blocking review gets its round now
   *  and that the gate lets in. One the gate holds waits, and so does the repo unless a later PR's
   *  round fits; a read that fails throws. */
  async next(repo: BuildRepo): Promise<Next> {
    if (this.stopped || !repo.github) return null;
    let pulls: ReviewPull[];
    try {
      pulls = (await this.d.github.pullsToReview(repo.github)).sort((a, b) => a.number - b.number);
    } catch (e) {
      throw new Error(`GitHub couldn't be read for fix rounds (${(e as Error).message})`);
    }
    let waits: string | null = null;
    for (const pr of pulls) {
      if (this.stopped) return null;
      const key = `${repo.github}#${pr.number}`;
      const name = `fix ${repo.title}#${pr.number}`;
      const blocking = this.blockingReview(repo, pr);
      if (!blocking) { this.why.delete(key); continue; }
      let ready: { why: string } | { reviews: Review[] };
      try {
        ready = await this.whyNot(repo, pr, blocking);
      } catch (e) {
        throw new Error(`PR #${pr.number} couldn't be read for its fix round (${(e as Error).message})`);
      }
      if ('why' in ready) { this.note(key, name, ready.why); continue; }
      if ((this.resting.get(key) ?? 0) > this.now().getTime()) continue;
      // a fork's PR: a fixer would push to this repo's branch of that name (a fork's `main` is
      // this repo's `main`), so none does; it needs the user (N2), and the repo waits on them
      if (pr.headRepo !== undefined && pr.headRepo?.toLowerCase() !== repo.github.toLowerCase()) {
        await this.forked(repo, pr, blocking);
        return { waits: `PR #${pr.number} is a fork's: it needs you` };
      }
      const plan = this.plan(repo, pr, blocking, ready.reviews);
      const letIn = this.letIn(key, name, plan);
      if (!letIn) { waits ??= this.why.get(key) ?? 'the gate holds it'; continue; }
      this.why.set(key, null);
      // the gate counts the round from now; the chooser goes on once T3 has it, so the next
      // repo's verdict counts this one
      return {
        launch: () => new Promise<void>((launched) => {
          this.track(key, this.round(repo, pr, blocking, ready.reviews, plan, letIn, launched).finally(launched));
        }),
      };
    }
    return waits === null ? null : { waits };
  }

  /** The app's newest review of the PR's head, if it's blocking. */
  private blockingReview(repo: BuildRepo, pr: ReviewPull): Job | null {
    const done = this.d.log.jobs().filter((j) => j.kind === 'review' && j.repo === repo.id && j.issue === pr.number
      && j.sha === pr.headSha && j.end && REVIEWED.includes(j.end.outcome));
    const last = done.at(-1);
    return last?.end?.outcome === 'blocking' ? last : null;
  }

  /** Why the PR gets no round on its head now, or the PR's reviews to brief from (`fixNext`). */
  private whyNot(repo: BuildRepo, pr: ReviewPull, review: Job): Promise<{ why: string } | { reviews: Review[] }> {
    return fixNext(this.d, repo, pr, review);
  }

  /** Where the round goes: back to the PR's writer thread, or to a fresh fixer, and why. */
  private plan(repo: BuildRepo, pr: ReviewPull, review: Job, reviews: Review[]): Plan {
    // a review that marks an earlier finding still not fixed: the writer is stuck there
    const stuck = state(reviews).filter((f) => f.tag === 'important' && f.status === 'open' && f.raised < review.round!);
    if (stuck.length) return { why: `review ${review.round} marks ${stuck.map((f) => f.id).join(', ')} still not fixed after an earlier round` };
    const jobs = this.d.log.jobs().filter((j) => j.repo === repo.id && j.branch === pr.branch);
    // the thread that writes the PR: its builder's, or the fresh fixer's that took over since
    const writer = jobs.filter((j) => j.threadId && (j.kind === 'build' || (j.kind === 'fix' && j.fresh))).at(-1);
    if (!writer) return { why: "no thread of the app's wrote this PR" };
    const gone = this.gone.has(writer.threadId!) ? 'T3 says so'
      : jobs.some((j) => j.kind === 'fix' && j.to === writer.threadId && j.end?.error?.includes(GONE_MARK)) ? `a round sent to it found it can't take a turn` : null;
    if (gone) return { why: goneText(writer.threadId!, gone) };
    return { send: writer };
  }

  /** The gate's word: on the writer thread's model for a send, on the fix kind's for a fresh
   *  fixer. Null when it holds the round (said once). */
  private letIn(key: string, name: string, plan: Plan): { choice: ModelChoice; onFallback: boolean; cost: Record<string, number> } | null {
    const id = `fix:${key}`;
    if (plan.send) {
      const v = this.d.gate.check({ id, kind: 'fix', choice: plan.send.choice });
      if (v.fits) { this.d.gate.forget(id); return { choice: plan.send.choice, onFallback: false, cost: v.cost }; }
      this.note(key, name, `waits: ${holdText(v.hold, (d) => d.toISOString())}`);
      return null;
    }
    const v = this.d.gate.pick(id, 'fix');
    if (!v.fits) {
      this.note(key, name, `waits: ${holdText(v.hold, (d) => d.toISOString())}`);
      return null;
    }
    this.d.gate.forget(id);
    return v;
  }

  /** One fix round on H, start to end. */
  private async round(repo: BuildRepo, pr: ReviewPull, review: Job, reviews: Review[], plan: Plan,
    letIn: { choice: ModelChoice; onFallback: boolean; cost: Record<string, number> }, onLaunched: () => void): Promise<Job | null> {
    const n = pr.number;
    const h = pr.headSha;
    const name = `fix ${repo.title}#${n}`;
    const title = fixTitle(repo, n);
    let where: FixWhere;
    let worktreePath: string | null = null;
    let brief: string;
    let knownRuns: string[] = [];
    try {
      const fetched = await this.d.git.fetchPr(repo.folder, n, pr.base);
      if (fetched !== h) throw new NotStarted(`the head moved from ${h.slice(0, 7)} to ${fetched.slice(0, 7)}; it's reviewed first`);
      if (plan.send) {
        where = { kind: 'thread' };
        // the runs the thread has now: its new one is the round's, also after a restart. A thread
        // that's gone takes no round: a fresh fixer does (F3)
        const runs = await this.threadRuns(plan.send.threadId!);
        if (runs === 'gone') throw new ThreadGone(plan.send.threadId!);
        knownRuns = runs;
      } else {
        const own = (await this.d.git.worktrees(repo.folder)).find((w) => w.branch === pr.branch);
        if (own) {
          where = { kind: 'worktree' };
          worktreePath = own.path;
        } else {
          where = { kind: 'new', work: fixBranch(n, h) };
          if (await this.d.git.hasBranch(repo.folder, where.work)) throw new NotStarted(`a local branch ${where.work} is left from an earlier round`);
        }
      }
      brief = await this.brief(repo, pr, review, reviews, where, plan.why ?? null);
    } catch (e) {
      if (e instanceof ThreadGone) {
        this.gone.add(e.message);
        this.d.say(`${name}: ${goneText(e.message, 'T3 says so')}; a fresh fixer takes the round`);
        onLaunched();
        return null; // the pass after this one plans it fresh
      }
      return this.notStartedBefore(repo, pr, name, e, onLaunched);
    }
    const job = await this.d.log.started({
      kind: 'fix', repo: repo.id, github: repo.github, issue: n, branch: pr.branch, base: pr.base, title,
      choice: letIn.choice, onFallback: letIn.onFallback, cost: letIn.cost, sha: h, round: review.round!,
      ...(plan.send ? { to: plan.send.threadId!, knownRuns } : { fresh: plan.why! }),
      ...(where.kind === 'new' ? { workBranch: where.work } : {}),
    });
    this.d.gate.started({ id: job.id, kind: 'fix', choice: letIn.choice }, letIn.cost);
    if (!this.d.repos().some((r) => r.id === repo.id)) return this.notStarted(job, `${repo.title} is no longer served`);
    let thread: { threadId: string; runId: string | null; link: string | null };
    try {
      if (plan.send) {
        this.d.say(`${name}: review ${review.round} of ${h.slice(0, 7)} goes back to its thread ${plan.send.link ?? plan.send.threadId}`);
        const sent = await this.d.mcp.call('t3_thread_send', { threadId: plan.send.threadId, message: brief, mode: 'queue' });
        thread = { threadId: plan.send.threadId!, runId: typeof sent?.runId === 'string' ? sent.runId : null, link: plan.send.link ?? null };
      } else {
        const catalog = this.d.catalog();
        if (!catalog) return this.notStarted(job, "T3's providers aren't known yet");
        this.d.say(`${name}: a fresh fixer takes review ${review.round} of ${h.slice(0, 7)}: ${plan.why}`);
        const launched = await launchJob(this.d.mcp, catalog, {
          kind: 'fix', projectId: repo.id, title, brief, choice: letIn.choice,
          ...(worktreePath ? { worktreePath } : { worktree: { baseRef: h, branch: (where as { work: string }).work } }),
        });
        thread = { threadId: launched.threadId, runId: launched.runId, link: launched.link };
      }
    } catch (e) {
      // a send whose outcome isn't known (its answer lost, or T3 answering a failure after it may
      // have taken it) is never "not started" (F4): the thread is read, and it's the new run there
      // T3 refused the send before it dispatched anything: the thread can't take a turn, so the
      // next pass sends a fresh fixer (F9)
      if (plan.send && e instanceof ToolFailed && e.code !== null && NOT_SENDABLE.has(e.code)) {
        this.gone.add(plan.send.threadId!);
        const text = e.code === 'thread_not_found' ? goneText(plan.send.threadId!, e.message) : refusedText(plan.send.threadId!, e.message);
        return this.notStarted(job, text, false);
      }
      if (plan.send && (e instanceof NoAnswer || e instanceof ToolFailed)) {
        return this.unknownSend(job, plan.send.threadId!, plan.send.link ?? null, knownRuns, e as Error, onLaunched);
      }
      // a launch sent and its answer lost: T3 may have started the thread, and nothing says which
      if (e instanceof NoAnswer) return this.needsUser(job, (e as Error).message);
      // refused before it ran (a 4xx, a refused token), or never sent: nothing started
      return this.notStarted(job, (e as Error).message);
    }
    await this.d.log.thread(job.id, thread);
    // a fresh fixer's new worktree and its branch are the app's (F15); the PR's own worktree, or
    // the writer's thread a round was sent to, made nothing
    if (where.kind === 'new') await this.d.log.made(job.id, where.work);
    onLaunched();
    return this.watch({ ...job, ...thread });
  }

  /** A blocking review on a fork's PR: recorded as a round on H that needs the user, so its repo
   *  starts nothing until they answer and H gets no round after (one per head). No gate, no thread. */
  private async forked(repo: BuildRepo, pr: ReviewPull, review: Job): Promise<void> {
    const job = await this.d.log.started({
      kind: 'fix', repo: repo.id, github: repo.github, issue: pr.number, branch: pr.branch, base: pr.base, title: fixTitle(repo, pr.number),
      choice: { provider: '', model: '', effort: null }, onFallback: false, sha: pr.headSha, round: review.round!,
    });
    await this.needsUser(job, `PR #${pr.number}'s head is in ${pr.headRepo ?? 'a fork GitHub no longer has'}, not ${repo.github}: no fixer pushes to a fork's branch`);
  }

  /** The thread's run ids, oldest first, or `gone` when T3 says it isn't there. The projection
   *  failing otherwise is asked of T3's MCP, which says whether the thread is there; a thread
   *  that's there but couldn't be read throws, for the round to rest and try again. */
  private async threadRuns(threadId: string): Promise<string[] | 'gone'> {
    let why: string;
    try {
      const p = await this.d.ws.request('orchestration.getThreadProjection', { threadId });
      if (Array.isArray(p?.runs)) {
        return [...p.runs].sort((a: any, b: any) => (a?.ordinal ?? 0) - (b?.ordinal ?? 0))
          .map((r: any) => r?.id).filter((x: unknown): x is string => typeof x === 'string');
      }
      why = `T3 gave thread ${threadId} no runs`;
    } catch (e) {
      if (GONE.test((e as Error).message)) return 'gone';
      why = (e as Error).message;
    }
    try {
      await this.d.mcp.call('t3_thread_read', { threadId, limit: 1 });
    } catch (e) {
      if (e instanceof ToolFailed && GONE.test(e.message)) return 'gone';
      throw e;
    }
    throw new Error(`thread ${threadId}'s runs couldn't be read: ${why}`);
  }

  /** A send T3 may have taken: the thread read again. Gone, nothing ran and the next pass sends a
   *  fresh fixer; showing a run it didn't have before, that run is the round's, watched; showing
   *  none, the round needs the user (#154's rule). A thread that can't be read says nothing yet:
   *  the round stays open, its repo held, and a pass reads it again after SEND_READ_MS (F6). */
  private async unknownSend(job: Job, threadId: string, link: string | null, knownRuns: string[], e: Error, onLaunched: () => void): Promise<Job> {
    let runs: string[] | 'gone';
    try {
      runs = await this.threadRuns(threadId);
    } catch (r) {
      if (!this.reread.has(job.id)) {
        this.d.say(`${job.title}: the round sent to thread ${threadId} got no clear answer (${e.message}), and the thread can't be read now (${(r as Error).message}): read again on a later pass; nothing else starts in ${job.github ?? job.repo} meanwhile`);
      }
      this.reread.set(job.id, { at: this.now().getTime() + SEND_READ_MS, link, why: e.message });
      onLaunched();
      return job;
    }
    this.reread.delete(job.id);
    if (runs === 'gone') {
      this.gone.add(threadId);
      onLaunched();
      return this.notStarted(job, goneText(threadId, e.message), false);
    }
    const fresh = runs.filter((r) => !knownRuns.includes(r)).at(-1);
    if (!fresh) return this.needsUser(job, `the round sent to thread ${threadId} got no clear answer (${e.message}), and the thread shows no new run`);
    this.d.say(`${job.title}: T3 answered the send unclearly (${e.message}), but thread ${threadId} shows its new run ${fresh}: watching it`);
    const thread = { threadId, runId: fresh, link };
    await this.d.log.thread(job.id, thread);
    onLaunched();
    return this.watch({ ...job, ...thread });
  }

  private async brief(repo: BuildRepo, pr: ReviewPull, review: Job, reviews: Review[], where: FixWhere, fresh: string | null): Promise<string> {
    const github = repo.github!;
    const here = github.toLowerCase();
    const findings: Finding[] = state(reviews.filter((r) => r.round <= review.round!));
    const threads = this.d.log.jobs()
      .filter((j) => j.repo === repo.id && j.link && (j.branch === pr.branch || (j.kind === 'review' && j.issue === pr.number)))
      .map((j) => ({ kind: j.kind, startedAt: j.startedAt, outcome: j.end?.outcome ?? 'still open', link: j.link! }));
    return fixBrief({
      github, number: pr.number, title: pr.title, round: review.round!, sha: pr.headSha, branch: pr.branch, base: pr.base,
      user: await this.d.user(), where, fresh,
      agentsFile: this.d.exists(join(repo.folder, 'AGENTS.md')) ? 'AGENTS.md' : this.d.exists(join(repo.folder, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
      reviewLink: review.end?.link ?? null, findings, body: pr.body,
      closes: closedIssues(pr.body, here).map(([where_, k]) => (where_ === here ? `#${k}` : `${where_}#${k}`)),
      commits: await this.d.git.log(repo.folder, `origin/${pr.base}`, pr.headSha),
      diffstat: await this.d.git.diffstat(repo.folder, `origin/${pr.base}`, pr.headSha),
      threads,
    });
  }

  /** A step before the round's start line failed: nothing ran, nothing is held; the PR rests. */
  private notStartedBefore(repo: BuildRepo, pr: ReviewPull, name: string, e: unknown, onLaunched: () => void): null {
    onLaunched();
    const key = `${repo.github}#${pr.number}`;
    this.resting.set(key, this.now().getTime() + (this.d.restMs ?? 300_000));
    const why = e instanceof NotStarted ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
    this.d.say(`${name} not started: ${why}`);
    return null;
  }

  /** A round let in that started nothing: dropped from the gate, and the PR rests unless T3 turned
   *  the send down, when the next pass sends a fresh fixer at once. */
  private async notStarted(job: Job, error: string, rest = true): Promise<Job> {
    this.d.gate.dropped(job.id);
    if (rest) this.resting.set(`${job.github}#${job.issue}`, this.now().getTime() + (this.d.restMs ?? 300_000));
    this.d.say(`${job.title} not started: ${error}`);
    return this.d.log.ended(job.id, { outcome: 'not-started', error });
  }

  private needsUser(job: Job, why: string): Promise<Job> {
    this.d.gate.dropped(job.id);
    this.d.say(`${job.title} needs you: ${why}. T3 may have started its run; nothing else starts in ${job.github ?? job.repo} until you answer.`);
    return this.d.log.ended(job.id, { outcome: 'needs-user', error: why });
  }

  private async resume(job: Job): Promise<Job> {
    this.d.gate.started({ id: job.id, kind: 'fix', choice: job.choice }, job.cost ?? {});
    // a send the app stopped before T3 answered is one whose outcome isn't known (F4): the thread
    // read shows whether it took it
    if (!job.threadId && job.to) {
      return this.unknownSend(job, job.to, null, job.knownRuns ?? [], new Error('the app stopped before T3 answered the round sent to its thread'), () => {});
    }
    if (!job.threadId) return this.needsUser(job, 'the app stopped before T3 named its thread');
    this.d.say(`Watching ${job.title} again: ${job.link ?? job.threadId}`);
    return this.watch(job);
  }

  /** A round waiting on a question: watched until its thread has finished again (the user may
   *  answer it in T3, not only through the app), its repo held meanwhile, and that end recorded
   *  in the question's place (#210 F5). A thread that can't be read holds it too: the watch opens
   *  its stream again until T3 answers. */
  private untilFinished(job: Job): Promise<Job> {
    if (this.stopped) return Promise.resolve(job);
    this.d.say(`${job.title} waits on a question: nothing else starts in ${job.github ?? job.repo} until its thread ${job.link ?? job.threadId} has finished, answered in T3 or here`);
    return this.watch(job, true);
  }

  private async watch(job: Job, asked = false): Promise<Job> {
    // after a question, the thread's newest run since the send: an answer may go on in its run or
    // start a new one
    const w = watchThreadEnd(this.d.ws, job.threadId!, asked ? null : job.runId ?? null, this.d.retry,
      (why) => this.d.say(`${job.title}: T3's thread stream dropped (${why}); opening it again`), new Set(job.knownRuns ?? []), asked ? 'wait' : 'end');
    this.watches.add(w);
    let end: ThreadEnd;
    try {
      end = await w.end;
    } finally {
      this.watches.delete(w);
    }
    // the gate measured the job at its question; the run on the answer isn't let in again
    if (!asked) this.d.gate.finished(job.id, end.outcome === 'usage-limit' ? { resetAt: end.resetAt } : undefined);
    const record: JobEnd = { outcome: end.outcome as JobEnd['outcome'], status: end.status };
    if (end.outcome === 'failed') record.error = end.error;
    if (end.outcome === 'usage-limit') Object.assign(record, { resetAt: end.resetAt, error: end.error });
    if (end.outcome === 'waiting') record.request = end.request;
    if (end.outcome === 'done') {
      try {
        record.head = (await this.d.github.pull(job.github!, job.issue)).headSha;
      } catch {
        record.head = null; // the review lane reads the head itself; this is only what's said
      }
    }
    const ended = await this.d.log.ended(job.id, record);
    const pushed = record.head && record.head !== job.sha ? `, pushed ${record.head.slice(0, 7)}: reviewed next`
      : record.head === job.sha ? `, without a push: the PR waits for you` : '';
    this.d.say(`${job.title} ended: ${record.outcome}${pushed} ${job.link ?? job.threadId}`);
    if (record.outcome === 'waiting') return this.untilFinished(ended);
    if (settles(record.outcome)) await this.settler.settle(job);
    return ended;
  }
}
