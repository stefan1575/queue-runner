// T3's MCP endpoint (`/mcp`), called directly: one tool call per MCP session, closed after it,
// as today's runner calls it (queue_runner/t3_mcp.py). The address is re-read on every call;
// a token T3 refuses (401) is replaced once, and a token minted on another address is never sent.
import { T3Error, Unauthorized, type Address, type Cli, type Http } from './seams.ts';
import { signInMcp } from './sign-in.ts';

const PROTOCOL = '2025-06-18';

function rpcResult(text: string, contentType: string): any {
  if (contentType.includes('text/event-stream')) {
    const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    text = data.at(-1) ?? '';
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new T3Error(`T3 sent an unreadable MCP answer: ${text.slice(0, 200)}`);
  }
  if (msg.error) throw new T3Error(`T3's MCP endpoint refused the call: ${msg.error.message}`);
  return msg.result;
}

export class T3Mcp {
  private token: string | null = null;
  private tokenOrigin: string | null = null;
  private signingIn: Promise<string> | null = null;

  private address: Address;
  private cli: Cli;
  private http: Http;

  constructor(address: Address, cli: Cli, http: Http) {
    this.address = address;
    this.cli = cli;
    this.http = http;
  }

  /** One tool call; its structured result. A T3Error if T3 can't be reached, refuses it or the
   *  tool fails. */
  async call(tool: string, args: object): Promise<any> {
    const origin = await this.address();
    for (const attempt of [1, 2]) {
      const token = await this.signedIn(origin);
      try {
        return await this.tool(origin, token, tool, args);
      } catch (e) {
        if (!(e instanceof Unauthorized) || attempt === 2) throw e;
        if (this.token === token) this.token = null; // not already replaced by another call
      }
    }
  }

  private async signedIn(origin: string): Promise<string> {
    if (this.token !== null && this.tokenOrigin === origin) return this.token;
    // one sign-in at a time: calls that find no token wait for the same one
    this.signingIn ??= signInMcp(origin, this.cli, this.http).then(
      (t) => { this.token = t; this.tokenOrigin = origin; return t; },
    ).finally(() => { this.signingIn = null; });
    return this.signingIn;
  }

  private async send(url: string, method: string, headers: Record<string, string>, body?: string) {
    try {
      return await this.http(url, body === undefined ? { method, headers } : { method, headers, body });
    } catch (e) {
      throw new T3Error(`T3's server can't be reached at ${url}: ${(e as Error).message}`);
    }
  }

  private async rpc(origin: string, token: string, session: string | undefined, method: string,
                    params?: object, id?: number) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL,
    };
    if (session) headers['mcp-session-id'] = session;
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    if (id !== undefined) msg.id = id;
    const got = await this.send(`${origin}/mcp`, 'POST', headers, JSON.stringify(msg));
    if (got.status === 401 || got.status === 403) throw new Unauthorized(`T3 refused the app's MCP token (${got.status})`);
    if (got.status >= 400) throw new T3Error(`T3's MCP endpoint answered ${got.status} to ${method}: ${got.text.slice(0, 300)}`);
    return { headers: got.headers, result: id === undefined ? undefined : rpcResult(got.text, got.headers['content-type'] ?? '') };
  }

  private async tool(origin: string, token: string, tool: string, args: object) {
    const init = await this.rpc(origin, token, undefined, 'initialize', {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'queue-runner-app', version: '1' },
    }, 1);
    const session = init.headers['mcp-session-id'];
    let result;
    try {
      await this.rpc(origin, token, session, 'notifications/initialized');
      result = (await this.rpc(origin, token, session, 'tools/call', { name: tool, arguments: args }, 2)).result;
    } finally {
      if (session) {
        // ends the MCP session, as the spec has a client do; a refusal leaves it to expire
        await this.send(`${origin}/mcp`, 'DELETE', {
          authorization: `Bearer ${token}`, 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL,
        }).catch(() => undefined);
      }
    }
    if (!result || typeof result !== 'object') throw new T3Error(`T3 sent no result for ${tool}`);
    if (result.isError) {
      let text: string = (result.content ?? []).find((c: any) => c?.text)?.text ?? '';
      try {
        const failure = JSON.parse(text);
        text = `${failure.code}: ${failure.message}`;
      } catch { /* the text as it is */ }
      throw new T3Error(`${tool} failed: ${text.slice(0, 300)}`);
    }
    return result.structuredContent;
  }
}
