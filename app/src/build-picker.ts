// Which ticket the runner builds next. Ported from `queue_runner/picker.py` (#218): the same
// decisions and the same names (snake_case, as Python has them), with `tests/test_picker.py`
// ported case for case in `test/build-picker.test.ts`. It reads GitHub through the ported seam
// (`src/github-seam.ts`). `src/picker.ts` stays beside it until the lanes that import it are
// ported (#219, #222, #223).
//
// Two differences are TypeScript's only. The seam's calls are async, so `pick` is async and
// `pickable` an async generator. And Python's `re` reads `\w`, `\d`, `\s` and `\b` as Unicode, where
// JavaScript's read ASCII: the patterns below spell out Python's classes, so they match what
// Python's do.
import type { GhCli, Issue, Repo as SeamRepo } from './github-seam.ts';

/** A repo as the picker needs it: its `owner/name` and its base branch (Python's `config.Repo`). */
export type Repo = SeamRepo & { readonly base: string };

/** What the picker reads from GitHub. */
export type GitHub = Pick<GhCli, 'ready_issues' | 'issue_state' | 'open_pulls' | 'branches'>;

// Python's `\w` (letters, digits and `_`, in any script), `\d` (any decimal digit) and `\s`
// (`str.isspace`), for a character class.
const W = String.raw`\p{L}\p{N}_`;
const D = String.raw`\p{Nd}`;
const S = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
/** Python's `\b` just before a word character, and just after one. */
const B_BEFORE = `(?<![${W}])`;
const B_AFTER = `(?![${W}])`;

const _HEADING = new RegExp(`^[${S}]{0,3}#{1,6}[${S}]`, 'u');
const _BLOCKED_BY = new RegExp(`^[${S}>*_#-]*blocked by${B_AFTER}`, 'iu');
// An issue reference: a github.com URL, `owner/name#N`, or `#N` (this repo).
const _REF = String.raw`(?:https://github\.com/(?<url_repo>[${W}.\-]+/[${W}.\-]+)/issues/(?<url_n>[${D}]+)`
  + String.raw`|(?<![${W}/#.\-])(?:(?<repo>[${W}.\-]+/[${W}.\-]+))?#(?<n>[${D}]+)${B_AFTER})`;
const _REFS = new RegExp(_REF, 'gu');
const _CLOSES = new RegExp(String.raw`${B_BEFORE}(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[${S}]+` + _REF, 'giu');
// Python's `.` is anything but `\n`, and its `$` also matches before a final `\n`.
/** Every job branch starts with this: a GitHub-facing name, kept as Python has it, since a branch
 *  the Python runner left counts as in flight across the cutover (docs/app.md, Rules). */
const _JOB_BRANCH_PREFIX = 'claude/';
const _CLAUDE_BRANCH = new RegExp(`^${_JOB_BRANCH_PREFIX}[^\\n]+-([${D}]+)(?=\\n?$)`, 'u');

const _WORD = /[a-z0-9]+/g;

/** Python's `int` on a run of decimal digits, in any script. Unicode keeps each script's digits
 *  as one run of 0 to 9 in order, so a digit's value is how far it sits into its run. */
function int(digits: string): number {
  let n = 0;
  for (const ch of digits) {
    const cp = ch.codePointAt(0)!;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    n = n * 10 + ((cp - start) % 10);
  }
  return n;
}

