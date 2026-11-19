// What the loop can't settle (#158; today's `queue_runner/stops.py` and `decisions.py`, with the
// owner's 2026-11-19 decisions on the ticket): only something that needs rethinking reaches the
// user, recorded on GitHub; plumbing, and a fix that just needs another round, never does.
//
// **What reaches the user**, each a stop:
// - **the cap** (src/cap.ts): a review still blocking with no round left under it (`approach-note`),
//   or a round a lane would start past it. A decision thread writes an Approach note first, posted
//   on the PR; then the stop is filed, linking it.
// - **a question** from a builder (a build, fix or conflict thread waiting on one; a build that
//   ended without a PR; a fix round that ended without a push, which its brief says to do when
//   something is only the user's) or from a decision thread (its `stop`).
// - **a job with no saved thread id after a restart**, or a launch or send whose answer was lost
//   (`needs-user`, #154): T3 may have started a thread the app has no id of.
//
// **Filed** (the loop's own posts on the repo, no go-ahead): on a PR, its one `needs-info` issue
// (found by its hidden line, else filed) gets the stop as a comment, and the PR a comment linking
// it; on a build's own issue (no PR yet), a comment there with the question, and the issue
// labelled `needs-info` in place of `ready-for-agent`. Every comment carries the app's hidden mark
// (`runnerPost`), and is looked for before it's posted again, so a retry never posts it twice. A
// write that fails is said and tried again next pass; the stop holds its PR whether it's filed yet
// or not.
//
// **Answered** on GitHub: its issue closed, or a person (not a bot, not the app's own posts)
// writing on the PR or the issue after the stop. **Its PR merged or closed** outside the app clears
// it (#88): its `needs-info` issue gets a note and is closed, unless another open stop shares it.
// Then the job it's about is answered (`answered` in the job log), and the lanes are told: the PR
// goes back to the loop, its next round told the user's words first; a build answered carries on
// to its PR (src/build-lane.ts). While a stop is open its PR gets no review, round or merge, and its
// repo starts no build (#179).
//
// **Decision threads** (#68 story 6): a fresh thread on the decision kind's settings, in the repo's
// T3 project with no worktree, with one narrow question and the state (src/briefs/decision.ts). Its
// answer is read once, acted on or turned into a stop, and its thread settled once it's read. One
// the log shows open after a restart is watched again; one with no thread id, or whose launch
// answer was lost, files the cap stop with no note rather than guess.
import type { BuildRepo } from './build-lane.ts';
import { APPROACH_NOTE, decisionBrief, readDecision } from './briefs/decision.ts';
import { CAP } from './cap.ts';
import { holdText } from './gate.ts';
import type { GitHubMerge, GitHubReview, GitHubStops, GitHubWork } from './github.ts';
import type { Job, JobLog, Stop, StopStart } from './job-log.ts';
import type { Catalog, ModelChoice } from './jobs.ts';
import { launchJob } from './launch.ts';
import { readReviews, runnerPost, state, type Comment } from './review/ledger.ts';
import type { GitHubPosts } from './review/post.ts';
import { ThreadSettler } from './settle.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { retryAfter, type Retry } from './t3/project-feed.ts';
import { NoAnswer } from './t3/seams.ts';
import { watchThreadEnd } from './t3/thread-end.ts';
import { runReply } from './t3/thread-reply.ts';
import type { T3Ws } from './t3/ws.ts';
import type { UsageGate } from './usage-gate.ts';

export const NEEDS_INFO = 'needs-info';
const READY = 'ready-for-agent';
/** How much of a thread's last message a stop quotes. */
export const QUOTE_CHARS = 3000;
const RECOMMEND = ['rework', 'fix on', 'hold'];

/** The hidden line that ties a `needs-info` issue to its PR. */
export const needsInfoMark = (github: string, pr: number) => `<!-- queue-runner-app needs-info ${github}#${pr} -->`;
const stopMark = (id: string) => `<!-- queue-runner-app stop ${id} -->`;
const noteMark = (id: string) => `<!-- queue-runner-app approach-note ${id} -->`;
const clearedMark = (id: string) => `<!-- queue-runner-app stop-cleared ${id} -->`;

