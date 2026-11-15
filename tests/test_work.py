"""The snapshot's work lists (ticket 32): `work.Reader` reads a fake GitHub and a temp job log the
way the lanes do, and `snapshot.build` writes the issues, features, PRs, activity and each lane's
queue from that read."""
import datetime
import json
import os
import tempfile
import unittest

from queue_runner import control, snapshot, work
from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Comment, Issue, WorkIssue
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, full_pr

H1, H2, H3, H4 = 'a' * 40, 'b' * 40, 'c' * 40, 'd' * 40
GH = 'owner/first'
UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 15, 5, 0, tzinfo=UTC)


def wi(n, title='A ticket', labels=('ready-for-agent',), parent=None, subs=(), blocked=(),
       body=''):
    return WorkIssue(number=n, title=title, body=body, labels=tuple(labels), parent=parent,
                     url=f'https://github.com/{GH}/issues/{n}', repo=GH,
                     sub_issues=tuple(WorkIssue(number=k, title=t, state=st, repo=GH)
                                      for k, t, st in subs),
                     blocked_by=tuple((GH, b, st) for b, st in blocked))


def ready(n, title='A ticket', body=''):
    return Issue(n, title, body)


class WorkCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github=GH, path=self.dir)
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'))
        self.jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.gh = FakeGitHubForReviews()
        self.gh.work_list = []

    def job(self, kind, issue, outcome, repo='first', **fields):
        start = {k: fields.pop(k) for k in ('sha', 'round', 'stop', 'about', 'question',
                                            'branch', 'cause') if k in fields}
        j = self.jobs.started(kind=kind, repo=repo, issue=issue,
                              branch=start.pop('branch', None), title=f'Queue runner {kind}',
                              **start)
        if outcome is not None:
            self.jobs.ended(j.id, exit_code=None, outcome=outcome, **fields)
        return j

    def reviewed(self, n, sha, verdict, rnd=1):
        """The runner's review of PR n on sha, in the job log and as its comment."""
        self.job('review', n, verdict, sha=sha, round=rnd, verdict=verdict)
        body = (f'## Sol review {rnd}\n\n'
                f'<!-- sol-pr-review round={rnd} verdict={verdict} sha={sha} -->')
        self.gh.comments.setdefault(n, []).append(Comment('stefan1575', '2026-11-14T10:00:00Z',
                                                          body))

    def reader(self, clock=None):
        return work.Reader(self.config, self.gh, None, self.jobs, clock=clock or (lambda: NOW))

    def snap(self, reader=None, **kw):
        if reader is None:
            reader = self.reader()
            reader.read()
        kw.setdefault('repos', self.config.repos)
        return snapshot.build(snapshot.Facts(now=NOW, jobs=self.jobs.jobs(), work=reader.last(),
                                             work_stale=reader.stale(), **kw))


def lane(snap, id):
    return next(l for l in snap['lanes'] if l['id'] == id)


def refs(queue):
    return [(q['kind'], q['ref']) for q in queue]


