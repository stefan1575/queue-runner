// The T3 seam, ported from `tests/test_t3.py` case for case (#217): the launch and the wait, the
// reply and the error, `show`, `list` and `send`, against T3's server answering from responses
// recorded off the running T3 (`test/recorded-t3.ts`). Python's cases on the CLI's output are
// ported onto the MCP calls that replace the CLI; the one on Python's missing MCP client is left
// out (the seam always has one). The cases after `ShowAndListTest` are the port's own: the reads
// that replace Python's database and transcripts, and the calls test_t3.py doesn't cover.
import { describe, expect, test } from 'vitest';
import {
  LastCall, T3Error, T3Server, T3Store, auto_resume_warning, find_job_thread, settle_quietly,
} from '../src/t3-seam.ts';
import { model } from '../src/jobs.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';
import { RecordedT3, about, content, recordedThread, recording, value, withContent, withValue } from './recorded-t3.ts';

const CLAUDE = { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'high' };

// Thread A of the note: launched, run 1 completed with the reply "ok".
const LAUNCHED = recording('mcp-thread_launch-started');
const A: string = content(LAUNCHED).threadId;
const RUN_A: string = content(LAUNCHED).runId;
const PROJECTS = recording('mcp-project_list');
const SANDBOX = content(PROJECTS).projects.find((p: any) => p.title === 'queue-runner sandbox');

/** T3 with the sandbox project listed and thread A launched; each other answer the test's own. */
function t3(): RecordedT3 {
  return new RecordedT3().answer('t3_project_list', PROJECTS).answer('t3_thread_launch', LAUNCHED);
}

// Each model's effort option, from T3's recorded catalog: Claude's `effort`, Codex's `reasoningEffort`
const CATALOG = catalogFromConfig(value(recording('ws-subscribeServerConfig-snapshot')).config);
const effortOption = (provider: string, m: string) => model(CATALOG, { provider, model: m })?.effortOption ?? null;
const seam = (r: RecordedT3) => new T3Server(r.mcp, r.ws, effortOption);
const onA = (name: string) => about(recording(name), A);

/** A timeline item shaped as the recorded reply of thread A. */
const ITEM = content(recording('mcp-thread_read-completed')).items[1];
const item = (type: string, text: string, run = RUN_A, extra: object = {}) =>
  ({ ...ITEM, itemId: `i-${type}-${text.slice(0, 4)}`, runId: run, type, text, textTruncated: false, nextTextOffset: null, ...extra });

/** Thread A's recorded read with these items, and the rest of a truncated text read on. */
const reads = (items: any[]) => (args: any) => withContent(onA('mcp-thread_read-completed'), (c) => (args.itemId
  ? { ...c, items: [{ ...item('assistant_message', ' and the rest.'), itemId: args.itemId }] }
  : { ...c, items, hasMore: false, nextPosition: items.length }));

