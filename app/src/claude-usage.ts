// Claude's plan windows, ported from `queue_runner/usage.py` (#263), read the way T3 reads them:
// `GET api.anthropic.com/api/oauth/usage` with the Claude login's OAuth token (T3's
// `readClaudeResetCredits`, `resources/server.asar`).
//
// The token is `claudeAiOauth.accessToken` in `<config dir>/.credentials.json`, the config dir
// being `$CLAUDE_CONFIG_DIR` or `~/.claude` (T3's `readAccessToken`; on Windows Claude Code keeps
// it in that file). Claude Code refreshes it whenever it runs. The token is only ever put in the
// request header: never logged, copied or put in an error.
//
// The response's `five_hour` and `seven_day` windows are `{utilization: 0-100, resets_at: ISO
// time or null}`; a window that's null hasn't started (nothing used).
//
// Reset credits (ticket 42) come in the same response when it's asked with `cedar_ember=1`, as T3
// asks it (`readClaudeResetCredits`): the `cedar_ember` block's grants, counted as T3 counts them
// (`claudeResetCreditsToContract`). Redeeming one is T3's (it spends the credit); the runner only
// counts them.
//
// **One reading, one budget** (issue 66): `CachedUsage` is the one reader the gate, its after-job
// read, the snapshot and Refresh share. It asks the endpoint at most once every `CALL_EVERY`
// seconds, failed calls counted, and in between gives back the cached reading with the time it
// was taken; a failed call keeps the last good reading, with its error beside it (T3's
// `CAPABILITIES_PROBE_TTL` and `resolveUsageLimitsAfterProbe`, read 2026-11-16). The endpoint
// answers 429 when it's asked about once a minute, per login, and T3 and Claude Code share it.
//
// Python's `CachedUsage` holds a thread lock around every method, through the endpoint's call, so
// two callers never ask at once and a reader waits for a call in flight. Here every method is
// async and queues on one promise lock (`Lock`), which keeps the same order: a caller that comes
// while a call is in flight waits for it, then sees its result.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Json, get, head, is_dict, py_float, py_repr, py_str, splitlines, strip, truthy, type_name, ValueError } from './python.ts';

export const URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1';
// T3's headers for this call; the user agent names a Claude Code version as T3's does.
export const HEADERS: Readonly<Record<string, string>> = {
  'anthropic-beta': 'oauth-2025-04-20',
  'user-agent': 'claude-cli/2.1.319 (external, cli)',
};

export const CALL_EVERY = 300;   // seconds: the endpoint is asked no more often than this, failed calls counted
const MINUTE = 60_000;
// A reading older than this isn't decided on (the gate), and its failure is shown (the page).
export const STALE_AFTER = 30 * MINUTE;   // milliseconds
// A failure isn't shown until it has lasted this long, two more tries at the usual 5 minutes
// apart. The first reads after the PC wakes fail and the next ones answer: the network isn't
// back, a login expired while it slept (a Claude Code session refreshes it within minutes), Codex
// starts slow (Stefan, 2026-11-17: "I'm not supposed to see this in the first place").
export const SHOW_AFTER = 10 * MINUTE;   // milliseconds

export type Clock = () => Date;
const utc_now: Clock = () => new Date();

/** Whether a failure that began at `since` has lasted long enough to show; one whose start isn't
 *  known has. */
export function lasted(since: Date | null, now: Date): boolean {
  return since === null || now.getTime() - since.getTime() >= SHOW_AFTER;
}

/** When `repo`'s reads began failing, for a stale entry (`inbox.Reader.stale`,
 *  `work.Reader.stale`): the entry it has already, or now for a first failure. */
export function failing_since(stale: Readonly<Record<string, readonly unknown[]>>, repo: string, now: Date): Date | null {
  const was = Object.hasOwn(stale, repo) ? stale[repo] : undefined;
  return was && was.length > 2 ? (was[2] as Date | null) : now;
}

/** Usage couldn't be read. Its message never holds the token. `login`: the Claude login is the
 *  trouble (none readable, or HTTP 401); `called`: the endpoint was asked, so the call counts
 *  against the budget. */
export class UsageError extends Error {
  override name = 'UsageError';
  readonly login: boolean;
  readonly called: boolean;
  constructor(message = '', { login = false, called = true }: { login?: boolean; called?: boolean } = {}) {
    super(message);
    this.login = login;
    this.called = called;
  }
}

