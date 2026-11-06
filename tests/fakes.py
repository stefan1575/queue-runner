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

    def issue_state(self, repo, number):
        return self.states.get(number, 'closed')

    def open_pulls(self, repo):
        return list(self.prs)

    def branches(self, repo, prefix):
        return [b for b in self.branch_names if b.startswith(prefix)]

    def issue_comments(self, repo, number):
        return list(self.comments.get(number, []))


def issue(number, title='A ticket', body='', open_blockers=0, open_sub_issues=0):
    return Issue(number=number, title=title, body=body, open_blockers=open_blockers,
                 open_sub_issues=open_sub_issues)


def pr(number, branch, body=''):
    return PullRequest(number=number, branch=branch, body=body)
