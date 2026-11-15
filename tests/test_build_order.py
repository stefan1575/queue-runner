"""The build order (ticket 33): `control.json`'s `repo_order`, written by the page, is the order
both lanes go through the served repos when it names each of them exactly once; anything else is
ignored, said once, and config.toml's order stands. GitHub, T3 and Sol are faked; every file is in
a temp folder."""
import datetime
import io
import json
import os
import tempfile
import unittest

from queue_runner.cli import main
from queue_runner.config import load_config
from queue_runner.run import Runner
from queue_runner.state import JobLog
from queue_runner.usage import Usage, Window
from queue_runner.wake import NoWaker
from tests.fakes import FakeGitHubWithPulls, FakeLimits, FakeToaster, FakeUsage, issue
from tests.fakes_t3 import FakeGit, FakeSol, FakeT3

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
ROOM = Usage(Window(0, None), Window(0, None))
WRITTEN = '2026-11-15T19:58:00+08:00'


class Done(Exception):
    pass


class PerRepo(FakeGitHubWithPulls):
    """Each repo's own ready issues, and the repos whose PRs were read, in order."""

    def __init__(self, by_repo):
        super().__init__(issues=[i for its in by_repo.values() for i in its], pulls_by_branch={
            b: {'number': 12, 'url': 'https://github.com/owner/x/pull/12', 'state': 'open'}
            for b in ('claude/red-widget-4', 'claude/green-widget-5', 'claude/blue-widget-7')})
        self.by_repo = by_repo
        self.read = []

    def ready_issues(self, repo):
        return list(self.by_repo.get(repo.name, []))

    def open_pulls(self, repo):
        self.read.append(repo.name)
        return []


def control(order, **lanes):
    return {'version': 1, 'written_at': WRITTEN,
            'lanes': {k: {'stop': v, 'at': WRITTEN} for k, v in lanes.items()},
            'repo_order': order}


