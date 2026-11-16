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
        # each working repo's job, side by side (#50)
        self.assertLess(out.index("dry run: first's Claude job:"),
                        out.index("dry run: second's Claude job:"))
        self.assertIn('/implement GitHub issue #4 in owner/second', out)

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


class LocalTicketsDryRunTest(unittest.TestCase):
    """A repo whose tickets are local: the dry run names the next one and builds none."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = os.path.join(self.dir, 'repo')
        folder = os.path.join(self.repo, '.scratch', 'chain', 'issues')
        os.makedirs(folder)
        for n, slug, status, blocked in [(1, 'first', 'done (2026-11-10)', 'None'),
                                         (2, 'second', 'ready-for-agent', '01'),
                                         (3, 'third', 'ready-for-agent', '02')]:
            with open(os.path.join(folder, f'{n:02d}-{slug}.md'), 'w', encoding='utf-8') as f:
                f.write(f'# {n:02d}: {slug}\n\n**Blocked by:** {blocked}\n\n'
                        f'**Status:** {status}\n')
        self.config = os.path.join(self.dir, 'config.toml')

    def write_config(self, extra=''):
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(f'''
state_dir = "{self.dir}/state"
log_dir = "{self.dir}/logs"

[[repos]]
name = "local"
path = "{self.repo}"
issues = "local"
{extra}
'''.replace('\\', '/'))

    def run_main(self, github):
        out = io.StringIO()
        code = main(['--once', '--dry-run', '--config', self.config], github=github, out=out,
                    usage=FakeUsage())
        return code, out.getvalue()

    def test_names_the_next_ticket_in_the_chain(self):
        self.write_config()
        code, out = self.run_main(FakeGitHub())
        self.assertEqual(code, 0)
        self.assertIn('Next local ticket in local', out)
        self.assertIn('chain/02 02: second', out)
        self.assertIn('.scratch/chain/issues/02-second.md', out)
        self.assertNotIn('Would start a build job', out)

    def test_a_local_repo_with_a_remote_isnt_picked_from_github(self):
        self.write_config('github = "owner/local"')
        code, out = self.run_main(FakeGitHub(issues=[issue(1, 'On GitHub', 'x')]))
        self.assertIn('chain/02', out)
        self.assertNotIn('On GitHub', out)

    def test_a_github_repo_after_it_still_shows_its_build(self):
        gh_repo = f'\n[[repos]]\nname = "gh"\ngithub = "owner/gh"\npath = "{self.dir}"'
        self.write_config(gh_repo.replace('\\', '/'))
        code, out = self.run_main(FakeGitHub(issues=[issue(4, 'Red', 'Red.')]))
        self.assertIn('chain/02', out)
        self.assertIn('Would start a build job', out)
        self.assertIn('#4 Red', out)

    def test_a_bad_issues_value_is_an_error(self):
        self.write_config()
        with open(self.config, encoding='utf-8') as f:
            text = f.read().replace('issues = "local"', 'issues = "files"')
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(text)
        from queue_runner.config import load_config
        with self.assertRaisesRegex(ValueError, "issues must be 'github' or 'local'"):
            load_config(self.config)

    def test_repos_are_github_unless_they_say_so(self):
        from queue_runner.config import DEFAULT_CONFIG, load_config
        self.assertEqual([r.name for r in load_config(DEFAULT_CONFIG).repos
                          if r.local_issues], [])


if __name__ == '__main__':
    unittest.main()
