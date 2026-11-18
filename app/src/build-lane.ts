// The build lane (#154; today's runner's builds, docs/flow.md, ported): a
// served repo's next ticket becomes a PR. One build per repo at a time, repos side by side, the
// repo that waited longest first (#50). Each pass, for every served repo with no build running:
//
//   pick (src/picker.ts)  ->  the usage gate lets it in, on the build kind's model or its fallback
//   ->  fetch origin/<base>  ->  a leftover branch of the job's name holds the job (branch-exists)
//   ->  the brief (src/briefs/build.ts)  ->  t3_thread_launch in a worktree from origin/<base>
//   ->  its end from T3's thread events (src/t3/thread-end.ts)  ->  the end recorded in the job log
//   ->  the thread settled (#68 story 5), unless it waits on a question (the Inbox ticket's) or
//       stopped on a usage limit (the limits ticket's)
//
// The app settles only threads it launched (story 13): the thread id comes from its own launch.
// A job the log shows open, left by an app that stopped mid-job, is watched again to its end; one
// that never got a thread is recorded not-started. A repo whose job started no thread rests
// `restMs` before it's tried again. The usage the job was let in on and T3's first reading after
// it are the gate's cost record (`usage.jsonl`, by the same job id).
import { buildBrief } from './briefs/build.ts';
import { holdText } from './gate.ts';
import type { GitHubWork } from './github.ts';
import type { Git } from './git.ts';
import type { Job, JobEnd, JobLog } from './job-log.ts';
import type { Catalog, Jobs } from './jobs.ts';
import { launchJob } from './launch.ts';
import { pick, type BuildTicket } from './picker.ts';
import type { Repo } from './repos.ts';
import type { Retry } from './t3/project-feed.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { watchThreadEnd, type ThreadEnd } from './t3/thread-end.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

/** A repo the lane builds in: a served T3 project. `github` is null only for the live check's
 *  sandbox, which has no GitHub: no picking, no comments and no PR to look for. */
export type BuildRepo = { id: string; title: string; folder: string; github: string | null };

export type BuildLaneDoors = {
  /** The served repos, now. */
  repos: () => BuildRepo[];
  github: GitHubWork;
  git: Git;
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe'>;
  gate: Pick<UsageGate, 'pick' | 'check' | 'started' | 'finished' | 'dropped' | 'forget'>;
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
  /** A dropped thread stream's wait before it's opened again. */
  retry?: Retry;
  now?: () => Date;
};

/** The repos the lane builds in: those switched to Served that have a GitHub remote. An
 *  unserved repo's tickets are never read. */
export const servedRepos = (list: Repo[] | null): BuildRepo[] =>
  (list ?? []).filter((r) => r.served && r.github).map((r) => ({ id: r.id, title: r.title, folder: r.folder, github: r.github }));

export const jobTitle = (repo: BuildRepo, issue: number) => `Queue runner build: ${repo.title}#${issue}`;

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;

export class BuildLane {
  private d: BuildLaneDoors;
  private building = new Map<string, Promise<Job>>();
  private watches = new Set<{ stop(): void }>();
  private resting = new Map<string, number>();
  private holdSaid = new Map<string, string>();
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private now: () => Date;

  constructor(doors: BuildLaneDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
  }

  /** Watches again each build the log shows open (an app that stopped mid-job), then passes. */
  start(): Promise<void> {
    for (const job of this.d.log.open()) {
      if (job.kind !== 'build' || this.building.has(job.repo)) continue;
      this.track(job.repo, this.resume(job));
    }
    return this.pass();
  }

