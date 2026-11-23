// In-memory GitHub and git for tests: no network, no gh, no git. Ported from `tests/fakes.py`'s
// `FakeGitHub`, `FakeGitHubWithPulls` and `FakeGitHubForReviews` (#215), and `tests/fakes_t3.py`'s
// `FakeGit` and `FakeReviewGit` (#216), and `FakeUsage` and `StubEndpoint` (#263), with Python's
// names and answers. Each call is async, as the seams' are (`src/github-seam.ts`,
// `src/git-seam.ts`).
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Clock, HTTPError, OAuthUsage, type Request, Usage, Window } from '../src/claude-usage.ts';
import type { Commit } from '../src/git-seam.ts';
import { Checks, Comment, GhError, Issue, PullRequest, type PullState, type Repo, replace, type WorkflowRun, type WorkIssue } from '../src/github-seam.ts';

export const MAIN_HEAD = '9'.repeat(40);   // the base branch's head, unless a test says otherwise (issue #98)

/** An issue's state, keyed by `[owner/name, number]` (`stateKey`) or by number alone for the
 *  served repo. */
export const stateKey = (github: string, number: number) => `${github}#${number}`;

export type FakeGitHubOptions = {
  issues?: Issue[]; states?: Record<string | number, string>; prs?: PullRequest[]; branches?: string[];
  comments?: Record<number, Comment[]>;
};

export class FakeGitHub {
  issues: Issue[];
  states: Map<string | number, string>;
  prs: PullRequest[];
  branch_names: string[];
  comments: Map<number, Comment[]>;
  /** The dashboard's read of open issues (`work_list`: WorkIssue). */
  work_list: WorkIssue[] = [];
  /** The open issues an issue blocks by GitHub's dependencies: number -> [Issue]. */
  blocks: Map<number, Issue[]> = new Map();
  /** The calls that raise (`FakeGitHubForReviews` takes it; `work_issues` reads it here). */
  fail: Set<string> = new Set();

  constructor({ issues = [], states = {}, prs = [], branches = [], comments = {} }: FakeGitHubOptions = {}) {
    this.issues = [...issues];
    this.states = new Map(Object.entries(states).map(([k, v]) => [/^\d+$/.test(k) ? Number(k) : k, v]));
    for (const i of this.issues) if (!this.states.has(i.number)) this.states.set(i.number, 'open');
    this.prs = [...prs];
    this.branch_names = [...branches];
    this.comments = new Map(Object.entries(comments).map(([k, v]) => [Number(k), v]));
  }

  async ready_issues(_repo: Repo): Promise<Issue[]> {
    return [...this.issues];
  }

  /** States keyed by [owner/name, number] (`stateKey`), or by number alone for the served repo. */
  async issue_state(github: string, number: number): Promise<string> {
    return this.states.get(stateKey(github, number)) ?? this.states.get(number) ?? 'closed';
  }

  async open_pulls(_repo: Repo): Promise<PullRequest[]> {
    return [...this.prs];
  }

  async branches(_repo: Repo, prefix: string): Promise<string[]> {
    return this.branch_names.filter((b) => b.startsWith(prefix));
  }

  async issue_comments(_repo: Repo, number: number): Promise<Comment[]> {
    return [...(this.comments.get(number) ?? [])];
  }

  async open_issues(_repo: Repo): Promise<Issue[]> {
    return [...this.issues];
  }

  /** The dashboard's read of open issues (`work_list`); `work_issues` in `fail` raises. */
  async work_issues(_repo: Repo): Promise<WorkIssue[]> {
    if (this.fail.has('work_issues')) throw new Error('gh failed (HTTP 503)');
    return [...this.work_list];
  }

  /** The open issues this one blocks by GitHub's dependencies: `blocks`, number -> [Issue]. */
  async blocking(_repo: Repo, number: number): Promise<Issue[]> {
    return [...(this.blocks.get(number) ?? [])];
  }
}

export function issue(number: number, title = 'A ticket', body = '', open_blockers = 0, open_sub_issues = 0,
  open_linked_pulls = 0): Issue {
  return new Issue({ number, title, body, open_blockers, open_sub_issues, open_linked_pulls });
}

export function pr(number: number, branch: string, body = ''): PullRequest {
  return new PullRequest({ number, branch, body });
}

/** Also answers which PR a job opened from its branch. */
export class FakeGitHubWithPulls extends FakeGitHub {
  pulls_by_branch: Map<string, PullState>;

  constructor(options: FakeGitHubOptions & { pulls_by_branch?: Record<string, PullState> } = {}) {
    super(options);
    this.pulls_by_branch = new Map(Object.entries(options.pulls_by_branch ?? {}));
  }

