// What the run loop (`src/run.ts`) calls in Python modules that later port tickets bring over, each
// standing in with Python's names until its ticket ports it and replaces it here. Each answers as
// its Python part does when there is nothing for it: no decision, ask, answer or fix round to
// start, no title to change, no stop in `control.json`, no wake task, no toast, no effort read
// back. None reads a file, T3 or GitHub. A method only a later part reaches throws, naming the
// ticket that ports it: nothing here can call it until that ticket does.
import { type Config, type Repo, working } from './config.ts';
import { type GhCli, PullRequest } from './github-seam.ts';
import { err_str, type_name } from './python.ts';
import { type Job, type JobLog, NOT_SENT, NOT_STARTED, REVIEWED } from './state.ts';

/** A part the run loop has no caller for until its ticket: thrown if it is ever reached. */
export class NotPorted extends Error {
  override name = 'NotPorted';
  constructor(what: string, ticket: string) {
    super(`${what} is ported in ${ticket}`);
  }
}

// --- `snapshot.py` (#230) ---------------------------------------------------------------------

/** `snapshot.Wait`: what a lane, or a repo's job, waits for, as the last pass left it. */
export class Wait {
  readonly until: Date | null;
  readonly reason: string;
  constructor(until: Date | null, reason: string) {
    [this.until, this.reason] = [until, reason];
    Object.freeze(this);
  }
}

// --- `control.py` (#229): `control.json`, read as an empty one ----------------------------------

export const LANES = ['claude', 'sol'] as const;
export const NAMES: Readonly<Record<string, string>> = { claude: 'Claude', sol: 'reviewing' };

/** `control.Stop`: what Stefan last asked of one lane or repo. */
export class Stop {
  readonly asked: string | null;
  constructor(asked: string | null = null) {
    this.asked = asked;
    Object.freeze(this);
  }

  get stopped(): boolean {
    return this.asked !== null;
  }
}

/** `control.Switch`: both lanes' stops and each repo's, as read now. */
export class Switch {
  readonly error: string | null = null;
  readonly repos: ReadonlyMap<string, Stop> = new Map();

  stop(_lane: string): Stop {
    return new Stop();
  }

  repo_stop(name: string): Stop {
    return this.repos.get(name) ?? new Stop();
  }

  holds(lane: string): boolean {
    return this.error !== null || this.stop(lane).stopped;
  }
}

/** `control.read`: until #229 the switch as an absent `control.json` reads (nothing stopped). */
export function read(_state_dir: string): Switch {
  return new Switch();
}

/** `control.stopped_repos`: the served repos stopped, and the names stopped that aren't served. */
export function stopped_repos(repos: readonly Repo[], switch_: Switch): [string[], string[]] {
  const names = repos.map((r) => r.name);
  const stopped = names.filter((n) => switch_.repo_stop(n).stopped);
  const unknown = [...switch_.repos].filter(([n, s]) => s.stopped && !names.includes(n)).map(([n]) => n).sort();
  return [stopped, unknown];
}

function resume_hint(lane: string): string {
  const cli = 'python3 -m queue_runner --resume' + (lane === 'claude' ? '' : ` ${lane}`);
  return `Resume on the dashboard, or ${cli}`;
}

export function stopped_text(lane: string): string {
  const what = lane === 'claude' ? 'starts no job' : 'starts no review and merges nothing';
  return `The ${NAMES[lane]} lane is stopped by Stefan: it ${what} (${resume_hint(lane)})`;
}

export function repo_stopped_text(name: string): string {
  return `${name} is stopped by Stefan: neither lane takes up its work, and a job already `
    + `running on it finishes (Resume it on the dashboard, or python3 -m queue_runner `
    + `--resume ${name})`;
}

export function repo_resumed_text(name: string): string {
  return `${name} runs again: Stefan resumed it`;
}

export function unknown_repos_text(names: readonly string[]): string {
  const verb = names.length === 1 ? 'is' : 'are';
  return `control.json stops ${names.join(', ')}, which ${verb} not served: ignored`;
}

export function unreadable_text(switch_: Switch): string {
  return `Neither lane starts anything: ${switch_.error}, and until it is fixed nothing `
    + 'starts (a Stop or Resume on the dashboard, or --pause or --resume, writes it afresh)';
}

// --- `fallback.py` (#222) -----------------------------------------------------------------------

/** A review job's `reviewer` when an Opus thread reviewed (`fallback.OPUS_KINDS`). */
export const OPUS_KINDS: readonly string[] = ['opus-fallback', 'opus-config'];

/** An Opus review as the usage gate and `shared_with` name it: `review queue-runner#67`. */
export function gate_label(repo: string, number: number | null): string {
  return `review ${repo}#${number ?? 'None'}`;
}

