"""Issue #120: each job kind runs on the provider, model and effort config.toml's `[jobs]` gives
it, through the real Runner and Reviewer with GitHub, T3 and git faked: a build on Codex end to
end, a kind's fallback while its provider is out of usage, a review on Claude as a T3 thread and
on Codex through the Codex adapter, and the fallback's model named on the PR."""
import dataclasses
import datetime
import io
import os
import tempfile
import unittest

from queue_runner.config import DEFAULT_JOBS, Config, JobSpec, Repo
from queue_runner.effort import Effort
from queue_runner.fallback import ThreadReviews
from queue_runner.gate import Gate
from queue_runner.github import Issue
from queue_runner.review import Reviewer
from queue_runner.run import Runner
from queue_runner.sol import SolCli
from queue_runner.state import JobLog
from queue_runner.usage import Usage, Window
from tests.fakes import FakeGitHubForReviews, FakeGitHubWithPulls, FakeUsage, full_pr, issue
from tests.fakes_t3 import FakeGit, FakeReviewGit, FakeSol, FakeT3
from tests.test_effort import FakeFiles, named
from tests.test_ledger import H2, H3, reply

UTC = datetime.timezone.utc
CODEX_BUILD = JobSpec('codex', 'gpt-6.1-sol', 'xhigh')
OPUS = JobSpec('claudeAgent', 'claude-opus-5-5', 'medium')
FABLE = JobSpec('claudeAgent', 'claude-fable-5-2', 'xhigh')


def full_usage(five=100):
    """Claude's usage with the 5-hour window `five` percent used."""
    return Usage(Window(five, datetime.datetime(2026, 11, 16, 20, 0, tzinfo=UTC)),
                 Window(10, datetime.datetime(2026, 11, 20, 0, 0, tzinfo=UTC)))


class Harness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.said = []

    def configure(self, repos, **jobs):
        self.config = Config(repos=repos, state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'),
                             jobs={**DEFAULT_JOBS, **jobs})
        self.jobs = JobLog(os.path.join(self.config.state_dir, 'jobs.jsonl'))

    def of(self, kind):
        return [j for j in self.jobs.jobs() if j.kind == kind]


class BuildOnCodexTest(Harness):
    def runner(self, gate=None, files=None):
        self.repo = Repo(name='first', github='owner/first', path=self.dir)
        pr = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}
        self.gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.')],
                                      pulls_by_branch={'claude/red-widget-4': pr})
        self.t3 = FakeT3([(0, 'completed')])
        return Runner(self.config, github=self.gh, t3=self.t3, git=FakeGit(), out=io.StringIO(),
                      log_line=self.said.append, gate=gate,
                      effort=Effort(self.config, files=files))

    def test_a_build_on_codex_runs_end_to_end(self):
        self.configure([Repo(name='first', github='owner/first', path=self.dir)],
                       build=CODEX_BUILD)
        r = self.runner(files=FakeFiles(efforts={'mcp:t1': 'xhigh'}))
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        # The brief and branch as any build's, its thread on Codex.
        self.assertEqual(named(start), ('codex', 'gpt-6.1-sol', 'xhigh'))
        self.assertEqual((start['title'], start['worktree'], start['branch']),
                         ('Queue runner build: first#4', 'origin/main', 'claude/red-widget-4'))
        self.assertIn('Make it red.', start['message'])
        [build] = self.of('build')
        self.assertEqual((build.outcome, build.pr['number'], build.provider, build.model,
                          build.effort), ('done', 12, 'codex', 'gpt-6.1-sol', 'xhigh'))

    def test_a_build_on_codex_is_not_held_by_claudes_usage_gate(self):
        # The gate reads Claude's usage: a full 5-hour window holds a Claude build, not this.
        self.configure([Repo(name='first', github='owner/first', path=self.dir)],
                       build=CODEX_BUILD)
        gate = Gate(self.config.state_dir, FakeUsage(full_usage()),
                    clock=lambda: datetime.datetime(2026, 11, 16, 8, 0, tzinfo=UTC))
        self.assertEqual(self.runner(gate=gate).run_pass(), 'started')
        self.assertEqual(named(self.t3.starts[0])[0], 'codex')

    def test_a_build_on_claude_is_held_by_the_gate(self):
        self.configure([Repo(name='first', github='owner/first', path=self.dir)])
        gate = Gate(self.config.state_dir, FakeUsage(full_usage()),
                    clock=lambda: datetime.datetime(2026, 11, 16, 8, 0, tzinfo=UTC))
        self.assertEqual(self.runner(gate=gate).run_pass(), 'gated')


