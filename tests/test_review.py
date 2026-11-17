"""The Sol lane: which open PRs it adopts, the brief it builds from sources, and a review whose
comment, sol-review status, follow-up issues and PR body row are posted, with GitHub, git and Sol
faked: every post is checked against FakeGitHubForReviews.posts."""
import dataclasses
import datetime
import glob
import json
import os
import re
import tempfile
import unittest

from queue_runner.config import Config, Repo
from queue_runner.deps import Prepared
from queue_runner.github import Checks, Comment, Issue
from queue_runner.ledger import SolFailed, read_reviews, state
from queue_runner.review import DryRunPoster, Reviewer
from queue_runner.sol import SolOutOfUsage
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, full_pr
from tests.fakes_t3 import FakeReviewGit, FakeSol
from tests.test_ledger import H1, H2, H3, important, old_marker, reply

NOW = datetime.datetime(2026, 11, 9, 12, 0)


def blocking_review_1(sha=H1, at='2026-11-06T02:00:00Z'):
    return Comment('stefan1575', at, '## Sol review 1 · Blocking\n\n' + old_marker(
        1, 'blocking', sha, [{**important('F1', cls='write logged wrongly'), 'status': 'open',
                              'raised': 1}]))


class FakeDeps:
    """Plays deps.Deps: every checkout gets the same result."""

    def __init__(self, result):
        self.result, self.prepared = result, []
        self.cache_dir = 'C:/deps'

    def prepare(self, repo, worktree):
        self.prepared.append((repo, worktree))
        return self.result


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

    def reviewer(self, gh, git, sol, now=NOW, poster=None, merger=False, deps=None):
        """Merging is tested in test_merge.py: these reviews merge nothing (merger False)."""
        self.gh, self.git, self.sol = gh, git, sol
        return Reviewer(self.config, github=gh, git=git, sol=sol, jobs=self.jobs,
                        say=self.said.append, now=lambda: now, poster=poster, merger=merger,
                        deps=deps)

    def one_pr(self, comments=(), replies=(), checks=None, conflicts=(), sol=None, heads=None,
               files=None, ancestors=(), body='Closes #5\n\nMakes it red.', labels=(),
               poster=None, deps=None, **gh_kw):
        pr = full_pr(20, 'claude/red-5', H2, body=body, title='Red widget', base='claude/base-4',
                     labels=labels)
        gh = FakeGitHubForReviews(
            prs=[pr], comments={20: list(comments), 5: [Comment('stefan', '2026-11-01T00:00:00Z',
                                                                'Use the brand red.')]},
            replies={20: list(replies)}, checks=checks, conflicts=conflicts,
            issue_bodies={('owner/first', 5): Issue(5, 'Red widget', 'Make the widget red.')},
            **gh_kw)
        git = FakeReviewGit(heads=heads or {20: H2}, ancestors=ancestors, files=files or {
            'AGENTS.md': '# Agents', 'REVIEW.md': '# Review guidelines\n\nAlways check grants.'})
        return self.reviewer(gh, git, sol or FakeSol([reply(findings=[important('F1')])]),
                             poster=poster, deps=deps)

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

    def test_a_checkout_git_couldnt_delete_is_said_and_one_still_kept_is_said_once(self):
        """Ticket 45: the review goes on whatever its leftovers; the log says where they are."""
        r = self.one_pr(sol=FakeSol([reply(), reply()]))
        wt = os.path.join(self.config.checkouts_dir, 'first-pr20')
        self.git.moved_aside[wt] = wt + '.stale-20261116-010203'
        self.git.stale = [wt + '.stale-20261116-000000']
        pr = full_pr(20, 'claude/red-5', H2, base='claude/base-4')
        for _ in range(2):
            r.review(self.repo, pr)
        self.assertEqual(len(self.sol.briefs), 2)
        moved = [s for s in self.said if 'moved aside' in s]
        self.assertEqual(len(moved), 2)
        self.assertIn('first-pr20.stale-20261116-010203', moved[0])
        kept = [s for s in self.said if 'stale-20261116-000000' in s]
        self.assertEqual(len(kept), 1, self.said)
        self.assertIn("can't be deleted", kept[0])

    def test_the_comment_and_verdict_are_in_the_run_folder(self):
        self.one_pr().review_pass()
        comment = self.read('comment.md')
        self.assertTrue(comment.startswith('## Sol review 1 · Blocking'))
        self.assertIn('sol-pr-review round=1 verdict=blocking sha=' + H2, comment)
        d = json.loads(self.read('decision.json'))
        self.assertEqual((d['verdict'], d['outcome'], d['round'], d['sha']),
                         ('blocking', 'fix', 1, H2))
        self.assertEqual(d['status']['state'], 'failure')

    def test_the_dry_run_poster_posts_nothing(self):
        self.one_pr(poster=DryRunPoster(self.said.append)).review_pass()
        self.assertEqual(self.gh.posts, [])
        self.assertTrue(any('dry run' in s for s in self.said))
        self.assertTrue(self.read('comment.md').startswith('## Sol review 1 · Blocking'))

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

    def test_the_brief_defines_a_class_as_the_cause_with_a_cause_for_its_example(self):
        # #135: a class named after the symptom let the fix round patch only Sol's scenario.
        self.one_pr().review_pass()
        brief = ' '.join(self.sol.briefs[0]['brief'].split())
        self.assertIn('`class` names the cause: what in the code lets the failure happen, not '
                      'what goes wrong', brief)
        self.assertIn('"log records matched by comparing timestamps written at different '
                      'precisions"', brief)
        self.assertNotIn('write made outside the app logged wrongly', brief)

    def test_with_its_dependencies_linked_sol_is_told_to_run_the_tests_and_may_write_the_cache(self):
        deps = FakeDeps(Prepared(True, 'its dependencies are installed in `node_modules` (from '
                                       '`bun.lock`, as CI installs them)', 'cached (first-abc)',
                                 ('C:/deps/first-abc/node_modules/.vite-temp',)))
        self.one_pr(deps=deps, files={'AGENTS.md': '# Agents', 'package.json': '{}'}).review_pass()
        [(name, wt)] = deps.prepared
        self.assertEqual(name, 'first')
        [b] = self.sol.briefs
        self.assertEqual(wt, b['workdir'])
        self.assertEqual(b['writable'], ['C:/deps/first-abc/node_modules/.vite-temp'])
        self.assertIn('from `bun.lock`', b['brief'])
        self.assertIn('`npm test`', b['brief'])
        self.assertIn('quote', b['brief'])                 # its summary line, in the reply
        self.assertIn('not browser tests', b['brief'])     # e2e stalled with no browser
        self.assertTrue(any('cached (first-abc)' in line for line in self.said))

    def test_without_its_dependencies_sol_is_told_why_and_still_reviews(self):
        deps = FakeDeps(Prepared(False, "its dependencies aren't installed: no lockfile", 'none'))
        self.one_pr(deps=deps).review_pass()
        [b] = self.sol.briefs
        self.assertIn("aren't installed: no lockfile", b['brief'])
        self.assertNotIn('`npm test`', b['brief'])
        self.assertEqual(b['writable'], [])

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

    def test_the_prs_screenshots_are_copied_in_and_the_brief_asks_sol_to_look(self):
        # Stefan, 2026-11-17: a visible change needs before and after shots (templates/build.md).
        r = self.one_pr()
        self.git.shots[20] = {'before-busy-usage.png': b'PNG1', 'after-busy-usage.png': b'PNG2'}
        r.review_pass()
        brief = self.sol.briefs[0]['brief']
        self.assertIn('`evidence/`', brief)
        self.assertIn('after-busy-usage.png', brief)
        self.assertIn('**Screenshots:**', brief)
        with open(os.path.join(self.run_dir(), 'evidence', 'after-busy-usage.png'), 'rb') as f:
            self.assertEqual(f.read(), b'PNG2')

    def test_a_pr_without_screenshots_says_none_were_published(self):
        self.one_pr().review_pass()
        brief = self.sol.briefs[0]['brief']
        self.assertIn('No screenshots are published for this PR', brief)
        self.assertIn('**Screenshots:**', brief)

    def test_screenshots_that_cant_be_read_fail_the_review_not_block_the_pr(self):
        # Sol's review 1 of PR #114, F2: a read failure isn't "none published".
        from queue_runner.git import GitError
        r = self.one_pr()
        self.git.shots[20] = GitError('git ls-remote origin evidence failed (128): DNS')
        r.review_pass()
        [job] = self.jobs.jobs()
        self.assertEqual(job.outcome, 'failed')
        self.assertIn('ls-remote', job.error)
        self.assertEqual(self.sol.briefs, [])

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

    def test_a_resume_written_without_an_offset_is_local_time(self):
        # Before 2026-11-16 the lane wrote `resume_at` with no offset; it still pauses the lane.
        job = self.jobs.started(kind='review', repo='leads-dashboard', issue=9, branch=None,
                                title='t')
        self.jobs.ended(job.id, exit_code=None, outcome='out-of-usage',
                        resume_at='2026-11-09T14:10:00')
        r = self.one_pr(sol=FakeSol([reply()]))
        self.assertEqual(r.review_pass(), 'idle')
        later = self.reviewer(self.gh, self.git, self.sol, now=datetime.datetime(2026, 11, 9, 14, 11))
        self.assertEqual(later.review_pass(), 'started')

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
        self.assertEqual((job.outcome, job.resume_at), ('out-of-usage', datetime.datetime(
            2026, 11, 9, 14, 10).astimezone().isoformat(timespec='seconds')))   # with its offset
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

    # --- posting (ticket 04) -----------------------------------------------------------------

    def test_a_review_posts_its_comment_then_sol_review_on_the_reviewed_head(self):
        self.one_pr().review_pass()
        [(c, n, body), (st, sha, state, desc, target)] = self.gh.posts
        self.assertEqual((c, n, st, sha, state), ('comment', 20, 'status', H2, 'failure'))
        self.assertEqual(body, self.read('comment.md'))
        self.assertEqual(desc, 'Blocking: 1 Important finding (F1)')
        url = 'https://github.com/owner/first/pull/20#issuecomment-901'
        self.assertEqual(target, url)
        [job] = self.jobs.jobs()
        self.assertEqual((job.outcome, job.link), ('blocking', url))

    def test_a_posted_review_is_not_reviewed_again_on_the_same_head(self):
        r = self.one_pr()
        r.review_pass()
        self.assertEqual(r.review_pass(), 'idle')
        self.assertEqual(len(self.sol.briefs), 1)

    def test_a_new_pre_existing_finding_is_filed_once_and_linked_from_the_comment(self):
        sol = FakeSol([reply(findings=[pre_existing('F2')])])
        self.one_pr(sol=sol).review_pass()
        [(i, title, text, labels), (c, _, body), (st, sha, st_state, _, _)] = self.gh.posts
        self.assertEqual((i, c, st, sha, st_state), ("issue", "comment", "status", H2, "success"))
        self.assertEqual(labels, ('needs-triage',))
        self.assertEqual(title, 'old bug (src/b.ts)')
        self.assertIn('<!-- sol-finding owner/first#20 F2 -->', text)
        url = 'https://github.com/owner/first/issues/901'
        self.assertIn(f'F2 → [#901]({url})', body)
        [r] = read_reviews([Comment('x', '', body)])
        self.assertEqual([(f['id'], f['status'], f.get('issue')) for f in state([r])],
                         [('F2', 'filed', url)])

    def test_a_finding_filed_by_an_earlier_review_is_not_filed_again(self):
        sol = FakeSol([reply(findings=[pre_existing('F2')]), reply(findings=[pre_existing('F2')])])
        r = self.one_pr(sol=sol, ancestors={(H2, H3)})
        r.review_pass()
        self.gh.prs = [dataclasses.replace(self.gh.prs[0], head_sha=H3)]
        self.git.heads[20] = H3
        r.review_pass()
        self.assertEqual([p[0] for p in self.gh.posts],
                         ['issue', 'comment', 'status', 'comment', 'status'])
        self.assertIn('Already filed after an earlier review', self.gh.posts[3][2])

    def test_an_open_issue_that_holds_the_finding_is_linked_not_filed_again(self):
        # A comment that failed after its issues were filed left this one; the retry finds it.
        had = Issue(77, 'Something else', 'x\n<!-- sol-finding owner/first#20 F2 -->',
                    url='https://github.com/owner/first/issues/77')
        sol = FakeSol([reply(findings=[pre_existing('F2')])])
        self.one_pr(sol=sol, open_issue_list=[had]).review_pass()
        self.assertEqual([p[0] for p in self.gh.posts], ['comment', 'status'])
        self.assertIn('F2 → [#77](https://github.com/owner/first/issues/77)', self.gh.posts[0][2])

    def test_a_finding_whose_filing_failed_is_filed_by_the_next_review(self):
        # Sol didn't list F2 again in review 2: it's still filed, from the ledger.
        sol = FakeSol([reply(findings=[pre_existing('F2')]), reply()])
        r = self.one_pr(sol=sol, ancestors={(H2, H3)}, fail={'open_issues'})
        r.review_pass()
        self.gh.fail.clear()
        self.gh.prs = [dataclasses.replace(self.gh.prs[0], head_sha=H3)]
        self.git.heads[20] = H3
        r.review_pass()
        self.assertEqual([p[0] for p in self.gh.posts],
                         ['comment', 'status', 'issue', 'comment', 'status'])
        url = 'https://github.com/owner/first/issues/902'
        [rv] = read_reviews([Comment('x', '', self.gh.posts[3][2])])
        self.assertEqual([(f['id'], f.get('issue'), f.get('unfiled')) for f in state([rv])],
                         [('F2', url, None)])

    def test_open_issues_unreadable_files_nothing_and_says_so_on_the_pr(self):
        sol = FakeSol([reply(findings=[pre_existing('F2')])])
        self.one_pr(sol=sol, fail={'open_issues'}).review_pass()
        self.assertEqual([p[0] for p in self.gh.posts], ['comment', 'status'])
        self.assertIn('Filing F2 as a follow-up issue failed; the next review files it',
                      self.gh.posts[0][2])

    def test_a_comment_that_cant_be_posted_fails_the_review_and_it_is_reviewed_again(self):
        sol = FakeSol([reply(findings=[important('F1')]), reply(findings=[important('F1')])])
        r = self.one_pr(sol=sol, fail={'comment'})
        r.review_pass()
        self.assertEqual(self.gh.posts, [])   # no status without its comment
        [job] = self.jobs.jobs()
        self.assertEqual(job.outcome, 'failed')
        self.gh.fail.clear()
        self.assertEqual(r.review_pass(), 'started')
        self.assertEqual([p[0] for p in self.gh.posts], ['comment', 'status'])

    def test_a_review_that_failed_posts_nothing(self):
        self.one_pr(sol=FakeSol(['No block here.'])).review_pass()
        self.assertEqual(self.gh.posts, [])

    def test_a_failed_status_leaves_the_posted_review_standing(self):
        self.one_pr(fail={'status'}).review_pass()
        self.assertEqual([p[0] for p in self.gh.posts], ['comment'])
        self.assertEqual(self.jobs.jobs()[0].outcome, 'blocking')
        self.assertTrue(any('setting sol-review' in s for s in self.said))

    def test_a_repo_with_a_review_table_gets_its_row_in_the_pr_body(self):
        self.repo = dataclasses.replace(self.repo, review_table=True)
        self.config = dataclasses.replace(self.config, repos=[self.repo])
        body = ('Closes #5\n\n## Evidence\n\nTests pass.\n\n## Review\n\n'
                '| Step | Time (UTC) | Commit | Verdict |\n|---|---|---|---|\n'
                '| Opened | 2026-11-09 11:00 | `bbbbbbb` | Waiting on Sol |\n')
        edited = body.replace('Tests pass.', 'Tests pass, edited while Sol ran.')
        self.one_pr(body=body, bodies={20: edited}).review_pass()
        [_, _, (b, n, new)] = self.gh.posts
        self.assertEqual((b, n), ('body', 20))
        self.assertRegex(new, re.escape(
            '| Opened | 2026-11-09 11:00 | `bbbbbbb` | Waiting on Sol |\n'
            '| [Sol review 1, GPT-6.1 Sol high]'
            '(https://github.com/owner/first/pull/20#issuecomment-901) | ')
            + r'\d{4}-\d\d-\d\d \d\d:\d\d' + re.escape(
            ' | `bbbbbbb` | **Blocking**, back to fix; raised: F1; left open: F1 |\n'))
        self.assertIn('edited while Sol ran', new)   # read afresh, not from the listing

    def test_the_old_scripts_labels_no_longer_hold_a_pr(self):
        # Since the cutover (ticket 13) the old sol-pr-review.py is stopped: its labels mean nothing.
        for label in ('needs-sol-review', 'sol-reviewed'):
            with self.subTest(label=label):
                self.said.clear()
                self.jobs = JobLog(os.path.join(self.dir, label, 'jobs.jsonl'))
                r = self.one_pr(labels=(label,))
                self.assertEqual(r.review_pass(), 'started')
                self.assertEqual(len(self.sol.briefs), 1)
                self.assertFalse(any(label in s for s in self.said))


def pre_existing(fid):
    return {'id': fid, 'tag': 'pre-existing', 'class': 'old bug', 'file': 'src/b.ts', 'line': 3,
            'scenario': 'an old input, the old wrong result'}


if __name__ == '__main__':
    unittest.main()
