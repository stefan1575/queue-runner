"""Screenshot findings in the review loop: a review blocking only on screenshots is no strike
against the approach (game-backdrop #14: reviews 4 to 6 each stopped for Stefan on screenshots
alone, with no code changed), and screenshots only Stefan can take go straight to him
(game-backdrop #20: a UAC prompt)."""
import unittest

from queue_runner.ledger import (SHOT_ROUNDS, decide, escalation, next_round, read_reviews,
                                 shot_kind)
from tests.test_ledger import H1, H2, N, REPO, comment, important, old_marker, reply

SHA = 'd' * 40


def shot(fid, kind='missing', cls='visible change lacks before and after screenshots'):
    return {**important(fid, cls=cls, file='src/Tray.cs', line=94, scenario='',),
            'cost': 'the visible states cannot be checked', 'rule': 'a visible change needs '
            'screenshots', 'screenshots': kind}


def history(*reviews):
    """The PR's comments after reviews 1..n, each [(finding, status)], findings raised in the
    review that first lists them."""
    out, raised = [], {}
    for rnd, found in enumerate(reviews, 1):
        state_ = []
        for f, status in found:
            raised.setdefault(f['id'], rnd)
            state_.append({**f, 'status': status, 'raised': raised[f['id']]})
        verdict = 'blocking' if any(f['tag'] == 'important' and s == 'open'
                                    for f, s in found) else 'clean'
        out.append(comment(f'## Sol review {rnd} · {verdict.capitalize()}\n\n'
                           + old_marker(rnd, verdict, H1 if rnd % 2 else H2, state_),
                           at=f'2026-11-18T0{rnd}:00:00Z'))
    return out


def decide_on(comments, reply_text):
    earlier = read_reviews(comments)
    return decide(REPO, N, SHA, next_round(earlier), earlier, False, reply_text)


CODE = important('F1')           # a real defect, fixed in review 2


class ScreenshotRoundsTest(unittest.TestCase):
    def test_review_4_blocking_only_on_missing_screenshots_goes_back_to_a_fix_round(self):
        # #14's shape: a real class fixed, then review 4 asks for screenshots and nothing else.
        comments = history([(CODE, 'open')], [(CODE, 'open')], [(CODE, 'open')])
        d = decide_on(comments, reply(findings=[shot('F9')],
                                      earlier=[{'id': 'F1', 'status': 'fixed'}]))
        self.assertEqual((d['verdict'], d['outcome'], d['signals']), ('blocking', 'fix', []))
        self.assertIn('no strike against the approach', d['body'])

    def test_a_code_finding_beside_the_screenshots_still_gets_the_approach_note(self):
        comments = history([(CODE, 'open')], [(CODE, 'open')])
        d = decide_on(comments, reply(findings=[shot('F9')],
                                      earlier=[{'id': 'F1', 'status': 'open'}]))
        self.assertEqual(d['outcome'], 'approach-note')

    def test_screenshot_rounds_in_a_row_are_capped(self):
        # Reviews 3 to 5 blocked on screenshots alone; review 6 still does: past the cap.
        rounds = [[(CODE, 'open')], [(CODE, 'fixed')]]
        rounds += [[(CODE, 'fixed'), (shot('F9'), 'open')]] * SHOT_ROUNDS
        d = decide_on(history(*rounds), reply(earlier=[{'id': 'F9', 'status': 'open'}]))
        self.assertEqual(d['outcome'], 'approach-note')
        # one fewer in a row is still a fix round
        d = decide_on(history(*rounds[:-1]), reply(earlier=[{'id': 'F9', 'status': 'open'}]))
        self.assertEqual(d['outcome'], 'fix')

    def test_a_new_screenshot_finding_in_an_earlier_screenshot_class_is_no_repeat(self):
        # Review 5 accepts F9's shots and asks for another state's: same class, new ID.
        comments = history([(CODE, 'open')], [(CODE, 'fixed')],
                           [(CODE, 'fixed'), (shot('F9'), 'open')])
        d = decide_on(comments, reply(findings=[shot('F10')],
                                      earlier=[{'id': 'F9', 'status': 'fixed'}]))
        self.assertEqual((d['outcome'], d['signals']), ('fix', []))

    def test_screenshots_only_stefan_can_take_go_to_him_at_once(self):
        d = decide_on([], reply(findings=[shot('F1', kind='owed')]))
        self.assertEqual(d['outcome'], 'stop')
        [s] = d['signals']
        self.assertEqual((s['signal'], s['ids']), ('screenshots-owed', ['F1']))
        self.assertIn('only Stefan', s['text'])

    def test_owed_screenshots_wait_while_a_code_finding_is_open(self):
        d = decide_on([], reply(findings=[shot('F1', kind='owed'), important('F2')]))
        self.assertEqual(d['outcome'], 'fix')

    def test_the_ledger_records_the_kind_and_the_next_review_reads_it(self):
        d = decide_on([], reply(findings=[shot('F1')]))
        [r] = read_reviews([comment(d['body'])])
        self.assertEqual(r['findings'][0]['screenshots'], 'missing')

    def test_sol_writing_true_means_missing(self):
        self.assertEqual([shot_kind(v) for v in (True, 'yes', 'Owed', '', None, False)],
                         ['missing', 'missing', 'owed', '', '', ''])


