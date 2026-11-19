import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { T3Mcp, ToolFailed } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { NoAnswer, T3Error, Unauthorized } from '../src/t3/seams.ts';
import { LABEL } from '../src/t3/sign-in.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeT3 } from './fake-t3.ts';

let dir: string;
let runtime: string;
let t3: FakeT3;

const writeRuntime = () => writeFile(runtime, JSON.stringify({ version: 1, origin: t3.origin, port: t3.port }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'queue-runner-app-'));
  runtime = join(dir, 'server-runtime.json');
  t3 = new FakeT3();
  t3.projects = [{ id: 'p1', title: 'sandbox', workspaceRoot: 'C:/sandbox' }];
  await writeRuntime();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const mcp = () => new T3Mcp(runtimeAddress(runtime), t3.cli, t3.http);
const ws = () => new T3Ws(runtimeAddress(runtime), t3.cli, t3.http, t3.connect);
const list = { cursor: 0, limit: 100 };

describe('signing in to MCP', () => {
  it('signs in through the OAuth flow under the app\'s own label', async () => {
    const page = await mcp().call('t3_project_list', list);
    expect(page.projects.map((p: any) => p.id)).toEqual(['p1']);
    expect(t3.active(LABEL, 'mcp-client')).toHaveLength(1);
    expect(LABEL).not.toBe('Queue runner');
  });

  it('keeps the Python runner\'s session and revokes only the app\'s older ones', async () => {
    const runner = t3.addSession('mcp-client', 'Queue runner');
    await mcp().call('t3_project_list', list);
    await mcp().call('t3_project_list', list); // a second app start
    expect(runner.revoked).toBe(false);
    expect(t3.active(LABEL, 'mcp-client')).toHaveLength(1);
  });

  it('signs in once for many calls', async () => {
    const client = mcp();
    await Promise.all([client.call('t3_project_list', list), client.call('t3_project_list', list)]);
    await client.call('t3_project_list', list);
    expect(t3.signIns['mcp-client']).toBe(1);
  });

  it('replaces a refused (401) token once', async () => {
    const client = mcp();
    await client.call('t3_project_list', list);
    t3.revokeAll(LABEL);
    const page = await client.call('t3_project_list', list);
    expect(page.projects).toHaveLength(1);
    expect(t3.signIns['mcp-client']).toBe(2);
  });

  it('gives up when the new token is refused too', async () => {
    let refuse = false;
    const client = new T3Mcp(runtimeAddress(runtime), t3.cli, async (url, req) => (
      refuse && new URL(url).pathname === '/mcp' ? { status: 401, headers: {}, text: '' } : t3.http(url, req)));
    await client.call('t3_project_list', list);
    refuse = true; // the signed-in client's token, then the new one, are both refused
    await expect(client.call('t3_project_list', list)).rejects.toBeInstanceOf(Unauthorized);
    expect(t3.signIns['mcp-client']).toBe(2);
  });

  it('re-reads the address after T3 moves port, and signs in there', async () => {
    const client = mcp();
    await client.call('t3_project_list', list);
    t3.port = 4001;
    await writeRuntime();
    const page = await client.call('t3_project_list', list);
    expect(page.projects).toHaveLength(1);
    expect(t3.signIns['mcp-client']).toBe(2);
  });

  it('says T3 isn\'t running when server-runtime.json is gone', async () => {
    await rm(runtime);
    await expect(mcp().call('t3_project_list', list)).rejects.toThrow(/T3's server isn't running/);
  });

  it('says a failed tool\'s code and message', async () => {
    await expect(mcp().call('t3_nope', {})).rejects.toThrow('t3_nope failed: unknown: no such tool');
    // and keeps T3's code, so a caller can tell a refusal from an unclear outcome (#156 F9)
    const e = await mcp().call('t3_nope', {}).catch((x) => x);
    expect(e).toBeInstanceOf(ToolFailed);
    expect(e.code).toBe('unknown');
  });
});

