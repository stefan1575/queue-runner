"""Refresh on the Usage card (ticket 42): the page asks through control.json's `usage`, the
runner's publisher takes it on its next tick and says in the snapshot which request it acted on.
Claude's endpoint is asked only when its 5-minute budget allows (issue 66). Usage is played by
stubs: nothing calls Anthropic or OpenAI."""
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
from queue_runner.usage import CachedUsage
from tests.fakes import StubEndpoint

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
    """Claude is read through the gate's own reader (`usage.CachedUsage`) on a stub endpoint, so
    Refresh shares its 5-minute budget (issue 66); ChatGPT is read on every Refresh taken."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = os.path.join(tmp.name, 'state')
        os.makedirs(self.state)
        self.config = Config(repos=[QR], state_dir=self.state, log_dir=os.path.join(tmp.name, 'logs'))
        self.clock = Clock()
        self.calls = snapshot.Calls(self.clock)
        self.endpoint = StubEndpoint(self.clock)
        self.claude = CachedUsage(self.endpoint.oauth(tmp.name), self.clock,
                                  on_call=lambda ok, note: self.calls.record('claude_usage', ok, note))
        self.sol_reads = 0
        self.snaps = snapshot.Snapshots(
            self.config, calls=self.calls, clock=self.clock, info=snapshot.RunnerInfo(1, NOW, None),
            claude=self.claude,
            sol=snapshot.Watch(self.sol, self.calls, 'sol_usage', self.clock, timed=True))

    def sol(self):
        self.sol_reads += 1
        return self.clock(), SolLimits('plus', (SolWindow(300, 9.0, None),), resets=3)

    def ask(self, at=None):
        App(self.state, clock=lambda: iso(at or self.clock())).write_control({'usage': 'refresh'})

    def reads(self):
        return len(self.endpoint.calls), self.sol_reads

    def test_a_refresh_inside_claudes_budget_is_taken_and_gives_back_its_reading(self):
        first = self.clock()
        self.snaps.build(fresh=True)                # the first read, as due
        self.clock.tick(minutes=2)
        asked = self.clock()
        self.ask()
        self.snaps.build(fresh=False)               # after a pass: nothing read
        self.assertEqual(self.reads(), (1, 1))
        self.clock.tick(seconds=20)
        snap = self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (1, 2))      # ChatGPT read, Claude's endpoint not asked
        self.assertEqual(snap['usage_refresh'], {'asked_at': iso(asked), 'done_at': iso(self.clock())})
        claude, sol = snap['usage']
        self.assertEqual((claude['read_at'], claude['error'], claude['next_read_at']),
                         (iso(first), None, iso(first + datetime.timedelta(minutes=5))))
        self.assertEqual((sol['read_at'], sol['next_read_at']), (iso(self.clock()), None))
        self.assertEqual([p['resets'] for p in snap['usage']], [None, {'available': 3}])
        self.clock.tick(seconds=30)
        self.snaps.build(fresh=True)                # the same request isn't taken again
        self.assertEqual(self.reads(), (1, 2))

    def test_a_refresh_outside_claudes_budget_reads_it_as_now(self):
        self.endpoint.limit = 0
        self.claude.every = datetime.timedelta(minutes=1)   # a budget shorter than READ_EVERY
        self.snaps.build(fresh=True)
        self.clock.tick(minutes=2)
        self.ask()
        snap = self.snaps.build(fresh=True)
        self.assertEqual(self.reads(), (2, 2))
        self.assertEqual(snap['usage'][0]['read_at'], iso(self.clock()))

    def test_each_refresh_is_taken_and_none_asks_claude_inside_its_budget(self):
        self.snaps.build(fresh=True)
        for _ in range(3):
            self.clock.tick(seconds=40)
            again = self.clock()
            self.ask()
            snap = self.snaps.build(fresh=True)
            self.assertEqual(snap['usage_refresh']['asked_at'], iso(again))
        self.assertEqual(self.reads(), (1, 4))
        self.assertEqual([s for _, s in self.endpoint.calls], [200])

    def test_a_failed_login_is_said_in_the_plan_and_the_request_counts_as_taken(self):
        first = self.snaps.build(fresh=True)['usage'][0]['read_at']
        self.clock.tick(minutes=5)
        self.endpoint.fail = 401
        self.ask()
        snap = self.snaps.build(fresh=True)
        claude = snap['usage'][0]
        # Just failed: reconnecting, not an error yet (the first reads after a wake fail).
        self.assertEqual((claude['read_at'], claude['error'], claude['retrying']),
                         (first, None, iso(self.clock())))
        self.assertEqual(snap['usage_refresh']['asked_at'], iso(NOW + datetime.timedelta(minutes=5)))
        self.clock.tick(minutes=10)   # still failing: now it's said
        claude = self.snaps.build(fresh=True)['usage'][0]
        self.assertEqual((claude['read_at'], claude['error']), (first, 'The usage endpoint answered HTTP 401.'))
        self.assertEqual(snap['usage_refresh']['asked_at'], iso(NOW + datetime.timedelta(minutes=5)))

    def test_a_429_beside_a_recent_reading_is_no_error(self):
        first = self.snaps.build(fresh=True)['usage'][0]['read_at']
        self.clock.tick(minutes=5)
        self.endpoint.fail = 429
        self.ask()
        snap = self.snaps.build(fresh=True)
        claude = snap['usage'][0]
        self.assertEqual((claude['read_at'], claude['error']), (first, None))
        self.assertEqual(claude['next_read_at'], iso(self.clock() + datetime.timedelta(minutes=5)))

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

    def test_the_pretend_runner_takes_a_refresh_a_few_seconds_after_it_is_asked(self):
        asked = {'written_at': self.T.isoformat(), 'usage': {'refresh_at': self.T.isoformat()}}
        early = sample.build('busy', base=self.T, now=self.T + datetime.timedelta(seconds=1), control=asked)
        self.assertIsNone(early['usage_refresh'])
        later = sample.build('busy', base=self.T, now=self.T + datetime.timedelta(seconds=sample.ACK_SECONDS),
                             control=asked)
        self.assertEqual(later['usage_refresh']['asked_at'], self.T.isoformat())
        claude, sol = later['usage']
        self.assertGreaterEqual(datetime.datetime.fromisoformat(sol['read_at']), self.T)
        # Claude was read a minute before: inside its 5-minute budget it keeps that reading.
        self.assertLess(datetime.datetime.fromisoformat(claude['read_at']), self.T)
        self.assertGreater(datetime.datetime.fromisoformat(claude['next_read_at']), self.T)

    def test_outside_claudes_budget_the_pretend_runner_reads_it_too(self):
        at = self.T + datetime.timedelta(minutes=6)
        asked = {'written_at': at.isoformat(), 'usage': {'refresh_at': at.isoformat()}}
        snap = sample.build('busy', base=self.T, now=at + datetime.timedelta(seconds=sample.ACK_SECONDS),
                            control=asked)
        claude = snap['usage'][0]
        self.assertGreaterEqual(datetime.datetime.fromisoformat(claude['read_at']), at)
        self.assertEqual(datetime.datetime.fromisoformat(claude['next_read_at']),
                         datetime.datetime.fromisoformat(claude['read_at']) + datetime.timedelta(minutes=5))

    def test_both_plans_have_reset_credits(self):
        # Stefan, 2026-11-18 (#141): the sample's ChatGPT has 2 resets too
        resets = [p['resets'] for p in sample.build('busy')['usage']]
        self.assertEqual(resets, [{'available': 2}, {'available': 2}])


if __name__ == '__main__':
    unittest.main()
