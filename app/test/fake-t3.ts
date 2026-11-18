// A fake T3 behind the app's seams: its CLI (pairing codes, sessions), its HTTP server (OAuth,
// token exchange, /mcp) and its WebSocket. No network: requests are answered in memory, and one
// to any port but the server's is refused, as a moved server refuses.
import { createHash } from 'node:crypto';
import type { Cli, Connect, Http, HttpAnswer, Socket, SocketEvents } from '../src/t3/seams.ts';

type Session = {
  sessionId: string; subject: string; client: { label: string }; issuedAt: string;
  token: string; scopes: string[]; revoked: boolean;
};

export type FakeProject = { id: string; title: string; workspaceRoot: string };

export class FakeT3 {
  port = 3773;
  sessions: Session[] = [];
  projects: FakeProject[] = [];
  serverConfig: any = { version: 1, type: 'snapshot', config: { environment: { label: 'Fake', serverVersion: '0.1.9' } } };
  /** Every `t3_thread_launch` a client made: its arguments, as T3 got them. */
  launches: any[] = [];
  /** WebSocket methods that answer once, by tag: the value T3's Exit carries. Any other
   *  method but subscribeServerConfig ends in a Failure. */
  wsMethods: Record<string, (payload: any) => unknown> = {};
  /** Every frame a client sent on a WebSocket. */
  frames: any[] = [];
  /** How many sign-ins finished, per subject. */
  signIns: Record<string, number> = {};
  private configStreams = new Set<(v: any) => void>();
  private closers = new Set<() => void>();
  private pairings = new Map<string, string[]>();
  private clients = new Map<string, string>(); // client id -> its name
  private codes = new Map<string, { challenge: string; label: string }>();
  private n = 0;

  get origin() { return `http://127.0.0.1:${this.port}`; }

  /** A session someone else holds (today's runner's, say). */
  addSession(subject: string, label: string): Session {
    const s = this.newSession(subject, label, []);
    return s;
  }

  /** A later `subscribeServerConfig` event (`{version: 1, type, payload}`), sent to every open stream. */
  pushConfig(type: string, payload: unknown) {
    for (const s of this.configStreams) s({ version: 1, type, payload });
  }

  /** T3 stops: every open WebSocket closes. */
  dropSockets() {
    for (const c of this.closers) c();
    this.closers.clear();
  }

  /** T3 forgets every token it gave the app (a restart, say): the next use is refused. */
  revokeAll(label: string) {
    for (const s of this.sessions) if (s.client.label === label) s.revoked = true;
  }

  active(label: string, subject: string) {
    return this.sessions.filter((s) => !s.revoked && s.client.label === label && s.subject === subject);
  }

  private newSession(subject: string, label: string, scopes: string[]): Session {
    const i = ++this.n;
    const s = {
      sessionId: `session-${i}`, subject, client: { label }, scopes, revoked: false,
      issuedAt: new Date(Date.UTC(2026, 10, 18, 0, 0, i)).toISOString(), token: `token-${i}`,
    };
    this.sessions.push(s);
    return s;
  }

  private session(token: string | undefined) {
    return this.sessions.find((s) => !s.revoked && `Bearer ${s.token}` === token);
  }

