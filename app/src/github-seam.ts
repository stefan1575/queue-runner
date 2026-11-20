// GitHub as the runner sees it: the seam, its data, and the gh adapter. Ported from
// `queue_runner/github.py` (#215): the same calls, the same answers, the same names (snake_case,
// as Python has them), with `tests/test_github.py` ported case for case in
// `test/github-seam.test.ts`.
//
// Two differences are TypeScript's only. `run_gh` and every call are async: Node runs a child
// process without blocking, where Python's lanes block on their own threads. And a Python
// dataclass is a frozen class here, built from its fields by name, with the same defaults.
//
// A field Python reads as `x['key']` is `need(x, 'key')`: missing, it's an error, as Python's
// `KeyError`. A field it reads as `x.get('key')` is `get(x, 'key')`: missing, it's the default.
import { execFile } from 'node:child_process';

/** A repo as the seam needs it: its `owner/name` on GitHub (Python's `config.Repo`). */
export type Repo = { readonly github: string };

type Json = any;

/** `x[key]`: a field that must be there. Missing, or `x` not an object, is an error. */
function need(x: Json, key: string): Json {
  if (x === null || typeof x !== 'object') throw new TypeError(`'${x === null ? 'NoneType' : typeof x}' object is not subscriptable`);
  if (!(key in x)) throw new Error(`KeyError: '${key}'`);
  return x[key];
}

/** `x.get(key, dflt)`: the field, or `dflt` when it's missing (a field set to null stays null). */
function get(x: Json, key: string, dflt: Json = null): Json {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new TypeError(`no .get on ${JSON.stringify(x)}`);
  return key in x ? x[key] : dflt;
}

/** Python's truthiness, for `a or b`: null, false, 0, '' and an empty list or object are false. */
function truthy(x: Json): boolean {
  if (Array.isArray(x)) return x.length > 0;
  if (x !== null && typeof x === 'object') return Object.keys(x).length > 0;
  return Boolean(x);
}

/** `a or b`. */
const or = (a: Json, b: Json): Json => (truthy(a) ? a : b);

/** Python's `iter`: a list's items, a string's characters, an object's keys. */
function items(x: Json): Json[] {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') return [...x];
  if (x !== null && typeof x === 'object') return Object.keys(x);
  throw new TypeError(`'${x === null ? 'NoneType' : typeof x}' object is not iterable`);
}

/** `urllib.parse.quote(s, safe)`: every UTF-8 byte but letters, digits, `_.-~` and `safe` as `%XX`. */
export function quote(s: string, safe = '/'): string {
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9_.\-~]/.test(ch) || safe.includes(ch)) out += ch;
    else for (const b of Buffer.from(ch, 'utf8')) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The first `n` characters (code points, as Python counts them). */
const head = (s: string, n: number) => Array.from(s).slice(0, n).join('');

type Fields<T> = { -readonly [K in keyof T as T[K] extends Function ? never : K]: T[K] };

