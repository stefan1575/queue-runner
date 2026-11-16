"""The Repositories card's rows (dashboard/index.html's repoRows()), run in node on the sample:
each repo says what it's doing now (#50: each runs its own Claude job at once), or why it waits,
or that it's stopped. Skipped where node isn't on PATH."""

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from dashboard import sample

PAGE = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"
NODE = shutil.which("node")


def source(pattern: str, name: str) -> str:
    found = re.search(pattern, PAGE.read_text(encoding="utf-8"), re.S | re.M)
    if not found:
        raise AssertionError(f"{name} not found in dashboard/index.html")
    return found.group(0)


@unittest.skipUnless(NODE, "node isn't on PATH")
class RepoRowsTest(unittest.TestCase):
    def rows(self, state: str) -> dict:
        snap = {"repos": sample.build(state)["repos"]}   # all repoRows() reads of it
        script = (
            "const esc = (s) => String(s);\nconst stamp = (s) => 'at ' + s;\n"
            "const ago = (s) => '5 min';\nconst frozen = () => false;\n"
            "const wasRead = () => true;\nconst ctl = {};\n"
            "const ICON = {play: '', pause: ''};\n"
            + f"const snap = {json.dumps(snap)};\n"
            + source(r"^const KIND = \{\n.*?^\};\n", "KIND")
            + source(r"^const kind = .*?;\n", "kind")
            + source(r"^function repoRows\(\) \{\n.*?^\}\n", "repoRows()")
            + "process.stdout.write(repoRows());\n"
        )
        # on stdin: the script is too long for a Windows command line
        done = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True,
                              encoding="utf-8", timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return dict(re.findall(r'<span class="name">([\w-]+)<span>(.*?)</span>', done.stdout))

    def test_each_repo_says_the_job_running_in_it(self):
        rows = self.rows("side-by-side")
        self.assertEqual(rows[sample.LD], "Building #212, 5 min in. You merge.")
        self.assertEqual(rows[sample.QR], "Building #5, 5 min in. The runner merges.")

    def test_a_repo_with_no_job_is_idle_or_says_why_it_waits(self):
        self.assertEqual(self.rows("busy")[sample.QR], "Idle. The runner merges.")
        waits = self.rows("reserve")[sample.LD]
        self.assertTrue(waits.startswith("Waiting: The week is at 93%"), waits)

    def test_a_stopped_repo_says_so_and_the_job_it_finishes(self):
        row = self.rows("repo-stopped")[sample.LD]
        self.assertTrue(row.startswith("Stopped since at "), row)
        self.assertTrue(row.endswith("; building #212, 5 min in"), row)


if __name__ == "__main__":
    unittest.main()
