// The build lane (#154; today's runner's builds, docs/flow.md, ported): a
// served repo's next ticket becomes a PR, none while the repo has an open PR (#179). When a build
// starts is the chooser's (src/chooser.ts, #210): one job per repo, repos side by side, the
// repo that waited longest first. Asked for a repo's next job (`next`):
//
//   new tickets read from GitHub at most every 5 minutes (sooner after a build ends, a merge, the
//   served repos changing or usage changing while one waits)  ->  pick (src/picker.ts)
//   ->  the usage gate lets it in, on the build kind's model or its fallback
//   ->  fetch origin/<base>  ->  a leftover branch of the job's name holds the job (branch-exists)
//   ->  the brief (src/briefs/build.ts)  ->  t3_thread_launch in a worktree from origin/<base>
//   ->  its end from T3's thread (src/t3/thread-end.ts, `watchJobThread`): a run that waits on the
//       user in T3 (a question, a login or secret card) hasn't ended, and its repo stays held until
//       it has (#210); nor has one whose issue has `needs-info` (its question on GitHub, read each
//       pass, src/github-hold.ts)  ->  the end recorded in the job log
//   ->  the thread settled (#68 story 5), unless it stopped on a usage limit (the limits
//       ticket's)  ->  the settle recorded in the job log
//
// The app settles only threads it launched (story 13): the thread id comes from its own launch,
// never from a thread's title, branch or project. A job the log shows open, left by an app that
// stopped mid-job, is watched again to its end on the thread id it saved; one whose end was
// recorded and whose thread wasn't settled yet is settled, and a settle that failed is tried again
// each pass. A job T3 may have
// started a thread for that the app has no id of (its launch was sent and the answer lost, or the
// app stopped before the id was saved) needs the user (#154, After a restart, don't guess): it's
// recorded as such and its repo starts nothing until the user answers
// (`Chooser.answered`). A repo whose
// job started no thread rests `restMs` before it's tried again. The usage the job was let in on
// and T3's first reading after it are the gate's cost record (`usage.jsonl`, by the same job id);
// both the reading and the cost it was let in at are in its start line, so a job watched again
// after a restart keeps them.
import { buildBrief } from './briefs/build.ts';
import { reading } from './costs.ts';
import { holdText } from './gate.ts';
import type { GitHubWork } from './github.ts';
import { QuestionHold } from './github-hold.ts';
import type { Git } from './git.ts';
import { settles, type Job, type JobEnd, type JobLog } from './job-log.ts';
import type { Catalog, Jobs } from './jobs.ts';
import { launchJob } from './launch.ts';
import { pick, type BuildTicket } from './picker.ts';
import type { RepoJobLane, Next } from './chooser.ts';
import { ThreadSettler } from './settle.ts';
import type { Repo } from './repos.ts';
import type { Merger } from './settings.ts';
import type { Retry } from './t3/project-feed.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { NoAnswer } from './t3/seams.ts';
import { watchJobThread, type ThreadEnd } from './t3/thread-end.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

/** A repo the lane builds in: a served T3 project. `github` is null only for the live check's
 *  sandbox, which has no GitHub: no picking, no comments and no PR to look for. `merge` says who
 *  merges its clean PRs (#156): the app, or the user (the default). */
export type BuildRepo = { id: string; title: string; folder: string; github: string | null; merge?: Merger };

export type BuildLaneDoors = {
  /** The served repos, now. */
  repos: () => BuildRepo[];
  github: GitHubWork;
  git: Git;
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe' | 'request' | 'first'>;
  gate: Pick<UsageGate, 'pick' | 'reading' | 'started' | 'finished' | 'dropped' | 'forget'>;
  catalog: () => Catalog | null;
  jobs: () => Jobs;
  /** The user's name for the brief (Settings, Name; else the gh account's). */
  user: () => Promise<string>;
  log: JobLog;
  /** Whether a file exists (the repo's agent instructions file, for the brief). */
  exists: (path: string) => boolean;
  /** A line for the app's log. */
  say: (line: string) => void;
  /** How long a repo whose job started no thread rests (ms). */
  restMs?: number;
  /** A build is over, or a done build's PR is known: the chooser passes. */
  freed?: () => void;
  /** A dropped thread stream's wait before it's opened again. */
  retry?: Retry;
  now?: () => Date;
};

