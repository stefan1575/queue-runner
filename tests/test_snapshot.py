"""The runner's snapshot for the dashboard (`queue_runner/snapshot.py`): `build()` from plain facts
with a fixed clock, the publisher that writes it whole, and the contract with `dashboard/sample.py`."""
import datetime
import json
import os
import tempfile
import threading
import time
import unittest
from dataclasses import replace

from dashboard import sample
from queue_runner import control, snapshot
from queue_runner.config import Config, Repo
from queue_runner.gate import Cost, Knob, write_knob
from queue_runner.sol import Limits as SolLimits, LimitWindow as SolWindow
from queue_runner.state import Job, JobLog
from queue_runner.t3 import Thread
from queue_runner.usage import Usage, UsageError, Window
from tests.fakes import FakeUsage

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 15, 5, 0, tzinfo=UTC)
LD = Repo(name='leads-dashboard', github='RoyalBullyAgency-RBA/leads-dashboard', path='C:/ld',
          merge='stefan')
QR = Repo(name='queue-runner', github='stefan1575/queue-runner', path='C:/qr')


def when(iso):
    return datetime.datetime.fromisoformat(iso)


def facts(**kw):
    kw.setdefault('now', NOW)
    kw.setdefault('repos', [LD, QR])
    return snapshot.Facts(**kw)


class BuildTest(unittest.TestCase):
    def test_a_snapshot_is_version_1_written_now_every_30_seconds_with_no_control_read(self):
        snap = snapshot.build(facts())
        self.assertEqual(snap['version'], 1)
        self.assertEqual(when(snap['written_at']), NOW)
        self.assertEqual(snap['write_every'], 30)
        self.assertIsNone(snap['control_read_at'])

    def test_the_work_lists_are_there_and_empty(self):
        snap = snapshot.build(facts())
        for key in ('asks', 'answered', 'features', 'issues', 'prs', 'activity'):
            self.assertEqual(snap[key], [], key)
        for lane in snap['lanes']:
            self.assertEqual(lane['queue'], [], lane['id'])
            self.assertTrue(lane['queue_empty'])

    def test_repos_come_in_config_order_with_their_github_page_and_who_merges(self):
        self.assertEqual(snapshot.build(facts())['repos'], [
            {'name': 'leads-dashboard', 'github': 'https://github.com/RoyalBullyAgency-RBA/leads-dashboard',
             'merge': 'stefan', 'stopped': None},
            {'name': 'queue-runner', 'github': 'https://github.com/stefan1575/queue-runner',
             'merge': 'runner', 'stopped': None},
        ])


def job(kind, issue, minutes_ago, **kw):
    kw.setdefault('repo', 'leads-dashboard')
    return Job(id=f'{kind}-{issue}', kind=kind, issue=issue, branch=kw.pop('branch', None),
               title=kw.pop('title', f'Queue runner {kind}: leads-dashboard#{issue}'),
               started_at=(NOW - datetime.timedelta(minutes=minutes_ago)).isoformat(), **kw)


def lane(snap, id):
    return next(l for l in snap['lanes'] if l['id'] == id)


