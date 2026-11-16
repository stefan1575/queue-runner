"""The effort a Claude job runs at (ticket 39; AGENTS.md, T3 as a script sees it).

T3's CLI has no effort flag. `t3 thread start --provider P --model M` sends T3's
`t3_thread_launch` a model selection with no options, so the run gets the model's default effort
(medium for Opus 5.5). With no `--provider`/`--model`, launch takes the project's default model
selection, options and all: the project's entry in `settings.json`'s `projectSettingsOverrides`
(T3's settings are folded on this PC), else the global `defaultModelSelection`. T3 has no
Settings screen for that entry yet (Stefan, 2026-11-16: issue #90), so it's added to the file
by hand with T3 closed (`Effort.step` says how); `t3_project_update` writes the project row,
which launch no longer reads once folded. (Read 2026-11-15 in `server.asar`:
`threadStartCommand` in `binCli-*.mjs`, `t3_thread_launch` in `server-*.mjs`,
`resolveProjectOverrides` in `ManagedEndpointRuntime-*.mjs`; checked live in the sandbox.)

So a repo's job starts with no `--model` only when its project's default is the config's
provider, model and effort and no fallback model could replace it; else with `--model` as
before. Either way the end record carries the effort the run used, read back from Claude Code's
transcript (each assistant record's `effort`), else T3's run record.
"""
import datetime
import glob
import json
import os
import re
import sqlite3
from dataclasses import dataclass

HOME = os.path.expanduser('~')
T3_SETTINGS = os.path.join(HOME, '.t3', 'userdata', 'settings.json')
T3_DB = os.path.join(HOME, '.t3', 'userdata', 'statev2.sqlite')
CLAUDE_PROJECTS = os.path.join(HOME, '.claude', 'projects')


@dataclass(frozen=True)
class ProjectDefault:
    project_id: str
    selection: dict | None   # what a thread started with no --model gets
    fallback: dict | None    # what launch may take instead while the default's provider is out


