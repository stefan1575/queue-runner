// Signing in to T3 (docs/app.md, Signing in). Two sessions, both made from a one-time pairing
// code that `t3 auth pairing create` mints, both under the app's own label:
//
// - MCP: T3's OAuth flow for an outside MCP client (register, decision, token with PKCE), a
//   full-access `mcp-client` session, as today's runner signs in (queue_runner/t3_mcp.py).
// - WebSocket: T3 refuses `mcp-client` sessions anywhere but /mcp, so the API gets a client
//   session from the pairing code's token exchange (`POST /oauth/token`), as T3's own clients pair.
//
// Tokens stay in memory only. After minting, the app revokes its own older sessions of that kind
// (its label, never "Queue runner": that is the Python runner's, which revokes by it).
import { createHash, randomBytes } from 'node:crypto';
import { T3Error, type Cli, type Http } from './seams.ts';

export const LABEL = 'Queue runner app';
const REDIRECT = 'http://127.0.0.1/queue-runner-app/callback'; // never opened: the code is read from it
// mcpClientScopes('full-access') in T3: what a pairing code must grant for a full-access sign-in
export const MCP_SCOPES = ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write'];
// subscribeServerConfig needs orchestration:read; later tickets add what their methods need
export const WS_SCOPES = ['orchestration:read'];
export const MCP_SUBJECT = 'mcp-client';
export const WS_SUBJECT = 'one-time-token'; // a pairing code's exchanged session keeps its subject

async function cliJson(cli: Cli, args: string[]): Promise<any> {
  const { code, stdout, stderr } = await cli(args);
  const what = `t3 ${args.slice(0, 3).join(' ')}`;
  if (code !== 0) throw new T3Error(`${what} failed (${code}): ${stderr.trim().slice(0, 300)}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new T3Error(`${what} printed no JSON`);
  }
}

async function pairingCode(cli: Cli, scopes: string[]): Promise<string> {
  const args = ['auth', 'pairing', 'create'];
  for (const s of scopes) args.push('--scope', s);
  const pairing = await cliJson(cli, [...args, '--ttl', '5m', '--label', LABEL, '--json']);
  if (typeof pairing?.credential !== 'string') throw new T3Error('t3 auth pairing create gave no code');
  return pairing.credential;
}

async function postJson(http: Http, url: string, payload: object, form = false): Promise<any> {
  const body = form
    ? new URLSearchParams(payload as Record<string, string>).toString()
    : JSON.stringify(payload);
  const contentType = form ? 'application/x-www-form-urlencoded' : 'application/json';
  const path = new URL(url).pathname;
  let answer;
  try {
    answer = await http(url, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body });
  } catch (e) {
    throw new T3Error(`T3's server can't be reached at ${url}: ${(e as Error).message}`);
  }
  if (answer.status >= 400) throw new T3Error(`T3 refused ${path} (${answer.status}): ${answer.text.slice(0, 300)}`);
  try {
    return JSON.parse(answer.text);
  } catch {
    throw new T3Error(`T3 sent an unreadable answer to ${path}`);
  }
}

const base64url = (b: Buffer) => b.toString('base64url');

/** A full-access MCP client session through T3's OAuth flow: its bearer token. */
export async function signInMcp(origin: string, cli: Cli, http: Http): Promise<string> {
  const code = await pairingCode(cli, MCP_SCOPES);
  const client = (await postJson(http, `${origin}/oauth/mcp/register`, {
    client_name: LABEL, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
  })).client_id;
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const resource = `${origin}/mcp`;
  const state = base64url(randomBytes(12));
  const went = await postJson(http, `${origin}/oauth/mcp/decision`, {
    authorization: {
      response_type: 'code', client_id: client, redirect_uri: REDIRECT, code_challenge: challenge,
      code_challenge_method: 'S256', state, resource,
    },
    decision: { _tag: 'pairing-code', access: 'full-access', code },
  });
  const query = new URL(went?.redirectTo ?? '', REDIRECT).searchParams;
  if (!query.get('code')) {
    throw new T3Error(`T3 approved no sign-in: ${query.get('error_description') ?? query.get('error') ?? '?'}`);
  }
  if (query.get('state') !== state) throw new T3Error("T3's sign-in answered another request (its state differs)");
  const token = await postJson(http, `${origin}/oauth/mcp/token`, {
    grant_type: 'authorization_code', code: query.get('code')!, redirect_uri: REDIRECT,
    client_id: client, code_verifier: verifier, resource,
  }, true);
  if (!token?.access_token) throw new T3Error('T3 issued no MCP token');
  await revokeOlder(cli, MCP_SUBJECT);
  return token.access_token;
}

/** A client session for T3's WebSocket API, from a pairing code's token exchange: its token. */
export async function signInWebSocket(origin: string, cli: Cli, http: Http): Promise<string> {
  const code = await pairingCode(cli, WS_SCOPES);
  const token = await postJson(http, `${origin}/oauth/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: code,
    subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    client_label: LABEL,
    client_device_type: 'bot',
  }, true);
  if (!token?.access_token) throw new T3Error('T3 issued no WebSocket token');
  await revokeOlder(cli, WS_SUBJECT);
  return token.access_token;
}

/** Revokes the app's earlier sessions of this subject, keeping the newest (the one just made).
 *  Only the app's own label: the Python runner's sessions are never touched. A failure leaves
 *  them to expire. */
export async function revokeOlder(cli: Cli, subject: string): Promise<void> {
  try {
    const sessions: any[] = await cliJson(cli, ['auth', 'session', 'list', '--json']);
    const mine = sessions
      .filter((s) => s?.subject === subject && s?.client?.label === LABEL)
      .sort((a, b) => String(a.issuedAt ?? '').localeCompare(String(b.issuedAt ?? '')));
    for (const s of mine.slice(0, -1)) await cli(['auth', 'session', 'revoke', s.sessionId]);
  } catch {
    // tidying only
  }
}
