"""Ticket 39 and issue #119: the effort the runner's Claude jobs run at. `[claude] effort` in
config.toml; every job kind starting with its provider, model and effort named, whatever the T3
project's default model is; and the effort read back for its end record (`effort.T3Files`, on a
temp SQLite and transcript folder), through real jobs with T3 faked."""
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
        # Stefan, 2026-11-16: "Opus 5.5 medium as worker" (fba6c8f).
        from queue_runner.config import DEFAULT_CONFIG
        self.assertEqual(load_config(DEFAULT_CONFIG).claude_effort, 'medium')


HIGH = {'instanceId': 'claudeAgent', 'model': 'claude-opus-5-5',
        'options': [{'id': 'effort', 'value': 'high'}, {'id': 'fastMode', 'value': False}]}


class T3Folder:
    """A T3 userdata folder in a temp dir: `statev2.sqlite` with the tables the runner reads
    (the columns it reads, as T3's are, 2026-11-15), and a Claude projects folder."""

    def __init__(self, folder):
        self.db = os.path.join(folder, 'statev2.sqlite')
        self.projects = os.path.join(folder, 'claude-projects')
        os.makedirs(self.projects)
        db = sqlite3.connect(self.db)
        db.executescript("""
            create table orchestration_v2_projection_runs (run_id text, thread_id text,
                ordinal integer, payload_json text);
            create table orchestration_v2_projection_provider_threads (thread_id text,
                driver text, last_run_ordinal integer, payload_json text);
        """)
        db.commit()
        db.close()

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
        return T3Files(db=self.db, projects=self.projects)


def said(effort, at='2026-11-15T10:05:00.000Z', model='claude-opus-5-5'):
    """An assistant record of a Claude Code transcript, as 2.1.325 writes it."""
    return {'type': 'assistant', 'timestamp': at, 'effort': effort, 'perTurnEffort': effort,
            'message': {'model': model, 'role': 'assistant',
                        'content': [{'type': 'text', 'text': 'ok'}]}}


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
    """Plays `T3Files` for the Runner: `efforts` maps a thread id to the effort its runs used."""

    def __init__(self, efforts=None):
        self.efforts = dict(efforts or {})
        self.read = []

    def run_effort(self, thread_id, run_id):
        self.read.append((thread_id, run_id))
        return self.efforts.get(thread_id)


NAMED = ('claudeAgent', 'claude-opus-5-5', 'high')   # [claude]'s provider, model and effort


def named(start):
    return start['provider'], start['model'], start['effort']


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

    def test_a_build_starts_with_its_provider_model_and_effort_named(self):
        r = self.runner(FakeFiles(efforts={'mcp:t1': 'high'}))
        self.assertEqual(r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual(named(start), NAMED)
        [build] = self.jobs('build')
        self.assertEqual(build.effort, 'high')
        self.assertEqual(self.told('effort'), [])

    def test_the_configs_effort_is_the_one_named(self):
        from dataclasses import replace
        self.config = replace(self.config, claude_model='claude-fable-5-2', claude_effort='xhigh')
        self.runner(FakeFiles()).run_pass()
        self.assertEqual(named(self.t3.starts[0]), ('claudeAgent', 'claude-fable-5-2', 'xhigh'))

    def test_a_job_at_another_effort_is_said_once_per_repo(self):
        r = self.runner(FakeFiles(efforts={'mcp:t1': 'medium', 'mcp:t2': 'medium'}))
        r.run_pass()
        r.run_pass()
        self.assertEqual([b.effort for b in self.jobs('build')], ['medium', 'medium'])
        [line] = self.told('ran at effort medium, not high')
        self.assertIn('first', line)

    def test_an_effort_that_cannot_be_read_back_is_recorded_as_unknown_and_said_once(self):
        r = self.runner(FakeFiles())
        r.run_pass()
        r.run_pass()
        self.assertEqual([b.effort for b in self.jobs('build')], [None, None])
        self.assertEqual(len(self.told("couldn't be read back")), 1, self.said)

    def test_a_decision_thread_starts_the_same_way_and_records_its_effort(self):
        from tests.fakes_t3 import decision_reply
        r = self.runner(FakeFiles(efforts={'mcp:t1': 'high',
                                                               'mcp:t2': 'medium'}),
                        (1, 'failed'),
                        (0, 'completed', decision_reply('stop', question='Which one?')))
        r.run_pass()   # the build fails
        r.run_pass()   # a decision on it
        self.assertEqual([named(s) for s in self.t3.starts], [NAMED] * 2)
        [decision] = self.jobs('decision')
        self.assertEqual(decision.effort, 'medium')
        [line] = self.told('ran at effort medium')
        self.assertIn('decision first#4', line)

    def test_a_continued_job_records_the_effort_of_its_new_run(self):
        from tests.fakes_t3 import decision_reply
        r = self.runner(FakeFiles(efforts={'mcp:t1': 'high',
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

    def test_a_runner_with_no_t3_files_names_the_model_and_records_no_effort(self):
        import io
        from queue_runner.run import Runner
        from tests.fakes import FakeGitHubWithPulls, issue
        from tests.fakes_t3 import FakeGit, FakeT3
        self.t3 = FakeT3([(0, 'completed')])
        self.r = Runner(self.config, github=FakeGitHubWithPulls(issues=[issue(4, 'Red', 'R')]),
                        t3=self.t3, git=FakeGit(), out=io.StringIO(), log_line=self.said.append)
        self.r.run_pass()
        self.assertEqual(named(self.t3.starts[0]), NAMED)
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
                        effort=self.effort(FakeFiles(efforts={'mcp:t1': 'high'})))
        self.r.reviewer.review_pass()
        self.assertEqual(self.r.run_pass(), 'started')
        [start] = self.t3.starts
        self.assertEqual(named(start), NAMED)
        [fix] = self.jobs('fix')
        self.assertEqual((fix.outcome, fix.effort), ('pushed', 'high'))

    def test_a_live_run_starts_the_same_way_and_records_its_effort(self):
        from tests.test_live import B, live_reply
        import tests.test_live as tl
        harness = tl.LiveHarness('setUp')
        harness.setUp()
        self.addCleanup(harness.doCleanups)
        effort = self.effort(FakeFiles(efforts={'mcp:t1': 'xhigh'}))
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
        self.assertEqual((*named(start), start['worktree']), (*NAMED, B))
        job = harness.jobs.live('first')[-1]
        self.assertEqual((job.outcome, job.effort), ('live', 'xhigh'))
        self.assertTrue(any('live first ran at effort xhigh, not high' in s
                            for s in harness.said), harness.said)


if __name__ == '__main__':
    unittest.main()
