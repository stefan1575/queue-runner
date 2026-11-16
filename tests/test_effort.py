"""Ticket 39: the effort the runner's Claude jobs run at. `[claude] effort` in config.toml; the
T3 project default a thread started without `--model` takes (`effort.T3Files`, on a temp
settings file, SQLite and transcript folder); and the Runner's start flags, end records and log
lines through real jobs with T3 faked."""
import json
import os
import sqlite3
import tempfile
import unittest

from queue_runner.config import load_config


def write_config(folder, claude='[claude]\nprovider = "claudeAgent"\nmodel = "claude-opus-5-5"\n'):
    path = os.path.join(folder, 'config.toml')
    d = folder.replace('\\', '/')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'state_dir = "{d}/state"\nlog_dir = "{d}/logs"\n\n{claude}\n'
                f'[[repos]]\nname = "first"\ngithub = "owner/first"\npath = "{d}/first"\n')
    return path


class ConfigTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def test_effort_is_high_when_config_names_none(self):
        self.assertEqual(load_config(write_config(self.dir)).claude_effort, 'high')

    def test_effort_is_read_from_the_claude_table(self):
        config = load_config(write_config(self.dir, '[claude]\nmodel = "claude-opus-5-5"\n'
                                                    'effort = "xhigh"\n'))
        self.assertEqual(config.claude_effort, 'xhigh')

    def test_an_effort_claude_code_has_not_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'effort'):
            load_config(write_config(self.dir, '[claude]\neffort = "ultrathink"\n'))

    def test_the_served_config_runs_claude_jobs_at_medium(self):
        # Stefan, 2026-11-16 (fba6c8f): "Opus 5.5 medium as worker".
        from queue_runner.config import DEFAULT_CONFIG
        self.assertEqual(load_config(DEFAULT_CONFIG).claude_effort, 'medium')


HIGH = {'instanceId': 'claudeAgent', 'model': 'claude-opus-5-5',
        'options': [{'id': 'effort', 'value': 'high'}, {'id': 'fastMode', 'value': False}]}


class T3Folder:
    """A T3 userdata folder in a temp dir: `settings.json`, `statev2.sqlite` with the tables the
    runner reads (the columns it reads, as T3's are, 2026-11-15), and a Claude projects folder."""

    def __init__(self, folder):
        self.settings = os.path.join(folder, 'settings.json')
        self.db = os.path.join(folder, 'statev2.sqlite')
        self.projects = os.path.join(folder, 'claude-projects')
        os.makedirs(self.projects)
        db = sqlite3.connect(self.db)
        db.executescript("""
            create table projection_projects (project_id text, title text, workspace_root text,
                deleted_at text, default_model_selection_json text);
            create table orchestration_v2_projection_runs (run_id text, thread_id text,
                ordinal integer, payload_json text);
            create table orchestration_v2_projection_provider_threads (thread_id text,
                driver text, last_run_ordinal integer, payload_json text);
        """)
        db.commit()
        db.close()

    def write_settings(self, **settings):
        with open(self.settings, 'w', encoding='utf-8') as f:
            json.dump(settings, f)

    def project(self, pid, root, default=None, deleted=None):
        self._exec('insert into projection_projects values (?, ?, ?, ?, ?)',
                   (pid, os.path.basename(root), root, deleted,
                    json.dumps(default) if default else None))

    def run(self, thread_id, run_id, selection, started='2026-11-15T10:00:00.000Z', session='s1'):
        self._exec('insert into orchestration_v2_projection_runs values (?, ?, 1, ?)',
                   (run_id, thread_id, json.dumps({'modelSelection': selection,
                                                   'startedAt': started})))
        if session:
            self._exec('insert into orchestration_v2_projection_provider_threads '
                       'values (?, ?, 1, ?)',
                       (thread_id, 'claudeAgent',
                        json.dumps({'nativeThreadRef': {'nativeId': session}})))

    def transcript(self, session, *records):
        folder = os.path.join(self.projects, 'C--repo')
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, f'{session}.jsonl'), 'w', encoding='utf-8') as f:
            for r in records:
                f.write(json.dumps(r) + '\n')

    def _exec(self, sql, args):
        db = sqlite3.connect(self.db)
        db.execute(sql, args)
        db.commit()
        db.close()

    def files(self):
        from queue_runner.effort import T3Files
        return T3Files(settings=self.settings, db=self.db, projects=self.projects)


