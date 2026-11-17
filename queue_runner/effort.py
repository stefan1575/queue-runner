"""The effort a Claude job runs at (ticket 39; issue #119; docs/t3.md).

Every job starts through T3's MCP launch with its provider, model and effort named
(`Effort.job`: its kind's in config.toml's `[jobs]`, issue #120), whatever the T3 project's
default model is: T3's CLI can't name an effort, so the runner no longer starts threads through it or leans on a project's
default (the workaround before #119). The end record carries the effort the run used, read back
from Claude Code's transcript (each assistant record's `effort`), else T3's run record.
"""
import datetime
import glob
import json
import os
import re
import sqlite3

HOME = os.path.expanduser('~')
T3_DB = os.path.join(HOME, '.t3', 'userdata', 'statev2.sqlite')
CLAUDE_PROJECTS = os.path.join(HOME, '.claude', 'projects')


def _when(stamp) -> datetime.datetime | None:
    try:
        return datetime.datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except ValueError:
        return None


def _aware(t: datetime.datetime | None) -> datetime.datetime | None:
    return t if t is None or t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def selection_effort(selection: dict | None) -> str | None:
    for option in (selection or {}).get('options') or ():
        if isinstance(option, dict) and option.get('id') == 'effort':
            return option.get('value')
    return None


class T3Files:
    """T3's database and Claude Code's transcripts, read-only. Anything unreadable reads as
    nothing found. A path of None is never read (tests that fake the rest)."""

    def __init__(self, db: str | None = T3_DB, projects: str | None = CLAUDE_PROJECTS):
        self.db, self.projects = db, projects

    def _rows(self, sql: str, args: tuple) -> list:
        if not self.db or not os.path.exists(self.db):
            return []
        try:
            db = sqlite3.connect(f'file:{self.db}?mode=ro', uri=True, timeout=5)
            try:
                return db.execute(sql, args).fetchall()
            finally:
                db.close()
        except sqlite3.Error:
            return []

    def _run(self, run_id: str) -> dict:
        for (payload,) in self._rows('select payload_json from orchestration_v2_projection_runs '
                                     'where run_id = ?', (run_id,)):
            try:
                found = json.loads(payload)
            except ValueError:
                continue
            if isinstance(found, dict):
                return found
        return {}

    def _session(self, thread_id: str) -> str | None:
        """The Claude session behind the thread's newest provider thread (as `limits.T3Store`)."""
        for (payload,) in self._rows(
                "select payload_json from orchestration_v2_projection_provider_threads "
                "where thread_id = ? and driver = 'claudeAgent' order by last_run_ordinal desc",
                (thread_id,)):
            try:
                native = (json.loads(payload).get('nativeThreadRef') or {}).get('nativeId')
            except (ValueError, AttributeError):
                continue
            if native and re.fullmatch(r'[\w-]+', native):
                return native
        return None

    def _called_at(self, session: str, since) -> str | None:
        """The effort of the transcript's last real call at or after `since`."""
        if not self.projects:
            return None
        found = glob.glob(os.path.join(glob.escape(self.projects), '*', f'{session}.jsonl'))
        if not found:
            return None
        # A session's transcript may be in more than one project folder: the last call is the
        # one recorded last by its own time, whichever file was touched last.
        calls = [got for path in sorted(found, key=os.path.getmtime, reverse=True)
                 if (got := self._last_effort(path, since)) is not None]
        earliest = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
        # Ties (or no times) go to the file touched last, as before.
        return max(calls, key=lambda c: _aware(c[0]) or earliest)[1] if calls else None

    @staticmethod
    def _last_effort(path: str, since):
        """(when, effort) of the transcript's last real call at or after `since`, or None."""
        last = None
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                for line in f:
                    if '"effort"' not in line:
                        continue
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if (record.get('type') != 'assistant' or not record.get('effort')
                            or (record.get('message') or {}).get('model') == '<synthetic>'):
                        continue
                    at = _when(record.get('timestamp'))
                    if since is not None and (at is None or at < since):
                        continue
                    last = at, record['effort']
        except OSError:
            return None
        return last

    def run_effort(self, thread_id: str, run_id: str | None) -> str | None:
        """The effort the run used, as Claude Code recorded its calls; else what T3's run record
        asked for; None if neither says."""
        if not run_id:
            return None
        run = self._run(run_id)
        since = _when(run.get('startedAt') or run.get('requestedAt') or '')
        session = self._session(thread_id)
        return ((self._called_at(session, since) if session else None)
                or selection_effort(run.get('modelSelection')))


def flags(spec) -> dict:
    """A JobSpec as `t3.start`'s and `t3.launch`'s keywords (issue #119): provider, model, effort."""
    return {'provider': spec.provider, 'model': spec.model, 'effort': spec.effort}


def asked(job) -> dict:
    """The provider, model and effort a job was started on, from its start record (issue #120):
    what its thread is launched with."""
    return {'provider': job.provider, 'model': job.model, 'effort': job.effort}


class Effort:
    """What a repo's job starts on, and what its end record says about the effort. With no
    `files` (tests, the live checks), no effort is read back. `out(provider)` says whether a
    provider is out of usage now (`state.JobLog.out_until`), so a kind with a fallback runs on
    it meanwhile (issue #120); with none, no provider is."""

    def __init__(self, config, files=None, say=None, out=None):
        self.config, self.files, self.say = config, files, say
        self.out = out
        self._said_used: dict[str, str] = {}

    def _say(self, said: dict, repo: str, state, line: str | None) -> None:
        """Says `line` once per repo while its `state` stays the same (said again when it
        changes, and forgotten when `line` is None: all is as it should be)."""
        if line is None:
            said.pop(repo, None)
        elif repo not in said or said[repo] != state:
            said[repo] = state
            if self.say:
                self.say(line)

    def spec(self, kind: str):
        """What a `kind` job runs on now (config.toml's `[jobs]`, issue #120): its own spec, or
        its fallback while its own provider is out of usage; None while both are out (or it has
        no fallback): it waits for the reset."""
        spec = self.config.job(kind)
        if self.out is None or not self.out(spec.provider):
            return spec
        back = spec.fallback
        return back if back is not None and not self.out(back.provider) else None

    def job(self, kind: str) -> dict:
        """The provider, model and effort a `kind` job starts with (`flags`): its fallback's
        while its own provider is out, else its own (a job chosen while the lane could still
        start it)."""
        return flags(self.spec(kind) or self.config.job(kind))

    def used(self, repo_name: str, name: str, thread_id: str | None,
             run_id: str | None, want: str | None) -> dict:
        """The end record's `effort`, read back from the run, and a line said once per repo
        when it isn't `want`, the effort it was started at. Empty with no files."""
        if self.files is None or not thread_id:
            return {}
        effort = self.files.run_effort(thread_id, run_id)
        if effort == want or want is None:
            line = None
        elif effort is None:
            line = (f"{repo_name}: {name}'s effort couldn't be read back from Claude Code's "
                    'transcript or T3; it may not have run at ' + want)
        else:
            line = f'{repo_name}: {name} ran at effort {effort}, not {want} (config.toml)'
        self._say(self._said_used, repo_name, effort, line)
        return {'effort': effort}
