"""An ask opens a T3 thread to decide in (ticket 35): the page's request (`serve.apply_control`),
the record the runner reads (`control.py`), the Claude lane starting the thread and reading its
answer through the real `Runner` (GitHub, T3 and git faked), and the ask in the snapshot."""
import datetime
import json
import os
import tempfile
import unittest

from dashboard.serve import Refused, apply_control
from queue_runner import control, inbox, snapshot
from queue_runner.fix import fix_branch
from queue_runner.github import Comment
from queue_runner.stops import held
from queue_runner.t3 import Message, T3Cli, T3Error
from tests.fakes_t3 import decision_reply
from tests import test_decisions as td

NOW = '2026-11-15T13:00:00+08:00'
THREAD1 = 'https://app.t3.codes/threads/env/mcp:t1'
LATER_NOW = '2026-11-15T13:05:00+08:00'


class RequestTest(unittest.TestCase):
    def test_opening_an_ask_is_recorded_under_its_id_and_keeps_the_rest(self):
        c = apply_control({}, {'lane': 'claude', 'stop': 'after-job'}, NOW)
        c = apply_control(c, {'ask': 'stop-123', 'open': True}, LATER_NOW)
        self.assertEqual(c['asks'], {'stop-123': {'open': {'at': LATER_NOW}}})
        self.assertEqual(c['lanes']['claude']['stop'], 'after-job')
        self.assertEqual(c['written_at'], LATER_NOW)
        # the other keys of the ask's record (ticket 36's) are kept, and so is every other write
        c['asks']['stop-123']['read'] = {'at': NOW}
        c = apply_control(c, {'ask': 'stop-9', 'open': True}, LATER_NOW)
        c = apply_control(c, {'lane': 'sol', 'stop': None}, LATER_NOW)
        self.assertEqual(c['asks']['stop-123'], {'open': {'at': LATER_NOW}, 'read': {'at': NOW}})
        self.assertEqual(c['asks']['stop-9'], {'open': {'at': LATER_NOW}})

    def test_asking_again_keeps_the_first_time(self):
        c = apply_control({}, {'ask': 'stop-1', 'open': True}, NOW)
        c = apply_control(c, {'ask': 'stop-1', 'open': True}, LATER_NOW)
        self.assertEqual(c['asks']['stop-1']['open'], {'at': NOW})

    def test_anything_else_about_an_ask_is_refused(self):
        for body in ({'ask': 'stop-1', 'open': False}, {'ask': 'stop-1', 'open': 'yes'},
                     {'ask': 'stop-1'}, {'ask': '../x', 'open': True}, {'ask': 3, 'open': True},
                     {'ask': 'stop-1', 'open': True, 'lane': 'claude'},
                     {'ask': 'stop-1', 'close': True}):
            with self.subTest(body=body), self.assertRaises(Refused):
                apply_control({}, body, NOW)


class RecordTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = tmp.name

    def write(self, data):
        with open(control.path(self.state), 'w', encoding='utf-8') as f:
            json.dump(data, f)

    def test_the_runner_reads_each_ask_asked_to_open_and_when(self):
        c = apply_control({}, {'ask': 'stop-1', 'open': True}, NOW)
        c['asks']['stop-2'] = {'read': {'at': NOW}}   # ticket 36's, not opened
        self.write(c)
        switch = control.read(self.state)
        self.assertIsNone(switch.error)
        self.assertEqual(switch.opened, {'stop-1': datetime.datetime.fromisoformat(NOW)})

    def test_an_ask_record_the_page_could_not_have_written_is_ignored_not_unreadable(self):
        self.write({'version': 1, 'lanes': {}, 'asks': {'stop-1': {'open': 'yes'},
                                                        'stop-2': 'x', 'stop-3': {'open': {}}}})
        switch = control.read(self.state)
        self.assertIsNone(switch.error)
        self.assertEqual(switch.opened, {})
        self.write({'version': 1, 'lanes': {}, 'asks': [1]})
        self.assertEqual(control.read(self.state).opened, {})

    def test_pause_and_resume_keep_the_asks(self):
        self.write(apply_control({}, {'ask': 'stop-1', 'open': True}, NOW))
        control.ask(self.state, ['claude'], 'after-job', LATER_NOW)
        control.ask(self.state, [], None, LATER_NOW, repos=['first'])
        self.assertEqual(control.read(self.state).opened,
                         {'stop-1': datetime.datetime.fromisoformat(NOW)})


