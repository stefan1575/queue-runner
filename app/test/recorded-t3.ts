// T3's server answering from responses recorded off the running T3 (`test/fixtures/t3/`, from
// `.scratch/queue-runner/research/t3-fixtures/`, the note `t3-api-facts.md`): the stand-in for
// `tests/test_t3.py`'s `FakeMcp` and `Recorder` (#217). The app's real MCP client (`src/t3/mcp.ts`)
// talks to it, so each answer is read as T3's own would be; the sign-ins go to `fake-t3.ts`, which
// plays T3's OAuth and CLI. A WebSocket recording is only read (`value`): the catalog's config.
//
// A recording is the file as T3 sent it. A test may point it at another thread (`about`), so the
// recordings of one story share the thread's ids, or change what its tool answered (`withContent`),
// keeping the shape T3 gave.
import { readFileSync } from 'node:fs';
import { T3Mcp } from '../src/t3/mcp.ts';
import type { Http, HttpAnswer } from '../src/t3/seams.ts';
import { FakeT3 } from './fake-t3.ts';

const DIR = new URL('./fixtures/t3/', import.meta.url);

/** A recorded response, as the file holds it: an MCP call's `{init, call: {status, contentType,
 *  body}, request}` or a WebSocket method's `{why, frames: [{t, raw}], request}`. */
export function recording(name: string): any {
  return JSON.parse(readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
}

/** What a recorded MCP call answered (`structuredContent`). */
export const content = (rec: any): any => rec.call.body.result.structuredContent;

/** The value a recorded WebSocket call's first frame carries: a one-shot method's Exit value, or
 *  a stream's first Chunk value. */
export function value(rec: any): any {
  const raw = rec.frames[0].raw;
  return raw._tag === 'Chunk' ? raw.values[0] : raw.exit.value;
}

/** The thread a recording was made on: its request's `threadId`. */
export function recordedThread(rec: any): string {
  const id = rec.request?.arguments?.threadId ?? rec.request?.payload?.threadId;
  if (typeof id !== 'string') throw new Error('this recording names no thread');
  return id;
}

/** `id`, then URL-encoded once, twice and three times: T3 nests a thread's id in its run, node
 *  and turn ids that way. */
const forms = (id: string) => {
  const out = [id];
  for (let i = 0; i < 3; i++) out.push(encodeURIComponent(out.at(-1)!));
  return out;
};

/** The recording as if it were made on thread `threadId`: every form of the recorded thread's id
 *  in it replaced by the same form of `threadId`. */
export function about(rec: any, threadId: string): any {
  const from = forms(recordedThread(rec));
  const to = forms(threadId);
  let text = JSON.stringify(rec);
  for (let i = from.length - 1; i >= 0; i--) text = text.split(from[i]!).join(to[i]!);
  return JSON.parse(text);
}

/** A recorded MCP call with what its tool answered changed by `edit`: `structuredContent` and the
 *  text copy of it T3 sends beside it. */
export function withContent(rec: any, edit: (content: any) => any): any {
  const out = structuredClone(rec);
  const result = out.call.body.result;
  result.structuredContent = edit(result.structuredContent);
  result.content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
  return out;
}

/** An answer: a recording, or one picked from the call's arguments. */
type Answer = any | ((args: any) => any);

export class RecordedT3 {
  /** Plays T3's OAuth and CLI, so the clients sign in as they do against T3. */
  private signIn = new FakeT3();
  /** Every MCP tool call, with its arguments. */
  calls: { tool: string; args: any }[] = [];
  private tools = new Map<string, Answer[]>();

  /** `tool`'s answers, in order; the last answers every call after it. */
  answer(tool: string, ...answers: Answer[]): this {
    this.tools.set(tool, answers);
    return this;
  }

  /** The arguments of each call to `tool`, in order. */
  argsOf(tool: string): any[] {
    return this.calls.filter((c) => c.tool === tool).map((c) => c.args);
  }

  /** More calls than any test makes: a seam that loops on a repeated answer fails, not hangs. */
  static readonly MOST_CALLS = 100;

  private static next(from: Map<string, Answer[]>, key: string, args: any, made: number): any {
    if (made > RecordedT3.MOST_CALLS) throw new Error(`more than ${RecordedT3.MOST_CALLS} calls: the seam is looping`);
    const answers = from.get(key);
    if (!answers?.length) throw new Error(`no recorded answer for ${key}`);
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return typeof a === 'function' ? a(args) : a;
  }

  /** T3's server: `/mcp` answered from the recordings, the sign-in's endpoints by `fake-t3.ts`. */
  http: Http = async (url, request) => {
    if (new URL(url).pathname !== '/mcp') return this.signIn.http(url, request);
    if (request.method === 'DELETE') return { status: 200, headers: {}, text: '' };
    const msg = JSON.parse(request.body ?? '{}');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpAnswer =>
      ({ status, headers: { 'content-type': 'application/json', ...headers }, text: JSON.stringify(body) });
    if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 'recorded' });
    if (msg.id === undefined) return { status: 202, headers: {}, text: '' };
    const { name, arguments: args } = msg.params;
    this.calls.push({ tool: name, args });
    const rec = RecordedT3.next(this.tools, name, args, this.calls.length);
    return {
      status: rec.call.status, headers: { 'content-type': rec.call.contentType },
      text: JSON.stringify({ ...rec.call.body, id: msg.id }),
    };
  };

  readonly mcp = new T3Mcp(this.signIn.address, this.signIn.cli, this.http);
}