class FallbackKindTest(Harness):
    """A kind with a fallback runs on it while its own provider is out of usage."""

    def setUp(self):
        super().setUp()
        self.first = Repo(name='first', github='owner/first', path=self.dir)
        self.second = Repo(name='second', github='owner/second', path=self.dir + '-2')

    def cut_off(self, provider='claudeAgent'):
        """A fix in `first` was cut off by `provider`'s usage limit, its reset far ahead."""
        job = self.jobs.started(kind='fix', repo='first', issue=20, branch='b', title='t',
                                sha=H2, provider=provider, model='m', effort='high')
        self.jobs.ended(job.id, exit_code=1, outcome='usage-limit',
                        resume_at='2099-01-01T00:00:00+00:00')

    def runner(self):
        gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.')])
        self.t3 = FakeT3([(0, 'completed')])
        return Runner(self.config, github=gh, t3=self.t3, git=FakeGit(), out=io.StringIO(),
                      log_line=self.said.append)

    def test_a_build_runs_on_its_fallback_while_claude_is_out(self):
        # `first`'s own job was cut off: it waits for that job's reset; `second` builds.
        self.configure([self.first, self.second],
                       build=dataclasses.replace(OPUS, fallback=CODEX_BUILD))
        self.cut_off()
        r = self.runner()
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual(named(start), ('codex', 'gpt-6.1-sol', 'xhigh'))
        [build] = self.of('build')
        self.assertEqual((build.repo, build.provider), ('second', 'codex'))

    def test_without_a_fallback_the_lane_waits_for_the_reset(self):
        self.configure([self.second], build=OPUS)
        self.cut_off()
        self.assertEqual(self.runner().run_pass(), 'gated')
        self.assertEqual(self.t3.starts, [])

    def test_once_the_provider_is_back_the_kind_runs_on_its_own(self):
        self.configure([self.second], build=dataclasses.replace(OPUS, fallback=CODEX_BUILD))
        self.cut_off(provider='codex')   # Codex is out, not Claude
        self.assertEqual(self.runner().run_pass(), 'started')
        self.assertEqual(named(self.t3.starts[0]), ('claudeAgent', 'claude-opus-5-5', 'medium'))


