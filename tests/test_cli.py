import io
import os
import tempfile
import unittest

from queue_runner.cli import main
from tests.fakes import FakeGitHub, FakeUsage, issue


class DryRunTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.config = os.path.join(self.dir, 'config.toml')
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(f'''
state_dir = "{self.dir}/state"
log_dir = "{self.dir}/logs"

[[repos]]
name = "first"
github = "owner/first"
path = "{self.dir}"

[[repos]]
name = "second"
github = "owner/second"
path = "{self.dir}"
'''.replace('\\', '/'))

    def run_main(self, args, github):
        out = io.StringIO()
        code = main(args, github=github, out=out, usage=FakeUsage())
        return code, out.getvalue()

    def test_prints_the_job_it_would_start_and_its_brief(self):
        gh = FakeGitHub(issues=[issue(9, 'Blue widget', 'Make it blue.'), issue(4, 'Red', 'Red.')])
        code, out = self.run_main(['--once', '--dry-run', '--config', self.config], gh)
        self.assertEqual(code, 0)
        self.assertIn('Would start a build job (dry run: nothing started)', out)
        self.assertIn('owner/first', out)
        self.assertIn('#4 Red', out)
        self.assertIn('claude/red-4 from origin/main', out)
        self.assertIn('/implement GitHub issue #4 in owner/first', out)
        self.assertNotIn('owner/second', out)

    def test_says_so_when_no_repo_has_work(self):
        code, out = self.run_main(['--once', '--dry-run', '--config', self.config], FakeGitHub())
        self.assertEqual(code, 0)
        self.assertIn('Nothing to start', out)

    def test_logs_to_its_own_log_dir(self):
        self.run_main(['--once', '--dry-run', '--config', self.config], FakeGitHub(issues=[issue(4)]))
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            self.assertIn('dry run: would build owner/first#4', f.read())

    def test_dry_run_goes_with_once(self):
        code, out = self.run_main(['--dry-run', '--config', self.config], FakeGitHub())
        self.assertEqual(code, 2)
        self.assertIn('--dry-run goes with --once', out)

if __name__ == '__main__':
    unittest.main()
