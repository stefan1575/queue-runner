"""The run loop through its command line: `--once`, the continuous mode and `--release`, with
GitHub, T3 and git faked."""
import io
import os
import tempfile
import unittest

from queue_runner.cli import main
from queue_runner.state import JobLog
from queue_runner.t3 import T3Error
from tests.fakes import FakeGitHubForReviews, FakeGitHubWithPulls, FakeToaster, full_pr, issue
from tests.fakes_t3 import FakeGit, FakeReviewGit, FakeSol, FakeT3
from tests.test_ledger import H2, important, reply

PR = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}


class Stop(Exception):
    pass


class RunTest(unittest.TestCase):
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

[claude]
provider = "claudeAgent"
model = "claude-opus-5-5"

[[repos]]
name = "first"
github = "owner/first"
path = "{self.dir}"
''')
        self.log = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))

    def run_main(self, args, github, t3, git=None, sleep=None, sol=None):
        out = io.StringIO()
        self.toaster = FakeToaster()   # a waiting job toasts: never a real one in tests
        code = main(args + ['--config', self.config], github=github, out=out, t3=t3,
                    git=git or FakeGit(), sleep=sleep or (lambda s: None), sol=sol or FakeSol(),
                    toaster=self.toaster)
        return code, out.getvalue()

    def runner_log(self):
        with open(os.path.join(self.dir, 'logs', 'runner.log'), encoding='utf-8') as f:
            return f.read()

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
        self.assertTrue(start['message'].startswith('/implement GitHub issue #4 in owner/first'))
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
        t3 = FakeT3([(1, 'interrupted'), (0, 'completed')])
        self.run_main(['--once'], gh, t3)
        self.run_main(['--once'], gh, t3)
        self.assertEqual([s['branch'] for s in t3.starts], ['claude/a-ticket-4', 'claude/a-ticket-5'])
        failed = self.log.jobs()[0]
        self.assertEqual((failed.issue, failed.exit_code, failed.outcome, failed.status),
                         (4, 1, 'failed', 'interrupted'))
        self.assertEqual(failed.error, 'It broke.')

    def test_a_run_waiting_for_an_answer_holds_its_issue(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
        t3 = FakeT3([(2, 'waiting')])
        self.run_main(['--once'], gh, t3)
        code, out = self.run_main(['--once'], gh, t3)
        self.assertEqual(len(t3.starts), 1)
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
        gh = FakeGitHubWithPulls(issues=[issue(4)])

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
        self.assertEqual((job.thread_id, job.exit_code, job.outcome), ('mcp:t1', 0, 'done-no-pr'))

    def test_a_job_still_running_from_a_dead_runner_blocks_a_second_claude_job(self):
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)])
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
        gh = FakeGitHubWithPulls(issues=[issue(4), issue(5)])
        self.run_main(['--once'], gh, FakeT3([(1, 'failed')]))
        code, out = self.run_main(['--once', '--dry-run'], gh, FakeT3())
        self.assertIn('#5 A ticket', out)

    def test_continuous_mode_runs_pass_after_pass_and_sleeps_when_idle(self):
        gh = FakeGitHubWithPulls(issues=[issue(4)])
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


if __name__ == '__main__':
    unittest.main()
