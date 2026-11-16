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
    held: str | None = None             # why it's left alone for Stefan (`stops.held`)
    writer: str | None = None           # a Claude job that writes to it, or may again


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
    findings: dict = field(default_factory=dict)   # review job id: {findings, signals}
    # The parts that couldn't be read (`read_repo`'s keys), which the Reader takes from the
    # last good read: 'fix' and 'review_why' (every PR's, or one PR's as ('fix', n)...),
    # ('merge', n), ('reviews', n), 'decisions', 'live', 'pending', 'builds', 'in_flight',
    # 'findings'.
    failed: frozenset = frozenset()


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
    from .stops import held
    issues = tuple(github.work_issues(repo))
    pulls = sorted(github.open_pulls(repo), key=lambda p: p.number)
    errors, failed = [], set()

    def part(label, fn, empty=(), key=None):
        try:
            return fn()
        except Exception as e:
            errors.append(f'{repo.name}: {label} ({type(e).__name__}: {e})')
            failed.add(key or label)
            return empty
    merger = Merger(config, github=github, git=None, jobs=jobs, say=_noop)
    reviewer = Reviewer(config, github=github, git=None, sol=None, jobs=jobs, say=_noop,
                        poster=DryRunPoster(_noop))
    fixer = Fixer(config, github=github, git=git, jobs=jobs)
    fixes = part('fix rounds', lambda: {pr.number: ('fix' if review else 'conflict', why)
                                        for pr, review, why in fixer.candidates(repo)}, {}, 'fix')
    whys = part('reviews', lambda: {pr.number: why for pr, why in reviewer.candidates(repo)}, {},
                'review_why')
    # Each lane's own reading of one PR failing is said as its why ("reading it failed (...)"):
    # here, a part of the read that failed, kept from the last good read.
    for k, (label, found) in {'fix': ('the fix round', fixes),
                              'review_why': ('the review', whys)}.items():
        for n, got in list(found.items()):
            why = got[1] if k == 'fix' else got
            if isinstance(why, str) and why.startswith(FAILED_READ):
                errors.append(f'{repo.name}: {label} of #{n} {why[len(FAILED_READ):]}')
                failed.add((k, n))
                if k == 'fix':   # not a candidate it can say anything of
                    del found[n]
    builds = {j.branch: j.issue for j in jobs.jobs() if j.kind == 'build' and j.repo == repo.name}
    here = repo.github.lower()
    prs = []
    for pr in pulls:
        closes = next((k for where, k in closed_issues(pr.body, repo.github) if where == here),
                      None)
        merge = None
        if merger.clean_on_head(repo, pr):
            merge = part(f'the merge re-check of #{pr.number}',
                         lambda: tuple(merger.steps(repo, pr.number, pr.head_sha)), None,
                         ('merge', pr.number))
        w = jobs.writer(repo.name, pr.branch)
        prs.append(PrRead(pr=pr, issue=closes or builds.get(pr.branch),
                          held=held(jobs, repo, pr.number),
                          writer=None if w is None else _writer(w),
                          review_why=whys.get(pr.number, 'it could not be read'),
                          fix=fixes.get(pr.number), merge=merge,
                          reviews=tuple(part(f'the reviews of #{pr.number}', lambda: read_reviews(
                              github.issue_comments(repo, pr.number)), (),
                              ('reviews', pr.number)))))
    decider = Decider(config, github=github, t3=None, jobs=jobs, say=_noop, stopper=None)
    decisions = part('decisions', lambda: tuple(
        (c.question, c.number, c.pr is not None or c.about.kind in ('fix', 'review'))
        for c in decider.cases(repo)), (), 'decisions')
    live, pending, pending_issues = None, (), ()
    if repo.live_doc and git is not None:
        steps = LiveSteps(config, github=github, git=NoFetch(git), t3=None, jobs=jobs, say=_noop,
                          stopper=_NoStops(), merger=merger, now=now)
        b = part('live steps', lambda: steps.batch(repo, record=False), None, 'live')
        if b is not None:
            live = (b.prs[-1], tuple(b.prs))
        last, _ = steps.reach(repo)
        if last is not None and last.head:
            commits = part('what is merged and not live', lambda: git.first_parent(
                repo.path, last.head, f'origin/{repo.base}'), (), 'pending')
            pending = tuple(pr_numbers(commits))
            pending_issues = tuple(int(m[1]) for c in commits
                                   if (m := _FROM_BRANCH.search(c['subject'])))
    picked = part('builds', lambda: tuple(
        (b.issue.number, b.issue.title)
        for b in pickable(repo, github, held=jobs.held_issues(repo.name))), (), 'builds')
    flying = part('what is in flight', lambda: frozenset(in_flight(repo, github)), frozenset(),
                  'in_flight')
    from .inbox import reviews
    # Each review's decision.json (its findings and signals), as `asks.Story` reads them.
    found = part("the reviews' findings", lambda: reviews(
        jobs.jobs(), {(repo.name, p.number) for p in pulls}), {}, 'findings')
    return RepoRead(at=None, issues=issues, prs=tuple(prs), decisions=decisions, live=live,
                    findings=found,
                    pending=pending, pending_issues=pending_issues, builds=picked,
                    in_flight=flying, errors=tuple(errors), failed=frozenset(failed))