describe('StartTest', () => {
  test('launches with the model its effort and a worktree in full access', async () => {
    const r = t3().answer('t3_thread_wait', onA('mcp-thread_wait-completed')).answer('t3_thread_read', onA('mcp-thread_read-completed'));
    await seam(r).start(SANDBOX.workspaceRoot, 'Line one\nLine two', { title: 'A job', worktree: 'origin/main', branch: 'claude/x-4', ...CLAUDE });
    expect(r.argsOf('t3_thread_launch')).toStrictEqual([{
      projectId: SANDBOX.id, title: 'A job', message: 'Line one\nLine two', runtimeMode: 'full-access',
      modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }] },
      workspaceStrategy: { type: 'worktree', baseRef: 'origin/main', branch: 'claude/x-4' },
    }]);
  });

  test('with no worktree it runs in the project folder', async () => {
    const r = t3().answer('t3_thread_wait', onA('mcp-thread_wait-completed')).answer('t3_thread_read', onA('mcp-thread_read-completed'));
    await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE });
    expect(r.argsOf('t3_thread_launch')[0]).not.toHaveProperty('workspaceStrategy');
  });

  test('a codex model gets its effort as reasoning effort', async () => {
    const r = t3().answer('t3_thread_wait', onA('mcp-thread_wait-completed')).answer('t3_thread_read', onA('mcp-thread_read-completed'));
    await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' });
    expect(r.argsOf('t3_thread_launch')[0].modelSelection.options).toStrictEqual([{ id: 'reasoningEffort', value: 'high' }]);
  });

  test('a completed run gives its last reply in full', async () => {
    const r = t3().answer('t3_thread_wait', onA('mcp-thread_wait-completed')).answer('t3_thread_read', reads([
      item('user_message', 'Do it.'),
      item('assistant_message', 'An earlier word', `${RUN_A}0`),
      item('assistant_message', 'First'),
      item('assistant_message', 'Red or blue?', RUN_A, { textTruncated: true, nextTextOffset: 12 }),
    ]));
    const result = await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE });
    expect([result.exit_code, result.thread_id, result.run_id, result.status]).toStrictEqual([0, A, RUN_A, 'completed']);
    expect(result.reply).toBe('Red or blue? and the rest.');
    expect(result.error).toBeNull();
  });

  test('it waits in slices until the run ends', async () => {
    const running = onA('mcp-thread_wait-running');
    const r = t3().answer('t3_thread_wait', running, running, onA('mcp-thread_wait-completed'))
      .answerWs('orchestration.getThreadFamily', onA('ws-getThreadFamily-shell-running'))
      .answer('t3_thread_read', onA('mcp-thread_read-completed'));
    const result = await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE });
    expect(result.exit_code).toBe(0);
    expect(r.argsOf('t3_thread_wait')).toStrictEqual(Array(3).fill({ threadId: A, runId: RUN_A, timeoutMs: 15000 }));
  });

  test('a failed run is exit 1 with its error', async () => {
    const r = t3().answer('t3_thread_wait', onA('mcp-thread_wait-failed-unknown-model'))
      .answer('t3_thread_read', onA('mcp-thread_read-activity-failed-unknown-model'));
    const result = await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE });
    expect([result.exit_code, result.status, result.reply, result.error])
      .toStrictEqual([1, 'failed', null, 'Claude gave up after repeated API errors.']);
    expect(r.argsOf('t3_thread_read')[0].view).toBe('activity');
  });

  // T3's MCP read counts a secret card as no pending request (the note, section 1): the shell is
  // read instead, which shows an approval and a secret card alike
  test.each(['secret-pending', 'approval-pending'])('a run waiting for an answer is exit 2 (%s)', async (state) => {
    const r = t3().answer('t3_thread_wait', onA(`mcp-thread_wait-${state}`))
      .answerWs('orchestration.getThreadFamily', onA(`ws-getThreadFamily-shell-${state}`));
    const result = await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE });
    expect([result.exit_code, result.status, result.reply, result.error]).toStrictEqual([2, 'waiting', null, null]);
    expect(r.argsOf('t3_thread_wait').map((a) => a.timeoutMs)).toStrictEqual([15000, 1]);
  });

  test('a pending request that just ended is the runs end', async () => {
    const r = t3().answer('t3_thread_wait', onA('mcp-thread_wait-secret-pending'), onA('mcp-thread_wait-completed'))
      .answerWs('orchestration.getThreadFamily', onA('ws-getThreadFamily-shell-secret-pending'))
      .answer('t3_thread_read', onA('mcp-thread_read-completed'));
    const result = await seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE });
    expect([result.exit_code, result.reply]).toStrictEqual([0, 'ok']);
  });

  test('a folder with no t3 project raises', async () => {
    await expect(seam(t3()).start('C:/nowhere', 'Do it.', { title: 'A job', ...CLAUDE })).rejects.toThrow('No T3 Code project');
    await expect(seam(t3()).start('C:/nowhere', 'Do it.', { title: 'A job', ...CLAUDE })).rejects.toBeInstanceOf(T3Error);
  });

  test('a relative folder matches its projects absolute root', async () => {
    // config keeps a served repo's path as written ('.'); T3 holds the absolute root
    const here = withContent(PROJECTS, (c) => ({ ...c, projects: [{ ...c.projects[1], id: 'proj-here', workspaceRoot: process.cwd() }] }));
    const r = t3().answer('t3_project_list', here);
    await seam(r).launch('.', 'Ask.', { title: 'Decide: x', ...CLAUDE });
    expect(r.argsOf('t3_thread_launch')[0].projectId).toBe('proj-here');
  });

  test.each(['unknown-project', 'bad-baseRef', 'disabled-provider'])('a refused launch raises (%s)', async (why) => {
    const r = t3().answer('t3_thread_launch', recording(`mcp-thread_launch-${why}`));
    await expect(seam(r).start(SANDBOX.workspaceRoot, 'Do it.', { title: 'A job', ...CLAUDE })).rejects.toBeInstanceOf(T3Error);
  });

  test('launch returns at once with its thread', async () => {
    const r = t3();
    const launched = await seam(r).launch(SANDBOX.workspaceRoot, 'Ask.', { title: 'Decide: x', ...CLAUDE });
    expect([launched.thread_id, launched.run_id]).toStrictEqual([A, RUN_A]);
    expect(r.calls.map((c) => c.tool)).toStrictEqual(['t3_project_list', 't3_thread_launch']);
    expect(r.argsOf('t3_thread_launch')[0].modelSelection.options).toStrictEqual([{ id: 'effort', value: 'high' }]);
    expect(r.argsOf('t3_thread_launch')[0].runtimeMode).toBe('full-access');
  });
});

