// The stop desk (#158) on fake T3 and fake GitHub: what reaches the user is filed in the PR's one
// `needs-info` issue (or on a build's own issue) and holds the PR; an answer on GitHub releases it;
// a PR merged or closed outside the app clears its stop; the cap gets an Approach note from a
// decision thread first, whose answer is acted on and whose thread is settled once it's read.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DECISION_TEMPLATE, decisionBrief, APPROACH_NOTE, readDecision } from '../src/briefs/decision.ts';
import type { BuildRepo } from '../src/build-lane.ts';
import type { MergePull } from '../src/github.ts';
import { JobLog, type Job, type JobStart, type Stop } from '../src/job-log.ts';
import type { ModelChoice } from '../src/jobs.ts';
import { needsInfoMark, StopDesk } from '../src/stops.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { T3Mcp } from '../src/t3/mcp.ts';
import { runtimeAddress } from '../src/t3/real.ts';
import { T3Ws } from '../src/t3/ws.ts';
import { FakeMergeGitHub } from './fake-github.ts';
import { FakeT3 } from './fake-t3.ts';

const snapshot = JSON.parse(await readFile(new URL('./fixtures/server-config.json', import.meta.url), 'utf8'));
const catalog = catalogFromConfig(snapshot.config);
const DECIDE: ModelChoice = { provider: 'claudeAgent', model: 'claude-haiku-5-5', effort: 'low' };
const APP: BuildRepo = { id: 'p-app', title: 'app', folder: 'C:/code/app', github: 'owner/app' };
const H = 'abcdef1234567890abcdef1234567890abcdef12';
const BRANCH = 'claude/add-a-thing-3';
const github = (part: Partial<MergePull> = {}): MergePull =>
  ({ number: 4, title: 'Add a thing', url: '', state: 'open', headSha: H, branch: BRANCH, base: 'main', draft: false, mergeable: true, labels: [], ...part });
const block = (o: object) => `Thought it through.\n\n\`\`\`queue-runner-decision\n${JSON.stringify({ version: 1, ...o })}\n\`\`\`\n`;

class FakeGate {
  calls: string[] = [];
  room = true;
  pick(id: string, kind: string) {
    this.calls.push(`pick ${id} ${kind}`);
    return this.room ? { fits: true as const, choice: DECIDE, onFallback: false, cost: { five_hour: 15 } }
      : { fits: false as const, until: null, hold: { why: 'reading' as const, provider: 'Claude', checkedAt: null, stale: 'none' as const } };
  }
  started(job: { id: string; kind: string }) { this.calls.push(`started ${job.kind}`); }
  finished(id: string) { this.calls.push(`finished ${id}`); }
  dropped(id: string) { this.calls.push(`dropped ${id}`); }
  forget() {}
}

const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error('not yet'); }, { timeout: 2000, interval: 5 });

let dir: string;
let t3: FakeT3;
let gh: FakeMergeGitHub;
let gate: FakeGate;
let log: JobLog;
let mcp: T3Mcp;
let ws: T3Ws;
let lines: string[];
let answered: Stop[];
let desk: StopDesk;
let tick: number;
/** What the job log's clock says now: a second on from each read. */
const now = () => new Date(Date.UTC(2026, 10, 19, 12, 0, tick++));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qr-stops-'));
  t3 = new FakeT3();
  t3.serverConfig = snapshot;
  await writeFile(join(dir, 'server-runtime.json'), JSON.stringify({ origin: t3.origin }));
  const address = runtimeAddress(join(dir, 'server-runtime.json'));
  mcp = new T3Mcp(address, t3.cli, t3.http);
  ws = new T3Ws(address, t3.cli, t3.http, t3.connect);
  gh = new FakeMergeGitHub();
  gh.prs['owner/app#4'] = github();
  gh.reviewPulls['owner/app'] = [{ number: 4, title: 'Add a thing', body: 'Closes #3', branch: BRANCH, base: 'main', headSha: H, draft: false, url: '' }];
  gate = new FakeGate();
  tick = 0;
  log = await JobLog.open(join(dir, 'jobs.jsonl'), now);
  lines = [];
  answered = [];
});
afterEach(async () => {
  desk?.stop();
  await rm(dir, { recursive: true, force: true });
});

function makeDesk() {
  desk = new StopDesk({
    repos: () => [APP], github: gh, mcp, ws, gate, catalog: () => catalog, user: async () => 'Pat', log,
    say: (l) => lines.push(l), answered: (s) => answered.push(s), retry: () => () => {},
  });
  return desk;
}

const job = (part: Partial<JobStart>): JobStart => ({
  kind: 'fix', repo: APP.id, github: 'owner/app', issue: 4, branch: BRANCH, base: 'main', title: 'Queue runner fix: app#4',
  choice: DECIDE, onFallback: false, sha: H, ...part,
});

