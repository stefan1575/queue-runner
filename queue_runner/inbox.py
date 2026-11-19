"""Everything waiting on Stefan, in one place (ticket 17: `python -m queue_runner --inbox`; ticket
31: the dashboard's Inbox page). `collect` is the one collection: `--inbox` prints it (`text`),
and the running runner keeps the last one its Sol lane read (`Reader`), from which the snapshot
writes its asks (`asks.py`). So the two can't disagree.

Five kinds of `Waiting`, read from the job log and GitHub; nothing is posted, started or recorded:

- **base:** a repo's base branch failing its checks (issue #98): its one `needs-info` issue,
  listed once however many PRs it holds, until the runner closes it once the base passes.

- **ready:** in a repo where Stefan merges (`merge = "stefan"`), each open PR the merge re-check
  passes now (what the merge pass marks `ready-for-stefan`).
- **stop:** each `needs-info` stop filed and not yet answered or released (`stops.py`).
- **build:** each build a decision left to Stefan (a comment on its issue, held until
  `--release`).
- **thread:** a build or fix thread that asked a question a decision couldn't answer, so it's
  Stefan's (answer it in the thread).

`answered` holds the stops he has answered that the runner hasn't finished acting on (`acting`).
Each `Waiting` also carries what the asks are written from: the PR's or issue's title, page and
body, the body of the issue a PR closes, the open issues it holds up, an Approach note's text and
Stefan's own words. A repo GitHub can't be read is named in `failed`, and said in `errors`.
"""
import datetime
import json
import os
import threading
from dataclasses import dataclass, field, replace

from .ledger import RUNNER_MARK, said_since
from .merge import Merger
from .picker import blockers, closed_issues
from .stops import BASE, BASE_HOLD, KINDS, PASSED_AFTER_UPDATE, number_of, utc
from .usage import failing_since

BUILD_QUESTIONS = ('failed', 'no-pr')   # a decision's stop on a build: on its issue
ORDER = ('base', 'ready', 'stop', 'build', 'thread')   # `--inbox`'s sections, in its order


def _issue_url(repo, n: int) -> str:
    return f'https://github.com/{repo.github}/issues/{n}' if repo.github else f'{repo.name}#{n}'


def _pull_url(repo, n: int) -> str:
    return f'https://github.com/{repo.github}/pull/{n}' if repo.github else f'{repo.name}#{n}'


@dataclass(frozen=True)
class Waiting:
    kind: str                    # base, ready, stop, build or thread (ORDER)
    repo: str
    number: int                  # the PR (ready, stop, a fix's thread) or the issue
    on_pr: bool
    job: object                  # state.Job: the clean review, the stop, the build or the thread
    decision: object = None      # build, thread: the decision that left it to Stefan
    title: str = ''
    url: str = ''                # the PR's or the issue's page
    body: str = ''               # its own body
    issue: int | None = None     # a PR: the issue it closes
    issue_body: str = ''         # ... and that issue's body
    head: str | None = None      # a PR: its head now
    base: str | None = None      # a PR: the branch it merges into
    holds_up: tuple = ()         # (n, title) of the open issues blocked by it
    note: str | None = None      # an Approach note's text
    said: str | None = None      # an answered stop: Stefan's words, or how he answered


@dataclass(frozen=True)
class Inbox:
    items: list = field(default_factory=list)
    answered: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    failed: frozenset = frozenset()   # repos GitHub couldn't be read for
    reviews: dict = field(default_factory=dict)   # review job id: its run folder's decision.json
    # The items GitHub failed on part-way (their `key`s): listed as the job log has them, and
    # the Reader keeps the last good read's instead.
    unfilled: frozenset = frozenset()
    # The repos never yet read whole enough to list (GitHub failed them, with no earlier good
    # read to keep): their asks aren't known, so the snapshot lists none to go by (PR #104's
    # review 1, F1). None means `failed`: a lone collection has no earlier read.
    never: frozenset | None = None

    @property
    def unread(self) -> frozenset:
        return self.failed if self.never is None else self.never


def gone(e: Exception) -> bool:
    """Whether GitHub said the thing isn't there (HTTP 404, a deleted issue): the item's own
    state, said, not a read that failed."""
    return '(HTTP 404)' in str(e)


