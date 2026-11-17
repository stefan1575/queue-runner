"""The usage gate: whether a Claude job starts now, with fixed clocks and fake usage."""
import datetime
import json
import os
import tempfile
import unittest

from queue_runner.gate import (DEFAULTS, FITS, FIVE_HOUR, RELEASED, RESERVE, WEEKLY, Cost,
                               CostBook, Knob, decide, read_knob, write_knob)
from queue_runner.state import read_records
from queue_runner.usage import Plan, Usage, Window

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

    # Stopping the Claude lane is control.json's, read before the gate (tests/test_switch.py).


class KnobTest(unittest.TestCase):
    def test_the_knob_defaults_to_a_5_percent_reserve_and_keeps_what_is_set(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(read_knob(d), Knob(reserve=5.0))
            write_knob(d, Knob(reserve=12.5))
            self.assertEqual(read_knob(d), Knob(reserve=12.5))


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


MAX = Plan('max', 'default_claude_max_20x')
PRO = Plan('pro', 'default_claude_ai')


class PlanCostTest(unittest.TestCase):
    """Learned costs are percents of a plan's windows, so they count only on it (issue #118)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.plan = MAX
        self.book = CostBook(os.path.join(tmp.name, 'usage.jsonl'), plan=lambda: self.plan)

    def builds(self, n, spent=4):
        for _ in range(n):
            self.book.record('build', [], snap(10, 10), snap(10 + spent, 11))

    def test_each_record_carries_the_plan_it_ran_on(self):
        self.builds(1)
        self.assertEqual(list(read_records(self.book.path))[-1]['plan'],
                         {'subscriptionType': 'max', 'rateLimitTier': 'default_claude_max_20x'})

    def test_a_plan_change_starts_from_the_defaults_until_three_jobs_are_measured_on_it(self):
        self.builds(3)
        self.assertEqual(self.book.expected('build'), Cost(4, 1))
        self.plan = PRO
        self.assertEqual(self.book.expected('build'), DEFAULTS['build'])
        self.assertFalse(self.book.learned('build'))
        self.builds(2, spent=30)
        self.assertEqual(self.book.expected('build'), DEFAULTS['build'])
        self.builds(1, spent=30)
        self.assertEqual(self.book.expected('build'), Cost(30, 1))

    def test_the_old_plans_records_count_again_when_it_comes_back(self):
        self.builds(3)
        self.plan = PRO
        self.builds(3, spent=30)
        self.plan = MAX
        self.assertEqual(self.book.expected('build'), Cost(4, 1))
        self.assertEqual(len(list(read_records(self.book.path))), 6)

    def test_records_without_a_plan_count_as_the_plan_stamped_at_the_first_start(self):
        plain = CostBook(self.book.path)   # records as before this landed: no plan read
        for _ in range(3):
            plain.record('fix', [], snap(10, 10), snap(12, 10))
        with open(self.book.path, encoding='utf-8') as f:
            lines = [json.loads(line) for line in f]
        with open(self.book.path, 'w', encoding='utf-8') as f:   # older code wrote no `plan`
            f.writelines(json.dumps({k: v for k, v in r.items() if k != 'plan'}) + '\n'
                         for r in lines)
        # Not stamped yet: they count as the plan read now.
        self.assertEqual(self.book.expected('fix'), Cost(2, 0))
        self.assertTrue(self.book.stamp_unmarked(MAX))
        self.assertFalse(self.book.stamp_unmarked(PRO))   # once: the first start's plan stays
        self.plan = PRO
        self.assertEqual(self.book.expected('fix'), DEFAULTS['fix'])
        self.plan = MAX
        self.assertEqual(self.book.expected('fix'), Cost(2, 0))

    def test_an_unread_plan_stamps_nothing(self):
        self.assertFalse(self.book.stamp_unmarked(None))
        self.assertFalse(os.path.exists(os.path.join(self.dir, 'usage-plan.json')))

    def test_the_plan_change_is_against_the_last_records(self):
        self.assertIsNone(self.book.plan_change())   # nothing recorded: nothing changed
        self.builds(1)
        self.assertIsNone(self.book.plan_change())
        self.plan = PRO
        self.assertEqual(self.book.plan_change(),
                         "Claude's plan is now pro (was max): learned costs start again")
        self.builds(1)
        self.assertIsNone(self.book.plan_change())
        self.plan = MAX
        self.assertEqual(self.book.plan_change(), "Claude's plan is now max (was pro): the "
                         'costs learned on it before count again')


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


class RunningJobsTest(unittest.TestCase):
    """#50: each repo runs its own Claude job at once, so a job starts only when its cost fits
    after the cost of every Claude job still running."""

    def test_a_job_that_fits_alone_waits_beside_running_jobs_until_one_ends(self):
        from queue_runner.gate import RUNNING, Running
        running = Running().plus('build first#4', BUILD)
        v = decide(usage(30, 10), 'build', BUILD, Knob(), NOW, running)
        self.assertEqual((v.go, v.why, v.until), (False, RUNNING, None))
        self.assertIn('build would fit alone, but the Claude job running (build first#4) is '
                      'expected to take 40% of 5 hours, 10% of the week: it waits for one of '
                      'them to end', v.text)

    def test_a_job_that_fits_beside_them_starts_and_says_so(self):
        from queue_runner.gate import Running
        running = Running().plus('fix first#12', Cost(20, 5)).plus('decision second#3', Cost(5, 1))
        v = decide(usage(30, 10), 'build', BUILD, Knob(), NOW, running)
        self.assertEqual((v.go, v.why), (True, FITS))
        self.assertIn('the 2 Claude jobs running (fix first#12, decision second#3) are expected '
                      'to take 25% of 5 hours, 6% of the week, and it fits beside them', v.text)

    def test_one_that_does_not_fit_alone_waits_for_the_reset_as_before(self):
        from queue_runner.gate import Running
        v = decide(usage(70, 10), 'build', BUILD, Knob(), NOW, Running().plus('x', BUILD))
        self.assertEqual((v.why, v.until), (FIVE_HOUR, FIVE_RESET + datetime.timedelta(minutes=2)))

    def test_a_fresh_window_takes_any_job_only_while_nothing_runs(self):
        from queue_runner.gate import RUNNING, Running
        big = Cost(70, 5)
        self.assertTrue(decide(usage(0, 0, five_reset=None), 'build', big, Knob(), NOW).go)
        v = decide(usage(0, 0, five_reset=None), 'build', big, Knob(), NOW,
                   Running().plus('build first#4', big))
        self.assertEqual(v.why, RUNNING)

    def test_the_reserve_counts_the_running_jobs_too(self):
        from queue_runner.gate import RUNNING, Running
        v = decide(usage(10, 80), 'build', BUILD, Knob(reserve=5), NOW,
                   Running().plus('build first#4', BUILD))
        self.assertTrue(decide(usage(10, 80), 'build', BUILD, Knob(reserve=5), NOW).go)
        self.assertEqual(v.why, RUNNING)

    def test_the_gate_counts_each_running_jobs_expected_cost_and_what_it_may_continue(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        from queue_runner.gate import Gate
        from tests.fakes import FakeUsage
        gate = Gate(tmp.name, FakeUsage(usage(0, 10), usage(0, 10)), clock=lambda: NOW)
        running = gate.running([('decision first#3', 'decision', 'build')])
        self.assertEqual(running.cost, CostBook.default('decision') + CostBook.default('build'))
        self.assertTrue(gate.check('decision').go)
        v = gate.check('build', running=[('decision first#3', 'decision', 'build')])
        self.assertFalse(v.go)   # 15 + 60 + 60 of 5 hours

    def test_a_pass_shared_with_another_job_teaches_nothing(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        book = CostBook(os.path.join(tmp.name, 'usage.jsonl'))
        for _ in range(3):
            book.record('fix', ['f'], snap(10, 10), snap(50, 20), shared_with=['b'])
        self.assertEqual(book.expected('fix'), CostBook.default('fix'))
        self.assertFalse(book.learned('fix'))
        for _ in range(3):
            book.record('fix', ['f'], snap(10, 10), snap(20, 12))
        self.assertEqual(book.expected('fix'), Cost(10, 2))
