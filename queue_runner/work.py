"""The work, for the dashboard (ticket 32; `.scratch/queue-runner/dashboard-live.md`): what each
lane takes up next, the issues and features, the open PRs and what happened.

- **The read** (`read_repo`, kept by `Reader`): GitHub and git are read the way the lanes read
  them, through their own code (`Decider.cases`, `LiveSteps.batch`, `Fixer.candidates`, the
  picker, `Reviewer.candidates`, the merge re-check), so the queues agree with what the lanes
  really take up. Nothing is posted, started, fetched or recorded. One read of a repo answers
  each GitHub call once (`Memo`), and the Sol lane reads once after each pass; a repo GitHub
  can't be read keeps its last good read, and `stale` says since when.
- **The lists** (`lists`) are pure: the last read and the job log now, in the build order, a
  stopped repo's work left out of the queues (ticket 37). The shapes are `dashboard/sample.py`'s.
"""
import datetime
import re
import threading
from dataclasses import dataclass, field

QUEUE_EMPTY = {
    'claude': "Nothing to start: no PR needs a fix round, and no repo has an unblocked "
              "ready-for-agent issue that isn't already being built or held.",
    'sol': 'Nothing is waiting for review.',
}
NOT_READ = "The runner hasn't read GitHub for its work yet."


def _noop(*args, **kwargs):
    return None


class _NoStops:
    """The read's stopper: files nothing."""

    def file(self, *args, **kwargs):
        return None


class NoFetch:
    """Git for the read: everything but `fetch`, which the read leaves to the lanes (it would
    write the clone's remote refs while a lane may be using them)."""

    def __init__(self, git):
        self._git = git

    def fetch(self, *args, **kwargs):
        return None

    def __getattr__(self, name):
        return getattr(self._git, name)


# The GitHub calls a read makes; each is answered once per read.
READS = ('open_pulls', 'open_issues', 'work_issues', 'ready_issues', 'issue_state', 'pull',
         'issue_comments', 'review_replies', 'checks', 'has_conflict', 'open_threads', 'branches',
         'issue', 'blocking', 'pull_for_branch', 'pull_body')


class Memo:
    """One read's GitHub: each read call is made once and its answer (or its error) reused.
    Anything else passes straight through."""

    def __init__(self, github):
        self._github = github
        self._seen: dict = {}

    def __getattr__(self, name):
        attr = getattr(self._github, name)
        if name not in READS or not callable(attr):
            return attr

        def call(*args):
            key = (name, tuple(getattr(a, 'name', a) for a in args))
            if key not in self._seen:
                try:
                    self._seen[key] = (True, attr(*args))
                except Exception as e:
                    self._seen[key] = (False, e)
            ok, got = self._seen[key]
            if not ok:
                raise got
            return got
        return call


@dataclass(frozen=True)
class PrRead:
    pr: object                          # github.PullRequest
    issue: int | None                   # the issue it closes (or its build's)
    review_why: str | None              # why Sol doesn't review it now (None: it would)
    fix: tuple | None = None            # (cause, why not now) if it's a fix or conflict candidate
    merge: tuple | None = None          # the re-check's steps, (label, why not), if clean on H
    reviews: tuple = ()                 # its reviews as its comments hold them (ledger)


@dataclass(frozen=True)
class RepoRead:
    """What one read of a repo found."""
    at: datetime.datetime | None
    issues: tuple = ()                  # github.WorkIssue, open
    prs: tuple = ()                     # PrRead, lowest number first
    decisions: tuple = ()               # (question, number, on a PR)
    live: tuple | None = None           # the live batch that would run: (newest PR, its PRs)
    pending: tuple = ()                 # PRs merged and not live yet
    pending_issues: tuple = ()          # ... and the issues their branches name
    builds: tuple = ()                  # (issue, title) in the picker's order
    in_flight: frozenset = frozenset()  # issues a branch or PR is on (`picker.in_flight`)
    errors: tuple = ()


_FROM_BRANCH = re.compile(r'\bfrom \S+?/claude/\S+-(\d+)\b')


