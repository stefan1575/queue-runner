"""The Sol adapter: one review through ~/Code/tools/codex-sol/codex-sol.sh, its reply, a failed run, Sol out of usage."""
import datetime
import os
import tempfile
import unittest

from queue_runner.ledger import SolFailed
from queue_runner.sol import LimitWindow, SolCli, SolOutOfUsage, latest_limits, usage_back


class FakeRun:
    """Plays codex-sol.sh: writes the reply and the logs it would, returns its exit code."""

    def __init__(self, code=0, reply='Review.', log='', out=''):
        self.code, self.reply, self.log, self.out = code, reply, log, out
        self.calls = []

    def __call__(self, cmd, out_path, timeout):
        self.calls.append((cmd, out_path, timeout))
        reply_path = cmd[-2]
        if self.reply is not None:
            with open(reply_path, 'w', encoding='utf-8') as f:
                f.write(self.reply)
        with open(reply_path + '.log', 'w', encoding='utf-8') as f:
            f.write(self.log)
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(self.out)
        return self.code


class SolCliTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        with open(os.path.join(self.dir, 'brief.md'), 'w', encoding='utf-8') as f:
            f.write('# Review')

    def review(self, run):
        sol = SolCli(script='C:/Users/me/codex-sol.sh', bash='C:/Git/bin/bash.exe', run=run,
                     now=lambda: datetime.datetime(2026, 11, 9, 8, 0),
                     sessions=os.path.join(self.dir, 'no-sessions'))
        return sol.review(os.path.join(self.dir, 'brief.md'), os.path.join(self.dir, 'reply.md'),
                          'C:\\wt\\pr7', os.path.join(self.dir, 'run.out'))

    def test_runs_a_review_job_at_effort_high_and_returns_the_reply(self):
        run = FakeRun(reply='  The review.\n')
        self.assertEqual(self.review(run), 'The review.')
        [(cmd, out, timeout)] = run.calls
        self.assertEqual(cmd[:2], ['C:/Git/bin/bash.exe', '-c'])
        self.assertEqual(cmd[3:8], ['C:/Users/me/codex-sol.sh', '--job', 'review', '--effort',
                                    'high'])
        self.assertEqual(cmd[-1], 'C:/wt/pr7')
        self.assertTrue(out.endswith('run.out'))
        self.assertEqual(timeout, 75 * 60)

    def test_a_review_may_write_in_its_checkout_and_the_folders_it_names(self):
        """Tests need to write (vitest's node_modules/.vite-temp, a test Sol adds), so the
        checkout is writable, and the dependency cache behind its node_modules too."""
        run = FakeRun()
        sol = SolCli(script='C:/Users/me/codex-sol.sh', bash='C:/Git/bin/bash.exe', run=run,
                     sessions=os.path.join(self.dir, 'no-sessions'))
        sol.review(os.path.join(self.dir, 'brief.md'), os.path.join(self.dir, 'reply.md'),
                   r'C:\wt\pr7', os.path.join(self.dir, 'run.out'),
                   writable=[r'C:\Users\me\.queue-runner\deps'])
        [(cmd, _, _)] = run.calls
        self.assertEqual(cmd[8:11], ['--write', '--writable-root',
                                     'C:/Users/me/.queue-runner/deps'])
        self.assertEqual(cmd[-1], 'C:/wt/pr7')

    def test_a_failed_run_is_a_failed_review(self):
        with self.assertRaises(SolFailed) as e:
            self.review(FakeRun(code=1, reply=None, out='codex-sol: no reply (codex exit 1)\n'))
        self.assertIn('codex-sol exit 1', str(e.exception))
        with self.assertRaises(SolFailed):   # a reply from a failed run may be partial
            self.review(FakeRun(code=2, reply='Half a review'))
        with self.assertRaises(SolFailed):
            self.review(FakeRun(code=0, reply='   '))

    def test_out_of_usage_says_when_sol_is_back(self):
        log = "ERROR: You've hit your usage limit. Upgrade or try again at 8:55 AM.\n"
        with self.assertRaises(SolOutOfUsage) as e:
            self.review(FakeRun(code=1, reply=None, log=log))
        self.assertEqual(e.exception.back, datetime.datetime(2026, 11, 9, 8, 55))

    def test_out_of_usage_reads_the_reset_from_the_runs_own_rollout(self):
        import json
        sid = '01a1c120-8a26-7050-a9a0-d72e3a7ef6b5'
        day = os.path.join(self.dir, 'sessions', '2026', '11', '09')
        os.makedirs(day)
        reset = int(datetime.datetime(2026, 11, 9, 13, 20).timestamp())
        records = [{'payload': {'rate_limits': {'primary': {'used_percent': 40.0,
                                                            'resets_at': 1}}}},
                   {'payload': {'rate_limits': {
                       'primary': {'used_percent': 100.0, 'resets_at': reset},
                       'secondary': {'used_percent': 61.0, 'resets_at': reset + 9999}}}}]
        with open(os.path.join(day, f'rollout-2026-11-09T08-00-00-{sid}.jsonl'), 'w') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in records))
        log = (f"session id: {sid}\n--------\n"
               "ERROR: You've hit your usage limit. Upgrade or try again at 8:55 AM.\n")
        sol = SolCli(script='s.sh', bash='bash.exe', run=FakeRun(code=1, reply=None, log=log),
                     now=lambda: datetime.datetime(2026, 11, 9, 8, 0),
                     sessions=os.path.join(self.dir, 'sessions'))
        with self.assertRaises(SolOutOfUsage) as e:
            sol.review(os.path.join(self.dir, 'brief.md'), os.path.join(self.dir, 'reply.md'),
                       'C:/wt', os.path.join(self.dir, 'run.out'))
        self.assertEqual(e.exception.back, datetime.datetime(2026, 11, 9, 13, 20))

    def test_a_run_past_its_time_is_stopped_and_failed(self):
        def run(cmd, out_path, timeout):
            raise TimeoutError
        with self.assertRaises(SolFailed) as e:
            self.review(run)
        self.assertIn('75 minutes', str(e.exception))


