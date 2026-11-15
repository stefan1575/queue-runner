"""The snapshot's work lists (ticket 32): `work.Reader` reads a fake GitHub and a temp job log the
way the lanes do, and `snapshot.build` writes the issues, features, PRs, activity and each lane's
queue from that read."""
import datetime
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


if __name__ == '__main__':
    unittest.main()