  async pull_for_branch(_repo: Repo, branch: string): Promise<PullState | null> {
    return this.pulls_by_branch.get(branch) ?? null;
  }

  /** The PR as listed (`prs`), as the runner reads it after a fix round. */
  async pull(_repo: Repo, number: number): Promise<PullRequest> {
    const p = this.prs.find((x) => x.number === number);
    if (!p) throw new Error(`StopIteration: no PR #${number}`);
    return p;
  }

  async issue(_github: string, number: number): Promise<Issue> {
    const found = this.issues.find((i) => i.number === number);
    if (!found) throw new Error(`StopIteration: no issue #${number}`);
    return found;
  }
}

/** One write the fake took, in order: the call's name, then its arguments. */
export type Post = [string, ...unknown[]];

export type FakeGitHubForReviewsOptions = FakeGitHubOptions & {
  pulls_by_branch?: Record<string, PullState>;
  checks?: Record<string, Checks>; conflicts?: number[]; replies?: Record<number, Comment[]>;
  issue_bodies?: Record<string, Issue>; open_issue_list?: Issue[]; bodies?: Record<number, string>; fail?: string[];
};

/** Also what the Sol lane reads (a PR's checks, conflicts, review replies, its issues and body)
 *  and what it posts: every write goes to `posts`, in order, as [call, args...]. A call named in
 *  `fail` raises. */
export class FakeGitHubForReviews extends FakeGitHubWithPulls {
  open_issue_list: Issue[];
  bodies: Map<number, string>;              // PR number -> its body now
  posts: Post[] = [];
  private _next = 900;
  check_states: Map<string, Checks>;        // sha -> Checks; default passed
  conflicts: Set<number>;
  replies: Map<number, Comment[]>;          // PR number -> [Comment]
  issue_bodies: Map<string, Issue>;         // stateKey(github, number) -> Issue
  now: Map<number, Partial<PullRequest>> = new Map();   // PR number -> its fields now, where they changed
  threads: Map<number, number> = new Map();             // PR number -> unresolved review threads
  push_before_merge: Map<number, string> = new Map();   // PR number -> a head pushed just before the merge call
  workflow_runs: Map<number, WorkflowRun> = new Map();  // Actions run id -> WorkflowRun now (issue #93)
  base_heads: Map<string, string> = new Map();          // branch -> its head now (issue #98); default MAIN_HEAD

  constructor({ checks = {}, conflicts = [], replies = {}, issue_bodies = {}, open_issue_list = [], bodies = {}, fail = [],
    ...rest }: FakeGitHubForReviewsOptions = {}) {
    super(rest);
    this.open_issue_list = [...open_issue_list];
    this.bodies = new Map(Object.entries(bodies).map(([k, v]) => [Number(k), v]));
    this.fail = new Set(fail);
    this.check_states = new Map(Object.entries(checks));
    this.conflicts = new Set(conflicts);
    this.replies = new Map(Object.entries(replies).map(([k, v]) => [Number(k), v]));
    this.issue_bodies = new Map(Object.entries(issue_bodies));
  }

  async checks(_repo: Repo, sha: string): Promise<Checks> {
    return this.check_states.get(sha) ?? new Checks({ state: 'passed' });
  }

  async has_conflict(_repo: Repo, number: number): Promise<boolean> {
    return this.conflicts.has(number);
  }

  async workflow_run(_repo: Repo, run_id: number): Promise<WorkflowRun> {
    const r = this.workflow_runs.get(run_id);
    if (!r) throw new Error(`KeyError: ${run_id}`);
    return r;
  }

  /** Re-runs the run's failed jobs: its next attempt is queued, its checks pending. */
  async rerun_failed(_repo: Repo, run_id: number): Promise<void> {
    this._write('rerun', run_id);
    const r = this.workflow_runs.get(run_id);
    if (!r) throw new Error(`KeyError: ${run_id}`);
    this.workflow_runs.set(run_id, replace(r, { attempt: r.attempt + 1, status: 'queued', conclusion: null }));
  }

  async branch_head(_repo: Repo, branch: string): Promise<string> {
    if (this.fail.has('branch_head')) throw new Error('gh failed');
    return this.base_heads.get(branch) ?? MAIN_HEAD;
  }

  /** GitHub's update-branch: refused (422) once the head moved, or when `update-branch` is in
   *  `fail` (a conflict). */
  async update_branch(repo: Repo, number: number, expected_head: string): Promise<void> {
    if (this.fail.has('update-branch') || (await this.pull(repo, number)).head_sha !== expected_head) {
      throw new GhError('gh api failed (1): merge conflict between base and head (HTTP 422)');
    }
    this.posts.push(['update-branch', number, expected_head]);
  }

