"""Conflict rounds (ticket 15): a PR that conflicts with its base gets a fix round that merges the
base in, then Sol reviews its new head afresh; conflicted PRs go one at a time, lowest number
first, each after the one before merged or stopped; a round that couldn't resolve it, or a third
conflict, is a stop. GitHub, T3, git and Sol faked."""
import io
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.fix import fix_branch
from queue_runner.github import Checks, Issue
from queue_runner.run import Runner
from tests.fakes import FakeGitHubForReviews, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import H2, H3, important, reply

H1 = 'a' * 40
H4 = 'd' * 40
H5 = 'e' * 40
BASE_COMMITS = [{'sha': '7' * 40, 'subject': 'Rename the widget table'}]


class ResolvingT3(FakeT3):
    """A conflict thread: each start pushes `pushes[PR]` to that PR, which then no longer
    conflicts (unless `still` names it)."""

    def __init__(self, outcomes, gh, git, pushes=None, still=()):
        super().__init__(outcomes)
        self.gh, self.git, self.pushes, self.still = gh, git, dict(pushes or {}), set(still)

    def start(self, *args, **kwargs):
        result = super().start(*args, **kwargs)
        n = int(kwargs['title'].rsplit('#', 1)[1])
        if n in self.pushes:
            self.gh.now.setdefault(n, {})['head_sha'] = self.pushes[n]
            self.git.heads[n] = self.pushes[n]
            if n not in self.still:
                self.gh.conflicts.discard(n)
        return result


