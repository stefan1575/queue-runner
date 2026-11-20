// In-memory T3 for the ported lanes' tests: no T3 server. Ported from `tests/fakes_t3.py`'s
// `FakeT3` and `decision_reply` and `tests/fakes.py`'s `FakeLimits` (#217), with Python's names
// and answers. Each call is async, as the seam's are (`src/t3-seam.ts`). Its threads answer as
// T3's recorded ones do (`test/recorded-t3.ts`): a settled thread stays readable, and a new turn
// unsettles it.
import { LastCall, Launched, type Message, RunResult, T3Error, Thread } from '../src/t3-seam.ts';

/** A decision thread's reply ending in its answer block. */
export function decision_reply(action: string, version = 1, prose = 'I read the sources.', fields: Record<string, unknown> = {}): string {
  const block = JSON.stringify({ version, action, ...fields });
  return `${prose}\n\n\`\`\`queue-runner-decision\n${block}\n\`\`\`\n`;
}

/** What a `start` or `send` does: [exit code, status] or [exit code, status, reply], or a T3Error. */
export type Outcome = readonly [number, string] | readonly [number, string, string | null] | Error;

/** A thread's fields with one changed (Python's `dataclasses.replace`). */
const replace = (t: Thread, change: Partial<Thread>): Thread => new Thread({ ...t, ...change });

/** `outcomes` are what successive `start` and `send` calls do. Each started thread is kept, so
 *  `show` and `list` can find it; tests change its status to play a thread that moves on (the
 *  user answered it, or it was still running). */
export class FakeT3 {
  outcomes: Outcome[];
  starts: Record<string, unknown>[] = [];
  sends: { thread_id: string; message: string }[] = [];
  threads = new Map<string, Thread>();
  /** Thread id -> its last messages. */
  messages = new Map<string, Message[]>();
  /** Threads started without waiting (ticket 35's ask threads). */
  launches: Record<string, unknown>[] = [];
  /** A T3Error the next launch raises. */
  launch_error: Error | null = null;
  /** Thread ids settled, in order (ticket 70). */
  settles: string[] = [];
  /** An exception every settle raises. */
  settle_error: Error | null = null;
  /** [thread id, title], in order (issue #71). */
  renames: [string, string][] = [];
  /** An exception every rename raises. */
  rename_error: Error | null = null;
  /** The projects `list` was asked for, in order. */
  lists: string[] = [];

  constructor(outcomes: Outcome[] = []) {
    this.outcomes = [...outcomes];
  }

  add(thread_id: string, title: string, status: string, created_at = '2099-01-01T00:00:00.000Z', extra: Partial<Thread> = {}): Thread {
    const t = new Thread({
      thread_id, title, status, settled: false, link: `https://app.t3.codes/threads/env/${thread_id}`, created_at,
      latest_run_id: `run:${thread_id}:1`, ...extra,
    });
    this.threads.set(thread_id, t);
    return t;
  }

  set_status(thread_id: string, status: string): void {
    const t = this.threads.get(thread_id);
    if (t === undefined) throw new Error(`KeyError: '${thread_id}'`);
    this.threads.set(thread_id, replace(t, { status }));
  }

