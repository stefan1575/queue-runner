"""Threads that need Stefan say so in their title (issue #71): an ask thread waiting on his
decision is "Decide: ...", a build or fix thread stopped on a question to him "Answer: ...", and
once it no longer needs him the prefix comes off and the thread is settled. Through the real
`Runner`, with T3 faked (`FakeT3`: a rename changes the thread's title)."""
import io
import unittest

from queue_runner.prefixes import ANSWER, DECIDE, plain, titled
from queue_runner.run import Runner
from queue_runner.t3 import Message, T3Error
from tests.fakes_t3 import decision_reply
from tests import test_ask_threads as ta
from tests import test_decisions as td
from queue_runner.github import Comment
from tests.test_ledger import H2, important, old_marker

ASK = 'Queue runner ask: first#20'
BUILD = 'Queue runner build: first#4'
FIX = 'Queue runner fix: first#20'


class TitleTest(unittest.TestCase):
    def test_a_prefix_goes_on_once(self):
        self.assertEqual(titled(DECIDE, ASK), 'Decide: ' + ASK)
        self.assertEqual(titled(DECIDE, titled(DECIDE, ASK)), 'Decide: ' + ASK)
        self.assertEqual(titled(ANSWER, titled(DECIDE, BUILD)), 'Answer: ' + BUILD)

    def test_plain_takes_every_prefix_off(self):
        self.assertEqual(plain('Answer: Decide: Answer: ' + BUILD), BUILD)
        self.assertEqual(plain(BUILD), BUILD)
        self.assertEqual(plain('Answered: x'), 'Answered: x')   # only the prefixes themselves


class AskTitleTest(ta.ThreadCase):
    def title(self, thread_id):
        return self.t3.threads[thread_id].title

    def test_an_ask_thread_opens_titled_decide_and_is_not_renamed_again(self):
        ask = self.opened()
        self.assertEqual(self.t3.launches[0]['title'], 'Decide: ' + ASK)
        self.assertEqual(ask.title, ASK)   # the job keeps its own title
        self.t3.outcomes = [(0, 'completed')]   # the build of #4
        self.r.run_pass()
        self.r.run_pass()
        self.assertEqual(self.title(ask.thread_id), 'Decide: ' + ASK)
        self.assertEqual(self.t3.renames, [])
        self.assertNotIn(ask.thread_id, self.t3.settles)

    def test_an_ask_thread_from_before_gets_its_prefix(self):
        ask = self.opened()
        self.t3.rename(ask.thread_id, ASK)   # opened before issue #71: no prefix
        self.t3.renames.clear()
        fresh = Runner(self.config, github=self.gh, t3=self.t3, git=self.git,
                       out=io.StringIO(), log_line=self.said.append, limits=self.limits)
        fresh.plan()
        self.assertEqual(self.t3.renames, [(ask.thread_id, 'Decide: ' + ASK)])
        fresh.plan()   # a runner that restarted reads the title, and doesn't double it
        Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=io.StringIO(),
               log_line=self.said.append, limits=self.limits).plan()
        self.assertEqual(self.title(ask.thread_id), 'Decide: ' + ASK)
        self.assertEqual(len(self.t3.renames), 1)

    def test_decided_in_the_thread_the_prefix_comes_off_and_it_is_settled(self):
        ask = self.opened()
        self.says(ask, Message('assistant', decision_reply('hold')))
        self.r.run_pass()
        self.assertEqual(self.title(ask.thread_id), ASK)
        self.assertTrue(self.t3.threads[ask.thread_id].settled)
        self.assertEqual(self.t3.renames, [(ask.thread_id, ASK)])
        self.r.run_pass()   # once
        self.assertEqual((self.t3.renames, self.t3.settles.count(ask.thread_id)),
                         ([(ask.thread_id, ASK)], 1))

    def test_answered_on_github_the_prefix_comes_off_and_it_is_settled(self):
        ask = self.opened()
        self.answer('hold')   # on the PR; the Sol lane reads it
        self.says(ask, Message('assistant', 'The case: ...'), status='completed')
        self.r.plan()
        self.assertEqual(self.title(ask.thread_id), ASK)
        self.assertTrue(self.t3.threads[ask.thread_id].settled)

    def test_a_released_stop_takes_the_prefix_off(self):
        ask = self.opened()
        self.says(ask, Message('assistant', 'The case: ...'), status='completed')
        self.r.jobs.released('first', 20)
        self.r.plan()
        self.assertEqual(self.title(ask.thread_id), ASK)
        self.assertTrue(self.t3.threads[ask.thread_id].settled)

    def test_a_thread_still_running_keeps_its_prefix_until_it_stops(self):
        ask = self.opened()   # running: Stefan is talking it through
        self.r.jobs.released('first', 20)
        self.r.plan()
        self.assertEqual(self.title(ask.thread_id), 'Decide: ' + ASK)
        self.assertNotIn(ask.thread_id, self.t3.settles)
        self.t3.set_status(ask.thread_id, 'completed')
        self.r.plan()
        self.assertEqual(self.title(ask.thread_id), ASK)
        self.assertIn(ask.thread_id, self.t3.settles)

    def test_a_rename_that_fails_is_said_once_and_tried_again(self):
        ask = self.opened()
        self.says(ask, Message('assistant', 'The case: ...'), status='completed')
        self.r.jobs.released('first', 20)
        self.t3.rename_error = T3Error('T3 refused it')
        self.r.plan()
        self.r.plan()
        line = (f'ask first#20: renaming its thread {ask.thread_id} in T3 failed '
                '(T3Error: T3 refused it); tried again next pass')
        self.assertEqual(self.said.count(line), 1)
        self.assertNotIn(ask.thread_id, self.t3.settles)   # the prefix first
        self.t3.rename_error = None
        self.r.plan()
        self.assertEqual(self.title(ask.thread_id), ASK)
        self.assertIn(ask.thread_id, self.t3.settles)