class ReviewTest(Harness):
    def setUp(self):
        super().setUp()
        self.repo = Repo(name='first', github='owner/first', path=self.dir, review_table=True)
        self.gh = FakeGitHubForReviews(
            prs=[full_pr(20, 'claude/red-5', H2, body='Closes #5', title='Red widget',
                         base='main')],
            comments={5: []}, issue_bodies={('owner/first', 5): Issue(5, 'Red', 'Make it red.')})
        self.git = FakeReviewGit(heads={20: H2}, files={'AGENTS.md': '# Agents'})

    def reviewer(self, *outcomes, sol=None, now=datetime.datetime(2026, 11, 16, 16, 0)):
        self.t3 = FakeT3(list(outcomes))
        self.sol = sol if sol is not None else FakeSol([])
        return Reviewer(self.config, github=self.gh, git=self.git, sol=self.sol, jobs=self.jobs,
                        say=self.said.append, now=lambda: now, merger=False,
                        fallback=ThreadReviews(self.config, t3=self.t3))

    def posted(self, kind):
        return [p for p in self.gh.posts if p[0] == kind]

    def test_a_review_on_claude_runs_as_a_t3_thread_at_its_model_and_effort(self):
        self.configure([self.repo], review=FABLE)
        self.reviewer((0, 'completed', reply())).review_pass()
        self.assertEqual(self.sol.briefs, [])
        [start] = self.t3.starts
        self.assertEqual(named(start), ('claudeReviewer', 'claude-fable-5-2', 'xhigh'))   # the no-tools instance (PR #127)
        [job] = self.of('review')
        self.assertEqual((job.provider, job.model, job.effort),
                         ('claudeAgent', 'claude-fable-5-2', 'xhigh'))
        [(_, _, body)] = self.posted('comment')
        self.assertIn('Fable 5.2 xhigh, set in config.toml', body)

    def test_a_review_on_codex_runs_through_the_codex_adapter_at_its_model_and_effort(self):
        self.configure([self.repo], review=JobSpec('codex', 'gpt-7-sol', 'xhigh'))
        from queue_runner.sol import codex_adapter
        calls = []

        def run(cmd, out, timeout):
            calls.append(cmd)
            reply_path = cmd[-2]
            with open(reply_path, 'w', encoding='utf-8') as f:
                f.write(reply())
            return 0

        sol = codex_adapter(self.config, run=run)
        self.reviewer(sol=sol).review_pass()
        self.assertEqual(self.t3.starts, [])
        [cmd] = calls
        i = cmd.index('--model')
        self.assertEqual(cmd[i:i + 4], ['--model', 'gpt-7-sol', '--effort', 'xhigh'])
        [job] = self.of('review')
        self.assertEqual((job.provider, job.model, job.effort, job.outcome),
                         ('codex', 'gpt-7-sol', 'xhigh', 'clean'))
        # The comment and the Review row say what it ran at (PR #137's review 1, F3).
        [(_, _, body)] = self.posted('comment')
        self.assertIn('<sub>GPT-7 Sol at effort xhigh, read-only, on ', body)
        self.assertNotIn('GPT-6.1', body)
        self.assertTrue(body.startswith('## Sol review 1 · Clean\n'), body[:80])
        [(_, _, pr_body)] = self.posted('body')
        row = next(line for line in pr_body.splitlines() if line.startswith('| ['))
        self.assertTrue(row.startswith('| [Sol review 1, GPT-7 Sol xhigh](https://'), row)

    def run_codex(self, calls):
        def run(cmd, out, timeout):
            calls.append(cmd)
            with open(cmd[-2], 'w', encoding='utf-8') as f:
                f.write(reply())
            return 0
        return run

    def test_a_review_on_claude_falls_back_to_sol_while_claude_is_out(self):
        # PR #137's review 1, F2: Sol as a Claude review's fallback, at the fallback's model
        # and effort, and the PR says why Sol reviewed.
        from queue_runner.sol import codex_adapter
        self.configure([self.repo], review=dataclasses.replace(
            OPUS, fallback=JobSpec('codex', 'gpt-7-sol', 'xhigh')))
        cut = self.jobs.started(kind='fix', repo='other', issue=3, branch='b', title='t',
                                provider='claudeAgent')
        self.jobs.ended(cut.id, exit_code=1, outcome='usage-limit',
                        resume_at='2099-01-01T00:00:00+00:00')
        calls = []
        self.reviewer(sol=codex_adapter(self.config, run=self.run_codex(calls))).review_pass()
        self.assertEqual(self.t3.starts, [])   # no Claude thread
        [cmd] = calls
        i = cmd.index('--model')
        self.assertEqual(cmd[i:i + 4], ['--model', 'gpt-7-sol', '--effort', 'xhigh'])
        [job] = self.of('review')
        self.assertEqual((job.provider, job.model, job.effort), ('codex', 'gpt-7-sol', 'xhigh'))
        label = 'GPT-7 Sol xhigh, fallback while Opus 5.5 is out'
        [(_, _, body)] = self.posted('comment')
        self.assertTrue(body.startswith(f'## Sol review 1 · Clean · {label}\n'), body[:120])
        self.assertIn('<sub>GPT-7 Sol at effort xhigh, fallback while Opus 5.5 is out, '
                      'read-only, on ', body)
        [(_, _, pr_body)] = self.posted('body')
        row = next(line for line in pr_body.splitlines() if line.startswith('| ['))
        self.assertTrue(row.startswith(f'| [Sol review 1, {label}](https://'), row)

    def test_the_fallback_reviews_while_sol_is_out_and_the_pr_names_its_model(self):
        self.configure([self.repo], review=JobSpec('codex', 'gpt-6.1-sol', 'high',
                                                   fallback=FABLE))
        old = self.jobs.started(kind='review', repo='first', issue=9, branch='b', title='t',
                                sha=H3, round=1)
        self.jobs.ended(old.id, exit_code=None, outcome='out-of-usage',
                        resume_at='2099-01-01T00:00:00+00:00')
        self.reviewer((0, 'completed', reply())).review_pass()
        [start] = self.t3.starts
        self.assertEqual(named(start), ('claudeReviewer', 'claude-fable-5-2', 'xhigh'))   # the no-tools instance (PR #127)
        label = 'Fable 5.2 xhigh, fallback while Sol is out'
        [(_, _, body)] = self.posted('comment')
        self.assertTrue(body.startswith(f'## Sol review 1 · Clean · {label}\n'), body[:120])
        [(_, _, pr_body)] = self.posted('body')
        row = next(line for line in pr_body.splitlines() if line.startswith('| ['))
        self.assertTrue(row.startswith(f'| [Review 1, {label}](https://'), row)

    def test_a_review_thread_that_stops_on_a_usage_limit_is_its_provider_out(self):
        self.configure([self.repo], review=OPUS)
        self.reviewer((1, 'failed', "You've hit your usage limit")).review_pass()
        [job] = self.of('review')
        self.assertEqual((job.outcome, job.provider), ('out-of-usage', 'claudeAgent'))
        self.assertIsNotNone(self.jobs.out_until(
            'claudeAgent', datetime.datetime(2026, 11, 16, 16, 0).astimezone()))
        self.assertEqual(self.t3.settles, ['mcp:t1'])


if __name__ == '__main__':
    unittest.main()
