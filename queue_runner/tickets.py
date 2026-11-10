"""Tickets kept as local markdown (ticket 12): `.scratch/<feature>/issues/NN-<slug>.md`, as a
repo's `docs/agents/issue-tracker.md` describes them.

A ticket's state is its `Status:` line near the top, in either form in use (`Status: x` or
`**Status:** x`), with or without a trailing date or note (`done (2026-11-10)`, `done.`). Its
blockers are the numbers on its `Blocked by:` line, which name tickets in the same feature
folder. Numbers repeat across features, so a ticket is known by `<feature>/NN`.
"""
import os
import re
from dataclasses import dataclass, field

READY = 'ready-for-agent'
DONE = frozenset({'done', 'resolved'})   # `resolved`: a wayfinding child's done

_FILE = re.compile(r'^(\d+)-(.+)\.md$')
_STATUS = re.compile(r'^[\s>*_-]*status\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$', re.IGNORECASE)
_BLOCKED_BY = re.compile(r'^[\s>*_-]*blocked by\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*(.*)$',
                         re.IGNORECASE)
_TITLE = re.compile(r'^#\s+(.+?)\s*$')
_PARENS = re.compile(r'\([^)]*\)')
# A ticket number on a Blocked by line: `05`, `05-merge-or-fix.md`, `#05`, `01.` ending a
# sentence; not part of a date or a decimal.
_NUMBER = re.compile(r'(?<![\w/.-])(\d{1,3})(?!\d|\.\d)(?=\b|-)')
_COMMENTS = re.compile(r'^##\s+comments\s*$', re.IGNORECASE)


@dataclass(frozen=True)
class Ticket:
    feature: str          # the folder under `.scratch/`
    number: int
    slug: str             # from the file name
    path: str             # repo-relative, with forward slashes
    title: str
    status: str | None    # the status word, lower case; None: no Status line
    blocked_by: tuple[int, ...] = ()
    body: str = field(default='', repr=False)

    @property
    def key(self) -> str:
        return f'{self.feature}/{self.number:02d}'


def status_of(text: str) -> str | None:
    """The status word of the first `Status:` line above `## Comments`: `done (2026-11-10)`,
    `done.` and `**Status:** done` all read as `done`."""
    for line in text.splitlines():
        if _COMMENTS.match(line):
            break
        if m := _STATUS.match(line):
            word = re.split(r'[\s(;,]', m.group(1).strip(), maxsplit=1)[0]
            return word.strip('.*_`:').lower() or None
    return None


def blocked_by(text: str) -> tuple[int, ...]:
    """The ticket numbers on the first `Blocked by:` line above `## Comments`. `None`, or words
    and dates in brackets, name nothing."""
    for line in text.splitlines():
        if _COMMENTS.match(line):
            break
        if m := _BLOCKED_BY.match(line):
            rest = _PARENS.sub(' ', m.group(1))
            return tuple(sorted({int(n) for n in _NUMBER.findall(rest)}))
    return ()


def _title(text: str, fallback: str) -> str:
    for line in text.splitlines():
        if m := _TITLE.match(line):
            return m.group(1)
    return fallback


def read_tickets(repo_path: str) -> list[Ticket]:
    """Every ticket under `<repo>/.scratch/*/issues/`, by feature, then number."""
    scratch = os.path.join(repo_path, '.scratch')
    found = []
    if not os.path.isdir(scratch):
        return found
    for feature in sorted(os.listdir(scratch)):
        folder = os.path.join(scratch, feature, 'issues')
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            m = _FILE.match(name)
            if not m or not os.path.isfile(os.path.join(folder, name)):
                continue
            with open(os.path.join(folder, name), encoding='utf-8') as f:
                text = f.read()
            found.append(Ticket(feature=feature, number=int(m.group(1)), slug=m.group(2),
                                path=f'.scratch/{feature}/issues/{name}',
                                title=_title(text, m.group(2)), status=status_of(text),
                                blocked_by=blocked_by(text), body=text))
    return found


def why_not(ticket: Ticket, tickets: list[Ticket]) -> str | None:
    """Why the ticket can't be built now, or None. A blocker that has no file blocks: nothing
    says it's done."""
    if ticket.status != READY:
        return f'its status is {ticket.status or "missing"}'
    same = {t.number: t for t in tickets if t.feature == ticket.feature}
    for n in ticket.blocked_by:
        blocker = same.get(n)
        if blocker is None:
            return f'blocked by {ticket.feature}/{n:02d}, which has no file'
        if blocker.status not in DONE:
            return f'blocked by {blocker.key} ({blocker.status or "no status"})'
    return None


def pick_ticket(repo_path: str, held=frozenset()) -> Ticket | None:
    """The lowest-numbered `ready-for-agent` ticket whose blockers are all done, and that `held`
    (keys, `<feature>/NN`) doesn't name; a tie in number goes to the feature first by name."""
    tickets = read_tickets(repo_path)
    for ticket in sorted(tickets, key=lambda t: (t.number, t.feature)):
        if ticket.key not in held and why_not(ticket, tickets) is None:
            return ticket
    return None
