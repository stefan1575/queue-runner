"""A check that fails on main too is main's, not the PR's (issue #98): the PR is held with no stop,
the repo gets one stop for main, no build starts from a red main while fix rounds still do, and
once main passes each held PR is updated from it and the stop closed. Through the real Runner and
Reviewer, with GitHub, T3, git and Sol faked."""
import io
import os
import tempfile
import unittest

from queue_runner.asks import render
from queue_runner.ask_threads import mark
from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Issue, WorkflowRun
from queue_runner.inbox import collect
from queue_runner.run import Runner
from queue_runner.stops import BASE, BASE_HOLD, base_mark
from tests.fakes import MAIN_HEAD, FakeGitHubForReviews, FakeToaster, full_pr, issue
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import H2, H3, important, reply

MAIN2 = '8' * 40   # main's head once the fix for it landed
RUN = 'https://github.com/owner/first/actions/runs/437'


class BaseRedTest(unittest.TestCase):
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
        self.git = FakeReviewGit(heads={20: H2, 21: H3})
        self.toaster = FakeToaster()
        self.out = io.StringIO()
        self.said = []

    def runner(self, *replies):
        self.t3 = FakeT3([(0, 'completed')])
        self.sol = FakeSol(list(replies) or [reply(findings=[important('F1')])])
        r = Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=self.out,
                   log_line=self.said.append, sol=self.sol, toaster=self.toaster)
        return r

    def main_fails(self, *names, sha=MAIN_HEAD):
        self.gh.base_heads['main'] = sha
        self.gh.check_states[sha] = Checks('failed', failed=names, runs=(500,),
                                           by_run=((500, names),))

    def pr_fails(self, sha, *names, run=437):
        self.gh.check_states[sha] = Checks('failed', failed=names, runs=(run,),
                                           by_run=((run, names),))
        self.gh.workflow_runs[run] = WorkflowRun(run, 1, 'completed', 'failure', RUN)

    def main_passes(self, sha=MAIN2):
        self.gh.base_heads['main'] = sha
        self.gh.check_states[sha] = Checks('passed')

    def second_pr(self):
        self.gh.prs.append(full_pr(21, 'claude/blue-9', H3, title='Blue widget'))

    def of(self, r, kind):
        return [j for j in r.jobs.jobs() if j.kind == kind]

    def calls(self, kind):
        return [p[1:] for p in self.gh.posts if p[0] == kind]

    # --- held, with one stop for main ---------------------------------------------------------

    def test_a_pr_failing_only_what_main_fails_is_held_and_main_gets_one_stop(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        self.assertEqual(self.of(r, 'stop'), [])
        self.assertEqual(self.calls('rerun'), [])   # re-running what main fails wastes a run
        [(title, body, labels)] = self.calls('issue')
        self.assertEqual((title, labels), ('main fails its checks', ('needs-info',)))
        self.assertIn(base_mark('owner/first', 'main'), body)
        self.assertIn(f'tests failed on main at {MAIN_HEAD[:7]}', body)
        self.assertIn('https://github.com/owner/first/actions/runs/500', body)
        [stop] = self.of(r, BASE)
        self.assertEqual((stop.outcome, stop.sha, stop.branch), ('filed', MAIN_HEAD, 'main'))
        [hold] = self.of(r, BASE_HOLD)
        self.assertEqual((hold.issue, hold.sha, hold.outcome, hold.about),
                         (20, H2, 'held', stop.id))
        self.assertTrue(any('not now, main fails tests too' in s for s in self.said), self.said)
        [t] = self.toaster.toasts
        self.assertEqual(t['title'], 'first: main fails its checks')
        self.assertEqual(self.sol.briefs, [])   # not reviewed while held

    def test_a_second_pr_held_by_the_same_red_main_files_nothing_new(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        self.second_pr()
        self.pr_fails(H3, 'tests', run=438)
        r.reviewer.review_pass()
        r.reviewer.review_pass()
        self.assertEqual(len(self.calls('issue')), 1)
        self.assertEqual(len(self.of(r, BASE)), 1)
        self.assertEqual(sorted(h.issue for h in self.of(r, BASE_HOLD)), [20, 21])
        self.assertEqual(self.of(r, 'stop'), [])
        self.assertEqual(len(self.toaster.toasts), 1)

    def test_a_check_failing_on_h_but_passing_on_main_is_a_stop_as_today(self):
        self.main_fails('tests')
        self.gh.check_states[H2] = Checks('failed', failed=('lint',))   # no Actions run
        r = self.runner()
        r.reviewer.review_pass()
        [stop] = self.of(r, 'stop')
        self.assertEqual(stop.stop, 'failed-check')
        self.assertEqual(self.of(r, BASE_HOLD), [])

    def test_a_pr_failing_more_than_main_fails_is_the_prs_own(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests', 'lint')
        r = self.runner()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('rerun'), [(437,)])   # issue #93's re-run, as today
        self.assertEqual(self.of(r, BASE_HOLD), [])

    def test_a_main_with_no_checks_yet_is_not_red(self):
        self.gh.base_heads['main'] = MAIN2
        self.gh.check_states[MAIN2] = Checks('none')
        self.gh.check_states[H2] = Checks('failed', failed=('tests',))
        r = self.runner()
        r.reviewer.review_pass()
        self.assertEqual(self.of(r, BASE), [])
        self.assertEqual([s.stop for s in self.of(r, 'stop')], ['failed-check'])

    # --- the Claude lane ---------------------------------------------------------------------

    def test_no_build_starts_from_a_red_main(self):
        self.main_fails('tests')
        self.gh.check_states[H2] = Checks('pending', pending=('tests',))   # PR #20 isn't reviewed
        r = self.runner()
        r.reviewer.review_pass()
        r.run_pass()
        r.run_pass()
        self.assertEqual(self.t3.starts, [])
        said = [s for s in self.said if 'no build starts while main fails its checks' in s]
        self.assertEqual(len(said), 1, self.said)   # said once per base head
        self.main_passes()
        r.reviewer.review_pass()
        r.run_pass()
        [start] = self.t3.starts
        self.assertEqual(start['title'], 'Queue runner build: first#9')

    def test_a_fix_round_still_starts_while_main_is_red(self):
        r = self.runner()
        r.reviewer.review_pass()   # main passes: Sol's review 1 of H2 is blocking
        [review] = self.of(r, 'review')
        self.assertEqual(review.outcome, 'blocking')
        self.main_fails('tests')
        r.reviewer.review_pass()
        r.run_pass()
        [start] = self.t3.starts
        self.assertEqual(start['title'], 'Queue runner fix: first#20')

    # --- main passes again ---------------------------------------------------------------------

    def test_once_main_passes_each_held_pr_is_updated_and_the_stop_closed(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        self.second_pr()
        self.pr_fails(H3, 'tests', run=438)
        r = self.runner()
        r.reviewer.review_pass()
        [stop] = self.of(r, BASE)
        n = int(stop.link.rsplit('/', 1)[-1])
        self.main_passes()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [(20, H2), (21, H3)])
        self.assertEqual(self.calls('close-done'), [(n,)])
        [closed] = self.of(r, BASE)
        self.assertEqual((closed.outcome, closed.head), ('closed', MAIN2))
        self.assertEqual({h.outcome for h in self.of(r, BASE_HOLD)}, {'updated'})
        said = [b for k, b in self.calls('comment') if k == n]
        self.assertIn('updated #20, #21 from it', said[-1])
        r.reviewer.review_pass()   # nothing twice
        self.assertEqual(len(self.calls('update-branch')), 2)
        self.assertEqual(len(self.calls('close-done')), 1)

    def test_an_update_github_refuses_is_left_to_the_conflict_round(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        self.main_passes()
        self.gh.fail.add('update-branch')
        r.reviewer.review_pass()
        [hold] = self.of(r, BASE_HOLD)
        self.assertEqual(hold.outcome, 'update-failed')
        self.assertEqual(self.of(r, BASE)[0].outcome, 'closed')
        self.assertTrue(any('a conflict round comes first' in s for s in self.said))

    def test_a_held_pr_that_moved_on_is_not_updated(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        self.main_passes()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [])
        self.assertEqual(self.of(r, BASE_HOLD)[0].outcome, 'moved')

    def test_main_still_running_its_checks_keeps_the_hold(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        self.gh.base_heads['main'] = MAIN2
        self.gh.check_states[MAIN2] = Checks('pending', pending=('tests',))
        self.second_pr()
        self.pr_fails(H3, 'tests', run=438)
        r.reviewer.review_pass()
        self.assertEqual(self.of(r, 'stop'), [])
        self.assertEqual(len(self.of(r, BASE_HOLD)), 2)
        self.assertEqual(self.calls('update-branch'), [])

    # --- review 1's findings -------------------------------------------------------------------

    def test_a_new_failure_on_a_held_head_that_main_does_not_fail_is_the_prs_own(self):
        """F1: held on `tests`, then `lint` fails on the same H: the hold goes, and #93's re-run
        (then its stop) follows as for any PR's own failure."""
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        [hold] = self.of(r, BASE_HOLD)
        self.assertEqual(hold.outcome, 'held')
        self.gh.check_states[H2] = Checks('failed', failed=('tests', 'lint'), runs=(437,),
                                          by_run=((437, ('tests', 'lint')),))
        r.reviewer.review_pass()
        [hold] = self.of(r, BASE_HOLD)
        self.assertEqual(hold.outcome, 'own-failure')
        self.assertEqual(self.calls('rerun'), [(437,)])
        r.reviewer.review_pass()   # not held again on H
        self.assertEqual(len(self.of(r, BASE_HOLD)), 1)

    def test_an_update_that_fails_for_another_reason_is_tried_again(self):
        """F2: an HTTP 503 from update-branch isn't a conflict: the hold stays and the next pass
        updates the PR."""
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        self.main_passes()
        real = self.gh.update_branch

        def flaky(repo, number, expected):
            from queue_runner.github import GhError
            raise GhError('gh api failed (1): Service Unavailable (HTTP 503)')
        self.gh.update_branch = flaky
        r.reviewer.review_pass()
        [hold] = self.of(r, BASE_HOLD)
        self.assertEqual(hold.outcome, 'held')
        self.gh.update_branch = real
        r.reviewer.review_pass()
        [hold] = self.of(r, BASE_HOLD)
        self.assertEqual(hold.outcome, 'updated')
        self.assertEqual(self.calls('update-branch'), [(20, H2)])

    def test_a_held_pr_with_a_claude_job_writing_to_it_is_not_updated_until_it_ends(self):
        """F3: a fix round open on the PR's branch is its writer: update-branch waits for it."""
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        r = self.runner()
        r.reviewer.review_pass()
        fix = r.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                             title='Queue runner conflict: first#20', sha=H2, cause='conflict')
        self.main_passes()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [])
        self.assertEqual(self.of(r, BASE_HOLD)[0].outcome, 'held')
        r.jobs.ended(fix.id, exit_code=0, outcome='no-push', head=H2)
        r.reviewer.review_pass()
        self.assertEqual(self.calls('update-branch'), [(20, H2)])

    def test_no_build_starts_from_a_red_main_even_when_its_issue_could_not_be_filed(self):
        """F4: the issue failing to file still records main as red, so no build starts; the
        next pass files it."""
        self.main_fails('tests')
        self.gh.check_states[H2] = Checks('pending', pending=('tests',))
        self.gh.fail.add('issue')
        r = self.runner()
        r.reviewer.review_pass()
        self.assertEqual(self.of(r, BASE)[-1].outcome, 'failed')
        r.run_pass()
        self.assertEqual(self.t3.starts, [])
        self.gh.fail.discard('issue')
        r.reviewer.review_pass()
        self.assertEqual(self.of(r, BASE)[-1].outcome, 'filed')
        self.assertEqual(len(self.calls('issue')), 1)
        self.main_passes()
        r.reviewer.review_pass()
        r.run_pass()
        self.assertEqual([s['title'] for s in self.t3.starts], ['Queue runner build: first#9'])

    def test_main_passing_after_a_stop_that_never_filed_lets_builds_start(self):
        """F4: a red main whose issue never filed, then passing: nothing to close, and builds
        start again."""
        self.main_fails('tests')
        self.gh.check_states[H2] = Checks('pending', pending=('tests',))
        self.gh.fail.add('issue')
        r = self.runner()
        r.reviewer.review_pass()
        self.main_passes()
        r.reviewer.review_pass()
        self.assertEqual(self.calls('close-done'), [])
        r.run_pass()
        self.assertEqual([s['title'] for s in self.t3.starts], ['Queue runner build: first#9'])

    # --- the Inbox -----------------------------------------------------------------------------

    def test_the_inbox_lists_the_base_stop_once_as_broken_with_no_decide_in_t3(self):
        self.main_fails('tests')
        self.pr_fails(H2, 'tests')
        self.second_pr()
        self.pr_fails(H3, 'tests', run=438)
        r = self.runner()
        r.reviewer.review_pass()
        got = collect(self.config, self.gh, r.jobs)
        asks, answered = render(got, r.jobs.jobs(), repos=self.config.repos)
        mark(asks, answered, r.jobs.jobs(), {}, lambda repo: None)
        [a] = asks
        self.assertEqual((a['kind'], a['repo'], a['subject']),
                         ('broken', 'first', 'main fails its checks'))
        self.assertIsNone(a['decide'])
        self.assertEqual(a['go']['where'], 'github')
        self.assertEqual(a['holds_up'], ['PR #20 Red widget', 'PR #21 Blue widget',
                                         'Every new build in first'])
        self.assertTrue(any('main failed its checks' in s['text'] for s in a['timeline']),
                        a['timeline'])
        self.main_passes()
        r.reviewer.review_pass()
        self.assertEqual(collect(self.config, self.gh, r.jobs).items, [])


if __name__ == '__main__':
    unittest.main()
