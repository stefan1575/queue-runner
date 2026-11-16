"""The Inbox's asks (ticket 31): `inbox.collect` read from a temp job log and a fake GitHub, then
written by `snapshot.build` from templates, each one readable cold."""
import datetime
import json
import os
import tempfile
import unittest

from queue_runner import inbox, snapshot
from queue_runner.config import Config, Repo
from queue_runner.github import Checks, Comment, Issue
from queue_runner.state import JobLog
from tests.fakes import FakeGitHubForReviews, full_pr

H1, H2, H3 = 'a' * 40, 'b' * 40, 'c' * 40
GH = 'owner/first'
ISSUE_BODY = ('## Parent\n\n#100\n\n## What to build\n\nWhere each Facade phone rings, typed by '
              'hand since the API can\'t tell us.\n\nEach phone gets a ring-to number.\n')


def decision_json(run_dir, rnd, findings, signals=()):
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, 'decision.json'), 'w', encoding='utf-8') as f:
        json.dump({'round': rnd, 'findings': findings,
                   'signals': [{'signal': s, 'text': t} for s, t in signals]}, f)


def finding(id, cls, status, raised, tag='important'):
    return {'id': id, 'tag': tag, 'class': cls, 'status': status, 'raised': raised}


class AskCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.repo = Repo(name='first', github=GH, path=self.dir, merge='stefan')
        self.config = Config(repos=[self.repo], state_dir=os.path.join(self.dir, 'state'),
                             log_dir=os.path.join(self.dir, 'logs'))
        self.jobs = JobLog(os.path.join(self.dir, 'state', 'jobs.jsonl'))
        self.gh = FakeGitHubForReviews(
            prs=[full_pr(152, 'claude/ring-to-113', H2, title='Ring-to number per Client',
                         body='## Summary\n\nRing-to numbers.\n\nCloses #113')],
            open_issue_list=[Issue(113, 'Ring-to number per Facade phone', ISSUE_BODY),
                             Issue(116, 'Ring-to audit page', 'Blocked by: #113'),
                             Issue(117, 'Something else', 'Blocked by: #99')])

    def job(self, kind, issue, outcome, **fields):
        start = {k: fields.pop(k) for k in ('sha', 'round', 'stop', 'about', 'question',
                                            'branch', 'cause') if k in fields}
        j = self.jobs.started(kind=kind, repo='first', issue=issue,
                              branch=start.pop('branch', 'claude/ring-to-113'),
                              title=f'Queue runner {kind}', **start)
        if outcome is not None:
            self.jobs.ended(j.id, exit_code=None, outcome=outcome, **fields)
        return j

    def review(self, rnd, sha, outcome, findings, signals=()):
        run_dir = os.path.join(self.dir, 'runs', f'r{rnd}')
        decision_json(run_dir, rnd, findings, signals)
        return self.job('review', 152, outcome, sha=sha, round=rnd, run_dir=run_dir,
                        verdict='clean' if outcome == 'clean' else 'blocking',
                        signals=[s for s, _ in signals])

    def built(self):
        self.job('build', 113, 'done', commits=['1', '2', '3'],
                 pr={'number': 152, 'url': 'https://github.com/owner/first/pull/152'})
        self.review(1, H1, 'blocking', [finding('F1', 'Stale owner', 'open', 1),
                                        finding('N1', 'Naming', 'open', 1, tag='nit')])
        self.job('fix', 152, 'pushed', sha=H1, round=1, head=H2, commits=['4', '5'])

    def snap(self):
        got = inbox.collect(self.config, self.gh, self.jobs)
        return snapshot.build(snapshot.Facts(now=datetime.datetime.now(datetime.timezone.utc),
                                             repos=[self.repo], jobs=self.jobs.jobs(),
                                             inbox=got))

    def texts(self, ask):
        return [step['text'] for step in ask['timeline']]


