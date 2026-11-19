// The build lane (#154; today's runner's builds, docs/flow.md, ported): a
// served repo's next ticket becomes a PR. One build per repo at a time, repos side by side, the
// repo that waited longest first (#50), and none while the repo has an open PR (#179). Each pass,
// for every served repo with no build running:
//
//   pick (src/picker.ts)  ->  the usage gate lets it in, on the build kind's model or its fallback
//   ->  fetch origin/<base>  ->  a leftover branch of the job's name holds the job (branch-exists)
//   ->  the brief (src/briefs/build.ts)  ->  t3_thread_launch in a worktree from origin/<base>
//   ->  its end from T3's thread events (src/t3/thread-end.ts)  ->  the end recorded in the job log
//   ->  the thread settled (#68 story 5), unless it waits on a question (the Inbox ticket's) or
//       stopped on a usage limit (the limits ticket's)  ->  the settle recorded in the job log
//
// The app settles only threads it launched (story 13): the thread id comes from its own launch,
// never from a thread's title, branch or project. A job the log shows open, left by an app that
// stopped mid-job, is watched again to its end on the thread id it saved; one whose end was
// recorded and whose thread wasn't settled yet is settled, and a settle that failed is tried again
// each pass. A job T3 may have
// started a thread for that the app has no id of (its launch was sent and the answer lost, or the
// app stopped before the id was saved) needs the user (#154, After a restart, don't guess): it's
// recorded as such and its repo starts nothing until the user answers (`answered`). A repo whose
// job started no thread rests `restMs` before it's tried again. The usage the job was let in on
// and T3's first reading after it are the gate's cost record (`usage.jsonl`, by the same job id);
// both the reading and the cost it was let in at are in its start line, so a job watched again
// after a restart keeps them.
//
// **A build that stopped on a question** (#158): its question is a stop on its issue (src/stops.ts
// files it, `needs-info`). Once the user answers there, the build carries on to its PR, whether it
// was waiting on the answer or ended without a PR, and even with its branch pushed: in its own
// thread while that thread is warm, or cold and under 120k tokens (src/resume.ts, the one rule),
// the answer given to the question it waits on or sent as a new turn; otherwise in a fresh thread
// on the same branch (its own worktree when git lists one, else a new one made from the branch),
// briefed with the question and the answer. A new build job `about` the old one, gated as a build.
// While any stop is open in the repo, no new build starts there (#179).
import { buildBrief } from './briefs/build.ts';
import { reading } from './costs.ts';
import { holdText } from './gate.ts';
import type { GitHubReview, GitHubWork } from './github.ts';
import type { FixGit, Git } from './git.ts';
import { settles, type Job, type JobEnd, type JobLog, type Stop } from './job-log.ts';
import { resumeChoice, threadNow } from './resume.ts';
import { ToolFailed } from './t3/mcp.ts';
import { runReply } from './t3/thread-reply.ts';
import type { Catalog, Jobs } from './jobs.ts';
import { launchJob } from './launch.ts';
import { pick, type BuildTicket } from './picker.ts';
import { ThreadSettler } from './settle.ts';
import type { Repo } from './repos.ts';
import type { Merger } from './settings.ts';
import type { Retry } from './t3/project-feed.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { NoAnswer } from './t3/seams.ts';
import { watchThreadEnd, type ThreadEnd } from './t3/thread-end.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

/** A repo the lane builds in: a served T3 project. `github` is null only for the live check's
 *  sandbox, which has no GitHub: no picking, no comments and no PR to look for. `merge` says who
 *  merges its clean PRs (#156): the app, or the user (the default). */
export type BuildRepo = { id: string; title: string; folder: string; github: string | null; merge?: Merger };

