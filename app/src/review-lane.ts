// The review lane (#155; today's `queue_runner/review.py`, ported, docs/flow.md The review loop):
// every open PR in a served repo without a review on its newest commit H gets one, whoever opened
// it, once the checks on H pass (`sol-review` not counted). One review at a time for now (#106
// runs them at once later). A review:
//
//   the usage gate lets it in, on the review kind's model or, while that provider has no room, its
//   fallback (#69)  ->  the PR's head fetched; moved since listing: head-moved, nothing counts
//   ->  a detached checkout of H in the state folder, the repo's dependencies linked in
//   ->  the inputs in a run folder (the diffs, the PR, the issues it closes, what's been said,
//       the screenshots) and the brief (src/briefs/review.ts)
//   ->  t3_thread_launch in the project's folder, told to work in the checkout
//   ->  its end from T3's thread events; its reply read whole
//   ->  decide (src/review/ledger.ts): the verdict from the reply's sol-findings block
//   ->  post (src/review/post.ts): follow-ups, the comment, sol-review on H, the Review row
//   ->  the end recorded, the checkout removed, the thread settled
//
// **No outside tools** (docs/reviews.md): a review runs only on a T3 provider instance the user
// named as set up without them (`toolFreeInstances`), as today's fallback reviews run on the one
// instance its config names (#127). The app can't see an instance's tools without
// naming its driver, so the list is the user's word, and launchJob refuses any instance not on it.
// The lane asks first, so such a review waits and says why instead of failing; nor does one run on
// the instance builds run on, which has their tools, whatever the list says.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewBrief, said } from './briefs/review.ts';
import { holdText } from './gate.ts';
import type { GitHubReview, ReviewPull } from './github.ts';
import { prRef, type ReviewGit } from './git.ts';
import { REVIEWED, type Job, type JobEnd, type JobLog } from './job-log.ts';
import { kindModels, model, provider, type Catalog, type Jobs, type ModelChoice } from './jobs.ts';
import { launchJob, toolsHeld } from './launch.ts';
import { closedIssues } from './picker.ts';
import type { Deps } from './review/deps.ts';
import { testsNote } from './review/deps.ts';
import { decide, nextRound, readReviews, ReviewFailed, runnerPost, type Comment, type Decision } from './review/ledger.ts';
import { GitHubPoster, PostFailed, type GitHubPosts, type Poster } from './review/post.ts';
import type { BuildRepo } from './build-lane.ts';
import type { Retry } from './t3/project-feed.ts';
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
  github: GitHubReview & GitHubPosts;
  git: ReviewGit;
  /** Links a checkout's dependencies in; null installs nothing. */
  deps: Pick<Deps, 'prepare'> | null;
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe'>;
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
  now?: () => Date;
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

export class ReviewLane {
  private d: ReviewLaneDoors;
  private poster: Poster;
  private now: () => Date;
  private running: Promise<unknown> | null = null;
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private watches = new Set<{ stop(): void }>();
  private why = new Map<string, string | null>();
  private holdSaid: string | null = null;

  constructor(doors: ReviewLaneDoors) {
    this.d = doors;
    this.poster = doors.poster ?? new GitHubPoster(doors.github, doors.say);
    this.now = doors.now ?? (() => new Date());
  }

