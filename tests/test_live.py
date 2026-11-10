"""Live steps after merges (ticket 11): the answer block, the batch from git and the job log,
"about to land", and a run's outcomes, stops and restarts, with GitHub, T3 and git faked."""
import datetime
import json
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.github import Checks
from queue_runner.live import LiveSteps, parse
from queue_runner.merge import Merger
from queue_runner.run import BUSY, Runner
from queue_runner.state import JobLog
from queue_runner.stops import Stopper
from queue_runner.t3 import Message, T3Error
from tests.fakes import FakeGitHubForReviews, FakeToaster, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeT3

A, B, C = 'a' * 40, 'b' * 40, 'c' * 40
M1 = 'supabase/migrations/20261101000000_one.sql'
M2 = 'supabase/migrations/20261102000000_two.sql'
NOW = datetime.datetime(2026, 11, 10, 12, 0, tzinfo=datetime.timezone.utc)


def live_reply(result='live', applied=(M1, M2), **fields) -> str:
    block = json.dumps({'version': 1, 'result': result, 'applied': list(applied),
                        'stefan': [], **fields})
    return f'I did the live steps.\n\n```queue-runner-live\n{block}\n```\n'


class FakeLiveGit(FakeReviewGit):
    """Also the base's head (`base`), its first-parent commits and changed files between two
    commits (`logs`, `changes`, keyed (a, b))."""

    def __init__(self, base=A, **kwargs):
        super().__init__(**kwargs)
        self.base, self.logs, self.changes = base, {}, {}

    def sha(self, path, ref):
        return self.base

    def first_parent(self, path, a, b):
        return list(self.logs.get((a, b), []))

    def name_status(self, path, a, b):
        return list(self.changes.get((a, b), []))


class ParseTest(unittest.TestCase):
    def test_live_with_every_pending_migration(self):
        a = parse(live_reply(notes='deployment 01J'), [M1, M2])
        self.assertEqual((a.result, a.applied, a.notes), ('live', (M1, M2), 'deployment 01J'))

    def test_live_missing_a_migration_reads_as_partial(self):
        a = parse(live_reply(applied=[M1]), [M1, M2])
        self.assertEqual((a.result, a.applied), ('partial', (M1,)))
        self.assertIn(M2, a.text)

    def test_an_unlisted_migration_is_unreadable_and_keeps_the_listed_ones(self):
        a = parse(live_reply(applied=[M1, 'supabase/migrations/x.sql']), [M1, M2])
        self.assertEqual((a.result, a.applied), ('failed', (M1,)))

    def test_partial_and_stop_need_their_text(self):
        self.assertEqual(parse(live_reply('partial', [M1]), [M1, M2]).result, 'failed')
        a = parse(live_reply('partial', [M1], failed='two failed: column exists'), [M1, M2])
        self.assertEqual((a.result, a.text), ('partial', 'two failed: column exists'))
        a = parse(live_reply('stop', [], question='Apply two by hand?'), [M1, M2])
        self.assertEqual((a.result, a.text), ('stop', 'Apply two by hand?'))

    def test_no_block_bad_json_or_version_is_unreadable(self):
        self.assertEqual(parse('Done.', []).result, 'failed')
        self.assertEqual(parse('```queue-runner-live\n{nope\n```', []).result, 'failed')
        self.assertEqual(parse(live_reply().replace('"version": 1', '"version": 2'),
                               [M1, M2]).result, 'failed')

    def test_the_last_block_counts(self):
        reply = live_reply('stop', [], question='?') + live_reply()
        self.assertEqual(parse(reply, [M1, M2]).result, 'live')