export type BuildLaneDoors = {
  /** The served repos, now. */
  repos: () => BuildRepo[];
  /** `issue` reads a carried-on build's issue for its fresh brief (it's `needs-info` by then, so
   *  no longer among the ready ones). */
  github: GitHubWork & Partial<Pick<GitHubReview, 'issue'>>;
  /** Git in the repo's folder; `worktrees` finds a build's own worktree to carry it on in. */
  git: Git & Partial<Pick<FixGit, 'worktrees'>>;
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe'> & Partial<Pick<T3Ws, 'request'>>;
  gate: Pick<UsageGate, 'pick' | 'reading' | 'started' | 'finished' | 'dropped' | 'forget'> & Partial<Pick<UsageGate, 'check'>>;
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
  (list ?? []).filter((r) => r.served && r.github).map((r) => ({ id: r.id, title: r.title, folder: r.folder, github: r.github, merge: r.merge }));

export const jobTitle = (repo: BuildRepo, issue: number) => `Queue runner build: ${repo.title}#${issue}`;

/** Asked again after every wait: a repo switched off meanwhile gets no gate verdict, no launch. */
const isServed = (repos: BuildRepo[], repo: BuildRepo) => repos.some((r) => r.id === repo.id);

const join = (folder: string, name: string) => `${folder.replace(/[\\/]+$/, '')}/${name}`;

export class BuildLane {
  private d: BuildLaneDoors;
  private building = new Map<string, Promise<Job>>();
  private watches = new Set<{ stop(): void }>();
  private settler: ThreadSettler;
  /** PR lookups owed after one failed, under way, by job id. */
  private lookingUp = new Map<string, Promise<void>>();
  private resting = new Map<string, number>();
  private holdSaid = new Map<string, string>();
  /** The open-PR hold last said for each repo, so it's said once. */
  private prHeld = new Map<string, string>();
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private now: () => Date;

  constructor(doors: BuildLaneDoors) {
    this.d = doors;
    this.now = doors.now ?? (() => new Date());
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Watches again each build the log shows open and settles each one it shows ended and not
   *  settled (an app that stopped mid-job), then passes. */
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

  /** The user has answered a job that needed them (the Inbox ticket's to ask): its repo is free
   *  again, and a pass runs. Its issue stays held, as every started build's does. */
  async answered(jobId: string): Promise<void> {
    await this.d.log.answered(jobId);
    await this.pass();
  }

  /** The repos with a build running, by T3 project id. */
  running(): string[] {
    return [...this.building.keys()];
  }

  /** Settles once every build under way has ended and been recorded (the tests wait on it). */
  async idle(): Promise<void> {
    while (this.building.size || this.passing || this.settler.pending().length || this.lookingUp.size) {
      await Promise.allSettled([...this.building.values(), this.passing, ...this.settler.pending(), ...this.lookingUp.values()]);
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
    // an end recorded and not settled: left by an app that stopped between the two, or a settle
    // that failed; tried each pass, on its own (a thread left in the sidebar holds no build)
    this.settler.owed('build');
    // a done build whose PR lookup failed: looked up again each pass, a restart's first included
    for (const job of this.d.log.prOwed()) if (job.kind === 'build') void this.lookUp(job);
    const now = this.now().getTime();
    const repos = this.d.repos()
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.github && !this.building.has(r.id) && (this.resting.get(r.id) ?? 0) <= now
        && !this.d.log.needingUser(r.id).length)
      .sort((a, b) => this.waited(a.r) - this.waited(b.r) || a.i - b.i)
      .map(({ r }) => r);
    for (const repo of repos) {
      if (this.stopped) return;
      // a build the user answered on GitHub carries on first (#158)
      const owed = this.carryOwed(repo);
      if (owed) {
        const v = this.carryGate(repo, owed);
        if (!v) continue;
        await new Promise<void>((launched) => {
          this.track(repo.id, this.carryOn(repo, owed.job, owed.stop, v, launched).finally(launched));
        });
        continue;
      }
      // while a stop is open in the repo, no new build starts there (#179)
      const stop = this.d.log.openStops(repo.id)[0];
      if (stop) {
        const text = `${repo.title}: no build while a stop waits for you (${stop.on === 'issue' ? 'issue' : 'PR'} #${stop.pr}: ${stop.why})`;
        if (this.prHeld.get(repo.id) !== text) this.d.say(text);
        this.prHeld.set(repo.id, text);
        continue;
      }
      let base: string;
      let ticket: BuildTicket | null;
      try {
        base = await this.d.github.defaultBranch(repo.github!);
        // one ticket at a time (#179): no build while the repo has an open PR, whoever opened it
        const open = await this.d.github.openPulls(repo.github!);
        if (open.length) {
          const text = `${repo.title}: no build while PR #${Math.min(...open.map((p) => p.number))} is open (one ticket at a time)`;
          if (this.prHeld.get(repo.id) !== text) this.d.say(text);
          this.prHeld.set(repo.id, text);
          continue;
        }
        this.prHeld.delete(repo.id);
        ticket = await pick(this.d.github, repo.github!, base, this.d.log.heldIssues(repo.id));
      } catch (e) {
        this.d.say(`${repo.title}: GitHub couldn't be read (${(e as Error).message})`);
        continue;
      }
      if (!ticket) continue;
      if (!isServed(this.d.repos(), repo)) continue; // switched off while GitHub was read
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

  /** A build of the repo the user answered on GitHub (`replied` to its question's stop) that
   *  nothing has carried on yet, the oldest first. */
  private carryOwed(repo: BuildRepo): { job: Job; stop: Stop } | null {
    const jobs = this.d.log.jobs();
    for (const job of jobs) {
      if (job.kind !== 'build' || job.repo !== repo.id || !job.answeredAt || !job.threadId) continue;
      if (job.end?.outcome !== 'waiting' && job.end?.outcome !== 'done-no-pr') continue;
      if (jobs.some((j) => j.about === job.id && j.end?.outcome !== 'not-started')) continue;
      const stop = this.d.log.stops().find((s) => s.job === job.id && s.answered?.answer === 'replied');
      if (stop) return { job, stop };
    }
    return null;
  }

  /** The gate's word on carrying a build on: in its own thread it runs on that thread's model
   *  (`check`), fresh on the build kind's (`pick`). Which one is known only once T3 is read, so the
   *  stricter is asked here: the build kind's, as a new build would be. Said once when held. */
  private carryGate(repo: BuildRepo, owed: { job: Job }) {
    const id = `build:${repo.github}#${owed.job.issue}`;
    const v = this.d.gate.pick(id, 'build');
    if (!v.fits) {
      const text = holdText(v.hold, (d) => d.toISOString());
      if (this.holdSaid.get(repo.id) !== text) this.d.say(`${owed.job.title} carries on once there's room: ${text}`);
      this.holdSaid.set(repo.id, text);
      return null;
    }
    this.holdSaid.delete(repo.id);
    this.d.gate.forget(id);
    return v;
  }

  /** The answered build carried on, in place or fresh (src/resume.ts), to its end. */
  private async carryOn(repo: BuildRepo, old: Job, stop: Stop, letIn: { choice: Job['choice']; onFallback: boolean; cost: Record<string, number> },
    onLaunched: () => void): Promise<Job> {
    const answer = stop.answered!.text ?? '';
    let now;
    try {
      if (!this.d.ws.request) throw new Error("T3's thread projection can't be read here");
      now = await threadNow(this.d.ws as Pick<T3Ws, 'request'>, old.threadId!);
    } catch (e) {
      // not read: never taken as "cold" or "gone"; tried again after the rest
      onLaunched();
      this.resting.set(repo.id, this.now().getTime() + (this.d.restMs ?? 300_000));
      this.d.say(`${old.title}: its thread couldn't be read to carry it on (${(e as Error).message}); tried again later`);
      return old;
    }
    const choice = resumeChoice(now.lastRequest, now.tokens, this.now());
    const how = choice.inPlace ? 'in-place' : 'fresh';
    const answering = choice.inPlace && old.end!.outcome === 'waiting' && now.pending ? now.pending : null;
    const before = this.d.gate.reading(choice.inPlace ? old.choice : letIn.choice);
    const job = await this.d.log.started({
      kind: 'build', repo: repo.id, github: repo.github, issue: old.issue, branch: old.branch, base: old.base, title: old.title,
      choice: choice.inPlace ? old.choice : letIn.choice, onFallback: choice.inPlace ? old.onFallback : letIn.onFallback,
      cost: letIn.cost, before, about: old.id, resume: { how, why: choice.why },
      ...(answering ? { answering: answering.requestId } : choice.inPlace ? { knownRuns: now.runs } : {}),
    });
    this.d.gate.started({ id: job.id, kind: 'build', choice: job.choice }, letIn.cost, before);
    this.d.say(`${old.title}: ${choice.inPlace ? 'carrying it on in place' : 'carrying it on in a fresh thread'}, ${choice.why}`);
    if (choice.inPlace) {
      // asked again after T3's read: a repo switched off meanwhile gets nothing sent
      if (!isServed(this.d.repos(), repo)) return this.notStarted(job, 'not-started', `${repo.title} is no longer served`);
      const thread = { threadId: old.threadId!, runId: answering ? old.runId ?? null : null, link: old.link ?? null };
      try {
        if (answering) {
          // the question it waits on, answered: its run goes on
          await this.d.log.thread(job.id, thread);
          const answers = Object.fromEntries((answering.questions.length ? answering.questions : ['answer']).map((q) => [q, answer]));
          await this.d.mcp.call('t3_pending_request', { action: 'respond', threadId: old.threadId, requestId: answering.requestId, answers });
        } else {
          const sent = await this.d.mcp.call('t3_thread_send', { threadId: old.threadId, message: this.answerMessage(old, answer), mode: 'queue' });
          thread.runId = typeof sent?.runId === 'string' ? sent.runId : null;
          await this.d.log.thread(job.id, thread);
        }
      } catch (e) {
        // T3 may have taken it: an unclear answer is never "not started"
        if (e instanceof NoAnswer || e instanceof ToolFailed) return this.needsUser(job, (e as Error).message);
        return this.notStarted(job, 'not-started', (e as Error).message);
      }
      onLaunched();
      return this.watch({ ...job, ...thread }, repo.github);
    }
    let launched;
    let work: string | null = null;
    try {
      const catalog = this.d.catalog();
      if (!catalog) return await this.notStarted(job, 'not-started', "T3's providers aren't known yet");
      // its own worktree when git lists one on the branch; else a new one from the branch, on a
      // branch of its own that pushes to the job's (T3 makes no worktree on a branch that exists)
      const own = (await this.d.git.worktrees?.(repo.folder))?.find((w) => w.branch === old.branch);
      let baseRef = old.branch;
      if (!own) {
        work = `${old.branch}-carry-${job.id.slice(-6)}`;
        if (!await this.d.git.hasBranch(repo.folder, old.branch)) {
          await this.d.git.fetch(repo.folder, old.branch);
          baseRef = `origin/${old.branch}`;
        }
      }
      let question: string | null = null;
      try {
        question = (await runReply(this.d.mcp, old.threadId!, old.runId ?? null))?.trim() || null;
      } catch {
        question = null; // the stop on the issue quotes it; the brief links the thread
      }
      const issue = repo.github && this.d.github.issue ? await this.d.github.issue(repo.github, old.issue) : { title: `#${old.issue}`, body: '' };
      const brief = buildBrief({
        github: repo.github ?? repo.title, number: old.issue, title: issue.title, body: issue.body,
        comments: repo.github ? await this.d.github.issueComments(repo.github, old.issue) : [],
        branch: old.branch, base: old.base, user: await this.d.user(),
        agentsFile: this.d.exists(join(repo.folder, 'AGENTS.md')) ? 'AGENTS.md' : this.d.exists(join(repo.folder, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
        carryOn: { question, answer, link: old.link ?? null, work },
      });
      if (!isServed(this.d.repos(), repo)) return await this.notStarted(job, 'not-started', `${repo.title} is no longer served`);
      try {
        launched = await launchJob(this.d.mcp, catalog, {
          kind: 'build', projectId: repo.id, title: job.title, brief, choice: letIn.choice,
          ...(own ? { worktreePath: own.path } : { worktree: { baseRef, branch: work! } }),
        });
      } catch (e) {
        if (e instanceof NoAnswer) return await this.needsUser(job, (e as Error).message);
        throw e;
      }
    } catch (e) {
      return await this.notStarted(job, 'not-started', (e as Error).message);
    }
    await this.d.log.thread(job.id, { threadId: launched.threadId, runId: launched.runId, link: launched.link });
    if (work) await this.d.log.made(job.id, work);
    onLaunched();
    return this.watch({ ...job, threadId: launched.threadId, runId: launched.runId, link: launched.link }, repo.github);
  }

  /** The user's answer as a new turn for a build that ended without a PR. */
  private answerMessage(old: Job, answer: string): string {
    return `The user answered your question on GitHub, on issue #${old.issue}:\n\n${answer.trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`
      + `Carry on with the issue from where you stopped (\`git status\`, \`git log\`) to its PR: go through Before you push, push \`${old.branch}\` and open the PR as your brief says, with \`Closes #${old.issue}\`.`;
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
    // an answer in place the app stopped before T3 took: the question still pending is answered
    // again (#158); a read that fails leaves it to the watch, which still sees the question
    if (job.answering && job.about && this.d.ws.request) {
      try {
        const now = await threadNow(this.d.ws as Pick<T3Ws, 'request'>, job.threadId);
        if (now.pending?.requestId === job.answering) {
          const stop = this.d.log.stops().find((s) => s.job === job.about && s.answered?.answer === 'replied');
          const answers = Object.fromEntries((now.pending.questions.length ? now.pending.questions : ['answer']).map((q) => [q, stop?.answered?.text ?? '']));
          await this.d.mcp.call('t3_pending_request', { action: 'respond', threadId: job.threadId, requestId: job.answering, answers });
        }
      } catch (e) {
        this.d.say(`${job.title}: its answer couldn't be given again after the restart (${(e as Error).message})`);
      }
    }
    this.d.say(`Watching ${job.title} again: ${job.link ?? job.threadId}`);
    return this.watch(job, job.github);
  }

  private async watch(job: Job, github: string | null): Promise<Job> {
    // a build carried on in place: a new turn is told apart from the runs before it, and the
    // question it answered is no question any more (#158)
    const w = watchThreadEnd(this.d.ws, job.threadId!, job.runId ?? null, this.d.retry,
      (why) => this.d.say(`${job.title}: T3's thread stream dropped (${why}); opening it again`),
      new Set(job.knownRuns ?? []), new Set(job.answering ? [job.answering] : []));
    this.watches.add(w);
    let end: ThreadEnd;
    try {
      end = await w.end;
    } finally {
      this.watches.delete(w);
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
    if (end.outcome === 'waiting') record.request = end.request;
    const ended = await this.d.log.ended(job.id, record);
    this.d.say(`${job.title} ended: ${record.outcome}${record.pr ? `, PR #${record.pr.number}` : ''} ${job.link ?? job.threadId}`);
    // recorded first, then settled (story 5); a question or a usage limit is a later ticket's.
    // Stopped between the two, the next start settles it (the log has no settled line)
    if (settles(record.outcome)) await this.settler.settle(job);
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
      } catch (e) {
        this.d.say(`${job.title}: its PR lookup failed again (${(e as Error).message}); tried again next pass`);
      }
    })().finally(() => this.lookingUp.delete(job.id));
    this.lookingUp.set(job.id, l);
    return l;
  }
}
