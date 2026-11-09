"""The runner's own state: an append-only job log (`<state_dir>/jobs.jsonl`), one JSON object per
line, so a restarted runner knows what ran and what's still open.

Job kinds: `build` (an issue), `review` (Sol on a PR's head H), `fix` (a Claude fix round on a
blocking PR, from H) and `merge` (the runner merging a clean PR at H).

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

# A review job's outcomes. These four mean Sol reviewed the head: it isn't reviewed again.
REVIEWED = frozenset({'clean', 'blocking', 'stop', 'approach-note'})
# Not a review: `failed` (no readable ledger, Sol's run failed, or the runner failed around it),
# `out-of-usage` (the Sol lane waits until resume_at) and `head-moved` (a push between listing the
# PR and fetching it).
FAILED_REVIEW = 'failed'
OUT_OF_USAGE = 'out-of-usage'

# Both lanes write the log from one process: one lock per file.
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_LOCK = threading.Lock()


def _lock(path: str) -> threading.Lock:
    with _LOCKS_LOCK:
        return _LOCKS.setdefault(os.path.normcase(os.path.abspath(path)), threading.Lock())


def _now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


@dataclass(frozen=True)
class Job:
    id: str
    kind: str                 # build, review, fix or merge
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

    @property
    def open(self) -> bool:
        return self.ended_at is None


_END_FIELDS = ('thread_id', 'link', 'run_id', 'exit_code', 'status', 'outcome', 'commits', 'pr',
               'worktree', 'error', 'verdict', 'signals', 'run_dir', 'resume_at', 'head')


class JobLog:
    def __init__(self, path: str):
        self.path = path
        self._lock = _lock(path)

    def _append(self, record: dict) -> None:
        """Appends one record and syncs it to disk, so a start record exists before t3 runs.
        A final record torn by a crash (no newline yet) is cut off first."""
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with self._lock, open(self.path, 'ab+') as f:
            f.seek(0)
            data = f.read()
            if data and not data.endswith(b'\n'):
                f.truncate(data.rfind(b'\n') + 1)
            f.write((json.dumps(record, ensure_ascii=False) + '\n').encode('utf-8'))
            f.flush()
            os.fsync(f.fileno())

    def _events(self):
        if not os.path.exists(self.path):
            return
        with self._lock, open(self.path, 'rb') as f:
            data = f.read()
        # Every complete record ends in a newline; what follows the last one was torn by a crash
        # (maybe inside a multibyte character), so it's cut off before decoding.
        for line in data[:data.rfind(b'\n') + 1].decode('utf-8').split('\n'):
            if line.strip():
                yield json.loads(line)

    def started(self, *, kind: str, repo: str, issue: int | None, branch: str | None,
                title: str, sha: str | None = None, round: int | None = None) -> Job:
        at = _now()
        stamp = at[:19].replace('-', '').replace(':', '').replace('T', '-')
        job = Job(id=f'{stamp}-{kind}-{repo}-{issue}-{uuid.uuid4().hex[:6]}', kind=kind,
                  repo=repo, issue=issue, branch=branch, title=title, started_at=at, sha=sha,
                  round=round)
        record = {'event': 'start', 'job': job.id, 'kind': kind, 'repo': repo, 'issue': issue,
                  'branch': branch, 'title': title, 'at': at}
        if sha:
            record.update(sha=sha, round=round)
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
                          sha=e.get('sha'), round=e.get('round'))
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

    def writer(self, repo: str, branch: str) -> Job | None:
        """A Claude job that is writing to this branch, or may again: a build or fix still
        open, or waiting for an answer (until it ends or is released). One writer per PR."""
        jobs, _, gone = self._fold()
        return next((j for j in jobs if j.kind in ('build', 'fix') and j.repo == repo
                     and j.branch == branch and (j.open or (j.outcome == 'waiting'
                                                            and j.id not in gone))), None)

    def sol_resume_at(self) -> str | None:
        """When the Sol lane may run again, if the newest ended review found Sol out of usage."""
        ended = [j for j in self.jobs() if j.kind == 'review' and not j.open]
        last = max(ended, key=lambda j: j.ended_at, default=None)
        return last.resume_at if last and last.outcome == OUT_OF_USAGE else None

    def held_issues(self, repo: str) -> set[int]:
        """Issues the build picker must leave alone: a build is open on them, or ended without
        a release since (failed, waiting, done...)."""
        return {issue for (r, issue), on in self._fold()[1].items() if r == repo and on}
