"""scripts/make_shortcut.py: the runner's and the dashboard's logon shortcuts, made in temp folders.

Real .lnk files through WScript.Shell, read back the same way. Never the real ~/.queue-runner or
Startup folder."""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("make_shortcut", REPO / "scripts" / "make_shortcut.py")
make_shortcut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_shortcut)


def read_link(path: Path) -> dict:
    ps = ('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:QR_LINK); '
          '@{target = $s.TargetPath; args = $s.Arguments; dir = $s.WorkingDirectory; style = $s.WindowStyle} | ConvertTo-Json')
    out = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps], env={**os.environ, "QR_LINK": str(path)},
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


class MakeShortcutTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="qr-shortcut-"))
        self.startup = Path(tempfile.mkdtemp(prefix="qr-startup-"))
        self.pythonw = self.dir / "pythonw.exe"
        self.pythonw.write_bytes(b"")   # a shortcut's target must exist for WScript to keep its path as given

    def make(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()):
            make_shortcut.main(["--dir", str(self.dir / "links"), "--startup-dir", str(self.startup), "--pythonw", str(self.pythonw), *extra])

    def test_both_shortcuts_start_pythonw_in_this_repo(self):
        self.make()
        runner = read_link(self.dir / "links" / "Queue runner.lnk")
        dashboard = read_link(self.dir / "links" / "Queue runner dashboard.lnk")
        for link in (runner, dashboard):
            self.assertEqual(Path(link["target"]), self.pythonw)
            self.assertEqual(Path(link["dir"]), REPO)
        self.assertEqual((runner["args"], dashboard["args"]), ("-m queue_runner", "-m dashboard"))
        self.assertEqual(list(self.startup.iterdir()), [])   # the Startup folder only with --startup

    def test_startup_copies_both_into_the_startup_folder(self):
        self.make("--startup")
        self.assertEqual(sorted(p.name for p in self.startup.iterdir()), ["Queue runner dashboard.lnk", "Queue runner.lnk"])
        self.assertEqual(read_link(self.startup / "Queue runner dashboard.lnk")["args"], "-m dashboard")
        self.assertEqual(read_link(self.startup / "Queue runner.lnk")["args"], "-m queue_runner")


if __name__ == "__main__":
    unittest.main()
