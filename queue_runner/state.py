"""The runner's own state: an append-only job log (`<state_dir>/jobs.jsonl`), one JSON object per
line, so a restarted runner knows what ran and what's still open.

Job kinds: `build` (an issue), `review` (Sol on a PR's head H), `fix` (a Claude fix round on a
blocking PR, from H; `cause` `conflict` for a round that merges a conflicted PR's base in), `merge` (the runner merging a clean PR at H, or Stefan's merge noticed),
`ready` (in a repo Stefan merges, `merge.py`: the PR at H `marked` ready for him, or `unmarked`), `stop` (a stop filed for
Stefan on a PR at H: `filed`, then `answered` once he closes its `needs-info` issue or replies on
the PR or the issue; `failed` if the issue couldn't be filed, so the next pass files it) and
`decision` (a one-off Claude decision thread, or Stefan's reply read directly, on a case the flow
doesn't cover: `about` the job it decides on, its outcome the action taken) and `live` (a repo's
live steps after merges, `live.py`: `sha` where the last live run reached, `head` the base's
commit this one brings live).

A build or fix started by a decision continues an earlier job's thread: its start record has
`thread_id` (that thread) and `about` (the earlier job).

Events: `start` (a job is about to start), `end` (how it ended; a later `end` for the same job
replaces the earlier one, e.g. when a waiting thread later completes) and `release` (Stefan
handled a held issue, so the picker may take it again).
"""
import datetime
import json
import os
import threading
import uuid
from dataclasses import dataclass, field, replace

# An ended build job holds its issue, so a failed or waiting run never loops, unless it never
# got a thread to begin with.
NOT_STARTED = 'not-started'
# A decision's message that never reached the earlier job's thread: the new job counts for
# nothing, and the earlier one stands (its issue stays held).
NOT_SENT = 'not-sent'

# A review job's outcomes. These four mean Sol reviewed the head: it isn't reviewed again.
REVIEWED = frozenset({'clean', 'blocking', 'stop', 'approach-note'})
# Not a review: `failed` (no readable ledger, Sol's run failed, or the runner failed around it),
# `out-of-usage` (the Sol lane waits until resume_at) and `head-moved` (a push between listing the
# PR and fetching it).
FAILED_REVIEW = 'failed'
OUT_OF_USAGE = 'out-of-usage'
# A build or fix whose thread stopped on a Claude usage limit (ticket 09): it waits until
# `resume_at`, then a later job of its kind (`about` it) continues the thread or starts afresh.
USAGE_LIMIT = 'usage-limit'
# A fresh restart after a limit whose brief or branch couldn't be made: the limited job stays the
# PR's writer, and the runner doesn't try again, until a release.
RESTART_FAILED = 'restart-failed'

# Both lanes write the log from one process: one lock per file.
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_LOCK = threading.Lock()


def _lock(path: str) -> threading.Lock:
    with _LOCKS_LOCK:
        return _LOCKS.setdefault(os.path.normcase(os.path.abspath(path)), threading.Lock())