class LiveHarness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github='owner/first', path=self.dir,
                         live_doc='docs/agents/lovable-cloud.md')
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'))
        self.jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.said = []
        self.gh = FakeGitHubForReviews(prs=[full_pr(12, 'claude/one-3', A, title='One'),
                                            full_pr(13, 'claude/two-4', A, title='Two')])
        for n in (12, 13):
            self.gh.now[n] = {'state': 'merged'}
        self.git = FakeLiveGit(base=A)
        self.t3 = FakeT3()
        self.toaster = FakeToaster()

    def live(self):
        stopper = Stopper(self.config, github=self.gh, jobs=self.jobs, say=self.said.append,
                          toaster=self.toaster)
        return LiveSteps(self.config, github=self.gh, git=self.git, t3=self.t3, jobs=self.jobs,
                         say=self.said.append, stopper=stopper,
                         merger=Merger(self.config, github=self.gh, git=self.git, jobs=self.jobs,
                                       say=self.said.append),
                         find_thread=self.find, now=lambda: NOW)

    def find(self, job):
        found = [t for t in self.t3.threads.values() if t.title == job.title]
        return self.t3.show(found[-1].thread_id)[0] if found else None

    def merged(self, start=A, target=B, changes=((('A', M2), ('A', M1),
                                                  ('M', 'supabase/functions/sync/index.ts'),
                                                  ('A', 'src/app.ts')))):
        """#12 and #13 merged since `start`: the base is at `target`."""
        self.git.base = target
        self.git.ancestors.add((start, target))
        self.git.logs[(start, target)] = [
            {'sha': '1' * 40, 'subject': 'Merge pull request #12 from owner/claude/one-3'},
            {'sha': '2' * 40, 'subject': 'Lovable: update types'},
            {'sha': '3' * 40, 'subject': 'Two (#13)'}]
        self.git.changes[(start, target)] = list(changes)

    def first_sight(self):
        self.assertIsNone(self.live().next())

    def outcomes(self, kind='live'):
        return [j.outcome for j in self.jobs.jobs() if j.kind == kind]

    def stops(self):
        return [(j.stop, j.outcome) for j in self.jobs.jobs() if j.kind == 'stop']


class BatchTest(LiveHarness):
    def test_first_sight_counts_the_base_as_live_and_starts_nothing(self):
        self.first_sight()
        [job] = self.jobs.live('first')
        self.assertEqual((job.outcome, job.head), ('assumed', A))
        self.assertIn('live first: not now, first sight: everything up to aaaaaaa on main counts '
                      'as live', self.said)
        self.assertIsNone(self.live().next())   # nothing merged since

    def test_a_dry_look_records_nothing(self):
        self.assertIsNone(self.live().batch(self.repo, record=False))
        self.assertEqual(self.jobs.jobs(), [])

    def test_the_batch_is_read_from_git(self):
        self.first_sight()
        self.merged()
        repo, b = self.live().next()
        self.assertEqual((b.start, b.target, b.prs), (A, B, (12, 13)))
        self.assertEqual(b.pending, (M1, M2))   # in file order: timestamps
        self.assertEqual(b.functions, ('sync',))
        brief = self.live().brief(repo, b)
        for text in ('1. `' + M1, '2. `' + M2, '#12 One', '#13 Two', '`sync`',
                     'docs/agents/lovable-cloud.md', 'Lovable: update types',
                     '```queue-runner-live'):
            self.assertIn(text, brief)

    def test_commits_with_no_pr_wait_for_one(self):
        self.first_sight()
        self.merged()
        self.git.logs[(A, B)] = [{'sha': '2' * 40, 'subject': 'Lovable: update types'}]
        self.assertIsNone(self.live().next())
        self.assertIn('live first: not now, no PR merged since aaaaaaa', self.said)

    def test_a_changed_migration_is_named_for_a_stop(self):
        self.first_sight()
        self.merged(changes=[('M', M1)])
        repo, b = self.live().next()
        self.assertEqual((b.pending, b.changed), ((), (M1,)))
        self.assertIn('Changed after reaching the base', self.live().brief(repo, b))


