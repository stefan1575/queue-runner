import json
import unittest

from queue_runner.config import Repo
from queue_runner.github import Comment, GhCli, Issue, PullRequest

REPO = Repo(name='demo', github='owner/demo', path='C:/demo')


class FakeGh:
    """Answers `gh api` calls from canned REST responses, keyed by endpoint."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        endpoint = next(a for a in args if a.startswith('repos/') or a == 'graphql')
        data = self.responses[endpoint]
        # --paginate --slurp wraps each page in an outer list
        return json.dumps([data] if '--slurp' in args else data)


class GhCliTest(unittest.TestCase):
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

    def test_issue_state(self):
        gh = FakeGh({'repos/owner/demo/issues/3': {'number': 3, 'state': 'closed'}})
        self.assertEqual(GhCli(gh).issue_state('owner/demo', 3), 'closed')

    def test_open_pulls(self):
        gh = FakeGh({'repos/owner/demo/pulls?state=open&per_page=100': [
            {'number': 20, 'head': {'ref': 'claude/x-5'}, 'body': None}]})
        self.assertEqual(GhCli(gh).open_pulls(REPO), [PullRequest(20, 'claude/x-5', '')])

    def test_branches_under_a_prefix(self):
        gh = FakeGh({'repos/owner/demo/git/matching-refs/heads/claude/': [
            {'ref': 'refs/heads/claude/x-5'}, {'ref': 'refs/heads/claude/y-6'}]})
        self.assertEqual(GhCli(gh).branches(REPO, 'claude/'), ['claude/x-5', 'claude/y-6'])

    def test_issue_comments(self):
        gh = FakeGh({'repos/owner/demo/issues/4/comments?per_page=100': [
            {'user': {'login': 'stefan'}, 'created_at': '2026-11-01T10:00:00Z', 'body': 'Hi'}]})
        self.assertEqual(GhCli(gh).issue_comments(REPO, 4),
                         [Comment('stefan', '2026-11-01T10:00:00Z', 'Hi')])


if __name__ == '__main__':
    unittest.main()
