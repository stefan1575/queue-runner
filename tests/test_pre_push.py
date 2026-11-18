"""#172: main is tested before it moves. `scripts/pre_push.py` decides, on fakes; then a real
`git push` from a temp repo with the hook installed by `scripts/install_hooks.py`: a push to main
with a failing test is refused, a push to another branch isn't checked."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import pre_push  # noqa: E402

A = 'a' * 40
B = 'b' * 40
ZERO = '0' * 40


class Run:
    def __init__(self, codes):
        self.codes = list(codes)
        self.commands = []

    def __call__(self, command, env):
        self.commands.append(command)
        assert not any(k.startswith('GIT_') for k in env)
        return subprocess.CompletedProcess(command, self.codes.pop(0))


def fake_git(head=A, status=''):
    return lambda *args: head if args[0] == 'rev-parse' else status


CHECKS = lambda: [['py', 'unittest'], ['pnpm', 'typecheck'], ['pnpm', 'test']]  # noqa: E731


class DecideTest(unittest.TestCase):
    def main(self, lines, run, **kw):
        said = []
        code = pre_push.main(lines, run=run, checks=CHECKS, git=kw.get('git', fake_git()), say=said.append)
        return code, said

    def test_a_push_to_main_runs_every_check(self):
        run = Run([0, 0, 0])
        code, _ = self.main([f'refs/heads/x {A} refs/heads/main {B}'], run)
        self.assertEqual(code, 0)
        self.assertEqual(run.commands, CHECKS())

    def test_a_failing_check_refuses_the_push_and_stops_there(self):
        run = Run([0, 1])
        code, said = self.main([f'refs/heads/x {A} refs/heads/main {B}'], run)
        self.assertEqual(code, 1)
        self.assertEqual(run.commands, CHECKS()[:2])
        self.assertIn('refused: typecheck failed (exit 1)', said[-1])

    def test_a_push_to_another_branch_runs_nothing(self):
        run = Run([])
        code, said = self.main([f'refs/heads/x {A} refs/heads/feature {ZERO}'], run)
        self.assertEqual((code, said, run.commands), (0, [], []))

    def test_deleting_main_runs_nothing(self):
        run = Run([])
        self.assertEqual(self.main([f'(delete) {ZERO} refs/heads/main {B}'], run)[0], 0)
        self.assertEqual(run.commands, [])

    def test_main_among_other_refs_is_checked(self):
        run = Run([0, 0, 0])
        lines = [f'refs/heads/x {B} refs/heads/feature {ZERO}', f'refs/heads/y {A} refs/heads/main {B}']
        self.assertEqual(self.main(lines, run)[0], 0)
        self.assertEqual(len(run.commands), 3)

    def test_a_commit_not_checked_out_is_refused_untested(self):
        run = Run([])
        code, said = self.main([f'refs/heads/x {A} refs/heads/main {B}'], run, git=fake_git(head=B))
        self.assertEqual((code, run.commands), (1, []))
        self.assertIn('check out aaaaaaa', said[0])

    def test_changed_tracked_files_are_refused_untested(self):
        run = Run([])
        code, _ = self.main([f'refs/heads/x {A} refs/heads/main {B}'], run, git=fake_git(status=' M x.py'))
        self.assertEqual((code, run.commands), (1, []))

    def test_a_check_that_cant_start_refuses(self):
        def run(command, env):
            raise FileNotFoundError('no pnpm')
        code, said = self.main([f'refs/heads/x {A} refs/heads/main {B}'], run)
        self.assertEqual(code, 1)
        self.assertIn('could not start', said[-1])


def git(*args, cwd):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True,
                          env={k: v for k, v in os.environ.items() if not k.startswith('GIT_')})


class RealPushTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = os.path.join(tmp.name, 'repo')
        origin = os.path.join(tmp.name, 'origin.git')
        os.makedirs(os.path.join(self.repo, 'scripts'))
        shutil.copytree(os.path.join(ROOT, 'hooks'), os.path.join(self.repo, 'hooks'))
        for name in ('pre_push.py', 'install_hooks.py'):
            shutil.copy(os.path.join(ROOT, 'scripts', name), os.path.join(self.repo, 'scripts', name))
        with open(os.path.join(self.repo, 'test_broken.py'), 'w', encoding='utf-8') as f:
            f.write('import unittest\n\nclass T(unittest.TestCase):\n    def test_it(self):\n        self.fail()\n')
        self.assertEqual(git('init', '-q', '--bare', origin, cwd=tmp.name).returncode, 0)
        for args in (['init', '-q', '-b', 'work'], ['config', 'user.name', 't'], ['config', 'user.email', 't@example.invalid'],
                     ['add', '.'], ['commit', '-qm', 'a failing test'], ['remote', 'add', 'origin', origin]):
            done = git(*args, cwd=self.repo)
            self.assertEqual(done.returncode, 0, done.stderr)
        installed = subprocess.run([sys.executable, os.path.join('scripts', 'install_hooks.py')], cwd=self.repo,
                                   capture_output=True, text=True)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(git('config', 'core.hooksPath', cwd=self.repo).stdout.strip(), 'hooks')

    def test_a_push_to_main_with_a_failing_test_is_refused(self):
        pushed = git('push', 'origin', 'HEAD:main', cwd=self.repo)
        self.assertNotEqual(pushed.returncode, 0)
        self.assertIn('pre-push: refused: -m unittest failed', pushed.stderr)
        self.assertEqual(git('ls-remote', 'origin', 'main', cwd=self.repo).stdout, '')

    def test_a_push_to_another_branch_isnt_checked(self):
        pushed = git('push', 'origin', 'HEAD:feature', cwd=self.repo)
        self.assertEqual(pushed.returncode, 0, pushed.stderr)
        self.assertNotIn('pre-push', pushed.stderr)


if __name__ == '__main__':
    unittest.main()
