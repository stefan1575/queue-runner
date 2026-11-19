// GitHub, through `gh` (the CLI T3 itself uses for GitHub). A seam the tests fake.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { GitHubPosts, OpenIssue } from './review/post.ts';

export type Remote = { nameWithOwner: string; url: string };

/** gh couldn't answer: not signed in, offline, not installed, or anything else it refused. */
export class GitHubError extends Error {}

export interface GitHub {
  /** The GitHub repo a folder's git remote points at, or null when it has none (not a git
   *  folder, no remote on GitHub, or the folder is gone). A GitHubError when gh fails. */
  remoteOf(folder: string): Promise<Remote | null>;
}

export type Account = { login: string; name: string | null };

export interface GitHubAccount {
  /** The account gh is signed in as: its login and the name set on it (null when none is). A
   *  GitHubError when gh fails. */
  account(): Promise<Account>;
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] || 'no message';

export type Label = { name: string; color: string; description: string };

export interface GitHubLabels {
  /** Every label's name in a repo (`owner/name`). A GitHubError when gh fails. */
  labelNames(repo: string): Promise<string[]>;
  /** Creates a label; one that's already there is left as it is. A GitHubError when gh fails. */
  createLabel(repo: string, label: Label): Promise<void>;
}

/** An open issue the picker may take: GitHub's counts of its open native blockers, its open
 *  sub-issues (a spec: its children are the work) and the open PRs linked to it. */
export type Issue = { number: number; title: string; body: string; openBlockers: number; openSubIssues: number; openLinkedPulls: number };
export type Pull = { number: number; branch: string; body: string; url: string };
export type PullState = { number: number; url: string; state: 'open' | 'closed' | 'merged' };
export type Comment = { author: string; createdAt: string; body: string; url?: string };

/** What the build lane reads on GitHub (#154; today's `queue_runner/github.py`). Repos are
 *  `owner/name`. Each is a GitHubError when gh fails. */
export interface GitHubWork {
  /** The open issues labelled `ready-for-agent`, PRs left out. */
  readyIssues(repo: string): Promise<Issue[]>;
  issueState(repo: string, n: number): Promise<'open' | 'closed'>;
  /** The repo's branch names that start with `prefix`. */
  branches(repo: string, prefix: string): Promise<string[]>;
  openPulls(repo: string): Promise<Pull[]>;
  issueComments(repo: string, n: number): Promise<Comment[]>;
  /** The newest PR opened from `branch`, open or not, or null. */
  pullForBranch(repo: string, branch: string): Promise<PullState | null>;
  /** GitHub's default branch: a served repo's base. */
  defaultBranch(repo: string): Promise<string>;
}

/** An open PR as the review lane reads it (#155): its head commit and its base branch. */
export type ReviewPull = {
  number: number; title: string; body: string; branch: string; base: string; headSha: string; draft: boolean; url: string;
  /** The repo its head branch is in (`owner/name`; null when GitHub has none, a deleted fork). A
   *  head in another repo is a fork's: no fixer pushes to it (#156 N2). Absent: the PR's own repo. */
  headRepo?: string | null;
};
/** The checks on one commit, `sol-review` not counted: none reported, still running, one failed,
 *  or every one passed (success, neutral or skipped). */
export type Checks = { state: 'none' | 'pending' | 'failed' | 'passed'; pending: string[]; failed: string[] };
export type ReviewComment = Comment & { path?: string | null; line?: number | null };

/** What the review lane reads on GitHub (#155; today's `queue_runner/github.py`). Each is a
 *  GitHubError when gh fails. */
export interface GitHubReview {
  pullsToReview(repo: string): Promise<ReviewPull[]>;
  checks(repo: string, sha: string): Promise<Checks>;
  /** An issue's title and body, in any repo. */
  issue(repo: string, n: number): Promise<{ title: string; body: string }>;
  issueComments(repo: string, n: number): Promise<Comment[]>;
  /** A PR's review-thread comments and its reviews' bodies (its other comments are issueComments). */
  reviewReplies(repo: string, n: number): Promise<ReviewComment[]>;
}