class LanesTest(unittest.TestCase):
    def test_an_idle_lane_names_itself_and_offers_no_stop_now(self):
        snap = snapshot.build(facts(claude_model='claude-opus-5-5'))
        claude, sol = lane(snap, 'claude'), lane(snap, 'sol')
        self.assertEqual((claude['provider'], claude['name'], claude['model'], claude['does']),
                         ('claude', 'Claude', 'Opus 5.5', 'builds and fixes'))
        self.assertEqual((sol['provider'], sol['name'], sol['does']), ('chatgpt', 'ChatGPT', 'reviews'))
        for l in (claude, sol):
            self.assertEqual((l['state'], l['job'], l['wait']), ('idle', None, None))
            self.assertFalse(l['stop_now']['available'])
            self.assertTrue(l['stop_now']['note'])

    def test_an_open_build_is_the_claude_lanes_job_with_its_title_and_thread(self):
        build = job('build', 212, 35)
        snap = snapshot.build(facts(jobs=[build], titles={('leads-dashboard', 212): 'Archive view'},
                                    threads={build.id: 'https://app.t3.codes/threads/t1'}))
        claude = lane(snap, 'claude')
        self.assertEqual(claude['state'], 'working')
        self.assertEqual(claude['job'], {
            'kind': 'build', 'repo': 'leads-dashboard', 'ref': '#212', 'title': 'Archive view',
            'started_at': claude['job']['started_at'], 'sha': None, 'pr': None,
            'thread': 'https://app.t3.codes/threads/t1'})
        self.assertEqual(when(claude['job']['started_at']), NOW - datetime.timedelta(minutes=35))
        self.assertEqual(lane(snap, 'sol')['state'], 'idle')

    def test_an_ended_job_is_no_lanes_job(self):
        done = replace(job('build', 212, 35), ended_at=NOW.isoformat(), outcome='done')
        self.assertIsNone(lane(snapshot.build(facts(jobs=[done])), 'claude')['job'])

    def test_a_fix_round_is_on_a_pr_at_its_head_and_a_conflict_round_says_so(self):
        fix = job('fix', 204, 5, sha='a0d5f6f0123456789', link='https://app.t3.codes/threads/t2')
        claude = lane(snapshot.build(facts(jobs=[fix])), 'claude')
        self.assertEqual((claude['job']['kind'], claude['job']['ref'], claude['job']['pr'],
                          claude['job']['sha'], claude['job']['thread']),
                         ('fix', 'PR #204', 204, 'a0d5f6f', 'https://app.t3.codes/threads/t2'))
        conflict = replace(fix, cause='conflict')
        self.assertEqual(lane(snapshot.build(facts(jobs=[conflict])), 'claude')['job']['kind'],
                         'conflict')

    def test_an_open_review_is_the_reviewing_lanes_job(self):
        review = job('review', 210, 12, sha='4be91c2aaaa')
        snap = snapshot.build(facts(jobs=[review]))
        sol = lane(snap, 'sol')
        self.assertEqual(sol['state'], 'working')
        self.assertEqual((sol['job']['kind'], sol['job']['ref'], sol['job']['pr'], sol['job']['sha'],
                          sol['job']['thread']), ('review', 'PR #210', 210, '4be91c2', None))
        self.assertEqual(lane(snap, 'claude')['state'], 'idle')

    def test_a_lane_the_gate_holds_waits_until_then_and_says_why(self):
        until = NOW + datetime.timedelta(hours=2)
        snap = snapshot.build(facts(claude_wait=snapshot.Wait(until, 'the 5-hour window is 80% used')))
        claude = lane(snap, 'claude')
        self.assertEqual(claude['state'], 'waiting')
        self.assertEqual(when(claude['wait']['until']), until)
        self.assertEqual(claude['wait']['reason'], 'The 5-hour window is 80% used.')

    def test_the_reviewing_lane_waits_for_chatgpts_reset(self):
        until = NOW + datetime.timedelta(minutes=40)
        sol = lane(snapshot.build(facts(sol_wait=snapshot.Wait(until, 'ChatGPT is out of usage'))), 'sol')
        self.assertEqual((sol['state'], when(sol['wait']['until'])), ('waiting', until))

    def test_stopped_by_stefan_with_no_job_open_the_lane_is_stopped_since_he_asked(self):
        at = NOW - datetime.timedelta(hours=3)
        snap = snapshot.build(facts(switch=stopped(claude=('after-job', at, 'control'))))
        claude = lane(snap, 'claude')
        self.assertEqual((claude['state'], claude['job'], claude['wait']), ('stopped', None, None))
        self.assertEqual(when(claude['stopped']['at']), at)
        self.assertIsNone(claude['stopped']['during'])
        self.assertEqual(lane(snap, 'sol')['state'], 'idle')
        self.assertEqual(snap['knob'], {'paused': True, 'reserve': 5.0})   # one word: the switch

    def test_gate_jsons_old_pause_reads_stopped_too(self):
        snap = snapshot.build(facts(switch=stopped(claude=('after-job', NOW, 'gate'))))
        self.assertEqual(lane(snap, 'claude')['state'], 'stopped')

    def test_now_reads_stopped_after_the_job_until_stop_now_is_built(self):
        snap = snapshot.build(facts(switch=stopped(claude=('now', NOW, 'control')),
                                    jobs=[job('build', 212, 3)]))
        self.assertEqual(lane(snap, 'claude')['state'], 'stopping')

    def test_stopped_while_a_job_runs_the_lane_is_stopping_after_it(self):
        snap = snapshot.build(facts(switch=stopped(claude=('after-job', NOW, 'control')),
                                    jobs=[job('build', 212, 3)]))
        claude = lane(snap, 'claude')
        self.assertEqual((claude['state'], claude['job']['ref']), ('stopping', '#212'))
        self.assertNotIn('stopped', claude)

    def test_the_reviewing_lane_stops_the_same_way(self):
        snap = snapshot.build(facts(switch=stopped(sol=('after-job', NOW, 'control')),
                                    sol_wait=snapshot.Wait(NOW, 'ChatGPT is out of usage')))
        sol = lane(snap, 'sol')
        self.assertEqual((sol['state'], sol['wait']), ('stopped', None))
        self.assertEqual(lane(snap, 'claude')['state'], 'idle')
        self.assertEqual(snap['knob']['paused'], False)

    def test_control_read_at_is_the_control_files_own_written_at(self):
        written = '2026-11-15T12:58:00+08:00'
        snap = snapshot.build(facts(switch=control.Switch({}, written)))
        self.assertEqual(snap['control_read_at'], written)
        self.assertEqual(lane(snap, 'claude')['state'], 'idle')

    def test_an_unreadable_control_json_holds_both_lanes_and_says_so(self):
        bad = control.Switch(error='control.json is unreadable (Expecting value)')
        snap = snapshot.build(facts(switch=bad, jobs=[job('build', 212, 3)]))
        self.assertIsNone(snap['control_read_at'])
        claude, sol = lane(snap, 'claude'), lane(snap, 'sol')
        self.assertEqual(claude['state'], 'working')   # its job runs on; nothing starts after
        self.assertEqual(sol['state'], 'waiting')
        self.assertIsNone(sol['wait']['until'])
        self.assertIn('control.json is unreadable (Expecting value)', sol['wait']['reason'])
        self.assertIn('until it is fixed', sol['wait']['reason'])


