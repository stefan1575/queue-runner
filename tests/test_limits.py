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



class ResumeChoiceTest(unittest.TestCase):
    """In place or fresh (ticket 38): warm continues at any size; cold continues only below
    120k tokens; an unknown age or size is cold and large."""
    NOW = datetime.datetime(2026, 11, 15, 12, 0, tzinfo=UTC)

    def choose(self, minutes_ago, tokens):
        last = None if minutes_ago is None else self.NOW - datetime.timedelta(minutes=minutes_ago)
        return limits.resume_choice(last, tokens, self.NOW)

    def test_warm_continues_in_place_at_any_size(self):
        self.assertTrue(self.choose(54, 900_000).in_place)
        self.assertTrue(self.choose(0, 300_000).in_place)

    def test_warm_means_the_last_request_started_less_than_55_minutes_ago(self):
        self.assertFalse(self.choose(55, 300_000).in_place)

    def test_cold_continues_in_place_below_120k_tokens(self):
        self.assertTrue(self.choose(55, 119_999).in_place)
        self.assertTrue(self.choose(300, 50_000).in_place)

    def test_cold_at_or_above_120k_tokens_starts_fresh(self):
        self.assertFalse(self.choose(55, 120_000).in_place)
        self.assertFalse(self.choose(300, 250_000).in_place)

    def test_an_unknown_age_is_cold(self):
        self.assertTrue(self.choose(None, 60_000).in_place)
        self.assertFalse(self.choose(None, 200_000).in_place)

    def test_an_unknown_size_is_large(self):
        self.assertTrue(self.choose(10, None).in_place)   # warm: any size
        self.assertFalse(self.choose(90, None).in_place)

    def test_it_says_why_with_the_age_and_size(self):
        c = self.choose(190, 180_000)
        self.assertEqual((c.how, c.idle_minutes, c.context), ('fresh', 190, 180_000))
        self.assertEqual(c.why, 'cold (its last request started 3 h 10 min ago) and 180,000 '
                                'tokens, at least 120,000: a fresh thread is cheaper')
        self.assertEqual(self.choose(12, 180_000).why,
                         'warm (its last request started 12 min ago): continuing it in place '
                         'is cheaper at any size')
        self.assertEqual(self.choose(None, None).why,
                         'cold (when its last request started is unknown) and its size '
                         'unknown: a fresh thread')
        self.assertEqual(self.choose(70, 40_000).record(), {
            'how': 'in-place', 'why': self.choose(70, 40_000).why,
            'last_request': '2026-11-15T10:50:00+00:00', 'idle_minutes': 70,
            'context': 40_000})


class TranscriptTest(unittest.TestCase):
    def test_context_is_the_last_real_calls_whole_prompt_and_reply(self):
        # The last record is Claude Code's synthetic limit message, with zero usage: skipped.
        # The one before: 2 input + 1606 cache write + 106858 cache read + 167 output.
        path = os.path.join(FIXTURES, 'claude', 'transcript-limit-stop.jsonl')
        self.assertEqual(limits.context_tokens(path), 108_633)

    def test_the_last_real_calls_request_start_and_context(self):
        # Its api-request record (by requestRef) started it; the request a limit refused after
        # it got only Claude Code's synthetic message, which doesn't count.
        path = os.path.join(FIXTURES, 'claude', 'transcript-requests.jsonl')
        self.assertEqual(limits.last_call(path), limits.LastCall(
            datetime.datetime(2026, 11, 10, 13, 2, 41, 120000, tzinfo=UTC), 209_676))

    def test_a_call_with_no_request_record_has_an_unknown_start(self):
        path = os.path.join(FIXTURES, 'claude', 'transcript-limit-stop.jsonl')
        self.assertEqual(limits.last_call(path), limits.LastCall(None, 108_633))

    def test_a_missing_or_empty_transcript_is_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            empty = os.path.join(d, 'x.jsonl')
            open(empty, 'w').close()
            self.assertIsNone(limits.context_tokens(empty))
            self.assertIsNone(limits.context_tokens(os.path.join(d, 'none.jsonl')))
            self.assertEqual(limits.last_call(empty), limits.LastCall(None, None))


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

    def test_a_claude_threads_last_call_from_its_transcript(self):
        self.assertEqual(self.store.last_call(THREAD), limits.LastCall(None, 108_633))

    def test_an_unreadable_database_says_nothing(self):
        store = limits.T3Store(os.path.join(self.dir, 'none.sqlite'), self.dir)
        self.assertEqual(store.limit_reset(THREAD, RUN), (False, None))
        self.assertIsNone(store.context_tokens(THREAD))
        self.assertEqual(store.last_call(THREAD), limits.LastCall(None, None))


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