_PARTS = ('decisions', 'live', 'builds', 'in_flight', 'findings')
FAILED_READ = 'reading it failed '   # `Reviewer._candidates`' and `Fixer.candidates`' why


def kept(got: RepoRead, last: RepoRead | None) -> RepoRead:
    """`got` with each part it couldn't read taken from `last`, the last good read (a PR's own
    parts only while its head is the same): a part GitHub failed on shows what it showed last,
    not nothing."""
    from dataclasses import replace
    if last is None or not got.failed:
        return got
    f, old = got.failed, {p.pr.number: p for p in last.prs}
    prs = []
    for p in got.prs:
        o = old.get(p.pr.number)
        if o is not None and o.pr.head_sha == p.pr.head_sha:
            n = p.pr.number
            p = replace(p, **{k: getattr(o, k) for k in ('fix', 'review_why', 'merge', 'reviews')
                              if k in f or (k, n) in f})
        prs.append(p)
    change = {k: getattr(last, k) for k in _PARTS if k in f}
    if 'pending' in f:
        change.update(pending=last.pending, pending_issues=last.pending_issues)
    return replace(got, prs=tuple(prs), **change)


def _writer(j) -> str:
    what = ('conflict round' if j.cause == 'conflict' else
            'fix round' if j.kind == 'fix' else j.kind)
    if j.outcome == 'waiting':
        return f'its {what} waits for an answer, and may write to the branch again'
    if j.outcome == 'usage-limit':
        return (f"its {what} was cut off by Claude's usage limit and resumes after "
                f'{j.resume_at}')
    return f'its {what} is writing to the branch'


class Reader:
    """The last read of each served repo, for the snapshot. A repo GitHub couldn't be read keeps
    what its last good read found, and `stale` says since when and why."""

    def __init__(self, config, github, git, jobs, clock):
        self.config, self.github, self.git, self.jobs, self.clock = config, github, git, jobs, clock
        self._lock = threading.Lock()
        self._good: dict[str, RepoRead] = {}
        self._stale: dict[str, tuple] = {}
        self._whole: dict[str, datetime.datetime] = {}   # repo: its last read with no part failed

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
                    self._stale[repo.name] = (self._whole.get(repo.name),
                                              f"{repo.name}: couldn't read its work "
                                              f'({type(e).__name__}: {e})')
                continue
            now = self.clock()
            with self._lock:
                # A part that failed keeps the last good read's, and the repo is stale (since
                # its last whole read) until a read has every part.
                self._good[repo.name] = _at(kept(got, self._good.get(repo.name)), now)
                if got.failed:
                    self._stale[repo.name] = (self._whole.get(repo.name), got.errors[0])
                else:
                    self._whole[repo.name] = now
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
    titles: dict = field(default_factory=dict)      # (repo, n): a title the passes read
    released: frozenset = frozenset()   # the jobs a release settled (`JobLog.released_ids`)


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
    story = _story(v)
    titles = {(r, n): t for r, read in v.reads.items() for n, t in _titles(read).items()}
    titles.update(v.titles)
    return {'features': _feature_list(v, issues), 'issues': issues,
            'prs': _pr_list(v, prs, story, releases),
            'activity': _activity(story, v, titles, releases)}