def stopped(**lanes):
    return control.Switch({id: control.Stop(*stop) for id, stop in lanes.items()},
                          '2026-11-15T12:58:00+08:00')


FIVE_RESET = NOW + datetime.timedelta(hours=1)
WEEK_RESET = NOW + datetime.timedelta(hours=50)


def plan(snap, id):
    return next(p for p in snap['usage'] if p['id'] == id)


def window(p, id):
    return next(w for w in p['windows'] if w['id'] == id)


class UsageTest(unittest.TestCase):
    def test_claudes_windows_as_last_read_with_the_weeks_reserve_and_when_it_opens(self):
        read = snapshot.Reading(Usage(Window(38, FIVE_RESET), Window(46, WEEK_RESET)),
                                NOW - datetime.timedelta(minutes=1))
        p = plan(snapshot.build(facts(claude_usage=read, knob=Knob(reserve=7))), 'claude')
        self.assertEqual((p['provider'], p['name'], p['plan'], p['error']), ('claude', 'Claude', None, None))
        self.assertEqual(when(p['read_at']), NOW - datetime.timedelta(minutes=1))
        five, week = window(p, 'five_hour'), window(p, 'week')
        self.assertEqual((five['label'], five['used'], when(five['resets_at']), five['gates']),
                         ('Session', 38, FIVE_RESET, True))
        self.assertEqual((week['label'], week['used'], week['reserve'], week['gates']),
                         ('Weekly', 46, 7, True))
        self.assertEqual(when(week['reserve_opens_at']), WEEK_RESET - datetime.timedelta(hours=24))

    def test_a_window_not_started_has_no_reset(self):
        read = snapshot.Reading(Usage(Window(0, None), Window(0, None)), NOW)
        p = plan(snapshot.build(facts(claude_usage=read)), 'claude')
        self.assertIsNone(window(p, 'five_hour')['resets_at'])
        self.assertIsNone(window(p, 'week')['reserve_opens_at'])

    def test_a_failed_read_keeps_the_last_good_windows_and_says_why(self):
        read = snapshot.Reading(Usage(Window(38, FIVE_RESET), Window(46, WEEK_RESET)),
                                NOW - datetime.timedelta(minutes=20), 'the usage endpoint answered HTTP 401')
        p = plan(snapshot.build(facts(claude_usage=read)), 'claude')
        self.assertEqual(p['error'], 'The usage endpoint answered HTTP 401.')
        self.assertEqual(window(p, 'five_hour')['used'], 38)

    def test_usage_never_read_has_no_windows(self):
        p = plan(snapshot.build(facts()), 'claude')
        self.assertEqual((p['windows'], p['read_at']), ([], None))
        self.assertTrue(p['error'])

    def test_chatgpts_windows_come_from_codexs_newest_rate_limits(self):
        limits = SolLimits(plan='plus', windows=(SolWindow(300, 93.0, FIVE_RESET),
                                                 SolWindow(10080, 22.0, WEEK_RESET)))
        p = plan(snapshot.build(facts(sol_usage=snapshot.Reading(limits, NOW))), 'sol')
        self.assertEqual((p['provider'], p['name'], p['plan'], p['error']), ('chatgpt', 'ChatGPT', 'Plus', None))
        self.assertEqual([(w['id'], w['label'], w['used'], when(w['resets_at']), w['gates']) for w in p['windows']],
                         [('five_hour', 'Session', 93.0, FIVE_RESET, True), ('week', 'Weekly', 22.0, WEEK_RESET, True)])

    def test_each_plan_says_how_many_reset_credits_it_has_from_the_same_read(self):
        claude = snapshot.Reading(Usage(Window(38, FIVE_RESET), Window(46, WEEK_RESET), resets=2), NOW)
        sol = snapshot.Reading(SolLimits('plus', (SolWindow(300, 9.0, FIVE_RESET),), resets=0), NOW)
        snap = snapshot.build(facts(claude_usage=claude, sol_usage=sol))
        self.assertEqual(plan(snap, 'claude')['resets'], {'available': 2})
        self.assertEqual(plan(snap, 'sol')['resets'], {'available': 0})

    def test_a_plan_with_no_reset_credits_to_give_or_not_read_says_none(self):
        claude = snapshot.Reading(Usage(Window(38, FIVE_RESET), Window(46, WEEK_RESET)), NOW)
        snap = snapshot.build(facts(claude_usage=claude))
        self.assertIsNone(plan(snap, 'claude')['resets'])
        self.assertIsNone(plan(snap, 'sol')['resets'])