describe('ShowAndListTest', () => {
  test('show gives the thread and its latest messages', async () => {
    const read = recording('mcp-thread_read-approval-interrupted');
    const thread_id = recordedThread(read);
    const r = new RecordedT3().answer('t3_thread_read', read)
      .answerWs('orchestration.getThreadFamily', recording('ws-getThreadFamily-shell-approval-interrupted'));
    const [thread, messages] = await seam(r).show(thread_id, 2);
    expect(r.argsOf('t3_thread_read')[0]).toStrictEqual({ threadId: thread_id, limit: 1, runLimit: 1 });
    expect(thread.status).toBe('interrupted');
    expect(thread.title).toBe('t3-api-facts C2 (research, safe to delete)');
    expect(thread.link.startsWith('https://app.t3.codes/threads/')).toBe(true);
    expect(thread.active).toBe(false);
    expect(thread.worktree_path).toBeNull();
    expect(thread.pending_requests).toBe(0);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => ['user', 'assistant'].includes(m.role))).toBe(true);
  });

  test('list gives a projects threads', async () => {
    const first = recording('mcp-thread_list-sandbox');      // 5 of the project's threads, from 5 on next
    const rest = recording('mcp-thread_list-titleContains'); // a last page
    const r = new RecordedT3().answer('t3_project_list', PROJECTS).answer('t3_thread_list', first, rest);
    const threads = await seam(r).list(SANDBOX.workspaceRoot);
    expect(r.argsOf('t3_thread_list')).toStrictEqual([
      { projectId: SANDBOX.id, limit: 100 }, { projectId: SANDBOX.id, limit: 100, cursor: 5 }]);
    expect(threads.map((t) => t.title)).toStrictEqual([...content(first).threads, ...content(rest).threads].map((t: any) => t.title));
    expect(threads[0]!.title).toBe('Queue runner build: queue-runner sandbox#295597');
    expect(threads[0]!.created_at).toBe('2026-11-20T04:34:55.951Z');
    expect(threads[0]!.settled).toBe(true);
    const c2 = threads.find((t) => t.title.startsWith('t3-api-facts C2'))!;
    expect([c2.status, c2.active, c2.settled]).toStrictEqual(['interrupted', false, false]);
  });

  test('send waits for the reply', async () => {
    // thread G's send, which started a run at once (`delivery: started`), as on thread A
    const sent = onA('mcp-thread_send-unknown-model');
    const r = new RecordedT3().answer('t3_thread_send', sent).answer('t3_thread_wait', onA('mcp-thread_wait-completed'))
      .answer('t3_thread_read', onA('mcp-thread_read-completed'));
    const result = await seam(r).send(A, 'Go on.');
    expect(r.argsOf('t3_thread_send')).toStrictEqual([{ threadId: A, message: 'Go on.', mode: 'queue' }]);
    expect(r.argsOf('t3_thread_wait')[0]).toStrictEqual({ threadId: A, runId: content(sent).runId, timeoutMs: 15000 });
    expect(result.status).toBe('completed');
    expect(result.reply).toBe('ok');
  });

  test('send with t3 failing raises', async () => {
    const r = new RecordedT3().answer('t3_thread_send', recording('mcp-thread_send-archived'));
    await expect(seam(r).send(A, 'Go on.')).rejects.toBeInstanceOf(T3Error);
  });

  test('send waiting for an answer is exit 2', async () => {
    const r = new RecordedT3().answer('t3_thread_send', onA('mcp-thread_send-unknown-model'))
      .answer('t3_thread_wait', onA('mcp-thread_wait-secret-pending'))
      .answerWs('orchestration.getThreadFamily', onA('ws-getThreadFamily-shell-secret-pending'));
    const result = await seam(r).send(A, 'Go on.');
    expect([result.exit_code, result.status]).toStrictEqual([2, 'waiting']);
  });
});

