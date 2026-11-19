// The review ledger, with no I/O (#155; today's `queue_runner/ledger.py`, ported): earlier reviews
// read from a PR's comments, and `decide`, which works out a review's verdict and outcome from the
// reviewer's `sol-findings` block, never from its prose (docs/flow.md, The review loop).
//
// A PR's state lives in its review comments. The newest one holds every finding raised so far,
// each with a status, so a review reads only the newest. **It starts clean** (#155): only the
// app's own reviews are read, by their hidden marker (`<!-- queue-runner-app review round=N
// verdict=V sha=H findings=<base64> -->`) beside a visible ledger. The Python runner's and the old
// script's (`<!-- sol-pr-review ...`) and reviews posted by hand (`<!-- sol-review ...`) are never
// read: a PR one of them reviewed gets a fresh first review from the app. They still count as the
// runner's posts, not something a person said (`runnerPost`).

const MARK = /<!-- queue-runner-app review round=(\d+) verdict=(clean|blocking) sha=([0-9a-f]+)/;
/** The hidden markers of reviews the app never reads: the Python runner's, the old script's and
 *  the hand-posted format's. */
const OTHER_REVIEWS = ['<!-- sol-pr-review', '<!-- sol-review '];
const FENCE = /^[ \t]*```+[ \t]*sol-findings[ \t]*\r?\n([\s\S]*?)^[ \t]*```+[ \t]*$/gm;
export const TAGS = { important: 'Important', nit: 'Nit', 'pre-existing': 'Pre-existing' } as const;
export type Tag = keyof typeof TAGS;
const FIELDS = ['id', 'tag', 'class', 'file', 'line', 'scenario', 'cost', 'rule'] as const;
export const MAX_NITS = 5;
/** The status the reviewer gives an earlier open finding. */
export const STATUSES = { fixed: 'Fixed', open: 'Still open', 'decline-accepted': 'Decline accepted', 'decline-kept': 'Decline kept open' } as const;
export type Status = keyof typeof STATUSES | 'filed';
export const OPEN: readonly Status[] = ['open', 'decline-kept'];
/** From this review on, a blocking review comes to the user with an approach note. */
export const APPROACH_REVIEW = 3;
/** Every comment the runner posts outside a review carries a hidden line starting with this. */
export const RUNNER_MARK = '<!-- queue-runner ';
/** Where a comment's collapsed ledger starts. */
export const LEDGER = '<details><summary>Ledger</summary>';

export type Finding = {
  id: string; tag: Tag; class: string; file: string; line: number | null;
  scenario: string; cost: string; rule: string;
  status: Status; raised: number;
  closed?: number; issue?: string; unfiled?: boolean; reopened?: Status; was?: string; again?: boolean;
};
export type Review = { round: number; verdict: 'clean' | 'blocking'; sha: string; findings: any[]; at: string };
export type Comment = { author: string; createdAt: string; body: string; path?: string | null; line?: number | null };

/** The review failed: the reply has no readable ledger, or the reviewer's run failed. */
export class ReviewFailed extends Error {}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const blocks = (body: string) => [...body.matchAll(FENCE)].map((m) => m[1]!);

// --- earlier reviews ------------------------------------------------------------------------

function markerFindings(body: string, start: number): any[] | null {
  const end = body.indexOf('-->', start);
  const field = /\bfindings=(\S*)/.exec(body.slice(start, end >= 0 ? end : body.length));
  if (!field) return [];
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(field[1]!) || field[1]!.length % 4) return null;
    const found = JSON.parse(Buffer.from(field[1]!, 'base64').toString('utf8'));
    return Array.isArray(found) ? found : null;
  } catch {
    return null;
  }
}

/** One comment's review, or null if it isn't one (or its ledger can't be read: a failed review). */
export function readReview(body: string, at = ''): Review | null {
  const m = MARK.exec(body);
  if (!m) return null;
  const found = markerFindings(body, m.index);
  if (found === null) return null;
  return { round: Number(m[1]), verdict: m[2] as Review['verdict'], sha: m[3]!, findings: found, at };
}

