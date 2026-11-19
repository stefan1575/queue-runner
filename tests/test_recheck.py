"""A PR stopped for a failed check is updated and checked again once its base moves (issue #199):
once per base head, with no writer and no conflict, the runner updates the PR from its base; a
pass on the new head closes the stop's issue and the PR goes back to review, and a failure there
is #93's re-run and then a stop, as today. Through the real Runner and Reviewer, with GitHub, T3,
git and Sol faked."""
import io
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Issue, WorkflowRun
from queue_runner.run import Runner
from queue_runner.stops import RECHECK
from tests.fakes import MAIN_HEAD, FakeGitHubForReviews, FakeToaster, full_pr, issue
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import H2, H3, important, reply

MAIN2 = '8' * 40   # main's head once the fix for the flaky test landed
H4 = 'd' * 40      # the PR's head after GitHub's update-branch
H5 = 'e' * 40
RUN = 'https://github.com/owner/first/actions/runs/437'


class RecheckTest(unittest.TestCase):
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
            issues=[issue(9, 'Blue widget', 'Make it blue.')],
            prs=[full_pr(20, 'claude/red-5', H2, title='Red widget', body='Makes it red.')],
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')})
        self.git = FakeReviewGit(heads={20: H2})
        self.toaster = FakeToaster()
        self.out = io.StringIO()
        self.said = []

    def runner(self, *replies):
        self.t3 = FakeT3([(0, 'completed')])
        self.sol = FakeSol(list(replies) or [reply(findings=[important('F1')])])
        return Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=self.out,
                      log_line=self.said.append, sol=self.sol, toaster=self.toaster)

    def stopped(self):
        """PR #20 stopped for a failed check on H2 (a commit status: a stop at once)."""
        self.gh.check_states[H2] = Checks('failed', failed=('tests',))
        r = self.runner()
        r.reviewer.review_pass()
        [stop] = self.of(r, 'stop')
        self.assertEqual((stop.stop, stop.outcome, stop.base), ('failed-check', 'filed', MAIN_HEAD))
        return r, stop

    def main_moves(self, sha=MAIN2):
        self.gh.base_heads['main'] = sha
        self.gh.check_states.setdefault(sha, Checks('passed'))

    def github_updates(self, head, checks=None):
        """GitHub's update-branch landed: the PR's head is its new merge commit."""
        self.gh.now.setdefault(20, {})['head_sha'] = head
        self.git.heads[20] = head
        if checks is not None:
            self.gh.check_states[head] = checks

    def of(self, r, kind):
        return [j for j in r.jobs.jobs() if j.kind == kind]

    def calls(self, kind):
        return [p[1:] for p in self.gh.posts if p[0] == kind]

    def test_a_stopped_pr_is_updated_once_main_moves_and_reviewed_once_it_passes(self):
        r, stop = self.stopped()
        n = int(stop.link.rsplit('/', 1)[-1])
        self.main_moves()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [(20, H2)])
        [job] = self.of(r, RECHECK)
        self.assertEqual((job.outcome, job.sha, job.base, job.about), ('updated', H2, MAIN2, stop.id))
        self.assertEqual(self.sol.briefs, [])   # still held: the new head's checks come first
        self.github_updates(H4, Checks('passed'))
        r.reviewer.review_pass()
        said = [b for k, b in self.calls('comment') if k == n]
        self.assertIn('main moved', said[-1])
        self.assertIn('pass on ' + H4[:7], said[-1])
        self.assertEqual(self.calls('close-done'), [(n,)])
        [answered] = self.of(r, 'stop')
        self.assertEqual((answered.outcome, answered.answer), ('answered', 'passed-after-update'))
        [job] = self.of(r, RECHECK)
        self.assertEqual((job.outcome, job.head), ('passed', H4))
        r.reviewer.review_pass()
        self.assertEqual(len(self.sol.briefs), 1)   # back in review, on the new head
        self.assertEqual(len(self.calls('update-branch')), 1)
        self.assertEqual(len(self.calls('close-done')), 1)

    def test_failing_again_on_the_new_head_is_rerun_then_stopped_once(self):
        r, stop = self.stopped()
        self.main_moves()
        r.reviewer.review_pass()
        self.github_updates(H4, Checks('failed', failed=('tests',), runs=(437,),
                                       by_run=((437, ('tests',)),)))
        self.gh.workflow_runs[437] = WorkflowRun(437, 1, 'completed', 'failure', RUN)
        r.reviewer.review_pass()
        self.assertEqual(self.calls('rerun'), [(437,)])   # #93's one re-run first
        self.assertEqual([s.sha for s in self.of(r, 'stop')], [H2])
        self.gh.workflow_runs[437] = WorkflowRun(437, 2, 'completed', 'failure', RUN)
        r.reviewer.review_pass()
        r.reviewer.review_pass()
        r.reviewer.review_pass()
        stops = self.of(r, 'stop')
        self.assertEqual([(s.sha, s.stop, s.outcome) for s in stops],
                         [(H2, 'failed-check', 'filed'), (H4, 'failed-check', 'filed')])
        self.assertEqual(stops[1].base, MAIN2)
        [job] = self.of(r, RECHECK)
        self.assertEqual((job.outcome, job.head), ('failed-again', H4))
        self.assertEqual(len(self.calls('update-branch')), 1)   # never twice for MAIN2
        self.assertEqual(self.calls('close-done'), [])
        self.assertEqual(self.sol.briefs, [])
        self.assertEqual(sum('not moved since' in s for s in self.said), 1, self.said)

    def test_main_moving_again_after_a_failure_checks_it_again_once(self):
        self.test_failing_again_on_the_new_head_is_rerun_then_stopped_once()
        r = self.runner()
        MAIN3 = '7' * 40
        self.main_moves(MAIN3)
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [(20, H2), (20, H4)])
        self.assertEqual(self.of(r, RECHECK)[-1].base, MAIN3)

    def test_a_base_that_has_not_moved_is_left_alone_and_said_once(self):
        r, _ = self.stopped()
        r.reviewer.review_pass()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [])
        self.assertEqual(self.of(r, RECHECK), [])
        self.assertEqual(sum('main has not moved since its check failed' in s
                             for s in self.said), 1, self.said)

    def test_a_conflict_is_left_to_the_conflict_round_and_said_once(self):
        r, _ = self.stopped()
        self.main_moves()
        self.gh.conflicts.add(20)
        stopper = r.reviewer.stopper
        stopper.recheck(self.repo, self.gh.pull(self.repo, 20))
        stopper.recheck(self.repo, self.gh.pull(self.repo, 20))
        self.assertEqual(self.calls('update-branch'), [])
        self.assertEqual(sum('a conflict round comes first' in s for s in self.said), 1)

    def test_a_pr_with_a_claude_job_writing_to_it_waits_for_that_job(self):
        r, _ = self.stopped()
        self.main_moves()
        r.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                       title='Queue runner fix: first#20', sha=H2)
        stopper = r.reviewer.stopper
        stopper.recheck(self.repo, self.gh.pull(self.repo, 20))
        stopper.recheck(self.repo, self.gh.pull(self.repo, 20))
        self.assertEqual(self.calls('update-branch'), [])
        self.assertEqual(sum('is writing to the PR' in s for s in self.said), 1, self.said)

    def test_a_pr_with_another_stop_is_left_for_stefan(self):
        r, stop = self.stopped()
        r.reviewer.stopper.file(self.repo, self.gh.pull(self.repo, 20), 'no-push', 'nothing')
        self.main_moves()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [])
        self.assertTrue(any('another stop for Stefan (no-push)' in s for s in self.said))

    def test_an_update_github_refuses_is_not_tried_again_on_that_base(self):
        r, stop = self.stopped()
        self.main_moves()
        self.gh.fail.add('update-branch')
        r.reviewer.review_pass()
        r.reviewer.review_pass()
        [job] = self.of(r, RECHECK)
        self.assertEqual(job.outcome, 'update-failed')
        self.assertEqual(self.of(r, 'stop')[0].outcome, 'filed')   # still Stefan's

    def test_github_not_answering_is_tried_again_next_pass(self):
        from queue_runner.github import GhError
        r, stop = self.stopped()
        self.main_moves()
        real = self.gh.update_branch

        def down(repo, number, expected_head):
            raise GhError('gh api failed (1): Bad gateway (HTTP 502)')
        self.gh.update_branch = down
        r.reviewer.review_pass()
        self.gh.update_branch = real
        r.reviewer.review_pass()
        self.assertEqual([j.outcome for j in self.of(r, RECHECK)], ['not-started', 'updated'])
        self.assertEqual(self.calls('update-branch'), [(20, H2)])

    def test_a_stop_filed_before_199_with_no_base_counts_as_moved(self):
        self.gh.check_states[H2] = Checks('failed', failed=('tests',))
        r = self.runner()
        job = r.jobs.started(kind='stop', repo='first', issue=20, branch='claude/red-5',
                             title='Queue runner stop: first#20', sha=H2, stop='failed-check')
        url = self.gh.create_issue(self.repo, 'PR #20 needs Stefan', 'x', ['needs-info'])
        r.jobs.ended(job.id, exit_code=None, outcome='filed', link=url, reason='tests')
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [(20, H2)])

    def test_a_close_that_fails_is_tried_again_without_a_second_comment(self):
        r, stop = self.stopped()
        n = int(stop.link.rsplit('/', 1)[-1])
        self.main_moves()
        r.reviewer.review_pass()
        self.github_updates(H4, Checks('passed'))
        self.gh.fail.add('close-done')
        r.reviewer.review_pass()
        self.assertEqual(self.of(r, 'stop')[0].outcome, 'filed')
        self.gh.fail.discard('close-done')
        r.reviewer.review_pass()
        self.assertEqual(self.calls('close-done'), [(n,)])
        self.assertEqual(sum('main moved' in b for k, b in self.calls('comment') if k == n), 1)
        self.assertEqual(self.of(r, 'stop')[0].answer, 'passed-after-update')


if __name__ == '__main__':
    unittest.main()
