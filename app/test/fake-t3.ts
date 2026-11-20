// A fake T3 behind the app's seams: its CLI (pairing codes, sessions), its HTTP server (OAuth,
// token exchange, /mcp) and its WebSocket. No network: requests are answered in memory, and one
// to any port but the server's is refused, as a moved server refuses.
import { createHash } from 'node:crypto';
import { T3Error, type Address, type Cli, type Connect, type Http, type HttpAnswer, type Socket, type SocketEvents } from '../src/t3/seams.ts';

type Session = {
  sessionId: string; subject: string; client: { label: string }; issuedAt: string;
  token: string; scopes: string[]; revoked: boolean;
};

export type FakeProject = { id: string; title: string; workspaceRoot: string; archivedAt?: string | null };

type ShellStream = { send(item: unknown): void; end(): void; ended: boolean };

/** A thread's state, modelled on T3 0.1.9 (the map of how T3's threads behave, PR #211's fix
 *  round 4: T3's own server code and live reads). Its projection is built from it
 *  (`projectionOf`):
 *  - `runs`: `{id, threadId, ordinal, rootNodeId, status, queueHeld, queuePosition, requestedAt,
 *    startedAt, completedAt, createdBy}`. A run's `id` keeps the number it was made with, while
 *    its `ordinal` is renumbered when a queued run starts after a newer one ran;
 *  - `nodes`: a question's child node (`kind: user_input_request`, `parentNodeId` the run's root);
 *  - `runtimeRequests`: questions and approvals, `{id, nodeId, kind, status, responseCapability,
 *    createdAt}`, with no `runId`;
 *  - `turnItems`: the run's items, cards among them (`secret_request`, `link_request`), and a
 *    failed run's `error` item;
 *  - `userMessages`: the projection's `messages` (`{id, role, createdBy, updatedAt}`);
 *  - `messages`: `t3_thread_read`'s items (MCP), as before;
 *  - `archivedAt`, `deletedAt`: an archive, and a soft delete (the thread stays readable).
 *  A test may build one with only some of these: the rest default. */
export type FakeThread = {
  id: string; projectId: string; runs: any[]; runtimeRequests: any[]; turnItems: any[]; nodes?: any[];
  userMessages?: any[]; messages?: any[]; title?: string; branch?: string | null;
  archivedAt?: string | null; deletedAt?: string | null;
};

/** The run statuses T3 counts as live (`isActivityRunForShell`): a secret card waits only while its
 *  run is one of these. */
const LIVE = new Set(['preparing', 'starting', 'running', 'waiting']);
/** How many turn-item rows `getThreadProjection` keeps (`THREAD_HISTORY_SNAPSHOT_ROW_LIMIT`). */
export const WINDOW_ROWS = 77;

/** The failure T3 0.1.9 ends a read of a thread it never had with (seen live): its typed code
 *  is the nested `cause.cause.name`. */
