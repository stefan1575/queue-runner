"""The review ledger: earlier reviews read from a PR's comments, and decide(), which works out a
review's verdict and outcome from Sol's sol-findings block, never from its prose."""
import base64
import json
import unittest

from queue_runner.github import Comment
from queue_runner.ledger import SolFailed, decide, next_round, read_reviews, state

REPO, N = 'owner/repo', 7
H1, H2, H3 = 'a' * 40, 'b' * 40, 'c' * 40


def old_marker(rnd, verdict, sha, findings):
    data = base64.b64encode(json.dumps(findings).encode()).decode()
    return f'<!-- sol-pr-review round={rnd} verdict={verdict} sha={sha} findings={data} tokens=0 -->'


def comment(body, at='2026-11-06T00:00:00Z', author='stefan1575'):
    return Comment(author=author, created_at=at, body=body)


def reply(findings=(), earlier=None, prose='Looks fine.'):
    data = {'findings': list(findings)}
    if earlier is not None:
        data['earlier'] = earlier
    return f'{prose}\n\n```sol-findings\n{json.dumps(data)}\n```\n'


def important(fid, cls='write logged wrongly', file='src/a.ts', line=10,
              scenario='this input, that wrong result'):
    return {'id': fid, 'tag': 'important', 'class': cls, 'file': file, 'line': line,
            'scenario': scenario}


def nit(fid):
    return {'id': fid, 'tag': 'nit', 'class': 'naming', 'file': 'src/a.ts', 'line': 1}


def review1(findings, verdict='blocking', sha=H1):
    """The PR's comments after the old script's review 1 raised `findings` (each open)."""
    state_ = [{**f, 'status': 'open', 'raised': 1} for f in findings]
    return [comment(f'## Sol review 1 · {verdict.capitalize()}\n\n...\n\n'
                    + old_marker(1, verdict, sha, state_))]


class ReadReviewsTest(unittest.TestCase):
    def test_reads_the_old_scripts_marker_with_its_base64_findings(self):
        comments = [comment('Opened.'), *review1([important('F1')])]
        [r] = read_reviews(comments)
        self.assertEqual((r['round'], r['verdict'], r['sha']), (1, 'blocking', H1))
        self.assertEqual([f['id'] for f in r['findings']], ['F1'])

    def test_reads_a_hand_run_review_with_its_visible_ledger(self):
        # PR #168's format: posted by Sol itself from a T3 child, 2026-11-06.
        body = (f'<!-- sol-review round=1 head={H1} -->\n## Sol review 1 · Blocking\n\nProse.\n\n'
                '```sol-findings\n' + json.dumps({'round': 1, 'head': H1, 'findings': [
                    {**important('F1'), 'status': 'open'}]}) + '\n```\n')
        [r] = read_reviews([comment(body)])
        self.assertEqual((r['round'], r['verdict'], r['sha']), (1, 'blocking', H1))
        [f] = state([r])
        self.assertEqual((f['id'], f['status'], f['raised']), ('F1', 'open', 1))

    def test_a_failed_review_and_other_comments_are_not_reviews(self):
        comments = [comment('## Sol review failed\n\nNo block.\n\n<!-- sol-pr-review failed -->'),
                    comment('Thanks!')]
        self.assertEqual(read_reviews(comments), [])
        self.assertEqual(next_round([]), 1)

    def test_a_review_whose_ledger_cant_be_read_isnt_counted(self):
        # Sol review F1: it replaced the PR's state with no findings, so F1 was lost.
        hand = (f'<!-- sol-review round=2 head={H2} -->\n## Sol review 2 · Clean\n\n'
                '```sol-findings\n{"findings": [oops\n```\n')
        corrupt = '<!-- sol-pr-review round=2 verdict=clean sha=' + H2 + ' findings=!!notbase64 -->'
        empty = '<!-- sol-pr-review round=2 verdict=clean sha=' + H2 + ' findings= tokens=0 -->'
        for bad in (hand, f'<!-- sol-review round=2 head={H2} -->\nNo block.', corrupt, empty):
            with self.subTest(bad=bad[:40]):
                earlier = read_reviews([*review1([important('F1')]), comment(bad)])
                self.assertEqual([r['round'] for r in earlier], [1])
                self.assertEqual([f['id'] for f in state(earlier)], ['F1'])

    def test_a_marker_from_before_findings_were_recorded_counts_with_none(self):
        # The old script's markers before 2026-11-05 (leads-dashboard #139) end at sha=, e.g. #88.
        [r] = read_reviews([comment(f'<!-- sol-pr-review round=1 verdict=clean sha={H1} -->')])
        self.assertEqual((r['round'], r['findings']), (1, []))

    def test_numbering_carries_on_from_the_newest_review(self):
        comments = [*review1([important('F1')]),
                    comment('## Sol review 2 · Clean\n\n' + old_marker(2, 'clean', H2, []))]
        self.assertEqual(next_round(read_reviews(comments)), 3)

    def test_an_old_marker_without_statuses_counts_pre_existing_as_filed(self):
        body = old_marker(1, 'blocking', H1, [important('F1'),
                                             {'id': 'F2', 'tag': 'pre-existing', 'class': 'x'}])
        found = {f['id']: f['status'] for f in state(read_reviews([comment(body)]))}
        self.assertEqual(found, {'F1': 'open', 'F2': 'filed'})


