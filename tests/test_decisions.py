"""Decision threads: the answer block parsed (an unreadable one is a stop), and each case and action
through the real `Runner`, with GitHub, T3, git and Sol faked."""
import io
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.decisions import QUESTIONS, parse, read_reply
from queue_runner.fix import fix_branch
from queue_runner.github import Comment
from queue_runner.ledger import RUNNER_MARK, runner_post
from queue_runner.run import Runner
from queue_runner.stops import held
from queue_runner.t3 import Message, T3Error
from tests.fakes import FakeGitHubForReviews, FakeToaster, full_pr, issue
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3, decision_reply
from tests.test_ledger import H2, H3, important, old_marker

LATER = '2099-01-01T00:00:00Z'
THREAD1 = 'https://app.t3.codes/threads/env/mcp:t1'


class ParseTest(unittest.TestCase):
    def test_each_allowed_action_is_read_with_its_fields(self):
        a = parse(decision_reply('retry', add='Run npm ci first.'), QUESTIONS['failed'])
        self.assertEqual((a.action, a.fields, a.unreadable), ('retry', {'add': 'Run npm ci first.'},
                                                              None))
        a = parse(decision_reply('carry-on'), QUESTIONS['reply'])
        self.assertEqual((a.action, a.fields), ('carry-on', {}))
        a = parse(decision_reply('approach-note', note='Wrong layer.', recommend='Fix on'),
                  QUESTIONS['approach-note'])
        self.assertEqual(a.fields, {'note': 'Wrong layer.', 'recommend': 'fix on'})

    def test_the_last_block_counts(self):
        text = decision_reply('stop', question='Q?') + decision_reply('carry-on', prose='')
        self.assertEqual(parse(text, QUESTIONS['reply']).action, 'carry-on')

    def test_anything_unreadable_is_a_stop_that_says_why(self):
        cases = {
            'Just prose, no block.': 'no queue-runner-decision block',
            '```queue-runner-decision\n{not json\n```': 'not JSON',
            '```queue-runner-decision\n[1]\n```': 'not a JSON object',
            decision_reply('carry-on', version=2): 'version 2, not 1',
            decision_reply('merge'): "action 'merge' is not one",
            decision_reply('retry'): 'retry needs a non-empty "add"',
            decision_reply('retry', add='  '): 'retry needs a non-empty "add"',
            decision_reply('approach-note', note='N', recommend='merge'): "recommend 'merge'",
            None: 'no queue-runner-decision block',
        }
        for text, why in cases.items():
            allowed = QUESTIONS['approach-note'] if text and 'approach' in text else \
                QUESTIONS['failed'] if text and 'retry' in text else QUESTIONS['reply']
            a = parse(text, allowed)
            self.assertEqual(a.action, 'stop', text)
            self.assertIn(why, a.unreadable, text)
            self.assertIn(why, a.fields['question'])

    def test_an_action_another_question_allows_is_a_stop_here(self):
        self.assertEqual(parse(decision_reply('fix', add='x'), QUESTIONS['failed']).action, 'stop')

    def test_stefans_answer_to_an_approach_note_is_his_newest_words(self):
        def said(*bodies):
            return tuple(Comment('stefan1575', LATER, b) for b in bodies)
        self.assertEqual(read_reply(said('Hold for now.')).action, 'hold')
        a = read_reply(said('hold', '**Fix on**, but skip F2.'))
        self.assertEqual(a.action, 'fix')
        self.assertIn('fix on', a.fields['add'])
        self.assertIn('> **Fix on**, but skip F2.', a.fields['add'])
        self.assertIn('rework', read_reply(said('Rework: split the hook.')).fields['add'])
        self.assertIsNone(read_reply(said('rework', 'Hmm, not sure yet.')))
        self.assertIsNone(read_reply(said('Holding pattern? Explain F1.')))
        self.assertIsNone(read_reply(()))

    def test_the_runners_own_posts_are_marked(self):
        self.assertTrue(runner_post(f'## Approach note\n\n{RUNNER_MARK}approach-note sha=x -->'))


class DecisionTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github='owner/first', path=self.dir)
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.gh = FakeGitHubForReviews(
            issues=[issue(4, 'Blue widget', 'Make it blue.')],
            prs=[full_pr(20, 'claude/red-5', H2, title='Red widget', body='Makes it red.')],
            comments={20: [Comment('stefan1575', '2026-11-09T10:00:00Z',
                                   old_marker(3, 'blocking', H2, [important('F7')]))]},
            issue_bodies={})
        self.git = FakeReviewGit(heads={20: H2})
        self.toaster = FakeToaster()
        self.said = []

    def runner(self, *outcomes, sol=()):
        self.t3 = FakeT3(list(outcomes))
        self.r = Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=io.StringIO(),
                        log_line=self.said.append, sol=FakeSol(list(sol)), toaster=self.toaster)
        return self.r

    def jobs(self, kind):
        return [j for j in self.r.jobs.jobs() if j.kind == kind]

    def calls(self, kind):
        return [p[1:] for p in self.gh.posts if p[0] == kind]

    def review_3(self, outcome='approach-note'):
        j = self.r.jobs.started(kind='review', repo='first', issue=20, branch='claude/red-5',
                                title='t', sha=H2, round=3)
        self.r.jobs.ended(j.id, exit_code=None, outcome=outcome, verdict='blocking',
                          link='https://github.com/owner/first/pull/20#issuecomment-3')

    def noted(self):
        """Review 3 on H2 is still blocking and the decision thread wrote its Approach note."""
        r = self.runner((0, 'completed', decision_reply(
            'approach-note', note='The hook writes in two places; F7 keeps coming back.',
            recommend='rework')), (0, 'completed'))
        self.review_3()
        self.assertEqual(r.run_pass(), 'started')
        return r

    def answer(self, body, on=20):
        self.gh.comments.setdefault(on, []).append(Comment('stefan1575', LATER, body))
        self.r.reviewer.review_pass()   # the Sol lane reads the answer

    # --- the Approach note ----------------------------------------------------------------

    def test_review_3_still_blocking_gets_an_approach_note_posted_and_a_stop_for_stefan(self):
        self.noted()
        [start] = self.t3.starts
        self.assertEqual((start['title'], start['worktree'], start['model']),
                         ('Queue runner decision: first#20', None, self.config.claude_model))
        brief = start['message']
        self.assertIn("Sol's review 3 of PR #20's head `bbbbbbb` is still blocking", brief)
        self.assertIn('**F7**', brief)                         # the open finding, from the ledger
        self.assertIn('"write logged wrongly"', brief)         # its class
        self.assertIn('`approach-note` with `note`, `recommend`', brief)
        self.assertNotIn('`retry`', brief)
        [(n, note), (pr_n, stop_comment)] = [c for c in self.calls('comment')]
        self.assertEqual(n, 20)
        self.assertIn('## Approach note\n\nThe hook writes in two places', note)
        self.assertIn('**Recommendation:** rework.', note)
        self.assertIn(f'{RUNNER_MARK}approach-note sha={H2} round=3 -->', note)
        self.assertIn('Still blocking after review 3', stop_comment)
        [(title, body, labels)] = self.calls('issue')
        self.assertIn('the Approach note recommends rework', body)
        [stop] = self.jobs('stop')
        self.assertEqual((stop.stop, stop.outcome), ('approach-note', 'filed'))
        [d] = self.jobs('decision')
        self.assertEqual((d.question, d.outcome, d.link),
                         ('approach-note', 'approach-note',
                          'https://github.com/owner/first/pull/20#issuecomment-901'))
        self.assertEqual(len(self.toaster.toasts), 1)
        # decided once
        self.assertEqual(self.r.run_pass(), 'started')   # nothing else: a build of #4
        self.assertEqual(len(self.jobs('decision')), 1)

    def test_an_unreadable_approach_note_still_stops_for_stefan(self):
        r = self.runner((0, 'completed', 'I think it is fine.'))
        self.review_3()
        r.run_pass()
        self.assertFalse(any('## Approach note' in c[1] for c in self.calls('comment')))
        [stop] = self.jobs('stop')
        self.assertEqual(stop.stop, 'approach-note')
        self.assertIn('no Approach note was written', stop.reason)
        self.assertIn('no queue-runner-decision block', stop.reason)
        [d] = self.jobs('decision')
        self.assertEqual((d.outcome, d.error), ('stop', 'it has no queue-runner-decision block'))

    def test_no_fourth_review_runs_without_stefans_answer_even_on_a_new_head(self):
        self.noted()
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        self.assertEqual(self.r.reviewer.review_pass(), 'idle')
        self.answer('Hmm, looks odd.')   # answered, but not yet decided
        self.assertEqual(self.r.reviewer.review_pass(), 'idle')
        self.assertIn('a decision on his reply comes first', held(self.r.jobs, self.repo, 20))

    def test_an_approach_note_filing_that_failed_is_filed_by_the_sol_lane(self):
        self.gh.fail.add('issue')
        self.noted()
        self.assertEqual([s.outcome for s in self.jobs('stop')], ['failed'])
        self.gh.fail.discard('issue')
        self.r.reviewer.review_pass()
        self.assertEqual([s.outcome for s in self.jobs('stop')], ['failed', 'filed'])
        self.assertIn('recommends rework', self.jobs('stop')[-1].reason)

    # --- Stefan's answer ------------------------------------------------------------------

    def test_fix_on_read_from_the_pr_orders_one_fix_round_with_his_words_first(self):
        self.noted()
        self.answer('Fix on, F7 is real.')
        self.t3.outcomes = [(0, 'completed')]
        self.assertEqual(self.r.run_pass(), 'started')   # the decision: no thread
        self.assertEqual(len(self.t3.starts), 1)
        [_, d] = self.jobs('decision')
        self.assertEqual((d.question, d.outcome, d.thread_id), ('reply', 'fix', None))
        self.assertIsNone(held(self.r.jobs, self.repo, 20))
        self.r.run_pass()
        start = self.t3.starts[-1]
        self.assertEqual((start['worktree'], start['branch']), (H2, fix_branch(20, H2)))
        self.assertIn('## Direction first', start['message'])
        self.assertIn('Stefan chose **fix on**', start['message'])
        self.assertIn('> Fix on, F7 is real.', start['message'])
        # one round: it ended without pushing, so the PR comes back to Stefan
        self.assertIsNone(self.r.next_fix())

    def test_rework_read_from_the_needs_info_issue_is_a_fix_round_told_to_rework(self):
        self.noted()
        self.answer('Rework it: one write path.', on=902)
        self.t3.outcomes = [(0, 'completed')]
        self.r.run_pass()
        self.r.run_pass()
        self.assertIn('Stefan chose **rework**', self.t3.starts[-1]['message'])

    def test_hold_leaves_the_pr_alone_until_a_release(self):
        self.noted()
        self.answer('hold')
        self.r.run_pass()
        self.assertIn('Stefan said hold', held(self.r.jobs, self.repo, 20))
        self.assertIsNone(self.r.next_fix())
        self.r.jobs.released('first', 20)
        self.assertIsNone(held(self.r.jobs, self.repo, 20))

    def test_a_reply_the_runner_cant_read_goes_to_a_decision_thread(self):
        self.noted()
        self.answer('Why does F7 keep coming back? Try once more, but only F7.')
        self.t3.outcomes = [(0, 'completed', decision_reply('fix', add='Fix F7 only.'))]
        self.r.run_pass()
        brief = self.t3.starts[-1]['message']
        self.assertIn('What does his reply ask the runner to do?', brief)
        self.assertIn('> Why does F7 keep coming back?', brief)
        d = self.jobs('decision')[-1]
        self.assertEqual((d.outcome, d.reason, d.link), ('fix', 'Fix F7 only.',
                                                         'https://app.t3.codes/threads/env/mcp:t2'))
        self.assertIsNotNone(self.r.next_fix())

    def test_carry_on_lets_the_loop_go_on_and_a_stop_files_the_threads_question(self):
        self.noted()
        self.answer('Ok whatever you think.')
        self.t3.outcomes = [(0, 'completed', decision_reply('carry-on'))]
        self.r.run_pass()
        self.assertIsNone(held(self.r.jobs, self.repo, 20))
        self.assertIsNone(self.r.next_fix())   # carry on: H was reviewed; a push gets review 4

    def test_a_reply_decision_that_stops_files_a_decision_stop(self):
        self.noted()
        self.answer('Not sure.')
        self.t3.outcomes = [(0, 'completed', decision_reply('stop', question='Rework or hold?'))]
        self.r.run_pass()
        stop = self.jobs('stop')[-1]
        self.assertEqual((stop.stop, stop.reason, stop.outcome),
                         ('decision', 'Rework or hold?', 'filed'))
        self.assertIn('stopped for Stefan (a decision needs you)',
                      held(self.r.jobs, self.repo, 20))

    # --- jobs that ended failed, waiting or without a PR -----------------------------------

    def build(self, *outcomes):
        """A build of #4 that ends with the first outcome; the rest are for what follows."""
        self.gh.prs = []
        r = self.runner(*outcomes)
        r.run_pass()
        return r

    def test_a_failed_build_retried_carries_on_in_its_thread_as_a_new_job(self):
        self.build((1, 'failed'),
                   (0, 'completed', decision_reply('retry', add='Install deps first.')),
                   (0, 'completed'))
        self.t3.messages['mcp:t1'] = [Message('assistant', 'npm test failed: missing module')]
        self.assertEqual(self.r.run_pass(), 'started')
        brief = self.t3.starts[1]['message']
        self.assertIn('the build thread for issue #4 ended failed (exit 1)', brief)
        self.assertIn('npm test failed: missing module', brief)
        self.assertIn('`close` with `reason`', brief)
        [send] = self.t3.sends
        self.assertEqual(send['thread_id'], 'mcp:t1')
        self.assertIn('Install deps first.', send['message'])
        first, second = self.jobs('build')
        self.assertEqual((second.about, second.thread_id, second.outcome),
                         (first.id, 'mcp:t1', 'done-no-pr'))
        self.assertEqual(first.outcome, 'failed')
        self.assertEqual(self.r.jobs.held_issues('first'), {4})

    def test_a_waiting_build_answered_by_a_decision_continues_and_the_old_job_is_done(self):
        self.build((2, 'waiting'), (0, 'completed', decision_reply('answer', text='Use blue.')),
                   (0, 'completed'))
        self.r.run_pass()
        self.assertIn('The answer to your question', self.t3.sends[0]['message'])
        first, second = self.jobs('build')
        self.assertEqual((first.outcome, second.outcome), ('continued', 'done-no-pr'))
        self.assertEqual(self.r.jobs.waiting_jobs(), [])
        self.assertEqual(self.toaster.toasts, [])

    def test_a_build_without_a_pr_closed_as_not_needed(self):
        self.build((0, 'completed'),
                   (0, 'completed', decision_reply('close', reason='#3 did it already.')))
        self.r.run_pass()
        [(n, said)] = self.calls('comment')
        self.assertEqual(n, 4)
        self.assertIn('closed this issue as not needed: #3 did it already.', said)
        self.assertEqual(self.calls('close'), [(4,)])
        self.assertEqual(self.jobs('decision')[0].outcome, 'close')

    def test_a_failed_build_the_thread_cant_decide_stops_on_the_issue(self):
        self.build((1, 'failed'), (1, 'failed'))
        self.r.run_pass()
        [(n, said)] = self.calls('comment')
        self.assertEqual(n, 4)
        self.assertIn('the decision thread ended failed (exit 1)', said)
        [t] = self.toaster.toasts
        self.assertIn('#issuecomment-', t['url'])
        self.assertEqual(self.jobs('decision')[0].outcome, 'stop')

    def test_t3_failing_before_a_decision_thread_is_tried_again_next_pass(self):
        self.build((1, 'failed'), T3Error('T3 is down'),
                   (0, 'completed', decision_reply('stop', question='?')))
        self.r.run_pass()
        self.assertEqual(self.jobs('decision')[0].outcome, 'not-started')
        self.r.run_pass()
        self.assertEqual([d.outcome for d in self.jobs('decision')], ['not-started', 'stop'])

    def test_a_decision_cut_off_with_its_runner_is_decided_again(self):
        r = self.build((1, 'failed'), (0, 'completed', decision_reply('stop', question='?')))
        first = self.jobs('build')[0]
        r.jobs.started(kind='decision', repo='first', issue=4, branch=None, title='t',
                       about=first.id, question='failed')
        r.run_pass()
        self.assertEqual([d.outcome for d in self.jobs('decision')], ['not-started', 'stop'])

    def test_after_three_decisions_the_next_goes_straight_to_stefan(self):
        retry = (0, 'completed', decision_reply('retry', add='Again.'))
        self.build((1, 'failed'), retry, (1, 'failed'), retry, (1, 'failed'), retry, (1, 'failed'))
        for _ in range(4):
            self.r.run_pass()
        self.assertEqual(len(self.t3.starts), 4)   # the build and three decision threads
        self.assertEqual(len(self.t3.sends), 3)
        last = self.jobs('decision')[-1]
        self.assertEqual((last.outcome, last.thread_id), ('stop', None))
        self.assertIn('3 decisions on this build already', last.reason)

    def test_a_released_build_gets_no_decision(self):
        self.build((1, 'failed'))
        self.r.jobs.released('first', 4)
        self.assertIsNone(self.r.decider.next_case())

    def test_a_failed_fix_round_can_be_retried_but_not_closed(self):
        r = self.runner((1, 'failed'), (0, 'completed', decision_reply('close', reason='x')))
        j = r.jobs.started(kind='review', repo='first', issue=20, branch='claude/red-5',
                           title='t', sha=H2, round=1)
        r.jobs.ended(j.id, exit_code=None, outcome='blocking')
        self.gh.comments[20] = [Comment('stefan1575', '2026-11-09T10:00:00Z',
                                        old_marker(1, 'blocking', H2, [important('F7')]))]
        r.run_pass()   # the fix round fails without pushing
        self.assertEqual(self.jobs('fix')[0].outcome, 'failed')
        r.run_pass()
        brief = self.t3.starts[1]['message']
        self.assertIn('the fix thread for PR #20 ended failed', brief)
        self.assertNotIn('`close`', brief)
        stop = self.jobs('stop')[-1]
        self.assertEqual(stop.stop, 'decision')
        self.assertIn("action 'close' is not one this question allows", stop.reason)


if __name__ == '__main__':
    unittest.main()