class QueueTest(WorkCase):
    def test_fix_rounds_then_builds_in_pick_order_and_the_prs_waiting_for_review(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3'),
                       full_pr(6, 'claude/blue-4', H2, title='Blue', body='Closes #4')]
        self.reviewed(5, H1, 'blocking')
        self.gh.issues = [ready(3), ready(4), ready(10, 'Ten'), ready(11, 'Eleven', 'Blocked by: #10'),
                          ready(12, 'Twelve')]
        self.gh.states = {10: 'open'}
        snap = self.snap()
        self.assertEqual(refs(lane(snap, 'claude')['queue']),
                         [('fix', 'PR #5'), ('build', '#10'), ('build', '#12')])
        self.assertEqual(lane(snap, 'claude')['queue'][1]['title'], 'Ten')
        self.assertEqual(refs(lane(snap, 'sol')['queue']), [('review', 'PR #6')])

    def test_the_build_order_goes_through_the_repos_and_a_stopped_repos_work_is_left_out(self):
        second = Repo(name='second', github='owner/second', path=self.dir)
        self.config = Config(repos=[self.repo, second], state_dir=self.config.state_dir,
                             log_dir=self.config.log_dir)
        self.gh.issues = [ready(10, 'Ten')]   # the fake answers every repo alike
        reader = self.reader()
        reader.read()
        snap = self.snap(reader, repos=[second, self.repo])
        self.assertEqual([(q['repo'], q['ref']) for q in lane(snap, 'claude')['queue']],
                         [('second', '#10'), ('first', '#10')])
        stopped = control.Switch(repos={'second': control.Stop('after-job', NOW, 'control')})
        snap = self.snap(reader, repos=[second, self.repo], switch=stopped)
        self.assertEqual([(q['repo'], q['ref']) for q in lane(snap, 'claude')['queue']],
                         [('first', '#10')])

    def test_a_job_a_limit_cut_off_comes_first_and_the_running_job_is_not_queued_again(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3')]
        self.gh.issues = [ready(10, 'Ten')]
        self.reviewed(5, H1, 'blocking')
        fix = self.job('fix', 5, 'usage-limit', sha=H1, round=1, branch='claude/red-3',
                       resume_at='2026-11-15T09:00:00+00:00')
        snap = self.snap(limited=[self.jobs.jobs()[-1]])
        self.assertEqual(refs(lane(snap, 'claude')['queue']), [('fix', 'PR #5'), ('build', '#10')])
        self.job('build', 10, None, branch='claude/ten-10')   # now building it
        snap = self.snap(limited=[j for j in self.jobs.jobs() if j.id == fix.id])
        self.assertEqual(refs(lane(snap, 'claude')['queue']), [('fix', 'PR #5')])

    def test_a_decision_comes_before_conflict_rounds_one_conflicted_pr_at_a_time(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3'),
                       full_pr(6, 'claude/blue-4', H2, title='Blue', body='Closes #4')]
        self.gh.conflicts = {5, 6}
        self.gh.work_list = [wi(9, 'Nine')]
        self.job('build', 9, 'failed', branch='claude/nine-9', thread_id='t-9')
        snap = self.snap()
        self.assertEqual(refs(lane(snap, 'claude')['queue']),
                         [('decision', '#9'), ('conflict', 'PR #5')])
        self.assertEqual(lane(snap, 'claude')['queue'][0]['title'], 'Nine')

    def test_live_steps_after_merges_come_before_fix_rounds_and_nothing_is_fetched(self):
        from tests.test_live import FakeLiveGit
        self.repo = Repo(name='first', github=GH, path=self.dir, live_doc='docs/live.md')
        self.config = Config(repos=[self.repo], state_dir=self.config.state_dir,
                             log_dir=self.config.log_dir)
        live = self.jobs.started(kind='live', repo='first', issue=None, branch='main',
                                 title='Queue runner live', sha=H1, head=H1)
        self.jobs.ended(live.id, exit_code=None, outcome='assumed')
        git = FakeLiveGit(base=H2, ancestors={(H1, H2)})
        git.logs[(H1, H2)] = [{'sha': '1' * 40, 'subject': 'Merge pull request #12 from o/claude/one-3'},
                              {'sha': '2' * 40, 'subject': 'Two (#13)'}]
        self.gh.prs = [full_pr(5, 'claude/red-3', H3, title='Red')]
        self.reviewed(5, H3, 'blocking')
        reader = work.Reader(self.config, self.gh, git, self.jobs, clock=lambda: NOW)
        reader.read()
        snap = self.snap(reader)
        self.assertEqual(lane(snap, 'claude')['queue'][:2], [
            {'kind': 'live', 'repo': 'first', 'ref': 'PR #13', 'title': '2 merged PRs: #12, #13'},
            {'kind': 'fix', 'repo': 'first', 'ref': 'PR #5', 'title': 'Red'}])
        self.assertEqual(git.fetches, [])


def by_n(snap):
    return {i['n']: i for i in snap['issues']}


class IssuesTest(WorkCase):
    def setUp(self):
        super().setUp()
        self.gh.work_list = [
            wi(1, 'Spec: the app', labels=('spec',),
               subs=[(2, 'Two', 'closed'), (4, 'Four', 'open'), (5, 'Five', 'open'),
                     (6, 'Six', 'open')]),
            wi(4, 'Four', parent=1, blocked=[(2, 'closed')]),
            wi(5, 'Five', parent=1, blocked=[(4, 'open')]),
            wi(6, 'Six', labels=(), parent=1),
            wi(8, 'Eight'),
            wi(10, 'PR #9 needs Stefan', labels=('needs-info',),
               body='<!-- queue-runner needs-info owner/first#9 -->'),
            wi(11, 'Eleven', body='Blocked by: #8'),
        ]
        self.gh.issues = [ready(4, 'Four'), Issue(5, 'Five', '', open_blockers=1),
                          ready(8, 'Eight'), ready(11, 'Eleven', 'Blocked by: #8')]
        self.gh.states = {8: 'open'}
        self.gh.prs = [full_pr(9, 'claude/eight-8', H1, title='Eight', body='Closes #8')]

    def test_open_issues_and_a_features_closed_ones_each_where_it_stands(self):
        got = by_n(self.snap())
        self.assertEqual(sorted(got), [2, 4, 5, 6, 8, 11])   # no spec, no needs-info issue
        self.assertEqual({n: i['state'] for n, i in got.items()},
                         {2: 'done', 4: 'ready', 5: 'blocked', 6: 'not-ready', 8: 'review',
                          11: 'blocked'})
        self.assertEqual(got[4], {'repo': 'first', 'n': 4, 'title': 'Four', 'state': 'ready',
                                  'feature': 'first#1', 'pr': None, 'blocked_by': ['first#2'],
                                  'note': None, 'pick': 1})
        self.assertEqual(got[5]['blocked_by'], ['first#4'])
        self.assertEqual(got[11]['blocked_by'], ['first#8'])
        self.assertIsNone(got[11]['feature'])
        self.assertEqual((got[8]['pr'], got[8]['pick']), (9, None))
        self.assertEqual(got[2]['feature'], 'first#1')

    def test_building_and_held_builds_say_so(self):
        self.job('build', 4, None, branch='claude/four-4')
        got = by_n(self.snap())
        self.assertEqual((got[4]['state'], got[4]['note']), ('building', 'Claude is building it'))


class FeaturesTest(IssuesTest):
    def test_a_spec_with_sub_issues_is_a_feature_its_tickets_in_the_order_theyre_built(self):
        [f] = self.snap()['features']
        self.assertEqual(f, {'id': 'first#1', 'repo': 'first', 'n': 1, 'title': 'The app',
                             'tickets': ['first#2', 'first#4', 'first#5', 'first#6']})

    def test_features_in_build_order_one_with_nothing_open_last(self):
        self.gh.work_list += [
            wi(20, 'Map: old', labels=('wayfinder:map',), subs=[(21, 'Done', 'closed')]),
            wi(30, 'Spec: soon', labels=('spec',), subs=[(3, 'Three', 'open')]),
            wi(3, 'Three', parent=30)]
        self.assertEqual([f['id'] for f in self.snap()['features']],
                         ['first#30', 'first#1', 'first#20'])


def pr_of(snap, n):
    return next(p for p in snap['prs'] if p['n'] == n)


class PrsTest(WorkCase):
    def test_a_pr_clean_on_its_head_is_ready_for_stefan_with_the_merge_rechecks_steps(self):
        self.repo = Repo(name='first', github=GH, path=self.dir, merge='stefan')
        self.config = Config(repos=[self.repo], state_dir=self.config.state_dir,
                             log_dir=self.config.log_dir)
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3')]
        self.gh.work_list = [wi(3, 'Red')]
        self.reviewed(5, H1, 'clean')
        snap = self.snap()
        p = pr_of(snap, 5)
        self.assertEqual({k: p[k] for k in ('repo', 'n', 'issue', 'title', 'head', 'branch', 'url',
                                             'status', 'next')},
                         {'repo': 'first', 'n': 5, 'issue': 3, 'title': 'Red', 'head': 'aaaaaaa',
                          'branch': 'claude/red-3', 'url': 'https://github.com/owner/first/pull/5',
                          'status': 'Ready for you to merge', 'next': 'You merge it.'})
        self.assertIn({'label': 'Clean on aaaaaaa', 'ok': True}, p['checks'])
        self.assertIn({'label': 'Checks passed on aaaaaaa', 'ok': True}, p['checks'])
        self.assertTrue(all(c['ok'] for c in p['checks']))
        self.assertEqual(by_n(snap)[3]['state'], 'you')

    def test_a_clean_pr_whose_checks_run_says_what_it_waits_for(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red')]
        self.gh.check_states = {H1: Checks('pending', pending=('ci',))}
        self.reviewed(5, H1, 'clean')
        p = pr_of(self.snap(), 5)
        self.assertEqual(p['status'], 'Clean, not merged yet')
        self.assertEqual(p['next'], 'The runner merges it once this clears: checks on aaaaaaa '
                                    'are pending (ci).')
        self.assertIn({'label': 'Checks passed on aaaaaaa', 'ok': False}, p['checks'])

    def test_prs_waiting_for_review_say_in_what_order(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3'),
                       full_pr(6, 'claude/blue-4', H2, title='Blue')]
        self.gh.work_list = [wi(3, 'Red')]
        snap = self.snap()
        self.assertEqual((pr_of(snap, 5)['status'], pr_of(snap, 5)['next']),
                         ('Waiting for review', 'Sol reviews aaaaaaa next.'))
        self.assertEqual(pr_of(snap, 6)['next'], 'Sol reviews bbbbbbb after PR #5.')
        self.assertEqual(pr_of(snap, 5)['checks'], [])
        self.assertEqual((by_n(snap)[3]['state'], by_n(snap)[3]['note']),
                         ('review', 'PR #5: Waiting for review'))

    def test_a_blocking_pr_has_its_fix_round_queued(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3')]
        self.gh.work_list = [wi(3, 'Red')]
        self.reviewed(5, H1, 'blocking')
        snap = self.snap()
        self.assertEqual((pr_of(snap, 5)['status'], pr_of(snap, 5)['next']),
                         ('Fix round next', "Claude's fix round on aaaaaaa is next in its queue."))
        self.assertEqual(by_n(snap)[3]['state'], 'fixing')

    def test_a_pr_reviewed_before_the_cutover_is_left_alone_until_a_new_head(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red')]
        self.gh.comments[5] = [Comment('stefan1575', '2026-11-08T10:00:00Z',
                                       f'<!-- sol-pr-review round=1 verdict=blocking sha={H1} -->')]
        p = pr_of(self.snap(), 5)
        self.assertEqual(p['status'], 'Left alone: reviewed outside the runner')
        self.assertEqual(p['next'], 'Review 1 on aaaaaaa (blocking) was posted before the '
                                    'cutover or by hand, so the runner leaves it to whoever ran '
                                    'it. A push of a new head lets it go: Sol reviews that.')

    def test_a_pr_whose_reviews_failed_twice_is_left_alone_until_a_push_or_a_release(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red')]
        for _ in range(2):
            self.job('review', 5, 'failed', sha=H1, round=1)
        p = pr_of(self.snap(), 5)
        self.assertEqual(p['status'], 'Left alone: two reviews failed')
        self.assertEqual(p['next'], 'Both reviews of aaaaaaa failed. A push of a new head, or '
                                    '--release first#5, lets it go.')

    def test_a_pr_stopped_for_stefan_is_held_and_says_what_lets_it_go(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red', body='Closes #3')]
        self.gh.work_list = [wi(3, 'Red')]
        self.reviewed(5, H1, 'blocking')
        self.job('stop', 5, 'filed', sha=H1, stop='review',
                 link='https://github.com/owner/first/issues/40')
        snap = self.snap()
        p = pr_of(snap, 5)
        self.assertEqual(p['status'], 'Held for you')
        self.assertIn('issues/40 is closed, he replies, or --release first#5', p['next'])
        self.assertEqual(by_n(snap)[3]['state'], 'you')

    def test_a_stopped_repos_pr_says_so(self):
        self.gh.prs = [full_pr(5, 'claude/red-3', H1, title='Red')]
        stopped = control.Switch(repos={'first': control.Stop('after-job', NOW, 'control')})
        p = pr_of(self.snap(switch=stopped), 5)
        self.assertEqual((p['status'], p['next']),
                         ('Its repository is stopped',
                          'Neither lane takes up its work until you resume first.'))


class HistoryCase(WorkCase):
    def setUp(self):
        super().setUp()
        self.gh.prs = [full_pr(5, 'claude/red-3', H2, title='Red', body='Closes #3')]
        self.gh.work_list = [wi(3, 'Red')]
        self.job('build', 3, 'done', branch='claude/red-3', commits=['1', '2'],
                 pr={'number': 5, 'url': 'u'})
        run = os.path.join(self.dir, 'runs', 'r1')
        os.makedirs(run)
        with open(os.path.join(run, 'decision.json'), 'w', encoding='utf-8') as f:
            json.dump({'findings': [{'id': 'F1', 'tag': 'important', 'class': 'Stale owner',
                                     'status': 'fixed', 'raised': 1}]}, f)
        self.job('review', 5, 'blocking', sha=H1, round=1, verdict='blocking', run_dir=run)
        self.job('fix', 5, 'pushed', sha=H1, round=1, branch='claude/red-3', head=H2,
                 commits=['3'])
        self.reviewed(5, H2, 'clean', rnd=2)


class HistoryTest(HistoryCase):
    def test_a_prs_timeline_by_head_from_the_job_log(self):
        tl = pr_of(self.snap(), 5)['timeline']
        self.assertEqual([(e['actor'], e['kind'], e['sha']) for e in tl],
                         [('claude', 'build', 'aaaaaaa'), ('sol', 'review', 'aaaaaaa'),
                          ('claude', 'fix', 'aaaaaaa'), ('sol', 'review', 'bbbbbbb')])
        self.assertEqual(tl[0]['title'], 'Claude built #3 and opened PR #5, in 2 commits.')
        self.assertEqual(tl[1]['findings'], [{'id': 'F1', 'text': 'Stale owner',
                                              'status': 'fixed'}])
        self.assertEqual((tl[3]['title'], tl[3]['tone']),
                         ('Review 2 on bbbbbbb came back clean.', 'ok'))
        self.assertEqual(set(tl[0]), {'at', 'actor', 'kind', 'sha', 'title', 'detail', 'tone',
                                      'findings'})

    def test_activity_is_the_job_log_newest_first_each_a_whole_sentence(self):
        stop = self.job('stop', 5, None, sha=H2, stop='review', link='https://x/issues/40')
        self.jobs.ended(stop.id, exit_code=None, outcome='filed')
        self.jobs.ended(stop.id, exit_code=None, outcome='answered', answer='replied')
        rows = self.snap(releases=[('first', 5, '2099-01-01T00:00:00+00:00')])['activity']
        self.assertEqual(rows[0]['title'], 'You released it (--release first#5), so the runner '
                                           'took it up again.')
        self.assertEqual([r['actor'] for r in rows][:2], ['you', 'you'])
        self.assertEqual(rows[1]['title'], 'You replied.')
        self.assertEqual(rows[-1], {'at': rows[-1]['at'], 'actor': 'claude', 'repo': 'first',
                                    'pr': None, 'ref': '#3', 'title': 'Claude built #3 and opened '
                                    'PR #5, in 2 commits.', 'detail': 'Red', 'tone': 'ok'})
        self.assertTrue(all(r['title'].endswith('.') for r in rows))
        times = [r['at'] for r in rows]
        self.assertEqual(times, sorted(times, reverse=True))

    def test_activity_keeps_the_latest_200(self):
        for k in range(205):
            self.job('review', 5, 'failed', sha=H2, round=3)
        self.assertEqual(len(self.snap()['activity']), 200)


class GitHubDownTest(WorkCase):
    def test_the_last_lists_stay_and_the_github_source_says_since_when(self):
        self.gh.prs = [full_pr(6, 'claude/blue-4', H2, title='Blue')]
        times = iter([NOW, NOW + datetime.timedelta(minutes=5)])
        reader = self.reader(clock=lambda: next(times))
        reader.read()
        self.gh.fail.add('work_issues')
        reader.read()
        snap = self.snap(reader, calls={'github': snapshot.Call(NOW, True, None, NOW)})
        self.assertEqual(refs(lane(snap, 'sol')['queue']), [('review', 'PR #6')])
        src = next(s for s in snap['sources'] if s['id'] == 'github')
        self.assertFalse(src['ok'])
        self.assertEqual(datetime.datetime.fromisoformat(src['checked_at']), NOW)
        self.assertIn('HTTP 503', src['note'])
        self.assertEqual(src['affects'], 'The queues, issues and PRs are as GitHub last showed '
                                         'them for first: some may have changed since.')

    def test_a_repo_never_read_has_no_lists_and_says_so(self):
        self.gh.fail.add('work_issues')
        reader = self.reader()
        reader.read()
        snap = self.snap(reader)
        self.assertEqual(lane(snap, 'claude')['queue'], [])
        src = next(s for s in snap['sources'] if s['id'] == 'github')
        self.assertIsNone(src['checked_at'])
        self.assertFalse(src['ok'])


class ContractTest(HistoryCase):
    """A real issue, feature, PR (its checks and timeline events), queue entry and activity row
    have the sample's keys: every key each sample has there, and none that no sample has."""

    def keys(self, pick):
        from dashboard import sample
        stopped = {'written_at': '2026-11-15T12:00:00+08:00',
                   'repos': {'leads-dashboard': {'stop': 'after-job', 'at': None}}}
        samples = [sample.build(name) for name in sample.STATES] + [sample.build(control=stopped)]
        sets = [set(d) for s in samples for d in pick(s)]
        return set.intersection(*sets), set.union(*sets)

    def holds(self, real, pick, what):
        self.assertTrue(real, f'no {what} to hold to the sample')
        must, may = self.keys(pick)
        for d in real:
            self.assertLessEqual(must, set(d), f'{what} lacks keys the sample always has')
            self.assertLessEqual(set(d), may, f'{what} has keys no sample has')

    def test_the_real_lists_have_the_samples_keys(self):
        self.gh.work_list = [wi(1, 'Spec: the app', labels=('spec',),
                                subs=[(3, 'Red', 'open'), (2, 'Two', 'closed')]),
                             wi(3, 'Red', parent=1), wi(7, 'Seven')]
        self.gh.issues = [ready(7, 'Seven')]
        self.gh.prs.append(full_pr(6, 'claude/blue-4', H3, title='Blue'))
        snap = self.snap()
        self.holds(snap['issues'], lambda s: s['issues'], 'an issue')
        self.holds(snap['features'], lambda s: s['features'], 'a feature')
        self.holds(snap['prs'], lambda s: s['prs'], 'a PR')
        self.holds([c for p in snap['prs'] for c in p['checks']],
                   lambda s: [c for p in s['prs'] for c in p['checks']], "a PR's check")
        self.holds([e for p in snap['prs'] for e in p['timeline']],
                   lambda s: [e for p in s['prs'] for e in p['timeline']], "a PR's event")
        self.holds([f for p in snap['prs'] for e in p['timeline'] for f in e['findings']],
                   lambda s: [f for p in s['prs'] for e in p['timeline'] for f in e['findings']],
                   'a finding')
        self.holds([q for l in snap['lanes'] for q in l['queue']],
                   lambda s: [q for l in s['lanes'] for q in l['queue']], 'a queue entry')
        self.holds(snap['activity'], lambda s: s['activity'], 'an activity row')
        json.dumps(snap)


if __name__ == '__main__':
    unittest.main()
