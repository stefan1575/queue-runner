// T3 Code as the runner sees it: the seam and its data. Ported from `queue_runner/t3.py` (#217):
// the same calls and answers, the same names (snake_case, as Python has them), with
// `tests/test_t3.py` ported case for case in `test/t3-seam.test.ts`. The thread facts Python reads
// from T3's database and the agent's files (`limits.T3Store`, `effort.T3Files`) port with their users
// (#227, #228).
//
// The one change is where the facts come from: T3's local server, as
// `.scratch/queue-runner/research/t3-api-facts.md` found it (T3 0.1.9), never its CLI, its
// database or the agents' own files (docs/app.md, Rules). Python's `t3 thread show`, `thread list`
// and `thread send --wait` go through T3's MCP tools here (`t3_thread_read`, `t3_thread_list`,
// `t3_thread_send`, then the wait `start` already used). Where the note found the MCP read hiding
// a state, the read that shows it is added:
//
// - **Waiting on the user.** `pendingRequestCount` counts pending runtime requests only, so a
//   secret card reads 0 with the run `running`, and `t3_thread_wait` times out on it as on an
//   approval (the note, section 1, Waiting on the user). `_finish` and `show` add the run's own
//   secret cards still `waiting` (its `secret_request` items on the activity view). A card counts
//   only for the run it belongs to: T3's shell (`pendingRuntimeRequest`) also shows a link card
//   after its run ended (`waitsOnUser`, the note), which Python's read never counted.
//
// TypeScript's differences only: every call is async, a Python dataclass is a frozen class built
// from its fields by name, and a field Python reads as `x['key']` is an error when missing.
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { when } from './state.ts';
import type { T3Mcp } from './t3/mcp.ts';
import { T3Error } from './t3/seams.ts';

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

/** `~` and `~/...` from the home folder, as T3's CLI expands a `--project` (`expandHomePath`). */
function _expand_home(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** The path with its links resolved, or as it is when that fails (the CLI's `realPath`). */
const _real = (p: string): Promise<string> => realpath(p).catch(() => p);

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

/** T3 Code through its local server's MCP tools. */
export class T3Server {
  readonly mcp: Pick<T3Mcp, 'call'>;
  readonly effort_option: EffortOption;
  /** Resolves a path's links, or gives it back as it is when that fails. Tests pass their own, so
   *  a recorded project folder isn't looked up on this machine's disk. */
  readonly real_path: (p: string) => Promise<string>;

  constructor(mcp: Pick<T3Mcp, 'call'>, effort_option: EffortOption, real_path: (p: string) => Promise<string> = _real) {
    this.mcp = mcp;
    this.effort_option = effort_option;
    this.real_path = real_path;
  }

  /** Every T3 project: each page of `t3_project_list`. */
  private async _projects(): Promise<Json[]> {
    const projects: Json[] = [];
    let cursor: Json = 0;
    while (cursor !== null && cursor !== undefined) {
      const page = obj(await this.mcp.call('t3_project_list', { cursor, limit: 100 }));
      projects.push(...list(page.projects));
      cursor = get(page, 'nextCursor');
    }
    return projects;
  }

  /** The id of the T3 project whose folder is `folder`. */
  private async _project(folder: string): Promise<string> {
    for (const p of await this._projects()) {
      if (get(p, 'workspaceRoot') && _same_folder(p.workspaceRoot, folder)) return p.id;
    }
    throw new T3Error(`No T3 Code project matches '${folder}'`);
  }

  /** The project `t3 thread list --project` names (`resolveProject` in T3's binCli): a project id,
   *  else the project whose folder holds the path, both with their links resolved, the deepest
   *  folder when they nest. A relative path is read from the working directory. */
  private async _project_holding(identifier: string): Promise<string> {
    const projects = await this._projects();
    const byId = projects.find((p) => get(p, 'id') === identifier);
    if (byId !== undefined) return byId.id;
    const target = await this.real_path(resolve(_expand_home(identifier)));
    let deepest: { id: string; root: string } | null = null;
    for (const p of projects) {
      const root = await this.real_path(need(p, 'workspaceRoot'));
      const rel = relative(root, target);
      const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
      if (inside && (deepest === null || root.length > deepest.root.length)) deepest = { id: p.id, root };
    }
    // T3's CLI's own words, which the run loop reads as the server up (`wait_for_t3`)
    if (deepest === null) {
      throw new T3Error(`No T3 Code project matches '${identifier}'. Pass a project id or a path inside a project.`);
    }
    return deepest.id;
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

  /** How many of `run_id`'s secret cards still wait on the user: its `secret_request` items on
   *  the activity view, `waiting` (the note, section 1: a secret card is a turn item, never a
   *  runtime request, so `pendingRequestCount` leaves it out). Another run's card isn't this
   *  run's question. */
  private async _cards_waiting(thread_id: string, run_id: string | null): Promise<number> {
    if (!run_id) return 0;
    return (await this._items(thread_id, 'activity')).filter((i) => get(i, 'runId') === run_id
      && get(i, 'type') === 'secret_request' && get(i, 'status') === 'waiting').length;
  }

  /** Waits for the run as `t3 thread start --wait --json` does (`waitForRun` and `finishRun` in
   *  T3's binCli): slices of `t3_thread_wait`; a pending request after a timed-out slice, or a
   *  secret card of this run, is a run waiting for an answer, unless one more short wait ends it. */
  private async _finish(thread_id: string, run_id: string): Promise<RunResult> {
    let waited: Json;
    for (;;) {
      waited = await this._wait(thread_id, run_id, WAIT_SLICE_MS);
      if (!waited.timedOut) break;
      const read = obj(await this.mcp.call('t3_thread_read', { threadId: thread_id, limit: 1, runLimit: 1 }));
      if (get(obj(get(read, 'thread')), 'pendingRequestCount') || await this._cards_waiting(thread_id, run_id)) {
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
   *  in full. Its pending requests add its live run's waiting secret cards (`activeRunId`), which
   *  the MCP read leaves out. */
  async show(thread_id: string, messages = 3): Promise<[Thread, Message[]]> {
    const read = obj(await this.mcp.call('t3_thread_read', { threadId: thread_id, limit: 1, runLimit: 1 }));
    const raw = need(read, 'thread');
    const cards = await this._cards_waiting(thread_id, get(raw, 'activeRunId'));
    const thread = _thread({ ...raw, pendingRequestCount: (get(raw, 'pendingRequestCount') || 0) + cards });
    const said = (await this._items(thread_id, 'messages')).filter((i) => Object.hasOwn(ROLES, get(i, 'type') ?? ''));
    const last = messages > 0 ? said.slice(-messages) : [];
    const out: Message[] = [];
    for (const m of last) out.push(new Message(ROLES[m.type]!, await this._full_text(thread_id, m), get(m, 'runId')));
    return [thread, out];
  }

  /** The threads of the project `project` names (`t3 thread list --project`: a project id or a
   *  path inside its folder), every page, as T3's CLI lists them: the active ones, newest first,
   *  without delegated threads (`includeSubagents: false`). */
  async list(project: string): Promise<Thread[]> {
    const projectId = await this._project_holding(project);
    const threads: Thread[] = [];
    let cursor: Json = 0;
    while (cursor !== null && cursor !== undefined) {
      const page = obj(await this.mcp.call('t3_thread_list', { projectId, includeSubagents: false, limit: 100, cursor }));
      threads.push(...list(page.threads).map(_thread));
      cursor = get(page, 'nextCursor');
    }
    return threads;
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
