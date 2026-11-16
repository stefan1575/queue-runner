"""The usage gate: whether a Claude job starts now, with fixed clocks and fake usage."""
import datetime
import os
import tempfile
import unittest

from queue_runner.gate import (FITS, FIVE_HOUR, PAUSED, RELEASED, RESERVE, WEEKLY, Cost,
                               CostBook, Knob, decide, read_knob, write_knob)
from queue_runner.usage import Usage, Window

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
FIVE_RESET = NOW + datetime.timedelta(hours=2)
WEEK_RESET = NOW + datetime.timedelta(days=3)


def usage(five, week, five_reset=FIVE_RESET, week_reset=WEEK_RESET):
    return Usage(Window(five, five_reset), Window(week, week_reset))


BUILD = Cost(five_hour=40, seven_day=10)


class DecideTest(unittest.TestCase):
    def test_a_job_that_fits_both_windows_starts(self):
        v = decide(usage(50, 70), 'build', BUILD, Knob(), NOW)
        self.assertEqual((v.go, v.why), (True, FITS))

    def test_a_job_that_wont_fit_the_five_hour_window_waits_for_its_reset(self):
        v = decide(usage(61, 20), 'build', BUILD, Knob(), NOW)
        self.assertEqual((v.go, v.why), (False, FIVE_HOUR))
        self.assertGreaterEqual(v.until, FIVE_RESET)
        self.assertLess(v.until, FIVE_RESET + datetime.timedelta(minutes=10))
        self.assertIn('61%', v.text)

    def test_a_fresh_five_hour_window_takes_any_job(self):
        v = decide(usage(0, 20, five_reset=None), 'build', Cost(120, 10), Knob(), NOW)
        self.assertTrue(v.go)

    def test_the_weekly_reserve_holds_until_a_day_before_the_weekly_reset(self):
        v = decide(usage(10, 86), 'build', BUILD, Knob(reserve=5), NOW)
        self.assertEqual((v.go, v.why), (False, RESERVE))
        self.assertEqual(v.until, WEEK_RESET - datetime.timedelta(hours=24))
        self.assertIn('5%', v.text)

    def test_a_changed_reserve_moves_the_line(self):
        self.assertTrue(decide(usage(10, 86), 'build', BUILD, Knob(reserve=2), NOW).go)
        self.assertFalse(decide(usage(10, 70), 'build', BUILD, Knob(reserve=25), NOW).go)

    def test_inside_the_last_24_hours_the_reserve_is_released(self):
        late = WEEK_RESET - datetime.timedelta(hours=23)
        v = decide(usage(10, 86, five_reset=late + datetime.timedelta(hours=1)), 'build', BUILD,
                   Knob(reserve=5), late)
        self.assertEqual((v.go, v.why), (True, RELEASED))

    def test_a_week_with_no_room_even_without_the_reserve_waits_for_the_weekly_reset(self):
        v = decide(usage(10, 95), 'build', BUILD, Knob(reserve=5), NOW)
        self.assertEqual((v.go, v.why), (False, WEEKLY))
        self.assertGreaterEqual(v.until, WEEK_RESET)

    def test_paused_starts_nothing_whatever_the_usage(self):
        v = decide(usage(0, 0, None, None), 'build', BUILD, Knob(paused=True), NOW)
        self.assertEqual((v.go, v.why, v.until), (False, PAUSED, None))
        self.assertIn('--resume', v.text)


class KnobTest(unittest.TestCase):
    def test_the_knob_defaults_to_running_with_a_5_percent_reserve_and_keeps_what_is_set(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(read_knob(d), Knob(paused=False, reserve=5.0))
            write_knob(d, Knob(paused=True, reserve=12.5))
            self.assertEqual(read_knob(d), Knob(paused=True, reserve=12.5))


def snap(five, week, five_reset=FIVE_RESET, week_reset=WEEK_RESET):
    return usage(five, week, five_reset, week_reset)


class CostBookTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.book = CostBook(os.path.join(tmp.name, 'usage.jsonl'))

    def test_a_kind_with_few_records_gets_the_cautious_default(self):
        default = self.book.expected('build')
        self.book.record('build', ['j1'], snap(10, 10), snap(15, 11))
        self.book.record('build', ['j2'], snap(15, 11), snap(20, 12))
        self.assertEqual(self.book.expected('build'), default)
        self.assertGreaterEqual(default.five_hour, 40)

    def test_with_a_few_records_the_cost_is_the_largest_recent_one(self):
        for before, after in ((10, 15), (15, 27), (27, 34)):
            self.book.record('fix', [], snap(before, 10), snap(after, 12))
        self.assertEqual(self.book.expected('fix'), Cost(five_hour=12, seven_day=2))
        self.assertEqual(self.book.expected('build'), CostBook(self.book.path).expected('build'))

    def test_a_window_that_reset_mid_job_gives_no_sample_for_it(self):
        later = FIVE_RESET + datetime.timedelta(hours=5)
        for _ in range(3):
            self.book.record('decision', [], snap(90, 10), snap(3, 11, five_reset=later))
        cost = self.book.expected('decision')
        self.assertEqual(cost.seven_day, 1)
        self.assertEqual(cost.five_hour, self.book.default('decision').five_hour)

    def test_a_window_that_started_mid_job_counts_from_zero(self):
        for _ in range(3):
            self.book.record('decision', [], snap(0, 10, five_reset=None), snap(4, 10))
        self.assertEqual(self.book.expected('decision').five_hour, 4)


if __name__ == '__main__':
    unittest.main()


class GateCheckTest(unittest.TestCase):
    def gate(self, *reads):
        from queue_runner.gate import Gate
        from tests.fakes import FakeUsage
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Gate(tmp.name, FakeUsage(*reads), clock=lambda: NOW)

    def test_a_decision_that_may_continue_a_build_must_fit_both(self):
        gate = self.gate(usage(30, 10))
        self.assertTrue(gate.check('decision').go)
        v = gate.check('decision', then='build')
        self.assertEqual((v.go, v.why), (False, FIVE_HOUR))
        self.assertIn('the build it may continue', v.text)

    def test_a_weekly_reset_already_past_is_not_waited_on(self):
        v = decide(usage(10, 99, week_reset=NOW - datetime.timedelta(minutes=30)), 'build',
                   BUILD, Knob(), NOW)
        self.assertEqual((v.go, v.why, v.until), (False, WEEKLY, None))

    def test_a_torn_last_record_is_ignored_and_cut_off_by_the_next(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        book = CostBook(os.path.join(tmp.name, 'usage.jsonl'))
        for _ in range(3):
            book.record('fix', [], snap(10, 10), snap(20, 12))
        with open(book.path, 'a', encoding='utf-8') as f:
            f.write('{"kind": "fix", "spe')
        self.assertEqual(book.expected('fix'), Cost(10, 2))
        book.record('fix', [], snap(10, 10), snap(40, 12))
        self.assertEqual(book.expected('fix'), Cost(30, 2))