class StuckTest(AskCase):
    def test_a_review_stop_is_stuck_and_reads_cold(self):
        self.built()
        why = 'review 2 on bbbbbbb: F3 repeats the class "Stale owner" of F1, raised in review 1'
        self.review(2, H2, 'stop', [finding('F1', 'Stale owner', 'fixed', 1),
                                    finding('F3', 'Stale owner', 'open', 2)],
                    signals=[('repeated-class', why[19:])])
        stop = self.job('stop', 152, 'filed', sha=H2, stop='review', reason=why,
                        link='https://github.com/owner/first/issues/30')
        [ask] = self.snap()['asks']
        self.assertEqual(ask['id'], f'stop-{stop.id}')
        self.assertEqual((ask['kind'], ask['repo'], ask['ref'], ask['pr'], ask['subject']),
                         ('stuck', 'first', 'PR #152', 152, 'Ring-to number per Client'))
        self.assertEqual(datetime.datetime.fromisoformat(ask['since']),
                         datetime.datetime.fromisoformat(stop.started_at))
        self.assertEqual(ask['situation'],
                         'Review 2 found a kind of problem that a fix round had already fixed.')
        self.assertEqual(ask['about'], "Where each Facade phone rings, typed by hand since the "
                                       "API can't tell us.")
        self.assertEqual(ask['because'], 'Review 2 on bbbbbbb: F3 repeats the class "Stale '
                                         'owner" of F1, raised in review 1. Open now: F3, Stale '
                                         'owner.')
        self.assertEqual(self.texts(ask), [
            'Claude built #113 and opened PR #152, in 3 commits.',
            'Review 1 on aaaaaaa found 1 problem: Stale owner.',
            'A fix round pushed 2 commits, moving the PR from aaaaaaa to bbbbbbb.',
            'Review 2 on bbbbbbb found 1 problem: Stale owner.',
            'The runner stopped the PR and brought it to you, on needs-info issue #30.',
        ])
        self.assertEqual(ask['holds_up'], ['#116 Ring-to audit page'])
        self.assertEqual(ask['go'], {'label': 'Open the needs-info issue', 'where': 'github',
                                     'url': 'https://github.com/owner/first/issues/30'})
        self.assertTrue(ask['question'].endswith('?'))
        self.assertEqual([o['say'] for o in ask['options']], ['a reply', 'hold',
                                                              'close the issue'])

    def test_an_approach_note_offers_rework_fix_on_and_hold_with_the_recommendation_marked(self):
        self.built()
        self.review(2, H2, 'blocking', [finding('F2', 'Stale cache', 'open', 2)])
        self.job('fix', 152, 'pushed', sha=H2, round=2, head=H3, commits=['6'])
        self.gh.prs = [full_pr(152, 'claude/ring-to-113', H3, title='Ring-to number per Client',
                               body='Closes #113')]
        r3 = self.review(3, H3, 'approach-note', [finding('F2', 'Stale cache', 'open', 2)])
        why = ('review 3 on ccccccc is still blocking; the Approach note recommends fix on: '
               'reply rework, fix on or hold')
        self.job('decision', 152, 'approach-note', sha=H3, about=r3.id, question='approach-note',
                 reason=why, link='https://github.com/owner/first/pull/152#issuecomment-1')
        self.gh.comments[152] = [Comment('stefan1575', '2026-11-10T14:00:00Z', (
            '## Approach note\n\n**The cache is read before the write lands.** Keep the approach '
            'and read it `after` the write.\n\n- **Review 1 (F1):** the same.\n\n'
            '**Recommendation:** fix on.\n\n'
            f'<!-- queue-runner approach-note sha={H3} round=3 -->\n'))]
        self.job('stop', 152, 'filed', sha=H3, stop='approach-note', reason=why,
                 link='https://github.com/owner/first/issues/31')
        [ask] = self.snap()['asks']
        self.assertEqual(ask['kind'], 'stuck')
        self.assertEqual(ask['situation'], 'Review 3 is still blocking after 2 fix rounds, so it '
                                           'came to you with an approach note.')
        self.assertEqual(ask['because'], 'Review 3 on ccccccc is still blocking. The approach note '
                                         'says: The cache is read before the write lands. Keep '
                                         'the approach and read it after the write. Open now: '
                                         'F2, Stale cache.')
        self.assertEqual([(o['say'], o.get('recommended', False)) for o in ask['options']],
                         [('rework', False), ('fix on', True), ('hold', False)])
        self.assertEqual(self.texts(ask)[-3:], [
            'Review 3 on ccccccc found no new problem, but 1 kind is still open: Stale cache.',
            'A decision thread wrote an approach note; it recommends fix on.',
            'The runner stopped the PR and brought it to you, on needs-info issue #31.'])

    def test_an_approach_note_with_no_fix_round_logged_says_none_and_comes_before_its_stop(self):
        from unittest import mock
        with mock.patch('queue_runner.state._now', lambda: '2026-11-10T22:10:00+08:00'):
            r3 = self.review(3, H2, 'approach-note', [finding('F2', 'Stale cache', 'open', 2)])
        why = 'review 3 on bbbbbbb is still blocking; the Approach note recommends hold: reply'
        with mock.patch('queue_runner.state._now', lambda: '2026-11-10T22:13:59+08:00'):
            d = self.jobs.started(kind='decision', repo='first', issue=152, branch=None, title='d',
                                  sha=H2, about=r3.id, question='approach-note')
        with mock.patch('queue_runner.state._now', lambda: '2026-11-10T22:14:52+08:00'):
            self.job('stop', 152, 'filed', sha=H2, stop='approach-note', reason=why)
        with mock.patch('queue_runner.state._now', lambda: '2026-11-10T22:15:01+08:00'):
            self.jobs.ended(d.id, exit_code=0, outcome='approach-note', reason=why)
        [ask] = self.snap()['asks']
        self.assertEqual(ask['situation'], 'Review 3 is still blocking, so it came to you.')
        self.assertEqual(self.texts(ask)[-2:], [
            'A decision thread wrote an approach note; it recommends hold.',
            'The runner stopped the PR and brought it to you.'])

    def test_it_holds_up_what_githubs_dependencies_say_and_what_blocked_by_lines_name(self):
        self.gh.blocks = {113: [Issue(118, 'Native one', ''), Issue(116, 'Ring-to audit page', '')]}
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed')
        [ask] = self.snap()['asks']
        self.assertEqual(ask['holds_up'], ['#116 Ring-to audit page', '#118 Native one'])


