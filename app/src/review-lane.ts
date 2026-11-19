// The review lane (#155; today's `queue_runner/review.py`, ported, docs/flow.md The review loop):
// every open PR in a served repo without a review on its newest commit H gets one, whoever opened
// it, once the checks on H pass (`sol-review` not counted) and H doesn't conflict with its base
// (#157: a conflict round comes first). One review at a time for now (#106 runs them at once
// later). A review:
//
//   the usage gate lets it in, on the review kind's model or, while that provider has no room, its
//   fallback (#69)  ->  the PR's head fetched; moved since listing: head-moved, nothing counts
//   ->  a detached checkout of H in the state folder, the repo's dependencies linked in
//   ->  the inputs in a run folder (the diffs, the PR, the issues it closes, what's been said,
//       the screenshots) and the brief (src/briefs/review.ts)
//   ->  t3_thread_launch with the checkout as its working folder (T3's existing_worktree)
//   ->  its end from T3's thread events; its reply read whole
//   ->  decide (src/review/ledger.ts): the verdict from the reply's sol-findings block
//   ->  post (src/review/post.ts): follow-ups, the comment; then sol-review on H and the Review
//       row, tried again until both land (the job stays open meanwhile, across a restart too)
//   ->  the end recorded, the checkout removed, the thread settled (src/settle.ts)
//
// **No outside tools** (docs/reviews.md): a review runs only on a T3 provider instance the user
// named as set up without them (`toolFreeInstances`), as today's fallback reviews run on the one
// instance its config names (#127). The app can't see an instance's tools without
// naming its driver, so the list is the user's word, and launchJob refuses any instance not on it.
// The lane asks first, so such a review waits and says why instead of failing; nor does one run on
// the instance builds run on, which has their tools, whatever the list says.
//
// **After a restart, don't guess** (#155, as #154's builds): a review the log shows open whose
// thread id was saved carries on with that thread: watched to its end, its reply read, decided
// and posted, as if the app had never stopped. One with no saved thread id (the app stopped
// before T3 named it, or the launch was sent and its answer lost: `NoAnswer`) is never matched to
// a thread by title, branch or project: it's recorded as needing the user, its checkout is left
// for a thread that may run in it, and its repo starts nothing until the user answers. A read of
// T3 or GitHub after the run that fails for a moment is tried again, never taken as "none" or as
// a failed review.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewBrief, said } from './briefs/review.ts';
import { holdText } from './gate.ts';
import type { GitHubMerge, GitHubReview, ReviewPull } from './github.ts';
import { prRef, type ReviewGit } from './git.ts';
import { REVIEWED, type Job, type JobEnd, type JobLog } from './job-log.ts';
import { kindModels, model, provider, type Catalog, type Jobs, type ModelChoice } from './jobs.ts';
import { JobError, launchJob, noToolsRefusal } from './launch.ts';
import { closedIssues } from './picker.ts';
import type { Deps } from './review/deps.ts';
import { testsNote } from './review/deps.ts';
import { decide, nextRound, readReviews, ReviewFailed, runnerPost, type Comment, type Decision, type Review } from './review/ledger.ts';
import { FinishFailed, GitHubPoster, PostFailed, type GitHubPosts, type Poster } from './review/post.ts';
import type { BuildRepo } from './build-lane.ts';
import { ThreadSettler } from './settle.ts';
import { retryAfter, type Retry } from './t3/project-feed.ts';
import { NoAnswer } from './t3/seams.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { watchThreadEnd, type ThreadEnd } from './t3/thread-end.ts';
import { runReply } from './t3/thread-reply.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

/** Failed reviews on one head before the lane leaves it until a new head. */
export const MAX_FAILED = 2;
const OUTCOMES = { merge: 'clean', fix: 'blocking', stop: 'stop', 'approach-note': 'approach-note' } as const;

