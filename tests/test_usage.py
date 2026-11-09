"""Claude's usage windows, parsed from a real `api/oauth/usage` response (saved 2026-11-10)."""
import datetime
import json
import os
import tempfile
import unittest

from queue_runner.usage import OAuthUsage, UsageError, parse

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
