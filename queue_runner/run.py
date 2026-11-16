"""The run loop: two lanes side by side, one Claude job per working repo and one Sol job at a
time.

The Claude lane settles what earlier passes left open, then chooses each working repo's job (#50:
the repos run side by side, each in a worker thread of its own that blocks on `t3 thread start
--wait` while its job runs): a decision on a case the flow doesn't cover (`decisions.py`), then
the repo's live steps after merges (`live.py`), then a fix round on a PR the runner found blocking
(`fix.py`), before any new build, so open PRs finish first. The usage gate lets each in only
when it fits beside the jobs still running, the repo whose work has waited longest first. The
lane plans again whenever a job ends. The Sol lane (`review.py`) reviews at most one PR a pass,
under `<state_dir>/sol.lock`. A second runner process is kept out by a lock on
`<state_dir>/runner.lock`.
"""
import datetime
import os
import threading
import time
import traceback
from dataclasses import dataclass, field, replace

from . import control
from .brief import build_brief
from .config import Config, Repo, set_stopped, stopped, working
from .decisions import Decider
from .fix import Fixer, fix_branch, fix_title
from .stops import CONFLICT
from .gate import CLAUDE_KINDS, FALLBACK_REVIEW
from . import limits as lim
from .live import LiveSteps
from .lock import RunnerBusy, runner_lock  # noqa: F401 (the CLI takes them from here)
from .merge import Merger
from .picker import BuildJob, pick
from .review import Reviewer
from .snapshot import Wait
from .state import NOT_SENT, NOT_STARTED, RESTART_FAILED, USAGE_LIMIT, Job, JobLog, when
from .stops import Stopper
from .t3 import T3Error, Thread, settle_quietly
from .toast import NoToaster
from .wake import NoWaker

# What a pass did: started (it started jobs), busy (a Claude job is still running from an earlier
# runner, so none was started where it runs, and nothing elsewhere), idle (nothing to start),
# gated (the usage gate held the chosen Claude jobs back: `Runner.gate_until` says when to look
# again).
STARTED, BUSY, IDLE, GATED = 'started', 'busy', 'idle', 'gated'
STOPPED = 'stopped'   # Stefan stopped the lane (`control.py`), or control.json is unreadable
RESTART = 'restart'   # run_forever's end when the runner's own code moved (`restart.py`)

WALL_STEP = 30      # a long sleep looks at the wall clock this often (seconds)
T3_RETRY = 30       # waiting for T3's server at logon: how often to look again (seconds)


def wall_sleep(seconds: float, sleep=time.sleep, clock=time.time, step: float = WALL_STEP) -> None:
    """Sleeps until `seconds` of wall-clock time have passed, in steps of at most `step`, so a
    PC that slept and was woken for this time doesn't sleep on (Windows' timers may not count
    the time the PC was asleep)."""
    end = clock() + seconds
    while (left := end - clock()) > 0:
        sleep(min(step, left))


def job_title(repo: Repo, issue: int) -> str:
    return f'Queue runner build: {repo.name}#{issue}'


def _exit_code(thread: Thread) -> int:
    """What `--wait` would have exited with, for a thread whose run has ended."""
    if thread.status == 'waiting' or thread.pending_requests:
        return 2
    return 0 if thread.status == 'completed' else 1


def _when(stamp: str) -> datetime.datetime:
    return when(stamp)


def _quote(text: str) -> str:
    """A message as a Markdown quote, clipped as a decision's are."""
    from .decisions import _clip
    return '\n'.join('> ' + line if line else '>' for line in _clip(text, 1500).splitlines())


@dataclass(frozen=True)
class Start:
    """A repo's Claude job, chosen and not yet started: `kind` the gate's (None for a decision
    Stefan's own words answer, which starts no thread), `then` the kind of job a decision may
    continue in the same pass, `run` what runs it, `label` what the log calls it, and `usage`
    the gate's read when it let the job in (what its cost is measured against)."""
    repo: str
    kind: str | None
    then: str | None
    run: object
    label: str
    usage: object = None


@dataclass(eq=False)
class Worker:
    """A repo's Claude job running in its own thread (#50): `did` what its run returned, and
    `shared` the other Claude jobs that ran beside it (so its usage teaches nothing)."""
    start: Start
    thread: threading.Thread | None = None
    did: str | None = None
    shared: set = field(default_factory=set)