class AnswerTitleTest(unittest.TestCase):
    """The decision tests' build of #4 and PR #20."""
    D = td.DecisionTest
    setUp, runner, jobs, build = D.setUp, D.runner, D.jobs, D.build

    def title(self, thread_id):
        return self.t3.threads[thread_id].title

    def stopped_build(self):
        """A build of #4 that asked a question, which a decision left to Stefan."""
        self.build((2, 'waiting'), (0, 'completed', decision_reply('stop', question='Blue?')))
        self.r.run_pass()
        self.assertEqual(self.jobs('decision')[0].outcome, 'stop')
        return self.jobs('build')[0]

    def test_a_build_stopped_on_a_question_to_stefan_is_titled_answer(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.assertEqual(self.title(build.thread_id), 'Answer: ' + BUILD)
        self.assertNotIn(build.thread_id, self.t3.settles)
        self.r.run_pass()
        self.assertEqual(self.t3.renames, [(build.thread_id, 'Answer: ' + BUILD)])

    def test_a_question_a_decision_answers_gets_no_prefix(self):
        self.build((2, 'waiting'), (0, 'completed', decision_reply('answer', text='Use blue.')),
                   (0, 'completed'))
        self.r.run_pass()
        self.r.run_pass()
        self.assertEqual(self.t3.renames, [])

    def test_answered_in_the_thread_the_prefix_comes_off_and_it_is_settled(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.t3.set_status(build.thread_id, 'completed')   # Stefan answered; it finished
        self.r.run_pass()
        self.assertEqual(self.jobs('build')[0].outcome, 'done-no-pr')
        self.assertEqual(self.title(build.thread_id), BUILD)
        self.assertTrue(self.t3.threads[build.thread_id].settled)

    def test_it_asked_again_and_keeps_its_prefix(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.t3.set_status(build.thread_id, 'waiting')   # answered, and it asked another
        self.r.run_pass()
        self.assertEqual(self.title(build.thread_id), 'Answer: ' + BUILD)
        self.assertNotIn(build.thread_id, self.t3.settles)

    def test_a_release_takes_the_prefix_off(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.r.jobs.released('first', 4)
        self.r.plan()
        self.assertEqual(self.title(build.thread_id), BUILD)
        self.assertTrue(self.t3.threads[build.thread_id].settled)

    def test_a_fix_round_stopped_on_a_question_to_stefan_is_titled_answer(self):
        self.gh.issues = []   # no build of #4 in between
        r = self.runner((2, 'waiting'), (0, 'completed', decision_reply('stop', question='?')))
        j = r.jobs.started(kind='review', repo='first', issue=20, branch='claude/red-5',
                           title='t', sha=H2, round=1)
        r.jobs.ended(j.id, exit_code=None, outcome='blocking')
        self.gh.comments[20] = [Comment('stefan1575', '2026-11-09T10:00:00Z',
                                        old_marker(1, 'blocking', H2, [important('F7')]))]
        r.run_pass()   # the fix round asks a question
        r.run_pass()   # a decision leaves it to Stefan
        r.run_pass()
        [fix] = self.jobs('fix')
        self.assertEqual(self.title(fix.thread_id), 'Answer: ' + FIX)
        self.t3.set_status(fix.thread_id, 'completed')
        r.run_pass()
        self.assertEqual(self.title(fix.thread_id), FIX)
        self.assertTrue(self.t3.threads[fix.thread_id].settled)


if __name__ == '__main__':
    unittest.main()