class KindsCase(AskCase):
    def setUp(self):
        super().setUp()
        self.gh.prs += [full_pr(153, 'claude/global-115', H3, title='Global recipients',
                                body='Closes #115'),
                        full_pr(154, 'claude/twilio-120', H1, title='Twilio links')]
        self.gh.open_issue_list += [
            Issue(115, 'Global recipients', '## What to build\n\nOne list of recipients.'),
            Issue(130, 'Onboarding form', 'A form a new Client fills in.\n\nBlocked by: #129'),
            Issue(131, 'Welcome email', 'Blocked by: #130')]
        self.gh.issue_bodies[(GH, 129)] = Issue(129, 'Monthly report', 'An email each month.')

    def ready(self):
        """PR #153 reviewed clean on its head and marked ready for Stefan."""
        self.job('build', 115, 'done', branch='claude/global-115', commits=['1'],
                 pr={'number': 153})
        self.gh.comments[153] = [Comment('stefan1575', '2026-11-10T14:00:00Z',
                                         f'<!-- sol-pr-review round=1 verdict=clean sha={H3} -->')]
        self.job('review', 153, 'clean', branch='claude/global-115', sha=H3, round=1,
                 verdict='clean')
        self.job('ready', 153, 'marked', branch='claude/global-115', sha=H3)


