"""PR #137's review 1: what a provider being out of usage is read from (F4), and which providers
a Claude-lane job really runs on, for the gate and for who's out (F1)."""
import dataclasses
import datetime
import io
import os
import tempfile
import unittest

from queue_runner.config import Repo
from queue_runner.decisions import Case
from queue_runner.gate import Gate
from queue_runner.run import Runner
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubWithPulls, FakeUsage
from tests.fakes_t3 import FakeGit, FakeT3
from tests.test_jobs_run import CODEX_BUILD, OPUS, Harness, full_usage
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



class InvokedProvidersTest(Harness):
    """F1: the gate, and whether a job's providers have usage, go by the threads its run starts
    or continues, not by what `[jobs]` names for its kind now. Claude's 5-hour window is full,
    so any job that runs a Claude thread is held."""

    def setUp(self):
        super().setUp()
        self.first = Repo(name='first', github='owner/first', path=self.dir)

    def runner(self, gate=True):
        self.t3 = FakeT3([(0, 'completed')])
        g = Gate(self.config.state_dir, FakeUsage(full_usage()),
                 clock=lambda: datetime.datetime(2026, 11, 16, 8, 0, tzinfo=UTC)) if gate else None
        return Runner(self.config, github=FakeGitHubWithPulls(issues=[]), t3=self.t3,
                      git=FakeGit(), out=io.StringIO(), log_line=self.said.append, gate=g)

    def claude_build(self, outcome, **end):
        """An earlier build in `first` on Claude, ended `outcome`."""
        job = self.jobs.started(kind='build', repo='first', issue=4, branch='claude/b-4',
                                title='Queue runner build: first#4', provider='claudeAgent',
                                model='claude-opus-5-5', effort='high')
        self.jobs.ended(job.id, exit_code=1, outcome=outcome, thread_id='mcp:old', **end)
        return self.jobs.jobs()[-1]

    def a_retry_case(self, r, build):
        """The decider has a case on `build` it may retry."""
        case = Case(question='failed', repo=self.first, number=4, about=build)
        r.decider.next_case = lambda repos=None: case
        r.decider.run = lambda case, cont: self.fail('the decision ran')

    def test_a_codex_decision_that_may_retry_a_claude_build_is_gated(self):
        # Sol's scenario: the decision is on Codex, the build it may continue on Claude.
        self.configure([self.first], decision=CODEX_BUILD)
        r = self.runner()
        self.a_retry_case(r, self.claude_build('failed'))
        [start] = r.choose()
        self.assertEqual(start.on, ('codex', 'claudeAgent', 'claudeAgent'))
        self.assertEqual(r.run_pass(), 'gated')

    def test_a_claude_build_picked_up_after_its_limit_is_gated_once_builds_are_on_codex(self):
        # Its reset has passed, and [jobs.build] is Codex now: in place it runs on Claude.
        self.configure([self.first], build=CODEX_BUILD)
        r = self.runner()
        self.claude_build('usage-limit', resume_at='2026-11-16T07:00:00+00:00')
        [start] = r.choose()
        self.assertEqual(start.on, ('claudeAgent', 'codex'))
        self.assertEqual(r.run_pass(), 'gated')
        self.assertEqual((self.t3.starts, self.t3.sends), ([], []))

    def test_a_reply_to_a_waiting_claude_build_waits_while_claude_is_out(self):
        # A second case of the class: whether a job's providers have usage. Claude is out (a
        # live run elsewhere met its limit), builds are on Codex, and Stefan answered a
        # waiting Claude build: continuing it in place would run on Claude.
        self.configure([self.first], build=dataclasses.replace(CODEX_BUILD))
        live = self.jobs.started(kind='live', repo='second', issue=1, branch='main', title='t',
                                 provider='claudeAgent')
        self.jobs.ended(live.id, exit_code=1, outcome='usage-limit', resume_at=AHEAD)
        r = self.runner(gate=False)
        build = self.claude_build('waiting')
        r.answers.next = lambda repos=None: (build, 'Use red.', {})
        self.assertEqual(r.choose(), 'idle')
        self.assertEqual((self.t3.starts, self.t3.sends), ([], []))

    def test_a_codex_decision_with_nothing_to_continue_is_not_gated(self):
        self.configure([self.first], decision=CODEX_BUILD)
        r = self.runner()
        case = Case(question='approach-note', repo=self.first, number=4,
                    about=self.claude_build('failed'))
        r.decider.next_case = lambda repos=None: case
        r.decider.run = lambda case, cont: 'started'
        self.assertEqual(r.choose()[0].on, ('codex',))
        self.assertEqual(r.run_pass(), 'started')


class ThreadModelTest(unittest.TestCase):
    """F3's class elsewhere: the work lists name a review thread by the model it ran on."""

    def review(self, model, outcome=None):
        from queue_runner.state import Job
        return Job(id='r', kind='review', repo='first', issue=20, branch='b', title='t',
                   started_at='2026-11-16T16:00:00+00:00', sha=H2, reviewer='opus-config',
                   model=model, outcome=outcome)

    def test_a_fable_review_thread_is_named_fable(self):
        from queue_runner.work import _other
        self.assertEqual(_other(self.review('claude-fable-5-2', 'failed')),
                         f'The Fable 5.2 review of {H2[:7]} failed.')

    def test_a_record_from_before_120_is_opus(self):
        from queue_runner.fallback import thread_model
        self.assertEqual(thread_model(self.review(None)), 'Opus')


UTC = datetime.timezone.utc


if __name__ == '__main__':
    unittest.main()
