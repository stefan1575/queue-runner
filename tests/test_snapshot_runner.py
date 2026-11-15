"""The snapshot in the running runner (ticket 28): written after every pass of either lane and
from its own thread while a lane is blocked in a job; none with `--once`; `--snapshot` prints one
and takes no lock. GitHub, T3, Sol and usage are faked."""
import datetime
import io
import json
import os
import tempfile
import threading
import time
import unittest

from queue_runner.cli import main
from queue_runner.config import load_config
from queue_runner.lock import runner_lock
from queue_runner.run import Runner
from queue_runner.sol import Limits, LimitWindow
from queue_runner.state import JobLog
from queue_runner.wake import NoWaker
from tests.fakes import FakeGitHubWithPulls, FakeLimits, FakeToaster, FakeUsage, issue
from tests.fakes_t3 import FakeGit, FakeSol, FakeT3

PR = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}
UTC = datetime.timezone.utc


class Stop(Exception):
    pass


def sol_limits():
    return (datetime.datetime(2026, 11, 15, 5, 0, tzinfo=UTC),
            Limits('plus', (LimitWindow(300, 12.0, None),)))


class Harness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name.replace('\\', '/')
        self.config = os.path.join(self.dir, 'config.toml')
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(f'''
state_dir = "{self.dir}/state"
log_dir = "{self.dir}/logs"
poll_seconds = 60

[[repos]]
name = "first"
github = "owner/first"
path = "{self.dir}"
''')
        self.state = os.path.join(self.dir, 'state')
        self.snapshot_path = os.path.join(self.state, 'snapshot.json')
        self.usage = FakeUsage()

    def run_main(self, args, t3=None, sleep=None, **kw):
        out = io.StringIO()
        gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget')],
                                 pulls_by_branch={'claude/red-widget-4': PR})
        code = main(args + ['--config', self.config], github=gh, out=out,
                    t3=t3 or FakeT3([(0, 'completed')]), git=FakeGit(),
                    sleep=sleep or (lambda s: None), sol=FakeSol(), toaster=FakeToaster(),
                    usage=self.usage, limits=FakeLimits(), waker=NoWaker(),
                    t3_settings=os.path.join(self.dir, 't3.json'), sol_usage=sol_limits, **kw)
        return code, out.getvalue()

    def written(self):
        with open(self.snapshot_path, encoding='utf-8') as f:
            return json.load(f)


def lane(snap, id):
    return next(l for l in snap['lanes'] if l['id'] == id)


class ContinuousTest(Harness):
    def test_the_snapshot_shows_a_build_while_the_lane_is_blocked_in_it(self):
        test = self
        seen = {}

        class SlowT3(FakeT3):
            """The build's thread exists at once, and its run ends once the snapshot shows it."""

            def start(self, project, message, **kw):
                self.add('mcp:t1', kw['title'], 'running')
                deadline = time.time() + 10
                while time.time() < deadline:
                    try:
                        snap = test.written()
                    except (OSError, ValueError):
                        snap = None
                    if snap and lane(snap, 'claude')['job'] and lane(snap, 'claude')['job']['thread']:
                        seen['snap'] = snap
                        break
                    time.sleep(0.01)
                del self.threads['mcp:t1']
                return super().start(project, message, **kw)

        sleeps = []

        def sleep(s):
            sleeps.append(s)
            raise Stop
        with self.assertRaises(Stop):
            self.run_main([], t3=SlowT3([(0, 'completed')]), sleep=sleep, snapshot_every=0.02)
        claude = lane(seen['snap'], 'claude')
        self.assertEqual((claude['state'], claude['job']['kind'], claude['job']['ref'],
                          claude['job']['title'], claude['job']['thread']),
                         ('working', 'build', '#4', 'Red widget',
                          'https://app.t3.codes/threads/env/mcp:t1'))
        self.assertEqual(seen['snap']['usage'][1]['plan'], 'Plus')   # read afresh by its thread
        github = next(s for s in seen['snap']['sources'] if s['id'] == 'github')
        self.assertTrue(github['ok'])
        self.assertIsNotNone(github['checked_at'])   # the passes' calls

    def test_the_snapshot_left_after_the_runner_names_it_and_its_lanes(self):
        def sleep(s):
            raise Stop
        with self.assertRaises(Stop):
            self.run_main([], sleep=sleep)
        snap = self.written()
        self.assertEqual(snap['runner']['pid'], os.getpid())
        self.assertTrue(snap['runner']['started_at'])
        self.assertEqual([l['id'] for l in snap['lanes']], ['claude', 'sol'])
        self.assertEqual(lane(snap, 'claude')['state'], 'idle')   # the build ended, nothing else to do

    def test_paused_through_gate_json_the_lane_reads_stopped(self):
        self.run_main(['--pause'])

        def sleep(s):
            raise Stop
        with self.assertRaises(Stop):
            self.run_main([], sleep=sleep)
        claude = lane(self.written(), 'claude')
        self.assertEqual(claude['state'], 'stopped')
        self.assertTrue(claude['stopped']['at'])

    def test_once_writes_no_snapshot(self):
        self.run_main(['--once'])
        self.assertFalse(os.path.exists(self.snapshot_path))


