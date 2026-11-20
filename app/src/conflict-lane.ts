// The conflict lane (#157; today's conflict rounds in `queue_runner/fix.py` and `stops.py`, ported,
// `docs/flow.md` A round, step 1): a PR whose head H conflicts with its base gets a fresh thread on
// the conflict kind's settings, in the PR's own worktree (or a new one at H), that merges the base
// in, resolves the conflict and pushes; a fresh reviewer then reviews the new head (the review lane).
//
//   GitHub says H can't merge (`mergeable: false`; null, still working it out, is not known yet:
//   that PR, and every newer one, waits for GitHub's answer on a later pass)
//   ->  nothing that may write to the branch again (a question, a usage limit), no review of the
//       PR is running, H's blocking review has had its fix round, nothing on H is left for the
//       user, it's no stop  ->  oldest first, one at a time  ->  the gate (kind `conflict`)
//   ->  the PR's head fetched (moved: nothing starts), the base's own tip read from GitHub  ->  the brief (src/briefs/conflict.ts)  ->  a new thread
//   ->  its end from T3's thread events; the PR's head read again: pushed (reviewed next) or not,
//       which is a stop  ->  the end recorded and the thread settled, then the review lane passes
//
// **When a round starts is the chooser's** (src/chooser.ts, #210): one job per repo, so no
// round starts while another job of the repo's runs, a conflict round included.
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
// **A stop, not a round** (#91), only when another round wouldn't help: the round on H ended
// without resolving it; or the PR conflicts again while the base's tip is still the one its last
// round merged; or it had MAX_CONFLICT_ROUNDS rounds as the base keeps moving. A conflict after the
// base moved, below that, gets another round. "The base moved" is read from the base branch's own
// tip (GitHub's branches API), never the PR's `base.sha`, which GitHub refreshes only when the PR's
// branch is pushed: after a stop it stays at the base the last round merged however far the base
// has moved. A stop is a `stop` line in the job log, once per PR and head, for the stops ticket
// (#158): nothing more happens to it yet.
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
import { REVIEWED, settles, type Job, type JobEnd, type JobLog, type StopStart } from './job-log.ts';
import type { Catalog, ModelChoice } from './jobs.ts';
import { launchJob } from './launch.ts';
import { closedIssues, JOB_BRANCH_PREFIX } from './picker.ts';
import type { RepoJobLane, Next } from './chooser.ts';
import { ThreadSettler } from './settle.ts';
import type { T3Mcp } from './t3/mcp.ts';
import type { Retry } from './t3/project-feed.ts';
import { NoAnswer } from './t3/seams.ts';
import { watchJobThread, type ThreadEnd } from './t3/thread-end.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

