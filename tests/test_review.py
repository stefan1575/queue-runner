"""The Sol lane: which open PRs it adopts, the brief it builds from sources, and a dry-run review
whose would-be comment and verdict land in the run folder, with GitHub, git and Sol faked."""
import datetime
import glob
import json
import os
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Comment, Issue
from queue_runner.ledger import SolFailed
from queue_runner.review import Reviewer
from queue_runner.sol import SolOutOfUsage
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeSol
from tests.test_ledger import H1, H2, important, old_marker, reply

NOW = datetime.datetime(2026, 11, 9, 12, 0)


def blocking_review_1(sha=H1, at='2026-11-06T02:00:00Z'):
    return Comment('stefan1575', at, '## Sol review 1 · Blocking\n\n' + old_marker(
        1, 'blocking', sha, [{**important('F1', cls='write logged wrongly'), 'status': 'open',
                              'raised': 1}]))


class ReviewerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github='owner/first', path=self.dir)
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.said = []

    def reviewer(self, gh, git, sol, now=NOW):
        self.gh, self.git, self.sol = gh, git, sol
        return Reviewer(self.config, github=gh, git=git, sol=sol, jobs=self.jobs,
                        say=self.said.append, now=lambda: now)

    def one_pr(self, comments=(), replies=(), checks=None, conflicts=(), sol=None, heads=None,
               files=None, ancestors=(), body='Closes #5\n\nMakes it red.'):
        pr = full_pr(20, 'claude/red-5', H2, body=body, title='Red widget', base='claude/base-4')
        gh = FakeGitHubForReviews(
            prs=[pr], comments={20: list(comments), 5: [Comment('stefan', '2026-11-01T00:00:00Z',
                                                                'Use the brand red.')]},
            replies={20: list(replies)}, checks=checks, conflicts=conflicts,
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')})
        git = FakeReviewGit(heads=heads or {20: H2}, ancestors=ancestors, files=files or {
            'AGENTS.md': '# Agents', 'REVIEW.md': '# Review guidelines\n\nAlways check grants.'})
        return self.reviewer(gh, git, sol or FakeSol([reply(findings=[important('F1')])]))

    def run_dir(self):
        [d] = glob.glob(os.path.join(self.dir, 'runs', '*'))
        return d

    def read(self, name):
        with open(os.path.join(self.run_dir(), name), encoding='utf-8') as f:
            return f.read()

    # --- adoption -------------------------------------------------------------------------

    def test_an_unreviewed_pr_with_passed_checks_is_reviewed_on_its_exact_head(self):
        r = self.one_pr()
        self.assertEqual(r.review_pass(), 'started')
        [b] = self.sol.briefs
        self.assertIn(H2, b['brief'])
        self.assertEqual(self.git.fetches, [(self.dir, 'pr20', 'claude/base-4')])
        [(_, ref, wt)] = self.git.checkouts
        self.assertEqual((ref, b['workdir']), ('refs/queue-runner/pr20', wt))
        self.assertEqual(self.git.removed, [(wt, ref)])   # the checkout goes afterwards

        [job] = self.jobs.jobs()
        self.assertEqual((job.kind, job.repo, job.issue, job.sha, job.round),
                         ('review', 'first', 20, H2, 1))
        self.assertEqual((job.outcome, job.verdict), ('blocking', 'blocking'))
        self.assertEqual(job.run_dir, self.run_dir())

    def test_the_would_be_comment_and_verdict_are_in_the_run_folder_and_nothing_is_posted(self):
        self.one_pr().review_pass()
        comment = self.read('comment.md')
        self.assertTrue(comment.startswith('## Sol review 1 · Blocking'))
        self.assertIn('sol-pr-review round=1 verdict=blocking sha=' + H2, comment)
        d = json.loads(self.read('decision.json'))
        self.assertEqual((d['verdict'], d['outcome'], d['round'], d['sha']),
                         ('blocking', 'fix', 1, H2))
        self.assertEqual(d['status']['state'], 'failure')
        self.assertTrue(any('dry run' in s for s in self.said))

    def test_a_pr_already_reviewed_on_its_head_is_left_alone(self):
        r = self.one_pr(comments=[blocking_review_1(sha=H2)])
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(self.sol.briefs, [])

    def test_a_pr_waits_for_its_checks_and_skips_a_failed_check_or_a_conflict(self):
        for kw in ({'checks': {H2: Checks('pending', pending=('check',))}},
                   {'checks': {H2: Checks('none')}},
                   {'checks': {H2: Checks('failed', failed=('check',))}},
                   {'conflicts': {20}}):
            with self.subTest(**{k: str(v) for k, v in kw.items()}):
                self.said.clear()
                r = self.one_pr(**kw)
                self.assertEqual(r.review_pass(), 'idle')
                self.assertEqual(self.sol.briefs, [])
                self.assertTrue(self.said)   # it says why, once

    def test_why_a_pr_is_skipped_is_said_once_not_every_pass(self):
        r = self.one_pr(checks={H2: Checks('pending', pending=('check',))})
        r.review_pass()
        r.review_pass()
        self.assertEqual(len([s for s in self.said if '#20' in s]), 1)

    def test_a_pr_a_build_is_still_writing_to_is_left_alone(self):
        self.jobs.started(kind='build', repo='first', issue=5, branch='claude/red-5',
                          title='Queue runner build: first#5')
        r = self.one_pr()
        self.assertEqual(r.review_pass(), 'idle')

    def test_a_pr_whose_build_waits_for_an_answer_is_left_alone(self):
        # Sol review F2: Stefan may answer it and the build writes to the branch again.
        job = self.jobs.started(kind='build', repo='first', issue=5, branch='claude/red-5',
                                title='Queue runner build: first#5')
        self.jobs.ended(job.id, exit_code=2, outcome='waiting', thread_id='mcp:t1')
        r = self.one_pr()
        self.assertEqual(r.review_pass(), 'idle')
        self.assertTrue(any('waits for an answer' in s for s in self.said))
        self.jobs.released('first', 5)
        self.assertEqual(r.review_pass(), 'started')

    def test_a_head_the_runner_reviewed_in_a_dry_run_is_not_reviewed_again(self):
        r = self.one_pr(sol=FakeSol([reply(), reply()]))
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(len(self.sol.briefs), 1)

    def test_lowest_pr_first_and_one_review_a_pass(self):
        gh = FakeGitHubForReviews(prs=[full_pr(30, 'b', H1), full_pr(20, 'a', H2)])
        r = self.reviewer(gh, FakeReviewGit(heads={20: H2, 30: H1}), FakeSol([reply()]))
        r.review_pass()
        [job] = self.jobs.jobs()
        self.assertEqual(job.issue, 20)

    # --- the brief --------------------------------------------------------------------------

    def test_review_1_brief_has_the_ticket_the_whole_diff_agents_and_review_md(self):
        self.one_pr().review_pass()
        brief = self.sol.briefs[0]['brief']
        self.assertIn('`AGENTS.md`', brief)
        self.assertIn('Always check grants.', brief)          # REVIEW.md, in full
        self.assertIn('`issue-5.md`', brief)
        self.assertNotIn('full.diff', brief)
        self.assertEqual(self.read('change.diff'), f'diff origin/claude/base-4...{H2}\n')
        issue = self.read('issue-5.md')
        self.assertIn('Make the widget red.', issue)
        self.assertIn('Use the brand red.', issue)            # with its comments
        self.assertIn('Makes it red.', self.read('pr.md'))

    def test_issues_closed_by_url_or_qualified_ref_are_in_the_brief(self):
        # Sol review F3: only a bare #N was found.
        r = self.one_pr(body='Closes https://github.com/owner/first/issues/5\nFixes other/x#9')
        self.gh.issue_bodies[('other/x', 9)] = Issue(9, 'Elsewhere', 'In another repo.')
        r.review_pass()
        brief = self.sol.briefs[0]['brief']
        self.assertIn('`issue-5.md`', brief)
        self.assertIn('`issue-other_x-9.md`', brief)
        self.assertIn('Make the widget red.', self.read('issue-5.md'))
        self.assertIn('In another repo.', self.read('issue-other_x-9.md'))

    def test_issues_in_repos_whose_names_join_alike_get_their_own_files(self):
        # Sol review 2, F4: a-b/c#9 and a/b-c#9 both became issue-a-b-c-9.md.
        r = self.one_pr(body='Closes https://github.com/a-b/c/issues/9\n'
                             'Closes https://github.com/a/b-c/issues/9')
        self.gh.issue_bodies[('a-b/c', 9)] = Issue(9, 'One', 'First ticket.')
        self.gh.issue_bodies[('a/b-c', 9)] = Issue(9, 'Two', 'Second ticket.')
        r.review_pass()
        self.assertIn('First ticket.', self.read('issue-a-b_c-9.md'))
        self.assertIn('Second ticket.', self.read('issue-a_b-c-9.md'))

    def test_review_2_brief_has_the_change_since_the_last_review_its_findings_and_replies(self):
        replies = [Comment('claude', '2026-11-06T01:00:00Z', 'Before the review.'),
                   Comment('claude', '2026-11-07T00:00:00Z', 'F1 declined: no test fails.',
                           path='src/a.ts', line=10)]
        r = self.one_pr(comments=[blocking_review_1()], replies=replies,
                        ancestors={(H1, H2)},
                        sol=FakeSol([reply(earlier=[{'id': 'F1', 'status': 'fixed'}])]))
        r.review_pass()
        brief = self.sol.briefs[0]['brief']
        self.assertIn('This is review 2.', brief)
        self.assertIn(f'You last reviewed {H1[:7]}', brief)
        self.assertEqual(self.read('change.diff'), f'diff {H1}..{H2}\n')
        self.assertEqual(self.read('full.diff'), f'diff origin/claude/base-4...{H2}\n')
        self.assertIn('**F1** · Important · write logged wrongly', brief)   # open findings
        self.assertIn('"write logged wrongly"', brief)                      # classes so far
        self.assertIn('F1 declined: no test fails.', brief)
        self.assertNotIn('Before the review.', brief)
        self.assertIn('Sol review 1', self.read('conversation.md'))
        [job] = self.jobs.jobs()
        self.assertEqual((job.round, job.outcome), (2, 'clean'))

    def test_a_force_pushed_last_review_gets_the_whole_diff_and_says_so(self):
        r = self.one_pr(comments=[blocking_review_1()], sol=FakeSol([reply()]))
        r.review_pass()
        brief = self.sol.briefs[0]['brief']
        self.assertIn("isn't in this branch's history any more", brief)
        self.assertEqual(self.read('change.diff'), f'diff origin/claude/base-4...{H2}\n')
        self.assertIn("isn't in this branch's history any more", self.read('comment.md'))

    # --- when it doesn't work ---------------------------------------------------------------

    def test_a_reply_without_a_ledger_is_a_failed_review_retried_once_then_held(self):
        r = self.one_pr(sol=FakeSol(['No block.', 'Still none.']))
        self.assertEqual(r.review_pass(), 'started')
        [job] = self.jobs.jobs()
        self.assertEqual(job.outcome, 'failed')
        self.assertIn('sol-findings', job.error)
        self.assertFalse(os.path.exists(os.path.join(job.run_dir, 'comment.md')))
        self.assertEqual(r.review_pass(), 'started')   # tried again on the same head
        self.assertEqual(r.review_pass(), 'idle')      # not a third time
        self.jobs.released('first', 20)
        self.sol.replies.append(reply())
        self.assertEqual(r.review_pass(), 'started')

    def test_a_failed_sol_run_is_a_failed_review(self):
        r = self.one_pr(sol=FakeSol([SolFailed('codex-sol exit 1')]))
        r.review_pass()
        [job] = self.jobs.jobs()
        self.assertEqual((job.outcome, job.error), ('failed', 'codex-sol exit 1'))

    def test_sol_out_of_usage_pauses_the_lane_until_ten_minutes_after_its_reset(self):
        back = datetime.datetime(2026, 11, 9, 14, 0)
        r = self.one_pr(sol=FakeSol([SolOutOfUsage(back), reply()]))
        r.review_pass()
        [job] = self.jobs.jobs()
        self.assertEqual((job.outcome, job.resume_at), ('out-of-usage', '2026-11-09T14:10:00'))
        self.assertEqual(r.review_pass(), 'idle')
        later = self.reviewer(self.gh, self.git, self.sol, now=datetime.datetime(2026, 11, 9, 14, 11))
        self.assertEqual(later.review_pass(), 'started')

    def test_a_push_between_listing_and_fetching_reviews_nothing(self):
        r = self.one_pr(heads={20: 'd' * 40})
        self.assertEqual(r.review_pass(), 'idle')
        [job] = self.jobs.jobs()
        self.assertEqual(job.outcome, 'head-moved')
        self.assertEqual(self.sol.briefs, [])

    def test_a_review_left_open_by_a_dead_runner_is_settled_as_failed(self):
        self.jobs.started(kind='review', repo='first', issue=20, branch='claude/red-5',
                          title='Queue runner review: first#20', sha=H2, round=1)
        r = self.one_pr()
        r.settle()
        [job] = self.jobs.jobs()
        self.assertEqual(job.outcome, 'failed')

    def test_github_failing_on_one_pr_skips_that_pr_not_the_pass(self):
        class Flaky(FakeGitHubForReviews):
            def checks(self, repo, sha):
                if sha == H1:
                    raise RuntimeError('TLS handshake timeout')
                return super().checks(repo, sha)
        gh = Flaky(prs=[full_pr(10, 'a', H1), full_pr(20, 'b', H2)])
        r = self.reviewer(gh, FakeReviewGit(heads={20: H2}), FakeSol([reply()]))
        self.assertEqual(r.review_pass(), 'started')
        [job] = self.jobs.jobs()
        self.assertEqual(job.issue, 20)
        self.assertTrue(any('#10' in s and 'TLS handshake timeout' in s for s in self.said))

    def test_candidates_say_what_would_be_reviewed(self):
        r = self.one_pr()
        [(pr, why)] = r.candidates(self.repo)
        self.assertEqual((pr.number, why), (20, None))


if __name__ == '__main__':
    unittest.main()