class ConflictRoundTest(unittest.TestCase):
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
            prs=[full_pr(20, 'claude/red-5', H2, body='Closes #5\n\nMakes it red.',
                         title='Red widget'),
                 full_pr(21, 'claude/blue-6', H4, body='Makes it blue.', title='Blue widget')],
            comments={20: [], 21: [], 5: []}, conflicts={20, 21},
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')})
        self.git = FakeReviewGit(heads={20: H2, 21: H4}, commits={
            ('origin/main', H2): [{'sha': '1' * 40, 'subject': 'Make the widget red'}],
            (H2, 'origin/main'): BASE_COMMITS,
            (H2, H3): [{'sha': H3, 'subject': "Merge branch 'main' into claude/red-5"}]})
        self.out = io.StringIO()

    def runner(self, outcomes=((0, 'completed'),), pushes=None, still=(), replies=()):
        self.t3 = ResolvingT3(list(outcomes), self.gh, self.git, pushes, still)
        self.sol = FakeSol(list(replies))
        return Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=self.out,
                      log_line=lambda line: None, sol=self.sol)

    def jobs(self, r, kind):
        return [j for j in r.jobs.jobs() if j.kind == kind]

    def only(self, *numbers):
        self.gh.prs = [p for p in self.gh.prs if p.number in numbers]

    # --- one conflicted PR ----------------------------------------------------------------

    def test_a_conflicted_pr_gets_a_conflict_round_from_its_head(self):
        self.only(20)
        r = self.runner(pushes={20: H3})
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual((start['worktree'], start['branch'], start['title']),
                         (H2, fix_branch(20, H2), 'Queue runner conflict: first#20'))
        brief = start['message']
        self.assertIn('Conflict round on PR #20 in owner/first: Red widget', brief)
        self.assertIn('git merge origin/main', brief)
        self.assertIn('git push origin HEAD:claude/red-5', brief)
        self.assertIn('- `7777777` Rename the widget table', brief)   # what landed on main
        self.assertIn('- `1111111` Make the widget red', brief)       # the PR's own commits
        self.assertIn('It closes: #5', brief)
        self.assertIn("If you can't resolve it", brief)
        [fix] = self.jobs(r, 'fix')
        self.assertEqual((fix.cause, fix.sha, fix.round, fix.outcome, fix.head),
                         ('conflict', H2, None, 'pushed', H3))
        self.assertIn('to resolve its conflict with main', self.out.getvalue())

    def test_sol_leaves_a_conflicted_head_alone_then_reviews_the_new_head_afresh(self):
        self.only(20)
        r = self.runner(pushes={20: H3}, replies=[reply()])
        self.assertEqual(r.reviewer.review_pass(), 'idle')   # conflicted: the round comes first
        self.assertEqual(self.sol.briefs, [])
        self.assertEqual(self.jobs(r, 'stop'), [])           # and no stop for Stefan
        r.run_pass()
        self.assertEqual(r.reviewer.review_pass(), 'started')
        [review] = self.jobs(r, 'review')
        self.assertEqual((review.sha, review.round, review.outcome), (H3, 1, 'clean'))

    def test_a_blocking_review_gets_its_fix_round_not_a_conflict_round(self):
        self.only(20)
        self.gh.conflicts.clear()
        r = self.runner(replies=[reply(findings=[important('F1')])])
        r.reviewer.review_pass()
        self.gh.conflicts.add(20)
        [(pr, review, why)] = list(r.fixer.candidates(self.repo))
        self.assertEqual((pr.number, review.outcome, why), (20, 'blocking', None))

    # --- one at a time --------------------------------------------------------------------

    def test_two_conflicted_prs_go_one_after_the_other(self):
        r = self.runner(outcomes=[(0, 'completed')] * 2, pushes={20: H3, 21: H5},
                        replies=[reply()])
        whys = {pr.number: why for pr, _, why in r.fixer.candidates(self.repo)}
        self.assertEqual(whys, {20: None, 21: 'PR #20 resolves its conflict first: one '
                                              'conflicted PR at a time'})
        r.run_pass()   # #20 first: the lowest number
        self.assertEqual([s['title'] for s in self.t3.starts],
                         ['Queue runner conflict: first#20'])
        # #20 pushed and is on its way (its new head's checks still running): #21 still waits.
        self.gh.check_states[H3] = Checks('pending', pending=('ci',))
        self.assertEqual(r.reviewer.review_pass(), 'idle')
        self.assertEqual(r.run_pass(), 'idle')
        self.assertIn("PR #20 had a conflict round and hasn't merged or stopped yet",
                      self.out.getvalue())
        self.assertEqual(len(self.t3.starts), 1)
        # Its checks pass, Sol reviews it clean and the runner merges it: #21's round starts.
        del self.gh.check_states[H3]
        self.assertEqual(r.reviewer.review_pass(), 'started')
        self.assertIn(('merge', 20, H3), self.gh.posts)
        self.assertEqual(r.run_pass(), 'started')
        self.assertEqual(self.t3.starts[1]['title'], 'Queue runner conflict: first#21')
        self.assertEqual(self.t3.starts[1]['worktree'], H4)

    def test_the_next_conflicted_pr_goes_once_the_earlier_one_stopped(self):
        r = self.runner(outcomes=[(0, 'completed')] * 2, pushes={20: H3, 21: H5})
        r.run_pass()
        self.gh.check_states[H3] = __import__('queue_runner.github', fromlist=['Checks']) \
            .Checks('failed', failed=('ci',))
        r.reviewer.review_pass()   # #20's new head fails a check: a stop for Stefan
        self.assertEqual([j.stop for j in self.jobs(r, 'stop')], ['failed-check'])
        self.assertEqual(r.run_pass(), 'started')
        self.assertEqual(self.t3.starts[1]['title'], 'Queue runner conflict: first#21')

    def test_a_held_earlier_pr_lets_the_next_one_go_first(self):
        r = self.runner(pushes={21: H5})
        s = r.jobs.started(kind='stop', repo='first', issue=20, branch='claude/red-5',
                           title='t', sha=H2, stop='failed-check')
        r.jobs.ended(s.id, exit_code=None, outcome='filed', link='https://x/issues/9')
        self.assertEqual(r.run_pass(), 'started')
        self.assertEqual(self.t3.starts[0]['title'], 'Queue runner conflict: first#21')

    # --- still a stop ---------------------------------------------------------------------

    def test_a_round_that_could_not_resolve_it_is_a_conflict_stop(self):
        self.only(20)
        r = self.runner()   # the thread pushes nothing
        r.run_pass()
        [fix] = self.jobs(r, 'fix')
        self.assertEqual((fix.cause, fix.outcome), ('conflict', 'no-push'))
        r.reviewer.review_pass()
        [stop] = self.jobs(r, 'stop')
        self.assertEqual(stop.stop, 'conflict')   # not a no-push stop: H2 was never reviewed
        self.assertIn("the conflict round on bbbbbbb couldn't resolve it (it ended no-push)",
                      stop.reason)
        self.assertIsNone(r.next_fix())
        self.assertEqual(len(self.t3.starts), 1)

    def test_a_round_that_pushed_but_still_conflicts_gets_one_more_then_a_third_is_a_stop(self):
        self.only(20)
        r = self.runner(outcomes=[(0, 'completed')] * 2, pushes={20: H3}, still={20})
        r.run_pass()                      # round 1 on H2 pushes H3, still conflicting
        self.t3.pushes[20] = H4
        r.reviewer.review_pass()
        self.assertEqual(self.jobs(r, 'stop'), [])
        r.run_pass()                      # round 2 on H3 pushes H4, still conflicting
        self.assertEqual([j.sha for j in self.jobs(r, 'fix')], [H2, H3])
        r.reviewer.review_pass()          # a third conflict, on H4: a stop
        [stop] = self.jobs(r, 'stop')
        self.assertEqual((stop.stop, stop.sha), ('conflict', H4))
        self.assertIn('a third conflict', stop.reason)
        self.assertIsNone(r.next_fix())
        self.assertEqual(len(self.t3.starts), 2)

    def test_a_conflict_stop_filed_before_a_round_on_the_same_head_does_not_hide_its_own(self):
        # Before ticket 15 a conflict on H2 was filed at once; Stefan releases it, the round on
        # H2 pushes nothing, and its own conflict stop is filed.
        self.only(20)
        r = self.runner()
        s = r.jobs.started(kind='stop', repo='first', issue=20, branch='claude/red-5',
                           title='t', sha=H2, stop='conflict')
        r.jobs.ended(s.id, exit_code=None, outcome='filed', link='https://x/issues/9')
        r.jobs.released('first', 20)
        r.run_pass()
        r.reviewer.review_pass()
        self.assertEqual([j.outcome for j in self.jobs(r, 'stop')], ['filed', 'filed'])

    def test_release_lets_a_stopped_conflict_try_again(self):
        self.only(20)
        r = self.runner(outcomes=[(0, 'completed')] * 2)
        r.run_pass()
        r.reviewer.review_pass()
        self.assertIsNone(r.next_fix())
        r.jobs.released('first', 20)
        self.assertIsNotNone(r.next_fix())

    def test_a_restart_after_a_usage_limit_rebuilds_the_conflict_brief(self):
        self.only(20)
        r = self.runner()
        old = r.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                             title='Queue runner conflict: first#20', sha=H2, cause='conflict')
        brief = r._brief_again(self.repo, old)
        self.assertIn('Conflict round on PR #20', brief)


if __name__ == '__main__':
    unittest.main()