  cli: Cli = async (args) => {
    const cmd = args.slice(0, 3).join(' ');
    if (cmd === 'auth pairing create') {
      const scopes = args.flatMap((a, i) => (args[i - 1] === '--scope' ? [a] : []));
      const code = `pair-${++this.n}`;
      this.pairings.set(code, scopes);
      return { code: 0, stdout: JSON.stringify({ id: code, credential: code, scopes }), stderr: '' };
    }
    if (cmd === 'auth session list') {
      const list = this.sessions.filter((s) => !s.revoked).map(({ token, revoked, ...s }) => s);
      return { code: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (cmd.startsWith('auth session revoke')) {
      const s = this.sessions.find((x) => x.sessionId === args[3]);
      if (s) s.revoked = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unknown command ${cmd}` };
  };

  http: Http = async (url, request) => {
    const u = new URL(url);
    if (Number(u.port) !== this.port) throw new Error(`connect ECONNREFUSED ${u.host}`);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpAnswer =>
      ({ status, headers: { 'content-type': 'application/json', ...headers }, text: JSON.stringify(body) });
    const form = () => Object.fromEntries(new URLSearchParams(request.body ?? ''));
    switch (u.pathname) {
      case '/oauth/mcp/register': {
        const body = JSON.parse(request.body ?? '{}');
        const id = `client-${++this.n}`;
        this.clients.set(id, body.client_name);
        return json(201, { client_id: id });
      }
      case '/oauth/mcp/decision': {
        const { authorization: a, decision: d } = JSON.parse(request.body ?? '{}');
        if (!this.pairings.delete(d.code) || d.access !== 'full-access') return json(400, { error: 'invalid_grant' });
        const code = `auth-${++this.n}`;
        this.codes.set(code, { challenge: a.code_challenge, label: this.clients.get(a.client_id)! });
        return json(200, { redirectTo: `${a.redirect_uri}?code=${code}&state=${a.state}` });
      }
      case '/oauth/mcp/token': {
        const f = form();
        const grant = this.codes.get(f.code!);
        const challenge = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
        if (!grant || grant.challenge !== challenge) return json(400, { error: 'invalid_grant' });
        this.codes.delete(f.code!);
        const s = this.newSession('mcp-client', grant.label, []);
        this.signIns['mcp-client'] = (this.signIns['mcp-client'] ?? 0) + 1;
        return json(200, { access_token: s.token, token_type: 'Bearer' });
      }
      case '/oauth/token': {
        const f = form();
        const scopes = this.pairings.get(f.subject_token!);
        if (!scopes || !this.pairings.delete(f.subject_token!)) return json(401, { error: 'invalid_credential' });
        const s = this.newSession('one-time-token', f.client_label!, scopes);
        this.signIns['one-time-token'] = (this.signIns['one-time-token'] ?? 0) + 1;
        return json(200, { access_token: s.token, token_type: 'Bearer', scope: scopes.join(' ') });
      }
      case '/mcp': {
        const s = this.session(request.headers.authorization);
        if (!s || s.subject !== 'mcp-client') return json(401, { error: 'invalid_token' });
        if (request.method === 'DELETE') return { status: 200, headers: {}, text: '' };
        const msg = JSON.parse(request.body ?? '{}');
        if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: {} }, { 'mcp-session-id': 'mcp-1' });
        if (msg.id === undefined) return { status: 202, headers: {}, text: '' };
        if (msg.method === 'tools/call' && msg.params.name === 't3_project_list') {
          const { cursor, limit } = msg.params.arguments;
          const projects = this.projects.slice(cursor, cursor + limit);
          const next = cursor + limit < this.projects.length ? cursor + limit : null;
          const data = `data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { projects, nextCursor: next } } })}\n\n`;
          return { status: 200, headers: { 'content-type': 'text/event-stream' }, text: data };
        }
        if (msg.method === 'tools/call' && msg.params.name === 't3_thread_launch') {
          const args = msg.params.arguments;
          this.launches.push(args);
          const n = this.launches.length;
          const result = { threadId: `thread-${n}`, runId: `run-${n}`, link: `t3://thread/thread-${n}`, projectId: args.projectId, modelSelection: args.modelSelection, status: 'running' };
          return json(200, { jsonrpc: '2.0', id: msg.id, result: { structuredContent: result } });
        }
        return json(200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ text: '{"code":"unknown","message":"no such tool"}' }] } });
      }
    }
    return json(404, { error: 'not found' });
  };

  /** T3's /ws: refuses another port, a missing protocol, an unknown token and any mcp-client
   *  session (T3: "MCP client sessions are only accepted by the MCP endpoint"). */
  connect: Connect = (url, headers, on: SocketEvents): Socket => {
    const u = new URL(url);
    const s = this.session(headers.authorization);
    const refused = Number(u.port) !== this.port || u.pathname !== '/ws'
      || u.searchParams.get('orchestrationProtocol') !== '2' || !s || s.subject === 'mcp-client';
    let open = !refused;
    queueMicrotask(() => (refused ? on.closed(false, 'refused') : on.open()));
    const mine: ((v: any) => void)[] = [];
    const forget = () => { for (const m of mine) this.configStreams.delete(m); };
    const drop = () => { if (open) { open = false; forget(); on.closed(true, 'T3 stopped'); } };
    if (!refused) this.closers.add(drop);
    return {
      send: (text) => {
        const msg = JSON.parse(text);
        this.frames.push(msg);
        if (msg._tag === 'Request' && msg.tag === 'subscribeServerConfig') {
          const sub = (v: any) => { if (open) on.message(JSON.stringify({ _tag: 'Chunk', requestId: msg.id, values: [v] })); };
          this.configStreams.add(sub);
          mine.push(sub);
          queueMicrotask(() => sub(this.serverConfig));
        } else if (msg._tag === 'Request') {
          const method = this.wsMethods[msg.tag];
          const exit = method ? { _tag: 'Success', value: method(msg.payload) } : { _tag: 'Failure', cause: { _tag: 'Die', defect: `no method ${msg.tag}` } };
          queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Exit', requestId: msg.id, exit })));
        }
      },
      close: () => {
        if (!open) return;
        open = false;
        forget();
        queueMicrotask(() => on.closed(true, ''));
      },
    };
  };
}
