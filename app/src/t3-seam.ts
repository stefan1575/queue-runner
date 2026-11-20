// T3 Code as the runner sees it: the seam, its data, and the thread facts the runner reads. Ported
// from `queue_runner/t3.py` (#217), with the reads `limits.T3Store` and `effort.T3Files` make
// (`T3Store` here): the same calls and answers, the same names (snake_case, as Python has them),
// with `tests/test_t3.py` ported case for case in `test/t3-seam.test.ts`.
//
// The one change is where the facts come from: T3's local server, as
// `.scratch/queue-runner/research/t3-api-facts.md` found it (T3 0.1.9), never its CLI, its
// database or the agents' own files (docs/app.md, Rules). Python's `t3 thread show`, `thread list`
// and `thread send --wait` go through T3's MCP tools here (`t3_thread_read`, `t3_thread_list`,
// `t3_thread_send`, then the wait `start` already used), and its database and transcript reads
// through the WebSocket (`orchestration.subscribeThread`'s snapshot, which is the whole
// projection, and `subscribeServerConfig`). Where the note found the MCP read hiding a state, the
// read that shows it is used:
//
// - **Waiting on the user.** `pendingRequestCount` counts pending runtime requests only, so a
//   secret card reads 0 with the run `running`, and `t3_thread_wait` times out on it as on an
//   approval. T3's shell (`orchestration.getThreadFamily`) has `pendingRuntimeRequest` for both
//   (the note, section 1, Waiting on the user). `_finish` and `show` read it there.
//
// TypeScript's differences only: every call is async, a Python dataclass is a frozen class built
// from its fields by name, and a field Python reads as `x['key']` is an error when missing.
import { resolve } from 'node:path';
import { when } from './state.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { T3Error } from './t3/seams.ts';
import type { T3Ws } from './t3/ws.ts';

export { T3Error };

type Json = any;

/** `x[key]`: a field that must be there. Missing, or `x` not an object, is an error. */
function need(x: Json, key: string): Json {
  if (x === null || typeof x !== 'object') throw new TypeError(`'${x === null ? 'NoneType' : typeof x}' object is not subscriptable`);
  if (!(key in x)) throw new Error(`KeyError: '${key}'`);
  return x[key];
}

/** `x.get(key)`: the field, or null when it's missing. */
const get = (x: Json, key: string): Json => (x !== null && typeof x === 'object' && key in x ? x[key] : null);

/** Python's `x or {}` for an answer: an object, or an empty one. */
const obj = (x: Json): Json => (x !== null && typeof x === 'object' && !Array.isArray(x) ? x : {});

/** Python's `x or ()` for a list. */
const list = (x: Json): Json[] => (Array.isArray(x) ? x : []);

type Fields<T> = { -readonly [K in keyof T as T[K] extends Function ? never : K]: T[K] };

/** Run statuses (T3's OrchestrationV2RunStatus) that count as active; a thread with none is `idle`. */
export const ACTIVE: ReadonlySet<string> = new Set(['preparing', 'queued', 'starting', 'running']);

/** The option a model's effort goes under when T3's catalog names none for it: Python's default.
 *  Python named the one driver that reads another; here T3's catalog says it (each model's
 *  `effortOption`, its driver's own: the note, section 3), as the app's code names no provider. */
export const EFFORT_OPTION = 'effort';
/** T3's CLI waits in 15-second slices, so a run that asks is noticed soon. */
export const WAIT_SLICE_MS = 15_000;

/** The effort option T3's catalog names for `provider`'s `model`, or null when it names none. */
export type EffortOption = (provider: string, model: string) => string | null;

/** T3's model selection for `provider`'s `model` at `effort`, the effort under `option`. */
export function selection(provider: string, model: string, effort: string, option: string | null = null) {
  return { instanceId: provider, model, options: [{ id: option ?? EFFORT_OPTION, value: effort }] };
}

/** `os.path.normcase(os.path.abspath(p))`: absolute from the working directory; on Windows, lower
 *  case with backslashes. */
const normcase = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** A relative folder is read from the runner's working directory, as the CLI read it: a served
 *  repo's path stays as config.toml wrote it ('.'), T3 holds the absolute root. */
const _same_folder = (a: string, b: string) => normcase(a) === normcase(b);

