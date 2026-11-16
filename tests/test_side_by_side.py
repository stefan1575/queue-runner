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

    def run_main(self, args, passes=1, t3=None, usage=ROOM, limits=None, clock=None):
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
                        usage=FakeUsage(usage), clock=clock or (lambda: NOW),
                        limits=limits or FakeLimits(),
                        t3_settings=os.path.join(self.dir, 't3.json'), waker=NoWaker())
        except Done:
            code = None
        return code, out.getvalue()

    def built(self):
        return [os.path.basename(s['project']) for s in self.t3.starts]

    def learn(self, kind='build', five=10, week=2):
        """The gate has learned that a `kind` job takes `five`% of 5 hours (three solo passes),
        so two fit side by side; the cautious default (a build's 60%) never lets two in."""
        from queue_runner.gate import CostBook
        book = CostBook(os.path.join(self.state, 'usage.jsonl'))
        for _ in range(3):
            book.record(kind, ['learned'], used(10, 10), used(10 + five, 10 + week))

    def write_events(self, *events):
        """Job-log records as a runner wrote them, with their own times."""
        with open(self.log.path, 'a', encoding='utf-8') as f:
            for e in events:
                f.write(json.dumps(e) + '\n')

    def earlier_build(self, repo, n, ended):
        """A build of `repo`'s issue `n` that ended at `ended` (it holds that issue)."""
        jid = f'old-{repo}-{n}'
        self.write_events(
            {'event': 'start', 'job': jid, 'kind': 'build', 'repo': repo, 'issue': n,
             'branch': f'claude/old-{n}', 'title': f'Queue runner build: {repo}#{n}',
             'at': '2026-11-15T08:00:00+00:00'},
            {'event': 'end', 'job': jid, 'at': ended, 'exit_code': 0, 'outcome': 'done',
             'pr': {'number': 90 + n, 'url': 'u', 'state': 'merged'}})

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()


class Together(FakeT3):
    """A T3 whose threads each wait at a barrier until `n` have started: the test fails (the
    barrier breaks) unless the Claude jobs really run at the same time."""

    def __init__(self, outcomes, n=2):
        import threading
        super().__init__(outcomes)
        self.barrier = threading.Barrier(n, timeout=10)

    def start(self, *args, **kwargs):
        self.barrier.wait()
        return super().start(*args, **kwargs)


class SideBySideTest(Harness):
    """#50: each working repo gets its own Claude job at once."""

    def setUp(self):
        super().setUp()
        self.learn()

    def test_one_pass_starts_a_build_in_each_repo_and_they_run_at_the_same_time(self):
        code, out = self.run_main(['--once'], t3=Together([(0, 'completed')] * 2))
        self.assertEqual(code, 0)
        self.assertEqual(sorted(self.built()), ['first', 'second'])
        done = {(j.repo, j.issue, j.outcome) for j in self.log.jobs()}
        self.assertEqual(done, {('first', 4, 'done'), ('second', 7, 'done')})

    def test_the_loop_runs_them_side_by_side_too(self):
        self.run_main([], passes=1, t3=Together([(0, 'completed')] * 2))
        self.assertEqual(sorted(self.built()), ['first', 'second'])

    def test_a_repo_with_a_job_running_gets_no_other_until_it_ends(self):
        import threading
        release, planned = threading.Event(), []
        self.gh.by_repo['first'].append(issue(5, 'Green widget', 'Green.'))
        ready = self.gh.ready_issues

        def ready_issues(repo):   # the lane plans again once second's #7 has ended
            if threading.current_thread() is threading.main_thread():   # not the Sol lane's read
                planned.append(repo.name)
                if planned.count('second') == 2:
                    release.set()
            return ready(repo)
        self.gh.ready_issues = ready_issues

        class FirstBlocks(FakeT3):
            """first's #4 runs until the lane has planned again without it."""
            def start(self, project, message, **kwargs):
                if project.endswith('first') and not release.is_set():
                    release.wait(10)
                return super().start(project, message, **kwargs)
        self.run_main([], t3=FirstBlocks([(0, 'completed')] * 3))
        self.assertTrue(release.is_set())
        titles = [s['title'] for s in self.t3.starts]
        self.assertEqual(sorted(titles[:2]), ['Queue runner build: first#4',
                                              'Queue runner build: second#7'])
        self.assertEqual(titles[2:], ['Queue runner build: first#5'])   # once #4 had ended
        # The pass after #7 ended chose nothing in first, whose #4 still ran
        self.assertEqual(planned[:3], ['first', 'second', 'second'])

    def test_a_stopped_repo_gets_none(self):
        self.put({'version': 1, 'written_at': WRITTEN, 'lanes': {},
                  'repos': {'first': {'stop': 'after-job', 'at': WRITTEN}}})
        self.run_main(['--once'])
        self.assertEqual(self.built(), ['second'])

    def test_a_job_a_dead_runner_left_running_holds_only_its_own_repo(self):
        self.write_events({'event': 'start', 'job': 'dead', 'kind': 'build', 'repo': 'first',
                           'issue': 3, 'branch': 'claude/x-3',
                           'title': 'Queue runner build: first#3',
                           'at': '2026-11-15T11:00:00+00:00'})
        t3 = FakeT3([(0, 'completed')])
        t3.add('mcp:dead', 'Queue runner build: first#3', 'running',
               created_at='2026-11-15T11:00:01.000Z')
        self.run_main(['--once'], t3=t3)
        self.assertEqual(self.built(), ['second'])
        self.assertIn('build first#3 is still running in', self.runner_log())