export class Issue {
  readonly number!: number;
  readonly title!: string;
  readonly body!: string;
  readonly open_blockers: number = 0;      // GitHub's native dependencies still open
  readonly open_sub_issues: number = 0;    // a spec or map: its children are the work
  readonly open_linked_pulls: number = 0;  // open PRs GitHub links to it (closing keyword or linked by hand)
  readonly url: string = '';
  constructor(fields: Pick<Fields<Issue>, 'number' | 'title' | 'body'> & Partial<Fields<Issue>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/** An issue as the dashboard's work lists read it (ticket 32): its labels, the issue it's a
 *  sub-issue of, its own sub-issues (open and closed) and GitHub's native blockers, each as
 *  [owner/name, number, open or closed]. */
export class WorkIssue {
  readonly number!: number;
  readonly title!: string;
  readonly body: string = '';
  readonly url: string = '';
  readonly state: string = 'open';
  readonly labels: readonly string[] = [];
  readonly parent: number | null = null;
  readonly sub_issues: readonly WorkIssue[] = [];   // with number, title, url, state and `repo`
  readonly blocked_by: readonly (readonly [string, number, string])[] = [];
  readonly repo: string = '';                       // owner/name: a sub-issue may be in another repo
  constructor(fields: Pick<Fields<WorkIssue>, 'number' | 'title'> & Partial<Fields<WorkIssue>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

export class PullRequest {
  readonly number!: number;
  readonly branch!: string;
  readonly body!: string;
  readonly title: string = '';
  readonly head_sha: string = '';     // H: the commit a review reviews
  readonly base: string = '';         // the branch it merges into (not always main: PRs stack)
  readonly url: string = '';
  readonly labels: readonly string[] = [];
  readonly draft: boolean = false;
  readonly state: string = 'open';             // `pull` only: open, closed or merged
  readonly mergeable: boolean | null = null;   // `pull` only: null while GitHub is still working it out
  constructor(fields: Pick<Fields<PullRequest>, 'number' | 'branch' | 'body'> & Partial<Fields<PullRequest>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

export class Comment {
  readonly author!: string;
  readonly created_at!: string;
  readonly body!: string;
  readonly path: string | null = null;   // a review thread's file and line
  readonly line: number | null = null;
  constructor(fields: Pick<Fields<Comment>, 'author' | 'created_at' | 'body'> & Partial<Fields<Comment>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/** A commit's checks, the `sol-review` status left out: passed, failed, pending, or none
 *  (nothing reported yet). */
export class Checks {
  readonly state!: string;
  readonly failed: readonly string[] = [];
  readonly pending: readonly string[] = [];
  // The GitHub Actions runs behind the failed checks, when every failed check is an Actions
  // check run, so re-running them may settle it (issue #93). A failed commit status, or a
  // check run from another app, can't be re-run: then none.
  readonly runs: readonly number[] = [];
  // Each of those runs with the failed checks it holds, `[run id, [names...]]`, so a re-run
  // and its stop name only their own run's checks (PR #105's F5).
  readonly by_run: readonly (readonly [number, readonly string[]])[] = [];
  constructor(fields: Pick<Fields<Checks>, 'state'> & Partial<Fields<Checks>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  /** The failed checks in Actions run `run_id` (all of them if not known per run). */
  failed_in(run_id: number): readonly string[] {
    const found = this.by_run.find(([r]) => r === run_id);
    return found ? found[1] : !this.by_run.length ? this.failed : [];
  }
}

/** A GitHub Actions run as it is now: its latest attempt, and that attempt's status
 *  (queued, in_progress, completed...) and conclusion. */
export class WorkflowRun {
  readonly id!: number;
  readonly attempt!: number;
  readonly status!: string;
  readonly conclusion!: string | null;
  readonly url!: string;
  constructor(fields: Fields<WorkflowRun>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/** `dataclasses.replace`: a copy with these fields changed. */
export function replace<T extends object>(x: T, changes: Partial<Fields<T>>): T {
  const Made = x.constructor as new (fields: object) => T;
  return new Made({ ...x, ...changes });
}

/** A PR as `pull_for_branch` has it: open, closed or merged. */
export type PullState = { number: number; url: string; state: string };

// The runner's own status on a reviewed commit: never counted as one of its checks.
export const SOL_REVIEW = 'sol-review';
const _PASSED = new Set(['success', 'neutral', 'skipped']);
const _ACTIONS_RUN = /\/actions\/runs\/(\d+)/;

/** The Actions run a check run belongs to, or null for another app's check run. */
function _actions_run(check_run: Json): number | null {
  if (get(or(get(check_run, 'app'), {}), 'slug') !== 'github-actions') return null;
  const m = _ACTIONS_RUN.exec(or(or(get(check_run, 'details_url'), get(check_run, 'html_url')), ''));
  return m ? Number(m[1]) : null;
}

export class GhError extends Error {}

function _pull(p: Json): PullRequest {
  const h = need(p, 'head');
  return new PullRequest({
    number: need(p, 'number'), branch: need(h, 'ref'), body: or(get(p, 'body'), ''),
    title: or(get(p, 'title'), ''), head_sha: or(get(h, 'sha'), ''),
    base: or(get(or(get(p, 'base'), {}), 'ref'), ''),
    url: or(get(p, 'html_url'), ''),
    labels: items(or(get(p, 'labels'), [])).map((lb) => need(lb, 'name')),
    draft: truthy(get(p, 'draft')),
    state: truthy(get(p, 'merged_at')) ? 'merged' : or(get(p, 'state'), 'open'),
    mergeable: get(p, 'mergeable'),
  });
}

/** gh's arguments in, its stdout out; `input` goes to its stdin. */
export type Run = (args: string[], input?: string) => Promise<string>;

/** Runs `gh` with no console window (the runner lives in the tray). `input` goes to its stdin: a
 *  write's JSON body (`--input -`), which keeps a long comment off the command line. A gh that
 *  can't start, or runs past the timeout, rejects with Node's own error, as Python's raises its
 *  own; a gh that exits non-zero is a GhError. */
export const run_gh: Run = (args, input) => new Promise((resolve, reject) => {
  const child = execFile('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: Infinity, windowsHide: true },
    (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (typeof error.code === 'number') return reject(new GhError(`gh ${args.join(' ')} failed (${error.code}): ${stderr.trim()}`));
      reject(error);
    });
  child.stdin?.on('error', () => {}); // a gh that never started: its error is the exit's
  child.stdin?.end(input ?? '');
});

const _LINKED_PULLS = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $endCursor, states: OPEN, labels: ["ready-for-agent"]) {
      pageInfo { hasNextPage endCursor }
      nodes { number closedByPullRequestsReferences(first: 20, includeClosedPrs: false) {
        nodes { state } } }
    }
  }
}`;

const _WORK_ISSUES = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $endCursor, states: OPEN) {
      pageInfo { hasNextPage endCursor }
      nodes { number title body url labels(first: 20) { nodes { name } } parent { number }
        subIssues(first: 50) { nodes { number title url state repository { nameWithOwner } } }
        blockedBy(first: 20) { nodes { number state repository { nameWithOwner } } } }
    }
  }
}`;

const _THREADS = `
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}`;

/** `owner/name` split in two, as Python's `owner, name = repo.github.split('/')`. */
function owner_name(github: string): [string, string] {
  const parts = github.split('/');
  if (parts.length !== 2) throw new Error(`ValueError: ${github} is not owner/name`);
  return [parts[0]!, parts[1]!];
}

/** `s.lower()` on a field that must be a string. */
const lower = (s: Json): string => {
  if (typeof s !== 'string') throw new TypeError(`'${typeof s}' object has no attribute 'lower'`);
  return s.toLowerCase();
};

/** GitHub through `gh api` (REST). `run` takes gh's arguments and returns its stdout. */
export class GhCli {
  private _run: Run;
  constructor(run: Run = run_gh) {
    this._run = run;
  }

  private async _get(endpoint: string): Promise<Json> {
    return JSON.parse(await this._run(['api', endpoint]));
  }

  private async _all(endpoint: string): Promise<Json[]> {
    const pages = JSON.parse(await this._run(['api', '--paginate', '--slurp', endpoint]));
    return items(pages).flatMap((page) => items(page));
  }

  /** Open PRs GitHub links to each ready issue: by closing keyword, or by hand in the
   *  Development sidebar. REST doesn't expose the links; GraphQL does. */
  private async _linked_open_pulls(repo: Repo): Promise<Map<number, number>> {
    const [owner, name] = owner_name(repo.github);
    const pages = JSON.parse(await this._run(['api', 'graphql', '--paginate', '--slurp',
      '-f', `query=${_LINKED_PULLS}`, '-f', `owner=${owner}`, '-f', `name=${name}`]));
    const counts = new Map<number, number>();
    for (const page of items(pages)) {
      for (const node of items(need(need(need(need(page, 'data'), 'repository'), 'issues'), 'nodes'))) {
        const refs = need(node, 'closedByPullRequestsReferences');
        counts.set(need(node, 'number'), items(need(refs, 'nodes')).filter((p) => need(p, 'state') === 'OPEN').length);
      }
    }
    return counts;
  }

  async ready_issues(repo: Repo): Promise<Issue[]> {
    const linked = await this._linked_open_pulls(repo);
    const found: Issue[] = [];
    for (const i of await this._all(`repos/${repo.github}/issues?state=open&labels=ready-for-agent&per_page=100`)) {
      if ('pull_request' in i) continue;
      const deps = or(get(i, 'issue_dependencies_summary'), {});
      const subs = or(get(i, 'sub_issues_summary'), {});
      found.push(new Issue({
        number: need(i, 'number'), title: need(i, 'title'), body: or(get(i, 'body'), ''),
        open_blockers: get(deps, 'blocked_by', 0),
        open_sub_issues: get(subs, 'total', 0) - get(subs, 'completed', 0),
        open_linked_pulls: linked.get(need(i, 'number')) ?? 0,
      }));
    }
    return found;
  }

  /** Every open issue (not PR) with its labels, parent, sub-issues and native blockers: one
   *  paged GraphQL query (the dashboard's work lists, ticket 32). */
  async work_issues(repo: Repo): Promise<WorkIssue[]> {
    const [owner, name] = owner_name(repo.github);
    const pages = JSON.parse(await this._run(['api', 'graphql', '--paginate', '--slurp',
      '-f', `query=${_WORK_ISSUES}`, '-f', `owner=${owner}`, '-f', `name=${name}`]));
    const here = repo.github;
    const found: WorkIssue[] = [];
    for (const page of items(pages)) {
      for (const i of items(need(need(need(need(page, 'data'), 'repository'), 'issues'), 'nodes'))) {
        const subs = items(or(get(or(get(i, 'subIssues'), {}), 'nodes'), [])).map((s) => new WorkIssue({
          number: need(s, 'number'), title: need(s, 'title'), url: or(get(s, 'url'), ''),
          state: lower(need(s, 'state')),
          repo: get(or(get(s, 'repository'), {}), 'nameWithOwner', here),
        }));
        const blocked = items(or(get(or(get(i, 'blockedBy'), {}), 'nodes'), [])).map((b): [string, number, string] => [
          get(or(get(b, 'repository'), {}), 'nameWithOwner', here), need(b, 'number'), lower(need(b, 'state'))]);
        found.push(new WorkIssue({
          number: need(i, 'number'), title: need(i, 'title'), body: or(get(i, 'body'), ''),
          url: or(get(i, 'url'), ''),
          labels: items(or(get(or(get(i, 'labels'), {}), 'nodes'), [])).map((x) => need(x, 'name')),
          parent: get(or(get(i, 'parent'), {}), 'number'), sub_issues: subs,
          blocked_by: blocked, repo: here,
        }));
      }
    }
    return found;
  }

  /** 'open' or 'closed', for an issue in any repo (`owner/name`). */
  async issue_state(github: string, number: number): Promise<string> {
    return need(await this._get(`repos/${github}/issues/${number}`), 'state');
  }

  async open_pulls(repo: Repo): Promise<PullRequest[]> {
    return (await this._all(`repos/${repo.github}/pulls?state=open&per_page=100`)).map(_pull);
  }

  /** One PR as GitHub has it now, with its state and whether it can merge. */
  async pull(repo: Repo, number: number): Promise<PullRequest> {
    return _pull(await this._get(`repos/${repo.github}/pulls/${number}`));
  }

  /** The PR's review threads nobody has resolved (outdated ones count: still unanswered). */
  async open_threads(repo: Repo, number: number): Promise<number> {
    const [owner, name] = owner_name(repo.github);
    const pages = JSON.parse(await this._run(['api', 'graphql', '--paginate', '--slurp',
      '-f', `query=${_THREADS}`, '-f', `owner=${owner}`,
      '-f', `name=${name}`, '-F', `number=${number}`]));
    let open = 0;
    for (const page of items(pages)) {
      for (const t of items(need(need(need(need(need(page, 'data'), 'repository'), 'pullRequest'), 'reviewThreads'), 'nodes'))) {
        if (!truthy(need(t, 'isResolved'))) open += 1;
      }
    }
    return open;
  }

  /** Check runs and commit statuses on `sha`, leaving out `sol-review`. */
  async checks(repo: Repo, sha: string): Promise<Checks> {
    const runs = await this._get(`repos/${repo.github}/commits/${sha}/check-runs?per_page=100`);
    const status = await this._get(`repos/${repo.github}/commits/${sha}/status`);
    const seen: [string, string, number | null][] = items(or(get(runs, 'check_runs'), []))
      .map((r) => [need(r, 'name'), need(r, 'status') === 'completed' ? need(r, 'conclusion') : 'pending', _actions_run(r)]);
    for (const s of items(or(get(status, 'statuses'), []))) {
      if (need(s, 'context') !== SOL_REVIEW) seen.push([need(s, 'context'), need(s, 'state'), null]);
    }
    const bad = seen.filter(([, s]) => !_PASSED.has(s) && s !== 'pending').map(([n, , run]) => [n, run] as const);
    const failed = bad.map(([n]) => n);
    const pending = seen.filter(([, s]) => s === 'pending').map(([n]) => n);
    const state = !seen.length ? 'none' : failed.length ? 'failed' : pending.length ? 'pending' : 'passed';
    let reruns: number[];
    let by_run: [number, string[]][];
    if (bad.some(([, run]) => run === null)) {
      [reruns, by_run] = [[], []];
    } else {
      reruns = [...new Set(bad.map(([, run]) => run as number))];
      by_run = reruns.map((r) => [r, bad.filter(([, run]) => run === r).map(([n]) => n)]);
    }
    return new Checks({ state, failed, pending, runs: reruns, by_run });
  }

  /** An Actions run's latest attempt and where it stands (issue #93). */
  async workflow_run(repo: Repo, run_id: number): Promise<WorkflowRun> {
    const r = await this._get(`repos/${repo.github}/actions/runs/${run_id}`);
    return new WorkflowRun({ id: need(r, 'id'), attempt: or(get(r, 'run_attempt'), 1), status: or(get(r, 'status'), ''),
      conclusion: get(r, 'conclusion'), url: or(get(r, 'html_url'), '') });
  }

  /** Re-runs an Actions run's failed jobs (as `gh run rerun <id> --failed`), a new attempt of the
   *  same run on the same commit. */
  async rerun_failed(repo: Repo, run_id: number): Promise<void> {
    await this._run(['api', '-X', 'POST', `repos/${repo.github}/actions/runs/${run_id}/rerun-failed-jobs`]);
  }

  /** The commit a branch of the repo points at now (the base's head: issue #98). */
  async branch_head(repo: Repo, branch: string): Promise<string> {
    return need(need(await this._get(`repos/${repo.github}/branches/${quote(branch, '')}`), 'commit'), 'sha');
  }

  /** True once GitHub says the PR can't merge cleanly; unknown (still computing) is false. */
  async has_conflict(repo: Repo, number: number): Promise<boolean> {
    return get(await this._get(`repos/${repo.github}/pulls/${number}`), 'mergeable') === false;
  }

  /** A PR's review-thread comments and non-empty review bodies (its other comments are
   *  `issue_comments`). */
  async review_replies(repo: Repo, number: number): Promise<Comment[]> {
    const said = (await this._all(`repos/${repo.github}/pulls/${number}/comments?per_page=100`)).map((c) => new Comment({
      author: get(or(get(c, 'user'), {}), 'login', 'ghost'),
      created_at: need(c, 'created_at'), body: or(get(c, 'body'), ''), path: get(c, 'path'),
      line: or(get(c, 'line'), get(c, 'original_line')),
    }));
    for (const r of await this._all(`repos/${repo.github}/pulls/${number}/reviews?per_page=100`)) {
      if (!(truthy(get(r, 'body')) && truthy(get(r, 'submitted_at')))) continue;
      said.push(new Comment({ author: get(or(get(r, 'user'), {}), 'login', 'ghost'),
        created_at: need(r, 'submitted_at'), body: need(r, 'body') }));
    }
    return said;
  }

  /** An issue's title and body, in any repo (`owner/name`). */
  async issue(github: string, number: number): Promise<Issue> {
    const i = await this._get(`repos/${github}/issues/${number}`);
    return new Issue({ number: need(i, 'number'), title: need(i, 'title'), body: or(get(i, 'body'), '') });
  }

  /** The open issues this one blocks, by GitHub's native dependencies (what an ask holds up:
   *  `inbox.py`). */
  async blocking(repo: Repo, number: number): Promise<Issue[]> {
    return (await this._all(`repos/${repo.github}/issues/${number}/dependencies/blocking?per_page=100`))
      .filter((i) => get(i, 'state') === 'open')
      .map((i) => new Issue({ number: need(i, 'number'), title: need(i, 'title'), body: or(get(i, 'body'), ''),
        url: or(get(i, 'html_url'), '') }));
  }

  async branches(repo: Repo, prefix: string): Promise<string[]> {
    const refs = await this._all(`repos/${repo.github}/git/matching-refs/heads/${prefix}`);
    return refs.map((r) => {
      const ref: string = need(r, 'ref');
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    });
  }

  /** The newest PR opened from `branch`, open or not: {number, url, state}, where state is open,
   *  closed or merged. */
  async pull_for_branch(repo: Repo, branch: string): Promise<PullState | null> {
    const owner = repo.github.split('/')[0];
    const pulls = await this._all(`repos/${repo.github}/pulls?head=${owner}:${branch}&state=all&per_page=100`);
    if (!pulls.length) return null;
    const p = pulls.reduce((a, b) => (need(b, 'number') > need(a, 'number') ? b : a));
    return { number: need(p, 'number'), url: need(p, 'html_url'),
      state: truthy(get(p, 'merged_at')) ? 'merged' : need(p, 'state') };
  }

  async issue_comments(repo: Repo, number: number): Promise<Comment[]> {
    return (await this._all(`repos/${repo.github}/issues/${number}/comments?per_page=100`)).map((c) => new Comment({
      author: get(or(get(c, 'user'), {}), 'login', 'ghost'),
      created_at: need(c, 'created_at'), body: or(get(c, 'body'), ''),
    }));
  }

  // --- writes: the review's automated posts (no go-ahead needed, docs/flow.md) --------

  private async _send(method: string, endpoint: string, data: Record<string, unknown>): Promise<Json> {
    const out = await this._run(['api', '-X', method, endpoint, '--input', '-'], JSON.stringify(data));
    return out.trim() ? JSON.parse(out) : {};
  }

  /** Every open issue (not PR), with its body and URL: where a follow-up may be filed already. */
  async open_issues(repo: Repo): Promise<Issue[]> {
    return (await this._all(`repos/${repo.github}/issues?state=open&per_page=100`))
      .filter((i) => !('pull_request' in i))
      .map((i) => new Issue({ number: need(i, 'number'), title: need(i, 'title'), body: or(get(i, 'body'), ''),
        url: or(get(i, 'html_url'), '') }));
  }

  /** Comments on an issue or PR; returns the comment's URL. */
  async post_comment(repo: Repo, number: number, body: string): Promise<string> {
    return need(await this._send('POST', `repos/${repo.github}/issues/${number}/comments`, { body }), 'html_url');
  }

  /** Files an issue; returns its URL. */
  async create_issue(repo: Repo, title: string, body: string, labels: readonly string[] = []): Promise<string> {
    return need(await this._send('POST', `repos/${repo.github}/issues`, { title, body, labels: [...labels] }), 'html_url');
  }

  /** Closes an issue as not planned (a decision found it isn't needed). */
  async close_not_planned(repo: Repo, number: number): Promise<void> {
    await this._send('PATCH', `repos/${repo.github}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' });
  }

  /** Closes an issue as done (the base stop, once the base passes: issue #98). */
  async close_completed(repo: Repo, number: number): Promise<void> {
    await this._send('PATCH', `repos/${repo.github}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
  }

  /** GitHub's update-branch (as `gh pr update-branch <n>`): merges the PR's base into its head,
   *  only while the head is still `expected_head`. GitHub refuses a conflict (422). */
  async update_branch(repo: Repo, number: number, expected_head: string): Promise<void> {
    await this._send('PUT', `repos/${repo.github}/pulls/${number}/update-branch`, { expected_head_sha: expected_head });
  }

  /** A commit status on exactly `sha`. */
  async set_status(repo: Repo, sha: string, state: string, description: string, target_url = '', context = SOL_REVIEW): Promise<void> {
    await this._send('POST', `repos/${repo.github}/statuses/${sha}`,
      { state, context, description: head(description, 140), ...(target_url ? { target_url } : {}) });
  }

  async pull_body(repo: Repo, number: number): Promise<string> {
    return or(get(await this._get(`repos/${repo.github}/pulls/${number}`), 'body'), '');
  }

  async edit_pull_body(repo: Repo, number: number, body: string): Promise<void> {
    await this._send('PATCH', `repos/${repo.github}/pulls/${number}`, { body });
  }

  /** Adds a label to an issue or PR (GitHub makes the label if the repo has none). */
  async add_label(repo: Repo, number: number, label: string): Promise<void> {
    await this._send('POST', `repos/${repo.github}/issues/${number}/labels`, { labels: [label] });
  }

  async remove_label(repo: Repo, number: number, label: string): Promise<void> {
    await this._run(['api', '-X', 'DELETE', `repos/${repo.github}/issues/${number}/labels/${quote(label)}`]);
  }

  /** Merges the PR with a merge commit, only if its head is still `sha` (GitHub refuses otherwise:
   *  409). Returns the merge commit's sha. */
  async merge(repo: Repo, number: number, sha: string): Promise<string> {
    return or(get(await this._send('PUT', `repos/${repo.github}/pulls/${number}/merge`, { sha, merge_method: 'merge' }), 'sha'), '');
  }
}