// --- `review.py` (#222): the Sol lane's `Reviewer` ----------------------------------------------

/** What the run loop asks of the Sol lane's reviewer. Python builds one only when it has Sol; until
 *  #222 the app has none, so the runner's `reviewer` is null and the Sol lane's pass is IDLE. */
export type Reviewer = {
  live: string | null;
  readonly titles: Map<string, string>;
  review_pass(): Promise<string>;
};

// --- `decisions.py` (#226) ----------------------------------------------------------------------

/** The questions a decision answers, and what each allows (`decisions.QUESTIONS`). */
export const QUESTIONS: Readonly<Record<string, readonly string[]>> = {
  'approach-note': ['approach-note', 'stop'],
  reply: ['fix', 'carry-on', 'hold', 'stop'],
  failed: ['retry', 'close', 'stop'],
  waiting: ['answer', 'stop'],
  'no-pr': ['retry', 'close', 'stop'],
};
/** A job's outcome -> its case (`decisions.ENDED`). */
export const ENDED: Readonly<Record<string, string>> = { failed: 'failed', waiting: 'waiting', 'done-no-pr': 'no-pr' };

/** A case the flow doesn't cover, for a decision thread (`decisions.Case`). Stefan's words since a
 *  stop (`said`) are read with the decision itself (#226). */
export class Case {
  readonly question: string;
  readonly repo: Repo;
  readonly number: number;
  readonly about: Job;
  readonly pr: PullRequest | null;
  constructor(question: string, repo: Repo, number: number, about: Job, pr: PullRequest | null = null) {
    [this.question, this.repo, this.number, this.about, this.pr] = [question, repo, number, about, pr];
    Object.freeze(this);
  }

  get allowed(): string[] {
    return QUESTIONS[this.question]!.filter((a) => a !== 'close' || this.about.kind === 'build');
  }

  get name(): string {
    return `decision ${this.repo.name}#${this.number} (${this.question})`;
  }
}

/** `stops.approach_review`: the runner's newest review of the PR (any head, not released), if it's
 *  an approach note. */
function approach_review(jobs: JobLog, repo: Repo, n: number): Job | null {
  const reviews = jobs.on('review', repo.name, n).filter((j) => j.outcome !== null && REVIEWED.has(j.outcome));
  const last = reviews.at(-1);
  return last && last.outcome === 'approach-note' ? last : null;
}

/** `stops.undecided_replies`: stops on the PR Stefan answered by a reply that no decision has read
 *  yet, oldest first. */
function undecided_replies(jobs: JobLog, repo: Repo, n: number): Job[] {
  const pos = new Map(jobs.jobs().map((j, i) => [j.id, i]));
  const read = jobs.on('decision', repo.name, n, null, true)
    .filter((d) => d.question === 'reply' && d.outcome !== NOT_STARTED).map((d) => pos.get(d.id)!);
  return jobs.on('stop', repo.name, n)
    .filter((s) => s.outcome === 'answered' && s.answer === 'replied' && !read.some((p) => p > pos.get(s.id)!));
}

/** `decisions.Decider`, the part that finds the cases (`next_case`, `cases`), ported so the run loop
 *  knows where Python would start a decision: it holds that repo until #226 ports the decision
 *  itself (its brief, thread and acts), and starts nothing else there in its place. */
export class Decider {
  readonly config: Config;
  readonly github: Pick<GhCli, 'open_pulls'>;
  readonly jobs: JobLog;
  readonly say: (line: string) => void;
  constructor(config: Config, { github, jobs, say }: { github: Pick<GhCli, 'open_pulls'>; jobs: JobLog; say: (line: string) => void }) {
    [this.config, this.github, this.jobs, this.say] = [config, github, jobs, say];
  }

  /** The first case to decide, in the working repos (or in `repos` of them: the Claude lane chooses
   *  each repo's job apart, #50). */
  async next_case({ repos = null }: { repos?: readonly string[] | null } = {}): Promise<Case | null> {
    for (const repo of working(this.config)) {
      if (repos !== null && !repos.includes(repo.name)) continue;
      if (!repo.github) continue;
      try {
        for (const case_ of await this.cases(repo)) return case_;
      } catch (e) {   // GitHub down: fix rounds and builds may still go on
        this.say(`decisions on ${repo.name}: reading GitHub failed (${type_name(e)}: ${err_str(e)})`);
      }
    }
    return null;
  }

