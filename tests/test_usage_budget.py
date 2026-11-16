"""Claude's usage read as T3 Code reads it (issue 66): one cached reading, at most one call to the
endpoint every 5 minutes whoever asks (the gate, its after-job read, the snapshot's read and
Refresh), and a failed call keeps the last good reading.

Wired as the CLI wires them: one `usage.CachedUsage` (`cli._gate`) is the gate's reader and the
snapshot's Claude, around a real `OAuthUsage` on `StubEndpoint`, which answers 429 when it's asked
within a minute of its last call, as the real one does. Refresh is written by the dashboard's own
`App`. Nothing calls Anthropic."""
import datetime
import os
import tempfile
import unittest

from dashboard.serve import App
from queue_runner import cli, snapshot
from queue_runner.config import Config, Repo
from queue_runner.gate import UNREADABLE
from queue_runner.sol import Limits as SolLimits, LimitWindow as SolWindow
from tests.fakes import StubEndpoint

SGT = datetime.timezone(datetime.timedelta(hours=8))
QR = Repo(name='queue-runner', github='stefan1575/queue-runner', path='C:/qr')


class Clock:
    def __init__(self):
        self.t = datetime.datetime(2026, 11, 16, 14, 1, 49, tzinfo=SGT)

    def __call__(self):
        return self.t

    def at(self, h, m, s=0):
        self.t = self.t.replace(hour=h, minute=m, second=s)

    def tick(self, **kw):
        self.t += datetime.timedelta(**kw)


def t(h, m, s=0):
    return datetime.datetime(2026, 11, 16, h, m, s, tzinfo=SGT)


def iso(when):
    return when.astimezone().isoformat(timespec='seconds')


def page(ctl: dict, snap: dict) -> tuple[bool, list]:
    """The Usage card's Refresh as `dashboard/index.html` decides it (`refreshPending`,
    `refreshNotes`): whether the button spins, and the notes it shows, as (bad, plan, read_at,
    next_read_at). A plan's error is the snapshot's alone: no time decides a failure."""
    ms = datetime.datetime.fromisoformat
    asked = (ctl.get('usage') or {}).get('refresh_at')
    done = snap.get('usage_refresh')
    pending = bool(asked) and not (done and ms(done['asked_at']) >= ms(asked))
    if not asked or pending or not done:
        return pending, []
    notes = []
    for p in snap['usage']:
        if p['error']:
            notes.append((True, p['id'], p['error'], None))
        elif p['read_at'] and p['next_read_at'] and ms(p['read_at']) < ms(asked):
            notes.append((False, p['id'], p['read_at'], p['next_read_at']))
    return pending, notes


class Harness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = os.path.join(tmp.name, 'state')
        os.makedirs(self.state)
        self.config = Config(repos=[QR], state_dir=self.state,
                             log_dir=os.path.join(tmp.name, 'logs'))
        self.clock = Clock()
        self.endpoint = StubEndpoint(self.clock)
        self.slept = []
        self.gate = cli._gate(self.config, self.endpoint.oauth(tmp.name), self.clock, self.sleep)
        self.calls = snapshot.Calls(self.clock)
        self.gate.reader.on_call = cli._heard(self.calls)
        self.snaps = snapshot.Snapshots(
            self.config, calls=self.calls, clock=self.clock, claude=self.gate.reader,
            sol=snapshot.Watch(self.sol, self.calls, 'sol_usage', self.clock, timed=True),
            info=snapshot.RunnerInfo(1, self.clock(), None))

    def sleep(self, seconds):   # run.wall_sleep, on the test's clock
        self.slept.append(seconds)
        self.clock.tick(seconds=seconds)

    def sol(self):
        return self.clock(), SolLimits('plus', (SolWindow(300, 9.0, None),))

    def tick(self) -> dict:
        """The publisher's own 30-second write."""
        return self.snaps.build(fresh=True)

    def press_refresh(self):
        App(self.state, clock=lambda: iso(self.clock())).write_control({'usage': 'refresh'})

    def control(self) -> dict:
        import json
        with open(os.path.join(self.state, 'control.json'), encoding='utf-8') as f:
            return json.load(f)

    def job(self, minutes):
        """A Claude job that checks, runs `minutes` and is measured, as `Runner._gated` does."""
        verdict = self.gate.check('fix')
        self.assertTrue(verdict.go, verdict.text)
        self.clock.tick(minutes=minutes)
        self.gate.measured('fix', [], verdict.usage)
        return verdict

    def statuses(self):
        return [s for _, s in self.endpoint.calls]

    @staticmethod
    def claude(snap):
        return snap['usage'][0]

    @staticmethod
    def source(snap):
        return next(s for s in snap['sources'] if s['id'] == 'claude_usage')


class TimelineTest(Harness):
    def test_stefans_refresh_on_2026_11_16(self):
        self.tick()                                    # 14:01:49 the 5-minute read: 200
        self.clock.at(14, 1, 50)
        self.press_refresh()
        self.clock.at(14, 2, 19)
        snap = self.tick()                             # takes the request, asks nothing
        self.clock.at(14, 3, 12)
        verdict = self.gate.check('fix')
        self.assertEqual(self.endpoint.calls, [(t(14, 1, 49), 200)])
        pending, notes = page(self.control(), snap)
        self.assertFalse(pending)                      # the spinner is off after that tick
        self.assertEqual(notes, [(False, 'claude', iso(t(14, 1, 49)), iso(t(14, 6, 49)))])
        claude = self.claude(snap)
        self.assertEqual((claude['read_at'], claude['error']), (iso(t(14, 1, 49)), None))
        self.assertEqual(self.claude(snap)['windows'][0]['used'], 38)
        self.assertTrue(verdict.go, verdict.text)
        self.assertEqual(verdict.usage.five_hour.used, 38)