def _titles(read: RepoRead) -> dict:
    found = {i.number: i.title for i in read.issues}
    found.update((s.number, s.title) for i in read.issues for s in i.sub_issues)
    found.update((p.pr.number, p.pr.title) for p in read.prs)
    return found


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
        free = [i for i in rest.values()
                if not any(b in rest for b in i['blocked_by'])] or list(rest.values())
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
    """An issue the job log holds for a build: what its newest build left. A build a release
    settled holds nothing: the picker takes the issue up again."""
    builds = [j for j in v.jobs if j.kind == 'build' and j.repo == repo and j.issue == n
              and j.outcome not in ('not-started', 'not-sent') and j.id not in v.released]
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

def _nth(n: int) -> str:
    if n == 1:
        return 'next'
    return f'{n}{"th" if 10 < n % 100 < 14 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")}'


def _sentence(text: str) -> str:
    text = (text or '').strip()
    return text[:1].upper() + text[1:] + ('' if text.endswith(('.', '!', '?')) else '.')


def _place(queue: list, kinds, repo: str, n: int) -> int | None:
    return next((k for k, e in enumerate(queue, 1)
                 if e['kind'] in kinds and e['repo'] == repo and e['ref'] == f'PR #{n}'), None)


_OUTSIDE = re.compile(r'^review (\d+) is on \w+ already \((\w+)\)')


def _pr_status(v: View, repo, p: PrRead, cq: list, sq: list) -> tuple[str, str, str]:
    """(status, what comes next, the family its issue's state takes: you, fixing or review)."""
    n, h7 = p.pr.number, p.pr.head_sha[:7]
    on = [j for j in v.jobs if j.open and j.repo == repo.name and j.issue == n]
    if fix := next((j for j in on if j.kind == 'fix'), None):
        what = 'Conflict round' if fix.cause == 'conflict' else 'Fix round'
        return f'{what} running', 'Claude is on it; Sol reviews the head it pushes.', FIXING
    if review := next((j for j in on if j.kind == 'review'), None):
        who = 'Opus (in place of Sol, out of usage)' if review.reviewer else 'Sol'
        return 'In review', f'{who} is on review {review.round or 1} of {h7}.', REVIEW
    if any(j.kind == 'merge' for j in on):
        return 'Merging', f'The runner is merging it at {h7}.', REVIEW
    if p.writer:
        return 'A Claude job holds it', _sentence(p.writer), FIXING
    if repo.name in v.off:
        return ('Its repository is stopped',
                f'Neither lane takes up its work until you resume {repo.name}.', REVIEW)
    if p.held:
        return 'Held for you', _sentence(p.held), YOU
    if p.merge is not None and not (p.fix and p.fix[0] == 'conflict'):
        why = next((w for _, w in p.merge if w), None)
        if why is None and repo.stefan_merges:
            return ('Ready for you to merge', 'You merge it.' + (
                ' Its live steps follow your merge.' if repo.live_doc else ''), YOU)
        if why is None:
            return 'Merging next', 'The runner merges it on its next pass.', REVIEW
        who = 'It comes to you to merge' if repo.stefan_merges else 'The runner merges it'
        why = why if why.endswith('.') else f'{why}.'
        return 'Clean, not merged yet', f'{who} once this clears: {why}', REVIEW
    if p.fix:
        cause, why = p.fix
        what = 'conflict round' if cause == 'conflict' else 'fix round'
        if why is None:
            k = _place(cq, ('fix', 'conflict'), repo.name, n) or 1
            return (f'{what.capitalize()} {"next" if k == 1 else "queued"}',
                    f"Claude's {what} on {h7} is {_nth(k)} in its queue.", FIXING)
        return ('Conflicts with its base' if cause == 'conflict' else 'Blocking, no fix round now',
                _sentence(why), REVIEW)
    why = p.review_why
    if why is None:
        k = _place(sq, ('review',), repo.name, n)
        before = sq[k - 2]['ref'] if k and k > 1 else None
        return ('Waiting for review', f'Sol reviews {h7} next.' if before is None else
                f'Sol reviews {h7} after {before}.', REVIEW)
    if m := _OUTSIDE.match(why):
        return ('Left alone: reviewed outside the runner',
                f'Review {m[1]} on {h7} ({m[2]}) was posted before the cutover or by hand, so the '
                'runner leaves it to whoever ran it. A push of a new head lets it go: Sol reviews '
                'that.', REVIEW)
    if 'failed reviews on' in why:
        return ('Left alone: two reviews failed',
                f'Both reviews of {h7} failed. A push of a new head, or --release '
                f'{repo.name}#{n}, lets it go.', REVIEW)
    if why.startswith('checks still running'):
        return 'Checks running', f'Sol reviews it once its checks pass on {h7}.', REVIEW
    if why.startswith('no checks reported'):
        return 'No checks yet', f'Sol reviews it once its checks report on {h7}.', REVIEW
    if why.startswith('a check failed'):
        return 'A check failed', _sentence(why), REVIEW
    if why.startswith('the runner reviewed'):
        return 'Reviewed', _sentence(why), REVIEW
    return 'Not reviewed now', _sentence(why), REVIEW


