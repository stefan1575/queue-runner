"""Running unattended (ticket 10): wake tasks against a fake scheduler, the schtasks adapter on
canned calls, the wall-clock sleep, one runner at a time, waiting for T3 at logon, and --stop."""
import datetime
import io
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET

from queue_runner.cli import main
from queue_runner.lock import runner_lock
from queue_runner.run import wall_sleep
from queue_runner.t3 import T3Error
from queue_runner.usage import Usage, Window
from queue_runner.wake import FOLDER, Schtasks, Waker, task_name, task_xml, wake_at
from tests.fakes import (FakeGitHubWithPulls, FakeLimits, FakeScheduler, FakeToaster, FakeUsage,
                         issue)
from tests.fakes_t3 import FakeGit, FakeSol, FakeT3

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 10, 12, 0, 20, tzinfo=UTC)
NS = '{http://schemas.microsoft.com/windows/2004/02/mit/task}'


class Done(Exception):
    pass


class WakerTest(unittest.TestCase):
    def setUp(self):
        self.said = []
        self.sched = FakeScheduler()
        self.now = NOW
        self.waker = Waker(self.sched, self.said.append, now=lambda: self.now)

    def test_a_time_ahead_gets_one_task_named_as_the_runners_at_the_minute_after(self):
        at = NOW + datetime.timedelta(hours=2, seconds=10)
        self.waker.sync([at])
        [(name, when)] = self.sched.tasks.items()
        self.assertTrue(name.startswith(FOLDER + 'wake '))
        self.assertEqual(when, wake_at(at))
        self.assertGreaterEqual(when, at)
        self.assertEqual(when.second, 0)
        self.assertIn('Wake task set', self.said[0])

    def test_syncing_again_changes_nothing(self):
        at = NOW + datetime.timedelta(hours=2)
        self.waker.sync([at])
        self.waker.sync([at])
        self.assertEqual(len(self.sched.calls), 1)

    def test_a_used_task_and_one_nothing_waits_for_are_removed(self):
        first = NOW + datetime.timedelta(minutes=5)
        second = NOW + datetime.timedelta(hours=3)
        self.waker.sync([first, second])
        self.assertEqual(len(self.sched.tasks), 2)
        self.now = first + datetime.timedelta(minutes=1)   # the first one fired
        self.waker.sync([second])
        self.assertEqual(set(self.sched.tasks), {task_name(wake_at(second))})
        self.waker.sync([])                                # nothing waits any more
        self.assertEqual(self.sched.tasks, {})
        self.assertEqual([c for c, _ in self.sched.calls], ['create', 'create', 'delete', 'delete'])

    def test_a_time_too_close_or_past_gets_no_task(self):
        self.waker.sync([NOW + datetime.timedelta(seconds=30), NOW - datetime.timedelta(hours=1),
                         None])
        self.assertEqual(self.sched.tasks, {})

    def test_a_task_left_by_an_earlier_runner_is_removed(self):
        self.sched.tasks[FOLDER + 'wake 2026-11-09 0300'] = NOW - datetime.timedelta(days=1)
        self.waker.sync([])
        self.assertEqual(self.sched.tasks, {})

    def test_a_scheduler_error_is_said_once_and_doesnt_raise(self):
        self.sched.fail = 'Access is denied.'
        self.waker.sync([NOW + datetime.timedelta(hours=1)])
        self.waker.sync([NOW + datetime.timedelta(hours=1)])
        self.assertEqual(len(self.said), 1)
        self.assertIn('Access is denied', self.said[0])


