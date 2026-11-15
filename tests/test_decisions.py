"""Decision threads: the answer block parsed (an unreadable one is a stop), and each case and action
through the real `Runner`, with GitHub, T3, git and Sol faked."""
import datetime
import io
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.decisions import QUESTIONS, parse, read_reply
from queue_runner.fix import fix_branch
from queue_runner.github import Checks, Comment
from queue_runner.ledger import RUNNER_MARK, runner_post
from queue_runner.run import Runner
from queue_runner.stops import held
from queue_runner.t3 import Message, T3Error
from tests.fakes import FakeGitHubForReviews, FakeLimits, FakeToaster, full_pr, issue
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
        # Every thread's last request started just now, so it's warm and continued in place,
        # unless a test says otherwise (ticket 38).
        self.limits = FakeLimits(default_start=datetime.datetime.now(datetime.timezone.utc))

    def runner(self, *outcomes, sol=()):
        self.t3 = FakeT3(list(outcomes))
        self.r = Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=io.StringIO(),
                        log_line=self.said.append, sol=FakeSol(list(sol)), toaster=self.toaster,
                        limits=self.limits)
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

    def test_another_stops_answer_does_not_lift_the_hold_before_the_approach_note(self):
        r = self.runner()
        self.review_3()
        self.gh.check_states[H2] = Checks('failed', failed=('ci',))
        r.reviewer.review_pass()   # files the failed-check stop; the note isn't written yet
        [stop] = self.jobs('stop')
        self.gh.close_issue(901)   # Stefan closes that one
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        self.gh.check_states.pop(H2)
        self.assertEqual(r.reviewer.review_pass(), 'idle')
        self.assertIn('its Approach note goes to Stefan first', held(r.jobs, self.repo, 20))

    def test_an_approach_note_still_pending_after_a_push_is_written_for_its_review(self):
        r = self.runner((0, 'completed', decision_reply('approach-note', note='N.',
                                                        recommend='hold')))
        self.review_3()
        self.gh.now[20] = {'head_sha': H3}
        r.run_pass()
        self.assertIn(f'sha={H2} round=3', self.calls('comment')[0][1])
        [stop] = self.jobs('stop')
        self.assertEqual((stop.stop, stop.sha), ('approach-note', H2))

    def test_one_reply_answering_two_stops_is_decided_once(self):
        self.noted()
        self.r.reviewer.stopper.file(self.repo, self.gh.pull(self.repo, 20), 'conflict',
                                     'it conflicts with main')
        self.answer('fix on')
        self.assertEqual([s.answer for s in self.jobs('stop')], ['replied', 'replied'])
        self.t3.outcomes = []
        self.r.run_pass()
        [_, d] = self.jobs('decision')
        self.assertEqual((d.about, d.outcome), (self.jobs('stop')[0].id, 'fix'))
        self.assertIsNone(self.r.decider.next_case())

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

    def cold(self, tokens):
        """The build's thread last ran two hours ago and holds `tokens`."""
        two_hours_ago = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)
        self.limits = FakeLimits(contexts={'mcp:t1': tokens}, starts={'mcp:t1': two_hours_ago})
        # A fresh thread's brief is the build's own, read from the issue again.
        self.gh.issue_bodies[('owner/first', 4)] = issue(4, 'Blue widget', 'Make it blue.')

    def test_a_cold_big_thread_retried_starts_fresh_with_the_decision_first(self):
        self.cold(200_000)
        self.git.tips = {'claude/blue-widget-4': 'abc1234def'}
        self.build((1, 'failed'),
                   (0, 'completed', decision_reply('retry', add='Install deps first.')),
                   (0, 'completed'))
        self.t3.messages['mcp:t1'] = [Message('assistant', 'npm test failed: missing module')]
        self.assertEqual(self.r.run_pass(), 'started')
        self.assertEqual(self.t3.sends, [])
        fresh = self.t3.starts[2]
        self.assertEqual((fresh['worktree'], fresh['branch'], fresh['title']),
                         ('abc1234def', 'claude/blue-widget-4', 'Queue runner build: first#4'))
        brief = fresh['message']
        self.assertTrue(brief.startswith('## Direction first\n\nAn earlier thread on this job '
                                         'failed'))
        self.assertIn('Install deps first.', brief)
        self.assertLess(brief.index('Install deps first.'), brief.index('/implement'))
        self.assertIn('## Picking up from an earlier thread', brief)
        self.assertIn('cold (its last request started 2 h ago) and 200,000 tokens', brief)
        self.assertIn('npm test failed: missing module', brief)
        self.assertEqual(self.git.freed, [('claude/blue-widget-4', 'C:/t3/worktrees/mcp:t1')])
        first, second = self.jobs('build')
        self.assertEqual((second.about, second.thread_id, second.outcome),
                         (first.id, 'mcp:t3', 'done-no-pr'))
        self.assertEqual((second.resume['how'], second.resume['context']), ('fresh', 200_000))
        self.assertTrue(any('Restarting build first#4 fresh for the decision (cold' in line
                            for line in self.said))

    def test_a_cold_big_thread_answered_starts_fresh_with_its_question_and_the_answer(self):
        self.cold(150_000)
        self.build((2, 'waiting'), (0, 'completed', decision_reply('answer', text='Use blue.')),
                   (0, 'completed'))
        self.t3.messages['mcp:t1'] = [Message('user', 'Go.'),
                                      Message('assistant', 'Which blue: navy or sky?')]
        self.r.run_pass()
        self.assertEqual(self.t3.sends, [])
        brief = self.t3.starts[2]['message']
        self.assertIn('An earlier thread on this job stopped to ask a question', brief)
        self.assertIn('The earlier thread asked:\n\n> Which blue: navy or sky?', brief)
        self.assertIn('Use blue.', brief)
        self.assertLess(brief.index('Use blue.'), brief.index('/implement'))
        first, second = self.jobs('build')
        self.assertEqual((first.outcome, second.outcome), ('continued', 'done-no-pr'))
        self.assertEqual(self.r.jobs.waiting_jobs(), [])

    def test_a_cold_thread_under_120k_tokens_retried_carries_on_in_place(self):
        self.cold(119_000)
        self.build((1, 'failed'),
                   (0, 'completed', decision_reply('retry', add='Again.')), (0, 'completed'))
        self.r.run_pass()
        self.assertEqual([s['thread_id'] for s in self.t3.sends], ['mcp:t1'])
        second = self.jobs('build')[1]
        self.assertEqual((second.resume['how'], second.resume['idle_minutes']), ('in-place', 120))

    def test_a_message_that_never_reaches_the_thread_leaves_the_case_to_decide_again(self):
        self.build((2, 'waiting'), (0, 'completed', decision_reply('answer', text='Blue.')),
                   T3Error('T3 is down'),
                   (0, 'completed', decision_reply('answer', text='Blue.')), (0, 'completed'))
        self.assertEqual(self.r.run_pass(), 'idle')
        first, second = self.jobs('build')
        self.assertEqual((first.outcome, second.outcome), ('waiting', 'not-sent'))
        self.assertEqual(self.jobs('decision')[0].outcome, 'not-started')
        self.assertEqual(self.r.jobs.held_issues('first'), {4})
        self.r.run_pass()
        self.assertEqual([j.outcome for j in self.jobs('build')],
                         ['continued', 'not-sent', 'done-no-pr'])

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