class RestartTest(Harness):
    """New code for the runner itself (`restart.py`): with jobs running, the Claude lane starts
    no more, and restarts once they end, so two repos taking turns can't hold it off."""

    def test_new_code_waits_for_the_running_jobs_and_starts_none_meanwhile(self):
        import threading
        from tests.test_restart import FakeSelfUpdate
        release = threading.Event()
        self.gh.by_repo['second'].append(issue(8, 'Pink widget', 'Pink.'))
        lines = []

        def log_line(line):
            lines.append(line)
            if 'starts no Claude job, and restarts on the new code' in line:
                release.set()

        class FirstBlocks(FakeT3):
            def start(self, project, message, **kwargs):
                if project.endswith('first'):
                    release.wait(10)
                return super().start(project, message, **kwargs)
        t3 = FirstBlocks([(0, 'completed')] * 3)
        runner = Runner(load_config(self.config), github=self.gh, t3=t3, git=FakeGit(),
                        out=io.StringIO(), log_line=log_line, now=lambda: NOW,
                        self_update=FakeSelfUpdate(after=1))
        self.assertEqual(runner.run_forever(lambda s: self.fail('slept')), 'restart')
        self.assertTrue(release.is_set(), lines)
        self.assertEqual(sorted(s['title'] for s in t3.starts),
                         ['Queue runner build: first#4', 'Queue runner build: second#7'])
        self.assertEqual({j.outcome for j in self.log.jobs()}, {'done'})


def used(five, week=10):
    later = NOW + datetime.timedelta(hours=3)
    return Usage(Window(five, later), Window(week, NOW + datetime.timedelta(days=3)))


