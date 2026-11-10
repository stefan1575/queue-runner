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
IN_PLACE_MAX = 50_000   # tokens: a thread this small or smaller is continued, not restarted

# What Claude Code and T3 say on a limit stop, for when T3's record can't be read.
LIMIT_SAID = re.compile(r"you've hit your (?:\w+ )?limit|claude api rate limit reached", re.I)

RESUME_MESSAGE = ('The usage limit that stopped you has reset. Continue where you left off: '
                  'check `git status` and `git log` first, and commit after every step.')


def resume_at(stopped: datetime.datetime,
              reset: datetime.datetime | None) -> datetime.datetime:
    """When a job cut off by a limit may run again: 10 minutes after the reset, or after 5h05m
    from the stop if the reset is unknown."""
    return (reset or stopped + RESET_UNKNOWN) + RESUME_AFTER


def in_place(tokens: int | None) -> bool:
    """Continue the old thread (True) or start a fresh one: in place only when its context is
    known and about 50k tokens or less."""
    return tokens is not None and tokens <= IN_PLACE_MAX


def _when(stamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))


def _reset(failure: dict) -> datetime.datetime | None:
    try:
        return _when(failure['resetAt']) if failure.get('resetAt') else None
    except (TypeError, ValueError):
        return None


def context_tokens(transcript: str) -> int | None:
    """The tokens of the transcript's last real call (its whole prompt, cached or not, plus its
    reply), or None if there's none. Claude Code's own `<synthetic>` messages don't count."""
    last = None
    try:
        with open(transcript, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"usage"' not in line:
                    continue
                try:
                    msg = json.loads(line).get('message') or {}
                except ValueError:
                    continue
                usage = msg.get('usage')
                if not usage or msg.get('model') == '<synthetic>' or msg.get('role') != 'assistant':
                    continue
                last = sum(usage.get(k) or 0 for k in (
                    'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
                    'output_tokens'))
    except OSError:
        return None
    return last


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

    def context_tokens(self, thread_id: str) -> int | None:
        session = self.claude_session(thread_id)
        if not session or not re.fullmatch(r'[\w-]+', session):
            return None
        found = glob.glob(os.path.join(glob.escape(self.projects), '*', f'{session}.jsonl'))
        return context_tokens(max(found, key=os.path.getmtime)) if found else None


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


def restart_section(old, work: str, tip: str, wip: str | None, messages) -> str:
    """What a fresh thread after a limit gets below its job's own brief: the old thread's link,
    where it starts, what it left uncommitted, and its last 3 messages (each clipped, as a
    decision's are)."""
    from importlib import resources
    from string import Template
    from .decisions import _clip
    said = '\n\n'.join(f'**{m.role}**:\n\n{_clip(m.text, 1500)}' for m in messages) or 'None.'
    return Template(resources.files(__package__).joinpath('templates/restart.md')
                    .read_text(encoding='utf-8')).substitute(
        link=old.link or old.thread_id, work=work, tip7=tip[:7],
        uncommitted=(f'It left uncommitted changes; they are kept in commit `{wip[:7]}` (see '
                     f'them with `git stash show -p {wip[:7]}` and take what '
                     f'is worth keeping with `git stash apply {wip[:7]}`).' if wip else
                     'It left nothing uncommitted.'),
        messages=said)