  async close_completed(_repo: Repo, number: number): Promise<void> {
    this._write('close-done', number);
    this.close_issue(number);
  }

  async review_replies(_repo: Repo, number: number): Promise<Comment[]> {
    return [...(this.replies.get(number) ?? [])];
  }

  override async issue(github: string, number: number): Promise<Issue> {
    const found = this.issue_bodies.get(stateKey(github, number));
    if (!found) throw new Error(`KeyError: (${github}, ${number})`);
    return found;
  }

  override async open_issues(_repo: Repo): Promise<Issue[]> {
    if (this.fail.has('open_issues')) throw new Error('gh failed');
    return [...this.open_issue_list];
  }

  async pull_body(_repo: Repo, number: number): Promise<string> {
    return this.bodies.get(number) ?? this.prs.find((p) => p.number === number)?.body ?? '';
  }

  private _write(call: string, ...args: unknown[]): void {
    if (this.fail.has(call)) throw new Error(`${call} failed`);
    this.posts.push([call, ...args]);
  }

  async post_comment(repo: Repo, number: number, body: string): Promise<string> {
    this._write('comment', number, body);
    const said = this.comments.get(number) ?? [];
    said.push(new Comment({ author: 'stefan1575', created_at: '2026-11-09T12:00:00Z', body }));
    this.comments.set(number, said);
    this._next += 1;
    return `https://github.com/${repo.github}/pull/${number}#issuecomment-${this._next}`;
  }

  async create_issue(repo: Repo, title: string, body: string, labels: readonly string[] = []): Promise<string> {
    this._write('issue', title, body, [...labels]);
    this._next += 1;
    this.states.set(this._next, 'open');
    this.open_issue_list.push(new Issue({ number: this._next, title, body, url: `https://github.com/${repo.github}/issues/${this._next}` }));
    return `https://github.com/${repo.github}/issues/${this._next}`;
  }

  /** Stefan closes an issue. */
  close_issue(number: number): void {
    this.states.set(number, 'closed');
    this.open_issue_list = this.open_issue_list.filter((i) => i.number !== number);
  }

  async close_not_planned(_repo: Repo, number: number): Promise<void> {
    this._write('close', number);
    this.states.set(number, 'closed');
  }

  async set_status(_repo: Repo, sha: string, state: string, description: string, target_url = '', _context = 'sol-review'): Promise<void> {
    this._write('status', sha, state, description, target_url);
  }

  async edit_pull_body(_repo: Repo, number: number, body: string): Promise<void> {
    this._write('body', number, body);
    this.bodies.set(number, body);
  }

  async add_label(_repo: Repo, number: number, label: string): Promise<void> {
    this._write('label', number, label);
  }

  async remove_label(_repo: Repo, number: number, label: string): Promise<void> {
    this._write('unlabel', number, label);
  }

  // --- merging (ticket 05) ------------------------------------------------------------------

  /** The PR as listed, with what changed since (`now`: number -> fields). */
  async pull(_repo: Repo, number: number): Promise<PullRequest> {
    if (this.fail.has('pull')) throw new Error('gh failed');
    const p = this.prs.find((x) => x.number === number);
    if (!p) throw new Error(`StopIteration: no PR #${number}`);
    return replace(p, this.now.get(number) ?? {});
  }

  async open_threads(_repo: Repo, number: number): Promise<number> {
    return this.threads.get(number) ?? 0;
  }

  /** GitHub's merge with an expected head: a push in `push_before_merge` lands first. */
  async merge(repo: Repo, number: number, sha: string): Promise<string> {
    const pushed = this.push_before_merge.get(number);
    if (pushed !== undefined) {
      this.push_before_merge.delete(number);
      this.now.set(number, { ...this.now.get(number), head_sha: pushed });
    }
    if ((await this.pull(repo, number)).head_sha !== sha) {
      throw new GhError('gh api failed (1): Head branch was modified. Review and try the merge again. (HTTP 409)');
    }
    this._write('merge', number, sha);
    this.now.set(number, { ...this.now.get(number), state: 'merged' });
    return 'f'.repeat(40);
  }

  /** The listed PRs as they are now, merged ones left out. */
  override async open_pulls(repo: Repo): Promise<PullRequest[]> {
    const open = this.prs.filter((p) => (this.now.get(p.number)?.state ?? 'open') === 'open');
    return Promise.all(open.map((p) => this.pull(repo, p.number)));
  }
}

