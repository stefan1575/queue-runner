"""ChatGPT's usage and reset credits through `codex app-server` (ticket 42), as T3 reads them:
`account/rateLimits/read`. The responses are real ones (2026-11-16, ids and the account replaced);
the app server is `fixtures/codex/fake_app_server.py`, so no test starts Codex or reads a login."""
import datetime
import json
import os
import sys
import unittest

from queue_runner.codex_usage import CodexUsage, CodexUsageError, parse
from queue_runner.sol import Limits, LimitWindow

HERE = os.path.join(os.path.dirname(__file__), 'fixtures', 'codex')
WITH = os.path.join(HERE, 'rate-limits-read.json')
WITHOUT = os.path.join(HERE, 'rate-limits-read-no-resets.json')
FAKE = os.path.join(HERE, 'fake_app_server.py')
UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 11, 16, 4, 0, tzinfo=UTC)


def result(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)['result']


def at(epoch):
    return datetime.datetime.fromtimestamp(epoch, UTC)


class ParseTest(unittest.TestCase):
    def test_the_plan_its_windows_and_its_reset_credits(self):
        limits = parse(result(WITH))
        self.assertEqual(limits, Limits('plus', (LimitWindow(300, 35.0, at(1794764804)),
                                                 LimitWindow(10080, 28.0, at(1795212739))), resets=3))

    def test_a_response_without_reset_credits_has_none(self):
        self.assertIsNone(parse(result(WITHOUT)).resets)

    def test_codexs_own_bucket_is_read_first(self):
        data = result(WITH)
        data['rateLimits']['primary']['usedPercent'] = 99
        self.assertEqual(parse(data).windows[0].used, 35.0)
        del data['rateLimitsByLimitId']
        self.assertEqual(parse(data).windows[0].used, 99.0)

    def test_a_window_without_its_length_takes_its_places(self):
        data = result(WITH)
        del data['rateLimitsByLimitId']
        data['rateLimits']['primary']['windowDurationMins'] = None
        data['rateLimits']['secondary']['resetsAt'] = None
        limits = parse(data)
        self.assertEqual(limits.windows, (LimitWindow(300, 35.0, at(1794764804)), LimitWindow(10080, 28.0, None)))

    def test_a_negative_count_is_none_left(self):
        data = result(WITH)
        data['rateLimitResetCredits']['availableCount'] = -2
        self.assertEqual(parse(data).resets, 0)

    def test_no_window_at_all_is_an_error(self):
        for data in ({}, {'rateLimits': {}}, {'rateLimits': {'primary': {'usedPercent': 'x'}}}, []):
            with self.subTest(data=data), self.assertRaises(CodexUsageError):
                parse(data)


class ReadTest(unittest.TestCase):
    def codex(self, fixture=WITH, *how, timeout=10):
        return CodexUsage(command=[sys.executable, FAKE, fixture, *how], timeout=timeout,
                          clock=lambda: NOW)

    def test_it_asks_after_initializing_and_says_when_it_read(self):
        when, limits = self.codex(WITH, '--before-init').read()
        self.assertEqual((when, limits.plan, limits.resets), (NOW, 'plus', 3))

    def test_an_error_answer_is_an_error_that_names_it(self):
        with self.assertRaises(CodexUsageError) as e:
            self.codex(WITH, '--error').read()
        self.assertIn('not signed in', str(e.exception))

    def test_no_answer_in_time_is_an_error(self):
        with self.assertRaises(CodexUsageError) as e:
            self.codex(WITH, '--silent', timeout=1).read()
        self.assertIn('did not answer', str(e.exception))

    def test_no_codex_is_an_error(self):
        with self.assertRaises(CodexUsageError):
            CodexUsage(command=[os.path.join(HERE, 'no-such-codex.exe')], clock=lambda: NOW).read()
        with self.assertRaises(CodexUsageError):
            CodexUsage(command=None, find=lambda: None, clock=lambda: NOW).read()


if __name__ == '__main__':
    unittest.main()