class Runner:
    def __init__(self, config: Config, *, github, t3, git, out, log_line, sol=None,
                 toaster=None, gate=None, limits=None, now=None, waker=None, self_update=None,
                 deps=None, effort=None):
        self.config, self.github, self.t3, self.git = config, github, t3, git
        # restart.SelfUpdate: the runner's own checkout, restarted on when its base moves
        # (continuous mode, and only when the runner serves its own repo)
        self.self_update = self_update
        self.restart_sha: str | None = None
        # wake.Waker: the Windows wake tasks for the times the lanes wait for (continuous mode)
        self.waker = waker or NoWaker()
        self._wake_lock = threading.Lock()
        self._claude_waits: datetime.datetime | None = None   # gate_until as the last pass left it
        # limits.T3Store, where T3 keeps a usage-limit stop's reset; None reads only what the
        # thread said (tests, the live checks).
        self.limits = limits
        # effort.Effort (ticket 39): how a job's thread is started, and the effort its run used
        # read back into its end record; with no T3 files (tests), --model as before.
        from .effort import Effort
        self.effort = effort or Effort(config)
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self.gate = gate   # gate.Gate; None starts every Claude job (tests, the live checks)
        self.gate_until: datetime.datetime | None = None
        # What the gate last said, per repo (None: the account's usage limit), so it's said once.
        self._last_gate: dict[str | None, str] = {}
        # The Claude jobs running in this runner's workers, one per repo (#50), and an event set
        # whenever one ends, so the lane plans again; the jobs a dead runner left running
        # (`settle`); and in the run loop, when each repo whose job started no thread may be
        # tried again.
        self._workers: dict[str, Worker] = {}
        self._workers_lock = threading.Lock()
        self._ended = threading.Event()
        self._busy: dict[str, tuple[str, str]] = {}
        # The jobs the gate let in this pass and not yet in a worker, and the Sol lane's Opus
        # review while it runs (label: the Claude jobs it ran beside), so each lane's gate counts
        # the other's Claude jobs (PR #74's review 1, F1). `_gate_lock` keeps one lane's check
        # and its admission together, so neither lets a job in unseen by the other.
        self._admitted: list[tuple[str, str, str | None]] = []
        self._reviews: dict[str, set] = {}
        self._gate_lock = threading.Lock()
        self._rests = False
        self._rest: dict[str, datetime.datetime] = {}
        # Each repo's wait as the last pass left it (a snapshot.Wait), for the Repositories card.
        self.repo_waits: dict[str, Wait] = {}
        self.out, self.log_line = out, log_line
        self.jobs = JobLog(os.path.join(config.state_dir, 'jobs.jsonl'))
        self.repos = {r.name: r for r in config.repos}
        self._say_lock = threading.Lock()
        if self.effort.say is None:
            self.effort.say = self.say
        self.toaster = toaster or NoToaster()
        # While Sol is out of usage, the Sol lane's reviews run as Opus threads in T3, through
        # the same usage gate as the Claude lane's jobs (issue #69).
        from .fallback import OpusFallback
        self.reviewer = Reviewer(config, github=github, git=git, sol=sol, jobs=self.jobs,
                                 say=self.say, toaster=self.toaster, deps=deps,
                                 fallback=OpusFallback(config, t3=t3, gate=gate,
                                                       effort=self.effort, say=self.say,
                                                       beside=self),
                                 t3=t3) if sol is not None else None
        self.fixer = Fixer(config, github=github, git=git, jobs=self.jobs)
        stopper = Stopper(config, github=github, jobs=self.jobs, say=self.say,
                          toaster=self.toaster)
        self.decider = Decider(config, github=github, t3=t3, jobs=self.jobs, say=self.say,
                               stopper=stopper, effort=self.effort)
        from .ask_threads import AskThreads   # an ask decided in a T3 thread (ticket 35)
        self.asking = AskThreads(config, github=github, t3=t3, jobs=self.jobs, say=self.say,
                                 decider=self.decider)
        self.live = LiveSteps(config, github=github, git=git, t3=t3, jobs=self.jobs,
                              say=self.say, stopper=stopper,
                              merger=Merger(config, github=github, git=git, jobs=self.jobs,
                                            say=self.say),
                              limit=self._limit, find_thread=self._find_thread, now=self.now,
                              effort=self.effort)
        self._last_why: dict[tuple[str, int], str | None] = {}
        # For the dashboard's snapshot (`snapshot.py`, continuous mode): the Claude lane's wait as
        # its last pass left it (a snapshot.Wait, or None), the titles of the issues and PRs the
        # passes started jobs on, and the publisher the loop writes it with (None: no snapshot).
        self.claude_wait = None
        self.titles: dict[tuple[str, int], str] = (
            self.reviewer.titles if self.reviewer is not None else {})
        self.publisher = None
        # The Inbox (ticket 31): what waits on Stefan, read by the Sol lane after each pass while
        # a snapshot is published, and kept for it (`inbox.Reader`).
        from .inbox import Reader
        self.inbox = Reader(config, github, self.jobs, clock=self.now)
        # The work (ticket 32): the queues, issues, features and PRs, read with the Inbox.
        from .work import Reader as WorkReader
        self.work = WorkReader(config, github, git, self.jobs, clock=self.now)
        # What each lane last said about its switch (`control.py`), so it's said once; a lock, as
        # the Claude lane's workers ask it too.
        self._said_switch: dict[str, str | None] = {}
        self._switch_lock = threading.Lock()
        # The repos Stefan stopped (ticket 37): a lock, as both lanes take them up.
        self._order_lock = threading.Lock()
        self._said_unknown: str | None = None   # control.json stops a repo not served (37)

    def say(self, line: str) -> None:
        with self._say_lock:   # both lanes say things
            self.log_line(line)
            print(line, file=self.out)

    # --- one pass -------------------------------------------------------------------------

    def run_pass(self) -> str:
        """One pass of the Claude lane, waiting for the jobs it started (`--once`, the tests):
        STARTED if any of them ran a thread, IDLE if none did, or what `plan` said when it
        started none."""
        did, workers = self.dispatch()
        for w in workers:
            w.thread.join()
        if workers:
            return STARTED if any(w.did == STARTED for w in workers) else IDLE
        return did

    def dispatch(self):
        """Plans, then starts each job `plan` let in, each in a worker of its own (#50): (what
        the pass did, the workers it started). It returns once they've started."""
        starts = self.plan()
        if not isinstance(starts, list):
            return starts, []
        return STARTED, [self._launch(s) for s in starts]

    def plan(self):
        """Settles, then chooses each working repo's Claude job (a repo with one running gets
        none: one Claude job per repo, #50) and asks the gate whether each fits beside the jobs
        still running: the Starts it lets in, in the order they're let in, or BUSY, IDLE, GATED
        or STOPPED when none. Starts nothing itself."""
        self.gate_until = None   # a wait from an earlier pass is that pass's
        busy = self.settle()
        self.take_stops()
        if self.held('claude'):
            self.repo_waits, self.claude_wait = {}, None
            return STOPPED
        self.asking.read_answers()   # an ask thread's answer, before anything is chosen (35)
        taken = set(busy) | set(self._alive())
        chosen = self.choose(skip=taken)
        if not isinstance(chosen, list):
            self.repo_waits = {}
            self.claude_wait = (Wait(self.gate_until, self._last_gate.get(None) or '')
                                if chosen == GATED else None)
            return BUSY if chosen == IDLE and busy else chosen
        starts = self._admit(chosen, busy)
        if starts:
            return starts
        return GATED if self.repo_waits else BUSY if busy else IDLE

    def choose(self, skip=frozenset()):
        """Each working repo's Claude job, but those in `skip` (one is running there): a list
        of Starts, the repo whose work has waited longest first (`_waited`), or IDLE when none
        has one, or GATED while a job a usage limit cut off may not resume yet (the limit is the
        whole account's: nothing starts in any repo). In each repo: a job a limit cut off, an
        ask thread Stefan asked for, a decision (none needs a thread when Stefan's own words
        answer it: `kind` None), the repo's live steps, a fix round, a build, in that order."""
        off = stopped(self.config)   # a stopped repo's limited job waits for its Resume (37)
        limited = [j for j in self.jobs.limited_jobs() if j.repo not in off]
        ahead = [j for j in limited if j.resume_at and self.now() < _when(j.resume_at)]
        if ahead:
            old = max(ahead, key=lambda j: _when(j.resume_at))
            at = _when(old.resume_at)
            self.gate_until = at
            text = (f'{self._name(old)} was cut off by a usage limit; it resumes after '
                    f'{at.astimezone():%Y-%m-%d %H:%M}')
            if text != self._last_gate.get(None):
                self.say(f'Claude lane waits: {text}')
            self._last_gate = {None: text}
            return GATED
        self._last_gate.pop(None, None)
        switch = control.read(self.config.state_dir)
        found, live_waits = [], []
        for repo in working(self.config):
            if repo.name in skip or self._resting(repo.name):
                continue
            start = self._choose_in(repo, limited, switch)
            live_waits.append(self.live.wait_until)
            if start is not None:
                found.append(start)
        if not found:
            if not skip:
                self.say('Nothing to start: no PR needs a fix round, and no repo has an '
                         'unblocked ready-for-agent issue that isn\'t already being built or '
                         'held.')
            # a live run's limit: the wake task for it
            self.gate_until = min(filter(None, live_waits), default=None)
            return IDLE
        order = [r.name for r in self.config.repos]
        return sorted(found, key=lambda s: (self._waited(s.repo), order.index(s.repo)))

    def _choose_in(self, repo: Repo, limited, switch):
        """This repo's Claude job now, as a Start, or None."""
        name, only = repo.name, (repo.name,)
        self.live.wait_until = None
        if mine := [j for j in limited if j.repo == name]:
            old = mine[0]
            return Start(name, old.kind, None, lambda: self.recover(old), self._name(old))
        if ask := self.asking.next(switch, only=only):   # Stefan's click (35)
            return Start(name, 'decision', None, lambda: self.asking.open(*ask),
                         f'ask {name}#{ask[2].number}')
        if case := self.decider.next_case(repos=only):
            label = f'decision {name}#{case.number}'
            if self.decider.direct_answer(case):
                return Start(name, None, None, lambda: self.decider.run(case, self.continue_job),
                             label)
            then = case.about.kind if {'retry', 'answer'} & set(case.allowed) else None
            return Start(name, 'decision', then,
                         lambda: self.decider.run(case, self.continue_job), label)
        if live := self.live.next(repos=only):
            return Start(name, 'live', None, lambda: self.live.run(*live), f'live {name}')
        if fix := self.next_fix(repos=only):
            return Start(name, 'fix', None, lambda: self.run_fix(*fix),
                         f'fix {name}#{fix[1].number}')
        if not repo.github or repo.local_issues:
            # No GitHub issues to pick from: a local-ticket repo (`tickets.py`) is only named by
            # --dry-run.
            return None
        job = pick(repo, self.github, held=self.jobs.held_issues(name))
        if job is not None:
            return Start(name, 'build', None, lambda: self.run_build(job),
                         f'build {name}#{job.issue.number}')
        return None

    def _waited(self, repo: str) -> float:
        """Since when the repo's work has waited for a Claude job: when its last one ended
        (one that never reached a thread aside), as a timestamp, or 0 (the longest) if it has
        had none. When
        the gate has room for one more job, the repo that has waited longest gets it, so
        neither starves (#50); config.toml's order breaks a tie."""
        ended = [j.ended_at for j in self.jobs.jobs() if j.repo == repo
                 and j.kind in CLAUDE_KINDS and j.ended_at
                 and j.outcome not in (NOT_STARTED, NOT_SENT)]
        return max((_when(t).timestamp() for t in ended), default=0.0)

    def _admit(self, chosen, busy) -> list:
        """The usage gate before each chosen job, in order (`gate.py`): a job starts only when
        its expected cost fits after the cost of every Claude job still running and every one
        let in before it this pass (#50). One that waits is said once per repo (until that
        changes) and doesn't hold back a later repo's job that fits. The Sol lane's Opus review
        counts among the jobs running, and holds off while this lane admits (`_gate_lock`)."""
        with self._gate_lock:
            with self._workers_lock:
                self._admitted = []   # an earlier pass's are in their workers by now
            return self._admit_locked(chosen, busy)

    def _admit_locked(self, chosen, busy) -> list:
        running = self._running(busy)
        starts, waits = [], {}
        for start in chosen:
            if start.kind is None or self.gate is None:
                starts.append(start)
                continue
            verdict = self.gate.check(start.kind, start.then, running=running)
            if not verdict.go:
                waits[start.repo] = Wait(verdict.until, verdict.text)
                if verdict.until and (self.gate_until is None or verdict.until < self.gate_until):
                    self.gate_until = verdict.until
                if verdict.text != self._last_gate.get(start.repo):
                    self.say(f'Claude lane waits on {start.repo}: {verdict.text}')
                self._last_gate[start.repo] = verdict.text
                continue
            self._last_gate.pop(start.repo, None)
            self.say(f'Usage gate, {start.repo}: {verdict.text}')
            running = running + [(start.label, start.kind, start.then)]
            with self._workers_lock:
                self._admitted.append((start.label, start.kind, start.then))
            starts.append(replace(start, usage=verdict.usage))
        self.repo_waits = waits
        first = next(iter(waits.values()), None)
        self.claude_wait = first if not starts else None
        return starts

    def _running(self, busy) -> list:
        """The Claude jobs still running, as the gate counts them: (label, kind, then) each,
        this runner's workers (and those let in and not yet started), the jobs a dead runner
        left running (`settle`), and the Sol lane's Opus review: the one it let in, or one open
        in the job log (a dead runner's, before the Sol lane settles it)."""
        jobs = self._claude_jobs(busy)
        with self._workers_lock:
            reviews = list(self._reviews)
        reviews += [label for label in self._open_reviews() if label not in reviews]
        return jobs + [(label, FALLBACK_REVIEW, None) for label in reviews]

    def _claude_jobs(self, busy) -> list:
        """The Claude lane's own jobs running, as (label, kind, then) each: its workers, those
        let in and not yet in one, and a dead runner's (`busy`)."""
        with self._workers_lock:
            mine = [(w.start.label, w.start.kind, w.start.then)
                    for w in self._workers.values() if w.start.kind]
            mine += [a for a in self._admitted if a[0] not in {m[0] for m in mine}]
        return mine + [(label, kind, None) for label, kind in busy.values()
                       if kind in CLAUDE_KINDS]

    def _open_reviews(self) -> list[str]:
        """The Opus reviews open in the job log, by label (`review <repo>#<PR>`)."""
        from .fallback import REVIEWERS, gate_label
        return [gate_label(j.repo, j.issue) for j in self.jobs.open_jobs()
                if j.kind == 'review' and j.reviewer in REVIEWERS]

    # --- the Sol lane's Opus review, beside this lane's jobs (`fallback.OpusFallback`) ------

    @property
    def gate_lock(self) -> threading.Lock:
        return self._gate_lock

    def claude_jobs(self) -> list:
        """What an Opus review's gate counts: the Claude lane's jobs running now."""
        return self._claude_jobs(self._busy)

    def review_began(self, label: str) -> None:
        """The Sol lane let an Opus review in: from now each lane's jobs count the other's
        spending (`shared_with`)."""
        with self._workers_lock:
            shared = {w.start.label for w in self._workers.values()}
            shared.update(label for label, _ in self._busy.values())
            for w in self._workers.values():
                w.shared.add(label)
            self._reviews[label] = shared

    def review_shared(self, label: str) -> list[str]:
        """The Claude jobs that ran beside the Opus review `label` so far, sorted."""
        with self._workers_lock:
            return sorted(self._reviews.get(label, ()))

    def review_ended(self, label: str) -> None:
        with self._workers_lock:
            self._reviews.pop(label, None)

    # --- workers: one Claude job per repo at once (#50) -------------------------------------

    def _alive(self) -> list[str]:
        """The repos whose Claude job is running in one of this runner's workers."""
        with self._workers_lock:
            return list(self._workers)

    def _resting(self, repo: str) -> bool:
        """In the run loop, a repo whose last job started no thread rests `poll_seconds` before
        it's tried again (as the one lane paused after such a pass), while the others go on."""
        until = self._rest.get(repo)
        return until is not None and self.now() < until

    def _launch(self, start: 'Start') -> 'Worker':
        w = Worker(start)
        w.shared.update(self._open_reviews())   # an Opus review open in the job log
        with self._workers_lock:
            for other in self._workers.values():   # each counts the other's spending
                other.shared.add(start.label)
                w.shared.add(other.start.label)
            w.shared.update(label for label, _ in self._busy.values())
            for label, shared in self._reviews.items():   # and the Sol lane's Opus review's
                shared.add(start.label)
                w.shared.add(label)
            self._admitted = [a for a in self._admitted if a[0] != start.label]
            self._workers[start.repo] = w
        w.thread = threading.Thread(target=self._work, args=(w,), daemon=True,
                                    name=f'claude-{start.repo}')
        w.thread.start()
        return w

    def _work(self, w: 'Worker') -> None:
        """A worker's thread: runs its job, records what it cost (a pass that ran beside another
        Claude job teaches nothing: `shared_with`), and says it ended."""
        start = w.start
        since = len(self.jobs.jobs())
        try:
            w.did = start.run()
        except Exception:
            self.log_line(f'{start.label}: the job failed:\n' + traceback.format_exc())
            w.did = IDLE
        try:
            new = [j for j in self.jobs.jobs()[since:]
                   if j.kind in CLAUDE_KINDS and j.repo == start.repo]
            if self.gate is not None and start.usage is not None and w.did == STARTED and new:
                # A thread ran: what it cost teaches the next estimate (an ask's thread runs on
                # with Stefan, so it teaches nothing: ticket 35). A decision that continued a
                # build or fix counts as that job's cost, so a plain decision's stays a
                # decision's.
                learned = next((j.kind for j in new if j.kind != 'decision'), start.kind)
                with self._workers_lock:
                    shared = sorted(w.shared)
                self.gate.measured(learned, [j.id for j in new], start.usage,
                                   shared_with=shared or None)
        except Exception:
            self.log_line(f'{start.label}: recording its usage failed:\n'
                          + traceback.format_exc())
        finally:
            with self._workers_lock:
                if self._workers.get(start.repo) is w:
                    del self._workers[start.repo]
            if self._rests and w.did != STARTED:
                self._rest[start.repo] = self.now() + datetime.timedelta(
                    seconds=self.config.poll_seconds)
            self._ended.set()

    # --- the switch ----------------------------------------------------------------------

    def held(self, lane: str) -> bool:
        """Whether Stefan stopped `lane` (control.json, read now), or control.json is unreadable:
        then the lane starts nothing. Said once, and again when it changes."""
        switch = control.read(self.config.state_dir)
        if switch.error is not None:
            text = control.unreadable_text(switch)
        elif switch.stop(lane).stopped:
            text = control.stopped_text(lane)
        else:
            text = None
        with self._switch_lock:
            said = self._said_switch.get(lane)
            if text is not None and text != said:
                self.say(text)
            elif text is None and said is not None:
                self.say(f'The {control.NAMES[lane]} lane runs again: Stefan resumed it')
            self._said_switch[lane] = text
        return text is not None

    def take_stops(self) -> None:
        """The repos Stefan stopped (ticket 37), read now from control.json: from then on every
        part that chooses work goes through `working`, which leaves them out. Each lane calls it
        at the start of its pass, so a job already running goes on. Each change is said once,
        and a name that isn't served once. (control.json's old `repo_order` isn't read: #50.)"""
        switch = control.read(self.config.state_dir)
        if switch.error is not None:   # nothing starts until it's fixed: `held` says so
            return
        with self._order_lock:   # both lanes take them up
            self._take_repo_stops(switch)

    def _take_repo_stops(self, switch) -> None:
        names, unknown = control.stopped_repos(self.config.repos, switch)
        was = stopped(self.config)
        for name in names:
            if name not in was:
                self.say(control.repo_stopped_text(name))
        for name in sorted(was - set(names)):
            self.say(control.repo_resumed_text(name))
        set_stopped(self.config, names)
        text = control.unknown_repos_text(unknown) if unknown else None
        if text is not None and text != self._said_unknown:
            self.say(text)
        self._said_unknown = text

    def idle_seconds(self) -> float:
        """The pause after a pass that started nothing, or while jobs run: `poll_seconds`, or
        less when the gate opens sooner (pause, resume and the reserve are read again each
        pass)."""
        poll = self.config.poll_seconds
        if self.gate_until is None:
            return poll
        left = (self.gate_until - self.now()).total_seconds()
        return min(poll, left) if left >= 1 else poll

    def next_fix(self, repos=None):
        """(repo, PR, its blocking review job) for the first PR that needs a fix round now (in
        `repos`' names, if given: #50); the review is None for a conflict round."""
        for repo in working(self.config):
            if not repo.github or repos is not None and repo.name not in repos:
                continue
            try:
                found = list(self.fixer.candidates(repo))
            except Exception as e:   # GitHub down on PRs: a build may still be picked
                self.say(f'fix rounds on {repo.name}: reading PRs failed ({type(e).__name__}: '
                         f'{e})')
                continue
            for pr, review, why in found:
                key = (repo.name, pr.number)
                if why and self._last_why.get(key) != why:
                    self.say(f'fix {repo.name}#{pr.number}: not now, {why}')
                self._last_why[key] = why
                if why is None:
                    return repo, pr, review
        return None

    def settle(self) -> dict:
        """Records how jobs left open by a dead runner, or left waiting for an answer, ended.
        The repos where one of their threads is still running: {repo: (label, kind)}, each of
        which gets no other Claude job (one per repo, #50) and whose cost the gate counts. A
        repo with a job running in one of this runner's own workers is left alone: that job is
        its worker's to record."""
        busy: dict[str, tuple[str, str]] = {}
        mine = set(self._alive())
        for job in self.jobs.open_jobs():
            if job.repo in mine:
                continue
            if job.kind == 'decision':   # cut off with its runner: decided again
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                                error='The runner stopped mid-decision.')
                self.say(f'{self._name(job)}: cut off with its runner; decided again')
                continue
            if job.kind == 'live':
                if self.live.settle(job):
                    busy[job.repo] = (self._name(job), job.kind)
                continue
            if job.kind not in ('build', 'fix'):
                continue   # an open review or merge is the Sol lane's to settle
            thread = self._find_thread(job)
            if thread is None:
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                                error='No T3 thread was found for this job.')
                self.say(f'{self._name(job)}: no thread was started; closed as not-started')
                self._uncontinue(job)
            elif thread.active and not thread.pending_requests:
                self.say(f'{self._name(job)} is still running in {thread.link}: '
                         f'no other Claude job starts in {job.repo}')
                busy[job.repo] = (self._name(job), job.kind)
            else:
                self.finish(job, thread.thread_id, _exit_code(thread), thread.status, None,
                            thread.latest_run_id)
        for job in self.jobs.waiting_jobs():
            if job.repo in mine:
                continue
            try:
                thread, _ = self.t3.show(job.thread_id)
            except T3Error as e:
                # Stefan may have answered it and set it running: start nothing until T3 says.
                self.say(f'{self._name(job)}: cannot read {job.thread_id} ({e}); '
                         f'no other Claude job starts in {job.repo}')
                busy[job.repo] = (self._name(job), job.kind)
                continue
            if thread.active and not thread.pending_requests:
                busy[job.repo] = (self._name(job), job.kind)   # answered, and running again
            elif _exit_code(thread) != 2:
                self.finish(job, thread.thread_id, _exit_code(thread), thread.status, None,
                            thread.latest_run_id)
        self._busy = busy
        return busy

    def find_thread(self, job: Job) -> Thread | None:
        """The T3 thread of a job, by its id or else its title (the snapshot's link)."""
        return self._find_thread(job)

    def _find_thread(self, job: Job) -> Thread | None:
        if job.thread_id:
            return self.t3.show(job.thread_id)[0]
        since = _when(job.started_at) - datetime.timedelta(seconds=5)
        repo = self.repos.get(job.repo)
        if repo is None:
            return None
        found = [t for t in self.t3.list(repo.path)
                 if t.title == job.title and _when(t.created_at) >= since]
        if not found:
            return None
        newest = max(found, key=lambda t: _when(t.created_at))
        return self.t3.show(newest.thread_id)[0]

    # --- a build job ----------------------------------------------------------------------

    def run_build(self, build: BuildJob) -> str:
        """STARTED once a thread ran (or may still be running); IDLE if none was started, so
        the loop pauses before trying again."""
        repo, n = build.repo, build.issue.number
        self.titles[(repo.name, n)] = build.issue.title
        self.git.fetch(repo.path, repo.base)
        job = self.jobs.started(kind='build', repo=repo.name, issue=n, branch=build.branch,
                                title=job_title(repo, n))
        if self.git.has_branch(repo.path, build.branch):
            self.jobs.ended(job.id, exit_code=None, outcome='branch-exists',
                            error=f'A local branch {build.branch} is left from an earlier run.')
            self.say(f'{self._name(job)} not started: local branch {build.branch} already exists '
                     f'(held until released)')
            return IDLE
        brief = build_brief(build, self.github.issue_comments(repo, n))
        where = f' ({repo.github}#{n})' if repo.github else ''
        self.say(f'Starting {self._name(job)}{where} on {build.branch} from {build.base}')
        return self._start(job, repo, brief, build.base, build.branch)

    def _start(self, job: Job, repo: Repo, brief: str, base: str, branch: str) -> str:
        """Runs the job's thread in a new T3 worktree on `branch` from `base`, and records how
        it ended."""
        try:
            result = self.t3.start(repo.path, brief, title=job.title, worktree=base,
                                   branch=branch, **self.effort.flags(repo))
        except T3Error as e:
            try:
                thread = self._find_thread(job)
            except T3Error:
                thread = job   # T3 can't say: leave the job open for the next pass to settle
            if thread is None:
                self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED, error=str(e))
                self.say(f'{self._name(job)} not started: {e}')
                return IDLE
            self.say(f'{self._name(job)}: lost track of its thread ({e}); '
                     'the next pass settles it')
            return STARTED
        self.finish(job, result.thread_id, result.exit_code, result.status, result.error,
                    result.run_id)
        return STARTED

    # --- a decision's retry or answer ------------------------------------------------------

    def continue_job(self, old: Job, message: str, *, limit: bool = False) -> str:
        """Picks up an earlier build or fix job (a decision's retry, the answer to its question,
        or with `limit` a job cut off by a usage limit) as a new job of its kind: in place, by
        sending `message` to its thread, or in a fresh thread, as `limits.resume_choice` decides
        from how long ago its last request started and its context. In place, the new job
        carries the thread in its start record so a dead runner's settle finds it. The earlier
        job, if it was waiting, ends `continued`. A Stop asked of the Claude lane since the pass
        began (during a decision's thread, ticket 30) starts nothing: IDLE, and the earlier job
        stays as it is, so the case is taken up again after Resume."""
        if self.held('claude'):
            return IDLE
        choice = self._resume_choice(old)
        if not choice.in_place:
            return self._restart(old, choice, None if limit else message)
        job = self.jobs.started(kind=old.kind, repo=old.repo, issue=old.issue, branch=old.branch,
                                title=old.title, sha=old.sha, round=old.round,
                                thread_id=old.thread_id, about=old.id, cause=old.cause,
                                resume=choice.record())
        if old.outcome == 'waiting':
            self.jobs.ended(old.id, exit_code=old.exit_code, outcome='continued')
        self.say(f'Continuing {self._name(job)} in place: {choice.why}; '
                 f'{old.link or old.thread_id}')
        try:
            result = self.t3.send(old.thread_id, message)
        except T3Error as e:
            try:
                running = self.t3.show(old.thread_id)[0].active
            except T3Error:
                running = True   # T3 can't say: leave the job open for the next pass to settle
            if running:
                self.say(f'{self._name(job)}: lost track of its thread ({e}); '
                         'the next pass settles it')
                return STARTED
            # The message never reached a run: as it was, and the case is decided again.
            # (`not-sent`, not `not-started`: the issue stays held.)
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_SENT, error=str(e))
            self._uncontinue(job)
            self.say(f'{self._name(job)} not continued: {e}')
            return IDLE
        self.finish(job, result.thread_id, result.exit_code, result.status, result.error,
                    result.run_id)
        return STARTED

    def _resume_choice(self, old: Job) -> lim.ResumeChoice:
        """In place or fresh for the earlier job's thread, now. Its last call is read from T3's
        database and the transcript; a limit stop's recorded context stands in for a size that
        can't be read, and its recorded request start for one that can't."""
        call = (self.limits.last_call(old.thread_id) if self.limits and old.thread_id else
                lim.LastCall(None, None))
        tokens = call.tokens if call.tokens is not None else old.context
        started = call.started or (_when(old.last_request) if old.last_request else None)
        return lim.resume_choice(started, tokens, self.now())

    # --- a fix round ----------------------------------------------------------------------

    def run_fix(self, repo: Repo, pr, review: Job | None) -> str:
        """A fresh Claude thread in a new T3 worktree at the PR's head H, on a local branch from
        which it pushes to the PR's. With no review, a conflict round: it merges the base in.
        IDLE if none was started."""
        n, h = pr.number, pr.head_sha
        self.titles[(repo.name, n)] = pr.title
        try:
            _, fetched = self.git.fetch_pr(repo.path, n, pr.base)
        except Exception as e:
            self.say(f'fix {repo.name}#{n}: fetching the PR failed ({e}); next pass')
            return IDLE
        if fetched != h:
            self.say(f'fix {repo.name}#{n}: the head moved from {h[:7]} to {fetched[:7]}; '
                     'Sol reviews it first')
            return IDLE
        work = fix_branch(n, h)
        cause = CONFLICT if review is None else None
        job = self.jobs.started(kind='fix', repo=repo.name, issue=n, branch=pr.branch,
                                title=fix_title(repo, n, cause), sha=h,
                                round=review and review.round, cause=cause)
        if self.git.has_branch(repo.path, work):
            self.jobs.ended(job.id, exit_code=None, outcome='branch-exists',
                            error=f'A local branch {work} is left from an earlier run.')
            self.say(f'{self._name(job)} not started: local branch {work} already exists '
                     '(held until released)')
            return IDLE
        try:
            brief = self.fixer.brief(repo, pr, review)
        except Exception as e:
            self.jobs.ended(job.id, exit_code=None, outcome=NOT_STARTED,
                            error=f'building the brief failed: {type(e).__name__}: {e}')
            self.say(f'{self._name(job)} not started: building the brief failed ({e})')
            return IDLE
        why = (f'to resolve its conflict with {pr.base}' if review is None else
               f'after review {review.round}')
        self.say(f'Starting {self._name(job)} ({repo.github}#{n}) {why}, '
                 f'from {h[:7]} on {work}, pushing to {pr.branch}')
        return self._start(job, repo, brief, h, work)

    def finish_fix(self, job: Job, thread_id: str, exit_code: int, status: str,
                   error: str | None, run_id: str | None) -> Job:
        """Records a fix round: `pushed` if the PR's head moved, `no-push` if it ended at H
        (reviewed already, so the PR waits for Stefan), `head-unknown` if GitHub couldn't say,
        else `failed` or `waiting`."""
        repo = self.repos[job.repo]
        link = worktree = head = pr = None
        commits, said = [], []
        try:
            thread, said = self.t3.show(thread_id)
            link, worktree = thread.link, thread.worktree_path
        except T3Error as e:
            error = error or f'thread show failed: {e}'
        limit = self._limit(thread_id, run_id, exit_code, error, said)
        try:
            now = self.github.pull(repo, job.issue)
            head = now.head_sha
            pr = {'number': now.number, 'url': now.url, 'state': now.state}
            if head != job.sha:
                self.git.fetch_pr(repo.path, job.issue, now.base)
                commits = self.git.log(repo.path, job.sha, head)
        except Exception as e:   # the record matters more than its commit list
            error = error or f'reading the PR after the round failed: {type(e).__name__}: {e}'
        pushed = head is not None and head != job.sha
        outcome = ('waiting' if exit_code == 2 else USAGE_LIMIT if limit else
                   'failed' if exit_code else
                   'head-unknown' if head is None else 'pushed' if pushed else 'no-push')
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, commits=commits, pr=pr,
                        worktree=worktree, error=error, head=head, **(limit or {}),
                        **self.effort.used(job.repo, self._name(job), thread_id, run_id))
        moved = (f', head {job.sha[:7]} -> {head[:7]}, {len(commits)} commits' if pushed else
                 f', head still {job.sha[:7]}' if head else ', head unknown')
        self.say(f'{self._name(job)} ended: {outcome} (exit {exit_code}{moved}) '
                 f'{link or thread_id}')
        self._settle_ended(job, thread_id, outcome)
        return job

    def finish(self, job: Job, thread_id: str, exit_code: int, status: str, error: str | None,
               run_id: str | None) -> Job:
        if job.kind == 'fix':
            return self.finish_fix(job, thread_id, exit_code, status, error, run_id)
        repo = self.repos[job.repo]
        link = worktree = None
        said = []
        try:
            thread, said = self.t3.show(thread_id)
            link, worktree = thread.link, thread.worktree_path
        except T3Error as e:
            error = error or f'thread show failed: {e}'
        limit = self._limit(thread_id, run_id, exit_code, error, said)
        commits = []
        try:
            commits = self.git.commits(repo.path, f'origin/{repo.base}', job.branch)
        except Exception as e:   # the record matters more than its commit list
            error = error or f'reading commits failed: {e}'
        pr = None
        if repo.github:   # a job may open its PR and fail or stop after
            try:
                pr = self.github.pull_for_branch(repo, job.branch)
            except Exception as e:
                error = error or f'PR lookup failed: {e}'
        if exit_code == 0:
            outcome = 'done' if pr or not repo.github else 'done-no-pr'
        else:
            outcome = 'waiting' if exit_code == 2 else USAGE_LIMIT if limit else 'failed'
        self.jobs.ended(job.id, exit_code=exit_code, outcome=outcome, thread_id=thread_id,
                        link=link, run_id=run_id, status=status, commits=commits, pr=pr,
                        worktree=worktree, error=error, **(limit or {}),
                        **self.effort.used(job.repo, self._name(job), thread_id, run_id))
        pr_note = f', PR #{pr["number"]}' if pr else ''
        self.say(f'{self._name(job)} ended: {outcome} (exit {exit_code}, {len(commits)} commits'
                 f'{pr_note}) {link or thread_id}')
        self._settle_ended(job, thread_id, outcome)
        return job

    def _settle_ended(self, job: Job, thread_id: str, outcome: str) -> None:
        """A build, fix or conflict thread is settled once its end is recorded (ticket 70),
        unless it waits for an answer: that one is Stefan's, or a decision's, to answer in the
        thread. One the runner picks up again in place is unsettled by T3 when its message
        lands, and settled again at its own end."""
        if outcome != 'waiting':
            settle_quietly(self.t3, thread_id, self._name(job), self.say)

    def _limit(self, thread_id: str, run_id: str | None, exit_code: int, error: str | None,
               said) -> dict | None:
        """For a failed run that stopped on a usage limit: the end record's `resume_at` and
        `context` (`limits.py`), said once in the log. None for any other end."""
        if exit_code != 1:
            return None
        # Only this run's own message: an earlier run's limit message may still be the last.
        last = [m.text for m in said if m.role == 'assistant'
                and (m.run_id is None or run_id is None or m.run_id == run_id)][-1:]
        stop = lim.limit_stop(self.limits, thread_id, run_id, [error, *last])
        if stop is None:
            return None
        resume = lim.resume_at(self.now(), stop.reset_at)
        call = self.limits.last_call(thread_id) if self.limits else lim.LastCall(None, None)
        tokens = call.tokens
        known = (f'T3 says it resets at {stop.reset_at.astimezone():%Y-%m-%d %H:%M}'
                 if stop.reset_at else "T3 doesn't say when it resets: 5h05m from now")
        # As it would be chosen then; the recovery chooses again when it runs.
        then = lim.resume_choice(call.started, tokens, resume)
        self.say(f'{thread_id} stopped on a usage limit; {known}. It resumes after '
                 f'{resume.astimezone():%Y-%m-%d %H:%M} '
                 f'({"in place" if then.in_place else "a fresh thread"}: {then.why}).')
        return {'resume_at': resume.isoformat(timespec='seconds'), 'context': tokens,
                'last_request': (call.started.isoformat(timespec='seconds')
                                 if call.started else None)}

    # --- recovering a job cut off by a usage limit -----------------------------------------

    def recover(self, old: Job) -> str:
        """A build or fix cut off by a usage limit, once the limit has reset: continued in place
        or in a fresh thread, as `limits.resume_choice` decides (`continue_job`)."""
        return self.continue_job(old, lim.RESUME_MESSAGE, limit=True)

    def _restart(self, old: Job, choice: lim.ResumeChoice, direction: str | None) -> str:
        """The earlier job in a fresh thread: its own brief built afresh from its sources, after
        `direction` (a decision's text, and for an answer the question it answers) and before
        the old thread's link, where it starts, what it left uncommitted and its last 3
        messages, in a new worktree on the same branch at the old thread's newest commit. The
        old thread is left as it is: it was settled when its end was recorded, unless it waited for
        an answer (ticket 70 leaves those)."""
        try:
            _, messages = self.t3.show(old.thread_id, 3)
        except T3Error as e:
            self.say(f'{self._name(old)}: reading its thread failed ({e}); next pass')
            return IDLE
        repo = self.repos[old.repo]
        work = fix_branch(old.issue, old.sha) if old.kind == 'fix' else old.branch
        job = self.jobs.started(kind=old.kind, repo=old.repo, issue=old.issue, branch=old.branch,
                                title=old.title, sha=old.sha, round=old.round, about=old.id,
                                cause=old.cause, resume=choice.record())
        after = 'after the usage limit' if direction is None else 'for the decision'
        try:
            brief = self._brief_again(repo, old)
            tip, wip = self.git.free_branch(repo.path, work, old.worktree)
        except Exception as e:
            # Not `not-started`, which would retry every pass. The old job stays the PR's
            # writer (nothing reviews or merges what it pushed) until Stefan releases it.
            why = f'{type(e).__name__}: {e}'
            self.jobs.ended(job.id, exit_code=None, outcome=RESTART_FAILED,
                            error=f'restarting {after} failed: {why}')
            self.say(f'{self._name(job)}: restarting {after} failed ({why}); '
                     f'held until --release {old.repo}#{old.issue}')
            self.toaster.toast(f'{old.repo} #{old.issue} needs you',
                               f'Restarting its {old.kind} {after} failed: '
                               f'{why}'[:250], old.link or '', tag=f'restart-{old.id}'[-60:])
            # A decision acted, and the new job holds the issue: it isn't decided again.
            return IDLE if direction is None else STARTED
        if tip is None:   # it made no commit: from where the old thread started
            tip = old.sha if old.kind == 'fix' else f'origin/{repo.base}'
        stopped = ('was cut off by a usage limit' if direction is None else
                   'stopped to ask a question' if old.outcome == 'waiting' else
                   'ended without a PR' if old.outcome == 'done-no-pr' else 'failed')
        if direction is not None:
            asked = ([m.text for m in messages if m.role == 'assistant'][-1:]
                     if old.outcome == 'waiting' else [])
            question = (f'The earlier thread asked:\n\n{_quote(asked[0])}\n\n' if asked else '')
            brief = (f'## Direction first\n\nAn earlier thread on this job {stopped}, and the '
                     'queue runner decided how to go on. Follow this; it comes before the brief '
                     f'below.\n\n{question}{direction.strip()}\n\n' + brief)
        brief = brief.rstrip('\n') + '\n\n' + lim.restart_section(
            old, work, tip, wip, messages, stopped=stopped, why=choice.why)
        if old.outcome == 'waiting':
            self.jobs.ended(old.id, exit_code=old.exit_code, outcome='continued')
        self.say(f'Restarting {self._name(job)} fresh {after} ({choice.why}), on {work} at '
                 f'{tip[:7]}; the old thread was {old.link or old.thread_id}')
        did = self._start(job, repo, brief, tip, work)
        if did == IDLE:   # T3 started no thread: the old job was never continued
            self._uncontinue(job)
        return did

    def _uncontinue(self, job: Job) -> None:
        """A job that picked up a waiting one (`about`) never reached a thread: the waiting job
        was marked `continued` before it, so it waits again as it did, and its case is decided
        again (as for a message that never reached its thread)."""
        old = next((j for j in self.jobs.jobs() if j.id == job.about), None) if job.about else None
        if old is not None and old.outcome == 'continued':
            self.jobs.ended(old.id, exit_code=old.exit_code, outcome='waiting')

    def _brief_again(self, repo: Repo, old: Job) -> str:
        """The job's brief, built afresh from its sources as when it started."""
        if old.kind == 'build':
            self.git.fetch(repo.path, repo.base)
            issue = self.github.issue(repo.github, old.issue)
            build = BuildJob(repo=repo, issue=issue, branch=old.branch,
                             base=f'origin/{repo.base}')
            return build_brief(build, self.github.issue_comments(repo, old.issue))
        from dataclasses import replace
        pr = self.github.pull(repo, old.issue)
        self.git.fetch_pr(repo.path, old.issue, pr.base)
        if old.cause == CONFLICT:
            return self.fixer.conflict_brief(repo, replace(pr, head_sha=old.sha))
        review = next((j for j in reversed(self.jobs.on('review', repo.name, old.issue, old.sha,
                                                        released=True))
                       if j.round == old.round), None)
        if review is None:   # a review from before the cutover (`Fixer.adopted`)
            review = self.fixer.adopted(repo, old.issue, old.sha, old.round)
        if review is None:
            raise ValueError(f'no review {old.round} of {old.sha[:7]} in the job log')
        return self.fixer.brief(repo, replace(pr, head_sha=old.sha), review)

    @staticmethod
    def _name(job: Job) -> str:
        return f'{job.kind} {job.repo}#{job.issue}'

    # --- the loop ---------------------------------------------------------------------------

    def _sol_pass(self) -> str:
        try:
            if self.reviewer is None:
                return IDLE
            self.take_stops()
            if self.held('sol'):   # stopped: no stop filed, no merge, no review
                return STOPPED
            return self.reviewer.review_pass()
        except Exception:
            self.log_line('Sol pass failed:\n' + traceback.format_exc())
            return IDLE
        finally:
            self._read_inbox()

    def _read_inbox(self) -> None:
        """The Inbox and the work for the snapshot, read from GitHub here in the Sol lane (never
        for the snapshot itself), each GitHub call once for both (`work.Memo`). A repo GitHub
        can't be read keeps its last asks and lists (`inbox.Reader`, `work.Reader`)."""
        if self.publisher is None:
            return
        from .work import Memo
        github = Memo(self.github)
        for name, reader in (('the Inbox', self.inbox), ('the work', self.work)):
            try:
                reader.read(github)
            except Exception:
                self.log_line(f'reading {name} failed:\n' + traceback.format_exc())

    def wake_times(self) -> list[datetime.datetime]:
        """The times the lanes wait for now: the Claude lane's gate or limit, Sol's resume. A lane
        Stefan stopped waits for nothing (`control.py`), so it wakes no PC."""
        switch = control.read(self.config.state_dir)
        times = [] if switch.holds('claude') else [self._claude_waits]
        if not switch.holds('sol') and (resume := self.jobs.sol_resume_at()):
            times.append(_when(resume))
        return [t for t in times if t is not None and t > self.now()]

    def _wake(self) -> None:
        try:
            with self._wake_lock:   # both lanes sync after their passes
                self.waker.sync(self.wake_times())
        except Exception:
            self.log_line('wake sync failed:\n' + traceback.format_exc())

    def wait_for_t3(self, sleep) -> None:
        """At logon T3 may not be up yet: look until its server answers (`thread list` on the
        first repo's project), saying once why it waits, and again only when that changes."""
        said = None
        while True:
            try:
                self.t3.list(self.config.repos[0].path)
            except T3Error as e:
                if 'No T3 Code project matches' in str(e):   # the server answered: it's up
                    self.say(f"T3's server is up, but: {e}")
                    return
                if str(e) != said:
                    self.say(f"Waiting for T3's server: {e}")
                said = str(e)
                sleep(T3_RETRY)
                continue
            if said is not None:
                self.say("T3's server is up")
            return

    def _publish(self) -> None:
        if self.publisher is not None:
            self.publisher.publish()   # never raises: a failed write is said once

    def _sol_lane(self, stop: threading.Event) -> None:
        while not stop.is_set():
            did = self._sol_pass()
            self._wake()
            self._publish()
            if did != STARTED:
                end = time.time() + self.config.poll_seconds
                while not stop.is_set() and (left := end - time.time()) > 0:
                    stop.wait(min(WALL_STEP, left))

    def run_once(self) -> None:
        """One pass of each lane, side by side: at most one Claude job per working repo (#50)
        and one Sol review. The Claude lane chooses its jobs before the Sol lane starts, so what
        this pass's review decides waits for the next pass."""
        _, workers = self.dispatch()
        sol = threading.Thread(target=self._sol_pass, name='sol-lane')
        sol.start()
        try:
            for w in workers:
                w.thread.join()
        finally:
            sol.join()

    def _start_sol_lane(self, stop: threading.Event) -> threading.Thread:
        sol = threading.Thread(target=self._sol_lane, args=(stop,), name='sol-lane', daemon=True)
        sol.start()
        return sol

    def _update_due(self) -> bool:
        try:
            return self.self_update is not None and self.self_update.due()
        except Exception:
            self.log_line('self-update check failed:\n' + traceback.format_exc())
            return False

    def _wait_for_a_job(self) -> None:
        """While Claude jobs run in their workers: until one ends, or `idle_seconds` pass (the
        other repos' work is looked at again then), by the wall clock."""
        end = time.time() + self.idle_seconds()
        while self._alive() and not self._ended.is_set() and (left := end - time.time()) > 0:
            self._ended.wait(min(WALL_STEP, left))

    def run_forever(self, sleep) -> str:
        """The Claude lane here, starting each repo's job in a worker of its own (#50) and
        planning again whenever one ends; the Sol lane in a thread that stops when this loop
        does. After each pass of either lane the wake tasks are set to the times they wait for.
        When the runner's own checkout is behind its base (`restart.py`), the Claude lane starts
        nothing more; once the jobs running end, it lets the Sol lane finish its pass, updates
        the checkout and returns RESTART, with the new commit in `restart_sha`; if git won't
        update it, both lanes carry on."""
        stop = threading.Event()
        self._rests = True
        draining = False   # new code is due: no Claude job starts until the restart
        if self.publisher is not None:
            self.publisher.start()
        sol = self._start_sol_lane(stop)
        try:
            while True:
                self._ended.clear()
                did = IDLE
                if not draining:
                    try:
                        did, _ = self.dispatch()
                    except Exception:
                        self.log_line('pass failed:\n' + traceback.format_exc())
                    self._claude_waits = self.gate_until
                self._wake()
                self._publish()
                if not draining and self._update_due():
                    draining = True
                    if running := self._alive():
                        self.say("The runner's own code moved: it starts no Claude job, and "
                                 'restarts on the new code once the jobs running end ('
                                 + ', '.join(running) + ')')
                if draining and not self._alive():
                    self.say("The runner's own code moved: restarting on the new code once the "
                             'Sol lane ends its pass')
                    stop.set()
                    sol.join()
                    if sha := self.self_update.update():
                        self.restart_sha = sha
                        return RESTART
                    draining = False
                    stop = threading.Event()
                    sol = self._start_sol_lane(stop)
                if self._alive():
                    self._wait_for_a_job()
                elif did != STARTED and not self._ended.is_set():
                    # (a job that ended since this pass planned: plan again at once)
                    sleep(self.idle_seconds())
        finally:
            stop.set()
            sol.join(timeout=5)
            if self.publisher is not None:
                self.publisher.stop()