class LatestLimitsTest(unittest.TestCase):
    """ChatGPT's plan windows for the dashboard: the newest `rate_limits` any Codex session wrote
    (the plan is the account's, so Stefan's own sessions count as Sol's do)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sessions = os.path.join(tmp.name, 'sessions')

    def rollout(self, day, name, records, mtime):
        import json
        folder = os.path.join(self.sessions, '2026', '11', day)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f'rollout-{name}.jsonl')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in records))
        os.utime(path, (mtime, mtime))

    @staticmethod
    def limits(at, primary, secondary, plan='plus'):
        return {'timestamp': at, 'type': 'event_msg', 'payload': {'type': 'token_count', 'rate_limits': {
            'limit_id': 'codex', 'primary': primary, 'secondary': secondary, 'plan_type': plan}}}

    def test_the_newest_record_with_windows_in_the_newest_session(self):
        reset = int(datetime.datetime(2026, 11, 15, 22, 0, tzinfo=datetime.timezone.utc).timestamp())
        self.rollout('14', 'old', [self.limits('2026-11-14T09:00:00Z', {'used_percent': 5.0, 'window_minutes': 300, 'resets_at': 1}, None)], 1000)
        self.rollout('15', 'new', [
            self.limits('2026-11-15T11:30:00Z', {'used_percent': 88.0, 'window_minutes': 300, 'resets_at': reset},
                        {'used_percent': 21.0, 'window_minutes': 10080, 'resets_at': reset + 600}),
            self.limits('2026-11-15T11:38:00Z', {'used_percent': 93.0, 'window_minutes': 300, 'resets_at': reset},
                        {'used_percent': 22.0, 'window_minutes': 10080, 'resets_at': reset + 600}),
            # a premium limit's record names no windows: it isn't the plan's usage
            self.limits('2026-11-15T11:42:00Z', None, None, plan=None),
        ], 2000)
        at, limits = latest_limits(self.sessions)
        self.assertEqual(at, datetime.datetime(2026, 11, 15, 11, 38, tzinfo=datetime.timezone.utc))
        self.assertEqual(limits.plan, 'plus')
        self.assertEqual(limits.windows, (
            LimitWindow(300, 93.0, datetime.datetime.fromtimestamp(reset, datetime.timezone.utc)),
            LimitWindow(10080, 22.0, datetime.datetime.fromtimestamp(reset + 600, datetime.timezone.utc))))

    def test_the_newest_reading_by_its_own_time_across_rollouts_not_the_newest_file(self):
        # Review 1's F7: a file touched last may hold an older reading than another file.
        self.rollout('15', 'newer-file-old-reading', [self.limits(
            '2026-11-15T10:00:00Z', {'used_percent': 10, 'window_minutes': 300}, None)], 2000)
        self.rollout('15', 'older-file-latest-reading', [self.limits(
            '2026-11-15T11:00:00Z', {'used_percent': 99, 'window_minutes': 300}, None)], 1000)
        at, usage = latest_limits(self.sessions)
        self.assertEqual(at, datetime.datetime(2026, 11, 15, 11, tzinfo=datetime.timezone.utc))
        self.assertEqual(usage.windows[0].used, 99)

    def test_no_session_with_windows_is_an_error_that_says_so(self):
        self.rollout('15', 'bare', [self.limits('2026-11-15T11:42:00Z', None, None)], 2000)
        with self.assertRaises(LookupError) as e:
            latest_limits(self.sessions)
        self.assertIn('No Codex session', str(e.exception))


class UsageBackTest(unittest.TestCase):
    now = datetime.datetime(2026, 11, 9, 20, 0)

    def test_a_time_today_or_tomorrow(self):
        self.assertEqual(usage_back('try again at 9:30 PM', self.now),
                         datetime.datetime(2026, 11, 9, 21, 30))
        self.assertEqual(usage_back('try again at 7:05 AM', self.now),
                         datetime.datetime(2026, 11, 10, 7, 5))

    def test_a_date_and_time(self):
        self.assertEqual(usage_back('try again at Nov 12th, 2026 12:01 AM', self.now),
                         datetime.datetime(2026, 11, 12, 0, 1))

    def test_no_time(self):
        self.assertIsNone(usage_back('hit your usage limit', self.now))


if __name__ == '__main__':
    unittest.main()
