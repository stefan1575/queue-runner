"""Claude's usage windows, parsed from a real `api/oauth/usage` response (saved 2026-11-10)."""
import datetime
import email.message
import io
import json
import os
import tempfile
import unittest
import urllib.error

from queue_runner.usage import URL, OAuthUsage, UsageError, parse

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'usage', 'oauth-usage.json')
UTC = datetime.timezone.utc


class ParseTest(unittest.TestCase):
    def test_reads_the_five_hour_and_weekly_windows_from_a_real_response(self):
        with open(FIXTURE, 'rb') as f:
            usage = parse(f.read())
        self.assertEqual(usage.five_hour.used, 80.0)
        self.assertEqual(usage.five_hour.resets_at,
                         datetime.datetime(2026, 11, 9, 21, 20, 0, 473393, tzinfo=UTC))
        self.assertEqual(usage.seven_day.used, 22.0)
        self.assertEqual(usage.seven_day.resets_at,
                         datetime.datetime(2026, 11, 16, 11, 0, 0, 473411, tzinfo=UTC))

    def test_a_window_not_started_is_unused_with_no_reset(self):
        usage = parse(json.dumps({'five_hour': None, 'seven_day': {'utilization': 3,
                                                                   'resets_at': None}}))
        self.assertEqual((usage.five_hour.used, usage.five_hour.resets_at), (0.0, None))
        self.assertEqual((usage.seven_day.used, usage.seven_day.resets_at), (3.0, None))

    def test_a_response_without_the_windows_is_an_error(self):
        for body in ('not json', '[]', '{"five_hour": {"resets_at": null}}'):
            with self.assertRaises(UsageError):
                parse(body)

    def test_a_record_round_trips(self):
        with open(FIXTURE, 'rb') as f:
            usage = parse(f.read())
        self.assertEqual(type(usage).from_record(json.loads(json.dumps(usage.record()))), usage)


RESETS = os.path.join(os.path.dirname(__file__), 'fixtures', 'usage', 'oauth-usage-resets.json')
ON_THE_16TH = datetime.datetime(2026, 11, 16, 4, 0, tzinfo=UTC)


class ResetsTest(unittest.TestCase):
    """Reset credits, from the response's `cedar_ember` block as T3 counts them
    (`claudeResetCreditsToContract`; the block as read on 2026-11-16)."""

    def block(self):
        with open(RESETS, encoding='utf-8') as f:
            return json.load(f)

    def test_every_usable_grant_counts_its_resets_left(self):
        with open(RESETS, 'rb') as f:
            usage = parse(f.read(), now=ON_THE_16TH)
        self.assertEqual(usage.resets, 2)
        self.assertEqual(usage.five_hour.used, 80.0)   # the windows are read as before

    def test_a_response_without_the_block_has_no_resets(self):
        with open(FIXTURE, 'rb') as f:
            self.assertIsNone(parse(f.read()).resets)

    def test_an_account_not_eligible_has_no_resets(self):
        data = self.block()
        data['cedar_ember']['eligible'] = False
        self.assertIsNone(parse(json.dumps(data), now=ON_THE_16TH).resets)

    def test_a_paused_unusable_or_ended_grant_doesnt_count(self):
        for change in ({'paused': True}, {'usable_now': False}, {'ends_at': '2026-11-01T00:00:00+00:00'},
                       {'resets_left': -1}, {'id': 'Not An Id!'}):
            with self.subTest(change=change):
                data = self.block()
                data['cedar_ember']['grants'][1].update(change)
                self.assertEqual(parse(json.dumps(data), now=ON_THE_16TH).resets, 1)

    def test_with_no_next_grant_usable_none_are_left(self):
        data = self.block()
        data['cedar_ember']['next_grant_id'] = None
        self.assertEqual(parse(json.dumps(data), now=ON_THE_16TH).resets, 0)
        data['cedar_ember']['grants'][0]['paused'] = True   # the next one itself
        data['cedar_ember']['next_grant_id'] = 'full-reset-2611'
        self.assertEqual(parse(json.dumps(data), now=ON_THE_16TH).resets, 0)

    def test_the_read_asks_for_the_block_as_t3_does(self):
        seen = []

        def fetch(request):
            seen.append(request.full_url)
            with open(RESETS, 'rb') as f:
                return f.read()
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, '.credentials.json'), 'w') as f:
                json.dump({'claudeAiOauth': {'accessToken': 'sk-fake'}}, f)
            usage = OAuthUsage(config_dir=d, fetch=fetch, clock=lambda: ON_THE_16TH).read()
        self.assertEqual(seen, ['https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'])
        self.assertEqual(usage.resets, 2)