export function full_pr(number: number, branch: string, head_sha: string, body = '', title = 'A PR', base = 'main',
  labels: readonly string[] = []): PullRequest {
  return new PullRequest({ number, branch, body, title, head_sha, base, url: `https://github.com/owner/first/pull/${number}`,
    labels: [...labels] });
}

// --- git (`tests/fakes_t3.py`) ------------------------------------------------------------------

/** A key for a pair, where Python keys a dict or set by the tuple `(a, b)`: `log(a, b)`'s
 *  `commit_log` entry (`commits` keys it by the branch) and `ancestors`' (older, newer). */
export const logKey = (a: string, b: string) => `${a}..${b}`;

export type FakeGitOptions = { branches?: Iterable<string>; commits?: Record<string, Commit[]> };

export class FakeGit {
  local_branches: Set<string>;
  commit_log: Map<string, Commit[]>;
  fetches: unknown[][] = [];
  tips: Map<string, string> | Error = new Map();   // branch -> its tip, for free_branch (an exception: it fails)
  uncommitted: Map<string, string> = new Map();    // branch -> the commit keeping what its worktree left
  freed: [string, string | null][] = [];           // (branch, worktree) freed after a usage limit
  refs: Map<string, string> = new Map();           // ref -> its sha (`sha`; a ref not named: null)

  constructor({ branches = [], commits = {} }: FakeGitOptions = {}) {
    this.local_branches = new Set(branches);
    this.commit_log = new Map(Object.entries(commits));
  }

  async fetch(path: string, branch: string): Promise<void> {
    this.fetches.push([path, branch]);
  }

  async has_branch(_path: string, branch: string): Promise<boolean> {
    return this.local_branches.has(branch);
  }

  async sha(_path: string, ref: string): Promise<string | null> {
    return this.refs.get(ref) ?? null;
  }

  async commits(_path: string, _base: string, branch: string): Promise<Commit[]> {
    return [...(this.commit_log.get(branch) ?? [])];
  }

  /** A fix round's PR head fetched: [ref, sha] (the sha `refs` names, else ''). */
  async fetch_pr(path: string, number: number, base: string): Promise<[string, string]> {
    this.fetches.push([path, `pr${number}`, base]);
    const ref = `refs/queue-runner/pr${number}`;
    return [ref, this.refs.get(ref) ?? ''];
  }

  /** The commits in `b` not in `a`: `commits` keyed `a..b` (`logKey`). */
  async log(_path: string, a: string, b: string): Promise<Commit[]> {
    return [...(this.commit_log.get(logKey(a, b)) ?? [])];
  }

  async free_branch(_path: string, branch: string, worktree: string | null): Promise<[string | null, string | null]> {
    this.freed.push([branch, worktree]);
    this.local_branches.delete(branch);
    if (this.tips instanceof Error) throw this.tips;
    return [this.tips.get(branch) ?? null, this.uncommitted.get(branch) ?? null];
  }
}

export type FakeReviewGitOptions = FakeGitOptions & {
  heads?: Record<number, string>; files?: Record<string, string>; ancestors?: Iterable<readonly [string, string]>;
};

/** FakeGit plus a review's checkout: `heads` is what fetching each PR finds (default: the
 *  sha the test says), `files` what the checkout holds, `ancestors` the (older, newer) pairs
 *  in history. */
export class FakeReviewGit extends FakeGit {
  heads: Map<number, string>;
  files: Map<string, string>;
  ancestors: Set<string>;                          // logKey(older, newer)
  checkouts: [string, string, string][] = [];
  removed: [string, string | null][] = [];
  removed_worktrees: [string, string | null][] = [];
  stuck: Set<string> = new Set();                  // worktrees git can't remove
  moved_aside: Map<string, string> = new Map();    // a review checkout git can't delete: where it's moved
  stale: string[] = [];                            // what sweep_stale can't delete
  shots: Map<number, Record<string, Uint8Array> | Error> = new Map();   // PR number -> {name: bytes} on its evidence branch, or what reading it raises

  constructor({ heads = {}, files = {}, ancestors = [], ...rest }: FakeReviewGitOptions = {}) {
    super(rest);
    this.heads = new Map(Object.entries(heads).map(([k, v]) => [Number(k), v]));
    this.files = new Map(Object.entries(files));
    this.ancestors = new Set(Array.from(ancestors, ([older, newer]) => logKey(older, newer)));
  }

  async sweep_stale(_checkouts_dir: string): Promise<string[]> {
    return [...this.stale];
  }

