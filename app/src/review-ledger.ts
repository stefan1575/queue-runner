// The review ledger, with no I/O, ported from `queue_runner/ledger.py` (#220): earlier reviews read
// from a PR's comments, and `decide`, which works out a review's verdict and outcome from Sol's
// sol-findings block, never from its prose. The same markers, ledgers and comment text, byte for
// byte, and the same names (snake_case, as Python has them), with `tests/test_ledger.py` ported
// case for case in `test/review-ledger.test.ts`, so a PR the Python runner reviewed reads the same
// here. `docs/flow.md`, The review loop, defines the words and the loop; a served repo's
// `REVIEW.md`, if it has one, what to report.
//
// A PR's state lives in its review comments. The newest one holds every finding raised so far,
// each with a status, so a review reads only the newest. Three formats are read:
// - the old script's and the runner's hidden marker,
//   `<!-- sol-pr-review round=N verdict=V sha=H findings=<base64 JSON> ... -->`;
// - a review Sol posted itself from a T3 child (2026-11-06, leads-dashboard #168):
//   `<!-- sol-review round=N head=H -->`, its verdict in the `## Sol review N · V` heading and its
//   findings in the comment's visible sol-findings block.
// The runner's own comments carry both the marker and a visible sol-findings ledger.
//
// The differences are TypeScript's only. Python's regex classes, `^` and `$`, `==`, hashing,
// `str()` and `strip()` are spelled out (`src/python.ts`), so the patterns match and the text
// comes out as Python's. JSON is JavaScript's: a number past 2^53 loses digits, a float like `10.0`
// reads as the int 10, `NaN` and `Infinity` don't parse, and an invalid block's error names
// JavaScript's reason. A finding is a plain object whose keys keep Python's insertion order.
import { quote, type Comment } from './github-seam.ts';
import {
  among, B_AFTER, B_BEFORE, BOL, capitalize, D, EOL, get, has, head, int, is_dict, join, key, len, or, py_eq, py_str,
  rstrip, S, str_only, strip, truthy, type Json,
} from './python.ts';

export const MARK = new RegExp(String.raw`<!-- sol-pr-review round=([${D}]+) verdict=(clean|blocking)(?: sha=([0-9a-f]+))?`, 'u');
export const HAND_MARK = new RegExp(String.raw`<!-- sol-review round=([${D}]+) head=([0-9a-f]{7,40}) -->`, 'u');
export const HEADING = new RegExp(String.raw`${BOL}## Sol review ([${D}]+)[${S}]*[^${S}][${S}]*(Clean|Blocking)${B_AFTER}`, 'iu');
export const FENCE = new RegExp(`${BOL}[ \\t]*` + '```+' + `[ \\t]*sol-findings[ \\t]*\\r?\\n([\\s\\S]*?)${BOL}[ \\t]*` + '```+'
  + `[ \\t]*${EOL}`, 'gu');
export const TAGS = { important: 'Important', nit: 'Nit', 'pre-existing': 'Pre-existing' } as const;
export const FIELDS = ['id', 'tag', 'class', 'file', 'line', 'scenario', 'cost', 'rule'] as const;
export const MAX_NITS = 5;
// A finding's status. Sol gives an earlier open finding one of STATUSES; a new finding is open,
// or filed when pre-existing. decline-kept stays apart from open: it goes to Stefan.
export const STATUSES = { fixed: 'Fixed', open: 'Still open', 'decline-accepted': 'Decline accepted',
  'decline-kept': 'Decline kept open' } as const;
export const OPEN = ['open', 'decline-kept'] as const;
const OPEN_OR_FILED = [...OPEN, 'filed'];
const CLOSED = ['fixed', 'decline-accepted'];
// From this review on, a blocking review comes to Stefan with an approach note, not a fix round
// (docs/flow.md: no fourth review without his answer). The old script did it at review 3 only,
// with its spend guard behind it; with that guard gone, every later blocking review does too.
export const APPROACH_REVIEW = 3;
// Every comment the runner posts outside a review carries a hidden line starting with this: the
// runner's own post, never a reply from Stefan, though it's on his account.
export const RUNNER_MARK = '<!-- queue-runner ';
// The hidden line on the runner's comment recording a stop on a PR (`stops.py`).
export const STOP_MARK = RUNNER_MARK + 'stop ';
// Where a comment's collapsed ledger starts: everything after it is the ledger and the marker.
export const LEDGER = '<details><summary>Ledger</summary>';
// The comment's byline: who reviewed. GitHub-facing text, kept as Python has it (docs/app.md, Rules).
const SOL_BYLINE = 'GPT-6.2 Sol at effort high, read-only';
const FALLBACK_BYLINE = "Claude reviewed in Sol's place, in a T3 thread, from the same brief";

