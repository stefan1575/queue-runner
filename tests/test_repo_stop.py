"""Stopping one repo (ticket 37): control.json's `repos.<name>.stop`, written by the page and by
`--pause NAME` and `--resume NAME`. Both lanes leave a stopped repo alone, in everything they
choose and do, and take the next repo's work. GitHub, T3, git and Sol are faked; every file is in
a temp folder."""
import datetime
import io
import json
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.run import Runner
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, issue
from tests.test_live import FakeLiveGit

UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
WRITTEN = '2026-11-15T19:58:00+08:00'
A, B = 'a' * 40, 'b' * 40
M1 = 'supabase/migrations/20261101000000_one.sql'
LD, GB = 'leads-dashboard', 'game-backdrop'


class Done(Exception):
    pass


def control(order=(), lanes=None, **repos):
    """control.json as the page writes it; each repo's stop by its name (`**{LD: ...}`)."""
    return {'version': 1, 'written_at': WRITTEN,
            'lanes': {k: {'stop': v, 'at': WRITTEN} for k, v in (lanes or {}).items()},
            'repo_order': list(order),
            'repos': {k: {'stop': v, 'at': WRITTEN} for k, v in repos.items()}}


class PerRepoGitHub(FakeGitHubForReviews):
    """Each repo's own ready issues and open PRs, and the repos whose PRs were read."""

    def __init__(self, issues=None, prs=None, **kwargs):
        super().__init__(issues=[i for its in (issues or {}).values() for i in its],
                         prs=[p for ps in (prs or {}).values() for p in ps], **kwargs)
        self.by_repo_issues = dict(issues or {})
        self.by_repo_prs = dict(prs or {})
        self.read = []

    def ready_issues(self, repo):
        return list(self.by_repo_issues.get(repo.name, []))

    def open_pulls(self, repo):
        self.read.append(repo.name)
        return list(self.by_repo_prs.get(repo.name, []))

    def pull(self, repo, number):
        self.prs = [p for ps in self.by_repo_prs.values() for p in ps]
        return super().pull(repo, number)


class Harness(unittest.TestCase):
    """leads-dashboard (live steps, first in config.toml) and game-backdrop (a ready issue)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.state = os.path.join(self.dir, 'state')
        os.makedirs(self.state)
        self.repos = [Repo(name=LD, github=f'owner/{LD}', path=os.path.join(self.dir, LD),
                           live_doc='docs/agents/lovable-cloud.md', merge='stefan'),
                      Repo(name=GB, github=f'owner/{GB}', path=os.path.join(self.dir, GB))]
        self.config = Config(repos=list(self.repos), state_dir=self.state,
                             log_dir=os.path.join(self.dir, 'logs'))
        self.jobs = JobLog(os.path.join(self.state, 'jobs.jsonl'))
        self.gh = PerRepoGitHub(issues={GB: [issue(5, 'Backdrop', 'Draw it.')]})
        self.git = FakeLiveGit(base=A)
        self.lines = []

    def put(self, data):
        with open(os.path.join(self.state, 'control.json'), 'w', encoding='utf-8') as f:
            f.write(data if isinstance(data, str) else json.dumps(data))

    def merged_since_live(self):
        """leads-dashboard's live steps are due: its base moved from A (live) to B, PR #209."""
        job = self.jobs.started(kind='live', repo=LD, issue=200, branch='main',
                                title=f'Queue runner live: {LD}', sha=A, head=A)
        self.jobs.ended(job.id, exit_code=None, outcome='assumed')
        self.git.base = B
        self.git.ancestors.add((A, B))
        self.git.logs[(A, B)] = [{'sha': '1' * 40,
                                  'subject': 'Merge pull request #209 from owner/claude/x-1'}]
        self.git.changes[(A, B)] = [('A', M1)]

    def runner(self, t3=None, sol=None):
        from tests.fakes_t3 import FakeT3
        self.t3 = t3 or FakeT3([(0, 'completed')] * 4)
        return Runner(self.config, github=self.gh, t3=self.t3, git=self.git,
                      out=io.StringIO(), log_line=self.lines.append, sol=sol, now=lambda: NOW)

    def run_loop(self, runner):
        """The run loop until its first idle pass."""
        def sleep(s):
            raise Done
        with self.assertRaises(Done):
            runner.run_forever(sleep)

    def titles(self):
        return [s['title'] for s in self.t3.starts]