class GateTest(Harness):
    """The gate counts the jobs still running before it starts another; with room for only one
    more, the repo whose work has waited longest gets it, config.toml's order breaking a tie."""

    def test_with_room_for_one_build_the_first_in_config_toml_gets_it_on_a_tie(self):
        _, out = self.run_main(['--once'], usage=used(30))   # 30 + 60 fits; 30 + 60 + 60 not
        self.assertEqual(self.built(), ['first'])
        self.assertIn('Claude lane waits on second: build would fit alone, but the Claude job '
                      'running (build first#4) is expected to take 60% of 5 hours, 15% of the '
                      'week: it waits for one of them to end', self.runner_log())

    def test_the_repo_whose_work_waited_longest_goes_first(self):
        self.earlier_build('first', 1, '2026-11-15T11:30:00+00:00')
        self.earlier_build('second', 2, '2026-11-15T09:00:00+00:00')
        self.run_main(['--once'], usage=used(30))
        self.assertEqual(self.built(), ['second'])
        self.earlier_build('second', 3, '2026-11-15T11:50:00+00:00')
        os.remove(self.log.path)   # afresh: now first has waited longer
        self.earlier_build('first', 1, '2026-11-15T09:00:00+00:00')
        self.earlier_build('second', 2, '2026-11-15T11:30:00+00:00')
        self.run_main(['--once'], usage=used(30))
        self.assertEqual(self.built(), ['first'])

    def test_a_job_that_does_not_fit_leaves_room_for_a_later_one_that_does(self):
        # first (the tie's winner) has a build the gate holds; second's decision fits
        from queue_runner.gate import FITS, FIVE_HOUR, Verdict
        self.gh.by_repo['second'] = []
        fail = self.log.started(kind='build', repo='second', issue=7, branch='claude/blue-7',
                                title='Queue runner build: second#7')
        self.log.ended(fail.id, exit_code=1, outcome='failed', thread_id='mcp:s7')
        from tests.fakes_t3 import decision_reply
        t3 = FakeT3([(0, 'completed', decision_reply('stop', reason='Stefan should look.'))])
        t3.add('mcp:s7', 'Queue runner build: second#7', 'failed')

        class OnlyDecisions:
            asked = []

            def check(self, kind, then=None, running=()):
                self.asked.append(kind)
                return (Verdict(True, FITS, 'a decision fits', usage=ROOM) if kind == 'decision'
                        else Verdict(False, FIVE_HOUR, 'the 5-hour window is full'))

            def measured(self, *args, **kwargs):
                pass
        lines = []
        runner = Runner(load_config(self.config), github=self.gh, t3=t3, git=FakeGit(),
                        out=io.StringIO(), log_line=lines.append, gate=OnlyDecisions(),
                        now=lambda: NOW)
        self.assertEqual(runner.run_pass(), 'started')
        self.assertEqual(OnlyDecisions.asked, ['build', 'decision'])   # first's, then second's
        self.assertEqual([s['title'] for s in t3.starts], ['Queue runner decision: second#7'])
        self.assertIn('Claude lane waits on first: the 5-hour window is full', lines)

    def test_two_jobs_at_once_teach_the_learned_costs_nothing(self):
        self.learn()
        self.run_main(['--once'], t3=Together([(0, 'completed')] * 2))
        with open(os.path.join(self.state, 'usage.jsonl'), encoding='utf-8') as f:
            records = [json.loads(line) for line in f][3:]   # after the three learned
        self.assertEqual(len(records), 2)
        shared = {r['jobs'][0]: r.get('shared_with') for r in records}
        self.assertTrue(all(shared.values()), records)
        self.assertEqual(sorted(s for v in shared.values() for s in v),
                         ['build first#4', 'build second#7'])

    def test_one_job_alone_still_teaches(self):
        self.gh.by_repo['second'] = []
        self.run_main(['--once'])
        with open(os.path.join(self.state, 'usage.jsonl'), encoding='utf-8') as f:
            [record] = [json.loads(line) for line in f]
        self.assertNotIn('shared_with', record)
        self.assertEqual(record['kind'], 'build')


class LimitTest(Harness):
    """A usage limit cuts off each running job, as it does one (ticket 09): each is recovered
    in its own repo once the limit has reset, and nothing starts before."""

    def test_both_jobs_cut_off_are_recovered_each_in_its_repo(self):
        self.learn()
        from tests.test_run import LIMIT_SAID
        from queue_runner.t3 import Message
        limits = FakeLimits(resets={'mcp:t1': NOW + datetime.timedelta(hours=1),
                                    'mcp:t2': NOW + datetime.timedelta(hours=1)},
                            contexts={'mcp:t1': 20_000, 'mcp:t2': 20_000})
        t3 = Together([(1, 'failed'), (1, 'failed')])
        for tid in ('mcp:t1', 'mcp:t2'):
            t3.messages[tid] = [Message('assistant', LIMIT_SAID)]
        self.run_main(['--once'], t3=t3, limits=limits)
        cut = {(j.repo, j.outcome) for j in self.log.jobs()}
        self.assertEqual(cut, {('first', 'usage-limit'), ('second', 'usage-limit')})
        self.gh.by_repo['first'].append(issue(5, 'Green widget', 'Green.'))
        _, out = self.run_main(['--once'], t3=t3, limits=limits)   # before the reset
        self.assertEqual((len(t3.starts), t3.sends), (2, []))
        self.assertIn('was cut off by a usage limit', out)
        t3.outcomes = [(0, 'completed')] * 2   # after it: each continues in place
        later = NOW + datetime.timedelta(hours=2)
        self.run_main(['--once'], t3=t3, limits=limits, clock=lambda: later)
        self.assertEqual(sorted(s['thread_id'] for s in t3.sends), ['mcp:t1', 'mcp:t2'])
        self.assertEqual(len(t3.starts), 2)   # first's #5 waits for its own job's recovery
        recovered = {j.repo for j in self.log.jobs() if j.about and j.outcome == 'done'}
        self.assertEqual(recovered, {'first', 'second'})


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
