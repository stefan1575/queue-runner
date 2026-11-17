"""The run loop through its command line: `--once`, the continuous mode and `--release`, with
GitHub, T3 and git faked."""
import datetime
import io
import os
import tempfile
import unittest

from queue_runner.cli import main
from queue_runner.wake import NoWaker
from queue_runner.state import JobLog
from queue_runner.t3 import Message, T3Error
from tests.fakes import (FakeGitHubForReviews, FakeGitHubWithPulls, FakeLimits, FakeToaster,
                         FakeUsage, full_pr, issue)
from tests.fakes_t3 import FakeGit, FakeReviewGit, FakeSol, FakeT3, decision_reply
from tests.test_ledger import H2, important, reply

PR = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}


class Stop(Exception):
    pass


class RunHarness(unittest.TestCase):
    """A config, a job log and `main` with GitHub, T3 and git faked."""

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
        self.log = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.limits = FakeLimits()
        self.clock = None   # the real one

    def run_main(self, args, github, t3, git=None, sleep=None, sol=None):
        out = io.StringIO()
        self.toaster = FakeToaster()   # a waiting job toasts: never a real one in tests
        code = main(args + ['--config', self.config], github=github, out=out, t3=t3,
                    git=git or FakeGit(), sleep=sleep or (lambda s: None), sol=sol or FakeSol(),
                    toaster=self.toaster, usage=FakeUsage(), limits=self.limits,
                    clock=self.clock, t3_settings=os.path.join(self.dir, 't3.json'),
                    waker=NoWaker())
        return code, out.getvalue()

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()



