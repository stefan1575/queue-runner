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

    def test_a_quiet_pass_calls_t3_for_nothing(self):
        self.opened()
        self.t3.outcomes = [(0, 'completed')]   # the build of #4
        self.r.run_pass()
        self.r.run_pass()
        self.t3.lists.clear()
        self.r.plan()
        self.r.plan()
        self.assertEqual(self.t3.lists, [])

    def test_titles_are_kept_right_while_a_dead_runners_job_runs_on(self):
        ask = self.opened()
        self.says(ask, Message('assistant', 'The case: ...'), status='completed')
        self.r.jobs.released('first', 20)
        # A dead runner's build of #4 runs on in T3: the pass starts nothing (review 1's F4).
        self.r.jobs.started(kind='build', repo='first', issue=4, branch='claude/blue-4',
                            title=BUILD)
        self.t3.add('mcp:dead', BUILD, 'running')
        self.assertEqual(self.r.plan(), 'busy')
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

    def reply(self, n, text, at='2099-01-01T00:00:00Z'):
        self.gh.comments.setdefault(n, []).append(Comment('stefan1575', at, text))

    def test_answered_on_github_his_reply_goes_to_the_thread_and_it_is_settled(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.reply(4, 'Blue, the darker one.')
        self.t3.outcomes = [(0, 'completed')]   # the thread carries on with his answer
        self.assertEqual(self.r.run_pass(), 'started')
        [sent] = self.t3.sends
        self.assertEqual(sent['thread_id'], build.thread_id)
        self.assertIn('Stefan answered your question on GitHub', sent['message'])
        self.assertIn('> Blue, the darker one.', sent['message'])
        old, new = self.jobs('build')
        self.assertEqual((old.outcome, old.reason), ('continued', 'github'))
        self.assertEqual(new.about, old.id)
        self.r.run_pass()
        self.assertEqual(self.title(build.thread_id), BUILD)
        self.assertTrue(self.t3.threads[build.thread_id].settled)
        self.assertEqual(len(self.t3.sends), 1)   # sent once

    def test_it_asks_again_after_his_github_answer_and_keeps_its_prefix(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.reply(4, 'Blue.')
        self.t3.outcomes = [(2, 'waiting'),   # it asks another question
                            (0, 'completed', decision_reply('stop', question='Which blue?'))]
        self.r.run_pass()
        self.r.run_pass()   # the new question's decision leaves it to Stefan too
        self.r.run_pass()
        self.assertEqual([j.outcome for j in self.jobs('build')], ['continued', 'waiting'])
        self.assertEqual(self.title(build.thread_id), 'Answer: ' + BUILD)
        self.assertFalse(self.t3.threads[build.thread_id].settled)
        self.assertEqual(len(self.t3.sends), 1)   # the old reply isn't sent again

    def test_words_from_before_the_question_are_no_answer(self):
        build = self.stopped_build()
        self.reply(4, 'Make it pop.', at='2026-01-01T00:00:00Z')
        self.r.run_pass()
        self.r.run_pass()
        self.assertEqual(self.t3.sends, [])
        self.assertEqual(self.title(build.thread_id), 'Answer: ' + BUILD)

    def test_its_issue_closed_on_github_ends_it_and_the_prefix_comes_off(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.gh.states[4] = 'closed'
        self.r.run_pass()
        [j] = self.jobs('build')
        self.assertEqual((j.outcome, j.reason), (
            'closed', 'its issue #4 was closed on GitHub while it waited for Stefan'))
        self.assertEqual(self.t3.sends, [])
        self.assertEqual(self.title(build.thread_id), BUILD)
        self.assertTrue(self.t3.threads[build.thread_id].settled)

    def test_github_failing_is_said_once_and_read_again(self):
        build = self.stopped_build()
        self.r.run_pass()
        self.gh.states = {}   # issue_state raises below
        self.gh.issue_state = lambda github, n: (_ for _ in ()).throw(RuntimeError('HTTP 502'))
        self.r.plan()
        self.r.plan()
        line = ('build first#4: reading GitHub for an answer to its question failed (HTTP 502); '
                'next pass')
        self.assertEqual(self.said.count(line), 1)
        self.assertEqual(self.title(build.thread_id), 'Answer: ' + BUILD)

    def stopped_fix(self):
        """A fix round on PR #20 that asked a question, which a decision left to Stefan."""
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
        return fix

    def test_its_pr_merged_on_github_ends_the_fix_round_and_the_prefix_comes_off(self):
        fix = self.stopped_fix()
        self.gh.now[20] = {'state': 'merged'}
        self.r.run_pass()
        [j] = self.jobs('fix')
        self.assertEqual((j.outcome, j.reason), (
            'closed', 'its PR #20 was merged on GitHub while it waited for Stefan'))
        self.assertEqual(self.title(fix.thread_id), FIX)
        self.assertTrue(self.t3.threads[fix.thread_id].settled)

    def test_a_reply_on_the_pr_goes_to_the_waiting_fix_round(self):
        fix = self.stopped_fix()
        self.reply(20, 'Keep F7 as it is.')
        self.t3.outcomes = [(0, 'completed')]
        self.r.run_pass()
        [sent] = self.t3.sends
        self.assertEqual(sent['thread_id'], fix.thread_id)
        self.assertIn('> Keep F7 as it is.', sent['message'])
        self.assertIn('https://github.com/owner/first/issues/20', sent['message'])

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
