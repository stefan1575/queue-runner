"""The T3 adapter, on output captured from the real `t3` CLI (tests/fixtures/t3/)."""
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


class StartTest(unittest.TestCase):
    def test_a_completed_run(self):
        run = Recorder(0, fixture('start-completed.json'))
        result = T3Cli(run).start('C:/repo', 'Do it.', title='A job')
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.thread_id, 'mcp:1da61c38-a98c-49b4-9551-e4cb995ca158')
        self.assertEqual(result.status, 'completed')
        self.assertIn('Red or blue?', result.reply)
        self.assertIsNone(result.error)

    def test_sends_the_message_on_stdin_and_waits_in_a_worktree(self):
        run = Recorder(0, fixture('start-completed.json'))
        T3Cli(run).start('C:/repo', 'Line one\nLine two', title='A job', provider='claudeAgent',
                         model='claude-opus-5-5', worktree='origin/main', branch='claude/x-4')
        args, stdin = run.calls[0]
        self.assertEqual(args, ['thread', 'start', '--wait', '--json', '--title', 'A job',
                                '--provider', 'claudeAgent', '--model', 'claude-opus-5-5',
                                '--worktree', 'origin/main', '--branch', 'claude/x-4',
                                'C:/repo', '-'])
        self.assertEqual(stdin, 'Line one\nLine two')

    def test_a_failed_run_is_exit_1_with_its_thread(self):
        run = Recorder(1, fixture('start-failed.json'),
                       'Thread mcp:0559c96c-0b1d-4312-be2c-b51be21529cf stopped with status interrupted.')
        result = T3Cli(run).start('C:/repo', 'Do it.', title='A job')
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.thread_id, 'mcp:0559c96c-0b1d-4312-be2c-b51be21529cf')
        self.assertEqual(result.status, 'interrupted')
        self.assertIsNone(result.reply)

    def test_a_run_waiting_for_an_answer_is_exit_2(self):
        # Shape from T3's finishRun (status "waiting", no reply, no error); not captured live:
        # T3 offers no AskUserQuestion and full-access threads ask for no approvals.
        out = ('{"threadId":"mcp:abc","runId":"run:thread:mcp%3Aabc:ordinal:1","status":"waiting",'
               '"reply":null,"error":null}')
        result = T3Cli(Recorder(2, out)).start('C:/repo', 'Do it.', title='A job')
        self.assertEqual((result.exit_code, result.status, result.thread_id), (2, 'waiting', 'mcp:abc'))

    def test_t3_failing_before_a_thread_exists_raises(self):
        run = Recorder(1, '', fixture('start-noproject.stderr.txt'))
        with self.assertRaises(T3Error) as caught:
            T3Cli(run).start('C:/nowhere', 'Do it.', title='A job')
        self.assertIn('No T3 Code project matches', str(caught.exception))

    def test_refuses_arguments_cmd_would_mangle(self):
        with self.assertRaises(ValueError):
            T3Cli(Recorder()).start('C:/repo', 'Do it.', title='Tom & Jerry')


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


if __name__ == '__main__':
    unittest.main()