class RunTest(RunHarness):
    def test_once_starts_the_picked_build_in_a_t3_worktree_and_records_it(self):
        gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.')],
                                 pulls_by_branch={'claude/red-widget-4': PR})
        t3 = FakeT3([(0, 'completed')])
        git = FakeGit(commits={'claude/red-widget-4': [{'sha': 'abc1234', 'subject': 'Red'}]})
        code, out = self.run_main(['--once'], gh, t3, git)

        self.assertEqual(code, 0)
        [start] = t3.starts
        self.assertEqual((start['project'], start['worktree'], start['branch']),
                         (os.path.normpath(self.dir), 'origin/main', 'claude/red-widget-4'))
        self.assertEqual((start['provider'], start['model']), ('claudeAgent', 'claude-opus-5-5'))
        self.assertTrue(start['message'].startswith('Build GitHub issue #4 in owner/first'))
        self.assertEqual(git.fetches, [(os.path.normpath(self.dir), 'main')])

        [job] = self.log.jobs()
        self.assertEqual((job.kind, job.repo, job.issue, job.branch), ('build', 'first', 4,
                                                                       'claude/red-widget-4'))
        self.assertEqual((job.thread_id, job.exit_code, job.outcome), ('mcp:t1', 0, 'done'))
        self.assertTrue(job.link.startswith('https://app.t3.codes/'))
        self.assertEqual(job.pr, PR)
        self.assertEqual(job.commits, [{'sha': 'abc1234', 'subject': 'Red'}])
        self.assertEqual(job.worktree, 'C:/t3/worktrees/mcp:t1')
        self.assertIn('build first#4 ended: done', self.runner_log())
        self.assertIn('owner/first#4', out)

    def test_a_completed_build_without_a_pr_is_recorded_as_such(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        self.run_main(['--once'], gh, FakeT3([(0, 'completed')]))
        self.assertEqual(self.log.jobs()[0].outcome, 'done-no-pr')

    def test_a_failed_run_is_recorded_and_its_issue_not_picked_again(self):
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)])
        stop = decision_reply('stop', question='Why?')
        t3 = FakeT3([(1, 'interrupted'), (0, 'completed', stop), (0, 'completed')])
        for _ in range(3):   # the build, a decision on its failure, the next build
            self.run_main(['--once'], gh, t3)
        self.assertEqual([s['branch'] for s in t3.starts],
                         ['claude/a-ticket-4', None, 'claude/a-ticket-5'])
        self.assertEqual(t3.starts[1]['title'], 'Queue runner decision: first#4')
        failed = self.log.jobs()[0]
        self.assertEqual((failed.issue, failed.exit_code, failed.outcome, failed.status),
                         (4, 1, 'failed', 'interrupted'))
        self.assertEqual(failed.error, 'It broke.')

    def test_a_run_waiting_for_an_answer_holds_its_issue(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        stop = decision_reply('stop', question='Which colour?')
        t3 = FakeT3([(2, 'waiting'), (0, 'completed', stop)])
        self.run_main(['--once'], gh, t3)
        self.run_main(['--once'], gh, t3)   # a decision on its question: Stefan's
        code, out = self.run_main(['--once'], gh, t3)
        self.assertEqual(len(t3.starts), 2)
        self.assertEqual(self.log.jobs()[0].outcome, 'waiting')
        self.assertIn('Nothing to start', out)

    def test_a_waiting_job_is_recorded_done_once_its_thread_completes(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)], pulls_by_branch={'claude/a-ticket-4': PR})
        t3 = FakeT3([(2, 'waiting')])
        self.run_main(['--once'], gh, t3)
        t3.set_status('mcp:t1', 'completed')   # Stefan answered it in T3
        self.run_main(['--once'], gh, t3)
        [job] = self.log.jobs()
        self.assertEqual((job.exit_code, job.outcome, job.pr), (0, 'done', PR))
        self.assertEqual(len(t3.starts), 1)

    def test_t3_failing_before_any_thread_exists_is_retried_next_pass(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        t3 = FakeT3([T3Error('T3 Code server is not running'), (0, 'completed')])
        self.run_main(['--once'], gh, t3)
        self.assertEqual(self.log.jobs()[0].outcome, 'not-started')
        self.assertIn('server is not running', self.log.jobs()[0].error)
        self.run_main(['--once'], gh, t3)
        self.assertEqual([j.outcome for j in self.log.jobs()], ['not-started', 'done-no-pr'])

    def test_t3_failing_after_its_thread_started_leaves_the_job_open_for_the_next_pass(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)], pulls_by_branch={'claude/a-ticket-4': PR})

        class LostWait(FakeT3):
            def start(self, *args, **kwargs):
                super().start(*args, **kwargs)        # the thread exists and runs on
                raise T3Error('T3 Code server is unreachable')

        t3 = LostWait([(0, 'running')])
        self.run_main(['--once'], gh, t3)
        self.assertEqual([j.issue for j in self.log.open_jobs()], [4])
        t3.set_status('mcp:t1', 'completed')
        self.run_main(['--once'], gh, t3)
        [job] = self.log.jobs()
        self.assertEqual((job.thread_id, job.exit_code, job.outcome), ('mcp:t1', 0, 'done'))

    def test_a_job_still_running_from_a_dead_runner_blocks_a_second_claude_job(self):
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)],
                                 pulls_by_branch={'claude/a-ticket-4': PR})
        job = self.log.started(kind='build', repo='first', issue=4, branch='claude/a-ticket-4',
                               title='Queue runner build: first#4')
        t3 = FakeT3([(0, 'completed')])
        t3.add('mcp:old', job.title, 'running')
        code, out = self.run_main(['--once'], gh, t3)
        self.assertEqual(t3.starts, [])
        self.assertIn('still running', out)
        t3.set_status('mcp:old', 'completed')
        self.run_main(['--once'], gh, t3)
        self.assertEqual([s['branch'] for s in t3.starts], ['claude/a-ticket-5'])
        self.assertEqual(self.log.jobs()[0].thread_id, 'mcp:old')

    def test_an_open_job_whose_thread_never_started_is_closed(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        self.log.started(kind='build', repo='first', issue=4, branch='claude/a-ticket-4',
                         title='Queue runner build: first#4')
        t3 = FakeT3([(0, 'completed')])
        self.run_main(['--once'], gh, t3)
        self.assertEqual([j.outcome for j in self.log.jobs()], ['not-started', 'done-no-pr'])

    def test_a_leftover_local_branch_holds_the_issue_without_starting_a_thread(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        t3 = FakeT3()
        self.run_main(['--once'], gh, t3, FakeGit(branches={'claude/a-ticket-4'}))
        self.assertEqual(t3.starts, [])
        self.assertEqual(self.log.jobs()[0].outcome, 'branch-exists')
        self.assertEqual(self.log.held_issues('first'), {4})

    def test_release_lets_a_held_issue_be_picked_again(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        t3 = FakeT3([(1, 'failed'), (0, 'completed')])
        self.run_main(['--once'], gh, t3)
        code, out = self.run_main(['--release', 'first#4'], gh, t3)
        self.assertEqual(code, 0)
        self.run_main(['--once'], gh, t3)
        self.assertEqual(len(t3.starts), 2)

    def test_dry_run_skips_held_issues(self):
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)], pulls_by_branch={
            'claude/a-ticket-4': PR})
        self.run_main(['--once'], gh, FakeT3([(0, 'completed')]))
        code, out = self.run_main(['--once', '--dry-run'], gh, FakeT3())
        self.assertIn('#5 A ticket', out)

    def test_dry_run_names_a_pending_decision_first_with_its_brief(self):
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)])
        t3 = FakeT3([(1, 'failed')])
        self.run_main(['--once'], gh, t3)
        code, out = self.run_main(['--once', '--dry-run'], gh, t3)
        self.assertIn('Would start a decision on first#4 (failed)', out)
        self.assertIn('the build thread for issue #4 ended failed', out)
        self.assertNotIn('#5 A ticket', out)
        self.assertEqual(len(t3.starts), 1)
        self.assertEqual([j.kind for j in self.log.jobs()], ['build'])

    def test_continuous_mode_runs_pass_after_pass_and_sleeps_when_idle(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)], pulls_by_branch={'claude/a-ticket-4': PR})
        t3 = FakeT3([(0, 'completed')])
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise Stop

        with self.assertRaises(Stop):
            self.run_main([], gh, t3, sleep=sleep)
        self.assertEqual(len(t3.starts), 1)   # the job, then two idle passes
        self.assertEqual(sleeps, [60, 60])

    def test_a_failing_pass_is_logged_and_the_loop_goes_on(self):
        class Broken(FakeGitHubWithPulls):
            def ready_issues(self, repo):
                raise RuntimeError('GitHub is down')

        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            raise Stop

        with self.assertRaises(Stop):
            self.run_main([], Broken(), FakeT3(), sleep=sleep)
        self.assertIn('GitHub is down', self.runner_log())

    def test_a_waiting_thread_t3_cannot_read_counts_as_busy(self):
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)])
        t3 = FakeT3([(2, 'waiting'), (0, 'completed')])
        self.run_main(['--once'], gh, t3)
        del t3.threads['mcp:t1']   # T3 can't say whether Stefan's answer set it running again
        self.run_main(['--once'], gh, t3)
        self.assertEqual(len(t3.starts), 1)

    def test_a_failed_build_records_the_pr_it_opened(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)], pulls_by_branch={'claude/a-ticket-4': PR})
        self.run_main(['--once'], gh, FakeT3([(1, 'interrupted')]))
        [job] = self.log.jobs()
        self.assertEqual((job.outcome, job.pr), ('failed', PR))

    def test_continuous_mode_pauses_after_a_build_that_never_started(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        t3 = FakeT3([T3Error('T3 Code server is not running')])
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            raise Stop

        with self.assertRaises(Stop):
            self.run_main([], gh, t3, sleep=sleep)
        self.assertEqual((len(t3.starts), sleeps), (1, [60]))

    def test_a_second_runner_exits_while_one_holds_the_lock(self):
        from queue_runner.run import runner_lock
        with runner_lock(os.path.join(self.dir, 'state')):
            code, out = self.run_main(['--once'], FakeGitHubWithPulls(issues=[issue(4)]), FakeT3())
        self.assertEqual(code, 3)
        self.assertIn('already running', out)


    # --- the Sol lane alongside -------------------------------------------------------------

    def reviews_setup(self):
        gh = FakeGitHubForReviews(issues=[issue(4, 'Red widget', 'Make it red.')],
                                  prs=[full_pr(20, 'claude/blue-3', H2)],
                                  pulls_by_branch={'claude/red-widget-4': PR})
        git = FakeReviewGit(heads={20: H2})
        return gh, git, FakeSol([reply(findings=[important('F1')])])

    def test_once_runs_a_build_and_a_review_alongside(self):
        gh, git, sol = self.reviews_setup()
        code, out = self.run_main(['--once'], gh, FakeT3([(0, 'completed')]), git, sol=sol)
        self.assertEqual(code, 0)
        jobs = {j.kind: j for j in self.log.jobs()}
        self.assertEqual((jobs['build'].issue, jobs['build'].outcome), (4, 'done'))
        self.assertEqual((jobs['review'].issue, jobs['review'].outcome), (20, 'blocking'))
        self.assertIn('review first#20', out)

    def test_an_open_review_is_the_sol_lanes_to_settle_not_the_claude_lanes(self):
        self.log.started(kind='review', repo='first', issue=20, branch='claude/blue-3',
                         title='Queue runner review: first#20', sha='e' * 40, round=1)
        gh, git, sol = self.reviews_setup()
        self.run_main(['--once'], gh, FakeT3([(0, 'completed')]), git, sol=sol)
        review = next(j for j in self.log.jobs() if j.kind == 'review' and j.sha == 'e' * 40)
        self.assertEqual(review.outcome, 'failed')

    def test_review_one_pr_now(self):
        gh, git, sol = self.reviews_setup()
        code, out = self.run_main(['--review', 'first#20'], gh, FakeT3(), git, sol=sol)
        self.assertEqual(code, 0)
        [job] = self.log.jobs()
        self.assertEqual((job.kind, job.outcome), ('review', 'blocking'))
        self.assertIn('is blocking', out)
        code, out = self.run_main(['--review', 'first#20'], gh, FakeT3(), git, sol=sol)
        self.assertEqual(code, 1)
        self.assertIn('reviewed', out)   # already reviewed on that head

    def test_dry_run_also_says_which_prs_sol_would_review(self):
        gh, git, sol = self.reviews_setup()
        code, out = self.run_main(['--once', '--dry-run'], gh, FakeT3(), git, sol=sol)
        self.assertIn(f'would review #20 on {H2[:7]} (review 1)', out)
        self.assertEqual(sol.briefs, [])

    def test_dry_run_prints_the_fix_brief_for_a_blocking_pr_and_starts_nothing(self):
        gh, git, sol = self.reviews_setup()
        self.run_main(['--review', 'first#20'], gh, FakeT3(), git, sol=sol)   # blocking
        t3 = FakeT3()
        code, out = self.run_main(['--once', '--dry-run'], gh, t3, git, sol=sol)
        self.assertEqual(code, 0)
        self.assertIn('Would start a fix round (dry run: nothing started)', out)
        self.assertIn(f'from:   {H2[:7]} on claude/fix-pr20-{H2[:7]}, pushing to claude/blue-3',
                      out)
        self.assertIn('**F1** · Important', out)
        self.assertNotIn('Would start a build job', out)   # a fix round comes first
        self.assertIn('Merges (dry run: nothing merged):', out)
        self.assertEqual(t3.starts, [])
        self.assertEqual([j.kind for j in self.log.jobs()], ['review'])


UTC = datetime.timezone.utc
STOP = datetime.datetime(2026, 11, 8, 7, 34, tzinfo=UTC)
RESET = datetime.datetime(2026, 11, 9, 11, 0, tzinfo=UTC)
LIMIT_SAID = "You've hit your weekly limit · resets Nov 9, 7pm (Asia/Singapore)"


class LimitRecoveryTest(RunHarness):
    """A build or fix cut off by a usage limit (ticket 09): it waits until 10 minutes after the
    reset, then continues in place (about 50k tokens or less) or starts afresh. Fixed clocks."""

    def setUp(self):
        super().setUp()
        self.at = STOP
        self.clock = lambda: self.at
        self.gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)])

    def limited_build(self, t3, **limits):
        self.limits = FakeLimits(**limits)
        t3.messages['mcp:t1'] = [Message('assistant', LIMIT_SAID)]
        self.run_main(['--once'], self.gh, t3)
        return self.log.jobs()[0]

    def test_a_limit_stop_is_recorded_with_its_resume_time_and_context(self):
        job = self.limited_build(FakeT3([(1, 'failed')]), resets={'mcp:t1': RESET},
                                 contexts={'mcp:t1': 108_633})
        self.assertEqual((job.outcome, job.exit_code), ('usage-limit', 1))
        self.assertEqual(job.resume_at, '2026-11-09T11:10:00+00:00')
        self.assertEqual(job.context, 108_633)
        self.assertIn('stopped on a usage limit; T3 says it resets at', self.runner_log())

    def test_nothing_else_starts_until_ten_minutes_after_the_reset(self):
        t3 = FakeT3([(1, 'failed')])
        self.limited_build(t3, resets={'mcp:t1': RESET}, contexts={'mcp:t1': 20_000})
        self.at = RESET + datetime.timedelta(minutes=9)
        _, out = self.run_main(['--once'], self.gh, t3)
        self.assertEqual(len(t3.starts), 1)   # issue 5 waits too: the limit is the account's
        self.assertEqual(t3.sends, [])
        self.assertIn('Claude lane waits: build first#4 was cut off by a usage limit', out)

    def test_a_warm_thread_is_continued_in_place_at_any_size(self):
        # The limit reset 30 minutes after its last request started: 41 minutes idle at resume.
        t3 = FakeT3([(1, 'failed'), (0, 'completed')])
        old = self.limited_build(t3, resets={'mcp:t1': STOP + datetime.timedelta(minutes=30)},
                                 contexts={'mcp:t1': 300_000},
                                 starts={'mcp:t1': STOP - datetime.timedelta(minutes=1)})
        self.assertIn('stopped on a usage limit', self.runner_log())
        self.assertIn('(in place: warm (its last request started 41 min ago)', self.runner_log())
        self.at = STOP + datetime.timedelta(minutes=40)
        self.run_main(['--once'], self.gh, t3)
        self.assertEqual(len(t3.starts), 1)
        [sent] = t3.sends
        self.assertEqual(sent['thread_id'], 'mcp:t1')
        again = self.log.jobs()[1]
        self.assertEqual((again.about, again.thread_id), (old.id, 'mcp:t1'))
        self.assertEqual(again.resume, {
            'how': 'in-place', 'idle_minutes': 41, 'context': 300_000,
            'last_request': '2026-11-08T07:33:00+00:00',
            'why': 'warm (its last request started 41 min ago): continuing it in place is '
                   'cheaper at any size'})
        self.assertIn('Continuing build first#4 in place: warm (its last request started 41 '
                      'min ago)', self.runner_log())

    def test_the_stop_records_its_last_request_and_a_dry_run_says_the_choice(self):
        t3 = FakeT3([(1, 'failed')])
        job = self.limited_build(t3, resets={'mcp:t1': STOP + datetime.timedelta(minutes=30)},
                                 contexts={'mcp:t1': 300_000},
                                 starts={'mcp:t1': STOP - datetime.timedelta(minutes=1)})
        self.assertEqual(job.last_request, '2026-11-08T07:33:00+00:00')
        _, out = self.run_main(['--once', '--dry-run'], self.gh, t3)
        self.assertIn('the runner would continue its thread in place (warm (its last request '
                      'started 41 min ago)', out)

    def test_a_cold_thread_under_120k_tokens_is_continued_in_place(self):
        t3 = FakeT3([(1, 'failed'), (0, 'completed')])
        self.limited_build(t3, resets={'mcp:t1': RESET}, contexts={'mcp:t1': 119_999},
                           starts={'mcp:t1': STOP})
        self.at = RESET + datetime.timedelta(minutes=10)
        self.run_main(['--once'], self.gh, t3)
        self.assertEqual([s['thread_id'] for s in t3.sends], ['mcp:t1'])
        self.assertEqual(self.log.jobs()[1].resume['how'], 'in-place')

    def test_a_small_thread_is_continued_in_place_after_the_reset(self):
        t3 = FakeT3([(1, 'failed'), (0, 'completed')])
        old = self.limited_build(t3, resets={'mcp:t1': RESET}, contexts={'mcp:t1': 50_000})
        self.at = RESET + datetime.timedelta(minutes=10)
        self.run_main(['--once'], self.gh, t3)
        self.assertEqual(len(t3.starts), 1)
        [sent] = t3.sends
        self.assertEqual(sent['thread_id'], 'mcp:t1')
        self.assertIn('usage limit that stopped you has reset', sent['message'])
        again = self.log.jobs()[1]
        self.assertEqual((again.kind, again.issue, again.about, again.thread_id),
                         ('build', 4, old.id, 'mcp:t1'))
        self.assertEqual(again.outcome, 'done-no-pr')
        self.assertEqual(self.log.limited_jobs(), [])

    def test_a_cold_big_thread_restarts_fresh_on_its_branch_at_its_newest_commit(self):
        t3 = FakeT3([(1, 'failed'), (0, 'completed')])
        git = FakeGit()
        git.tips = {'claude/a-ticket-4': 'abc1234def'}
        self.limits = FakeLimits(contexts={'mcp:t1': 120_000},   # no reset stored
                                 starts={'mcp:t1': STOP})
        t3.messages['mcp:t1'] = [Message('user', 'Go.'), Message('assistant', LIMIT_SAID)]
        self.run_main(['--once'], self.gh, t3, git)
        old = self.log.jobs()[0]
        # No reset known: 5h05m from the stop, then 10 minutes more.
        self.assertEqual(old.resume_at, '2026-11-08T12:49:00+00:00')
        self.at = STOP + datetime.timedelta(hours=5, minutes=14)
        self.run_main(['--once'], self.gh, t3, git)
        self.assertEqual(len(t3.starts), 1)
        self.at = STOP + datetime.timedelta(hours=5, minutes=15)
        self.run_main(['--once'], self.gh, t3, git)
        self.assertEqual(t3.sends, [])
        fresh = t3.starts[1]
        self.assertEqual((fresh['worktree'], fresh['branch'], fresh['title']),
                         ('abc1234def', 'claude/a-ticket-4', 'Queue runner build: first#4'))
        self.assertTrue(fresh['message'].startswith('Build GitHub issue #4 in owner/first'))
        self.assertIn('## Picking up from an earlier thread', fresh['message'])
        self.assertIn('cut off by a usage limit', fresh['message'])
        self.assertIn('cold (its last request started 5 h 15 min ago) and 120,000 tokens',
                      fresh['message'])
        self.assertIn(old.link, fresh['message'])
        self.assertIn(LIMIT_SAID, fresh['message'])
        self.assertIn('at `abc1234`', fresh['message'])
        self.assertEqual(git.freed, [('claude/a-ticket-4', 'C:/t3/worktrees/mcp:t1')])
        again = self.log.jobs()[1]
        self.assertEqual((again.about, again.thread_id, again.outcome), (old.id, 'mcp:t2',
                                                                         'done-no-pr'))
        self.assertEqual((again.resume['how'], again.resume['idle_minutes'],
                          again.resume['context']), ('fresh', 315, 120_000))
        self.assertIn('Restarting build first#4 fresh after the usage limit (cold (its last '
                      'request started 5 h 15 min ago) and 120,000 tokens', self.runner_log())

    def test_any_other_failure_is_not_a_limit_stop(self):
        t3 = FakeT3([(1, 'failed')])
        t3.messages['mcp:t1'] = [Message('assistant', 'The type checker keeps failing.')]
        self.run_main(['--once'], self.gh, t3)
        self.assertEqual(self.log.jobs()[0].outcome, 'failed')

    def test_the_runner_warns_at_start_if_t3_resumes_limited_threads_itself(self):
        with open(os.path.join(self.dir, 't3.json'), 'w', encoding='utf-8') as f:
            f.write('{"autoResumeLimitedThreads": true}')
        _, out = self.run_main(['--once'], self.gh, FakeT3([(0, 'completed')]))
        self.assertIn('Warning: T3\'s "Resume after usage limits" is on', out)
        self.assertIn('Resume after usage limits', self.runner_log())

    def test_t3s_record_of_another_failure_wins_over_a_limit_message(self):
        job = self.limited_build(FakeT3([(1, 'failed')]), failures={'mcp:t1': 'provider_error'})
        self.assertEqual(job.outcome, 'failed')

    def test_an_earlier_runs_limit_message_doesnt_make_a_later_failure_a_limit_stop(self):
        t3 = FakeT3([(1, 'failed')])
        t3.messages['mcp:t1'] = [Message('assistant', LIMIT_SAID, 'run:mcp:t1:0')]
        self.run_main(['--once'], self.gh, t3)   # this run is run:mcp:t1:1 and said nothing
        self.assertEqual(self.log.jobs()[0].outcome, 'failed')

    def test_a_restart_that_cant_be_made_holds_the_job_and_isnt_tried_again(self):
        from queue_runner.git import GitError
        t3 = FakeT3([(1, 'failed')])
        git = FakeGit()
        git.tips = GitError('the old worktree could not be removed')
        self.limits = FakeLimits(resets={'mcp:t1': RESET})   # context unknown: fresh
        t3.messages['mcp:t1'] = [Message('assistant', LIMIT_SAID)]
        self.run_main(['--once'], self.gh, t3, git)
        old = self.log.jobs()[0]
        self.at = RESET + datetime.timedelta(minutes=11)
        self.run_main(['--once'], self.gh, t3, git)
        failed = self.log.jobs()[1]
        self.assertEqual((failed.about, failed.outcome), (old.id, 'restart-failed'))
        self.assertIn('could not be removed', failed.error)
        self.assertEqual(self.log.writer('first', old.branch).id, old.id)   # still held
        self.assertEqual([t['title'] for t in self.toaster.toasts], ['first #4 needs you'])
        t3.outcomes.append((0, 'completed'))
        self.run_main(['--once'], self.gh, t3, git)   # not tried again: issue 5 builds
        self.assertEqual([s['branch'] for s in t3.starts], ['claude/a-ticket-4',
                                                             'claude/a-ticket-5'])

    def test_claude_codes_limit_message_is_enough_when_t3_recorded_nothing(self):
        job = self.limited_build(FakeT3([(1, 'failed')]))
        self.assertEqual((job.outcome, job.context), ('usage-limit', None))


if __name__ == '__main__':
    unittest.main()
