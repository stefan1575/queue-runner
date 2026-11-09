"""GitHub as the runner sees it: the seam, its data, and the gh adapter."""
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Issue:
    number: int
    title: str
    body: str
    open_blockers: int = 0      # GitHub's native dependencies still open
    open_sub_issues: int = 0    # a spec or map: its children are the work
    open_linked_pulls: int = 0  # open PRs GitHub links to it (closing keyword or linked by hand)


@dataclass(frozen=True)
class PullRequest:
    number: int
    branch: str
    body: str


@dataclass(frozen=True)
class Comment:
    author: str
    created_at: str
    body: str


class GhError(RuntimeError):
    pass


def run_gh(args: list[str]) -> str:
    """Runs `gh` with no console window (the runner lives under pythonw)."""
    import subprocess
    p = subprocess.run(['gh', *args], capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=120, stdin=subprocess.DEVNULL,
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
        return [PullRequest(number=p['number'], branch=p['head']['ref'], body=p.get('body') or '')
                for p in self._all(f'repos/{repo.github}/pulls?state=open&per_page=100')]

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
