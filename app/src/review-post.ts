// Posting a review, ported from `queue_runner/post.py` (#220): the review loop's automated posts on
// the repo's own PR, which need no go-ahead (`docs/flow.md`, Who runs it; A round, step 4). The
// same text, byte for byte, and the same names (snake_case, as Python has them), through the
// ported GitHub seam (`src/github-seam.ts`). Its Python cases are in `tests/test_review.py`, which
// the reviews port (#222) ports.
//
// In order: each new Pre-existing finding filed once as a `needs-triage` issue (an open issue that
// already holds it is linked instead), the review comment with those links and its ledger, the
// `sol-review` status on H (the commit reviewed, never a newer one), then the repo's own records
// (leads-dashboard: a row in the PR body's `## Review` table). The comment is the review's record:
// if it can't be posted, the review failed and nothing counts. Anything after it that fails is
// said and left; the review stands.
//
// One difference is TypeScript's only: the seam's calls are async, so `post` is.
import { writeFileSync } from 'node:fs';
import { join as path_join } from 'node:path';
import type { GhCli, Issue, PullRequest } from './github-seam.ts';
import { B_AFTER, capitalize, err_str, get, join, key, among, py_eq, py_str, S, str_only, strip, truthy, type_name, type Json } from './python.ts';
import { _cell, _where, OPEN, with_issues, type Decision, type Finding } from './review-ledger.ts';

/** A repo as posting needs it (Python's `config.Repo`): its short name, its `owner/name`, and
 *  whether its PR body keeps a `## Review` table. */
export type Repo = { readonly name: string; readonly github: string; readonly review_table: boolean };
/** What posting reads and writes on GitHub. */
export type GitHub = Pick<GhCli, 'open_issues' | 'create_issue' | 'post_comment' | 'set_status' | 'pull_body' | 'edit_pull_body'>;

export const TRIAGE = 'needs-triage';
export const OUTCOMES = { stop: 'stopped for Stefan', 'approach-note': 'approach note for Stefan',
  merge: 'to merge', fix: 'back to fix' } as const;
export const TABLE_HEAD = '| Step | Time (UTC) | Commit | Verdict |';

/** The review comment couldn't be posted: nothing is on the PR, so the review failed. */
export class PostFailed extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PostFailed';
  }
}

/** The hidden line that ties a follow-up issue to its PR and finding. */
export const followup_mark = (github: string, n: number, fid: Json): string => `<!-- sol-finding ${github}#${n} ${py_str(fid)} -->`;

export function issue_body(github: string, n: number, rnd: number, sha: string, f: Finding): string {
  const lines = [`Sol found this in code that PR #${n} didn't change, in review ${rnd} of `
    + `https://github.com/${github}/pull/${n}, so it was filed here instead of blocking `
    + 'that PR.', ''];
  if (truthy(f.file)) lines.push(`- **Where:** ${_where(github, sha, f)}`);
  for (const k of ['class', 'scenario', 'cost', 'rule']) if (truthy(get(f, k))) lines.push(`- **${capitalize(k)}:** ${py_str(f[k])}`);
  return [...lines, '', `<sub>Finding ${py_str(f.id)}, filed by the queue runner from Stefan's PC.</sub>`, '',
    followup_mark(github, n, f.id), ''].join('\n');
}

/** The open issue that already holds this finding, or null: the runner's mark, the old
 *  script's footer for the same PR and ID, or the same title. */
export function filed_already(issues: readonly Issue[], github: string, n: number, fid: Json, title: string): Issue | null {
  const old = `Finding ${str_only(fid)}, filed by sol-pr-review`;
  return issues.find((i) => i.body.includes(followup_mark(github, n, fid))
    || (i.body.includes(old) && i.body.includes(`/${github}/pull/${n}`))
    || strip(i.title) === strip(title)) ?? null;
}

