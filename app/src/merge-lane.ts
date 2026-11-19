// The merge lane (#156; today's `queue_runner/merge.py`, ported, without its live steps: merged is
// the end, #68): a PR whose newest review, the app's own of its head H, is clean merges, or in a
// repo where the user merges is marked `ready-to-merge` and waits.
//
//   clean on H  ->  the re-check, read afresh just before: still open at H, not a draft, nothing
//   writing to its branch, its repo not held for the user, fewer than 2 failed merges on H, its
//   newest review comment the clean one on H, checks passed on H (`sol-review` not counted), no
//   conflict (GitHub's `mergeable` true: null, not known yet, waits for a later pass), nothing said
//   since that review, no unresolved review thread
//   ->  the runner merges: a `merge` step, then GitHub's merge naming H (`sha`, a merge commit).
//       GitHub's 409 (the head moved meanwhile) is `head-moved`: nothing merged, the new head is
//       reviewed (`headMoved`)
//   ->  or the user merges: `ready-to-merge` on the PR, a `ready` step `marked`, once per head. The
//       mark comes off (`unmarked`) when the head moves or the re-check fails; a marked PR gone
//       from the open list is read: merged by the user (noticed: a `merge` step `by: user`), or
//       closed, which unmarks it
//   ->  after a merge, either's: the PR's worktrees and branches removed (found by branch in `git
//       worktree list`) and every thread the app ran on the PR settled, then `cleaned`; folders T3
//       still held then are swept on later passes (docs/t3.md)
//
// A merge step with no end (the app stopped mid-merge) is read from GitHub on the next pass; a
// merge not yet cleaned is cleaned then. A read that fails is said and tried next pass, never taken
// as "merged" or "gone".
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { BuildRepo } from './build-lane.ts';
import type { FixGit } from './git.ts';
import { HeadMoved, type GitHubMerge, type GitHubReview, type MergePull, type ReviewPull } from './github.ts';
import { REVIEWED, type Job, type JobLog, type Step } from './job-log.ts';
import { readReviews, runnerPost, type Comment } from './review/ledger.ts';
import { ThreadSettler } from './settle.ts';
import type { T3Mcp } from './t3/mcp.ts';

/** The label on a PR that's ready for the user to merge (#156: it was `ready-for-stefan`). */
export const READY = 'ready-to-merge';
/** The re-check's answer while GitHub hasn't worked out whether the PR conflicts: wait, and read
 *  it again next pass. Not a reason to take a mark off. */
const MERGEABLE_UNKNOWN = "GitHub hasn't worked out yet whether it conflicts; read again next pass";
/** Failed merges on one head before the lane leaves it until a new head. */
export const MAX_FAILED_MERGES = 2;

export type MergeLaneDoors = {
  /** The served repos, each with who merges (`merge`, default the user). */
  repos: () => BuildRepo[];
  github: Pick<GitHubReview, 'pullsToReview' | 'issueComments' | 'reviewReplies' | 'checks'> & GitHubMerge;
  git: Pick<FixGit, 'worktrees' | 'removeWorktree' | 'deleteBranch' | 'isClean'>;
  mcp: Pick<T3Mcp, 'call'>;
  log: JobLog;
  say: (line: string) => void;
  /** Removes a folder git no longer lists; true once it's gone. */
  removeFolder?: (path: string) => Promise<boolean>;
  /** Whether a folder is still there. */
  exists?: (path: string) => boolean;
  /** A PR merged (the build lane passes: the repo's one ticket is done). */
  merged?: (repo: BuildRepo) => void;
  /** A merge GitHub refused on a moved head (the review lane passes: the new head is reviewed). */
  headMoved?: () => void;
};

const WRITING = (j: Job) => !j.end || j.end.outcome === 'waiting' || j.end.outcome === 'usage-limit';
const defaultRemove = async (path: string) => {
  await rm(path, { recursive: true, force: true }).catch(() => {});
  return !existsSync(path);
};