class LaunchTest(unittest.TestCase):
    def test_a_thread_is_started_without_waiting_and_its_id_read(self):
        calls = []

        def run(args, stdin):
            calls.append((args, stdin))
            return 0, '{"threadId": "mcp:x1", "projectId": "p1", "runId": "run:x1:1"}', ''
        got = T3Cli(run=run).launch('C:/repo', 'The brief.', title='Queue runner ask: first#20',
                                    provider='claudeAgent', model='claude-opus-5-5')
        self.assertEqual((got.thread_id, got.run_id), ('mcp:x1', 'run:x1:1'))
        self.assertEqual(calls, [(['thread', 'start', '--json', '--title',
                                   'Queue runner ask: first#20', '--provider', 'claudeAgent',
                                   '--model', 'claude-opus-5-5', 'C:/repo', '-'], 'The brief.')])

    def test_t3_failing_is_a_t3_error(self):
        with self.assertRaises(T3Error):
            T3Cli(run=lambda a, s: (1, '', 'No T3 Code project matches')).launch(
                'C:/repo', 'b', title='t')


class ThreadCase(unittest.TestCase):
    """The decision tests' PR #20, whose review 3 on H2 stopped with an Approach note: a filed
    `approach-note` stop, which Stefan opens from the Inbox."""
    D = td.DecisionTest
    setUp, runner, jobs, calls = D.setUp, D.runner, D.jobs, D.calls
    review_3, noted, answer = D.review_3, D.noted, D.answer

    def stop(self):
        [s] = [s for s in self.jobs('stop') if s.outcome == 'filed']
        return s

    def ask_to_open(self, stop=None, at=NOW):
        path = control.path(self.config.state_dir)
        try:
            with open(path, encoding='utf-8') as f:
                c = json.load(f)
        except FileNotFoundError:
            c = {}
        c = apply_control(c, {'ask': f'stop-{(stop or self.stop()).id}', 'open': True}, at)
        os.makedirs(self.config.state_dir, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(c, f)

    def opened(self):
        self.noted()
        self.ask_to_open()
        self.r.run_pass()
        [ask] = self.jobs('ask')
        return ask

    def says(self, ask, *messages, status='completed'):
        """The ask's thread, now: its newest messages, and its status."""
        self.t3.messages[ask.thread_id] = list(messages)
        self.t3.set_status(ask.thread_id, status)


class OpenTest(ThreadCase):
    def test_his_click_starts_a_thread_briefed_with_the_ask_and_the_lane_does_not_wait(self):
        self.noted()
        self.ask_to_open()
        self.t3.outcomes = []   # nothing waits on a run: a start with --wait would fail here
        self.assertEqual(self.r.run_pass(), 'started')
        [launch] = self.t3.launches
        self.assertEqual((launch['title'], launch['project'], launch['model']),
                         ('Queue runner ask: first#20', self.dir, self.config.claude_model))
        brief = launch['message']
        self.assertIn('Review 3 is still blocking', brief)            # the ask's situation
        self.assertIn('Rework the approach, fix on with the same approach, or hold it?', brief)
        self.assertIn('**F7**', brief)                                 # an open finding
        self.assertIn('Earlier threads', brief)
        self.assertIn('ended approach-note: https://github.com/owner/first/pull/20#issuecomment-901',
                      brief)                                           # the decision before
        self.assertIn('```queue-runner-decision', brief)
        for action in ('`fix`', '`carry-on`', '`hold`', '`stop`'):
            self.assertIn(action, brief)
        self.assertIn('once Stefan has decided', brief)
        [ask] = self.jobs('ask')
        self.assertEqual((ask.outcome, ask.about, ask.issue, ask.thread_id, ask.link),
                         ('opened', self.stop().id, 20, 'mcp:a1',
                          'https://app.t3.codes/threads/env/mcp:a1'))

    def test_it_starts_only_on_his_click(self):
        self.noted()
        self.t3.outcomes = [(0, 'completed')]   # the build of #4 instead
        self.r.run_pass()
        self.assertEqual(self.t3.launches, [])

    def test_once_per_ask(self):
        self.noted()
        self.ask_to_open()
        self.r.run_pass()
        self.ask_to_open(at=LATER_NOW)   # asked again
        self.t3.outcomes = [(0, 'completed')]   # the build of #4
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 1)
        self.assertEqual(self.t3.starts[-1]['title'], 'Queue runner build: first#4')

    def test_t3_failing_keeps_the_request_and_the_next_pass_tries_again(self):
        self.noted()
        self.ask_to_open()
        self.t3.launch_error = T3Error('server down')
        self.assertEqual(self.r.run_pass(), 'idle')
        self.assertEqual([j.outcome for j in self.jobs('ask')], ['not-started'])
        self.r.run_pass()
        self.assertEqual([j.outcome for j in self.jobs('ask')], ['not-started', 'opened'])

    def test_a_stopped_claude_lane_keeps_the_request_and_starts_it_on_resume(self):
        self.noted()
        control.ask(self.config.state_dir, ['claude'], 'after-job', NOW)
        self.ask_to_open()
        self.assertEqual(self.r.run_pass(), 'stopped')
        self.assertEqual(self.t3.launches, [])
        control.ask(self.config.state_dir, ['claude'], None, LATER_NOW)
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 1)

    def test_a_stopped_repo_keeps_the_request_and_starts_it_on_resume(self):
        self.noted()
        control.ask(self.config.state_dir, [], 'after-job', NOW, repos=['first'])
        self.ask_to_open()
        self.r.run_pass()
        self.assertEqual(self.t3.launches, [])
        control.ask(self.config.state_dir, [], None, LATER_NOW, repos=['first'])
        self.r.run_pass()
        self.assertEqual(len(self.t3.launches), 1)

    def test_it_is_gated_as_a_decision(self):
        from queue_runner.gate import Verdict

        class Shut:
            kinds = []

            def check(self, kind, then=None):
                self.kinds.append((kind, then))
                return Verdict(False, 'five-hour', 'the session is full')
        self.noted()
        self.ask_to_open()
        self.r.gate = Shut()
        self.assertEqual(self.r.run_pass(), 'gated')
        self.assertEqual((Shut.kinds, self.t3.launches), ([('decision', None)], []))

    def test_a_dry_run_names_the_thread_it_would_open_and_starts_nothing(self):
        import io
        from queue_runner.cli import main
        from tests.fakes import FakeUsage
        self.noted()
        self.ask_to_open()
        config = os.path.join(self.dir, 'config.toml')
        with open(config, 'w', encoding='utf-8') as f:
            f.write(f'''
state_dir = "{self.config.state_dir}"
log_dir = "{self.dir}/logs"

[[repos]]
name = "first"
github = "owner/first"
path = "{self.dir}"
'''.replace('\\', '/'))
        out = io.StringIO()
        self.assertEqual(main(['--once', '--dry-run', '--config', config], github=self.gh,
                              t3=self.t3, out=out, usage=FakeUsage()), 0)
        self.assertIn('Would open a T3 thread for Stefan to decide first#20 in', out.getvalue())
        self.assertIn('## The ask', out.getvalue())
        self.assertEqual((self.t3.launches, self.jobs('ask')), ([], []))