export type ReviewLaneDoors = {
  repos: () => BuildRepo[];
  github: GitHubReview & GitHubPosts & Pick<GitHubMerge, 'pull'>;
  git: ReviewGit;
  /** Links a checkout's dependencies in; null installs nothing. */
  deps: Pick<Deps, 'prepare'> | null;
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe' | 'first'>;
  gate: Pick<UsageGate, 'pick' | 'check' | 'started' | 'finished' | 'dropped' | 'forget'>;
  catalog: () => Catalog | null;
  jobs: () => Jobs;
  /** The instances set up without outside tools (the `toolFreeInstances` setting). */
  toolFree: () => readonly string[];
  /** The user's name, for the comment's byline and the stop notes. */
  user: () => Promise<string>;
  log: JobLog;
  /** The state folder: run folders go in `runs/`, checkouts in `checkouts/`. */
  stateDir: string;
  /** Posts the review; the live check's posts nothing. Default: GitHubPoster. */
  poster?: Poster;
  say: (line: string) => void;
  retry?: Retry;
  /** How long a PR whose review started no thread rests before it's tried again (ms). */
  restMs?: number;
  now?: () => Date;
  /** A review ended (#156: a blocking one gets a fix round, a clean one merges). */
  ended?: (job: Job) => void;
};

export const reviewTitle = (repo: BuildRepo, n: number) => `Queue runner review: ${repo.title}#${n}`;
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-');
const slash = (p: string) => p.replace(/\\/g, '/');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const readText = (p: string) => readFile(p, 'utf8').catch(() => null);
const isFile = (p: string) => stat(p).then((s) => s.isFile(), () => false);

/** Who reviews, as the comment, the status and the Review row name it: the model and effort T3
 *  calls them, and on the fallback, whose usage ran out. */
export function reviewerName(catalog: Catalog, jobs: Jobs, choice: ModelChoice, onFallback: boolean): string {
  const m = model(catalog, choice);
  const effort = m?.efforts.find((e) => e.id === choice.effort)?.label ?? choice.effort;
  const name = `${m?.label ?? choice.model}${effort ? ` ${effort}` : ''}`;
  if (!onFallback) return name;
  const own = kindModels(jobs, 'review', catalog).choice;
  return `${name}, fallback while ${own ? provider(catalog, own.provider)?.label ?? own.provider : 'its own provider'} is out of usage`;
}

/** Reads of the reply that come back empty before the review counts as failed: T3 gives an empty
 *  page now and then, so one is no answer, and the third in a row is the thread's own. */
export const EMPTY_READS = 3;

/** What a review needs after its launch, to read, decide and post: kept in the job log's start
 *  line and the run folder's `review.json`, so a review carries on after a restart. */
type Run = {
  name: string; github: string; n: number; h: string; round: number; reviewer: string;
  runDir: string; wt: string; folder: string; gone: boolean; hasReviewMd: boolean;
};

/** The lane was stopped while a review waited: it's left open, for the next start to carry on. */
class Stopping extends Error {}
/** A review that launched nothing, for a reason the lane gives. */
class NotStarted extends Error {}

export class ReviewLane {
  private d: ReviewLaneDoors;
  private poster: Poster;
  private now: () => Date;
  private settler: ThreadSettler;
  private running: Promise<unknown> | null = null;
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private watches = new Set<{ stop(): void }>();
  /** Retry waits under way: stop() ends each one. */
  private waits = new Set<() => void>();
  private why = new Map<string, string | null>();
  private holdSaid: string | null = null;
  /** The needs-you hold last said for each repo, so it's said once. */
  private heldSaid = new Map<string, string>();
  /** PRs whose review started no thread, resting until then (ms), by `owner/name#n`. */
  private resting = new Map<string, number>();

  constructor(doors: ReviewLaneDoors) {
    this.d = doors;
    this.poster = doors.poster ?? new GitHubPoster(doors.github, doors.say);
    this.now = doors.now ?? (() => new Date());
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Each review the log shows open (an app that stopped mid-review) carries on with its saved
   *  thread, or needs the user without one; no other review starts until they're done. Then a
   *  pass. */
  start(): Promise<void> {
    const open = this.d.log.open().filter((j) => j.kind === 'review');
    if (open.length) this.track(Promise.all(open.map((j) => this.resume(j))));
    return this.pass();
  }

  /** Stops watching: a review in T3 goes on, and the next start carries on with it. */
  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
    for (const wake of [...this.waits]) wake();
  }

  /** T3 read new usage: a pass, if a review waits on the gate. */
  usageChanged(): void {
    if (this.holdSaid) void this.pass();
  }

  /** The user has answered a job that needed them (the Inbox ticket's to ask): its repo is free
   *  again, and a pass runs. */
  async answered(jobId: string): Promise<void> {
    if (!this.d.log.get(jobId)?.answeredAt) await this.d.log.answered(jobId);
    await this.pass();
  }

