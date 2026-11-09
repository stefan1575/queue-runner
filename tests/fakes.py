"""In-memory GitHub for tests: no network, no gh."""
from queue_runner.github import Comment, Issue, PullRequest


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
    """Also what the Sol lane reads (a PR's checks, conflicts, review replies, its issues and
    body) and what it posts: every write goes to `posts`, in order, as (call, args...). A call
    named in `fail` raises."""

    def __init__(self, *args, checks=None, conflicts=(), replies=None, issue_bodies=None,
                 open_issue_list=(), bodies=None, fail=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.open_issue_list = list(open_issue_list)
        self.bodies = dict(bodies or {})              # PR number -> its body now
        self.fail = set(fail)
        self.posts = []
        self._next = 900
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

    def open_issues(self, repo):
        if 'open_issues' in self.fail:
            raise RuntimeError('gh failed')
        return list(self.open_issue_list)

    def pull_body(self, repo, number):
        return self.bodies.get(number, next((p.body for p in self.prs if p.number == number), ''))

    def _write(self, call, *args):
        if call in self.fail:
            raise RuntimeError(f'{call} failed')
        self.posts.append((call, *args))

    def post_comment(self, repo, number, body):
        self._write('comment', number, body)
        self.comments.setdefault(number, []).append(Comment('stefan1575', '2026-11-09T12:00:00Z',
                                                            body))
        self._next += 1
        return f'https://github.com/{repo.github}/pull/{number}#issuecomment-{self._next}'

    def create_issue(self, repo, title, body, labels=()):
        self._write('issue', title, body, tuple(labels))
        self._next += 1
        self.open_issue_list.append(Issue(self._next, title, body,
                                          url=f'https://github.com/{repo.github}/issues/{self._next}'))
        return f'https://github.com/{repo.github}/issues/{self._next}'

    def set_status(self, repo, sha, state, description, target_url='', context='sol-review'):
        self._write('status', sha, state, description, target_url)

    def edit_pull_body(self, repo, number, body):
        self._write('body', number, body)
        self.bodies[number] = body


def full_pr(number, branch, head_sha, body='', title='A PR', base='main', labels=()):
    return PullRequest(number=number, branch=branch, body=body, title=title, head_sha=head_sha,
                       base=base, url=f'https://github.com/owner/first/pull/{number}',
                       labels=tuple(labels))
