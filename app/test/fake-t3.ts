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

type ShellStream = { send(item: unknown): void; end(): void; ended: boolean };

export class FakeT3 {
  port = 3773;
  sessions: Session[] = [];
  projects: FakeProject[] = [];
  serverConfig: any = { version: 1, type: 'snapshot', config: { environment: { label: 'Fake', serverVersion: '0.1.9' } } };
  /** How many threads each project has: T3 won't delete a project with threads unless forced. */
  threads: Record<string, number> = {};
  /** Every MCP tool call, with its arguments. */
  toolCalls: { tool: string; args: any }[] = [];
  /** The open `subscribeShell` streams. */
  private shells: ShellStream[] = [];
  /** Every frame a client sent on a WebSocket. */
  frames: any[] = [];
  /** How many sign-ins finished, per subject. */
  signIns: Record<string, number> = {};
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

  /** A project added in T3 itself (its own Add project): told to every shell stream. */
  addProject(p: FakeProject) {
    this.projects.push(p);
    this.tell({ kind: 'project.updated', sequence: ++this.n, project: { ...p, scripts: [] } });
  }

  /** A project removed in T3 itself. */
  removeProject(id: string) {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.tell({ kind: 'project.removed', sequence: ++this.n, projectId: id });
  }

  /** T3 ends every shell stream (a restart, say). */
  endShells() {
    for (const s of this.shells) s.end();
    this.shells = [];
  }

  /** How many shell streams are open. */
  get shellCount() { return this.shells.length; }

  private tell(item: unknown) {
    for (const s of this.shells) s.send(item);
  }

  private tool(name: string, args: any): { result?: unknown; failure?: { code: string; message: string } } {
    this.toolCalls.push({ tool: name, args });
    if (name === 't3_project_list') {
      const { cursor, limit } = args;
      const next = cursor + limit < this.projects.length ? cursor + limit : null;
      return { result: { projects: this.projects.slice(cursor, cursor + limit), nextCursor: next } };
    }
    if (name === 't3_project_create') {
      if (this.projects.some((p) => p.workspaceRoot === args.workspaceRoot)) {
        return { failure: { code: 'invalid_request', message: 'The workspace is already registered to a project.' } };
      }
      const p = { id: `project-${++this.n}`, title: args.title, workspaceRoot: args.workspaceRoot };
      this.addProject(p);
      return { result: { project: p } };
    }
    if (name === 't3_project_delete') {
      if (!this.projects.some((p) => p.id === args.projectId)) return { failure: { code: 'invalid_request', message: 'The project was not found.' } };
      if ((this.threads[args.projectId] ?? 0) > 0 && args.force !== true) {
        return { failure: { code: 'invalid_request', message: 'The project is not empty; force=true is required to delete it.' } };
      }
      delete this.threads[args.projectId];
      this.removeProject(args.projectId);
      return { result: { projectId: args.projectId } };
    }
    return { failure: { code: 'unknown', message: 'no such tool' } };
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
    let shell: ShellStream | null = null;
    queueMicrotask(() => (refused ? on.closed(false, 'refused') : on.open()));
    return {
      send: (text) => {
        const msg = JSON.parse(text);
        this.frames.push(msg);
        if (msg._tag === 'Request' && msg.tag === 'subscribeServerConfig') {
          queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Chunk', requestId: msg.id, values: [this.serverConfig] })));
        }
        if (msg._tag === 'Request' && msg.tag === 'subscribeShell') {
          // T3's shell stream: a snapshot of every project (and threads, which the app ignores),
          // then each change as it happens (docs/app.md, The WebSocket API).
          const stream: ShellStream = {
            ended: false,
            end: () => {
              stream.ended = true;
              if (!open) return;
              open = false;
              queueMicrotask(() => on.closed(true, 'T3 stopped'));
            },
            send: (item) => queueMicrotask(() => open && !stream.ended && on.message(JSON.stringify({ _tag: 'Chunk', requestId: msg.id, values: [item] }))),
          };
          shell = stream;
          this.shells.push(stream);
          stream.send({ kind: 'snapshot', snapshot: { schemaVersion: 2, snapshotSequence: this.n, projects: this.projects.map((p) => ({ ...p, scripts: [] })), threads: [{ id: 't1' }], archivedThreads: [] } });
          stream.send({ kind: 'synchronized' });
          stream.send({ kind: 'thread.updated', sequence: this.n, location: 'active', thread: { id: 't1' } });
        }
      },
      close: () => {
        if (!open) return;
        open = false;
        if (shell) this.shells = this.shells.filter((x) => x !== shell);
        queueMicrotask(() => on.closed(true, ''));
      },
    };
  };
}