  /** Whether a review runs now. */
  busy(): boolean {
    return this.running !== null;
  }

  /** Settles once the review under way, any pass and any settle have ended (the tests wait on it). */
  async idle(): Promise<void> {
    while (this.running || this.passing || this.settler.pending().length) {
      await Promise.allSettled([this.running, this.passing, ...this.settler.pending()]);
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

  /** The review under way; once it ends, a pass, unless its head had moved (GitHub's list may
   *  still show the old head, and a pass now would fetch the moved one again at once) or the lane
   *  stopped. */
  private track(p: Promise<unknown>) {
    this.running = p;
    p.then((job) => {
      const ended = job as Job | undefined;
      if (ended?.end && !this.stopped) this.d.ended?.(ended);
      return ended?.end?.outcome !== 'head-moved';
    }, (e) => {
      this.d.say(`a review stopped: ${(e as Error).message}`);
      return true;
    }).then((again) => {
      this.running = null;
      if (again && !this.stopped) void this.pass();
    });
  }

  private note(repo: BuildRepo, pr: ReviewPull, why: string | null) {
    const key = `${repo.github}#${pr.number}`;
    if (why && this.why.get(key) !== why) this.d.say(`review ${repo.title}#${pr.number}: not now, ${why}`);
    this.why.set(key, why);
  }

  private async passOnce() {
    // an end recorded and its thread not settled: settled on its own, each pass
    this.settler.owed('review');
    if (this.running) return;
    for (const repo of this.d.repos()) {
      if (this.stopped || this.running) return;
      if (!repo.github) continue;
      // a job that needs the user holds its repo, whichever lane's it is (After a restart, don't guess)
      const held = this.d.log.needingUser(repo.id)[0];
      if (held) {
        const text = `${repo.title}: no review while ${held.title} needs you`;
        if (this.heldSaid.get(repo.id) !== text) this.d.say(text);
        this.heldSaid.set(repo.id, text);
        continue;
      }
      this.heldSaid.delete(repo.id);
      let pulls: ReviewPull[];
      try {
        pulls = (await this.d.github.pullsToReview(repo.github)).sort((a, b) => a.number - b.number);
      } catch (e) {
        this.d.say(`${repo.title}: GitHub couldn't be read (${(e as Error).message})`);
        continue;
      }
      for (const pr of pulls) {
        let why: string | null;
        try {
          why = await this.whyNot(repo, pr);
        } catch (e) { // GitHub failing on one PR leaves the others to go on
          why = `reading it failed (${(e as Error).message})`;
        }
        this.note(repo, pr, why);
        if (why) continue;
        // one review at a time, and the gate holds every review alike: either way the pass ends
        this.letIn(repo, pr);
        return;
      }
    }
  }

  /** Why this PR isn't reviewed now, or null if it is: cheapest checks first. */
  async whyNot(repo: BuildRepo, pr: ReviewPull): Promise<string | null> {
    const h = pr.headSha;
    const h7 = h.slice(0, 7);
    const jobs = this.d.log.jobs().filter((j) => j.repo === repo.id);
    // one writer per PR: a build writing to its branch, or one that may write again
    const writer = jobs.find((j) => j.kind !== 'review' && j.branch === pr.branch
      && (!j.end || j.end.outcome === 'waiting' || j.end.outcome === 'usage-limit'));
    if (writer) {
      return !writer.end ? `a ${writer.kind} job is still writing to its branch`
        : writer.end.outcome === 'waiting' ? `its ${writer.kind} waits for an answer, and may write to the branch again`
        : `its ${writer.kind} was cut off by a usage limit and resumes after the reset`;
    }
    const done = jobs.filter((j) => j.kind === 'review' && j.issue === pr.number && j.sha === h && j.end);
    const ran = done.filter((j) => REVIEWED.includes(j.end!.outcome));
    if (ran.length) return `the app reviewed ${h7} already (review ${ran.at(-1)!.round}, ${ran.at(-1)!.end!.outcome})`;
    const rest = this.resting.get(`${repo.github}#${pr.number}`) ?? 0;
    if (rest > this.now().getTime()) return `its last review started no thread; it rests until ${new Date(rest).toISOString()}`;
    const failed = done.filter((j) => j.end!.outcome === 'failed').length;
    if (failed >= MAX_FAILED) return `${failed} failed reviews on ${h7}: left until a new head`;
    for (const r of readReviews(await this.d.github.issueComments(repo.github!, pr.number))) {
      if (r.sha && h.startsWith(r.sha)) return `review ${r.round} is on ${h7} already (${r.verdict})`;
    }
    const checks = await this.d.github.checks(repo.github!, h);
    if (checks.state === 'pending') return `checks still running on ${h7} (${checks.pending.join(', ')})`;
    if (checks.state === 'none') return `no checks reported on ${h7} yet`;
    if (checks.state === 'failed') return `a check failed on ${h7} (${checks.failed.join(', ')})`;
    // a head that conflicts with its base gets a conflict round first (#157), as today's runner
    // waits: its pushed head is what's reviewed. GitHub still working it out (null) is no conflict
    if ((await this.d.github.pull(repo.github!, pr.number)).mergeable === false) return `${h7} conflicts with ${pr.base}: a conflict round (or a stop) comes first`;
    return null;
  }

  /** Asks the gate; a review let in starts (tracked, one at a time). False when it waits. */
  private letIn(repo: BuildRepo, pr: ReviewPull): boolean {
    const id = `review:${repo.github}#${pr.number}`;
    const v = this.d.gate.pick(id, 'review');
    const catalog = this.d.catalog();
    let held: string | null = null;
    if (!v.fits) held = holdText(v.hold, (d) => d.toISOString());
    else if (!catalog) held = "T3's providers aren't known yet";
    else {
      const build = kindModels(this.d.jobs(), 'build', catalog).choice?.provider ?? null;
      held = noToolsRefusal(v.choice.provider, this.d.toolFree(), build, provider(catalog, v.choice.provider)?.label ?? v.choice.provider);
    }
    if (held) {
      if (this.holdSaid !== held) this.d.say(`review ${repo.title}#${pr.number} waits: ${held}`);
      this.holdSaid = held;
      return false;
    }
    this.holdSaid = null;
    this.d.gate.forget(id);
    const fit = v as Extract<typeof v, { fits: true }>;
    // named now, from the settings the gate read: the review runs and is named as it was let in
    const reviewer = reviewerName(catalog!, this.d.jobs(), fit.choice, fit.onFallback);
    this.track(this.review(repo, pr, { ...fit, reviewer }, () => this.d.repos().some((r) => r.id === repo.id)));
    return true;
  }

  /** One review of H, start to end, on the choice let in and under the name it was let in as
   *  (`reviewerName`): the settings aren't read again. `served` is asked again right before the
   *  launch, after the slow steps. The live check calls it directly. */
  async review(repo: BuildRepo, pr: ReviewPull, letIn: { choice: ModelChoice; onFallback: boolean; cost: Record<string, number>; reviewer: string },
    served: () => boolean = () => true): Promise<Job> {
    const github = repo.github!;
    const n = pr.number;
    const h = pr.headSha;
    const catalog = this.d.catalog()!;
    const reviewer = letIn.reviewer;
    const earlier = readReviews(await this.d.github.issueComments(github, n));
    const round = nextRound(earlier);
    const title = reviewTitle(repo, n);
    const runDir = join(this.d.stateDir, 'runs', `${slug(repo.title)}-pr${n}-r${round}-${stamp(this.now())}`);
    const wt = join(this.d.stateDir, 'checkouts', `${slug(repo.title)}-pr${n}`);
    const job = await this.d.log.started({
      kind: 'review', repo: repo.id, github, issue: n, branch: pr.branch, base: pr.base, title,
      choice: letIn.choice, onFallback: letIn.onFallback, cost: letIn.cost, sha: h, round, reviewer,
      runDir, checkout: wt, folder: repo.folder,
    });
    this.d.gate.started({ id: job.id, kind: 'review', choice: letIn.choice }, letIn.cost);
    const name = `review ${repo.title}#${n}`;
    const write = (file: string, text: string) => writeFile(join(runDir, file), text);
    let run: Run;
    let launched;
    try {
      await mkdir(runDir, { recursive: true });
      const fetched = await this.d.git.fetchPr(repo.folder, n, pr.base);
      if (fetched !== h) {
        this.d.say(`${name}: the head moved from ${h.slice(0, 7)} to ${fetched.slice(0, 7)}; next pass`);
        return await this.close(job, { folder: repo.folder, wt, n }, { outcome: 'head-moved', error: `Listed at ${h.slice(0, 7)}, fetched at ${fetched.slice(0, 7)}.`, runDir }, false);
      }
      await mkdir(join(this.d.stateDir, 'checkouts'), { recursive: true });
      await this.d.git.checkout(repo.folder, prRef(n), wt);
      const prepared = this.d.deps ? await this.d.deps.prepare(slug(repo.title), wt) : null;
      if (prepared?.how) this.d.say(`${name}: dependencies ${prepared.how}${prepared.ready ? '' : `: ${prepared.note}`}`);
      const last = earlier.at(-1)?.sha ?? null;
      const gone = round > 1 && !(last && await this.d.git.isAncestor(repo.folder, last, h));
      const said_ = await this.conversation(github, n);
      const files = await this.inputs(repo, pr, round, last, gone, runDir, wt, said_);
      const guidelines = await readText(join(wt, 'REVIEW.md'));
      const after = earlier.at(-1)?.at ?? '';
      const brief = reviewBrief({
        github, number: n, title: pr.title, branch: pr.branch, base: pr.base, sha: h, round, earlier, gone,
        checkout: slash(wt), runDir: slash(runDir), projectFolder: slash(repo.folder), files,
        hasAgents: await isFile(join(wt, 'AGENTS.md')), guidelines, tests: testsNote(prepared),
        since: round > 1 ? said_.filter((c) => c.createdAt > after && !runnerPost(c.body)) : [],
      });
      await write('brief.md', brief);
      run = { name, github, n, h, round, reviewer, runDir, wt, folder: repo.folder, gone, hasReviewMd: guidelines !== null };
      // what deciding needs that the log's start line doesn't hold, for a review carried on after a restart
      await write('review.json', `${JSON.stringify({ gone: run.gone, hasReviewMd: run.hasReviewMd })}\n`);
      // nothing is awaited from here to the launch call, so a repo served now is served at launch
      if (!served()) throw new NotStarted(`${repo.title} is no longer served`);
      this.d.say(`${name}: ${reviewer} reviews ${h.slice(0, 7)} (review ${round}) in ${runDir}`);
      try {
        launched = await launchJob(this.d.mcp, catalog, { kind: 'review', projectId: repo.id, title, brief, worktreePath: wt, choice: letIn.choice, toolFree: this.d.toolFree(),
          buildInstance: kindModels(this.d.jobs(), 'build', catalog).choice?.provider ?? null });
      } catch (e) {
        // sent and its answer lost: T3 may have started the thread, and nothing says which one it
        // is. Any other failure (nothing sent, or a refusal T3 answered) started nothing
        if (e instanceof NoAnswer) return await this.needsUser(job, (e as Error).message);
        throw e;
      }
    } catch (e) {
      // nothing ran: a git, GitHub or T3 step failing for a moment (or a launch T3 refused) isn't a
      // failed review, which would count against the head; the PR rests and is tried again
      const error = `${e instanceof NotStarted || e instanceof JobError ? '' : `${(e as Error).name}: `}${(e as Error).message}`;
      await writeFile(join(runDir, 'not-started.txt'), `${error}\n`).catch(() => {});
      this.d.say(`${name} not started: ${error}`);
      this.resting.set(`${github}#${n}`, this.now().getTime() + (this.d.restMs ?? 300_000));
      return await this.close(job, { folder: repo.folder, wt, n }, { outcome: 'not-started', error, runDir }, false);
    }
    const thread = { threadId: launched.threadId, runId: launched.runId, link: launched.link };
    await this.d.log.thread(job.id, thread);
    return this.carryOn({ ...job, ...thread }, run);
  }

  /** A review whose thread runs: watched to its end, read, decided and posted; then recorded, its
   *  checkout removed and its thread settled. Stopped meanwhile, it's left open as it is. */
  private async carryOn(job: Job, run: Run): Promise<Job> {
    let end: JobEnd;
    try {
      end = await this.ran(job, run);
    } catch (e) {
      if (this.stopped) return job; // the next start carries on with its thread
      end = await this.failed(run.name, run.runDir, e);
    }
    return this.close(job, run, end, true);
  }

  /** The run's end, its reply and what the review decided, posted. */
  private async ran(job: Job, run: Run): Promise<JobEnd> {
    const write = (file: string, text: string) => writeFile(join(run.runDir, file), text);
    const ran = await this.watch(job.title, { threadId: job.threadId!, runId: job.runId ?? null });
    if (ran.outcome === 'usage-limit') {
      this.d.say(`${run.name}: the reviewer ran out of usage; nothing counts, and the next review waits on the gate`);
      return { outcome: 'out-of-usage', status: ran.status, error: ran.error, resetAt: ran.resetAt, runDir: run.runDir };
    }
    if (ran.outcome !== 'done') {
      throw new ReviewFailed(ran.outcome === 'waiting' ? `The review thread ${job.threadId} stopped to ask a question instead of reviewing.`
        : `The review thread ${job.threadId} ended ${ran.status}: ${ran.error ?? 'no error given'}`);
    }
    const reply = await this.reply(run.name, job.threadId!, job.runId ?? null);
    if (!reply) throw new ReviewFailed(`The review thread ${job.threadId} completed with an empty reply (read ${EMPTY_READS} times).`);
    await write('reply.md', `${reply}\n`);
    // read afresh, the app's own reviews only: the earlier rounds, and this one if it was posted
    // before the app stopped, so it's never posted twice
    const reviews = readReviews(await this.askAgain(run.name, 'its comments', () => this.d.github.issueComments(run.github, run.n)));
    const earlier = reviews.filter((r) => r.round < run.round);
    const d = decide({
      repo: run.github, sha: run.h, round: run.round, earlier, hasReviewMd: run.hasReviewMd, reply,
      wt: slash(run.wt), runDir: slash(run.runDir), gone: run.gone, reviewer: run.reviewer, user: await this.d.user(),
    });
    const posted = (list: Review[]) => list.find((r) => r.round === run.round && r.sha === run.h);
    const already = (had: Review, why: string) => {
      this.d.say(`${run.name}: review ${run.round} on ${run.h.slice(0, 7)} is on the PR already (${why}); not posted again`);
      return had.url ?? null;
    };
    let url: string | null;
    const had = posted(reviews);
    if (had) url = already(had, 'posted before the app stopped');
    else {
      // a comment that fails to post is posted again after the wait, unless it got there after all
      for (;;) {
        try {
          url = await this.post(run.name, run.github, run.n, d, write);
          break;
        } catch (e) {
          if (!(e instanceof PostFailed)) throw e;
          this.d.say(`${run.name}: ${e.message} Posting it again after a wait.`);
          await this.wait();
          if (this.stopped) throw new Stopping('the lane stopped');
          const now = posted(readReviews(await this.askAgain(run.name, 'its comments', () => this.d.github.issueComments(run.github, run.n))));
          if (now) { url = already(now, 'its post failed and got there after all'); break; }
        }
      }
    }
    if (url) await this.finish(run.name, run.github, run.n, d, url);
    return { outcome: OUTCOMES[d.outcome], verdict: d.verdict, signals: d.signals.map((s) => s.signal), link: url, runDir: run.runDir };
  }

  /** `sol-review` on H and the Review row, once the comment is on the PR: tried again after each
   *  wait until both land (F14). The job stays open meanwhile, so a stop or a restart carries on
   *  here: the next start finds the comment on the PR and finishes it. */
  private async finish(name: string, github: string, n: number, d: Decision, url: string): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Stopping('the lane stopped');
      try {
        return await this.poster.finish(github, n, d, url);
      } catch (e) {
        if (this.stopped) throw new Stopping('the lane stopped');
        const why = e instanceof FinishFailed ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
        this.d.say(`${name}: the review is posted, but ${why} Trying again after a wait.`);
        await this.wait();
      }
    }
  }

