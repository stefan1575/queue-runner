"""The T3 adapter: the `t3` CLI on output captured from it (tests/fixtures/t3/), and the launch
and wait through T3's MCP endpoint (issue #119; docs/t3.md)."""
import os
import unittest

from queue_runner.t3 import T3Cli, T3Error

FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures', 't3')


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


class Recorder:
    """Stands in for the `t3` process: returns canned (exit code, stdout, stderr)."""

    def __init__(self, code=0, stdout='', stderr=''):
        self.result = (code, stdout, stderr)
        self.calls = []

    def __call__(self, args, stdin=None):
        self.calls.append((args, stdin))
        return self.result


class FakeMcp:
    """T3's MCP endpoint as `T3Cli.start` and `launch` use it (docs/t3.md): one project at
    C:/repo, a launch that answers a thread and run, waits answered from `waits` in order (a
    timed-out slice is `{'timedOut': True}`), and the run's timeline items."""

    def __init__(self, waits=({'status': 'completed'},), items=(), pending=0,
                 launch_error=None):
        self.calls = []
        self.waits = list(waits)
        self.items = list(items)
        self.pending = pending
        self.launch_error = launch_error

    def call(self, tool, arguments):
        self.calls.append((tool, arguments))
        if tool == 't3_project_list':
            return {'projects': [{'id': 'proj-other', 'workspaceRoot': 'C:\\elsewhere'},
                                 {'id': 'proj-1', 'workspaceRoot': 'C:\\repo'}],
                    'nextCursor': None}
        if tool == 't3_thread_launch':
            if self.launch_error:
                raise self.launch_error
            return {'threadId': 'mcp:t1', 'projectId': arguments['projectId'],
                    'runId': 'run:t1:1', 'status': 'preparing'}
        if tool == 't3_thread_wait':
            got = self.waits.pop(0)
            return {'threadId': 'mcp:t1', 'runId': 'run:t1:1', 'timedOut': False, **got}
        if tool == 't3_thread_read':
            if 'itemId' in arguments:   # the rest of a truncated text
                return {'items': [{'itemId': arguments['itemId'], 'text': ' and the rest.',
                                   'textTruncated': False}], 'thread': {}}
            view = arguments.get('view')
            kinds = {'messages': {'user_message', 'assistant_message'}}.get(view)
            items = [i for i in self.items if kinds is None or i['type'] in kinds]
            return {'thread': {'pendingRequestCount': self.pending},
                    'items': items if view else [], 'hasMore': False, 'nextPosition': None}
        raise AssertionError(tool)

    def tools(self):
        return [c[0] for c in self.calls]

    def launched(self):
        return next(a for t, a in self.calls if t == 't3_thread_launch')


def item(type_, text, run='run:t1:1', **extra):
    return {'itemId': f'i-{type_}-{text[:4]}', 'runId': run, 'type': type_, 'text': text,
            'textTruncated': False, **extra}


CLAUDE = dict(provider='claudeAgent', model='claude-opus-5-5', effort='high')


