"""Merging a clean PR: the pre-merge re-check read afresh, the merge with the expected head, and
the worktrees removed after, with GitHub, git and Sol faked."""
import datetime
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Comment
from queue_runner.fix import fix_branch
from queue_runner.merge import READY, Merger
from queue_runner.review import Reviewer
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, FakeToaster, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeSol
from tests.test_ledger import H2, H3, important, reply

NOW = datetime.datetime(2026, 11, 9, 12, 0)
LATER = '2026-11-09T13:00:00Z'   # after the fake's review comment (12:00)


class MergeTest(unittest.TestCase):
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
        self.gh = FakeGitHubForReviews(prs=[full_pr(20, 'claude/red-5', H2, body='Makes it red.')])
        self.git = FakeReviewGit(heads={20: H2})

    def reviewer(self, *replies, merge=True):
        return Reviewer(self.config, github=self.gh, git=self.git,
                        sol=FakeSol(list(replies) or [reply()]), jobs=self.jobs,
                        say=self.said.append, now=lambda: NOW,
                        merger=None if merge else False)

    def merger(self):
        return Merger(self.config, github=self.gh, git=self.git, jobs=self.jobs,
                      say=self.said.append)

    def reviewed_clean(self):
        """Sol found H2 clean; nothing merged yet."""
        self.reviewer(merge=False).review_pass()
        self.assertEqual([p[0] for p in self.gh.posts], ['comment', 'status'])

    def merges(self):
        return [p[1:] for p in self.gh.posts if p[0] == 'merge']

    def outcomes(self, kind='merge'):
        return [j.outcome for j in self.jobs.jobs() if j.kind == kind]

    # --- the merge ------------------------------------------------------------------------

    def test_a_clean_review_merges_at_the_reviewed_head(self):
        self.reviewer().review_pass()
        self.assertEqual([p[0] for p in self.gh.posts], ['comment', 'status', 'merge'])
        self.assertEqual(self.merges(), [(20, H2)])
        [job] = [j for j in self.jobs.jobs() if j.kind == 'merge']
        self.assertEqual((job.outcome, job.sha, job.head), ('merged', H2, 'f' * 40))
        self.assertIn(f'merge first#20: merged at {H2[:7]} (merge commit fffffff)', self.said)

    def test_a_blocking_review_does_not_merge(self):
        self.reviewer(reply(findings=[important('F1')])).review_pass()
        self.assertEqual(self.merges(), [])
        self.assertEqual(list(self.merger().candidates(self.repo)), [])

    def test_a_clean_review_that_stops_for_stefan_does_not_merge(self):
        self.jobs.ended(self.jobs.started(kind='review', repo='first', issue=20,
                                          branch='claude/red-5', title='t', sha=H2,
                                          round=2).id, exit_code=None, outcome='stop',
                        verdict='clean')
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])

    def test_a_clean_head_left_unmerged_merges_on_a_later_pass(self):
        self.reviewed_clean()
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [(20, H2)])

    # --- the pre-merge re-check -----------------------------------------------------------

    def test_a_head_that_moved_after_the_review_is_not_merged_but_reviewed_again(self):
        self.reviewed_clean()
        self.gh.now[20] = {'head_sha': H3}
        m = self.merger()
        m.merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertEqual(self.outcomes(), [])   # nothing was tried
        r = self.reviewer(merge=False)
        [(pr, why)] = r.candidates(self.repo)
        self.assertEqual((pr.head_sha, why), (H3, None))   # the Sol lane reviews H3 next

    def test_a_push_while_merging_is_refused_by_the_expected_head(self):
        self.reviewed_clean()
        self.gh.push_before_merge[20] = H3
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertEqual(self.outcomes(), ['head-moved'])
        self.assertTrue(any('moved' in s and 'Sol reviews the new head' in s for s in self.said))

    def test_a_check_that_failed_after_the_review_holds_the_merge(self):
        self.reviewed_clean()
        self.gh.check_states[H2] = Checks('failed', failed=('build',))
        m = self.merger()
        m.merge_pass()
        m.merge_pass()
        self.assertEqual(self.merges(), [])
        said = [s for s in self.said if s.startswith('merge first#20: not now')]
        self.assertEqual(said, [f'merge first#20: not now, checks on {H2[:7]} are failed '
                                '(build)'])   # said once, not every pass
        self.gh.check_states[H2] = Checks('passed')
        m.merge_pass()
        self.assertEqual(self.merges(), [(20, H2)])

    def test_pending_checks_hold_the_merge(self):
        self.reviewed_clean()
        self.gh.check_states[H2] = Checks('pending', pending=('build',))
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])

    def test_a_reply_since_the_clean_review_holds_the_merge(self):
        self.reviewed_clean()
        self.gh.comments[20].append(Comment('michael', LATER, 'Wait, the copy is wrong.'))
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertTrue(any('1 reply since the clean review (michael)' in s for s in self.said))

    def test_a_bots_comment_since_the_review_does_not_hold_the_merge(self):
        self.reviewed_clean()
        self.gh.comments[20].append(Comment('vercel[bot]', LATER, 'Preview ready.'))
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [(20, H2)])

    def test_an_unresolved_review_thread_holds_the_merge(self):
        self.reviewed_clean()
        self.gh.threads[20] = 2
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertTrue(any('2 unresolved review threads' in s for s in self.said))

    def test_a_draft_holds_the_merge(self):
        self.reviewed_clean()
        self.gh.now[20] = {'draft': True}
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])

    def test_a_conflict_holds_the_merge(self):
        self.reviewed_clean()
        self.gh.now[20] = {'mergeable': False}
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertTrue(any('conflicts with main' in s for s in self.said))

    def test_a_blocking_review_posted_after_the_clean_one_holds_the_merge(self):
        self.reviewed_clean()
        from tests.test_ledger import old_marker
        self.gh.comments[20].append(Comment('stefan1575', LATER, '## Sol review 2 · Blocking\n\n'
                                            + old_marker(2, 'blocking', H2, [])))
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])

    def test_a_job_writing_to_the_branch_holds_the_merge(self):
        self.reviewed_clean()
        self.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                          title='Queue runner fix: first#20', sha=H2)
        self.merger().merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertTrue(any('a fix job is writing to claude/red-5' in s for s in self.said))

    def test_a_failed_merge_is_tried_once_more_then_left(self):
        self.reviewed_clean()
        self.gh.fail.add('merge')
        m = self.merger()
        for _ in range(3):
            m.merge_pass()
        self.assertEqual(self.outcomes(), ['failed', 'failed'])
        self.assertTrue(any('2 merges failed' in s for s in self.said))

    # --- after the merge ------------------------------------------------------------------

    def test_the_prs_build_and_fix_worktrees_are_removed_after_it_merges(self):
        build = self.jobs.started(kind='build', repo='first', issue=5, branch='claude/red-5',
                                  title='Queue runner build: first#5')
        self.jobs.ended(build.id, exit_code=0, outcome='done', worktree='C:/t3/wt/build')
        fix = self.jobs.started(kind='fix', repo='first', issue=20, branch='claude/red-5',
                                title='Queue runner fix: first#20', sha=H3)
        self.jobs.ended(fix.id, exit_code=0, outcome='pushed', worktree='C:/t3/wt/fix')
        other = self.jobs.started(kind='build', repo='first', issue=6, branch='claude/blue-6',
                                  title='Queue runner build: first#6')
        self.jobs.ended(other.id, exit_code=0, outcome='done', worktree='C:/t3/wt/other')
        self.git.stuck.add('C:/t3/wt/fix')
        self.reviewer().review_pass()
        self.assertEqual(self.git.removed_worktrees, [('C:/t3/wt/build', 'claude/red-5'),
                                                      ('C:/t3/wt/fix', fix_branch(20, H3))])
        self.assertIn('merge first#20: fix worktree C:/t3/wt/fix not removed; remove it by '
                      'hand', self.said)

    def test_a_merge_cut_off_with_its_runner_is_settled_from_github(self):
        self.reviewed_clean()
        self.jobs.started(kind='merge', repo='first', issue=20, branch='claude/red-5',
                          title='Queue runner merge: first#20', sha=H2)
        self.gh.now[20] = {'state': 'merged'}
        self.reviewer().review_pass()
        self.assertEqual(self.outcomes(), ['merged'])
        self.assertEqual(self.merges(), [])