class KindsTest(KindsCase):
    def test_ready_for_stefan_is_a_merge(self):
        self.ready()
        [ask] = self.snap()['asks']
        self.assertEqual((ask['kind'], ask['ref'], ask['subject'], ask['about']),
                         ('merge', 'PR #153', 'Global recipients', 'One list of recipients.'))
        self.assertEqual(ask['situation'], 'This PR is reviewed clean and ready for you to merge.')
        self.assertEqual(ask['because'], 'Clean on ccccccc after review 1, checks passed, no '
                                         'conflict, nothing said since. In first the merge is '
                                         'yours.')
        self.assertEqual(ask['go'], {'label': 'Open PR to merge', 'where': 'github',
                                     'url': 'https://github.com/owner/first/pull/153'})
        self.assertEqual(self.texts(ask), [
            'Claude built #115 and opened PR #153, in 1 commit.',
            'Review 1 on ccccccc came back clean.',
            'The runner marked it ready for you to merge.'])

    def test_a_build_a_decision_left_to_stefan_and_a_waiting_thread_are_decisions(self):
        build = self.job('build', 129, 'failed', branch='claude/monthly-129',
                         error='The Resend key is missing.')
        self.job('decision', 129, 'stop', about=build.id, question='failed',
                 reason='should the report wait for the new Resend key?')
        waiting = self.job('build', 130, 'waiting', branch='claude/onboarding-130',
                           link='https://app.t3.codes/threads/t130')
        self.job('decision', 130, 'stop', about=waiting.id, question='waiting',
                 reason='must every Client fill in the form before they go live?')
        built, thread = self.snap()['asks']
        self.assertEqual((built['kind'], built['ref'], built['pr'], built['subject']),
                         ('decision', '#129', None, 'Monthly report'))
        self.assertEqual(built['situation'], 'The build of #129 failed, and a decision thread '
                                             'left it to you.')
        self.assertEqual(built['because'], "The build ended failed: The Resend key is missing. "
                                           "A decision thread couldn't settle what to do.")
        self.assertEqual(built['question'], 'Should the report wait for the new Resend key?')
        self.assertEqual(built['go']['url'], 'https://github.com/owner/first/issues/129')
        self.assertEqual(self.texts(built), [
            'The build of #129 failed: The Resend key is missing.',
            "A decision thread couldn't settle what to do, so it came to you."])
        self.assertEqual((thread['kind'], thread['ref'], thread['subject'], thread['about']),
                         ('decision', '#130', 'Onboarding form', 'A form a new Client fills in.'))
        self.assertEqual(thread['question'],
                         'Must every Client fill in the form before they go live?')
        self.assertEqual(thread['go'], {'label': 'Answer in T3', 'where': 't3',
                                        'url': 'https://app.t3.codes/threads/t130'})
        self.assertEqual(thread['holds_up'], ['#131 Welcome email'])
        self.assertEqual(self.texts(thread), [
            'The build of #130 stopped to ask a question.',
            "A decision thread couldn't answer the thread's question, so it came to you."])

    def test_a_failed_check_and_a_stopped_live_run_are_broken(self):
        self.gh.check_states[H1] = Checks('failed', ('test',))
        self.job('stop', 154, 'filed', branch='claude/twilio-120', sha=H1, stop='failed-check',
                 reason='a check failed on aaaaaaa (test)',
                 link='https://github.com/owner/first/issues/40')
        self.job('live', 150, 'stop', branch=None, sha=H2, head=H3, prs=[150],
                 reason='Migration 2 failed: column "owner_id" already exists')
        merged, listed = full_pr(150, 'claude/notes-110', H2, title='Caller notes'), self.gh.pull
        self.gh.pull = lambda repo, n: merged if n == 150 else listed(repo, n)   # not open
        self.job('stop', 150, 'filed', branch='claude/notes-110', sha=H2, stop='live',
                 reason='the live steps stopped: Migration 2 failed',
                 link='https://github.com/owner/first/issues/41')
        asks = {a['ref']: a for a in self.snap()['asks']}
        check, live = asks['PR #154'], asks['PR #150']
        self.assertEqual((check['kind'], check['situation']),
                         ('broken', 'A check failed on aaaaaaa.'))
        self.assertEqual(check['because'], 'A check failed on aaaaaaa (test).')
        self.assertEqual(self.texts(check), [
            'A check failed on aaaaaaa, so the runner stopped the PR and brought it to you, on '
            'needs-info issue #40.'])
        self.assertEqual((live['kind'], live['subject']), ('broken', 'Caller notes'))
        self.assertEqual(live['situation'], 'PR #150 is merged, but its live steps stopped before '
                                            'it went live.')
        self.assertEqual(live['holds_up'], ['Every later live run in first'])
        self.assertEqual(self.texts(live), [
            'Its live steps stopped at a question: Migration 2 failed: column "owner_id" already '
            'exists.',
            'Its live steps stopped, so the runner stopped the PR and brought it to you, on '
            'needs-info issue #41.'])

    def test_broken_then_stuck_then_decision_then_merge_oldest_first_inside_a_kind(self):
        self.ready()
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed')
        waiting = self.job('build', 130, 'waiting', branch='claude/onboarding-130', link='t3')
        self.job('decision', 130, 'stop', about=waiting.id, question='waiting', reason='which?')
        self.job('stop', 154, 'filed', branch='claude/twilio-120', sha=H1, stop='conflict',
                 reason='it conflicts with main at aaaaaaa')
        self.job('stop', 154, 'filed', branch='claude/twilio-120', sha=H1, stop='failed-check',
                 reason='a check failed on aaaaaaa (test)')
        got = [(a['kind'], a['ref']) for a in self.snap()['asks']]
        self.assertEqual(got, [('broken', 'PR #154'), ('stuck', 'PR #152'), ('stuck', 'PR #154'),
                               ('decision', '#130'), ('merge', 'PR #153')])

    def test_inside_a_kind_the_one_waiting_longest_comes_first(self):
        from unittest import mock
        with mock.patch('queue_runner.state._now', lambda: '2026-11-12T10:00:00+08:00'):
            self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed')
        with mock.patch('queue_runner.state._now', lambda: '2026-11-11T10:00:00+08:00'):
            self.job('stop', 154, 'filed', branch='claude/twilio-120', sha=H1, stop='conflict',
                     reason='it conflicts with main at aaaaaaa')
        self.assertEqual([a['ref'] for a in self.snap()['asks']], ['PR #154', 'PR #152'])