class Harness(unittest.TestCase):
    """Two served repos, `first` and `second` in config.toml's order, each with a ready issue."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name.replace('\\', '/')
        self.config = os.path.join(self.dir, 'config.toml')
        repos = ''.join(f'''
[[repos]]
name = "{name}"
github = "owner/{name}"
path = "{self.dir}/{name}"
''' for name in ('first', 'second'))
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(f'state_dir = "{self.dir}/state"\nlog_dir = "{self.dir}/logs"\n'
                    f'poll_seconds = 300\n{repos}')
        self.state = os.path.join(self.dir, 'state')
        os.makedirs(self.state)
        self.log = JobLog(os.path.join(self.state, 'jobs.jsonl'))
        self.gh = PerRepo({'first': [issue(4, 'Red widget', 'Red.')],
                           'second': [issue(7, 'Blue widget', 'Blue.')]})

    def put(self, data):
        with open(os.path.join(self.state, 'control.json'), 'w', encoding='utf-8') as f:
            f.write(data if isinstance(data, str) else json.dumps(data))

    def run_main(self, args, passes=1, t3=None):
        out = io.StringIO()
        slept = []

        def sleep(s):
            slept.append(s)
            if len(slept) >= passes:
                raise Done
        self.t3 = t3 or FakeT3([(0, 'completed')] * 4)
        try:
            code = main(args + ['--config', self.config], github=self.gh, out=out, t3=self.t3,
                        git=FakeGit(), sleep=sleep, sol=FakeSol(), toaster=FakeToaster(),
                        usage=FakeUsage(ROOM), clock=lambda: NOW, limits=FakeLimits(),
                        t3_settings=os.path.join(self.dir, 't3.json'), waker=NoWaker())
        except Done:
            code = None
        return code, out.getvalue()

    def built(self):
        return [os.path.basename(s['project']) for s in self.t3.starts]

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()


class ClaudeLaneTest(Harness):
    def test_with_no_order_set_config_tomls_comes_first(self):
        self.run_main(['--once'])
        self.assertEqual(self.built(), ['first'])

    def test_it_builds_from_the_first_repo_in_repo_order(self):
        self.put(control(['second', 'first']))
        self.run_main(['--once'])
        self.assertEqual(self.built(), ['second'])
        self.assertIn("Repos are taken in Stefan's build order now: second, first",
                      self.runner_log())

    def test_an_order_that_doesnt_name_each_served_repo_once_is_ignored_and_says_why(self):
        for order, why in ((['second'], 'it leaves out first'),
                           (['second', 'first', 'third'], 'it names third, which is not served'),
                           (['second', 'second', 'first'], 'it names second more than once'),
                           (['second', 2], 'it is not a list of repo names'),
                           ('second', 'it is not a list of repo names')):
            with self.subTest(order=order):
                if os.path.exists(self.log.path):   # #4's build held it: start afresh
                    os.remove(self.log.path)
                self.put(control(order))
                self.run_main(['--once'])
                self.assertEqual(self.built(), ['first'])
                self.assertIn(f"control.json's repo_order is ignored ({why}): repos are taken "
                              "in config.toml's order, first, second", self.runner_log())

    def test_an_ignored_order_is_said_once_not_every_pass(self):
        self.put(control(['second']))
        self.run_main([], passes=3, t3=FakeT3([(0, 'completed')] * 4))
        self.assertEqual(self.runner_log().count('repo_order is ignored'), 1)

    def test_an_ignored_order_leaves_the_stops_standing(self):
        self.put(control(['nope'], claude='after-job'))
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])


class RunningJobTest(Harness):
    def test_a_new_order_written_while_a_job_runs_lets_it_finish_and_counts_from_the_next_pass(
            self):
        test = self

        class ReorderedMidJob(FakeT3):
            def start(self, *args, **kwargs):
                if not self.starts:
                    test.put(control(['second', 'first']))   # Stefan reorders on the page
                return super().start(*args, **kwargs)
        self.gh.by_repo['first'].append(issue(5, 'Green widget', 'Green.'))
        self.run_main([], passes=2, t3=ReorderedMidJob([(0, 'completed')] * 4))
        self.assertEqual(self.built()[:2], ['first', 'second'])
        first, second = self.log.jobs()[:2]
        self.assertEqual((first.repo, first.issue, first.outcome), ('first', 4, 'done'))
        self.assertEqual((second.repo, second.issue), ('second', 7))


class DryRunTest(Harness):
    def test_it_says_the_order_and_would_build_from_its_first_repo(self):
        self.put(control(['second', 'first']))
        _, out = self.run_main(['--once', '--dry-run'])
        self.assertIn("dry run: repos are taken in Stefan's build order: second, first", out)
        self.assertIn('issue:  #7 Blue widget', out)
        self.assertEqual(self.t3.starts, [])

    def test_with_no_order_set_it_says_config_tomls(self):
        _, out = self.run_main(['--once', '--dry-run'])
        self.assertIn("dry run: repos are taken in config.toml's order: first, second", out)
        self.assertIn('issue:  #4 Red widget', out)

    def test_an_ignored_order_says_why(self):
        self.put(control(['second']))
        _, out = self.run_main(['--once', '--dry-run'])
        self.assertIn("dry run: control.json's repo_order is ignored (it leaves out first): "
                      "repos are taken in config.toml's order, first, second", out)
        self.assertIn('issue:  #4 Red widget', out)


class SnapshotTest(Harness):
    """The snapshot reads control.json once for both lanes' stops and the order, so the one that
    shows the new order is the one whose `control_read_at` is its `written_at`."""

    def snapshot(self, config=None):
        from queue_runner import snapshot
        calls = snapshot.Calls(lambda: NOW)
        return snapshot.Snapshots(config or load_config(self.config), calls=calls,
                                  clock=lambda: NOW, info=snapshot.RunnerInfo(1, NOW, None),
                                  claude=None, sol=None).build()

    def test_its_repos_follow_repo_order_and_control_read_at_moves_with_it(self):
        snap = self.snapshot()
        self.assertEqual([r['name'] for r in snap['repos']], ['first', 'second'])
        self.assertIsNone(snap['control_read_at'])
        self.put(control(['second', 'first']))
        snap = self.snapshot()
        self.assertEqual([r['name'] for r in snap['repos']], ['second', 'first'])
        self.assertEqual(snap['control_read_at'], WRITTEN)

    def test_an_ignored_order_shows_config_tomls_whatever_the_lanes_took_up_before(self):
        runner = SolLaneTest.runner(self)
        self.put(control(['second', 'first']))
        runner.run_once()   # the lanes take Stefan's order up
        self.put(control(['second']))
        snap = self.snapshot(runner.config)
        self.assertEqual([r['name'] for r in snap['repos']], ['first', 'second'])


class SolLaneTest(Harness):
    def runner(self):
        self.lines = []
        self.t3 = FakeT3([(0, 'completed')] * 4)
        return Runner(load_config(self.config), github=self.gh, t3=self.t3, git=FakeGit(),
                      out=io.StringIO(), log_line=self.lines.append, sol=FakeSol(),
                      now=lambda: NOW)

    def test_it_goes_through_the_repos_in_repo_order_on_its_own_pass(self):
        runner = self.runner()
        runner._sol_pass()   # the reviewing lane's pass, with no Claude pass before it
        self.assertEqual(self.gh.read[-1], 'second')   # config.toml's order: second is last
        self.put(control(['second', 'first']))
        self.gh.read.clear()
        runner._sol_pass()
        self.assertEqual(self.gh.read[0], 'second')
        self.assertEqual(self.gh.read[-1], 'first')

    def test_both_lanes_say_a_new_order_once_between_them(self):
        runner = self.runner()
        self.put(control(['second', 'first']))
        runner.run_once()
        runner.run_once()
        self.assertEqual(sum("Stefan's build order" in l for l in self.lines), 1, self.lines)


if __name__ == '__main__':
    unittest.main()