export type StopDeskDoors = {
  repos: () => BuildRepo[];
  github: Pick<GitHubReview, 'issueComments' | 'reviewReplies' | 'pullsToReview'> & Pick<GitHubMerge, 'pull'> & Pick<GitHubWork, 'issueState'>
    & Pick<GitHubPosts, 'openIssues' | 'createIssue' | 'postComment'> & GitHubStops;
  mcp: Pick<T3Mcp, 'call'>;
  ws: Pick<T3Ws, 'subscribe'>;
  gate: Pick<UsageGate, 'pick' | 'started' | 'finished' | 'dropped' | 'forget'>;
  catalog: () => Catalog | null;
  user: () => Promise<string>;
  log: JobLog;
  say: (line: string) => void;
  /** A stop was answered or cleared: the lanes pass (the PR, or the build, goes on). */
  answered?: (stop: Stop) => void;
  retry?: Retry;
};

const issueNumber = (url: string) => Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? NaN);
const quote = (text: string) => {
  const t = text.trim();
  return (t.length > QUOTE_CHARS ? `${t.slice(0, QUOTE_CHARS)}…` : t).split('\n').map((l) => `> ${l}`).join('\n');
};
/** Said by a person, after `at`: not a bot, not one of the app's (or another runner's) own posts. */
const said = (c: Comment, at: string) => c.createdAt > at && !/\[bot\]$/i.test(c.author) && !runnerPost(c.body);

export class StopDesk {
  private d: StopDeskDoors;
  private settler: ThreadSettler;
  private passing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private why = new Map<string, string | null>();
  /** Decision threads under way, by stop id. */
  private deciding = new Map<string, Promise<void>>();
  private watches = new Set<{ stop(): void }>();

  constructor(doors: StopDeskDoors) {
    this.d = doors;
    this.settler = new ThreadSettler(doors.mcp, doors.log, doors.say);
  }

  /** Each decision the log shows open is watched again (or files its stop with no note), then a pass. */
  start(): Promise<void> {
    for (const job of this.d.log.open()) {
      if (job.kind !== 'decision' || !job.about) continue;
      const stop = this.d.log.stops().find((s) => s.id === job.about);
      if (stop) this.track(stop.id, this.resume(job, stop));
    }
    return this.pass();
  }

  stop() {
    this.stopped = true;
    for (const w of this.watches) w.stop();
  }

  async idle(): Promise<void> {
    while (this.passing || this.deciding.size || this.settler.pending().length) {
      await Promise.allSettled([this.passing, ...this.deciding.values(), ...this.settler.pending()]);
    }
  }