def read_repo(config, github, git, jobs, repo, now=None) -> RepoRead:
    """One repo's read. Raises when its issues or PRs can't be read (the Reader keeps the last
    good one); a part that fails on its own is left empty and named in `errors`."""
    from .decisions import Decider
    from .fix import Fixer
    from .ledger import read_reviews
    from .live import LiveSteps, pr_numbers
    from .merge import Merger
    from .picker import closed_issues, in_flight, pickable
    from .review import DryRunPoster, Reviewer
    issues = tuple(github.work_issues(repo))
    pulls = sorted(github.open_pulls(repo), key=lambda p: p.number)
    errors = []

    def part(label, fn, empty=()):
        try:
            return fn()
        except Exception as e:
            errors.append(f'{repo.name}: {label} ({type(e).__name__}: {e})')
            return empty
    merger = Merger(config, github=github, git=None, jobs=jobs, say=_noop)
    reviewer = Reviewer(config, github=github, git=None, sol=None, jobs=jobs, say=_noop,
                        poster=DryRunPoster(_noop))
    fixer = Fixer(config, github=github, git=git, jobs=jobs)
    fixes = part('fix rounds', lambda: {pr.number: ('fix' if review else 'conflict', why)
                                        for pr, review, why in fixer.candidates(repo)}, {})
    whys = part('reviews', lambda: {pr.number: why for pr, why in reviewer.candidates(repo)}, {})
    builds = {j.branch: j.issue for j in jobs.jobs() if j.kind == 'build' and j.repo == repo.name}
    here = repo.github.lower()
    prs = []
    for pr in pulls:
        closes = next((k for where, k in closed_issues(pr.body, repo.github) if where == here),
                      None)
        merge = None
        if merger.clean_on_head(repo, pr):
            merge = part(f'the merge re-check of #{pr.number}',
                         lambda: tuple(merger.steps(repo, pr.number, pr.head_sha)), None)
        prs.append(PrRead(pr=pr, issue=closes or builds.get(pr.branch),
                          review_why=whys.get(pr.number, 'it could not be read'),
                          fix=fixes.get(pr.number), merge=merge,
                          reviews=tuple(part(f'the reviews of #{pr.number}', lambda: read_reviews(
                              github.issue_comments(repo, pr.number))))))
    decider = Decider(config, github=github, t3=None, jobs=jobs, say=_noop, stopper=None)
    decisions = part('decisions', lambda: tuple(
        (c.question, c.number, c.pr is not None or c.about.kind in ('fix', 'review'))
        for c in decider.cases(repo)))
    live, pending, pending_issues = None, (), ()
    if repo.live_doc and git is not None:
        steps = LiveSteps(config, github=github, git=NoFetch(git), t3=None, jobs=jobs, say=_noop,
                          stopper=_NoStops(), merger=merger, now=now)
        b = part('live steps', lambda: steps.batch(repo, record=False), None)
        if b is not None:
            live = (b.prs[-1], tuple(b.prs))
        last, _ = steps.reach(repo)
        if last is not None and last.head:
            commits = part('what is merged and not live', lambda: git.first_parent(
                repo.path, last.head, f'origin/{repo.base}'))
            pending = tuple(pr_numbers(commits))
            pending_issues = tuple(int(m[1]) for c in commits
                                   if (m := _FROM_BRANCH.search(c['subject'])))
    picked = part('builds', lambda: tuple(
        (b.issue.number, b.issue.title)
        for b in pickable(repo, github, held=jobs.held_issues(repo.name))))
    flying = part('what is in flight', lambda: frozenset(in_flight(repo, github)), frozenset())
    return RepoRead(at=None, issues=issues, prs=tuple(prs), decisions=decisions, live=live,
                    pending=pending, pending_issues=pending_issues, builds=picked,
                    in_flight=flying, errors=tuple(errors))