/** The repos the lane builds in: those switched to Served that have a GitHub remote. An
 *  unserved repo's tickets are never read. */
export const servedRepos = (list: Repo[] | null): BuildRepo[] =>
  (list ?? []).filter((r) => r.served && r.github).map((r) => ({ id: r.id, title: r.title, folder: r.folder, github: r.github, merge: r.merge }));

export const jobTitle = (repo: BuildRepo, issue: number) => `Queue runner build: ${repo.title}#${issue}`;

/** Asked again after every wait: a repo switched off meanwhile gets no gate verdict, no launch. */
const isServed = (repos: BuildRepo[], repo: BuildRepo) => repos.some((r) => r.id === repo.id);

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;

/** How often a repo's new tickets are read from GitHub, as today's 5-minute poll. */
export const TICKETS_MS = 5 * 60_000;

export class BuildLane implements RepoJobLane {
  private d: BuildLaneDoors;
  /** Each build under way, and its repo: a repo may have more than one after a restart (an
   *  older app left a build waiting on a question and started the next beside it), and each is
   *  watched to its end (#210 F12). */
  private building = new Map<Promise<Job>, string>();
  private watches = new Set<{ stop(): void }>();
  /** Each watched build's question on GitHub, read again each pass while it waits on one. */
  private holds = new Set<QuestionHold>();
  private settler: ThreadSettler;
  /** PR lookups owed after one failed, under way, by job id. */
  private lookingUp = new Map<string, Promise<void>>();
  private resting = new Map<string, number>();
  private holdSaid = new Map<string, string>();
  /** The open-PR hold last said for each repo, so it's said once. */
  private prHeld = new Map<string, string>();
  /** When each repo's tickets were last read; one not read is due. */
  private readAt = new Map<string, number>();
  private stopped = false;
  private now: () => Date;

  constructor(doors: BuildLaneDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Watches again each build the log shows open (an app that stopped mid-job, one waiting on
   *  the user among them), reserved in the gate before the chooser's first choice (#210 F19); the
   *  chooser's first pass settles each one it shows ended and not settled (`owed`). */
  recover(): void {
    // every one, even two in a repo: one left out would hold its repo for good (#210 F12)
    for (const job of this.d.log.open()) {
      if (job.kind === 'build') this.track(job.repo, this.resume(job));
    }
  }

  /** Stops watching: builds in T3 go on, and the next start watches them again. */
  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
  }

  /** T3 read new usage: whether a build waits on the gate (a held one may fit now); its tickets
   *  are read again then. */
  usageChanged(): boolean {
    if (!this.holdSaid.size) return false;
    this.ticketsDue();
    return true;
  }

  /** Every repo's tickets are read on its next turn (a merge, the served repos changing). */
  ticketsDue(): void {
    this.readAt.clear();
  }

  busy(repo: BuildRepo): boolean {
    return [...this.building.values()].includes(repo.id);
  }

  /** The repos with a build running, by T3 project id. */
  running(): string[] {
    return [...new Set(this.building.values())];
  }

  /** Settles once every build under way has ended and been recorded (the tests wait on it). */
  async idle(): Promise<void> {
    while (this.building.size || this.settler.pending().length || this.lookingUp.size) {
      await Promise.allSettled([...this.building.keys(), ...this.settler.pending(), ...this.lookingUp.values()]);
    }
  }

  owed(): void {
    // an end recorded and not settled: left by an app that stopped between the two, or a settle
    // that failed; tried each pass, on its own (a thread left in the sidebar holds no build)
    this.settler.owed('build');
    // a done build whose PR lookup failed: looked up again each pass, a restart's first included
    for (const job of this.d.log.prOwed()) if (job.kind === 'build') void this.lookUp(job);
    // a build whose runs have ended with its question open on GitHub: GitHub read again, on its
    // timer (the pass), never T3
    for (const hold of this.holds) if (hold.waiting) hold.refresh();
  }

