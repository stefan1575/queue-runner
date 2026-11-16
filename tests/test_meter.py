"""The Usage meter (dashboard/index.html's meter()), run in node: the bar holds what's left, and the
blue share kept for Stefan is the last of what's left, so it never draws wider than what's left
(PR #62's review 1, F1). Skipped where node isn't on PATH."""

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"
NODE = shutil.which("node")


def meter_source():
    page = PAGE.read_text(encoding="utf-8")
    found = re.search(r"^function meter\(w, full\) \{\n.*?^\}\n", page, re.S | re.M)
    if not found:
        raise AssertionError("meter() not found in dashboard/index.html")
    return found.group(0)


@unittest.skipUnless(NODE, "node isn't on PATH")
class MeterTest(unittest.TestCase):
    def render(self, window):
        script = (
            "const esc = (s) => String(s);\nconst stamp = (s) => String(s);\n"
            + meter_source()
            + f"process.stdout.write(meter({json.dumps(window)}, false));\n"
        )
        done = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def widths(self, window):
        html = self.render(window)
        fill = re.search(r'class="fill" style="width:([\d.]+)%"', html)
        kept = re.search(r'class="kept" style="width:([\d.]+)%"', html)
        return (float(fill.group(1)) if fill else None, float(kept.group(1)) if kept else None, html)

    def test_the_kept_share_is_drawn_whole_while_enough_is_left(self):
        fill, kept, html = self.widths({"label": "Weekly", "used": 60, "reserve": 5})
        self.assertEqual((fill, kept), (40, 5))
        self.assertIn("40% left", html)

    def test_the_kept_share_is_never_wider_than_whats_left(self):
        fill, kept, html = self.widths({"label": "Weekly", "used": 98, "reserve": 5})
        self.assertEqual((fill, kept), (2, 2))
        self.assertIn("2% left", html)

    def test_nothing_left_draws_no_kept_share(self):
        fill, kept, html = self.widths({"label": "Weekly", "used": 100, "reserve": 5})
        self.assertEqual(fill, 0)
        self.assertIsNone(kept)
        self.assertIn("0% left", html)

    def test_over_the_limit_reads_as_nothing_left(self):
        fill, kept, _ = self.widths({"label": "Weekly", "used": 104, "reserve": 5})
        self.assertEqual((fill, kept), (0, None))

    def test_an_unknown_reading_draws_no_kept_share(self):
        fill, kept, html = self.widths({"label": "Weekly", "used": None, "reserve": 5})
        self.assertEqual((fill, kept), (None, None))
        self.assertIn(">?<", html)


if __name__ == "__main__":
    unittest.main()
