"""The job log: what ran and what's open, read back the way a restarted runner reads it."""
import datetime
import os
import tempfile
import unittest

from queue_runner.state import JobLog, when


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

    def test_a_record_torn_by_a_crash_is_dropped_and_later_records_still_read(self):
        log = JobLog(self.path)
        job = self.start(log, 4)
        with open(self.path, 'a', encoding='utf-8') as f:
            f.write('{"event": "end", "job": "' + job.id + '", "exit')   # the crash
        self.assertEqual([j.id for j in JobLog(self.path).open_jobs()], [job.id])
        self.start(JobLog(self.path), 5)
        self.assertEqual([j.issue for j in JobLog(self.path).open_jobs()], [4, 5])

    def test_a_broken_record_mid_log_is_an_error(self):
        log = JobLog(self.path)
        self.start(log, 4)
        with open(self.path, 'a', encoding='utf-8') as f:
            f.write('not json\n')
        self.start(log, 5)
        with self.assertRaises(ValueError):
            JobLog(self.path).jobs()


    def test_a_record_torn_inside_a_multibyte_character_is_dropped(self):
        log = JobLog(self.path)
        job = self.start(log, 4)
        with open(self.path, 'ab') as f:
            f.write(b'{"event": "end", "error": "caf\xc3')   # the crash, mid-character
        self.assertEqual([j.id for j in JobLog(self.path).open_jobs()], [job.id])

    def test_a_released_waiting_job_stays_released_when_its_issue_is_built_again(self):
        log = JobLog(self.path)
        self.end(log, self.start(log, 4), exit_code=2, outcome='waiting', status='waiting')
        log.released('first', 4)
        self.end(log, self.start(log, 4), exit_code=0, outcome='done')
        self.assertEqual(JobLog(self.path).waiting_jobs(), [])

    def test_an_old_live_runs_records_still_read_as_an_ended_job(self):
        """The live steps after merges went (#265); leads-dashboard's live runs stay in the log,
        their end records with `applied` and `prs`."""
        import json
        log = JobLog(self.path)
        self.start(log, 4)
        job = '20261110-211802-live-leads-dashboard-179-8692e3'
        with open(self.path, 'a', encoding='utf-8') as f:
            for r in ({'event': 'start', 'job': job, 'kind': 'live', 'repo': 'leads-dashboard',
                       'issue': 179, 'branch': 'main', 'title': 'Queue runner live: leads-dashboard',
                       'at': '2026-11-10T21:18:02+08:00', 'sha': 'ff58c6d', 'round': None,
                       'head': '1c6808d'},
                      {'event': 'end', 'job': job, 'at': '2026-11-10T21:18:46+08:00',
                       'exit_code': 0, 'outcome': 'live', 'thread_id': 'mcp:t9',
                       'status': 'completed', 'applied': [], 'prs': [179], 'reason': None,
                       'error': None}):
                f.write(json.dumps(r) + '\n')
        reopened = JobLog(self.path)
        [live] = [j for j in reopened.jobs() if j.id == job]
        self.assertEqual((live.kind, live.repo, live.issue, live.outcome, live.head, live.open),
                         ('live', 'leads-dashboard', 179, 'live', '1c6808d', False))
        self.assertEqual([j.issue for j in reopened.open_jobs()], [4])
        self.assertEqual(reopened.held_issues('leads-dashboard'), set())
        from queue_runner import snapshot
        snap = snapshot.build(snapshot.Facts(
            now=datetime.datetime(2026, 11, 22, tzinfo=datetime.timezone.utc), repos=[],
            jobs=reopened.jobs()))
        claude = next(l for l in snap['lanes'] if l['id'] == 'claude')
        self.assertEqual([j['kind'] for j in claude['jobs']], ['build'])   # the live run ended


class WhenTest(unittest.TestCase):
    def test_a_stamp_keeps_its_offset(self):
        self.assertEqual(when('2026-11-16T05:40:00Z'),
                         datetime.datetime(2026, 11, 16, 5, 40, tzinfo=datetime.timezone.utc))

    def test_a_stamp_with_no_offset_is_local_time_and_compares_with_any_aware_time(self):
        # The wake sync raised on one (TypeError: offset-naive and offset-aware) on 2026-11-16.
        t = when('2026-11-16T13:40:00')
        self.assertEqual(t, datetime.datetime(2026, 11, 16, 13, 40).astimezone())
        self.assertIsInstance(t > datetime.datetime.now(datetime.timezone.utc), bool)


if __name__ == '__main__':
    unittest.main()
