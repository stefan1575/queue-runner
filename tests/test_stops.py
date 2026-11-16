"""Stops for Stefan: each kind detected and filed (the PR's needs-info issue, a comment on the PR,
a toast), a second stop added to the open issue, the PR left alone until Stefan answers, with
GitHub, git, Sol and the toaster faked."""
import datetime
import io
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Comment, WorkflowRun
from queue_runner.ledger import RUNNER_MARK, STOP_MARK
from queue_runner.merge import Merger
from queue_runner.review import Reviewer
from queue_runner.run import Runner
from queue_runner.state import JobLog
from queue_runner.stops import NEEDS_INFO, conflict_stop, held, needs_info_mark
from queue_runner.toast import toast_xml, WindowsToaster
from tests.fakes import FakeGitHubWithPulls, FakeGitHubForReviews, FakeToaster, \
    full_pr, issue
from tests.fakes_t3 import FakeGit, FakeReviewGit, FakeSol, FakeT3, decision_reply
from tests.test_ledger import H2, H3, important, old_marker, reply

NOW = datetime.datetime(2026, 11, 9, 12, 0)
LATER = '2099-01-01T00:00:00Z'    # after any stop the test files
EARLIER = '2026-01-01T00:00:00Z'  # before it
ISSUE_URL = 'https://github.com/owner/first/issues/901'
BASE1, BASE2 = '4' * 40, '5' * 40   # main's tip, as two conflict rounds merged it


class StopsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github='owner/first', path=self.dir)
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.said = []
        self.gh = FakeGitHubForReviews(prs=[full_pr(20, 'claude/red-5', H2, title='Red widget',
                                                    body='Makes it red.')])
        self.git = FakeReviewGit(heads={20: H2})
        self.toaster = FakeToaster()

    def reviewer(self, *replies, merger=False):
        self.sol = FakeSol(list(replies))
        return Reviewer(self.config, github=self.gh, git=self.git, sol=self.sol, jobs=self.jobs,
                        say=self.said.append, now=lambda: NOW, merger=merger,
                        toaster=self.toaster)

    def calls(self, kind):
        return [p[1:] for p in self.gh.posts if p[0] == kind]

    def stops(self):
        return [j for j in self.jobs.jobs() if j.kind == 'stop']

    def fail_check(self, sha=H2):
        self.gh.check_states[sha] = Checks('failed', failed=('ci',))

    def conflict_rounds(self, *bases, released=False):
        """A pushed conflict round on an earlier head per base it merged (None: a record from
        before issue #91, with no base)."""
        for i, base in enumerate(bases, 1):
            j = self.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                                  title='Queue runner conflict: first#20', sha=str(i) * 40,
                                  cause='conflict', base=base)
            self.jobs.ended(j.id, exit_code=0, outcome='pushed')

    def conflict_stops(self):
        """The PR conflicts again with the base its last conflict round merged, which hasn't
        moved: a stop (issue #91)."""
        self.conflict_rounds(BASE1, BASE2)
        self.gh.now[20] = {'base_sha': BASE2}
        self.gh.conflicts.add(20)

    def conflict_says(self):
        """The conflict stop on PR #20 now, or None (`stops.conflict_stop`)."""
        return conflict_stop(self.jobs, self.repo, self.gh.pull(self.repo, 20))

    def review_ended(self, outcome, round=1, signals=(), sha=H2):
        j = self.jobs.started(kind='review', repo='first', issue=20, branch='claude/red-5',
                              title='t', sha=sha, round=round)
        self.jobs.ended(j.id, exit_code=None, outcome=outcome, signals=list(signals),
                        link='https://github.com/owner/first/pull/20#issuecomment-1')

    # --- each kind is filed ---------------------------------------------------------------

    def test_a_failed_check_files_a_needs_info_issue_records_it_on_the_pr_and_toasts(self):
        self.fail_check()
        self.assertEqual(self.reviewer().review_pass(), 'idle')
        [(title, body, labels)] = self.calls('issue')
        self.assertEqual(labels, (NEEDS_INFO,))
        self.assertEqual(title, 'PR #20 needs Stefan: Red widget')
        self.assertIn(needs_info_mark('owner/first', 20), body)
        self.assertIn(f'a check failed on {H2[:7]} (ci)', body)
        [(n, said)] = self.calls('comment')
        self.assertEqual(n, 20)
        self.assertIn('Tracked in #901', said)
        self.assertIn(f'{STOP_MARK}kind=failed-check sha={H2} issue=901 -->', said)
        [t] = self.toaster.toasts
        self.assertEqual((t['title'], t['url']), ('first PR #20 needs you', ISSUE_URL))
        self.assertIn('A check failed', t['text'])
        [stop] = self.stops()
        self.assertEqual((stop.stop, stop.sha, stop.outcome, stop.link),
                         ('failed-check', H2, 'filed', ISSUE_URL))

    # --- a failed Actions check is re-run once per head first (issue #93) ------------------

    RUN = 'https://github.com/owner/first/actions/runs/437'

    def fail_actions(self, sha=H2, attempt=1, status='completed'):
        """CI's Actions run 437 failed on `sha`, its latest attempt `attempt`."""
        self.gh.check_states[sha] = Checks('failed', failed=('tests',), runs=(437,))
        self.gh.workflow_runs[437] = WorkflowRun(437, attempt, status, 'failure', self.RUN)

    def test_a_first_failed_actions_check_is_re_run_and_is_no_stop(self):
        self.fail_actions()
        self.reviewer().review_pass()
        self.assertEqual(self.calls('rerun'), [(437,)])
        self.assertEqual(self.stops(), [])
        self.assertEqual(self.calls('issue'), [])
        self.assertTrue(any('re-running the failed jobs of run 437' in s for s in self.said),
                        self.said)
        # While the re-run runs (GitHub may still list the old failure), still no stop, and it
        # isn't re-run twice.
        self.reviewer().review_pass()
        self.gh.check_states[H2] = Checks('pending', pending=('tests',))
        self.reviewer().review_pass()
        self.assertEqual((len(self.calls('rerun')), self.stops()), (1, []))

    def test_a_check_that_fails_again_on_its_re_run_is_a_stop(self):
        self.fail_actions()
        self.reviewer().review_pass()
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'failure', self.RUN)
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertEqual((stop.stop, stop.sha), ('failed-check', H2))
        self.assertIn(f'a check failed on {H2[:7]} (tests) again after one re-run '
                      f'(attempt 2 of [run 437]({self.RUN}/attempts/2))', stop.reason)
        self.assertEqual(len(self.calls('rerun')), 1)

    def test_a_re_run_that_passes_is_said_on_the_pr_and_the_loop_carries_on(self):
        self.fail_actions()
        self.reviewer().review_pass()
        self.gh.check_states[H2] = Checks('passed')
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'success', self.RUN)
        self.reviewer(reply()).review_pass()
        self.assertEqual(self.stops(), [])
        said = [b for n, b in self.calls('comment') if 'passed on a re-run' in b]
        self.assertEqual(len(said), 1, self.calls('comment'))
        self.assertIn(f'tests failed on {H2[:7]} in attempt 1 of [run 437]'
                      f'({self.RUN}/attempts/1) and passed on a re-run', said[0])
        self.assertIn(RUNNER_MARK, said[0])   # not a reply from Stefan
        self.assertEqual(len(self.sol.briefs), 1)   # Sol reviewed H2: the loop carried on
        self.reviewer().review_pass()
        self.assertEqual(len([1 for n, b in self.calls('comment')
                              if 'passed on a re-run' in b]), 1)

    def test_a_new_head_gets_its_own_re_run(self):
        self.fail_actions()
        self.reviewer().review_pass()
        self.gh.prs = [full_pr(20, 'claude/red-5', H3, title='Red widget')]
        self.git.heads[20] = H3
        self.fail_actions(sha=H3, attempt=2)   # the same run's next attempt, on the new head
        self.gh.check_states[H3] = Checks('failed', failed=('tests',), runs=(438,))
        self.gh.workflow_runs[438] = WorkflowRun(438, 1, 'completed', 'failure', self.RUN)
        self.reviewer().review_pass()
        self.assertEqual(self.calls('rerun'), [(437,), (438,)])
        self.assertEqual(self.stops(), [])

    def test_a_run_already_re_run_by_hand_is_a_stop_at_once(self):
        self.fail_actions(attempt=2)
        self.reviewer().review_pass()
        self.assertEqual(self.calls('rerun'), [])
        [stop] = self.stops()
        self.assertEqual(stop.stop, 'failed-check')

    def test_a_failed_commit_status_can_t_be_re_run_and_stops_at_once(self):
        self.gh.check_states[H2] = Checks('failed', failed=('deploy',))   # no Actions run
        self.reviewer().review_pass()
        self.assertEqual(self.calls('rerun'), [])
        [stop] = self.stops()
        self.assertEqual(stop.stop, 'failed-check')
        self.assertIn(f'a check failed on {H2[:7]} (deploy)', stop.reason)

    def test_a_re_run_github_refuses_is_a_stop(self):
        self.fail_actions()
        self.gh.fail.add('rerun')
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertIn('re-running it failed', stop.reason)

    # --- PR #105's review 1 -------------------------------------------------------------------

    RUN2 = 'https://github.com/owner/first/actions/runs/440'

    def test_f1_a_later_run_that_fails_gets_its_own_re_run_then_its_stop(self):
        # Run 437 fails while run 440 is still going: 437 is re-run and passes.
        self.fail_actions()
        self.reviewer().review_pass()
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'success', self.RUN)
        # Then 440 fails on its first attempt: it gets its own re-run, not a stall.
        self.gh.check_states[H2] = Checks('failed', failed=('lint',), runs=(440,))
        self.gh.workflow_runs[440] = WorkflowRun(440, 1, 'completed', 'failure', self.RUN2)
        self.reviewer().review_pass()
        self.assertEqual(self.calls('rerun'), [(437,), (440,)])
        self.assertEqual(self.stops(), [])
        # 440 fails again: now it's a stop.
        self.gh.workflow_runs[440] = WorkflowRun(440, 2, 'completed', 'failure', self.RUN2)
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertIn(f'again after one re-run (attempt 2 of [run 440]({self.RUN2}/attempts/2))',
                      stop.reason)
        self.assertEqual(len(self.calls('rerun')), 2)

    def test_f2_a_re_run_cut_off_before_github_was_asked_is_asked_next_pass(self):
        # A runner died after writing the re-run's start record, before the POST.
        self.fail_actions()
        self.jobs.started(kind='rerun', repo='first', issue=20, branch='claude/red-5',
                          title='Queue runner rerun: first#20', sha=H2, reason='tests',
                          runs=[{'id': 437, 'attempt': 1, 'url': self.RUN}])
        self.reviewer().review_pass()
        self.assertEqual(self.calls('rerun'), [(437,)])
        self.assertEqual(self.stops(), [])
        self.assertEqual([j.outcome for j in self.jobs.on('rerun', 'first', 20, H2)],
                         ['not-started', 'rerun'])
        # And it fails again: a stop, as for any re-run.
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'failure', self.RUN)
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertIn('again after one re-run', stop.reason)

    def test_f2_a_re_run_cut_off_after_github_was_asked_counts_as_the_runners(self):
        self.fail_actions(attempt=2, status='in_progress')
        self.jobs.started(kind='rerun', repo='first', issue=20, branch='claude/red-5',
                          title='Queue runner rerun: first#20', sha=H2, reason='tests',
                          runs=[{'id': 437, 'attempt': 1, 'url': self.RUN}])
        self.reviewer().review_pass()
        self.assertEqual((self.calls('rerun'), self.stops()), ([], []))
        self.assertEqual([j.outcome for j in self.jobs.on('rerun', 'first', 20, H2)], ['rerun'])

    def test_f3_a_pass_on_the_re_run_is_said_once_posting_works_again(self):
        self.fail_actions()
        self.reviewer().review_pass()
        self.gh.check_states[H2] = Checks('passed')
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'success', self.RUN)
        self.gh.fail.add('comment')
        self.reviewer().review_pass()
        self.assertEqual([j.outcome for j in self.jobs.on('rerun', 'first', 20, H2)], ['rerun'])
        self.gh.fail.discard('comment')
        self.reviewer().review_pass()
        self.reviewer().review_pass()
        said = [b for n, b in self.calls('comment') if 'passed on a re-run' in b]
        self.assertEqual(len(said), 1, self.calls('comment'))
        self.assertEqual([j.outcome for j in self.jobs.on('rerun', 'first', 20, H2)], ['passed'])

    def test_f3_a_pass_said_before_its_record_was_written_is_not_said_twice(self):
        self.fail_actions()
        self.reviewer().review_pass()
        [job] = self.jobs.on('rerun', 'first', 20, H2)
        self.gh.post_comment(self.repo, 20, f'said\n\n{RUNNER_MARK}rerun passed sha={H2} '
                                            f'run=437 -->\n')
        self.gh.check_states[H2] = Checks('passed')
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'success', self.RUN)
        self.reviewer().review_pass()
        self.assertEqual(len([1 for n, b in self.calls('comment') if 'rerun passed' in b]), 1)
        self.assertEqual([j.outcome for j in self.jobs.on('rerun', 'first', 20, H2)], ['passed'])

    def test_f4_a_re_run_that_passed_is_no_stop_while_checks_still_list_the_old_failure(self):
        self.fail_actions()
        self.reviewer().review_pass()
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'success', self.RUN)
        self.reviewer().review_pass()   # check-runs still say failed
        self.assertEqual(self.stops(), [])
        self.assertEqual(len(self.calls('rerun')), 1)

    # --- PR #105's review 2 -------------------------------------------------------------------

    def test_f5_each_re_run_names_only_its_own_runs_checks(self):
        # Runs 437 (tests) and 440 (lint) fail attempt 1 together.
        self.gh.check_states[H2] = Checks('failed', failed=('tests', 'lint'), runs=(437, 440),
                                          by_run=((437, ('tests',)), (440, ('lint',))))
        self.gh.workflow_runs[437] = WorkflowRun(437, 1, 'completed', 'failure', self.RUN)
        self.gh.workflow_runs[440] = WorkflowRun(440, 1, 'completed', 'failure', self.RUN2)
        self.reviewer().review_pass()
        self.assertEqual(sorted(j.reason for j in self.jobs.on('rerun', 'first', 20, H2)),
                         ['lint', 'tests'])
        # 437 passes its re-run, 440 fails again; check-runs still list 437's old failure.
        self.gh.check_states[H2] = Checks('failed', failed=('tests', 'lint'), runs=(437, 440),
                                          by_run=((437, ('tests',)), (440, ('lint',))))
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'success', self.RUN)
        self.gh.workflow_runs[440] = WorkflowRun(440, 2, 'completed', 'failure', self.RUN2)
        self.reviewer().review_pass()
        [said] = [b for n, b in self.calls('comment') if 'passed on a re-run' in b]
        self.assertIn('tests failed on', said)
        self.assertNotIn('lint', said)
        [stop] = self.stops()
        self.assertIn('(lint) again after one re-run (attempt 2 of [run 440]', stop.reason)
        self.assertNotIn('tests', stop.reason)

    def test_f5_a_stop_names_each_runs_own_checks(self):
        self.gh.check_states[H2] = Checks('failed', failed=('tests', 'lint'), runs=(437, 440),
                                          by_run=((437, ('tests',)), (440, ('lint',))))
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'failure', self.RUN)
        self.gh.workflow_runs[440] = WorkflowRun(440, 2, 'completed', 'failure', self.RUN2)
        self.reviewer().review_pass()   # both re-run by hand already: a stop at once
        [stop] = self.stops()
        self.assertIn('(tests) on attempt 2 of [run 437]', stop.reason)
        self.assertIn('(lint) on attempt 2 of [run 440]', stop.reason)

    def test_a_conflict_is_no_stop_until_a_conflict_round_tried(self):
        self.gh.conflicts.add(20)
        self.reviewer().review_pass()
        self.assertEqual(self.stops(), [])
        self.assertTrue(any('a conflict round (or a stop) comes first' in s for s in self.said))

    def test_a_conflict_on_the_base_the_last_round_merged_is_a_stop(self):
        self.conflict_stops()
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertEqual(stop.stop, 'conflict')
        self.assertIn('conflicts with main again at bbbbbbb, though the conflict round on '
                      '2222222 merged main at 5555555 and main has not moved since',
                      stop.reason)

    # --- a conflict after main moved: another round (issue #91) -------------------------

    def test_a_conflict_on_a_new_base_under_the_ceiling_gets_a_round(self):
        self.conflict_rounds(BASE1, BASE2, BASE1, BASE2)   # four rounds, each pushed
        self.gh.now[20] = {'base_sha': '6' * 40}           # main moved since the last
        self.gh.conflicts.add(20)
        self.assertIsNone(self.conflict_says())
        self.reviewer().review_pass()
        self.assertEqual(self.stops(), [])

    def test_a_round_without_a_base_counts_as_a_different_base(self):
        self.conflict_rounds(None, None)
        self.gh.now[20] = {'base_sha': BASE2}
        self.gh.conflicts.add(20)
        self.assertIsNone(self.conflict_says())
        self.gh.now[20] = {'base_sha': ''}   # nor does GitHub not saying the base's tip
        self.conflict_rounds(BASE2)
        self.assertIsNone(self.conflict_says())

    def test_after_five_conflict_rounds_the_next_conflict_is_a_stop(self):
        self.conflict_rounds(BASE1, BASE2, BASE1, BASE2, BASE1)
        self.gh.now[20] = {'base_sha': '6' * 40}   # main moved again: a 6th round would help
        self.gh.conflicts.add(20)
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertEqual(stop.stop, 'conflict')
        self.assertIn('5 conflict rounds, main keeps moving under it', stop.reason)

    def test_a_continued_conflict_round_is_the_same_round(self):
        # Four rounds, the last cut off by a usage limit and picked up (in place or fresh, or by
        # a decision's retry or answer): five records, four rounds (Sol's review 1 of PR #101).
        self.conflict_rounds(BASE1, BASE2, BASE1)
        cut = self.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                                title='Queue runner conflict: first#20', sha='4' * 40,
                                cause='conflict', base=BASE2)
        self.jobs.ended(cut.id, exit_code=1, outcome='usage-limit')
        again = self.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                                  title='Queue runner conflict: first#20', sha='4' * 40,
                                  cause='conflict', base=BASE2, about=cut.id)
        self.jobs.ended(again.id, exit_code=0, outcome='pushed')
        self.gh.now[20] = {'base_sha': '6' * 40}   # main moved again: the fifth round
        self.gh.conflicts.add(20)
        self.assertIsNone(self.conflict_says())
        self.conflict_rounds('7' * 40)             # that fifth round; main moves once more
        self.gh.now[20] = {'base_sha': '8' * 40}
        self.assertIn('5 conflict rounds, main keeps moving under it', self.conflict_says()[0])

    def test_a_release_resets_the_count(self):
        self.conflict_rounds(BASE1, BASE2, BASE1, BASE2, BASE1)
        self.gh.now[20] = {'base_sha': BASE1}   # the same base, too
        self.gh.conflicts.add(20)
        self.assertIsNotNone(self.conflict_says())
        self.jobs.released('first', 20)
        self.assertIsNone(self.conflict_says())

    def test_a_review_that_stops_files_its_signals(self):
        # Review 1 raised F1 in "write logged wrongly"; review 2 on H3 raises F2 in that class.
        r = self.reviewer(reply(findings=[important('F1')]),
                          reply(findings=[important('F2', line=40)],
                                earlier=[{'id': 'F1', 'status': 'fixed'}]))
        r.review_pass()
        self.assertEqual(self.stops(), [])   # blocking: a fix round, no stop
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        self.git.ancestors.add((H2, H3))
        r.review_pass()
        [stop] = self.stops()
        self.assertEqual((stop.stop, stop.sha), ('review', H3))
        self.assertIn('F2 repeats the class "write logged wrongly" of F1', stop.reason)
        self.assertEqual(len(self.toaster.toasts), 1)

    def test_review_3_still_blocking_waits_for_its_approach_note_without_a_fourth_review(self):
        self.review_ended('approach-note', round=3)
        self.gh.prs = [full_pr(20, 'claude/red-5', H3, title='Red widget')]   # a push since
        self.git.heads[20] = H3
        r = self.reviewer()
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(self.stops(), [])   # the decision thread files it, with its note
        self.assertEqual(self.sol.briefs, [])
        self.assertIn('its Approach note goes to Stefan first',
                      held(self.jobs, self.repo, 20))

    def test_a_reopened_finding_and_a_kept_decline_are_review_stops(self):
        self.review_ended('stop', signals=['reopened', 'decline-kept'])
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertIn('a fixed finding came back; Sol kept a decline open', stop.reason)

    def test_a_fix_round_that_pushed_nothing_is_a_stop(self):
        self.review_ended('blocking')
        j = self.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                              title='t', sha=H2, round=1)
        self.jobs.ended(j.id, exit_code=0, outcome='no-push', head=H2, link='https://t3/x')
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertEqual(stop.stop, 'no-push')
        self.assertIn('ended without pushing', stop.reason)

    def test_nothing_stops_a_pr_a_job_is_writing_to(self):
        self.fail_check()
        self.jobs.started(kind='build', repo='first', issue=5, branch='claude/red-5', title='b')
        self.reviewer().review_pass()
        self.assertEqual(self.stops(), [])
        self.assertEqual(self.gh.posts, [])

    # --- once, and one issue per PR ---------------------------------------------------------

    def test_a_stop_is_filed_once_per_head(self):
        self.fail_check()
        r = self.reviewer()
        r.review_pass()
        r.review_pass()
        self.assertEqual(len(self.calls('issue')), 1)
        self.assertEqual(len(self.stops()), 1)
        self.assertEqual(len(self.toaster.toasts), 1)

    def test_a_second_stop_on_the_pr_is_added_to_its_open_issue(self):
        self.fail_check()
        r = self.reviewer()
        r.review_pass()
        self.conflict_stops()
        r.review_pass()
        self.assertEqual(len(self.calls('issue')), 1)   # no second issue
        on_issue = [b for n, b in self.calls('comment') if n == 901]
        self.assertEqual(len(on_issue), 1)
        self.assertIn('Another stop on PR #20', on_issue[0])
        self.assertIn('conflicts with main', on_issue[0])
        self.assertEqual([s.link for s in self.stops()], [ISSUE_URL, ISSUE_URL])
        # Two toasts, each its own: the second doesn't replace the first.
        self.assertEqual([t['tag'] for t in self.toaster.toasts],
                         ['first-20-failed-check', 'first-20-conflict'])

    def test_after_the_issue_is_closed_a_new_stop_opens_a_new_issue(self):
        self.fail_check()
        r = self.reviewer()
        r.review_pass()
        self.gh.close_issue(901)
        self.conflict_stops()
        r.review_pass()
        self.assertEqual(len(self.calls('issue')), 2)

    def test_an_issue_that_cannot_be_filed_is_tried_again_next_pass(self):
        self.fail_check()
        self.gh.fail.add('issue')
        r = self.reviewer()
        r.review_pass()
        self.assertEqual([s.outcome for s in self.stops()], ['failed'])
        self.assertEqual(self.toaster.toasts, [])
        self.gh.fail.discard('issue')
        r.review_pass()
        self.assertEqual([s.outcome for s in self.stops()], ['failed', 'filed'])

    def test_a_failed_toast_or_pr_comment_still_files_the_stop(self):
        self.fail_check()
        self.toaster.fail = True
        self.gh.fail.add('comment')
        self.reviewer().review_pass()
        [stop] = self.stops()
        self.assertEqual(stop.outcome, 'filed')
        self.assertTrue(any('toast failed' in s for s in self.said))

    # --- left alone until Stefan answers ------------------------------------------------------

    def stopped_then_pushed(self):
        """A failed check on H2 stopped the PR; then a push moved it to H3, checks passed."""
        self.fail_check()
        r = self.reviewer(reply())
        r.review_pass()
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        return r

    def test_a_stopped_pr_is_not_reviewed_even_on_a_new_head(self):
        r = self.stopped_then_pushed()
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(self.sol.briefs, [])
        self.assertTrue(any('stopped for Stefan' in s for s in self.said))

    def test_closing_the_issue_puts_the_pr_back_in_the_loop(self):
        r = self.stopped_then_pushed()
        self.gh.close_issue(901)
        self.assertEqual(r.review_pass(), 'started')
        [stop] = self.stops()
        self.assertEqual((stop.outcome, stop.answer), ('answered', 'issue-closed'))
        self.assertEqual(len(self.sol.briefs), 1)

    def test_a_reply_on_the_pr_puts_it_back_but_the_runners_own_comment_does_not(self):
        r = self.stopped_then_pushed()
        r.review_pass()   # the runner's stop comment is on the PR: not an answer
        self.assertEqual(self.sol.briefs, [])
        self.gh.comments[20].append(Comment('someone', EARLIER, 'Said before the stop.'))
        self.gh.comments[20].append(Comment('ci[bot]', LATER, 'A bot.'))
        r.review_pass()
        self.assertEqual(self.sol.briefs, [])
        self.gh.replies[20] = [Comment('stefan1575', LATER, 'Rerun it, it was flaky.')]
        self.assertEqual(r.review_pass(), 'idle')   # a decision on the reply comes first
        self.assertEqual(self.stops()[0].answer, 'replied')
        self.assertIn('a decision on his reply comes first', held(self.jobs, self.repo, 20))

    def test_a_reply_on_the_needs_info_issue_answers_the_stop(self):
        r = self.stopped_then_pushed()
        self.gh.comments[901] = [Comment('stefan1575', LATER, 'hold')]
        r.review_pass()
        self.assertEqual(self.stops()[0].answer, 'replied')

    def test_the_runners_own_comment_on_the_needs_info_issue_is_no_answer(self):
        self.fail_check()
        self.reviewer().review_pass()
        self.conflict_stops()
        self.reviewer().review_pass()   # a second stop: added to issue 901 as a comment
        [(n, added)] = [c for c in self.calls('comment') if c[0] == 901]
        self.assertIn('Another stop on PR #20', added)
        self.gh.comments[901] = [Comment('stefan1575', LATER, added)]
        self.reviewer().review_pass()
        self.assertEqual({s.outcome for s in self.stops()}, {'filed'})

    def test_release_puts_a_stopped_pr_back(self):
        r = self.stopped_then_pushed()
        self.jobs.released('first', 20)
        self.assertEqual(r.review_pass(), 'started')

    def test_a_stopped_pr_does_not_merge(self):
        self.review_ended('clean')
        self.gh.comments[20] = [Comment('stefan1575', '2026-11-09T12:00:00Z',
                                        old_marker(1, 'clean', H2, []))]
        self.conflict_stops()   # has_conflict: the stop; pull().mergeable stays unknown
        merger = Merger(self.config, github=self.gh, git=self.git, jobs=self.jobs,
                        say=self.said.append)
        self.reviewer(merger=merger).review_pass()
        self.assertEqual(self.calls('merge'), [])
        self.assertIn('stopped for Stefan', merger.why_not(self.repo, 20, H2))

    def test_a_stopped_pr_gets_no_fix_round(self):
        self.review_ended('blocking')
        self.gh.comments[20] = [Comment('stefan1575', '2026-11-09T12:00:00Z',
                                        old_marker(1, 'blocking', H2, []))]
        self.conflict_stops()
        runner = Runner(self.config, github=self.gh, t3=FakeT3([]), git=self.git,
                        out=io.StringIO(), log_line=lambda line: None, sol=FakeSol([]),
                        toaster=self.toaster)
        self.assertIsNotNone(runner.next_fix())   # before the stop is filed
        runner.reviewer.review_pass()
        self.assertIsNone(runner.next_fix())


