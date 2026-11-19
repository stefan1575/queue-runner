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
export type Comment = { author: string; createdAt: string; body: string };

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
export type ReviewPull = { number: number; title: string; body: string; branch: string; base: string; headSha: string; draft: boolean; url: string };
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

export class GhGitHub implements GitHub, GitHubAccount, GitHubLabels, GitHubWork, GitHubReview, GitHubPosts {
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

  /** Every page of a paged REST answer, as GitHub sent each one. */
  private async pages(endpoint: string): Promise<any[]> {
    const pages = await this.api(['--paginate', '--slurp', endpoint], endpoint);
    return Array.isArray(pages) ? pages : [];
  }

  /** Every item of a paged REST list. */
  private async all(endpoint: string): Promise<any[]> {
    return (await this.pages(endpoint)).flat();
  }

  /** Every item under `key` of a paged REST answer whose pages are objects (`{check_runs: [...]}`). */
  private async allOf(endpoint: string, key: string): Promise<any[]> {
    return (await this.pages(endpoint)).flatMap((p) => (Array.isArray(p?.[key]) ? p[key] : []));
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
    return comments.map((c) => ({ author: c.user?.login ?? 'ghost', createdAt: c.created_at ?? '', body: c.body ?? '' }));
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
}
