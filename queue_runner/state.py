"""The runner's own state: an append-only job log (`<state_dir>/jobs.jsonl`), one JSON object per
line, so a restarted runner knows what ran and what's still open.

Job kinds: `build` (an issue), `review` (Sol on a PR's head H), `fix` (a Claude fix round on a
blocking PR, from H; `cause` `conflict` for a round that merges a conflicted PR's base in), `merge` (the runner merging a clean PR at H, or Stefan's merge noticed),
`ready` (in a repo Stefan merges, `merge.py`: the PR at H `marked` ready for him, or `unmarked`), `stop` (a stop filed for
Stefan on a PR at H: `filed`, then `answered` once he closes its `needs-info` issue or replies on
the PR or the issue; `failed` if the issue couldn't be filed, so the next pass files it) and
`rerun` (one failed Actions run on a PR's head H re-run once before it's a stop, `stops.py`;
its start record has the run and the failed checks, so a runner cut off before asking GitHub is
settled from the run: `rerun`, then `passed` once its re-run passed and that was said on the PR;
`failed` if GitHub refused it; `not-started` if GitHub was never asked), `base` (the repo's
base branch failing its checks, `stops.py`, issue #98: `issue` null, `branch` the base; `filed`
(or `failed`, its issue not filed: still red, filed next pass), then `closed` once the base
passed) and `base-hold` (a PR held on H because the base fails the
same checks: `held`, then `updated`, `update-failed` (GitHub refused: a conflict) or `moved`,
or `own-failure` (a check the base doesn't fail failed on H too) or `cleared` (nothing fails
on H any more)) and `recheck` (a PR stopped for a failed check on H, updated from its base
once the base moved, issue #199: `sha` H, `base` the base's head it was updated from, `about`
the stop; `updated`, then `passed` (`head` the new head, the stop answered
`passed-after-update`) or `failed-again`; `update-failed` (GitHub refused) or `not-started`
(GitHub didn't answer: tried again)) and `decision` (a one-off Claude decision thread, or Stefan's reply read directly, on a case the flow
doesn't cover: `about` the job it decides on, its outcome the action taken) and `live` (a repo's
live steps after merges, `live.py`: `sha` where the last live run reached, `head` the base's
commit this one brings live).

A build or fix started by a decision continues an earlier job's thread: its start record has
`thread_id` (that thread) and `about` (the earlier job). A job that picks up an earlier one (a
decision's retry or answer, a limit's recovery) also has `resume`: in place or fresh and why
(`limits.ResumeChoice.record`); a fresh one has no `thread_id`.

Events: `start` (a job is about to start), `end` (how it ended; a later `end` for the same job
replaces the earlier one, e.g. when a waiting thread later completes), `release` (Stefan
handled a held issue, so the picker may take it again) and `sol-back` (a ChatGPT reading taken
after Sol's out-of-usage review `job`, with every window under `sol.FULL`, ended that review's
wait before the `resume_at` it recorded: issue #130; `read_at` and `windows` are that reading).
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


def when(stamp: str) -> datetime.datetime:
    """A stamp from the job log as a time with its offset. A stamp written without one (the Sol
    lane's `resume_at` before 2026-11-16) is this PC's local time."""
    t = datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    return t if t.tzinfo else t.astimezone()


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
    answer: str | None = None      # a stop: how Stefan answered (issue-closed, replied); a job
                                   # his GitHub reply continued: that reply's time (waiting.py)
    about: str | None = None       # a decision: the job it decides on; a continued job: the earlier
    question: str | None = None    # a decision: which question (decisions.QUESTIONS)
    context: int | None = None     # usage-limit: the thread's context in tokens (None: unknown)
    last_request: str | None = None   # usage-limit: when its last real request started
    applied: list = field(default_factory=list)   # live: the migrations its thread applied
    prs: list = field(default_factory=list)       # live: the PRs merged in its batch
    cause: str | None = None       # a fix: `conflict` for a conflict round (ticket 15), else None
    resume: dict | None = None     # a job picking up an earlier one: in place or fresh, and why
    effort: str | None = None      # a Claude job: the effort its run used, read back (ticket 39)
    reviewer: str | None = None    # a review: `opus-fallback` when Opus reviewed in Sol's place
    base: str | None = None        # a conflict round: the sha of origin/<base> it merged (#91);
                                   # a failed-check stop or a recheck: the base's head then (#199)
    runs: list = field(default_factory=list)   # a rerun: [{id, attempt, url}], each failed
                                               # Actions run and the attempt that failed (#93)

    @property
    def open(self) -> bool:
        return self.ended_at is None


_END_FIELDS = ('thread_id', 'link', 'run_id', 'exit_code', 'status', 'outcome', 'commits', 'pr',
               'worktree', 'error', 'verdict', 'signals', 'run_dir', 'resume_at', 'head',
               'reason', 'answer', 'context', 'last_request', 'applied', 'prs', 'effort', 'runs')


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
                cause: str | None = None, resume: dict | None = None,
                reviewer: str | None = None, base: str | None = None,
                reason: str | None = None, runs: list | None = None) -> Job:
        at = _now()
        stamp = at[:19].replace('-', '').replace(':', '').replace('T', '-')
        job = Job(id=f'{stamp}-{kind}-{repo}-{issue}-{uuid.uuid4().hex[:6]}', kind=kind,
                  repo=repo, issue=issue, branch=branch, title=title, started_at=at, sha=sha,
                  round=round, stop=stop, thread_id=thread_id, about=about, question=question,
                  head=head, cause=cause, resume=resume, reviewer=reviewer,
                  base=base, reason=reason, runs=list(runs or []))
        record = {'event': 'start', 'job': job.id, 'kind': kind, 'repo': repo, 'issue': issue,
                  'branch': branch, 'title': title, 'at': at}
        if sha:
            record.update(sha=sha, round=round)
        for k, v in (('stop', stop), ('thread_id', thread_id), ('about', about),
                     ('question', question), ('head', head), ('cause', cause),
                     ('resume', resume), ('reviewer', reviewer), ('base', base),
                     ('reason', reason), ('runs', runs)):
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
                          cause=e.get('cause'), resume=e.get('resume'),
                          reviewer=e.get('reviewer'), base=e.get('base'),
                          reason=e.get('reason'), runs=e.get('runs') or [])
                jobs[job.id] = job
                if job.kind == 'build':
                    held[(job.repo, job.issue)] = True
            elif kind == 'end' and e['job'] in jobs:
                job = replace(jobs[e['job']], ended_at=e['at'],
                              **{k: e[k] for k in _END_FIELDS if k in e})
                jobs[job.id] = job
                # A fresh build that never started holds nothing; one picking up an earlier
                # build (`about`) leaves the issue held, as that build holds it.
                if job.kind == 'build' and job.outcome == NOT_STARTED and not job.about:
                    held[(job.repo, job.issue)] = False
            elif kind == 'release':
                held[(e['repo'], e['issue'])] = False
                released.update(j.id for j in jobs.values()
                                if (j.repo, j.issue) == (e['repo'], e['issue']))
        return list(jobs.values()), held, released

    def jobs(self) -> list[Job]:
        return self._fold()[0]

    def released_ids(self) -> set[str]:
        """The ids of the jobs a `--release` settled: each job on that issue or PR started
        before it. What reads the log's history to act on it, or to say where work stands,
        leaves them out."""
        return self._fold()[2]

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

    def pr_threads(self, repo: str, number: int, branch: str) -> list[str]:
        """The T3 threads the runner started for a PR, oldest first, each once (ticket 70's
        settle at its merge): its build and fix threads, the decisions on it or on one of
        those jobs (a failed build's, before the PR existed), and its Opus fallback reviews.
        Never an ask thread, which `prefixes.py` settles once decided (a decision acted on
        from one carries its id), nor a live run's, which isn't the PR's."""
        jobs = self.jobs()
        writers = self.pr_jobs(repo, number, branch)
        ids = {j.id for j in writers}
        asks = {j.thread_id for j in jobs if j.kind == 'ask' and j.repo == repo}
        mine = [j for j in jobs if j.repo == repo and (
            j.id in ids
            or (j.kind == 'decision' and (j.issue == number or j.about in ids))
            or (j.kind == 'review' and j.issue == number))]
        out = []
        for j in mine:
            if j.thread_id and j.thread_id not in asks and j.thread_id not in out:
                out.append(j.thread_id)
        return out

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

    def sol_out(self) -> Job | None:
        """Sol's newest ended review, if it found Sol out of usage and no `sol-back` record
        since says ChatGPT has usage again (issue #130). The Opus fallback's reviews meanwhile
        (`reviewer`) aren't Sol's, so they don't end the wait (issue #69)."""
        ended = [j for j in self.jobs() if j.kind == 'review' and not j.open and not j.reviewer]
        # Stamps are to the second: a tie goes to the one written later.
        last = max(reversed(ended), key=lambda j: j.ended_at, default=None)
        if not last or last.outcome != OUT_OF_USAGE:
            return None
        # A sol-back record names the review whose wait it ended (PR 131's review 2, F6): no
        # stamp is compared, so a later out-of-usage review ending in the same second as the
        # reading starts a wait of its own.
        if any(e['event'] == 'sol-back' and e.get('job') == last.id for e in self._events()):
            return None
        return last

    def sol_resume_at(self) -> str | None:
        """When Sol may review again, if it's out of usage now (`sol_out`)."""
        out = self.sol_out()
        return out.resume_at if out else None

    def sol_back(self, *, job: str, read_at: str, windows: list, resume_at: str | None) -> None:
        """A ChatGPT reading at `read_at`, after Sol's out-of-usage review `job` ran out, shows
        usage again: that review's wait, which would have lasted until `resume_at`, ends now
        (issue #130)."""
        self._append({'event': 'sol-back', 'at': _now(), 'job': job, 'read_at': read_at,
                      'windows': windows, 'resume_at': resume_at})

    def held_issues(self, repo: str) -> set[int]:
        """Issues the build picker must leave alone: a build is open on them, or ended without
        a release since (failed, waiting, done...)."""
        return {issue for (r, issue), on in self._fold()[1].items() if r == repo and on}
