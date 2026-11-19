// Posting a review (#155; today's `queue_runner/post.py`, ported): the review loop's automated
// posts on the repo's own PR, which need no go-ahead (docs/flow.md, Who runs it). In order: each
// new Pre-existing finding filed once as a `needs-triage` issue (an open issue that already holds
// it is linked instead), the review comment with those links and its ledger, the `sol-review`
// status on H (the commit reviewed, never a newer one), then a row in the PR body's `## Review`
// table, on every repo (#36), its Reviewer column naming who reviewed. The comment is the review's record: if it
// can't be posted the review failed and nothing counts. Anything after it that fails is said and
// left; the review stands.
import { cell, OPEN, where, withIssues, type Decision, type Finding } from './ledger.ts';

export const TRIAGE = 'needs-triage';
export const STATUS_CONTEXT = 'sol-review';
const OUTCOMES = { stop: 'stopped for the user', 'approach-note': 'approach note for the user', merge: 'to merge', fix: 'back to fix' } as const;
const TABLE_HEAD = '| Step | Reviewer | Time (UTC) | Commit | Verdict |';
const TABLE_RULE = '|---|---|---|---|---|';
/** Today's runner's table, before the Reviewer column: a PR it reviewed keeps its rows. */
const OLD_HEAD = '| Step | Time (UTC) | Commit | Verdict |';

/** The review comment couldn't be posted: nothing is on the PR, so the review failed. */
export class PostFailed extends Error {}

export type OpenIssue = { number: number; title: string; body: string; url: string };

/** What posting a review writes on GitHub (repos are `owner/name`). Each throws when gh fails. */
export interface GitHubPosts {
  openIssues(repo: string): Promise<OpenIssue[]>;
  /** Files an issue; its URL. */
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<string>;
  /** Comments on an issue or PR; the comment's URL. */
  postComment(repo: string, n: number, body: string): Promise<string>;
  setStatus(repo: string, sha: string, context: string, state: 'success' | 'failure', description: string, url: string): Promise<void>;
  pullBody(repo: string, n: number): Promise<string>;
  editPullBody(repo: string, n: number, body: string): Promise<void>;
}

/** The hidden line that ties a follow-up issue to its PR and finding. */
export const followupMark = (repo: string, n: number, id: string) => `<!-- sol-finding ${repo}#${n} ${id} -->`;

export function issueBody(repo: string, n: number, rnd: number, sha: string, f: Finding): string {
  const lines = [`The review found this in code that PR #${n} didn't change, in review ${rnd} of https://github.com/${repo}/pull/${n}, so it was filed here instead of blocking that PR.`, ''];
  if (f.file) lines.push(`- **Where:** ${where(repo, sha, f)}`);
  for (const k of ['class', 'scenario', 'cost', 'rule'] as const) if (f[k]) lines.push(`- **${k[0]!.toUpperCase()}${k.slice(1)}:** ${f[k]}`);
  return [...lines, '', `<sub>Finding ${f.id}, filed by the queue runner.</sub>`, '', followupMark(repo, n, f.id), ''].join('\n');
}

/** The open issue that already holds this finding: the runner's mark, the old script's footer
 *  for the same PR and ID, or the same title. */
export function filedAlready(issues: OpenIssue[], repo: string, n: number, id: string, title: string): OpenIssue | undefined {
  const old = new RegExp(`Finding ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, filed by sol-pr-review`);
  return issues.find((i) => i.body.includes(followupMark(repo, n, id))
    || (old.test(i.body) && i.body.includes(`/${repo}/pull/${n}`))
    || i.title.trim() === title.trim());
}