  private next(): Exclude<Outcome, Error> {
    if (!this.outcomes.length) throw new Error('IndexError: pop from empty list');
    const outcome = this.outcomes.shift()!;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  /** As `T3Server.start`: every thread names its provider, model and effort (issue #119). */
  async start(project: string, message: string, { title, provider, model, effort, worktree = null, branch = null }:
    { title: string; provider: string; model: string; effort: string; worktree?: string | null; branch?: string | null }): Promise<RunResult> {
    this.starts.push({ project, message, title, provider, model, effort, worktree, branch });
    const outcome = this.next();
    const thread_id = `mcp:t${this.starts.length}`;
    this.add(thread_id, title, outcome[1], undefined, { branch, worktree_path: `C:/t3/worktrees/${thread_id}` });
    return FakeT3._result(thread_id, outcome);
  }

  private static _result(thread_id: string, outcome: Exclude<Outcome, Error>): RunResult {
    const [code, status] = outcome;
    const reply = outcome.length > 2 ? outcome[2]! : (code === 0 ? 'Done.' : null);
    return new RunResult({ exit_code: code, thread_id, run_id: `run:${thread_id}:1`, status, reply, error: code === 1 ? 'It broke.' : null });
  }

  /** A thread started without waiting: it's running, with no reply yet. */
  async launch(project: string, message: string, { title, provider, model, effort }:
    { title: string; provider: string; model: string; effort: string }): Promise<Launched> {
    this.launches.push({ project, message, title, provider, model, effort });
    if (this.launch_error !== null) {
      const error = this.launch_error;
      this.launch_error = null;
      throw error;
    }
    const thread_id = `mcp:a${this.launches.length}`;
    this.add(thread_id, title, 'running');
    return new Launched({ thread_id, run_id: `run:${thread_id}:1` });
  }

  /** A message to an existing thread: the next outcome is how its new run ends. */
  async send(thread_id: string, message: string): Promise<RunResult> {
    this.sends.push({ thread_id, message });
    const outcome = this.next();
    const t = this.threads.get(thread_id);
    if (t === undefined) throw new Error(`KeyError: '${thread_id}'`);
    // a new turn unsettles a settled thread, as in T3
    this.threads.set(thread_id, replace(t, { status: outcome[1], settled: false }));
    return FakeT3._result(thread_id, outcome);
  }

  async show(thread_id: string, messages = 3): Promise<[Thread, Message[]]> {
    const t = this.threads.get(thread_id);
    if (t === undefined) throw new T3Error(`no thread ${thread_id}`);
    const said = this.messages.get(thread_id) ?? [];
    return [t, messages > 0 ? said.slice(-messages) : [...said]];
  }

  /** Settled threads stay readable (`show`, `list`), as in T3. */
  async settle(thread_id: string): Promise<void> {
    if (this.settle_error !== null) throw this.settle_error;
    this.settles.push(thread_id);
    const t = this.threads.get(thread_id);
    if (t !== undefined) this.threads.set(thread_id, replace(t, { settled: true }));
  }

  /** The thread's title changes; a settled thread stays settled (T3 unsettles only on a new turn). */
  async rename(thread_id: string, title: string): Promise<void> {
    if (this.rename_error !== null) throw this.rename_error;
    this.renames.push([thread_id, title]);
    const t = this.threads.get(thread_id);
    if (t !== undefined) this.threads.set(thread_id, replace(t, { title }));
  }

  async list(project: string): Promise<Thread[]> {
    this.lists.push(project);
    return [...this.threads.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }
}

/** A time as T3 writes one (`2026-11-20T21:49:59.983Z`). */
const iso = (t: Date) => t.toISOString();

/** Plays T3's record of threads for limit recovery (`T3Store`): `resets` maps a thread id to the
 *  reset T3 stored for its runs' limit stop (null: a stop with no reset), `failures` a thread id
 *  to another failure class T3 recorded, `contexts` a thread id to its context in tokens, `starts`
 *  a thread id to when its last real request started (`default_start` for any other thread),
 *  `expires` a thread id to when T3 says its prompt cache expires (none: T3 reports none, issue
 *  #72). Tests never read T3. */
export class FakeLimits {
  resets: Map<string, Date | null>;
  contexts: Map<string, number>;
  failures: Map<string, string>;
  starts: Map<string, Date | null>;
  default_start: Date | null;
  expires: Map<string, Date>;

  constructor({ resets = {}, contexts = {}, failures = {}, starts = {}, default_start = null, expires = {} }: {
    resets?: Record<string, Date | null>; contexts?: Record<string, number>; failures?: Record<string, string>;
    starts?: Record<string, Date | null>; default_start?: Date | null; expires?: Record<string, Date>;
  } = {}) {
    this.resets = new Map(Object.entries(resets));
    this.contexts = new Map(Object.entries(contexts));
    this.failures = new Map(Object.entries(failures));
    this.starts = new Map(Object.entries(starts));
    this.default_start = default_start;
    this.expires = new Map(Object.entries(expires));
  }

  async cache_expires_at(thread_id: string): Promise<Date | null> {
    return this.expires.get(thread_id) ?? null;
  }

  async run_failure(thread_id: string, _run_id: string | null): Promise<Record<string, unknown> | null> {
    if (this.resets.has(thread_id)) {
      const reset = this.resets.get(thread_id)!;
      return { class: 'usage_limit', resetAt: reset ? iso(reset) : null };
    }
    if (this.failures.has(thread_id)) return { class: this.failures.get(thread_id) };
    return null;
  }

  async context_tokens(thread_id: string): Promise<number | null> {
    return this.contexts.get(thread_id) ?? null;
  }

  async last_call(thread_id: string): Promise<LastCall> {
    return new LastCall(this.starts.has(thread_id) ? this.starts.get(thread_id)! : this.default_start, this.contexts.get(thread_id) ?? null);
  }
}