describe('the port: what replaces the CLI and the database', () => {
  test('show counts a secret card as a pending request, which the MCP read leaves out', async () => {
    const read = recording('mcp-thread_read-secret-pending');
    expect(content(read).thread.pendingRequestCount).toBe(0);
    const r = new RecordedT3().answer('t3_thread_read', read)
      .answerWs('orchestration.getThreadFamily', recording('ws-getThreadFamily-shell-secret-pending'));
    const [thread] = await seam(r).show(recordedThread(read));
    expect([thread.status, thread.active, thread.pending_requests]).toStrictEqual(['running', true, 1]);
  });

  test('show gives each of the last messages in full', async () => {
    const said = [item('user_message', 'Do it.'), item('assistant_message', 'Red or blue?', RUN_A, { textTruncated: true, nextTextOffset: 12 })];
    const r = new RecordedT3().answer('t3_thread_read', reads(said))
      .answerWs('orchestration.getThreadFamily', onA('ws-getThreadFamily-shell-settled'));
    const [, messages] = await seam(r).show(A, 1);
    expect(messages.map((m) => [m.role, m.text, m.run_id])).toStrictEqual([['assistant', 'Red or blue? and the rest.', RUN_A]]);
  });

  test('settle and rename go to t3_thread_organize and t3_thread_update', async () => {
    const r = new RecordedT3().answer('t3_thread_organize', onA('mcp-thread_organize-settle'))
      .answer('t3_thread_update', onA('mcp-thread_organize-settle'));
    await seam(r).settle(A);
    await seam(r).rename(A, 'New title');
    expect(r.calls).toStrictEqual([
      { tool: 't3_thread_organize', args: { threadId: A, action: 'settle' } },
      { tool: 't3_thread_update', args: { threadId: A, action: 'rename', title: 'New title' } }]);
  });

  test('settle quietly says a failure and never raises', async () => {
    const r = new RecordedT3().answer('t3_thread_organize', recording('mcp-thread_organize-deleted'));
    const said: string[] = [];
    expect(await settle_quietly(seam(r), 'mcp:gone', 'build demo#4', (l) => said.push(l))).toBe(false);
    expect(said).toStrictEqual(["build demo#4: settling its thread mcp:gone in T3 failed (ToolFailed: t3_thread_organize failed: thread_not_found: The thread was not found.); left as it is"]);
    expect(await settle_quietly(seam(r), null, 'build demo#4', (l) => said.push(l))).toBe(false);
    expect(await settle_quietly(null, 'mcp:gone', 'build demo#4', (l) => said.push(l))).toBe(false);
  });

  test('find job thread by its id, else the newest by its title since the job started', async () => {
    const list = withContent(recording('mcp-thread_list-titleContains'), (c) => ({
      ...c, threads: c.threads.map((t: any) => ({ ...t, title: 'A job' })),
    }));
    const read = recording('mcp-thread_read-completed');
    const r = new RecordedT3().answer('t3_project_list', PROJECTS).answer('t3_thread_list', list)
      .answer('t3_thread_read', read).answerWs('orchestration.getThreadFamily', recording('ws-getThreadFamily-shell-settled'));
    const job = { thread_id: null, started_at: '2026-11-20T17:04:00+00:00', title: 'A job' };
    expect((await find_job_thread(seam(r), job, SANDBOX.workspaceRoot))!.thread_id).toBe(A);
    // C2 is the newest of those created since 17:03:55 (B2, C, D, E, C2): the one read
    expect(r.argsOf('t3_thread_read')[0].threadId).toBe(content(list).threads[0].threadId);
    expect(await find_job_thread(seam(r), job, null)).toBeNull();
    expect(await find_job_thread(seam(r), { ...job, started_at: '2026-11-21T00:00:00+00:00' }, SANDBOX.workspaceRoot)).toBeNull();
    r.calls.length = 0;
    await find_job_thread(seam(r), { ...job, thread_id: A }, null);
    expect(r.calls.map((c) => c.tool)).toStrictEqual(['t3_thread_read', 't3_thread_read']);
  });
});

