// What the run loop (`src/run.ts`) calls in Python modules that later port tickets bring over, each
// standing in with Python's names until its ticket ports it and replaces it here. Each answers as
// its Python part does when there is nothing for it: no decision, ask, answer or fix round to
// start, no title to change, no stop in `control.json`, no wake task, no toast, no effort read
// back. None reads a file, T3 or GitHub. A method only a later part reaches throws, naming the
// ticket that ports it: nothing here can call it until that ticket does.
import type { Repo } from './config.ts';
import type { PullRequest } from './github-seam.ts';
import type { Job } from './state.ts';

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

/** A case the flow doesn't cover, for a decision thread (`decisions.Case`). */
export type Case = { readonly repo: Repo; readonly number: number; readonly about: Job; readonly allowed: readonly string[] };

/** How a decision picks up the earlier job (`Runner.continue_job`). */
export type ContinueJob = (old: Job, message: string, options?: { limit?: boolean; marks?: Record<string, unknown> | null }) => Promise<string>;

/** `decisions.Decider`: no case to decide until #226. */
export class Decider {
  async next_case(_options: { repos?: readonly string[] | null } = {}): Promise<Case | null> {
    return null;
  }

  direct_answer(_case: Case): unknown {
    throw new NotPorted('Decider.direct_answer', '#226');
  }

  async run(_case: Case, _continue_thread: ContinueJob): Promise<string> {
    throw new NotPorted('Decider.run', '#226');
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

// --- `toast.py` and `wake.py` (#236) ------------------------------------------------------------

/** `toast.NoToaster`: toasts nothing. */
export class NoToaster {
  toast(_title: string, _text: string, _url: string, _tag = '', _button = 'Open'): void {}
}

/** `wake.NoWaker`: sets no wake task. */
export class NoWaker {
  async sync(_times: readonly Date[]): Promise<void> {}
}