def _pr_list(v: View, statuses: dict, story, releases) -> list[dict]:
    out = []
    for r in v.repos:
        read = v.reads.get(r.name)
        if read is None:
            continue
        for p in read.prs:
            status, nxt, _ = statuses[(r.name, p.pr.number)]
            pr = p.pr
            out.append({'repo': r.name, 'n': pr.number, 'issue': p.issue, 'title': pr.title,
                        'head': pr.head_sha[:7], 'branch': pr.branch,
                        'url': pr.url or f'https://github.com/{r.github}/pull/{pr.number}',
                        'status': status, 'next': nxt,
                        'checks': [{'label': label, 'ok': why is None}
                                   for label, why in (p.merge or ())],
                        'timeline': _timeline(story, v, r, p, releases)})
    return out


# --- what happened ------------------------------------------------------------------------------

ACTIVITY_MAX = 200
_PR_KINDS = ('review', 'fix', 'merge', 'ready', 'stop', 'live')


def _h7(sha) -> str:
    return (sha or '')[:7]


def _other(j) -> str | None:
    """The sentences `asks.Story` doesn't write: what counted for nothing."""
    h7 = _h7(j.sha)
    if j.kind == 'review' and j.reviewer:   # the Opus fallback while Sol is out (#69)
        return {'failed': f"The Opus fallback's review of {h7} failed.",
                'head-moved': f'The head moved while Opus was to review {h7}, so nothing '
                              'counted.'}.get(j.outcome, f'Opus started reviewing {h7} in place '
                                              'of Sol.' if j.open else None)
    if j.kind == 'review':
        return {'failed': f"Sol's review of {h7} failed.",
                'out-of-usage': f'Sol ran out of usage reviewing {h7}; the PR is reviewed afresh '
                                'after the reset.',
                'head-moved': f'The head moved while Sol was to review {h7}, so nothing '
                              'counted.'}.get(j.outcome, f'Sol started reviewing {h7}.'
                                              if j.open else None)
    if j.kind == 'merge':
        return {'head-moved': f'The merge at {h7} was refused: the head had moved.',
                'failed': f'The merge at {h7} failed.'}.get(
            j.outcome, f'The runner started merging it at {h7}.' if j.open else None)
    if j.kind == 'stop' and j.outcome == 'failed':
        return 'Filing a stop for you failed; the next pass files it again.'
    return None