class AnsweredTest(AskCase):
    def answered(self, answer):
        self.built()
        self.review(2, H2, 'stop', [finding('F3', 'Stale owner', 'open', 2)])
        stop = self.job('stop', 152, 'filed', sha=H2, stop='review', reason='review 2 stopped',
                        link='https://github.com/owner/first/issues/30')
        self.jobs.ended(stop.id, exit_code=None, outcome='answered', reason='review 2 stopped',
                        link='https://github.com/owner/first/issues/30', answer=answer)
        return stop

    def test_a_reply_is_answered_until_the_runner_has_acted_on_it(self):
        stop = self.answered('replied')
        self.gh.comments[152] = [Comment('stefan1575', '2099-01-01T00:00:00Z',
                                         'fix on, and keep the cache\n\nMore words.')]
        snap = self.snap()
        self.assertEqual(snap['asks'], [])
        [a] = snap['answered']
        self.assertEqual((a['id'], a['kind'], a['ref']), (f'stop-{stop.id}', 'stuck', 'PR #152'))
        self.assertEqual(a['answered']['said'], 'fix on, and keep the cache')
        self.assertEqual(datetime.datetime.fromisoformat(a['answered']['at']),
                         datetime.datetime.fromisoformat(self.jobs.on('stop', 'first', 152)[0]
                                                         .ended_at))
        self.assertEqual(a['answered']['next'], 'The runner reads your reply on its next pass: a '
                                                'decision on it comes first.')
        self.assertEqual(self.texts(a)[-1], 'You replied.')
        decision = self.job('decision', 152, 'fix', sha=H2, about=stop.id, question='reply',
                            reason='fix on')
        [a] = self.snap()['answered']
        self.assertEqual(a['answered']['next'], 'One more fix round on PR #152 is queued.')
        self.assertEqual(self.texts(a)[-1], 'A decision on your reply ordered one more fix round.')
        fix = self.job('fix', 152, None, sha=H2, round=2)
        self.assertEqual(len(self.snap()['answered']), 1)   # the fix round runs
        self.jobs.ended(fix.id, exit_code=0, outcome='pushed', head=H3, commits=['7'])
        self.assertEqual(self.snap()['answered'], [])
        self.assertTrue(decision)

    def test_a_closed_issue_is_answered_until_the_next_job_on_the_pr_ends(self):
        self.answered('issue-closed')
        [a] = self.snap()['answered']
        self.assertEqual(a['answered']['said'], 'closed #30')
        self.assertEqual(a['answered']['next'], 'The PR is back in the loop: the runner takes it '
                                                'up on its next pass.')
        self.assertEqual(self.texts(a)[-1], 'You closed needs-info issue #30.')
        self.job('review', 152, 'clean', sha=H2, round=3, verdict='clean')
        self.assertEqual(self.snap()['answered'], [])