  /** The cases waiting for a decision in this repo, in the order they're taken. */
  async cases(repo: Repo): Promise<Case[]> {
    const jobs = this.jobs;
    const found: Case[] = [];
    const prs = new Map((await this.github.open_pulls(repo as Repo & { github: string })).map((p) => [p.number, p]));
    const numbers = [...prs.keys()].sort((a, b) => a - b);
    for (const n of numbers) {
      const pr = prs.get(n)!;
      if (jobs.writer(repo.name, pr.branch)) continue;
      // The newest review, on whatever head it was: the note is about that review.
      const r = approach_review(jobs, repo, n);
      if (r && !jobs.decided(r.id) && !jobs.stopped(repo.name, n, r.sha!, 'approach-note')) {
        found.push(new Case('approach-note', repo, n, r, new PullRequest({ ...pr, head_sha: r.sha ?? '' })));
      }
    }
    for (const n of numbers) {
      // One reply may answer several stops: one decision reads it, about the newest Approach note
      // among them if there is one.
      const waiting = undecided_replies(jobs, repo, n);
      if (waiting.length) {
        const s = [...waiting].reverse().find((w) => w.stop === 'approach-note') ?? waiting.at(-1)!;
        found.push(new Case('reply', repo, n, s, prs.get(n)!));
      }
    }
    const newest = new Map<string, [string, number | null, Job]>();   // each issue's newest build and each PR's newest fix
    for (const j of jobs.jobs()) {   // one that never reached a thread is no newer job: it never ran
      if ((j.kind === 'build' || j.kind === 'fix') && j.repo === repo.name
        && j.outcome !== NOT_SENT && j.outcome !== NOT_STARTED) {
        newest.set(`${j.kind}#${j.issue}`, [j.kind, j.issue, j]);
      }
    }
    const ordered = [...newest.values()].sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
    for (const [kind, n, j] of ordered) {
      if (j.open || j.outcome === null || !Object.hasOwn(ENDED, j.outcome) || !j.thread_id || jobs.decided(j.id)
        || !jobs.on(kind, repo.name, n).some((o) => o.id === j.id)) continue;   // a release settled it
      const pr = kind === 'fix' ? prs.get(n!) ?? null : null;
      if (kind === 'fix' && (pr === null || (j.outcome === 'failed' && pr.head_sha !== j.sha))) continue;
      found.push(new Case(ENDED[j.outcome]!, repo, n!, j, pr));
    }
    return found;
  }
}

// --- `ask_threads.py` (#233) and `waiting.py`, `prefixes.py` (#232) ------------------------------

/** An ask Stefan asked to open in a T3 thread (`ask_threads.Opening`). */
export type Opening = { readonly repo: Repo; readonly number: number };

/** A waiting job's answer: (the job, the answer's text, the end record's marks). */
export type Answered = readonly [old: Job, text: string, marks: Record<string, unknown> | null];

/** `ask_threads.AskThreads`: no ask to open and no answer to read until #233. */
export class AskThreads {
  async read_answers(): Promise<void> {}

  async next(_switch: Switch, _options: { only?: readonly string[] | null } = {}): Promise<Opening | null> {
    return null;
  }

  async open(_o: Opening): Promise<string> {
    throw new NotPorted('AskThreads.open', '#233');
  }

  async reply(_options: { repos?: readonly string[] | null } = {}): Promise<Answered | null> {
    return null;
  }
}

/** `waiting.GitHubAnswers`: no answer on GitHub to read until #232. */
export class GitHubAnswers {
  async read(): Promise<void> {}

  async next(_options: { repos?: readonly string[] | null } = {}): Promise<Answered | null> {
    return null;
  }
}

/** `prefixes.Prefixes`: no title to change until #232. */
export class Prefixes {
  async sync(): Promise<void> {}
}

// --- `fix.py` (#223) ----------------------------------------------------------------------------

/** `fix.Fixer`: no PR to fix until #223. */
export class Fixer {
  async *candidates(_repo: Repo): AsyncGenerator<[PullRequest, Job | null, string | null]> {}
}

// --- `effort.py` (#228) -------------------------------------------------------------------------

/** `effort.claude_job`: the provider, model and effort a Claude job starts with. */
export function claude_job(config: { claude_provider: string; claude_model: string; claude_effort: string }) {
  return { provider: config.claude_provider, model: config.claude_model, effort: config.claude_effort };
}

/** `effort.Effort` with no `files`, as Python's is in its tests and live checks: what a Claude job
 *  starts on, and no effort read back into its end record. #228 ports the read-back (`T3Files`),
 *  which Python's command line gives it. */
export class Effort {
  readonly config: { claude_provider: string; claude_model: string; claude_effort: string };
  say: ((line: string) => void) | null = null;
  constructor(config: Effort['config']) {
    this.config = config;
  }

  job() {
    return claude_job(this.config);
  }

  used(_repo_name: string, _name: string, _thread_id: string | null, _run_id: string | null): Record<string, unknown> {
    return {};
  }
}