/** One window: percent used, 0-100, and when it resets (null: it hasn't started). */
export class Window {
  readonly used: number;
  readonly resets_at: Date | null;
  constructor(used: number, resets_at: Date | null) {
    this.used = used;
    this.resets_at = resets_at;
    Object.freeze(this);
  }
}

export type UsageRecord = Record<'five_hour' | 'seven_day', { used: number; resets_at: string | null }>;

export class Usage {
  readonly five_hour: Window;
  readonly seven_day: Window;
  readonly resets: number | null;   // reset credits left; null: the account has none to give
  constructor(five_hour: Window, seven_day: Window, resets: number | null = null) {
    this.five_hour = five_hour;
    this.seven_day = seven_day;
    this.resets = resets;
    Object.freeze(this);
  }

  record(): UsageRecord {
    const w = (x: Window) => ({ used: x.used, resets_at: x.resets_at ? isoformat(x.resets_at) : null });
    return { five_hour: w(this.five_hour), seven_day: w(this.seven_day) };
  }

  static from_record(rec: Json): Usage {
    const one = (n: string) => {
      const r = need(rec, n);
      return new Window(py_float(need(r, 'used')), _time(need(r, 'resets_at')));
    };
    return new Usage(one('five_hour'), one('seven_day'));
  }
}

/** `rec[key]`: Python's `KeyError` when it's missing, its `TypeError` when `rec` isn't a dict. */
function need(rec: Json, key: string): Json {
  if (!is_dict(rec)) throw new TypeError(`'${rec === null ? 'NoneType' : typeof rec}' object is not subscriptable`);
  if (!Object.hasOwn(rec, key)) throw new Error(`KeyError: '${key}'`);
  return rec[key];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `t.isoformat()` of a time in UTC: microseconds only when there are any (a `Date` holds
 *  milliseconds), and `+00:00`. */
export function isoformat(t: Date): string {
  const ms = t.getUTCMilliseconds();
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:`
    + `${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}${ms ? `.${pad(ms, 3)}000` : ''}+00:00`;
}

/** `t.astimezone().isoformat(timespec='minutes')`: this PC's local time, to the minute, with its
 *  offset (`2026-11-10T20:00+08:00`). */
export function local_minutes(t: Date): string {
  const off = -t.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
    + `${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// The ISO forms `datetime.fromisoformat` reads: a date, then a time to the hour, minute, second
// or fraction, then an offset (`Z` is replaced first, as Python's caller does).
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?)?(?:(Z)|([+-])(\d{2}):?(\d{2})(?::?(\d{2})(?:\.(\d+))?)?)?$/;

/** `datetime.fromisoformat(s)` as an instant: one with no offset is UTC, as `_time` makes it. A
 *  string it can't read is Python's `ValueError`. */
function fromisoformat(s: string): Date {
  const m = ISO.exec(s);
  const bad = () => new ValueError(`Invalid isoformat string: ${py_repr(s)}`);
  if (!m) throw bad();
  const [y, mo, d, h = 0, mi = 0, se = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? undefined : Number(x))) as number[];
  const ms = m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0;
  const days = new Date(Date.UTC(y!, mo!, 0)).getUTCDate();
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > days || h > 23 || mi > 59 || se > 59) throw bad();
  let off = 0;
  if (m[9]) {
    const [oh, om, os] = [Number(m[10]), Number(m[11]), Number(m[12] ?? 0)];
    if (oh > 23 || om > 59 || os > 59) throw bad();
    off = (m[9] === '-' ? -1 : 1) * ((oh * 60 + om) * 60 + os) * 1000;
  }
  const t = new Date(0);
  t.setUTCFullYear(y!, mo! - 1, d!);
  t.setUTCHours(h, mi, se, ms);
  return new Date(t.getTime() - off);
}

/** A reset time as the endpoint (or `usage.jsonl`) writes it, else null for none. */
export function _time(value: Json): Date | null {
  if (!truthy(value)) return null;
  return fromisoformat(py_str(value).split('Z').join('+00:00'));
}

const is_number = (x: Json): x is number => typeof x === 'number';

function _window(raw: Json): Window {
  if (raw === null || raw === undefined) return new Window(0, null);
  const used = is_dict(raw) ? get(raw, 'utilization') : null;
  if (!is_number(used)) throw new UsageError(`a usage window has no utilization: ${head(py_str(raw), 200)}`);
  try {
    return new Window(used, _time(get(raw, 'resets_at')));
  } catch (e) {
    if (e instanceof ValueError) throw new UsageError(`a usage window has an unreadable reset time: ${e.message}`);
    throw e;
  }
}