const pad = (n: number) => String(n).padStart(2, '0');
const utc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** The PR body's `## Review` row for this review: who reviewed, what it found, closed and left. */
export function reviewRow(d: Decision, url: string, at: Date): string {
  const rnd = d.round;
  const fs = d.findings;
  const ids = (ok: (f: Finding) => boolean) => fs.filter(ok).map((f) => f.id).join(', ');
  const came = new Set(d.signals.filter((s) => s.signal === 'reopened').flatMap((s) => s.ids));
  const signal = d.signals.length ? ` (${d.signals.map((s) => s.signal).join(', ')})` : '';
  const parts = [`**${d.verdict[0]!.toUpperCase()}${d.verdict.slice(1)}**, ${OUTCOMES[d.outcome]}${signal}`];
  const kinds: [string, (f: Finding) => boolean][] = [
    ['raised', (f) => f.raised === rnd && f.tag !== 'pre-existing'],
    ['came back', (f) => came.has(f.id)],
    ['fixed', (f) => f.closed === rnd && f.status === 'fixed'],
    ['decline accepted', (f) => f.closed === rnd && f.status === 'decline-accepted'],
    ['decline kept open', (f) => d.kept.includes(f.id)],
    ['filed as follow-ups', (f) => f.raised === rnd && f.tag === 'pre-existing'],
    ['left open', (f) => f.tag === 'important' && OPEN.includes(f.status)],
  ];
  for (const [label, ok] of kinds) {
    const got = ids(ok);
    if (got) parts.push(`${label}: ${got}`);
  }
  return `| [Review ${rnd}](${url}) | ${cell(d.reviewer)} | ${utc(at)} | \`${d.sha.slice(0, 7)}\` | ${cell(parts.join('; '))} |`;
}

/** Today's runner's Step cell: `[Review N, <reviewer>](url)`, or `[Sol review N](url)` from
 *  before it named the reviewer (Sol, then). */
const OLD_STEP = /^\|\s*\[(?:Sol review (\d+)|Review (\d+), ((?:[^\]\\]|\\.)+))\]\(([^)\s]*)\)\s*\|/;

/** A row of today's runner's table with the Reviewer column: the reviewer its Step link named
 *  moves to its own cell; a Step it didn't write keeps its text, beside a blank Reviewer. */
function oldRow(line: string): string {
  const m = OLD_STEP.exec(line);
  if (m) return `| [Review ${m[1] ?? m[2]}](${m[4]}) | ${m[1] ? 'Sol' : m[3]!.trim()} |${line.slice(m[0].length)}`;
  const step = /^\|(?:[^|\\]|\\.)*\|/.exec(line); // the first pipe that isn't escaped after the opening one
  return step ? `${step[0]}  |${line.slice(step[0].length)}` : line;
}

/** The tables in lines `from` to `to`: each a run of lines that start with a pipe, its first
 *  and last line. A table ends at the first line that doesn't. */
function tablesIn(lines: string[], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = from; j < to; j++) {
    if (!lines[j]!.startsWith('|')) continue;
    const last = out.at(-1);
    if (last && last[1] === j - 1) last[1] = j;
    else out.push([j, j]);
  }
  return out;
}

/** The PR body with `row` appended to its `## Review` table: the section's table headed as the
 *  runner's (today's runner's is given the Reviewer column first), whichever table it is there;
 *  every other table is left as it is. A section without it gets one after its last table, or at
 *  its end; a body without the section gets it after `## Evidence` (or at the end). */
