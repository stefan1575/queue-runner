"""A repo that runs as a train (#179): one PR at a time, lowest number first; no build while a PR
is open or the last merge's live steps aren't done; a stop on the front PR pauses the repo; a
front PR stacked on a merged branch is retargeted to the repo's base first. GitHub, T3, git and
Sol faked; the repos are the test's own, never config.toml's (#172)."""
import datetime
import io
import os
import tempfile
import unittest
from dataclasses import replace

from queue_runner import inbox, snapshot, train, work
from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Issue
from queue_runner.run import Runner
from queue_runner.state import USAGE_LIMIT, JobLog
from tests.fakes import FakeGitHubForReviews, full_pr, issue
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import reply
from tests.test_live import FakeLiveGit

H20, H21, H22 = '2' * 40, '3' * 40, '4' * 40
A, B = 'a' * 40, 'b' * 40
NOW = datetime.datetime(2026, 11, 19, 12, 0, tzinfo=datetime.timezone.utc)


class TrainTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github='owner/first', path=self.dir, train=True)
        self.gh = FakeGitHubForReviews(
            issues=[issue(30, 'Next ticket')],
            prs=[full_pr(20, 'claude/red-5', H20, title='Red widget'),
                 full_pr(21, 'claude/blue-6', H21, title='Blue widget')],
            comments={20: [], 21: [], 30: []},
            issue_bodies={('owner/first', 30): Issue(30, 'Next ticket', '')})
        self.git = FakeReviewGit(heads={20: H20, 21: H21})
        self.out = io.StringIO()

    def config(self, repo=None):
        return Config(repos=[repo or self.repo], state_dir=os.path.join(self.dir, 'state'),
                      log_dir=os.path.join(self.dir, 'logs'),
                      runs_dir=os.path.join(self.dir, 'runs'),
                      checkouts_dir=os.path.join(self.dir, 'checkouts'))

    def runner(self, repo=None, outcomes=((0, 'completed'),), replies=(), git=None, now=None):
        self.t3 = FakeT3(list(outcomes))
        self.sol = FakeSol(list(replies))
        return Runner(self.config(repo), github=self.gh, t3=self.t3, git=git or self.git,
                      out=self.out, log_line=lambda line: None, sol=self.sol, now=now)

    def kinds(self, r, kind):
        return [j for j in r.jobs.jobs() if j.kind == kind]

    # --- one PR at a time ---------------------------------------------------------------------

    def test_two_open_prs_only_the_lower_one_gets_a_round_and_no_build_starts(self):
        self.gh.conflicts = {20, 21}
        r = self.runner()
        self.assertEqual(r.run_pass(), 'started')
        self.assertEqual([s['title'] for s in self.t3.starts], ['Queue runner conflict: first#20'])
        self.assertEqual(self.kinds(r, 'build'), [])
        whys = {pr.number: why for pr, _, why in r.fixer.candidates(self.repo)}
        self.assertEqual(whys[21], 'the train moves one PR at a time: it waits behind #20')

    def test_with_nothing_to_fix_the_pass_starts_no_build_while_a_pr_is_open(self):
        r = self.runner()
        self.assertEqual(r.run_pass(), 'idle')
        self.assertEqual(self.t3.starts, [])
        self.assertIn('first: no build starts: the train has #20 open and 1 more',
                      self.out.getvalue())

    def test_only_the_front_pr_is_reviewed_and_merged_then_the_next_moves_up(self):
        r = self.runner(replies=[reply(), reply()])
        self.assertEqual(r.reviewer.review_pass(), 'started')
        [review] = self.kinds(r, 'review')
        self.assertEqual((review.issue, review.outcome), (20, 'clean'))
        self.assertEqual([p for p in self.gh.posts if p[0] == 'merge'], [('merge', 20, H20)])
        self.assertEqual(r.reviewer.review_pass(), 'started')   # #21 is the front now
        self.assertEqual([j.issue for j in self.kinds(r, 'review')], [20, 21])

    def test_a_pr_behind_the_front_gets_no_review_stop_or_merge(self):
        self.gh.check_states[H21] = Checks('failed', failed=('ci',))
        self.gh.check_states[H20] = Checks('pending', pending=('ci',))
        r = self.runner()
        self.assertEqual(r.reviewer.review_pass(), 'idle')
        self.assertEqual(self.kinds(r, 'stop'), [])   # #21's failed check is left as it is
        self.assertEqual(r.reviewer.why_not(self.repo, self.gh.pull(self.repo, 21)),
                         'the train moves one PR at a time: it waits behind #20')
        steps = dict(r.reviewer.merger.steps(self.repo, 21, H21))
        self.assertEqual(steps['First in the train'],
                         'the train moves one PR at a time: it waits behind #20')

    def test_a_pr_opened_by_hand_counts_in_the_train(self):
        self.gh.prs.insert(0, full_pr(19, 'stefan/by-hand', H22, title='By hand'))
        self.git.heads[19] = H22
        r = self.runner(replies=[reply()])
        self.gh.check_states[H22] = Checks('pending', pending=('ci',))
        self.assertEqual(r.reviewer.review_pass(), 'idle')   # #19's checks run: none reviewed
        self.assertEqual(self.sol.briefs, [])

    # --- no build ahead of the train ----------------------------------------------------------

    def live_repo(self):
        repo = replace(self.repo, live_doc='docs/live.md')
        git = FakeLiveGit(base=B)
        git.logs[(A, B)] = [{'sha': B, 'subject': 'Merge pull request #20 from owner/claude/red-5'}]
        git.ancestors.add((A, B))
        jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        first = jobs.started(kind='live', repo='first', issue=None, branch='main',
                             title='Queue runner live: first', sha=A, head=A)
        jobs.ended(first.id, exit_code=None, outcome='assumed')
        return repo, git, jobs

    def test_no_build_while_the_last_merges_live_steps_are_pending_then_one_once_done(self):
        self.gh.prs = []
        repo, git, jobs = self.live_repo()
        # The live run for #20 was cut off by a usage limit, and may not run again yet.
        run = jobs.started(kind='live', repo='first', issue=20, branch='main',
                           title='Queue runner live: first', sha=A, head=B)
        jobs.ended(run.id, exit_code=None, outcome=USAGE_LIMIT,
                   resume_at=(NOW + datetime.timedelta(hours=2)).isoformat())
        r = self.runner(repo=repo, git=git, now=lambda: NOW)
        self.assertEqual(r.run_pass(), 'idle')
        self.assertEqual(self.t3.starts, [])
        self.assertIn('first: no build starts: the live steps of #20 are not done',
                      self.out.getvalue())
        done = jobs.started(kind='live', repo='first', issue=20, branch='main',
                            title='Queue runner live: first', sha=A, head=B)
        jobs.ended(done.id, exit_code=None, outcome='live')
        self.assertEqual(r.run_pass(), 'started')
        [build] = self.kinds(r, 'build')
        self.assertEqual(build.issue, 30)

    def test_no_build_beside_a_build_still_on_its_way_to_a_pr(self):
        jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        b = jobs.started(kind='build', repo='first', issue=29, branch='claude/x-29', title='b')
        jobs.ended(b.id, exit_code=2, outcome='waiting', thread_id='mcp:t9')
        self.assertEqual(train.build_hold(self.repo, [], jobs),
                         'build #29 is still on its way to a PR (waiting): no build starts '
                         'beside it')
        self.assertIsNone(train.build_hold(replace(self.repo, train=False), [], jobs))

    # --- a stop pauses the train --------------------------------------------------------------

    def test_a_stop_on_the_front_pr_pauses_the_repo_and_says_so_everywhere(self):
        self.gh.check_states[H20] = Checks('failed', failed=('ci',))
        self.gh.check_states[H21] = Checks('failed', failed=('ci',))
        r = self.runner()
        r.reviewer.review_pass()
        [stop] = self.kinds(r, 'stop')
        self.assertEqual((stop.issue, stop.stop, stop.outcome), (20, 'failed-check', 'filed'))
        self.gh.conflicts = {21}   # behind it: no conflict round either
        self.assertEqual(r.run_pass(), 'idle')
        self.assertEqual(self.t3.starts, [])
        self.assertIn('first: no build starts: the train is paused on #20 (stopped for Stefan',
                      self.out.getvalue())
        # --inbox
        said = inbox.report(self.config(), self.gh, r.jobs)
        self.assertIn('Trains paused:\n  first: paused on PR #20 (stopped for Stefan', said)
        # the dashboard: the repo's row, and each PR's status
        read = work.read_repo(self.config(), self.gh, self.git, r.jobs, self.repo)
        self.assertEqual(read.train[0], 20)
        self.assertIn('stopped for Stefan', read.train[1])
        [row] = snapshot._repos(snapshot.Facts(now=NOW, repos=[self.repo],
                                               work={'first': read}))
        self.assertEqual(row['train']['front'], 'PR #20')
        self.assertIn('Stopped for Stefan', row['train']['paused'])
        view = work.View(reads={'first': read}, jobs=r.jobs.jobs(), repos=[self.repo])
        prs = {p['n']: p for p in work.lists(view)['prs']}
        self.assertEqual(prs[21]['status'], 'Waiting in the train')
        self.assertIn('The train is paused on it', prs[20]['next'])

    def test_once_stefan_answers_the_stop_the_train_moves_again(self):
        self.gh.check_states[H20] = Checks('failed', failed=('ci',))
        r = self.runner()
        r.reviewer.review_pass()
        [stop] = self.kinds(r, 'stop')
        self.gh.check_states[H20] = Checks('passed')
        r.jobs.released('first', 20)
        self.assertIsNone(train.paused(r.jobs, self.repo, self.gh.open_pulls(self.repo)))
        self.assertNotIn('Trains paused', inbox.report(self.config(), self.gh, r.jobs))

    # --- stacked PRs rejoin the base ----------------------------------------------------------

    def stacked(self):
        self.gh.prs[0] = full_pr(20, 'claude/red-5', H20, title='Red widget', base='claude/a-19')
        self.gh.branch_names = ['claude/a-19']
        self.gh.pulls_by_branch = {'claude/a-19': {'number': 19, 'url': '', 'state': 'merged'}}

    def test_a_front_pr_whose_base_merged_is_retargeted_then_gets_its_conflict_round(self):
        self.stacked()
        self.gh.conflicts = {20}
        r = self.runner()
        self.assertEqual(r.run_pass(), 'idle')   # no round on the merged base: retarget first
        self.assertEqual(self.t3.starts, [])
        whys = {pr.number: why for pr, _, why in r.fixer.candidates(self.repo)}
        self.assertEqual(whys[20], 'its base claude/a-19 merged in #19: it is retargeted to '
                                   'main first')
        self.assertEqual(r.reviewer.review_pass(), 'idle')   # conflicted: the round comes next
        self.assertIn(('retarget', 20, 'main'), self.gh.posts)
        self.assertIn('train first#20: its base claude/a-19 merged in #19; retargeted from '
                      'claude/a-19 to main', self.out.getvalue())
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual(start['title'], 'Queue runner conflict: first#20')
        self.assertIn('git merge origin/main', start['message'])

    def test_a_front_pr_whose_base_is_gone_is_retargeted_then_reviewed(self):
        self.stacked()
        self.gh.branch_names, self.gh.pulls_by_branch = [], {}
        r = self.runner(replies=[reply()])
        self.assertEqual(r.reviewer.review_pass(), 'started')
        self.assertEqual(self.gh.posts[0], ('retarget', 20, 'main'))
        [review] = self.kinds(r, 'review')
        self.assertEqual((review.issue, review.sha), (20, H20))

    def test_a_stacked_pr_whose_base_is_still_open_stays_on_it(self):
        self.stacked()
        self.gh.pulls_by_branch = {'claude/a-19': {'number': 19, 'url': '', 'state': 'open'}}
        self.assertIsNone(train.stale_base(self.gh, self.repo, self.gh.prs[0]))

    # --- other repos are unchanged ------------------------------------------------------------

    def test_without_train_a_repo_builds_beside_its_open_prs(self):
        r = self.runner(repo=replace(self.repo, train=False))
        self.assertEqual(r.run_pass(), 'started')
        [build] = self.kinds(r, 'build')
        self.assertEqual(build.issue, 30)

    def test_without_train_a_stacked_pr_is_not_retargeted(self):
        self.stacked()
        r = self.runner(repo=replace(self.repo, train=False), replies=[reply(), reply()])
        r.reviewer.review_pass()
        self.assertNotIn('retarget', [p[0] for p in self.gh.posts])


