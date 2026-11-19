// Posting a review (#155; today's `queue_runner/post.py`, ported): the review loop's automated
// posts on the repo's own PR, which need no go-ahead (docs/flow.md, Who runs it). In order: each
// new Pre-existing finding filed once as a `needs-triage` issue (an open issue that already holds
// it is linked instead), the review comment with those links and its ledger, the `sol-review`
// status on H (the commit reviewed, never a newer one), then a row in the app's Review table in
// the PR body, on every repo (#36), its Reviewer column naming who reviewed. The app reads and
// changes only what it posted itself: its own marker on a follow-up issue, its own table between
// its own markers. The comment is the review's record: if it can't be posted the review failed and
// nothing counts. `post` ends at the comment; `finish` writes the status and the row, and throws
// `FinishFailed` while either hasn't landed: the lane calls it again until both have (F14).
import { cell, OPEN, where, withIssues, type Decision, type Finding } from './ledger.ts';

export const TRIAGE = 'needs-triage';
export const STATUS_CONTEXT = 'sol-review';
const OUTCOMES = { stop: 'stopped for the user', 'approach-note': 'approach note for the user', merge: 'to merge', fix: 'back to fix' } as const;
const TABLE_HEAD = '| Step | Reviewer | Time (UTC) | Commit | Verdict |';
const TABLE_RULE = '|---|---|---|---|---|';

/** The review comment couldn't be posted: nothing is on the PR, so the review failed. */
export class PostFailed extends Error {}
/** The comment is on the PR, but `sol-review` on H or its Review row didn't land: try again. */
export class FinishFailed extends Error {}

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
export const followupMark = (repo: string, n: number, id: string) => `<!-- queue-runner-app finding ${repo}#${n} ${id} -->`;

export function issueBody(repo: string, n: number, rnd: number, sha: string, f: Finding): string {
  const lines = [`The review found this in code that PR #${n} didn't change, in review ${rnd} of https://github.com/${repo}/pull/${n}, so it was filed here instead of blocking that PR.`, ''];
  if (f.file) lines.push(`- **Where:** ${where(repo, sha, f)}`);
  for (const k of ['class', 'scenario', 'cost', 'rule'] as const) if (f[k]) lines.push(`- **${k[0]!.toUpperCase()}${k.slice(1)}:** ${f[k]}`);
  return [...lines, '', `<sub>Finding ${f.id}, filed by the queue runner.</sub>`, '', followupMark(repo, n, f.id), ''].join('\n');
}

/** The open issue that already holds this finding: the app's mark for the same PR and ID, or the
 *  same title. Another runner's footer is never read: its finding IDs are its own reviews'. */
export function filedAlready(issues: OpenIssue[], repo: string, n: number, id: string, title: string): OpenIssue | undefined {
  return issues.find((i) => i.body.includes(followupMark(repo, n, id)) || i.title.trim() === title.trim());
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

/** Where the app's Review table starts and ends in the PR body. **Only the table between these is
 *  ever read or changed** (#155, It starts clean): another table, the Python runner's included, is
 *  never touched, nor anything in a fenced block. */
export const TABLE_START = '<!-- queue-runner-app review-table -->';
export const TABLE_END = '<!-- /queue-runner-app review-table -->';

/** Each line's index unless it's inside a fenced code block (```` ``` ```` or `~~~`) or is a fence. */
function outsideFences(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && m) { fence = m[1]!; out.push(false); continue; }
    if (fence !== null) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
      out.push(false);
      continue;
    }
    out.push(true);
  }
  return out;
}

/** The PR body with `row` appended to the app's Review table, the one between its markers. With
 *  no such table, one is added at the end of the `## Review` section, or, with no such section,
 *  as a new one after `## Evidence` (or at the end). */
export function withReviewRow(body: string, row: string): string {
  const lines = (body ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const open = outsideFences(lines);
  const at = (ok: (l: string) => boolean, from = 0) => { for (let j = from; j < lines.length; j++) if (open[j] && ok(lines[j]!)) return j; return null; };
  const start = at((l) => l.trim() === TABLE_START);
  const end = start === null ? null : at((l) => l.trim() === TABLE_END, start + 1);
  if (start !== null && end !== null) {
    let last = end;
    while (last > start + 1 && !lines[last - 1]!.trim()) last--;
    lines.splice(last, 0, row);
    return lines.join('\n') + '\n';
  }
  // a blank line before the end marker: GitHub ends the table there, whatever it makes of the marker
  const table = [TABLE_START, TABLE_HEAD, TABLE_RULE, row, '', TABLE_END];
  const sectionEnd = (i: number) => at((l) => /^#{1,2}\s/.test(l), i + 1) ?? lines.length;
  // blank lines around the block: a line next to a table would be read as its row
  const put = (where: number, floor: number, add: string[]) => {
    let s = where;
    while (s > floor && !lines[s - 1]!.trim()) s--;
    lines.splice(s, where - s, '', ...add, ...(where < lines.length ? [''] : []));
  };
  const r = at((l) => /^##\s+Review\s*$/.test(l));
  if (r !== null) put(sectionEnd(r), r + 1, table);
  else {
    const ev = at((l) => /^##\s+Evidence\b/.test(l));
    put(ev === null ? lines.length : sectionEnd(ev), 0, ['## Review', '', '_Rows from the review loop, one per review; each links its comment._', '', ...table]);
  }
  return lines.join('\n').replace(/^\n+/, '') + '\n';
}

export interface Poster {
  /** Files the follow-ups and posts the comment; its URL (null for a dry run). PostFailed if the
   *  comment didn't post. */
  post(repo: string, n: number, d: Decision): Promise<string | null>;
  /** What follows the comment once it's on the PR: `sol-review` on H and its Review row, unless
   *  the row is there already. Safe to call again; FinishFailed until both have landed. */
  finish(repo: string, n: number, d: Decision, url: string): Promise<void>;
}

/** Posts nothing (the live check): the comment and the decision are in the run folder. */
export class DryRunPoster implements Poster {
  private say: (line: string) => void;
  constructor(say: (line: string) => void) { this.say = say; }
  async post(repo: string, n: number): Promise<null> {
    this.say(`dry run: ${repo}#${n}'s review comment, follow-ups, sol-review status and Review row not posted`);
    return null;
  }

  async finish(repo: string, n: number): Promise<void> {
    this.say(`dry run: ${repo}#${n}'s sol-review status and Review row not posted`);
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
    return url;
  }

  async finish(repo: string, n: number, d: Decision, url: string): Promise<void> {
    const name = `review ${repo}#${n}`;
    const failed: string[] = [];
    try { // on H, the commit reviewed, whatever the PR's head is by now
      await this.gh.setStatus(repo, d.sha, STATUS_CONTEXT, d.status.state, d.status.description, url);
      this.say(`${name}: ${STATUS_CONTEXT} ${d.status.state} on ${d.sha.slice(0, 7)}`);
    } catch (e) {
      failed.push(`setting ${STATUS_CONTEXT} on ${d.sha.slice(0, 7)} failed (${(e as Error).message})`);
    }
    try { // read afresh: someone may have edited the body while the review ran
      const body = await this.gh.pullBody(repo, n);
      if (!body.includes(`[Review ${d.round}](${url})`)) { // its row isn't there already
        const next = withReviewRow(body, reviewRow(d, url, this.now()));
        await this.write('pr-body.md', next);
        await this.gh.editPullBody(repo, n, next);
      }
    } catch (e) {
      failed.push(`adding the Review row to the PR body failed (${(e as Error).message})`);
    }
    if (failed.length) throw new FinishFailed(`${failed.join('; ')}.`);
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
