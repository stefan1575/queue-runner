import unittest

from queue_runner.config import Repo
from queue_runner.picker import pick, pickable
from tests.fakes import FakeGitHub, issue, pr

REPO = Repo(name='demo', github='owner/demo', path='C:/demo')


class PickerTest(unittest.TestCase):
    def test_picks_the_lowest_numbered_ready_issue(self):
        gh = FakeGitHub(issues=[issue(12), issue(7), issue(30)])
        self.assertEqual(pick(REPO, gh).issue.number, 7)

    def test_nothing_ready_picks_nothing(self):
        self.assertIsNone(pick(REPO, FakeGitHub()))

    def test_skips_an_issue_whose_blocked_by_line_names_an_open_issue(self):
        gh = FakeGitHub(issues=[issue(5, body='Blocked by: #3, #4'), issue(9)],
                        states={3: 'closed', 4: 'open'})
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_picks_an_issue_whose_blockers_are_all_closed(self):
        gh = FakeGitHub(issues=[issue(5, body='**Blocked by:** #3, #4'), issue(9)],
                        states={3: 'closed', 4: 'closed'})
        self.assertEqual(pick(REPO, gh).issue.number, 5)

    def test_reads_a_blocked_by_section(self):
        body = ('## What to build\n\nSee #2.\n\n## Blocked by\n\n- #3\n- #4\n\n'
                '## Acceptance\n\n#8 too')
        gh = FakeGitHub(issues=[issue(5, body=body), issue(9)],
                        states={2: 'open', 3: 'closed', 4: 'open', 8: 'open'})
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_refs_outside_the_blocked_by_section_dont_block(self):
        body = ('Follows #2.\n\n## Blocked by\n\nNone (can start immediately).\n\n'
                '## Notes\n\n#8')
        gh = FakeGitHub(issues=[issue(5, body=body)], states={2: 'open', 8: 'open'})
        self.assertEqual(pick(REPO, gh).issue.number, 5)

    def test_skips_an_issue_with_an_open_native_blocker(self):
        gh = FakeGitHub(issues=[issue(5, open_blockers=1), issue(9)])
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_an_issue_whose_native_blockers_are_all_closed_is_picked(self):
        # GitHub's summary counts only open blockers: closed ones leave open_blockers at 0.
        gh = FakeGitHub(issues=[issue(5, open_blockers=0), issue(9)])
        self.assertEqual(pick(REPO, gh).issue.number, 5)

    def test_an_issue_blocked_either_way_waits(self):
        # #73: GitHub's native links and `Blocked by:` lines both count; either one open blocks.
        cases = {
            'native open, line closed': (1, 'Blocked by: #3', 'closed', 9),
            'native closed, line open': (0, 'Blocked by: #3', 'open', 9),
            'both open': (2, 'Blocked by: #3', 'open', 9),
            'both closed': (0, 'Blocked by: #3', 'closed', 5),
        }
        for name, (native, body, state, want) in cases.items():
            with self.subTest(name):
                gh = FakeGitHub(issues=[issue(5, body=body, open_blockers=native), issue(9)],
                                states={3: state})
                self.assertEqual(pick(REPO, gh).issue.number, want)

    def test_the_queue_leaves_out_natively_blocked_issues(self):
        # `pickable` is the dashboard's queue of builds: a natively blocked issue isn't in it.
        gh = FakeGitHub(issues=[issue(5, open_blockers=1), issue(7, body='Blocked by: #3'),
                                issue(9)], states={3: 'open'})
        self.assertEqual([j.issue.number for j in pickable(REPO, gh)], [9])

    def test_skips_an_issue_with_an_open_pr_on_its_branch(self):
        gh = FakeGitHub(issues=[issue(5), issue(9)], prs=[pr(20, 'claude/thing-5')],
                        branches=['claude/thing-5'])
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_skips_an_issue_an_open_pr_closes(self):
        gh = FakeGitHub(issues=[issue(5), issue(9)], prs=[pr(20, 'lovable/x', 'Fixes #5.')])
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_a_pr_that_only_mentions_the_issue_doesnt_count(self):
        gh = FakeGitHub(issues=[issue(5)], prs=[pr(20, 'lovable/x', 'Part of #5; closes #50')])
        self.assertEqual(pick(REPO, gh).issue.number, 5)

    def test_skips_an_issue_that_already_has_a_claude_branch(self):
        gh = FakeGitHub(issues=[issue(5), issue(9)], branches=['claude/old-try-5', 'claude/x-95'])
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_skips_an_issue_with_an_open_pr_linked_by_hand(self):
        gh = FakeGitHub(issues=[issue(5, open_linked_pulls=1), issue(9)])
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_a_qualified_blocker_in_this_repo_counts(self):
        gh = FakeGitHub(issues=[issue(5, body='Blocked by: owner/demo#3'), issue(9)],
                        states={3: 'open'})
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_a_blocker_in_another_repo_is_checked_there(self):
        gh = FakeGitHub(issues=[issue(5, body='Blocked by: other/lib#3'), issue(9)],
                        states={3: 'closed', ('other/lib', 3): 'open'})
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_a_blocker_given_as_a_url_counts(self):
        body = '## Blocked by\n\n- https://github.com/other/lib/issues/3'
        gh = FakeGitHub(issues=[issue(5, body=body), issue(9)], states={('other/lib', 3): 'open'})
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_skips_an_issue_a_pr_closes_by_qualified_ref(self):
        gh = FakeGitHub(issues=[issue(5), issue(9)], prs=[pr(20, 'feature/x', 'Fixes owner/demo#5')])
        self.assertEqual(pick(REPO, gh).issue.number, 9)

    def test_a_pr_closing_the_same_number_in_another_repo_doesnt_count(self):
        gh = FakeGitHub(issues=[issue(5)], prs=[pr(20, 'feature/x', 'Fixes other/lib#5')])
        self.assertEqual(pick(REPO, gh).issue.number, 5)

    def test_skips_a_spec_with_open_sub_issues(self):
        gh = FakeGitHub(issues=[issue(2, open_sub_issues=4), issue(9)])
        self.assertEqual(pick(REPO, gh).issue.number, 9)




class BuildJobTest(unittest.TestCase):
    def test_the_job_branches_from_origin_main_with_a_slug_and_the_issue_number(self):
        title = "Duplicated code: four judgement calls from #60's, #79's and #85's reviews"
        job = pick(REPO, FakeGitHub(issues=[issue(159, title=title)]))
        self.assertEqual(job.branch, 'claude/duplicated-code-four-judgement-159')
        self.assertEqual(job.base, 'origin/main')
        self.assertEqual(job.repo, REPO)

    def test_a_title_without_letters_still_makes_a_branch(self):
        job = pick(REPO, FakeGitHub(issues=[issue(4, title='!!!')]))
        self.assertEqual(job.branch, 'claude/issue-4')


if __name__ == '__main__':
    unittest.main()