export class RunResult {
  readonly exit_code!: number;        // 0 completed, 1 ended otherwise, 2 waiting for an answer
  readonly thread_id!: string;
  readonly run_id!: string | null;
  readonly status!: string;
  readonly reply!: string | null;
  readonly error!: string | null;
  constructor(fields: Fields<RunResult>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/** A thread `launch` started: its thread and run. */
export class Launched {
  readonly thread_id!: string;
  readonly run_id!: string | null;
  constructor(fields: Fields<Launched>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

export class Thread {
  readonly thread_id!: string;
  readonly title!: string;
  readonly link!: string;
  readonly status!: string;
  readonly settled!: boolean;
  readonly created_at!: string;
  readonly latest_run_id: string | null = null;
  readonly model: string | null = null;
  readonly branch: string | null = null;          // `show` only
  readonly worktree_path: string | null = null;   // `show` only
  readonly pending_requests: number = 0;          // `show` only
  constructor(fields: Pick<Fields<Thread>, 'thread_id' | 'title' | 'link' | 'status' | 'settled' | 'created_at'> & Partial<Fields<Thread>>) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  get active(): boolean {
    return ACTIVE.has(this.status);
  }
}

export class Message {
  readonly role!: string;   // user | assistant
  readonly text!: string;
  readonly run_id: string | null = null;   // the run that wrote it
  constructor(role: string, text: string, run_id: string | null = null) {
    Object.assign(this, { role, text, run_id });
    Object.freeze(this);
  }
}

/** The seam's calls, for what takes a T3 (a lane, `find_job_thread`) and the tests' fakes. */
export type T3 = Pick<T3Server, 'start' | 'launch' | 'send' | 'show' | 'list' | 'settle' | 'rename'>;

/** A job as `find_job_thread` reads it (`state.Job`'s fields). */
export type JobRef = { readonly thread_id: string | null; readonly started_at: string; readonly title: string };

/** A job's T3 thread (`show`): by its `thread_id`, else by its title among the threads of
 *  `project` created after the job's start record (5 seconds' slack), the newest. Null when
 *  there's none, or no project to look in. T3Error propagates. */
export async function find_job_thread(t3: Pick<T3, 'show' | 'list'>, job: JobRef, project: string | null): Promise<Thread | null> {
  if (job.thread_id) return (await t3.show(job.thread_id))[0];
  if (project === null) return null;
  const since = when(job.started_at).getTime() - 5_000;
  const found = (await t3.list(project)).filter((t) => t.title === job.title && when(t.created_at).getTime() >= since);
  if (!found.length) return null;
  // Python's max: the first of the newest
  const newest = found.reduce((a, t) => (when(t.created_at).getTime() > when(a.created_at).getTime() ? t : a));
  return (await t3.show(newest.thread_id))[0];
}

function _thread(raw: Json): Thread {
  return new Thread({
    thread_id: need(raw, 'threadId'), title: need(raw, 'title'), link: need(raw, 'link'),
    status: need(raw, 'status'), settled: Boolean(get(raw, 'settled')),
    created_at: need(raw, 'createdAt'), latest_run_id: get(raw, 'latestRunId'),
    model: get(raw, 'model'), branch: get(raw, 'branch'), worktree_path: get(raw, 'worktreePath'),
    pending_requests: get(raw, 'pendingRequestCount') || 0,
  });
}

/** A message item's role, as `t3 thread show` names it. */
const ROLES: Readonly<Record<string, string>> = { user_message: 'user', assistant_message: 'assistant' };

/** T3 Code through its local server: MCP tools for the thread calls, the WebSocket for the shell's
 *  waits-on-the-user. */
export class T3Server {
  readonly mcp: Pick<T3Mcp, 'call'>;
  readonly ws: Pick<T3Ws, 'request'>;
  readonly effort_option: EffortOption;

  constructor(mcp: Pick<T3Mcp, 'call'>, ws: Pick<T3Ws, 'request'>, effort_option: EffortOption) {
    this.mcp = mcp;
    this.ws = ws;
    this.effort_option = effort_option;
  }

  /** The id of the T3 project whose folder is `folder`. */
  private async _project(folder: string): Promise<string> {
    let cursor: Json = 0;
    while (cursor !== null && cursor !== undefined) {
      const page = obj(await this.mcp.call('t3_project_list', { cursor, limit: 100 }));
      for (const p of list(page.projects)) {
        if (get(p, 'workspaceRoot') && _same_folder(p.workspaceRoot, folder)) return p.id;
      }
      cursor = get(page, 'nextCursor');
    }
    throw new T3Error(`No T3 Code project matches '${folder}'`);
  }

  /** `t3_thread_launch` with the model and its effort named: `{threadId, runId, ...}`. */
  private async _launch(project: string, message: string, title: string, provider: string, model: string,
                        effort: string, worktree: string | null, branch: string | null): Promise<Json> {
    if (branch && !worktree) throw new Error('ValueError: a branch needs a worktree base');
    const args: Record<string, unknown> = {
      projectId: await this._project(project), title, message, runtimeMode: 'full-access',
      modelSelection: selection(provider, model, effort, this.effort_option(provider, model)),
    };
    if (worktree) { // as the CLI's --worktree and --branch (`launchWorkspaceStrategy`)
      args.workspaceStrategy = { type: 'worktree', baseRef: worktree, ...(branch ? { branch } : {}) };
    }
    const launched = await this.mcp.call('t3_thread_launch', args);
    if (launched === null || typeof launched !== 'object' || !launched.threadId) {
      throw new T3Error(`t3_thread_launch started no thread: ${JSON.stringify(launched) ?? 'None'}`.slice(0, 300));
    }
    return launched;
  }

  /** Starts a thread on `provider`'s `model` at `effort` and waits until its run ends.
   *  `worktree` is the base ref of a new T3 worktree, `branch` the branch T3 makes there. */
  async start(project: string, message: string, { title, provider, model, effort, worktree = null, branch = null }:
    { title: string; provider: string; model: string; effort: string; worktree?: string | null; branch?: string | null }): Promise<RunResult> {
    const launched = await this._launch(project, message, title, provider, model, effort, worktree, branch);
    const thread_id: string = launched.threadId;
    const run_id: string | null = get(launched, 'runId');
    if (!run_id) throw new T3Error(`T3 started thread ${thread_id} with no run`);
    return this._finish(thread_id, run_id);
  }

  /** Starts a thread in the project folder on `provider`'s `model` at `effort` and returns at once. */
  async launch(project: string, message: string, { title, provider, model, effort }:
    { title: string; provider: string; model: string; effort: string }): Promise<Launched> {
    const launched = await this._launch(project, message, title, provider, model, effort, null, null);
    return new Launched({ thread_id: launched.threadId, run_id: get(launched, 'runId') });
  }

  private async _wait(thread_id: string, run_id: string, timeout_ms: number): Promise<Json> {
    return obj(await this.mcp.call('t3_thread_wait', { threadId: thread_id, runId: run_id, timeoutMs: timeout_ms }));
  }

  /** Whether the thread waits on the user, as T3's shell says (`pendingRuntimeRequest`): an
   *  approval, a question or a secret card. `pendingRequestCount` on the MCP read misses a secret
   *  card, and `t3_thread_wait` times out on both (the note, section 1). A thread the shell doesn't
   *  list (archived, deleted) waits on nobody. */
  private async _waits_on_user(thread_id: string): Promise<boolean> {
    const family = obj(await this.ws.request('orchestration.getThreadFamily', { threadId: thread_id }));
    const shell = list(family.threads).find((t) => get(t, 'id') === thread_id);
    return Boolean(get(shell ?? {}, 'pendingRuntimeRequest'));
  }

  /** Waits for the run as `t3 thread start --wait --json` does (`waitForRun` and `finishRun` in
   *  T3's binCli): slices of `t3_thread_wait`; a thread waiting on the user after a timed-out
   *  slice is a run waiting for an answer, unless one more short wait ends it. */
  private async _finish(thread_id: string, run_id: string): Promise<RunResult> {
    let waited: Json;
    for (;;) {
      waited = await this._wait(thread_id, run_id, WAIT_SLICE_MS);
      if (!waited.timedOut) break;
      if (await this._waits_on_user(thread_id)) {
        waited = await this._wait(thread_id, run_id, 1);
        if (waited.timedOut) {
          return new RunResult({ exit_code: 2, thread_id, run_id, status: 'waiting', reply: null, error: null });
        }
        break;
      }
    }
    run_id = get(waited, 'runId') || run_id;
    const status: string = get(waited, 'status') || 'unknown';
    const done = status === 'completed';
    return new RunResult({
      exit_code: done ? 0 : 1, thread_id, run_id, status,
      reply: done ? await this._run_text(thread_id, run_id, 'assistant_message') : null,
      error: done ? null : await this._run_text(thread_id, run_id, 'error'),
    });
  }

  /** Every item of the thread's `view`, paged by `afterPosition` while T3 says there's more. */
  private async _items(thread_id: string, view: string, runLimit?: number): Promise<Json[]> {
    const items: Json[] = [];
    let after: Json = null;
    for (;;) {
      const page = obj(await this.mcp.call('t3_thread_read', {
        threadId: thread_id, view, limit: 100, ...(runLimit === undefined ? {} : { runLimit }),
        ...(after === null ? {} : { afterPosition: after }),
      }));
      items.push(...list(page.items));
      after = get(page, 'nextPosition');
      if (!page.hasMore || after === null) break;
    }
    return items;
  }

  /** An item's whole text: T3 cuts a long one, and it's read on by `textOffset` while T3 says
   *  it's truncated (`runResultText` in T3's binCli). */
  private async _full_text(thread_id: string, item: Json): Promise<string> {
    let text: string = get(item, 'text') || '';
    let offset: Json = get(item, 'textTruncated') ? get(item, 'nextTextOffset') : null;
    while (offset !== null && offset !== undefined) {
      const page = obj(await this.mcp.call('t3_thread_read', { threadId: thread_id, itemId: item.itemId, textOffset: offset, runLimit: 1 }));
      const chunk = list(page.items).find((i) => get(i, 'itemId') === item.itemId);
      if (chunk === undefined) break;
      text += get(chunk, 'text') || '';
      offset = get(chunk, 'textTruncated') ? get(chunk, 'nextTextOffset') : null;
    }
    return text;
  }

  /** The run's last `kind` item's full text (`runResultText` in T3's binCli). */
  private async _run_text(thread_id: string, run_id: string, kind: string): Promise<string | null> {
    const items = await this._items(thread_id, kind === 'assistant_message' ? 'messages' : 'activity', 1);
    const found = items.filter((i) => get(i, 'runId') === run_id && get(i, 'type') === kind);
    if (!found.length) return null;
    return this._full_text(thread_id, found.at(-1));
  }

  /** Sends a message (T3's `queue` mode: a thread whose run ended starts the new one at once) and
   *  waits until the run it starts ends, as `t3 thread send --wait --json` does. */
  async send(thread_id: string, message: string): Promise<RunResult> {
    const sent = obj(await this.mcp.call('t3_thread_send', { threadId: thread_id, message, mode: 'queue' }));
    const run_id: string | null = get(sent, 'runId');
    if (!run_id) throw new T3Error(`T3 took the message to thread ${thread_id} with no run`);
    return this._finish(thread_id, run_id);
  }

  /** The thread and its last `messages` messages (`t3 thread show --messages <n> --json`), each
   *  in full. Its pending requests count a secret card too, which the MCP read leaves out. */
  async show(thread_id: string, messages = 3): Promise<[Thread, Message[]]> {
    const read = obj(await this.mcp.call('t3_thread_read', { threadId: thread_id, limit: 1, runLimit: 1 }));
    const raw = need(read, 'thread');
    const waits = await this._waits_on_user(thread_id);
    const thread = _thread({ ...raw, pendingRequestCount: get(raw, 'pendingRequestCount') || (waits ? 1 : 0) });
    const said = (await this._items(thread_id, 'messages')).filter((i) => Object.hasOwn(ROLES, get(i, 'type') ?? ''));
    const last = messages > 0 ? said.slice(-messages) : [];
    const out: Message[] = [];
    for (const m of last) out.push(new Message(ROLES[m.type]!, await this._full_text(thread_id, m), get(m, 'runId')));
    return [thread, out];
  }

  /** The threads of the project whose folder is `project` (`t3 thread list --project`), every
   *  page: T3 lists the active ones, newest first. */
  async list(project: string): Promise<Thread[]> {
    const projectId = await this._project(project);
    const threads: Thread[] = [];
    let cursor: Json = null;
    for (;;) {
      const page = obj(await this.mcp.call('t3_thread_list', { projectId, limit: 100, ...(cursor === null ? {} : { cursor }) }));
      threads.push(...list(page.threads).map(_thread));
      cursor = get(page, 'nextCursor');
      if (cursor === null || cursor === undefined) return threads;
    }
  }

  /** Settles a thread the runner started: it leaves T3's sidebar and stays readable. */
  async settle(thread_id: string): Promise<void> {
    await this.mcp.call('t3_thread_organize', { threadId: thread_id, action: 'settle' });
  }

  async rename(thread_id: string, title: string): Promise<void> {
    await this.mcp.call('t3_thread_update', { threadId: thread_id, action: 'rename', title });
  }
}

/** Settles a thread the runner started, once it's done with it (ticket 70): it leaves the user's
 *  sidebar and stays readable. A failure is said and never raised: a thread left in the sidebar
 *  stops no lane. False if it wasn't settled. */
export async function settle_quietly(t3: Pick<T3, 'settle'> | null, thread_id: string | null, name: string,
                                     say: (line: string) => void): Promise<boolean> {
  if (!thread_id || t3 === null) return false;
  try {
    await t3.settle(thread_id);
  } catch (e) { // T3 down, or refused
    const err = e as Error;
    say(`${name}: settling its thread ${thread_id} in T3 failed (${err?.constructor?.name ?? 'Error'}: ${err?.message ?? e}); left as it is`);
    return false;
  }
  return true;
}

// --- A thread's facts: limits.T3Store and effort.T3Files ------------------------------------

/** A thread's last real call to its provider: when its request started (null: T3 reports no
 *  cache start for it) and its context in tokens (null: no call). `at`, when the call was
 *  recorded, says which call is last; it isn't part of what a LastCall says (Python's
 *  `compare=False`). */
export class LastCall {
  readonly started!: Date | null;
  readonly tokens!: number | null;
  readonly at: Date | null = null;
  constructor(started: Date | null, tokens: number | null, at: Date | null = null) {
    Object.assign(this, { started, tokens, at });
    Object.freeze(this);
  }

  /** Python's `==`: `at` isn't compared. */
  equals(other: LastCall): boolean {
    return (this.started?.getTime() ?? null) === (other.started?.getTime() ?? null) && this.tokens === other.tokens;
  }
}

/** An ISO time, or null when it isn't one. */
function _when(stamp: Json): Date | null {
  if (typeof stamp !== 'string') return null;
  const t = new Date(stamp);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** The reset a failure stored, or null. */
export function _reset(failure: Json): Date | null {
  return get(failure, 'resetAt') ? _when(failure.resetAt) : null;
}

/** The effort a model selection names (its `effort` option), or null. */
export function selection_effort(selection: Json): string | null {
  for (const option of list(get(selection ?? {}, 'options'))) {
    if (option !== null && typeof option === 'object' && option.id === 'effort') return get(option, 'value');
  }
  return null;
}

/** T3's record of a thread, read-only: what Python read from T3's database (`limits.T3Store`,
 *  `effort.T3Files`) and the agent's transcripts, read here from the thread's projection on
 *  T3's server (`orchestration.subscribeThread`'s first value, the whole projection: the note,
 *  section 1). Anything unreadable reads as nothing found. */
export class T3Store {
  readonly ws: Pick<T3Ws, 'first'>;

  constructor(ws: Pick<T3Ws, 'first'>) {
    this.ws = ws;
  }

  /** The thread's projection, or null when T3 can't give it (down, or no such thread). */
  private async _projection(thread_id: string): Promise<Json | null> {
    try {
      const first = await this.ws.first('orchestration.subscribeThread', { threadId: thread_id });
      return get(first, 'kind') === 'snapshot' ? obj(get(first, 'projection')) : null;
    } catch (e) {
      if (e instanceof T3Error) return null;
      throw e;
    }
  }

  /** The failure T3 recorded for this run (`{class, message, code, resetAt...}`, on its `error`
   *  turn items), or null if it recorded none or can't be read. A usage limit is `class`
   *  `usage_limit`, and wins over another failure of the same run. */
  async run_failure(thread_id: string, run_id: string | null): Promise<Json | null> {
    if (!run_id) return null;
    const projection = await this._projection(thread_id);
    let found: Json = null;
    const errors = list(projection?.turnItems)
      .filter((i) => get(i, 'runId') === run_id && get(i, 'type') === 'error')
      .sort((a, b) => (get(a, 'ordinal') ?? 0) - (get(b, 'ordinal') ?? 0));
    for (const item of errors) {
      const failure = get(item, 'failure');
      if (failure !== null && typeof failure === 'object' && !Array.isArray(failure) && get(failure, 'class')) {
        found = failure;
        if (failure.class === 'usage_limit') return failure;
      }
    }
    return found;
  }

  /** [found, reset]: whether T3 recorded this run stopping on a usage limit, and the reset it
   *  stored (null if it stored none). */
  async limit_reset(thread_id: string, run_id: string | null): Promise<[boolean, Date | null]> {
    const failure = await this.run_failure(thread_id, run_id);
    if (!failure || failure.class !== 'usage_limit') return [false, null];
    return [true, _reset(failure)];
  }

  /** The thread's last real call: its newest provider turn's `tokenUsage`, where `usedTokens` is
   *  the call's whole prompt, cached or not, plus its reply (input plus output in every recorded
   *  turn), and the request started at `promptCacheExpiresAt` less `promptCacheTtlMs`, the start
   *  T3 counts the cache's hour from. A turn with no `tokenUsage` (a run that failed before the
   *  provider answered) isn't a call. */
  async last_call(thread_id: string): Promise<LastCall> {
    const projection = await this._projection(thread_id);
    let newest: { at: Date; usage: Json } | null = null;
    for (const turn of list(projection?.providerTurns)) {
      const usage = get(turn, 'tokenUsage');
      if (usage === null || typeof usage !== 'object') continue;
      const at = _when(get(usage, 'updatedAt'));
      if (at !== null && (newest === null || at > newest.at)) newest = { at, usage };
    }
    if (newest === null) return new LastCall(null, null);
    const { usage } = newest;
    const expires = _when(get(usage, 'promptCacheExpiresAt'));
    const ttl = get(usage, 'promptCacheTtlMs');
    const started = expires !== null && typeof ttl === 'number' ? new Date(expires.getTime() - ttl) : null;
    const tokens = typeof get(usage, 'usedTokens') === 'number' ? usage.usedTokens : null;
    return new LastCall(started, tokens, newest.at);
  }

  async context_tokens(thread_id: string): Promise<number | null> {
    return (await this.last_call(thread_id)).tokens;
  }

  /** When the thread's prompt cache expires, as T3 reports it (issue #72): the newest
   *  `tokenUsage.promptCacheExpiresAt` on its provider turns, by `updatedAt`. Null when T3
   *  reports none or it can't be read. */
  async cache_expires_at(thread_id: string): Promise<Date | null> {
    const projection = await this._projection(thread_id);
    let newest: [string, Json] | null = null;
    for (const turn of list(projection?.providerTurns)) {
      const usage = obj(get(turn, 'tokenUsage'));
      const at: string = get(usage, 'updatedAt') || '';
      if (newest === null || at > newest[0]) newest = [at, get(usage, 'promptCacheExpiresAt')];
    }
    if (newest === null || typeof newest[1] !== 'string') return null;
    return _when(newest[1]);
  }

  /** The effort the run asked for, as T3's run record has it (its model selection's `effort`
   *  option); null if it says none. */
  async run_effort(thread_id: string, run_id: string | null): Promise<string | null> {
    if (!run_id) return null;
    const projection = await this._projection(thread_id);
    const run = list(projection?.runs).find((r) => get(r, 'id') === run_id);
    return selection_effort(get(run ?? {}, 'modelSelection'));
  }
}

/** A warning if T3's "Resume after usage limits" is on (`autoResumeLimitedThreads` in its
 *  settings, as `subscribeServerConfig` gives them): it would continue a limited thread in place
 *  itself, racing the runner. Off by default (T3's settings schema). Null when it's off or T3
 *  can't say. */
export async function auto_resume_warning(ws: Pick<T3Ws, 'first'>): Promise<string | null> {
  let on: boolean;
  try {
    const config = await ws.first('subscribeServerConfig', {});
    on = Boolean(get(obj(get(obj(get(config, 'config')), 'settings')), 'autoResumeLimitedThreads'));
  } catch (e) {
    if (e instanceof T3Error) return null;
    throw e;
  }
  if (!on) return null;
  return 'T3\'s "Resume after usage limits" is on (its settings, autoResumeLimitedThreads): it '
    + 'continues a thread cut off by a limit itself, racing the runner. Turn it off in T3 Settings.';
}
