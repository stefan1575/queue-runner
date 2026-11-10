"""GitHub as the runner sees it: the seam, its data, and the gh adapter."""
import json
from urllib.parse import quote
from dataclasses import dataclass


@dataclass(frozen=True)
class Issue:
    number: int
    title: str
    body: str
    open_blockers: int = 0      # GitHub's native dependencies still open
    open_sub_issues: int = 0    # a spec or map: its children are the work
    open_linked_pulls: int = 0  # open PRs GitHub links to it (closing keyword or linked by hand)
    url: str = ''


@dataclass(frozen=True)
class PullRequest:
    number: int
    branch: str
    body: str
    title: str = ''
    head_sha: str = ''     # H: the commit a review reviews
    base: str = ''         # the branch it merges into (not always main: PRs stack)
    url: str = ''
    labels: tuple = ()
    draft: bool = False
    state: str = 'open'            # `pull` only: open, closed or merged
    mergeable: bool | None = None  # `pull` only: None while GitHub is still working it out


@dataclass(frozen=True)
class Comment:
    author: str
    created_at: str
    body: str
    path: str | None = None   # a review thread's file and line
    line: int | None = None


@dataclass(frozen=True)
class Checks:
    """A commit's checks, the `sol-review` status left out: passed, failed, pending, or none
    (nothing reported yet)."""
    state: str
    failed: tuple = ()
    pending: tuple = ()


# Until the cutover (ticket 13) the old ~/sol-pr-review.py still reviews PRs carrying these
# labels: the runner leaves them to it (no review, fix round or merge), so the two never meet.
OLD_LABELS = ('needs-sol-review', 'sol-reviewed')

# The runner's own status on a reviewed commit: never counted as one of its checks.
SOL_REVIEW = 'sol-review'
_PASSED = {'success', 'neutral', 'skipped'}


class GhError(RuntimeError):
    pass


def _pull(p: dict) -> PullRequest:
    return PullRequest(number=p['number'], branch=p['head']['ref'], body=p.get('body') or '',
                       title=p.get('title') or '', head_sha=p['head'].get('sha') or '',
                       base=(p.get('base') or {}).get('ref') or '', url=p.get('html_url') or '',
                       labels=tuple(lb['name'] for lb in p.get('labels') or ()),
                       draft=bool(p.get('draft')),
                       state='merged' if p.get('merged_at') else p.get('state') or 'open',
                       mergeable=p.get('mergeable'))