  /** The run's reply, read whole. A read T3 fails is asked again after `retry`'s wait, never
   *  taken as no reply (F12); one that comes back empty is read again, and only `EMPTY_READS` in
   *  a row are the thread's own: null. */
  private async reply(name: string, threadId: string, runId: string | null): Promise<string | null> {
    for (let empty = 0; ;) {
      const text = (await this.askAgain(name, 'its reply', () => runReply(this.d.mcp, threadId, runId)))?.trim();
      if (text) return text;
      if (++empty >= EMPTY_READS) return null;
      this.d.say(`${name}: T3 gave its reply empty; reading it again`);
      await this.wait();
      if (this.stopped) throw new Stopping('the lane stopped');
    }
  }

  /** `read`, asked again after `retry`'s wait while it throws: T3 or GitHub failing for a moment
   *  is no answer. Throws Stopping once the lane stops. */
  private async askAgain<T>(name: string, what: string, read: () => Promise<T>): Promise<T> {
    for (;;) {
      if (this.stopped) throw new Stopping('the lane stopped');
      try {
        return await read();
      } catch (e) {
        if (this.stopped) throw new Stopping('the lane stopped');
        this.d.say(`${name}: ${what} couldn't be read (${(e as Error).message}); asking again`);
        await this.wait();
      }
    }
  }