def said(effort, at='2026-11-15T10:05:00.000Z', model='claude-opus-5-5'):
    """An assistant record of a Claude Code transcript, as 2.1.325 writes it."""
    return {'type': 'assistant', 'timestamp': at, 'effort': effort, 'perTurnEffort': effort,
            'message': {'model': model, 'role': 'assistant',
                        'content': [{'type': 'text', 'text': 'ok'}]}}


class ProjectDefaultTest(unittest.TestCase):
    """What `t3_thread_launch` uses for a thread started with no --model: with T3's settings
    folded (`projectSettingsFolded`, as on this PC), the project's entry in settings.json's
    `projectSettingsOverrides`, else the global `defaultModelSelection`; the project row's own
    default counts only before folding."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.t3 = T3Folder(tmp.name)
        self.root = 'C:\\Users\\Anon\\Code\\Personal\\first'
        self.t3.project('p1', self.root)

    def test_the_projects_override_in_folded_settings_is_its_default(self):
        self.t3.write_settings(projectSettingsFolded=True,
                               projectSettingsOverrides={'p1': {'defaultModelSelection': HIGH}})
        found = self.t3.files().project_default('c:/users/anon/code/personal/first')
        self.assertEqual(found.project_id, 'p1')
        self.assertEqual(found.selection, HIGH)
        self.assertIsNone(found.fallback)

    def test_once_folded_the_project_rows_own_default_is_not_read(self):
        # What t3_project_update writes: live check B (2026-11-15) failed on it with "the
        # project has no default model".
        self.t3.project('p2', 'C:\\sandbox', default=HIGH)
        self.t3.write_settings(projectSettingsFolded=True)
        found = self.t3.files().project_default('C:/sandbox')
        self.assertEqual(found.project_id, 'p2')
        self.assertIsNone(found.selection)

    def test_before_folding_the_project_rows_default_counts(self):
        self.t3.project('p2', 'C:\\sandbox', default=HIGH)
        self.t3.write_settings()
        self.assertEqual(self.t3.files().project_default('C:/sandbox').selection, HIGH)

    def test_with_no_override_the_global_default_and_fallback_apply(self):
        fallback = {'instanceId': 'codex', 'model': 'gpt-6.1-sol'}
        self.t3.write_settings(projectSettingsFolded=True, defaultModelSelection=HIGH,
                               fallbackModelSelection=fallback)
        found = self.t3.files().project_default(self.root)
        self.assertEqual((found.selection, found.fallback), (HIGH, fallback))

    def test_an_override_of_null_clears_the_global_default(self):
        self.t3.write_settings(projectSettingsFolded=True, defaultModelSelection=HIGH,
                               projectSettingsOverrides={'p1': {'defaultModelSelection': None}})
        self.assertIsNone(self.t3.files().project_default(self.root).selection)

    def test_a_folder_t3_has_no_project_for_reads_as_none(self):
        self.t3.project('p3', 'C:\\gone', deleted='2026-11-01T00:00:00.000Z')
        self.t3.write_settings(projectSettingsFolded=True)
        self.assertIsNone(self.t3.files().project_default('C:/elsewhere'))
        self.assertIsNone(self.t3.files().project_default('C:/gone'))

    def test_unreadable_files_read_as_none(self):
        from queue_runner.effort import T3Files
        files = T3Files(settings=os.path.join(self.t3.projects, 'none.json'),
                        db=os.path.join(self.t3.projects, 'none.sqlite'),
                        projects=self.t3.projects)
        self.assertIsNone(files.project_default(self.root))
        self.assertIsNone(T3Files(settings=None, db=None, projects=None)
                          .project_default(self.root))


class RunEffortTest(unittest.TestCase):
    """The effort a run used: Claude Code's own record of its calls (the transcript's assistant
    records since the run started, as `output_config.effort` went to the API), else the effort
    T3's run record asked for. Live check A (2026-11-15): `--model claude-haiku-5-5` gave a run
    record with no options and transcript records with `effort: medium`."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.t3 = T3Folder(tmp.name)

    def test_the_transcript_says_what_the_run_used(self):
        self.t3.run('t1', 'r1', {'instanceId': 'claudeAgent', 'model': 'claude-opus-5-5'})
        self.t3.transcript('s1', said('medium'))
        self.assertEqual(self.t3.files().run_effort('t1', 'r1'), 'medium')

    def test_the_last_call_of_the_run_counts(self):
        self.t3.run('t1', 'r1', HIGH)
        self.t3.transcript('s1', said('medium', at='2026-11-15T10:01:00.000Z'),
                           said('high', at='2026-11-15T10:02:00.000Z'))
        self.assertEqual(self.t3.files().run_effort('t1', 'r1'), 'high')

    def test_an_earlier_runs_calls_and_claude_codes_own_messages_do_not_count(self):
        # A continued thread whose new run stopped before any call: T3's ask stands.
        self.t3.run('t1', 'r2', HIGH, started='2026-11-15T12:00:00.000Z')
        self.t3.transcript('s1', said('medium', at='2026-11-15T10:00:00.000Z'),
                           said(None, at='2026-11-15T12:00:01.000Z', model='<synthetic>'))
        self.assertEqual(self.t3.files().run_effort('t1', 'r2'), 'high')

    def test_the_newest_call_by_its_own_time_across_the_sessions_transcripts(self):
        # One session's transcript in two project folders (review 1's F7's class): the file
        # touched last holds the older call.
        self.t3.run('t1', 'r1', HIGH)
        self.t3.transcript('s1', said('high', at='2026-11-15T10:05:00.000Z'))
        other = os.path.join(self.t3.projects, 'C--repo-moved')
        os.makedirs(other)
        with open(os.path.join(other, 's1.jsonl'), 'w', encoding='utf-8') as f:
            f.write(json.dumps(said('medium', at='2026-11-15T10:01:00.000Z')) + '\n')
        os.utime(os.path.join(self.t3.projects, 'C--repo', 's1.jsonl'), (1000, 1000))
        os.utime(os.path.join(other, 's1.jsonl'), (2000, 2000))
        self.assertEqual(self.t3.files().run_effort('t1', 'r1'), 'high')

    def test_with_no_transcript_t3s_run_record_says_what_it_asked_for(self):
        self.t3.run('t1', 'r1', HIGH, session=None)
        self.assertEqual(self.t3.files().run_effort('t1', 'r1'), 'high')

    def test_nothing_readable_is_none(self):
        self.t3.run('t1', 'r1', {'instanceId': 'claudeAgent', 'model': 'claude-opus-5-5'},
                    session=None)
        self.assertIsNone(self.t3.files().run_effort('t1', 'r1'))
        self.assertIsNone(self.t3.files().run_effort('t9', None))


