"""Refresh on the Usage card (ticket 42): the page asks through control.json's `usage`, the
runner's publisher reads both plans on its next tick (no more than once a minute) and says in the
snapshot which request it acted on. Usage is played by fakes: nothing calls Anthropic or OpenAI."""
import datetime
import json
import os
import tempfile
import unittest

from dashboard import sample
from dashboard.serve import App, Refused, apply_control
from queue_runner import control, snapshot
from queue_runner.config import Config, Repo
from queue_runner.sol import Limits as SolLimits, LimitWindow as SolWindow
from queue_runner.usage import Usage, UsageError, Window
from tests.fakes import FakeUsage

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 16, 5, 0, tzinfo=UTC)
AT = '2026-11-16T13:00:00+08:00'   # NOW, as the page's server writes it
QR = Repo(name='queue-runner', github='stefan1575/queue-runner', path='C:/qr')


class Clock:
    def __init__(self, t=NOW):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, **kw):
        self.t += datetime.timedelta(**kw)


def iso(t):
    return t.astimezone().isoformat(timespec='seconds')


class ControlTest(unittest.TestCase):
    def test_refresh_is_written_with_its_time_and_kept_by_other_requests(self):
        c = apply_control({}, {'usage': 'refresh'}, AT)
        self.assertEqual((c['usage'], c['written_at']), ({'refresh_at': AT}, AT))
        c = apply_control(c, {'lane': 'claude', 'stop': 'after-job'}, '2026-11-16T13:05:00+08:00')
        self.assertEqual(c['usage'], {'refresh_at': AT})
        c = apply_control(c, {'usage': 'refresh'}, '2026-11-16T13:06:00+08:00')
        self.assertEqual(c['usage'], {'refresh_at': '2026-11-16T13:06:00+08:00'})

    def test_no_refresh_asked_writes_no_usage(self):
        self.assertNotIn('usage', apply_control({}, {'lane': 'sol', 'stop': None}, AT))
        self.assertNotIn('usage', apply_control({'usage': 'junk'}, {'lane': 'sol', 'stop': None}, AT))

    def test_anything_else_under_usage_is_refused(self):
        for body in ({'usage': 'now'}, {'usage': True}, {'usage': 'refresh', 'lane': 'sol'}):
            with self.subTest(body=body), self.assertRaises(Refused):
                apply_control({}, body, AT)

    def test_the_runner_reads_when_it_was_asked(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(control.read(d).refresh_at)
            App(d, clock=lambda: AT).write_control({'usage': 'refresh'})
            self.assertEqual(control.read(d).refresh_at, datetime.datetime.fromisoformat(AT))

    def test_a_usage_entry_the_page_couldnt_have_written_is_ignored_not_unreadable(self):
        with tempfile.TemporaryDirectory() as d:
            for usage in ('x', {'refresh_at': 7}, {'refresh_at': 'not a time'}):
                with open(control.path(d), 'w', encoding='utf-8') as f:
                    json.dump({'version': 1, 'usage': usage}, f)
                switch = control.read(d)
                self.assertEqual((switch.error, switch.refresh_at), (None, None))

    def test_pause_and_resume_keep_the_request(self):
        with tempfile.TemporaryDirectory() as d:
            App(d, clock=lambda: AT).write_control({'usage': 'refresh'})
            control.ask(d, ['claude'], 'after-job', '2026-11-16T13:01:00+08:00')
            self.assertEqual(control.read(d).refresh_at, datetime.datetime.fromisoformat(AT))


class RunnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = os.path.join(tmp.name, 'state')
        os.makedirs(self.state)
        self.config = Config(repos=[QR], state_dir=self.state, log_dir=os.path.join(tmp.name, 'logs'))
        self.clock = Clock()
        self.calls = snapshot.Calls(self.clock)
        self.usage = FakeUsage(Usage(Window(38, None), Window(46, None), resets=2))
        self.sol_reads = 0
        self.snaps = snapshot.Snapshots(
            self.config, calls=self.calls, clock=self.clock, info=snapshot.RunnerInfo(1, NOW, None),
            claude=snapshot.Watch(self.usage.read, self.calls, 'claude_usage', self.clock),
            sol=snapshot.Watch(self.sol, self.calls, 'sol_usage', self.clock, timed=True))

    def sol(self):
        self.sol_reads += 1
        return self.clock(), SolLimits('plus', (SolWindow(300, 9.0, None),), resets=3)

    def ask(self, at=None):
        App(self.state, clock=lambda: iso(at or self.clock())).write_control({'usage': 'refresh'})

    def reads(self):
        return self.usage.count, self.sol_reads

    def test_a_refresh_reads_both_plans_on_the_next_tick_and_says_which_request_it_took(self):
        self.snaps.build(fresh=True)                # the first read, as due
        self.clock.tick(minutes=2)                  # READ_EVERY is far off
        asked = self.clock()
        self.ask()
        self.snaps.build(fresh=False)               # after a pass: nothing read
        self.assertEqual(self.reads(), (1, 1))
        self.clock.tick(seconds=20)
        snap = self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (2, 2))
        self.assertEqual(snap['usage_refresh'], {'asked_at': iso(asked), 'done_at': iso(self.clock())})
        self.assertEqual([p['read_at'] for p in snap['usage']], [iso(self.clock())] * 2)
        self.assertEqual([p['resets'] for p in snap['usage']], [{'available': 2}, {'available': 3}])
        self.clock.tick(seconds=30)
        self.snaps.build(fresh=True)                # the same request isn't read again
        self.assertEqual(self.reads(), (2, 2))

    def test_no_more_than_one_forced_read_a_minute(self):
        self.snaps.build(fresh=True)
        self.clock.tick(minutes=2)
        self.ask()
        self.snaps.build(fresh=True)
        self.clock.tick(seconds=10)
        again = self.clock()
        self.ask()
        snap = self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (2, 2))      # it waits
        self.assertNotEqual(snap['usage_refresh']['asked_at'], iso(again))
        self.clock.tick(seconds=50)
        snap = self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (3, 3))
        self.assertEqual(snap['usage_refresh']['asked_at'], iso(again))

    def test_a_failed_read_is_said_in_the_plan_and_the_request_counts_as_taken(self):
        self.usage.reads = [self.usage.reads[0], UsageError('the usage endpoint answered HTTP 401')]
        first = self.snaps.build(fresh=True)['usage'][0]['read_at']
        self.clock.tick(minutes=2)
        self.ask()
        snap = self.snaps.build(fresh=True)
        claude = snap['usage'][0]
        self.assertEqual((claude['read_at'], claude['error']), (first, 'The usage endpoint answered HTTP 401.'))
        self.assertEqual(snap['usage_refresh']['asked_at'], iso(NOW + datetime.timedelta(minutes=2)))

    def test_a_request_left_from_before_the_runner_started_is_taken_by_its_first_read(self):
        self.ask(NOW - datetime.timedelta(hours=1))
        snap = self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (1, 1))
        self.assertIsNotNone(snap['usage_refresh'])
        self.clock.tick(seconds=30)
        self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (1, 1))

    def test_with_nothing_asked_there_is_no_refresh_to_tell(self):
        self.assertIsNone(self.snaps.build(fresh=True)['usage_refresh'])

    def test_an_unreadable_control_json_refreshes_nothing(self):
        self.snaps.build(fresh=True)
        self.clock.tick(minutes=2)
        with open(control.path(self.state), 'w', encoding='utf-8') as f:
            f.write('{')
        self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (1, 1))


class SampleTest(unittest.TestCase):
    T = datetime.datetime(2026, 11, 16, 13, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))

    def test_the_pretend_runner_reads_both_plans_a_few_seconds_after_refresh_is_asked(self):
        asked = {'written_at': self.T.isoformat(), 'usage': {'refresh_at': self.T.isoformat()}}
        early = sample.build('busy', base=self.T, now=self.T + datetime.timedelta(seconds=1), control=asked)
        self.assertIsNone(early['usage_refresh'])
        later = sample.build('busy', base=self.T, now=self.T + datetime.timedelta(seconds=sample.ACK_SECONDS),
                             control=asked)
        self.assertEqual(later['usage_refresh']['asked_at'], self.T.isoformat())
        for p in later['usage']:
            self.assertGreaterEqual(datetime.datetime.fromisoformat(p['read_at']), self.T)

    def test_one_plan_has_reset_credits_and_one_has_none(self):
        resets = [p['resets'] for p in sample.build('busy')['usage']]
        self.assertEqual(resets, [{'available': 2}, None])


if __name__ == '__main__':
    unittest.main()