def _event(story, j) -> list[tuple]:
    """A job's events: (when, actor, kind, sha, sentence, tone, findings). A stop Stefan answered
    is two: the stop, and his answer."""
    from .asks import REVIEWED, SKIPPED
    from .stops import number_of
    if j.outcome in SKIPPED or (j.kind == 'live' and j.outcome == 'assumed'):
        return []
    at, sha = j.ended_at or j.started_at, _h7(j.sha)
    tone = None
    findings = []
    if j.kind == 'build':
        text, actor, at = story._build(j), 'claude', j.started_at if j.open else at
        tone = 'ok' if j.outcome == 'done' else 'bad' if j.outcome == 'failed' else None
    elif j.kind == 'review':
        actor = 'sol'
        text = story._review(j) if j.outcome in REVIEWED else _other(j)
        tone = 'ok' if j.outcome == 'clean' else 'you' if j.outcome in (
            'stop', 'approach-note') else None
        findings = [{'id': f.get('id', ''), 'text': f.get('class') or f.get('text') or '',
                     'status': f.get('status', 'open')} for f in story.findings(j)]
    elif j.kind == 'fix':
        text, actor = story._fix(j), 'claude'
        at = j.started_at if j.open else at
        tone = 'ok' if j.outcome == 'pushed' else 'bad' if j.outcome == 'failed' else None
    elif j.kind == 'ready':
        text, actor = story._ready(j), 'runner'
        tone = 'you' if j.outcome == 'marked' else None
    elif j.kind == 'merge':
        mine = 'Stefan' in (j.reason or '')
        text = ('You merged it.' if mine else 'The runner merged it.') \
            if j.outcome == 'merged' else _other(j)
        actor, tone = ('you' if mine else 'runner'), 'ok' if j.outcome == 'merged' else None
    elif j.kind == 'live':
        text, actor = story._live(j), 'claude'
        tone = 'ok' if j.outcome == 'live' else 'bad' if j.outcome in ('failed', 'partial') \
            else 'you' if j.outcome == 'stop' else None
    elif j.kind == 'decision':
        text, actor = story._decision(j) or f'A decision ended {j.outcome}.', 'claude'
        tone = 'you' if j.outcome == 'stop' else None
    elif j.kind == 'stop':
        if j.outcome not in ('filed', 'answered'):
            return [(at, 'runner', 'stop', sha, _other(j), 'bad', [])] if _other(j) else []
        out = [(j.started_at, 'runner', 'stop', sha, story._stop(j), 'you', [])]
        if j.outcome == 'answered':
            out.append((j.ended_at, 'you', 'answer', sha,
                        f'You closed needs-info issue #{number_of(j.link)}.'
                        if j.answer == 'issue-closed' and j.link else 'You replied.', None, []))
        return out
    else:
        return []
    return [(at, actor, j.kind, sha, text, tone, findings)] if text else []


def _story(v: View):
    from .asks import Story
    reviews = {}
    for read in v.reads.values():
        reviews.update(read.findings)
    return Story(list(v.jobs), [], reviews)


