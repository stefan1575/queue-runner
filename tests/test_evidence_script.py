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


if __name__ == '__main__':
    unittest.main()