  /** `retry`'s wait; stop() ends it at once. */
  private wait(): Promise<void> {
    return new Promise<void>((done) => {
      let cancel = () => {};
      const wake = () => { this.waits.delete(wake); cancel(); done(); };
      this.waits.add(wake);
      cancel = (this.d.retry ?? retryAfter(30_000))(wake);
    });
  }

  /** A review that failed: said and kept in its run folder; nothing counts. */
  private async failed(name: string, runDir: string, e: unknown): Promise<JobEnd> {
    const error = e instanceof ReviewFailed || e instanceof PostFailed ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
    await writeFile(join(runDir, 'failed.txt'), `${error}\n`).catch(() => {});
    this.d.say(`${name}: review failed, nothing counts: ${error}`);
    return { outcome: 'failed', error, runDir };
  }

  /** The end recorded, after its checkout (if one was made) is removed. The gate measures a
   *  review that ran and drops one that didn't; a thread it ran in is settled, whatever the end:
   *  nobody answers a review thread. */
  private async close(job: Job, checkout: Pick<Run, 'folder' | 'wt' | 'n'> | null, end: JobEnd, launched: boolean): Promise<Job> {
    if (checkout) await this.d.git.removeCheckout(checkout.folder, checkout.wt, prRef(checkout.n));
    if (launched) this.d.gate.finished(job.id, end.outcome === 'out-of-usage' ? { resetAt: end.resetAt ?? null } : undefined);
    else this.d.gate.dropped(job.id);
    const ended = await this.d.log.ended(job.id, end);
    if (launched) await this.settler.settle(ended);
    return ended;
  }