/** A finding as a ledger holds it: Python's dict, its keys in the order they were set. */
export type Finding = Record<string, Json>;
/** One comment's review (`read_review`). `sha` is null on an old marker that has none. */
export type Review = { round: number; verdict: string; sha: string | null; findings: Json[]; at: string };
export type Signal = { signal: string; ids: Json[]; text: string };
export type Decision = {
  round: number; sha: string; verdict: string; outcome: string; signals: Signal[]; findings: Finding[];
  kept: Json[]; unaddressed: Json[]; status: { state: string; description: string };
  issues: { id: Json; title: string; finding: Finding }[]; body: string; reviewer: string | null;
};

/** The review failed: Sol's reply has no readable ledger, or Sol's run failed. */
export class SolFailed extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SolFailed';
  }
}

const _text = (v: Json): string => (v === null || v === undefined ? '' : strip(py_str(v)));
const findall = (body: string): string[] => [...body.matchAll(FENCE)].map((m) => m[1]!);

// --- earlier reviews ----------------------------------------------------------------------------

const FINDINGS_FIELD = new RegExp(`${B_BEFORE}findings=([^${S}]*)`, 'u');

/** `base64.b64decode(s, validate=True)`: only the alphabet, then at most two `=`; data one past a
 *  multiple of four, or two or three past without the padding Python's decoder needs, raises. */
function b64decode(s: string): Buffer {
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(s);
  if (!m) throw new Error('Non-base64 digit found');
  const rest = m[1]!.length % 4, pads = m[2]!.length;
  if (rest === 1 || (rest === 2 && pads < 2) || (rest === 3 && pads < 1)) throw new Error('Incorrect padding');
  return Buffer.from(m[1]!, 'base64');
}

/** `json.loads` on UTF-8 bytes: a leading BOM is dropped, and bytes that aren't UTF-8 raise. */
const json_bytes = (b: Buffer): Json => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));

/** The marker's base64 findings, or null if they can't be read. A marker with no findings
 *  field holds none: the old script's markers before 2026-11-05 (leads-dashboard #139) end at
 *  `sha=`. An empty field is never written (the runner and the old script write `W10=` for no
 *  findings), so it can't be read. */
function _marker_findings(body: string, start: number): Json[] | null {
  const end = body.indexOf('-->', start);
  const field = FINDINGS_FIELD.exec(body.slice(start, end >= 0 ? end : body.length));
  if (!field) return [];
  let found: Json;
  try {
    found = json_bytes(b64decode(field[1]!));
  } catch {
    return null;
  }
  return Array.isArray(found) ? found : null;
}

/** The findings in a comment's last sol-findings block; null if there's no readable one. */
function _visible_findings(body: string): Finding[] | null {
  const blocks = findall(body);
  let data: Json;
  try {
    data = blocks.length ? JSON.parse(blocks.at(-1)!) : null;
  } catch {
    return null;
  }
  const found = is_dict(data) ? get(data, 'findings') : null;
  return Array.isArray(found) ? found.filter(is_dict) : null;
}

/** One comment's review: {round, verdict, sha, findings, at}, or null if it isn't one. A
 *  review whose ledger can't be read isn't one: it failed, so it isn't counted and doesn't
 *  replace the PR's state (docs/flow.md). */
export function read_review(body: string, at = ''): Review | null {
  let m = MARK.exec(body);
  if (m) {
    const found = _marker_findings(body, m.index);
    if (found === null) return null;
    return { round: int(m[1]!), verdict: m[2]!, sha: m[3] ?? null, findings: found, at };
  }
  m = HAND_MARK.exec(body);
  if (m) {
    const h = HEADING.exec(body);
    const rnd = int(m[1]!);
    const visible = _visible_findings(body);
    if (visible === null) return null;
    const found = visible.map((f) => ({ ...f, raised: or(get(f, 'raised'), rnd) }));
    const verdict = h ? h[2]!.toLowerCase() : (
      found.some((f) => get(f, 'tag') === 'important' && among(OPEN, get(f, 'status', 'open'))) ? 'blocking' : 'clean');
    return { round: rnd, verdict, sha: m[2]!, findings: found, at };
  }
  return null;
}

