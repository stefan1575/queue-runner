"""A fix round on a blocking PR: which PRs get one, its brief built from the ledger, git and the job
log, the fresh thread from the PR's head, and how its end is recorded, with GitHub, T3, git and Sol
faked."""
import io
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.github import Comment, Issue
from queue_runner.fix import fix_branch
from queue_runner.run import Runner
from tests.fakes import FakeGitHubForReviews, full_pr, issue
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import H2, H3, important, nit, reply

WORK = fix_branch(20, H2)
COMMITS = [{'sha': '1' * 40, 'subject': 'Make the widget red'},
           {'sha': '2' * 40, 'subject': 'Test the red'}]


class PushingT3(FakeT3):
    """A fix thread that pushes `pushes` to the PR (its new head) before it ends."""

    def __init__(self, outcomes, gh, pushes=None):
        super().__init__(outcomes)
        self.gh, self.pushes = gh, pushes

    def start(self, *args, **kwargs):
        result = super().start(*args, **kwargs)
        if self.pushes:
            self.gh.now[20] = {'head_sha': self.pushes}
        return result


class FixTest(unittest.TestCase):
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
            prs=[full_pr(20, 'claude/red-5', H2, body='Closes #5\n\nMakes it red.',
                         title='Red widget', base='main')],
            comments={5: []},
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')},
            pulls_by_branch={'claude/blue-widget-9': {'number': 21, 'url': 'u', 'state': 'open'}})
        self.git = FakeReviewGit(heads={20: H2}, commits={
            ('origin/main', H2): COMMITS, (H2, H3): [{'sha': H3, 'subject': 'Fix F1'}]})
        self.out = io.StringIO()

    def runner(self, t3, *replies):
        self.t3 = t3
        self.sol = FakeSol(list(replies) or [reply(findings=[important('F1'), nit('F2')])])
        return Runner(self.config, github=self.gh, t3=t3, git=self.git, out=self.out,
                      log_line=lambda line: None, sol=self.sol)

    def blocking(self, t3=None, pushes=None, outcomes=((0, 'completed'),)):
        """Sol's review 1 of H2 is blocking: F1 Important, F2 a nit."""
        r = self.runner(t3 or PushingT3(list(outcomes), self.gh, pushes))
        r.reviewer.review_pass()
        [review] = [j for j in r.jobs.jobs() if j.kind == 'review']
        self.assertEqual(review.outcome, 'blocking')
        return r

    def fixes(self, r):
        return [j for j in r.jobs.jobs() if j.kind == 'fix']

    # --- starting one ---------------------------------------------------------------------

    def test_a_blocking_pr_gets_a_fix_thread_from_its_head_before_any_build(self):
        r = self.blocking(pushes=H3)
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual((start['worktree'], start['branch'], start['title']),
                         (H2, WORK, 'Queue runner fix: first#20'))
        self.assertEqual((start['provider'], start['model']), ('claudeAgent', 'claude-opus-5-5'))
        [fix] = self.fixes(r)
        self.assertEqual((fix.branch, fix.sha, fix.round), ('claude/red-5', H2, 1))
        self.assertIn(f'git push origin HEAD:claude/red-5', start['message'])

    def test_the_brief_comes_from_the_ledger_git_and_earlier_threads(self):
        build = None
        r = self.runner(PushingT3([(0, 'completed')], self.gh))
        build = r.jobs.started(kind='build', repo='first', issue=5, branch='claude/red-5',
                               title='Queue runner build: first#5')
        r.jobs.ended(build.id, exit_code=0, outcome='done',
                     link='https://app.t3.codes/threads/env/mcp:build')
        r.reviewer.review_pass()
        r.run_pass()
        brief = self.t3.starts[0]['message']
        # The ledger: the Important finding with its class and scenario, the nit apart.
        self.assertIn('**F1** · Important · write logged wrongly · `src/a.ts:10` · open', brief)
        self.assertIn('Scenario: this input, that wrong result', brief)
        self.assertIn('**Classes to fix:** "write logged wrongly"', brief)
        self.assertIn('**F2** · Nit', brief)
        self.assertIn('https://github.com/owner/first/pull/20#issuecomment-', brief)
        # Git: the branch's commits and the files it changes.
        self.assertIn('- `1111111` Make the widget red\n- `2222222` Test the red', brief)
        self.assertIn(f'1 file changed (origin/main...{H2})', brief)
        # The job log: the build thread's link, as T3 gave it.
        self.assertIn('build job', brief)
        self.assertIn('https://app.t3.codes/threads/env/mcp:build', brief)
        self.assertIn('It closes: #5', brief)
        for handoff in ('progress.md', 'notes.md', 'handoff'):
            self.assertNotIn(handoff, brief.replace('no handoff\nfiles', ''))

    def test_earlier_declines_and_fixes_are_in_the_brief(self):
        r = self.runner(PushingT3([(0, 'completed')], self.gh),
                        reply(findings=[important('F1')]),
                        reply(findings=[important('F3', cls='grant missing', file='src/b.ts')],
                              earlier=[{'id': 'F1', 'status': 'decline-accepted'}]))
        r.reviewer.review_pass()
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        self.git.ancestors.add((H2, H3))
        r.reviewer.review_pass()   # review 2 on H3: F1's decline accepted, F3 new
        r.run_pass()
        brief = self.t3.starts[0]['message']
        self.assertIn('- **F1** · write logged wrongly · decline accepted', brief)
        self.assertIn('**F3** · Important · grant missing', brief)
        self.assertIn('Sol\'s review 2', brief)

    def test_a_stop_or_an_approach_note_gets_no_fix_round(self):
        for outcome in ('stop', 'approach-note', 'clean'):
            with self.subTest(outcome):
                r = self.runner(FakeT3([]))
                j = r.jobs.started(kind='review', repo='first', issue=20, branch='claude/red-5',
                                   title='t', sha=H2, round=3)
                r.jobs.ended(j.id, exit_code=None, outcome=outcome)
                self.assertIsNone(r.next_fix())
                os.remove(r.jobs.path)

    def test_a_newer_review_comment_on_the_pr_holds_the_fix(self):
        r = self.blocking()
        from tests.test_ledger import old_marker
        self.gh.comments[20].append(Comment('stefan1575', '2026-11-09T13:00:00Z',
                                            '## Sol review 2 · Clean\n\n'
                                            + old_marker(2, 'clean', H2, [])))
        self.assertIsNone(r.next_fix())
        self.assertIn('not the blocking review', self.out.getvalue())

    def test_a_head_that_moved_since_the_review_gets_no_fix_round(self):
        r = self.blocking()
        self.gh.now[20] = {'head_sha': H3}
        self.assertIsNone(r.next_fix())

    # --- how it ends ----------------------------------------------------------------------

    def test_a_round_that_pushed_is_recorded_and_the_new_head_reviewed(self):
        r = self.blocking(pushes=H3)
        r.run_pass()
        [fix] = self.fixes(r)
        self.assertEqual((fix.outcome, fix.head), ('pushed', H3))
        self.assertEqual(fix.commits, [{'sha': H3, 'subject': 'Fix F1'}])
        self.assertEqual(fix.worktree, 'C:/t3/worktrees/mcp:t1')
        self.assertIn('fix first#20 ended: pushed', self.out.getvalue())
        # The Sol lane reviews the new head.
        self.git.heads[20] = H3
        self.git.ancestors.add((H2, H3))
        self.sol.replies.append(reply(earlier=[{'id': 'F1', 'status': 'fixed'}]))
        r.reviewer.review_pass()
        review2 = [j for j in r.jobs.jobs() if j.kind == 'review'][-1]
        self.assertEqual((review2.sha, review2.round, review2.outcome), (H3, 2, 'clean'))

    def test_a_round_that_ended_without_pushing_is_recorded_and_h_not_reviewed_again(self):
        r = self.blocking()
        r.run_pass()
        [fix] = self.fixes(r)
        self.assertEqual((fix.outcome, fix.head), ('no-push', H2))
        self.assertEqual(r.reviewer.review_pass(), 'idle')   # H2 was reviewed: not again
        self.assertEqual(len(self.sol.briefs), 1)
        self.assertIsNone(r.next_fix())                      # and H2 gets no second round
        self.assertIn('ended no-push and the head is still', self.out.getvalue())
        self.assertEqual(len(self.t3.starts), 1)

    def test_release_lets_a_head_that_got_no_push_have_another_round(self):
        r = self.blocking(outcomes=[(0, 'completed'), (0, 'completed')])
        r.run_pass()
        r.jobs.released('first', 20)
        self.assertIsNotNone(r.next_fix())

    def test_after_a_release_sol_still_leaves_the_reviewed_head_alone(self):
        # The release lets H have another fix round; its review comment keeps Sol off H, so the
        # round is the PR's one writer.
        r = self.blocking(outcomes=[(0, 'completed'), (0, 'completed')])
        r.run_pass()
        r.jobs.released('first', 20)
        self.assertIsNotNone(r.next_fix())
        why = r.reviewer.why_not(self.repo, self.gh.pull(self.repo, 20))
        self.assertEqual(why, 'review 1 is on bbbbbbb already (blocking)')

    def test_a_round_whose_pr_cannot_be_read_after_is_recorded_head_unknown(self):
        gh = self.gh

        class GitHubDownAfter(PushingT3):
            def start(self, *args, **kwargs):
                result = super().start(*args, **kwargs)
                gh.fail.add('pull')   # GitHub goes down while the round runs
                return result
        r = self.blocking(t3=GitHubDownAfter([(0, 'completed')], gh, H3))
        r.run_pass()
        [fix] = self.fixes(r)
        self.assertEqual((fix.outcome, fix.head), ('head-unknown', None))
        self.assertIn('gh failed', fix.error)

    def test_a_failed_round_holds_its_head_too(self):
        r = self.blocking(outcomes=[(1, 'failed')])
        r.run_pass()
        self.assertEqual([j.outcome for j in self.fixes(r)], ['failed'])
        self.assertIsNone(r.next_fix())

    def test_a_round_waiting_for_an_answer_is_the_prs_one_writer(self):
        r = self.blocking(outcomes=[(2, 'waiting')])
        r.run_pass()
        self.assertEqual([j.outcome for j in self.fixes(r)], ['waiting'])
        self.assertIsNone(r.next_fix())
        why = r.reviewer.why_not(self.repo, self.gh.pull(self.repo, 20))
        self.assertEqual(why, 'its fix waits for an answer, and may write to the branch again')

    def test_an_open_round_is_the_prs_one_writer(self):
        r = self.blocking()
        r.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                       title='Queue runner fix: first#20', sha=H2, round=1)
        self.gh.now[20] = {'head_sha': H3}   # it pushed once and goes on
        why = r.reviewer.why_not(self.repo, self.gh.pull(self.repo, 20))
        self.assertEqual(why, 'a fix job is still writing to its branch')

    def test_a_round_left_open_by_a_dead_runner_is_settled_from_its_thread(self):
        r = self.blocking()
        job = r.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                             title='Queue runner fix: first#20', sha=H2, round=1)
        self.t3.add('mcp:old', 'Queue runner fix: first#20', 'completed',
                    worktree_path='C:/t3/wt/fix')
        self.gh.now[20] = {'head_sha': H3}
        self.git.heads[20] = H3
        self.assertEqual(r.settle(), None)
        [fix] = [j for j in self.fixes(r) if j.id == job.id]
        self.assertEqual((fix.outcome, fix.head, fix.worktree), ('pushed', H3, 'C:/t3/wt/fix'))

    def test_a_leftover_fix_branch_starts_nothing(self):
        r = self.blocking()
        self.git.local_branches.add(WORK)
        self.assertEqual(r.run_pass(), 'idle')
        self.assertEqual([j.outcome for j in self.fixes(r)], ['branch-exists'])
        self.assertEqual(self.t3.starts, [])


if __name__ == '__main__':
    unittest.main()