export class MergeLane {
  private d: MergeLaneDoors;
  private settler: ThreadSettler;
  private why = new Map<string, string | null>();
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(doors: MergeLaneDoors) {
    this.d = doors;
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  stop() {
    this.stopped = true;
  }

  async idle(): Promise<void> {
    while (this.passing || this.settler.pending().length) await Promise.allSettled([this.passing, ...this.settler.pending()]);
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
    if (why && this.why.get(key) !== why) this.d.say(`${name}: not now, ${why}`);
    this.why.set(key, why);
  }

  private async passOnce() {
    const repos = this.d.repos();
    const repoOf = (id: string) => repos.find((r) => r.id === id);
    // left from before: a merge the app stopped in the middle of, a clean-up owed, folders to sweep
    for (const step of this.d.log.steps()) {
      if (this.stopped) return;
      const repo = repoOf(step.repo);
      if (!repo) continue;
      if (step.kind === 'merge' && !step.end) await this.cutOff(repo, step);
      const now = this.d.log.steps().find((s) => s.id === step.id)!;
      if (now.end?.outcome === 'merged' && !now.cleanedAt) await this.cleanUp(repo, now);
      else if (now.cleanedAt && now.left?.length && !now.sweptAt) await this.sweep(repo, now);
    }
    for (const repo of repos) {
      if (this.stopped) return;
      if (!repo.github) continue;
      let pulls: ReviewPull[];
      try {
        pulls = (await this.d.github.pullsToReview(repo.github)).sort((a, b) => a.number - b.number);
        if ((repo.merge ?? 'me') === 'me') await this.marksPass(repo, pulls);
        await this.noticePass(repo, pulls);
      } catch (e) {
        this.d.say(`${repo.title}: GitHub couldn't be read for merges (${(e as Error).message})`);
        continue;
      }
      for (const pr of pulls) {
        if (this.stopped) return;
        if (!this.cleanOnHead(repo, pr.number, pr.headSha)) continue;
        if ((repo.merge ?? 'me') === 'me' && this.marked(repo, pr.number)?.sha === pr.headSha) continue;
        const key = `${repo.github}#${pr.number}`;
        const name = `merge ${repo.title}#${pr.number}`;
        let why: string | null;
        try {
          why = await this.whyNot(repo, pr.number, pr.headSha);
        } catch (e) {
          why = `reading it failed (${(e as Error).message})`;
        }
        this.note(key, name, why);
        if (why) continue;
        // asked again after the re-check's reads: a repo switched off, or to the user merging,
        // meanwhile is never merged by the app
        const now = this.d.repos().find((r) => r.id === repo.id);
        if (!now) continue;
        if ((now.merge ?? 'me') === 'runner') await this.merge(now, pr);
        else await this.mark(now, pr);
      }
    }
  }

  /** The app's newest review of the PR's head is clean, and no merge on H has landed. */
  private cleanOnHead(repo: BuildRepo, n: number, h: string): boolean {
    const done = this.d.log.jobs().filter((j) => j.kind === 'review' && j.repo === repo.id && j.issue === n && j.sha === h && j.end && REVIEWED.includes(j.end.outcome));
    return done.at(-1)?.end?.outcome === 'clean'
      && !this.d.log.steps().some((s) => s.kind === 'merge' && s.repo === repo.id && s.pr === n && s.end?.outcome === 'merged');
  }

  /** The re-check just before a merge or a mark, read afresh: why not at H now, or null. */
  async whyNot(repo: BuildRepo, n: number, h: string): Promise<string | null> {
    const github = repo.github!;
    const h7 = h.slice(0, 7);
    const pr = await this.d.github.pull(github, n);
    if (pr.state !== 'open') return `it is ${pr.state}`;
    if (pr.headSha !== h) return `the head moved from ${h7} to ${pr.headSha.slice(0, 7)}: it's reviewed first`;
    if (pr.draft) return 'it is a draft';
    const writer = this.d.log.jobs().find((j) => j.repo === repo.id && j.kind !== 'review' && j.branch === pr.branch && WRITING(j));
    if (writer) return `a ${writer.kind} job is writing to ${pr.branch}`;
    const held = this.d.log.needingUser(repo.id)[0];
    if (held) return `${held.title} needs you`;
    const failed = this.d.log.steps().filter((s) => s.kind === 'merge' && s.repo === repo.id && s.pr === n && s.sha === h && s.end?.outcome === 'failed').length;
    if (failed >= MAX_FAILED_MERGES) return `${failed} merges failed on ${h7}: left until a new head`;
    const comments = await this.d.github.issueComments(github, n);
    const last = readReviews(comments).at(-1);
    if (!last || !h.startsWith(last.sha) || last.verdict !== 'clean') return `its newest review comment is not a clean review of ${h7}`;
    const checks = await this.d.github.checks(github, h);
    if (checks.state !== 'passed') {
      const more = [...checks.failed, ...checks.pending].join(', ');
      return `checks on ${h7} are ${checks.state}${more ? ` (${more})` : ''}`;
    }
    if (pr.mergeable === false) return `it conflicts with ${pr.base}`;
    // GitHub still working it out is not known yet (#157 F5): no merge or mark on a guess, and a
    // mark already on stays
    if (pr.mergeable === null) return MERGEABLE_UNKNOWN;
    const said = saidSince([...comments, ...await this.d.github.reviewReplies(github, n)], last.at);
    if (said.length) {
      const who = [...new Set(said.map((c) => c.author))].join(', ');
      return `${said.length} repl${said.length === 1 ? 'y' : 'ies'} since the clean review (${who}): you read ${said.length === 1 ? 'it' : 'them'} first`;
    }
    const threads = await this.d.github.openThreads(github, n);
    if (threads) return `${threads} unresolved review thread${threads === 1 ? '' : 's'}`;
    return null;
  }

  /** Merges at H. GitHub refusing the old head (409) is head-moved, and the new head is reviewed. */
  private async merge(repo: BuildRepo, pr: ReviewPull): Promise<void> {
    const github = repo.github!;
    const name = `merge ${repo.title}#${pr.number}`;
    const h = pr.headSha;
    const step = await this.d.log.stepStarted({ kind: 'merge', repo: repo.id, github, pr: pr.number, branch: pr.branch, sha: h });
    let commit: string | null;
    try {
      commit = await this.d.github.merge(github, pr.number, h);
    } catch (e) {
      const error = (e as Error).message;
      let now: { state: string; headSha: string } | null = null;
      if (!(e instanceof HeadMoved)) {
        try {
          now = await this.d.github.pull(github, pr.number);
        } catch {
          // a merge whose answer was lost may have landed: the step stays open, and the next
          // pass reads GitHub again (cutOff) rather than take it as failed
          this.d.say(`${name}: the merge at ${h.slice(0, 7)} got no clear answer (${error}), and GitHub can't say yet whether it merged; next pass`);
          return;
        }
        if (now.state === 'merged') {
          const done = await this.d.log.stepEnded(step.id, { outcome: 'merged', by: 'app' });
          this.d.say(`${name}: merged at ${h.slice(0, 7)}, though GitHub's answer was lost (${error})`);
          await this.cleanUp(repo, done);
          this.d.merged?.(repo);
          return;
        }
      }
      if (e instanceof HeadMoved || (now && now.headSha !== h)) {
        await this.d.log.stepEnded(step.id, { outcome: 'head-moved', error });
        this.d.say(`${name}: the head moved from ${h.slice(0, 7)} before the merge; the new head is reviewed first`);
        this.d.headMoved?.();
        return;
      }
      await this.d.log.stepEnded(step.id, { outcome: 'failed', error });
      this.d.say(`${name}: the merge at ${h.slice(0, 7)} failed: ${error}`);
      return;
    }
    const done = await this.d.log.stepEnded(step.id, { outcome: 'merged', by: 'app', commit });
    this.d.say(`${name}: merged at ${h.slice(0, 7)}${commit ? ` (merge commit ${commit.slice(0, 7)})` : ''}`);
    await this.cleanUp(repo, done);
    this.d.merged?.(repo);
  }

  /** A merge step the app stopped in the middle of: GitHub says whether it merged. */
  private async cutOff(repo: BuildRepo, step: Step): Promise<void> {
    const name = `merge ${repo.title}#${step.pr}`;
    let state: string;
    try {
      state = (await this.d.github.pull(step.github, step.pr)).state;
    } catch (e) {
      this.d.say(`${name}: cut off when the app stopped, and GitHub can't say yet whether it merged (${(e as Error).message}); next pass`);
      return;
    }
    if (state === 'merged') {
      await this.d.log.stepEnded(step.id, { outcome: 'merged', by: 'app' });
      this.d.say(`${name}: cut off when the app stopped; it merged`);
      this.d.merged?.(repo);
    } else {
      await this.d.log.stepEnded(step.id, { outcome: 'failed', error: 'The app stopped mid-merge.' });
      this.d.say(`${name}: cut off when the app stopped; it did not merge`);
    }
  }

  // --- the user merges -----------------------------------------------------------------------

  /** The PR's newest mark, if it's on: its step. */
  private marked(repo: BuildRepo, n: number): Step | null {
    const last = this.d.log.steps().filter((s) => s.kind === 'ready' && s.repo === repo.id && s.pr === n && s.end).at(-1);
    return last?.end?.outcome === 'marked' ? last : null;
  }

  private async mark(repo: BuildRepo, pr: ReviewPull): Promise<void> {
    const github = repo.github!;
    const name = `ready ${repo.title}#${pr.number}`;
    const step = await this.d.log.stepStarted({ kind: 'ready', repo: repo.id, github, pr: pr.number, branch: pr.branch, sha: pr.headSha });
    try {
      const now = await this.d.github.pull(github, pr.number);
      if (!now.labels.includes(READY)) await this.d.github.addLabel(github, pr.number, READY);
    } catch (e) {
      await this.d.log.stepEnded(step.id, { outcome: 'failed', error: (e as Error).message });
      this.d.say(`${name}: labelling it ${READY} failed (${(e as Error).message}); next pass`);
      return;
    }
    await this.d.log.stepEnded(step.id, { outcome: 'marked' });
    this.d.say(`${name}: clean at ${pr.headSha.slice(0, 7)} with its checks passed: labelled ${READY}, for you to merge ${pr.url}`);
  }

  /** Marks come off the open PRs the re-check no longer passes. */
  private async marksPass(repo: BuildRepo, pulls: ReviewPull[]): Promise<void> {
    for (const pr of pulls) {
      const last = this.marked(repo, pr.number);
      if (!last) continue;
      const why = pr.headSha !== last.sha ? `the head moved from ${last.sha.slice(0, 7)} to ${pr.headSha.slice(0, 7)}: it's reviewed first`
        : !this.cleanOnHead(repo, pr.number, pr.headSha) ? `its review of ${pr.headSha.slice(0, 7)} is no longer clean`
        : await this.whyNot(repo, pr.number, pr.headSha);
      if (why && why !== MERGEABLE_UNKNOWN) await this.unmark(repo, last, why);
    }
  }

  /** Each PR the app reviewed or marked that's gone from the open list is read once: merged (by
   *  the user, or by hand where the runner merges), its merge is recorded, its threads settled and
   *  its clean-up run, whatever its label history (#156 F14: a mark taken off by a reply, then a
   *  merge); closed, it's recorded closed and a mark on it comes off. Either way it's done with:
   *  never read again. GitHub's list lagging (still open) leaves it for the next pass. */
  private async noticePass(repo: BuildRepo, pulls: ReviewPull[]): Promise<void> {
    const listed = new Set(pulls.map((p) => p.number));
    const done = new Set(this.d.log.steps().filter((s) => s.kind === 'merge' && s.repo === repo.id
      && (s.end?.outcome === 'merged' || s.end?.outcome === 'closed' || !s.end)).map((s) => s.pr));
    const known = new Set([
      ...this.d.log.jobs().filter((j) => j.kind === 'review' && j.repo === repo.id).map((j) => j.issue),
      ...this.d.log.steps().filter((s) => s.kind === 'ready' && s.repo === repo.id).map((s) => s.pr),
    ]);
    for (const n of [...known].sort((a, b) => a - b)) {
      if (this.stopped) return;
      if (listed.has(n) || done.has(n)) continue;
      let now: MergePull;
      try {
        now = await this.d.github.pull(repo.github!, n);
      } catch (e) { // one PR GitHub won't answer for holds up no other: said once, tried next pass
        this.note(`${repo.github}#${n} notice`, `merge ${repo.title}#${n}`, `GitHub couldn't say whether it merged (${(e as Error).message})`);
        continue;
      }
      if (now.state === 'open') continue;
      const mark = this.marked(repo, n);
      if (now.state === 'merged') {
        // the label goes too, so a merged PR isn't left saying it's ready (said if it fails)
        if (now.labels.includes(READY)) {
          await this.d.github.removeLabel(repo.github!, n, READY).catch((e: Error) => this.d.say(`merge ${repo.title}#${n}: removing ${READY} failed (${e.message})`));
        }
        await this.userMerged(repo, n, now.branch, now.headSha, mark?.sha ?? null);
        continue;
      }
      if (mark) await this.unmark(repo, mark, 'closed without merging');
      const step = await this.d.log.stepStarted({ kind: 'merge', repo: repo.id, github: repo.github!, pr: n, branch: now.branch, sha: now.headSha });
      await this.d.log.stepEnded(step.id, { outcome: 'closed', why: 'closed without merging' });
      this.d.say(`merge ${repo.title}#${n}: closed without merging; done with`);
    }
  }

  private async unmark(repo: BuildRepo, last: Step, why: string): Promise<void> {
    const name = `ready ${repo.title}#${last.pr}`;
    try {
      await this.d.github.removeLabel(repo.github!, last.pr, READY);
    } catch (e) { // left marked: the next pass tries again
      this.note(`${repo.github}#${last.pr} unmark`, name, `no longer ready (${why}), but removing ${READY} failed (${(e as Error).message})`);
      return;
    }
    const step = await this.d.log.stepStarted({ kind: 'ready', repo: repo.id, github: repo.github!, pr: last.pr, branch: last.branch, sha: last.sha });
    await this.d.log.stepEnded(step.id, { outcome: 'unmarked', why });
    this.d.say(`${name}: no longer ready for you (${why}); ${READY} removed`);
  }

  private async userMerged(repo: BuildRepo, n: number, branch: string, head: string, ready: string | null): Promise<void> {
    const step = await this.d.log.stepStarted({ kind: 'merge', repo: repo.id, github: repo.github!, pr: n, branch, sha: head });
    const done = await this.d.log.stepEnded(step.id, { outcome: 'merged', by: 'user' });
    this.d.say(`merge ${repo.title}#${n}: you merged it${!ready || head === ready ? '' : ` (at ${head.slice(0, 7)}, not ${ready.slice(0, 7)}, which was ready)`}`);
    await this.cleanUp(repo, done);
    this.d.merged?.(repo);
  }

  // --- after a merge ---------------------------------------------------------------------------

  /** The PR's own jobs: its reviews and fix rounds (by the PR's number and branch), and its
   *  build: the one whose end names this PR, or the one that made the PR's head branch (a `made`
   *  line), ended before the merge was recorded and names no other PR (F11: a build that opened
   *  its PR and then failed has none on its end). A build still running, or started after the
   *  merge, on a reused branch name is another PR's (F2). */
  private ownJobs(repo: BuildRepo, step: Step): Job[] {
    const build = (j: Job) => j.end?.pr?.number === step.pr
      || (Boolean(j.made?.includes(step.branch)) && Boolean(j.end) && !j.end!.pr && j.startedAt < step.startedAt);
    return this.d.log.jobs().filter((j) => j.repo === repo.id
      && (j.kind === 'build' ? build(j) : j.issue === step.pr && j.branch === step.branch));
  }

  /** What the app made for the PR, removed, and every thread the app ran on it settled: the latest
   *  point one of them can still be open (#68 story 7). Only branches the app's own launches
   *  recorded making (`made`, F15) are touched, with the worktrees git lists on them: never a
   *  branch that was there before the app looked (a `branch-exists` build made nothing), a person's,
   *  or one another job of the app's is on now (a new build on a reused name, F2). A worktree with
   *  uncommitted changes is never removed: it's left, said, and its branch kept. Recorded once both
   *  are done; a settle that failed, or a worktree git keeps listing, leaves it owed. */
  private async cleanUp(repo: BuildRepo, step: Step): Promise<void> {
    const name = `merge ${repo.title}#${step.pr}`;
    const jobs = this.ownJobs(repo, step);
    const own = new Set(jobs.map((j) => j.id));
    // another job of the app's on a branch now: still running (or waiting, or cut off), or ended
    // on another PR
    const others = new Set(this.d.log.jobs().filter((j) => j.repo === repo.id && !own.has(j.id) && j.kind !== 'review'
      && (WRITING(j) || (j.end?.pr && j.end.pr.number !== step.pr))).flatMap((j) => [j.branch, ...(j.made ?? [])]));
    const made = (j: Job) => (j.kind === 'build' ? (j.made ?? []).filter((b) => b === step.branch) : j.made ?? []);
    const branches = [...new Set(jobs.flatMap(made))].filter((b) => !others.has(b));
    const left: string[] = [];
    const kept = new Set<string>();
    let done = true;
    try {
      for (const w of await this.d.git.worktrees(repo.folder)) {
        if (!w.branch || !branches.includes(w.branch)) continue;
        // a folder that's gone has nothing to lose: git only lists it until it's pruned
        if ((this.d.exists ?? existsSync)(w.path) && !(await this.d.git.isClean(w.path))) {
          kept.add(w.branch);
          this.d.say(`${name}: worktree ${w.path} has uncommitted changes (or git couldn't say): left as it is, and its branch ${w.branch} kept`);
          continue;
        }
        const gone = await this.d.git.removeWorktree(repo.folder, w.path);
        if (!gone) { done = false; this.d.say(`${name}: git still lists the worktree ${w.path}; tried again next pass`); continue; }
        if ((this.d.exists ?? existsSync)(w.path)) left.push(w.path);
        this.d.say(`${name}: worktree ${w.path} removed${left.includes(w.path) ? ' (T3 still holds its folder: swept later)' : ''}`);
      }
      for (const b of branches) if (!kept.has(b)) await this.d.git.deleteBranch(repo.folder, b);
    } catch (e) {
      done = false;
      this.d.say(`${name}: removing its worktrees and branches failed (${(e as Error).message}); tried again next pass`);
    }
    for (const j of jobs) if (j.threadId) await this.settler.settle(j);
    const unsettled = jobs.filter((j) => j.threadId && !this.d.log.get(j.id)?.settledAt);
    if (unsettled.length) done = false;
    if (done) await this.d.log.cleaned(step.id, left);
  }

  /** Folders T3 held at the clean-up, removed once it lets go. */
  private async sweep(repo: BuildRepo, step: Step): Promise<void> {
    const remove = this.d.removeFolder ?? defaultRemove;
    let all = true;
    for (const path of step.left ?? []) if (!(await remove(path))) all = false;
    if (all) {
      await this.d.log.swept(step.id);
      this.d.say(`merge ${repo.title}#${step.pr}: its leftover worktree folders are gone`);
    }
  }
}

/** What people said on the PR after `at`: bots and the app's and the runner's own posts left out. */
export const saidSince = (comments: Comment[], at: string): Comment[] =>
  comments.filter((c) => c.createdAt > at && !c.author.endsWith('[bot]') && !runnerPost(c.body));