// Python's `re.match` with `$`, which also matches before a final newline.
export const GRANT_ID = /^[a-z0-9_-]{1,40}\n?$/;

function _ends_ahead(value: Json, now: Date): boolean {
  if (value === null || value === undefined) return true;
  try {
    const t = _time(value);
    return t !== null && t.getTime() > now.getTime();   // None > now: Python's TypeError, so False
  } catch (e) {
    if (e instanceof ValueError) return false;
    throw e;
  }
}

/** `for g in x`, for a JSON value: a list's items, a string's characters, a dict's keys; a number
 *  or a bool is Python's `TypeError`. */
function py_iter(x: Json): Json[] {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') return Array.from(x);
  if (is_dict(x)) return Object.keys(x);
  throw new TypeError(`'${typeof x === 'boolean' ? 'bool' : Number.isInteger(x) ? 'int' : 'float'}' object is not iterable`);
}

/** The reset credits left in a `cedar_ember` block, as T3 counts them: null when there's no block
 *  or the account isn't eligible; else every usable grant's `resets_left` (not paused,
 *  `usable_now`, not ended), or 0 when the grant to be used next isn't one of them. */
export function resets(block: Json, now: Date): number | null {
  if (!is_dict(block) || get(block, 'eligible') !== true) return null;
  const grants = get(block, 'grants');
  const live = py_iter(truthy(grants) ? grants : []).filter((g) => is_dict(g)
    && typeof get(g, 'id') === 'string' && GRANT_ID.test(g.id)
    && Number.isInteger(get(g, 'resets_left')) && g.resets_left >= 0 && get(g, 'paused') !== true
    && get(g, 'usable_now') === true && _ends_ahead(get(g, 'ends_at'), now));
  if (!live.some((g) => g.id === get(block, 'next_grant_id'))) return 0;
  return live.reduce((n, g) => n + g.resets_left, 0);
}