export function withReviewRow(body: string, row: string): string {
  const lines = (body ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const head = (pat: RegExp) => { const i = lines.findIndex((l) => pat.test(l)); return i < 0 ? null : i; };
  const end = (i: number) => { for (let j = i + 1; j < lines.length; j++) if (/^#{1,2}\s/.test(lines[j]!)) return j; return lines.length; };
  const table = [TABLE_HEAD, TABLE_RULE, row];
  const put = (at: number, floor: number, add: string[]) => {
    let s = at;
    while (s > floor && !lines[s - 1]!.trim()) s--;
    lines.splice(s, at - s, '', ...add, ...(at < lines.length ? [''] : []));
  };
  const r = head(/^##\s+Review\s*$/);
  if (r !== null) {
    const tables = tablesIn(lines, r + 1, end(r));
    const ours = tables.find(([a]) => [TABLE_HEAD, OLD_HEAD].includes(lines[a]!.trim()));
    if (ours) {
      const [a, b] = ours;
      if (lines[a]!.trim() === OLD_HEAD) {
        lines[a] = TABLE_HEAD;
        if (b > a && /^\|(\s*:?-+:?\s*\|)+\s*$/.test(lines[a + 1]!)) lines[a + 1] = TABLE_RULE;
        for (let j = a + 2; j <= b; j++) lines[j] = oldRow(lines[j]!);
      }
      lines.splice(b + 1, 0, row);
    } else if (tables.length) {
      const after = tables.at(-1)![1] + 1;
      // a line right after a table would be read as its row: a blank line keeps ours apart
      lines.splice(after, 0, '', ...table, ...(after < lines.length && lines[after]!.trim() ? [''] : []));
    } else put(end(r), r + 1, table);
  } else {
    const ev = head(/^##\s+Evidence\b/);
    put(ev === null ? lines.length : end(ev), 0, ['## Review', '', '_Rows from the review loop, one per review; each links its comment._', '', ...table]);
  }
  return lines.join('\n').replace(/^\n+/, '') + '\n';
}

export interface Poster {
  /** Posts the review; its comment's URL (null for a dry run). PostFailed if the comment didn't post. */
  post(repo: string, n: number, d: Decision): Promise<string | null>;
}

/** Posts nothing (the live check): the comment and the decision are in the run folder. */
export class DryRunPoster implements Poster {
  private say: (line: string) => void;
  constructor(say: (line: string) => void) { this.say = say; }
  async post(repo: string, n: number): Promise<null> {
    this.say(`dry run: ${repo}#${n}'s review comment, follow-ups, sol-review status and Review row not posted`);
    return null;
  }
}

export class GitHubPoster implements Poster {
  private gh: GitHubPosts;
  private say: (line: string) => void;
  private now: () => Date;
  /** Each file the post writes beside the run (`comment.md`, `pr-body.md`, `followup-<id>.md`). */
  private write: (name: string, text: string) => Promise<void>;

  constructor(gh: GitHubPosts, say: (line: string) => void, write: (name: string, text: string) => Promise<void> = async () => {}, now = () => new Date()) {
    this.gh = gh;
    this.say = say;
    this.write = write;
    this.now = now;
  }

  async post(repo: string, n: number, d: Decision): Promise<string> {
    const name = `review ${repo}#${n}`;
    const [urls, failed] = await this.file(repo, n, d);
    const body = withIssues(d, urls, failed);
    await this.write('comment.md', body);
    let url: string;
    try {
      url = await this.gh.postComment(repo, n, body);
    } catch (e) {
      throw new PostFailed(`Posting the review comment failed (${(e as Error).message}).`);
    }
    this.say(`${name}: posted ${url}`);
    try { // on H, the commit reviewed, whatever the PR's head is by now
      await this.gh.setStatus(repo, d.sha, STATUS_CONTEXT, d.status.state, d.status.description, url);
      this.say(`${name}: ${STATUS_CONTEXT} ${d.status.state} on ${d.sha.slice(0, 7)}`);
    } catch (e) {
      this.say(`${name}: setting ${STATUS_CONTEXT} on ${d.sha.slice(0, 7)} failed: ${(e as Error).message}`);
    }
    try { // read afresh: someone may have edited the body while the review ran
      const next = withReviewRow(await this.gh.pullBody(repo, n), reviewRow(d, url, this.now()));
      await this.write('pr-body.md', next);
      await this.gh.editPullBody(repo, n, next);
    } catch (e) {
      this.say(`${name}: adding the Review row to the PR body failed: ${(e as Error).message}`);
    }
    return url;
  }

  /** Files each new Pre-existing finding once: its issue's URL by finding id, and the ids that failed. */
  private async file(repo: string, n: number, d: Decision): Promise<[Map<string, string>, string[]]> {
    const urls = new Map<string, string>();
    if (!d.issues.length) return [urls, []];
    const name = `review ${repo}#${n}`;
    let open: OpenIssue[];
    try {
      open = await this.gh.openIssues(repo);
    } catch (e) { // without the check, filing could duplicate: leave it for the next review
      this.say(`${name}: reading open issues failed, so nothing is filed: ${(e as Error).message}`);
      return [urls, d.issues.map((i) => i.id)];
    }
    const failed: string[] = [];
    for (const i of d.issues) {
      const had = filedAlready(open, repo, n, i.id, i.title);
      if (had) {
        urls.set(i.id, had.url);
        this.say(`${name}: ${i.id} is open already as ${had.url}; not filed again`);
        continue;
      }
      const text = issueBody(repo, n, d.round, d.sha, i.finding);
      await this.write(`followup-${i.id.replace(/[^A-Za-z0-9-]/g, '_')}.md`, text);
      try {
        urls.set(i.id, await this.gh.createIssue(repo, i.title, text, [TRIAGE]));
        this.say(`${name}: filed ${i.id} as ${urls.get(i.id)}`);
      } catch (e) {
        failed.push(i.id);
        this.say(`${name}: filing ${i.id} failed: ${(e as Error).message}`);
      }
    }
    return [urls, failed];
  }
}