/** The PR's reviews, oldest first, from its comments (`Comment`s, oldest first). */
export const read_reviews = (comments: readonly Comment[]): Review[] =>
  comments.flatMap((c) => { const r = read_review(c.body || '', c.created_at); return r ? [r] : []; });

/** The PR's newest review, if it's on `sha` with this verdict: no later review has
 *  replaced the one the runner acts on. */
export function newest_on(comments: readonly Comment[], sha: string, verdict: string): Review | null {
  const reviews = read_reviews(comments);
  const last = reviews.at(-1) ?? null;
  if (last && last.sha && sha.startsWith(last.sha) && last.verdict === verdict) return last;
  return null;
}

/** A review (any format), or a stop, an Approach note or anything else the runner posted:
 *  not something a person said. */
export function runner_post(body: string | null): boolean {
  const b = body || '';
  return read_review(b) !== null || b.includes('<!-- sol-pr-review') || b.includes(RUNNER_MARK);
}

/** What people said on the PR after `at` (GitHub's UTC time): bots and the runner's own
 *  reviews and stop records left out. */
export const said_since = (comments: readonly Comment[], at: string): Comment[] =>
  comments.filter((c) => c.created_at > at && !c.author.endsWith('[bot]') && !runner_post(c.body));

/** Reviews the old script posted count: numbering carries on from the newest. */
export const next_round = (earlier: readonly Review[]): number => 1 + Math.max(0, ...earlier.map((r) => r.round));

/** The PR's findings as its newest review left them, each with a status and the review that
 *  raised it. A marker from before statuses existed counts pre-existing as filed, the rest open. */
export function state(earlier: readonly Review[]): Finding[] {
  if (!earlier.length) return [];
  const m = earlier.at(-1)!;
  return m.findings.filter((f) => is_dict(f) && truthy(get(f, 'id')) && has(TAGS, get(f, 'tag'))).map((f) => ({
    ...Object.fromEntries(FIELDS.map((k) => [k, ''])), line: null, ...f,
    status: or(get(f, 'status'), get(f, 'tag') === 'pre-existing' ? 'filed' : 'open'),
    raised: or(get(f, 'raised'), m.round),
  }));
}

/** Why the newest of the PR's reviews (read_reviews()) went to Stefan rather than to a fix
 *  round, read from the ledgers alone, as decide() would have said: a kept decline, a closed
 *  finding reopened, a new Important finding in an earlier class, or review 3 or later still
 *  blocking (an Approach note). null if it only says fix. */
export function escalation(reviews: readonly Review[]): string | null {
  if (!reviews.length) return null;
  const now = state(reviews);
  const before = new Map(state(reviews.slice(0, -1)).map((f) => [key(f.id), f]));
  const rnd = reviews.at(-1)!.round;
  const important = now.filter((f) => f.tag === 'important' && among(OPEN, f.status));
  const kept = now.filter((f) => f.status === 'decline-kept').map((f) => f.id);
  if (kept.length) return `a decline kept open (${join(', ', kept)})`;
  const back = now.filter((f) => among(OPEN, f.status) && (truthy(get(f, 'reopened'))
    || (before.has(key(f.id)) && among(CLOSED, before.get(f.id)!.status)))).map((f) => f.id);
  if (back.length) return `a finding reopened (${join(', ', back)})`;
  const seen = new Set([...before.values()].filter((p) => p.tag === 'important' && truthy(norm(p.class))).map((p) => norm(p.class)));
  const rep = important.filter((f) => !before.has(key(f.id)) && seen.has(norm(f.class))).map((f) => f.id);
  if (rep.length) return `an earlier class repeated (${join(', ', rep)})`;
  if (important.length && rnd >= APPROACH_REVIEW) return `review ${rnd} still blocking (an Approach note)`;
  return null;
}

/** A class name as reviews compare it: lower case, words only. */
export function norm(c: Json): string {
  const s = or(c, '');
  if (typeof s !== 'string') throw new TypeError(`'${typeof s}' object has no attribute 'lower'`);
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}

