"""In-memory GitHub for tests: no network, no gh."""
from queue_runner.github import Issue, PullRequest


class FakeGitHub:
    def __init__(self, issues=(), states=None, prs=(), branches=(), comments=None):
        self.issues = list(issues)
        self.states = dict(states or {})
        for i in self.issues:
            self.states.setdefault(i.number, 'open')
        self.prs = list(prs)
        self.branch_names = list(branches)
        self.comments = dict(comments or {})

    def ready_issues(self, repo):
        return list(self.issues)

    def issue_state(self, github, number):
        """States keyed by (owner/name, number), or by number alone for the served repo."""
        return self.states.get((github, number), self.states.get(number, 'closed'))

    def open_pulls(self, repo):
        return list(self.prs)

    def branches(self, repo, prefix):
        return [b for b in self.branch_names if b.startswith(prefix)]

    def issue_comments(self, repo, number):
        return list(self.comments.get(number, []))


def issue(number, title='A ticket', body='', open_blockers=0, open_sub_issues=0,
          open_linked_pulls=0):
    return Issue(number=number, title=title, body=body, open_blockers=open_blockers,
                 open_sub_issues=open_sub_issues, open_linked_pulls=open_linked_pulls)


def pr(number, branch, body=''):
    return PullRequest(number=number, branch=branch, body=body)


class FakeGitHubWithPulls(FakeGitHub):
    """Also answers which PR a job opened from its branch."""

    def __init__(self, *args, pulls_by_branch=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.pulls_by_branch = dict(pulls_by_branch or {})

    def pull_for_branch(self, repo, branch):
        return self.pulls_by_branch.get(branch)


class FakeGitHubForReviews(FakeGitHubWithPulls):
    """Also what the Sol lane reads: a PR's checks, conflicts, review replies and its issues.
    It has no way to post anything, so a dry run that tried would fail."""

    def __init__(self, *args, checks=None, conflicts=(), replies=None, issue_bodies=None,
                 **kwargs):
        super().__init__(*args, **kwargs)
        self.check_states = dict(checks or {})        # sha -> Checks; default passed
        self.conflicts = set(conflicts)
        self.replies = dict(replies or {})            # PR number -> [Comment]
        self.issue_bodies = dict(issue_bodies or {})  # (github, number) -> Issue

    def checks(self, repo, sha):
        from queue_runner.github import Checks
        return self.check_states.get(sha, Checks('passed'))

    def has_conflict(self, repo, number):
        return number in self.conflicts

    def review_replies(self, repo, number):
        return list(self.replies.get(number, []))

    def issue(self, github, number):
        return self.issue_bodies[(github, number)]


def full_pr(number, branch, head_sha, body='', title='A PR', base='main', labels=()):
    return PullRequest(number=number, branch=branch, body=body, title=title, head_sha=head_sha,
                       base=base, url=f'https://github.com/owner/first/pull/{number}',
                       labels=tuple(labels))