/** A job that ran on thread `thread`, whose last message was `said`, ended `end`. */
async function ran(part: Partial<JobStart>, end: Parameters<JobLog['ended']>[1], thread = 'thread-x', said = 'Which API should it keep, v1 or v2?'): Promise<Job> {
  const j = await log.started(job(part));
  await log.thread(j.id, { threadId: thread, runId: `${thread}-run`, link: `t3://thread/${thread}` });
  t3.threadState[thread] = { id: thread, projectId: APP.id, runtimeRequests: [], turnItems: [], runs: [{ id: `${thread}-run`, threadId: thread, ordinal: 1, rootNodeId: 'n', status: 'completed' }],
    messages: [{ itemId: 'm1', type: 'assistant_message', runId: `${thread}-run`, text: said }] };
  return log.ended(j.id, end);
}

/** The review lane's review 3 of H, at the cap: its Approach note is owed. */
async function atTheCap(): Promise<Job> {
  const r = await log.started(job({ kind: 'review', title: 'Queue runner review: app#4', round: 3, reviewer: 'r' }));
  return log.ended(r.id, { outcome: 'approach-note', verdict: 'blocking', signals: ['repeated-class'], link: 'https://github.com/owner/app/pull/4#issuecomment-9' });
}

const posted = (what: string) => gh.posted.filter((p) => p.what === what);
const reply = (n: number, body: string, author = 'pat') =>
  (gh.comments[`owner/app#${n}`] ??= []).push({ author, createdAt: '2026-11-19T13:00:00Z', body });

describe('the cap: an Approach note from a decision thread, then the stop', () => {
  test("review 3 still blocking: a decision thread writes the note, it's posted on the PR, and the stop is filed in a new needs-info issue", async () => {
    await atTheCap();
    makeDesk();
    await desk.pass();
    await until(() => t3.launches.length === 1);
    expect(gate.calls).toContain(`pick decision:${log.stops()[0]!.id} decision`);
    const launch = t3.launches[0]!;
    expect(launch).toMatchObject({ projectId: APP.id, title: 'Queue runner decision: app#4', modelSelection: { instanceId: DECIDE.provider, model: DECIDE.model } });
    expect(launch.workspaceStrategy).toBeUndefined(); // no worktree: it changes nothing
    expect(launch.message).toContain('Write Pat an Approach note');
    expect(launch.message).toContain('review 3 on abcdef1: approach-note (signals: repeated-class)');
    const decision = log.jobs().find((j) => j.kind === 'decision')!;
    expect(decision).toMatchObject({ question: 'approach-note', about: log.stops()[0]!.id, issue: 4 });
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.say('thread-1', block({ action: 'approach-note', note: 'The cache is the wrong layer.', recommend: 'rework' }));
    t3.endRun('thread-1', 'completed');
    await desk.idle();
    await desk.pass();
    // acted on: the note on the PR, the thread settled once its answer was read
    const note = posted('comment').find((p) => p.body.startsWith('## Approach note'))!;
    expect(note).toMatchObject({ n: 4 });
    expect(note.body).toContain('The cache is the wrong layer.\n\n**Recommendation:** rework.');
    expect(log.get(decision.id)).toMatchObject({ end: { outcome: 'decided', action: 'approach-note' }, settledAt: expect.any(String) });
    expect(t3.toolCalls.filter((c) => c.tool === 't3_thread_organize')).toEqual([{ tool: 't3_thread_organize', args: { threadId: 'thread-1', action: 'settle' } }]);
    // filed: one needs-info issue for the PR, the stop in it, and the PR told
    expect(posted('issue')).toEqual([expect.objectContaining({ title: 'PR #4 needs Pat: Add a thing', labels: ['needs-info'], body: expect.stringContaining(needsInfoMark('owner/app', 4)) })]);
    const issue = posted('issue')[0]!.url;
    const onIssue = posted('comment').find((p) => p.n === Number(issue.split('/').pop()))!;
    expect(onIssue.body).toContain('**Stopped for Pat** (the cap): review 3 of abcdef1 is still blocking at the cap (review 3).');
    expect(onIssue.body).toContain(`The Approach note: ${note.url}. Recommendation: rework.`);
    expect(posted('comment').find((p) => p.n === 4 && p.body.startsWith('**Stopped for Pat:**'))!.body).toContain(`It's in ${issue}`);
    expect(log.stops()[0]).toMatchObject({ cause: 'cap', filed: { issue } });
    // a pass after files nothing more
    const writes = gh.posted.length;
    await desk.pass();
    expect(gh.posted).toHaveLength(writes);
  });

  test("an answer it can't read is a stop that says why, with no note", async () => {
    await atTheCap();
    makeDesk();
    await desk.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.say('thread-1', block({ action: 'merge-it' }));
    t3.endRun('thread-1', 'completed');
    await desk.idle();
    await desk.pass();
    expect(posted('comment').some((p) => p.body.startsWith('## Approach note'))).toBe(false);
    expect(posted('comment').find((p) => p.n === 101)!.body).toContain(`No Approach note: the decision thread's answer couldn't be read: its action "merge-it" isn't one this question allows (approach-note, stop).`);
    expect(log.jobs().find((j) => j.kind === 'decision')!.end).toMatchObject({ outcome: 'decided', action: 'stop' });
  });

  test('its stop action is the question put to the user', async () => {
    await atTheCap();
    makeDesk();
    await desk.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.say('thread-1', block({ action: 'stop', question: 'Keep v1 working? I would drop it.' }));
    t3.endRun('thread-1', 'completed');
    await desk.idle();
    await desk.pass();
    expect(posted('comment').find((p) => p.n === 101)!.body).toContain('asks you instead:\n\n> Keep v1 working? I would drop it.');
  });

  test('the gate holding the decision holds the note, said once; the stop holds the PR meanwhile', async () => {
    gate.room = false;
    await atTheCap();
    makeDesk();
    await desk.pass();
    await desk.pass();
    expect(t3.launches).toEqual([]);
    expect(lines.filter((l) => l.includes('decision app#4: waits:'))).toHaveLength(1);
    expect(log.openStops(APP.id, 4)).toHaveLength(1);
  });

  test("after a restart, an open decision with its thread is watched again; one without files the stop with no note", async () => {
    await atTheCap();
    makeDesk();
    await desk.pass();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    desk.stop();
    // a new app: the decision is open with its thread
    makeDesk();
    await desk.start();
    await until(() => t3.threadStreamCount('thread-1') > 0);
    t3.say('thread-1', block({ action: 'approach-note', note: 'Overbuilt.', recommend: 'hold' }));
    t3.endRun('thread-1', 'completed');
    await desk.idle();
    await desk.pass();
    expect(posted('comment').filter((p) => p.body.startsWith('## Approach note'))).toHaveLength(1);
    expect(t3.launches).toHaveLength(1);
  });
});