def _same_folder(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


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
    """T3's settings and database and Claude Code's transcripts, read-only. Anything unreadable
    reads as nothing found. A path of None is never read (tests that fake the rest)."""

    def __init__(self, settings: str | None = T3_SETTINGS, db: str | None = T3_DB,
                 projects: str | None = CLAUDE_PROJECTS):
        self.settings, self.db, self.projects = settings, db, projects

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

    def _settings(self) -> dict | None:
        if not self.settings:
            return None
        try:
            with open(self.settings, encoding='utf-8') as f:
                found = json.load(f)
        except (OSError, ValueError):
            return None
        return found if isinstance(found, dict) else None

    def project_default(self, folder: str) -> ProjectDefault | None:
        """The model selection a thread started in `folder`'s T3 project with no --model gets,
        as `t3_thread_launch` resolves it; None if T3 has no project there or can't be read."""
        settings = self._settings()
        if settings is None:
            return None
        rows = self._rows('select project_id, workspace_root, default_model_selection_json '
                          'from projection_projects where deleted_at is null', ())
        row = next((r for r in rows if r[1] and _same_folder(r[1], folder)), None)
        if row is None:
            return None
        pid, _, own = row
        overrides = dict((settings.get('projectSettingsOverrides') or {}).get(pid) or {})
        if not settings.get('projectSettingsFolded') and own:
            try:
                overrides.setdefault('defaultModelSelection', json.loads(own))
            except ValueError:
                pass

        selection = (overrides['defaultModelSelection'] if 'defaultModelSelection' in overrides
                     else settings.get('defaultModelSelection'))
        # The fallback isn't one of T3's project-scoped keys (`PROJECT_SCOPED_SERVER_SETTING_KEYS`
        # in server.asar, read 2026-11-16: PR #100's review 1, F1): a project's entry neither
        # sets nor clears it, so only the top-level one counts.
        return ProjectDefault(pid, selection, settings.get('fallbackModelSelection'))

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


class Effort:
    """How the runner starts a repo's Claude job and what its end record says about the effort.
    With no `files` (tests, the live checks), every job starts with --model as before and no
    effort is read back."""

    def __init__(self, config, files=None, say=None):
        self.config, self.files, self.say = config, files, say
        self._said_project: dict[str, str] = {}
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

    def _why_not(self, repo, found: ProjectDefault | None) -> str | None:
        """Why a thread started in the repo's T3 project with no --model wouldn't run at the
        config's model and effort; None if it would."""
        c = self.config
        if found is None:
            return "T3 has no project there, or its settings can't be read"
        s = found.selection
        if not s:
            return 'it has no default model'
        if (s.get('instanceId') or s.get('provider'), s.get('model')) != (c.claude_provider,
                                                                          c.claude_model):
            return f"its default model is {s.get('model')}, not {c.claude_model}"
        effort = selection_effort(s)
        if effort != c.claude_effort:
            return f"its default model's effort is {effort or 'not set'}, not {c.claude_effort}"
        if found.fallback:
            return (f"a fallback model ({found.fallback.get('model')}) is set, which T3 would "
                    'start it on instead while Claude is out of usage')
        return None

    def flags(self, repo) -> dict:
        """`t3.start`'s provider and model: none when the project's default is the config's
        model at its effort, so the thread takes it; else the config's, as before."""
        c = self.config
        explicit = {'provider': c.claude_provider, 'model': c.claude_model}
        if self.files is None:
            return explicit
        found = self.files.project_default(repo.path)
        why = self._why_not(repo, found)
        if why is None:
            self._say(self._said_project, repo.name, 'set',
                      f"{repo.name}: its T3 project's default model is {c.claude_model} at "
                      f'effort {c.claude_effort}; its Claude jobs start on it (no --model)')
            return {}
        self._say(self._said_project, repo.name, why,
                  f'{repo.name}: its Claude jobs start with --model {c.claude_model} and run at '
                  f"the model's default effort, not {c.claude_effort}: in its T3 project "
                  f'({repo.path}) {why}. {self.step(found)}')
        return explicit

    def step(self, found: ProjectDefault | None) -> str:
        """How Stefan sets the project's default by hand (issue #90): T3 has no Settings screen
        for it yet, so the entry goes in its settings.json, with T3 closed; and a fallback model,
        which T3 reads only at the file's top level, comes out there."""
        c = self.config
        where = getattr(self.files, 'settings', None) or '~/.t3/userdata/settings.json'
        pid = json.dumps(found.project_id) if found else '<its project id>'
        selection = json.dumps({'instanceId': c.claude_provider, 'model': c.claude_model,
                                'options': [{'id': 'effort', 'value': c.claude_effort}]})
        # T3 reads the fallback only at the file's top level, for every project (PR #100's
        # review 1, F1), so a set one is named there, and nothing is said of one when none is.
        fallback = found.fallback if found else None
        drop = (f", and remove the top-level fallbackModelSelection ({fallback.get('model')}): "
                "T3 has no per-project one, so that stops every project's new threads moving to "
                'it while Claude is out of usage') if fallback else ''
        return (f'To run them at {c.claude_effort}: with T3 closed (it may write over the file '
                f'while it runs), in {where}, under projectSettingsOverrides[{pid}]'
                f'.defaultModelSelection, put {selection}{drop}, then start T3 again')

    def check(self, repos) -> None:
        """At start: says for each served repo how its jobs will start."""
        for repo in repos:
            self.flags(repo)

    def used(self, repo_name: str, name: str, thread_id: str | None,
             run_id: str | None) -> dict:
        """The end record's `effort`, read back from the run, and a line said once per repo
        when it isn't the config's. Empty with no files."""
        if self.files is None or not thread_id:
            return {}
        want = self.config.claude_effort
        effort = self.files.run_effort(thread_id, run_id)
        if effort == want:
            line = None
        elif effort is None:
            line = (f"{repo_name}: {name}'s effort couldn't be read back from Claude Code's "
                    'transcript or T3; it may not have run at ' + want)
        else:
            line = f'{repo_name}: {name} ran at effort {effort}, not {want} (config.toml)'
        self._say(self._said_used, repo_name, effort, line)
        return {'effort': effort}