class StartTest(unittest.TestCase):
    """Jobs start through T3's MCP with their provider, model and effort named (issue #119)."""

    def test_launches_with_the_model_its_effort_and_a_worktree_in_full_access(self):
        mcp = FakeMcp()
        T3Cli(mcp=mcp).start('C:/repo', 'Line one\nLine two', title='A job',
                             worktree='origin/main', branch='claude/x-4', **CLAUDE)
        self.assertEqual(mcp.launched(), {
            'projectId': 'proj-1', 'title': 'A job', 'message': 'Line one\nLine two',
            'runtimeMode': 'full-access',
            'modelSelection': {'instanceId': 'claudeAgent', 'model': 'claude-opus-5-5',
                               'options': [{'id': 'effort', 'value': 'high'}]},
            'workspaceStrategy': {'type': 'worktree', 'baseRef': 'origin/main',
                                  'branch': 'claude/x-4'}})

    def test_with_no_worktree_it_runs_in_the_project_folder(self):
        mcp = FakeMcp()
        T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)
        self.assertNotIn('workspaceStrategy', mcp.launched())

    def test_a_codex_model_gets_its_effort_as_reasoning_effort(self):
        mcp = FakeMcp()
        T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', provider='codex',
                             model='gpt-6.1-sol', effort='high')
        self.assertEqual(mcp.launched()['modelSelection']['options'],
                         [{'id': 'reasoningEffort', 'value': 'high'}])

    def test_a_completed_run_gives_its_last_reply_in_full(self):
        mcp = FakeMcp(items=[item('user_message', 'Do it.'),
                             item('assistant_message', 'An earlier word', run='run:t0:1'),
                             item('assistant_message', 'First'),
                             item('assistant_message', 'Red or blue?', textTruncated=True,
                                  nextTextOffset=12)])
        result = T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)
        self.assertEqual((result.exit_code, result.thread_id, result.run_id, result.status),
                         (0, 'mcp:t1', 'run:t1:1', 'completed'))
        self.assertEqual(result.reply, 'Red or blue? and the rest.')
        self.assertIsNone(result.error)

    def test_it_waits_in_slices_until_the_run_ends(self):
        mcp = FakeMcp(waits=[{'timedOut': True}, {'timedOut': True}, {'status': 'completed'}])
        result = T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)
        self.assertEqual(result.exit_code, 0)
        waits = [a for t, a in mcp.calls if t == 't3_thread_wait']
        self.assertEqual(waits, [{'threadId': 'mcp:t1', 'runId': 'run:t1:1',
                                  'timeoutMs': 15000}] * 3)

    def test_a_failed_run_is_exit_1_with_its_error(self):
        mcp = FakeMcp(waits=[{'status': 'failed'}],
                      items=[item('error', 'You have hit your limit.')])
        result = T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)
        self.assertEqual((result.exit_code, result.status, result.reply, result.error),
                         (1, 'failed', None, 'You have hit your limit.'))

    def test_a_run_waiting_for_an_answer_is_exit_2(self):
        mcp = FakeMcp(waits=[{'timedOut': True}, {'timedOut': True}], pending=1)
        result = T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)
        self.assertEqual((result.exit_code, result.status, result.reply, result.error),
                         (2, 'waiting', None, None))
        self.assertEqual([a['timeoutMs'] for t, a in mcp.calls if t == 't3_thread_wait'],
                         [15000, 1])

    def test_a_pending_request_that_just_ended_is_the_runs_end(self):
        mcp = FakeMcp(waits=[{'timedOut': True}, {'status': 'completed'}], pending=1,
                      items=[item('assistant_message', 'Done.')])
        result = T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)
        self.assertEqual((result.exit_code, result.reply), (0, 'Done.'))

    def test_a_folder_with_no_t3_project_raises(self):
        with self.assertRaises(T3Error) as caught:
            T3Cli(mcp=FakeMcp()).start('C:/nowhere', 'Do it.', title='A job', **CLAUDE)
        self.assertIn('No T3 Code project', str(caught.exception))

    def test_a_relative_folder_matches_its_projects_absolute_root(self):
        # config keeps a served repo's path as written ('.'); T3 holds the absolute root
        here = os.getcwd()
        mcp = FakeMcp()
        mcp.call = lambda tool, arguments, _call=mcp.call: (
            {'projects': [{'id': 'proj-here', 'workspaceRoot': here}], 'nextCursor': None}
            if tool == 't3_project_list' else _call(tool, arguments))
        T3Cli(mcp=mcp).launch('.', 'Ask.', title='Decide: x', **CLAUDE)
        self.assertEqual(mcp.launched()['projectId'], 'proj-here')

    def test_a_refused_launch_raises(self):
        mcp = FakeMcp(launch_error=T3Error('t3_thread_launch failed: no'))
        with self.assertRaises(T3Error):
            T3Cli(mcp=mcp).start('C:/repo', 'Do it.', title='A job', **CLAUDE)

    def test_with_no_mcp_client_it_raises(self):
        with self.assertRaises(T3Error):
            T3Cli().start('C:/repo', 'Do it.', title='A job', **CLAUDE)

    def test_launch_returns_at_once_with_its_thread(self):
        mcp = FakeMcp()
        launched = T3Cli(mcp=mcp).launch('C:/repo', 'Ask.', title='Decide: x', **CLAUDE)
        self.assertEqual((launched.thread_id, launched.run_id), ('mcp:t1', 'run:t1:1'))
        self.assertEqual(mcp.tools(), ['t3_project_list', 't3_thread_launch'])
        self.assertEqual(mcp.launched()['modelSelection']['options'],
                         [{'id': 'effort', 'value': 'high'}])
        self.assertEqual(mcp.launched()['runtimeMode'], 'full-access')