describe('a question, and a job that needs the user', () => {
  test("a fix round waiting on a question: filed on the PR with its last message; the user's reply answers it and the job", async () => {
    const fix = await ran({}, { outcome: 'waiting', request: 'user_input' });
    makeDesk();
    await desk.pass();
    expect(posted('comment').find((p) => p.n === 101)!.body).toContain('**Stopped for Pat** (a question): Queue runner fix: app#4 stopped to ask a question.\n\nIts last message:\n\n> Which API should it keep, v1 or v2?');
    expect(log.openStops(APP.id, 4)).toHaveLength(1);
    // the app's own posts and a bot's are no answer
    reply(4, 'Coverage: 80%', 'codecov[bot]');
    await desk.pass();
    expect(answered).toEqual([]);
    reply(101, 'Keep v2 only.');
    await desk.pass();
    expect(log.stops()[0]!.answered).toMatchObject({ answer: 'replied', text: 'Keep v2 only.' });
    expect(log.get(fix.id)!.answeredAt).toEqual(expect.any(String));
    expect(answered.map((s) => s.id)).toEqual([log.stops()[0]!.id]);
    expect(log.openStops(APP.id, 4)).toEqual([]);
  });

  test('a fix round that ended without a push is a question; a second stop on the PR goes in the same needs-info issue', async () => {
    await ran({}, { outcome: 'done', head: H }, 'thread-a');
    await ran({ sha: 'c'.repeat(40) }, { outcome: 'waiting', request: 'user_input' }, 'thread-b');
    makeDesk();
    await desk.pass();
    expect(posted('issue')).toHaveLength(1);
    expect(log.stops().map((s) => s.filed?.issue)).toEqual([posted('issue')[0]!.url, posted('issue')[0]!.url]);
  });

  test("a build that ended without a PR, or waits on a question: the stop is on its own issue, labelled needs-info", async () => {
    await ran({ kind: 'build', issue: 3, title: 'Queue runner build: app#3', sha: undefined }, { outcome: 'done-no-pr' });
    makeDesk();
    await desk.pass();
    expect(posted('comment')).toEqual([expect.objectContaining({ n: 3, body: expect.stringContaining('Queue runner build: app#3 ended without a PR') })]);
    expect(posted('relabel')).toEqual([{ what: 'relabel', repo: 'owner/app', n: 3, add: 'needs-info', remove: 'ready-for-agent' }]);
    expect(posted('issue')).toEqual([]);
    expect(log.stops()[0]).toMatchObject({ on: 'issue', pr: 3, sha: null });
    // no PR stop holds PR #3 or #4: it's the issue's
    expect(log.openStops(APP.id, 3)).toEqual([]);
    expect(log.openStops(APP.id, 3, 'issue')).toHaveLength(1);
  });

  test('a job with no saved thread id after a restart is filed; answering it frees its repo', async () => {
    const j = await log.started(job({ kind: 'review', title: 'Queue runner review: app#4', round: 1 }));
    await log.ended(j.id, { outcome: 'needs-user', error: 'the app stopped before T3 named its thread' });
    expect(log.needingUser(APP.id)).toHaveLength(1);
    makeDesk();
    await desk.pass();
    expect(posted('comment').find((p) => p.n === 101)!.body).toContain('(a job the app lost track of): Queue runner review: app#4 may have started a T3 thread the app has no id of (the app stopped before T3 named its thread)');
    gh.states['owner/app#101'] = 'closed';
    await desk.pass();
    expect(log.stops()[0]!.answered).toMatchObject({ answer: 'issue-closed' });
    expect(log.needingUser(APP.id)).toEqual([]);
  });

  test("a question whose last message can't be read yet isn't filed without it: tried again next pass", async () => {
    await ran({}, { outcome: 'waiting', request: 'user_input' });
    t3.readFailures = 1000;
    makeDesk();
    await desk.pass();
    expect(posted('comment')).toEqual([]);
    expect(lines.some((l) => l.includes('tried again next pass'))).toBe(true);
    t3.readFailures = 0;
    await desk.pass();
    expect(posted('comment')).toHaveLength(2);
  });

  test('a write that fails is tried again next pass, and nothing is posted twice', async () => {
    await ran({}, { outcome: 'waiting', request: 'user_input' });
    makeDesk();
    const post = gh.postComment.bind(gh);
    let fails = 1;
    gh.postComment = async (repo, n, body) => {
      if (n === 4 && fails-- > 0) throw new Error('gh failed (HTTP 502)');
      return post(repo, n, body);
    };
    await desk.pass();
    expect(log.stops()[0]!.filed).toBeUndefined();
    await desk.pass();
    expect(log.stops()[0]!.filed).toBeDefined();
    expect(posted('comment').filter((p) => p.n === 101)).toHaveLength(1);
    expect(posted('comment').filter((p) => p.n === 4)).toHaveLength(1);
  });
});