class CostsAndRolesTest(unittest.TestCase):
    def test_each_claude_job_kinds_expected_cost_and_where_it_comes_from(self):
        costs = {'build': (Cost(60, 15), False), 'fix': (Cost(34, 6), True),
                 'decision': (Cost(15, 4), False), 'live': (Cost(20, 5), False)}
        rows = snapshot.build(facts(costs=costs))['costs']
        self.assertEqual([(r['kind'], r['label'], r['session'], r['week']) for r in rows],
                         [('build', 'Build', 60, 15), ('fix', 'Fix round', 34, 6),
                          ('decision', 'Decision', 15, 4), ('live', 'Live steps', 20, 5)])
        self.assertEqual(rows[1]['basis'], 'The largest of the last 5')
        self.assertEqual(rows[0]['basis'], 'The cautious default, until 3 builds are recorded')

    def test_every_role_names_a_lane(self):
        snap = snapshot.build(facts())
        lanes = {l['id'] for l in snap['lanes']}
        self.assertEqual([r['lane'] for r in snap['roles']], ['claude'] * 4 + ['sol'])
        self.assertTrue({r['lane'] for r in snap['roles']} <= lanes)


class SourcesAndRunnerTest(unittest.TestCase):
    def source(self, snap, id):
        return next(s for s in snap['sources'] if s['id'] == id)

    def test_the_four_sources_by_group_each_from_its_last_call(self):
        an_hour = NOW - datetime.timedelta(hours=1)
        calls = {'github': snapshot.Call(NOW - datetime.timedelta(minutes=2), True, None, NOW - datetime.timedelta(minutes=2)),
                 't3': snapshot.Call(NOW, False, 'T3 Code server is not running', an_hour)}
        snap = snapshot.build(facts(calls=calls))
        self.assertEqual([(s['id'], s['group'], s['short']) for s in snap['sources']],
                         [('claude_usage', 'provider', 'Claude'), ('sol_usage', 'provider', 'ChatGPT'),
                          ('t3', 'local', 'T3 Code'), ('github', 'external', 'GitHub')])
        github, t3 = self.source(snap, 'github'), self.source(snap, 't3')
        self.assertTrue(github['ok'])
        self.assertEqual(when(github['checked_at']), NOW - datetime.timedelta(minutes=2))
        self.assertFalse(t3['ok'])
        self.assertEqual(t3['note'], 'T3 Code server is not running')
        self.assertEqual(when(t3['checked_at']), an_hour)   # a failing source's time is its last good one

    def test_a_source_not_called_yet_says_so(self):
        s = self.source(snapshot.build(facts()), 'github')
        self.assertEqual((s['ok'], s['note'], s['checked_at']), (True, 'Not called yet', None))

    def test_the_runner_its_pid_start_and_commit_and_how_to_start_it(self):
        started = NOW - datetime.timedelta(hours=6)
        snap = snapshot.build(facts(runner=snapshot.RunnerInfo(18244, started, '66a5ea1')))
        self.assertEqual((snap['runner']['pid'], when(snap['runner']['started_at']), snap['runner']['commit']),
                         (18244, started, '66a5ea1'))
        self.assertIn('Queue runner.lnk', snap['start_hint'])


