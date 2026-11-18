// A fake T3 behind the app's seams: its CLI (pairing codes, sessions), its HTTP server (OAuth,
// token exchange, /mcp) and its WebSocket. No network: requests are answered in memory, and one
// to any port but the server's is refused, as a moved server refuses.
import { createHash } from 'node:crypto';
import type { Cli, Connect, Http, HttpAnswer, Socket, SocketEvents } from '../src/t3/seams.ts';

type Session = {
  sessionId: string; subject: string; client: { label: string }; issuedAt: string;
  token: string; scopes: string[]; revoked: boolean;
};

export type FakeProject = { id: string; title: string; workspaceRoot: string; archivedAt?: string | null };

type ShellStream = { send(item: unknown): void; end(): void; ended: boolean };

/** A thread's state as `orchestration.subscribeThread` shows it: its runs, runtime requests (a
 *  question to the user is a pending one) and turn items (a failed run's error among them). */
export type FakeThread = { id: string; projectId: string; runs: any[]; runtimeRequests: any[]; turnItems: any[]; messages?: any[] };

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
  /** Every `t3_thread_launch` a client made: its arguments, as T3 got them. */
  launches: any[] = [];
  /** Each thread a client launched, by id. */
  threadState: Record<string, FakeThread> = {};
  /** The open `subscribeThread` streams, by thread. */
  private threadStreams = new Map<string, Set<{ send(item: unknown): void; end(): void }>>();
  /** Answers `t3_thread_launch` with this failure instead (T3 refusing it). */
  launchFailure: { code: string; message: string } | null = null;
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

  /** A project archived (`archived: true`) or brought back in T3. */
  archiveProject(id: string, archived: boolean) {
    const p = this.projects.find((x) => x.id === id)!;
    p.archivedAt = archived ? '2026-11-19T00:00:00.000Z' : null;
    this.tell({ kind: 'project.updated', sequence: ++this.n, project: { ...p, scripts: [] } });
  }

  /** T3 says every shell stream must start again from a snapshot. */
  requireSnapshot() {
    this.tell({ kind: 'snapshot-required' });
  }

  /** T3 ends every shell stream (a restart, say). */
  endShells() {
    for (const s of this.shells) s.end();
    this.shells = [];
  }

  /** A thread event, as T3 sends it on `subscribeThread`: the item (`run`, `runtime-request` or
   *  `turn-item`) replaces the one with its id in the thread's state, and every open stream on
   *  the thread is told. */
  threadEvent(threadId: string, type: 'run' | 'runtime-request' | 'turn-item', payload: any) {
    const t = this.threadState[threadId]!;
    const list = type === 'run' ? t.runs : type === 'runtime-request' ? t.runtimeRequests : t.turnItems;
    const at = list.findIndex((x) => x.id === payload.id);
    if (at >= 0) list[at] = payload; else list.push(payload);
    for (const s of this.threadStreams.get(threadId) ?? []) {
      s.send({ kind: 'event', sequence: ++this.n, event: { id: `event-${this.n}`, threadId, type: `${type}.updated`, payload } });
    }
  }

  private run(threadId: string) { return this.threadState[threadId]!.runs.at(-1); }

  /** How many characters of an item's text `t3_thread_read` gives at once. */
  textChunk = 1_000_000;

  /** The thread's run says something: an `assistant_message` item, as `t3_thread_read` lists it. */
  say(threadId: string, text: string) {
    const t = this.threadState[threadId]!;
    (t.messages ??= []).push({ itemId: `msg-${++this.n}`, type: 'assistant_message', runId: this.run(threadId).id, text });
  }

  /** The thread's run ends: `completed`, `failed`, `interrupted`, `cancelled`... */
  endRun(threadId: string, status: string) {
    this.threadEvent(threadId, 'run', { ...this.run(threadId), status, completedAt: '2026-11-19T12:00:00.000Z' });
  }

  /** The thread's run stops on a question to the user: a pending request, the run waiting. */
  askUser(threadId: string) {
    const run = this.run(threadId);
    this.threadEvent(threadId, 'runtime-request', { id: `request-${++this.n}`, nodeId: run.rootNodeId, kind: 'user_input', status: 'pending' });
    this.threadEvent(threadId, 'run', { ...run, status: 'waiting' });
  }

  /** The thread's run fails on the provider's usage limit, as T3 records it: a failed error item
   *  on the run's root node with the failure's class, then the run failed. */
  hitUsageLimit(threadId: string, resetAt: string | null) {
    const run = this.run(threadId);
    this.threadEvent(threadId, 'turn-item', {
      id: `item-${++this.n}`, type: 'error', status: 'failed', runId: run.id, nodeId: run.rootNodeId,
      failure: { class: 'usage_limit', message: "You've hit your limit", resetAt },
    });
    this.endRun(threadId, 'failed');
  }

  /** T3 ends every thread stream (a restart, say). */
  endThreadStreams() {
    for (const set of this.threadStreams.values()) for (const s of [...set]) s.end();
  }

  /** How many thread streams are open on a thread. */
  threadStreamCount(threadId: string) { return this.threadStreams.get(threadId)?.size ?? 0; }

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
    if (name === 't3_thread_launch') {
      if (this.launchFailure) return { failure: this.launchFailure };
      this.launches.push(args);
      const n = this.launches.length;
      this.threadState[`thread-${n}`] = {
        id: `thread-${n}`, projectId: args.projectId, runtimeRequests: [], turnItems: [], messages: [],
        runs: [{ id: `run-${n}`, threadId: `thread-${n}`, ordinal: 1, rootNodeId: `node-${n}`, status: 'running', completedAt: null }],
      };
      return { result: { threadId: `thread-${n}`, runId: `run-${n}`, link: `t3://thread/thread-${n}`, projectId: args.projectId, modelSelection: args.modelSelection, status: 'running' } };
    }
    if (name === 't3_thread_read') {
      // `view: messages` pages of `limit` items from `afterPosition`; `itemId` + `textOffset` reads
      // one item's text on, `textChunk` characters at a time (T3 truncates long text)
      const t = this.threadState[args.threadId];
      if (!t) return { failure: { code: 'not_found', message: 'The thread was not found.' } };
      const cut = (item: any, from: number) => {
        const text = String(item.text).slice(from, from + this.textChunk);
        const more = from + this.textChunk < String(item.text).length;
        return { ...item, text, textTruncated: more, nextTextOffset: more ? from + this.textChunk : null };
      };
      if (args.itemId) {
        const item = (t.messages ?? []).find((m) => m.itemId === args.itemId);
        return { result: { items: item ? [cut(item, args.textOffset ?? 0)] : [] } };
      }
      const from = args.afterPosition ?? 0;
      const page = (t.messages ?? []).slice(from, from + args.limit).map((m) => cut(m, 0));
      const more = from + args.limit < (t.messages ?? []).length;
      return { result: { items: page, hasMore: more, nextPosition: more ? from + args.limit : null } };
    }
    if (name === 't3_thread_organize') {
      if (!this.threadState[args.threadId]) return { failure: { code: 'not_found', message: 'The thread was not found.' } };
      return { result: { threadId: args.threadId, action: args.action } };
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
        if (msg.method !== 'tools/call') return json(200, { jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } });
        const done = this.tool(msg.params.name, msg.params.arguments);
        if (done.failure) return json(200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ text: JSON.stringify(done.failure) }] } });
        const data = `data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: done.result } })}\n\n`;
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, text: data };
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
    let threadStream: (() => void) | null = null;
    queueMicrotask(() => (refused ? on.closed(false, 'refused') : on.open()));
    const mine: ((v: any) => void)[] = [];
    const forget = () => { for (const m of mine) this.configStreams.delete(m); threadStream?.(); };
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
        } else if (msg._tag === 'Request' && msg.tag === 'orchestration.subscribeThread') {
          // T3's thread stream: a snapshot of the thread's projection, then each change
          const t = this.threadState[msg.payload?.threadId];
          if (!t) {
            const exit = { _tag: 'Failure', cause: { _tag: 'Fail', error: { message: `no thread ${msg.payload?.threadId}` } } };
            queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Exit', requestId: msg.id, exit })));
            return;
          }
          const set = this.threadStreams.get(t.id) ?? new Set();
          this.threadStreams.set(t.id, set);
          const stream = {
            send: (item: unknown) => queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Chunk', requestId: msg.id, values: [item] }))),
            end: () => {
              set.delete(stream);
              if (!open) return;
              open = false;
              queueMicrotask(() => on.closed(true, 'T3 stopped'));
            },
          };
          set.add(stream);
          threadStream = () => set.delete(stream);
          stream.send({ kind: 'snapshot', snapshotSequence: this.n, projection: structuredClone({ thread: { id: t.id, projectId: t.projectId }, runs: t.runs, runtimeRequests: t.runtimeRequests, turnItems: t.turnItems }) });
        } else if (msg._tag === 'Request' && msg.tag !== 'orchestration.subscribeShell') {
          const method = this.wsMethods[msg.tag];
          const exit = method ? { _tag: 'Success', value: method(msg.payload) } : { _tag: 'Failure', cause: { _tag: 'Die', defect: `no method ${msg.tag}` } };
          queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Exit', requestId: msg.id, exit })));
        }
        if (msg._tag === 'Request' && msg.tag === 'orchestration.subscribeShell') {
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
        forget();
        if (shell) this.shells = this.shells.filter((x) => x !== shell);
        queueMicrotask(() => on.closed(true, ''));
      },
    };
  };
}