export const threadNotFound = (threadId: string, tag = 'OrchestrationV2GetThreadProjectionError') => ({
  _tag: 'Failure',
  cause: [{
    _tag: 'Fail',
    error: {
      _tag: tag, threadId, message: `Failed to load orchestration V2 thread ${threadId}`,
      cause: { name: 'OrchestratorProjectionError', message: 'projection failed', cause: { name: 'ProjectionStoreThreadNotFoundError', message: `thread ${threadId} not found` } },
    },
  }],
});

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
  /** How many `t3_thread_read` calls fail (T3 busy a moment), then how many more answer with no
   *  items (an empty page, as T3 gives one now and then), before reads answer as they should. */
  readFailures = 0;
  emptyReads = 0;
  /** How many reads of an item's text from an offset (a continuation) answer with no items. */
  emptyContinuations = 0;
  /** Answers `t3_thread_launch` with this failure instead (T3 refusing it). */
  launchFailure: { code: string; message: string } | null = null;
  /** `t3_thread_launch` runs, then its answer is lost (the connection drops before it arrives). */
  launchAnswerLost = false;
  /** `t3_thread_launch` runs, and its answer leaves the thread id out. */
  launchOmitsThreadId = false;
  /** `t3_thread_launch` runs, and its answer has no `structuredContent` at all. */
  launchOmitsContent = false;
  /** Every `t3_thread_send`, its arguments as T3 got them. */
  sends: any[] = [];
  /** Answers `t3_thread_send` with this failure instead (a thread that can't take another turn). */
  sendFailure: { code: string; message: string } | null = null;
  /** `t3_thread_send` runs, then its answer is lost. */
  sendAnswerLost = false;
  /** `t3_thread_send` answers without the new run's id. */
  sendOmitsRunId = false;
  /** With `sendFailure`: T3 takes the send (its new run starts), then answers with the failure,
   *  as when it can't read the run back (`orchestration_error`). */
  sendTaken = false;
  /** Runs as a send arrives, before T3 looks at it (a thread deleted meanwhile, say). */
  beforeSend: () => void = () => {};
  /** `orchestration.subscribeShell` fails at once, its snapshot (projects, the thread list) never
   *  sent. */
  shellDown = false;
  /** How many reads of a thread's projection the fake answered: `getThreadProjection`, and each
   *  `subscribeThread` snapshot. */
  projectionReads = 0;
  /** How many `subscribeThread` requests fail at once with `readFailure` (T3 failing the read). */
  failReads = 0;
  /** The same, counting only requests made while a stream on the thread is open: a read that
   *  fails while the stream it was started from stays up. */
  failReadsBeside = 0;
  readFailure: unknown = { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'OrchestrationV2SubscribeThreadError', message: 'the thread could not be read', cause: { name: 'SqlError', message: 'database is locked' } } }] };
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

  /** Whether T3's server is up, for `address`: off, it answers as a missing runtime file does. */
  running = true;
  /** Where T3's server is, answered in memory rather than read from a runtime file, so a test
   *  that waits for T3's events waits on nothing but this fake (#202 F2). */
  address: Address = async () => {
    if (!this.running) throw new T3Error("T3's server isn't running (the fake T3 is stopped)");
    return this.origin;
  };

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

  /** The fake's clock for T3's timestamps: each call a second later, so `completedAt` orders runs
   *  as they ended. */
  private clock = 0;
  at() { return new Date(Date.UTC(2026, 10, 19, 12, 0, ++this.clock)).toISOString(); }

  /** A thread's lists, each made if a test left it out. */
  private t(threadId: string): FakeThread {
    const t = this.threadState[threadId]!;
    t.nodes ??= [];
    t.userMessages ??= [];
    return t;
  }

  /** Sends a thread event to every open stream on the thread, as T3 does:
   *  `{kind: "event", sequence, event: {id, type, threadId, runId?, occurredAt, payload}}`. */
  private emit(threadId: string, type: string, payload: any) {
    for (const s of this.threadStreams.get(threadId) ?? []) {
      s.send({ kind: 'event', sequence: ++this.n, event: { id: `event-${this.n}`, type, threadId, runId: payload?.runId ?? undefined, occurredAt: this.at(), payload: structuredClone(payload) } });
    }
  }

  /** Puts `payload` in place of the item with its id in the list (or adds it), and tells every
   *  stream: `<kind>.updated`, or `run.created` for a run the thread didn't have. */
  threadEvent(threadId: string, kind: 'run' | 'runtime-request' | 'turn-item' | 'node', payload: any) {
    const t = this.t(threadId);
    const list = kind === 'run' ? t.runs : kind === 'runtime-request' ? t.runtimeRequests : kind === 'node' ? t.nodes! : t.turnItems;
    const at = list.findIndex((x) => x.id === payload.id);
    if (at >= 0) list[at] = payload; else list.push(payload);
    this.emit(threadId, kind === 'run' && at < 0 ? 'run.created' : `${kind}.updated`, payload);
  }

  private run(threadId: string) { return this.threadState[threadId]!.runs.at(-1); }
  /** The thread's live run (the newest by ordinal), or its last one. */
  private liveRun(threadId: string) {
    const t = this.threadState[threadId]!;
    return [...t.runs].filter((r) => LIVE.has(r.status)).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1) ?? this.run(threadId);
  }

  /** A new run on the thread, as T3 makes one for a message: queued behind a live run
   *  (`run.created` only, `queuePosition` set, never started), or started at once otherwise, past
   *  a held queue too (`run.created` with `starting`, then `running`). Seen live (A, B). */
  private newRun(threadId: string, createdBy: string): any {
    const t = this.t(threadId);
    const k = t.runs.length + 1;
    const ordinal = Math.max(0, ...t.runs.map((r) => r.ordinal ?? 0)) + 1;
    const busy = t.runs.some((r) => LIVE.has(r.status));
    const queued = t.runs.filter((r) => r.status === 'queued' && r.queueHeld !== true).length;
    const run = {
      id: `${t.id}-run-${k}`, threadId: t.id, ordinal, rootNodeId: `${t.id}-node-${k}`, createdBy,
      status: busy ? 'queued' : 'starting', queueHeld: false, queuePosition: busy ? queued + 1 : null,
      requestedAt: this.at(), startedAt: busy ? null : this.at(), completedAt: null,
    };
    this.threadEvent(threadId, 'run', run);
    if (!busy) this.threadEvent(threadId, 'run', { ...run, status: 'running' });
    return run;
  }

  /** The run that ran last, as T3 takes it (`latestExecutedRun`): queued runs and runs cancelled
   *  before they started skipped, the latest `completedAt`, an unfinished run the latest. */
  private lastExecuted(t: FakeThread) {
    const end = (r: any) => (r.completedAt ? Date.parse(r.completedAt) : Infinity);
    return t.runs.filter((r) => r.status !== 'queued' && !(r.status === 'cancelled' && !r.startedAt))
      .reduce<any>((a, r) => (!a || end(r) > end(a) || (end(r) === end(a) && r.ordinal > a.ordinal) ? r : a), null);
  }

  /** T3's queue after a run ends (`startNextQueuedRun`): nothing starts in an archived or
   *  deleted thread, while a run is live, or while the run that ran last failed on a usage limit
   *  (its queue isn't held, it waits); otherwise the first unheld queued run by `queuePosition ??
   *  ordinal` starts, renumbered past any newer run that already ran. */
  private startNextQueued(threadId: string) {
    const t = this.t(threadId);
    if (t.archivedAt || t.deletedAt || t.runs.some((r) => LIVE.has(r.status))) return;
    const last = this.lastExecuted(t);
    if (last?.status === 'failed' && this.failureOf(t, last)?.class === 'usage_limit') return;
    const next = t.runs.filter((r) => r.status === 'queued' && r.queueHeld !== true)
      .sort((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal))[0];
    if (!next) return;
    const top = Math.max(0, ...t.runs.map((r) => r.ordinal ?? 0));
    const ordinal = top > next.ordinal ? top + 1 : next.ordinal;
    const started = { ...next, ordinal, status: 'starting', queuePosition: null, startedAt: this.at() };
    this.threadEvent(threadId, 'run', started);
    this.threadEvent(threadId, 'run', { ...started, status: 'running' });
  }

  private failureOf(t: FakeThread, run: any) {
    return t.turnItems.filter((i) => i.type === 'error' && i.status === 'failed' && i.runId === run.id && i.nodeId === run.rootNodeId).at(-1)?.failure ?? null;
  }

  /** How many characters of an item's text `t3_thread_read` gives at once. */
  textChunk = 1_000_000;

  /** The thread's run says something: an `assistant_message` item, as `t3_thread_read` lists it. */
  say(threadId: string, text: string) {
    const t = this.threadState[threadId]!;
    (t.messages ??= []).push({ itemId: `msg-${++this.n}`, type: 'assistant_message', runId: this.run(threadId).id, text });
  }

  /** The thread's live run ends (`completed`, `failed`, `interrupted`, `cancelled`...) and its
   *  queue moves on. A completed run with no interrupt asked releases the held runs no user typed
   *  (T3's release rule, src RL). */
  endRun(threadId: string, status: string) {
    const t = this.t(threadId);
    const run = this.liveRun(threadId);
    this.threadEvent(threadId, 'run', { ...run, status, completedAt: this.at() });
    if (status === 'completed' && !t.turnItems.some((i) => i.type === 'run_interrupt_request' && i.runId === run.id)) {
      for (const r of t.runs.filter((x) => x.status === 'queued' && x.queueHeld === true && x.createdBy !== 'user')) {
        this.threadEvent(threadId, 'run', { ...r, queueHeld: false });
      }
    }
    this.startNextQueued(threadId);
  }

  /** The thread's run fails on the provider: a failed `error` item on its root node, then the run
   *  failed. Any class but `usage_limit` and `validation_error` holds every queued run
   *  (`queueHeld: true`); a usage limit leaves them queued, waiting behind it (src RL). */
  failRun(threadId: string, failure: { class: string; message: string; resetAt?: string | null }) {
    const t = this.t(threadId);
    const run = this.liveRun(threadId);
    this.threadEvent(threadId, 'turn-item', { id: `item-${++this.n}`, type: 'error', status: 'failed', runId: run.id, nodeId: run.rootNodeId, ordinal: this.n, updatedAt: this.at(), failure });
    if (failure.class !== 'usage_limit' && failure.class !== 'validation_error') {
      for (const r of t.runs.filter((x) => x.status === 'queued' && x.queueHeld !== true)) this.threadEvent(threadId, 'run', { ...r, queueHeld: true });
    }
    this.endRun(threadId, 'failed');
  }

  /** The thread's run fails on the provider's usage limit (`failure.class: usage_limit`). */
  hitUsageLimit(threadId: string, resetAt: string | null) {
    this.failRun(threadId, { class: 'usage_limit', message: "You've hit your limit", resetAt });
  }

  /** A send in `queue` mode, as T3 takes it: a new run, queued or started (`newRun`). The app's
   *  sends come through MCP: unconfirmed whether T3 records them `createdBy: agent`. */
  queueMessage(threadId: string, createdBy = 'agent') { return this.newRun(threadId, createdBy); }

  /** The user writes in the thread in T3 itself: a user message (which moves past a link card),
   *  every held run released (a message from the web or mobile app does that), and its run. */
  userWrites(threadId: string) {
    const t = this.t(threadId);
    t.userMessages!.push({ id: `message-${++this.n}`, role: 'user', createdBy: 'user', createdAt: this.at(), updatedAt: this.at() });
    this.emit(threadId, 'message.updated', t.userMessages!.at(-1));
    for (const r of t.runs.filter((x) => x.status === 'queued' && x.queueHeld === true)) this.threadEvent(threadId, 'run', { ...r, queueHeld: false });
    return this.newRun(threadId, 'user');
  }

  /** The user stops the thread (`t3_thread_interrupt {stop: true}`, seen live, B): the interrupt
   *  asked, every queued run held, the run interrupted. Stopping closes pending link cards. */
  stop(threadId: string) {
    const t = this.t(threadId);
    const run = this.liveRun(threadId);
    this.threadEvent(threadId, 'turn-item', { id: `item-${++this.n}`, type: 'run_interrupt_request', status: 'completed', runId: run.id, nodeId: run.rootNodeId, updatedAt: this.at() });
    for (const r of t.runs.filter((x) => x.status === 'queued' && x.queueHeld !== true)) this.threadEvent(threadId, 'run', { ...r, queueHeld: true });
    this.closeLinkCards(threadId);
    this.threadEvent(threadId, 'turn-item', { id: `item-${++this.n}`, type: 'run_interrupt_result', status: 'interrupted', runId: run.id, nodeId: run.rootNodeId, updatedAt: this.at() });
    this.threadEvent(threadId, 'run', { ...this.t(threadId).runs.find((r) => r.id === run.id), status: 'interrupted', completedAt: this.at() });
  }

  /** A queued run cancelled before it ran (`t3_queue {action: cancel}`, seen live, A): it keeps
   *  its ordinal, the highest, with `startedAt: null`. */
  cancelQueued(threadId: string, runId: string) {
    const run = this.threadState[threadId]!.runs.find((r) => r.id === runId);
    this.threadEvent(threadId, 'run', { ...run, status: 'cancelled', queuePosition: null, startedAt: null, completedAt: this.at() });
  }

  /** The held queue released by hand (`queue.resume`), and the next run started. */
  resumeQueue(threadId: string) {
    for (const r of this.t(threadId).runs.filter((x) => x.status === 'queued' && x.queueHeld === true)) this.threadEvent(threadId, 'run', { ...r, queueHeld: false });
    this.startNextQueued(threadId);
  }

  /** The thread's run stops on a question to the user (src RL; not producible here: Claude's
   *  `AskUserQuestion` is denied on this machine): a child node `user_input_request` waiting, a
   *  pending `user_input` runtime request on that node (no `runId`, a live capability) and a
   *  waiting `user_input_request` item. Unconfirmed: whether the run itself goes `waiting` (T3's
   *  code sets the node); here it stays as it was. */
  askUser(threadId: string) {
    const run = this.liveRun(threadId);
    const node = { id: `node-${++this.n}`, kind: 'user_input_request', parentNodeId: run.rootNodeId, runId: run.id, status: 'waiting' };
    this.threadEvent(threadId, 'node', node);
    this.threadEvent(threadId, 'runtime-request', { id: `request-${++this.n}`, nodeId: node.id, providerTurnId: `turn-${this.n}`, kind: 'user_input', status: 'pending', responseCapability: { type: 'live' }, createdAt: this.at(), resolvedAt: null });
    this.threadEvent(threadId, 'turn-item', { id: `item-${++this.n}`, type: 'user_input_request', status: 'waiting', runId: run.id, nodeId: node.id, updatedAt: this.at() });
  }

  /** The user answers the thread's pending question in T3. Answered live, the request resolves
   *  and the same run goes on; one T3 restarted under (its capability `message`) goes as a
   *  message: a new turn (unconfirmed in detail). */
  answerInT3(threadId: string) {
    const t = this.t(threadId);
    let message = false;
    for (const r of t.runtimeRequests.filter((x: any) => x.status === 'pending')) {
      message ||= r.responseCapability?.type === 'message';
      this.threadEvent(threadId, 'runtime-request', { ...r, status: 'resolved', resolvedAt: this.at() });
      const node = t.nodes!.find((n) => n.id === r.nodeId);
      if (node) this.threadEvent(threadId, 'node', { ...node, status: 'completed' });
      for (const i of t.turnItems.filter((x) => x.type === 'user_input_request' && x.nodeId === r.nodeId && x.status === 'waiting')) {
        this.threadEvent(threadId, 'turn-item', { ...i, status: 'completed', updatedAt: this.at() });
      }
    }
    if (message) this.userWrites(threadId);
  }

  /** A secret card (T3's `request_secret`, seen live, D): a turn item, never a runtime request,
   *  on the live run, which stays `running`. */
  secretCard(threadId: string, label = 'a login') {
    const run = this.liveRun(threadId);
    const item = { id: `turn-item:secret-request:${threadId}:${++this.n}`, type: 'secret_request', status: 'waiting', runId: run.id, nodeId: run.rootNodeId, ordinal: 1_000_000 + this.n, secretStatus: 'pending', label, startedAt: this.at(), updatedAt: this.at() };
    this.threadEvent(threadId, 'turn-item', item);
    return item;
  }

  /** The secret card answered (`saved`, `declined`) or timed out (`cancelled`): the tool returns
   *  into the same run, which goes on (seen live, D). */
  answerSecret(threadId: string, secretStatus: 'saved' | 'declined' | 'cancelled' = 'saved') {
    for (const i of this.t(threadId).turnItems.filter((x) => x.type === 'secret_request' && x.status === 'waiting')) {
      this.threadEvent(threadId, 'turn-item', { ...i, status: secretStatus === 'cancelled' ? 'cancelled' : 'completed', secretStatus, updatedAt: this.at() });
    }
  }

  /** A link card (src SRV `PeerLinkRequests`; none has existed in this T3): the ask doesn't wait,
   *  so its run goes on and may end; the card stays `waiting` after it, until answered or the user
   *  writes in the thread after it. */
  linkCard(threadId: string) {
    const run = this.liveRun(threadId);
    const item = { id: `turn-item:link-request:${threadId}:${++this.n}`, type: 'link_request', status: 'waiting', runId: run.id, nodeId: run.rootNodeId, linkStatus: 'pending', hint: 'my vps', startedAt: this.at(), updatedAt: this.at() };
    this.threadEvent(threadId, 'turn-item', item);
    return item;
  }

  /** The link card answered (`link_request.record`): the card done, then its wake, a notification
   *  message `queue_after_active` from the server: a new run (src RL). */
  answerLink(threadId: string, linkStatus: 'linked' | 'declined' = 'linked') {
    for (const i of this.t(threadId).turnItems.filter((x) => x.type === 'link_request' && x.status === 'waiting')) {
      this.threadEvent(threadId, 'turn-item', { ...i, status: 'completed', linkStatus, updatedAt: this.at() });
    }
    return this.newRun(threadId, 'agent');
  }

  /** Stopping or archiving closes pending link cards, with no wake (`closePendingLinkRequests`). */
  private closeLinkCards(threadId: string) {
    for (const i of this.t(threadId).turnItems.filter((x) => x.type === 'link_request' && x.status === 'waiting')) {
      this.threadEvent(threadId, 'turn-item', { ...i, status: 'cancelled', linkStatus: 'cancelled', updatedAt: this.at() });
    }
  }

  /** T3 restarts (src RL's runtime reconcile; not tried live): every stream ends first, so nothing
   *  hears the events it writes, which a stream opened after sees in its snapshot. In each thread:
   *  live runs cancelled; a pending question kept pending, answerable as a message; any other
   *  pending request expired; pending secret cards cancelled; link cards left alone; queued runs
   *  held. Not modelled: the restart continuation T3 may start when
   *  `continueThreadsAfterServerUpdate` is on. */
  restart() {
    this.endThreadStreams();
    this.endShells();
    for (const id of Object.keys(this.threadState)) {
      const t = this.t(id);
      t.runs = t.runs.map((r) => (LIVE.has(r.status) ? { ...r, status: 'cancelled', completedAt: this.at() }
        : r.status === 'queued' ? { ...r, queueHeld: true } : r));
      t.runtimeRequests = t.runtimeRequests.map((r) => (r.status !== 'pending' ? r
        : r.kind === 'user_input' && r.responseCapability?.type === 'live' ? { ...r, responseCapability: { type: 'message' } }
          : { ...r, status: 'expired', responseCapability: { type: 'not_resumable' } }));
      t.turnItems = t.turnItems.map((i) => (i.type === 'secret_request' && i.status === 'waiting' ? { ...i, status: 'cancelled', secretStatus: 'cancelled' } : i));
    }
  }

  /** The thread deleted in T3 (`thread.delete`, seen live, C): a soft delete. `deletedAt` set and
   *  `thread.deleted` sent, then every live or queued run cancelled. Its projection stays
   *  readable; `getThreadTitles` and both shell lists leave it out. Unconfirmed: whether T3 ends
   *  an open thread stream after `thread.deleted`; here it stays open. */
  deleteThread(threadId: string) {
    const t = this.t(threadId);
    t.deletedAt = this.at();
    this.emit(threadId, 'thread.deleted', this.appThread(t));
    for (const r of t.runs.filter((x) => LIVE.has(x.status) || x.status === 'queued')) {
      this.threadEvent(threadId, 'run', { ...r, status: 'cancelled', queuePosition: null, completedAt: this.at() });
    }
    this.tell({ kind: 'thread.removed', sequence: ++this.n, threadId });
  }

  /** The thread archived (seen live, A): `archivedAt` set, `thread.archived` sent, pending link
   *  cards closed. It leaves `subscribeShell` (as `thread.removed`) for
   *  `getArchivedShellSnapshot`; its projection and `getThreadTitles` still have it. */
  archiveThread(threadId: string) {
    const t = this.t(threadId);
    t.archivedAt = this.at();
    this.emit(threadId, 'thread.archived', this.appThread(t));
    this.closeLinkCards(threadId);
    this.tell({ kind: 'thread.removed', sequence: ++this.n, threadId });
  }

  private appThread(t: FakeThread) {
    return { id: t.id, projectId: t.projectId, title: t.title ?? null, branch: t.branch ?? null, archivedAt: t.archivedAt ?? null, deletedAt: t.deletedAt ?? null };
  }

  /** How many turn-item rows `getThreadProjection` keeps. */
  windowRows = WINDOW_ROWS;

  /** The thread's projection, as `orchestration.subscribeThread`'s snapshot has it (whole), or
   *  `getThreadProjection` (`windowed`, src SRV `getThreadSnapshotWindow` and MER
   *  `buildBoundedThreadProjection`): the newest `windowRows` turn items, pending approval and
   *  question items added back (cards aren't); runs that are queued or live, own a kept item, or
   *  are the shell's presented one; pending requests and the kept items' own. */
  projectionOf(threadId: string, windowed: boolean) {
    const t = this.t(threadId);
    const whole = {
      thread: this.appThread(t), runs: t.runs, attempts: [], nodes: t.nodes, subagents: [], providerSessions: [], providerThreads: [],
      providerTurns: [], runtimeRequests: t.runtimeRequests, messages: t.userMessages, plans: [], turnItems: t.turnItems,
      checkpointScopes: [], checkpoints: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], updatedAt: this.at(),
    };
    if (!windowed) return structuredClone(whole);
    const kept = t.turnItems.slice(-this.windowRows);
    for (const i of t.turnItems) {
      if ((i.type === 'approval_request' || i.type === 'user_input_request') && i.status === 'waiting' && !kept.includes(i)) kept.unshift(i);
    }
    const owners = new Set(kept.map((i) => i.runId));
    const nodes = new Set(kept.map((i) => i.nodeId));
    const presented = t.runs.filter((r) => !(r.status === 'queued' && r.queueHeld === true)).sort((a, b) => b.ordinal - a.ordinal)[0];
    return structuredClone({
      ...whole, turnItems: kept,
      runs: t.runs.filter((r) => r.status === 'queued' || LIVE.has(r.status) || owners.has(r.id) || r === presented),
      runtimeRequests: t.runtimeRequests.filter((r) => r.status === 'pending' || r.status === 'waiting' || nodes.has(r.nodeId)),
    });
  }

  /** `orchestration.getThreadTitles {threadIds}`: the title of each that exists, archived ones
   *  included; deleted and unknown ids left out (src MER, `deleted_at IS NULL`). */
  threadTitles(ids: string[]) {
    return Object.fromEntries(ids.map((id) => this.threadState[id]).filter((t) => t && !t.deletedAt).map((t) => [t!.id, t!.title ?? '']));
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

  /** Each launched thread as T3's shell snapshot lists it: the active ones (`subscribeShell`), or
   *  the archived ones (`getArchivedShellSnapshot`). A deleted thread is in neither. */
  private shellThreads(archived = false) {
    return Object.values(this.threadState).filter((t) => !t.deletedAt && Boolean(t.archivedAt) === archived)
      .map((t) => ({ id: t.id, projectId: t.projectId, title: t.title ?? null, branch: t.branch ?? null, archivedAt: t.archivedAt ?? null }));
  }

  /** A thread a tool can act on: one T3 has and hasn't deleted. */
  private kept(threadId: string) {
    const t = this.threadState[threadId];
    return t && !t.deletedAt ? t : undefined;
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
      // T3 answers the launch at `preparing`; its run passes `starting` to `running` at once (no
      // stream is open on a thread that didn't exist, so nothing hears those)
      const at = this.at();
      this.threadState[`thread-${n}`] = {
        id: `thread-${n}`, projectId: args.projectId, title: args.title, runtimeRequests: [], turnItems: [], nodes: [], userMessages: [],
        messages: [{ itemId: `msg-${++this.n}`, type: 'user_message', runId: `run-${n}`, text: args.message }],
        branch: args.workspaceStrategy?.branch ?? null, archivedAt: null, deletedAt: null,
        runs: [{ id: `run-${n}`, threadId: `thread-${n}`, ordinal: 1, rootNodeId: `node-${n}`, createdBy: 'agent', status: 'running', queueHeld: false, queuePosition: null, requestedAt: at, startedAt: at, completedAt: null }],
      };
      if (this.launchOmitsThreadId) return { result: { runId: `run-${n}`, status: 'preparing' } };
      return { result: { threadId: `thread-${n}`, runId: `run-${n}`, link: `t3://thread/thread-${n}`, projectId: args.projectId, modelSelection: args.modelSelection, status: 'preparing' } };
    }
    if (name === 't3_thread_send') {
      // a message to a thread in `queue` mode: a new run, queued behind a live one or started
      // at once (`newRun`, seen live), answered as T3's MCP does (`status`, `delivery`)
      this.beforeSend();
      // a deleted or unknown thread: what T3 answers before it dispatches anything (its sendToThread)
      const t = this.kept(args.threadId);
      if (!t) return { failure: { code: 'thread_not_found', message: `Thread ${args.threadId} was not found.` } };
      if (this.sendFailure && !this.sendTaken) return { failure: this.sendFailure };
      this.sends.push(args);
      const run = this.newRun(t.id, 'agent');
      (t.messages ??= []).push({ itemId: `msg-${++this.n}`, type: 'user_message', runId: run.id, text: args.message });
      if (this.sendFailure) return { failure: this.sendFailure }; // taken, then answered as failed
      const delivery = run.status === 'queued' ? 'queued' : 'started';
      return { result: this.sendOmitsRunId ? { threadId: t.id, status: run.status, delivery } : { threadId: t.id, runId: run.id, status: run.status, delivery } };
    }
    if (name === 't3_thread_read') {
      // `view: messages` pages of `limit` items from `afterPosition`; `itemId` + `textOffset` reads
      // one item's text on, `textChunk` characters at a time (T3 truncates long text)
      const t = this.kept(args.threadId);
      if (!t) return { failure: { code: 'not_found', message: 'The thread was not found.' } };
      if (this.readFailures > 0) { this.readFailures--; return { failure: { code: 'busy', message: 'T3 is busy' } }; }
      if (this.emptyReads > 0) { this.emptyReads--; return { result: { items: [], hasMore: false, nextPosition: null } }; }
      const cut = (item: any, from: number) => {
        const text = String(item.text).slice(from, from + this.textChunk);
        const more = from + this.textChunk < String(item.text).length;
        return { ...item, text, textTruncated: more, nextTextOffset: more ? from + this.textChunk : null };
      };
      if (args.itemId) {
        if (this.emptyContinuations > 0) { this.emptyContinuations--; return { result: { items: [] } }; }
        const item = (t.messages ?? []).find((m) => m.itemId === args.itemId);
        return { result: { items: item ? [cut(item, args.textOffset ?? 0)] : [] } };
      }
      const from = args.afterPosition ?? 0;
      const page = (t.messages ?? []).slice(from, from + args.limit).map((m) => cut(m, 0));
      const more = from + args.limit < (t.messages ?? []).length;
      return { result: { items: page, hasMore: more, nextPosition: more ? from + args.limit : null } };
    }
    if (name === 't3_thread_organize') {
      if (!this.kept(args.threadId)) return { failure: { code: 'not_found', message: 'The thread was not found.' } };
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
        if (this.launchAnswerLost && msg.params.name === 't3_thread_launch') throw new Error('socket hang up');
        if (this.sendAnswerLost && msg.params.name === 't3_thread_send') throw new Error('socket hang up');
        if (done.failure) return json(200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ text: JSON.stringify(done.failure) }] } });
        const bare = this.launchOmitsContent && msg.params.name === 't3_thread_launch';
        const data = `data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: bare ? { content: [] } : { structuredContent: done.result } })}\n\n`;
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
          // T3's thread stream: a snapshot of the thread's whole projection (a bounded one only
          // with `acceptBoundedSnapshot`), then each change. A thread T3 never had fails with its
          // tagged error; a deleted one still streams (seen live)
          const t = this.threadState[msg.payload?.threadId];
          const failed = !t ? threadNotFound(msg.payload?.threadId, 'OrchestrationV2SubscribeThreadError')
            : this.failReads > 0 ? (this.failReads--, this.readFailure)
              : this.failReadsBeside > 0 && (this.threadStreams.get(t.id)?.size ?? 0) > 0 ? (this.failReadsBeside--, this.readFailure) : null;
          if (failed) {
            queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Exit', requestId: msg.id, exit: failed })));
            return;
          }
          const set = this.threadStreams.get(t!.id) ?? new Set();
          this.threadStreams.set(t!.id, set);
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
          this.projectionReads++;
          stream.send({ kind: 'snapshot', snapshotSequence: this.n, projection: this.projectionOf(t!.id, msg.payload?.acceptBoundedSnapshot === true) });
        } else if (msg._tag === 'Request' && msg.tag !== 'orchestration.subscribeShell') {
          const builtIn: Record<string, ((payload: any) => unknown) | undefined> = {
            // windowed (src SRV); a deleted thread reads fine, with `deletedAt`
            'orchestration.getThreadProjection': (payload) => {
              if (!this.threadState[payload?.threadId]) throw threadNotFound(payload?.threadId);
              this.projectionReads++;
              return this.projectionOf(payload.threadId, true);
            },
            'orchestration.getThreadTitles': (payload) => this.threadTitles(Array.isArray(payload?.threadIds) ? payload.threadIds : []),
            // the shape of `OrchestrationV2ArchivedShellSnapshot` beyond its `threads` is unconfirmed
            'orchestration.getArchivedShellSnapshot': () => ({ snapshotSequence: this.n, threads: this.shellThreads(true) }),
          };
          const method = this.wsMethods[msg.tag] ?? builtIn[msg.tag];
          let exit: unknown;
          try {
            exit = method ? { _tag: 'Success', value: method(msg.payload) } : { _tag: 'Failure', cause: { _tag: 'Die', defect: `no method ${msg.tag}` } };
          } catch (e) {
            // the method failing in T3: a Failure, as T3 ends it; a thrown Exit (T3's tagged
            // failure, `threadNotFound`) as it is
            exit = (e as any)?._tag === 'Failure' ? e : { _tag: 'Failure', cause: { _tag: 'Fail', error: (e as Error).message } };
          }
          queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Exit', requestId: msg.id, exit })));
        }
        if (msg._tag === 'Request' && msg.tag === 'orchestration.subscribeShell' && this.shellDown) {
          // T3 failing the shell stream: no snapshot, so no thread list either
          const exit = { _tag: 'Failure', cause: { _tag: 'Fail', error: { message: 'orchestration_error: the shell could not be read' } } };
          queueMicrotask(() => open && on.message(JSON.stringify({ _tag: 'Exit', requestId: msg.id, exit })));
        } else if (msg._tag === 'Request' && msg.tag === 'orchestration.subscribeShell') {
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
          stream.send({ kind: 'snapshot', snapshot: { schemaVersion: 2, snapshotSequence: this.n, projects: this.projects.map((p) => ({ ...p, scripts: [] })), threads: [{ id: 't1' }, ...this.shellThreads()], archivedThreads: [] } }); // `archivedThreads` is always empty in T3 0.1.9
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
