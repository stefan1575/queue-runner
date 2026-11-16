"""A stale waiting thread (issue #72): once T3 says a runner thread's prompt cache has expired
while it waits on Stefan, the runner settles it and keeps its Inbox item; opening that item then
starts a fresh thread, briefed with the old one's link and its last messages, instead of
reopening the cold one. Through the real `Runner` (T3, GitHub and git faked; `FakeLimits.expires`
plays T3's `promptCacheExpiresAt`) and the snapshot's asks."""
import datetime
import json
import os
import unittest

from dashboard.serve import Refused, apply_control
from queue_runner import control
from queue_runner.ask_threads import mark
from queue_runner.t3 import Message
from tests.fakes_t3 import decision_reply
from tests import test_ask_threads as ta
from tests import test_decisions as td

UTC = datetime.timezone.utc
PAST = datetime.datetime(2026, 1, 1, tzinfo=UTC)
NOW = '2026-11-15T13:00:00+08:00'
LATER = '2026-11-15T13:05:00+08:00'
BUILD = 'Queue runner build: first#4'


def ask_for(config, body, at=None):
    """The page's request, written to control.json as the dashboard writes it."""
    at = at or datetime.datetime.now(UTC).isoformat()
    path = control.path(config.state_dir)
    try:
        with open(path, encoding='utf-8') as f:
            c = json.load(f)
    except FileNotFoundError:
        c = {}
    os.makedirs(config.state_dir, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(apply_control(c, body, at), f)


class RequestTest(unittest.TestCase):
    def test_a_fresh_thread_is_asked_for_under_the_ask_and_the_latest_click_stands(self):
        c = apply_control({}, {'ask': 'thread-1', 'open': True}, NOW)
        c = apply_control(c, {'ask': 'thread-1', 'fresh': True}, NOW)
        c = apply_control(c, {'ask': 'thread-1', 'fresh': True}, LATER)
        self.assertEqual(c['asks']['thread-1'], {'open': {'at': NOW}, 'fresh': {'at': LATER}})

    def test_anything_else_is_refused(self):
        for body in ({'ask': 'thread-1', 'fresh': False}, {'ask': '../x', 'fresh': True},
                     {'ask': 'thread-1', 'fresh': True, 'open': True}):
            with self.subTest(body=body), self.assertRaises(Refused):
                apply_control({}, body, NOW)

    def test_the_runner_reads_it_and_ignores_one_the_page_could_not_have_written(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            with open(control.path(d), 'w', encoding='utf-8') as f:
                json.dump({'version': 1, 'lanes': {}, 'asks': {
                    'stop-1': {'fresh': {'at': NOW}}, 'stop-2': {'fresh': 'yes'}}}, f)
            switch = control.read(d)
            self.assertIsNone(switch.error)
            self.assertEqual(switch.fresh, {'stop-1': datetime.datetime.fromisoformat(NOW)})
            self.assertEqual(switch.opened, {})


class StaleAskTest(ta.ThreadCase):
    """An ask thread Stefan opened on PR #20's stop, gone stale."""

    def stale(self):
        ask = self.opened()
        self.says(ask, Message('user', 'Is F7 real?'),
                  Message('assistant', 'F7 is real: the hook writes twice.'))
        self.limits.expires[ask.thread_id] = PAST
        self.r.plan()
        self.assertIn(ask.thread_id, self.t3.settles)
        return ask

    def test_a_stale_ask_opened_again_starts_a_fresh_thread_with_the_old_ones_last_messages(self):
        old = self.stale()
        ask_for(self.config, {'ask': f'stop-{self.stop().id}', 'fresh': True})
        self.assertEqual(self.r.run_pass(), 'started')
        first, fresh = self.t3.launches
        self.assertEqual(fresh['title'], 'Decide: Queue runner ask: first#20')
        brief = fresh['message']
        self.assertIn('Review 3 is still blocking', brief)          # the ask's own brief
        self.assertIn('```queue-runner-decision', brief)
        self.assertIn('The earlier thread, gone cold', brief)
        self.assertIn(old.link, brief)                               # the old thread's link
        self.assertIn('F7 is real: the hook writes twice.', brief)   # and its last messages
        self.assertIn('Is F7 real?', brief)
        _, new = self.jobs('ask')
        self.assertEqual((new.outcome, new.about, new.resume['after'], new.resume['how']),
                         ('opened', self.stop().id, old.id, 'fresh'))
        # The prefix moved to the fresh thread: the cold one's comes off.
        self.r.plan()
        self.assertEqual(self.t3.threads[old.thread_id].title, 'Queue runner ask: first#20')
        self.assertEqual(self.t3.threads[new.thread_id].title,
                         'Decide: Queue runner ask: first#20')
        # Its answer is the one read, and acted on.
        stop = self.stop()
        self.says(new, Message('assistant', decision_reply('hold')))
        self.r.run_pass()
        self.assertEqual(self.r.jobs.decided(stop.id).outcome, 'hold')

    def test_the_request_is_taken_once(self):
        self.stale()
        ask_for(self.config, {'ask': f'stop-{self.stop().id}', 'fresh': True})
        self.r.run_pass()
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 2)

    def test_a_thread_not_stale_is_not_replaced(self):
        ask = self.opened()
        self.says(ask, Message('assistant', 'The case: ...'))
        ask_for(self.config, {'ask': f'stop-{self.stop().id}', 'fresh': True})
        self.r.run_pass()
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 1)   # T3 reports no expiry: never stale
        self.assertEqual(sum('has not gone stale' in s for s in self.said), 1)
        self.limits.expires[ask.thread_id] = datetime.datetime(2099, 1, 1, tzinfo=UTC)
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 1)   # still warm

    def test_a_request_from_before_the_newest_thread_opened_is_not_taken(self):
        self.noted()
        ask_for(self.config, {'ask': f'stop-{self.stop().id}', 'fresh': True},
                at='2020-01-01T00:00:00+00:00')
        self.ask_to_open()
        self.r.run_pass()
        [ask] = self.jobs('ask')
        self.limits.expires[ask.thread_id] = PAST
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 1)


