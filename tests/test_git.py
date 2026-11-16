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

    def test_removing_a_review_checkout_keeps_what_its_node_modules_links_to(self):
        """git worktree remove --force follows a junction and empties its target (ticket 16):
        the dependency cache behind a checkout's node_modules must survive."""
        import _winapi
        cache = os.path.join(os.path.dirname(self.repo), 'cache', 'node_modules')
        os.makedirs(os.path.join(cache, 'react'))
        checkout = os.path.join(os.path.dirname(self.repo), 'checkout')
        self.cli.checkout(self.repo, self.head, checkout)
        _winapi.CreateJunction(cache, os.path.join(checkout, 'node_modules'))
        self.cli.checkout(self.repo, self.head, checkout)   # made afresh: the old one removed
        _winapi.CreateJunction(cache, os.path.join(checkout, 'node_modules'))
        self.cli.remove_checkout(self.repo, checkout)
        self.assertFalse(os.path.exists(checkout))
        self.assertTrue(os.path.isdir(os.path.join(cache, 'react')))

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

    def test_a_checkout_git_cant_delete_is_moved_aside_and_the_next_one_is_made(self):
        """Ticket 45: Sol's sandbox user left owner-only folders in the checkout, so `git
        worktree remove` unregistered it but left its folder, and the next review's `worktree
        add` refused the path. A deny-delete ACL plays the sandbox user's folder."""
        checkout = os.path.join(os.path.dirname(self.repo), 'checkouts', 'repo-pr6')
        self.cli.checkout(self.repo, self.head, checkout)
        locked = os.path.join(checkout, '.review-tmp', 'tmp1')
        deny_delete(self, locked)
        moved = self.cli.remove_checkout(self.repo, checkout)
        self.addCleanup(subprocess.run, ['icacls', os.path.join(moved, '.review-tmp', 'tmp1'),
                                         '/remove:d', '*S-1-1-0'], capture_output=True)
        self.assertFalse(os.path.exists(checkout))
        self.assertTrue(os.path.basename(moved).startswith('repo-pr6.stale-'), moved)
        self.assertTrue(os.path.isdir(os.path.join(moved, '.review-tmp', 'tmp1')))
        self.cli.checkout(self.repo, self.head, checkout)   # the next review
        self.assertTrue(os.path.isfile(os.path.join(checkout, 'b.txt')))
        self.assertNotIn('repo-pr6.stale', git('worktree', 'list', cwd=self.repo))

    def test_a_checkout_removed_whole_moves_nothing_aside(self):
        checkout = os.path.join(os.path.dirname(self.repo), 'checkouts', 'repo-pr6')
        self.cli.checkout(self.repo, self.head, checkout)
        self.assertIsNone(self.cli.remove_checkout(self.repo, checkout))
        self.assertEqual(os.listdir(os.path.dirname(checkout)), [])

    def test_folders_moved_aside_are_swept_once_they_can_be_deleted(self):
        checkouts = os.path.join(os.path.dirname(self.repo), 'checkouts')
        free = os.path.join(checkouts, 'repo-pr4.stale-20261116-010203')
        held = os.path.join(checkouts, 'repo-pr6.stale-20261116-010203')
        live = os.path.join(checkouts, 'repo-pr7')
        for d in (free, held, live):
            os.makedirs(os.path.join(d, 'x'))
        deny_delete(self, os.path.join(held, 'x'))
        self.assertEqual(self.cli.sweep_stale(checkouts), [held])
        self.assertEqual(sorted(os.listdir(checkouts)), ['repo-pr6.stale-20261116-010203',
                                                         'repo-pr7'])
        self.assertEqual(self.cli.sweep_stale(os.path.join(checkouts, 'none')), [])


def deny_delete(test, folder):
    """Makes `folder` (and a file in it) undeletable by anyone, as the folders Sol's sandbox
    user leaves are for Stefan; undone at the test's end so the temp folder can go."""
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'f.txt'), 'w') as f:
        f.write('x')
    subprocess.run(['icacls', folder, '/deny', '*S-1-1-0:(OI)(CI)(DE,DC)'], check=True,
                   capture_output=True)
    test.addCleanup(lambda: subprocess.run(['icacls', folder, '/remove:d', '*S-1-1-0'],
                                           capture_output=True))
