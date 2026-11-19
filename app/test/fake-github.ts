// A fake GitHub behind the build lane's seam (`GitHubWork`), answered from memory. Repos are
// `owner/name`; issues elsewhere are `owner/name#N` in `states`.
import type { Comment, GitHubWork, Issue, Pull, PullState } from '../src/github.ts';

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
