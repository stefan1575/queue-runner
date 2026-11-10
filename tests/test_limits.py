"""Limit recovery's own rules (ticket 09): when to resume, in place or fresh, and what T3 and
Claude Code keep about a usage-limit stop, read from fixtures captured on a real one."""
import datetime
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

from queue_runner import limits

UTC = datetime.timezone.utc
FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures')
STOPPED = datetime.datetime(2026, 11, 8, 7, 34, 13, tzinfo=UTC)


def fixture(*parts) -> str:
    with open(os.path.join(FIXTURES, *parts), encoding='utf-8') as f:
        return f.read()


class ResumeTimeTest(unittest.TestCase):
    def test_ten_minutes_after_the_reset_t3_stored(self):
        reset = datetime.datetime(2026, 11, 9, 11, 0, tzinfo=UTC)
        self.assertEqual(limits.resume_at(STOPPED, reset),
                         datetime.datetime(2026, 11, 9, 11, 10, tzinfo=UTC))

    def test_with_no_reset_five_hours_five_minutes_from_the_stop_then_ten_more(self):
        self.assertEqual(limits.resume_at(STOPPED, None),
                         datetime.datetime(2026, 11, 8, 12, 49, 13, tzinfo=UTC))

    def test_continues_in_place_only_at_about_50k_tokens_or_less(self):
        self.assertTrue(limits.in_place(50_000))
        self.assertTrue(limits.in_place(12_000))
        self.assertFalse(limits.in_place(50_001))
        self.assertFalse(limits.in_place(None))   # unknown: fresh


class TranscriptTest(unittest.TestCase):
    def test_context_is_the_last_real_calls_whole_prompt_and_reply(self):
        # The last record is Claude Code's synthetic limit message, with zero usage: skipped.
        # The one before: 2 input + 1606 cache write + 106858 cache read + 167 output.
        path = os.path.join(FIXTURES, 'claude', 'transcript-limit-stop.jsonl')
        self.assertEqual(limits.context_tokens(path), 108_633)

    def test_a_missing_or_empty_transcript_is_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            empty = os.path.join(d, 'x.jsonl')
            open(empty, 'w').close()
            self.assertIsNone(limits.context_tokens(empty))
            self.assertIsNone(limits.context_tokens(os.path.join(d, 'none.jsonl')))


def make_store(d: str) -> str:
    """A T3 database holding the real stop's rows, in the tables and columns T3 0.1.5 uses."""
    path = os.path.join(d, 'statev2.sqlite')
    db = sqlite3.connect(path)
    db.execute('create table orchestration_v2_projection_turn_items (turn_item_id text, '
               'thread_id text, run_id text, node_id text, provider_thread_id text, '
               'provider_turn_id text, parent_item_id text, ordinal integer, type text, '
               'status text, updated_at text, payload_json text)')
    db.execute('create table orchestration_v2_projection_provider_threads (provider_thread_id '
               'text, thread_id text, owner_node_id text, provider text, provider_session_id '
               'text, status text, first_run_ordinal integer, last_run_ordinal integer, '
               'updated_at text, payload_json text, driver text, provider_instance_id text)')
    item = json.loads(fixture('t3', 'turn-item-usage-limit.json'))
    db.execute('insert into orchestration_v2_projection_turn_items (turn_item_id, thread_id, '
               'run_id, type, status, payload_json) values (?, ?, ?, ?, ?, ?)',
               (item['id'], item['threadId'], item['runId'], item['type'], item['status'],
                json.dumps(item)))
    pt = json.loads(fixture('t3', 'provider-thread-claude.json'))
    db.execute('insert into orchestration_v2_projection_provider_threads (provider_thread_id, '
               'thread_id, last_run_ordinal, payload_json, driver) values (?, ?, ?, ?, ?)',
               (pt['id'], pt['appThreadId'], pt['lastRunOrdinal'], json.dumps(pt), pt['driver']))
    db.commit()
    db.close()
    return path


THREAD = 'mcp:launch:224d9fdd0490455c641043a2b1e21b674ba028ab2f3b1ab3ce22c2c5f994c066'
RUN = f'run:thread:{THREAD.replace(":", "%3A")}:ordinal:1'


class T3StoreTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        projects = os.path.join(self.dir, 'projects', 'C--Users-Anon--t3-worktrees-x')
        os.makedirs(projects)
        shutil.copy(os.path.join(FIXTURES, 'claude', 'transcript-limit-stop.jsonl'),
                    os.path.join(projects, '79889bce-919b-48ed-ac44-9136d2e24268.jsonl'))
        self.store = limits.T3Store(make_store(self.dir), os.path.join(self.dir, 'projects'))

    def test_reads_the_reset_t3_stored_for_the_runs_limit_stop(self):
        found, reset = self.store.limit_reset(THREAD, RUN)
        self.assertTrue(found)
        self.assertEqual(reset, datetime.datetime(2026, 11, 9, 11, 0, tzinfo=UTC))

    def test_another_run_of_the_thread_has_no_limit_stop(self):
        self.assertEqual(self.store.limit_reset(THREAD, RUN.replace('ordinal:1', 'ordinal:2')),
                         (False, None))

    def test_a_claude_threads_context_from_its_transcript(self):
        self.assertEqual(self.store.context_tokens(THREAD), 108_633)

    def test_an_unreadable_database_says_nothing(self):
        store = limits.T3Store(os.path.join(self.dir, 'none.sqlite'), self.dir)
        self.assertEqual(store.limit_reset(THREAD, RUN), (False, None))
        self.assertIsNone(store.context_tokens(THREAD))


class LimitStopTest(unittest.TestCase):
    """Whether a failed run stopped on a usage limit, from T3's record or, failing that, what
    the thread said."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = limits.T3Store(make_store(tmp.name), tmp.name)

    def test_t3s_record_gives_the_reset(self):
        stop = limits.limit_stop(self.store, THREAD, RUN, [])
        self.assertEqual(stop.reset_at, datetime.datetime(2026, 11, 9, 11, 0, tzinfo=UTC))

    def test_claude_codes_limit_message_without_a_record_is_a_stop_with_no_reset(self):
        said = json.loads(fixture('t3', 'thread-show-usage-limit.json'))['messages'][-1]['text']
        stop = limits.limit_stop(self.store, 'other', 'run:other:1', [said])
        self.assertIsNotNone(stop)
        self.assertIsNone(stop.reset_at)

    def test_any_other_failure_is_not_a_limit_stop(self):
        self.assertIsNone(limits.limit_stop(self.store, 'other', 'run:other:1',
                                            ['It broke.', 'I hit a type error.']))


class AutoResumeTest(unittest.TestCase):
    def test_off_unless_t3s_settings_turn_it_on(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'settings.json')
            self.assertIsNone(limits.auto_resume_warning(path))   # no file: T3's default, off
            with open(path, 'w') as f:
                json.dump({'idleCompaction': 'off'}, f)
            self.assertIsNone(limits.auto_resume_warning(path))
            with open(path, 'w') as f:
                json.dump({'autoResumeLimitedThreads': True}, f)
            self.assertIn('Resume after usage limits', limits.auto_resume_warning(path))
