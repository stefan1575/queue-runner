// In-memory GitHub for tests: no network, no gh. Ported from `tests/fakes.py`'s `FakeGitHub`,
// `FakeGitHubWithPulls` and `FakeGitHubForReviews` (#215), with Python's names and answers. Each
// call is async, as the seam's are (`src/github-seam.ts`).
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
  async rerun_failed(repo: Repo, run_id: number): Promise<void> {
    this._write('rerun', run_id);
    const r = await this.workflow_run(repo, run_id);
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
