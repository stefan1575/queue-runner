"""GitCli against a real local git repo in a temp folder (no network): a fix round's commits and
files, and removing a job's worktree and branch after its PR merged."""
import os
import subprocess
import tempfile
import unittest

from queue_runner.git import GitCli


def git(*args, cwd):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True,
                          text=True).stdout.strip()


class GitCliTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = os.path.join(tmp.name, 'repo')
        os.makedirs(self.repo)
        git('init', '-q', '-b', 'main', cwd=self.repo)
        git('config', 'user.email', 't@example.com', cwd=self.repo)
        git('config', 'user.name', 'T', cwd=self.repo)
        self.commit('a.txt', 'one', 'First')
        self.base = git('rev-parse', 'HEAD', cwd=self.repo)
        self.wt = os.path.join(tmp.name, 'wt')
        git('worktree', 'add', '-q', '-b', 'claude/x-1', self.wt, cwd=self.repo)
        self.commit('b.txt', 'two', 'Add b', cwd=self.wt)
        self.head = git('rev-parse', 'HEAD', cwd=self.wt)
        self.cli = GitCli()

    def commit(self, name, text, subject, cwd=None):
        cwd = cwd or self.repo
        with open(os.path.join(cwd, name), 'w') as f:
            f.write(text)
        git('add', name, cwd=cwd)
        git('commit', '-q', '-m', subject, cwd=cwd)

    def test_log_and_diffstat_between_two_commits(self):
        self.assertEqual(self.cli.log(self.repo, self.base, self.head),
                         [{'sha': self.head, 'subject': 'Add b'}])
        self.assertIn('b.txt', self.cli.diffstat(self.repo, self.base, self.head))

    def test_a_merged_pr_on_the_first_parent_line_and_its_files(self):
        git('merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from o/claude/x-1',
            'claude/x-1', cwd=self.repo)
        merge = git('rev-parse', 'HEAD', cwd=self.repo)
        self.assertEqual(self.cli.sha(self.repo, 'main'), merge)
        self.assertEqual(self.cli.first_parent(self.repo, self.base, merge),
                         [{'sha': merge, 'subject': 'Merge pull request #7 from o/claude/x-1'}])
        self.assertEqual(self.cli.name_status(self.repo, self.base, merge), [('A', 'b.txt')])

    def test_a_worktree_and_its_branch_are_removed(self):
        self.assertTrue(self.cli.remove_worktree(self.repo, self.wt.replace('\\', '/'),
                                                 'claude/x-1'))
        self.assertFalse(os.path.exists(os.path.join(self.wt, 'b.txt')))
        self.assertFalse(self.cli.has_branch(self.repo, 'claude/x-1'))

    def test_a_limited_jobs_branch_and_folder_are_freed_for_t3_to_make_again(self):
        with open(os.path.join(self.wt, 'b.txt'), 'w') as f:
            f.write('half done')   # left uncommitted by the thread the limit cut off
        with open(os.path.join(self.wt, 'new.txt'), 'w') as f:
            f.write('untracked')
        tip, wip = self.cli.free_branch(self.repo, 'claude/x-1', self.wt)
        self.assertEqual(tip, self.head)
        self.assertFalse(self.cli.has_branch(self.repo, 'claude/x-1'))
        # What it left is kept in a commit, untracked files too.
        self.assertEqual(git('show', f'{wip}:b.txt', cwd=self.repo), 'half done')
        self.assertEqual(git('show', f'{wip}:new.txt', cwd=self.repo), 'untracked')
        # T3 makes the same branch again, at the tip, in the same folder.
        git('worktree', 'add', '-q', '-b', 'claude/x-1', self.wt, tip, cwd=self.repo)
        with open(os.path.join(self.wt, 'b.txt')) as f:
            self.assertEqual(f.read(), 'two')
        # A second try (T3 failed to start the first time) finds what it kept.
        git('worktree', 'remove', '--force', self.wt, cwd=self.repo)
        git('branch', '-D', 'claude/x-1', cwd=self.repo)
        self.assertEqual(self.cli.free_branch(self.repo, 'claude/x-1', self.wt), (tip, wip))

    def test_a_clean_worktree_leaves_nothing_uncommitted(self):
        self.assertEqual(self.cli.free_branch(self.repo, 'claude/x-1', self.wt),
                         (self.head, None))
        self.assertFalse(os.path.exists(os.path.join(self.wt, 'b.txt')))

    def test_a_branch_never_made_has_no_tip(self):
        self.assertEqual(self.cli.free_branch(self.repo, 'claude/none-2', None), (None, None))

    def test_a_worktree_already_gone_counts_as_removed(self):
        self.cli.remove_worktree(self.repo, self.wt, None)
        self.assertTrue(self.cli.remove_worktree(self.repo, self.wt, 'claude/x-1'))