def run_gh(args: list[str], input: str | None = None) -> str:
    """Runs `gh` with no console window (the runner lives under pythonw). `input` goes to its
    stdin: a write's JSON body (`--input -`), which keeps a long comment off the command line."""
    import subprocess
    p = subprocess.run(['gh', *args], capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=120,
                       **({'input': input} if input is not None else {'stdin': subprocess.DEVNULL}),
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if p.returncode:
        raise GhError(f"gh {' '.join(args)} failed ({p.returncode}): {p.stderr.strip()}")
    return p.stdout


_LINKED_PULLS = '''
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $endCursor, states: OPEN, labels: ["ready-for-agent"]) {
      pageInfo { hasNextPage endCursor }
      nodes { number closedByPullRequestsReferences(first: 20, includeClosedPrs: false) {
        nodes { state } } }
    }
  }
}'''


_THREADS = '''
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}'''


class GhCli:
    """GitHub through `gh api` (REST). `run` takes gh's arguments and returns its stdout."""

    def __init__(self, run=run_gh):
        self._run = run

    def _get(self, endpoint):
        return json.loads(self._run(['api', endpoint]))

    def _all(self, endpoint):
        pages = json.loads(self._run(['api', '--paginate', '--slurp', endpoint]))
        return [item for page in pages for item in page]

    def _linked_open_pulls(self, repo) -> dict[int, int]:
        """Open PRs GitHub links to each ready issue: by closing keyword, or by hand in the
        Development sidebar. REST doesn't expose the links; GraphQL does."""
        owner, name = repo.github.split('/')
        pages = json.loads(self._run(['api', 'graphql', '--paginate', '--slurp',
                                      '-f', f'query={_LINKED_PULLS}', '-f', f'owner={owner}',
                                      '-f', f'name={name}']))
        counts = {}
        for page in pages:
            for node in page['data']['repository']['issues']['nodes']:
                refs = node['closedByPullRequestsReferences']
                counts[node['number']] = sum(1 for p in refs['nodes'] if p['state'] == 'OPEN')
        return counts

    def ready_issues(self, repo) -> list[Issue]:
        linked = self._linked_open_pulls(repo)
        found = []
        for i in self._all(f'repos/{repo.github}/issues?state=open&labels=ready-for-agent&per_page=100'):
            if 'pull_request' in i:
                continue
            deps = i.get('issue_dependencies_summary') or {}
            subs = i.get('sub_issues_summary') or {}
            found.append(Issue(number=i['number'], title=i['title'], body=i.get('body') or '',
                               open_blockers=deps.get('blocked_by', 0),
                               open_sub_issues=subs.get('total', 0) - subs.get('completed', 0),
                               open_linked_pulls=linked.get(i['number'], 0)))
        return found

    def issue_state(self, github: str, number: int) -> str:
        """'open' or 'closed', for an issue in any repo (`owner/name`)."""
        return self._get(f'repos/{github}/issues/{number}')['state']

    def open_pulls(self, repo) -> list[PullRequest]:
        return [_pull(p) for p in self._all(f'repos/{repo.github}/pulls?state=open&per_page=100')]

    def pull(self, repo, number) -> PullRequest:
        """One PR as GitHub has it now, with its state and whether it can merge."""
        return _pull(self._get(f'repos/{repo.github}/pulls/{number}'))

    def open_threads(self, repo, number) -> int:
        """The PR's review threads nobody has resolved (outdated ones count: still unanswered)."""
        owner, name = repo.github.split('/')
        pages = json.loads(self._run(['api', 'graphql', '--paginate', '--slurp',
                                      '-f', f'query={_THREADS}', '-f', f'owner={owner}',
                                      '-f', f'name={name}', '-F', f'number={number}']))
        return sum(not t['isResolved'] for page in pages for t in
                   page['data']['repository']['pullRequest']['reviewThreads']['nodes'])

    def checks(self, repo, sha) -> Checks:
        """Check runs and commit statuses on `sha`, leaving out `sol-review`."""
        runs = self._get(f'repos/{repo.github}/commits/{sha}/check-runs?per_page=100')
        status = self._get(f'repos/{repo.github}/commits/{sha}/status')
        seen = [(r['name'], r['conclusion'] if r['status'] == 'completed' else 'pending')
                for r in runs.get('check_runs') or ()]
        seen += [(s['context'], s['state']) for s in status.get('statuses') or ()
                 if s['context'] != SOL_REVIEW]
        failed = tuple(n for n, s in seen if s not in _PASSED and s != 'pending')
        pending = tuple(n for n, s in seen if s == 'pending')
        state = ('none' if not seen else 'failed' if failed else 'pending' if pending
                 else 'passed')
        return Checks(state, failed=failed, pending=pending)

    def has_conflict(self, repo, number) -> bool:
        """True once GitHub says the PR can't merge cleanly; unknown (still computing) is False."""
        return self._get(f'repos/{repo.github}/pulls/{number}').get('mergeable') is False

    def review_replies(self, repo, number) -> list[Comment]:
        """A PR's review-thread comments and non-empty review bodies (its other comments are
        `issue_comments`)."""
        said = [Comment(author=(c.get('user') or {}).get('login', 'ghost'),
                        created_at=c['created_at'], body=c.get('body') or '', path=c.get('path'),
                        line=c.get('line') or c.get('original_line'))
                for c in self._all(f'repos/{repo.github}/pulls/{number}/comments?per_page=100')]
        said += [Comment(author=(r.get('user') or {}).get('login', 'ghost'),
                         created_at=r['submitted_at'], body=r['body'])
                 for r in self._all(f'repos/{repo.github}/pulls/{number}/reviews?per_page=100')
                 if r.get('body') and r.get('submitted_at')]
        return said

    def issue(self, github: str, number: int) -> Issue:
        """An issue's title and body, in any repo (`owner/name`)."""
        i = self._get(f'repos/{github}/issues/{number}')
        return Issue(number=i['number'], title=i['title'], body=i.get('body') or '')

    def branches(self, repo, prefix) -> list[str]:
        refs = self._all(f'repos/{repo.github}/git/matching-refs/heads/{prefix}')
        return [r['ref'].removeprefix('refs/heads/') for r in refs]

    def pull_for_branch(self, repo, branch) -> dict | None:
        """The newest PR opened from `branch`, open or not: {number, url, state}, where state is
        open, closed or merged."""
        owner = repo.github.split('/')[0]
        pulls = self._all(f'repos/{repo.github}/pulls?head={owner}:{branch}&state=all&per_page=100')
        if not pulls:
            return None
        p = max(pulls, key=lambda p: p['number'])
        return {'number': p['number'], 'url': p['html_url'],
                'state': 'merged' if p.get('merged_at') else p['state']}

    def issue_comments(self, repo, number) -> list[Comment]:
        return [Comment(author=(c.get('user') or {}).get('login', 'ghost'),
                        created_at=c['created_at'], body=c.get('body') or '')
                for c in self._all(f'repos/{repo.github}/issues/{number}/comments?per_page=100')]

    # --- writes: the review's automated posts (no go-ahead needed, ~/.claude/CLAUDE.md) --------

    def _send(self, method, endpoint, data) -> dict:
        out = self._run(['api', '-X', method, endpoint, '--input', '-'],
                        input=json.dumps(data, ensure_ascii=False))
        return json.loads(out) if out.strip() else {}

    def open_issues(self, repo) -> list[Issue]:
        """Every open issue (not PR), with its body and URL: where a follow-up may be filed
        already."""
        return [Issue(number=i['number'], title=i['title'], body=i.get('body') or '',
                      url=i.get('html_url') or '')
                for i in self._all(f'repos/{repo.github}/issues?state=open&per_page=100')
                if 'pull_request' not in i]

    def post_comment(self, repo, number, body) -> str:
        """Comments on an issue or PR; returns the comment's URL."""
        return self._send('POST', f'repos/{repo.github}/issues/{number}/comments',
                          {'body': body})['html_url']

    def create_issue(self, repo, title, body, labels=()) -> str:
        """Files an issue; returns its URL."""
        return self._send('POST', f'repos/{repo.github}/issues',
                          {'title': title, 'body': body, 'labels': list(labels)})['html_url']

    def close_not_planned(self, repo, number) -> None:
        """Closes an issue as not planned (a decision found it isn't needed)."""
        self._send('PATCH', f'repos/{repo.github}/issues/{number}',
                   {'state': 'closed', 'state_reason': 'not_planned'})

    def set_status(self, repo, sha, state, description, target_url='', context=SOL_REVIEW):
        """A commit status on exactly `sha`."""
        self._send('POST', f'repos/{repo.github}/statuses/{sha}',
                   {'state': state, 'context': context, 'description': description[:140],
                    **({'target_url': target_url} if target_url else {})})

    def pull_body(self, repo, number) -> str:
        return self._get(f'repos/{repo.github}/pulls/{number}').get('body') or ''

    def edit_pull_body(self, repo, number, body) -> None:
        self._send('PATCH', f'repos/{repo.github}/pulls/{number}', {'body': body})

    def add_label(self, repo, number, label) -> None:
        """Adds a label to an issue or PR (GitHub makes the label if the repo has none)."""
        self._send('POST', f'repos/{repo.github}/issues/{number}/labels', {'labels': [label]})

    def remove_label(self, repo, number, label) -> None:
        self._run(['api', '-X', 'DELETE',
                   f'repos/{repo.github}/issues/{number}/labels/{quote(label)}'])

    def merge(self, repo, number, sha) -> str:
        """Merges the PR with a merge commit, only if its head is still `sha` (GitHub refuses
        otherwise: 409). Returns the merge commit's sha."""
        return self._send('PUT', f'repos/{repo.github}/pulls/{number}/merge',
                          {'sha': sha, 'merge_method': 'merge'}).get('sha') or ''