class AnswerTest(ThreadCase):
    def test_no_block_yet_changes_nothing(self):
        ask = self.opened()
        for messages, status in (
                ([Message('assistant', 'The case: ... I recommend rework. What do you think?')],
                 'completed'),
                ([Message('assistant', decision_reply('hold'))], 'running'),   # not done yet
                ([Message('assistant', decision_reply('hold')),
                  Message('user', 'Wait, not hold.')], 'completed')):          # Stefan spoke last
            self.says(ask, *messages, status=status)
            self.t3.outcomes = [(0, 'completed')]
            self.r.plan()
            self.assertEqual(self.stop().outcome, 'filed')
            self.assertEqual([d.question for d in self.jobs('decision')], ['approach-note'])

    def test_a_fix_answered_in_the_thread_is_acted_on_as_a_reply_is(self):
        ask = self.opened()
        self.says(ask, Message('user', 'fix on, only F7'),
                  Message('assistant', decision_reply(
                      'fix', prose='Then fix on.', add='Stefan chose fix on: fix F7 only.')))
        self.t3.outcomes = [(0, 'completed')]   # the fix round
        self.assertEqual(self.r.run_pass(), 'started')
        [stop] = self.jobs('stop')
        self.assertEqual((stop.outcome, stop.answer), ('answered', 'thread'))
        d = self.jobs('decision')[-1]
        self.assertEqual((d.question, d.about, d.outcome, d.reason, d.link, d.sha),
                         ('reply', stop.id, 'fix', 'Stefan chose fix on: fix F7 only.',
                          ask.link, td.H2))
        self.assertIsNone(held(self.r.jobs, self.repo, 20))
        start = self.t3.starts[-1]   # the fix round it ordered, this same pass
        self.assertEqual(start['branch'], fix_branch(20, td.H2))
        self.assertIn('## Direction first', start['message'])
        self.assertIn('fix F7 only', start['message'])
        self.assertIsNone(self.r.decider.next_case())   # decided once
        # The fix round's thread is settled at its end; the ask thread is left (ticket 70).
        self.assertTrue(ask.thread_id)
        self.assertNotIn(ask.thread_id, self.t3.settles)
        self.assertEqual(self.t3.settles[-1], self.jobs('fix')[-1].thread_id)

    def test_hold_answered_in_the_thread(self):
        ask = self.opened()
        self.says(ask, Message('assistant', decision_reply('hold')))
        self.r.run_pass()
        self.assertIn('Stefan said hold', held(self.r.jobs, self.repo, 20))

    def test_a_block_the_runner_cant_act_on_is_said_and_waits_for_another(self):
        ask = self.opened()
        self.says(ask, Message('assistant', decision_reply('retry', add='x')))
        self.r.plan()
        self.assertEqual(self.stop().outcome, 'filed')
        self.assertTrue(any("can't act on" in line for line in self.said))

    def test_an_answer_on_github_meanwhile_still_counts_and_the_thread_s_is_not_acted_on(self):
        ask = self.opened()
        self.answer('fix on')   # on the PR; the Sol lane reads it
        self.says(ask, Message('assistant', decision_reply('hold')))
        self.t3.outcomes = [(0, 'completed')]   # the fix round his reply orders
        self.r.run_pass()
        [stop] = self.jobs('stop')
        self.assertEqual(stop.answer, 'replied')
        decisions = [d for d in self.jobs('decision') if d.question == 'reply']
        self.assertEqual([d.outcome for d in decisions], ['fix'])
        self.r.run_pass()
        self.assertEqual(len([d for d in self.jobs('decision') if d.question == 'reply']), 1)
        self.assertIsNone(held(self.r.jobs, self.repo, 20))   # no hold from the thread

    def test_a_reply_on_github_after_the_thread_decided_is_not_decided_again(self):
        ask = self.opened()
        self.says(ask, Message('assistant', decision_reply('carry-on')))
        self.r.plan()
        self.answer('Actually, hold.')   # the stop isn't filed any more: not an answer to it
        self.assertEqual(self.stop_of_pr().answer, 'thread')
        self.assertIsNone(self.r.decider.next_case())
        self.assertEqual(len([d for d in self.jobs('decision') if d.question == 'reply']), 1)

    def stop_of_pr(self):
        [s] = self.jobs('stop')
        return s