// `json.loads(bytes)` reads a UTF-8 BOM as `utf-8-sig`; a file opened as `utf-8` keeps it, and
// `json.load` then refuses it.
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf8_kept_bom = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function parse(body: Uint8Array | string, now: Date | null = null): Usage {
  let data: Json;
  try {
    data = JSON.parse(typeof body === 'string' ? body : utf8.decode(body));
  } catch (e) {
    throw new UsageError(`the usage response is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!is_dict(data)) throw new UsageError('the usage response is not a JSON object');
  now = now ?? utc_now();
  return new Usage(_window(get(data, 'five_hour')), _window(get(data, 'seven_day')), resets(get(data, 'cedar_ember'), now));
}

/** The request `OAuthUsage` makes: urllib's `Request`, as its `fetch` takes it. */
export type Request = { readonly full_url: string; readonly headers: Readonly<Record<string, string>> };
export type Fetch = (request: Request) => Promise<Uint8Array | string>;

/** urllib's `HTTPError`: the endpoint answered with a status that isn't 2xx. */
export class HTTPError extends Error {
  override name = 'HTTPError';
  readonly url: string;
  readonly code: number;
  readonly msg: string;
  constructor(url: string, code: number, msg: string) {
    super(`HTTP Error ${code}: ${msg}`);
    this.url = url;
    this.code = code;
    this.msg = msg;
  }
}

/** `urllib.request.urlopen(request, timeout=15).read()`. */
export const _fetch: Fetch = async (request) => {
  const r = await fetch(request.full_url, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
  if (r.status < 200 || r.status >= 300) {
    await r.body?.cancel();   // it holds the response open
    throw new HTTPError(request.full_url, r.status, r.statusText);
  }
  return new Uint8Array(await r.arrayBuffer());
};

/** An error's name as Python's `type(e).__name__` says it, for the login's file: Node's file
 *  errors by their code, JSON's by Python's name. */
function login_error_name(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return 'UnicodeDecodeError';
  if (e instanceof SyntaxError) return 'JSONDecodeError';
  if (typeof code === 'string') return 'OSError';
  return type_name(e);
}

/** Python's `AttributeError`: a method looked up on a value that hasn't it (`.get` on a list). */
function attribute_error(x: Json): Error {
  const e = new Error(`'${Array.isArray(x) ? 'list' : typeof x === 'string' ? 'str' : typeof x === 'boolean' ? 'bool' : typeof x === 'number' ? (Number.isInteger(x) ? 'int' : 'float') : 'NoneType'}' object has no attribute 'get'`);
  e.name = 'AttributeError';
  return e;
}

/** A Claude usage endpoint, as `CachedUsage` asks it. */
export type Endpoint<T = Usage> = { readonly call_every?: number; read(): Promise<T> | T };

export class OAuthUsage implements Endpoint {
  readonly call_every = CALL_EVERY;   // how often this endpoint may be asked: `CachedUsage`'s budget
  readonly config_dir: string;
  readonly fetch: Fetch;
  readonly clock: Clock;

  constructor(config_dir: string | null = null, fetch: Fetch = _fetch, clock: Clock | null = null) {
    this.config_dir = config_dir || strip(process.env.CLAUDE_CONFIG_DIR ?? '') || join(homedir(), '.claude');
    this.fetch = fetch;
    this.clock = clock ?? utc_now;
  }

  get credentials(): string {
    return join(this.config_dir, '.credentials.json');
  }

  /** The token, and a note on its expiry for an error message. */
  _login(): [string, string] {
    let oauth: Json;
    try {
      const data: Json = JSON.parse(utf8_kept_bom.decode(readFileSync(this.credentials)));
      if (!is_dict(data)) throw attribute_error(data);
      oauth = get(data, 'claudeAiOauth');
      if (!truthy(oauth)) oauth = {};
    } catch (e) {
      throw new UsageError(`no Claude login readable in ${this.credentials} (${login_error_name(e)})`, { login: true, called: false });
    }
    if (!is_dict(oauth)) throw attribute_error(oauth);   // outside Python's try: not a UsageError
    const token = strip(py_str(truthy(get(oauth, 'accessToken')) ? oauth.accessToken : ''));
    if (!token) throw new UsageError(`no Claude login in ${this.credentials}`, { login: true, called: false });
    let note = '';
    const expires = get(oauth, 'expiresAt');
    if (typeof expires === 'number' || typeof expires === 'boolean') {   // Python's bool is an int
      const at = new Date(Number(expires));
      if (at.getTime() <= this.clock().getTime()) {
        note = `; the login expired at ${local_minutes(at)} (any Claude Code session refreshes it)`;
      }
    }
    return [token, note];
  }

  async read(): Promise<Usage> {
    const [token, note] = this._login();
    const request: Request = { full_url: URL, headers: { ...HEADERS, authorization: `Bearer ${token}` } };
    let body: Uint8Array | string;
    try {
      body = await this.fetch(request);
    } catch (e) {
      if (e instanceof HTTPError) throw new UsageError(`the usage endpoint answered HTTP ${e.code}${note}`, { login: e.code === 401 });
      // The message is ours: an exception's own could echo the request.
      throw new UsageError(`reading usage failed (${type_name(e)})${note}`);
    }
    return parse(body, this.clock());
  }
}

/** A usage reading: the last good value (a `Usage`, or ChatGPT's `Limits`) and when it was read,
 *  the newest read's error if that one failed, whether that error is the login's, (Claude's)
 *  when the endpoint may be asked again, null for now, and since when the reads have failed
 *  without one answering (null: not known). */
export class Reading<T = unknown> {
  readonly value: T | null;
  readonly at: Date | null;
  readonly error: string | null;
  readonly login: boolean;
  readonly next_at: Date | null;
  readonly since: Date | null;
  constructor(value: T | null, at: Date | null, error: string | null = null, login = false, next_at: Date | null = null,
    since: Date | null = null) {
    [this.value, this.at, this.error, this.login, this.next_at, this.since] = [value, at, error, login, next_at, since];
    Object.freeze(this);
  }

  /** Whether its error is worth showing: it has lasted `SHOW_AFTER`, and there's no good value,
   *  the login is the trouble, or the good value is older than `STALE_AFTER`. A failed call
   *  beside a recent good reading isn't: the reading stands, as in T3. */
  failing(now: Date): boolean {
    return this.error !== null && lasted(this.since, now) && (
      this.value === null || this.at === null || this.login || now.getTime() - this.at.getTime() > STALE_AFTER);
  }
}

function _first_line(e: Error): string {
  return head(splitlines(strip(e.message))[0] ?? type_name(e), 200);
}

/** Python's `threading.Lock` for async callers: each `hold` runs after the one before it ends. */
class Lock {
  private tail: Promise<void> = Promise.resolve();

  async hold<R>(f: () => Promise<R> | R): Promise<R> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await before;
    try {
      return await f();
    } finally {
      release();
    }
  }
}

/** Claude's usage, asked of `endpoint` at most once every `endpoint.call_every` seconds
 *  (`CALL_EVERY` for the real one) whoever asks: the gate, its after-job read, the snapshot's read
 *  and Refresh. A failed call counts against the budget; a login that can't be read asks nothing,
 *  so it doesn't. `on_call(ok, note)` hears every attempt (the dashboard's source). */
export class CachedUsage<T = Usage> {
  readonly endpoint: Endpoint<T>;
  every: number;   // milliseconds
  readonly clock: Clock;
  on_call: ((ok: boolean, note: string | null) => void) | null;
  private readonly _lock = new Lock();
  private _good: [T, Date] | null = null;
  private _error: UsageError | null = null;
  private _called: Date | null = null;   // the last call to the endpoint
  private _tried: Date | null = null;    // the last attempt, a login's too
  private _since: Date | null = null;    // the first failure since one answered

  constructor(endpoint: Endpoint<T>, clock: Clock | null = null, on_call: CachedUsage<T>['on_call'] = null) {
    this.endpoint = endpoint;
    this.every = (endpoint.call_every ?? CALL_EVERY) * 1000;
    this.clock = clock ?? utc_now;
    this.on_call = on_call;
  }

  private _next(now: Date): Date | null {
    const at = this._called !== null ? new Date(this._called.getTime() + this.every) : null;
    return at !== null && at.getTime() > now.getTime() ? at : null;
  }

  /** When the endpoint may be asked again; null: now. */
  next_call_at(): Promise<Date | null> {
    return this._lock.hold(() => this._next(this.clock()));
  }

  /** How long until the endpoint may be asked again, in seconds. */
  wait_seconds(): Promise<number> {
    return this._lock.hold(() => {
      const now = this.clock();
      const at = this._next(now);
      return at ? (at.getTime() - now.getTime()) / 1000 : 0;
    });
  }

  /** Whether a read now would ask the endpoint, and the last attempt is `seconds` old. */
  due(seconds: number): Promise<boolean> {
    return this._lock.hold(() => {
      const now = this.clock();
      return this._next(now) === null && (this._tried === null || (now.getTime() - this._tried.getTime()) / 1000 >= seconds);
    });
  }

  /** Reads if `due(seconds)`, as `snapshot.Watch.read_if_due`. `read` keeps to the budget itself,
   *  so two callers both finding it due still ask the endpoint once. */
  async read_if_due(seconds: number): Promise<void> {
    if (await this.due(seconds)) {
      try {
        await this.read();
      } catch {
        // kept as the last error
      }
    }
  }

  /** Asks the endpoint if the budget allows, then gives the last good value, which may be the
   *  cached one. Throws `UsageError` only while there's no good value. */
  read(): Promise<T> {
    return this._lock.hold(async () => {   // held through the call: two callers never ask at once
      const now = this.clock();
      if (this._next(now) === null) await this._call(now);
      if (this._good === null) throw this._error ?? new UsageError('Claude usage is not read yet', { called: false });
      return this._good[0];
    });
  }

  private async _call(now: Date): Promise<void> {
    this._tried = now;
    let value: T;
    try {
      value = await this.endpoint.read();
    } catch (e) {   // anything but ours is said by its type: its text could echo more
      const err = e instanceof UsageError ? e : new UsageError(`reading usage failed (${type_name(e)})`);
      if (err.called) this._called = now;
      this._error = err;
      this._since = this._since ?? now;
      this.on_call?.(false, _first_line(err));
      return;
    }
    [this._called, this._good, this._error, this._since] = [now, [value, now], null, null];
    this.on_call?.(true, null);
  }

  /** The cached reading, asking nothing; null before any attempt. */
  reading(): Promise<Reading<T> | null> {
    return this._lock.hold(() => {
      if (this._good === null && this._error === null) return null;
      const [value, at] = this._good ?? [null, null];
      const err = this._error;
      return new Reading<T>(value, at, err ? _first_line(err) : null, !!(err && err.login), this._next(this.clock()), this._since);
    });
  }
}