class TaskXmlTest(unittest.TestCase):
    def test_one_off_wake_to_run_and_deleted_once_expired(self):
        at = datetime.datetime(2026, 11, 10, 14, 5, tzinfo=UTC)
        root = ET.fromstring(task_xml(at, r'C:\py\pythonw.exe', '-I -c "x<y"')
                             .replace('encoding="UTF-16"', ''))
        [trigger] = list(root.find(NS + 'Triggers'))
        self.assertEqual(trigger.tag, NS + 'TimeTrigger')   # no repetition: once
        self.assertIsNone(trigger.find(NS + 'Repetition'))
        start = datetime.datetime.fromisoformat(trigger.find(NS + 'StartBoundary').text)
        self.assertEqual(start, at)
        settings = root.find(NS + 'Settings')
        self.assertEqual(settings.find(NS + 'WakeToRun').text, 'true')
        self.assertEqual(settings.find(NS + 'DeleteExpiredTaskAfter').text, 'PT0S')
        self.assertEqual(settings.find(NS + 'DisallowStartIfOnBatteries').text, 'false')
        exec_ = root.find(NS + 'Actions').find(NS + 'Exec')
        self.assertEqual(exec_.find(NS + 'Arguments').text, '-I -c "x<y"')


class SchtasksTest(unittest.TestCase):
    def setUp(self):
        self.calls, self.xml = [], []

    def fake(self, out='', code=0):
        def run(args):
            self.calls.append(args)
            if '/xml' in args:
                with open(args[args.index('/xml') + 1], encoding='utf-16') as f:
                    self.xml.append(f.read())
            return code, out, 'ERROR: denied' if code else ''
        return run

    def test_names_are_only_the_runners_wake_tasks(self):
        out = ('"\\Queue runner\\wake 2026-11-10 1405","11/10/2026 2:05:00 PM","Ready"\n'
               '"\\T3 Code wake","11/11/2026 9:00:00 AM","Ready"\n'
               '"\\Queue runner\\other","N/A","Ready"\n')
        s = Schtasks(run=self.fake(out))
        self.assertEqual(s.names(), {'\\Queue runner\\wake 2026-11-10 1405'})

    def test_create_registers_the_xml_and_removes_its_file(self):
        s = Schtasks(run=self.fake(), action=lambda: ('pythonw.exe', '-I -c "pass"'))
        at = datetime.datetime(2026, 11, 10, 14, 5, tzinfo=UTC)
        s.create(task_name(at), at)
        [args] = self.calls
        self.assertEqual(args[:3], ['/create', '/tn', task_name(at)])
        self.assertIn('/f', args)
        self.assertIn('<WakeToRun>true</WakeToRun>', self.xml[0])
        self.assertFalse(os.path.exists(args[args.index('/xml') + 1]))

    def test_delete_and_a_failure(self):
        Schtasks(run=self.fake()).delete('\\Queue runner\\wake x')
        self.assertEqual(self.calls[0], ['/delete', '/tn', '\\Queue runner\\wake x', '/f'])
        from queue_runner.wake import WakeError
        with self.assertRaisesRegex(WakeError, 'denied'):
            Schtasks(run=self.fake(code=1)).delete('x')


class WallSleepTest(unittest.TestCase):
    def test_sleeps_in_steps_until_the_wall_clock_says_so(self):
        t = [0.0]
        slept = []

        def sleep(s):
            slept.append(s)
            t[0] += s
        wall_sleep(100, sleep=sleep, clock=lambda: t[0], step=30)
        self.assertEqual(slept, [30, 30, 30, 10])

    def test_a_pc_that_slept_through_it_stops_at_once(self):
        t = [0.0]
        slept = []

        def sleep(s):
            slept.append(s)
            t[0] += 3600   # the PC slept an hour during this step
        wall_sleep(300, sleep=sleep, clock=lambda: t[0], step=30)
        self.assertEqual(slept, [30])