/** A PR as the merge reads it just before merging (#156): open, closed or merged, its head, and
 *  whether GitHub can merge it (null while GitHub is still working that out). */
export type MergePull = {
  number: number; title: string; url: string; state: 'open' | 'closed' | 'merged'; headSha: string;
  branch: string; base: string; draft: boolean; mergeable: boolean | null; labels: string[];
};

/** GitHub refused a merge because the PR's head isn't the one named (its 409). */
export class HeadMoved extends GitHubError {}

/** What merging writes and reads on GitHub (#156). Each is a GitHubError when gh fails. */
export interface GitHubMerge {
  pull(repo: string, n: number): Promise<MergePull>;
  /** Merges the PR at `sha` only, with a merge commit: its sha. HeadMoved when the head isn't `sha`. */
  merge(repo: string, n: number, sha: string): Promise<string | null>;
  /** The commit a branch points at now, from the branches API: a base's own tip (#157), never a
   *  PR's `base.sha`, which GitHub refreshes only when the PR's branch is pushed. */
  branchHead(repo: string, branch: string): Promise<string>;
  /** How many of the PR's review threads are unresolved, every page read. */
  openThreads(repo: string, n: number): Promise<number>;
  addLabel(repo: string, n: number, label: string): Promise<void>;
  /** Removes a label; one that isn't there is left so. */
  removeLabel(repo: string, n: number, label: string): Promise<void>;
}

/** A GitHub Actions run, as a re-run reads it: the attempt it's on, and how that attempt ended. */
export type ActionsRun = { id: number; attempt: number; status: string; conclusion: string | null };

/** What a failed check's one re-run and a base's failure read and write (#158; today's #93 and
 *  #199 in `queue_runner/stops.py`). Each is a GitHubError when gh fails. */
export interface GitHubChecks {
  /** The checks that failed on `sha` that are GitHub Actions check runs, by name: the run each is
   *  in (from its `details_url`). One not listed (a commit status, another app's) can't be re-run. */
  failedRuns(repo: string, sha: string): Promise<Record<string, number>>;
  run(repo: string, id: number): Promise<ActionsRun>;
  /** Re-runs a run's failed jobs (`gh run rerun <id> --failed`). */
  rerunFailed(repo: string, id: number): Promise<void>;
  /** The run's failed jobs' log (`gh run view <id> --log-failed`). */
  failedLog(repo: string, id: number): Promise<string>;
  /** Brings the PR up to date with its base (GitHub's update-branch, naming its head): `refused`
   *  is GitHub's 422 (a conflict, or the head moved). */
  updateBranch(repo: string, n: number, sha: string): Promise<'updated' | 'refused'>;
}

/** What filing a stop writes and reads (#158), besides a review's posts. Each is a GitHubError
 *  when gh fails. */
export interface GitHubStops {
  /** Closes an issue, as completed or not planned. */
  closeIssue(repo: string, n: number, reason: 'completed' | 'not_planned'): Promise<void>;
  /** Adds a label to an issue or PR, and takes another off (null: none). */
  relabel(repo: string, n: number, add: string, remove: string | null): Promise<void>;
}

const REVIEW_THREADS = `
query($owner: String!, $name: String!, $n: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}`;

const PASSED = new Set(['success', 'neutral', 'skipped']);
/** The status the review sets on the commit it reviewed: never one of the checks it waits for. */
const REVIEW_STATUS = 'sol-review';

/** One gh run: its exit code and both streams. A gh that can't be started (not installed) or
 *  is killed (the timeout) is a code that isn't 0, with why in `stderr`. */
export type Gh = (args: string[], cwd: string, input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `program` with `pre` before gh's own arguments (a test runs `node -e <script>` as gh).
 *  **Its output is never capped**: execFile's default 1 MiB would cut off a paged answer (every
 *  page of check runs comes back as one JSON document), and GitHub's answer is bounded by the
 *  timeout instead. */