export type ConflictLaneDoors = {
  repos: () => BuildRepo[];
  github: Pick<GitHubReview, 'pullsToReview' | 'checks' | 'issueComments' | 'reviewReplies'> & Pick<GitHubMerge, 'pull' | 'branchHead' | 'openThreads'>;
  git: Pick<FixGit, 'fetchPr' | 'log' | 'diffstat' | 'worktrees'> & { hasBranch(folder: string, branch: string): Promise<boolean> };
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe' | 'request' | 'first'>;
  gate: Pick<UsageGate, 'pick' | 'started' | 'finished' | 'dropped' | 'forget'>;
  catalog: () => Catalog | null;
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

/** A PR that conflicted this many times as its base kept moving is a stop (today's #91 limit). */
export const MAX_CONFLICT_ROUNDS = 5;
/** How long a head a conflict round pushed, with no checks reported on it, still holds the repo's
 *  other conflicted PRs: CI reports within minutes, and a repo with none never does (#157 F7). */
export const NO_CHECKS_GRACE_MS = 10 * 60_000;

export const conflictTitle = (repo: BuildRepo, n: number) => `Queue runner conflict: ${repo.title}#${n}`;
/** The local branch a round's new worktree is made on, from H; it never goes to origin: the round
 *  pushes to the PR's own branch. Not the fix round's name, so the two never meet on one head. */
export const conflictBranch = (n: number, sha: string) => `${JOB_BRANCH_PREFIX}conflict-pr${n}-${sha.slice(0, 7)}`;

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;
/** A job on the branch that ended on a question or a usage limit: it may write to it again. */
const MAY_WRITE_AGAIN = (j: Job) => j.end?.outcome === 'waiting' || j.end?.outcome === 'usage-limit';
/** A round that got as far as its thread (or may have): every end but `not-started`. */
const RAN = (j: Job) => j.end?.outcome !== 'not-started';

/** A round that started no thread, for a reason the lane gives. */
class NotStarted extends Error {}

export class ConflictLane implements RepoJobLane {
  private d: ConflictLaneDoors;
  private now: () => Date;
  private settler: ThreadSettler;
  /** Rounds under way, by `owner/name#n`. */
  private running = new Map<string, Promise<Job | null>>();
  private watches = new Set<{ stop(): void }>();
  private why = new Map<string, string | null>();
  private resting = new Map<string, number>();
  private stopped = false;

  constructor(doors: ConflictLaneDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Each round the log shows open (one waiting on the user among them) is watched again, or
   *  needs the user; each is reserved in the gate before the chooser's first choice (#210 F19). */
  recover(): void {
    for (const job of this.d.log.open()) {
      if (job.kind !== 'conflict') continue;
      this.track(`${job.github}#${job.issue}`, this.resume(job));
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
    if (why && this.why.get(key) !== why) this.d.say(`${name}: no conflict round now, ${why}`);
    this.why.set(key, why);
  }

  private track(key: string, round: Promise<Job | null>) {
    this.running.set(key, round);
    round.then((job) => {
      if (job?.end && !this.stopped) this.d.ended?.(job);
    }, (e) => this.d.say(`a conflict round on ${key} stopped: ${(e as Error).message}`)).finally(() => {
      this.running.delete(key);
      if (!this.stopped) this.d.freed?.();
    });
  }

  owed(): void {
    this.settler.owed('conflict');
  }

  /** The repo's next conflict round: its lowest-numbered conflicting PR that gets one now, if the
   *  gate lets it in (held, the round waits and so does the repo). A read that fails throws. */
  async next(repo: BuildRepo): Promise<Next> {
    if (this.stopped || !repo.github) return null;
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
      throw new Error(`GitHub couldn't be read for conflicts (${(e as Error).message})`);
    }
    let first: ReviewPull | null = null;
    let waits: string | null = null;
    // oldest first: a PR GitHub hasn't answered for may conflict, so no newer one goes before it
    let unknown: ReviewPull | null = null;
    for (const pr of pulls) {
      if (this.stopped) return null;
      const key = `${repo.github}#${pr.number}`;
      const name = `conflict ${repo.title}#${pr.number}`;
      if (conflicts.get(pr.number) === null) {
        // the PR's own writer or review aside, nothing acts on it until GitHub says
        unknown ??= pr;
        this.note(key, name, `GitHub hasn't worked out yet whether ${pr.headSha.slice(0, 7)} conflicts with ${pr.base}; read again next pass`);
        continue;
      }
      if (!conflicts.get(pr.number)) { this.why.delete(key); continue; }
      let why: string | null;
      try {
        why = await this.whyNot(repo, pr, pulls, conflicts);
      } catch (e) {
        throw new Error(`PR #${pr.number} couldn't be read for its conflict round (${(e as Error).message})`);
      }
      if (!why && first) why = `PR #${first.number} resolves its conflict first: one conflicted PR at a time`;
      if (!why && unknown) why = `GitHub hasn't said yet whether the older PR #${unknown.number} conflicts: oldest first`;
      if (why) { this.note(key, name, why); continue; }
      first = pr;
      const v = this.d.gate.pick(`conflict:${key}`, 'conflict');
      if (!v.fits) {
        waits = `waits: ${holdText(v.hold, (d) => d.toISOString())}`;
        this.note(key, name, waits);
        continue; // a round held by the gate holds the rest too (`first`)
      }
      this.d.gate.forget(`conflict:${key}`);
      this.why.set(key, null);
      // the gate counts the round from now; the chooser goes on once T3 has it
      return {
        launch: () => new Promise<void>((launched) => {
          this.track(key, this.round(repo, pr, v, launched).finally(launched));
        }),
      };
    }
    return waits === null ? null : { waits };
  }

  /** Why the conflicting PR gets no round now, or null: cheapest first. A stop found here is
   *  recorded. */
  private async whyNot(repo: BuildRepo, pr: ReviewPull, pulls: ReviewPull[], conflicts: Map<number, boolean | null>): Promise<string | null> {
    const h = pr.headSha;
    const h7 = h.slice(0, 7);
    const jobs = this.d.log.jobs().filter((j) => j.repo === repo.id);
    // a job on the branch that may write to it again (one running is the chooser's to wait on)
    const writer = jobs.find((j) => j.kind !== 'review' && j.branch === pr.branch && MAY_WRITE_AGAIN(j));
    if (writer) return `a ${writer.kind} job is writing to ${pr.branch}`;
    // a review under way decides on H first; the round would make it a review of a stale head
    if (jobs.some((j) => j.kind === 'review' && j.issue === pr.number && !j.end)) return `a review of PR #${pr.number} is running`;
    const review = this.newestReview(repo, pr);
    if (review?.end?.outcome === 'blocking' && !jobs.some((j) => j.kind === 'fix' && j.issue === pr.number && j.sha === h && RAN(j))) {
      return `review ${review.round} of ${h7} is blocking: its fix round comes first`;
    }
    const stop = await this.conflictStop(repo, pr);
    if (stop) {
      await this.recordStop(`conflict ${repo.title}#${pr.number}`, { cause: 'conflict', repo: repo.id, github: repo.github!, pr: pr.number, sha: h, ...stop });
      return `stopped for you: ${stop.why}`;
    }
    const held = this.heldForUser(repo, pr);
    if (held) return `left for you: ${held}`;
    if ((this.resting.get(`${repo.github}#${pr.number}`) ?? 0) > this.now().getTime()) return 'its last round started no thread; it rests';
    for (const o of pulls) {
      if (o.number === pr.number || !(o.number < pr.number || conflicts.get(o.number) !== true)) continue;
      if (!jobs.some((j) => j.kind === 'conflict' && j.issue === o.number && RAN(j))) continue;
      const moving = await this.moving(repo, o);
      if (moving) return `PR #${o.number} had a conflict round and is still on its way to merging (${moving}): one conflicted PR at a time`;
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

  /** Why the PR's head is left for the user, or null: a stop on it, a review that stops on it, a
   *  fix or conflict round on it that ended without a push, or the PR marked ready for the user to
   *  merge. Such a PR is on no way to merging that the app drives. */
  private heldForUser(repo: BuildRepo, pr: ReviewPull): string | null {
    const h = pr.headSha;
    const h7 = h.slice(0, 7);
    const stop = this.d.log.stopOn(repo.id, pr.number, h, 'conflict');
    if (stop) return stop.why;
    const review = this.newestReview(repo, pr);
    if (review && (review.end!.outcome === 'stop' || review.end!.outcome === 'approach-note')) return `review ${review.round} of ${h7} ended ${review.end!.outcome}`;
    const round = this.d.log.jobs().filter((j) => j.repo === repo.id && (j.kind === 'fix' || j.kind === 'conflict') && j.issue === pr.number
      && j.sha === h && j.end && RAN(j) && !MAY_WRITE_AGAIN(j)).at(-1);
    if (round) return `a ${round.kind} round on ${h7} ended ${round.end!.outcome} without a push`;
    const ready = this.d.log.steps().filter((s) => s.kind === 'ready' && s.repo === repo.id && s.pr === pr.number && s.end).at(-1);
    if (ready?.end?.outcome === 'marked' && ready.sha === h) return `${h7} is marked ready for you to merge`;
    return null;
  }

  /** Why the conflict on H is a stop, or null while another round may still resolve it (#91). The
   *  base's tip is read from GitHub's branches API; that read failing throws, and the PR waits for
   *  the next pass: it's never taken as "the base moved". */
  private async conflictStop(repo: BuildRepo, pr: ReviewPull): Promise<{ why: string; link: string | null } | null> {
    const h7 = pr.headSha.slice(0, 7);
    // a fork's head: a round would push to this repo's branch of that name (#156 N2)
    if (pr.headRepo !== undefined && pr.headRepo?.toLowerCase() !== repo.github!.toLowerCase()) {
      return { why: `it conflicts with ${pr.base}, and its head is in ${pr.headRepo ?? 'a fork GitHub no longer has'}, not ${repo.github}: no conflict round pushes to a fork's branch`, link: null };
    }
    const rounds = this.d.log.jobs().filter((j) => j.kind === 'conflict' && j.repo === repo.id && j.issue === pr.number && RAN(j));
    const onH = rounds.filter((j) => j.sha === pr.headSha && j.end).at(-1);
    if (onH) {
      return { why: `it conflicts with ${pr.base} at ${h7}, and the conflict round on ${h7} couldn't resolve it (it ended ${onH.end!.outcome} without a push)`, link: onH.link ?? null };
    }
    if (rounds.length >= MAX_CONFLICT_ROUNDS) {
      return { why: `${rounds.length} conflict rounds, ${pr.base} keeps moving under it: it conflicts again at ${h7}`, link: rounds.at(-1)!.link ?? null };
    }
    const prev = rounds.filter((j) => j.sha !== pr.headSha).at(-1);
    if (prev?.baseSha) {
      const tip = await this.d.github.branchHead(repo.github!, pr.base);
      if (tip === prev.baseSha) {
        return { why: `it conflicts with ${pr.base} again at ${h7}, though the conflict round on ${prev.sha!.slice(0, 7)} merged ${pr.base} at ${prev.baseSha.slice(0, 7)} and ${pr.base} has not moved since`, link: prev.link ?? null };
      }
    }
    return null;
  }

  /** A stop on the PR's head, recorded once and said once. */
  private async recordStop(name: string, stop: StopStart) {
    if (this.d.log.stopOn(stop.repo, stop.pr, stop.sha, stop.cause)) return;
    await this.d.log.stopped(stop);
    this.d.say(`${name}: a stop for you, ${stop.why}`);
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
        where = { kind: 'new', work: conflictBranch(n, h) };
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
    // a review of the PR started meanwhile (the review lane runs beside the chooser) goes on alone
    const review = this.d.log.jobs().find((j) => j.kind === 'review' && j.repo === repo.id && j.issue === n && !j.end);
    if (review) return this.notStarted(job, `a review of PR #${n} started meanwhile`);
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

  /** The round's thread followed to its end (`watchJobThread`): a run waiting on the user in T3
   *  hasn't ended, and the round stays open, its repo held and its cost in the gate, until it has.
   *  The gate measures it once, at that end (#210 F18). */
  private async watch(job: Job): Promise<Job> {
    const w = watchJobThread(this.d.ws, { ...job, threadId: job.threadId! }, this.d.say, this.d.retry);
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
    // a round that failed may still have pushed: its head is read too
    if (end.outcome === 'done' || end.outcome === 'failed') {
      try {
        record.head = (await this.d.github.pull(job.github!, job.issue)).headSha;
      } catch {
        record.head = null; // the next pass reads the head from the PR list itself
      }
    }
    const ended = await this.d.log.ended(job.id, record);
    const pushed = record.head && record.head !== job.sha ? `, pushed ${record.head.slice(0, 7)}: reviewed next`
      : record.head === job.sha ? ', without a push: a stop for you' : '';
    this.d.say(`${job.title} ended: ${record.outcome}${pushed} ${job.link ?? job.threadId}`);
    // a round that ends without a push is a stop, for the stops ticket (#158)
    if (record.head === job.sha) {
      await this.recordStop(job.title, {
        cause: 'conflict', repo: job.repo, github: job.github!, pr: job.issue, sha: job.sha!, link: job.link ?? null,
        why: `it conflicts with ${job.base} at ${job.sha!.slice(0, 7)}, and the conflict round on it couldn't resolve it (it ended ${record.outcome} without a push)`,
      });
    }
    // a thread T3's list no longer has has nothing left to settle (#210 F11)
    if (end.outcome === 'failed' && end.gone) await this.d.log.settled(job.id);
    else if (settles(record.outcome)) await this.settler.settle(job);
    return ended;
  }
}
