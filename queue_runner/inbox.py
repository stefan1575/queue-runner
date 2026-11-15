"""Everything waiting on Stefan, in one place (ticket 17: `python -m queue_runner --inbox`; the
dashboard's Inbox page shows the same things).

Three kinds, read from the job log and GitHub; nothing is posted, started or recorded:

- **Ready to merge:** in a repo where Stefan merges (`merge = "stefan"`), each open PR the merge
  re-check passes now (what the merge pass marks `ready-for-stefan`).
- **Stops:** each `needs-info` stop filed and not yet answered or released (`stops.py`), and each
  build a decision left to Stefan (a comment on its issue, held until `--release`).
- **Threads waiting for an answer:** a build or fix thread that asked a question a decision
  couldn't answer, so it's Stefan's (answer it in the thread).
"""
from .merge import Merger
from .stops import KINDS

BUILD_QUESTIONS = ('failed', 'no-pr')   # a decision's stop on a build: on its issue


def _issue_url(repo, n: int) -> str:
    return f'https://github.com/{repo.github}/issues/{n}' if repo.github else f'{repo.name}#{n}'


def ready_prs(config, github, jobs) -> tuple[list[str], list[str]]:
    """(lines, errors): the PRs ready for Stefan to merge."""
    merger = Merger(config, github=github, git=None, jobs=jobs, say=lambda line: None)
    lines, errors = [], []
    for repo in config.repos:
        if not (repo.github and repo.stefan_merges):
            continue
        try:
            for pr in sorted(github.open_pulls(repo), key=lambda p: p.number):
                if merger.clean_on_head(repo, pr) and                         merger.why_not(repo, pr.number, pr.head_sha) is None:
                    lines.append(f'{repo.name}#{pr.number} at {pr.head_sha[:7]}'
                                 + (f': {pr.title}' if pr.title else '')
                                 + f' ({pr.url or _issue_url(repo, pr.number)})')
        except Exception as e:   # GitHub down: said, and the rest still listed
            errors.append(f"{repo.name}: couldn't read its PRs ({type(e).__name__}: {e})")
    return lines, errors


def stops(config, jobs) -> list[str]:
    """Stops filed and not answered, and builds a decision left to Stefan."""
    repos = {r.name: r for r in config.repos}
    all_jobs = jobs.jobs()
    lines = []
    for name, n in sorted({(j.repo, j.issue) for j in all_jobs if j.kind == 'stop'}):
        for s in jobs.open_stops(name, n):
            lines.append(f'{name}#{n}: {KINDS.get(s.stop, s.stop)}: {s.reason or "see the issue"}'
                         + (f' ({s.link})' if s.link else ''))
    by_id = {j.id: j for j in all_jobs}
    for name in sorted(repos):
        held = jobs.held_issues(name)
        for n in sorted(held):
            decisions = [d for d in jobs.on('decision', name, n)
                         if d.question in BUILD_QUESTIONS and d.about in by_id
                         and by_id[d.about].kind == 'build']
            if decisions and decisions[-1].outcome == 'stop':
                d = decisions[-1]
                lines.append(f'{name}#{n}: {KINDS["decision"]}: {d.reason or "see the issue"} '
                             f'({_issue_url(repos[name], n)}; --release {name}#{n} once handled)')
    return lines


def waiting_threads(jobs) -> list[str]:
    """Threads waiting for an answer that a decision left to Stefan."""
    lines = []
    for j in jobs.waiting_jobs():
        d = jobs.decided(j.id)
        if d and not d.open and d.outcome == 'stop':
            lines.append(f'{j.repo}#{j.issue}: the {j.kind} thread asks: '
                         f'{d.reason or "see the thread"} ({j.link or j.thread_id})')
    return lines


def report(config, github, jobs) -> str:
    ready, errors = ready_prs(config, github, jobs)
    sections = [('Ready for you to merge', ready), ('Stops (needs-info)', stops(config, jobs)),
                ('Threads waiting for your answer', waiting_threads(jobs))]
    out = [f'{title}:\n' + '\n'.join(f'  {line}' for line in lines)
           for title, lines in sections if lines]
    body = '\n\n'.join(out) or ('Nothing waits on you.' if not errors else
                                'Nothing waits on you in what could be read.')
    return body + ''.join(f'\n{e}' for e in errors)