class BudgetTest(Harness):
    def test_all_four_callers_ask_the_endpoint_at_most_once_every_five_minutes(self):
        end = self.clock() + datetime.timedelta(hours=1)
        step = 0
        while self.clock() < end:
            step += 1
            if step % 2 == 0:
                self.tick()                            # every 30 s
            if step % 5 == 0:
                self.press_refresh()                   # every 75 s
                self.tick()
            if step % 3 == 0:
                self.gate.check('fix')                 # every 45 s
            if step % 13 == 0:
                self.job(minutes=1)                    # a short job, then its after-read
            self.clock.tick(seconds=15)
        self.assertNotIn(429, self.statuses())
        times = [at for at, _ in self.endpoint.calls]
        gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
        self.assertGreaterEqual(min(gaps), 300)
        self.assertGreaterEqual(len(times), 10)        # and it's still read about every 5 minutes
        self.assertTrue(self.slept)                    # some after-reads waited for the budget


class FailedCallTest(Harness):
    def test_a_429_beside_a_recent_reading_taken_after_the_last_job_lets_the_gate_go(self):
        self.tick()
        self.clock.tick(minutes=1)
        self.job(minutes=6)                            # its after-read: a call at +7 min
        after = self.clock()
        self.clock.tick(minutes=5)
        self.endpoint.fail = 429
        self.press_refresh()
        snap = self.tick()                             # the budget allows: a call, 429
        self.assertEqual(self.statuses(), [200, 200, 429])
        verdict = self.gate.check('fix')
        self.assertTrue(verdict.go, verdict.text)
        claude = self.claude(snap)
        self.assertEqual((claude['read_at'], claude['error']), (iso(after), None))
        self.assertTrue(self.source(snap)['ok'])
        self.assertEqual(page(self.control(), snap),
                         (False, [(False, 'claude', iso(after), iso(self.clock() + datetime.timedelta(minutes=5)))]))

    def test_a_reading_past_thirty_minutes_with_failing_calls_holds_the_lane_and_the_card_says_so(self):
        good = self.clock()
        self.tick()
        self.endpoint.fail = 429
        for _ in range(7):                             # a call every 5 minutes, each 429
            self.clock.tick(minutes=5)
            self.tick()
        self.clock.tick(seconds=30)
        verdict = self.gate.check('fix')
        self.assertEqual((verdict.go, verdict.why), (False, UNREADABLE))
        self.assertIn('over 30 minutes ago', verdict.text)
        self.assertEqual(verdict.until, good + datetime.timedelta(minutes=40))
        self.press_refresh()
        snap = self.tick()
        claude = self.claude(snap)
        self.assertIn('over 30 minutes old', claude['error'])
        self.assertFalse(self.source(snap)['ok'])
        self.assertEqual(page(self.control(), snap)[1][0][:2], (True, 'claude'))


class AfterJobTest(Harness):
    def test_the_next_check_uses_the_after_read(self):
        self.tick()
        self.clock.tick(minutes=1)
        self.endpoint.five = 50
        self.job(minutes=10)
        verdict = self.gate.check('fix')
        self.assertTrue(verdict.go, verdict.text)
        self.assertEqual(verdict.usage.five_hour.used, 50)
        self.assertEqual(len(self.endpoint.calls), 2)

    def test_a_failed_after_read_holds_the_next_check_until_the_endpoint_may_be_asked(self):
        self.tick()
        self.clock.tick(minutes=1)
        verdict = self.gate.check('fix')
        self.clock.tick(minutes=10)
        self.endpoint.fail = 429
        ended = self.clock()
        self.gate.measured('fix', [], verdict.usage)
        self.clock.tick(minutes=1)
        held = self.gate.check('fix')                  # the reading is from before the job
        self.assertEqual((held.go, held.why), (False, UNREADABLE))
        self.assertIn('before the last Claude job ended', held.text)
        self.assertEqual(held.until, ended + datetime.timedelta(minutes=5))   # gate_until
        self.endpoint.fail = None
        self.clock.t = held.until
        self.assertTrue(self.gate.check('fix').go)

    def test_a_job_under_five_minutes_waits_for_the_budget_then_reads(self):
        self.tick()                                    # read at 14:01:49
        self.job(minutes=2)
        self.assertEqual(self.slept, [180])
        self.assertEqual(self.endpoint.calls, [(t(14, 1, 49), 200), (t(14, 6, 49), 200)])
        import json
        with open(self.gate.book.path, encoding='utf-8') as f:
            [rec] = [json.loads(line) for line in f if line.strip()]
        self.assertIsNotNone(rec['after'])
        self.assertNotIn('error', rec)

    def test_a_reading_another_caller_took_after_the_job_ended_serves_the_after_read(self):
        self.tick()
        verdict = self.gate.check('fix')
        self.clock.tick(minutes=2)
        self.endpoint.five = 44

        def sleep(seconds):                            # the publisher reads while it waits
            self.clock.tick(seconds=seconds)
            self.tick()
        self.gate.sleep = sleep
        self.gate.measured('fix', [], verdict.usage)
        self.assertEqual(self.statuses(), [200, 200])  # no second call after the wait
        self.assertEqual(self.gate.check('fix').usage.five_hour.used, 44)


if __name__ == '__main__':
    unittest.main()
