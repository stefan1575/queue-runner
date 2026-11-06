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

    def test_starts_the_implement_skill_on_the_issue(self):
        self.assertTrue(self.brief().startswith('/implement GitHub issue #42 in owner/demo'))

    def test_carries_the_issue_title_body_and_comments(self):
        text = self.brief()
        self.assertIn('Blue widget', text)
        self.assertIn('Make the widget blue.\n\n## Acceptance\n\n- [ ] It costs $5', text)
        self.assertIn('stefan', text)
        self.assertIn('2026-11-01T10:00:00Z', text)
        self.assertIn('Navy, not sky blue.', text)

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
        self.assertIn("open the PR the way the repo's own rules say", text)
        self.assertIn('Closes #42', text)


if __name__ == '__main__':
    unittest.main()
