// Which repos the runner serves, and where it keeps its own state and logs. Ported from
// `queue_runner/config.py` (#219): `Config` and `Repo`, read from `config.toml` (`--config`) once
// at start, with Python's keys, defaults and errors.
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse as parse_toml } from 'smol-toml';
import { get, or, py_repr, py_str, strip, KeyError, ValueError, type Json } from './python.ts';

/** The runner's own `config.toml`, at the repo's root, beside `queue_runner/` (Python's
 *  `DEFAULT_CONFIG`). */
export const DEFAULT_CONFIG = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'config.toml');

// `sol.py`'s `SOL_SCRIPT` and `GIT_BASH`, which `load_config` defaults to, here until the Sol port
// (#222) moves them.
export const SOL_SCRIPT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts',
  'codex-sol.sh').split(sep).join('/');
// Git's bash by full path: 'bash' on PATH here is WSL's (System32\bash.exe).
export const GIT_BASH = String.raw`C:\Program Files\Git\bin\bash.exe`;

type Fields<T> = { -readonly [K in keyof T as T[K] extends Function ? never : K]: T[K] };

export class Repo {
  readonly name!: string;
  readonly github!: string | null;  // owner/name; null for a repo with no GitHub (the live-check sandbox)
  readonly path!: string;           // local clone; T3's project for its jobs
  readonly base: string = 'main';
  // Who merges a clean PR (ticket 17, `merge.py`): 'runner' (it merges itself), or 'stefan'
  // (it labels the PR `ready-for-stefan` and toasts once; Stefan merges, and the runner notices).
  readonly merge: string = 'runner';

  constructor(fields: Pick<Fields<Repo>, 'name' | 'github' | 'path'> & Partial<Fields<Repo>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  get stefan_merges(): boolean {
    return this.merge === 'stefan';
  }
}

export class Config {
  readonly repos!: Repo[];  // in config.toml's order, which breaks a tie between repos' work (#50)
  readonly state_dir!: string;
  readonly log_dir!: string;
  readonly claude_provider: string = 'claudeAgent';     // T3 provider instance for Claude jobs
  readonly claude_model: string = 'claude-opus-5-5';
  // The effort every Claude job runs at (ticket 39, `effort.py`): named in its T3 launch (#119).
  readonly claude_effort: string = 'high';
  readonly poll_seconds: number = 300;                  // continuous mode: the pause after an idle pass
  readonly runs_dir: string = '';        // a review's run folder: brief, inputs, reply, would-be comment
  readonly checkouts_dir: string = '';   // Sol's detached checkout of the PR's head, removed after
  readonly deps_dir: string = '';        // node_modules per lockfile, linked into Sol's checkout (ticket 16)
  readonly sol_script: string = '';      // scripts/codex-sol.sh
  readonly sol_bash: string = '';        // Git's bash, which runs it
  // Who reviews every PR (issue #76): 'chatgpt' (Sol, through codex-sol.sh; the Opus fallback
  // steps in only while Sol is out of usage, #69) or 'claude' (an Opus thread in T3 at
  // [claude]'s model and effort, through the usage gate). `[review] provider` in config.toml.
  readonly review_provider: string = 'chatgpt';
  // The T3 provider instance an Opus review starts on (`[review] claude_provider`): one launched
  // with no MCP tools (docs/reviews.md, A review has no outside tools), so an Opus review gets
  // what a Sol review gets. Never [claude]'s instance, which has the build's tools: an empty
  // one is a config error, and an Opus review refuses to start without one.
  readonly review_claude_provider: string = 'claudeReviewer';

