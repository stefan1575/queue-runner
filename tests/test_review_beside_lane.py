"""An Opus review in the Sol lane is a Claude job too (PR #74's review 1, F1): the Claude lane's
gate counts it among the jobs running, the review's own gate counts the Claude lane's jobs, and a
pass that ran beside the other records `shared_with`, so neither teaches the learned costs. GitHub,
T3 and the usage endpoint are faked; every file is in a temp folder."""
import io
import json
import os
import threading

from queue_runner.config import load_config
from queue_runner.gate import Gate
from queue_runner.run import Runner
from tests.fakes import FakeUsage
from tests.fakes_t3 import FakeGit, FakeSol, FakeT3
from tests.test_side_by_side import NOW, ROOM, Harness, used


class Held(FakeT3):
    """A T3 whose threads wait until `go` is set, so a Claude job is still running while the
    test looks."""

    def __init__(self, outcomes):
        super().__init__(outcomes)
        self.go, self.started = threading.Event(), threading.Event()

    def start(self, *args, **kwargs):
        self.started.set()
        self.go.wait(10)
        return super().start(*args, **kwargs)


class ReviewBesideLaneTest(Harness):
    def setUp(self):
        super().setUp()
        with open(self.config, 'a', encoding='utf-8') as f:
            f.write('\n[jobs.review]\nprovider = "claudeAgent"\nmodel = "claude-opus-5-5"\n'
                    'effort = "high"\n')
        self.gh.by_repo['second'] = []   # one build, first#4, unless a test says otherwise

    def runner(self, t3, usage=ROOM):
        self.lines = []
        gate = Gate(self.state, FakeUsage(usage), lambda: NOW)
        return Runner(load_config(self.config), github=self.gh, t3=t3, git=FakeGit(),
                      out=io.StringIO(), log_line=self.lines.append, gate=gate, now=lambda: NOW,
                      sol=FakeSol())

    def open_review(self):
        """An Opus review of second#12 open in the job log, as the Sol lane writes it."""
        return self.log.started(kind='review', repo='second', issue=12, branch='claude/x-12',
                                title='Queue runner review: second#12', sha='a' * 40, round=1,
                                reviewer='opus-config')

    def records(self):
        path = os.path.join(self.state, 'usage.jsonl')
        if not os.path.exists(path):
            return []
        with open(path, encoding='utf-8') as f:
            return [json.loads(line) for line in f]

    def test_the_claude_lane_counts_an_open_opus_review(self):
        # 30% used: a build (60) fits alone, but not beside the review (15): 30 + 15 + 60 > 100
        self.open_review()
        self.run_main(['--once'], usage=used(30))
        self.assertEqual(self.built(), [])
        self.assertIn('Claude lane waits on first: build would fit alone, but the Claude job '
                      'running (review second#12) is expected to take 15% of 5 hours, 4% of the '
                      'week: it waits for one of them to end', self.runner_log())

    def test_the_claude_lane_counts_a_review_its_sol_lane_let_in(self):
        t3 = FakeT3([(0, 'completed')])
        runner = self.runner(t3, usage=used(30))
        fallback = runner.reviewer.fallback
        verdict = fallback.check('review second#12')
        self.assertTrue(verdict.go, verdict.text)
        self.assertEqual(runner.run_pass(), 'gated')   # the review not yet in the job log
        self.assertEqual(t3.starts, [])
        fallback.ended('review second#12')
        self.assertEqual(runner.run_pass(), 'started')   # once it ends, the build goes

    def test_the_opus_review_counts_the_claude_jobs_running(self):
        t3 = Held([(0, 'completed')])
        runner = self.runner(t3, usage=used(30))
        _, [worker] = runner.dispatch()
        self.assertTrue(t3.started.wait(10))
        try:
            verdict = runner.reviewer.fallback.check('review second#12')
            self.assertFalse(verdict.go)
            self.assertIn('the Claude job running (build first#4)', verdict.text)
            self.assertIsNone(runner.reviewer._who('review second#12'))
            self.assertTrue(any(line.startswith('Opus 5.5 review waits: review would fit alone, but '
                                                'the Claude job running (build first#4)')
                                for line in self.lines), self.lines)
        finally:
            t3.go.set()
            worker.thread.join()

    def test_a_build_and_a_review_that_ran_together_teach_nothing(self):
        self.learn()           # a build takes 10%: both fit
        self.learn('review')   # and a review 10%
        t3 = Held([(0, 'completed')])
        runner = self.runner(t3, usage=used(10))
        fallback = runner.reviewer.fallback
        before = fallback.check('review second#12')   # the review first, then the build
        self.assertTrue(before.go, before.text)
        _, [worker] = runner.dispatch()
        self.assertTrue(t3.started.wait(10))
        t3.go.set()
        worker.thread.join()
        review = self.open_review()
        fallback.measured([review.id], before, 'review second#12')
        fallback.ended('review second#12')
        build, rev = self.records()[6:]
        self.assertEqual((build['kind'], build.get('shared_with')),
                         ('build', ['review second#12']))
        self.assertEqual((rev['kind'], rev.get('shared_with')), ('review', ['build first#4']))

    def test_a_review_let_in_beside_a_running_build_is_shared_with_it(self):
        self.learn()
        self.learn('review')
        t3 = Held([(0, 'completed')])
        runner = self.runner(t3, usage=used(10))
        fallback = runner.reviewer.fallback
        _, [worker] = runner.dispatch()   # the build first, then the review
        self.assertTrue(t3.started.wait(10))
        before = fallback.check('review second#12')
        self.assertTrue(before.go, before.text)
        review = self.open_review()
        fallback.measured([review.id], before, 'review second#12')
        fallback.ended('review second#12')
        t3.go.set()
        worker.thread.join()
        rev, build = self.records()[6:]
        self.assertEqual(rev.get('shared_with'), ['build first#4'])
        self.assertEqual(build.get('shared_with'), ['review second#12'])

    def test_a_review_alone_still_teaches(self):
        runner = self.runner(FakeT3([]))
        fallback = runner.reviewer.fallback
        before = fallback.check('review second#12')
        review = self.open_review()
        fallback.measured([review.id], before, 'review second#12')
        fallback.ended('review second#12')
        [rec] = self.records()
        self.assertNotIn('shared_with', rec)

    def test_gate_counts_an_open_review_and_the_review_counts_the_builds(self):
        self.open_review()
        _, out = self.run_main(['--gate'], usage=used(30))
        self.assertIn('running: review second#12', out)
        self.assertIn('build: waits: build would fit alone, but the Claude job running '
                      '(review second#12)', out)