class DecideTest(unittest.TestCase):
    def decide(self, reply_text, earlier=(), rnd=None, sha=H2, **kw):
        earlier = read_reviews(list(earlier))
        return decide(REPO, N, sha, rnd or next_round(earlier), earlier, False, reply_text, **kw)

    def test_no_important_finding_is_clean_and_merges(self):
        d = self.decide(reply(findings=[nit('F1')]))
        self.assertEqual((d['verdict'], d['outcome'], d['signals']), ('clean', 'merge', []))
        self.assertEqual(d['status']['state'], 'success')

    def test_an_important_finding_with_evidence_blocks_and_goes_back_to_fix(self):
        d = self.decide(reply(findings=[important('F1')]))
        self.assertEqual((d['verdict'], d['outcome']), ('blocking', 'fix'))
        self.assertEqual(d['status']['state'], 'failure')
        self.assertIn('F1', d['status']['description'])

    def test_the_verdict_comes_from_the_ledger_not_the_prose(self):
        d = self.decide(reply(findings=[important('F1')], prose='All clean, ship it!'))
        self.assertEqual(d['verdict'], 'blocking')
        d = self.decide(reply(prose='Blocking: this is badly broken.'))
        self.assertEqual(d['verdict'], 'clean')

    def test_an_important_finding_without_evidence_counts_as_a_nit(self):
        d = self.decide(reply(findings=[important('F1', line=None)]))
        self.assertEqual(d['verdict'], 'clean')
        self.assertIn('F1 was tagged Important without', d['body'])

    def test_nits_past_five_are_left_out_and_named(self):
        d = self.decide(reply(findings=[nit(f'F{i}') for i in range(1, 8)]))
        self.assertEqual([f['id'] for f in d['findings']], ['F1', 'F2', 'F3', 'F4', 'F5'])
        self.assertIn('Nits past the first 5 are left out: F6, F7.', d['body'])

    def test_a_reply_without_a_readable_ledger_fails(self):
        for bad in ('No block at all.', '```sol-findings\nnot json\n```',
                    reply(findings=[{'id': 'F1', 'tag': 'major'}]),
                    reply(findings=[nit('F1'), nit('F1')]),
                    '```sol-findings\n{"verdict": "clean"}\n```'):
            with self.subTest(bad=bad), self.assertRaises(SolFailed):
                self.decide(bad)

    def test_a_fixed_finding_closes_and_a_clean_review_follows(self):
        d = self.decide(reply(earlier=[{'id': 'F1', 'status': 'fixed'}]),
                        review1([important('F1')]))
        self.assertEqual((d['verdict'], d['outcome']), ('clean', 'merge'))
        [f] = d['findings']
        self.assertEqual((f['status'], f['closed']), ('fixed', 2))

    def test_an_earlier_finding_given_no_status_stays_open(self):
        d = self.decide(reply(), review1([important('F1')]))
        self.assertEqual((d['verdict'], d['unaddressed']), ('blocking', ['F1']))

    def test_a_new_important_finding_in_an_earlier_class_stops(self):
        d = self.decide(reply(findings=[important('F2', cls='Write  logged, wrongly')],
                              earlier=[{'id': 'F1', 'status': 'fixed'}]),
                        review1([important('F1', cls='write logged wrongly')]))
        self.assertEqual(d['outcome'], 'stop')
        self.assertEqual([(s['signal'], s['ids']) for s in d['signals']],
                         [('repeated-class', ['F2'])])

    def test_a_closed_finding_raised_again_reopens_and_stops(self):
        comments = review1([important('F1')]) + [comment(
            '## Sol review 2 · Clean\n\n' + old_marker(2, 'clean', H2, [
                {**important('F1'), 'status': 'fixed', 'raised': 1, 'closed': 2}]))]
        d = self.decide(reply(findings=[important('F1')]), comments, sha=H3)
        self.assertEqual(d['outcome'], 'stop')
        self.assertEqual([s['signal'] for s in d['signals']], ['reopened'])
        self.assertIn('F1 (fixed in review 2)', d['body'])

    def test_a_decline_sol_keeps_under_a_repo_rule_stops(self):
        rule = 'Always put a game back.'
        d = self.decide(reply(earlier=[{'id': 'F1', 'status': 'decline-kept', 'rule': rule}]),
                        review1([important('F1')]))
        self.assertEqual((d['outcome'], d['kept']), ('stop', ['F1']))
        self.assertEqual([s['signal'] for s in d['signals']], ['decline-kept'])
        self.assertIn(rule, d['signals'][0]['text'])
        self.assertEqual(state([{'round': 2, 'findings': d['findings']}])[0]['kept_rule'], rule)

    def test_a_decline_sol_disagrees_with_on_judgment_alone_stands(self):
        # Stefan, 2026-11-18: "don't treat review as gospel". With no repo rule behind it, the
        # builder's decline wins: it closes, the PR can merge, and the disagreement is recorded.
        for kept in ({'id': 'F1', 'status': 'decline-kept'},
                     {'id': 'F1', 'status': 'decline-kept', 'rule': '  '}):
            with self.subTest(kept=kept):
                d = self.decide(reply(earlier=[kept]), review1([important('F1')]))
                self.assertEqual((d['verdict'], d['outcome']), ('clean', 'merge'))
                self.assertEqual((d['kept'], d['stands'], d['signals']), ([], ['F1'], []))
                [f1] = d['findings']
                self.assertEqual((f1['status'], f1['closed']), ('decline-stands', 2))
                self.assertIn('Declined; Sol disagrees', d['body'])
                self.assertIn('the decline stands', d['body'])

    def test_a_decline_that_stood_raised_again_reopens_and_stops(self):
        comments = review1([important('F1')]) + [comment(
            '## Sol review 2 · Clean\n\n' + old_marker(2, 'clean', H2, [
                {**important('F1'), 'status': 'decline-stands', 'raised': 1, 'closed': 2}]))]
        d = self.decide(reply(findings=[important('F1')]), comments, sha=H3)
        self.assertEqual(d['outcome'], 'stop')
        self.assertEqual([s['signal'] for s in d['signals']], ['reopened'])

    def test_an_accepted_decline_closes(self):
        d = self.decide(reply(earlier=[{'id': 'F1', 'status': 'decline-accepted'}]),
                        review1([important('F1')]))
        self.assertEqual((d['verdict'], d['outcome']), ('clean', 'merge'))

    def test_review_3_still_blocking_gets_the_approach_note_instead_of_a_fix(self):
        d = self.decide(reply(earlier=[{'id': 'F1', 'status': 'open'}]),
                        review1([important('F1')]), rnd=3)
        self.assertEqual((d['verdict'], d['outcome']), ('blocking', 'approach-note'))
        # and so does every blocking review after it: there's no spend guard any more
        d = self.decide(reply(earlier=[{'id': 'F1', 'status': 'open'}]),
                        review1([important('F1')]), rnd=4)
        self.assertEqual(d['outcome'], 'approach-note')

    def test_review_2_still_blocking_goes_back_to_fix(self):
        d = self.decide(reply(earlier=[{'id': 'F1', 'status': 'open'}]), review1([important('F1')]))
        self.assertEqual(d['outcome'], 'fix')

    def test_a_pre_existing_finding_is_filed_once(self):
        pre = {'id': 'F2', 'tag': 'pre-existing', 'class': 'old bug', 'file': 'src/b.ts',
               'line': 3, 'scenario': 's'}
        d = self.decide(reply(findings=[pre]))
        self.assertEqual([i['id'] for i in d['issues']], ['F2'])
        self.assertEqual(d['verdict'], 'clean')
        comments = [comment(old_marker(1, 'clean', H1, [{**pre, 'status': 'filed', 'raised': 1}]))]
        d = self.decide(reply(findings=[pre]), comments)
        self.assertEqual(d['issues'], [])

    def test_a_finding_listed_again_under_a_new_id_keeps_its_earlier_one(self):
        d = self.decide(reply(findings=[important('F7')]), review1([important('F1')]))
        self.assertEqual([f['id'] for f in d['findings']], ['F1'])
        self.assertIn('F7 is F1', d['body'])
        self.assertEqual(d['signals'], [])   # not a new finding in an earlier class

    def test_an_unchanged_finding_is_not_reposted_as_new(self):
        d = self.decide(reply(findings=[important('F1')]), review1([important('F1')]))
        findings = d['body'].split('### Findings')[1]
        self.assertIn('No new findings.', findings)
        self.assertIn('Still open (listed again)', d['body'].split('### Findings')[0])

    def test_a_filed_finding_listed_again_keeps_its_issue_url(self):
        url = 'https://github.com/owner/repo/issues/40'
        pre = {'id': 'F2', 'tag': 'pre-existing', 'class': 'old bug', 'file': 'src/b.ts',
               'line': 3, 'scenario': 's'}
        comments = [comment(old_marker(1, 'clean', H1, [{**pre, 'status': 'filed', 'raised': 1,
                                                         'issue': url}]))]
        d = self.decide(reply(findings=[pre]), comments)
        self.assertEqual(d['issues'], [])
        [r] = read_reviews([comment(d['body'])])
        self.assertEqual([f.get('issue') for f in state([r])], [url])

    def test_the_comment_carries_a_ledger_that_reads_back_as_the_prs_state(self):
        d = self.decide(reply(findings=[important('F1'), nit('F2')], prose='Two things.'))
        self.assertTrue(d['body'].startswith('## Sol review 1 · Blocking'))
        self.assertIn('Two things.', d['body'])
        self.assertIn('```sol-findings', d['body'])
        [r] = read_reviews([comment(d['body'])])
        self.assertEqual((r['round'], r['verdict'], r['sha']), (1, 'blocking', H2))
        self.assertEqual({f['id']: f['status'] for f in state([r])}, {'F1': 'open', 'F2': 'open'})

    def test_local_paths_in_findings_become_repo_relative(self):
        f = important('F1', file='C:/wt/pr7/src/a.ts:12', line=None)
        d = self.decide(reply(findings=[f]), wt='C:/wt/pr7', rundir='C:/runs/r1')
        [g] = d['findings']
        self.assertEqual((g['file'], g['line']), ('src/a.ts', 12))

    def test_a_force_push_is_said_in_the_comment(self):
        d = self.decide(reply(), review1([]), gone=True)
        self.assertIn("isn't in this branch's history any more", d['body'])


if __name__ == '__main__':
    unittest.main()