class FakeFiles:
    """Plays `T3Files` for the Runner: `defaults` maps a folder to its ProjectDefault, `efforts`
    a thread id to the effort its runs used."""

    def __init__(self, defaults=None, efforts=None):
        self.defaults, self.efforts = dict(defaults or {}), dict(efforts or {})
        self.read = []

    def project_default(self, folder):
        return self.defaults.get(folder)

    def run_effort(self, thread_id, run_id):
        self.read.append((thread_id, run_id))
        return self.efforts.get(thread_id)


def set_high(folder, model='claude-opus-5-5', effort='high', fallback=None):
    from queue_runner.effort import ProjectDefault
    return {folder: ProjectDefault('p1', {'instanceId': 'claudeAgent', 'model': model,
                                          'options': [{'id': 'effort', 'value': effort}]},
                                   fallback)}


class RunnerHarness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        from queue_runner.config import Config, Repo
        self.repo = Repo(name='first', github='owner/first', path=self.dir)
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'),
                             runs_dir=os.path.join(self.dir, 'runs'),
                             checkouts_dir=os.path.join(self.dir, 'checkouts'))
        self.said = []

    def effort(self, files):
        from queue_runner.effort import Effort
        return Effort(self.config, files=files)

    def jobs(self, kind):
        return [j for j in self.r.jobs.jobs() if j.kind == kind]

    def told(self, text):
        return [s for s in self.said if text in s]