def key(w: Waiting) -> tuple:
    """Which ask an item is, from one read to the next."""
    return (w.kind, w.repo, w.number, getattr(w.job, 'id', None))


# --- the collection -----------------------------------------------------------------------------

def collect(config, github, jobs) -> Inbox:
    """What waits on Stefan now, in `ORDER`, each kind in its repo's order and then by number."""
    items, answered, errors, failed, unfilled = [], [], [], set(), set()
    all_jobs = jobs.jobs()
    for repo in config.repos:
        try:
            got, done = _repo(config, github, jobs, all_jobs, repo, errors, unfilled)
        except Exception as e:   # GitHub down: said, and the rest still listed
            errors.append(f"{repo.name}: couldn't read its PRs ({type(e).__name__}: {e})")
            failed.add(repo.name)
            got, done = _offline(jobs, all_jobs, repo), []
        items += got
        answered += done
    rank = {k: i for i, k in enumerate(ORDER)}
    names = {r.name: i for i, r in enumerate(config.repos)}
    items.sort(key=lambda w: (rank[w.kind], names[w.repo], w.number))
    return Inbox(items, answered, errors, frozenset(failed),
                 reviews(all_jobs, {(w.repo, w.number) for w in items + answered if w.on_pr}),
                 frozenset(unfilled))


def reviews(all_jobs, prs) -> dict:
    """Each review of these PRs whose run folder holds a readable `decision.json`: its findings
    and signals, as `ledger.decide` wrote them."""
    found = {}
    for j in all_jobs:
        if j.kind != 'review' or (j.repo, j.issue) not in prs or not j.run_dir:
            continue
        try:
            with open(os.path.join(j.run_dir, 'decision.json'), encoding='utf-8') as f:
                d = json.load(f)
            found[j.id] = {'findings': list(d.get('findings') or []),
                           'signals': list(d.get('signals') or [])}
        except (OSError, ValueError, AttributeError):
            continue
    return found


def _offline(jobs, all_jobs, repo) -> list[Waiting]:
    """What the job log alone says waits, with nothing read from GitHub."""
    return (_bases(all_jobs, repo) + _stops(jobs, repo) + _builds(jobs, all_jobs, repo)
            + _threads(jobs, repo))


def _repo(config, github, jobs, all_jobs, repo, errors, unfilled=None) -> tuple[list, list]:
    if not repo.github:
        return _offline(jobs, all_jobs, repo), []
    pulls = {p.number: p for p in github.open_pulls(repo)}
    issues = {i.number: i for i in github.open_issues(repo)}
    reader = _Reader(github, repo, pulls, issues, errors, unfilled)
    ready = []
    if repo.stefan_merges:
        merger = Merger(config, github=github, git=None, jobs=jobs, say=lambda line: None)
        for n in sorted(pulls):
            pr = pulls[n]
            if merger.clean_on_head(repo, pr) and merger.why_not(repo, n, pr.head_sha) is None:
                ready.append(Waiting('ready', repo.name, n, True,
                                     jobs.runner_review(repo.name, n, pr.head_sha)))
    items = [reader.fill(w) for w in _bases(all_jobs, repo) + ready + _stops(jobs, repo)
             + _builds(jobs, all_jobs, repo) + _threads(jobs, repo)]
    done = [reader.fill(w, answered=True) for w in _answered(jobs, all_jobs, repo, pulls)]
    return items, done


def _bases(all_jobs, repo) -> list[Waiting]:
    """The repo's base stop, once, while it's open (issue #98): on its own issue, holding up the
    PRs held for it (titles filled from GitHub) and every build in the repo."""
    stops = [j for j in all_jobs if j.kind == BASE and j.repo == repo.name
             and j.outcome == 'filed' and j.link]
    if not stops:
        return []
    s = stops[-1]
    held = sorted({j.issue for j in all_jobs if j.kind == BASE_HOLD and j.repo == repo.name
                   and j.outcome == 'held'})
    return [Waiting('base', repo.name, number_of(s.link), False, s, base=s.branch,
                    holds_up=tuple((n, '') for n in held))]


def _stops(jobs, repo) -> list[Waiting]:
    n_s = sorted({j.issue for j in jobs.jobs() if j.kind == 'stop' and j.repo == repo.name})
    return [Waiting('stop', repo.name, n, True, s)
            for n in n_s for s in jobs.open_stops(repo.name, n)]