class UnattendedTest(unittest.TestCase):
    """The runner's continuous mode through `main`, with fakes everywhere."""

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
        self.now = NOW
        self.sched = FakeScheduler()

    def run_main(self, args, t3=None, sleep=None, usage=None, waker=None, kill=None):
        out = io.StringIO()
        gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.')],
                                 pulls_by_branch={'claude/red-widget-4': {
                                     'number': 12, 'url': 'https://github.com/owner/first/pull/12',
                                     'state': 'open'}})
        self.t3 = t3 or FakeT3([(0, 'completed')])
        extra = {'kill': kill} if kill else {}
        code = main(args + ['--config', self.config], github=gh, out=out, t3=self.t3,
                    git=FakeGit(), sleep=sleep or (lambda s: None), sol=FakeSol(),
                    toaster=FakeToaster(), usage=usage or FakeUsage(), clock=lambda: self.now,
                    limits=FakeLimits(), t3_settings=os.path.join(self.dir, 't3.json'),
                    waker=waker or Waker(self.sched, lambda line: None, now=lambda: self.now),
                    **extra)
        return code, out.getvalue()

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()

    def test_a_second_start_exits_at_once_and_the_log_says_so(self):
        with runner_lock(os.path.join(self.dir, 'state')):
            code, out = self.run_main([], sleep=lambda s: self.fail('it waited'))
        self.assertEqual(code, 3)
        self.assertIn('already running', out)
        self.assertIn('a second runner started', self.runner_log())
        self.assertIn('exited at once', self.runner_log())

    def test_a_gated_wait_sets_a_wake_task_and_its_removed_once_the_job_starts(self):
        reset = NOW + datetime.timedelta(hours=2)
        seen = []

        def sleep(s):
            seen.append(dict(self.sched.tasks))
            self.now = reset + datetime.timedelta(minutes=5)
            if len(seen) == 2:
                raise Done
        gated = Usage(Window(80, reset), Window(20, NOW + datetime.timedelta(days=3)))
        fits = Usage(Window(0, None), Window(20, NOW + datetime.timedelta(days=3)))
        with self.assertRaises(Done):
            self.run_main([], sleep=sleep, usage=FakeUsage(gated, fits))
        [(name, when)] = seen[0].items()
        self.assertGreaterEqual(when, reset)   # the gate opens 2 minutes after the reset
        self.assertEqual(len(self.t3.starts), 1)
        self.assertEqual(seen[1], {})
        self.assertIn(('delete', name), self.sched.calls)

    def test_it_waits_for_t3s_server_at_logon_without_starting_anything(self):
        class LateT3(FakeT3):
            def __init__(self):
                super().__init__([(0, 'completed')])
                self.down = 2

            def list(self, project):
                if self.down:
                    self.down -= 1
                    raise T3Error('t3 thread list failed (1): connect ECONNREFUSED 127.0.0.1:3773')
                return super().list(project)
        t3 = LateT3()
        slept = []

        def sleep(s):
            slept.append((s, len(t3.starts)))
            if t3.down == 0 and t3.starts:
                raise Done
        with self.assertRaises(Done):
            self.run_main([], t3=t3, sleep=sleep)
        self.assertEqual(slept[:2], [(30, 0), (30, 0)])   # no job while T3 was down
        log = self.runner_log()
        self.assertEqual(log.count("Waiting for T3's server"), 1)
        self.assertIn("T3's server is up", log)
        self.assertEqual(len(t3.starts), 1)

    def test_stop_kills_the_runner_named_in_runner_pid(self):
        killed = []
        state = os.path.join(self.dir, 'state')
        with runner_lock(state):
            with open(os.path.join(state, 'runner.pid'), 'w') as f:
                f.write('4242')
            code, out = self.run_main(['--stop'], kill=lambda pid: (killed.append(pid), (0, ''))[1])
        self.assertEqual((code, killed), (0, [4242]))
        self.assertIn('runner stopped by --stop (pid 4242)', self.runner_log())

    def test_stop_with_no_runner_says_so(self):
        code, out = self.run_main(['--stop'], kill=lambda pid: self.fail('nothing to kill'))
        self.assertEqual(code, 1)
        self.assertIn('No queue runner is running', out)


if __name__ == '__main__':
    unittest.main()