class EarlierClassificationTest(unittest.TestCase):
    """Sol classifies a finding it already raised in the block's `earlier` list, since it must
    not list an open finding again in `findings` (templates/review.md, review.py's brief)."""

    def test_a_missing_finding_found_owed_later_stops_for_stefan(self):
        comments = history([(shot('F1'), 'open')])
        d = decide_on(comments, reply(earlier=[{'id': 'F1', 'status': 'open',
                                                'screenshots': 'owed'}]))
        self.assertEqual(d['outcome'], 'stop')
        self.assertEqual([s['signal'] for s in d['signals']], ['screenshots-owed'])

    def test_a_legacy_screenshot_finding_classified_missing_at_review_4_gets_a_fix_round(self):
        legacy = {k: v for k, v in shot('F9').items() if k != 'screenshots'}
        comments = history([(CODE, 'open')], [(CODE, 'fixed')],
                           [(CODE, 'fixed'), (legacy, 'open')])
        d = decide_on(comments, reply(earlier=[{'id': 'F9', 'status': 'open',
                                                'screenshots': 'missing'}]))
        self.assertEqual((d['outcome'], d['signals']), ('fix', []))

    def test_an_owed_reason_that_no_longer_holds_turns_missing_and_the_ledger_keeps_it(self):
        comments = history([(shot('F1', kind='owed'), 'open')])
        d = decide_on(comments, reply(earlier=[{'id': 'F1', 'status': 'open',
                                                'screenshots': 'missing'}]))
        self.assertEqual((d['outcome'], d['signals']), ('fix', []))
        [r] = read_reviews([comment(d['body'])])
        self.assertEqual(r['findings'][0]['screenshots'], 'missing')

    def test_an_earlier_entry_without_screenshots_keeps_the_kind(self):
        comments = history([(shot('F1', kind='owed'), 'open')])
        d = decide_on(comments, reply(earlier=[{'id': 'F1', 'status': 'open'}]))
        self.assertEqual([s['signal'] for s in d['signals']], ['screenshots-owed'])


class EscalationTest(unittest.TestCase):
    """The fix lane reads the same routing from the ledgers alone (`ledger.escalation`)."""

    def test_screenshots_only_at_review_4_gets_a_fix_round(self):
        comments = history([(CODE, 'open')], [(CODE, 'open')], [(CODE, 'fixed')],
                           [(CODE, 'fixed'), (shot('F9'), 'open')])
        self.assertIsNone(escalation(read_reviews(comments)))

    def test_owed_screenshots_go_to_stefan(self):
        comments = history([(shot('F1', kind='owed'), 'open')])
        self.assertIn('only Stefan', escalation(read_reviews(comments)))

    def test_code_still_blocking_at_review_3_is_an_approach_note(self):
        comments = history([(CODE, 'open')], [(CODE, 'open')], [(CODE, 'open')])
        self.assertIn('Approach note', escalation(read_reviews(comments)))


if __name__ == '__main__':
    unittest.main()