def busy_facts():
    """A real snapshot with everything in it: both lanes working, usage read, every source called."""
    call = snapshot.Call(NOW, True, None, NOW)
    return facts(
        jobs=[job('build', 212, 35, link='https://app.t3.codes/threads/t1'),
              job('review', 210, 12, sha='4be91c2aaaa')],
        runner=snapshot.RunnerInfo(1, NOW, 'abc1234'),
        calls={id: call for id in ('github', 't3', 'claude_usage', 'sol_usage')},
        claude_usage=snapshot.Reading(Usage(Window(38, FIVE_RESET), Window(46, WEEK_RESET)), NOW),
        sol_usage=snapshot.Reading(SolLimits('plus', (SolWindow(300, 1.0, FIVE_RESET),)), NOW),
        costs={k: (Cost(1, 1), False) for k in ('build', 'fix', 'decision', 'live')})


class ContractTest(unittest.TestCase):
    """The real snapshot has the sample's keys: at the top, in a lane and its job, a usage plan, a
    window and a source. Keys some samples have and others don't may be there or not."""

    @classmethod
    def setUpClass(cls):
        stopped = {'written_at': '2026-11-15T12:00:00+08:00',
                   'lanes': {'claude': {'stop': 'now', 'at': '2026-11-15T12:00:00+08:00'}}}
        cls.samples = [sample.build(name) for name in sample.STATES] + [sample.build(control=stopped)]

    def keys(self, pick):
        """(the keys every sample has there, the keys any has), over `pick(sample)`'s dicts."""
        sets = [set(d) for s in self.samples for d in pick(s)]
        return set.intersection(*sets), set.union(*sets)

    def holds(self, real: list[dict], pick, what):
        must, may = self.keys(pick)
        for d in real:
            with self.subTest(what=what):
                self.assertLessEqual(must, set(d), f'{what} lacks keys the sample always has')
                self.assertLessEqual(set(d), may, f'{what} has keys no sample has')

    def test_the_real_snapshot_has_the_samples_keys(self):
        for snap in (snapshot.build(busy_facts()), snapshot.build(facts()),
                     snapshot.build(facts(switch=stopped(claude=('after-job', NOW, 'gate'))))):
            self.assertEqual(set(snap), set(self.samples[0]) - {'sample'})
            self.holds(snap['lanes'], lambda s: s['lanes'], 'a lane')
            self.holds([l['job'] for l in snap['lanes'] if l['job']],
                       lambda s: [l['job'] for l in s['lanes'] if l['job']], "a lane's job")
            self.holds([l['wait'] for l in snap['lanes'] if l['wait']],
                       lambda s: [l['wait'] for l in s['lanes'] if l['wait']], "a lane's wait")
            self.holds([l['stop_now'] for l in snap['lanes']],
                       lambda s: [l['stop_now'] for l in s['lanes']], "a lane's stop_now")
            self.holds(snap['usage'], lambda s: s['usage'], 'a usage plan')
            self.holds([w for p in snap['usage'] for w in p['windows']],
                       lambda s: [w for p in s['usage'] for w in p['windows']], 'a window')
            self.holds(snap['sources'], lambda s: s['sources'], 'a source')
            self.holds(snap['repos'], lambda s: s['repos'], 'a repo')
            self.holds(snap['costs'], lambda s: s['costs'], 'a cost')
            self.holds(snap['roles'], lambda s: s['roles'], 'a role')
            self.holds([snap['runner']], lambda s: [s['runner']], 'the runner')
            json.dumps(snap)   # it's written as JSON

    def test_the_samples_sources_are_the_runners(self):
        # Only what the runner depends on (ticket 43): no sample lists a source the real
        # snapshot can't, such as Stop now, which shows on a lane's Stop button instead.
        real = {id: (group, name, short) for id, group, name, short, _ in snapshot.SOURCES}
        for s in self.samples:
            with self.subTest(sample=s.get('sample')):
                self.assertEqual({x['id']: (x['group'], x['name'], x['short']) for x in s['sources']}, real)

    def test_a_stopped_lane_says_when_as_the_samples_do(self):
        snap = snapshot.build(facts(switch=stopped(claude=('after-job', NOW, 'control'))))
        self.holds([lane(snap, 'claude')['stopped']],
                   lambda s: [l['stopped'] for l in s['lanes'] if 'stopped' in l], "a lane's stop")