describe('T3Store: the thread facts Python read from the database and transcripts', () => {
  const store = (...snapshots: any[]) => new T3Store(new RecordedT3().answerWs('orchestration.subscribeThread', ...snapshots).ws);

  test('a failed run gives the failure T3 recorded on its error item', async () => {
    const snap = recording('ws-subscribeThread-snapshot-failed-unknown-model');
    const run = value(snap).projection.runs[0].id;
    const s = store(snap);
    expect(await s.run_failure(recordedThread(snap), run)).toStrictEqual({
      class: 'provider_error', message: 'Claude gave up after repeated API errors.', code: 'api_error_404', retryable: null });
    expect(await s.limit_reset(recordedThread(snap), run)).toStrictEqual([false, null]);
    expect(await s.run_failure(recordedThread(snap), null)).toBeNull();
    expect(await s.run_failure(recordedThread(snap), `${run}0`)).toBeNull();
  });

  test('a usage limit wins and gives its reset', async () => {
    // no limit could be hit live: the recorded error item with the failure T3's source gives a limit
    const snap = withValue(recording('ws-subscribeThread-snapshot-failed-unknown-model'), (v) => {
      const error = v.projection.turnItems.find((i: any) => i.type === 'error');
      const limit = { ...error, id: `${error.id}-limit`, ordinal: error.ordinal + 1,
        failure: { class: 'usage_limit', message: 'Claude usage limit reached.', code: null, retryable: null, resetAt: '2026-11-20T21:49:59.983Z' } };
      return { ...v, projection: { ...v.projection, turnItems: [limit, ...v.projection.turnItems] } };
    });
    const run = value(snap).projection.runs[0].id;
    expect(await store(snap).limit_reset(recordedThread(snap), run)).toStrictEqual([true, new Date('2026-11-20T21:49:59.983Z')]);
  });

  test('a thread T3 never had reads as nothing found', async () => {
    const s = store(recording('ws-subscribeThread-never-existed'));
    expect(await s.run_failure('mcp:none', 'run:x')).toBeNull();
    expect(await s.last_call('mcp:none')).toStrictEqual(new LastCall(null, null));
    expect(await s.cache_expires_at('mcp:none')).toBeNull();
    expect(await s.run_effort('mcp:none', 'run:x')).toBeNull();
  });

  test('the last call is the newest claude turns token usage', async () => {
    const snap = recording('ws-subscribeThread-snapshot-completed');
    const s = store(snap);
    expect(await s.last_call(recordedThread(snap))).toStrictEqual(
      new LastCall(new Date('2026-11-20T17:02:07.553Z'), 47888, new Date('2026-11-20T17:02:07.564Z')));
    expect(await s.context_tokens(recordedThread(snap))).toBe(47888);
    expect(await s.cache_expires_at(recordedThread(snap))).toStrictEqual(new Date('2026-11-20T18:02:07.553Z'));
  });

  test('of two turns the newest gives the cache expiry and the last call', async () => {
    const snap = recording('ws-subscribeThread-snapshot-deleted');
    const s = store(snap);
    expect(await s.cache_expires_at(recordedThread(snap))).toStrictEqual(new Date('2026-11-20T18:03:00.903Z'));
    expect((await s.last_call(recordedThread(snap))).tokens).toBe(55447);
  });

  test('a run that failed before claude answered has no last call', async () => {
    const snap = recording('ws-subscribeThread-snapshot-failed-unknown-model');
    expect(await store(snap).last_call(recordedThread(snap))).toStrictEqual(new LastCall(null, null));
  });

  test('the effort a run used is its model selections effort', async () => {
    const done = recording('ws-subscribeThread-snapshot-completed');
    const failed = recording('ws-subscribeThread-snapshot-failed-unknown-model');   // sent with no effort
    const s = store(done, failed);
    expect(await s.run_effort(recordedThread(done), value(done).projection.runs[0].id)).toBe('low');
    expect(await s.run_effort(recordedThread(failed), value(failed).projection.runs[0].id)).toBeNull();
  });

  test('auto resume warns only when t3s setting is on', async () => {
    const snap = recording('ws-subscribeServerConfig-snapshot');   // trimmed to its providers
    const on = withValue(snap, (v) => ({ ...v, config: { ...v.config, settings: { autoResumeLimitedThreads: true } } }));
    const off = withValue(snap, (v) => ({ ...v, config: { ...v.config, settings: { autoResumeLimitedThreads: false } } }));
    const ws = new RecordedT3().answerWs('subscribeServerConfig', on, off, snap).ws;
    expect(await auto_resume_warning(ws)).toContain('autoResumeLimitedThreads');
    expect(await auto_resume_warning(ws)).toBeNull();
    expect(await auto_resume_warning(ws)).toBeNull();
  });
});
