"""One switch (ticket 30): a lane's stop is `control.json`'s `lanes.<id>.stop`, written by the page
and by `--pause` and `--resume`, and read by the runner before each lane starts a job. A pause
left in `gate.json` by the older code still stops the Claude lane. GitHub, T3, Sol and usage are
faked; every file is in a temp folder."""
import datetime
import io
import json
import os
import tempfile
import unittest

from queue_runner.cli import main
from queue_runner.state import JobLog
from queue_runner.usage import Usage, Window
from queue_runner.wake import NoWaker
from tests.fakes import FakeGitHubWithPulls, FakeLimits, FakeToaster, FakeUsage, issue
from tests.fakes_t3 import FakeGit, FakeSol, FakeT3

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
PR = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}
ROOM = Usage(Window(0, None), Window(0, None))


class Done(Exception):
    pass


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
poll_seconds = 300

[[repos]]
name = "first"
github = "owner/first"
path = "{self.dir}"
''')
        self.state = os.path.join(self.dir, 'state')
        os.makedirs(self.state)
        self.log = JobLog(os.path.join(self.state, 'jobs.jsonl'))

    def put(self, name, data):
        with open(os.path.join(self.state, name), 'w', encoding='utf-8') as f:
            f.write(data if isinstance(data, str) else json.dumps(data))

    def read(self, name):
        with open(os.path.join(self.state, name), encoding='utf-8') as f:
            return json.load(f)

    def run_main(self, args, passes=1, **kw):
        """Runs main; in continuous mode it ends at the `passes`-th idle sleep."""
        out = io.StringIO()
        slept = []

        def sleep(s):
            slept.append(s)
            if len(slept) >= passes:
                raise Done
        gh = FakeGitHubWithPulls(
            issues=kw.pop('github_issues', None) or [issue(4, 'Red widget', 'Make it red.')],
            pulls_by_branch={'claude/red-widget-4': PR, 'claude/blue-widget-5': PR})
        self.t3 = kw.pop('t3', None) or FakeT3([(0, 'completed')])
        try:
            code = main(args + ['--config', self.config], github=gh, out=out, t3=self.t3,
                        git=FakeGit(), sleep=sleep, sol=FakeSol(), toaster=FakeToaster(),
                        usage=kw.pop('usage', FakeUsage(ROOM)), clock=lambda: NOW,
                        limits=FakeLimits(), t3_settings=os.path.join(self.dir, 't3.json'),
                        waker=kw.pop('waker', NoWaker()), **kw)
        except Done:
            code = None
        return code, out.getvalue()

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()


class TodaysPauseTest(Harness):
    def test_a_runner_started_paused_through_gate_json_with_no_control_json_starts_no_claude_job(
            self):
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        self.run_main([], passes=3)
        self.assertEqual(self.t3.starts, [])
        self.assertEqual(self.log.jobs(), [])
        self.assertFalse(os.path.exists(os.path.join(self.state, 'control.json')))

    def test_once_too(self):
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])


def control(**lanes):
    return {'version': 1, 'written_at': '2026-11-15T19:58:00+08:00',
            'lanes': {k: {'stop': v, 'at': '2026-11-15T19:58:00+08:00'} for k, v in lanes.items()},
            'repo_order': []}


class OldPauseTest(Harness):
    def test_an_entry_for_the_claude_lane_wins_over_gate_jsons_pause_either_way(self):
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        self.put('control.json', control(claude=None))
        self.run_main(['--once'])
        self.assertEqual(len(self.t3.starts), 1)
        self.put('gate.json', {'paused': False, 'reserve': 5.0})
        self.put('control.json', control(claude='after-job'))
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])

    def test_an_entry_for_the_other_lane_leaves_gate_jsons_pause_standing(self):
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        self.put('control.json', control(sol=None))
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])

    def test_the_switch_says_where_the_stop_came_from_and_since_when(self):
        from queue_runner import control as ctl
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        at = datetime.datetime(2026, 11, 14, 9, 30, tzinfo=UTC).timestamp()
        os.utime(os.path.join(self.state, 'gate.json'), (at, at))
        s = ctl.read(self.state)
        self.assertEqual(s.stop('claude'), ctl.Stop('after-job', datetime.datetime.fromtimestamp(
            at, UTC), 'gate'))
        self.assertFalse(s.holds('sol'))
        self.assertIsNone(s.written_at)
        self.put('control.json', control(claude='now'))
        s = ctl.read(self.state)
        self.assertEqual(s.stop('claude').by, 'control')
        self.assertEqual(s.stop('claude').at.isoformat(), '2026-11-15T19:58:00+08:00')
        self.assertTrue(s.holds('claude'))
        self.assertEqual(s.written_at, '2026-11-15T19:58:00+08:00')

    def test_gate_json_keeps_the_reserve_only(self):
        from queue_runner.gate import Knob, read_knob, write_knob
        write_knob(self.state, Knob(reserve=12.5))
        self.assertEqual(self.read('gate.json'), {'reserve': 12.5})
        self.put('gate.json', {'paused': True, 'reserve': 7})
        self.assertEqual(read_knob(self.state), Knob(reserve=7.0))


class ClaudeLaneTest(Harness):
    def test_after_job_starts_no_claude_job_and_says_how_to_resume(self):
        self.put('control.json', control(claude='after-job'))
        self.run_main([], passes=2)
        self.assertEqual(self.t3.starts, [])
        log = self.runner_log()
        self.assertIn('stopped by Stefan', log)
        self.assertIn('--resume', log)
        self.assertIn('dashboard', log)
        self.assertEqual(log.count('stopped by Stefan'), 1)   # said once, not every pass

    def test_now_is_read_as_after_job(self):
        self.put('control.json', control(claude='now'))
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])

    def test_null_carries_on(self):
        self.put('control.json', control(claude=None))
        self.run_main(['--once'])
        self.assertEqual(len(self.t3.starts), 1)

    def test_a_stop_asked_while_a_job_runs_lets_it_finish_and_starts_nothing_after(self):
        test = self

        class StoppedMidJob(FakeT3):
            def start(self, *args, **kwargs):
                test.put('control.json', control(claude='after-job'))   # Stefan presses Stop
                return super().start(*args, **kwargs)
        gh_issues = [issue(4, 'Red widget', 'Make it red.'), issue(5, 'Blue widget', 'Blue.')]
        self.run_main([], passes=2, t3=StoppedMidJob([(0, 'completed'), (0, 'completed')]),
                      github_issues=gh_issues)
        self.assertEqual(len(self.t3.starts), 1)
        [job] = self.log.jobs()
        self.assertEqual(job.outcome, 'done')


class CliTest(Harness):
    def lanes(self):
        return {id: e['stop'] for id, e in self.read('control.json')['lanes'].items()}

    def test_pause_and_resume_take_a_lane_claude_by_default(self):
        self.assertEqual(self.run_main(['--pause'])[0], 0)
        self.assertEqual(self.lanes(), {'claude': 'after-job'})
        self.run_main(['--pause', 'sol'])
        self.assertEqual(self.lanes(), {'claude': 'after-job', 'sol': 'after-job'})
        self.run_main(['--resume'])
        self.assertEqual(self.lanes(), {'claude': None, 'sol': 'after-job'})
        self.run_main(['--resume', 'all'])
        self.assertEqual(self.lanes(), {'claude': None, 'sol': None})
        self.run_main(['--pause', 'all'])
        self.assertEqual(self.lanes(), {'claude': 'after-job', 'sol': 'after-job'})
        code, out = self.run_main(['--pause', 'somebody'])   # not a lane, nor a served repo
        self.assertEqual(code, 2)
        self.assertIn("not 'somebody'", out)

    def test_it_says_what_it_did_and_how_to_undo_it_and_logs_it(self):
        code, out = self.run_main(['--pause'])
        self.assertIn('stopped by Stefan', out)
        self.assertIn('--resume', out)
        code, out = self.run_main(['--resume', 'sol'])
        self.assertIn('reviewing lane', out)
        self.assertIn('carries on', out)
        log = self.runner_log()
        self.assertIn('--pause', log)
        self.assertIn('--resume sol', log)

    def test_pause_then_resume_works_between_passes(self):
        self.run_main(['--pause'])
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])
        self.run_main(['--resume'])
        self.run_main(['--once'])
        self.assertEqual(len(self.t3.starts), 1)

    def test_the_old_pause_is_carried_over_and_gate_json_keeps_the_reserve(self):
        self.put('gate.json', {'paused': True, 'reserve': 7.0})
        self.run_main(['--pause', 'sol'])   # says nothing of Claude: its old pause stands
        self.assertEqual(self.lanes(), {'claude': 'after-job', 'sol': 'after-job'})
        self.assertEqual(self.read('gate.json'), {'reserve': 7.0})
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])

    def test_a_new_reserve_carries_the_old_pause_over_too(self):
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        self.run_main(['--reserve', '9'])
        self.assertEqual(self.read('gate.json'), {'reserve': 9.0})
        self.assertEqual(self.lanes(), {'claude': 'after-job'})
        self.run_main(['--once'])
        self.assertEqual(self.t3.starts, [])

    def test_an_unreadable_control_json_is_written_afresh_as_the_page_does(self):
        self.put('control.json', '{ torn')
        code, out = self.run_main(['--pause'])
        self.assertEqual(code, 0)
        self.assertIn('unreadable', out)
        self.assertEqual(self.lanes(), {'claude': 'after-job'})


class SaysTest(Harness):
    def test_gate_says_stopped_by_stefan_and_how_to_resume_from_either_end(self):
        self.put('gate.json', {'paused': True, 'reserve': 5.0})
        code, out = self.run_main(['--gate'])
        self.assertEqual(code, 0)
        self.assertNotIn('paused', out)
        self.assertIn('Claude lane is stopped by Stefan', out)
        self.assertIn('Resume on the dashboard, or python3 -m queue_runner --resume', out)
        self.assertIn('reviewing lane carries on', out)
        self.assertIn('build: waits: the Claude lane is stopped by Stefan', out)
        self.assertIn('weekly reserve 5%', out)

    def test_gate_with_both_running(self):
        code, out = self.run_main(['--gate'])
        self.assertIn('Claude lane carries on', out)
        self.assertIn('build: starts', out)

    def test_gate_says_an_unreadable_control_json(self):
        self.put('control.json', '{ torn')
        code, out = self.run_main(['--gate'])
        self.assertIn('control.json is unreadable', out)
        self.assertIn('build: waits', out)

    def test_dry_run_says_a_stopped_lane_would_start_nothing(self):
        self.put('control.json', control(claude='after-job', sol='after-job'))
        code, out = self.run_main(['--once', '--dry-run'])
        self.assertEqual(code, 0)
        self.assertIn('Claude lane is stopped by Stefan', out)
        self.assertIn('reviewing lane is stopped by Stefan', out)
        self.assertIn('--resume sol', out)
        self.assertNotIn('paused', out)
        self.assertEqual(self.t3.starts, [])


class Wakes:
    def __init__(self):
        self.synced = []

    def sync(self, times):
        self.synced.append(sorted(times))


class WakeTest(Harness):
    RESUME = NOW + datetime.timedelta(hours=2)

    def limited(self, kind):
        job = self.log.started(kind=kind, repo='first', issue=4, branch='claude/red-widget-4',
                               title='t')
        self.log.ended(job.id, exit_code=1, thread_id='mcp:t0',
                       outcome='usage-limit' if kind == 'build' else 'out-of-usage',
                       resume_at=self.RESUME.isoformat())

    def wakes(self):
        waker = Wakes()
        self.run_main([], passes=1, waker=waker)
        return {t for times in waker.synced for t in times}

    def test_a_claude_lane_waiting_on_a_limit_sets_one(self):
        self.limited('build')
        self.assertEqual(self.wakes(), {self.RESUME})

    def test_stopped_it_sets_none(self):
        self.limited('build')
        self.put('control.json', control(claude='after-job'))
        self.assertEqual(self.wakes(), set())

    def test_a_stopped_reviewing_lane_sets_none_for_chatgpts_reset(self):
        self.limited('review')
        self.assertEqual(self.wakes(), {self.RESUME})
        self.put('control.json', control(sol='after-job'))
        self.assertEqual(self.wakes(), set())

    def test_nor_does_either_while_control_json_is_unreadable(self):
        self.limited('review')
        self.put('control.json', '{ torn')
        self.assertEqual(self.wakes(), set())


class SameFileTest(unittest.TestCase):
    """The runner's writer (`--pause`, `--resume`) and the page's (`dashboard/serve.py`) leave the
    same control.json behind."""

    def test_both_writers_write_the_same_file(self):
        from dashboard import serve
        from queue_runner import control as ctl
        at = '2026-11-15T20:01:02+08:00'
        before = {'version': 1, 'written_at': '2026-11-15T19:00:00+08:00',
                  'lanes': {'sol': {'stop': 'after-job', 'at': '2026-11-15T19:00:00+08:00'},
                            'junk': 'not an entry'},
                  'repo_order': ['queue-runner', 'leads-dashboard', 7]}
        for lane, stop in (('claude', 'after-job'), ('sol', None), ('claude', None)):
            with self.subTest(lane=lane, stop=stop), tempfile.TemporaryDirectory() as page, \
                    tempfile.TemporaryDirectory() as cli:
                for d in (page, cli):
                    with open(os.path.join(d, 'control.json'), 'w', encoding='utf-8') as f:
                        json.dump(before, f)
                serve.App(page, clock=lambda: at).write_control({'lane': lane, 'stop': stop})
                ctl.ask(cli, [lane], stop, at)
                with open(os.path.join(page, 'control.json'), encoding='utf-8') as f:
                    by_page = json.load(f)
                with open(os.path.join(cli, 'control.json'), encoding='utf-8') as f:
                    by_cli = json.load(f)
                self.assertEqual(by_cli, by_page)
                self.assertEqual(by_cli['lanes'][lane], {'stop': stop, 'at': at})
                self.assertEqual(ctl.read(cli).stop(lane).asked, stop)

    def test_with_no_file_yet_too(self):
        from dashboard import serve
        from queue_runner import control as ctl
        at = '2026-11-15T20:01:02+08:00'
        with tempfile.TemporaryDirectory() as page, tempfile.TemporaryDirectory() as cli:
            serve.App(page, clock=lambda: at).write_control({'lane': 'claude', 'stop': 'after-job'})
            ctl.ask(cli, ['claude'], 'after-job', at)
            with open(os.path.join(page, 'control.json'), encoding='utf-8') as f, \
                    open(os.path.join(cli, 'control.json'), encoding='utf-8') as g:
                self.assertEqual(json.load(g), json.load(f))


class Passes:
    """Stands in for the Sol lane's reviewer: counts its passes (each one files stops, merges and
    reviews)."""

    def __init__(self):
        self.passes = 0
        self.titles = {}

    def review_pass(self):
        self.passes += 1
        return 'idle'


class SolLaneTest(Harness):
    def runner(self):
        from queue_runner.config import load_config
        from queue_runner.run import Runner
        self.t3 = FakeT3([(0, 'completed')])
        gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.')],
                                 pulls_by_branch={'claude/red-widget-4': PR})
        self.lines = []
        runner = Runner(load_config(self.config), github=gh, t3=self.t3, git=FakeGit(),
                        out=io.StringIO(), log_line=self.lines.append, sol=FakeSol(),
                        now=lambda: NOW)
        runner.reviewer = self.reviews = Passes()
        return runner

    def test_stopped_it_starts_no_review_and_merges_nothing(self):
        self.put('control.json', control(sol='after-job'))
        self.runner().run_once()
        self.assertEqual(self.reviews.passes, 0)
        self.assertEqual(len(self.t3.starts), 1)   # the Claude lane goes on
        self.assertTrue(any('reviewing lane is stopped by Stefan' in l and '--resume sol' in l
                            for l in self.lines), self.lines)

    def test_an_unreadable_control_json_starts_nothing_in_either_lane_until_its_fixed(self):
        for broken in ('{"lanes": {"claude": {"stop": "sometime"}}', '[]',
                       '{"lanes": {"claude": {"stop": "maybe"}}}', '{"lanes": ["claude"]}'):
            with self.subTest(broken=broken):
                self.put('control.json', broken)
                runner = self.runner()
                runner.run_once()
                self.assertEqual((self.reviews.passes, self.t3.starts), (0, []))
                self.assertTrue(any('control.json is unreadable' in l for l in self.lines))
        self.put('control.json', control())   # fixed
        runner.run_once()
        self.assertEqual(self.reviews.passes, 1)
        self.assertEqual(len(self.t3.starts), 1)
        self.assertTrue(any('runs again' in l for l in self.lines))

    def test_carrying_on_it_reviews(self):
        self.put('control.json', control(sol=None, claude='after-job'))
        self.runner().run_once()
        self.assertEqual(self.reviews.passes, 1)
        self.assertEqual(self.t3.starts, [])


if __name__ == '__main__':
    unittest.main()