const pad = (v: number, width = 2) => String(v).padStart(width, '0');
/** `{at:%Y-%m-%d %H:%M}` on a UTC time. */
const minute = (at: Date) =>
  `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;

/** The PR body's `## Review` row for this review: what it found, closed and left open. */
export function review_row(d: Decision, url: string, at: Date): string {
  const rnd = d.round, fs = d.findings;
  const ids = (ok: (f: Finding) => boolean) => join(', ', fs.filter(ok).map((f) => f.id));
  const came = new Set(d.signals.filter((s) => s.signal === 'reopened').flatMap((s) => s.ids).map(key));
  const signal = d.signals.length ? ` (${d.signals.map((s) => s.signal).join(', ')})` : '';
  const parts = [`**${capitalize(d.verdict)}**, ${OUTCOMES[d.outcome as keyof typeof OUTCOMES]}${signal}`];
  const kinds: [string, (f: Finding) => boolean][] = [
    ['raised', (f) => py_eq(f.raised, rnd) && f.tag !== 'pre-existing'],
    ['came back', (f) => came.has(key(f.id))],
    ['fixed', (f) => py_eq(get(f, 'closed'), rnd) && f.status === 'fixed'],
    ['decline accepted', (f) => py_eq(get(f, 'closed'), rnd) && f.status === 'decline-accepted'],
    ['decline kept open', (f) => among(d.kept, f.id)],
    ['filed as follow-ups', (f) => py_eq(f.raised, rnd) && f.tag === 'pre-existing'],
    ['left open', (f) => f.tag === 'important' && among(OPEN, f.status)],
  ];
  for (const [label, ok] of kinds) {
    const got = ids(ok);
    if (got) parts.push(`${label}: ${got}`);
  }
  const name = d.reviewer ? `Review ${rnd}, ${d.reviewer}` : `Sol review ${rnd}`;
  return `| [${_cell(name)}](${url}) | ${minute(at)} | \`${d.sha.slice(0, 7)}\` | ${_cell(parts.join('; '))} |`;
}

const REVIEW_SECTION = new RegExp(`^##[${S}]+Review[${S}]*$`, 'u');
const SECTION = new RegExp(`^#{1,2}[${S}]`, 'u');
const EVIDENCE = new RegExp(`^##[${S}]+Evidence${B_AFTER}`, 'u');

/** The PR body with `row` appended to its `## Review` table. A section without a table gets
 *  one; a body without the section gets it after `## Evidence` (or at the end). Rows already
 *  there stay. Ported from `~/sol-pr-review.py`. */
export function with_review_row(body: string | null, row: string): string {
  const lines = (body || '').replaceAll('\r\n', '\n').replace(/\n+$/, '').split('\n');
  const head = (pat: RegExp) => { const i = lines.findIndex((line) => pat.test(line)); return i < 0 ? null : i; };
  const end = (i: number) => { for (let j = i + 1; j < lines.length; j += 1) if (SECTION.test(lines[j]!)) return j; return lines.length; };
  const table = [TABLE_HEAD, '|---|---|---|---|', row];
  // In place of the blank lines before line `at`, one blank line either side of `add`.
  const put = (at: number, floor: number, add: string[]) => {
    let s = at;
    while (s > floor && !strip(lines[s - 1]!)) s -= 1;
    lines.splice(s, at - s, '', ...add, ...(at < lines.length ? [''] : []));
  };
  const r = head(REVIEW_SECTION);
  if (r !== null) {
    const rows: number[] = [];
    for (let j = r + 1, stop = end(r); j < stop; j += 1) if (lines[j]!.startsWith('|')) rows.push(j);
    // A table with another header (written by hand) keeps its rows; ours starts below it.
    if (rows.length && strip(lines[rows[0]!]!) === TABLE_HEAD) lines.splice(rows.at(-1)! + 1, 0, row);
    else if (rows.length) lines.splice(rows.at(-1)! + 1, 0, '', ...table);
    else put(end(r), r + 1, table);
  } else {
    const ev = head(EVIDENCE);
    put(ev === null ? lines.length : end(ev), 0,
      ['## Review', '', '_Rows from the Sol review loop, one per review; each links its comment._', '', ...table]);
  }
  return lines.join('\n').replace(/^\n+/, '') + '\n';
}

