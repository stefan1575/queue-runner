"""Sol's wait for usage ends once ChatGPT's reading shows usage again (issue #130): Stefan used a
ChatGPT reset credit on 2026-11-17, and the Opus fallback went on reviewing until the reset Sol's
review had named. Through the Sol seam (FakeSol), the T3 fake, and the dashboard's own ChatGPT
reader (`snapshot.Watch`) on a fake read: no Codex."""
import datetime
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.fallback import ThreadReviews
from queue_runner.github import Issue
from queue_runner.review import SOL_BACK_EVERY, Reviewer
from queue_runner.snapshot import Calls, Snapshots, Watch
from queue_runner.sol import Limits, LimitWindow
from queue_runner.state import JobLog, append_record, read_records
from tests.fakes import FakeGitHubForReviews, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import H2, H3, reply

UTC = datetime.timezone.utc
OUT_AT = datetime.datetime(2026, 11, 17, 22, 21, tzinfo=UTC)   # Sol's review ran out
RESUME = datetime.datetime(2026, 11, 21, 6, 22, tzinfo=UTC)    # the reset it named, plus ten
NOW = OUT_AT + datetime.timedelta(hours=2)


def limits(session, week):
    return Limits('plus', (LimitWindow(300, session, None), LimitWindow(10080, week, None)))


class Clock:
    def __init__(self, at):
        self.at = at

    def __call__(self):
        return self.at


class ChatGPT:
    """ChatGPT's usage as `codex_usage.CodexUsage.read` gives it: (when, Limits), or an error."""

    def __init__(self, clock, *answers):
        self.clock, self.answers, self.reads = clock, list(answers), 0

    def __call__(self):
        self.reads += 1
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return self.clock(), answer


class SolBackTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        repo = Repo(name='first', github='owner/first', path=self.dir)
        self.config = Config(repos=[repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.path = os.path.join(self.config.state_dir, 'jobs.jsonl')
        self.jobs = JobLog(self.path)
        self.said = []
        self.gh = FakeGitHubForReviews(
            prs=[full_pr(20, 'claude/red-5', H2, body='Closes #5\n\nMakes it red.',
                         title='Red widget', base='main')],
            comments={5: []},
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')})
        self.git = FakeReviewGit(heads={20: H2}, files={'AGENTS.md': '# Agents'})
        self.clock = Clock(NOW)
        self.sol_out()

    def sol_out(self, at=OUT_AT, resume=RESUME, id='out'):
        """Sol's review of an earlier PR ran out of usage at `at`, naming `resume`."""
        stamp = at.astimezone().isoformat(timespec='seconds')
        append_record(self.path, {'event': 'start', 'job': id, 'kind': 'review', 'repo': 'first',
                                  'issue': 9, 'branch': 'b', 'title': 't', 'at': stamp,
                                  'sha': H3, 'round': 1})
        append_record(self.path, {'event': 'end', 'job': id, 'at': stamp, 'exit_code': None,
                                  'outcome': 'out-of-usage',
                                  'resume_at': resume.astimezone().isoformat(timespec='seconds')})

    def watch(self, *answers):
        self.chatgpt = ChatGPT(self.clock, *answers)
        return Watch(self.chatgpt, Calls(self.clock), 'sol_usage', self.clock, timed=True)

    def reviewer(self, watch, *, sol=(), opus=()):
        self.sol = FakeSol(list(sol))
        self.t3 = FakeT3(list(opus))
        return Reviewer(self.config, github=self.gh, git=self.git, sol=self.sol, jobs=self.jobs,
                        say=self.said.append, now=self.clock, merger=False,
                        fallback=ThreadReviews(self.config, t3=self.t3, gate=None, effort=None),
                        sol_usage=watch)

    def backs(self):
        return [e for e in read_records(self.path) if e['event'] == 'sol-back']

    def review(self):
        [job] = [j for j in self.jobs.jobs() if j.kind == 'review' and j.issue == 20]
        return job

    # --- usage back ---------------------------------------------------------------------------

    def test_a_reading_with_usage_again_ends_the_wait_and_sol_reviews(self):
        r = self.reviewer(self.watch(limits(2, 0)), sol=[reply()])
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual((len(self.sol.briefs), self.t3.starts), (1, []))
        self.assertIsNone(self.review().reviewer)   # Sol's own
        [back] = self.backs()
        self.assertEqual(back['windows'], [{'minutes': 300, 'used': 2.0},
                                           {'minutes': 10080, 'used': 0.0}])
        self.assertEqual(back['resume_at'], RESUME.astimezone().isoformat(timespec='seconds'))
        self.assertIsNone(self.jobs.sol_resume_at())
        [line] = [s for s in self.said if 'usage again' in s]
        self.assertIn('the session 2%, the week 0%', line)
        self.assertNotIn('Sol is out of usage', ' '.join(self.said))

    def test_the_ended_wait_holds_for_the_dashboard_and_a_restarted_runner(self):
        self.reviewer(self.watch(limits(2, 0)), sol=[reply()]).review_pass()
        self.assertIsNone(Snapshots(self.config, calls=Calls(self.clock), clock=self.clock,
                                    claude=None, sol=None, info=None).facts().sol_wait)
        self.assertIsNone(JobLog(self.path).sol_out())   # and the wake times' sol_resume_at

    def test_a_dashboard_reading_after_the_review_ran_out_is_used_as_it_is(self):
        watch = self.watch(limits(2, 0))
        watch.read()   # the publisher's read
        self.reviewer(watch, sol=[reply()]).review_pass()
        self.assertEqual(self.chatgpt.reads, 1)
        self.assertEqual(len(self.sol.briefs), 1)

    def test_sol_out_again_after_its_usage_came_back_starts_a_new_wait(self):
        self.reviewer(self.watch(limits(2, 0)), sol=[reply()]).review_pass()
        later = NOW + datetime.timedelta(hours=1)
        self.sol_out(at=later, resume=later + datetime.timedelta(hours=5), id='out-again')
        self.assertEqual(self.jobs.sol_resume_at(), (later + datetime.timedelta(hours=5))
                         .astimezone().isoformat(timespec='seconds'))

    def test_with_no_pr_to_review_a_pass_still_ends_the_wait(self):
        """Review 1 F1: the lane reads ChatGPT on every pass, not only when a PR needs Sol."""
        self.gh.prs = []
        watch = self.watch(limits(2, 0))
        watch.read()   # the publisher's read
        self.assertEqual(self.reviewer(watch).review_pass(), 'idle')
        self.assertEqual(len(self.backs()), 1)
        self.assertIsNone(self.jobs.sol_resume_at())   # the dashboard's wait and the wake time

    def test_a_reading_within_the_second_the_review_ran_out_leaves_the_wait_for_every_reader(self):
        """Review 1 F2 and review 2 F6: the end is stamped to the second, so a reading inside
        that second may come before the review ran out. It doesn't end the wait, for the lane or
        the job log; one from the next second on does, and the record names the review."""
        self.clock.at = OUT_AT + datetime.timedelta(microseconds=500000)
        watch = self.watch(limits(2, 0))
        r = self.reviewer(watch, sol=[reply()])
        self.assertTrue(r._paused())
        self.assertEqual(self.backs(), [])
        self.assertIsNotNone(JobLog(self.path).sol_out())
        self.clock.at += datetime.timedelta(seconds=SOL_BACK_EVERY)   # read again once due
        self.assertFalse(r._paused())
        self.assertIsNone(JobLog(self.path).sol_out())
        self.assertFalse(r._paused())
        [back] = self.backs()   # recorded once: the log agrees after it
        self.assertEqual(back['job'], 'out')

    def test_a_reading_at_the_second_after_the_end_stamp_ends_the_wait(self):
        self.clock.at = OUT_AT + datetime.timedelta(seconds=1)
        self.assertFalse(self.reviewer(self.watch(limits(2, 0)), sol=[reply()])._paused())
        self.assertIsNone(JobLog(self.path).sol_out())

    def test_sol_out_again_in_the_second_its_usage_came_back_starts_a_new_wait(self):
        """Review 2 F6: usage back at 00:21:00.5 ends the first wait; a review running out again
        at 00:21:00.9 is stamped 00:21:00, before the reading, and still starts a wait of its
        own, because the record ends only the review it names."""
        back_at = OUT_AT + datetime.timedelta(hours=2, seconds=0.5)
        self.clock.at = back_at
        self.reviewer(self.watch(limits(2, 0)), sol=[reply()]).review_pass()
        self.assertIsNone(self.jobs.sol_out())
        again = back_at.replace(microsecond=900000)
        resume = again + datetime.timedelta(hours=5)
        self.sol_out(at=again, resume=resume, id='out-again')
        self.assertEqual(JobLog(self.path).sol_resume_at(),
                         resume.astimezone().isoformat(timespec='seconds'))
        self.assertEqual(self.jobs.sol_out().id, 'out-again')

    def test_an_old_record_without_a_job_ends_no_wait(self):
        append_record(self.path, {'event': 'sol-back', 'at': NOW.isoformat(),
                                  'read_at': NOW.isoformat(), 'windows': [], 'resume_at': None})
        self.assertEqual(self.jobs.sol_out().id, 'out')

    def test_a_reading_still_full_is_read_again_once_due(self):
        """Review 1 F5: a post-stop reading at 100% doesn't stop the lane reading again."""
        r = self.reviewer(self.watch(limits(2, 100), limits(2, 0)))
        self.assertTrue(r._paused())
        self.clock.at += datetime.timedelta(seconds=SOL_BACK_EVERY)
        self.assertFalse(r._paused())
        self.assertEqual((self.chatgpt.reads, len(self.backs())), (2, 1))

    def test_the_lane_and_the_dashboard_checking_at_once_read_chatgpt_once(self):
        """Review 1 F3: the check and the read are one step under the reader's lock. Here the
        dashboard's pass runs the moment the lane's check returns, before its read: were the
        check apart from the read, both would find a read due and both would read."""
        snaps = []

        class Racing(Watch):
            def due(self, seconds):
                was = super().due(seconds)
                if snaps:
                    snaps.pop().facts(fresh=True)
                return was

        watch = Racing(ChatGPT(self.clock, limits(2, 0)), Calls(self.clock), 'sol_usage',
                       self.clock, timed=True)
        self.chatgpt = watch.read_fn
        snaps.append(Snapshots(self.config, calls=Calls(self.clock), clock=self.clock,
                               claude=None, sol=watch, info=None))
        self.reviewer(watch, sol=[reply()])._paused()
        self.assertEqual(self.chatgpt.reads, 1)

    # --- the wait stands --------------------------------------------------------------------

    def test_a_window_still_full_keeps_the_wait_and_opus_reviews(self):
        r = self.reviewer(self.watch(limits(3, 99)), opus=[(0, 'completed', reply())])
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual((self.sol.briefs, len(self.t3.starts)), ([], 1))
        self.assertEqual(self.backs(), [])
        self.assertIsNotNone(self.jobs.sol_resume_at())

    def test_a_reading_from_before_the_review_ran_out_is_read_again_once_due(self):
        self.clock.at = OUT_AT - datetime.timedelta(minutes=1)
        watch = self.watch(limits(2, 0))
        watch.read()   # before Sol ran out: says nothing of now
        self.clock.at = OUT_AT + datetime.timedelta(seconds=SOL_BACK_EVERY - 120)
        r = self.reviewer(watch, opus=[(0, 'completed', reply())])
        self.assertTrue(r._paused())   # not due yet: the old reading stands for nothing
        self.assertEqual((self.chatgpt.reads, self.backs()), (1, []))
        self.clock.at += datetime.timedelta(seconds=120)
        self.assertFalse(r._paused())
        self.assertEqual((self.chatgpt.reads, len(self.backs())), (2, 1))

    def test_a_failed_read_keeps_the_wait_and_says_so_once(self):
        watch = self.watch(RuntimeError('Codex is not installed'))
        r = self.reviewer(watch, opus=[(0, 'completed', reply())])
        self.assertTrue(r._paused())
        self.clock.at += datetime.timedelta(seconds=SOL_BACK_EVERY)
        self.assertTrue(r._paused())
        self.assertEqual(self.chatgpt.reads, 2)
        self.assertEqual(len([s for s in self.said if "couldn't be read" in s]), 1)
        self.assertEqual(self.backs(), [])

    # --- Stefan's own --review ----------------------------------------------------------------

    def run_review(self, answer):
        """`--review first#20` with Sol's wait recorded an hour ago (in real time: `--review`'s
        Reviewer reads the PC's clock) and ChatGPT reading `answer` now."""
        import io
        from queue_runner import cli
        real = datetime.datetime.now(UTC)
        os.remove(self.path)
        self.sol_out(at=real - datetime.timedelta(hours=1), resume=real + datetime.timedelta(days=3))
        self.clock.at = real
        self.chatgpt = ChatGPT(self.clock, answer)
        self.sol = FakeSol([reply()])
        out = io.StringIO()
        code = cli._review(self.config, self.gh, self.git, self.sol, 'first#20', out,
                           lambda line: None, sol_usage=self.chatgpt, clock=self.clock)
        return code, out.getvalue()

    def test_review_reads_chatgpt_and_sol_reviews_once_its_usage_is_back(self):
        code, out = self.run_review(limits(2, 0))
        self.assertEqual((code, len(self.sol.briefs), len(self.backs())), (0, 1, 1))
        self.assertIn('usage again', out)

    def test_review_still_refuses_while_a_window_is_full(self):
        code, out = self.run_review(limits(2, 100))
        self.assertEqual((code, self.sol.briefs, self.backs()), (1, [], []))
        self.assertIn('Sol is out of usage until', out)

    def test_with_no_reader_the_wait_lasts_until_the_reset(self):
        r = self.reviewer(None, opus=[(0, 'completed', reply())])
        self.assertTrue(r._paused())
        self.assertEqual(self.backs(), [])


if __name__ == '__main__':
    unittest.main()
