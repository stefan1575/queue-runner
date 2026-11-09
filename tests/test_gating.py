"""The usage gate in the run loop and Stefan's knob, through the command line, with a fixed clock
and fake usage."""
import datetime
import io
import json
import os
import tempfile
import unittest

from queue_runner.cli import main
from queue_runner.state import JobLog
from queue_runner.usage import Usage, UsageError, Window
from tests.fakes import FakeGitHubWithPulls, FakeToaster, FakeUsage, issue
from tests.fakes_t3 import FakeGit, FakeSol, FakeT3

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
FIVE_RESET = NOW + datetime.timedelta(hours=2)
WEEK_RESET = NOW + datetime.timedelta(days=3)
PR = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}


def usage(five, week):
    return Usage(Window(five, FIVE_RESET), Window(week, WEEK_RESET))


class GatingTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name.replace('\\', '/')
        self.config = os.path.join(self.dir, 'config.toml')
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(f'''
state_dir = "{self.dir}/state"
log_dir = "{self.dir}/logs"
poll_seconds = 300

[[repos]]
name = "first"
github = "owner/first"
path = "{self.dir}"
''')
        self.log = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))

    def run_main(self, args, usage_reader, t3=None, sleep=None):
        out = io.StringIO()
        gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.')],
                                 pulls_by_branch={'claude/red-widget-4': PR})
        self.t3 = t3 or FakeT3([(0, 'completed')])
        code = main(args + ['--config', self.config], github=gh, out=out, t3=self.t3,
                    git=FakeGit(), sleep=sleep or (lambda s: None), sol=FakeSol(),
                    toaster=FakeToaster(), usage=usage_reader, clock=lambda: NOW)
        return code, out.getvalue()

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()

    def usage_records(self):
        with open(os.path.join(self.dir, 'state', 'usage.jsonl'), encoding='utf-8') as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_a_build_that_wont_fit_the_five_hour_window_waits_and_says_until_when(self):
        self.run_main(['--once'], FakeUsage(usage(80, 20)))
        self.assertEqual(self.t3.starts, [])
        self.assertEqual(self.log.jobs(), [])
        log = self.runner_log()
        self.assertIn('Claude lane waits', log)
        self.assertIn('80%', log)
        self.assertIn(FIVE_RESET.astimezone().isoformat(timespec='minutes'), log)

    def test_a_build_that_fits_starts_and_records_usage_before_and_after(self):
        self.run_main(['--once'], FakeUsage(usage(10, 20), usage(35, 24)))
        [start] = self.t3.starts
        [job] = self.log.jobs()
        [rec] = self.usage_records()
        self.assertEqual((rec['kind'], rec['jobs']), ('build', [job.id]))
        self.assertEqual(rec['before']['five_hour']['used'], 10)
        self.assertEqual(rec['spent'], {'five_hour': 25, 'seven_day': 4})

    def test_unreadable_usage_starts_nothing_and_says_why(self):
        self.run_main(['--once'], FakeUsage(UsageError('the usage endpoint answered HTTP 401')))
        self.assertEqual(self.t3.starts, [])
        self.assertIn('HTTP 401', self.runner_log())

    def test_pause_and_resume_work_between_passes(self):
        code, out = self.run_main(['--pause'], FakeUsage())
        self.assertEqual(code, 0)
        self.assertIn('Paused', out)
        self.run_main(['--once'], FakeUsage(usage(0, 0)))
        self.assertEqual(self.t3.starts, [])
        self.assertIn('paused by Stefan', self.runner_log())
        self.run_main(['--resume'], FakeUsage())
        self.run_main(['--once'], FakeUsage(usage(0, 0)))
        self.assertEqual(len(self.t3.starts), 1)

    def test_a_changed_reserve_holds_the_week_back(self):
        code, out = self.run_main(['--reserve', '30'], FakeUsage())
        self.assertEqual(code, 0)
        self.assertIn('30%', out)
        self.run_main(['--once'], FakeUsage(usage(0, 60)))
        self.assertEqual(self.t3.starts, [])
        self.assertIn('weekly reserve holds', self.runner_log())
        self.assertEqual(self.run_main(['--reserve', '150'], FakeUsage())[0], 2)

    def test_the_continuous_mode_sleeps_no_longer_than_until_the_reset(self):
        soon = Usage(Window(80, NOW + datetime.timedelta(seconds=30)), Window(20, WEEK_RESET))
        slept = []

        class Done(Exception):
            pass

        def sleep(s):
            slept.append(s)
            raise Done
        with self.assertRaises(Done):
            self.run_main([], FakeUsage(soon), sleep=sleep)
        self.assertLess(slept[0], 300)

    def test_gate_prints_the_windows_and_each_kind(self):
        code, out = self.run_main(['--gate'], FakeUsage(usage(80, 20)))
        self.assertEqual(code, 0)
        self.assertIn('5 hours: 80%', out)
        for kind in ('build', 'fix', 'decision'):
            self.assertIn(f'{kind}:', out)


if __name__ == '__main__':
    unittest.main()
