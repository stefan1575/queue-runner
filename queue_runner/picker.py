"""Which ticket the runner builds next."""
import re
from dataclasses import dataclass

from .config import Repo
from .github import Issue

_HEADING = re.compile(r'^\s{0,3}#{1,6}\s')
_BLOCKED_BY = re.compile(r'^[\s>*_#-]*blocked by\b', re.IGNORECASE)
# An issue reference: a github.com URL, `owner/name#N`, or `#N` (this repo).
_REF = (r'(?:https://github\.com/(?P<url_repo>[\w.-]+/[\w.-]+)/issues/(?P<url_n>\d+)'
        r'|(?<![\w/#.-])(?:(?P<repo>[\w.-]+/[\w.-]+))?#(?P<n>\d+)\b)')
_REFS = re.compile(_REF)
_CLOSES = re.compile(r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+' + _REF, re.IGNORECASE)
_CLAUDE_BRANCH = re.compile(r'^claude/.+-(\d+)$')


_WORD = re.compile(r'[a-z0-9]+')


@dataclass(frozen=True)
class BuildJob:
    repo: Repo
    issue: Issue
    branch: str     # claude/<slug>-<issue>
    base: str       # origin/<repo base>


def slug(title: str, words: int = 4) -> str:
    return '-'.join(_WORD.findall(title.lower())[:words]) or 'issue'


def _refs(pattern, text: str, here: str) -> list[tuple[str, int]]:
    """(owner/name, number) for each reference; a bare `#N` is in `here`."""
    found = []
    for m in pattern.finditer(text):
        if m['url_n']:
            found.append((m['url_repo'].lower(), int(m['url_n'])))
        else:
            found.append(((m['repo'] or here).lower(), int(m['n'])))
    return found


def closed_issues(body: str, here: str) -> list[tuple[str, int]]:
    """Issues a PR body closes (Closes, Fixes, Resolves... then `#N`, `owner/name#N` or an issue
    URL), as (owner/name, number); a bare `#N` is in `here`."""
    return sorted(set(_refs(_CLOSES, body or '', here.lower())))


def blockers(body: str, here: str) -> list[tuple[str, int]]:
    """Issues named as blockers, as (owner/name, number): on a `Blocked by:` line, or under a
    `## Blocked by` heading up to the next heading. Refs elsewhere in the body don't block."""
    found = []
    lines = (body or '').splitlines()
    for i, line in enumerate(lines):
        if not _BLOCKED_BY.match(line):
            continue
        found += _refs(_REFS, line, here)
        if _HEADING.match(line):
            for later in lines[i + 1:]:
                if _HEADING.match(later):
                    break
                found += _refs(_REFS, later, here)
    return sorted(set(found))


def _unblocked(repo: Repo, github, issue: Issue) -> bool:
    if issue.open_blockers:
        return False
    return all(github.issue_state(where, n) == 'closed'
               for where, n in blockers(issue.body, repo.github))


def _in_flight(repo: Repo, github) -> set[int]:
    """Issues something is already building: a `claude/*-<issue>` branch, or an open PR on one or
    with a closing keyword for the issue in this repo. PRs GitHub links to an issue (by keyword or
    by hand) are counted on the issue itself (`open_linked_pulls`)."""
    here = repo.github.lower()
    taken = set()
    for branch in github.branches(repo, 'claude/'):
        if m := _CLAUDE_BRANCH.match(branch):
            taken.add(int(m.group(1)))
    for pr in github.open_pulls(repo):
        if m := _CLAUDE_BRANCH.match(pr.branch):
            taken.add(int(m.group(1)))
        taken.update(n for where, n in _refs(_CLOSES, pr.body or '', here) if where == here)
    return taken


def pick(repo: Repo, github, held=frozenset()) -> BuildJob | None:
    """The lowest-numbered open `ready-for-agent` issue that's unblocked and not already being
    built. A spec or map with open sub-issues isn't built itself; its children are. `held` are
    issues the runner's own job log holds (a build open, failed or waiting on them)."""
    taken = _in_flight(repo, github) | set(held)
    for issue in sorted(github.ready_issues(repo), key=lambda i: i.number):
        if issue.number in taken or issue.open_linked_pulls or issue.open_sub_issues:
            continue
        if _unblocked(repo, github, issue):
            return BuildJob(repo=repo, issue=issue, base=f'origin/{repo.base}',
                            branch=f'claude/{slug(issue.title)}-{issue.number}')
    return None