describe('a PR merged or closed outside the app clears its stop (#88)', () => {
  test.each([['merged', 'completed'], ['closed', 'not_planned']] as const)('%s: its needs-info issue gets a note and is closed %s', async (state, reason) => {
    await ran({}, { outcome: 'waiting', request: 'user_input' });
    makeDesk();
    await desk.pass();
    gh.prs['owner/app#4'] = github({ state });
    await desk.pass();
    expect(log.stops()[0]!.answered).toMatchObject({ answer: 'pr-closed' });
    expect(posted('close')).toEqual([{ what: 'close', repo: 'owner/app', n: 101, reason }]);
    expect(posted('comment').at(-1)!.body).toContain(`PR #4 was ${state} without an answer here`);
    expect(log.lastAnswer(APP.id, 4)).toBeUndefined(); // a clear is no answer to go on from
  });
});

describe('the decision brief', () => {
  test('is self-contained: no skill, no slash command, no path outside the repo, no person', () => {
    expect(DECISION_TEMPLATE).not.toMatch(/\bskills?\b/i);
    expect(DECISION_TEMPLATE).not.toMatch(/^\s*\/[a-z][\w-]*\b/m);
    expect(DECISION_TEMPLATE).not.toMatch(/~\/|\b[A-Za-z]:[\\/]/);
    expect(DECISION_TEMPLATE).not.toContain('Stefan');
    const brief = decisionBrief({ subject: 'owner/app#4', user: 'Pat', question: APPROACH_NOTE, sources: [{ title: 'A', text: 'x'.repeat(5000) }] });
    expect(brief).not.toContain('$');
    expect(brief).toContain('(clipped at 3000 characters)');
    expect(brief).toContain('- `approach-note`: `note` (');
  });

  test('reads only the last block, with the fields the action needs', () => {
    expect(readDecision(`${block({ action: 'stop', question: 'a' })}\n${block({ action: 'approach-note', note: 'n', recommend: 'hold' })}`, APPROACH_NOTE))
      .toEqual({ action: 'approach-note', fields: { note: 'n', recommend: 'hold' } });
    expect(readDecision('no block', APPROACH_NOTE)).toEqual({ error: 'its reply has no queue-runner-decision block' });
    expect(readDecision(block({ action: 'approach-note', note: ' ', recommend: 'hold' }), APPROACH_NOTE)).toEqual({ error: 'its approach-note has no note' });
    expect(readDecision('```queue-runner-decision\n{"version": 2, "action": "stop", "question": "q"}\n```', APPROACH_NOTE)).toEqual({ error: 'its answer is version 2, not 1' });
  });
});