class WaitingToastTest(unittest.TestCase):
    """T3's thread notifications can't be limited to threads that need Stefan, so they stay off.
    A job thread that waits for an answer (exit 2) gets a decision first; only when it's Stefan's
    does the runner toast, and the click opens the waiting thread."""

    def passes(self, n, *outcomes):
        """`n` passes over issue #4, T3's threads ending as given; returns the toasts."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo = Repo(name='first', github='owner/first', path=tmp.name)
        config = Config(repos=[repo], state_dir=os.path.join(tmp.name, 'state'),
                        log_dir=os.path.join(tmp.name, 'logs'))
        toaster = FakeToaster()
        self.gh = FakeGitHubForReviews(issues=[issue(4)])
        r = Runner(config, github=self.gh, t3=FakeT3(list(outcomes)), git=FakeGit(),
                   out=io.StringIO(), log_line=lambda line: None, toaster=toaster)
        for _ in range(n):
            r.run_pass()
        return toaster.toasts

    def test_a_waiting_build_toasts_only_once_a_decision_finds_its_question_is_stefans(self):
        self.assertEqual(self.passes(1, (2, 'waiting')), [])
        [t] = self.passes(2, (2, 'waiting'),
                          (0, 'completed', decision_reply('stop', question='Red or blue?')))
        self.assertEqual(t['url'], 'https://app.t3.codes/threads/env/mcp:t1')
        self.assertIn('Red or blue?', t['text'])
        [(n, said)] = [p[1:] for p in self.gh.posts if p[0] == 'comment']
        self.assertEqual(n, 4)
        self.assertIn('Answer it in the waiting thread (https://app.t3.codes/threads/env/mcp:t1)'
                      ', or reply here', said)

    def test_a_build_that_completes_does_not_toast(self):
        self.assertEqual(self.passes(1, (0, 'completed')), [])


class ToastTest(unittest.TestCase):
    def test_the_toast_opens_its_url_on_click_and_escapes_its_text(self):
        xml = toast_xml('PR #2 <needs> you', 'a & b', 'https://x/issues/1?a=1&b=2')
        self.assertIn('<toast activationType="protocol" launch="https://x/issues/1?a=1&amp;b=2">',
                      xml)
        self.assertIn('<text>PR #2 &lt;needs&gt; you</text><text>a &amp; b</text>', xml)

    def test_windows_toaster_runs_powershell_hidden_with_the_runners_app_id(self):
        import base64
        ran = []

        class Done:
            returncode, stderr = 0, ''

        def run(args, **kw):
            ran.append((args, kw))
            return Done()
        t = WindowsToaster(run=run)
        t._registered = True   # the registry is left alone in tests
        t.toast("It's red", 'Why', 'https://x', tag='first-20')
        [(args, kw)] = ran
        self.assertEqual(args[0], 'powershell.exe')
        script = base64.b64decode(args[-1]).decode('utf-16-le')
        self.assertIn("CreateToastNotifier('Stefan.QueueRunner')", script)
        self.assertIn("$toast.Tag = 'first-20'", script)
        self.assertIn('creationflags', kw)


if __name__ == '__main__':
    unittest.main()