  async evidence(_path: string, number: number, dest: string): Promise<string[]> {
    const shots = this.shots.get(number) ?? {};
    if (shots instanceof Error) throw shots;   // origin unreadable
    for (const [name, data] of Object.entries(shots)) {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, name), data);
    }
    return Object.keys(shots).sort();
  }

  async fetch_pr(path: string, number: number, base: string): Promise<[string, string]> {
    this.fetches.push([path, `pr${number}`, base]);
    const head = this.heads.get(number);
    if (head === undefined) throw new Error(`KeyError: ${number}`);
    return [`refs/queue-runner/pr${number}`, head];
  }

  async checkout(path: string, ref: string, worktree: string): Promise<null> {
    await mkdir(worktree, { recursive: true });
    for (const [name, text] of this.files) await writeFile(join(worktree, name), text, 'utf8');
    this.checkouts.push([path, ref, worktree]);
    return null;
  }

  async remove_checkout(_path: string, worktree: string, ref: string | null = null): Promise<string | null> {
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
    this.removed.push([worktree, ref]);
    return this.moved_aside.get(worktree) ?? null;
  }

  async is_ancestor(_path: string, older: string, newer: string): Promise<boolean> {
    return this.ancestors.has(logKey(older, newer));
  }

  async diff(_path: string, a: string, b: string, merge_base = false): Promise<string> {
    return `diff ${a}${merge_base ? '...' : '..'}${b}\n`;
  }

  async log(_path: string, a: string, b: string): Promise<Commit[]> {
    return [...(this.commit_log.get(logKey(a, b)) ?? [])];
  }

  async diffstat(_path: string, a: string, b: string): Promise<string> {
    return ` src/a.ts | 2 +-\n 1 file changed (${a}...${b})\n`;
  }

  async remove_worktree(_path: string, worktree: string, branch: string | null = null): Promise<boolean> {
    this.removed_worktrees.push([worktree, branch]);
    return !this.stuck.has(worktree);
  }
}

/** Plays Claude's usage endpoint: each read gives the next of `reads` (the last one again once
 *  they run out); an error in it is thrown. Tests never read the real one. It never answers 429,
 *  so it may be asked at any pace: `call_every` 0 leaves `CachedUsage`'s budget out of the tests
 *  that use it (the budget's own tests give their endpoint one). */
export class FakeUsage {
  readonly call_every = 0;
  readonly reads: (Usage | Error)[];
  count = 0;

  constructor(...reads: (Usage | Error)[]) {
    const far = new Date(Date.UTC(2099, 0, 1));
    this.reads = reads.length ? reads : [new Usage(new Window(0, null), new Window(0, far))];
  }

  read(): Usage {
    const got = this.reads[Math.min(this.count, this.reads.length - 1)]!;
    this.count += 1;
    if (got instanceof Error) throw got;
    return got;
  }
}

/** Plays `api/oauth/usage` behind a real `OAuthUsage` (its `fetch`), on a test's clock: it answers
 *  a response shaped like the real one, or HTTP 429 when it's asked within `limit` seconds of its
 *  last call, as the real one does (issue 66). `fail` makes every call answer that status.
 *  `calls` is every call, as [time, status]. Nothing calls Anthropic. */
export class StubEndpoint {
  fail: number | null = null;
  readonly calls: [Date, number][] = [];
  readonly resets: [Date | null, Date | null];   // the windows' resets_at

  readonly clock: Clock;
  five: number;
  week: number;
  limit: number;

  constructor(clock: Clock, five = 38, week = 46, limit = 60, resets: [Date | null, Date | null] | null = null) {
    [this.clock, this.five, this.week, this.limit] = [clock, five, week, limit];
    this.resets = resets ?? [null, null];
  }

  readonly fetch = async (request: Request): Promise<string> => {
    const now = this.clock();
    const last = this.calls[this.calls.length - 1];
    const status = this.fail || (last && (now.getTime() - last[0].getTime()) / 1000 < this.limit ? 429 : 200);
    this.calls.push([now, status]);
    if (status !== 200) throw new HTTPError(request.full_url, status, 'stub');
    const [five, week] = this.resets.map((r) => (r ? r.toISOString() : null));
    return JSON.stringify({ five_hour: { utilization: this.five, resets_at: five }, seven_day: { utilization: this.week, resets_at: week } });
  };

  /** A real `OAuthUsage` on this stub, with a fake login written in `config_dir`. */
  oauth(config_dir: string): OAuthUsage {
    writeFileSync(join(config_dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fake' } }), 'utf8');
    return new OAuthUsage(config_dir, this.fetch, this.clock);
  }
}