class BuildTest(RunnerHarness):
    def runner(self, files, *outcomes):
        import datetime
        import io
        from queue_runner.run import Runner
        from tests.fakes import FakeGitHubWithPulls, FakeLimits, issue
        from tests.fakes_t3 import FakeGit, FakeT3
        self.t3 = FakeT3(list(outcomes) or [(0, 'completed')] * 3)
        pr = {'number': 12, 'url': 'https://github.com/owner/first/pull/12', 'state': 'open'}
        self.gh = FakeGitHubWithPulls(issues=[issue(4, 'Red widget', 'Make it red.'),
                                              issue(5, 'Blue widget', 'Make it blue.')],
                                      pulls_by_branch={'claude/red-widget-4': pr,
                                                       'claude/blue-widget-5': pr})
        self.r = Runner(self.config, github=self.gh, t3=self.t3, git=FakeGit(),
                        out=io.StringIO(), log_line=self.said.append,
                        # every thread warm (ticket 38): a retry continues in place
                        limits=FakeLimits(default_start=datetime.datetime.now(
                            datetime.timezone.utc)),
                        effort=self.effort(files))
        return self.r

    def test_a_project_set_to_the_configs_model_and_effort_starts_with_no_model(self):
        r = self.runner(FakeFiles(set_high(self.dir), efforts={'mcp:t1': 'high'}))
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual((start['provider'], start['model']), (None, None))
        [build] = self.jobs('build')
        self.assertEqual(build.effort, 'high')
        self.assertEqual(self.told('ran at effort'), [])

    def test_a_project_not_set_so_starts_with_the_model_and_says_how_to_set_it_once(self):
        r = self.runner(FakeFiles(efforts={'mcp:t1': 'medium', 'mcp:t2': 'medium'}))
        r.run_pass()
        r.run_pass()
        self.assertEqual([(s['provider'], s['model']) for s in self.t3.starts],
                         [('claudeAgent', 'claude-opus-5-5')] * 2)
        [line] = self.told('start with --model')
        self.assertIn('first', line)
        self.assertIn('Settings', line)
        self.assertIn('Reasoning: high', line)

    def test_another_model_effort_or_a_fallback_is_not_the_configs(self):
        fallback = {'instanceId': 'codex', 'model': 'gpt-6.1-sol'}
        from dataclasses import replace
        for i, defaults in enumerate((set_high(self.dir, model='claude-fable-5-2'),
                                      set_high(self.dir, effort='medium'),
                                      set_high(self.dir, fallback=fallback))):
            with self.subTest(defaults=defaults):
                self.said.clear()
                self.config = replace(self.config, state_dir=os.path.join(self.dir, f'state{i}'))
                r = self.runner(FakeFiles(defaults))
                r.run_pass()
                self.assertEqual(self.t3.starts[0]['model'], 'claude-opus-5-5')
                self.assertEqual(len(self.told('start with --model')), 1, self.said)

    def test_a_job_at_another_effort_is_said_once_per_repo(self):
        r = self.runner(FakeFiles(set_high(self.dir),
                                  efforts={'mcp:t1': 'medium', 'mcp:t2': 'medium'}))
        r.run_pass()
        r.run_pass()
        self.assertEqual([b.effort for b in self.jobs('build')], ['medium', 'medium'])
        [line] = self.told('ran at effort medium, not high')
        self.assertIn('first', line)

    def test_an_effort_that_cannot_be_read_back_is_recorded_as_unknown_and_said_once(self):
        r = self.runner(FakeFiles(set_high(self.dir)))
        r.run_pass()
        r.run_pass()
        self.assertEqual([b.effort for b in self.jobs('build')], [None, None])
        self.assertEqual(len(self.told("couldn't be read back")), 1, self.said)

    def test_a_decision_thread_starts_the_same_way_and_records_its_effort(self):
        from tests.fakes_t3 import decision_reply
        r = self.runner(FakeFiles(set_high(self.dir), efforts={'mcp:t1': 'high',
                                                               'mcp:t2': 'medium'}),
                        (1, 'failed'),
                        (0, 'completed', decision_reply('stop', question='Which one?')))
        r.run_pass()   # the build fails
        r.run_pass()   # a decision on it
        self.assertEqual([(s['provider'], s['model']) for s in self.t3.starts], [(None, None)] * 2)
        [decision] = self.jobs('decision')
        self.assertEqual(decision.effort, 'medium')
        [line] = self.told('ran at effort medium')
        self.assertIn('decision first#4', line)

    def test_a_continued_job_records_the_effort_of_its_new_run(self):
        from tests.fakes_t3 import decision_reply
        r = self.runner(FakeFiles(set_high(self.dir), efforts={'mcp:t1': 'high',
                                                               'mcp:t2': 'high'}),
                        (1, 'failed'),
                        (0, 'completed', decision_reply('retry', add='Run the tests again.')),
                        (0, 'completed'))
        r.run_pass()
        r.run_pass()   # the decision retries the build in its thread
        builds = self.jobs('build')
        self.assertEqual(len(self.t3.sends), 1)
        self.assertEqual([(b.outcome, b.effort) for b in builds],
                         [('failed', 'high'), ('done', 'high')])
        self.assertEqual(r.effort.files.read[-1], ('mcp:t1', 'run:mcp:t1:1'))

    def test_a_runner_with_no_t3_files_starts_with_the_model_and_records_no_effort(self):
        import io
        from queue_runner.run import Runner
        from tests.fakes import FakeGitHubWithPulls, issue
        from tests.fakes_t3 import FakeGit, FakeT3
        self.t3 = FakeT3([(0, 'completed')])
        self.r = Runner(self.config, github=FakeGitHubWithPulls(issues=[issue(4, 'Red', 'R')]),
                        t3=self.t3, git=FakeGit(), out=io.StringIO(), log_line=self.said.append)
        self.r.run_pass()
        self.assertEqual(self.t3.starts[0]['model'], 'claude-opus-5-5')
        [build] = self.jobs('build')
        self.assertIsNone(build.effort)
        self.assertEqual(self.told('effort'), [])