  /** The build's question open on GitHub: its issue still open and labelled `needs-info` (the
   *  build brief has the builder swap `ready-for-agent` for it when it asks), or null. */
  private async question(github: string, n: number): Promise<string | null> {
    const issue = await this.d.github.issueLabels(github, n);
    return issue.open && issue.labels.includes('needs-info') ? `${github}#${n} is labelled needs-info` : null;
  }

  /** The repo's next build: its next ticket, while it has no open PR, if the gate lets it in. Its
   *  tickets are read at most every TICKETS_MS (`ticketsDue` asks sooner); a read that fails
   *  throws, and they're read again on the next pass. */
  async next(repo: BuildRepo): Promise<Next> {
    const now = this.now().getTime();
    if (this.stopped || !repo.github || this.busy(repo) || (this.resting.get(repo.id) ?? 0) > now) return null;
    const read = this.readAt.get(repo.id);
    if (read !== undefined && now - read < TICKETS_MS) return null;
    let base: string;
    let ticket: BuildTicket | null;
    try {
      base = await this.d.github.defaultBranch(repo.github);
      // one ticket at a time (#179): no build while the repo has an open PR, whoever opened it
      const open = await this.d.github.openPulls(repo.github);
      if (open.length) {
        const text = `${repo.title}: no build while PR #${Math.min(...open.map((p) => p.number))} is open (one ticket at a time)`;
        if (this.prHeld.get(repo.id) !== text) this.d.say(text);
        this.prHeld.set(repo.id, text);
        this.readAt.set(repo.id, now);
        return null;
      }
      this.prHeld.delete(repo.id);
      ticket = await pick(this.d.github, repo.github, base, this.d.log.heldIssues(repo.id));
    } catch (e) {
      throw new Error(`GitHub couldn't be read (${(e as Error).message})`);
    }
    this.readAt.set(repo.id, now);
    if (!ticket) return null;
    if (!isServed(this.d.repos(), repo)) return null; // switched off while GitHub was read
    const holdId = `build:${repo.github}#${ticket.issue.number}`;
    const verdict = this.d.gate.pick(holdId, 'build');
    if (!verdict.fits) {
      const text = holdText(verdict.hold, (d) => d.toISOString());
      if (this.holdSaid.get(repo.id) !== text) this.d.say(`${repo.title}#${ticket.issue.number} waits: ${text}`);
      this.holdSaid.set(repo.id, text);
      return { waits: text };
    }
    this.holdSaid.delete(repo.id);
    this.d.gate.forget(holdId);
    // the gate counts it from now, so the next repo's verdict counts this one; the chooser goes on
    // once T3 has it (or it ended before), so builds launch in the pass's order
    return {
      launch: () => new Promise<void>((launched) => {
        this.track(repo.id, this.build(repo, ticket, base, verdict, launched).finally(launched));
      }),
    };
  }

  private track(repo: string, build: Promise<Job>) {
    this.building.set(build, repo);
    build.then(() => {}, (e) => this.d.say(`a build in ${repo} stopped: ${(e as Error).message}`)).finally(() => {
      this.building.delete(build);
      // a build that ended may have opened its PR or freed its ticket: read again on the next pass
      this.readAt.delete(repo);
      if (!this.stopped) this.d.freed?.();
    });
  }

