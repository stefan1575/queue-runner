"""The Opus fallback reviewer (issue #69): while Sol is out of usage, the Sol lane's review runs as
a T3 thread on Opus through the usage gate, is posted naming its reviewer, merges or starts a fix
round as Sol's would, and once Sol's reset passes the next review goes to Sol again. Through the
Sol seam (FakeSol), the T3 fake and the GitHub fake: no network, no T3."""
import dataclasses
import datetime
import io
import json
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.effort import Effort
from queue_runner.fallback import KIND, SET, OpusFallback
from queue_runner.gate import Gate
from queue_runner.github import Issue
from queue_runner.merge import READY
from queue_runner.review import Reviewer
from queue_runner.run import Runner
from queue_runner.state import JobLog, read_records
from queue_runner.t3 import T3Error
from queue_runner.usage import Usage, Window
from tests.fakes import FakeGitHubForReviews, FakeToaster, FakeUsage, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeSol, FakeT3
from tests.test_effort import FakeFiles, set_high
from tests.test_ledger import H2, H3, important, reply

NOW = datetime.datetime(2026, 11, 16, 16, 0)
RESUME = datetime.datetime(2026, 11, 16, 18, 36)   # Sol's reset plus ten minutes
LABEL = 'Opus 5.5 high, fallback while Sol is out'
UTC = datetime.timezone.utc


def usage(five, week=10):
    return Usage(Window(five, datetime.datetime(2026, 11, 16, 20, 0, tzinfo=UTC)),
                 Window(week, datetime.datetime(2026, 11, 20, 0, 0, tzinfo=UTC)))


class FallbackTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.use(Repo(name='first', github='owner/first', path=self.dir))
        self.said = []
        self.gh = FakeGitHubForReviews(
            prs=[full_pr(20, 'claude/red-5', H2, body='Closes #5\n\nMakes it red.',
                         title='Red widget', base='main')],
            comments={5: []},
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')})
        self.git = FakeReviewGit(heads={20: H2}, files={'AGENTS.md': '# Agents'})

    def use(self, repo):
        self.repo = repo
        self.config = Config(repos=[repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.jobs = JobLog(os.path.join(self.config.state_dir, 'jobs.jsonl'))

    def sol_out(self, resume=RESUME):
        """Sol's review of an earlier PR ran out of usage: no Sol review before `resume`."""
        job = self.jobs.started(kind='review', repo='first', issue=9, branch='b', title='t',
                                sha=H3, round=1)
        self.jobs.ended(job.id, exit_code=None, outcome='out-of-usage',
                        resume_at=resume.astimezone().isoformat(timespec='seconds'))

    def reviewer(self, *outcomes, sol=(), now=NOW, gate=None, effort=None, merge=False,
                 toaster=None):
        self.t3 = FakeT3(list(outcomes))
        self.sol = FakeSol(list(sol))
        self.toaster = toaster
        return Reviewer(self.config, github=self.gh, git=self.git, sol=self.sol, jobs=self.jobs,
                        say=self.said.append, now=lambda: now, toaster=toaster,
                        merger=None if merge else False,
                        fallback=OpusFallback(self.config, t3=self.t3, gate=gate, effort=effort))

    def reviews(self):
        return [j for j in self.jobs.jobs() if j.kind == 'review' and j.issue == 20]

    def posted(self, kind):
        return [p for p in self.gh.posts if p[0] == kind]

    # --- the fallback review ----------------------------------------------------------------

    def test_with_sol_out_the_review_runs_as_an_opus_thread_and_sol_is_not_asked(self):
        self.sol_out()
        r = self.reviewer((0, 'completed', reply(findings=[important('F1')])))
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual(self.sol.briefs, [])
        [start] = self.t3.starts
        self.assertEqual((start['project'], start['title'], start['worktree'], start['branch']),
                         (self.dir, 'Queue runner review: first#20', None, None))
        self.assertEqual((start['provider'], start['model']), ('claudeAgent', 'claude-opus-5-5'))
        # Sol's own brief, after the fallback's: where to work, and to post nothing.
        wt = os.path.join(self.config.checkouts_dir, 'first-pr20').replace('\\', '/')
        self.assertTrue(start['message'].startswith("## First: you review in Sol's place"))
        self.assertIn(f'cd {wt}', start['message'])
        self.assertIn("Don't post on GitHub", start['message'])
        self.assertIn('# Review PR #20: Red widget', start['message'])
        self.assertIn('```sol-findings', start['message'])
        [job] = self.reviews()
        self.assertEqual((job.reviewer, job.outcome, job.verdict, job.thread_id, job.run_id),
                         (KIND, 'blocking', 'blocking', 'mcp:t1', 'run:mcp:t1:1'))
        self.assertTrue(any('Opus (the fallback while Sol is out of usage) reviews' in s
                            for s in self.said), self.said)
        self.assertEqual(self.t3.settles, ['mcp:t1'])   # its reply read: settled (ticket 70)

    def test_the_comment_status_and_decision_name_the_fallback(self):
        self.sol_out()
        self.reviewer((0, 'completed', reply())).review_pass()
        [(_, n, body)] = self.posted('comment')
        self.assertEqual(n, 20)
        self.assertTrue(body.startswith(f'## Sol review 1 · Clean · {LABEL}\n'), body[:120])
        self.assertIn(f"Reviewed by {LABEL}: Claude reviewed in Sol's place", body)
        self.assertNotIn('GPT-6.1 Sol', body)
        self.assertIn(f'sol-pr-review round=1 verdict=clean sha={H2}', body)   # read as any
        [(_, sha, state, description, _)] = self.posted('status')
        self.assertEqual((sha, state), (H2, 'success'))
        self.assertTrue(description.startswith(f'{LABEL}: Clean'), description)
        [job] = self.reviews()
        with open(os.path.join(job.run_dir, 'decision.json'), encoding='utf-8') as f:
            self.assertEqual(json.load(f)['reviewer'], LABEL)

    def test_the_review_row_names_the_fallback(self):
        self.use(Repo(name='first', github='owner/first', path=self.dir, review_table=True))
        self.sol_out()
        self.reviewer((0, 'completed', reply())).review_pass()
        [(_, _, body)] = self.posted('body')
        row = next(line for line in body.splitlines() if line.startswith('| ['))
        self.assertTrue(row.startswith(f'| [Review 1, {LABEL}](https://'), row)

    def test_sols_own_review_still_names_sol(self):
        r = self.reviewer(sol=[reply()])
        r.review_pass()
        [(_, _, body)] = self.posted('comment')
        self.assertTrue(body.startswith('## Sol review 1 · Clean\n'))
        self.assertIn('GPT-6.1 Sol at effort high', body)
        self.assertEqual(self.t3.starts, [])
        [job] = self.reviews()
        self.assertIsNone(job.reviewer)

    def test_the_label_says_the_effort_the_run_used(self):
        self.sol_out()
        files = FakeFiles(set_high(self.dir), efforts={'mcp:t1': 'medium'})
        r = self.reviewer((0, 'completed', reply()),
                          effort=Effort(self.config, files=files, say=self.said.append))
        r.review_pass()
        [start] = self.t3.starts
        self.assertEqual((start['provider'], start['model']), (None, None))   # the default
        [(_, _, body)] = self.posted('comment')
        self.assertIn('Opus 5.5 medium, fallback while Sol is out', body)
        [job] = self.reviews()
        self.assertEqual(job.effort, 'medium')

    def test_a_thread_that_fails_or_asks_is_a_failed_review(self):
        self.sol_out()
        r = self.reviewer((1, 'failed'), (2, 'waiting'), (0, 'completed', reply()))
        r.review_pass()
        r.review_pass()
        failed = self.reviews()
        self.assertEqual([j.outcome for j in failed], ['failed', 'failed'])
        self.assertIn('ended failed: It broke.', failed[0].error)
        self.assertIn('stopped to ask a question', failed[1].error)
        self.assertEqual(failed[0].thread_id, 'mcp:t1')
        self.assertEqual(self.posted('comment'), [])
        # Each settled once its end was recorded, the one that asked too (issue #77): nobody
        # answers a review thread.
        self.assertEqual(self.t3.settles, ['mcp:t1', 'mcp:t2'])
        self.assertEqual(r.review_pass(), 'idle')   # two failed reviews on H2, as for Sol's

    def test_a_review_thread_settles_only_once_its_end_is_recorded(self):
        self.sol_out()
        r = self.reviewer((0, 'completed', reply()))
        seen = []
        settle = self.t3.settle
        self.t3.settle = lambda tid: (seen.append([j.open for j in self.reviews()]), settle(tid))
        r.review_pass()
        self.assertEqual(seen, [[False]])   # the job's end was in the log first (issue #77)
        self.assertEqual(self.t3.settles, ['mcp:t1'])

    def test_a_review_whose_post_failed_still_settles_its_thread(self):
        self.sol_out()
        self.gh.fail = {'comment'}
        r = self.reviewer((0, 'completed', reply()))
        r.review_pass()
        [job] = self.reviews()
        self.assertEqual((job.outcome, job.thread_id), ('failed', 'mcp:t1'))
        self.assertEqual(self.t3.settles, ['mcp:t1'])

    def test_a_failed_settle_is_said_and_the_review_counts(self):
        self.sol_out()
        r = self.reviewer((0, 'completed', reply()))
        self.t3.settle_error = T3Error('refused')
        self.assertEqual(r.review_pass(), 'started')
        [job] = self.reviews()
        self.assertEqual(job.outcome, 'clean')
        self.assertTrue(any('settling its thread mcp:t1 in T3 failed' in s for s in self.said),
                        self.said)

    def test_t3_not_starting_the_thread_is_a_failed_review(self):
        self.sol_out()
        self.reviewer(T3Error('server down')).review_pass()
        [job] = self.reviews()
        self.assertEqual((job.outcome, job.thread_id), ('failed', None))
        self.assertIn("didn't run: server down", job.error)

    # --- the usage gate ---------------------------------------------------------------------

    def gate(self, *reads):
        return Gate(self.config.state_dir, FakeUsage(*reads),
                    clock=lambda: datetime.datetime(2026, 11, 16, 8, 0, tzinfo=UTC))

    def test_the_gate_holds_the_fallback_back_and_says_so_once(self):
        self.sol_out()
        r = self.reviewer((0, 'completed', reply()), gate=self.gate(usage(90)))
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(self.t3.starts, [])
        self.assertEqual(self.reviews(), [])
        waits = [s for s in self.said if s.startswith('Opus fallback review waits:')]
        self.assertEqual(len(waits), 1, self.said)
        self.assertIn('the 5-hour window is 90% used and a review is expected to take 15%',
                      waits[0])

    def test_a_fallback_that_fits_runs_and_its_cost_is_learned_as_a_review(self):
        self.sol_out()
        r = self.reviewer((0, 'completed', reply()), gate=self.gate(usage(10), usage(22, 13)))
        self.assertEqual(r.review_pass(), 'started')
        self.assertTrue(any(s.startswith('Usage gate: review fits') for s in self.said))
        [rec] = read_records(os.path.join(self.config.state_dir, 'usage.jsonl'))
        [job] = self.reviews()
        self.assertEqual((rec['kind'], rec['jobs']), ('review', [job.id]))
        self.assertEqual(rec['spent'], {'five_hour': 12, 'seven_day': 3})

    def test_gate_prints_the_fallback_review_and_the_reviewing_lanes_stop(self):
        from queue_runner import cli, control
        out = io.StringIO()
        cli._print_gate(self.gate(usage(10)), out, self.config)
        self.assertIn('  review (Opus, while Sol is out): starts: review fits', out.getvalue())
        control.ask(self.config.state_dir, ['sol'], 'after-job',
                    now=NOW.astimezone().isoformat(timespec='seconds'))
        out = io.StringIO()
        cli._print_gate(self.gate(usage(10)), out, self.config)
        self.assertIn('  review (Opus, while Sol is out): waits: the reviewing lane is stopped',
                      out.getvalue())
        self.assertIn('  build: starts', out.getvalue())

    def test_sols_own_review_is_not_gated(self):
        r = self.reviewer(sol=[reply()], gate=self.gate(usage(100, 100)))
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual(len(self.sol.briefs), 1)

    # --- back to Sol --------------------------------------------------------------------------

    def test_once_sols_reset_passes_the_next_review_goes_to_sol(self):
        self.sol_out()
        self.reviewer((0, 'completed', reply(findings=[important('F1')]))).review_pass()
        self.gh.now[20] = {'head_sha': H3}   # a fix round pushed H3
        self.gh.prs = [full_pr(20, 'claude/red-5', H3, body='Closes #5', base='main')]
        self.git.heads[20] = H3
        self.assertEqual(self.jobs.sol_resume_at(),   # the fallback's review doesn't end it
                         RESUME.astimezone().isoformat(timespec='seconds'))
        later = self.reviewer(sol=[reply(earlier=[{'id': 'F1', 'status': 'fixed'}])],
                              now=RESUME + datetime.timedelta(minutes=1))
        self.assertEqual(later.review_pass(), 'started')
        self.assertEqual(self.t3.starts, [])
        [brief] = self.sol.briefs
        self.assertIn('This is review 2', brief['brief'])
        first, second = self.reviews()
        self.assertEqual((first.reviewer, second.reviewer), (KIND, None))
        self.assertEqual(second.outcome, 'clean')

    def test_sol_out_again_after_the_reset_falls_back_again(self):
        self.sol_out(resume=NOW - datetime.timedelta(minutes=1))   # the reset has passed
        from queue_runner.sol import SolOutOfUsage
        r = self.reviewer((0, 'completed', reply()), sol=[SolOutOfUsage(None)])
        self.assertEqual(r.review_pass(), 'started')   # Sol, out again
        self.assertEqual(r.review_pass(), 'started')   # the fallback
        self.assertEqual([j.reviewer for j in self.reviews()], [None, KIND])
        self.assertEqual([j.outcome for j in self.reviews()], ['out-of-usage', 'clean'])

    def test_without_a_fallback_the_review_waits_for_sol(self):
        self.sol_out()
        r = Reviewer(self.config, github=self.gh, git=self.git, sol=FakeSol([]), jobs=self.jobs,
                     say=self.said.append, now=lambda: NOW)
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(self.reviews(), [])

    # --- what follows a fallback review ---------------------------------------------------------

    def test_a_clean_fallback_review_merges_where_the_runner_merges(self):
        self.sol_out()
        self.reviewer((0, 'completed', reply()), merge=True).review_pass()
        [merge] = [p for p in self.gh.posts if p[0] == 'merge']
        self.assertEqual(merge[1:3], (20, H2))
        self.assertEqual([j.outcome for j in self.jobs.jobs() if j.kind == 'merge'], ['merged'])

    def test_a_clean_fallback_review_marks_the_pr_ready_where_stefan_merges(self):
        self.use(Repo(name='first', github='owner/first', path=self.dir, merge='stefan'))
        self.sol_out()
        self.reviewer((0, 'completed', reply()), merge=True,
                      toaster=FakeToaster()).review_pass()
        self.assertEqual([p for p in self.gh.posts if p[0] == 'merge'], [])
        self.assertEqual([p for p in self.gh.posts if p[0] == 'label'], [('label', 20, READY)])
        self.assertEqual([j.outcome for j in self.jobs.jobs() if j.kind == 'ready'], ['marked'])


class ClaudeReviewsTest(unittest.TestCase):
    """config.toml's `[review] provider = "claude"` (issue #76): Opus reviews every PR, through the
    usage gate, whether or not Sol is out; "chatgpt" (the default) keeps Sol."""

    SET_LABEL = 'Opus 5.5 high, set in config.toml'

    def setUp(self):
        FallbackTest.setUp(self)
        self.use(Repo(name='first', github='owner/first', path=self.dir))

    def use(self, repo, provider='claude'):
        FallbackTest.use(self, repo)
        self.config = dataclasses.replace(self.config, review_provider=provider)

    reviewer, reviews, posted, sol_out, gate = (
        FallbackTest.reviewer, FallbackTest.reviews, FallbackTest.posted, FallbackTest.sol_out,
        FallbackTest.gate)

    def test_opus_reviews_with_sol_available_and_sol_is_not_asked(self):
        r = self.reviewer((0, 'completed', reply()), sol=[reply()])
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual(self.sol.briefs, [])
        [start] = self.t3.starts
        first = start['message'].split('\n\n')[1]
        self.assertTrue(first.startswith('You review this PR in place of Sol'), first)
        self.assertNotIn('out of usage', first)
        [job] = self.reviews()
        self.assertEqual((job.reviewer, job.outcome), (SET, 'clean'))
        self.assertTrue(any('Opus (config.toml says so) reviews' in s for s in self.said),
                        self.said)

    def test_the_comment_status_and_row_say_config_toml_chose_it(self):
        self.use(Repo(name='first', github='owner/first', path=self.dir, review_table=True))
        self.reviewer((0, 'completed', reply())).review_pass()
        [(_, _, body)] = self.posted('comment')
        self.assertTrue(body.startswith(f'## Sol review 1 · Clean · {self.SET_LABEL}\n'),
                        body[:120])
        self.assertNotIn('fallback', body)
        [(_, _, _, description, _)] = self.posted('status')
        self.assertTrue(description.startswith(f'{self.SET_LABEL}: Clean'), description)
        [(_, _, pr_body)] = self.posted('body')
        row = next(line for line in pr_body.splitlines() if line.startswith('| ['))
        self.assertTrue(row.startswith(f'| [Review 1, {self.SET_LABEL}](https://'), row)

    def test_sol_out_of_usage_changes_nothing(self):
        self.sol_out()
        self.reviewer((0, 'completed', reply())).review_pass()
        [job] = self.reviews()
        self.assertEqual(job.reviewer, SET)
        self.assertFalse(any(s.startswith('Sol is out of usage') for s in self.said), self.said)

    def test_the_gate_holds_it_back_and_says_so_once(self):
        r = self.reviewer((0, 'completed', reply()), sol=[reply()], gate=self.gate(usage(90)))
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual((self.t3.starts, self.sol.briefs), ([], []))
        waits = [s for s in self.said if s.startswith('Opus review waits:')]
        self.assertEqual(len(waits), 1, self.said)

    def test_review_one_says_the_gate_holds_it(self):
        r = self.reviewer((0, 'completed', reply()), gate=self.gate(usage(90)))
        result, why = r.review_one(self.repo, 20)
        self.assertEqual(result, 'idle')
        self.assertTrue(why.startswith('the Opus review waits: '), why)

    def test_without_a_t3_thread_to_start_sol_reviews(self):
        # The CLI's --review and the live checks build no fallback: they run Sol by name.
        r = Reviewer(self.config, github=self.gh, git=self.git, sol=FakeSol([reply()]),
                     jobs=self.jobs, say=self.said.append, now=lambda: NOW)
        self.assertEqual(r.review_pass(), 'started')
        [job] = self.reviews()
        self.assertIsNone(job.reviewer)

    def test_chatgpt_keeps_sol_reviewing(self):
        self.use(Repo(name='first', github='owner/first', path=self.dir), provider='chatgpt')
        r = self.reviewer((0, 'completed', reply()), sol=[reply()])
        r.review_pass()
        self.assertEqual((len(self.sol.briefs), self.t3.starts), (1, []))

    def test_gate_prints_the_review_as_config_toml_chose_it(self):
        from queue_runner import cli
        out = io.StringIO()
        cli._print_gate(self.gate(usage(10)), out, self.config)
        self.assertIn('  review (Opus, set in config.toml): starts: review fits', out.getvalue())

    def test_the_snapshot_shows_claude_on_the_reviewing_lane(self):
        from queue_runner import snapshot
        facts = snapshot.Facts(now=NOW.astimezone(), repos=[self.repo],
                               review_provider='claude')
        lanes = {lane['id']: lane for lane in snapshot.build(facts)['lanes']}
        self.assertEqual((lanes['sol']['provider'], lanes['sol']['name'], lanes['sol']['model']),
                         ('claude', 'Claude', lanes['claude']['model']))
        facts = snapshot.Facts(now=NOW.astimezone(), repos=[self.repo])
        lanes = {lane['id']: lane for lane in snapshot.build(facts)['lanes']}
        self.assertEqual(lanes['sol']['name'], 'ChatGPT')


class ReviewProviderConfigTest(unittest.TestCase):
    def load(self, text):
        from queue_runner.config import load_config
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'config.toml')
            with open(path, 'w', encoding='utf-8') as f:
                f.write('state_dir = "s"\nlog_dir = "l"\n' + text)
            return load_config(path)

    def test_the_default_is_chatgpt(self):
        self.assertEqual(self.load('').review_provider, 'chatgpt')

    def test_claude(self):
        self.assertEqual(self.load('[review]\nprovider = "claude"\n').review_provider, 'claude')

    def test_anything_else_is_an_error_naming_the_key(self):
        with self.assertRaisesRegex(ValueError, r'\[review\] provider must be one of'):
            self.load('[review]\nprovider = "opus"\n')


class FallbackFixRoundTest(unittest.TestCase):
    """A blocking fallback review starts a fix round through the real Runner, as Sol's would."""

    def setUp(self):
        FallbackTest.setUp(self)

    use, sol_out = FallbackTest.use, FallbackTest.sol_out

    def test_a_blocking_fallback_review_starts_a_fix_round(self):
        self.sol_out(resume=datetime.datetime(2099, 1, 1))
        t3 = FakeT3([(0, 'completed', reply(findings=[important('F1')])), (0, 'completed')])
        sol = FakeSol([])
        r = Runner(self.config, github=self.gh, t3=t3, git=self.git, out=io.StringIO(),
                   log_line=lambda line: None, sol=sol)
        self.assertEqual(r.reviewer.review_pass(), 'started')
        [review] = [j for j in r.jobs.jobs() if j.kind == 'review' and j.issue == 20]
        self.assertEqual((review.reviewer, review.outcome), (KIND, 'blocking'))
        self.assertEqual(r.run_pass(), 'started')
        review_thread, fix_thread = t3.starts
        self.assertEqual(fix_thread['title'], 'Queue runner fix: first#20')
        self.assertEqual(fix_thread['worktree'], H2)
        self.assertIn('**F1** · Important · write logged wrongly', fix_thread['message'])
        [fix] = [j for j in r.jobs.jobs() if j.kind == 'fix']
        self.assertEqual((fix.sha, fix.round), (H2, 1))
        self.assertEqual(sol.briefs, [])


if __name__ == '__main__':
    unittest.main()
