"""Which ticket the runner builds next."""
import re
from dataclasses import dataclass

from .config import Repo
from .github import Issue

_HEADING = re.compile(r'^\s{0,3}#{1,6}\s')
_BLOCKED_BY = re.compile(r'^[\s>*_#-]*blocked by\b', re.IGNORECASE)
_REF = re.compile(r'(?<![\w/#])#(\d+)\b')
_CLOSES = re.compile(r'\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b', re.IGNORECASE)
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


def blockers(body: str) -> list[int]:
    """Issue numbers named as blockers: on a `Blocked by:` line, or under a `## Blocked by` heading
    up to the next heading. Refs elsewhere in the body don't block."""
    found = []
    lines = (body or '').splitlines()
    for i, line in enumerate(lines):
        if not _BLOCKED_BY.match(line):
            continue
        found += _REF.findall(line)
        if _HEADING.match(line):
            for later in lines[i + 1:]:
                if _HEADING.match(later):
                    break
                found += _REF.findall(later)
    return sorted({int(n) for n in found})


def _unblocked(repo: Repo, github, issue: Issue) -> bool:
    if issue.open_blockers:
        return False
    return all(github.issue_state(repo, n) == 'closed' for n in blockers(issue.body))


def _in_flight(repo: Repo, github) -> set[int]:
    """Issues something is already building: a `claude/*-<issue>` branch, or an open PR on one or
    with a closing keyword for the issue."""
    taken = set()
    for branch in github.branches(repo, 'claude/'):
        if m := _CLAUDE_BRANCH.match(branch):
            taken.add(int(m.group(1)))
    for pr in github.open_pulls(repo):
        if m := _CLAUDE_BRANCH.match(pr.branch):
            taken.add(int(m.group(1)))
        taken.update(int(n) for n in _CLOSES.findall(pr.body or ''))
    return taken


def pick(repo: Repo, github) -> BuildJob | None:
    """The lowest-numbered open `ready-for-agent` issue that's unblocked and not already being
    built. A spec or map with open sub-issues isn't built itself; its children are."""
    taken = _in_flight(repo, github)
    for issue in sorted(github.ready_issues(repo), key=lambda i: i.number):
        if issue.number in taken or issue.open_sub_issues:
            continue
        if _unblocked(repo, github, issue):
            return BuildJob(repo=repo, issue=issue, base=f'origin/{repo.base}',
                            branch=f'claude/{slug(issue.title)}-{issue.number}')
    return None
