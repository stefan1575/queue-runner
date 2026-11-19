// A fake GitHub behind the build lane's seam (`GitHubWork`), answered from memory. Repos are
// `owner/name`; issues elsewhere are `owner/name#N` in `states`.
import type { Checks, Comment, GitHubReview, GitHubWork, Issue, Pull, PullState, ReviewPull } from '../src/github.ts';
import type { GitHubPosts, OpenIssue } from '../src/review/post.ts';

export class FakeGitHub implements GitHubWork {
  /** Each repo's open `ready-for-agent` issues. */
  ready: Record<string, Issue[]> = {};
  /** Any issue's state, by `owner/name#N`; one not named is closed. */
  states: Record<string, 'open' | 'closed'> = {};
  branchList: Record<string, string[]> = {};
  pulls: Record<string, Pull[]> = {};
  comments: Record<string, Comment[]> = {};
  /** The PR opened from each branch, by `owner/name:branch`. */
  pullsFromBranch: Record<string, PullState> = {};
  defaults: Record<string, string> = {};
  /** Every read, as `<method> <repo>`. */
  reads: string[] = [];

  async readyIssues(repo: string) { this.reads.push(`readyIssues ${repo}`); return structuredClone(this.ready[repo] ?? []); }
  async issueState(repo: string, n: number) { return this.states[`${repo}#${n}`] ?? 'closed'; }
  async branches(repo: string, prefix: string) { return (this.branchList[repo] ?? []).filter((b) => b.startsWith(prefix)); }
  async openPulls(repo: string) { return structuredClone(this.pulls[repo] ?? []); }
  async issueComments(repo: string, n: number) { return structuredClone(this.comments[`${repo}#${n}`] ?? []); }
  /** While above 0, each PR lookup fails (a GitHub blip) and counts it down. */
  pullLookupFails = 0;
  async pullForBranch(repo: string, branch: string) {
    if (this.pullLookupFails > 0) { this.pullLookupFails--; throw new Error('gh api failed (1): HTTP 502'); }
    return this.pullsFromBranch[`${repo}:${branch}`] ?? null;
  }
  async defaultBranch(repo: string) { return this.defaults[repo] ?? 'main'; }
}

/** The review lane's GitHub (#155): what it reads about a PR, and what posting a review writes,
 *  each write recorded in `posted`. */
export class FakeReviewGitHub extends FakeGitHub implements GitHubPosts, GitHubReview {
  reviewPulls: Record<string, ReviewPull[]> = {};
  /** Each commit's checks, by sha; one not named has none reported. */
  checkStates: Record<string, Checks> = {};
  issues: Record<string, { title: string; body: string }> = {};
  replies: Record<string, Comment[]> = {};
  open: Record<string, OpenIssue[]> = {};
  bodies: Record<string, string> = {};
  /** Every write, in order. */
  posted: { what: string; repo: string; [k: string]: any }[] = [];
  /** Writes that fail, by `what` (`comment`, `status`, `issue`, `body`, `openIssues`). */
  failing = new Set<string>();
  private n = 100;

  private fail(what: string) { if (this.failing.has(what)) throw new Error(`gh ${what} failed (HTTP 502)`); }
  async pullsToReview(repo: string) { return structuredClone(this.reviewPulls[repo] ?? []); }
  async checks(_repo: string, sha: string) { return this.checkStates[sha] ?? { state: 'none' as const, pending: [], failed: [] }; }
  async issue(repo: string, n: number) { return this.issues[`${repo}#${n}`] ?? { title: `Issue ${n}`, body: '' }; }
  async reviewReplies(repo: string, n: number) { return structuredClone(this.replies[`${repo}#${n}`] ?? []); }
  async openIssues(repo: string) { this.fail('openIssues'); return structuredClone(this.open[repo] ?? []); }
  async createIssue(repo: string, title: string, body: string, labels: string[]) {
    this.fail('issue');
    const url = `https://github.com/${repo}/issues/${++this.n}`;
    this.posted.push({ what: 'issue', repo, title, body, labels, url });
    (this.open[repo] ??= []).push({ number: this.n, title, body, url });
    return url;
  }
  async postComment(repo: string, n: number, body: string) {
    this.fail('comment');
    const url = `https://github.com/${repo}/pull/${n}#issuecomment-${++this.n}`;
    this.posted.push({ what: 'comment', repo, n, body, url });
    (this.comments[`${repo}#${n}`] ??= []).push({ author: 'me', createdAt: `2026-11-19T12:00:${String(this.n % 60).padStart(2, '0')}Z`, body });
    return url;
  }
  async setStatus(repo: string, sha: string, context: string, state: string, description: string, url: string) {
    this.fail('status');
    this.posted.push({ what: 'status', repo, sha, context, state, description, url });
  }
  async pullBody(repo: string, n: number) { this.fail('body'); return this.bodies[`${repo}#${n}`] ?? ''; }
  async editPullBody(repo: string, n: number, body: string) {
    this.posted.push({ what: 'body', repo, n, body });
    this.bodies[`${repo}#${n}`] = body;
  }
}
