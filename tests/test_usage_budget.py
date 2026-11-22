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
from queue_runner.gate import FIVE_HOUR, UNREADABLE
from queue_runner.run import BUSY, GATED, STARTED, Runner, Start
from queue_runner.state import JobLog
from queue_runner.sol import Limits as SolLimits, LimitWindow as SolWindow
from tests.fakes import FakeGitHubWithPulls, StubEndpoint, issue
from tests.fakes_t3 import FakeGit, FakeT3

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


class EndedElsewhereTest(Harness):
    """A Claude thread that ends outside a measured pass (PR 67's review 1, F1): a dead runner's
    job settled, a waiting job Stefan answered that has since ended, or a decision thread whose retry never reached its job. The next check decides only on a
    reading taken after the runner saw it end, as after a measured job."""

    def setUp(self):
        super().setUp()
        import io
        self.log = JobLog(os.path.join(self.state, 'jobs.jsonl'))
        self.t3 = FakeT3([(0, 'completed')])
        self.gh = FakeGitHubWithPulls(issues=[issue(5)])
        self.r = Runner(self.config, github=self.gh, t3=self.t3, git=FakeGit(),
                        out=io.StringIO(), log_line=lambda line: None, gate=self.gate,
                        now=self.clock)

    def a_build(self, status=None):
        """A build left open by a dead runner, its thread in T3 (if `status`)."""
        job = self.log.started(kind='build', repo='queue-runner', issue=4,
                               branch='claude/a-ticket-4',
                               title='Queue runner build: queue-runner#4')
        if status:
            self.t3.add('mcp:old', job.title, status)
        return job

    def assert_held_until_the_next_read(self):
        """The pass after the job ended: held on the reading from before it, until the endpoint
        may be asked again; then it decides on the new reading (90% used: a build won't fit)."""
        self.assertEqual(self.r.run_pass(), GATED)
        self.assertEqual(self.t3.starts, [])
        self.assertIn('before the last Claude job ended', self.r.claude_wait.reason)
        self.assertEqual(self.r.gate_until, t(14, 6, 49))
        self.clock.t = self.r.gate_until
        self.assertEqual(self.r.run_pass(), GATED)
        self.assertEqual(self.gate.check('build').why, FIVE_HOUR)
        self.assertEqual(self.t3.starts, [])

    def test_a_dead_runners_job_that_ends_holds_the_next_job_for_a_reading_after_it(self):
        self.a_build('running')
        self.endpoint.five = 10
        self.tick()                                    # 14:01:49: 10% while the job runs
        self.assertEqual(self.r.run_pass(), BUSY)
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90                        # what the job spent
        self.t3.set_status('mcp:old', 'completed')
        self.assert_held_until_the_next_read()

    def test_a_dead_runners_job_found_ended_on_the_first_pass_counts_too(self):
        self.a_build('completed')
        self.endpoint.five = 10
        self.tick()                                    # read before the pass settled it
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90
        self.assert_held_until_the_next_read()

    def test_a_waiting_job_answered_and_ended_since_holds_the_next_job_too(self):
        job = self.a_build()
        self.log.ended(job.id, exit_code=2, outcome='waiting', thread_id='mcp:w')
        self.t3.add('mcp:w', job.title, 'running')     # Stefan answered it in T3
        self.endpoint.five = 10
        self.tick()
        self.assertEqual(self.r.run_pass(), BUSY)
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90
        self.t3.set_status('mcp:w', 'completed')
        self.assert_held_until_the_next_read()

    def test_a_waiting_job_that_ran_on_stefans_answer_and_asks_again_holds_the_next_job(self):
        self.a_waiting_build()
        self.ran_again('mcp:w', 'running')             # Stefan answered it in T3
        self.endpoint.five = 10
        self.tick()
        self.assertEqual(self.r.run_pass(), BUSY)
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90
        self.t3.set_status('mcp:w', 'waiting')         # it ran, and asks him again
        self.assert_held_until_the_next_read()
        self.assertEqual(self.log.jobs()[0].outcome, 'waiting')

    def test_a_waiting_job_still_on_the_run_that_asked_holds_nothing(self):
        self.a_waiting_build()                         # Stefan hasn't answered
        self.tick()
        self.clock.at(14, 2, 49)
        self.r.run_pass()
        self.assertIsNone(self.gate.ended)             # no run since it asked: nothing ended

    def test_a_run_on_stefans_answer_is_told_to_the_gate_once(self):
        self.a_waiting_build()
        self.ran_again('mcp:w', 'waiting')
        self.endpoint.five = 10
        self.tick()
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90
        self.assert_held_until_the_next_read()        # its next pass decides on 14:06:49's
        self.clock.at(14, 8)
        self.r.run_pass()
        self.assertEqual(self.gate.ended, t(14, 2, 49))   # the same run: not told again

    def a_waiting_build(self):
        """A build waiting on Stefan, its end record naming the run that asked (#85)."""
        job = self.a_build()
        self.log.ended(job.id, exit_code=2, outcome='waiting', thread_id='mcp:w',
                       run_id='run:mcp:w:1')
        self.t3.add('mcp:w', job.title, 'waiting')
        return job

    def ran_again(self, thread_id, status):
        """Stefan answered the thread in T3: a newer run, now `status`."""
        from dataclasses import replace
        self.t3.threads[thread_id] = replace(self.t3.threads[thread_id], status=status,
                                             latest_run_id=f'run:{thread_id}:2')

    def test_a_run_on_stefans_answer_no_pass_saw_running_holds_the_next_job(self):
        self.a_waiting_build()
        self.endpoint.five = 10
        self.tick()
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90
        self.ran_again('mcp:w', 'waiting')             # ran and asked again, all between passes
        self.assert_held_until_the_next_read()
        self.assertEqual(self.log.jobs()[0].outcome, 'waiting')

    def test_jobs_settled_that_never_reached_a_thread_hold_nothing(self):
        self.a_build()                                 # no thread in T3: not-started
        self.tick()
        self.clock.at(14, 2, 49)
        self.assertEqual(self.r.run_pass(), STARTED)   # a build, on the 14:01:49 reading
        self.assertEqual(len(self.t3.starts), 1)

    def test_a_decision_thread_whose_retry_never_reached_the_job_holds_the_next_job(self):
        # Decider.act: the decision thread ran, then continuing the job failed, so the pass
        # returns idle and isn't measured; the decision's thread still spent usage.
        self.tick()
        self.endpoint.five = 90

        def run():
            job = self.log.started(kind='decision', repo='queue-runner', issue=4, branch=None,
                                   title='Queue runner decision: queue-runner#4')
            self.clock.at(14, 2, 49)
            self.log.ended(job.id, exit_code=0, outcome='retry', thread_id='mcp:d')
            self.log.ended(job.id, exit_code=0, outcome='not-started',
                           error='the earlier job was not continued')
            return 'idle'
        self.r.choose = lambda skip=frozenset(): [   # one repo's job (#50)
            Start('queue-runner', 'decision', None, run, 'decision queue-runner#4')]
        self.assertEqual(self.r.run_pass(), 'idle')
        del self.r.choose
        self.assert_held_until_the_next_read()

    def test_a_pass_whose_job_reached_no_thread_holds_nothing(self):
        self.tick()

        def run():                                     # T3 down: the build never started
            job = self.a_build()
            self.log.ended(job.id, exit_code=None, outcome='not-started', error='T3 is down')
            return 'idle'
        self.r.choose = lambda skip=frozenset(): [
            Start('queue-runner', 'build', None, run, 'build queue-runner#5')]
        self.r.run_pass()
        del self.r.choose
        self.clock.at(14, 2, 49)
        self.assertEqual(self.r.run_pass(), STARTED)   # the next build goes on the same reading