  /** A review T3 may have started a thread for, with no thread id the app could watch: recorded
   *  as needing the user, never matched to a thread by its title, branch or project. Its checkout
   *  stays (the thread may run in it), and its repo starts nothing until the user answers. */
  private needsUser(job: Job, why: string): Promise<Job> {
    this.d.gate.dropped(job.id);
    this.d.say(`${job.title} needs you: ${why}. T3 may have started its thread; nothing else starts in ${job.github ?? job.repo} until you answer.`);
    return this.d.log.ended(job.id, { outcome: 'needs-user', error: why, ...(job.runDir ? { runDir: job.runDir } : {}) });
  }

  /** The decision written to the run folder and the comment posted: its URL (null for a dry run). */
  private async post(name: string, github: string, n: number, d: Decision, write: (f: string, t: string) => Promise<void>): Promise<string | null> {
    await write('comment.md', d.body);
    await write('decision.json', `${JSON.stringify({
      repo: github, pr: n, round: d.round, sha: d.sha, verdict: d.verdict, outcome: d.outcome, signals: d.signals,
      status: d.status, kept: d.kept, unaddressed: d.unaddressed, issues: d.issues.map((i) => ({ id: i.id, title: i.title })),
      findings: d.findings, reviewer: d.reviewer,
    }, null, 2)}\n`);
    const url = await this.poster.post(github, n, d);
    const why = d.signals.length ? ` (${d.signals.map((s) => s.text).join('; ')})` : '';
    this.d.say(`${name}: review ${d.round} on ${d.sha.slice(0, 7)} is ${d.verdict} by ${d.reviewer}, next: ${d.outcome}${why}`);
    return url;
  }

