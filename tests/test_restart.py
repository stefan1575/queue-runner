"""The runner restarting on its own new code (ticket 14): `SelfUpdate` on a real checkout with a
bare origin in a temp folder, `relaunch` with a fake process, and the loop through a fake."""
import os
import subprocess
import tempfile
import unittest

from queue_runner.config import Repo
from queue_runner.restart import SelfUpdate, relaunch
from queue_runner.lock import runner_lock
from tests.fakes import FakeToaster
from tests.test_wake import Done, UnattendedHarness


def git(*args, cwd):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True,
                          text=True).stdout.strip()


class SelfUpdateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.origin = os.path.join(tmp.name, 'origin.git')
        git('init', '-q', '--bare', '-b', 'main', self.origin, cwd=tmp.name)
        self.other = os.path.join(tmp.name, 'other')    # where merges land, as on GitHub
        git('clone', '-q', self.origin, self.other, cwd=tmp.name)
        self.commit(self.other, 'a.txt', 'one')
        git('push', '-q', 'origin', 'HEAD:main', cwd=self.other)
        self.repo = os.path.join(tmp.name, 'checkout')  # the runner's own checkout
        git('clone', '-q', self.origin, self.repo, cwd=tmp.name)
        self.lines = []
        self.update = SelfUpdate(Repo(name='queue-runner', github='o/queue-runner',
                                      path=self.repo), say=self.lines.append)

    def commit(self, cwd, name, text):
        with open(os.path.join(cwd, name), 'w') as f:
            f.write(text)
        git('add', name, cwd=cwd)
        git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name, cwd=cwd)
        return git('rev-parse', 'HEAD', cwd=cwd)

    def merge_on_origin(self, name='b.txt'):
        sha = self.commit(self.other, name, 'new')
        git('push', '-q', 'origin', 'HEAD:main', cwd=self.other)
        return sha

    def test_nothing_is_due_while_the_checkout_is_at_origin(self):
        self.assertFalse(self.update.due())

    def test_a_merge_on_origin_is_due_and_the_update_fast_forwards_the_checkout(self):
        new = self.merge_on_origin()
        self.assertTrue(self.update.due())
        self.assertEqual(self.update.update(), new)
        self.assertEqual(git('rev-parse', 'HEAD', cwd=self.repo), new)
        self.assertTrue(os.path.exists(os.path.join(self.repo, 'b.txt')))
        self.assertFalse(self.update.due())

    def test_a_checkout_on_another_branch_is_left_alone_and_said_once(self):
        git('switch', '-q', '-c', 'mine', cwd=self.repo)
        self.merge_on_origin()
        self.assertFalse(self.update.due())
        self.assertFalse(self.update.due())
        self.assertEqual(len(self.lines), 1)
        self.assertIn('mine', self.lines[0])

    def test_a_local_commit_on_main_is_left_alone(self):
        self.commit(self.repo, 'c.txt', 'mine')
        self.merge_on_origin()
        self.assertFalse(self.update.due())
        self.assertIn('fast-forward', self.lines[0])

    def test_a_switch_to_another_branch_while_waiting_is_not_fast_forwarded(self):
        self.merge_on_origin()
        self.assertTrue(self.update.due())
        git('switch', '-q', '-c', 'mine', cwd=self.repo)   # during the Sol lane's pass
        before = git('rev-parse', 'HEAD', cwd=self.repo)
        self.assertIsNone(self.update.update())
        self.assertEqual(git('rev-parse', 'mine', cwd=self.repo), before)
        self.assertEqual(git('rev-parse', 'main', cwd=self.repo), before)
        self.assertIn('changed while', self.lines[-1])

    def test_an_update_that_fails_is_said_and_not_due_again_for_that_commit(self):
        self.merge_on_origin('b.txt')
        with open(os.path.join(self.repo, 'b.txt'), 'w') as f:   # untracked, in the way
            f.write('local')
        self.assertTrue(self.update.due())
        self.assertIsNone(self.update.update())
        self.assertIn('could not update', self.lines[-1])
        self.assertFalse(self.update.due())
        os.remove(os.path.join(self.repo, 'b.txt'))
        newer = self.merge_on_origin('d.txt')   # main moves again: tried again
        self.assertTrue(self.update.due())
        self.assertEqual(self.update.update(), newer)


class FakeProcess:
    """A spawned runner: `exits` is the poll count after which it has ended with `code`; with
    `takes_lock`, it writes its pid to the pid file on the first poll."""

    def __init__(self, pid_file, *, pid=4242, takes_lock=True, exits=None, code=1, err='',
                 err_file=None):
        self.pid, self.pid_file, self.takes_lock = pid, pid_file, takes_lock
        self.exits, self.code, self.polls = exits, code, 0
        if err and err_file:
            with open(err_file, 'w', encoding='utf-8') as f:
                f.write(err)

    def poll(self):
        self.polls += 1
        if self.takes_lock and self.polls == 1:
            with open(self.pid_file, 'w') as f:
                f.write(str(self.pid))
        if self.exits is not None and self.polls > self.exits:
            return self.code
        return None


class RelaunchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.pid_file = os.path.join(tmp.name, 'runner.pid')
        self.err_file = os.path.join(tmp.name, 'restart.err')
        self.toaster, self.lines, self.t = FakeToaster(), [], 0.0
        self.spawned = []

    def clock(self):
        return self.t

    def sleep(self, s):
        self.t += s

    def run_relaunch(self, **process):
        def spawn(cmd, cwd, err):
            self.spawned.append((cmd, cwd, err))
            return FakeProcess(self.pid_file, err_file=err, **process)
        return relaunch(['pythonw', '-m', 'queue_runner'], cwd='C:/repo', sha='abc1234def',
                        github='o/queue-runner', pid_file=self.pid_file,
                        err_file=self.err_file, spawn=spawn, toaster=self.toaster,
                        say=self.lines.append, sleep=self.sleep, clock=self.clock)

    def test_a_runner_that_takes_the_lock_and_stays_up_has_restarted(self):
        self.assertTrue(self.run_relaunch())
        self.assertEqual(self.spawned[0][:2], (['pythonw', '-m', 'queue_runner'], 'C:/repo'))
        self.assertEqual(self.toaster.toasts, [])
        self.assertIn('restarted on abc1234 (pid 4242)', self.lines[-1])

    def test_new_code_that_dies_before_the_lock_toasts_with_its_error(self):
        ok = self.run_relaunch(takes_lock=False, exits=0,
                               err='Traceback ...\nSyntaxError: invalid syntax\n')
        self.assertFalse(ok)
        toast = self.toaster.toasts[0]
        self.assertIn('SyntaxError: invalid syntax', toast['text'])
        self.assertEqual(toast['url'], 'https://github.com/o/queue-runner/commit/abc1234def')
        self.assertIn('failed to start', self.lines[-1])
        self.assertIn('SyntaxError', self.lines[-1])

    def test_new_code_that_dies_soon_after_taking_the_lock_toasts(self):
        self.assertFalse(self.run_relaunch(exits=3, code=1, err='RuntimeError: boom\n'))
        self.assertIn('RuntimeError: boom', self.toaster.toasts[0]['text'])

    def test_a_runner_that_never_takes_the_lock_toasts(self):
        self.assertFalse(self.run_relaunch(takes_lock=False))
        self.assertIn("didn't take", self.toaster.toasts[0]['text'])

    def test_another_runner_holding_the_lock_is_no_failure(self):
        self.assertTrue(self.run_relaunch(takes_lock=False, exits=0, code=3))
        self.assertEqual(self.toaster.toasts, [])
        self.assertIn('another runner', self.lines[-1])

    def test_a_runner_that_cant_be_spawned_toasts(self):
        def spawn(cmd, cwd, err):
            raise FileNotFoundError('no such python')
        ok = relaunch(['missing.exe'], cwd='C:/repo', sha='abc1234def', github='o/queue-runner',
                      pid_file=self.pid_file, err_file=self.err_file, spawn=spawn,
                      toaster=self.toaster, say=self.lines.append, sleep=self.sleep,
                      clock=self.clock)
        self.assertFalse(ok)
        self.assertIn('no such python', self.toaster.toasts[0]['text'])

    def test_a_failed_toast_is_said(self):
        self.toaster.fail = True
        self.assertFalse(self.run_relaunch(takes_lock=False, exits=0, err='X: y\n'))
        self.assertIn('toast failed', self.lines[-1])


if __name__ == '__main__':
    unittest.main()


class FakeSelfUpdate:
    """Due after `after` checks; `update` gives `sha`, or None as git refusing would."""

    def __init__(self, after=1, sha='feedface1234', fails=False):
        self.after, self.sha, self.fails, self.checks, self.updates = after, sha, fails, 0, 0

    def due(self):
        self.checks += 1
        return self.checks >= self.after and not (self.fails and self.updates)

    def update(self):
        self.updates += 1
        return None if self.fails else self.sha


class LoopRestartTest(UnattendedHarness):
    """`main` in continuous mode: a due self-update ends the loop, and the runner is started
    again only after it let go of runner.lock and runner.pid."""

    def test_a_due_update_restarts_the_runner_after_it_lets_go_of_the_lock(self):
        seen = []

        def fake_relaunch(sha):
            with runner_lock(os.path.join(self.dir, 'state')):   # free to take now
                seen.append((sha, os.path.exists(os.path.join(self.dir, 'state', 'runner.pid'))))
            return True
        update = FakeSelfUpdate(after=2)
        code, _ = self.run_main([], self_update=update, relaunch=fake_relaunch)
        self.assertEqual(code, 0)
        self.assertEqual(seen, [('feedface1234', False)])
        self.assertEqual(len(self.t3.starts), 1)    # the first pass's build ran before it
        log = self.runner_log()
        self.assertIn('restarting on the new code', log)

    def test_new_code_that_fails_to_start_ends_this_runner_with_an_error_code(self):
        code, _ = self.run_main([], self_update=FakeSelfUpdate(), relaunch=lambda sha: False)
        self.assertEqual(code, 1)

    def test_an_update_git_refuses_carries_on_with_the_old_code(self):
        update = FakeSelfUpdate(fails=True)
        passes = []

        def sleep(s):
            passes.append(s)
            if len(passes) == 2:
                raise Done
        with self.assertRaises(Done):
            self.run_main([], self_update=update, relaunch=lambda sha: self.fail('restarted'),
                          sleep=sleep)
        self.assertEqual(update.updates, 1)
