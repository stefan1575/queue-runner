"""The runner's own state: an append-only job log (`<state_dir>/jobs.jsonl`), one JSON object per
line, so a restarted runner knows what ran and what's still open.

Events: `start` (a job is about to start), `end` (how it ended; a later `end` for the same job
replaces the earlier one, e.g. when a waiting thread later completes) and `release` (Stefan
handled a held issue, so the picker may take it again).
"""
import datetime
import json
import os
import uuid
from dataclasses import dataclass, field, replace

# An ended build job holds its issue, so a failed or waiting run never loops, unless it never
# got a thread to begin with.
NOT_STARTED = 'not-started'


def _now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec='seconds')


@dataclass(frozen=True)
class Job:
    id: str
    kind: str                 # build (fix, review... in later tickets)
    repo: str                 # the repo's name in config.toml
    issue: int | None
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

    @property
    def open(self) -> bool:
        return self.ended_at is None


_END_FIELDS = ('thread_id', 'link', 'run_id', 'exit_code', 'status', 'outcome', 'commits', 'pr',
               'worktree', 'error')


class JobLog:
    def __init__(self, path: str):
        self.path = path

    def _append(self, record: dict) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')

    def _events(self):
        if not os.path.exists(self.path):
            return
        with open(self.path, encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    yield json.loads(line)

    def started(self, *, kind: str, repo: str, issue: int | None, branch: str | None,
                title: str) -> Job:
        at = _now()
        stamp = at[:19].replace('-', '').replace(':', '').replace('T', '-')
        job = Job(id=f'{stamp}-{kind}-{repo}-{issue}-{uuid.uuid4().hex[:6]}', kind=kind, repo=repo, issue=issue,
                  branch=branch, title=title, started_at=at)
        self._append({'event': 'start', 'job': job.id, 'kind': kind, 'repo': repo,
                      'issue': issue, 'branch': branch, 'title': title, 'at': at})
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
        for e in self._events():
            kind = e['event']
            if kind == 'start':
                job = Job(id=e['job'], kind=e['kind'], repo=e['repo'], issue=e['issue'],
                          branch=e['branch'], title=e['title'], started_at=e['at'])
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
        return list(jobs.values()), held

    def jobs(self) -> list[Job]:
        return self._fold()[0]

    def open_jobs(self) -> list[Job]:
        return [j for j in self.jobs() if j.open]

    def waiting_jobs(self) -> list[Job]:
        jobs, held = self._fold()
        return [j for j in jobs if j.outcome == 'waiting' and held.get((j.repo, j.issue))]

    def held_issues(self, repo: str) -> set[int]:
        """Issues the build picker must leave alone: a build is open on them, or ended without
        a release since (failed, waiting, done...)."""
        return {issue for (r, issue), on in self._fold()[1].items() if r == repo and on}