  /** Stops watching: builds in T3 go on, and the next start watches them again. */
  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
  }

  /** T3 read new usage: a pass, if a build waits on the gate (a held one may fit now). */
  usageChanged(): void {
    if (this.holdSaid.size) void this.pass();
  }

  /** The repos with a build running, by T3 project id. */
  running(): string[] {
    return [...this.building.keys()];
  }

  /** Settles once every build under way has ended and been recorded (the tests wait on it). */
  async idle(): Promise<void> {
    while (this.building.size || this.passing) {
      await Promise.allSettled([...this.building.values(), this.passing]);
    }
  }

  /** One pass: a build for each served repo that has none running and has a ticket the gate lets
   *  in. A pass asked for while one runs runs once more after it. */
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

  private waited(repo: BuildRepo): number {
    const at = this.d.log.lastEnded(repo.id);
    return at ? Date.parse(at) : 0;
  }

  private async passOnce() {
    const now = this.now().getTime();
    const repos = this.d.repos()
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.github && !this.building.has(r.id) && (this.resting.get(r.id) ?? 0) <= now)
      .sort((a, b) => this.waited(a.r) - this.waited(b.r) || a.i - b.i)
      .map(({ r }) => r);
    for (const repo of repos) {
      if (this.stopped) return;
      let base: string;
      let ticket: BuildTicket | null;
      try {
        base = await this.d.github.defaultBranch(repo.github!);
        ticket = await pick(this.d.github, repo.github!, base, this.d.log.heldIssues(repo.id));
      } catch (e) {
        this.d.say(`${repo.title}: GitHub couldn't be read (${(e as Error).message})`);
        continue;
      }
      if (!ticket) continue;
      const holdId = `build:${repo.github}#${ticket.issue.number}`;
      const verdict = this.d.gate.pick(holdId, 'build');
      if (!verdict.fits) {
        const text = holdText(verdict.hold, (d) => d.toISOString());
        if (this.holdSaid.get(repo.id) !== text) this.d.say(`${repo.title}#${ticket.issue.number} waits: ${text}`);
        this.holdSaid.set(repo.id, text);
        continue;
      }
      this.holdSaid.delete(repo.id);
      this.d.gate.forget(holdId);
      // the gate counts it from now, so the next repo's verdict counts this one; the pass goes on
      // once T3 has it (or it ended before), so builds launch in the pass's order
      await new Promise<void>((launched) => {
        this.track(repo.id, this.build(repo, ticket, base, verdict, launched).finally(launched));
      });
    }
  }

  private track(repo: string, build: Promise<Job>) {
    this.building.set(repo, build);
    build.then(() => {}, (e) => this.d.say(`a build in ${repo} stopped: ${(e as Error).message}`)).finally(() => {
      this.building.delete(repo);
      void this.pass();
    });
  }

  /** One build, start to end: the job's start, its launch, its end recorded and its thread
   *  settled. The live check calls it with a hand-made ticket. */
  async build(repo: BuildRepo, ticket: BuildTicket, base: string,
    letIn: { choice: Job['choice']; onFallback: boolean; cost: Record<string, number> },
    onLaunched: () => void = () => {}): Promise<Job> {
    const n = ticket.issue.number;
    const job = await this.d.log.started({
      kind: 'build', repo: repo.id, github: repo.github, issue: n, branch: ticket.branch, base: ticket.base,
      title: jobTitle(repo, n), choice: letIn.choice, onFallback: letIn.onFallback,
    });
    this.d.gate.started({ id: job.id, kind: 'build', choice: letIn.choice }, letIn.cost);
    const notStarted = async (outcome: 'not-started' | 'branch-exists', error: string) => {
      this.d.gate.dropped(job.id);
      this.resting.set(repo.id, this.now().getTime() + (this.d.restMs ?? 300_000));
      this.d.say(`${job.title} not started: ${error}`);
      return this.d.log.ended(job.id, { outcome, error });
    };
    let launched;
    try {
      await this.d.git.fetch(repo.folder, base);
      if (await this.d.git.hasBranch(repo.folder, ticket.branch)) {
        return await notStarted('branch-exists', `A local branch ${ticket.branch} is left from an earlier run; it holds ${repo.title}#${n} until it's gone.`);
      }
      const catalog = this.d.catalog();
      if (!catalog) return await notStarted('not-started', "T3's providers aren't known yet");
      const brief = buildBrief({
        github: repo.github ?? repo.title, number: n, title: ticket.issue.title, body: ticket.issue.body,
        comments: repo.github ? await this.d.github.issueComments(repo.github, n) : [],
        branch: ticket.branch, base: ticket.base, user: await this.d.user(),
        agentsFile: this.d.exists(join(repo.folder, 'AGENTS.md')) ? 'AGENTS.md' : this.d.exists(join(repo.folder, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
      });
      this.d.say(`Starting ${job.title} on ${ticket.branch} from ${ticket.base}`);
      launched = await launchJob(this.d.mcp, this.d.jobs(), catalog, {
        kind: 'build', projectId: repo.id, title: job.title, brief,
        worktree: { baseRef: ticket.base, branch: ticket.branch }, onFallback: letIn.onFallback,
      });
    } catch (e) {
      return await notStarted('not-started', (e as Error).message);
    }
    await this.d.log.thread(job.id, { threadId: launched.threadId, runId: launched.runId, link: launched.link });
    onLaunched();
    return this.watch({ ...job, threadId: launched.threadId, runId: launched.runId, link: launched.link }, repo.github);
  }

  /** A build the log shows open: watched to its end if T3 named its thread, else not-started. */
  private async resume(job: Job): Promise<Job> {
    if (!job.threadId) {
      return this.d.log.ended(job.id, { outcome: 'not-started', error: 'The app stopped before T3 named its thread.' });
    }
    const v = this.d.gate.check({ id: job.id, kind: job.kind, choice: job.choice });
    this.d.gate.started({ id: job.id, kind: job.kind, choice: job.choice }, v.fits ? v.cost : {});
    this.d.say(`Watching ${job.title} again: ${job.link ?? job.threadId}`);
    return this.watch(job, job.github);
  }

  private async watch(job: Job, github: string | null): Promise<Job> {
    const w = watchThreadEnd(this.d.ws, job.threadId!, job.runId ?? null, this.d.retry,
      (why) => this.d.say(`${job.title}: T3's thread stream dropped (${why}); opening it again`));
    this.watches.add(w);
    let end: ThreadEnd;
    try {
      end = await w.end;
    } finally {
      this.watches.delete(w);
    }
    this.d.gate.finished(job.id);
    const record: JobEnd = { outcome: end.outcome as JobEnd['outcome'], status: end.status };
    if (end.outcome === 'done' && github) {
      // a job may open its PR and stop after; done without one is done-no-pr
      try {
        record.pr = await this.d.github.pullForBranch(github, job.branch);
      } catch (e) {
        record.error = `PR lookup failed: ${(e as Error).message}`;
      }
      if (!record.pr) record.outcome = 'done-no-pr';
    }
    if (end.outcome === 'failed') record.error = end.error;
    if (end.outcome === 'usage-limit') Object.assign(record, { resetAt: end.resetAt, error: end.error });
    if (end.outcome === 'waiting') record.request = end.request;
    const ended = await this.d.log.ended(job.id, record);
    this.d.say(`${job.title} ended: ${record.outcome}${record.pr ? `, PR #${record.pr.number}` : ''} ${job.link ?? job.threadId}`);
    // recorded first, then settled (story 5); a question or a usage limit is a later ticket's
    if (end.outcome !== 'waiting' && end.outcome !== 'usage-limit') await this.settle(job);
    return ended;
  }

  /** Settles a thread this app launched. A failure is said, never raised: a thread left in the
   *  sidebar stops no lane. */
  private async settle(job: Job) {
    try {
      await this.d.mcp.call('t3_thread_organize', { threadId: job.threadId, action: 'settle' });
    } catch (e) {
      this.d.say(`${job.title}: settling its thread ${job.threadId} failed (${(e as Error).message}); left as it is`);
    }
  }
}