export const ghAt = (program: string, pre: string[] = []): Gh => (args, cwd, input) => new Promise((resolve) => {
  const child = execFile(program, [...pre, ...args], { cwd, timeout: 60_000, maxBuffer: Infinity, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
    (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      const why = error && typeof error.code !== 'number' ? `${error.message}\n` : '';
      resolve({ code, stdout: String(stdout), stderr: why + String(stderr) });
    });
  // a body goes on stdin (`--input -`), never the command line, which Windows caps at 32K
  child.stdin?.on('error', () => {}); // a gh that never started: its error is the exit's
  child.stdin?.end(input ?? '');
});
export const ghCli: Gh = ghAt('gh');

// What gh says, exit 1, for a folder with no GitHub repo (gh 2.x, seen live 2026-11-18).
// Anything else it fails with (exit 4 when not signed in, HTTP 401, offline) is a failure.
const NO_REPO = [
  /not a git repository/,
  /none of the git remotes configured for this repository point to a known GitHub host/,
  /no git remotes found/,
];

const LINKED_PULLS = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $endCursor, states: OPEN, labels: ["ready-for-agent"]) {
      pageInfo { hasNextPage endCursor }
      nodes { number closedByPullRequestsReferences(first: 20, includeClosedPrs: false) { nodes { state } } }
    }
  }
}`;

export class GhGitHub implements GitHub, GitHubAccount, GitHubLabels, GitHubWork, GitHubReview, GitHubPosts, GitHubMerge, GitHubChecks, GitHubStops {
  private gh: Gh;
  private exists: (folder: string) => boolean;
  constructor(gh: Gh = ghCli, exists: (folder: string) => boolean = existsSync) {
    this.gh = gh;
    this.exists = exists;
  }

  async remoteOf(folder: string): Promise<Remote | null> {
    // A folder that's gone has no remote; gh can't even start there (ENOENT, like no gh).
    if (!this.exists(folder)) return null;
    const { code, stdout, stderr } = await this.gh(['repo', 'view', '--json', 'nameWithOwner,url'], folder);
    if (code !== 0) {
      if (code === 1 && NO_REPO.some((r) => r.test(stderr))) return null;
      throw new GitHubError(`gh repo view failed (${code}) in ${folder}: ${stderr.trim().split('\n')[0] || 'no message'}`);
    }
    let repo: any;
    try {
      repo = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh repo view printed no JSON in ${folder}: ${stdout.slice(0, 200)}`);
    }
    if (typeof repo?.nameWithOwner !== 'string') throw new GitHubError(`gh repo view named no repo in ${folder}`);
    return { nameWithOwner: repo.nameWithOwner, url: repo.url };
  }

  async account(): Promise<Account> {
    const { code, stdout, stderr } = await this.gh(['api', 'user'], homedir());
    if (code !== 0) throw new GitHubError(`gh api user failed (${code}): ${stderr.trim().split('\n')[0] || 'no message'}`);
    let user: any;
    try {
      user = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh api user printed no JSON: ${stdout.slice(0, 200)}`);
    }
    if (typeof user?.login !== 'string') throw new GitHubError('gh api user named no login');
    return { login: user.login, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : null };
  }

  async labelNames(repo: string): Promise<string[]> {
    const { code, stdout, stderr } = await this.gh(['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000'], homedir());
    if (code !== 0) throw new GitHubError(`gh label list failed (${code}) for ${repo}: ${firstLine(stderr)}`);
    let labels: any;
    try {
      labels = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh label list printed no JSON for ${repo}: ${stdout.slice(0, 200)}`);
    }
    if (!Array.isArray(labels)) throw new GitHubError(`gh label list printed no list for ${repo}`);
    return labels.map((l) => l?.name).filter((n): n is string => typeof n === 'string');
  }

  async createLabel(repo: string, label: Label): Promise<void> {
    const { code, stderr } = await this.gh(
      ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description], homedir());
    // made meanwhile by someone else: it's there, and it's theirs to keep as it is
    if (code === 0 || /already exists/.test(stderr)) return;
    throw new GitHubError(`gh label create ${label.name} failed (${code}) for ${repo}: ${firstLine(stderr)}`);
  }

  /** `gh api` with its JSON answer. */
  private async api(args: string[], what: string, input?: string): Promise<any> {
    const { code, stdout, stderr } = await this.gh(['api', ...args], homedir(), input);
    if (code !== 0) throw new GitHubError(`gh api ${what} failed (${code}): ${firstLine(stderr)}`);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh api ${what} printed no JSON: ${stdout.slice(0, 200)}`);
    }
  }

  /** Every page of a paged REST answer, as GitHub sent each one. An answer that isn't a list of
   *  pages is an error, never read as an empty list (a PR lookup would take it as no PR, #154 F13). */
  private async pages(endpoint: string): Promise<any[]> {
    const pages = await this.api(['--paginate', '--slurp', endpoint], endpoint);
    if (!Array.isArray(pages)) throw new GitHubError(`gh api ${endpoint} printed no list: ${JSON.stringify(pages).slice(0, 200)}`);
    return pages;
  }

  /** Every item of a paged REST list. */
  private async all(endpoint: string): Promise<any[]> {
    const pages = await this.pages(endpoint);
    if (!pages.every(Array.isArray)) throw new GitHubError(`gh api ${endpoint} printed no list: ${JSON.stringify(pages).slice(0, 200)}`);
    return pages.flat();
  }

  /** Every item under `key` of a paged REST answer whose pages are objects (`{check_runs: [...]}`). */
  private async allOf(endpoint: string, key: string): Promise<any[]> {
    const pages = await this.pages(endpoint);
    if (!pages.every((p) => Array.isArray(p?.[key]))) throw new GitHubError(`gh api ${endpoint} printed no ${key}: ${JSON.stringify(pages).slice(0, 200)}`);
    return pages.flatMap((p) => p[key]);
  }

  async readyIssues(repo: string): Promise<Issue[]> {
    const [owner, name] = repo.split('/');
    // REST doesn't show the PRs GitHub links to an issue (by keyword or by hand); GraphQL does
    const pages = await this.api(['graphql', '--paginate', '--slurp', '-f', `query=${LINKED_PULLS}`, '-f', `owner=${owner}`, '-f', `name=${name}`], `graphql (${repo}'s linked PRs)`);
    const linked = new Map<number, number>();
    for (const page of pages ?? []) {
      for (const node of page?.data?.repository?.issues?.nodes ?? []) {
        linked.set(node.number, (node.closedByPullRequestsReferences?.nodes ?? []).filter((p: any) => p?.state === 'OPEN').length);
      }
    }
    const issues = await this.all(`repos/${repo}/issues?state=open&labels=ready-for-agent&per_page=100`);
    return issues.filter((i) => !('pull_request' in i)).map((i) => {
      const subs = i.sub_issues_summary ?? {};
      return {
        number: i.number, title: i.title ?? '', body: i.body ?? '',
        // GitHub's native dependencies count only open blockers (checked 2026-11-16, #73)
        openBlockers: i.issue_dependencies_summary?.blocked_by ?? 0,
        openSubIssues: (subs.total ?? 0) - (subs.completed ?? 0),
        openLinkedPulls: linked.get(i.number) ?? 0,
      };
    });
  }

  async issueState(repo: string, n: number): Promise<'open' | 'closed'> {
    return (await this.api([`repos/${repo}/issues/${n}`], `${repo}#${n}`)).state === 'open' ? 'open' : 'closed';
  }

  async branches(repo: string, prefix: string): Promise<string[]> {
    const refs = await this.all(`repos/${repo}/git/matching-refs/heads/${prefix}`);
    return refs.map((r) => String(r.ref ?? '').replace(/^refs\/heads\//, ''));
  }

  async openPulls(repo: string): Promise<Pull[]> {
    const pulls = await this.all(`repos/${repo}/pulls?state=open&per_page=100`);
    return pulls.map((p) => ({ number: p.number, branch: p.head?.ref ?? '', body: p.body ?? '', url: p.html_url ?? '' }));
  }

  async issueComments(repo: string, n: number): Promise<Comment[]> {
    const comments = await this.all(`repos/${repo}/issues/${n}/comments?per_page=100`);
    return comments.map((c) => ({ author: c.user?.login ?? 'ghost', createdAt: c.created_at ?? '', body: c.body ?? '', ...(c.html_url ? { url: c.html_url } : {}) }));
  }

  async pullForBranch(repo: string, branch: string): Promise<PullState | null> {
    const owner = repo.split('/')[0];
    const pulls = await this.all(`repos/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=100`);
    if (!pulls.length) return null;
    const p = pulls.reduce((a, b) => (b.number > a.number ? b : a));
    return { number: p.number, url: p.html_url ?? '', state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed' };
  }

  async defaultBranch(repo: string): Promise<string> {
    const r = await this.api([`repos/${repo}`], repo);
    if (typeof r?.default_branch !== 'string') throw new GitHubError(`gh api ${repo} named no default branch`);
    return r.default_branch;
  }

  /** `gh api` writing: the fields as a JSON body on stdin. */
  private write(method: string, endpoint: string, fields: Record<string, unknown>): Promise<any> {
    return this.api(['-X', method, endpoint, '--input', '-'], `${method} ${endpoint}`, JSON.stringify(fields));
  }

  async pullsToReview(repo: string) {
    const pulls = await this.all(`repos/${repo}/pulls?state=open&per_page=100`);
    return pulls.map((p) => ({
      number: p.number, title: p.title ?? '', body: p.body ?? '', branch: p.head?.ref ?? '', base: p.base?.ref ?? '',
      headSha: p.head?.sha ?? '', draft: p.draft === true, url: p.html_url ?? '',
      headRepo: typeof p.head?.repo?.full_name === 'string' ? p.head.repo.full_name : null,
    }));
  }

  async checks(repo: string, sha: string) {
    // every page of both: a check that failed past the first page still fails the gate
    const runs = await this.allOf(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, 'check_runs');
    const statuses = await this.allOf(`repos/${repo}/commits/${sha}/status?per_page=100`, 'statuses');
    const seen: [string, string][] = [
      ...runs.map((r: any): [string, string] => [r.name, r.status === 'completed' ? String(r.conclusion) : 'pending']),
      ...statuses.filter((s: any) => s.context !== REVIEW_STATUS).map((s: any): [string, string] => [s.context, s.state]),
    ];
    const failed = seen.filter(([, s]) => !PASSED.has(s) && s !== 'pending').map(([n]) => n);
    const pending = seen.filter(([, s]) => s === 'pending').map(([n]) => n);
    const state: Checks['state'] = !seen.length ? 'none' : failed.length ? 'failed' : pending.length ? 'pending' : 'passed';
    return { state, pending, failed };
  }

  async issue(repo: string, n: number) {
    const i = await this.api([`repos/${repo}/issues/${n}`], `${repo}#${n}`);
    return { title: i?.title ?? '', body: i?.body ?? '' };
  }

  async reviewReplies(repo: string, n: number) {
    const threads = await this.all(`repos/${repo}/pulls/${n}/comments?per_page=100`);
    const reviews = await this.all(`repos/${repo}/pulls/${n}/reviews?per_page=100`);
    return [
      ...threads.map((c) => ({ author: c.user?.login ?? 'ghost', createdAt: c.created_at ?? '', body: c.body ?? '', path: c.path ?? null, line: c.line ?? c.original_line ?? null })),
      ...reviews.filter((r) => r.body && r.submitted_at).map((r) => ({ author: r.user?.login ?? 'ghost', createdAt: r.submitted_at, body: r.body })),
    ];
  }

  async openIssues(repo: string): Promise<OpenIssue[]> {
    const issues = await this.all(`repos/${repo}/issues?state=open&per_page=100`);
    return issues.filter((i) => !('pull_request' in i)).map((i) => ({ number: i.number, title: i.title ?? '', body: i.body ?? '', url: i.html_url ?? '' }));
  }

  async createIssue(repo: string, title: string, body: string, labels: string[]) {
    // REST makes a label it doesn't have yet, so a repo without `needs-triage` still gets the issue
    const i = await this.write('POST', `repos/${repo}/issues`, { title, body, labels });
    if (typeof i?.html_url !== 'string') throw new GitHubError(`gh api POST repos/${repo}/issues named no issue`);
    return i.html_url;
  }

  async postComment(repo: string, n: number, body: string) {
    const c = await this.write('POST', `repos/${repo}/issues/${n}/comments`, { body });
    if (typeof c?.html_url !== 'string') throw new GitHubError(`gh api POST ${repo}#${n} comments named no comment`);
    return c.html_url;
  }

  async setStatus(repo: string, sha: string, context: string, state: string, description: string, url: string) {
    await this.write('POST', `repos/${repo}/statuses/${sha}`, { state, context, description, target_url: url });
  }

  async pullBody(repo: string, n: number) {
    return (await this.api([`repos/${repo}/pulls/${n}`], `${repo}#${n}`))?.body ?? '';
  }

  async editPullBody(repo: string, n: number, body: string) {
    await this.write('PATCH', `repos/${repo}/pulls/${n}`, { body });
  }

  async pull(repo: string, n: number): Promise<MergePull> {
    const p = await this.api([`repos/${repo}/pulls/${n}`], `${repo}#${n}`);
    if (typeof p?.head?.sha !== 'string') throw new GitHubError(`gh api ${repo}#${n} named no head`);
    return {
      number: p.number, title: p.title ?? '', url: p.html_url ?? '', headSha: p.head.sha,
      state: p.merged_at || p.merged === true ? 'merged' : p.state === 'open' ? 'open' : 'closed',
      branch: p.head?.ref ?? '', base: p.base?.ref ?? '', draft: p.draft === true,
      mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
      labels: (p.labels ?? []).map((l: any) => l?.name).filter((x: unknown): x is string => typeof x === 'string'),
    };
  }

  async merge(repo: string, n: number, sha: string): Promise<string | null> {
    const endpoint = `repos/${repo}/pulls/${n}/merge`;
    const { code, stdout, stderr } = await this.gh(['api', '-X', 'PUT', endpoint, '--input', '-'], homedir(),
      JSON.stringify({ sha, merge_method: 'merge' }));
    // GitHub answers 409 when the head isn't `sha` ("Head branch was modified")
    if (code !== 0 && /HTTP 409/.test(stderr)) throw new HeadMoved(`GitHub refused the merge at ${sha.slice(0, 7)}: ${firstLine(stderr)}`);
    if (code !== 0) throw new GitHubError(`gh api PUT ${endpoint} failed (${code}): ${firstLine(stderr)}`);
    let answer: any;
    try {
      answer = JSON.parse(stdout);
    } catch {
      throw new GitHubError(`gh api PUT ${endpoint} printed no JSON: ${stdout.slice(0, 200)}`);
    }
    if (answer?.merged !== true) throw new GitHubError(`GitHub didn't merge ${repo}#${n}: ${answer?.message ?? 'no reason given'}`);
    return typeof answer.sha === 'string' ? answer.sha : null;
  }

  async branchHead(repo: string, branch: string): Promise<string> {
    const b = await this.api([`repos/${repo}/branches/${encodeURIComponent(branch)}`], `${repo} branch ${branch}`);
    if (typeof b?.commit?.sha !== 'string') throw new GitHubError(`gh api ${repo} branch ${branch} named no commit`);
    return b.commit.sha;
  }

  async openThreads(repo: string, n: number): Promise<number> {
    const [owner, name] = repo.split('/');
    const pages = await this.api(['graphql', '--paginate', '--slurp', '-f', `query=${REVIEW_THREADS}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `n=${n}`],
      `graphql (${repo}#${n}'s review threads)`);
    if (!Array.isArray(pages)) throw new GitHubError(`gh api graphql printed no pages for ${repo}#${n}'s review threads`);
    let open = 0;
    for (const page of pages) {
      const nodes = page?.data?.repository?.pullRequest?.reviewThreads?.nodes;
      // a page without its threads isn't "none open": the merge would go ahead on it
      if (!Array.isArray(nodes)) throw new GitHubError(`gh api graphql gave no review threads for ${repo}#${n}: ${JSON.stringify(page).slice(0, 200)}`);
      open += nodes.filter((t: any) => t?.isResolved !== true).length;
    }
    return open;
  }

  async failedRuns(repo: string, sha: string): Promise<Record<string, number>> {
    const runs = await this.allOf(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, 'check_runs');
    const found: Record<string, number> = {};
    for (const r of runs) {
      if (r?.status !== 'completed' || PASSED.has(String(r.conclusion)) || r?.app?.slug !== 'github-actions') continue;
      const m = /\/actions\/runs\/(\d+)/.exec(String(r.details_url ?? ''));
      if (m) found[r.name] = Number(m[1]);
    }
    return found;
  }

  async run(repo: string, id: number): Promise<ActionsRun> {
    const r = await this.api([`repos/${repo}/actions/runs/${id}`], `${repo} run ${id}`);
    if (typeof r?.run_attempt !== 'number') throw new GitHubError(`gh api ${repo} run ${id} named no attempt`);
    return { id, attempt: r.run_attempt, status: String(r.status ?? ''), conclusion: typeof r.conclusion === 'string' ? r.conclusion : null };
  }

  async rerunFailed(repo: string, id: number): Promise<void> {
    const endpoint = `repos/${repo}/actions/runs/${id}/rerun-failed-jobs`;
    const { code, stderr } = await this.gh(['api', '-X', 'POST', endpoint], homedir());
    if (code !== 0) throw new GitHubError(`gh api POST ${endpoint} failed (${code}): ${firstLine(stderr)}`);
  }

  async failedLog(repo: string, id: number): Promise<string> {
    const { code, stdout, stderr } = await this.gh(['run', 'view', String(id), '--repo', repo, '--log-failed'], homedir());
    if (code !== 0) throw new GitHubError(`gh run view ${id} --log-failed failed (${code}): ${firstLine(stderr)}`);
    return stdout;
  }

  async updateBranch(repo: string, n: number, sha: string): Promise<'updated' | 'refused'> {
    const endpoint = `repos/${repo}/pulls/${n}/update-branch`;
    const { code, stderr } = await this.gh(['api', '-X', 'PUT', endpoint, '--input', '-'], homedir(), JSON.stringify({ expected_head_sha: sha }));
    if (code === 0) return 'updated';
    if (/HTTP 422/.test(stderr)) return 'refused';
    throw new GitHubError(`gh api PUT ${endpoint} failed (${code}): ${firstLine(stderr)}`);
  }

  async closeIssue(repo: string, n: number, reason: 'completed' | 'not_planned'): Promise<void> {
    await this.write('PATCH', `repos/${repo}/issues/${n}`, { state: 'closed', state_reason: reason });
  }

  async relabel(repo: string, n: number, add: string, remove: string | null): Promise<void> {
    await this.addLabel(repo, n, add);
    if (remove) await this.removeLabel(repo, n, remove);
  }

  async addLabel(repo: string, n: number, label: string): Promise<void> {
    await this.write('POST', `repos/${repo}/issues/${n}/labels`, { labels: [label] });
  }

  async removeLabel(repo: string, n: number, label: string): Promise<void> {
    const endpoint = `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`;
    const { code, stderr } = await this.gh(['api', '-X', 'DELETE', endpoint], homedir());
    if (code === 0 || /HTTP 404/.test(stderr)) return; // not there: as good as removed
    throw new GitHubError(`gh api DELETE ${endpoint} failed (${code}): ${firstLine(stderr)}`);
  }
}