  /** Everything said on the PR: its comments, review threads and review bodies, oldest first. */
  private async conversation(github: string, n: number): Promise<Comment[]> {
    const all = [...await this.d.github.issueComments(github, n), ...await this.d.github.reviewReplies(github, n)];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Writes the reviewer's inputs to the run folder; the brief's list of them. */
  private async inputs(repo: BuildRepo, pr: ReviewPull, round: number, last: string | null, gone: boolean, runDir: string, wt: string, conversation: Comment[]): Promise<string[]> {
    const write = (file: string, text: string) => writeFile(join(runDir, file), text);
    const h = pr.headSha;
    const full = await this.d.git.diff(repo.folder, `origin/${pr.base}`, h, true);
    const files: string[] = [];
    if (round > 1 && !gone && last) {
      await write('change.diff', await this.d.git.diff(repo.folder, last, h));
      await write('full.diff', full);
      files.push(`\`change.diff\`: the change since your last review, ${last.slice(0, 7)}..${h.slice(0, 7)}`, `\`full.diff\`: the PR's whole diff against \`${pr.base}\`, for context`);
    } else {
      await write('change.diff', full);
      files.push(`\`change.diff\`: the PR's whole diff against \`${pr.base}\`${gone ? ' (the commit you last reviewed is gone)' : ''}`);
    }
    await write('pr.md', `# PR #${pr.number}: ${pr.title}\n\nMerges \`${pr.branch}\` into \`${pr.base}\`; head ${h}.\n\n${pr.body}\n`);
    files.push("`pr.md`: the PR's description");
    const shots = await this.d.git.evidence(repo.folder, pr.number, join(runDir, 'evidence'));
    files.push(shots.length ? `\`evidence/\`: the PR's screenshots, ${shots.map((s) => `\`${s}\``).join(', ')}: open each one`
      : 'No screenshots are published for this PR (its `evidence/` would hold them)');
    const here = repo.github!.toLowerCase();
    for (const [where, k] of closedIssues(pr.body, here)) {
      const issue = await this.d.github.issue(where, k);
      const comments = await this.d.github.issueComments(where, k);
      const file = where === here ? `issue-${k}.md` : `issue-${where.replace('/', '_')}-${k}.md`;
      await write(file, `# Issue ${where === here ? `#${k}` : `${where}#${k}`}: ${issue.title}\n\n${issue.body}\n\n## Comments\n\n${comments.map(said).join('') || 'None.\n'}`);
      files.push(`\`${file}\`: the issue it closes (the ticket), with its comments`);
    }
    if (conversation.length) {
      await write('conversation.md', `# PR #${pr.number}: everything said on it so far\n\n${conversation.map(said).join('')}`);
      files.push("`conversation.md`: the PR's comments, review threads and review bodies so far, earlier reviews and their ledgers included");
    }
    if (await isFile(join(wt, 'AGENTS.md'))) files.push("`AGENTS.md` in this workdir: the repo's rules; read it first, and the docs it points to for what the PR touches");
    return files;
  }

  private async watch(title: string, thread: { threadId: string; runId: string | null }): Promise<ThreadEnd> {
    const w = watchThreadEnd(this.d.ws, thread.threadId, thread.runId, this.d.retry,
      (why) => this.d.say(`${title}: T3's thread stream dropped (${why}); opening it again`));
    this.watches.add(w);
    try {
      return await w.end;
    } finally {
      this.watches.delete(w);
    }
  }

  /** A review the log shows open, left by an app that stopped mid-review: reserved in the gate at
   *  its logged cost; with its saved thread id it carries on with that thread, with none it needs
   *  the user. A start line without what carrying on needs (an earlier app's) has its thread
   *  watched to its end and counts as failed. */
  private async resume(job: Job): Promise<Job> {
    this.d.gate.started({ id: job.id, kind: 'review', choice: job.choice }, job.cost ?? {});
    if (!job.threadId) return this.needsUser(job, 'the app stopped before T3 named its thread');
    const name = `review ${job.title}`;
    this.d.say(`${name}: carrying on with its thread after the app stopped: ${job.link ?? job.threadId}`);
    const kept = job.runDir ? await readText(join(job.runDir, 'review.json')) : null;
    let saved: { gone?: unknown; hasReviewMd?: unknown } | null = null;
    try { saved = kept ? JSON.parse(kept) : null; } catch { saved = null; }
    if (!saved || !job.github || !job.sha || !job.round || !job.reviewer || !job.runDir || !job.checkout || !job.folder) {
      try {
        await this.watch(job.title, { threadId: job.threadId, runId: job.runId ?? null });
      } catch {
        return job; // stopped: left open for the next start
      }
      return this.close(job, null, { outcome: 'failed', error: 'The app stopped mid-review, and its start line has no run folder to carry on from.' }, true);
    }
    return this.carryOn(job, {
      name, github: job.github, n: job.issue, h: job.sha, round: job.round, reviewer: job.reviewer,
      runDir: job.runDir, wt: job.checkout, folder: job.folder, gone: saved.gone === true, hasReviewMd: saved.hasReviewMd === true,
    });
  }
}