// --- Sol's reply ----------------------------------------------------------------------------------

function _block(reply: string): Json {
  const blocks = findall(reply);
  if (!blocks.length) {
    throw new SolFailed("Sol's reply has no ```sol-findings block, so it can't be read as clean or blocking.");
  }
  try {
    return JSON.parse(blocks.at(-1)!);
  } catch (e) {
    throw new SolFailed(`Sol's sol-findings block isn't valid JSON (${(e as Error).message}).`);
  }
}

const SPACES = new RegExp(`[${S}_]+`, 'gu');
const LINE = new RegExp(`^L?([${D}]+)`, 'u');

/** Sol's last sol-findings block as normalised findings, and the reply without the block. */
export function parse_findings(reply: string): [Finding[], string] {
  const data = _block(reply);
  const items = is_dict(data) ? get(data, 'findings') : null;
  if (!Array.isArray(items) || !items.every(is_dict)) {
    throw new SolFailed(`Sol's sol-findings block has no "findings" list of objects.`);
  }
  const found: Finding[] = [];
  items.forEach((f, i) => {
    const g: Finding = Object.fromEntries(FIELDS.map((k) => [k, _text(get(f, k))]));
    const tag = g.tag.toLowerCase().replace(SPACES, '-');
    g.tag = tag === 'preexisting' ? 'pre-existing' : tag;
    if (!g.id) throw new SolFailed(`Finding ${i + 1} in Sol's sol-findings block has no id.`);
    if (!has(TAGS, g.tag)) {
      throw new SolFailed(`Finding ${g.id} has tag "${py_str(get(f, 'tag'))}", not one of ${Object.keys(TAGS).join(', ')}.`);
    }
    if (found.some((h) => h.id === g.id)) throw new SolFailed(`Two findings have the id ${g.id}.`);
    const m = LINE.exec(g.line);
    g.line = m && int(m[1]!) > 0 ? int(m[1]!) : null;
    found.push(g);
  });
  return [found, strip(reply.replace(FENCE, ''))];
}

/** The status Sol gave each earlier finding, from the block's "earlier" list: {id: status}. */
export function parse_earlier(reply: string): Map<string, string> {
  const data = _block(reply);
  const items = is_dict(data) ? get(data, 'earlier') : null;
  const given = new Map<string, string>();
  if (items === null) return given;
  if (!Array.isArray(items) || !items.every(is_dict)) {
    throw new SolFailed(`Sol's sol-findings block has an "earlier" that isn't a list of objects.`);
  }
  items.forEach((e, i) => {
    const fid = _text(get(e, 'id'));
    let s = _text(get(e, 'status')).toLowerCase().replace(SPACES, '-');
    s = ({ 'still-open': 'open', 'decline-kept-open': 'decline-kept' } as Record<string, string>)[s] ?? s;
    if (!fid) throw new SolFailed(`Entry ${i + 1} in the block's "earlier" list has no id.`);
    if (!has(STATUSES, s)) {
      throw new SolFailed(`Earlier finding ${fid} has status "${py_str(get(e, 'status'))}", not one of ${Object.keys(STATUSES).join(', ')}.`);
    }
    if (given.has(fid)) throw new SolFailed(`Earlier finding ${fid} has two statuses.`);
    given.set(fid, s);
  });
  return given;
}

/** `re.escape`, for a pattern with the `u` flag (which refuses escapes of other characters). */
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const _root = (p: string) => escape(String(p).replaceAll('\\', '/')).replaceAll('/', String.raw`[/\\]`) + String.raw`[/\\]`;
const AT_LINE = new RegExp(`^([^\\n]+?):L?([${D}]+)(?:-[${D}]+)?$`, 'u');

/** A finding's file as a repo-relative path, and its line if Sol put it on the path. */
export function repo_path(file: string, line: number | null, roots: readonly string[] = []): [string, number | null] {
  file = file.replaceAll('\\', '/').replace(/^\/(?=[A-Za-z]:)/, '');
  for (const r of roots) file = file.replace(new RegExp('^' + _root(r), 'iu'), '');
  const m = AT_LINE.exec(file);
  if (m) [file, line] = [m[1]!, or(line, int(m[2]!))];
  return [file, line];
}

