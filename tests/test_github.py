import json
import unittest

from queue_runner.config import Repo
from queue_runner.github import Checks, Comment, GhCli, Issue, PullRequest, WorkflowRun

REPO = Repo(name='demo', github='owner/demo', path='C:/demo')


class FakeGh:
    """Answers `gh api` calls from canned REST responses, keyed by endpoint."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []
        self.inputs = []   # each write's JSON body, sent on stdin

    def __call__(self, args, input=None):
        self.calls.append(args)
        if input is not None:
            self.inputs.append(json.loads(input))
        endpoint = next(a for a in args if a.startswith('repos/') or a == 'graphql')
        data = self.responses[endpoint]
        # --paginate --slurp wraps each page in an outer list
        return json.dumps([data] if '--slurp' in args else data)


class GhCliTest(unittest.TestCase):
    def test_writes_send_their_json_on_stdin_and_return_the_url(self):
        repo = Repo(name='demo', github='owner/demo', path='.')
        gh = FakeGh({'repos/owner/demo/issues/4/comments': {'html_url': 'C'},
                     'repos/owner/demo/issues': {'html_url': 'I'},
                     'repos/owner/demo/statuses/' + 'a' * 40: {},
                     'repos/owner/demo/pulls/4': {}})
        cli = GhCli(run=gh)
        body = 'A long comment' * 2000 + '<!-- marker é -->'
        self.assertEqual(cli.post_comment(repo, 4, body), 'C')
        self.assertEqual(cli.create_issue(repo, 'T', 'B', ['needs-triage']), 'I')
        cli.set_status(repo, 'a' * 40, 'success', 'x' * 200, 'C')
        cli.edit_pull_body(repo, 4, 'New body')
        self.assertEqual([c[:3] for c in gh.calls], [['api', '-X', 'POST']] * 3
                         + [['api', '-X', 'PATCH']])
        self.assertTrue(all(c[-2:] == ['--input', '-'] for c in gh.calls))
        self.assertEqual(gh.inputs, [
            {'body': body},
            {'title': 'T', 'body': 'B', 'labels': ['needs-triage']},
            {'state': 'success', 'context': 'sol-review', 'description': 'x' * 140,
             'target_url': 'C'},
            {'body': 'New body'}])

    def test_blocking_lists_the_open_issues_an_issue_blocks_by_githubs_dependencies(self):
        gh = FakeGh({'repos/owner/demo/issues/115/dependencies/blocking?per_page=100': [
            {'number': 116, 'title': 'Recipients', 'body': 'b', 'state': 'open',
             'html_url': 'https://github.com/owner/demo/issues/116'},
            {'number': 117, 'title': 'Done', 'body': None, 'state': 'closed'}]})
        self.assertEqual(GhCli(run=gh).blocking(REPO, 115), [
            Issue(116, 'Recipients', 'b', url='https://github.com/owner/demo/issues/116')])

    def test_ready_issues_skip_pull_requests_and_count_open_blockers_and_sub_issues(self):
        gh = FakeGh({'repos/owner/demo/issues?state=open&labels=ready-for-agent&per_page=100': [
            {'number': 7, 'title': 'T', 'body': None,
             'issue_dependencies_summary': {'blocked_by': 1, 'total_blocked_by': 2},
             'sub_issues_summary': {'total': 5, 'completed': 2}},
            {'number': 8, 'title': 'A PR', 'body': '', 'pull_request': {'url': 'x'}},
            {'number': 9, 'title': 'Old', 'body': 'b'},
        ], 'graphql': {'data': {'repository': {'issues': {
            'pageInfo': {'hasNextPage': False, 'endCursor': None},
            'nodes': [{'number': 9, 'closedByPullRequestsReferences': {'nodes': [
                          {'state': 'OPEN'}, {'state': 'MERGED'}, {'state': 'OPEN'}]}},
                      {'number': 7, 'closedByPullRequestsReferences': {'nodes': []}}]}}}}})
        self.assertEqual(GhCli(gh).ready_issues(REPO), [
            Issue(7, 'T', '', open_blockers=1, open_sub_issues=3),
            Issue(9, 'Old', 'b', open_linked_pulls=2),
        ])
        query = next(c for c in gh.calls if 'graphql' in c)
        self.assertIn('owner=owner', query)
        self.assertIn('name=demo', query)

    def test_ready_issues_with_every_native_blocker_closed_count_none_open(self):
        # #73, checked live on 2026-11-16: `blocked_by` is the open count (queue-runner #50 has
        # `{"blocked_by": 0, "total_blocked_by": 3}` with its three blockers closed).
        gh = FakeGh({'repos/owner/demo/issues?state=open&labels=ready-for-agent&per_page=100': [
            {'number': 50, 'title': 'T', 'body': '',
             'issue_dependencies_summary': {'blocked_by': 0, 'blocking': 0,
                                            'total_blocked_by': 3, 'total_blocking': 0}},
        ], 'graphql': {'data': {'repository': {'issues': {
            'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'nodes': []}}}}})
        self.assertEqual(GhCli(gh).ready_issues(REPO), [Issue(50, 'T', '')])

    def test_issue_state(self):
        gh = FakeGh({'repos/owner/demo/issues/3': {'number': 3, 'state': 'closed'}})
        self.assertEqual(GhCli(gh).issue_state('owner/demo', 3), 'closed')

    def test_open_pulls(self):
        gh = FakeGh({'repos/owner/demo/pulls?state=open&per_page=100': [
            {'number': 20, 'head': {'ref': 'claude/x-5'}, 'body': None}]})
        self.assertEqual(GhCli(gh).open_pulls(REPO), [PullRequest(20, 'claude/x-5', '')])

    def test_open_pulls_carry_what_a_review_needs(self):
        gh = FakeGh({'repos/owner/demo/pulls?state=open&per_page=100': [
            {'number': 20, 'title': 'Red', 'body': 'Closes #5', 'draft': False,
             'html_url': 'https://github.com/owner/demo/pull/20',
             'head': {'ref': 'claude/x-5', 'sha': 'a' * 40}, 'base': {'ref': 'claude/y-4'},
             'labels': [{'name': 'sol-reviewed'}]}]})
        [p] = GhCli(gh).open_pulls(REPO)
        self.assertEqual((p.title, p.head_sha, p.base, p.url, p.labels),
                         ('Red', 'a' * 40, 'claude/y-4', 'https://github.com/owner/demo/pull/20',
                          ('sol-reviewed',)))

    def checks(self, runs, statuses):
        sha = 'a' * 40
        return GhCli(FakeGh({
            f'repos/owner/demo/commits/{sha}/check-runs?per_page=100': {
                'total_count': len(runs), 'check_runs': [
                    {'name': n, 'status': s, 'conclusion': c} for n, s, c in runs]},
            f'repos/owner/demo/commits/{sha}/status': {
                'state': 'x', 'statuses': [{'context': n, 'state': s} for n, s in statuses]},
        })).checks(REPO, sha)

    def test_checks_pass_when_every_check_and_status_passed_leaving_out_sol_review(self):
        c = self.checks([('check', 'completed', 'success'), ('lint', 'completed', 'skipped')],
                        [('sol-review', 'failure'), ('deploy', 'success')])
        self.assertEqual(c, Checks('passed', failed=(), pending=()))

    def test_checks_fail_when_any_failed_and_wait_while_any_runs(self):
        self.assertEqual(self.checks([('check', 'completed', 'failure'),
                                      ('e2e', 'in_progress', None)], []).state, 'failed')
        c = self.checks([('check', 'in_progress', None)], [('deploy', 'pending')])
        self.assertEqual((c.state, c.pending), ('pending', ('check', 'deploy')))
        self.assertEqual(self.checks([], [('ci', 'error')]).failed, ('ci',))

    def test_a_failed_actions_check_names_its_run_so_it_can_be_re_run(self):
        sha = 'a' * 40
        runs = [{'name': 'tests', 'status': 'completed', 'conclusion': 'failure',
                 'app': {'slug': 'github-actions'},
                 'details_url': 'https://github.com/owner/demo/actions/runs/437/job/9'},
                {'name': 'lint', 'status': 'completed', 'conclusion': 'failure',
                 'app': {'slug': 'github-actions'},
                 'details_url': 'https://github.com/owner/demo/actions/runs/437/job/10'},
                {'name': 'build', 'status': 'completed', 'conclusion': 'success',
                 'app': {'slug': 'github-actions'},
                 'details_url': 'https://github.com/owner/demo/actions/runs/438/job/11'}]

        def checks(statuses=(), more=()):
            return GhCli(FakeGh({
                f'repos/owner/demo/commits/{sha}/check-runs?per_page=100':
                    {'check_runs': runs + list(more)},
                f'repos/owner/demo/commits/{sha}/status': {'statuses': list(statuses)},
            })).checks(REPO, sha)
        self.assertEqual(checks().runs, (437,))
        # A failed commit status, or a check run from outside Actions, can't be re-run: no runs.
        self.assertEqual(checks([{'context': 'deploy', 'state': 'failure'}]).runs, ())
        self.assertEqual(checks(more=[{'name': 'x', 'status': 'completed',
                                       'conclusion': 'failure', 'app': {'slug': 'circleci'},
                                       'details_url': 'https://circleci.com/1'}]).runs, ())

    def test_a_workflow_run_s_attempt_and_its_re_run(self):
        gh = FakeGh({'repos/owner/demo/actions/runs/437': {
                        'id': 437, 'run_attempt': 2, 'status': 'in_progress', 'conclusion': None,
                        'html_url': 'https://github.com/owner/demo/actions/runs/437'},
                     'repos/owner/demo/actions/runs/437/rerun-failed-jobs': {}})
        cli = GhCli(gh)
        self.assertEqual(cli.workflow_run(REPO, 437),
                         WorkflowRun(437, 2, 'in_progress', None,
                                     'https://github.com/owner/demo/actions/runs/437'))
        cli.rerun_failed(REPO, 437)
        self.assertEqual(gh.calls[-1], ['api', '-X', 'POST',
                                        'repos/owner/demo/actions/runs/437/rerun-failed-jobs'])

    def test_no_checks_yet(self):
        self.assertEqual(self.checks([], [('sol-review', 'success')]).state, 'none')

    def test_a_pull_request_with_a_conflict(self):
        gh = FakeGh({'repos/owner/demo/pulls/20': {'mergeable': False, 'mergeable_state': 'dirty'},
                     'repos/owner/demo/pulls/21': {'mergeable': None, 'mergeable_state': 'unknown'}})
        self.assertTrue(GhCli(gh).has_conflict(REPO, 20))
        self.assertFalse(GhCli(gh).has_conflict(REPO, 21))

    def test_review_threads_and_review_bodies_as_replies(self):
        gh = FakeGh({
            'repos/owner/demo/pulls/20/comments?per_page=100': [
                {'user': {'login': 'claude'}, 'created_at': '2026-11-02T00:00:00Z',
                 'body': 'F1 declined', 'path': 'src/a.ts', 'line': None, 'original_line': 9}],
            'repos/owner/demo/pulls/20/reviews?per_page=100': [
                {'user': {'login': 'stefan'}, 'submitted_at': '2026-11-03T00:00:00Z', 'body': ''},
                {'user': {'login': 'stefan'}, 'submitted_at': '2026-11-04T00:00:00Z',
                 'body': 'Looks odd'}]})
        self.assertEqual(GhCli(gh).review_replies(REPO, 20), [
            Comment('claude', '2026-11-02T00:00:00Z', 'F1 declined', path='src/a.ts', line=9),
            Comment('stefan', '2026-11-04T00:00:00Z', 'Looks odd')])

    def test_an_issue_in_any_repo(self):
        gh = FakeGh({'repos/other/x/issues/3': {'number': 3, 'title': 'T', 'body': None}})
        self.assertEqual(GhCli(gh).issue('other/x', 3), Issue(3, 'T', ''))

    def test_branches_under_a_prefix(self):
        gh = FakeGh({'repos/owner/demo/git/matching-refs/heads/claude/': [
            {'ref': 'refs/heads/claude/x-5'}, {'ref': 'refs/heads/claude/y-6'}]})
        self.assertEqual(GhCli(gh).branches(REPO, 'claude/'), ['claude/x-5', 'claude/y-6'])

    def test_issue_comments(self):
        gh = FakeGh({'repos/owner/demo/issues/4/comments?per_page=100': [
            {'user': {'login': 'stefan'}, 'created_at': '2026-11-01T10:00:00Z', 'body': 'Hi'}]})
        self.assertEqual(GhCli(gh).issue_comments(REPO, 4),
                         [Comment('stefan', '2026-11-01T10:00:00Z', 'Hi')])

    def test_the_newest_pull_request_from_a_branch_in_any_state(self):
        gh = FakeGh({'repos/owner/demo/pulls?head=owner:claude/x-5&state=all&per_page=100': [
            {'number': 21, 'html_url': 'https://github.com/owner/demo/pull/21', 'state': 'open',
             'merged_at': None, 'head': {'ref': 'claude/x-5'}},
            {'number': 20, 'html_url': 'https://github.com/owner/demo/pull/20', 'state': 'closed',
             'merged_at': None, 'head': {'ref': 'claude/x-5'}}]})
        self.assertEqual(GhCli(gh).pull_for_branch(REPO, 'claude/x-5'),
                         {'number': 21, 'url': 'https://github.com/owner/demo/pull/21',
                          'state': 'open'})

    def test_no_pull_request_from_a_branch(self):
        gh = FakeGh({'repos/owner/demo/pulls?head=owner:claude/x-5&state=all&per_page=100': []})
        self.assertIsNone(GhCli(gh).pull_for_branch(REPO, 'claude/x-5'))


if __name__ == '__main__':
    unittest.main()


class MergeCallsTest(unittest.TestCase):
    """Ticket 05: one PR afresh, its unresolved review threads, and the expected-head merge."""

    def test_a_pr_read_afresh_has_its_state_and_whether_it_can_merge(self):
        gh = FakeGh({'repos/owner/demo/pulls/4': {
            'number': 4, 'head': {'ref': 'claude/x-1', 'sha': 'b' * 40}, 'base': {'ref': 'main'},
            'state': 'closed', 'merged_at': '2026-11-10T00:00:00Z', 'mergeable': None,
            'draft': False, 'labels': [], 'title': 'X', 'body': None, 'html_url': 'U'}})
        pr = GhCli(run=gh).pull(REPO, 4)
        self.assertEqual((pr.head_sha, pr.state, pr.mergeable, pr.base), ('b' * 40, 'merged',
                                                                          None, 'main'))

    def test_unresolved_review_threads_are_counted(self):
        gh = FakeGh({'graphql': {'data': {'repository': {'pullRequest': {'reviewThreads': {
            'pageInfo': {'hasNextPage': False, 'endCursor': None},
            'nodes': [{'isResolved': True}, {'isResolved': False}]}}}}}})
        self.assertEqual(GhCli(run=gh).open_threads(REPO, 4), 1)
        self.assertIn('number=4', gh.calls[0])
        self.assertIn('-F', gh.calls[0])   # an Int, not a string

    def test_the_merge_sends_the_expected_head_and_a_merge_commit(self):
        gh = FakeGh({'repos/owner/demo/pulls/4/merge': {'sha': 'm' * 40, 'merged': True}})
        self.assertEqual(GhCli(run=gh).merge(REPO, 4, 'b' * 40), 'm' * 40)
        self.assertEqual(gh.calls[0][:3], ['api', '-X', 'PUT'])
        self.assertEqual(gh.inputs, [{'sha': 'b' * 40, 'merge_method': 'merge'}])


class WorkIssuesTest(unittest.TestCase):
    """The snapshot's work lists (ticket 32): a repo's open issues with their labels, parent,
    sub-issues and blockers, in one paged GraphQL query."""

    def test_open_issues_with_labels_parent_sub_issues_and_blockers(self):
        node = lambda n, **kw: {'number': n, 'title': f'T{n}', 'body': kw.get('body', ''),
                                'url': f'https://github.com/owner/demo/issues/{n}',
                                'labels': {'nodes': [{'name': x} for x in kw.get('labels', ())]},
                                'parent': kw.get('parent'),
                                'subIssues': {'nodes': kw.get('subs', [])},
                                'blockedBy': {'nodes': kw.get('blocked', [])}}
        here = {'nameWithOwner': 'owner/demo'}
        page = {'data': {'repository': {'issues': {
            'pageInfo': {'hasNextPage': False, 'endCursor': None},
            'nodes': [
                node(1, labels=['spec'], subs=[
                    {'number': 2, 'title': 'T2', 'state': 'CLOSED', 'repository': here,
                     'url': 'https://github.com/owner/demo/issues/2'},
                    {'number': 4, 'title': 'T4', 'state': 'OPEN', 'repository': here,
                     'url': 'https://github.com/owner/demo/issues/4'}]),
                node(4, labels=['ready-for-agent'], parent={'number': 1}, body='Blocked by: #9',
                     blocked=[{'number': 2, 'state': 'CLOSED', 'repository': here},
                              {'number': 7, 'state': 'OPEN',
                               'repository': {'nameWithOwner': 'other/x'}}]),
            ]}}}}
        gh = FakeGh({'graphql': page})
        got = GhCli(run=gh).work_issues(REPO)
        self.assertEqual([i.number for i in got], [1, 4])
        spec, four = got
        self.assertEqual(spec.labels, ('spec',))
        self.assertIsNone(spec.parent)
        self.assertEqual([(s.number, s.state, s.title) for s in spec.sub_issues],
                         [(2, 'closed', 'T2'), (4, 'open', 'T4')])
        self.assertEqual(four.parent, 1)
        self.assertEqual(four.body, 'Blocked by: #9')
        self.assertEqual(four.blocked_by, (('owner/demo', 2, 'closed'), ('other/x', 7, 'open')))
        self.assertEqual(four.url, 'https://github.com/owner/demo/issues/4')
        self.assertIn('--paginate', gh.calls[0])