class Reader:
    """The last read of each served repo, for the snapshot. A repo GitHub couldn't be read keeps
    what its last good read found, and `stale` says since when and why."""

    def __init__(self, config, github, git, jobs, clock):
        self.config, self.github, self.git, self.jobs, self.clock = config, github, git, jobs, clock
        self._lock = threading.Lock()
        self._good: dict[str, RepoRead] = {}
        self._stale: dict[str, tuple] = {}

    def read(self, github=None) -> dict:
        """Reads every served repo once (with `github`, a `Memo` the pass shares, else its own)."""
        from .config import toml_order
        gh = github if github is not None else Memo(self.github)
        for repo in toml_order(self.config):
            if not repo.github or repo.local_issues:
                continue
            try:
                got = read_repo(self.config, gh, self.git, self.jobs, repo, now=self.clock)
            except Exception as e:
                with self._lock:
                    last = self._good.get(repo.name)
                    self._stale[repo.name] = (last.at if last else None,
                                              f"{repo.name}: couldn't read its work "
                                              f'({type(e).__name__}: {e})')
                continue
            with self._lock:
                self._good[repo.name] = _at(got, self.clock())
                self._stale.pop(repo.name, None)
        return self.last()

    def last(self) -> dict | None:
        with self._lock:
            return dict(self._good) if self._good or self._stale else None

    def stale(self) -> dict[str, tuple]:
        with self._lock:
            return dict(self._stale)


def _at(r: RepoRead, at) -> RepoRead:
    from dataclasses import replace
    return replace(r, at=at)


# --- the lists ----------------------------------------------------------------------------------

@dataclass(frozen=True)
class View:
    """What the lists are written from: the reads, the job log now, the build order and the
    stopped repos, and what each lane is on."""
    reads: dict
    jobs: list
    repos: list
    off: frozenset = frozenset()
    limited: list = field(default_factory=list)
    lane_jobs: dict = field(default_factory=dict)   # lane id: its open state.Job, or None


def _title(read: RepoRead, n: int) -> str:
    for p in read.prs:
        if p.pr.number == n:
            return p.pr.title
    for i in read.issues:
        if i.number == n:
            return i.title
    return ''


def _ref(on_pr: bool, n) -> str:
    return f'PR #{n}' if on_pr else f'#{n}'


def _entry(kind, repo, on_pr, n, title) -> dict:
    return {'kind': kind, 'repo': repo, 'ref': _ref(on_pr, n), 'title': title}


def _same(entry: dict, job) -> bool:
    if job is None:
        return False
    on_pr = job.kind in ('fix', 'review', 'merge', 'live') or (job.kind == 'decision' and job.sha)
    kind = 'conflict' if job.kind == 'fix' and job.cause == 'conflict' else job.kind
    return (entry['kind'], entry['repo'], entry['ref']) == (kind, job.repo, _ref(on_pr, job.issue))


def claude_queue(v: View) -> list[dict]:
    """The Claude lane's queue, as `Runner.choose` takes it: a job a limit cut off, decisions,
    live steps, fix and conflict rounds, then builds in the picker's order; each kind through
    the repos in the build order."""
    working = [r for r in v.repos if r.name not in v.off and r.name in v.reads]
    out = []
    for j in v.limited:
        if j.repo in v.off:
            continue
        read = v.reads.get(j.repo)
        kind = 'conflict' if j.kind == 'fix' and j.cause == 'conflict' else j.kind
        out.append(_entry(kind, j.repo, j.kind in ('fix', 'live'), j.issue,
                          _title(read, j.issue) if read else ''))
    for r in working:
        for question, n, on_pr in v.reads[r.name].decisions:
            out.append(_entry('decision', r.name, on_pr, n, _title(v.reads[r.name], n)))
    for r in working:
        if live := v.reads[r.name].live:
            newest, prs = live
            out.append(_entry('live', r.name, True, newest,
                              f'{len(prs)} merged PR{"s" * (len(prs) != 1)}: '
                              + ', '.join(f'#{n}' for n in prs)))
    for r in working:
        for p in v.reads[r.name].prs:
            if p.fix and p.fix[1] is None:
                out.append(_entry(p.fix[0], r.name, True, p.pr.number, p.pr.title))
    for r in working:
        for n, title in v.reads[r.name].builds:
            out.append(_entry('build', r.name, False, n, title))
    now = v.lane_jobs.get('claude')
    return [e for e in out if not _same(e, now)]