/** What an Important finding needs to block: file and line, and a scenario or a cost and rule. */
export const evidence = (f: Finding): boolean =>
  truthy(f.file) && truthy(f.line) && (truthy(f.scenario) || (truthy(f.cost) && truthy(f.rule)));

// --- the comment ------------------------------------------------------------------------------------

export const _cell = (s: Json): string => py_str(s).replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ');

export function _where(repo: string, sha: string, f: Finding): string {
  if (!truthy(f.file)) return '';
  const at = truthy(f.line) ? `${py_str(f.file)}:${py_str(f.line)}` : f.file;
  return `[\`${_cell(at)}\`](https://github.com/${repo}/blob/${sha}/${quote(str_only(f.file))}`
    + (truthy(f.line) ? `#L${py_str(f.line)})` : ')');
}

/** Sol cites local paths. On GitHub a link into the checkout points at H; a link into the run
 *  folder (the diff, the issue) becomes its plain text; bare paths lose the prefix. */
export function github_links(text: string, wt: string, rundir: string, repo: string, sha: string): string {
  const to_head = (_: string, label: string, path: string, line: string | undefined) =>
    `[${label}](https://github.com/${repo}/blob/${sha}/${path.replaceAll('\\', '/')}` + (line ? `#L${line})` : ')');
  text = text.replace(new RegExp(String.raw`\[([^\]]*)\]\(` + _root(wt) + String.raw`([^):]+)(?::([${D}]+))?\)`, 'giu'), to_head);
  text = text.replace(new RegExp(String.raw`\[([^\]]*)\]\(` + _root(rundir) + String.raw`[^)]*\)`, 'giu'), (_, label: string) => label);
  return text.replace(new RegExp(_root(wt) + '|' + _root(rundir), 'giu'), () => '');
}

export function mark(rnd: number, verdict: string, sha: string, findings: readonly Finding[]): string {
  const data = Buffer.from(JSON.stringify(findings), 'utf8').toString('base64');
  return `<!-- sol-pr-review round=${rnd} verdict=${verdict} sha=${sha} findings=${data} -->`;
}

export function ledger_block(rnd: number, verdict: string, sha: string, findings: readonly Finding[]): string {
  const data = { round: rnd, head: sha, verdict, findings };
  return '```sol-findings\n' + JSON.stringify(data, null, 1) + '\n```';
}

export function issue_title(f: Finding): string {
  const t = str_only(or(or(or(f.class, f.scenario), f.cost), 'Pre-existing problem'));
  const short = head(t, 90) + (len(t) > 90 ? '…' : '');
  return truthy(f.file) ? `${short} (${py_str(f.file)})` : short;
}

// --- decide ---------------------------------------------------------------------------------------

export type DecideOptions = { wt?: string | null; rundir?: string | null; gone?: boolean; reviewer?: string | null };

/** Everything a review decides, from the PR's earlier reviews (read_reviews()) and Sol's reply.
 *  wt and rundir are the local folders Sol's paths start with; gone means the last reviewed commit
 *  isn't in H's history (a force-push), so Sol read the whole diff.
 *
 *  Returns verdict (clean or blocking), outcome (stop, approach-note, merge or fix), signals (why
 *  it stops: [{signal, ids, text}]), findings (the PR's whole state, as the ledger holds it), kept
 *  (declines Sol kept), unaddressed (earlier open findings Sol gave no status), status (for
 *  `sol-review` on H), issues (new Pre-existing findings to file), body (the comment) and
 *  reviewer. `reviewer` names who reviewed when it wasn't Sol, and why (the fallback model, #69,
 *  or config.toml's choice, #76): the comment's heading and byline and the status say so. An
 *  unreadable reply throws SolFailed. */