class GitHubDownTest(AskCase):
    def test_the_last_asks_stay_and_the_github_source_says_since_when_and_what_it_affects(self):
        times = iter([datetime.datetime(2026, 11, 15, 4, 0, tzinfo=datetime.timezone.utc),
                      datetime.datetime(2026, 11, 15, 4, 5, tzinfo=datetime.timezone.utc)])
        reader = inbox.Reader(self.config, self.gh, self.jobs, clock=lambda: next(times))
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed',
                 link='https://github.com/owner/first/issues/30')
        reader.read()
        self.gh.fail.add('open_issues')
        got = reader.read()
        self.assertEqual([(w.title, w.number) for w in got.items],
                         [('Ring-to number per Client', 152)])   # as the last good read had it
        snap = snapshot.build(snapshot.Facts(
            now=datetime.datetime(2026, 11, 15, 4, 6, tzinfo=datetime.timezone.utc),
            repos=[self.repo], jobs=self.jobs.jobs(), inbox=reader.last(),
            inbox_stale=reader.stale(),
            calls={'github': snapshot.Call(datetime.datetime(2026, 11, 15, 4, 5,
                                                             tzinfo=datetime.timezone.utc),
                                           True, None, None)}))
        [ask] = snap['asks']
        self.assertEqual(ask['subject'], 'Ring-to number per Client')
        github = next(s for s in snap['sources'] if s['id'] == 'github')
        self.assertFalse(github['ok'])
        self.assertEqual(datetime.datetime.fromisoformat(github['checked_at']),
                         datetime.datetime(2026, 11, 15, 4, 0, tzinfo=datetime.timezone.utc))
        self.assertIn('gh failed', github['note'])
        self.assertEqual(github['affects'], "The Inbox is as GitHub last showed it for first: an "
                                            "ask since then may be missing, and one you answered "
                                            "may still be listed.")
        self.gh.fail.clear()   # GitHub back: the next read is whole again
        times2 = iter([datetime.datetime(2026, 11, 15, 4, 10, tzinfo=datetime.timezone.utc)])
        reader.clock = lambda: next(times2)
        reader.read()
        self.assertEqual(reader.stale(), {})


class PartialReadTest(AskCase):
    """GitHub failing part-way through one ask (review 1's F6): that ask is the last good read's,
    and the Inbox says it's stale; the asks read whole are this read's."""

    def reader(self):
        times = iter([datetime.datetime(2026, 11, 15, 4, k, tzinfo=datetime.timezone.utc)
                      for k in (0, 5, 10)])
        return inbox.Reader(self.config, self.gh, self.jobs, clock=lambda: next(times))

    def test_a_failing_dependency_read_keeps_the_last_ask_and_marks_the_inbox_stale(self):
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed',
                 link='https://github.com/owner/first/issues/30')
        reader = self.reader()
        before = reader.read()
        self.assertEqual(before.items[0].title, 'Ring-to number per Client')
        self.assertEqual(before.items[0].holds_up, ((116, 'Ring-to audit page'),))

        def fail(repo, number):
            raise RuntimeError('HTTP 503')
        self.gh.blocking = fail
        after = reader.read()
        self.assertTrue(after.errors)
        self.assertEqual(after.items[0], before.items[0])
        when, error = reader.stale()['first']
        self.assertEqual(when, datetime.datetime(2026, 11, 15, 4, 0, tzinfo=datetime.timezone.utc))
        self.assertIn('HTTP 503', error)
        del self.gh.blocking   # back: the next read is whole, and fresh
        reader.read()
        self.assertEqual(reader.stale(), {})

    def test_only_the_ask_that_failed_is_the_last_reads_the_others_are_this_reads(self):
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed',
                 link='https://github.com/owner/first/issues/30')
        reader = self.reader()
        reader.read()
        # Since then: PR #152 renamed, and a new stop on PR #160, which holds nothing up.
        self.gh.prs = [full_pr(152, 'claude/ring-to-113', H2, title='Ring-to, renamed',
                               body='Closes #113'),
                       full_pr(160, 'claude/other-120', H3, title='Other')]
        self.job('stop', 160, 'filed', sha=H3, stop='no-push', reason='nothing pushed',
                 branch='claude/other-120', link='https://github.com/owner/first/issues/31')

        def fail(repo, number):
            raise RuntimeError('HTTP 503')
        self.gh.blocking = fail   # only #152 closes an issue, so only its read fails
        got = reader.read()
        self.assertEqual([(w.number, w.title) for w in got.items],
                         [(152, 'Ring-to number per Client'), (160, 'Other')])
        self.assertIn('first', reader.stale())

    def test_with_no_good_read_yet_the_bare_ask_is_listed_and_stale(self):
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed',
                 link='https://github.com/owner/first/issues/30')

        def fail(repo, number):
            raise RuntimeError('HTTP 503')
        self.gh.blocking = fail
        reader = self.reader()
        got = reader.read()
        self.assertEqual([w.number for w in got.items], [152])
        self.assertEqual(reader.stale()['first'][0], None)

    def test_a_deleted_issue_is_the_asks_own_state_not_a_failing_read(self):
        from queue_runner.github import GhError
        self.job('stop', 152, 'filed', sha=H2, stop='no-push', reason='nothing pushed',
                 link='https://github.com/owner/first/issues/30')

        def gone(repo, number):
            raise GhError('gh api repos/owner/first/issues/113/dependencies/blocking failed '
                          '(1): gh: Not Found (HTTP 404)')
        self.gh.blocking = gone
        reader = self.reader()
        got = reader.read()
        self.assertEqual([w.number for w in got.items], [152])
        self.assertTrue(got.errors)   # said
        self.assertEqual(reader.stale(), {})   # and GitHub isn't red for it every pass

    def test_an_answered_ask_that_fails_part_way_keeps_its_last_read_too(self):
        stop = self.job('stop', 152, 'answered', sha=H2, stop='no-push', reason='nothing pushed',
                        link='https://github.com/owner/first/issues/30', answer='replied')
        self.gh.comments[152] = [Comment('stefan1575', '2099-01-01T00:00:00Z', 'Fix on, please.')]
        reader = self.reader()
        before = reader.read()
        self.assertEqual([w.job.id for w in before.answered], [stop.id])
        self.assertEqual(before.answered[0].said, 'Fix on, please.')

        def fail(repo, number):
            raise RuntimeError('HTTP 503')
        self.gh.blocking = fail
        after = reader.read()
        self.assertEqual(after.answered[0], before.answered[0])
        self.assertIn('first', reader.stale())


