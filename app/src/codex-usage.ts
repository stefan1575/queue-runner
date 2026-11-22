// ChatGPT's usage and reset credits, ported from `queue_runner/codex_usage.py` (#263), read the way
// T3 reads them (ticket 42): `codex app-server` started for one call, JSON-RPC over its stdin and
// stdout (one JSON object a line): `initialize`, `initialized`, then `account/rateLimits/read`
// (T3's `probeCodexAppServerProvider`, `resources/server.asar`, read 2026-11-16). Codex reads its
// own login; the runner never sees it.
//
// The answer's `rateLimitsByLimitId.codex` (else `rateLimits`) has the plan and its windows
// (`primary` the session, `secondary` the week: `usedPercent`, `windowDurationMins`, `resetsAt` in
// epoch seconds), and `rateLimitResetCredits.availableCount` the reset credits left (T3's
// `codexResetCreditsToContract`). Redeeming one is T3's: the runner only counts them.
//
// It answers in about a second. Starting the app server rewrites Codex's shared model list
// (`~/.codex/models_cache.json`, seen 2026-11-16); T3's own Codex check writes it again.
//
// Python reads the server's output on a thread into a queue and waits on the queue with the
// call's deadline. Here the output's lines go into `Lines` as they come, and `_answer` awaits the
// next one with what is left of the deadline.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { which } from './deps.ts';
import { type Json, get, head, is_dict, py_eq, py_str, truthy } from './python.ts';

export const TIMEOUT = 20;   // seconds for the whole call: T3 allows 20 for its probe
export const CLIENT = { name: 'queue-runner', title: 'Queue runner', version: '1' };
// A window whose length isn't given takes its place's (T3's `codexRateLimitsToWindows`).
export const PLACES: readonly (readonly [string, number])[] = [['primary', 300], ['secondary', 10080]];

// `sol.py`'s `LimitWindow` and `Limits`, here until the Sol port (#222) ports `sol.py`.
export class LimitWindow {
  readonly minutes: number;            // the window's length: 300 is the session, 10080 the week
  readonly used: number;               // percent used
  readonly resets_at: Date | null;
  constructor(minutes: number, used: number, resets_at: Date | null) {
    [this.minutes, this.used, this.resets_at] = [minutes, used, resets_at];
    Object.freeze(this);
  }
}

/** ChatGPT's plan windows, as Codex last reported them in a rollout's `rate_limits`, or as its app
 *  server read them (`codex-usage.ts`, with `resets`: reset credits left, null if unknown). */
export class Limits {
  readonly plan: string | null;
  readonly windows: readonly LimitWindow[];
  readonly resets: number | null;
  constructor(plan: string | null, windows: readonly LimitWindow[], resets: number | null = null) {
    [this.plan, this.windows, this.resets] = [plan, windows, resets];
    Object.freeze(this);
  }
}

/** ChatGPT's usage couldn't be read through Codex. */
export class CodexUsageError extends Error {
  override name = 'CodexUsageError';
}

/** Codex on PATH, else the newest copy the Codex app keeps (codex-sol.sh looks there too). */
export function find_codex(): string | null {
  const found = which('codex');
  if (found) return found;
  const bin = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  let names: string[] = [];
  try {
    names = readdirSync(bin);
  } catch {
    // glob finds nothing in a folder that isn't there
  }
  const bundled = names.filter((n) => !n.startsWith('.')).map((n) => join(bin, n, 'codex.exe')).filter((p) => existsSync(p));
  if (!bundled.length) return null;
  return bundled.reduce((a, b) => (statSync(b).mtimeMs > statSync(a).mtimeMs ? b : a));
}

/** Python's `isinstance(x, (int, float)) and not isinstance(x, bool)`. */
const is_number = (x: Json): x is number => typeof x === 'number';
/** Python's `isinstance(x, int)`, a bool included. */
const is_int = (x: Json): boolean => Number.isInteger(x) || typeof x === 'boolean';

function _window(raw: Json, minutes: number): LimitWindow | null {
  if (!is_dict(raw)) return null;
  const used = get(raw, 'usedPercent');
  if (!is_number(used)) return null;
  const length = get(raw, 'windowDurationMins'), reset = get(raw, 'resetsAt');
  return new LimitWindow(is_int(length) && Number(length) > 0 ? Number(length) : minutes, used,
    is_number(reset) ? new Date(reset * 1000) : null);
}

/** Python's `AttributeError`: `.get` on a value that isn't a dict. */
function no_get(x: Json): Error {
  const e = new Error(`'${Array.isArray(x) ? 'list' : typeof x === 'string' ? 'str' : typeof x}' object has no attribute 'get'`);
  e.name = 'AttributeError';
  return e;
}

/** `account/rateLimits/read`'s result as the plan's windows and reset credits. */
export function parse(result: Json): Limits {
  if (!is_dict(result)) throw new CodexUsageError("Codex's usage answer is not an object");
  const by_id = truthy(get(result, 'rateLimitsByLimitId')) ? result.rateLimitsByLimitId : {};
  if (!is_dict(by_id)) throw no_get(by_id);
  const own = get(by_id, 'codex');
  const snap = truthy(own) ? own : get(result, 'rateLimits');
  if (!is_dict(snap)) throw new CodexUsageError("Codex's usage answer has no rate limits");
  const windows = PLACES.map(([name, minutes]) => _window(get(snap, name), minutes)).filter((w): w is LimitWindow => w !== null);
  if (!windows.length) throw new CodexUsageError("Codex's usage answer has no window");
  const credits = get(result, 'rateLimitResetCredits');
  const count = is_dict(credits) ? get(credits, 'availableCount') : null;
  const resets = Number.isInteger(count) ? Math.max(0, count) : null;
  const plan = get(snap, 'planType');
  return new Limits(typeof plan === 'string' ? plan : null, windows, resets);
}

