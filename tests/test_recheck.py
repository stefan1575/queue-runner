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


if __name__ == '__main__':
    unittest.main()
