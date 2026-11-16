"""Ticket 45: Sol runs these tests in Codex's sandbox, where a temp folder is made by the sandbox
user with an owner-only ACL (Python 3.13+ on Windows), so one a test leaves behind can't be
deleted by Stefan's account and the review's checkout can't be removed. Every test cleans up the
temp folders it makes: `tempfile.TemporaryDirectory` with `addCleanup`, never a bare `mkdtemp`."""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BARE = re.compile(r'\bmkdtemp\(')


class NoTempLeftoversTest(unittest.TestCase):
    def test_no_test_makes_a_temp_folder_it_doesnt_clean_up(self):
        found = []
        for root, _, names in os.walk(HERE):
            for name in names:
                if not name.endswith('.py') or name == os.path.basename(__file__):
                    continue
                path = os.path.join(root, name)
                with open(path, encoding='utf-8') as f:
                    for n, line in enumerate(f, 1):
                        if BARE.search(line) and not line.lstrip().startswith(('#', '"')):
                            found.append(f'{os.path.relpath(path, HERE)}:{n}: {line.strip()}')
        self.assertEqual(found, [], 'use tempfile.TemporaryDirectory with addCleanup')


if __name__ == '__main__':
    unittest.main()