const _write = (path: string, text: string): void => writeFileSync(path, text, 'utf8');

const _utcnow = (): Date => new Date();

export class GitHubPoster {
  readonly github: GitHub;
  readonly say: (line: string) => void;
  readonly now: () => Date;

  constructor(github: GitHub, say: (line: string) => void, now: () => Date = _utcnow) {
    this.github = github;
    this.say = say;
    this.now = now;
  }

  /** Posts the review; resolves to its comment's URL. PostFailed if the comment didn't post. */
  async post(repo: Repo, pr: Pick<PullRequest, 'number'>, d: Decision, run_dir: string): Promise<string> {
    const n = pr.number, name = `review ${repo.name}#${pr.number}`;
    const [urls, failed] = await this._file(repo, pr, d, run_dir);
    const body = with_issues(d, urls, failed);
    _write(path_join(run_dir, 'comment.md'), body);
    let url: string;
    try {
      url = await this.github.post_comment(repo, n, body);
    } catch (e) {
      throw new PostFailed(`Posting the review comment failed (${type_name(e)}: ${err_str(e)}).`, { cause: e });
    }
    this.say(`${name}: posted ${url}`);
    const st = d.status;
    try {   // on H, the commit Sol reviewed, whatever the PR's head is by now
      await this.github.set_status(repo, d.sha, st.state, st.description, url);
      this.say(`${name}: sol-review ${st.state} on ${d.sha.slice(0, 7)}`);
    } catch (e) {
      this.say(`${name}: setting sol-review on ${d.sha.slice(0, 7)} failed: ${err_str(e)}`);
    }
    if (repo.review_table) {
      try {   // read afresh: someone may have edited the body while Sol ran
        const row = review_row(d, url, this.now());
        const updated = with_review_row(await this.github.pull_body(repo, n), row);
        _write(path_join(run_dir, 'pr-body.md'), updated);
        await this.github.edit_pull_body(repo, n, updated);
      } catch (e) {
        this.say(`${name}: adding the Review row to the PR body failed: ${err_str(e)}`);
      }
    }
    return url;
  }

  /** Files each new Pre-existing finding once: [{finding id: issue url}, ids that failed]. */
  async _file(repo: Repo, pr: Pick<PullRequest, 'number'>, d: Decision, run_dir: string): Promise<[Map<Json, string>, Json[]]> {
    if (!d.issues.length) return [new Map(), []];
    const n = pr.number, name = `review ${repo.name}#${pr.number}`;
    const urls = new Map<Json, string>(), failed: Json[] = [];
    let open_: Issue[];
    try {
      open_ = await this.github.open_issues(repo);
    } catch (e) {   // without the check, filing could duplicate: leave it
      this.say(`${name}: reading open issues failed, so nothing is filed: ${err_str(e)}`);
      return [new Map(), d.issues.map((i) => i.id)];
    }
    for (const i of d.issues) {
      const fid = i.id;
      const had = filed_already(open_, repo.github, n, fid, i.title);
      if (had) {
        urls.set(key(fid), had.url);
        this.say(`${name}: ${py_str(fid)} is open already as ${had.url}; not filed again`);
        continue;
      }
      const text = issue_body(repo.github, n, d.round, d.sha, i.finding);
      _write(path_join(run_dir, `followup-${str_only(fid).replace(/[^A-Za-z0-9-]/gu, '_')}.md`), text);
      try {
        urls.set(key(fid), await this.github.create_issue(repo, i.title, text, [TRIAGE]));
        this.say(`${name}: filed ${py_str(fid)} as ${urls.get(fid)}`);
      } catch (e) {
        failed.push(fid);
        this.say(`${name}: filing ${py_str(fid)} failed: ${err_str(e)}`);
      }
    }
    return [urls, failed];
  }
}