class ReleasedTest(ThreadCase):
    """`--release` settles a stop: its ask is never opened or acted on after (review 1's F3)."""

    def test_releasing_a_stop_drops_its_pending_request(self):
        self.noted()
        self.ask_to_open()
        self.r.jobs.released('first', 20)
        self.assertIsNone(self.r.asking.next(control.read(self.config.state_dir)))
        self.t3.outcomes = [(0, 'completed')]   # the build of #4 instead
        self.r.run_pass()
        self.assertEqual(self.t3.launches, [])

    def test_releasing_a_stop_keeps_its_open_thread_from_holding_the_pr_again(self):
        ask = self.opened()
        self.r.jobs.released('first', 20)
        self.assertIsNone(held(self.r.jobs, self.repo, 20))
        self.says(ask, Message('assistant', decision_reply('hold')))
        self.r.plan()
        self.assertIsNone(held(self.r.jobs, self.repo, 20))
        self.assertEqual([j.outcome for j in self.jobs('decision')], ['approach-note'])
        self.assertEqual(self.stop().id, ask.about)   # still `filed`, as the release left it

    def test_a_released_stops_ask_offers_no_thread_in_the_snapshot(self):
        from queue_runner.ask_threads import mark
        ask = self.opened()
        self.r.jobs.released('first', 20)
        asks = [{'id': f'stop-{ask.about}', 'repo': 'first', 'go': {'url': 'u'}}]
        mark(asks, [], self.r.jobs.jobs(), {}, lambda repo: None,
             released=self.r.jobs.released_ids())
        self.assertEqual((asks[0]['decide'], asks[0]['go']), (None, {'url': 'u'}))


