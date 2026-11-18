// Which ticket a served repo builds next (#154; today's `queue_runner/picker.py`, docs/layout.md):
// an open issue labelled `ready-for-agent`, every blocker closed (GitHub's native blocked-by, and
// `#N`, `owner/name#N` or issue URLs on a `Blocked by:` line or under a `## Blocked by` heading),
// not already in flight (a job branch, an open PR on one, or an open PR that closes it or that
// GitHub links to it), not a spec with open sub-issues (its children are the work), and
// not held by the app's job log. Lowest number first.
import type { GitHubWork, Issue } from './github.ts';

/** A ticket to build: on `branch`, made from `base` (`origin/<the repo's base>`). */
export type BuildTicket = { issue: Issue; branch: string; base: string };

const HEADING = /^\s{0,3}#{1,6}\s/;
const BLOCKED_BY = /^[\s>*_#-]*blocked by\b/i;
// An issue reference: a github.com URL, `owner/name#N`, or `#N` (this repo).
const REF = String.raw`(?:https://github\.com/(?<urlRepo>[\w.-]+/[\w.-]+)/issues/(?<urlN>\d+)|(?<![\w/#.-])(?:(?<repo>[\w.-]+/[\w.-]+))?#(?<n>\d+)\b)`;
const CLOSES = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+` + REF;
/** Every job branch starts with this, `<prefix><slug>-<issue>`: a GitHub-facing name, kept as
 *  today's runner has it, since a branch it left counts as in flight across the cutover
 *  (docs/app.md, Rules). */
export const JOB_BRANCH_PREFIX = 'claude/';
const JOB_BRANCH = new RegExp(String.raw`^${JOB_BRANCH_PREFIX}.+-(\d+)$`);

export type Ref = [repo: string, n: number];

export function slug(title: string, words = 4): string {
  return (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, words).join('-') || 'issue';
}

/** (owner/name, number) for each reference; a bare `#N` is in `here`. */
function refs(pattern: string, text: string, here: string): Ref[] {
  return [...text.matchAll(new RegExp(pattern, 'gi'))].map((m) => {
    const g = m.groups!;
    return g.urlN ? [g.urlRepo!.toLowerCase(), Number(g.urlN)] : [(g.repo ?? here).toLowerCase(), Number(g.n)];
  });
}

const sorted = (found: Ref[]): Ref[] => {
  const unique = new Map(found.map((r) => [`${r[0]}#${r[1]}`, r]));
  return [...unique.values()].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
};

/** Issues a PR body closes (Closes, Fixes, Resolves... then a reference). */
export function closedIssues(body: string, here: string): Ref[] {
  return sorted(refs(CLOSES, body ?? '', here.toLowerCase()));
}

/** Issues named as blockers: on a `Blocked by:` line, or under a `## Blocked by` heading up to
 *  the next heading. References elsewhere in the body don't block. */
export function blockers(body: string, here: string): Ref[] {
  const found: Ref[] = [];
  const lines = (body ?? '').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!BLOCKED_BY.test(line)) return;
    found.push(...refs(REF, line, here.toLowerCase()));
    if (!HEADING.test(line)) return;
    for (const later of lines.slice(i + 1)) {
      if (HEADING.test(later)) break;
      found.push(...refs(REF, later, here.toLowerCase()));
    }
  });
  return sorted(found);
}

/** Issues something is already building: a job branch, or an open PR on one or
 *  with a closing keyword for the issue in this repo. PRs GitHub links to an issue are counted on
 *  the issue itself (`openLinkedPulls`). */
export async function inFlight(github: GitHubWork, repo: string): Promise<Set<number>> {
  const here = repo.toLowerCase();
  const [branches, pulls] = await Promise.all([github.branches(repo, JOB_BRANCH_PREFIX), github.openPulls(repo)]);
  const taken = new Set<number>();
  for (const b of [...branches, ...pulls.map((p) => p.branch)]) {
    const m = JOB_BRANCH.exec(b);
    if (m) taken.add(Number(m[1]));
  }
  for (const p of pulls) for (const [where, n] of closedIssues(p.body, here)) if (where === here) taken.add(n);
  return taken;
}

async function unblocked(github: GitHubWork, repo: string, issue: Issue): Promise<boolean> {
  if (issue.openBlockers) return false;
  for (const [where, n] of blockers(issue.body, repo)) {
    if (await github.issueState(where, n) !== 'closed') return false;
  }
  return true;
}

/** Every ticket `pick` could take, in the order it takes them. `held` are issues the job log
 *  holds (a build open on them, or ended without a release since). */
export async function* pickable(github: GitHubWork, repo: string, base: string, held: ReadonlySet<number>): AsyncGenerator<BuildTicket> {
  const [issues, taken] = await Promise.all([github.readyIssues(repo), inFlight(github, repo)]);
  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    if (held.has(issue.number) || taken.has(issue.number) || issue.openLinkedPulls || issue.openSubIssues) continue;
    if (await unblocked(github, repo, issue)) {
      yield { issue, base: `origin/${base}`, branch: `${JOB_BRANCH_PREFIX}${slug(issue.title)}-${issue.number}` };
    }
  }
}

/** The lowest-numbered ready issue that's unblocked and not being built, or null. */
export async function pick(github: GitHubWork, repo: string, base: string, held: ReadonlySet<number>): Promise<BuildTicket | null> {
  for await (const t of pickable(github, repo, base, held)) return t;
  return null;
}
