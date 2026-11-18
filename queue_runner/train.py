"""A repo that runs as a train (#179; `docs/flow.md`, The train): `train = true` in its
`config.toml` entry.

The train is the repo's open PRs, lowest number first, whoever opened them. Only the front one
moves: each lane asks `behind` where it decides what to take up (the Sol lane's reviews, stops and
merges, the Claude lane's fix and conflict rounds and decisions), and leaves the others as they
are. No build starts ahead of it (`build_hold`): only once the repo has no open PR, no build of its
own still on its way to one, and its last merge's live steps are done, so each build branches from
a base that holds everything before it. A stop on the front PR (`stops.held`) pauses the whole
repo (`paused`): nothing behind it moves, and no build starts, until Stefan answers or releases it.
A front PR stacked on a branch that merged or is gone (`stale_base`) is pointed at the repo's base
by the Sol lane's stop pass (`Stopper.train_front`) before anything else is done with it.

These are reads: nothing here posts or records. A repo without `train` gets None from each.
"""
from .stops import held


def front(prs):
    """The train's front PR: the lowest-numbered open one, or None."""
    return min(prs, key=lambda p: p.number, default=None)


def behind(repo, pr, prs) -> str | None:
    """Why `pr` waits in a train repo: another open PR is ahead of it. None if it's the front, or
    the repo isn't a train."""
    if not repo.train:
        return None
    first = front(prs)
    if first is None or first.number == pr.number:
        return None
    return f'the train moves one PR at a time: it waits behind #{first.number}'


def stale_base(github, repo, pr) -> str | None:
    """Why a train's PR must be retargeted to the repo's base first: the branch it's stacked on
    merged, or no longer exists. None for a PR into the repo's base, or in a repo that isn't a
    train."""
    if not repo.train or not pr.base or pr.base == repo.base:
        return None
    if pr.base not in github.branches(repo, pr.base):
        return f'its base {pr.base} no longer exists'
    got = github.pull_for_branch(repo, pr.base)
    if got and got.get('state') == 'merged':
        return f'its base {pr.base} merged in #{got["number"]}'
    return None


def retarget_first(why: str, repo) -> str:
    return f'{why}: it is retargeted to {repo.base} first'


def paused(jobs, repo, prs) -> tuple[int, str] | None:
    """(the front PR, why) while a stop or hold on it pauses the train (`stops.held`), else None."""
    if not repo.train:
        return None
    first = front(prs)
    if first is None:
        return None
    why = held(jobs, repo, first.number)
    return (first.number, why) if why else None


def paused_text(n: int, why: str) -> str:
    return (f'the train is paused on #{n} ({why}): nothing behind it moves, and no build '
            'starts')


def build_hold(repo, prs, jobs, live=None) -> str | None:
    """Why no build starts in a train repo now, or None: the train is paused, a PR is open, a
    build of its own is still on its way to a PR (open, waiting for an answer or cut off by a
    usage limit), or the last merge's live steps aren't done (`live.LiveSteps.pending`)."""
    if not repo.train:
        return None
    if stop := paused(jobs, repo, prs):
        return paused_text(*stop)
    if prs:
        more = len(prs) - 1
        return (f'the train has #{front(prs).number} open' + (f' and {more} more' if more else '')
                + ': no build starts until every open PR has merged or closed')
    if job := jobs.building(repo.name):
        return (f'build #{job.issue} is still on its way to a PR ({job.outcome or "running"}): '
                'no build starts beside it')
    if live is not None and (why := live.pending(repo)):
        return f'{why}: no build starts until they are'
    return None
