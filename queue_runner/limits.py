"""Limit recovery (ticket 09; `orchestration.md`, Limits): a Claude job cut off by a usage limit.

T3's CLI doesn't say when a limit resets: `thread show --json` gives the thread `failed` and
Claude Code's message ("You've hit your weekly limit · resets Nov 9, 7pm (Asia/Singapore)"), and
`--wait --json` the run's error. The reset is in T3's own database: the run's `error` turn item,
`failure.class` `usage_limit`, `failure.resetAt` (what T3's "Resume after usage limits" reads as
`usage-limit-recovery:<runId>`). So the runner reads that database read-only, and falls back to
5h05m from the stop when it can't.

A thread's context size is its Claude transcript's last real call: T3's provider thread gives the
Claude session id (`nativeThreadRef.nativeId`), and Claude Code keeps the transcript at
`~/.claude/projects/<folder>/<session id>.jsonl`.
"""
import datetime
import glob
import json
import os
import re
import sqlite3
from dataclasses import dataclass

HOME = os.path.expanduser('~')
T3_DB = os.path.join(HOME, '.t3', 'userdata', 'statev2.sqlite')
T3_SETTINGS = os.path.join(HOME, '.t3', 'userdata', 'settings.json')
CLAUDE_PROJECTS = os.path.join(HOME, '.claude', 'projects')

RESET_UNKNOWN = datetime.timedelta(hours=5, minutes=5)   # from the stop, when T3 has no reset
RESUME_AFTER = datetime.timedelta(minutes=10)            # after the reset

# --- In place or fresh (ticket 38) ---------------------------------------------------------
# The research is `.scratch/queue-runner/research/token-economics.md` and
# `subscription-economics.md` (2026-11-12, not committed; Stefan's main checkout).
#
# Warm: Claude Code's main conversation on a subscription caches for one hour, measured from the
# start of the request that last read or wrote it (token-economics.md section 1: 22 gaps under an
# hour kept the history cached, 3 over it rewrote it). 55 minutes is the research's own margin
# under that hour, not an Anthropic guarantee. Warm, continuing re-reads the cached history
# (cheap), while a fresh thread writes a new one and must reorient: in the subscription scenario a
# warm restart only pays above about 131k-636k tokens with 50 to 5 requests left
# (subscription-economics.md, Crossovers), and the runner can't count the requests left, so warm
# continues at any size (recommendation 1).
WARM_FOR = datetime.timedelta(minutes=55)
# Cold: both paths write their whole context once, so fresh wins when the old context C is above
# the cold crossover (subscription-economics.md section 4):
#     C* = F + o*E / (w + (n-1)*r)
# with F = S + D the fresh thread's context after reorienting (S the initial context, D what it
# rereads), E its extra output, (w, r, o) the weights of a 1h cache write, a read and output, and
# n the requests left. The research's central subscription scenario is w = 1.21, r = .027,
# o = 4.49, D = 25k, E = 5k. The largest C* is at n = 1: o*E/w = 4.49 * 5,000 / 1.21 = 18.6k.
#   - leads-dashboard, S = 50k (the median first request of 43 sessions, 50,333): F = 75k,
#     C* = 75k + 18.6k = 93.6k (n = 1), 90.5k (n = 10), 83.9k (n = 50).
#   - queue-runner, S = 70k (its sessions' first requests, 70.4k-74.2k): F = 95k,
#     C* = 95k + 18.6k = 113.6k (n = 1), 110.5k (n = 10).
# 120k is the larger repo's crossover rounded up, a margin toward continuing because what a fresh
# thread loses (hypotheses, files read, test results) isn't priced in the model at all.
# Where the evidence is thin: the subscription weights are a scenario, not measured Max rates; D
# and E (reorientation) were never measured, and at D = 50k, E = 15k the cold crossover is
# 127-146k; S is a first request, not a measured restart brief. So this is a policy heuristic the
# research points to (its own shorthand was "cold and above ~100k" for S = 50k), not a proven
# optimum. The context compared is `context_tokens`'s, which adds the last reply's output to the
# research's input-only C: the next request's history, a few thousand tokens more at most.
COLD_FRESH_MIN = 120_000   # tokens: a cold thread this big or bigger restarts fresh


@dataclass(frozen=True)
class ResumeChoice:
    """Whether to continue a thread in place or start fresh, and why (`resume_choice`)."""
    in_place: bool
    why: str
    last_request: datetime.datetime | None   # when its last real request started
    idle_minutes: int | None                 # from then to the choice
    context: int | None                      # its context in tokens

    @property
    def how(self) -> str:
        return 'in-place' if self.in_place else 'fresh'

    def record(self) -> dict:
        """For the new job's start record (`resume`)."""
        return {'how': self.how, 'why': self.why,
                'last_request': (self.last_request.isoformat(timespec='seconds')
                                 if self.last_request else None),
                'idle_minutes': self.idle_minutes, 'context': self.context}