class TrainRowTest(unittest.TestCase):
    """The Repositories card's row for a train repo (dashboard/index.html's repoRows(), run in
    node as tests/test_repo_rows.py runs it)."""

    def row(self, train_):
        import json
        import re
        import subprocess
        from tests.test_repo_rows import NODE, source
        if not NODE:
            self.skipTest("node isn't on PATH")
        snap = {'repos': [{'name': 'first', 'github': None, 'icon': None, 'merge': 'runner',
                           'stopped': None, 'doing': None, 'wait': None, 'train': train_}]}
        script = ("const esc = (s) => String(s);\nconst clock = (s) => s;\n"
                  "const ago = (s) => s;\nconst frozen = () => false;\n"
                  "const wasRead = () => true;\nconst ctl = {};\n"
                  "const ICON = {play: '', pause: ''};\n"
                  + f'const snap = {json.dumps(snap)};\n'
                  + source(r'^const KIND = \{\n.*?^\};\n', 'KIND')
                  + source(r'^const kind = .*?;\n', 'kind')
                  + source(r'^function repoLogo\(name\) \{\n.*?^\}\n', 'repoLogo()')
                  + source(r'^function repoRows\(\) \{\n.*?^\}\n', 'repoRows()')
                  + 'process.stdout.write(repoRows());\n')
        done = subprocess.run([NODE, '-'], input=script, capture_output=True, text=True,
                              encoding='utf-8', timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout, re.search(r'<span class="name">first<span>(.*?)</span>',
                                      done.stdout)[1]

    def test_a_paused_train_says_on_which_pr_and_why(self):
        html, sub = self.row({'front': 'PR #20', 'paused': 'Stopped for Stefan (a check failed).'})
        self.assertEqual(sub, 'Train paused on PR #20. The runner merges.')
        self.assertIn('title="Stopped for Stefan (a check failed)."', html)

    def test_a_moving_train_names_its_front_pr(self):
        _, sub = self.row({'front': 'PR #20', 'paused': None})
        self.assertEqual(sub, 'Idle. One PR at a time: PR #20 moves. The runner merges.')


class ConfigTest(unittest.TestCase):
    def test_train_is_read_per_repo_and_off_unless_set(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'config.toml')
            with open(path, 'w', encoding='utf-8') as f:
                f.write('state_dir = "s"\nlog_dir = "l"\n'
                        '[[repos]]\nname = "a"\npath = "a"\ntrain = true\n'
                        '[[repos]]\nname = "b"\npath = "b"\n')
            from queue_runner.config import load_config
            a, b = load_config(path).repos
        self.assertEqual((a.train, b.train), (True, False))


if __name__ == '__main__':
    unittest.main()