class FixAndLiveTest(RunnerHarness):
    def test_a_fix_round_starts_the_same_way_and_records_its_effort(self):
        import io
        from queue_runner.github import Issue
        from queue_runner.run import Runner
        from tests.fakes import FakeGitHubForReviews, full_pr, issue
        from tests.fakes_t3 import FakeReviewGit, FakeSol
        from tests.test_fix import COMMITS, PushingT3
        from tests.test_ledger import H2, H3, important, reply
        gh = FakeGitHubForReviews(
            issues=[issue(9, 'Blue widget', 'Make it blue.')],
            prs=[full_pr(20, 'claude/red-5', H2, body='Closes #5', title='Red', base='main')],
            comments={5: []}, issue_bodies={('owner/first', 5): Issue(5, 'Red', 'Make it red.')})
        git = FakeReviewGit(heads={20: H2}, commits={('origin/main', H2): COMMITS,
                                                     (H2, H3): [{'sha': H3, 'subject': 'Fix'}]})
        self.t3 = PushingT3([(0, 'completed')], gh, H3)
        self.r = Runner(self.config, github=gh, t3=self.t3, git=git, out=io.StringIO(),
                        log_line=self.said.append,
                        sol=FakeSol([reply(findings=[important('F1')])]),
                        effort=self.effort(FakeFiles(set_high(self.dir),
                                                     efforts={'mcp:t1': 'high'})))
        self.r.reviewer.review_pass()
        self.assertEqual(self.r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual((start['provider'], start['model']), (None, None))
        [fix] = self.jobs('fix')
        self.assertEqual((fix.outcome, fix.effort), ('pushed', 'high'))

    def test_a_live_run_starts_the_same_way_and_records_its_effort(self):
        from tests.test_live import B, live_reply
        import tests.test_live as tl
        harness = tl.LiveHarness('setUp')
        harness.setUp()
        self.addCleanup(harness.doCleanups)
        effort = self.effort(FakeFiles(set_high(harness.dir), efforts={'mcp:t1': 'xhigh'}))
        effort.config = harness.config
        effort.say = harness.said.append

        def live():
            from queue_runner.live import LiveSteps
            from queue_runner.merge import Merger
            from queue_runner.stops import Stopper
            h = harness
            stopper = Stopper(h.config, github=h.gh, jobs=h.jobs, say=h.said.append,
                              toaster=h.toaster)
            return LiveSteps(h.config, github=h.gh, git=h.git, t3=h.t3, jobs=h.jobs,
                             say=h.said.append, stopper=stopper,
                             merger=Merger(h.config, github=h.gh, git=h.git, jobs=h.jobs,
                                           say=h.said.append),
                             find_thread=h.find, now=lambda: tl.NOW, effort=effort)

        self.assertIsNone(live().next())   # first sight
        harness.merged()
        harness.t3.outcomes = [(0, 'completed', live_reply())]
        steps = live()
        steps.run(*steps.next())
        [start] = harness.t3.starts
        self.assertEqual((start['provider'], start['model'], start['worktree']), (None, None, B))
        job = harness.jobs.live('first')[-1]
        self.assertEqual((job.outcome, job.effort), ('live', 'xhigh'))
        self.assertTrue(any('live first ran at effort xhigh, not high' in s
                            for s in harness.said), harness.said)


class StartTest(unittest.TestCase):
    """`main` reads T3's real files through its limits store (`limits.T3Store`: the database
    and Claude's projects folder) and `t3_settings`, and says at start how each served repo's
    jobs will start."""

    def run_main(self, set_up):
        import io
        from queue_runner.cli import main
        from queue_runner.limits import T3Store
        from queue_runner.wake import NoWaker
        from tests.fakes import FakeGitHubWithPulls, FakeToaster, FakeUsage
        from tests.fakes_t3 import FakeGit, FakeSol, FakeT3
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        config = write_config(tmp.name)
        t3 = T3Folder(tmp.name)
        root = os.path.join(tmp.name, 'first')
        t3.project('p1', root)
        t3.write_settings(projectSettingsFolded=True, projectSettingsOverrides=(
            {'p1': {'defaultModelSelection': HIGH}} if set_up else {}))
        out = io.StringIO()
        code = main(['--once', '--config', config], github=FakeGitHubWithPulls(), out=out,
                    t3=FakeT3(), git=FakeGit(), sleep=lambda s: None, sol=FakeSol(),
                    toaster=FakeToaster(), usage=FakeUsage(), limits=T3Store(t3.db, t3.projects),
                    t3_settings=t3.settings, waker=NoWaker())
        self.assertEqual(code, 0)
        return out.getvalue()

    def test_a_repo_whose_project_is_not_set_is_said_at_start_with_the_step(self):
        said = self.run_main(set_up=False)
        self.assertIn('first: its Claude jobs start with --model claude-opus-5-5', said)
        self.assertIn('it has no default model', said)
        self.assertIn('New threads, Model: claude-opus-5-5, Reasoning: high', said)

    def test_a_repo_whose_project_is_set_is_said_at_start_too(self):
        said = self.run_main(set_up=True)
        self.assertIn("first: its T3 project's default model is claude-opus-5-5 at effort high",
                      said)


if __name__ == '__main__':
    unittest.main()
