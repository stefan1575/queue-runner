// The conflict lane (#157; today's conflict rounds in `queue_runner/fix.py` and `stops.py`, ported,
// `docs/flow.md` A round, step 1): a PR whose head H conflicts with its base gets a fresh thread on
// the conflict kind's settings, in the PR's own worktree (or a new one at H), that merges the base
// in, resolves the conflict and pushes; a fresh reviewer then reviews the new head (the review lane).
//
//   GitHub says H can't merge (`mergeable: false`; null, still working it out, is not known yet:
//   that PR, and every newer one, waits for GitHub's answer on a later pass)
//   ->  nothing writes to the branch, no review of the PR is running, H's blocking review has had
//       its fix round, nothing on H is left for the user, it's no stop  ->  oldest first, one at a
//       time  ->  the gate (kind `conflict`)  ->  the PR's head fetched (moved: nothing starts), the
//       base's own tip read from GitHub  ->  the brief (src/briefs/conflict.ts)  ->  a new thread
//   ->  its end from T3's thread events; the PR's head read again: pushed (reviewed next) or not,
//       which is a stop  ->  the end recorded and the thread settled, then the review lane passes
//
// **One conflicted PR at a time** in a repo, lowest number first: while another open PR that had a
// conflict round is still being moved by the loop (`moving`: a job on it, a review, fix round or
// merge the lanes will start on their own, asked of those lanes' own rules), it's on its way to
// merging, and the next waits, so each resolves against the base it lands on. One that waits on the
// user (a draft, a question, a stop, a failed check, reviews that failed past the review lane's
// cut-off, a clean review where the user merges, a reply or open thread the merge waits on), or on
// checks that never report past NO_CHECKS_GRACE_MS, holds nothing (#157 F6, F7). One that conflicts again waits its own turn, so it holds back only
// higher numbers: two such PRs never wait for each other.
//
// **Another round once the base moves, never a stop** (#158): a conflict a round couldn't resolve
// (it ended without a push, or the PR conflicts again) waits while the base's tip is still the one
// that round merged, and gets another round once it moves. A round that failed gets another at
// once. Each counts toward the cap (src/cap.ts): at it, the PR stops for a rethink instead, with
// an Approach note. "The base moved" is read from the base branch's own tip (GitHub's branches
// API), never the PR's `base.sha`, which GitHub refreshes only when the PR's branch is pushed: it
// stays at the base the last round merged however far the base has moved. A round that stops on a
// question is a stop for the user (src/stops.ts files it).
//
// **After a restart, don't guess** (#154): a round is tied to a thread only by the id T3 gave the
// app's own launch. One the log shows open with its thread line is watched again; one without, and
// a launch whose answer was lost (`NoAnswer`), need the user: the repo starts nothing until they
// answer. What the launch made (a new worktree's branch) is a `made` line (#156 F15).
import type { BuildRepo } from './build-lane.ts';
import { conflictBrief, type ConflictWhere } from './briefs/conflict.ts';
import { holdText } from './gate.ts';
import type { FixGit } from './git.ts';
import type { GitHubMerge, GitHubReview, ReviewPull } from './github.ts';
import { fixNext } from './fix-lane.ts';
import { mergeNext } from './merge-lane.ts';
import { reviewNext } from './review-lane.ts';
import { capReached, capText, roundsSinceAnswer } from './cap.ts';
import { REVIEWED, settles, writes, type Job, type JobEnd, type JobLog } from './job-log.ts';
import type { Catalog, ModelChoice } from './jobs.ts';
import { launchJob } from './launch.ts';
import { closedIssues, JOB_BRANCH_PREFIX } from './picker.ts';
import { ThreadSettler } from './settle.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { Retry } from './t3/project-feed.ts';
import { NoAnswer } from './t3/seams.ts';
import { watchThreadEnd, type ThreadEnd } from './t3/thread-end.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