def _when(stamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def _iso(stamp: str | None) -> str | None:
    return _when(stamp).astimezone().isoformat(timespec='seconds') if stamp else None


def _on_pr(j) -> bool:
    return j.kind in _PR_KINDS or (j.kind == 'decision' and bool(j.sha))


def _timeline(story, v: View, repo, p: PrRead, releases) -> list[dict]:
    """The PR's story, oldest first, each event on the head it happened at: its build, the
    runner's reviews, fix rounds, decisions, stops, ready marks, merges, live runs and releases."""
    n = p.pr.number
    pos = {j.id: k for k, j in enumerate(v.jobs)}
    events = []
    for j in v.jobs:
        if j.repo != repo.name:
            continue
        mine = (j.issue == n and _on_pr(j)) or (j.kind == 'live' and n in (j.prs or ())) or (
            j.kind == 'build' and isinstance(j.pr, dict) and j.pr.get('number') == n)
        if mine:
            events += [(e, pos[j.id]) for e in _event(story, j)]
    for r_repo, r_n, at in releases:
        if (r_repo, r_n) == (repo.name, n):
            events.append(((at, 'you', 'release', '', f'You released it (--release '
                           f'{repo.name}#{n}), so the runner took it up again.', None, []),
                           len(pos)))
    events.sort(key=lambda e: (_when(e[0][0]), e[1]))
    out, sha = [], None
    for (at, actor, kind, h7, text, tone, findings), _ in events:
        out.append({'at': _iso(at), 'actor': actor, 'kind': kind, 'sha': h7 or None,
                    'title': text, 'detail': None, 'tone': tone, 'findings': findings})
    # A build is on the first head the PR was reviewed or fixed at; a step with no head of its
    # own is on the head before it.
    for k, e in enumerate(out):
        if not e['sha'] and e['kind'] == 'build':
            e['sha'] = next((x['sha'] for x in out[k + 1:] if x['sha']), p.pr.head_sha[:7])
    for e in out:
        sha = e['sha'] = e['sha'] or sha or p.pr.head_sha[:7]
    return out


def _activity(story, v: View, titles: dict, releases) -> list[dict]:
    """What happened, newest first, the latest `ACTIVITY_MAX`: every job's events and Stefan's
    releases, each a whole sentence, with its issue's or PR's title."""
    pos = {j.id: k for k, j in enumerate(v.jobs)}
    rows = []
    for j in v.jobs:
        on_pr = _on_pr(j)
        n = j.issue
        for k, (at, actor, kind, sha, text, tone, _) in enumerate(_event(story, j)):
            if n is None:
                continue
            rows.append(((_when(at), pos[j.id], k), {
                'at': _iso(at), 'actor': actor, 'repo': j.repo, 'pr': n if on_pr else None,
                'ref': _ref(on_pr, n), 'title': text, 'detail': titles.get((j.repo, n)) or None,
                'tone': tone}))
    prs = {(r, p.pr.number) for r, read in v.reads.items() for p in read.prs}
    for repo, n, at in releases:
        on_pr = (repo, n) in prs
        rows.append(((_when(at), len(pos), 0), {
            'at': _iso(at), 'actor': 'you', 'repo': repo, 'pr': n if on_pr else None,
            'ref': _ref(on_pr, n),
            'title': f'You released it (--release {repo}#{n}), so the runner took it up again.',
            'detail': titles.get((repo, n)) or None, 'tone': None}))
    rows.sort(key=lambda r: r[0], reverse=True)
    return [r for _, r in rows[:ACTIVITY_MAX]]


def stale_github(sources: list[dict], stale: dict) -> None:
    """When a repo's work couldn't be read, its lists are the last good read's: the GitHub source
    says so, since when and what it affects (as `asks.stale_github` does for the Inbox, whose
    line this one joins)."""
    src = next((s for s in sources if s['id'] == 'github'), None)
    if not stale or src is None:
        return
    names = ', '.join(sorted(stale))
    whens = [when for when, _ in stale.values() if when is not None]
    error = next((e for _, e in stale.values() if e), '')
    text = (f'The queues, issues and PRs are as GitHub last showed them for {names}: some may '
            'have changed since.')
    earlier = None if src['ok'] else src
    at = min(whens).astimezone().isoformat(timespec='seconds')         if len(whens) == len(stale) else None
    if earlier is not None:   # the Inbox's line was there first: both are said, the older time
        at = min(filter(None, (at, earlier['checked_at'])), default=None)             if at and earlier['checked_at'] else None
    src.update(ok=False, note=earlier['note'] if earlier else _sentence(
        error.split(': ', 1)[-1]) or "Couldn't be read", checked_at=at,
        affects=f'{earlier["affects"]} {text}' if earlier and earlier.get('affects') else text)
