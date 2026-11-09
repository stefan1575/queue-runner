"""The job log: what ran and what's open, read back the way a restarted runner reads it."""
import os
import tempfile
import unittest

from queue_runner.state import JobLog


class JobLogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, 'state', 'jobs.jsonl')

    def start(self, log, issue=4, repo='first'):
        return log.started(kind='build', repo=repo, issue=issue, branch=f'claude/x-{issue}',
                           title=f'Queue runner build: {repo}#{issue}')

    def end(self, log, job, exit_code=0, outcome='done', **extra):
        fields = dict(thread_id='mcp:t1', link='https://app.t3.codes/threads/x/mcp%3At1',
                      run_id='run:1', status='completed', commits=[], pr=None,
                      worktree=None, error=None)
        fields.update(extra)
        log.ended(job.id, exit_code=exit_code, outcome=outcome, **fields)

    def test_a_started_job_is_open_after_a_restart(self):
        job = self.start(JobLog(self.path))
        reopened = JobLog(self.path)
        self.assertEqual([j.id for j in reopened.open_jobs()], [job.id])
        self.assertEqual(reopened.held_issues('first'), {4})

    def test_an_ended_job_keeps_its_record(self):
        log = JobLog(self.path)
        job = self.start(log)
        self.end(log, job, commits=[{'sha': 'abc', 'subject': 'Add a line'}],
                 pr={'number': 7, 'url': 'https://github.com/o/r/pull/7', 'state': 'open'})
        [done] = JobLog(self.path).jobs()
        self.assertEqual(JobLog(self.path).open_jobs(), [])
        self.assertEqual((done.kind, done.repo, done.issue, done.thread_id, done.exit_code,
                          done.outcome), ('build', 'first', 4, 'mcp:t1', 0, 'done'))
        self.assertEqual(done.pr['number'], 7)
        self.assertEqual(done.commits[0]['subject'], 'Add a line')
        self.assertTrue(done.started_at <= done.ended_at)

    def test_a_failed_or_waiting_job_holds_its_issue_until_released(self):
        log = JobLog(self.path)
        self.end(log, self.start(log, 4), exit_code=1, outcome='failed', status='interrupted')
        self.end(log, self.start(log, 5), exit_code=2, outcome='waiting', status='waiting')
        self.assertEqual(JobLog(self.path).held_issues('first'), {4, 5})
        self.assertEqual([j.issue for j in JobLog(self.path).waiting_jobs()], [5])
        log.released('first', 4)
        self.assertEqual(JobLog(self.path).held_issues('first'), {5})

    def test_a_job_that_never_started_a_thread_holds_nothing(self):
        log = JobLog(self.path)
        self.end(log, self.start(log), exit_code=1, outcome='not-started', thread_id=None,
                 status=None, error='T3 server not running')
        self.assertEqual(JobLog(self.path).held_issues('first'), set())

    def test_holds_are_per_repo(self):
        log = JobLog(self.path)
        self.start(log, 4, repo='first')
        self.assertEqual(JobLog(self.path).held_issues('second'), set())

    def test_a_later_end_record_updates_the_job(self):
        log = JobLog(self.path)
        job = self.start(log, 5)
        self.end(log, job, exit_code=2, outcome='waiting', status='waiting')
        self.end(log, job, exit_code=0, outcome='done')
        [j] = JobLog(self.path).jobs()
        self.assertEqual(j.outcome, 'done')
        self.assertEqual(JobLog(self.path).waiting_jobs(), [])

    def test_an_issue_started_again_after_release_is_held_again(self):
        log = JobLog(self.path)
        self.end(log, self.start(log, 4), exit_code=1, outcome='failed')
        log.released('first', 4)
        self.start(log, 4)
        self.assertEqual(JobLog(self.path).held_issues('first'), {4})


if __name__ == '__main__':
    unittest.main()