// --- `stops.py` (#225) --------------------------------------------------------------------------

export const BASE = 'base';

/** The repo's base stop while its base fails its checks (issue #98), or null. While there's one, no
 *  build starts in the repo. It's the newest `base` job on the branch, `filed` or not filed yet
 *  (`failed`: its issue couldn't be filed, or still open: cut off while filing), so a red base
 *  holds builds back whether or not GitHub took the issue (review 1, F4). Read from the job log as
 *  Python reads it; nothing files a base stop until #225. */
export function red_base(jobs: { jobs(): Job[] }, repo_name: string, branch: string | null = null): Job | null {
  const found = jobs.jobs().filter((j) => j.kind === BASE && j.repo === repo_name && (branch === null || j.branch === branch));
  const last = found.at(-1);
  if (last && (last.open || last.outcome === 'filed' || last.outcome === 'failed')) return last;
  return null;
}

// --- `limits.py` (#227): a usage-limit stop, read from what the run said ----------------------

export const RESET_UNKNOWN = (5 * 60 + 5) * 60;   // seconds from the stop, when T3 has no reset
export const RESUME_AFTER = 10 * 60;              // seconds after the reset
const WARM_FOR = 55 * 60;                         // seconds: a thread this recently asked is warm
const COLD_FRESH_MIN = 120_000;                   // tokens: a cold thread this big or bigger restarts fresh

/** What Claude Code and T3 say on a limit stop, for when T3's record can't be read. */
export const LIMIT_SAID = /you've hit your (?:\w+ )?limit|claude api rate limit reached/i;

/** `limits.LimitStop`: `reset_at` null when T3 stored none, or couldn't be read. */
export type LimitStop = { readonly reset_at: Date | null };

/** `limits.LastCall`: a thread's last real call to Claude. */
export type LastCall = { readonly started: Date | null; readonly tokens: number | null };

/** `limits.limit_stop` with no `T3Store` (Python's `limits` None: its tests and live checks): the
 *  limit message in what this run said (its error, its last message) decides. #227 ports the store,
 *  where T3's record of the run's failure decides first and names the reset. */
export function limit_stop(said: readonly (string | null)[]): LimitStop | null {
  return said.some((s) => LIMIT_SAID.test(s || '')) ? { reset_at: null } : null;
}

/** When a job cut off by a limit may run again: 10 minutes after the reset, or after 5h05m from
 *  the stop if the reset is unknown. */
export function resume_at(stopped: Date, reset: Date | null): Date {
  return new Date((reset ?? new Date(stopped.getTime() + RESET_UNKNOWN * 1000)).getTime() + RESUME_AFTER * 1000);
}

/** `limits.ResumeChoice`: in place or fresh, and why. */
export type ResumeChoice = { readonly in_place: boolean; readonly why: string };

function _age(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  return m ? `${h} h ${m} min` : `${h} h`;
}

const commas = (n: number) => n.toLocaleString('en-US');

/** `limits.resume_choice`: warm (its last request started under 55 minutes ago) continues at any
 *  size; cold continues below 120k tokens and starts fresh at or above. An unknown age is cold, an
 *  unknown size large. */
export function resume_choice(last_request: Date | null, tokens: number | null, now: Date): ResumeChoice {
  const gap = last_request === null ? null : (now.getTime() - last_request.getTime()) / 1000;
  const idle = gap === null ? null : Math.max(0, Math.floor(gap / 60));
  if (gap !== null && gap < WARM_FOR) {
    return { in_place: true, why: `warm (its last request started ${_age(idle!)} ago): continuing it in place is cheaper at any size` };
  }
  const age = idle === null ? 'when its last request started is unknown' : `its last request started ${_age(idle)} ago`;
  if (tokens === null) return { in_place: false, why: `cold (${age}) and its size unknown: a fresh thread` };
  const small = tokens < COLD_FRESH_MIN;
  const why = small
    ? `cold (${age}) and ${commas(tokens)} tokens, under ${commas(COLD_FRESH_MIN)}: continuing it in place is cheaper`
    : `cold (${age}) and ${commas(tokens)} tokens, at least ${commas(COLD_FRESH_MIN)}: a fresh thread is cheaper`;
  return { in_place: small, why };
}

// --- `toast.py` and `wake.py` (#236) ------------------------------------------------------------

/** `toast.NoToaster`: toasts nothing. */
export class NoToaster {
  toast(_title: string, _text: string, _url: string, _tag = '', _button = 'Open'): void {}
}

/** `wake.NoWaker`: sets no wake task. */
export class NoWaker {
  async sync(_times: readonly Date[]): Promise<void> {}
}