class ContractTest(KindsCase):
    """A real ask of each kind has the sample ask's keys, and so do its parts."""

    def test_a_real_ask_of_each_kind_has_the_sample_asks_keys(self):
        from dashboard import sample
        self.ready()                                                      # merge
        self.job('stop', 152, 'filed', sha=H2, stop='review', reason='review 2 stopped',
                 link='https://github.com/owner/first/issues/30')        # stuck
        self.job('stop', 154, 'filed', branch='claude/twilio-120', sha=H1, stop='failed-check',
                 reason='a check failed', link='https://github.com/owner/first/issues/40')
        waiting = self.job('build', 130, 'waiting', branch='claude/onboarding-130', link='t3')
        self.job('decision', 130, 'stop', about=waiting.id, question='waiting', reason='which?')
        self.gh.prs.append(full_pr(155, 'claude/other-121', 'd' * 40, title='Other'))
        stop = self.job('stop', 155, 'filed', branch='claude/other-121', sha='d' * 40,
                        stop='no-push', reason='old',
                        link='https://github.com/owner/first/issues/50')
        self.jobs.ended(stop.id, exit_code=None, outcome='answered', reason='old', answer='replied',
                        link='https://github.com/owner/first/issues/50')
        snap = self.snap()
        self.assertEqual({a['kind'] for a in snap['asks']},
                         {'merge', 'stuck', 'broken', 'decision'})
        self.assertEqual(len(snap['answered']), 1)
        samples = [s for s in (sample.build(name) for name in sample.STATES) if s['asks'] is not None]

        def holds(real, pick, what):
            sets = [set(d) for s in samples for d in pick(s)]
            must, may = set.intersection(*sets), set.union(*sets) - {'why', 'story'}
            for d in real:
                with self.subTest(what=what, kind=d.get('kind')):
                    self.assertLessEqual(must - {'why', 'story'}, set(d))
                    self.assertLessEqual(set(d), may)
        every = snap['asks'] + snap['answered']
        holds(snap['asks'], lambda s: s['asks'], 'an ask')
        holds(snap['answered'], lambda s: s['answered'], 'an answered ask')
        holds([a['answered'] for a in snap['answered']],
              lambda s: [a['answered'] for a in s['answered']], 'its answer')
        holds([a['go'] for a in every], lambda s: [a['go'] for a in s['asks']], 'its go')
        holds([t for a in every for t in a['timeline']],
              lambda s: [t for a in s['asks'] for t in a['timeline']], 'a step')
        holds([o for a in every for o in a['options']],
              lambda s: [o for a in s['asks'] for o in a.get('options', [])], 'an option')
        for a in every:   # the ticket's keys, every one
            self.assertLessEqual({'id', 'kind', 'repo', 'ref', 'pr', 'subject', 'since',
                                  'situation', 'about', 'because', 'timeline', 'question',
                                  'options', 'holds_up', 'go'}, set(a))
            self.assertTrue(all(isinstance(h, str) for h in a['holds_up']))
        json.dumps(snap)


if __name__ == '__main__':
    unittest.main()