class AboutToLandTest(LiveHarness):
    def setUp(self):
        super().setUp()
        self.first_sight()
        self.merged()

    def test_an_open_review_fix_or_merge_waits(self):
        for kind in ('review', 'fix', 'merge'):
            job = self.jobs.started(kind=kind, repo='first', issue=20, branch='claude/x-9',
                                    title='t', sha=C)
            self.assertIsNone(self.live().next(), kind)
            self.jobs.ended(job.id, exit_code=None, outcome='failed')
        self.assertTrue(any('Sol is reviewing #20' in s for s in self.said))
        self.assertIsNotNone(self.live().next())

    def clean_pr(self):
        self.gh.prs.append(full_pr(20, 'claude/x-9', C))
        job = self.jobs.started(kind='review', repo='first', issue=20, branch='claude/x-9',
                                title='t', sha=C, round=1)
        self.jobs.ended(job.id, exit_code=None, outcome='clean')

    def test_a_clean_pr_merging_waits(self):
        self.clean_pr()
        live = self.live()
        live.merger.why_not = lambda repo, n, h: None
        self.assertIsNone(live.next())
        self.assertIn('live first: not now, #20 is clean and merging', self.said)

    def test_a_clean_pr_waiting_for_its_checks_waits(self):
        self.clean_pr()
        self.gh.check_states[C] = Checks('pending', pending=('ci',))
        live = self.live()
        live.merger.why_not = lambda repo, n, h, checks=True: 'checks pending' if checks else None
        self.assertIsNone(live.next())
        self.assertIn('live first: not now, #20 is clean, waiting for its checks', self.said)

    def test_a_held_clean_pr_with_checks_pending_does_not_wait(self):
        self.clean_pr()
        self.gh.check_states[C] = Checks('pending', pending=('ci',))
        live = self.live()
        live.merger.why_not = lambda repo, n, h, checks=True: 'stopped for Stefan'
        self.assertIsNotNone(live.next())

    def test_first_sight_is_recorded_even_while_a_merge_is_about_to_land(self):
        self.jobs.path = os.path.join(self.dir, 'state', 'other.jsonl')   # a fresh log
        self.clean_pr()
        live = self.live()
        live.merger.why_not = lambda repo, n, h, checks=True: None
        self.git.base = A
        self.assertIsNone(live.next())
        self.assertEqual([(j.outcome, j.head) for j in self.jobs.live('first')], [('assumed', A)])

    def test_a_clean_pr_held_for_stefan_does_not_wait(self):
        self.clean_pr()
        live = self.live()
        live.merger.why_not = lambda repo, n, h: 'Stefan reads it first'
        self.assertIsNotNone(live.next())

    def test_a_pr_ready_for_stefan_to_merge_does_not_wait(self):
        from dataclasses import replace
        self.config = replace(self.config, repos=[replace(self.repo, merge='stefan')])
        self.clean_pr()
        live = self.live()
        live.merger.why_not = lambda repo, n, h, checks=True: None   # ready: his call when
        self.assertIsNotNone(live.next())


