"""`--needs-me` (ticket 17): PRs ready for Stefan to merge, needs-info stops and threads waiting
for his answer, in one list; "nothing" when there's nothing. Read only."""
import io
import os
import tempfile
import unittest

from queue_runner.cli import main
from queue_runner.config import DEFAULT_CONFIG, load_config
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, FakeUsage, full_pr
from tests.test_ledger import H2, H3


class NeedsMeTest(unittest.TestCase):
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
merge = "stefan"

[[repos]]
name = "second"
github = "owner/second"
path = "{self.dir}"
'''.replace('\\', '/'))
        self.jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.gh = FakeGitHubForReviews(prs=[full_pr(20, 'claude/red-5', H2, title='Red'),
                                            full_pr(21, 'claude/blue-6', H3, title='Blue')])

    def needs_me(self):
        out = io.StringIO()
        code = main(['--needs-me', '--config', self.config], github=self.gh, out=out,
                    usage=FakeUsage())
        self.assertEqual(code, 0)
        return out.getvalue()

    def job(self, kind, issue, outcome, **fields):
        start = {k: fields.pop(k) for k in ('sha', 'stop', 'about', 'question', 'branch')
                 if k in fields}
        repo = fields.pop('repo', 'first')
        branch = start.pop('branch', None)
        j = self.jobs.started(kind=kind, repo=repo, issue=issue, branch=branch, title='t',
                              **start)
        self.jobs.ended(j.id, exit_code=None, outcome=outcome, **fields)
        return j

    def test_says_nothing_when_nothing_waits(self):
        self.assertEqual(self.needs_me().strip(), 'Nothing waits on you.')
        self.assertEqual(self.gh.posts, [])

    def test_lists_all_three_kinds(self):
        self.job('ready', 20, 'marked', sha=H2)                    # ready on its head
        self.job('ready', 21, 'marked', sha='0' * 40)              # an old head: not ready
        self.job('stop', 21, 'filed', sha=H3, stop='conflict', reason='it conflicts with main',
                 link='https://github.com/owner/first/issues/30')
        self.job('stop', 21, 'answered', sha=H3, stop='failed-check', reason='old')
        build = self.job('build', 7, 'waiting', repo='second', branch='claude/x-7',
                         link='https://t3/thread/7')
        self.job('decision', 7, 'stop', repo='second', about=build.id, question='waiting',
                 reason='Which colour?')
        failed = self.job('build', 8, 'failed', repo='second', branch='claude/y-8')
        self.job('decision', 8, 'stop', repo='second', about=failed.id, question='failed',
                 reason='Retry with the new key?')
        out = self.needs_me()
        self.assertIn('Ready for you to merge:\n  first#20 at '
                      f'{H2[:7]}: Red (https://github.com/owner/first/pull/20)', out)
        self.assertNotIn('first#21 at', out)
        self.assertIn('Stops (needs-info):\n  first#21: It conflicts with its base: it conflicts '
                      'with main (https://github.com/owner/first/issues/30)', out)
        self.assertNotIn('old', out)
        self.assertIn('second#8: A decision needs you: Retry with the new key? '
                      '(https://github.com/owner/second/issues/8; --release second#8 once '
                      'handled)', out)
        self.assertIn('Threads waiting for your answer:\n  second#7: the build thread asks: '
                      'Which colour? (https://t3/thread/7)', out)
        self.assertNotIn('Nothing', out)

    def test_a_released_build_decision_is_not_listed(self):
        failed = self.job('build', 8, 'failed', repo='second', branch='claude/y-8')
        self.job('decision', 8, 'stop', repo='second', about=failed.id, question='failed',
                 reason='Retry?')
        self.jobs.released('second', 8)
        self.assertEqual(self.needs_me().strip(), 'Nothing waits on you.')

    def test_a_github_failure_is_said(self):
        self.gh.fail.add('pull')   # open_pulls reads each PR afresh
        out = self.needs_me()
        self.assertIn("first: couldn't read its PRs", out)
        self.assertIn('Nothing waits on you in what could be read.', out)


class MergeConfigTest(unittest.TestCase):
    def test_leads_dashboard_is_merged_by_stefan_and_the_default_is_the_runner(self):
        repos = {r.name: r for r in load_config(DEFAULT_CONFIG).repos}
        self.assertTrue(repos['leads-dashboard'].stefan_merges)
        from queue_runner.config import Repo
        self.assertEqual(Repo(name='x', github=None, path='.').merge, 'runner')

    def test_a_bad_merge_value_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'config.toml')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(f'state_dir = "{d}/s"\nlog_dir = "{d}/l"\n[[repos]]\nname = "x"\n'
                        f'path = "{d}"\nmerge = "michael"\n'.replace('\\', '/'))
            with self.assertRaisesRegex(ValueError, "merge must be 'runner' or 'stefan'"):
                load_config(path)


if __name__ == '__main__':
    unittest.main()