const EMPTY = Symbol('queue.Empty');

/** Python's `queue.Queue` of the server's output lines: null once its output ended. */
class Lines {
  private readonly items: (string | null)[] = [];
  private waiter: (() => void) | null = null;

  put(line: string | null): void {
    this.items.push(line);
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The next line, or `EMPTY` when none comes in `ms`. */
  get(ms: number): Promise<string | null | typeof EMPTY> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(EMPTY);
      }, ms);
      this.waiter = () => {
        clearTimeout(timer);
        resolve(this.items.shift()!);
      };
    });
  }
}

/** Python's `type(e).__name__` for a process that didn't start. */
function os_error_name(e: NodeJS.ErrnoException): string {
  if (e.code === 'ENOENT') return 'FileNotFoundError';
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'PermissionError';
  return 'OSError';
}

type Options = { command?: string[] | null; timeout?: number; clock?: (() => Date) | null; find?: () => string | null };

/** `read()` gives [when it was read, Limits], as `snapshot.Watch(timed=True)` takes it. `command`
 *  is the app server's command line (a test's stand-in); by default it's the Codex `find` finds,
 *  with `app-server`. */
export class CodexUsage {
  readonly command: string[] | null;
  readonly timeout: number;
  readonly find: () => string | null;
  readonly clock: () => Date;

  constructor({ command = null, timeout = TIMEOUT, clock = null, find = find_codex }: Options = {}) {
    this.command = command;
    this.timeout = timeout;
    this.find = find;
    this.clock = clock ?? (() => new Date());
  }

  async read(): Promise<[Date, Limits]> {
    let command = this.command;
    if (command === null) {
      const codex = this.find();
      if (!codex) throw new CodexUsageError("Codex is not installed where the runner looks (PATH, or the Codex app's own copy)");
      command = [codex, 'app-server'];
    }
    const proc = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }) as unknown as ChildProcessWithoutNullStreams;
    const started = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      proc.once('spawn', () => resolve(null));
      proc.once('error', resolve);
    });
    if (started) throw new CodexUsageError(`Codex's app server didn't start (${os_error_name(started)})`);
    proc.on('error', () => {});         // a kill that fails: Python's OSError, passed over
    proc.stdin.on('error', () => {});   // a write to a server that has gone: its output ends
    const lines = new Lines();
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    const pumped = this.pump(proc, lines);
    const deadline = performance.now() + this.timeout * 1000;
    try {
      CodexUsage._send(proc, { id: 1, method: 'initialize', params: { clientInfo: CLIENT, capabilities: { experimentalApi: true } } });
      await CodexUsage._answer(lines, 1, deadline, 'initialize');
      CodexUsage._send(proc, { method: 'initialized' });
      CodexUsage._send(proc, { id: 2, method: 'account/rateLimits/read', params: null });
      const got = await CodexUsage._answer(lines, 2, deadline, 'the usage request');
      return [this.clock(), parse(got)];
    } finally {
      proc.stdin.destroy();
      proc.kill();
      await within(exited, 5000);
      await within(pumped, 5000);
      proc.stdout.destroy();
    }
  }

  /** The server's output, a line at a time (Python's text mode: UTF-8 with bad bytes replaced,
   *  `\n`, `\r` and `\r\n` each a line's end), then null. */
  private pump(proc: ChildProcessWithoutNullStreams, lines: Lines): Promise<void> {
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const flush = (end: boolean) => {
      for (let m = /\r\n|\r|\n/.exec(buf); m; m = /\r\n|\r|\n/.exec(buf)) {
        if (!end && m[0] === '\r' && m.index === buf.length - 1) break;   // a `\r\n` split between reads
        lines.put(`${buf.slice(0, m.index)}\n`);
        buf = buf.slice(m.index + m[0].length);
      }
    };
    return new Promise((resolve) => {
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += decoder.decode(chunk, { stream: true });
        flush(false);
      });
      const done = () => {
        buf += decoder.decode();
        flush(true);
        if (buf) lines.put(buf);
        buf = '';
        lines.put(null);
        resolve();
      };
      proc.stdout.once('end', done);
      proc.stdout.once('error', done);   // closed under it, once the call is over
    });
  }

  static _send(proc: ChildProcessWithoutNullStreams, message: Json): void {
    if (!proc.stdin.writable) throw new CodexUsageError("Codex's app server stopped before it answered");
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** The result of request `id`; notifications and anything else are skipped. */
  static async _answer(lines: Lines, id: number, deadline: number, what: string): Promise<Json> {
    for (;;) {
      const left = deadline - performance.now();
      const line = left <= 0 ? EMPTY : await lines.get(left);
      if (line === EMPTY) throw new CodexUsageError(`Codex's app server did not answer ${what} in time`);
      if (line === null) throw new CodexUsageError(`Codex's app server stopped before it answered ${what}`);   // its output ended
      let message: Json;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!is_dict(message) || !py_eq(get(message, 'id'), id)) continue;
      if (Object.hasOwn(message, 'error')) {
        const error = message.error;
        const text = is_dict(error) ? get(error, 'message') : error;
        throw new CodexUsageError(`Codex refused ${what}: ${head(py_str(text), 200)}`);
      }
      return get(message, 'result');
    }
  }
}

/** Waits for `p`, or `ms`, whichever comes first (Python's `wait(timeout=5)` and `join(timeout=5)`,
 *  whose expiry is passed over). */
async function within(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}