/** The PR's reviews by the app, oldest first, from its comments (oldest first). */
export const readReviews = (comments: Comment[]): Review[] =>
  comments.flatMap((c) => readReview(c.body ?? '', c.createdAt) ?? []);

/** A review (the app's or one it doesn't read) or anything else the runner posted: not something
 *  a person said. */
export const runnerPost = (body: string) =>
  [...OTHER_REVIEWS, RUNNER_MARK, '<!-- queue-runner-app '].some((m) => (body ?? '').includes(m));

/** Numbering carries on from the app's newest review: a PR only another runner reviewed starts at 1. */
export const nextRound = (earlier: Review[]) => 1 + Math.max(0, ...earlier.map((r) => r.round));

/** The PR's findings as its newest review left them, each with a status and the review that
 *  raised it. One with no status counts pre-existing as filed, the rest open. */
export function state(earlier: Review[]): Finding[] {
  const m = earlier.at(-1);
  if (!m) return [];
  return m.findings.filter((f) => isObj(f) && f.id && f.tag in TAGS).map((f) => ({
    id: '', tag: 'nit', class: '', file: '', line: null, scenario: '', cost: '', rule: '', ...f,
    status: f.status || (f.tag === 'pre-existing' ? 'filed' : 'open'),
    raised: f.raised || m.round,
  }) as Finding);
}

