"""Repos side by side (#50): each working repo gets its own Claude job at once, the usage gate
counting the jobs still running, and control.json's old `repo_order` (ticket 33's build order) is
no longer read. GitHub, T3 and Sol are faked; every file is in a temp folder."""
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


def control(order=None, **lanes):
    """control.json as the page writes it; with `order`, an old `repo_order` left in it."""
    data = {'version': 1, 'written_at': WRITTEN,
            'lanes': {k: {'stop': v, 'at': WRITTEN} for k, v in lanes.items()}}
    if order is not None:
        data['repo_order'] = order
    return data


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


class OldOrderTest(Harness):
    """A control.json that still has `repo_order` is read as before for its stops, and the order
    is ignored without a word."""

    def snapshot(self, config=None):
        from queue_runner import snapshot
        calls = snapshot.Calls(lambda: NOW)
        return snapshot.Snapshots(config or load_config(self.config), calls=calls,
                                  clock=lambda: NOW, info=snapshot.RunnerInfo(1, NOW, None),
                                  claude=None, sol=None).build()

    def test_an_old_order_is_ignored_without_a_word(self):
        for order in (['second', 'first'], ['second'], 'second', ['second', 2]):
            with self.subTest(order=order):
                self.put(control(order))
                self.run_main(['--once', '--dry-run'])
                log = self.runner_log()
                self.assertNotIn('repo_order', log)
                self.assertNotIn('build order', log)

    def test_its_stops_still_stand(self):
        self.put(control(['second', 'first'], claude='after-job'))
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])

    def test_the_snapshot_keeps_config_tomls_order(self):
        self.put(control(['second', 'first']))
        snap = self.snapshot()
        self.assertEqual([r['name'] for r in snap['repos']], ['first', 'second'])
        self.assertEqual(snap['control_read_at'], WRITTEN)

    def test_a_write_drops_it(self):
        from queue_runner import control as ctl
        self.put(control(['second', 'first']))
        data = ctl.ask(self.state, ('claude',), 'after-job', WRITTEN)
        self.assertNotIn('repo_order', data)


if __name__ == '__main__':
    unittest.main()