def _builds(jobs, all_jobs, repo) -> list[Waiting]:
    by_id = {j.id: j for j in all_jobs}
    found = []
    for n in sorted(jobs.held_issues(repo.name)):
        decisions = [d for d in jobs.on('decision', repo.name, n)
                     if d.question in BUILD_QUESTIONS and d.about in by_id
                     and by_id[d.about].kind == 'build']
        if decisions and decisions[-1].outcome == 'stop':
            d = decisions[-1]
            found.append(Waiting('build', repo.name, n, False, by_id[d.about], decision=d))
    return found


def _threads(jobs, repo) -> list[Waiting]:
    found = []
    for j in jobs.waiting_jobs():
        d = jobs.decided(j.id)
        if j.repo == repo.name and d and not d.open and d.outcome == 'stop':
            found.append(Waiting('thread', repo.name, j.issue, j.kind == 'fix', j, decision=d))
    return found


# What the runner does after Stefan's answer, until it's done: the jobs on the PR after it.
ACTING = ('decision', 'fix', 'review', 'merge', 'ready', 'live', 'build')


def _when(stamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def acting(all_jobs, stop) -> list:
    """The runner's jobs on the PR since Stefan answered this stop, oldest first: started after
    the stop in the log, and not before his answer was read."""
    at, seen = _when(stop.ended_at), False
    found = []
    for j in all_jobs:
        if j.id == stop.id:
            seen = True
        elif (seen and (j.repo, j.issue) == (stop.repo, stop.issue) and j.kind in ACTING
              and _when(j.started_at) >= at and j.outcome not in ('not-started', 'not-sent')):
            found.append(j)
    return found


def finished(all_jobs, stop) -> bool:
    """The runner has acted on Stefan's answer: after a reply, the decision on it ended (and the
    fix round it ordered, if it did); after a closed issue, the next job on the PR ended."""
    if stop.answer == PASSED_AFTER_UPDATE:   # settled by the runner, not answered (#199)
        return True
    after = acting(all_jobs, stop)
    if stop.answer in ('replied', 'thread'):   # a reply, or decided in its T3 thread (35)
        k = next((i for i, j in enumerate(after) if j.kind == 'decision'), None)
        if k is None or after[k].open:
            return False
        if after[k].outcome != 'fix':
            return True
        fix = next((j for j in after[k + 1:] if j.kind == 'fix'), None)
        return fix is not None and not fix.open
    return any(not j.open for j in after)


def _answered(jobs, all_jobs, repo, pulls) -> list[Waiting]:
    """Stops Stefan answered that the runner hasn't finished acting on, on PRs still open. Only
    the newest per PR: one answer reads them all."""
    found = []
    for n in sorted(pulls):
        stops = [s for s in jobs.on('stop', repo.name, n) if s.outcome == 'answered']
        if stops and not finished(all_jobs, stops[-1]):
            s = stops[-1]
            found.append(Waiting('stop', repo.name, n, True, s, said=_in_thread(all_jobs, s)))
    return found


def _in_thread(all_jobs, stop) -> str | None:
    """What Stefan decided in the stop's T3 thread (ticket 35), as its decision says it."""
    if stop.answer != 'thread':
        return None
    d = next((j for j in reversed(all_jobs) if j.kind == 'decision' and j.about == stop.id), None)
    text = (d.reason or d.outcome) if d is not None and not d.open else 'a decision'
    line = next((l.strip() for l in text.splitlines() if l.strip()), text)
    line = f'In T3: {line.rstrip(".")}'   # the page quotes it inside a sentence
    return line if len(line) <= 120 else line[:119].rstrip() + '…'


class _Reader:
    """Fills a `Waiting` from GitHub: the PR or issue, the issue a PR closes, what it holds up,
    an Approach note and Stefan's words. Each PR's comments are read once."""

    def __init__(self, github, repo, pulls, issues, errors, unfilled=None):
        self.github, self.repo, self.pulls, self.issues = github, repo, pulls, issues
        self.errors = errors
        self.unfilled = unfilled if unfilled is not None else set()   # `key`s it failed on
        self._comments = {}

    def _issue(self, n: int):
        return self.issues.get(n) or self.github.issue(self.repo.github, n)

    def comments(self, n: int) -> list:
        if n not in self._comments:
            self._comments[n] = self.github.issue_comments(self.repo, n)
        return self._comments[n]

    def fill(self, w: Waiting, answered: bool = False) -> Waiting:
        """The item with what GitHub says about it; one GitHub can't say (a deleted issue, or
        a read failing part-way) stays listed as the job log has it, the error is said, and it's
        named in `unfilled` (the Reader keeps the last good read's)."""
        try:
            return self._fill(w, answered)
        except Exception as e:
            self.errors.append(f"{w.repo}#{w.number}: couldn't read it ({type(e).__name__}: {e})")
            if not gone(e):   # GitHub failing, not the item: the last good read's is kept
                self.unfilled.add(key(w))
            return w

    def _fill(self, w: Waiting, answered: bool) -> Waiting:
        repo = self.repo
        if w.kind == 'base':   # holds up the PRs held for it, not issues (#98)
            i = self._issue(w.number)
            return replace(w, title=i.title, url=i.url or _issue_url(repo, w.number), body=i.body,
                           holds_up=tuple((n, self.pulls[n].title if n in self.pulls else '')
                                          for n, _ in w.holds_up))
        if w.on_pr:
            pr = self.pulls.get(w.number) or self.github.pull(repo, w.number)
            issue = next((k for where, k in closed_issues(pr.body, repo.github)
                          if where == repo.github.lower()), None)
            issue_body = self._issue(issue).body if issue else ''
            w = replace(w, title=pr.title, url=pr.url or _pull_url(repo, w.number), body=pr.body,
                        issue=issue, issue_body=issue_body, head=pr.head_sha, base=pr.base)
            blocked_on = issue
        else:
            i = self._issue(w.number)
            w = replace(w, title=i.title, url=i.url or _issue_url(repo, w.number), body=i.body)
            blocked_on = w.number
        if blocked_on:   # by GitHub's dependencies, and by `Blocked by:` lines (`picker.py`)
            here = repo.github.lower()
            held = {i.number: i.title for i in self.github.blocking(repo, blocked_on)}
            held.update((n, i.title) for n, i in self.issues.items()
                        if n != blocked_on and (here, blocked_on) in blockers(i.body, repo.github))
            w = replace(w, holds_up=tuple(sorted(held.items())))
        if w.kind == 'stop' and w.job.stop == 'approach-note':
            w = replace(w, note=self._note(w))
        if answered:
            w = replace(w, said=w.said or self._said(w))
        return w

    def _note(self, w: Waiting) -> str | None:
        """The Approach note's own text: the comment the runner posted under that heading on
        the stop's head."""
        mark = f'{RUNNER_MARK}approach-note sha={w.job.sha}'
        for c in reversed(self.comments(w.number)):
            if mark in c.body:
                text = c.body.split('## Approach note', 1)[-1]
                return text.split('**Recommendation:**', 1)[0].strip() or None
        return None

    def _said(self, w: Waiting) -> str:
        s = w.job
        if s.answer == 'issue-closed':
            return f'closed #{number_of(s.link)}' if s.link else 'closed the issue'
        said = said_since(self.comments(w.number), utc(s.started_at))
        if s.link:
            said += said_since(self.github.issue_comments(self.repo, number_of(s.link)),
                               utc(s.started_at))
        said.sort(key=lambda c: c.created_at)
        if not said:
            return 'a reply'
        line = next((l.strip() for l in said[-1].body.splitlines() if l.strip()), 'a reply')
        return line if len(line) <= 120 else line[:119].rstrip() + '…'


# --- the CLI's text -----------------------------------------------------------------------------

def line(w: Waiting) -> str:
    """One `--inbox` line."""
    j, d = w.job, w.decision
    if w.kind == 'base':
        return (f'{w.repo}: {j.branch} fails its checks ({j.reason}): no build starts, and '
                f'{len(w.holds_up)} PR(s) wait ({j.link})')
    if w.kind == 'ready':
        head = w.head or (j.sha if j else '')
        return (f'{w.repo}#{w.number} at {head[:7]}' + (f': {w.title}' if w.title else '')
                + f' ({w.url})')
    if w.kind == 'stop':
        return (f'{w.repo}#{w.number}: {KINDS.get(j.stop, j.stop)}: {j.reason or "see the issue"}'
                + (f' ({j.link})' if j.link else ''))
    if w.kind == 'build':
        url = w.url or f'{w.repo}#{w.number}'
        return (f'{w.repo}#{w.number}: {KINDS["decision"]}: {d.reason or "see the issue"} '
                f'({url}; --release {w.repo}#{w.number} once handled)')
    return (f'{w.repo}#{w.number}: the {j.kind} thread asks: '
            f'{d.reason or "see the thread"} ({j.link or j.thread_id})')


TITLES = {'base': 'A base branch fails its checks', 'ready': 'Ready for you to merge', 'stop': 'Stops (needs-info)',
          'build': 'Stops (needs-info)', 'thread': 'Threads waiting for your answer'}


def text(inbox: Inbox) -> str:
    sections: dict[str, list[str]] = {}
    for w in inbox.items:
        sections.setdefault(TITLES[w.kind], []).append(line(w))
    out = [f'{title}:\n' + '\n'.join(f'  {l}' for l in lines) for title, lines in sections.items()]
    body = '\n\n'.join(out) or ('Nothing waits on you.' if not inbox.errors else
                                'Nothing waits on you in what could be read.')
    return body + ''.join(f'\n{e}' for e in inbox.errors)


def report(config, github, jobs) -> str:
    return text(collect(config, github, jobs))


# --- the running runner's copy ------------------------------------------------------------------

class Reader:
    """The Sol lane's last collection, for the snapshot. A repo GitHub couldn't be read keeps
    what the last good read of it found, an ask GitHub failed on part-way keeps the last good
    read of that ask, and `stale` says since when (the repo's last whole read) and since when
    its reads have failed."""

    def __init__(self, config, github, jobs, clock):
        self.config, self.github, self.jobs, self.clock = config, github, jobs, clock
        self._lock = threading.Lock()
        self._last: Inbox | None = None
        self._good: dict[str, tuple] = {}     # repo: (when, its items, its answered)
        self._reviews: dict = {}
        self._stale: dict[str, tuple] = {}    # repo: (last whole read or None, the error, since)
        self._whole: dict[str, datetime.datetime] = {}   # repo: its last read with no error

    def read(self, github=None) -> Inbox:
        """With `github`, the pass's shared reads (`work.Memo`), else its own GitHub."""
        got = collect(self.config, github if github is not None else self.github, self.jobs)
        now = self.clock()
        with self._lock:
            items, answered = [], []
            for repo in self.config.repos:
                mine = [w for w in got.items if w.repo == repo.name]
                done = [w for w in got.answered if w.repo == repo.name]
                mine_errors = [e for e in got.errors if e.startswith((f'{repo.name}:',
                                                                      f'{repo.name}#'))]
                if repo.name in got.failed:
                    _, mine, done = self._good.get(repo.name, (None, mine, done))
                    error = next((e for e in mine_errors if e.startswith(f'{repo.name}:')), '')
                    self._stale[repo.name] = (self._whole.get(repo.name), error,
                                              failing_since(self._stale, repo.name, now))
                else:
                    _, was, was_done = self._good.get(repo.name, (None, [], []))
                    last = {key(w): w for w in was + was_done}
                    mine = [last.get(key(w), w) if key(w) in got.unfilled else w for w in mine]
                    done = [last.get(key(w), w) if key(w) in got.unfilled else w for w in done]
                    self._good[repo.name] = (now, mine, done)
                    partial = [e for e in mine_errors if not gone(e)]
                    if partial:   # part-way: what failed is the last good read's, said
                        self._stale[repo.name] = (self._whole.get(repo.name), partial[0],
                                                  failing_since(self._stale, repo.name, now))
                    else:
                        self._whole[repo.name] = now
                        self._stale.pop(repo.name, None)
                items += mine
                answered += done
            # A kept ask's reviews are the last good read's: their run folders don't change.
            self._reviews = {**self._reviews, **got.reviews}
            never = frozenset(r.name for r in self.config.repos
                              if r.name in got.failed and r.name not in self._good)
            self._last = Inbox(items, answered, got.errors, got.failed, dict(self._reviews),
                               never=never)
            return self._last

    def last(self) -> Inbox | None:
        with self._lock:
            return self._last

    def stale(self) -> dict[str, tuple]:
        """Repos whose asks are an older read's: (when that read was, or None, why, and when
        the first read that failed was)."""
        with self._lock:
            return dict(self._stale)