class StaleAnswerTest(unittest.TestCase):
    """The decision tests' build of #4, stopped on a question a decision left to Stefan, gone
    stale."""
    D = td.DecisionTest
    setUp, runner, jobs, build = D.setUp, D.runner, D.jobs, D.build

    def stale(self):
        self.build((2, 'waiting'), (0, 'completed', decision_reply('stop', question='Blue?')))
        self.r.run_pass()
        [build] = self.jobs('build')
        self.t3.messages[build.thread_id] = [
            Message('assistant', 'Which blue: the light one or the dark one?')]
        self.limits.expires[build.thread_id] = PAST
        self.r.run_pass()
        self.assertIn(build.thread_id, self.t3.settles)
        self.assertEqual(self.t3.threads[build.thread_id].title, 'Answer: ' + BUILD)
        return build

    def opened(self):
        build = self.stale()
        ask_for(self.config, {'ask': f'thread-{build.id}', 'fresh': True})
        self.assertEqual(self.r.run_pass(), 'started')
        [launch] = self.t3.launches
        [ask] = self.jobs('ask')
        return build, launch, ask

    def test_opening_it_starts_a_fresh_thread_to_answer_in(self):
        build, launch, ask = self.opened()
        self.assertEqual(launch['title'], 'Answer: Queue runner answer: first#4')
        brief = launch['message']
        self.assertIn('> Which blue: the light one or the dark one?', brief)   # the question
        self.assertIn('### The issue', brief)                                   # the issue
        self.assertIn(build.link, brief)                                        # the old thread
        self.assertIn('The earlier thread, gone cold', brief)
        self.assertIn('"action": "answer"', brief)
        self.assertEqual((ask.about, ask.question, ask.issue), (build.id, 'waiting', 4))
        self.assertEqual(self.jobs('build')[0].outcome, 'waiting')   # it still waits
        self.r.plan()   # the prefix moved to the fresh thread
        self.assertEqual(self.t3.threads[build.thread_id].title, BUILD)
        self.assertEqual(self.t3.threads[ask.thread_id].title,
                         'Answer: Queue runner answer: first#4')

    def test_his_answer_there_goes_to_the_waiting_job_once(self):
        build, _, ask = self.opened()
        self.t3.messages[ask.thread_id] = [Message('assistant', decision_reply(
            'answer', text='The dark one.'))]
        self.t3.set_status(ask.thread_id, 'completed')
        self.t3.outcomes = [(0, 'completed')]   # the build carries on with it
        self.assertEqual(self.r.run_pass(), 'started')
        [sent] = self.t3.sends
        self.assertEqual(sent['thread_id'], build.thread_id)
        self.assertIn('Stefan answered your question in a T3 thread', sent['message'])
        self.assertIn('> The dark one.', sent['message'])
        old, new = self.jobs('build')
        self.assertEqual((old.outcome, old.reason), ('continued', 'thread'))
        self.assertEqual(new.about, old.id)
        self.r.run_pass()
        self.assertEqual(len(self.t3.sends), 1)
        self.assertTrue(self.t3.threads[ask.thread_id].settled)   # it no longer needs him
        self.assertEqual(self.t3.threads[ask.thread_id].title, 'Queue runner answer: first#4')

    def test_an_answer_on_github_meanwhile_wins(self):
        from queue_runner.github import Comment
        _, _, ask = self.opened()
        self.gh.comments.setdefault(4, []).append(
            Comment('stefan1575', '2099-01-01T00:00:00Z', 'The light one.'))
        self.t3.messages[ask.thread_id] = [Message('assistant', decision_reply(
            'answer', text='The dark one.'))]
        self.t3.set_status(ask.thread_id, 'completed')
        self.t3.outcomes = [(0, 'completed'), (0, 'completed')]
        self.r.run_pass()
        self.r.run_pass()
        [sent] = self.t3.sends
        self.assertIn('on GitHub', sent['message'])
        self.assertNotIn('The dark one.', sent['message'])

    def test_a_fresh_waiting_item_is_not_replaced(self):
        self.build((2, 'waiting'), (0, 'completed', decision_reply('stop', question='Blue?')))
        self.r.run_pass()
        [build] = self.jobs('build')
        ask_for(self.config, {'ask': f'thread-{build.id}', 'fresh': True})
        self.r.run_pass()
        self.assertEqual(self.t3.launches, [])
        self.assertNotIn(build.thread_id, self.t3.settles)