/** A class name as reviews compare it: lower case, words only. */
export const norm = (c: string) => ((c ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

// --- the reviewer's reply ---------------------------------------------------------------------

function block(reply: string): unknown {
  const all = blocks(reply);
  if (!all.length) throw new ReviewFailed("The reply has no ```sol-findings block, so it can't be read as clean or blocking.");
  try {
    return JSON.parse(all.at(-1)!);
  } catch (e) {
    throw new ReviewFailed(`The sol-findings block isn't valid JSON (${(e as Error).message}).`);
  }
}

type Raw = { id: string; tag: string; class: string; file: string; line: number | null; scenario: string; cost: string; rule: string };

/** The reply's last sol-findings block as findings, and the reply without the block. */
export function parseFindings(reply: string): [Raw[], string] {
  const data = block(reply);
  const items = isObj(data) ? data.findings : null;
  if (!Array.isArray(items) || !items.every(isObj)) throw new ReviewFailed('The sol-findings block has no "findings" list of objects.');
  const found: Raw[] = [];
  items.forEach((f, i) => {
    const g = Object.fromEntries(FIELDS.map((k) => [k, text(f[k])])) as Record<(typeof FIELDS)[number], string>;
    let tag = g.tag.toLowerCase().replace(/[\s_]+/g, '-');
    if (tag === 'preexisting') tag = 'pre-existing';
    if (!g.id) throw new ReviewFailed(`Finding ${i + 1} in the sol-findings block has no id.`);
    if (!(tag in TAGS)) throw new ReviewFailed(`Finding ${g.id} has tag "${f.tag}", not one of ${Object.keys(TAGS).join(', ')}.`);
    if (found.some((h) => h.id === g.id)) throw new ReviewFailed(`Two findings have the id ${g.id}.`);
    const m = /^L?(\d+)/.exec(g.line);
    found.push({ ...g, tag, line: m && Number(m[1]) > 0 ? Number(m[1]) : null });
  });
  return [found, reply.replace(FENCE, '').trim()];
}

/** The status the reviewer gave each earlier finding, from the block's "earlier" list. */
export function parseEarlier(reply: string): Map<string, Status> {
  const data = block(reply);
  const items = isObj(data) ? data.earlier : undefined;
  const given = new Map<string, Status>();
  if (items === undefined || items === null) return given;
  if (!Array.isArray(items) || !items.every(isObj)) throw new ReviewFailed('The sol-findings block has an "earlier" that isn\'t a list of objects.');
  items.forEach((e, i) => {
    const id = text(e.id);
    let s = text(e.status).toLowerCase().replace(/[\s_]+/g, '-');
    s = ({ 'still-open': 'open', 'decline-kept-open': 'decline-kept' } as Record<string, string>)[s] ?? s;
    if (!id) throw new ReviewFailed(`Entry ${i + 1} in the block's "earlier" list has no id.`);
    if (!(s in STATUSES)) throw new ReviewFailed(`Earlier finding ${id} has status "${e.status}", not one of ${Object.keys(STATUSES).join(', ')}.`);
    if (given.has(id)) throw new ReviewFailed(`Earlier finding ${id} has two statuses.`);
    given.set(id, s as Status);
  });
  return given;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const root = (p: string) => escape(p.replace(/\\/g, '/')).replace(/\//g, '[/\\\\]') + '[/\\\\]';

/** A finding's file as a repo-relative path, and its line if the reviewer put it on the path. */
export function repoPath(file: string, line: number | null, roots: string[] = []): [string, number | null] {
  file = file.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:)/, '');
  for (const r of roots) file = file.replace(new RegExp('^' + root(r), 'i'), '');
  const m = /^(.+?):L?(\d+)(?:-\d+)?$/.exec(file);
  if (m) return [m[1]!, line || Number(m[2])];
  return [file, line];
}

/** What an Important finding needs to block: file and line, and a scenario or a cost and rule. */
export const evidence = (f: Raw) => Boolean(f.file && f.line && (f.scenario || (f.cost && f.rule)));

// --- the comment ------------------------------------------------------------------------------

export const cell = (s: string) => String(s).replace(/\|/g, '\\|').replace(/\r/g, '').replace(/\n/g, ' ');

export function where(repo: string, sha: string, f: { file: string; line: number | null }): string {
  if (!f.file) return '';
  const at = f.line ? `${f.file}:${f.line}` : f.file;
  return `[\`${cell(at)}\`](https://github.com/${repo}/blob/${sha}/${encodeURI(f.file)}${f.line ? `#L${f.line})` : ')'}`;
}

/** Local paths cited in the reply, made GitHub's: a link into the checkout points at H, a link
 *  into the run folder becomes its text, and bare paths lose the prefix. */
export function githubLinks(prose: string, wt: string, runDir: string, repo: string, sha: string): string {
  prose = prose.replace(new RegExp(`\\[([^\\]]*)\\]\\(${root(wt)}([^):]+)(?::(\\d+))?\\)`, 'gi'),
    (_, label, path, line) => `[${label}](https://github.com/${repo}/blob/${sha}/${path.replace(/\\/g, '/')}${line ? `#L${line})` : ')'}`);
  prose = prose.replace(new RegExp(`\\[([^\\]]*)\\]\\(${root(runDir)}[^)]*\\)`, 'gi'), '$1');
  return prose.replace(new RegExp(`${root(wt)}|${root(runDir)}`, 'gi'), '');
}

export function mark(rnd: number, verdict: string, sha: string, findings: Finding[]): string {
  const data = Buffer.from(JSON.stringify(findings), 'utf8').toString('base64');
  return `<!-- queue-runner-app review round=${rnd} verdict=${verdict} sha=${sha} findings=${data} -->`;
}

export const ledgerBlock = (rnd: number, verdict: string, sha: string, findings: Finding[]) =>
  '```sol-findings\n' + JSON.stringify({ round: rnd, head: sha, verdict, findings }, null, 1) + '\n```';

export function issueTitle(f: Finding): string {
  let t = f.class || f.scenario || f.cost || 'Pre-existing problem';
  t = t.length > 90 ? `${t.slice(0, 90)}…` : t;
  return f.file ? `${t} (${f.file})` : t;
}

const trailer = (rnd: number, verdict: string, sha: string, findings: Finding[]) =>
  `${LEDGER}\n\n${ledgerBlock(rnd, verdict, sha, findings)}\n\n</details>\n\n${mark(rnd, verdict, sha, findings)}\n`;

// --- decide -----------------------------------------------------------------------------------

export type Outcome = 'stop' | 'approach-note' | 'merge' | 'fix';
export type Signal = { signal: 'repeated-class' | 'reopened' | 'decline-kept'; ids: string[]; text: string };
export type Decision = {
  round: number; sha: string; verdict: 'clean' | 'blocking'; outcome: Outcome; signals: Signal[];
  findings: Finding[]; kept: string[]; unaddressed: string[];
  status: { state: 'success' | 'failure'; description: string };
  issues: { id: string; title: string; finding: Finding }[];
  body: string; reviewer: string;
};

export type DecideInput = {
  /** `owner/name`. */
  repo: string; sha: string; round: number; earlier: Review[]; hasReviewMd: boolean; reply: string;
  /** The checkout and the run folder: the local folders the reply's paths start with. */
  wt?: string; runDir?: string;
  /** The last reviewed commit isn't in H's history (a force-push): the whole diff was read. */
  gone?: boolean;
  /** Who reviewed, as the comment, the status and the Review row name it. */
  reviewer: string;
  /** Who posts, for the byline: "Posted by the queue runner from <user>'s PC". */
  user: string;
};

/** Everything a review decides, from the PR's earlier reviews and the reply. An unreadable
 *  reply throws ReviewFailed. */
export function decide(i: DecideInput): Decision {
  const { repo, sha, round: rnd, earlier, reviewer } = i;
  const [raw, prose] = parseFindings(i.reply);
  const given = parseEarlier(i.reply);
  const notes: string[] = [];
  const last = earlier.at(-1)?.sha ?? null;
  if (i.gone) {
    notes.push(`The last reviewed commit${last ? `, ${last.slice(0, 7)},` : ''} isn't in this branch's history any more (a force-push), so this review read the PR's whole diff, not only the change since.`);
  }
  const roots = [i.wt, i.runDir].filter((r): r is string => Boolean(r));
  const found: Finding[] = raw.map((f) => {
    const [file, line] = repoPath(f.file, f.line, roots);
    const g = { ...f, file, line };
    const down = g.tag === 'important' && !evidence(g);
    return { ...g, tag: (down ? 'nit' : g.tag) as Tag, ...(down ? { was: 'important' } : {}), status: 'open', raised: rnd };
  });
  const down = found.filter((f) => f.was).map((f) => f.id);
  if (down.length) {
    const one = down.length === 1;
    notes.push(`${down.join(', ')} ${one ? 'was' : 'were'} tagged Important without a file and line plus a failure scenario, or a later cost and the rule it breaks, so ${one ? 'it counts' : 'they count'} as a nit.`);
  }
  // An unchanged finding isn't reposted as new: a new ID with the same tag, class, file and line
  // as one still open (or filed), given no status, is that finding.
  const prior = state(earlier);
  const ids = new Set(found.map((f) => f.id));
  const same: string[] = [];
  for (const f of found) {
    if (prior.some((p) => p.id === f.id)) continue;
    const p = prior.find((p) => [...OPEN, 'filed'].includes(p.status) && !ids.has(p.id) && !given.has(p.id)
      && p.tag === f.tag && norm(p.class) && p.file
      && norm(p.class) === norm(f.class) && p.file === f.file && p.line === f.line);
    if (p) {
      same.push(`${f.id} is ${p.id}`);
      ids.add(p.id);
      f.id = p.id;
    }
  }
  if (same.length) notes.push(`Listed again under a new ID, with the same tag, class, file and line, so each keeps its earlier ID: ${same.join('; ')}.`);
  const over = found.filter((f) => f.tag === 'nit').map((f) => f.id).slice(MAX_NITS);
  let kept_ = found;
  if (over.length) {
    kept_ = found.filter((f) => !over.includes(f.id));
    notes.push(`Nits past the first ${MAX_NITS} are left out: ${over.join(', ')}.`);
  }
  const fnd = kept_;
  // Filed already: every earlier Pre-existing finding but one whose filing failed.
  const filed = new Set(earlier.flatMap((m) => m.findings).filter((f) => isObj(f) && f.tag === 'pre-existing' && !f.unfiled).map((f) => f.id));
  const pre = fnd.filter((f) => f.tag === 'pre-existing');
  const again = pre.filter((f) => filed.has(f.id)).map((f) => f.id);
  if (again.length) notes.push(`Already filed after an earlier review, so not filed again: ${again.join(', ')}.`);

  // Carry the state forward.
  const before = new Map(prior.map((f) => [f.id, f]));
  const fresh = new Map(fnd.map((f) => [f.id, f]));
  for (const f of fnd) {
    const p = before.get(f.id);
    f.status = f.tag === 'pre-existing' ? 'filed' : 'open';
    f.raised = p ? p.raised : rnd;
    if (p?.issue) f.issue = p.issue;
    if (p && (p.status === 'fixed' || p.status === 'decline-accepted')) f.reopened = p.status;
  }
  const asked = prior.filter((f) => OPEN.includes(f.status) && !fresh.has(f.id)).map((f) => f.id);
  const unaddressed = asked.filter((id) => !given.has(id));
  const rows: Finding[] = [];
  const now: Finding[] = [];
  for (const p of prior) {
    const n = fresh.get(p.id);
    if (n) {
      now.push(n);
      if ([...OPEN, 'filed'].includes(p.status)) rows.push({ ...n, again: true });
      continue;
    }
    const q = { ...p };
    if (asked.includes(p.id)) {
      if (given.has(p.id)) {
        q.status = given.get(p.id)!;
        if (!OPEN.includes(q.status)) q.closed = rnd;
      }
      rows.push(q);
    }
    now.push(q);
  }
  now.push(...fnd.filter((f) => !before.has(f.id)));
  const kept = rows.filter((f) => given.has(f.id) && f.status === 'decline-kept').map((f) => f.id);
  const back = fnd.filter((f) => f.reopened);
  const closedIn = (id: string) => before.get(id)?.closed ?? '?';
  const label = (s: Status) => (STATUSES as Record<string, string>)[s]!.toLowerCase();
  if (back.length) notes.push(`Raised again after closing in an earlier review: ${back.map((f) => `${f.id} (${label(f.reopened!)} in review ${closedIn(f.id)})`).join(', ')}.`);
  if (unaddressed.length) {
    const one = unaddressed.length === 1;
    notes.push(`The reviewer didn't address ${unaddressed.join(', ')}: it gave no status, so ${one ? 'it stays' : 'they stay'} open.`);
  }
  const stray = [...given.keys()].filter((id) => !asked.includes(id));
  if (stray.length) notes.push(`Statuses for ${stray.join(', ')} were ignored: not an earlier open finding, or listed again as a finding.`);

  const important = now.filter((f) => f.tag === 'important' && OPEN.includes(f.status)).map((f) => f.id);
  const verdict = important.length ? 'blocking' : 'clean';

  const seen = new Map<string, Finding>();
  for (const p of prior) if (p.tag === 'important' && norm(p.class) && !seen.has(norm(p.class))) seen.set(norm(p.class), p);
  const signals: Signal[] = [];
  const rep = fnd.filter((f) => !before.has(f.id) && f.tag === 'important' && seen.has(norm(f.class)));
  if (rep.length) {
    signals.push({ signal: 'repeated-class', ids: rep.map((f) => f.id), text: rep.map((f) => {
      const p = seen.get(norm(f.class))!;
      return `${f.id} repeats the class "${p.class}" of ${p.id}, raised in review ${p.raised}`;
    }).join('; ') });
  }
  if (back.length) {
    signals.push({ signal: 'reopened', ids: back.map((f) => f.id), text: back.map((f) => `${f.id} came back after it was ${label(f.reopened!)} in review ${closedIn(f.id)}`).join('; ') });
  }
  if (kept.length) signals.push({ signal: 'decline-kept', ids: kept, text: `The reviewer kept the decline of ${kept.join(', ')} open` });
  const outcome: Outcome = signals.length ? 'stop' : important.length && rnd >= APPROACH_REVIEW ? 'approach-note' : important.length ? 'fix' : 'merge';
  notes.push('**Next:** ' + {
    stop: `the loop stops here for ${i.user}: ${signals.map((s) => s.text).join('; ')}.`,
    'approach-note': `review ${rnd} is still blocking, so an approach note goes to ${i.user} instead of a fix round.`,
    merge: `the PR merges once its checks pass on ${sha.slice(0, 7)}.`,
    fix: "back to a fix round: fix every case of each Important finding's class, or decline it with the test that wouldn't fail.",
  }[outcome]);

  const nits = now.filter((f) => f.tag === 'nit' && OPEN.includes(f.status)).length;
  const desc = `${reviewer}: ` + (important.length
    ? `Blocking: ${important.length} Important finding${important.length !== 1 ? 's' : ''} (${important.join(', ')})`
    : `Clean: no Important finding, ${nits} nit${nits !== 1 ? 's' : ''}`);
  const newOnes = fnd.filter((f) => !(before.has(f.id) && [...OPEN, 'filed'].includes(before.get(f.id)!.status)));
  const table = !newOnes.length ? (earlier.length ? 'No new findings.' : 'No findings.')
    : '| ID | Tag | Class | Where |\n|---|---|---|---|\n' + newOnes.map((f) => `| ${cell(f.id)} | ${TAGS[f.tag]} | ${cell(f.class)} | ${where(repo, sha, f)} |\n`).join('');
  const rowLabel = (f: Finding) => f.again
    ? `${f.status === 'filed' ? 'Filed already' : 'Still open'} (listed again)`
    : (STATUSES as Record<string, string>)[f.status]! + (given.has(f.id) ? '' : ' (the reviewer gave no status)');
  const old = !rows.length ? '' : '### Earlier findings\n\n| ID | Tag | Class | Where | Now |\n|---|---|---|---|---|\n'
    + rows.map((f) => `| ${cell(f.id)} | ${TAGS[f.tag]} | ${cell(f.class)} | ${where(repo, sha, f)} | ${rowLabel(f)} |\n`).join('') + '\n';
  const guide = i.hasReviewMd ? ", with the repo's REVIEW.md" : '';
  const scope = last && !i.gone ? `, the change since ${last.slice(0, 7)}` : '';
  const body_ = i.wt && i.runDir ? githubLinks(prose, i.wt, i.runDir, repo, sha) : prose;
  // The heading keeps its `## Sol review N · V` start: the `sol-*` names stay until #171.
  const body = `## Sol review ${rnd} · ${verdict[0]!.toUpperCase()}${verdict.slice(1)} · ${reviewer}\n\n`
    + `<sub>Reviewed by ${reviewer} in a T3 thread, on ${sha.slice(0, 7)}${scope}${guide}. Posted by the queue runner from ${i.user}'s PC.</sub>\n\n`
    + `${body_}\n\n${old}### Findings\n\n${table.trimEnd()}\n\n`
    + notes.map((s) => `${s}\n\n`).join('')
    + trailer(rnd, verdict, sha, now);
  const issues = [...pre.filter((f) => !filed.has(f.id)), ...now.filter((f) => f.unfiled && !fresh.has(f.id))]
    .map((f) => ({ id: f.id, title: issueTitle(f), finding: f }));
  return {
    round: rnd, sha, verdict, outcome, signals, findings: now, kept, unaddressed,
    status: { state: important.length ? 'failure' : 'success', description: desc.slice(0, 140) },
    issues, body, reviewer,
  };
}

/** The comment with each filed Pre-existing finding's issue linked and its URL recorded in the
 *  ledger and the marker (`issue`), so no later review files it again. One whose filing failed
 *  is marked `unfiled`, so the next review files it. */
export function withIssues(d: Decision, urls: Map<string, string>, failed: string[] = []): string {
  if (!urls.size && !failed.length) return d.body;
  for (const f of d.findings) {
    if (urls.has(f.id)) {
      f.issue = urls.get(f.id);
      delete f.unfiled;
    } else if (failed.includes(f.id)) f.unfiled = true;
  }
  let said = '';
  if (urls.size) {
    said += `Filed as follow-up issues: ${[...urls].map(([id, url]) => `${id} → [#${url.replace(/\/+$/, '').split('/').at(-1)}](${url})`).join(', ')}.\n\n`;
  }
  if (failed.length) {
    const one = failed.length === 1;
    said += `Filing ${failed.join(', ')} as ${one ? 'a follow-up issue' : 'follow-up issues'} failed; the next review files ${one ? 'it' : 'them'}.\n\n`;
  }
  return d.body.slice(0, d.body.lastIndexOf(LEDGER)) + said + trailer(d.round, d.verdict, d.sha, d.findings);
}