class RunTest(LiveHarness):
    def setUp(self):
        super().setUp()
        self.first_sight()
        self.merged()

    def run_live(self, *outcomes):
        self.t3.outcomes = list(outcomes)
        live = self.live()
        found = live.next()
        self.assertIsNotNone(found)
        return live.run(*found)

    def test_live_moves_the_reach_and_reports_each_pr(self):
        self.assertEqual(self.run_live((0, 'completed', live_reply())), 'started')
        [start] = self.t3.starts
        self.assertEqual((start['worktree'], start['title']), (B, 'Queue runner live: first'))
        self.assertTrue(start['branch'].startswith('claude/live-bbbbbbb-'))
        job = self.jobs.live('first')[-1]
        self.assertEqual((job.outcome, job.sha, job.head, job.applied, job.prs),
                         ('live', A, B, [M1, M2], [12, 13]))
        comments = [p for p in self.gh.posts if p[0] == 'comment']
        self.assertEqual([c[1] for c in comments], [12, 13])
        self.assertIn('**Live.**', comments[0][2])
        self.assertIn('first: #12, #13 live at bbbbbbb', ' '.join(self.said))
        self.assertEqual(self.git.removed_worktrees[0][0], 'C:/t3/worktrees/mcp:t1')
        self.assertIsNone(self.live().next())   # reached the base
        self.assertEqual(self.stops(), [])

    def test_steps_for_stefan_file_a_stop_that_holds_nothing(self):
        self.run_live((0, 'completed', live_reply(stefan=['Ask Lovable to deploy sync.'])))
        self.assertEqual(self.stops(), [('live-todo', 'filed')])
        self.merged(start=B, target=C)
        self.assertIsNotNone(self.live().next())

    def test_partial_stops_and_the_next_run_skips_what_it_applied(self):
        self.run_live((0, 'completed', live_reply('partial', [M1], failed='two: column exists')))
        self.assertEqual(self.outcomes(), ['assumed', 'partial'])
        self.assertEqual(self.stops(), [('live', 'filed')])
        [issue] = [p for p in self.gh.posts if p[0] == 'issue']
        self.assertIn('two: column exists', issue[2])
        self.assertIn('first: #12, #13 merged, not live yet (partial', ' '.join(self.said))
        self.assertEqual(len(self.toaster.toasts), 1)
        self.assertIsNone(self.live().next())   # held for Stefan
        self.assertTrue(any('waiting for Stefan on' in s for s in self.said))
        # Stefan closes the issue: the next run applies only two, from the same reach.
        stopper = Stopper(self.config, github=self.gh, jobs=self.jobs, say=self.said.append)
        self.gh.close_issue(901)
        stopper.answers(self.repo)
        self.assertEqual(self.stops(), [('live', 'answered')])
        repo, b = self.live().next()
        self.assertEqual((b.start, b.pending, b.applied), (A, (M2,), (M1,)))
        brief = self.live().brief(repo, b)
        self.assertIn('Already applied by an earlier live run', brief)
        self.assertIn('he closed its issue', brief)
        self.run_live((0, 'completed', live_reply(applied=[M2])))
        self.assertEqual(self.outcomes(), ['assumed', 'partial', 'live'])

    def test_a_failed_thread_stops_and_marks_its_batch_maybe_applied(self):
        self.run_live((1, 'failed'))
        self.assertEqual(self.outcomes(), ['assumed', 'failed'])
        self.assertEqual(self.stops(), [('live', 'filed')])
        self.jobs.released('first', 13)   # Stefan releases the batch's newest PR
        repo, b = self.live().next()
        self.assertEqual(b.pending, (M1, M2))
        self.assertIn('Maybe applied already', self.live().brief(repo, b))

    def test_an_unfiled_stop_is_filed_next_pass(self):
        self.gh.fail.add('issue')
        self.gh.open_issue_list = []
        self.run_live((0, 'completed', 'no block'))
        self.assertEqual(self.stops(), [('live', 'failed')])
        self.gh.fail.clear()
        self.assertIsNone(self.live().next())
        self.assertEqual(self.stops(), [('live', 'failed'), ('live', 'filed')])

    def test_t3_down_starts_nothing(self):
        self.assertEqual(self.run_live(T3Error('server down')), 'idle')
        self.assertEqual(self.outcomes(), ['assumed', 'not-started'])
        self.assertIsNotNone(self.live().next())

    def test_a_usage_limit_waits_for_its_reset_then_checks_first(self):
        live = self.live()
        live.limit = lambda *a: {'resume_at': (NOW + datetime.timedelta(hours=1)).isoformat(),
                                 'context': None}
        self.t3.outcomes = [(1, 'failed')]
        live.run(*live.next())
        self.assertEqual(self.outcomes(), ['assumed', 'usage-limit'])
        self.assertEqual(self.stops(), [])
        self.assertEqual(self.jobs.limited_jobs(), [])   # not a build or fix to recover
        waits = self.live()
        self.assertIsNone(waits.next())
        self.assertEqual(waits.wait_until, NOW + datetime.timedelta(hours=1))
        later = self.live()
        later.now = lambda: NOW + datetime.timedelta(hours=2)
        repo, b = later.next()
        self.assertEqual(b.pending, (M1, M2))
        self.assertIn('Maybe applied already', later.brief(repo, b))


class RaceTest(LiveHarness):
    """The Sol lane merges alongside: a batch read before a merge is never run stale, and no
    merge lands while a live run is open."""

    def setUp(self):
        super().setUp()
        self.first_sight()
        self.merged()

    def test_a_merge_after_the_batch_was_read_makes_it_stale(self):
        live = self.live()
        repo, b = live.next()
        self.git.base = C   # the Sol lane merged meanwhile
        self.assertEqual(live.run(repo, b), 'idle')
        self.assertEqual(self.t3.starts, [])
        self.assertEqual(self.outcomes(), ['assumed', 'not-started'])
        self.assertIn('main moved past bbbbbbb', ' '.join(self.said))

    def test_a_merge_begun_after_the_batch_was_read_makes_it_stale(self):
        live = self.live()
        repo, b = live.next()
        self.jobs.started(kind='merge', repo='first', issue=20, branch='claude/x-9', title='t',
                          sha=C)
        self.assertEqual(live.run(repo, b), 'idle')
        self.assertEqual(self.t3.starts, [])

    def test_no_merge_while_a_live_run_is_open(self):
        self.jobs.started(kind='live', repo='first', issue=13, branch='main',
                          title='Queue runner live: first', sha=A, head=B)
        self.gh.prs.append(full_pr(20, 'claude/x-9', C))
        why = Merger(self.config, github=self.gh, git=self.git, jobs=self.jobs,
                     say=self.said.append).why_not(self.repo, 20, C)
        self.assertIn('is bringing main live: merges wait for it', why)


