"""Job briefs, filled from sources that keep themselves current, never from handoff files."""
import os
from importlib import resources
from string import Template

from .github import Comment
from .picker import BuildJob


def _template(kind: str) -> Template:
    return Template(resources.files(__package__).joinpath(f'templates/{kind}.md')
                    .read_text(encoding='utf-8'))


def _agents_pointer(path: str) -> str:
    for name in ('AGENTS.md', 'CLAUDE.md'):
        if os.path.isfile(os.path.join(path, name)):
            return f"Read the repo's `{name}` first, and the docs it points to for what you touch."
    return 'The repo has no `AGENTS.md`; follow its README and existing conventions.'


def _comments(comments: list[Comment]) -> str:
    if not comments:
        return 'No comments.'
    return '\n\n'.join(f'**{c.author}**, {c.created_at}:\n\n{c.body.strip()}' for c in comments)


def build_brief(job: BuildJob, comments: list[Comment]) -> str:
    return _template('build').substitute(
        number=job.issue.number, github=job.repo.github, title=job.issue.title,
        branch=job.branch, base=job.base, agents=_agents_pointer(job.repo.path),
        body=(job.issue.body or '').strip() or '(The issue has no body.)',
        comments=_comments(comments))