export function decide(repo: string, n: number, sha: string, rnd: number, earlier: readonly Review[], has_review_md: boolean,
  reply: string, { wt = null, rundir = null, gone = false, reviewer = null }: DecideOptions = {}): Decision {
  let [found, prose] = parse_findings(reply);
  const given = parse_earlier(reply);
  const notes: string[] = [];
  const last = earlier.length ? earlier.at(-1)!.sha : null;
  if (gone) {
    notes.push(`The last reviewed commit${last ? `, ${last.slice(0, 7)},` : ''} isn't in this `
      + "branch's history any more (a force-push), so this review read the PR's "
      + 'whole diff, not only the change since.');
  }
  for (const f of found) {
    [f.file, f.line] = repo_path(f.file, f.line, [wt, rundir].filter((r): r is string => truthy(r)));
    if (f.tag === 'important' && !evidence(f)) [f.tag, f.was] = ['nit', 'important'];
  }
  const down = found.filter((f) => truthy(get(f, 'was'))).map((f) => f.id);
  if (down.length) {
    const one = down.length === 1;
    notes.push(`${join(', ', down)} ${one ? 'was' : 'were'} tagged Important without a `
      + 'file and line plus a failure scenario, or a later cost and the rule it '
      + `breaks, so ${one ? 'it counts' : 'they count'} as a nit.`);
  }
  // An unchanged finding isn't reposted as new: one Sol gives a new ID with the same tag,
  // class, file and line as a finding still open (or filed), and gave no status, is that
  // finding.
  const prior = state(earlier);
  const ids = new Set(found.map((f) => key(f.id)));
  const same: string[] = [];
  for (const f of found) {
    if (prior.some((p) => py_eq(p.id, f.id))) continue;
    const p = prior.find((p) => among(OPEN_OR_FILED, p.status) && !ids.has(key(p.id))
      && !given.has(key(p.id))
      && py_eq(p.tag, f.tag) && truthy(norm(p.class)) && truthy(p.file)
      && py_eq([norm(p.class), p.file, p.line], [norm(f.class), f.file, f.line]));
    if (p) {
      same.push(`${py_str(f.id)} is ${py_str(p.id)}`);
      ids.add(key(p.id));
      f.id = p.id;
    }
  }
  if (same.length) {
    notes.push('Listed again under a new ID, with the same tag, class, file and line, so '
      + `each keeps its earlier ID: ${same.join('; ')}.`);
  }
  const over = found.filter((f) => f.tag === 'nit').map((f) => f.id).slice(MAX_NITS);
  if (over.length) {
    found = found.filter((f) => !among(over, f.id));
    notes.push(`Nits past the first ${MAX_NITS} are left out: ${join(', ', over)}.`);
  }
  // Filed already: every earlier Pre-existing finding but one whose filing failed (`unfiled`).
  const filed = new Set<Json>();
  for (const m of earlier) {
    for (const f of m.findings) {
      if (is_dict(f) && get(f, 'tag') === 'pre-existing' && !truthy(get(f, 'unfiled'))) filed.add(key(get(f, 'id')));
    }
  }
  const pre = found.filter((f) => f.tag === 'pre-existing');
  const again = pre.filter((f) => filed.has(key(f.id))).map((f) => f.id);
  if (again.length) notes.push(`Already filed after an earlier review, so not filed again: ${join(', ', again)}.`);

  // Carry the state forward. A finding Sol lists again takes its earlier ID's place, open (or
  // filed); one that had closed is reopened. Every other earlier open finding takes the status
  // Sol gave it, and stays as it was if Sol gave none. Closed ones are kept as they are.
  const before = new Map(prior.map((f) => [key(f.id), f]));
  const fresh_ids = new Map(found.map((f) => [key(f.id), f]));
  for (const f of found) {
    const p = before.get(key(f.id));
    f.status = f.tag === 'pre-existing' ? 'filed' : 'open';
    f.raised = p ? p.raised : rnd;
    if (p && truthy(get(p, 'issue'))) f.issue = p.issue;   // its follow-up issue's URL stays recorded
    if (p && among(CLOSED, p.status)) f.reopened = p.status;
  }
  const asked = prior.filter((f) => among(OPEN, f.status) && !fresh_ids.has(key(f.id))).map((f) => f.id);
  const unaddressed = asked.filter((i) => !given.has(key(i)));
  const rows: Finding[] = [], now: Finding[] = [];
  for (const p of prior) {
    const listed = fresh_ids.get(key(p.id));
    if (listed) {
      now.push(listed);
      if (among(OPEN_OR_FILED, p.status)) rows.push({ ...listed, again: true });   // listed again: shown with the earlier ones
      continue;
    }
    const q: Finding = { ...p };
    if (among(asked, p.id)) {
      if (given.has(p.id)) {
        q.status = given.get(p.id);
        if (!among(OPEN, q.status)) q.closed = rnd;
      }
      rows.push(q);
    }
    now.push(q);
  }
  now.push(...found.filter((f) => !before.has(key(f.id))));
  const kept = rows.filter((f) => given.has(key(f.id)) && f.status === 'decline-kept').map((f) => f.id);
  const back = found.filter((f) => truthy(get(f, 'reopened')));
  const closed_in = (f: Finding) => py_str(get(before.get(key(f.id))!, 'closed', '?'));
  const reopened = (f: Finding) => STATUSES[f.reopened as keyof typeof STATUSES].toLowerCase();
  if (back.length) {
    notes.push('Raised again after closing in an earlier review: '
      + back.map((f) => `${py_str(f.id)} (${reopened(f)} in review ${closed_in(f)})`).join(', ') + '.');
  }
  if (unaddressed.length) {
    const one = unaddressed.length === 1;
    notes.push(`Sol didn't address ${join(', ', unaddressed)}: it gave no status, so `
      + `${one ? 'it stays' : 'they stay'} open.`);
  }
  const stray = [...given.keys()].filter((i) => !among(asked, i));
  if (stray.length) {
    notes.push(`Statuses for ${stray.join(', ')} were ignored: not an earlier open finding, `
      + 'or listed again as a finding.');
  }

  const important = now.filter((f) => f.tag === 'important' && among(OPEN, f.status)).map((f) => f.id);
  const verdict = important.length ? 'blocking' : 'clean';

  // The outcome, in order: stop on any signal; the approach note from review 3 if still
  // blocking; merge if clean; fix otherwise.
  const seen = new Map<string, Finding>();
  for (const p of prior) {
    if (p.tag === 'important' && truthy(norm(p.class)) && !seen.has(norm(p.class))) seen.set(norm(p.class), p);
  }
  const signals: Signal[] = [];
  const rep = found.filter((f) => !before.has(key(f.id)) && f.tag === 'important' && seen.has(norm(f.class)))
    .map((f) => [f, seen.get(norm(f.class))!] as const);
  if (rep.length) {
    signals.push({ signal: 'repeated-class', ids: rep.map(([f]) => f.id), text: rep.map(([f, p]) =>
      `${py_str(f.id)} repeats the class "${py_str(p.class)}" of ${py_str(p.id)}, raised in review ${py_str(p.raised)}`).join('; ') });
  }
  if (back.length) {
    signals.push({ signal: 'reopened', ids: back.map((f) => f.id), text: back.map((f) =>
      `${py_str(f.id)} came back after it was ${reopened(f)} in review ${closed_in(f)}`).join('; ') });
  }
  if (kept.length) signals.push({ signal: 'decline-kept', ids: kept, text: `Sol kept the decline of ${join(', ', kept)} open` });
  const outcome = signals.length ? 'stop' : important.length && rnd >= APPROACH_REVIEW ? 'approach-note'
    : important.length ? 'fix' : 'merge';
  notes.push('**Next:** ' + {
    stop: 'the loop stops here for Stefan: ' + signals.map((s) => s.text).join('; ') + '.',
    'approach-note': `review ${rnd} is still blocking, so an approach note goes to Stefan `
      + 'instead of a fix round.',
    merge: `the PR merges once its checks pass on ${sha.slice(0, 7)}.`,
    fix: "back to a fix round: fix every case of each Important finding's class, or "
      + "decline it with the test that wouldn't fail.",
  }[outcome]);

  const nits = now.filter((f) => f.tag === 'nit' && among(OPEN, f.status)).length;
  let desc = important.length
    ? `Blocking: ${important.length} Important finding${important.length !== 1 ? 's' : ''} (${join(', ', important)})`
    : `Clean: no Important finding, ${nits} nit${nits !== 1 ? 's' : ''}`;
  if (reviewer) desc = `${reviewer}: ${desc}`;
  const fresh = found.filter((f) => !(before.has(key(f.id)) && among(OPEN_OR_FILED, before.get(key(f.id))!.status)));
  const tag = (f: Finding) => TAGS[f.tag as keyof typeof TAGS];
  const table = !fresh.length ? (earlier.length ? 'No new findings.' : 'No findings.')
    : '| ID | Tag | Class | Where |\n|---|---|---|---|\n' + fresh.map((f) =>
      `| ${_cell(f.id)} | ${tag(f)} | ${_cell(f.class)} | ${_where(repo, sha, f)} |\n`).join('');

  const label = (f: Finding) => {
    if (truthy(get(f, 'again'))) return (f.status === 'filed' ? 'Filed already' : 'Still open') + ' (listed again)';
    if (!has(STATUSES, f.status)) throw new Error(`KeyError: ${py_str(f.status)}`);
    return STATUSES[f.status as keyof typeof STATUSES] + (given.has(key(f.id)) ? '' : ' (Sol gave no status)');
  };
  const old = !rows.length ? '' : (
    '### Earlier findings\n\n| ID | Tag | Class | Where | Now |\n|---|---|---|---|---|\n'
    + rows.map((f) => `| ${_cell(f.id)} | ${tag(f)} | ${_cell(f.class)} | `
      + `${_where(repo, sha, f)} | ${label(f)} |\n`).join('') + '\n');
  const guide = has_review_md ? ", with the repo's REVIEW.md" : '';
  const scope = last && !gone ? `, the change since ${last.slice(0, 7)}` : '';
  const text = wt && rundir ? github_links(prose, wt, rundir, repo, sha) : prose;
  // The heading keeps its `## Sol review N · V` start (the review loop's name, and HEADING's).
  const byline = reviewer ? `Reviewed by ${reviewer}: ${FALLBACK_BYLINE}, on ${sha.slice(0, 7)}${scope}${guide}`
    : `${SOL_BYLINE}, on ${sha.slice(0, 7)}${scope}${guide}`;
  const body = `## Sol review ${rnd} · ${capitalize(verdict)}`
    + (reviewer ? ` · ${reviewer}` : '') + '\n\n'
    + `<sub>${byline}. Posted by the queue runner from Stefan's PC.</sub>\n\n`
    + `${text}\n\n${old}### Findings\n\n${rstrip(table)}\n\n`
    + notes.map((s) => `${s}\n\n`).join('')
    + _trailer(rnd, verdict, sha, now);
  return {
    round: rnd, sha, verdict, outcome, signals, findings: now, kept, unaddressed,
    status: { state: important.length ? 'failure' : 'success', description: head(desc, 140) },
    // New ones, and earlier ones whose filing failed that Sol didn't list again.
    issues: [...pre.filter((f) => !filed.has(key(f.id))), ...now.filter((f) => truthy(get(f, 'unfiled')) && !fresh_ids.has(key(f.id)))]
      .map((f) => ({ id: f.id, title: issue_title(f), finding: f })),
    body, reviewer,
  };
}