class Clock:
    def __init__(self, t=NOW):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, **kw):
        self.t += datetime.timedelta(**kw)


class CallsTest(unittest.TestCase):
    def test_a_watched_adapters_calls_are_its_sources_last_call(self):
        class GitHub:
            name = 'gh'

            def __init__(self):
                self.down = False

            def open_pulls(self, repo):
                if self.down:
                    raise RuntimeError('gh api failed (1): HTTP 503\nmore')
                return ['pr']

        clock, gh = Clock(), GitHub()
        calls = snapshot.Calls(clock)
        watched = calls.watch(gh, 'github')
        self.assertIsNone(calls.all().get('github'))
        self.assertEqual(watched.open_pulls('r'), ['pr'])
        self.assertEqual(watched.name, 'gh')   # not a call: passed through
        good = NOW
        self.assertEqual(calls.all()['github'], snapshot.Call(good, True, None, good))
        clock.tick(minutes=5)
        gh.down = True
        with self.assertRaises(RuntimeError):
            watched.open_pulls('r')
        self.assertEqual(calls.all()['github'],
                         snapshot.Call(clock(), False, 'gh api failed (1): HTTP 503', good))


class WatchTest(unittest.TestCase):
    def test_a_read_is_kept_and_a_failed_one_keeps_the_last_good_value(self):
        clock = Clock()
        reads = [Usage(Window(10, None), Window(20, None)), UsageError('HTTP 401')]

        def read():
            got = reads.pop(0)
            if isinstance(got, Exception):
                raise got
            return got
        calls = snapshot.Calls(clock)
        watch = snapshot.Watch(read, calls, 'claude_usage', clock)
        self.assertIsNone(watch.reading())
        self.assertTrue(watch.due(300))
        first = watch.read()
        self.assertEqual(watch.reading(), snapshot.Reading(first, NOW))
        clock.tick(minutes=4)
        self.assertFalse(watch.due(300))
        clock.tick(minutes=1)
        self.assertTrue(watch.due(300))
        with self.assertRaises(UsageError):
            watch.read()
        self.assertEqual(watch.reading(), snapshot.Reading(first, NOW, 'HTTP 401'))
        self.assertFalse(calls.all()['claude_usage'].ok)

    def test_a_read_that_returns_when_it_was_read_keeps_that_time(self):
        at = NOW - datetime.timedelta(minutes=9)
        watch = snapshot.Watch(lambda: (at, 'limits'), snapshot.Calls(Clock()), 'sol_usage',
                               Clock(), timed=True)
        self.assertEqual(watch.read(), 'limits')
        self.assertEqual(watch.reading(), snapshot.Reading('limits', at))


class PublisherTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, 'state', 'snapshot.json')
        self.said = []

    def test_it_writes_the_snapshot_whole_and_leaves_no_temp_file(self):
        pub = snapshot.Publisher(self.path, lambda fresh: {'version': 1, 'fresh': fresh}, self.said.append)
        self.assertTrue(pub.publish())
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {'version': 1, 'fresh': False})
        self.assertEqual(os.listdir(os.path.dirname(self.path)), ['snapshot.json'])

    def test_a_write_that_fails_is_said_once_and_never_raises(self):
        fail = [True]

        def make(fresh):
            if fail[0]:
                raise OSError('disk full')
            return {'version': 1}
        pub = snapshot.Publisher(self.path, make, self.said.append)
        self.assertFalse(pub.publish())
        self.assertFalse(pub.publish())
        self.assertEqual(len(self.said), 1)
        self.assertIn('disk full', self.said[0])
        fail[0] = False
        self.assertTrue(pub.publish())
        self.assertEqual(len(self.said), 2)
        self.assertIn('written again', self.said[1])

    def test_its_own_thread_writes_every_so_often_reading_afresh(self):
        wrote = []
        got = threading.Event()

        def make(fresh):
            wrote.append(fresh)
            if len(wrote) >= 3:
                got.set()
            return {'version': 1}
        pub = snapshot.Publisher(self.path, make, self.said.append, every=0.01)
        pub.start()
        try:
            self.assertTrue(got.wait(5))
        finally:
            pub.stop()
        self.assertEqual(wrote[0], False)   # the first write, at start, reads nothing afresh
        self.assertTrue(all(wrote[1:3]))
        n = len(wrote)
        time.sleep(0.05)
        self.assertEqual(len(wrote), n)     # stopped


class FakeRunner:
    """What `Snapshots` reads from the running runner."""

    def __init__(self, wait=None, titles=None, thread=None):
        self.claude_wait, self.titles, self.thread, self.looked = wait, titles or {}, thread, []

    def find_thread(self, job):
        self.looked.append(job.id)
        return self.thread


class SnapshotsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = os.path.join(tmp.name, 'state')
        self.config = Config(repos=[LD, QR], state_dir=self.state, log_dir=os.path.join(tmp.name, 'logs'))
        self.jobs = JobLog(os.path.join(self.state, 'jobs.jsonl'))
        self.clock = Clock()
        self.calls = snapshot.Calls(self.clock)
        self.usage = FakeUsage(Usage(Window(38, FIVE_RESET), Window(46, WEEK_RESET)))
        self.limits = []

    def snapshots(self, runner=None):
        def sol():
            self.limits.append(1)
            return NOW, SolLimits('plus', (SolWindow(300, 9.0, FIVE_RESET),))
        return snapshot.Snapshots(
            self.config, calls=self.calls, clock=self.clock, runner=runner,
            info=snapshot.RunnerInfo(42, NOW, 'abc1234'),
            claude=snapshot.Watch(self.usage.read, self.calls, 'claude_usage', self.clock),
            sol=snapshot.Watch(sol, self.calls, 'sol_usage', self.clock, timed=True))

    def test_the_job_log_gate_json_and_the_costs_from_the_state_folder(self):
        self.jobs.started(kind='build', repo='leads-dashboard', issue=212, branch='claude/x-212',
                          title='Queue runner build: leads-dashboard#212')
        write_knob(self.state, Knob(reserve=5.0))
        with open(os.path.join(self.state, 'control.json'), 'w', encoding='utf-8') as f:
            json.dump({'version': 1, 'written_at': '2026-11-15T12:58:00+08:00',
                       'lanes': {'sol': {'stop': 'after-job', 'at': '2026-11-15T12:58:00+08:00'}}}, f)
        facts = self.snapshots().facts()
        self.assertEqual([(j.kind, j.issue, j.open) for j in facts.jobs], [('build', 212, True)])
        self.assertEqual(facts.knob, Knob(reserve=5.0))
        self.assertTrue(facts.switch.holds('sol'))
        self.assertEqual(facts.switch.written_at, '2026-11-15T12:58:00+08:00')
        self.assertEqual(facts.costs['build'], (Cost(60, 15), False))
        self.assertEqual(facts.runner, snapshot.RunnerInfo(42, NOW, 'abc1234'))
        self.assertEqual(facts.repos, [LD, QR])

    def test_a_snapshot_after_a_pass_reads_nothing_afresh(self):
        self.jobs.started(kind='build', repo='leads-dashboard', issue=212, branch=None, title='t')
        runner = FakeRunner(thread=Thread('t1', 't', 'https://app.t3.codes/threads/t1', 'running', False, NOW.isoformat()))
        facts = self.snapshots(runner).facts(fresh=False)
        self.assertEqual((self.usage.count, self.limits, runner.looked), (0, [], []))
        self.assertIsNone(facts.claude_usage)

    def test_a_fresh_one_reads_usage_once_every_5_minutes_and_finds_an_open_jobs_thread_once(self):
        job = self.jobs.started(kind='build', repo='leads-dashboard', issue=212, branch=None, title='t')
        runner = FakeRunner(thread=Thread('t1', 't', 'https://app.t3.codes/threads/t1', 'running', False, NOW.isoformat()))
        snaps = self.snapshots(runner)
        facts = snaps.facts(fresh=True)
        self.assertEqual(facts.claude_usage.value.five_hour.used, 38)
        self.assertEqual(facts.sol_usage.value.plan, 'plus')
        self.assertEqual(facts.threads, {job.id: 'https://app.t3.codes/threads/t1'})
        self.clock.tick(minutes=4)
        snaps.facts(fresh=True)
        self.assertEqual((self.usage.count, len(self.limits), runner.looked), (1, 1, [job.id]))
        self.clock.tick(minutes=1)
        snaps.facts(fresh=True)
        self.assertEqual((self.usage.count, len(self.limits)), (2, 2))

    def test_a_thread_not_there_yet_is_looked_for_again(self):
        self.jobs.started(kind='build', repo='leads-dashboard', issue=212, branch=None, title='t')
        runner = FakeRunner(thread=None)
        snaps = self.snapshots(runner)
        snaps.facts(fresh=True)
        self.assertEqual(snaps.facts(fresh=True).threads, {})
        self.assertEqual(len(runner.looked), 2)

    def test_the_runners_wait_and_titles_go_in(self):
        wait = snapshot.Wait(NOW, 'paused')
        facts = self.snapshots(FakeRunner(wait=wait, titles={('leads-dashboard', 4): 'Red'})).facts()
        self.assertEqual((facts.claude_wait, facts.titles), (wait, {('leads-dashboard', 4): 'Red'}))

    def test_with_no_runner_a_limits_resume_is_the_claude_lanes_wait(self):
        job = self.jobs.started(kind='build', repo='leads-dashboard', issue=212, branch=None, title='t')
        resume = NOW + datetime.timedelta(hours=1)
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit', resume_at=resume.isoformat())
        facts = self.snapshots().facts()
        self.assertEqual(facts.claude_wait.until, resume)
        self.assertIn('usage limit', facts.claude_wait.reason)

    def test_chatgpt_out_of_usage_is_the_reviewing_lanes_wait(self):
        job = self.jobs.started(kind='review', repo='leads-dashboard', issue=210, branch=None, title='t')
        resume = NOW + datetime.timedelta(minutes=30)
        self.jobs.ended(job.id, exit_code=None, outcome='out-of-usage', resume_at=resume.isoformat())
        self.assertEqual(self.snapshots().facts().sol_wait.until, resume)
        self.clock.tick(hours=1)
        self.assertIsNone(self.snapshots().facts().sol_wait)

    def test_an_unreadable_gate_json_is_no_knob(self):
        os.makedirs(self.state)
        with open(os.path.join(self.state, 'gate.json'), 'w') as f:
            f.write('{ torn')
        snap = self.snapshots().build()
        self.assertEqual(snap['knob'], {'paused': False, 'reserve': None})


if __name__ == '__main__':
    unittest.main()