  /** One build, start to end: the job's start, its launch, its end recorded and its thread
   *  settled. The live check calls it with a hand-made ticket. */
  async build(repo: BuildRepo, ticket: BuildTicket, base: string,
    letIn: { choice: Job['choice']; onFallback: boolean; cost: Record<string, number> },
    onLaunched: () => void = () => {}): Promise<Job> {
    const n = ticket.issue.number;
    const before = this.d.gate.reading(letIn.choice);
    const job = await this.d.log.started({
      kind: 'build', repo: repo.id, github: repo.github, issue: n, branch: ticket.branch, base: ticket.base,
      title: jobTitle(repo, n), choice: letIn.choice, onFallback: letIn.onFallback, cost: letIn.cost, before,
    });
    this.d.gate.started({ id: job.id, kind: 'build', choice: letIn.choice }, letIn.cost, before);
    const notStarted = (outcome: 'not-started' | 'branch-exists', error: string) => this.notStarted(job, outcome, error);
    let launched;
    try {
      await this.d.git.fetch(repo.folder, base);
      if (await this.d.git.hasBranch(repo.folder, ticket.branch)) {
        return await notStarted('branch-exists', `A local branch ${ticket.branch} is left from an earlier run; ${repo.title}#${n} stays held, as every started build's issue is.`);
      }
      const catalog = this.d.catalog();
      if (!catalog) return await notStarted('not-started', "T3's providers aren't known yet");
      const brief = buildBrief({
        github: repo.github ?? repo.title, number: n, title: ticket.issue.title, body: ticket.issue.body,
        comments: repo.github ? await this.d.github.issueComments(repo.github, n) : [],
        branch: ticket.branch, base: ticket.base, user: await this.d.user(),
        agentsFile: this.d.exists(join(repo.folder, 'AGENTS.md')) ? 'AGENTS.md' : this.d.exists(join(repo.folder, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
      });
      // a PR opened while the job was fetched and its brief written holds it, as one open before
      const opened = repo.github ? await this.d.github.openPulls(repo.github) : [];
      if (opened.length) return await notStarted('not-started', `PR #${opened[0]!.number} was opened in ${repo.title} meanwhile (one ticket at a time)`);
      // nothing is awaited from here to the launch call, so a repo served now is served at launch
      if (!isServed(this.d.repos(), repo)) return await notStarted('not-started', `${repo.title} is no longer served`);
      this.d.say(`Starting ${job.title} on ${ticket.branch} from ${ticket.base}`);
      try {
        launched = await launchJob(this.d.mcp, catalog, {
          kind: 'build', projectId: repo.id, title: job.title, brief,
          worktree: { baseRef: ticket.base, branch: ticket.branch }, choice: letIn.choice,
        });
      } catch (e) {
        // sent and its answer lost: T3 may have started the thread, and nothing says which one
        // it is. Any other failure (nothing sent, or a refusal T3 answered) started nothing
        if (e instanceof NoAnswer) return await this.needsUser(job, (e as Error).message);
        throw e;
      }
    } catch (e) {
      return await notStarted('not-started', (e as Error).message);
    }
    await this.d.log.thread(job.id, { threadId: launched.threadId, runId: launched.runId, link: launched.link });
    // T3 made the job's branch and its worktree for this launch: the app's to remove after the
    // merge (#156 F15). A leftover branch (branch-exists) never gets here, so it's never the app's
    await this.d.log.made(job.id, ticket.branch);
    onLaunched();
    return this.watch({ ...job, threadId: launched.threadId, runId: launched.runId, link: launched.link }, repo.github);
  }

  /** A job let in that started no thread: it holds nothing and its repo rests. */
  private notStarted(job: Job, outcome: 'not-started' | 'branch-exists', error: string): Promise<Job> {
    this.d.gate.dropped(job.id);
    this.resting.set(job.repo, this.now().getTime() + (this.d.restMs ?? 300_000));
    this.d.say(`${job.title} not started: ${error}`);
    return this.d.log.ended(job.id, { outcome, error });
  }

  /** A job T3 may have started a thread for, with no thread id the app could watch: recorded as
   *  needing the user, never matched to a thread by its title, branch or project. It's dropped
   *  from the gate unmeasured (nothing measures a run the app can't see), and its repo starts
   *  nothing until the user answers. */
  private needsUser(job: Job, why: string): Promise<Job> {
    this.d.gate.dropped(job.id);
    this.d.say(`${job.title} needs you: ${why}. T3 may have started its thread; nothing else starts in ${job.github ?? job.repo} until you answer.`);
    return this.d.log.ended(job.id, { outcome: 'needs-user', error: why });
  }

  /** A build the log shows open: watched to its end on the thread id it saved; with none, it
   *  needs the user. */
  private async resume(job: Job): Promise<Job> {
    // reserved and measured as it was let in; a line with no record of that (an older app's)
    // teaches nothing rather than measure from a reading taken mid-run
    this.d.gate.started({ id: job.id, kind: job.kind, choice: job.choice }, job.cost ?? {}, job.before ?? reading(null, []));
    if (!job.threadId) return this.needsUser(job, 'the app stopped before T3 named its thread');
    this.d.say(`Watching ${job.title} again: ${job.link ?? job.threadId}`);
    return this.watch(job, job.github);
  }

  /** The build's thread followed to its end (`watchJobThread`): a run waiting on the user in T3
   *  hasn't ended, and the build stays open, its repo held and its cost in the gate, until it has.
   *  The gate measures it once, at that end, from the reading it was let in on (#210 F18). */
  private async watch(job: Job, github: string | null): Promise<Job> {
    const hold = github ? new QuestionHold(() => this.question(github, job.issue), (l) => this.d.say(`${job.title}: ${l}`)) : undefined;
    const w = watchJobThread(this.d.ws, { ...job, threadId: job.threadId! }, this.d.say, this.d.retry, hold);
    if (hold) {
      hold.recheck = () => w.recheck();
      this.holds.add(hold);
    }
    this.watches.add(w);
    let end: ThreadEnd;
    try {
      end = await w.end;
    } finally {
      this.watches.delete(w);
      if (hold) this.holds.delete(hold);
    }
    this.d.gate.finished(job.id, end.outcome === 'usage-limit' ? { resetAt: end.resetAt } : undefined);
    const record: JobEnd = { outcome: end.outcome as JobEnd['outcome'], status: end.status };
    if (end.outcome === 'done' && github) {
      // a job may open its PR and stop after; done without one is done-no-pr. A lookup that
      // failed isn't "none": the end has no pr, and each pass looks it up again (F13)
      try {
        record.pr = await this.d.github.pullForBranch(github, job.branch);
        if (!record.pr) record.outcome = 'done-no-pr';
      } catch (e) {
        record.error = `PR lookup failed: ${(e as Error).message}; looked up again next pass`;
      }
    }
    if (end.outcome === 'failed') record.error = end.error;
    if (end.outcome === 'usage-limit') Object.assign(record, { resetAt: end.resetAt, error: end.error });
    const ended = await this.d.log.ended(job.id, record);
    this.d.say(`${job.title} ended: ${record.outcome}${record.pr ? `, PR #${record.pr.number}` : ''} ${job.link ?? job.threadId}`);
    // recorded first, then settled (story 5); a usage limit is a later ticket's. Stopped between
    // the two, the next start settles it (the log has no settled line). A thread T3's list no
    // longer has has nothing left to settle (#210 F11)
    if (end.outcome === 'failed' && end.gone) await this.d.log.settled(job.id);
    else if (settles(record.outcome)) await this.settler.settle(job);
    return ended;
  }

  /** A done build's PR, looked up again after a lookup failed; once at a time per job. A failure
   *  is said and leaves it owed for the next pass. */
  private lookUp(job: Job): Promise<void> {
    const under = this.lookingUp.get(job.id);
    if (under) return under;
    const l = (async () => {
      try {
        const pr = await this.d.github.pullForBranch(job.github!, job.branch);
        const done = await this.d.log.pr(job.id, pr);
        this.d.say(`${job.title}: ${done.end!.outcome}${pr ? `, PR #${pr.number}` : ''}`);
        if (!this.stopped) this.d.freed?.(); // its repo was held while its PR wasn't known
      } catch (e) {
        this.d.say(`${job.title}: its PR lookup failed again (${(e as Error).message}); tried again next pass`);
      }
    })().finally(() => this.lookingUp.delete(job.id));
    this.lookingUp.set(job.id, l);
    return l;
  }
}