/** The end of a review comment: the collapsed ledger, then the hidden marker. */
function _trailer(rnd: number, verdict: string, sha: string, findings: readonly Finding[]): string {
  return `${LEDGER}\n\n` + ledger_block(rnd, verdict, sha, findings) + '\n\n</details>\n\n'
    + mark(rnd, verdict, sha, findings) + '\n';
}

/** The comment with each filed Pre-existing finding's issue linked ({finding id: url}) and
 *  its URL recorded in the ledger and the marker (`issue`), so no later review files it again.
 *  One whose filing `failed` is marked `unfiled`, so the next review files it. */
export function with_issues(d: Decision, urls: ReadonlyMap<Json, string>, failed: readonly Json[] = []): string {
  if (!urls.size && !failed.length) return d.body;
  for (const f of d.findings) {
    if (urls.has(key(f.id))) {
      f.issue = urls.get(f.id);
      delete f.unfiled;
    } else if (among(failed, f.id)) {
      f.unfiled = true;
    }
  }
  let said = '';
  if (urls.size) {
    said += 'Filed as follow-up issues: ' + [...urls].map(([fid, url]) =>
      `${py_str(fid)} → [#${url.replace(/\/+$/, '').split('/').at(-1)}](${url})`).join(', ') + '.\n\n';
  }
  if (failed.length) {
    const one = failed.length === 1;
    said += `Filing ${join(', ', failed)} as ${one ? 'a follow-up issue' : 'follow-up issues'}`
      + ` failed; the next review files ${one ? 'it' : 'them'}.\n\n`;
  }
  const body = d.body;
  const at = body.lastIndexOf(LEDGER);
  if (at < 0) throw new Error('ValueError: substring not found');
  return body.slice(0, at) + said + _trailer(d.round, d.verdict, d.sha, d.findings);
}