  constructor(fields: Pick<Fields<Config>, 'repos' | 'state_dir' | 'log_dir'> & Partial<Fields<Config>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

// Python sets `_stopped` on the frozen config itself; a frozen object here takes no new field, so
// each config's stopped repos are kept beside it.
const STOPPED = new WeakMap<Config, ReadonlySet<string>>();

/** The repos Stefan stopped (control.json's `repos`, ticket 37): every part that chooses work
 *  goes through `working`, which leaves them out. `repos` itself keeps them, for what is only
 *  looked up or shown (a job's own repo, the Inbox, the snapshot). */
export function set_stopped(config: Config, names: Iterable<string>): void {
  STOPPED.set(config, new Set(names));
}

export function stopped(config: Config): ReadonlySet<string> {
  return STOPPED.get(config) ?? new Set();
}

/** The repos the lanes take work from: `repos`, less those stopped. */
export function working(config: Config): Repo[] {
  const off = stopped(config);
  return config.repos.filter((r) => !off.has(r.name));
}

/** `os.path.expanduser`: `~` and `~user` at the start, as Python's `ntpath` reads them on Windows
 *  (`USERPROFILE`, else `HOMEDRIVE` and `HOMEPATH`) and `posixpath` elsewhere (`HOME`). */
function expanduser(p: string): string {
  if (!p.startsWith('~')) return p;
  const win = process.platform === 'win32';
  let i = 1;
  while (i < p.length && !(p[i] === '/' || (win && p[i] === '\\'))) i += 1;
  if (!win) {
    if (i !== 1) return p;   // `~user`: Python asks pwd; no such user here leaves it as it is
    const userhome = (process.env.HOME ?? homedir()).replace(/\/+$/, '');
    return userhome + p.slice(i) || '/';
  }
  let userhome: string;
  if (process.env.USERPROFILE !== undefined) userhome = process.env.USERPROFILE;
  else if (process.env.HOMEPATH !== undefined) userhome = join(process.env.HOMEDRIVE ?? '', process.env.HOMEPATH);
  else return p;
  if (i !== 1) {
    const target_user = p.slice(1, i);
    const current_user = process.env.USERNAME;
    if (target_user !== current_user) {
      if (current_user !== basename(userhome)) return p;
      userhome = join(dirname(userhome), target_user);
    }
  }
  return userhome + p.slice(i);
}

/** `os.path.normpath`: Node's `normalize`, less the trailing separator Python drops. */
function normpath(p: string): string {
  const n = normalize(p);
  const root = parse(n).root;
  return n.length > root.length && /[\\/]$/.test(n) ? n.slice(0, -1) : n;
}

function _path(p: string): string {
  return normpath(expanduser(p));
}

/** `entry[key]`: a key that must be there, or Python's `KeyError`. */
function need(entry: Record<string, Json>, k: string): Json {
  if (!Object.hasOwn(entry, k)) throw new KeyError(py_repr(k));
  return entry[k];
}

function _merge(entry: Record<string, Json>): string {
  const merge = get(entry, 'merge', 'runner');
  if (merge !== 'runner' && merge !== 'stefan') {
    throw new ValueError(`repo ${py_str(need(entry, 'name'))}: merge must be 'runner' or 'stefan', `
      + `not ${py_repr(merge)}`);
  }
  return merge;
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;   // Claude Code's effort levels

function _effort(claude: Record<string, Json>): string {
  const effort = get(claude, 'effort', 'high');
  if (!(EFFORTS as readonly Json[]).includes(effort)) {
    throw new ValueError(`[claude] effort must be one of ${EFFORTS.join(', ')}, not ${py_repr(effort)}`);
  }
  return effort;
}

export const REVIEW_PROVIDERS = ['chatgpt', 'claude'] as const;

function _review_provider(review: Record<string, Json>): string {
  const provider = get(review, 'provider', 'chatgpt');
  if (!(REVIEW_PROVIDERS as readonly Json[]).includes(provider)) {
    throw new ValueError(`[review] provider must be one of ${REVIEW_PROVIDERS.join(', ')}, `
      + `not ${py_repr(provider)}`);
  }
  return provider;
}

/** `[review] claude_provider`, `claudeReviewer` when unset. A review has no outside tools
 *  (docs/reviews.md), so it can't be empty or [claude]'s instance, which builds start on with
 *  their tools: either is an error naming the key, not a review with tools. */
function _review_claude_provider(review: Record<string, Json>, build_provider: Json): string {
  const name = strip(py_str(get(review, 'claude_provider', 'claudeReviewer')));
  if (!name) {
    throw new ValueError('[review] claude_provider must name a T3 provider instance with no MCP '
      + 'tools (docs/reviews.md, A review has no outside tools), not be empty');
  }
  if (name === build_provider) {
    throw new ValueError(`[review] claude_provider must not be [claude] provider (${py_repr(name)}): `
      + "that instance has the build's tools, and a review has none");
  }
  return name;
}

/** Python's `int()` of a TOML value: an int as it is, a float cut toward zero, a bool as 0 or 1,
 *  a string of decimal digits read; anything else raises. */
function py_int(x: Json): number {
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new ValueError(`cannot convert float ${py_str(x)} to integer`);
    return Math.trunc(x);
  }
  if (typeof x === 'string') {
    const s = strip(x);
    if (/^[+-]?\d(?:_?\d)*$/.test(s)) return Number(s.replaceAll('_', ''));
    throw new ValueError(`invalid literal for int() with base 10: ${py_repr(x)}`);
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number`);
}

export function load_config(path: string = DEFAULT_CONFIG): Config {
  const raw: Record<string, Json> = parse_toml(readFileSync(path, 'utf8'));
  const repos = (get(raw, 'repos', []) as Record<string, Json>[]).map((r) => new Repo({
    name: need(r, 'name'), github: get(r, 'github'), path: _path(need(r, 'path')),
    base: get(r, 'base', 'main'),
    merge: _merge(r),
  }));
  const claude = get(raw, 'claude', {}), sol = get(raw, 'sol', {});
  const state_dir = _path(need(raw, 'state_dir'));
  const home = dirname(state_dir);   // runs and checkouts sit beside the state folder
  return new Config({
    repos, state_dir, log_dir: _path(need(raw, 'log_dir')),
    claude_provider: get(claude, 'provider', 'claudeAgent'),
    claude_model: get(claude, 'model', 'claude-opus-5-5'),
    claude_effort: _effort(claude),
    poll_seconds: py_int(get(raw, 'poll_seconds', 300)),
    runs_dir: _path(or(get(raw, 'runs_dir'), join(home, 'runs'))),
    checkouts_dir: _path(or(get(raw, 'checkouts_dir'), join(home, 'checkouts'))),
    deps_dir: _path(or(get(raw, 'deps_dir'), join(home, 'deps'))),
    sol_script: _path(or(get(sol, 'script'), SOL_SCRIPT)),
    sol_bash: or(get(sol, 'bash'), GIT_BASH),
    review_provider: _review_provider(get(raw, 'review', {})),
    review_claude_provider: _review_claude_provider(
      get(raw, 'review', {}), get(claude, 'provider', 'claudeAgent')),
  });
}