  /** A review the log shows open (an app that stopped mid-review) is watched to its thread's end
   *  and counted as failed; then a pass. */
  start(): Promise<void> {
    const open = this.d.log.open().filter((j) => j.kind === 'review');
    if (open.length) this.track(Promise.all(open.map((j) => this.cutOff(j))));
    return this.pass();
  }

  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
  }

  /** T3 read new usage: a pass, if a review waits on the gate. */
  usageChanged(): void {
    if (this.holdSaid) void this.pass();
  }

  /** Whether a review runs now. */
  busy(): boolean {
    return this.running !== null;
  }

  /** Settles once the review under way and any pass have ended (the tests wait on it). */
  async idle(): Promise<void> {
    while (this.running || this.passing) await Promise.allSettled([this.running, this.passing]);
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

  /** The review under way; once it ends, a pass, unless its head had moved: GitHub's list may
   *  still show the old head, and a pass now would fetch the moved one again at once. */
  private track(p: Promise<unknown>) {
    this.running = p;
    p.then((job) => (job as Job | undefined)?.end?.outcome !== 'head-moved', (e) => {
      this.d.say(`a review stopped: ${(e as Error).message}`);
      return true;
    }).then((again) => {
      this.running = null;
      if (again) void this.pass();
    });
  }

  private note(repo: BuildRepo, pr: ReviewPull, why: string | null) {
    const key = `${repo.github}#${pr.number}`;
    if (why && this.why.get(key) !== why) this.d.say(`review ${repo.title}#${pr.number}: not now, ${why}`);
    this.why.set(key, why);
  }

  private async passOnce() {
    if (this.running) return;
    for (const repo of this.d.repos()) {
      if (this.stopped || this.running) return;
      if (!repo.github) continue;
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
    const failed = done.filter((j) => j.end!.outcome === 'failed').length;
    if (failed >= MAX_FAILED) return `${failed} failed reviews on ${h7}: left until a new head`;
    for (const r of readReviews(await this.d.github.issueComments(repo.github!, pr.number))) {
      if (r.sha && h.startsWith(r.sha)) return `review ${r.round} is on ${h7} already (${r.verdict})`;
    }
    const checks = await this.d.github.checks(repo.github!, h);
    if (checks.state === 'pending') return `checks still running on ${h7} (${checks.pending.join(', ')})`;
    if (checks.state === 'none') return `no checks reported on ${h7} yet`;
    if (checks.state === 'failed') return `a check failed on ${h7} (${checks.failed.join(', ')})`;
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
      const build = kindModels(this.d.jobs(), 'build', catalog).choice;
      if (!this.d.toolFree().includes(v.choice.provider)) held = toolsHeld(provider(catalog, v.choice.provider)?.label ?? v.choice.provider);
      else if (build && build.provider === v.choice.provider) {
        held = `the review would run on ${provider(catalog, v.choice.provider)?.label ?? v.choice.provider}, the instance builds run on, which has their tools: a review needs an instance set up without outside tools (docs/reviews.md)`;
      }
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
    this.track(this.review(repo, pr, { ...fit, reviewer }));
    return true;
  }

  /** One review of H, start to end, on the choice let in and under the name it was let in as
   *  (`reviewerName`): the settings aren't read again. The live check calls it directly. */
  async review(repo: BuildRepo, pr: ReviewPull, letIn: { choice: ModelChoice; onFallback: boolean; cost: Record<string, number>; reviewer: string }): Promise<Job> {
    const github = repo.github!;
    const n = pr.number;
    const h = pr.headSha;
    const catalog = this.d.catalog()!;
    const reviewer = letIn.reviewer;
    const earlier = readReviews(await this.d.github.issueComments(github, n));
    const round = nextRound(earlier);
    const title = reviewTitle(repo, n);
    const job = await this.d.log.started({
      kind: 'review', repo: repo.id, github, issue: n, branch: pr.branch, base: pr.base, title,
      choice: letIn.choice, onFallback: letIn.onFallback, sha: h, round, reviewer,
    });
    this.d.gate.started({ id: job.id, kind: 'review', choice: letIn.choice }, letIn.cost);
    const name = `review ${repo.title}#${n}`;
    const runDir = join(this.d.stateDir, 'runs', `${slug(repo.title)}-pr${n}-r${round}-${stamp(this.now())}`);
    const wt = join(this.d.stateDir, 'checkouts', `${slug(repo.title)}-pr${n}`);
    const write = (file: string, text: string) => writeFile(join(runDir, file), text);
    const ran_: { thread: { threadId: string; runId: string | null; link: string | null } | null } = { thread: null };
    let end: JobEnd;
    try {
      await mkdir(runDir, { recursive: true });
      end = await (async (): Promise<JobEnd> => {
        const fetched = await this.d.git.fetchPr(repo.folder, n, pr.base);
        if (fetched !== h) {
          this.d.say(`${name}: the head moved from ${h.slice(0, 7)} to ${fetched.slice(0, 7)}; next pass`);
          return { outcome: 'head-moved', error: `Listed at ${h.slice(0, 7)}, fetched at ${fetched.slice(0, 7)}.`, runDir };
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
        this.d.say(`${name}: ${reviewer} reviews ${h.slice(0, 7)} (review ${round}) in ${runDir}`);
        const launched = await launchJob(this.d.mcp, catalog, { kind: 'review', projectId: repo.id, title, brief, choice: letIn.choice, toolFree: this.d.toolFree() });
        const thread = { threadId: launched.threadId, runId: launched.runId, link: launched.link };
        ran_.thread = thread;
        await this.d.log.thread(job.id, thread);
        const ran = await this.watch(job.title, thread);
        if (ran.outcome === 'usage-limit') {
          this.d.say(`${name}: the reviewer ran out of usage; nothing counts, and the next review waits on the gate`);
          return { outcome: 'out-of-usage', status: ran.status, error: ran.error, resetAt: ran.resetAt, runDir };
        }
        if (ran.outcome !== 'done') {
          throw new ReviewFailed(ran.outcome === 'waiting' ? `The review thread ${thread.threadId} stopped to ask a question instead of reviewing.`
            : `The review thread ${thread.threadId} ended ${ran.status}: ${ran.error ?? 'no error given'}`);
        }
        const reply = (await runReply(this.d.mcp, thread.threadId, thread.runId))?.trim();
        if (!reply) throw new ReviewFailed(`The review thread ${thread.threadId} completed with an empty reply.`);
        await write('reply.md', `${reply}\n`);
        const d = decide({ repo: github, sha: h, round, earlier, hasReviewMd: guidelines !== null, reply, wt: slash(wt), runDir: slash(runDir), gone, reviewer, user: await this.d.user() });
        return await this.post(name, github, n, d, runDir, write);
      })();
    } catch (e) {
      const error = e instanceof ReviewFailed || e instanceof PostFailed ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
      await writeFile(join(runDir, 'failed.txt'), `${error}\n`).catch(() => {});
      this.d.say(`${name}: review failed, nothing counts: ${error}`);
      end = { outcome: 'failed', error, runDir };
    } finally {
      await this.d.git.removeCheckout(repo.folder, wt, prRef(n));
    }
    const thread = ran_.thread;
    if (thread) this.d.gate.finished(job.id);
    else this.d.gate.dropped(job.id);
    const ended = await this.d.log.ended(job.id, end);
    // recorded first, then settled: nobody answers a review thread, whatever its end
    if (thread) await this.settle(name, thread.threadId);
    return ended;
  }

  private async post(name: string, github: string, n: number, d: Decision, runDir: string, write: (f: string, t: string) => Promise<void>): Promise<JobEnd> {
    await write('comment.md', d.body);
    await write('decision.json', `${JSON.stringify({
      repo: github, pr: n, round: d.round, sha: d.sha, verdict: d.verdict, outcome: d.outcome, signals: d.signals,
      status: d.status, kept: d.kept, unaddressed: d.unaddressed, issues: d.issues.map((i) => ({ id: i.id, title: i.title })),
      findings: d.findings, reviewer: d.reviewer,
    }, null, 2)}\n`);
    const url = await this.poster.post(github, n, d);
    const why = d.signals.length ? ` (${d.signals.map((s) => s.text).join('; ')})` : '';
    this.d.say(`${name}: review ${d.round} on ${d.sha.slice(0, 7)} is ${d.verdict} by ${d.reviewer}, next: ${d.outcome}${why}`);
    return { outcome: OUTCOMES[d.outcome], verdict: d.verdict, signals: d.signals.map((s) => s.signal), link: url, runDir };
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

  /** A review left open by an app that stopped mid-review: its thread (if it got one) is
   *  watched to its end, then the review counts as failed, nothing posted, and the thread is
   *  settled. */
  private async cutOff(job: Job): Promise<Job> {
    const name = `review ${job.title}`;
    if (job.threadId) {
      const v = this.d.gate.check({ id: job.id, kind: 'review', choice: job.choice });
      this.d.gate.started({ id: job.id, kind: 'review', choice: job.choice }, v.fits ? v.cost : {});
      this.d.say(`${name}: cut off with the app; its thread runs on in ${job.link ?? job.threadId}: counted as failed once it ends`);
      await this.watch(job.title, { threadId: job.threadId, runId: job.runId ?? null });
      this.d.gate.finished(job.id);
    }
    const ended = await this.d.log.ended(job.id, { outcome: 'failed', error: 'The app stopped mid-review.' });
    if (job.threadId) await this.settle(name, job.threadId);
    this.d.say(`${name}: cut off with the app; counted as failed`);
    return ended;
  }

  private async settle(name: string, threadId: string) {
    try {
      await this.d.mcp.call('t3_thread_organize', { threadId, action: 'settle' });
    } catch (e) {
      this.d.say(`${name}: settling its thread ${threadId} failed (${(e as Error).message}); left as it is`);
    }
  }
}