class RaceTest(ThreadCase):
    """The Sol lane runs alongside: a stop answered or released after the Claude lane chose its
    ask and before it opened the thread gets no thread (issue #84, PR #67 on 2026-11-16)."""

    def between_choosing_and_opening(self, step):
        opening = self.r.asking.open

        def step_first(*a):   # the other lane's step lands between choose and open
            step()
            return opening(*a)
        self.r.asking.open = step_first

    def test_a_stop_answered_on_github_between_choosing_and_opening_opens_no_thread(self):
        self.noted()
        self.ask_to_open()
        self.gh.comments.setdefault(20, []).append(Comment('stefan1575', td.LATER, 'fix on'))
        self.between_choosing_and_opening(self.r.reviewer.review_pass)
        self.r.run_pass()
        [stop] = self.jobs('stop')
        self.assertEqual(stop.answer, 'replied')        # GitHub's answer counts...
        self.assertEqual(self.jobs('ask'), [])          # ...so no thread should open
        self.assertEqual(self.t3.launches, [])
        self.assertFalse(any('is open for Stefan' in line for line in self.said))
        self.assertTrue(any('answered on GitHub' in line for line in self.said))

    def test_a_stop_released_between_choosing_and_opening_opens_no_thread(self):
        self.noted()
        self.ask_to_open()
        self.between_choosing_and_opening(lambda: self.r.jobs.released('first', 20))
        self.r.run_pass()
        self.assertEqual(self.jobs('ask'), [])
        self.assertEqual(self.t3.launches, [])
        self.assertFalse(any('is open for Stefan' in line for line in self.said))
        self.assertTrue(any('released' in line for line in self.said))
        self.assertIsNone(self.r.asking.next(control.read(self.config.state_dir)))