class DeadFallbackReviewTest(EndedElsewhereTest):
    """A dead runner's Opus fallback review whose thread runs on in T3 (PR 67's review 2, F2):
    the Sol lane leaves its job open while the thread runs and counts it failed once it ends;
    the Claude lane starts nothing beside it; and whichever lane first sees the thread end tells
    the gate, once, so the next Claude job waits for a reading after it."""
    test_a_dead_runners_job_that_ends_holds_the_next_job_for_a_reading_after_it = None
    test_a_dead_runners_job_found_ended_on_the_first_pass_counts_too = None

    def setUp(self):
        super().setUp()
        import io
        from queue_runner.review import Reviewer
        self.said = []
        self.r = Runner(self.config, github=self.gh, t3=self.t3, git=FakeGit(), sol=object(),
                        out=io.StringIO(), log_line=self.said.append, gate=self.gate,
                        now=self.clock)
        self.assertIsInstance(self.r.reviewer, Reviewer)

    def a_review(self, status=None):
        from queue_runner.fallback import KIND
        job = self.log.started(kind='review', repo='queue-runner', issue=7, branch='claude/x-7',
                               title='Queue runner review: queue-runner#7', sha='c' * 40,
                               round=1, reviewer=KIND)
        if status:
            self.t3.add('mcp:opus', job.title, status)
        return job

    def the(self, job):
        return next(j for j in self.log.jobs() if j.id == job.id)

    def test_the_sol_lane_keeps_it_open_while_its_thread_runs_then_counts_it_failed(self):
        from queue_runner.github import PullRequest
        job = self.a_review('running')
        self.endpoint.five = 10
        self.tick()                                    # 14:01:49: 10% while it runs
        self.r.reviewer.settle()
        self.r.reviewer.settle()
        self.assertTrue(self.the(job).open)
        self.assertEqual(self.t3.settles, [])          # running: left in the sidebar
        self.assertEqual(sum('runs on in https://app.t3.codes/threads/env/mcp:opus' in line
                             for line in self.said), 1)   # said once
        self.assertIn('runs on in T3', self.r.reviewer.why_not(
            QR, PullRequest(7, 'claude/x-7', '', head_sha='d' * 40)))
        self.assertEqual(self.r.run_pass(), BUSY)      # no Claude job beside it
        self.assertEqual(self.t3.starts, [])
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90                        # what the review spent
        self.t3.set_status('mcp:opus', 'completed')
        self.r.reviewer.settle()                       # the Sol lane sees it end first
        ended = self.the(job)
        self.assertEqual((ended.outcome, ended.thread_id, ended.run_id),
                         ('failed', 'mcp:opus', 'run:mcp:opus:1'))
        self.assertEqual(self.t3.settles, ['mcp:opus'])   # its end recorded: settled (#77)
        self.assertEqual(self.gate.ended, t(14, 2, 49))
        self.assert_held_until_the_next_read()

    def test_a_dead_runners_review_thread_whose_settle_fails_is_said_and_counted(self):
        from queue_runner.t3 import T3Error
        job = self.a_review('completed')
        self.t3.settle_error = T3Error('refused')
        self.r.reviewer.settle()
        self.assertEqual(self.the(job).outcome, 'failed')
        self.assertTrue(any('settling its thread mcp:opus in T3 failed' in line
                            for line in self.said), self.said)

    def test_the_claude_lane_seeing_it_end_first_tells_the_gate_once(self):
        job = self.a_review('running')
        self.endpoint.five = 10
        self.tick()
        self.assertEqual(self.r.run_pass(), BUSY)
        self.clock.at(14, 2, 49)
        self.endpoint.five = 90
        self.t3.set_status('mcp:opus', 'completed')
        # Each of these passes sees the job still open (the Sol lane is busy elsewhere) and its
        # thread ended: only the first tells the gate, so the 14:06:49 reading serves.
        self.assert_held_until_the_next_read()
        self.assertEqual(self.gate.ended, t(14, 2, 49))
        self.clock.at(14, 7)
        self.r.reviewer.settle()                       # the Sol lane, at last
        self.assertEqual(self.the(job).outcome, 'failed')
        self.assertEqual(self.gate.ended, t(14, 2, 49))   # told already: the reading stands
        self.assertEqual(self.gate.check('fix').why, FIVE_HOUR)   # decided on 14:06:49's 90%

    def test_the_sol_lanes_own_review_now_runs_beside_the_claude_lane(self):
        job = self.a_review('running')
        self.r.reviewer.live = job.id                  # this runner's review, running now
        self.endpoint.five = 10                        # room for a build beside its cost (#50)
        self.tick()
        self.clock.at(14, 2, 49)
        self.assertEqual(self.r.run_pass(), STARTED)

    def test_a_review_that_never_started_a_thread_is_counted_failed_and_holds_nothing(self):
        job = self.a_review()
        self.tick()
        self.r.reviewer.settle()
        ended = self.the(job)
        self.assertEqual((ended.outcome, ended.thread_id), ('failed', None))
        self.assertIsNone(self.gate.ended)             # no thread ran: the reading stands
        self.clock.at(14, 2, 49)
        self.assertEqual(self.r.run_pass(), STARTED)

    def test_t3_unreadable_keeps_both_lanes_off_it(self):
        from queue_runner.t3 import T3Error
        job = self.a_review('running')
        self.tick()

        def down(project):
            raise T3Error('the server is down')
        self.t3.list = down
        self.r.reviewer.settle()
        self.assertTrue(self.the(job).open)
        self.assertEqual(self.r.run_pass(), BUSY)
        self.assertEqual(self.t3.starts, [])


class MeasuredRaceTest(Harness):
    """PR 67's review 2, a nit: the other lane telling the gate a job ended while this job's
    after-read is under way doesn't cost this job its sample."""

    def test_a_job_ended_in_the_other_lane_mid_read_keeps_this_jobs_reading(self):
        import json
        self.tick()                                    # 14:01:49
        verdict = self.gate.check('fix')
        self.clock.tick(minutes=10)                    # a 10-minute job: no budget wait
        read = self.gate.reader.read

        def read_then_the_other_lane(*a, **kw):
            got = read(*a, **kw)
            self.clock.tick(seconds=1)
            self.gate.job_ended('the-sol-lanes-fallback-review')
            return got
        self.gate.reader.read = read_then_the_other_lane
        self.gate.measured('fix', ['j1'], verdict.usage)
        with open(os.path.join(self.state, 'usage.jsonl'), encoding='utf-8') as f:
            last = json.loads(f.read().splitlines()[-1])
        self.assertIsNotNone(last['after'], last)


if __name__ == '__main__':
    unittest.main()