def _age(minutes: int) -> str:
    if minutes < 60:
        return f'{minutes} min'
    h, m = divmod(minutes, 60)
    return f'{h} h {m} min' if m else f'{h} h'


def resume_choice(last_request: datetime.datetime | None, tokens: int | None,
                  now: datetime.datetime) -> ResumeChoice:
    """In place or fresh, for any thread the runner is about to send more work to: warm (its last
    request started under 55 minutes ago) continues at any size; cold continues below 120k
    tokens and starts fresh at or above. An unknown age is cold, an unknown size large."""
    idle = None if last_request is None else max(0, int((now - last_request).total_seconds()
                                                        // 60))
    warm = last_request is not None and now - last_request < WARM_FOR
    if warm:
        return ResumeChoice(True, f'warm (its last request started {_age(idle)} ago): '
                                  'continuing it in place is cheaper at any size',
                            last_request, idle, tokens)
    age = ('when its last request started is unknown' if idle is None else
           f'its last request started {_age(idle)} ago')
    if tokens is None:
        return ResumeChoice(False, f'cold ({age}) and its size unknown: a fresh thread',
                            last_request, idle, tokens)
    small = tokens < COLD_FRESH_MIN
    why = (f'cold ({age}) and {tokens:,} tokens, under {COLD_FRESH_MIN:,}: continuing it in '
           'place is cheaper' if small else
           f'cold ({age}) and {tokens:,} tokens, at least {COLD_FRESH_MIN:,}: a fresh thread is '
           'cheaper')
    return ResumeChoice(small, why, last_request, idle, tokens)

# What Claude Code and T3 say on a limit stop, for when T3's record can't be read.
LIMIT_SAID = re.compile(r"you've hit your (?:\w+ )?limit|claude api rate limit reached", re.I)

RESUME_MESSAGE = ('The usage limit that stopped you has reset. Continue where you left off: '
                  'check `git status` and `git log` first, and commit after every step.')


def resume_at(stopped: datetime.datetime,
              reset: datetime.datetime | None) -> datetime.datetime:
    """When a job cut off by a limit may run again: 10 minutes after the reset, or after 5h05m
    from the stop if the reset is unknown."""
    return (reset or stopped + RESET_UNKNOWN) + RESUME_AFTER


def _when(stamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def _reset(failure: dict) -> datetime.datetime | None:
    try:
        return _when(failure['resetAt']) if failure.get('resetAt') else None
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class LastCall:
    """A thread's last real call to Claude: when its request started (None: no request record
    names it) and its context in tokens (None: no call)."""
    started: datetime.datetime | None
    tokens: int | None


def last_call(transcript: str) -> LastCall:
    """The transcript's last real call: its whole prompt, cached or not, plus its reply, and when
    its request started (the `api-request` record its `requestRef` names: the cache's hour counts
    from a request's start). Claude Code's own `<synthetic>` messages, such as a limit stop's,
    don't count."""
    starts: dict[str, str] = {}
    tokens = ref = None
    try:
        with open(transcript, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"api-request"' in line:
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if rec.get('type') == 'api-request' and rec.get('id'):
                        starts[rec['id']] = rec.get('timestamp')
                    continue
                if '"usage"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                msg = rec.get('message') or {}
                usage = msg.get('usage')
                if not usage or msg.get('model') == '<synthetic>' or msg.get('role') != 'assistant':
                    continue
                tokens = sum(usage.get(k) or 0 for k in (
                    'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
                    'output_tokens'))
                ref = rec.get('requestRef')
    except OSError:
        return LastCall(None, None)
    try:
        started = _when(starts[ref]) if ref and starts.get(ref) else None
    except (TypeError, ValueError):
        started = None
    return LastCall(started, tokens)


def context_tokens(transcript: str) -> int | None:
    """The tokens of the transcript's last real call, or None if there's none."""
    return last_call(transcript).tokens


class T3Store:
    """T3's database, read-only: what its CLI doesn't show. Anything unreadable reads as
    nothing found."""

    def __init__(self, path: str = T3_DB, projects: str = CLAUDE_PROJECTS):
        self.path, self.projects = path, projects

    def _rows(self, sql: str, args: tuple) -> list:
        if not os.path.exists(self.path):
            return []
        try:
            db = sqlite3.connect(f'file:{self.path}?mode=ro', uri=True, timeout=5)
            try:
                return db.execute(sql, args).fetchall()
            finally:
                db.close()
        except sqlite3.Error:
            return []

    def run_failure(self, thread_id: str, run_id: str | None) -> dict | None:
        """The failure T3 recorded for this run (`{class, message, code, resetAt...}`), or None
        if it recorded none or can't be read. A usage limit is `class` `usage_limit`."""
        if not run_id:
            return None
        found = None
        for (payload,) in self._rows(
                "select payload_json from orchestration_v2_projection_turn_items "
                "where thread_id = ? and run_id = ? and type = 'error' order by ordinal",
                (thread_id, run_id)):
            try:
                failure = json.loads(payload).get('failure')
            except ValueError:
                continue
            if isinstance(failure, dict) and failure.get('class'):
                found = failure
                if failure['class'] == 'usage_limit':
                    return failure
        return found

    def limit_reset(self, thread_id: str, run_id: str | None):
        """(found, reset): whether T3 recorded this run stopping on a usage limit, and the reset
        it stored (None if it stored none)."""
        failure = self.run_failure(thread_id, run_id)
        if not failure or failure.get('class') != 'usage_limit':
            return False, None
        return True, _reset(failure)

    def claude_session(self, thread_id: str) -> str | None:
        """The Claude session id behind the thread's newest provider thread."""
        rows = self._rows(
            "select payload_json from orchestration_v2_projection_provider_threads "
            "where thread_id = ? and driver = 'claudeAgent' order by last_run_ordinal desc",
            (thread_id,))
        for (payload,) in rows:
            try:
                ref = json.loads(payload).get('nativeThreadRef') or {}
            except ValueError:
                continue
            if ref.get('nativeId'):
                return ref['nativeId']
        return None

    def last_call(self, thread_id: str) -> LastCall:
        """The thread's last real call (`last_call`), from the transcript of its Claude session."""
        session = self.claude_session(thread_id)
        if not session or not re.fullmatch(r'[\w-]+', session):
            return LastCall(None, None)
        found = glob.glob(os.path.join(glob.escape(self.projects), '*', f'{session}.jsonl'))
        return last_call(max(found, key=os.path.getmtime)) if found else LastCall(None, None)

    def context_tokens(self, thread_id: str) -> int | None:
        return self.last_call(thread_id).tokens


@dataclass(frozen=True)
class LimitStop:
    reset_at: datetime.datetime | None   # None: T3 stored none, or couldn't be read


def limit_stop(store, thread_id: str, run_id: str | None, said: list[str]) -> LimitStop | None:
    """Whether a failed run stopped on a usage limit. T3's record of the run's failure decides
    when there is one (another class is no limit stop); only without one does the limit message
    in what this run said (its error, its last message) count."""
    failure = store.run_failure(thread_id, run_id) if store else None
    if failure:
        return LimitStop(_reset(failure)) if failure.get('class') == 'usage_limit' else None
    if any(LIMIT_SAID.search(s or '') for s in said):
        return LimitStop(None)
    return None


def auto_resume_warning(path: str = T3_SETTINGS) -> str | None:
    """A warning if T3's "Resume after usage limits" is on: it would continue a limited thread
    in place itself, racing the runner. Off by default (T3's settings schema)."""
    try:
        with open(path, encoding='utf-8') as f:
            on = bool(json.load(f).get('autoResumeLimitedThreads'))
    except (OSError, ValueError, AttributeError):
        return None
    if not on:
        return None
    return (f'T3\'s "Resume after usage limits" is on ({path}, autoResumeLimitedThreads): it '
            'continues a thread cut off by a limit itself, racing the runner. Turn it off in '
            'T3 Settings.')


def restart_section(old, work: str, tip: str, wip: str | None, messages, *,
                    stopped: str = 'was cut off by a usage limit', why: str) -> str:
    """What a fresh thread picking up an earlier one gets below its job's own brief: how the old
    one stopped and why it isn't continued (`ResumeChoice.why`), its link, where it starts, what
    it left uncommitted, and its last 3 messages (each clipped, as a decision's are)."""
    from importlib import resources
    from string import Template
    from .decisions import _clip
    said = '\n\n'.join(f'**{m.role}**:\n\n{_clip(m.text, 1500)}' for m in messages) or 'None.'
    return Template(resources.files(__package__).joinpath('templates/restart.md')
                    .read_text(encoding='utf-8')).substitute(
        link=old.link or old.thread_id, work=work, tip7=tip[:7], stopped=stopped, why=why,
        uncommitted=(f'It left uncommitted changes; they are kept in commit `{wip[:7]}` (see '
                     f'them with `git stash show -p {wip[:7]}` and take what '
                     f'is worth keeping with `git stash apply {wip[:7]}`).' if wip else
                     'It left nothing uncommitted.'),
        messages=said)