class ShowAndListTest(unittest.TestCase):
    def test_show_gives_the_thread_and_its_latest_messages(self):
        run = Recorder(0, fixture('thread-show-interrupted.json'))
        thread, messages = T3Cli(run).show('mcp:0559c96c-0b1d-4312-be2c-b51be21529cf', messages=2)
        self.assertEqual(run.calls[0][0], ['thread', 'show', '--messages', '2', '--json',
                                           'mcp:0559c96c-0b1d-4312-be2c-b51be21529cf'])
        self.assertEqual(thread.status, 'interrupted')
        self.assertEqual(thread.title, 'Queue runner fixture: failed run')
        self.assertTrue(thread.link.startswith('https://app.t3.codes/threads/'))
        self.assertFalse(thread.active)
        self.assertIsNone(thread.worktree_path)
        self.assertEqual(thread.pending_requests, 0)
        self.assertTrue(all(m.role in ('user', 'assistant') for m in messages))

    def test_list_gives_a_projects_threads(self):
        run = Recorder(0, fixture('thread-list.json'))
        threads = T3Cli(run).list('C:/Users/Anon/Code/Personal/personal-ops')
        self.assertEqual(run.calls[0][0], ['thread', 'list', '--json', '--project',
                                           'C:/Users/Anon/Code/Personal/personal-ops'])
        self.assertEqual([t.title for t in threads], ['Queue runner: implement 02',
                                                      'Queue runner: implement 01',
                                                      'Mechanical Timer Without Repeated AI Calls'])
        self.assertTrue(threads[0].active)
        self.assertEqual(threads[0].created_at, '2026-11-06T21:08:06.270Z')
        self.assertTrue(threads[2].settled)

    def test_send_waits_for_the_reply(self):
        run = Recorder(0, fixture('start-completed.json'))
        result = T3Cli(run).send('mcp:1da61c38-a98c-49b4-9551-e4cb995ca158', 'Go on.')
        self.assertEqual(run.calls[0], (['thread', 'send', '--wait', '--json',
                                         'mcp:1da61c38-a98c-49b4-9551-e4cb995ca158', '-'], 'Go on.'))
        self.assertEqual(result.status, 'completed')
        self.assertIn('Red or blue?', result.reply)

    def test_send_with_t3_failing_raises(self):
        run = Recorder(1, '', fixture('start-noproject.stderr.txt'))
        with self.assertRaises(T3Error):
            T3Cli(run).send('mcp:abc', 'Go on.')

    def test_send_waiting_for_an_answer_is_exit_2(self):
        out = ('{"threadId":"mcp:abc","runId":"run:thread:mcp%3Aabc:ordinal:1","status":"waiting",'
               '"reply":null,"error":null}')
        result = T3Cli(Recorder(2, out)).send('mcp:abc', 'Go on.')
        self.assertEqual((result.exit_code, result.status), (2, 'waiting'))


if __name__ == '__main__':
    unittest.main()