def sol_queue(v: View) -> list[dict]:
    """The PRs waiting for their review, in the order the Sol lane takes them."""
    out = [_entry('review', r.name, True, p.pr.number, p.pr.title)
           for r in v.repos if r.name not in v.off and r.name in v.reads
           for p in v.reads[r.name].prs if p.review_why is None]
    now = v.lane_jobs.get('sol')
    return [e for e in out if not _same(e, now)]


def queue(v: View | None, lane: str) -> tuple[list[dict], str]:
    if v is None:
        return [], NOT_READ
    return (claude_queue(v) if lane == 'claude' else sol_queue(v)), QUEUE_EMPTY[lane]


def lists(v: View | None, asks=(), releases=(), inbox=None) -> dict:
    """The snapshot's `features`, `issues`, `prs` and `activity`."""
    if v is None:
        return {'features': [], 'issues': [], 'prs': [], 'activity': []}
    cq, sq = claude_queue(v), sol_queue(v)
    prs = {(r.name, p.pr.number): _pr_status(v, r, p, cq, sq)
           for r in v.repos if r.name in v.reads for p in v.reads[r.name].prs}
    issues = _issues(v, asks, prs, cq)
    return {'features': _feature_list(v, issues), 'issues': issues, 'prs': [], 'activity': []}


# --- features -----------------------------------------------------------------------------------

_PREFIX = re.compile(r'^\s*(spec|map)\s*:\s*', re.I)
# How far along a ticket is, furthest first (as `dashboard/sample.py` orders a feature's bar).
_FAR = {'done': 0, 'merged': 1, 'review': 2, 'fixing': 2, 'building': 3, 'you': 4}


def _feature_title(title: str) -> str:
    t = _PREFIX.sub('', title)
    return t[:1].upper() + t[1:]


def _tickets(its: list[dict]) -> list[str]:
    """In the order they're built: what has started first, furthest along first; then the rest,
    a blocker before what it blocks, lowest number first, one not marked ready last."""
    started = sorted((i for i in its if i['state'] in _FAR),
                     key=lambda i: (_FAR[i['state']], i['n']))
    rest = {_key(i['repo'], i['n']): i for i in its if i['state'] not in _FAR}
    later = []
    while rest:
        free = [i for i in rest.values() if not any(b in rest for b in i['blocked_by'])] \n            or list(rest.values())
        nxt = min(free, key=lambda i: (i['state'] == 'not-ready', i['n']))
        later.append(nxt)
        del rest[_key(nxt['repo'], nxt['n'])]
    return [_key(i['repo'], i['n']) for i in started + later]


def _feature_list(v: View, issues: list[dict]) -> list[dict]:
    """Each repo's features, in the build order: the repos' order, then the feature whose first
    open ticket has the lowest number; one with nothing open last."""
    rank = {r.name: k for k, r in enumerate(v.repos)}
    out = []
    for r in v.repos:
        read = v.reads.get(r.name)
        if read is None:
            continue
        for n, f in _features(read).items():
            fid = _key(r.name, n)
            its = [i for i in issues if i['feature'] == fid]
            out.append({'id': fid, 'repo': r.name, 'n': n, 'title': _feature_title(f.title),
                        'tickets': _tickets(its)})

    def first_open(f):
        return min((i['n'] for i in issues if i['feature'] == f['id'] and i['state'] != 'done'),
                   default=None)
    out.sort(key=lambda f: (first_open(f) is None, rank[f['repo']], first_open(f) or 0))
    return out


# --- issues -------------------------------------------------------------------------------------

READY = 'ready-for-agent'
NEEDS_INFO_MARK = '<!-- queue-runner needs-info '
# A PR's status, by the family its issue's state takes: `you`, `fixing` or `review`.
YOU, FIXING, REVIEW = 'you', 'fixing', 'review'


def _key(repo: str, n: int) -> str:
    return f'{repo}#{n}'


def _features(read: RepoRead) -> dict[int, object]:
    """The repo's features: each open issue with sub-issues (a spec or a map)."""
    return {i.number: i for i in read.issues if i.sub_issues}


def _blocked_by(repo, i, names) -> list[str]:
    """Its blockers as `repo#n` keys: GitHub's dependencies, then `Blocked by:` lines; one in a
    repo the runner doesn't serve is left out."""
    from .picker import blockers
    found = [(where.lower(), n) for where, n, _ in i.blocked_by]
    found += blockers(i.body, repo.github)
    out = []
    for where, n in found:
        if (name := names.get(where)) and _key(name, n) not in out:
            out.append(_key(name, n))
    return out


