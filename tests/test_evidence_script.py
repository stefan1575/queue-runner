"""scripts/evidence.py, the screenshot script build and fix jobs run (`templates/build.md`)."""
import importlib.util
import os
import tempfile
import unittest
from unittest import mock

from queue_runner.brief import EVIDENCE


def load():
    spec = importlib.util.spec_from_file_location('evidence_script', EVIDENCE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ScreenTest(unittest.TestCase):
    def test_a_path_with_spaces_reaches_powershell_whole(self):
        # PR #115 review 1, F2: arguments after -Command are joined into the script text and
        # split again on spaces, so `before shot.png` arrived as `...before`. The path now goes
        # in an environment variable, which PowerShell never re-parses.
        ev = load()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = os.path.join(tmp.name, 'my shots', 'before shot.png')
        seen = {}

        def run(cmd, **kw):
            seen['cmd'], seen['env'] = cmd, kw.get('env') or {}
            open(out, 'wb').close()
            return mock.Mock(returncode=0, stderr='')

        with mock.patch.object(ev.subprocess, 'run', run):
            ev.screen(ev.Path(out))
        self.assertEqual(seen['env'].get('EVIDENCE_OUT'), str(ev.Path(out).resolve()))
        self.assertFalse(any('before shot' in a for a in seen['cmd']), seen['cmd'])
        self.assertIn('$env:EVIDENCE_OUT', seen['cmd'][-1])


class IdenticalPairTest(unittest.TestCase):
    """Issue #136: nothing looks at a shot, so `publish` refuses a before and after whose bytes
    are the same (on #131 both were the default sample page) before pushing anything."""

    def files(self, **contents):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        paths = []
        for name, data in contents.items():
            p = os.path.join(tmp.name, name.replace('_', '-') + '.png')
            with open(p, 'wb') as f:
                f.write(data)
            paths.append(p)
        return paths

    def test_an_identical_pair_is_refused_naming_both_files_and_nothing_is_pushed(self):
        ev = load()
        paths = self.files(before_sol_wait_overview=b'same', after_sol_wait_overview=b'same',
                           before_busy_usage=b'old', after_busy_usage=b'new')
        with mock.patch.object(ev, 'git') as git,                 self.assertRaises(SystemExit) as stop:
            ev.main(['publish', '--repo', '.', '--into', 'pr-1', *paths])
        git.assert_not_called()
        self.assertIn('before-sol-wait-overview.png', str(stop.exception))
        self.assertIn('after-sol-wait-overview.png', str(stop.exception))
        self.assertNotIn('busy', str(stop.exception))
        self.assertIn('Screenshot owed', str(stop.exception))

    def test_different_pairs_and_unpaired_files_pass(self):
        ev = load()
        paths = self.files(before_busy_usage=b'old', after_busy_usage=b'new',
                           after_new_overview=b'x', before_gone_overview=b'x')
        self.assertEqual(ev.identical_pairs([ev.Path(p) for p in paths]), [])


if __name__ == '__main__':
    unittest.main()