class StefanMergesTest(unittest.TestCase):
    """merge = "stefan" (ticket 17): a ready PR is labelled and toasted once; Stefan merges."""

    def setUp(self):
        MergeTest.setUp(self)
        self.repo = Repo(name='first', github='owner/first', path=self.dir, merge='stefan')
        self.config = Config(repos=[self.repo], state_dir=self.config.state_dir,
                             log_dir=self.config.log_dir, runs_dir=self.config.runs_dir,
                             checkouts_dir=self.config.checkouts_dir)
        self.toaster = FakeToaster()

    reviewed_clean, merges, outcomes = (MergeTest.reviewed_clean, MergeTest.merges,
                                        MergeTest.outcomes)

    def reviewer(self, *replies, merge=True):
        return Reviewer(self.config, github=self.gh, git=self.git,
                        sol=FakeSol(list(replies) or [reply()]), jobs=self.jobs,
                        say=self.said.append, now=lambda: NOW, toaster=self.toaster,
                        merger=None if merge else False)

    def merger(self):
        return Merger(self.config, github=self.gh, git=self.git, jobs=self.jobs,
                      say=self.said.append, toaster=self.toaster)

    def labels(self):
        return [p for p in self.gh.posts if p[0] in ('label', 'unlabel')]

    def test_a_clean_review_marks_the_pr_ready_once_and_never_merges(self):
        self.reviewer().review_pass()
        m = self.merger()
        m.merge_pass()
        m.merge_pass()
        self.assertEqual(self.merges(), [])
        self.assertEqual(self.labels(), [('label', 20, READY)])
        [t] = self.toaster.toasts
        self.assertEqual((t['title'], t['url']), ('first PR #20 is ready to merge',
                                                  'https://github.com/owner/first/pull/20'))
        self.assertEqual(self.outcomes('ready'), ['marked'])
        self.assertEqual(self.outcomes(), [])
        self.assertIn(f'ready first#20: clean at {H2[:7]} with its checks passed: labelled '
                      f'{READY}, for Stefan to merge', self.said)

    def test_a_pr_not_ready_yet_is_not_marked(self):
        self.reviewed_clean()
        self.gh.check_states[H2] = Checks('pending', pending=('build',))
        self.merger().merge_pass()
        self.assertEqual((self.labels(), self.toaster.toasts), ([], []))

    def test_a_new_head_takes_the_mark_off_and_its_clean_review_marks_it_again(self):
        self.reviewer().review_pass()
        self.gh.now[20] = {'head_sha': H3, 'labels': (READY,)}
        self.git.heads[20] = H3
        self.merger().merge_pass()
        self.assertEqual(self.labels(), [('label', 20, READY), ('unlabel', 20, READY)])
        self.assertTrue(any('no longer ready for Stefan (the head moved' in s for s in self.said))
        self.gh.now[20] = {'head_sha': H3}
        self.reviewer().review_pass()   # Sol reviews H3 clean: ready again, a second toast
        self.assertEqual(self.labels()[-1], ('label', 20, READY))
        self.assertEqual(len(self.toaster.toasts), 2)
        self.assertEqual(self.outcomes('ready'), ['marked', 'unmarked', 'marked'])

    def test_a_stop_takes_the_mark_off(self):
        self.reviewer().review_pass()
        stop = self.jobs.started(kind='stop', repo='first', issue=20, branch='claude/red-5',
                                 title='t', sha=H2, stop='conflict')
        self.jobs.ended(stop.id, exit_code=None, outcome='filed', link='https://x/issues/1')
        self.gh.now[20] = {'labels': (READY,)}
        self.merger().merge_pass()
        self.assertEqual(self.labels()[-1], ('unlabel', 20, READY))
        self.assertEqual(self.outcomes('ready'), ['marked', 'unmarked'])

    def test_stefans_merge_is_noticed_once_and_the_worktrees_go(self):
        build = self.jobs.started(kind='build', repo='first', issue=5, branch='claude/red-5',
                                  title='Queue runner build: first#5')
        self.jobs.ended(build.id, exit_code=0, outcome='done', worktree='C:/t3/wt/build')
        self.reviewer().review_pass()
        self.gh.now[20] = {'state': 'merged', 'labels': (READY,)}   # Stefan merged it
        m = self.merger()
        m.merge_pass()
        m.merge_pass()
        [job] = [j for j in self.jobs.jobs() if j.kind == 'merge']
        self.assertEqual((job.outcome, job.sha, job.reason), ('merged', H2, 'Stefan merged it'))
        self.assertEqual(self.merges(), [])
        self.assertEqual(self.labels()[-1], ('unlabel', 20, READY))
        self.assertEqual(self.git.removed_worktrees, [('C:/t3/wt/build', 'claude/red-5')])
        self.assertIn('merge first#20: Stefan merged it; its live steps follow', self.said)

    def test_a_ready_pr_closed_unmerged_loses_its_mark_and_label(self):
        self.reviewer().review_pass()
        self.gh.now[20] = {'state': 'closed', 'labels': (READY,)}
        m = self.merger()
        m.merge_pass()
        m.merge_pass()
        self.assertEqual(self.outcomes('ready'), ['marked', 'unmarked'])
        self.assertEqual(self.labels()[-1], ('unlabel', 20, READY))
        self.assertEqual(self.outcomes(), [])

    def test_a_reply_after_the_mark_takes_it_off_and_the_inbox_drops_it(self):
        from queue_runner.inbox import ready_prs
        self.reviewer().review_pass()
        self.assertEqual(len(ready_prs(self.config, self.gh, self.jobs)[0]), 1)
        self.gh.comments[20].append(Comment('michael', LATER, 'Wait, this breaks the export.'))
        self.gh.now[20] = {'labels': (READY,)}
        m = self.merger()
        m.merge_pass()
        m.merge_pass()
        self.assertEqual(self.outcomes('ready'), ['marked', 'unmarked'])
        self.assertEqual(self.labels()[-1], ('unlabel', 20, READY))
        self.assertEqual(ready_prs(self.config, self.gh, self.jobs)[0], [])
        self.assertEqual(len(self.toaster.toasts), 1)

    def test_a_label_that_fails_is_tried_again_next_pass(self):
        self.reviewed_clean()
        self.gh.fail.add('label')
        self.merger().merge_pass()
        self.assertEqual((self.outcomes('ready'), self.toaster.toasts), (['failed'], []))
        self.gh.fail.discard('label')
        self.merger().merge_pass()
        self.assertEqual(self.outcomes('ready'), ['failed', 'marked'])
        self.assertEqual(len(self.toaster.toasts), 1)

    def test_a_live_run_does_not_hold_the_mark(self):
        self.reviewed_clean()
        self.jobs.started(kind='live', repo='first', issue=19, branch=None, title='t', sha=H3)
        self.merger().merge_pass()
        self.assertEqual(self.outcomes('ready'), ['marked'])


if __name__ == '__main__':
    unittest.main()