def _issue(repo, n, title, state, feature=None, pr=None, blocked_by=(), note=None) -> dict:
    return {'repo': repo, 'n': n, 'title': title, 'state': state, 'feature': feature,
            'pr': pr, 'blocked_by': list(blocked_by), 'note': note, 'pick': None}


def _held_state(v: View, repo: str, n: int) -> tuple[str, str] | None:
    """An issue the job log holds for a build: what its newest build left."""
    builds = [j for j in v.jobs if j.kind == 'build' and j.repo == repo and j.issue == n
              and j.outcome not in ('not-started', 'not-sent')]
    if not builds:
        return None
    j = builds[-1]
    if j.open:
        return 'building', 'Claude is building it'
    return {
        'waiting': ('building', 'Its build waits for an answer: a decision comes first'),
        'failed': ('building', 'Its build failed: a decision on what next comes first'),
        'done-no-pr': ('building', 'Its build opened no PR: a decision on what next comes first'),
        'usage-limit': ('building', "Its build was cut off by Claude's usage limit and resumes "
                                    'after the reset'),
        'continued': ('building', 'Its build carries on in the same thread'),
    }.get(j.outcome, ('you', f'Held since its build ended {j.outcome}: --release {repo}#{n} '
                             'lets the runner build it again'))


def _issues(v: View, asks, prs: dict, cq: list) -> list[dict]:
    names = {r.github.lower(): r.name for r in v.repos if r.github}
    picks = {(e['repo'], e['ref']): k for k, e in
             enumerate((e for e in cq if e['kind'] == 'build'), 1)}
    asked = {(a['repo'], a['ref']) for a in asks} | {(a['repo'], f'PR #{a["pr"]}')
                                                    for a in asks if a.get('pr')}
    held = {}   # repo: issues the job log holds
    out = []
    for r in v.repos:
        read = v.reads.get(r.name)
        if read is None:
            continue
        features = _features(read)
        pr_of = {p.issue: p.pr.number for p in read.prs if p.issue}
        builds = {n for n, _ in read.builds}
        for i in sorted(read.issues, key=lambda i: i.number):
            if i.sub_issues or NEEDS_INFO_MARK in i.body:
                continue
            feature = _key(r.name, i.parent) if i.parent in features else None
            n, pr = i.number, pr_of.get(i.number)
            note = None
            if pr is not None:
                status, _, family = prs[(r.name, pr)]
                state, note = family, f'PR #{pr}: {status}'
            elif (r.name, f'#{n}') in asked:
                state = YOU
            elif got := _held_state(v, r.name, n):
                state, note = got
            elif n in read.in_flight:
                state, note = 'building', 'A branch or PR is already on it'
            elif READY not in i.labels:
                state = 'not-ready'
            elif n in builds:
                state = 'ready'
            else:
                state = 'blocked'
            item = _issue(r.name, n, i.title, state, feature, pr, _blocked_by(r, i, names), note)
            item['pick'] = picks.get((r.name, f'#{n}'))
            out.append(item)
        for f in features.values():   # a feature's closed tickets: done, or merged not live yet
            for s in f.sub_issues:
                if s.state != 'closed' or s.repo.lower() != r.github.lower():
                    continue
                merged = s.number in read.pending_issues
                out.append(_issue(r.name, s.number, s.title, 'merged' if merged else 'done',
                                  _key(r.name, f.number),
                                  note='Merged; its live steps are still to run' if merged
                                  else None))
    return out


# --- PRs ----------------------------------------------------------------------------------------

def _pr_status(v: View, repo, p: PrRead, cq: list, sq: list) -> tuple[str, str, str]:
    """(status, what comes next, the family its issue's state takes)."""
    return 'Waiting for review', '', REVIEW


def stale_github(sources: list[dict], stale: dict) -> None:
    """When a repo's work couldn't be read, its lists are the last good read's: the GitHub source
    says so (as `asks.stale_github` does for the Inbox)."""
