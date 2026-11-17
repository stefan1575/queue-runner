"""PR #137's review 1: what a provider being out of usage is read from (F4), and which providers
a Claude-lane job really runs on, for the gate and for who's out (F1)."""
import datetime
import os
import tempfile
import unittest

from queue_runner.state import JobLog
from tests.test_ledger import H2

NOW = datetime.datetime(2026, 11, 16, 16, 0, tzinfo=datetime.timezone.utc)
AHEAD = '2099-01-01T00:00:00+00:00'


class OutUntilTest(unittest.TestCase):
    """F4: a provider is out while any job on it met a usage limit whose reset is ahead, not only
    while a build or fix is left to recover."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.jobs = JobLog(os.path.join(tmp.name, 'jobs.jsonl'))

    def limited(self, kind, provider, repo='first', issue=20):
        job = self.jobs.started(kind=kind, repo=repo, issue=issue, branch='main', title='t',
                                sha=H2, provider=provider, model='m', effort='high')
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit', resume_at=AHEAD)
        return job

    def test_a_live_run_cut_off_by_a_limit_has_its_provider_out(self):
        self.limited('live', 'codex')
        self.assertIsNotNone(self.jobs.out_until('codex', NOW))
        self.assertIsNone(self.jobs.out_until('claudeAgent', NOW))

    def test_a_released_build_cut_off_by_a_limit_still_has_its_provider_out(self):
        # Stefan's release settles the job, not the provider's limit.
        self.limited('build', 'claudeAgent', issue=4)
        self.jobs.released('first', 4)
        self.assertEqual(self.jobs.limited_jobs(), [])
        self.assertIsNotNone(self.jobs.out_until('claudeAgent', NOW))

    def test_a_limit_whose_reset_has_passed_leaves_its_provider_in(self):
        job = self.jobs.started(kind='live', repo='first', issue=20, branch='main', title='t',
                                provider='codex')
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit',
                        resume_at='2026-11-16T15:00:00+00:00')
        self.assertIsNone(self.jobs.out_until('codex', NOW))


if __name__ == '__main__':
    unittest.main()