class MarkTest(unittest.TestCase):
    """The snapshot's `decide` on a stale item: a fresh thread offered, asked, then open."""

    def job(self, **kw):
        from queue_runner.state import Job
        base = dict(id='j', kind='stop', repo='first', issue=20, branch=None, title='t',
                    started_at='2026-11-15T10:00:00+00:00', ended_at='2026-11-15T10:00:00+00:00')
        return Job(**{**base, **kw})

    def setUp(self):
        self.stop = self.job(id='s1', stop='review', outcome='filed')
        self.ask = self.job(id='a1', kind='ask', about='s1', outcome='opened', thread_id='mcp:a1',
                            link='https://t3/a1', started_at='2026-11-15T11:00:00+00:00')
        self.build = self.job(id='b1', kind='build', issue=4, outcome='waiting',
                              thread_id='mcp:b1', link='https://t3/b1')

    def asks(self):
        return [{'id': 'stop-s1', 'repo': 'first',
                 'go': {'label': 'Answer on GitHub', 'where': 'github', 'url': 'https://gh/1'}},
                {'id': 'thread-b1', 'repo': 'first',
                 'go': {'label': 'Open the thread', 'where': 't3', 'url': 'https://t3/b1'}}]

    def test_fresh_items_are_as_before(self):
        asks = self.asks()
        mark(asks, [], [self.stop, self.ask, self.build], {}, lambda r: None)
        self.assertEqual(asks[0]['decide']['state'], 'open')
        self.assertEqual(asks[0]['go']['url'], 'https://t3/a1')
        self.assertIsNone(asks[1]['decide'])
        self.assertEqual(asks[1]['go']['url'], 'https://t3/b1')

    def test_stale_items_offer_a_fresh_thread(self):
        asks = self.asks()
        mark(asks, [], [self.stop, self.ask, self.build], {}, lambda r: None,
             stale={'mcp:a1': PAST, 'mcp:b1': PAST})
        for a, label in zip(asks, ('Decide in a fresh T3 thread', 'Answer in a fresh T3 thread')):
            self.assertEqual((a['decide']['state'], a['decide']['label']), ('stale', label))
            self.assertIn('went cold', a['decide']['note'])

    def test_asked_then_open_on_the_fresh_thread(self):
        asks = self.asks()
        clicked = datetime.datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
        mark(asks, [], [self.stop, self.ask, self.build], {}, lambda r: None,
             stale={'mcp:a1': PAST, 'mcp:b1': PAST},
             fresh={'stop-s1': clicked, 'thread-b1': clicked})
        self.assertEqual([a['decide']['state'] for a in asks], ['asked', 'asked'])
        answer = self.job(id='a2', kind='ask', about='b1', issue=4, outcome='opened',
                          thread_id='mcp:a2', link='https://t3/a2', question='waiting',
                          started_at='2026-11-15T12:01:00+00:00')
        asks = self.asks()
        mark(asks, [], [self.stop, self.ask, self.build, answer], {}, lambda r: None,
             stale={'mcp:a1': PAST, 'mcp:b1': PAST},
             fresh={'stop-s1': clicked, 'thread-b1': clicked})
        self.assertEqual(asks[1]['decide']['state'], 'open')
        self.assertEqual((asks[1]['go']['url'], asks[1]['go']['label']),
                         ('https://t3/a2', 'Answer in T3'))


if __name__ == '__main__':
    unittest.main()