def append_record(path: str, record: dict) -> None:
    """Appends one JSON record to a `.jsonl` file and syncs it to disk. A final record torn by a
    crash (no newline yet) is cut off first."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _lock(path), open(path, 'ab+') as f:
        f.seek(0)
        data = f.read()
        if data and not data.endswith(b'\n'):
            f.truncate(data.rfind(b'\n') + 1)
        f.write((json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8'))
        f.flush()
        os.fsync(f.fileno())


def read_records(path: str):
    """The records of a `.jsonl` file written by `append_record`; a bad line other than a torn
    last one is an error (ValueError)."""
    if not os.path.exists(path):
        return
    with _lock(path), open(path, 'rb') as f:
        data = f.read()
    # Every complete record ends in a newline; what follows the last one was torn by a crash
    # (maybe inside a multibyte character), so it's cut off before decoding.
    for line in data[:data.rfind(b'\n') + 1].decode('utf-8').split('\n'):
        if line.strip():
            yield json.loads(line)


def _now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


@dataclass(frozen=True)
class Job:
    id: str
    kind: str                 # build, review, fix, merge, stop or decision
    repo: str                 # the repo's name in config.toml
    issue: int | None         # the issue; for a review, fix or merge, the PR
    branch: str | None
    title: str                # the T3 thread's title; finds the thread after a crash
    started_at: str
    ended_at: str | None = None
    thread_id: str | None = None
    link: str | None = None
    run_id: str | None = None
    exit_code: int | None = None   # t3's: 0 done, 1 failed run, 2 waiting for an answer
    status: str | None = None      # T3's run status
    outcome: str | None = None     # done, done-no-pr, failed, waiting, branch-exists, not-started
    commits: list = field(default_factory=list)
    pr: dict | None = None
    worktree: str | None = None
    error: str | None = None
    sha: str | None = None         # a review, fix or merge: H, the commit it starts from
    round: int | None = None       # a review: its number on the PR
    verdict: str | None = None     # a review: clean or blocking
    signals: list = field(default_factory=list)   # a review: the stop signals that fired
    run_dir: str | None = None     # a review: its brief, inputs, reply and would-be comment
    resume_at: str | None = None   # out-of-usage: when the Sol lane may run again
    head: str | None = None        # a fix: the PR's head after it (H again if it pushed nothing)
    stop: str | None = None        # a stop: its kind (stops.KINDS)
    reason: str | None = None      # a stop: why, as the issue and the toast say it
    answer: str | None = None      # a stop: how Stefan answered (issue-closed, replied)
    about: str | None = None       # a decision: the job it decides on; a continued job: the earlier
    question: str | None = None    # a decision: which question (decisions.QUESTIONS)
    context: int | None = None     # usage-limit: the thread's context in tokens (None: unknown)
    applied: list = field(default_factory=list)   # live: the migrations its thread applied
    prs: list = field(default_factory=list)       # live: the PRs merged in its batch
    cause: str | None = None       # a fix: `conflict` for a conflict round (ticket 15), else None

    @property
    def open(self) -> bool:
        return self.ended_at is None


_END_FIELDS = ('thread_id', 'link', 'run_id', 'exit_code', 'status', 'outcome', 'commits', 'pr',
               'worktree', 'error', 'verdict', 'signals', 'run_dir', 'resume_at', 'head',
               'reason', 'answer', 'context', 'applied', 'prs')


class JobLog:
    def __init__(self, path: str):
        self.path = path

    def _append(self, record: dict) -> None:
        """A start record exists on disk before t3 runs."""
        append_record(self.path, record)

    def _events(self):
        yield from read_records(self.path)

    def started(self, *, kind: str, repo: str, issue: int | None, branch: str | None,
                title: str, sha: str | None = None, round: int | None = None,
                stop: str | None = None, thread_id: str | None = None, about: str | None = None,
                question: str | None = None, head: str | None = None,
                cause: str | None = None) -> Job:
        at = _now()
        stamp = at[:19].replace('-', '').replace(':', '').replace('T', '-')
        job = Job(id=f'{stamp}-{kind}-{repo}-{issue}-{uuid.uuid4().hex[:6]}', kind=kind,
                  repo=repo, issue=issue, branch=branch, title=title, started_at=at, sha=sha,
                  round=round, stop=stop, thread_id=thread_id, about=about, question=question,
                  head=head, cause=cause)
        record = {'event': 'start', 'job': job.id, 'kind': kind, 'repo': repo, 'issue': issue,
                  'branch': branch, 'title': title, 'at': at}
        if sha:
            record.update(sha=sha, round=round)
        for k, v in (('stop', stop), ('thread_id', thread_id), ('about', about),
                     ('question', question), ('head', head), ('cause', cause)):
            if v:
                record[k] = v
        self._append(record)
        return job

    def ended(self, job_id: str, *, exit_code: int | None, outcome: str, **fields) -> None:
        unknown = set(fields) - set(_END_FIELDS)
        if unknown:
            raise TypeError(f'unknown job fields: {sorted(unknown)}')
        self._append({'event': 'end', 'job': job_id, 'at': _now(), 'exit_code': exit_code,
                      'outcome': outcome, **fields})

    def released(self, repo: str, issue: int) -> None:
        self._append({'event': 'release', 'repo': repo, 'issue': issue, 'at': _now()})

    def _fold(self):
        jobs: dict[str, Job] = {}
        held: dict[tuple[str, int], bool] = {}
        released: set[str] = set()   # jobs a release settled; a later build doesn't revive them
        for e in self._events():
            kind = e['event']
            if kind == 'start':
                job = Job(id=e['job'], kind=e['kind'], repo=e['repo'], issue=e['issue'],
                          branch=e['branch'], title=e['title'], started_at=e['at'],
                          sha=e.get('sha'), round=e.get('round'), stop=e.get('stop'),
                          thread_id=e.get('thread_id'), about=e.get('about'),
                          question=e.get('question'), head=e.get('head'),
                          cause=e.get('cause'))
                jobs[job.id] = job
                if job.kind == 'build':
                    held[(job.repo, job.issue)] = True
            elif kind == 'end' and e['job'] in jobs:
                job = replace(jobs[e['job']], ended_at=e['at'],
                              **{k: e[k] for k in _END_FIELDS if k in e})
                jobs[job.id] = job
                if job.kind == 'build' and job.outcome == NOT_STARTED:
                    held[(job.repo, job.issue)] = False
            elif kind == 'release':
                held[(e['repo'], e['issue'])] = False
                released.update(j.id for j in jobs.values()
                                if (j.repo, j.issue) == (e['repo'], e['issue']))
        return list(jobs.values()), held, released

    def jobs(self) -> list[Job]:
        return self._fold()[0]

    def releases(self) -> list[tuple[str, int, str]]:
        """Each `--release`, oldest first: (repo, issue or PR, when)."""
        return [(e['repo'], e['issue'], e['at']) for e in self._events()
                if e['event'] == 'release']

    def open_jobs(self) -> list[Job]:
        return [j for j in self.jobs() if j.open]

    def waiting_jobs(self) -> list[Job]:
        jobs, _, released = self._fold()
        return [j for j in jobs if j.outcome == 'waiting' and j.id not in released]

    def reviews_of(self, repo: str, number: int, sha: str) -> list[Job]:
        """The review jobs on this PR's head H, oldest first, leaving out any a release settled."""
        jobs, _, released = self._fold()
        return [j for j in jobs if j.kind == 'review' and (j.repo, j.issue, j.sha) ==
                (repo, number, sha) and j.id not in released]

    def on(self, kind: str, repo: str, number: int, sha: str | None = None,
           released: bool = False) -> list[Job]:
        """The jobs of this kind on this issue or PR (and head H, if given), oldest first; with
        `released`, also those a release settled."""
        jobs, _, gone = self._fold()
        return [j for j in jobs if (j.kind, j.repo, j.issue) == (kind, repo, number)
                and (sha is None or j.sha == sha) and (released or j.id not in gone)]

    def runner_review(self, repo: str, number: int, sha: str) -> Job | None:
        """The runner's newest review that reviewed this head (clean, blocking, stop or
        approach-note). A release doesn't undo it: the review stands on GitHub."""
        ran = [j for j in self.on('review', repo, number, sha, released=True)
               if j.outcome in REVIEWED]
        return ran[-1] if ran else None

    def pr_jobs(self, repo: str, number: int, branch: str) -> list[Job]:
        """The Claude jobs that wrote to a PR: builds on its branch and its fix rounds."""
        return [j for j in self.jobs() if j.repo == repo and (
            (j.kind == 'build' and j.branch == branch) or (j.kind == 'fix' and j.issue == number))]

    def writer(self, repo: str, branch: str) -> Job | None:
        """A Claude job that is writing to this branch, or may again: a build or fix still
        open, waiting for an answer, or cut off by a usage limit and not yet recovered (until
        it ends or is released). One writer per PR."""
        jobs, _, gone = self._fold()
        limited = {j.id for j in self._limited(jobs, gone, stuck=True)}
        return next((j for j in jobs if j.kind in ('build', 'fix') and j.repo == repo
                     and j.branch == branch and (j.open or j.id in limited or (
                         j.outcome == 'waiting' and j.id not in gone))), None)

    @staticmethod
    def _limited(jobs, gone, stuck=False):
        """Limited jobs not yet recovered: a recovery that never reached a thread (not-started,
        not-sent) doesn't count. One whose restart failed is left out, unless `stuck`."""
        later = [j for j in jobs if j.about and j.kind in ('build', 'fix')]
        recovered = {j.about for j in later
                     if j.outcome not in (NOT_STARTED, NOT_SENT, RESTART_FAILED)}
        failed = {j.about for j in later if j.outcome == RESTART_FAILED}
        return [j for j in jobs if j.outcome == USAGE_LIMIT and j.kind in ('build', 'fix')
                and j.id not in gone
                and j.id not in recovered and (stuck or j.id not in failed)]

    def limited_jobs(self) -> list[Job]:
        """Builds and fixes cut off by a usage limit that no later job has picked up (and no
        release settled), oldest first."""
        jobs, _, gone = self._fold()
        return self._limited(jobs, gone)

    def live(self, repo: str, released: bool = True) -> list[Job]:
        """The repo's live jobs, oldest first; without `released`, leaving out those a release
        settled (a release of the batch's newest PR)."""
        jobs, _, gone = self._fold()
        return [j for j in jobs if j.kind == 'live' and j.repo == repo
                and (released or j.id not in gone)]

    def open_stops(self, repo: str, number: int) -> list[Job]:
        """Stops filed on this PR that Stefan hasn't answered (or released), oldest first: while
        there's one, the runner leaves the PR alone."""
        return [j for j in self.on('stop', repo, number) if j.outcome == 'filed']

    def stopped(self, repo: str, number: int, sha: str, kind: str) -> bool:
        """A stop of this kind was filed on this head already (answered or released or not):
        it's never filed twice."""
        return any(j.stop == kind and j.outcome in ('filed', 'answered')
                   for j in self.on('stop', repo, number, sha, released=True))

    def decided(self, job_id: str) -> Job | None:
        """The decision on this job, if one ran (or is running): a release doesn't undo it, so a
        case is decided once. One cut off before its thread (`not-started`) doesn't count."""
        found = [j for j in self.jobs() if j.kind == 'decision' and j.about == job_id
                 and j.outcome != NOT_STARTED]
        return found[-1] if found else None

    def sol_resume_at(self) -> str | None:
        """When the Sol lane may run again, if the newest ended review found Sol out of usage."""
        ended = [j for j in self.jobs() if j.kind == 'review' and not j.open]
        last = max(ended, key=lambda j: j.ended_at, default=None)
        return last.resume_at if last and last.outcome == OUT_OF_USAGE else None

    def held_issues(self, repo: str) -> set[int]:
        """Issues the build picker must leave alone: a build is open on them, or ended without
        a release since (failed, waiting, done...)."""
        return {issue for (r, issue), on in self._fold()[1].items() if r == repo and on}