class FirstRunTest(Harness):
    """Stefan's first real run: game-backdrop first, leads-dashboard served but stopped."""

    def test_with_leads_dashboard_stopped_the_first_job_is_game_backdrops_build(self):
        self.merged_since_live()
        self.put(control([GB, LD], lanes={'claude': None}, **{LD: 'after-job'}))
        self.run_loop(self.runner())
        self.assertEqual(self.titles()[:1], [f'Queue runner build: {GB}#5'])
        self.assertNotIn(f'Queue runner live: {LD}', self.titles())
        self.assertEqual([j.kind for j in self.jobs.jobs() if j.repo == LD], ['live'])

    def test_without_the_stop_its_live_steps_would_come_first(self):
        self.merged_since_live()
        self.put(control([GB, LD], lanes={'claude': None}))
        runner = self.runner()
        runner.take_order()
        kind, _, _ = runner.choose()
        self.assertEqual(kind, 'live')


class ClaudeLaneTest(Harness):
    """game-backdrop first and stopped, with work of each kind; leads-dashboard has a ready
    issue. Without the stop the lane would take game-backdrop's work (the control); with it, it
    builds leads-dashboard's issue."""

    def setUp(self):
        super().setUp()
        self.gh.by_repo_issues = {GB: [], LD: [issue(3, 'Leads', 'List them.')]}
        self.gh.issues = [issue(3, 'Leads', 'List them.'), issue(5, 'Backdrop', 'Draw it.')]
        self.gh.states.update({3: 'open', 5: 'open'})

    def ready_issue(self):
        self.gh.by_repo_issues[GB] = [issue(5, 'Backdrop', 'Draw it.')]

    def conflicted_pr(self):
        from tests.fakes import full_pr
        self.gh.by_repo_prs[GB] = [full_pr(30, 'claude/backdrop-5', 'c' * 40)]
        self.gh.conflicts.add(30)
        self.git.heads = {30: 'c' * 40}

    def failed_build(self):
        job = self.jobs.started(kind='build', repo=GB, issue=5, branch='claude/backdrop-5',
                                title=f'Queue runner build: {GB}#5')
        self.jobs.ended(job.id, exit_code=1, outcome='failed', thread_id='mcp:gb5',
                        link='https://t3/gb5')

    def limited_build(self):
        job = self.jobs.started(kind='build', repo=GB, issue=5, branch='claude/backdrop-5',
                                title=f'Queue runner build: {GB}#5')
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit', thread_id='mcp:gb5',
                        resume_at=(NOW - datetime.timedelta(hours=1)).isoformat(), context=1000)

    def kinds(self):
        return (('a ready issue', self.ready_issue, 'build'),
                ('a conflicted PR', self.conflicted_pr, 'fix'),
                ('a failed build', self.failed_build, 'decision'),
                ('a build a usage limit cut off', self.limited_build, 'build'))

    def test_a_stopped_repos_work_is_left_for_the_next_repos(self):
        for what, make, kind in self.kinds():
            with self.subTest(what):
                self.setUp()
                make()
                self.put(control([GB, LD]))
                runner = self.runner()
                runner.take_order()
                self.assertEqual(runner.choose()[0], kind)   # the control: GB's work is due
                self.put(control([GB, LD], **{GB: 'after-job'}))
                runner = self.runner()
                runner.run_pass()
                self.assertEqual(self.titles()[:1], [f'Queue runner build: {LD}#3'])
                self.assertEqual(self.t3.sends, [])


