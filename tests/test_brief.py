import os
import tempfile
import unittest

from queue_runner.brief import build_brief
from queue_runner.config import Repo
from queue_runner.github import Comment
from queue_runner.picker import pick
from tests.fakes import FakeGitHub, issue


class BuildBriefTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Repo(name='demo', github='owner/demo', path=self.tmp.name)
        body = 'Make the widget blue.\n\n## Acceptance\n\n- [ ] It costs $5'
        self.job = pick(self.repo, FakeGitHub(issues=[issue(42, 'Blue widget', body)]))
        self.comments = [Comment('stefan', '2026-11-01T10:00:00Z', 'Navy, not sky blue.')]

    def brief(self):
        return build_brief(self.job, self.comments)

    def test_starts_with_the_issue(self):
        self.assertTrue(self.brief().startswith('Build GitHub issue #42 in owner/demo'))

    def test_carries_the_issue_title_body_and_comments(self):
        text = self.brief()
        self.assertIn('Blue widget', text)
        self.assertIn('Make the widget blue.\n\n## Acceptance\n\n- [ ] It costs $5', text)
        self.assertIn('stefan', text)
        self.assertIn('2026-11-01T10:00:00Z', text)
        self.assertIn('Navy, not sky blue.', text)

    def test_the_build_goes_through_the_check_before_it_pushes(self):
        # Stefan, 2026-11-19: 60% of PRs blocked on review 1, mostly on the same few causes.
        text = ' '.join(self.brief().split())
        self.assertIn('go through Before you push (below), then push', text)
        self.assertIn('## Before you push', text)
        self.assertIn('read to its last page', text)
        self.assertIn("Don't run a review", text)
        self.assertNotIn("Don't review your own work", text)

    def test_text_only_output_needs_no_screenshots(self):
        text = ' '.join(self.brief().split())
        self.assertIn('Output that is only text', text)

    def test_says_when_the_issue_has_no_comments(self):
        self.comments = []
        self.assertIn('No comments.', self.brief())

    def test_names_the_branch_and_its_base(self):
        text = self.brief()
        self.assertIn('`claude/blue-widget-42`', text)
        self.assertIn('`origin/main`', text)

    def test_points_at_the_repos_agents_md_when_it_has_one(self):
        open(os.path.join(self.tmp.name, 'AGENTS.md'), 'w').close()
        self.assertIn("Read the repo's `AGENTS.md` first", self.brief())

    def test_falls_back_to_claude_md(self):
        open(os.path.join(self.tmp.name, 'CLAUDE.md'), 'w').close()
        self.assertIn("Read the repo's `CLAUDE.md` first", self.brief())

    def test_tells_the_job_to_commit_each_step_and_open_the_pr(self):
        text = self.brief()
        self.assertIn('Commit after every step', text)
        self.assertIn('decision', text)
        self.assertIn('open the PR with the body below', text)
        self.assertIn('## Merge Danger', text)
        self.assertIn('Closes #42', text)

    def test_says_how_to_work_without_naming_a_skill(self):
        text = self.brief()
        self.assertIn('Write a failing test first where one fits', text)
        self.assertIn('the full test suite once at the end', text)

    def test_names_the_runners_own_screenshot_script(self):
        from queue_runner.brief import EVIDENCE
        text = self.brief()
        self.assertIn(f'python3 -I {EVIDENCE} shoot URL OUT.png', text)
        # PR #115 review 1, F1: GitCli.evidence reads pr-<number>/, so a build publishes there,
        # once the PR is open and has its number, never into issue-<number>/.
        self.assertIn("--into pr-<the PR's number>", text)
        self.assertNotIn('issue-42', text)


if __name__ == '__main__':
    unittest.main()