class RateLimitTest(unittest.TestCase):
    """After a 429 the endpoint isn't asked again until the cool-down ends (2026-11-16: the
    runner's two reads a few seconds apart around each job, beside T3's own, met 429s)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with open(os.path.join(tmp.name, '.credentials.json'), 'w') as f:
            json.dump({'claudeAiOauth': {'accessToken': 'sk-fake'}}, f)
        self.now = ON_THE_16TH
        self.answers, self.calls = [], 0

        def fetch(request):
            self.calls += 1
            got = self.answers.pop(0)
            if isinstance(got, Exception):
                raise got
            with open(RESETS, 'rb') as f:
                return f.read()
        self.usage = OAuthUsage(config_dir=tmp.name, fetch=fetch, clock=lambda: self.now)

    def limited(self, retry_after=None):
        headers = email.message.Message()
        if retry_after is not None:
            headers['Retry-After'] = retry_after
        return urllib.error.HTTPError(URL, 429, 'Too Many Requests', headers, io.BytesIO())

    def later(self, **kw):
        self.now += datetime.timedelta(**kw)

    def test_after_a_429_reads_wait_without_a_call_then_ask_again(self):
        self.answers = [self.limited(), 'ok']
        with self.assertRaises(UsageError) as e:
            self.usage.read()
        self.assertIn('HTTP 429', str(e.exception))
        self.later(seconds=90)
        with self.assertRaises(UsageError):
            self.usage.read()
        self.assertEqual(self.calls, 1)   # the second read asked nothing
        self.later(seconds=31)
        self.assertEqual(self.usage.read().resets, 2)
        self.assertEqual(self.calls, 2)

    def test_429s_in_a_row_wait_longer_each_time_up_to_a_ceiling(self):
        waits = []
        for _ in range(6):
            self.answers = [self.limited()]
            start = self.now
            with self.assertRaises(UsageError):
                self.usage.read()
            waits.append(self.usage._cool_until - start)
            self.now = self.usage._cool_until
        self.assertEqual([w.total_seconds() / 60 for w in waits], [2, 4, 8, 16, 16, 16])

    def test_a_good_read_ends_the_backoff(self):
        self.answers = [self.limited(), 'ok', self.limited()]
        with self.assertRaises(UsageError):
            self.usage.read()
        self.later(minutes=2)
        self.usage.read()
        with self.assertRaises(UsageError):
            self.usage.read()
        self.assertEqual(self.usage._cool_until - self.now, datetime.timedelta(minutes=2))

    def test_retry_after_is_honoured_and_capped(self):
        self.answers = [self.limited('300')]
        with self.assertRaises(UsageError):
            self.usage.read()
        self.assertEqual(self.usage._cool_until - self.now, datetime.timedelta(minutes=5))
        self.now = self.usage._cool_until
        self.answers = [self.limited('86400')]
        with self.assertRaises(UsageError):
            self.usage.read()
        self.assertEqual(self.usage._cool_until - self.now, datetime.timedelta(minutes=30))

    def test_another_http_error_sets_no_cool_down(self):
        self.answers = [urllib.error.HTTPError(URL, 500, 'boom', email.message.Message(),
                                               io.BytesIO()), 'ok']
        with self.assertRaises(UsageError) as e:
            self.usage.read()
        self.assertIn('HTTP 500', str(e.exception))
        self.usage.read()
        self.assertEqual(self.calls, 2)


class LoginTest(unittest.TestCase):
    def test_no_login_says_where_it_looked_and_never_the_token(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(UsageError) as e:
                OAuthUsage(config_dir=d).read()
            self.assertIn('.credentials.json', str(e.exception))
            with open(os.path.join(d, '.credentials.json'), 'w') as f:
                json.dump({'claudeAiOauth': {'accessToken': 'sk-secret-123',
                                             'expiresAt': 1000}}, f)
            with self.assertRaises(UsageError) as e:
                OAuthUsage(config_dir=d, fetch=lambda req: (_ for _ in ()).throw(
                    OSError('boom'))).read()
            self.assertNotIn('sk-secret-123', str(e.exception))
            self.assertIn('expired', str(e.exception))


if __name__ == '__main__':
    unittest.main()