class EditedMigrationTest(LiveHarness):
    def test_a_migration_edited_after_a_partial_run_applied_it_is_named(self):
        self.first_sight()
        self.merged()
        self.t3.outcomes = [(0, 'completed', live_reply('partial', [M1], failed='two failed'))]
        live = self.live()
        live.run(*live.next())
        self.jobs.released('first', 13)
        self.merged(start=A, target=C, changes=[('A', M1), ('A', M2)])   # net: still added
        self.git.changes[(B, C)] = [('M', M1)]                          # but C edited one
        repo, b = self.live().next()
        self.assertEqual((b.pending, b.changed), ((M2,), (M1,)))


class RestartTest(LiveHarness):
    """A runner that died mid-run: the next one settles the live job from its thread."""

    def setUp(self):
        super().setUp()
        self.first_sight()
        self.merged()
        self.job = self.jobs.started(kind='live', repo='first', issue=13, branch='main',
                                     title='Queue runner live: first', sha=A, head=B)

    def runner(self):
        return Runner(self.config, github=self.gh, t3=self.t3, git=self.git, out=open(os.devnull, 'w'),
                      log_line=self.said.append, now=lambda: NOW)

    def test_a_running_thread_keeps_the_lane_busy(self):
        self.t3.add('mcp:live', 'Queue runner live: first', 'running')
        r = self.runner()
        self.addCleanup(r.out.close)
        self.assertEqual(r.settle(), BUSY)
        self.assertTrue(self.jobs.live('first')[-1].open)

    def test_an_ended_thread_is_settled_from_its_reply(self):
        self.t3.add('mcp:live', 'Queue runner live: first', 'completed',
                    worktree_path='C:/t3/worktrees/live', branch='claude/live-b')
        self.t3.messages['mcp:live'] = [Message('assistant', live_reply('partial', [M1],
                                                                        failed='two failed'))]
        r = self.runner()
        self.addCleanup(r.out.close)
        self.assertIsNone(r.settle())
        job = self.jobs.live('first')[-1]
        self.assertEqual((job.outcome, job.applied), ('partial', [M1]))
        self.assertEqual(self.stops(), [('live', 'filed')])

    def test_no_thread_is_not_started(self):
        r = self.runner()
        self.addCleanup(r.out.close)
        r.settle()
        self.assertEqual(self.jobs.live('first')[-1].outcome, 'not-started')
        self.assertIsNotNone(self.live().next())


class LaneTest(LiveHarness):
    def test_live_steps_come_before_a_build(self):
        self.first_sight()
        self.merged()
        r = Runner(self.config, github=self.gh, t3=self.t3, git=self.git,
                   out=open(os.devnull, 'w'), log_line=self.said.append, now=lambda: NOW)
        self.addCleanup(r.out.close)
        kind, then, run = r.choose()
        self.assertEqual((kind, then), ('live', None))

    def test_an_idle_lane_wakes_for_a_live_runs_limit(self):
        self.first_sight()
        self.merged()
        job = self.jobs.started(kind='live', repo='first', issue=13, branch='main',
                                title='Queue runner live: first', sha=A, head=B)
        at = NOW + datetime.timedelta(hours=1)
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit', resume_at=at.isoformat())
        r = Runner(self.config, github=self.gh, t3=self.t3, git=self.git,
                   out=open(os.devnull, 'w'), log_line=self.said.append, now=lambda: NOW)
        self.addCleanup(r.out.close)
        self.assertEqual(r.choose(), 'idle')
        self.assertEqual(r.gate_until, at)


if __name__ == '__main__':
    unittest.main()