describe('a tool call whose answer is lost (#154)', () => {
  /** A client whose HTTP answers the tool call itself with `answer`; every other request is T3's. */
  const client = (answer: () => Promise<{ status: number; headers: Record<string, string>; text: string }>) =>
    new T3Mcp(runtimeAddress(runtime), t3.cli, async (url, req) => (
      new URL(url).pathname === '/mcp' && JSON.parse(req.body ?? '{}').method === 'tools/call' ? answer() : t3.http(url, req)));

  it('is NoAnswer when it was sent and the connection dropped, or T3 answered 5xx, unreadably or with no result', async () => {
    const answers = [
      async () => { throw new Error('socket hang up'); },
      async () => ({ status: 502, headers: {}, text: 'bad gateway' }),
      async () => ({ status: 200, headers: { 'content-type': 'application/json' }, text: '{"jsonrpc":' }),
      async () => ({ status: 200, headers: { 'content-type': 'application/json' }, text: '{"jsonrpc":"2.0","id":2}' }),
    ];
    for (const answer of answers) {
      await expect(client(answer).call('t3_thread_launch', {})).rejects.toBeInstanceOf(NoAnswer);
    }
  });

  it('is a plain refusal, not NoAnswer, when T3 answered no: a 4xx, a JSON-RPC error, a failed tool', async () => {
    const answers = [
      async () => ({ status: 400, headers: {}, text: 'bad request' }),
      async () => ({ status: 200, headers: { 'content-type': 'application/json' }, text: '{"jsonrpc":"2.0","id":2,"error":{"message":"no"}}' }),
    ];
    for (const answer of answers) {
      const e = await client(answer).call('t3_thread_launch', {}).catch((x) => x);
      expect(e).toBeInstanceOf(T3Error);
      expect(e).not.toBeInstanceOf(NoAnswer);
    }
    const failed = await mcp().call('t3_nope', {}).catch((x) => x);
    expect(failed).not.toBeInstanceOf(NoAnswer);
  });

  it('is not NoAnswer when T3 was never reached: nothing was sent', async () => {
    await rm(runtime);
    const e = await mcp().call('t3_thread_launch', {}).catch((x) => x);
    expect(e).toBeInstanceOf(T3Error);
    expect(e).not.toBeInstanceOf(NoAnswer);
  });
});

describe('the WebSocket API', () => {
  it('subscribes to the server config with a client session, and acks the chunk', async () => {
    const config = await ws().first('subscribeServerConfig', {});
    expect(config.type).toBe('snapshot');
    expect(t3.frames[0]).toEqual({ _tag: 'Request', id: '1', tag: 'subscribeServerConfig', payload: {}, headers: [] });
    expect(t3.active(LABEL, 'one-time-token')).toHaveLength(1);
    expect(t3.active(LABEL, 'one-time-token')[0]!.scopes).toEqual(['orchestration:read']);
  });

  it('replaces a refused token once', async () => {
    const client = ws();
    await client.first('subscribeServerConfig');
    t3.revokeAll(LABEL);
    await client.first('subscribeServerConfig');
    expect(t3.signIns['one-time-token']).toBe(2);
  });

  it('re-reads the address after T3 moves port', async () => {
    const client = ws();
    await client.first('subscribeServerConfig');
    t3.port = 4002;
    await writeRuntime();
    expect((await client.first('subscribeServerConfig')).type).toBe('snapshot');
  });

  it("answers a method that isn't a stream with the value of T3's Exit", async () => {
    t3.wsMethods['orchestration.getThreadProjection'] = (p) => ({ thread: { id: p.threadId } });
    expect(await ws().request('orchestration.getThreadProjection', { threadId: 't1' })).toEqual({ thread: { id: 't1' } });
    expect(t3.frames.at(-1)).toEqual({ _tag: 'Request', id: '1', tag: 'orchestration.getThreadProjection', payload: { threadId: 't1' }, headers: [] });
  });

  it("fails a method T3 ends with a Failure", async () => {
    await expect(ws().request('orchestration.noSuchMethod')).rejects.toThrow(/T3 ended orchestration.noSuchMethod/);
  });

  it('fails when T3 keeps refusing the socket', async () => {
    t3.connect = (_url, _h, on) => {
      queueMicrotask(() => on.closed(false, 'refused'));
      return { send() {}, close() {} };
    };
    await expect(ws().first('subscribeServerConfig')).rejects.toBeInstanceOf(T3Error);
    expect(t3.signIns['one-time-token']).toBe(2);
  });
});
