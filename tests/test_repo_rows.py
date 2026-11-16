"""The Repositories card's rows (dashboard/index.html's repoRows()), run in node on the sample:
each repo says what it's doing now (#50: each runs its own Claude job at once), or why it waits,
or that it's stopped; each has its mark (its favicon, else its first two letters) and Stop or
Resume as an icon (Stefan, 2026-11-16). Skipped where node isn't on PATH."""

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
    def html(self, state: str) -> str:
        snap = {"repos": sample.build(state)["repos"]}   # all repoRows() reads of it
        script = (
            "const esc = (s) => String(s);\nconst clock = (s) => 'at ' + s;\n"
            "const ago = (s) => '5 min';\nconst frozen = () => false;\n"
            "const wasRead = () => true;\nconst ctl = {};\n"
            "const ICON = {play: '', pause: ''};\n"
            + f"const snap = {json.dumps(snap)};\n"
            + source(r"^const KIND = \{\n.*?^\};\n", "KIND")
            + source(r"^const kind = .*?;\n", "kind")
            + source(r"^function repoLogo\(name\) \{\n.*?^\}\n", "repoLogo()")
            + source(r"^function repoRows\(\) \{\n.*?^\}\n", "repoRows()")
            + "process.stdout.write(repoRows());\n"
        )
        # on stdin: the script is too long for a Windows command line
        done = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True,
                              encoding="utf-8", timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def rows(self, state: str) -> dict:
        return dict(re.findall(r'<span class="name">([\w-]+)<span>(.*?)</span>', self.html(state)))

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

    def test_a_repo_with_a_favicon_shows_it_and_one_without_its_first_two_letters(self):
        html = self.html("busy")
        self.assertIn(f'<span class="rlogo img" aria-hidden="true"><img src="{sample.LD_ICON}" alt=""></span>'
                      f'<span class="name">{sample.LD}<', html)
        self.assertIn(f'<span class="rlogo" aria-hidden="true">Qu</span><span class="name">{sample.QR}<', html)

    def test_stop_and_resume_are_icons_named_for_their_repo_with_no_note_under_the_list(self):
        html = self.html("repo-stopped")
        self.assertRegex(html, rf'<button class="btn sm icon solid"[^>]*aria-label="Resume {sample.LD}"[^>]*></button>')
        self.assertRegex(html, rf'<button class="btn sm icon"[^>]*aria-label="Stop {sample.QR}"[^>]*></button>')
        self.assertTrue(html.endswith("</ul>"), html[-120:])


if __name__ == "__main__":
    unittest.main()