class SnapshotTest(ThreadCase):
    def snap(self):
        got = inbox.collect(self.config, self.gh, self.r.jobs)
        return snapshot.build(snapshot.Facts(
            now=datetime.datetime.now(datetime.timezone.utc), repos=[self.repo],
            jobs=self.r.jobs.jobs(), inbox=got, switch=control.read(self.config.state_dir)))

    def the_ask(self):
        snap = self.snap()
        [a] = [a for a in snap['asks'] if a['id'] == f'stop-{self.stop().id}']
        return a

    def test_an_open_stop_s_ask_offers_a_thread_and_says_where_it_stands(self):
        self.noted()
        a = self.the_ask()
        issue = 'https://github.com/owner/first/issues/902'
        self.assertEqual((a['decide'], a['also'], a['go']['url']),
                         ({'state': 'offered', 'at': None, 'note': None}, None, issue))
        self.ask_to_open()
        a = self.the_ask()
        self.assertEqual(a['decide']['state'], 'asked')
        self.assertEqual(a['decide']['note'], "It starts on the Claude lane's next pass.")
        control.ask(self.config.state_dir, ['claude'], 'after-job', LATER_NOW)
        self.assertEqual(self.the_ask()['decide']['note'],
                         'It starts when you resume the Claude lane.')
        control.ask(self.config.state_dir, ['claude'], None, LATER_NOW)
        self.r.run_pass()
        a = self.the_ask()
        thread = 'https://app.t3.codes/threads/env/mcp:a1'
        self.assertEqual(a['decide']['state'], 'open')
        self.assertEqual((a['go']['url'], a['go']['where']), (thread, 't3'))
        self.assertEqual((a['also']['url'], a['also']['where']), (issue, 'github'))
        self.assertIn('You opened a thread in T3 to decide it.',
                      [t['text'] for t in a['timeline']])

    def test_answered_in_the_thread_the_ask_moves_to_answered(self):
        ask = self.opened()
        self.says(ask, Message('assistant', decision_reply(
            'fix', add='Stefan chose fix on: fix F7 only.')))
        self.r.plan()   # read and decided; the fix round not started yet
        snap = self.snap()
        self.assertEqual([a['id'] for a in snap['asks'] if a['id'].startswith('stop-')], [])
        [a] = snap['answered']
        self.assertEqual(a['answered']['said'], 'In T3: Stefan chose fix on: fix F7 only')
        self.assertEqual(a['answered']['next'], 'One more fix round on PR #20 is queued.')
        self.assertEqual((a['go']['url'], a['also']['where']), (ask.link, 'github'))
        self.assertIn('You decided in T3.', [t['text'] for t in a['timeline']])

    def test_asks_that_are_not_a_pr_stop_offer_no_thread(self):
        self.noted()
        live = self.r.jobs.started(kind='stop', repo='first', issue=20, branch='claude/red-5',
                                   title='t', sha=td.H2, stop='live')
        self.r.jobs.ended(live.id, exit_code=None, outcome='filed', reason='its live steps')
        asks = {a['id']: a for a in self.snap()['asks']}
        self.assertIsNone(asks[f'stop-{live.id}']['decide'])
        self.assertEqual(asks[f'stop-{self.jobs("stop")[0].id}']['decide']['state'], 'offered')

    def test_decide_and_also_have_the_samples_keys(self):
        from dashboard import sample
        samples = [sample.build(n) for n in sample.STATES]
        decides = [a['decide'] for s in samples for a in s['asks'] if a['decide']]
        alsos = [a['also'] for s in samples for a in s['asks'] if a['also']]
        self.assertEqual({d['state'] for d in decides}, {'open', 'offered'})
        ask = self.opened()
        real = self.the_ask()
        self.assertEqual(set(real['decide']), set.union(*map(set, decides)))
        self.assertEqual(set(real['also']), set.union(*map(set, alsos)))
        self.says(ask, Message('assistant', 'Hmm.'))
        asked = apply_control({}, {'ask': 'ask-qr4', 'open': True}, NOW)
        played = sample.build('many', control=asked,
                              now=datetime.datetime.fromisoformat(NOW) + datetime.timedelta(minutes=1))
        [qr4] = [a for a in played['asks'] if a['id'] == 'ask-qr4']
        self.assertEqual(qr4['decide'], {'state': 'asked', 'at': NOW,
                                         'note': "It starts once Claude's current build ends."})


if __name__ == '__main__':
    unittest.main()