/** Python's order for (owner/name, number): names by code point, then numbers. */
function compare([ra, na]: Ref, [rb, nb]: Ref): number {
  const a = Array.from(ra, (c) => c.codePointAt(0)!);
  const b = Array.from(rb, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length || na - nb;
}

/** `sorted(set(found))`. */
function sorted_set(found: Ref[]): Ref[] {
  const unique = new Map(found.map((r) => [JSON.stringify(r), r]));
  return [...unique.values()].sort(compare);
}

/** Python's `str.splitlines`: every line break it knows, no empty line after a final one. */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export type Ref = [github: string, number: number];

export class BuildJob {
  readonly repo!: Repo;
  readonly issue!: Issue;
  readonly branch!: string;   // <job branch prefix><slug>-<issue>
  readonly base!: string;     // origin/<repo base>
  constructor(fields: { repo: Repo; issue: Issue; branch: string; base: string }) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

export function slug(title: string, words = 4): string {
  return (title.toLowerCase().match(_WORD) ?? []).slice(0, words).join('-') || 'issue';
}

/** (owner/name, number) for each reference; a bare `#N` is in `here`. */
function _refs(pattern: RegExp, text: string, here: string): Ref[] {
  const found: Ref[] = [];
  for (const m of text.matchAll(pattern)) {
    const g = m.groups!;
    if (g.url_n) found.push([g.url_repo!.toLowerCase(), int(g.url_n)]);
    else found.push([(g.repo || here).toLowerCase(), int(g.n!)]);
  }
  return found;
}

/** Issues a PR body closes (Closes, Fixes, Resolves... then `#N`, `owner/name#N` or an issue
 *  URL), as (owner/name, number); a bare `#N` is in `here`. */
export function closed_issues(body: string | null, here: string): Ref[] {
  return sorted_set(_refs(_CLOSES, body || '', here.toLowerCase()));
}

/** Issues named as blockers, as (owner/name, number): on a `Blocked by:` line, or under a
 *  `## Blocked by` heading up to the next heading. Refs elsewhere in the body don't block. */
export function blockers(body: string | null, here: string): Ref[] {
  const found: Ref[] = [];
  const lines = splitlines(body || '');
  lines.forEach((line, i) => {
    if (!_BLOCKED_BY.test(line)) return;
    found.push(..._refs(_REFS, line, here));
    if (_HEADING.test(line)) {
      for (const later of lines.slice(i + 1)) {
        if (_HEADING.test(later)) break;
        found.push(..._refs(_REFS, later, here));
      }
    }
  });
  return sorted_set(found);
}

async function _unblocked(repo: Repo, github: GitHub, issue: Issue): Promise<boolean> {
  if (issue.open_blockers) return false;
  for (const [where, n] of blockers(issue.body, repo.github)) {
    if (await github.issue_state(where, n) !== 'closed') return false;
  }
  return true;
}

/** Issues something is already building: a `<job branch prefix>*-<issue>` branch, or an open PR on one or
 *  with a closing keyword for the issue in this repo. PRs GitHub links to an issue (by keyword or
 *  by hand) are counted on the issue itself (`open_linked_pulls`). */
export async function in_flight(repo: Repo, github: GitHub): Promise<Set<number>> {
  const here = repo.github.toLowerCase();
  const taken = new Set<number>();
  for (const branch of await github.branches(repo, _JOB_BRANCH_PREFIX)) {
    const m = _CLAUDE_BRANCH.exec(branch);
    if (m) taken.add(int(m[1]!));
  }
  for (const pr of await github.open_pulls(repo)) {
    const m = _CLAUDE_BRANCH.exec(pr.branch);
    if (m) taken.add(int(m[1]!));
    for (const [where, n] of _refs(_CLOSES, pr.body || '', here)) if (where === here) taken.add(n);
  }
  return taken;
}

/** The lowest-numbered open `ready-for-agent` issue that's unblocked and not already being
 *  built. A spec or map with open sub-issues isn't built itself; its children are. `held` are
 *  issues the runner's own job log holds (a build open, failed or waiting on them). */
export async function pick(repo: Repo, github: GitHub, held: Iterable<number> = []): Promise<BuildJob | null> {
  for await (const job of pickable(repo, github, held)) return job;
  return null;
}

/** Every build `pick` could take, in the order it takes them: the dashboard's queue (ticket
 *  32). A generator, so `pick` reads no further than its first. */
export async function* pickable(repo: Repo, github: GitHub, held: Iterable<number> = []): AsyncGenerator<BuildJob> {
  const taken = new Set([...await in_flight(repo, github), ...held]);
  const ready = [...await github.ready_issues(repo)].sort((a, b) => a.number - b.number);
  for (const issue of ready) {
    if (taken.has(issue.number) || issue.open_linked_pulls || issue.open_sub_issues) continue;
    if (await _unblocked(repo, github, issue)) {
      yield new BuildJob({ repo, issue, base: `origin/${repo.base}`,
        branch: `${_JOB_BRANCH_PREFIX}${slug(issue.title)}-${issue.number}` });
    }
  }
}