class RecordingPublisher:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def start(self):
        self.events.append('start')

    def stop(self):
        self.events.append('stop')

    def publish(self, fresh=False):
        with self.lock:
            self.events.append(threading.current_thread().name)
        return True


class EveryPassTest(Harness):
    def test_both_lanes_publish_after_each_pass_between_start_and_stop(self):
        config = load_config(self.config)
        runner = Runner(config, github=FakeGitHubWithPulls(issues=[]), t3=FakeT3(), git=FakeGit(),
                        out=io.StringIO(), log_line=lambda line: None, sol=FakeSol())
        runner.publisher = pub = RecordingPublisher()

        def sleep(s):
            raise Stop
        with self.assertRaises(Stop):
            runner.run_forever(sleep)
        self.assertEqual((pub.events[0], pub.events[-1]), ('start', 'stop'))
        self.assertIn('MainThread', pub.events)   # the Claude lane's pass
        self.assertIn('sol-lane', pub.events)     # the reviewing lane's


class InboxTest(Harness):
    """The Sol lane reads the Inbox after each pass (ticket 31), and the snapshot writes its asks
    from that read: never from GitHub itself."""

    def test_a_sol_pass_reads_the_inbox_and_the_snapshot_writes_its_asks(self):
        from queue_runner.snapshot import Calls, RunnerInfo, Snapshots
        from tests.fakes import FakeGitHubForReviews, full_pr
        config = load_config(self.config)
        gh = FakeGitHubForReviews(prs=[full_pr(12, 'claude/red-widget-4', 'b' * 40,
                                               title='Red widget', body='Closes #4')],
                                  open_issue_list=[issue(4, 'Red widget', 'A red widget.')])
        gh.states[30] = 'open'   # the stop's needs-info issue
        runner = Runner(config, github=gh, t3=FakeT3(), git=FakeGit(), out=io.StringIO(),
                        log_line=lambda line: None)   # no Sol: the lane's pass reviews nothing
        stop = runner.jobs.started(kind='stop', repo='first', issue=12,
                                   branch='claude/red-widget-4', title='t', sha='b' * 40,
                                   stop='no-push')
        runner.jobs.ended(stop.id, exit_code=None, outcome='filed', reason='nothing pushed',
                          link='https://github.com/owner/first/issues/30')
        snaps = Snapshots(config, calls=Calls(lambda: datetime.datetime.now(UTC)), claude=None,
                          sol=None, info=RunnerInfo(1, None, None),
                          clock=lambda: datetime.datetime.now(UTC), runner=runner)
        runner._sol_pass()
        self.assertEqual(snaps.build()['asks'], [])   # no snapshot published: nothing read
        runner.publisher = RecordingPublisher()
        runner._sol_pass()
        gh.prs.clear()   # what GitHub says now is the next pass's
        [ask] = snaps.build()['asks']
        self.assertEqual((ask['kind'], ask['ref'], ask['subject'], ask['about']),
                         ('stuck', 'PR #12', 'Red widget', 'A red widget.'))


class SnapshotFlagTest(Harness):
    def test_it_prints_one_snapshot_from_the_real_state_and_takes_no_lock(self):
        log = JobLog(os.path.join(self.state, 'jobs.jsonl'))
        log.started(kind='build', repo='first', issue=4, branch='claude/red-widget-4',
                    title='Queue runner build: first#4')
        before = os.path.getsize(log.path)
        with runner_lock(self.state):   # a runner is running
            code, out = self.run_main(['--snapshot'])
        self.assertEqual(code, 0)
        snap = json.loads(out)
        self.assertEqual(snap['version'], 1)
        self.assertEqual((lane(snap, 'claude')['state'], lane(snap, 'claude')['job']['ref']),
                         ('working', '#4'))
        self.assertEqual(snap['usage'][0]['windows'][0]['id'], 'five_hour')   # read once
        self.assertEqual(self.usage.count, 1)
        self.assertEqual(os.path.getsize(log.path), before)   # records nothing
        self.assertFalse(os.path.exists(self.snapshot_path))  # and writes no file


if __name__ == '__main__':
    unittest.main()