export type ConflictLaneDoors = {
  repos: () => BuildRepo[];
  github: Pick<GitHubReview, 'pullsToReview' | 'checks' | 'issueComments' | 'reviewReplies'> & Pick<GitHubMerge, 'pull' | 'branchHead' | 'openThreads'>;
  git: Pick<FixGit, 'fetchPr' | 'log' | 'diffstat' | 'worktrees'> & { hasBranch(folder: string, branch: string): Promise<boolean> };
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe'>;
  gate: Pick<UsageGate, 'pick' | 'started' | 'finished' | 'dropped' | 'forget'>;
  catalog: () => Catalog | null;
  user: () => Promise<string>;
  log: JobLog;
  exists: (path: string) => boolean;
  say: (line: string) => void;
  /** A round ended (the review lane passes: its pushed head is reviewed next). */
  ended?: (job: Job) => void;
  restMs?: number;
  retry?: Retry;
  now?: () => Date;
};

/** How long a head a conflict round pushed, with no checks reported on it, still holds the repo's
 *  other conflicted PRs: CI reports within minutes, and a repo with none never does (#157 F7). */
export const NO_CHECKS_GRACE_MS = 10 * 60_000;

export const conflictTitle = (repo: BuildRepo, n: number) => `Queue runner conflict: ${repo.title}#${n}`;
/** The local branch a round's new worktree is made on, from H and the base tip it merges; it never
 *  goes to origin: the round pushes to the PR's own branch. Not the fix round's name, so the two
 *  never meet on one head, and the base's tip in it, since H gets another round once the base
 *  moves (#158). */
export const conflictBranch = (n: number, sha: string, base: string) => `${JOB_BRANCH_PREFIX}conflict-pr${n}-${sha.slice(0, 7)}-${base.slice(0, 7)}`;

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;
const WRITING = writes;
/** A round that got as far as its thread (or may have): every end but `not-started`. */
const RAN = (j: Job) => j.end?.outcome !== 'not-started';

/** A round that started no thread, for a reason the lane gives. */
class NotStarted extends Error {}

export class ConflictLane {
  private d: ConflictLaneDoors;
  private now: () => Date;
  private settler: ThreadSettler;
  /** Rounds under way, by `owner/name#n`. */
  private running = new Map<string, Promise<Job | null>>();
  private watches = new Set<{ stop(): void }>();
  private why = new Map<string, string | null>();
  private resting = new Map<string, number>();
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(doors: ConflictLaneDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Each round the log shows open is watched again (or needs the user), then a pass. */
  start(): Promise<void> {
    for (const job of this.d.log.open()) {
      if (job.kind !== 'conflict') continue;
      this.track(`${job.github}#${job.issue}`, this.resume(job));
    }
    return this.pass();
  }

  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
  }

  usageChanged(): void {
    if ([...this.why.values()].some((w) => w?.startsWith('waits:'))) void this.pass();
  }

  async answered(jobId: string): Promise<void> {
    if (!this.d.log.get(jobId)?.answeredAt) await this.d.log.answered(jobId);
    await this.pass();
  }