class SolLaneTest(Harness):
    """game-backdrop first: PR #30 due for review and #31 with a failed check (a stop);
    leads-dashboard's PR #40 due for review."""

    def setUp(self):
        super().setUp()
        from dataclasses import replace
        from queue_runner.github import Checks
        from tests.fakes import full_pr
        self.config = replace(self.config, runs_dir=os.path.join(self.dir, 'runs'),
                              checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.gh.by_repo_prs = {GB: [full_pr(30, 'claude/a-1', '3' * 40),
                                    full_pr(31, 'claude/b-2', '4' * 40)],
                               LD: [full_pr(40, 'claude/c-3', '5' * 40)]}
        self.gh.check_states['4' * 40] = Checks('failed', failed=('ci',))
        self.git.heads = {30: '3' * 40, 31: '4' * 40, 40: '5' * 40}

    def sol_pass(self, *replies):
        from tests.fakes_t3 import FakeSol
        from tests.test_ledger import reply
        runner = self.runner(sol=FakeSol(list(replies) or [reply()]))
        runner._sol_pass()
        return runner

    def reviewed(self):
        return [(j.repo, j.issue) for j in self.jobs.jobs() if j.kind == 'review']

    def stops(self):
        return [(j.repo, j.issue, j.stop) for j in self.jobs.jobs() if j.kind == 'stop']

    def test_without_the_stop_it_reviews_stops_and_merges_game_backdrops_prs(self):   # control
        self.put(control([GB, LD]))
        self.sol_pass()
        self.assertEqual(self.reviewed(), [(GB, 30)])
        self.assertIn((GB, 31, 'failed-check'), self.stops())
        self.assertEqual([p[1] for p in self.gh.posts if p[0] == 'merge'], [30])

    def test_a_stopped_repo_gets_no_stop_merge_ready_mark_or_review(self):
        self.put(control([GB, LD], **{GB: 'after-job'}))
        self.sol_pass()
        self.assertNotIn(GB, self.gh.read)
        self.assertEqual(self.reviewed(), [(LD, 40)])
        self.assertEqual(self.stops(), [])
        self.assertEqual([p for p in self.gh.posts if p[0] == 'merge'], [])

    def test_a_review_running_when_its_repo_is_stopped_finishes_and_merges_nothing(self):
        from tests.fakes_t3 import FakeSol
        from tests.test_ledger import reply
        test = self
        self.put(control([GB, LD]))

        class StoppedMidReview(FakeSol):
            def review(self, *args, **kwargs):
                test.put(control([GB, LD], **{GB: 'after-job'}))   # Stefan stops it
                return super().review(*args, **kwargs)
        runner = self.runner(sol=StoppedMidReview([reply()]))
        runner._sol_pass()
        [review] = [j for j in self.jobs.jobs() if j.kind == 'review']
        self.assertEqual((review.repo, review.issue, review.outcome), (GB, 30, 'clean'))
        self.assertEqual([p for p in self.gh.posts if p[0] == 'merge'], [])
        runner._sol_pass()   # the next pass leaves game-backdrop alone
        self.assertEqual([p for p in self.gh.posts if p[0] == 'merge'], [])
        self.assertEqual(self.reviewed(), [(GB, 30), (LD, 40)])


class PageControlTest(unittest.TestCase):
    """`POST /control` takes `{"repo", "stop"}` (`dashboard/serve.py`, `apply_control`)."""

    def test_a_repo_is_stopped_and_resumed_and_the_rest_is_kept(self):
        from dashboard.serve import apply_control
        c = apply_control({}, {'lane': 'claude', 'stop': 'after-job'}, WRITTEN)
        c = apply_control(c, {'repo_order': [GB, LD]}, WRITTEN)
        c = apply_control(c, {'repo': LD, 'stop': 'after-job'}, '2026-11-15T20:00:00+08:00')
        self.assertEqual(c['repos'], {LD: {'stop': 'after-job', 'at': '2026-11-15T20:00:00+08:00'}})
        self.assertEqual((c['lanes']['claude']['stop'], c['repo_order']), ('after-job', [GB, LD]))
        self.assertEqual(c['written_at'], '2026-11-15T20:00:00+08:00')
        c = apply_control(c, {'repo': LD, 'stop': None}, WRITTEN)
        self.assertEqual(c['repos'][LD], {'stop': None, 'at': WRITTEN})
        c = apply_control(c, {'lane': 'sol', 'stop': 'now'}, WRITTEN)
        self.assertEqual(c['repos'][LD], {'stop': None, 'at': WRITTEN})   # a lane's keeps it

    def test_stop_now_stays_a_lanes_and_a_bad_name_is_refused(self):
        from dashboard.serve import Refused, apply_control
        for body in ({'repo': LD, 'stop': 'now'}, {'repo': LD, 'stop': 'maybe'},
                     {'repo': '../x', 'stop': 'after-job'}, {'repo': 3, 'stop': None},
                     {'repo': LD}, {'repo': LD, 'lane': 'claude', 'stop': None}):
            with self.subTest(body=body), self.assertRaises(Refused):
                apply_control({}, body, WRITTEN)


class CliControlTest(unittest.TestCase):
    """`--pause NAME` and `--resume NAME` write the same file as the page."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name.replace('\\', '/')
        self.config = os.path.join(self.dir, 'config.toml')
        with open(self.config, 'w', encoding='utf-8') as f:
            f.write(f'state_dir = "{self.dir}/state"\nlog_dir = "{self.dir}/logs"\n' + ''.join(
                f'\n[[repos]]\nname = "{n}"\ngithub = "owner/{n}"\npath = "{self.dir}/{n}"\n'
                for n in (LD, GB)))
        self.state = os.path.join(self.dir, 'state')

    def main(self, *args):
        from queue_runner.cli import main
        out = io.StringIO()
        code = main([*args, '--config', self.config], out=out)
        return code, out.getvalue()

    def read(self):
        with open(os.path.join(self.state, 'control.json'), encoding='utf-8') as f:
            return json.load(f)

    def test_pause_and_resume_a_repo_by_name(self):
        code, out = self.main('--pause', LD)
        self.assertEqual(code, 0)
        self.assertEqual(self.read()['repos'][LD]['stop'], 'after-job')
        self.assertIn(f'{LD} is stopped by Stefan: neither lane takes up its work', out)
        self.assertIn(f'--resume {LD}', out)
        self.assertEqual(self.read()['lanes'], {})   # the lanes carry on
        code, out = self.main('--resume', LD)
        self.assertEqual((code, self.read()['repos'][LD]['stop']), (0, None))
        self.assertIn(f'{LD} runs again', out)

    def test_a_lanes_id_and_all_keep_their_meaning(self):
        self.main('--pause')
        self.main('--pause', 'sol')
        self.assertEqual({k: v['stop'] for k, v in self.read()['lanes'].items()},
                         {'claude': 'after-job', 'sol': 'after-job'})
        self.assertEqual(self.read().get('repos'), {})
        self.main('--resume', 'all')
        self.assertEqual({k: v['stop'] for k, v in self.read()['lanes'].items()},
                         {'claude': None, 'sol': None})

    def test_a_name_that_isnt_a_lane_or_served_repo_is_refused(self):
        code, out = self.main('--pause', 'somebody')
        self.assertEqual(code, 2)
        self.assertIn(f'claude, sol, all, {LD} or {GB}', out)
        self.assertFalse(os.path.exists(os.path.join(self.state, 'control.json')))

    def test_both_writers_write_the_same_file(self):
        from dashboard import serve
        from queue_runner import control as ctl
        at = '2026-11-15T20:01:02+08:00'
        before = control([GB, LD], lanes={'sol': 'after-job'}, **{GB: 'after-job'})
        for name, stop in ((LD, 'after-job'), (GB, None)):
            with self.subTest(name=name, stop=stop), tempfile.TemporaryDirectory() as page, \
                    tempfile.TemporaryDirectory() as cli:
                for d in (page, cli):
                    with open(os.path.join(d, 'control.json'), 'w', encoding='utf-8') as f:
                        json.dump(before, f)
                serve.App(page, clock=lambda: at).write_control({'repo': name, 'stop': stop})
                ctl.ask(cli, [], stop, at, repos=[name])
                with open(os.path.join(page, 'control.json'), encoding='utf-8') as f, \
                        open(os.path.join(cli, 'control.json'), encoding='utf-8') as g:
                    by_page, by_cli = json.load(f), json.load(g)
                self.assertEqual(by_cli, by_page)
                self.assertEqual(by_cli['repos'][name], {'stop': stop, 'at': at})
                self.assertEqual(ctl.read(cli).repo_stop(name).asked, stop)


class UnreadableTest(Harness):
    def test_a_repo_entry_the_page_couldnt_write_starts_nothing_in_either_lane(self):
        for bad in ({LD: {'stop': 'now'}}, {LD: 'after-job'}, ['x']):
            with self.subTest(bad=bad):
                self.put(dict(control([GB, LD]), repos=bad))
                runner = self.runner()
                self.assertEqual(runner.run_pass(), 'stopped')
                self.assertEqual(self.t3.starts, [])
                self.assertIn('control.json is unreadable', self.lines[-1])


class Wakes:
    def __init__(self):
        self.synced = []

    def sync(self, times):
        self.synced.append(sorted(times))


class SaysTest(Harness):
    """The log, the wake tasks and the Inbox."""

    def test_the_log_says_a_stop_and_a_resume_once_each(self):
        self.put(control([GB, LD], **{GB: 'after-job'}))
        runner = self.runner()
        runner.run_pass()
        runner.run_pass()
        said = [l for l in self.lines if l.startswith(f'{GB} is stopped by Stefan')]
        self.assertEqual(len(said), 1, self.lines)
        self.assertIn(f'--resume {GB}', said[0])
        self.put(control([GB, LD], **{GB: None}))
        runner.run_pass()
        runner.run_pass()
        self.assertEqual(self.lines.count(f'{GB} runs again: Stefan resumed it'), 1)

    def test_a_name_that_isnt_served_is_ignored_and_said_once(self):
        self.put(control([GB, LD], **{'old-repo': 'after-job'}))
        runner = self.runner()
        runner.run_pass()
        runner.run_pass()
        self.assertEqual(self.lines.count(
            'control.json stops old-repo, which is not served: ignored'), 1, self.lines)
        self.assertEqual(self.titles()[:1], [f'Queue runner build: {GB}#5'])   # both carry on

    def test_a_stopped_repos_wait_sets_no_wake_task(self):
        resume = NOW + datetime.timedelta(hours=2)
        job = self.jobs.started(kind='build', repo=GB, issue=5, branch='claude/backdrop-5',
                                title=f'Queue runner build: {GB}#5')
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit', thread_id='mcp:gb5',
                        resume_at=resume.isoformat(), context=1000)
        self.gh.by_repo_issues[GB] = []

        def wakes():
            waker = Wakes()
            runner = self.runner()
            runner.waker = waker
            self.run_loop(runner)
            return {t for times in waker.synced for t in times}
        self.put(control([GB, LD]))
        self.assertEqual(wakes(), {resume})   # the control: the limit's resume wakes the PC
        self.put(control([GB, LD], **{GB: 'after-job'}))
        self.assertEqual(wakes(), set())

    def test_a_stopped_repos_asks_stay_in_the_inbox(self):
        from queue_runner.inbox import collect
        from tests.fakes import full_pr
        self.gh.by_repo_prs[GB] = [full_pr(30, 'claude/a-1', '3' * 40)]
        stop = self.jobs.started(kind='stop', repo=GB, issue=30, branch='claude/a-1',
                                 title='stop', sha='3' * 40, stop='failed-check')
        self.jobs.ended(stop.id, exit_code=None, outcome='filed',
                        link=f'https://github.com/owner/{GB}/issues/901')
        self.put(control([GB, LD], **{GB: 'after-job'}))
        runner = self.runner()
        runner.run_pass()   # takes the stop up
        self.assertEqual([(w.repo, w.number) for w in collect(self.config, self.gh, self.jobs).items],
                         [(GB, 30)])


class SnapshotTest(Harness):
    def snapshot(self):
        from queue_runner import snapshot
        return snapshot.Snapshots(self.config, calls=snapshot.Calls(lambda: NOW),
                                  clock=lambda: NOW, info=snapshot.RunnerInfo(1, NOW, None),
                                  claude=None, sol=None).build()

    def test_a_stopped_repo_carries_stopped_with_when_and_control_read_at_moves(self):
        snap = self.snapshot()
        self.assertEqual([r['stopped'] for r in snap['repos']], [None, None])
        self.put(control([GB, LD], **{LD: 'after-job'}))
        snap = self.snapshot()
        stopped = {r['name']: r['stopped'] for r in snap['repos']}
        self.assertIsNone(stopped[GB])
        self.assertEqual(datetime.datetime.fromisoformat(stopped[LD]['at']),
                         datetime.datetime.fromisoformat(WRITTEN))
        self.assertEqual(snap['control_read_at'], WRITTEN)
        later = dict(control([GB, LD], **{LD: None}), written_at='2026-11-15T20:05:00+08:00')
        self.put(later)
        snap = self.snapshot()
        self.assertEqual([r['stopped'] for r in snap['repos']], [None, None])
        self.assertEqual(snap['control_read_at'], '2026-11-15T20:05:00+08:00')

    def test_its_repo_holds_the_samples_keys(self):
        from dashboard import sample
        [want] = {frozenset(r) for r in sample.build('repo-stopped')['repos']}
        self.assertEqual(set(self.snapshot()['repos'][0]), set(want))


class CliSaysTest(Harness):
    """`--gate` and `--once --dry-run` through `main`."""

    def setUp(self):
        super().setUp()
        d = self.dir.replace('\\', '/')
        self.toml = os.path.join(self.dir, 'config.toml')
        with open(self.toml, 'w', encoding='utf-8') as f:
            f.write(f'state_dir = "{d}/state"\nlog_dir = "{d}/logs"\n'
                    f'\n[[repos]]\nname = "{LD}"\ngithub = "owner/{LD}"\npath = "{d}/{LD}"\n'
                    f'live_doc = "docs/agents/lovable-cloud.md"\nmerge = "stefan"\n'
                    f'\n[[repos]]\nname = "{GB}"\ngithub = "owner/{GB}"\npath = "{d}/{GB}"\n')

    def main(self, *args):
        from queue_runner.cli import main
        from queue_runner.usage import Usage, Window
        from tests.fakes import FakeUsage
        from tests.fakes_t3 import FakeT3
        self.t3 = FakeT3()
        out = io.StringIO()
        main([*args, '--config', self.toml], github=self.gh, git=self.git, t3=self.t3, out=out,
             usage=FakeUsage(Usage(Window(0, None), Window(0, None))), clock=lambda: NOW)
        return out.getvalue()

    def test_gate_says_which_repos_are_stopped(self):
        self.put(control([GB, LD], **{LD: 'after-job', 'old-repo': 'after-job'}))
        out = self.main('--gate')
        self.assertIn(f'{LD} is stopped by Stefan: neither lane takes up its work', out)
        self.assertIn('control.json stops old-repo, which is not served: ignored', out)
        self.assertNotIn(f'{GB} is stopped', out)

    def test_the_dry_run_says_so_and_would_build_game_backdrop_not_go_live(self):
        self.merged_since_live()
        self.put(control([GB, LD], **{LD: 'after-job'}))
        out = self.main('--once', '--dry-run')
        self.assertIn(f'dry run: {LD} is stopped by Stefan: neither lane takes up its work', out)
        self.assertNotIn('Would start the live steps', out)
        self.assertIn(f'issue:  #5 Backdrop', out)
        self.assertEqual(self.t3.starts, [])

    def test_without_the_stop_the_dry_run_would_go_live(self):   # the control
        self.merged_since_live()
        self.put(control([GB, LD]))
        self.assertIn(f'Would start the live steps on {LD}', self.main('--once', '--dry-run'))


class SampleTest(unittest.TestCase):
    """The sample shows one stopped repo in a state of its own, and plays the runner taking a
    repo's stop up."""

    def test_the_repo_stopped_state_stops_leads_dashboard_and_its_work_leaves_the_queues(self):
        from dashboard import sample
        snap = sample.build('repo-stopped')
        stopped = {r['name']: r['stopped'] for r in snap['repos']}
        self.assertIsNone(stopped[sample.QR])
        self.assertIn('at', stopped[sample.LD])
        queued = [q['repo'] for lane in snap['lanes'] for q in lane['queue']]
        self.assertTrue(queued)
        self.assertNotIn(sample.LD, queued)
        self.assertFalse([i for i in snap['issues'] if i['repo'] == sample.LD and i['pick']])
        self.assertTrue([a for a in snap['asks'] if a['repo'] == sample.LD])   # asks stay
        self.assertEqual(sample._lane(snap, 'claude')['job']['repo'], sample.LD)   # it finishes

    def test_no_other_state_has_a_stopped_repo(self):
        from dashboard import sample
        for name in set(sample.STATES) - {'repo-stopped'}:
            with self.subTest(name):
                self.assertEqual([r['stopped'] for r in sample.build(name)['repos']],
                                 [None, None])

    def test_the_pretend_runner_takes_a_repo_stop_up_once_it_has_read_control_json(self):
        from dashboard import sample
        now = datetime.datetime(2026, 11, 15, 20, 0, 10, tzinfo=UTC)
        c = {'version': 1, 'written_at': '2026-11-15T20:00:00+00:00', 'lanes': {},
             'repo_order': [], 'repos': {sample.LD: {'stop': 'after-job',
                                                     'at': '2026-11-15T20:00:00+00:00'}}}
        snap = sample.build('busy', control=c, now=now)
        self.assertEqual({r['name']: r['stopped'] for r in snap['repos']},
                         {sample.LD: {'at': '2026-11-15T20:00:00+00:00'}, sample.QR: None})
        early = sample.build('busy', control=c, now=now - datetime.timedelta(seconds=9))
        self.assertEqual([r['stopped'] for r in early['repos']], [None, None])


if __name__ == '__main__':
    unittest.main()