  usageChanged(): void {
    if ([...this.why.values()].some((w) => w?.startsWith('waits:'))) void this.pass();
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

  private note(key: string, line: string | null) {
    if (line && this.why.get(key) !== line) this.d.say(line);
    this.why.set(key, line);
  }

  private track(id: string, p: Promise<void>) {
    this.deciding.set(id, p);
    p.catch((e) => this.d.say(`a decision on stop ${id} stopped: ${(e as Error).message}`)).finally(() => {
      this.deciding.delete(id);
      if (!this.stopped) void this.pass();
    });
  }

  private async passOnce() {
    this.settler.owed('decision');
    const served = new Map(this.d.repos().filter((r) => r.github).map((r) => [r.id, r]));
    await this.record(served);
    await this.free();
    for (const stop of this.d.log.stops()) {
      if (this.stopped) return;
      const repo = served.get(stop.repo);
      if (!repo || stop.answered || stop.cause === 'conflict') continue;
      const key = stop.id;
      try {
        if (stop.cause === 'cap' && !stop.noted) {
          if (!this.deciding.has(stop.id)) await this.decide(repo, stop);
          continue;
        }
        if (!stop.filed) await this.file(repo, stop);
        else await this.read(repo, stop);
        this.note(key, null);
      } catch (e) {
        this.note(key, `stop on ${repo.title}#${stop.pr}: GitHub or T3 couldn't be read or written (${(e as Error).message}); tried again next pass`);
      }
    }
  }

  // --- what's recorded ------------------------------------------------------------------------

  /** Stops the lanes' ends imply, recorded once each: a review at the cap, a question, a job that
   *  needs the user. Only jobs in served repos on GitHub. */
  private async record(served: Map<string, BuildRepo>) {
    const has = (job: Job) => this.d.log.stops().some((s) => s.job === job.id);
    for (const job of this.d.log.jobs()) {
      const repo = served.get(job.repo);
      if (!repo || !job.end || has(job) || job.answeredAt) continue;
      const on: StopStart['on'] = job.kind === 'build' ? 'issue' : 'pr';
      const base = { repo: job.repo, github: repo.github!, pr: job.issue, sha: on === 'issue' ? null : job.sha ?? null, link: job.link ?? null, on, job: job.id };
      const o = job.end.outcome;
      let stop: StopStart | null = null;
      if (job.kind === 'review' && o === 'approach-note') {
        stop = { ...base, cause: 'cap', why: `review ${job.round} of ${job.sha!.slice(0, 7)} is still blocking at the cap (review ${CAP})`, link: job.end.link ?? null };
      } else if (o === 'needs-user' && job.kind !== 'decision') {
        stop = { ...base, cause: 'needs-user', why: `${job.title} may have started a T3 thread the app has no id of (${job.end.error ?? 'its answer was lost'}): look in T3, and answer here once it's dealt with` };
      } else if (o === 'waiting' && job.kind !== 'review' && job.kind !== 'decision') {
        stop = { ...base, cause: 'question', why: `${job.title} stopped to ask a question` };
      } else if (job.kind === 'build' && o === 'done-no-pr') {
        stop = { ...base, cause: 'question', why: `${job.title} ended without a PR` };
      } else if (job.kind === 'fix' && o === 'done' && job.end.head === job.sha) {
        stop = { ...base, cause: 'question', why: `${job.title} ended without a push` };
      }
      if (!stop) continue;
      const s = await this.d.log.stopped(stop);
      this.d.say(`${repo.title}#${s.pr}: a stop for you, ${s.why}`);
    }
  }

  /** The jobs an answered stop is about, answered: also after an app that stopped between
   *  recording the answer and this. */
  private async free() {
    for (const stop of this.d.log.stops()) {
      if (!stop.answered) continue;
      for (const job of this.d.log.jobs()) {
        if ((job.id === stop.job || (job.kind === 'decision' && job.about === stop.id)) && job.end && !job.answeredAt
          && (job.end.outcome === 'needs-user' || job.end.outcome === 'waiting' || job.end.outcome === 'done-no-pr' || job.end.outcome === 'done')) {
          await this.d.log.answered(job.id);
        }
      }
    }
  }

  // --- the Approach note --------------------------------------------------------------------

  /** The cap stop's Approach note: a decision thread asked, gated as the decision kind. */
  private async decide(repo: BuildRepo, stop: Stop) {
    const key = stop.id;
    const name = `decision ${repo.title}#${stop.pr}`;
    // one that started no thread before is asked again; any other end files the stop as it is
    const done = this.d.log.jobs().filter((j) => j.kind === 'decision' && j.about === stop.id && j.end && j.end.outcome !== 'not-started').at(-1);
    if (done) {
      // a note posted before the app stopped, and not yet recorded: found by its mark
      const posted = done.end!.action === 'approach-note'
        ? (await this.d.github.issueComments(repo.github!, stop.pr)).find((c) => c.body.includes(noteMark(stop.id))) : undefined;
      if (posted) {
        await this.d.log.stopNoted(stop.id, posted.url ?? null, `The Approach note: ${posted.url ?? 'on the PR'}.`);
        return;
      }
      return this.unnoted(stop, `the decision thread ended ${done.end!.outcome}${done.end!.error ? ` (${done.end!.error})` : ''}`);
    }
    const v = this.d.gate.pick(`decision:${stop.id}`, 'decision');
    if (!v.fits) { this.note(key, `${name}: waits: ${holdText(v.hold, (d) => d.toISOString())}`); return; }
    const catalog = this.d.catalog();
    if (!catalog) { this.note(key, `${name}: waits: T3's providers aren't known yet`); return; }
    this.d.gate.forget(`decision:${stop.id}`);
    this.note(key, null);
    const brief = await this.approachBrief(repo, stop);
    const pr = await this.d.github.pull(repo.github!, stop.pr);
    // asked again after the reads: a repo switched off meanwhile starts nothing
    if (!this.d.repos().some((r) => r.id === repo.id)) return;
    const job = await this.d.log.started({
      kind: 'decision', repo: repo.id, github: repo.github, issue: stop.pr, branch: pr.branch, base: pr.base,
      title: `Queue runner decision: ${repo.title}#${stop.pr}`, choice: v.choice, onFallback: v.onFallback, cost: v.cost,
      ...(stop.sha ? { sha: stop.sha } : {}), question: APPROACH_NOTE.kind, about: stop.id,
    });
    this.d.gate.started({ id: job.id, kind: 'decision', choice: v.choice }, v.cost);
    let launched;
    try {
      this.d.say(`${name}: a decision thread writes the Approach note`);
      launched = await launchJob(this.d.mcp, catalog, { kind: 'decision', projectId: repo.id, title: job.title, brief, choice: v.choice as ModelChoice });
    } catch (e) {
      this.d.gate.dropped(job.id);
      // sent and its answer lost: no thread is guessed at, and the stop goes to the user unnoted
      if (e instanceof NoAnswer) { await this.d.log.ended(job.id, { outcome: 'needs-user', error: (e as Error).message }); return; }
      await this.d.log.ended(job.id, { outcome: 'not-started', error: (e as Error).message });
      this.d.say(`${name} not started: ${(e as Error).message}`);
      return;
    }
    const thread = { threadId: launched.threadId, runId: launched.runId, link: launched.link };
    await this.d.log.thread(job.id, thread);
    this.track(stop.id, this.carryOn({ ...job, ...thread }, repo, stop));
  }

  private async resume(job: Job, stop: Stop): Promise<void> {
    this.d.gate.started({ id: job.id, kind: 'decision', choice: job.choice }, job.cost ?? {});
    if (!job.threadId) {
      this.d.gate.dropped(job.id);
      await this.d.log.ended(job.id, { outcome: 'needs-user', error: 'the app stopped before T3 named its thread' });
      return;
    }
    const repo = this.d.repos().find((r) => r.id === job.repo);
    if (repo) await this.carryOn(job, repo, stop);
  }

  /** The decision thread watched to its end, its answer read once and acted on, the thread settled. */
  private async carryOn(job: Job, repo: BuildRepo, stop: Stop): Promise<void> {
    const w = watchThreadEnd(this.d.ws, job.threadId!, job.runId ?? null, this.d.retry,
      (why) => this.d.say(`${job.title}: T3's thread stream dropped (${why}); opening it again`));
    this.watches.add(w);
    let end;
    try {
      end = await w.end;
    } catch {
      return; // stopped: the next start watches it again
    } finally {
      this.watches.delete(w);
    }
    this.d.gate.finished(job.id, end.outcome === 'usage-limit' ? { resetAt: end.resetAt } : undefined);
    if (end.outcome !== 'done') {
      const ended = await this.d.log.ended(job.id, { outcome: 'failed', status: end.status, error: `it ended ${end.outcome}${'error' in end && end.error ? `: ${end.error}` : ''}` });
      await this.settler.settle(ended);
      return;
    }
    // a read that fails is asked again after a wait, never taken as no answer; only an empty reply
    // three times in a row is the thread's own
    let reply: string | null = null;
    for (let empty = 0; !reply && empty < 3;) {
      if (this.stopped) return; // its end isn't recorded: the next start reads it again
      try {
        reply = (await runReply(this.d.mcp, job.threadId!, job.runId ?? null))?.trim() || null;
        if (!reply) empty++;
      } catch (e) {
        this.d.say(`${job.title}: its reply couldn't be read (${(e as Error).message}); asking again`);
        await new Promise<void>((done) => { (this.d.retry ?? retryAfter(30_000))(done); });
      }
    }
    const decided = reply ? readDecision(reply, APPROACH_NOTE) : { error: 'its reply was empty' };
    const ok = 'action' in decided && (decided.action !== 'approach-note' || RECOMMEND.includes(decided.fields.recommend!.toLowerCase()));
    const error = 'error' in decided ? decided.error : ok ? null : `its recommendation ${JSON.stringify(decided.fields.recommend)} isn't rework, fix on or hold`;
    const ended = await this.d.log.ended(job.id, { outcome: 'decided', status: end.status, action: error ? 'stop' : (decided as { action: string }).action, error });
    // settled once its answer is read (#68 story 6)
    await this.settler.settle(ended);
    if (error || !('action' in decided)) return this.unnoted(stop, `the decision thread's answer couldn't be read: ${error}`);
    if (decided.action === 'stop') {
      await this.d.log.stopNoted(stop.id, null, `A decision thread couldn't write the Approach note and asks you instead:\n\n${quote(decided.fields.question!)}`);
      return;
    }
    const body = `## Approach note\n\n${decided.fields.note}\n\n**Recommendation:** ${decided.fields.recommend!.toLowerCase()}.\n\n`
      + `<sub>Written by a decision thread for ${await this.d.user()} at the cap (review ${CAP} still blocking): ${job.link ?? job.threadId}</sub>\n\n${noteMark(stop.id)}\n`;
    const url = await this.postOnce(repo.github!, stop.pr, noteMark(stop.id), body);
    await this.d.log.stopNoted(stop.id, url, `The Approach note: ${url}. Recommendation: ${decided.fields.recommend!.toLowerCase()}.`);
    this.d.say(`${repo.title}#${stop.pr}: the Approach note is on the PR: ${url}`);
  }

  /** The cap stop goes to the user without a note, saying why. */
  private async unnoted(stop: Stop, why: string) {
    await this.d.log.stopNoted(stop.id, null, `No Approach note: ${why}.`);
  }

  private async approachBrief(repo: BuildRepo, stop: Stop): Promise<string> {
    const github = repo.github!;
    const pr = (await this.d.github.pullsToReview(github)).find((p) => p.number === stop.pr);
    const reviews = readReviews(await this.d.github.issueComments(github, stop.pr));
    const open = state(reviews).filter((f) => f.tag === 'important' && (f.status === 'open' || f.status === 'decline-kept'));
    const jobs = this.d.log.jobs().filter((j) => j.repo === repo.id && (j.issue === stop.pr || (pr && j.branch === pr.branch)) && j.kind !== 'decision');
    const history = jobs.map((j) => `- ${j.kind}${j.round ? ` ${j.round}` : ''} on ${j.sha?.slice(0, 7) ?? 'its branch'}: ${j.end?.outcome ?? 'still open'}`
      + `${j.end?.signals?.length ? ` (signals: ${j.end.signals.join(', ')})` : ''}${j.link ? `, ${j.link}` : ''}`).join('\n');
    return decisionBrief({
      subject: `${github}#${stop.pr}`, user: await this.d.user(), question: APPROACH_NOTE,
      sources: [
        { title: `The PR: #${stop.pr} ${pr?.title ?? ''}`, text: `${pr?.body ?? ''}\n\nWhy it stopped: ${stop.why}` },
        { title: 'Open Important findings, from the newest review', text: open.map((f) => `- ${f.id} (${f.class || 'no class'}, raised in review ${f.raised}${f.status === 'decline-kept' ? ', a decline the reviewer kept' : ''}): ${f.file}${f.line ? `:${f.line}` : ''} ${f.scenario || f.cost}`).join('\n') },
        { title: 'Every review and round so far, with its signals', text: history },
        { title: 'Read more', text: `The reviews and their ledgers: \`gh pr view ${stop.pr} --repo ${github} --comments\`.` },
      ],
    });
  }

  // --- filing -------------------------------------------------------------------------------

  /** A comment carrying `mark`, posted once: one already there (a retry after a lost answer) is it. */
  private async postOnce(github: string, n: number, mark: string, body: string): Promise<string> {
    const there = (await this.d.github.issueComments(github, n)).find((c) => c.body.includes(mark));
    if (there) return there.url ?? `https://github.com/${github}/issues/${n}`;
    return this.d.github.postComment(github, n, body);
  }

  private async stopText(stop: Stop): Promise<string> {
    const user = await this.d.user();
    const what = { cap: 'the cap', question: 'a question', 'needs-user': 'a job the app lost track of', conflict: 'a conflict' }[stop.cause];
    const parts = [`**Stopped for ${user}** (${what}): ${stop.why}.`];
    if (stop.noted) parts.push(stop.noted.text);
    const job = stop.job ? this.d.log.get(stop.job) : undefined;
    // a question's own words: the thread's last message (a read that fails is tried next pass)
    if (stop.cause === 'question' && job?.threadId) {
      const last = await runReply(this.d.mcp, job.threadId, job.runId ?? null);
      if (last?.trim()) parts.push(`Its last message:\n\n${quote(last)}`);
    }
    if (stop.link || job?.link) parts.push(`Thread: ${stop.link ?? job!.link}`);
    parts.push(stop.cause === 'question' ? 'Answer here: the job carries on with your answer.' : 'Answer here, or close the issue, and the PR goes back to the loop.');
    return parts.join('\n\n');
  }

  private async file(repo: BuildRepo, stop: Stop) {
    const github = repo.github!;
    const text = await this.stopText(stop);
    if ((stop.on ?? 'pr') === 'issue') {
      await this.postOnce(github, stop.pr, stopMark(stop.id), `${text}\n\n${stopMark(stop.id)}\n`);
      await this.d.github.relabel(github, stop.pr, NEEDS_INFO, READY);
      await this.d.log.stopFiled(stop.id, `https://github.com/${github}/issues/${stop.pr}`);
      this.d.say(`${repo.title}#${stop.pr}: the stop is on the issue`);
      return;
    }
    const issue = await this.needsInfo(repo, stop.pr);
    await this.postOnce(github, issueNumber(issue), stopMark(stop.id), `${text}\n\nThe PR: https://github.com/${github}/pull/${stop.pr}\n\n${stopMark(stop.id)}\n`);
    await this.postOnce(github, stop.pr, stopMark(stop.id), `**Stopped for ${await this.d.user()}:** ${stop.why}. It's in ${issue}; answer there or here.\n\n${stopMark(stop.id)}\n`);
    await this.d.log.stopFiled(stop.id, issue);
    this.d.say(`${repo.title}#${stop.pr}: the stop is filed in ${issue}`);
  }

  /** The PR's one open `needs-info` issue, found by its hidden line, or filed. */
  private async needsInfo(repo: BuildRepo, pr: number): Promise<string> {
    const github = repo.github!;
    const mark = needsInfoMark(github, pr);
    const there = (await this.d.github.openIssues(github)).find((i) => i.body.includes(mark));
    if (there) return there.url;
    const p = await this.d.github.pull(github, pr);
    return this.d.github.createIssue(github, `PR #${pr} needs ${await this.d.user()}: ${p.title}`,
      `The loop stopped on https://github.com/${github}/pull/${pr} for something only you can settle. Each stop is a comment below.\n\n${mark}\n`, [NEEDS_INFO]);
  }

  // --- answers ------------------------------------------------------------------------------

  private async read(repo: BuildRepo, stop: Stop) {
    const github = repo.github!;
    const issue = issueNumber(stop.filed!.issue);
    if ((stop.on ?? 'pr') === 'pr') {
      const pr = await this.d.github.pull(github, stop.pr);
      if (pr.state !== 'open') return this.clear(repo, stop, issue, pr.state);
    }
    if (await this.d.github.issueState(github, issue) === 'closed') return this.answer(repo, stop, 'issue-closed', null);
    const words = [...await this.d.github.issueComments(github, issue)];
    if ((stop.on ?? 'pr') === 'pr') words.push(...await this.d.github.issueComments(github, stop.pr), ...await this.d.github.reviewReplies(github, stop.pr));
    const reply = words.filter((c) => said(c, stop.at)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (reply.length) return this.answer(repo, stop, 'replied', reply.map((c) => c.body.trim()).join('\n\n'));
  }

  /** The PR merged or closed outside the app (#88): its `needs-info` issue gets a note and is closed
   *  (completed for a merge, not planned for a close), unless another open stop shares it. */
  private async clear(repo: BuildRepo, stop: Stop, issue: number, state: 'merged' | 'closed') {
    const github = repo.github!;
    const shared = this.d.log.openStops(repo.id, stop.pr).some((s) => s.id !== stop.id && s.filed?.issue === stop.filed!.issue);
    if (!shared && await this.d.github.issueState(github, issue) === 'open') {
      await this.postOnce(github, issue, clearedMark(stop.id), `PR #${stop.pr} was ${state} without an answer here, so this stop is cleared.\n\n${clearedMark(stop.id)}\n`);
      await this.d.github.closeIssue(github, issue, state === 'merged' ? 'completed' : 'not_planned');
    }
    await this.answer(repo, stop, 'pr-closed', null);
  }

  private async answer(repo: BuildRepo, stop: Stop, how: 'issue-closed' | 'replied' | 'pr-closed', text: string | null) {
    const done = await this.d.log.stopAnswered(stop.id, how, text);
    // the job it's about is answered: a question's carries on, one that needed the user frees its repo
    await this.free();
    this.d.say(`${repo.title}#${stop.pr}: the stop is ${how === 'pr-closed' ? 'cleared: the PR was merged or closed' : how === 'issue-closed' ? 'answered: its issue was closed' : 'answered on GitHub'}`);
    this.d.answered?.(done);
  }
}