  async idle(): Promise<void> {
    while (this.running.size || this.passing || this.settler.pending().length) {
      await Promise.allSettled([...this.running.values(), this.passing, ...this.settler.pending()]);
    }
  }

  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.passing) {
      this.again = true;
      return this.passing;
    }
    this.passing = (async () => {
      do {
        this.again = false;
        await this.passOnce();
      } while (this.again && !this.stopped);
    })().finally(() => { this.passing = null; });
    return this.passing;
  }

  private note(key: string, name: string, why: string | null) {
    if (why && this.why.get(key) !== why) this.d.say(`${name}: no conflict round now, ${why}`);
    this.why.set(key, why);
  }

  private track(key: string, round: Promise<Job | null>) {
    this.running.set(key, round);
    round.then((job) => {
      if (job?.end && !this.stopped) this.d.ended?.(job);
    }, (e) => this.d.say(`a conflict round on ${key} stopped: ${(e as Error).message}`)).finally(() => {
      this.running.delete(key);
      if (!this.stopped) void this.pass();
    });
  }

  private async passOnce() {
    this.settler.owed('conflict');
    for (const repo of this.d.repos()) {
      if (this.stopped) return;
      if (!repo.github || this.d.log.needingUser(repo.id).length) continue;
      let pulls: ReviewPull[];
      // GitHub's word on each open PR: it conflicts (true), or not (false), or it's still working it
      // out (null: not known yet, read again next pass). One read failing leaves the repo for the
      // next pass: who goes first needs them all.
      const conflicts = new Map<number, boolean | null>();
      try {
        pulls = (await this.d.github.pullsToReview(repo.github)).sort((a, b) => a.number - b.number);
        for (const pr of pulls) {
          const mergeable = (await this.d.github.pull(repo.github, pr.number)).mergeable;
          conflicts.set(pr.number, mergeable === null ? null : !mergeable);
        }
      } catch (e) {
        this.note(`${repo.github}`, repo.title, `GitHub couldn't be read for conflicts (${(e as Error).message})`);
        continue;
      }
      this.why.delete(repo.github);
      let first: ReviewPull | null = null;
      // oldest first: a PR GitHub hasn't answered for may conflict, so no newer one goes before it
      let unknown: ReviewPull | null = null;
      for (const pr of pulls) {
        if (this.stopped) return;
        const key = `${repo.github}#${pr.number}`;
        const name = `conflict ${repo.title}#${pr.number}`;
        if (this.running.has(key)) continue;
        if (conflicts.get(pr.number) === null) {
          // the PR's own writer or review aside, nothing acts on it until GitHub says
          unknown ??= pr;
          this.note(key, name, `GitHub hasn't worked out yet whether ${pr.headSha.slice(0, 7)} conflicts with ${pr.base}; read again next pass`);
          continue;
        }
        if (!conflicts.get(pr.number)) { this.why.delete(key); continue; }
        // one conflicted PR at a time: a round running in the repo holds every other
        const running = [...this.running.keys()].find((k) => k.startsWith(`${repo.github}#`));
        let why: string | null = running ? `the conflict round on PR #${running.slice(repo.github.length + 1)} runs first: one conflicted PR at a time` : null;
        try {
          why ??= await this.whyNot(repo, pr, pulls, conflicts);
        } catch (e) {
          why = `reading it failed (${(e as Error).message})`;
        }
        if (!why && first) why = `PR #${first.number} resolves its conflict first: one conflicted PR at a time`;
        if (!why && unknown) why = `GitHub hasn't said yet whether the older PR #${unknown.number} conflicts: oldest first`;
        if (why) { this.note(key, name, why); continue; }
        first = pr;
        // the gate counts the round from now; the pass goes on once T3 has it
        const v = this.d.gate.pick(`conflict:${key}`, 'conflict');
        if (!v.fits) { this.note(key, name, `waits: ${holdText(v.hold, (d) => d.toISOString())}`); continue; }
        this.d.gate.forget(`conflict:${key}`);
        this.why.set(key, null);
        await new Promise<void>((launched) => {
          this.track(key, this.round(repo, pr, v, launched).finally(launched));
        });
      }
    }
  }

  /** Why the conflicting PR gets no round now, or null: cheapest first. A stop found here is
   *  recorded. */
  private async whyNot(repo: BuildRepo, pr: ReviewPull, pulls: ReviewPull[], conflicts: Map<number, boolean | null>): Promise<string | null> {
    const h = pr.headSha;
    const h7 = h.slice(0, 7);
    const jobs = this.d.log.jobs().filter((j) => j.repo === repo.id);
    // one writer per PR
    const writer = jobs.find((j) => j.kind !== 'review' && j.branch === pr.branch && WRITING(j));
    if (writer) return `a ${writer.kind} job is writing to ${pr.branch}`;
    // a review under way decides on H first; the round would make it a review of a stale head
    if (jobs.some((j) => j.kind === 'review' && j.issue === pr.number && !j.end)) return `a review of PR #${pr.number} is running`;
    const review = this.newestReview(repo, pr);
    if (review?.end?.outcome === 'blocking' && !jobs.some((j) => j.kind === 'fix' && j.issue === pr.number && j.sha === h && RAN(j))) {
      return `review ${review.round} of ${h7} is blocking: its fix round comes first`;
    }
    const held = this.heldForUser(repo, pr);
    if (held) return `left for you: ${held}`;
    const wait = await this.conflictWait(repo, pr);
    if (wait) return wait;
    if ((this.resting.get(`${repo.github}#${pr.number}`) ?? 0) > this.now().getTime()) return 'its last round started no thread; it rests';
    for (const o of pulls) {
      if (o.number === pr.number || !(o.number < pr.number || conflicts.get(o.number) !== true)) continue;
      if (!jobs.some((j) => j.kind === 'conflict' && j.issue === o.number && RAN(j))) continue;
      // one whose conflict waits for the base to move holds nothing: the next PR's merge is what
      // moves it (#158)
      if (conflicts.get(o.number) === true && await this.conflictWait(repo, o)) continue;
      const moving = await this.moving(repo, o);
      if (moving) return `PR #${o.number} had a conflict round and is still on its way to merging (${moving}): one conflicted PR at a time`;
    }
    // the cap (#158): no round past it; the PR stops for a rethink, and src/stops.ts files it
    if (capReached(this.d.log, repo.id, pr.number)) {
      const why = capText(roundsSinceAnswer(this.d.log, repo.id, pr.number), `${h7} conflicts with ${pr.base} again`);
      await this.d.log.stopped({ cause: 'cap', repo: repo.id, github: repo.github!, pr: pr.number, sha: h, why, link: null });
      this.d.say(`conflict ${repo.title}#${pr.number}: a stop for you, ${why}`);
      return `stopped for you: ${why}`;
    }
    return null;
  }

  /** What the loop is still doing with the PR without the user, or null when it waits on them:
   *  only such a PR holds the repo's other conflicted PRs back (#157 F6). Asked of the review, fix
   *  and merge lanes' own rules (`reviewNext`, `fixNext`, `mergeNext`), so the hold never counts
   *  a PR one of them has given up on (#157 F7); a read that fails throws, so the PR it would hold
   *  waits for the next pass rather than go on a guess. */
  private async moving(repo: BuildRepo, o: ReviewPull): Promise<string | null> {
    const h7 = o.headSha.slice(0, 7);
    if (o.draft) return null; // a draft is never merged until the user marks it ready
    if (this.heldForUser(repo, o)) return null;
    // (a job that needs the user holds the whole repo: no pass gets here)
    if (this.d.log.jobs().some((j) => j.kind === 'review' && j.repo === repo.id && j.issue === o.number && !j.end)) return 'a review of it is running';
    const review = await reviewNext(this.d, repo, o);
    if (review.why === null) return `${h7} is reviewed next`;
    if (review.on !== 'reviewed') return this.stillMoving(repo, o, review);
    const done = this.newestReview(repo, o)!;
    if (done.end!.outcome === 'blocking') {
      const fix = await fixNext(this.d, repo, o, done);
      if ('reviews' in fix) return `review ${done.round} of ${h7} gets its fix round`;
      return this.stillMoving(repo, o, fix);
    }
    // clean on H (a stop or approach note is the user's: heldForUser): the app merges it, unless
    // the user does
    if ((repo.merge ?? 'me') === 'me') return null;
    const merge = await mergeNext(this.d, repo, o.number, o.headSha);
    if (merge.why === null) return `clean at ${h7}, merged next`;
    return this.stillMoving(repo, o, merge);
  }

  /** A lane's "not now" as the hold reads it: what the loop brings itself still moves the PR; what
   *  waits on the user doesn't. Checks that may never report (no CI, a path filter) move it only
   *  for NO_CHECKS_GRACE_MS after the conflict round that pushed its head: past that, nothing the
   *  loop does brings them. */
  private stillMoving(repo: BuildRepo, o: ReviewPull, next: { why: string; on: string }): string | null {
    if (next.on === 'loop') return next.why;
    if (next.on !== 'checks') return null;
    const pushed = this.d.log.jobs().filter((j) => j.kind === 'conflict' && j.repo === repo.id && j.issue === o.number && j.end?.head === o.headSha).at(-1);
    const until = pushed ? Date.parse(pushed.end!.at) + NO_CHECKS_GRACE_MS : 0;
    return until > this.now().getTime() ? `${next.why}, held until ${new Date(until).toISOString()} at most` : null;
  }

  /** The app's newest review of the PR's head that reached a verdict. */
  private newestReview(repo: BuildRepo, pr: ReviewPull): Job | undefined {
    return this.d.log.jobs().filter((j) => j.kind === 'review' && j.repo === repo.id && j.issue === pr.number
      && j.sha === pr.headSha && j.end && REVIEWED.includes(j.end.outcome)).at(-1);
  }

  /** Why the PR's head is left for the user, or null: a stop on the PR (#158), a review on it that
   *  went to them (the cap's approach note, or an older app's stop) and isn't answered, a fork's
   *  head, a fix round on it that ended without a push, or the PR marked ready for the user to
   *  merge. Such a PR is on no way to merging that the app drives. */
  private heldForUser(repo: BuildRepo, pr: ReviewPull): string | null {
    const h = pr.headSha;
    const h7 = h.slice(0, 7);
    const stop = this.d.log.openStops(repo.id, pr.number)[0];
    if (stop) return stop.why;
    // a fork's head: a round would push to this repo's branch of that name (#156 N2)
    if (pr.headRepo !== undefined && pr.headRepo?.toLowerCase() !== repo.github!.toLowerCase()) {
      return `its head is in ${pr.headRepo ?? 'a fork GitHub no longer has'}, not ${repo.github}: no conflict round pushes to a fork's branch`;
    }
    const answered = this.d.log.lastAnswer(repo.id, pr.number)?.answered!.at ?? '';
    const review = this.newestReview(repo, pr);
    if (review && (review.end!.outcome === 'stop' || review.end!.outcome === 'approach-note') && review.end!.at > answered) return `review ${review.round} of ${h7} ended ${review.end!.outcome}`;
    // a fix round that ended without a push asked the user (its question is a stop); a conflict
    // round that couldn't resolve it waits for the base to move (conflictWait)
    const round = this.d.log.jobs().filter((j) => j.repo === repo.id && j.kind === 'fix' && j.issue === pr.number
      && j.sha === h && j.end && RAN(j) && !WRITING(j) && j.end.outcome !== 'failed' && j.startedAt > answered).at(-1);
    if (round) return `a ${round.kind} round on ${h7} ended ${round.end!.outcome} without a push`;
    const ready = this.d.log.steps().filter((s) => s.kind === 'ready' && s.repo === repo.id && s.pr === pr.number && s.end).at(-1);
    if (ready?.end?.outcome === 'marked' && ready.sha === h) return `${h7} is marked ready for you to merge`;
    return null;
  }

  /** Why the conflict on H waits, or null when a round may go (#158): the PR's last round couldn't
   *  resolve it (it ended without a push, or the PR conflicts again after it) and the base's tip is
   *  still the one that round merged, so another round would merge the same thing. Once the base
   *  moves, it gets another. A round that failed gets another at once (the cap bounds them). The
   *  base's tip is read from GitHub's branches API; that read failing throws, and the PR waits for
   *  the next pass: it's never taken as "the base moved". */
  private async conflictWait(repo: BuildRepo, pr: ReviewPull): Promise<string | null> {
    const h7 = pr.headSha.slice(0, 7);
    const last = this.d.log.jobs().filter((j) => j.kind === 'conflict' && j.repo === repo.id && j.issue === pr.number && RAN(j) && j.end).at(-1);
    if (!last?.baseSha) return null;
    if (last.end!.outcome === 'failed' && (last.end!.head ?? last.sha) === last.sha) return null;
    // a round that asked the user: answered (else it still writes), it gets another round
    if (last.end!.outcome === 'waiting') return null;
    const tip = await this.d.github.branchHead(repo.github!, pr.base);
    if (tip !== last.baseSha) return null;
    const what = last.sha === pr.headSha
      ? `the conflict round on ${h7} couldn't resolve it (it ended ${last.end!.outcome} without a push)`
      : `it conflicts again after the round on ${last.sha!.slice(0, 7)}`;
    return `${what}, and ${pr.base} is still at ${last.baseSha.slice(0, 7)}, which that round merged: another round once ${pr.base} moves`;
  }

  /** One conflict round on H, start to end. */
  private async round(repo: BuildRepo, pr: ReviewPull, letIn: { choice: ModelChoice; onFallback: boolean; cost: Record<string, number> },
    onLaunched: () => void): Promise<Job | null> {
    const n = pr.number;
    const h = pr.headSha;
    const name = `conflict ${repo.title}#${n}`;
    const title = conflictTitle(repo, n);
    let where: ConflictWhere;
    let worktreePath: string | null = null;
    let baseSha: string;
    let brief: string;
    try {
      const fetched = await this.d.git.fetchPr(repo.folder, n, pr.base);
      if (fetched !== h) throw new NotStarted(`the head moved from ${h.slice(0, 7)} to ${fetched.slice(0, 7)}; it's looked at again`);
      // the base the round merges in, as GitHub has its tip: the next conflict is a stop only while
      // the tip is still this one
      baseSha = await this.d.github.branchHead(repo.github!, pr.base);
      const own = (await this.d.git.worktrees(repo.folder)).find((w) => w.branch === pr.branch);
      if (own) {
        where = { kind: 'worktree' };
        worktreePath = own.path;
      } else {
        where = { kind: 'new', work: conflictBranch(n, h, baseSha) };
        if (await this.d.git.hasBranch(repo.folder, where.work)) throw new NotStarted(`a local branch ${where.work} is left from an earlier round`);
      }
      brief = await this.brief(repo, pr, where);
    } catch (e) {
      onLaunched();
      this.resting.set(`${repo.github}#${n}`, this.now().getTime() + (this.d.restMs ?? 300_000));
      this.d.say(`${name} not started: ${e instanceof NotStarted ? e.message : `${(e as Error).name}: ${(e as Error).message}`}`);
      return null;
    }
    const job = await this.d.log.started({
      kind: 'conflict', repo: repo.id, github: repo.github, issue: n, branch: pr.branch, base: pr.base, title,
      choice: letIn.choice, onFallback: letIn.onFallback, cost: letIn.cost, sha: h, baseSha,
      ...(where.kind === 'new' ? { workBranch: where.work } : {}),
    });
    this.d.gate.started({ id: job.id, kind: 'conflict', choice: letIn.choice }, letIn.cost);
    if (!this.d.repos().some((r) => r.id === repo.id)) return this.notStarted(job, `${repo.title} is no longer served`);
    // one writer per PR, asked again after the slow steps: a job another lane started on the PR
    // meanwhile (a fix round on its branch, a review of it) goes on alone
    const other = this.d.log.jobs().find((j) => j.id !== job.id && j.repo === repo.id
      && ((j.kind !== 'review' && j.branch === pr.branch && WRITING(j)) || (j.kind === 'review' && j.issue === n && !j.end)));
    if (other) return this.notStarted(job, `a ${other.kind} job started on PR #${n} meanwhile`);
    const catalog = this.d.catalog();
    if (!catalog) return this.notStarted(job, "T3's providers aren't known yet");
    let thread: { threadId: string; runId: string | null; link: string | null };
    try {
      this.d.say(`Starting ${name}: ${h.slice(0, 7)} conflicts with ${pr.base} (at ${baseSha.slice(0, 7)})`);
      const launched = await launchJob(this.d.mcp, catalog, {
        kind: 'conflict', projectId: repo.id, title, brief, choice: letIn.choice,
        ...(worktreePath ? { worktreePath } : { worktree: { baseRef: h, branch: (where as { work: string }).work } }),
      });
      thread = { threadId: launched.threadId, runId: launched.runId, link: launched.link };
    } catch (e) {
      // sent and its answer lost: T3 may have started the thread, and nothing says which
      if (e instanceof NoAnswer) return this.needsUser(job, e.message);
      // refused before it ran (a 4xx, a refused token), or never sent: nothing started
      return this.notStarted(job, (e as Error).message);
    }
    await this.d.log.thread(job.id, thread);
    // a new worktree and its branch are the app's (F15); the PR's own worktree made nothing
    if (where.kind === 'new') await this.d.log.made(job.id, where.work);
    onLaunched();
    return this.watch({ ...job, ...thread });
  }

  private async brief(repo: BuildRepo, pr: ReviewPull, where: ConflictWhere): Promise<string> {
    const github = repo.github!;
    const here = github.toLowerCase();
    const base = `origin/${pr.base}`;
    const threads = this.d.log.jobs()
      .filter((j) => j.repo === repo.id && j.link && (j.branch === pr.branch || (j.kind === 'review' && j.issue === pr.number)))
      .map((j) => ({ kind: j.kind, startedAt: j.startedAt, outcome: j.end?.outcome ?? 'still open', link: j.link! }));
    return conflictBrief({
      github, number: pr.number, title: pr.title, sha: pr.headSha, branch: pr.branch, base: pr.base,
      user: await this.d.user(), where,
      agentsFile: this.d.exists(join(repo.folder, 'AGENTS.md')) ? 'AGENTS.md' : this.d.exists(join(repo.folder, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
      body: pr.body,
      closes: closedIssues(pr.body, here).map(([w, k]) => (w === here ? `#${k}` : `${w}#${k}`)),
      commits: await this.d.git.log(repo.folder, base, pr.headSha),
      landed: await this.d.git.log(repo.folder, pr.headSha, base),
      diffstat: await this.d.git.diffstat(repo.folder, base, pr.headSha),
      threads,
    });
  }

  /** A round let in that started nothing: dropped from the gate, and the PR rests. */
  private async notStarted(job: Job, error: string): Promise<Job> {
    this.d.gate.dropped(job.id);
    this.resting.set(`${job.github}#${job.issue}`, this.now().getTime() + (this.d.restMs ?? 300_000));
    this.d.say(`${job.title} not started: ${error}`);
    return this.d.log.ended(job.id, { outcome: 'not-started', error });
  }

  private needsUser(job: Job, why: string): Promise<Job> {
    this.d.gate.dropped(job.id);
    this.d.say(`${job.title} needs you: ${why}. T3 may have started its run; nothing else starts in ${job.github ?? job.repo} until you answer.`);
    return this.d.log.ended(job.id, { outcome: 'needs-user', error: why });
  }

  private async resume(job: Job): Promise<Job> {
    this.d.gate.started({ id: job.id, kind: 'conflict', choice: job.choice }, job.cost ?? {});
    if (!job.threadId) return this.needsUser(job, 'the app stopped before T3 named its thread');
    this.d.say(`Watching ${job.title} again: ${job.link ?? job.threadId}`);
    return this.watch(job);
  }

  private async watch(job: Job): Promise<Job> {
    const w = watchThreadEnd(this.d.ws, job.threadId!, job.runId ?? null, this.d.retry,
      (why) => this.d.say(`${job.title}: T3's thread stream dropped (${why}); opening it again`));
    this.watches.add(w);
    let end: ThreadEnd;
    try {
      end = await w.end;
    } finally {
      this.watches.delete(w);
    }
    this.d.gate.finished(job.id, end.outcome === 'usage-limit' ? { resetAt: end.resetAt } : undefined);
    const record: JobEnd = { outcome: end.outcome as JobEnd['outcome'], status: end.status };
    if (end.outcome === 'failed') record.error = end.error;
    if (end.outcome === 'usage-limit') Object.assign(record, { resetAt: end.resetAt, error: end.error });
    if (end.outcome === 'waiting') record.request = end.request;
    // a round that failed may still have pushed: its head is read too
    if (end.outcome === 'done' || end.outcome === 'failed') {
      try {
        record.head = (await this.d.github.pull(job.github!, job.issue)).headSha;
      } catch {
        record.head = null; // the next pass reads the head from the PR list itself
      }
    }
    const ended = await this.d.log.ended(job.id, record);
    // a round that couldn't resolve it is no stop (#158): another round once the base moves
    const pushed = record.head && record.head !== job.sha ? `, pushed ${record.head.slice(0, 7)}: reviewed next`
      : record.head === job.sha ? `, without a push: another round once ${job.base} moves` : '';
    this.d.say(`${job.title} ended: ${record.outcome}${pushed} ${job.link ?? job.threadId}`);
    if (settles(record.outcome)) await this.settler.settle(job);
    return ended;
  }
}
