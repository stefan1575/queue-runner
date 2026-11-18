"""The right-hand rail (dashboard/index.html: Usage, Repositories, Health), run in node on the
sample, as Stefan agreed it on 2026-11-18 after takes 14 to 19 of its prototype (#141). Usage's
windows are equal rows, each with its own resets line; a provider's line is its plan, its resets
left and when it was read. Each repository says what its lanes are doing in one plain line, who
and for how long on hover; its mark is its favicon, else two capitals. Health is a dot and a name
each, the runner one of the local things. Skipped where node isn't on PATH."""

import json
from html import unescape
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from dashboard import sample

PAGE = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"
NODE = shutil.which("node")
START = "// ------------------------------------------------------------------ status, usage and repositories\n"
END = "// ------------------------------------------------------------------ the other pages\n"


def source(pattern: str, name: str) -> str:
    found = re.search(pattern, PAGE.read_text(encoding="utf-8"), re.S | re.M)
    if not found:
        raise AssertionError(f"{name} not found in dashboard/index.html")
    return found.group(0)


def rail_source() -> str:
    page = PAGE.read_text(encoding="utf-8")
    if START not in page or END not in page:
        raise AssertionError("the rail's section not found in dashboard/index.html")
    return page[page.index(START):page.index(END)]


def helpers() -> str:
    return (
        source(r"^const esc = .*?;\n", "esc")
        + source(r"^const svg = .*?;\n", "svg")
        + source(r"^const ms = .*?;\n", "ms")
        + source(r"^const plural = .*?;\n", "plural")
        + source(r"^function stamp\(iso\) \{\n.*?^\}\n", "stamp()")
        + source(r"^const t12 = .*?;\n", "t12")
        + source(r"^function when\(iso, now = new Date\(\)\) \{\n.*?^\}\n", "when()")
        + source(r"^const whenEl = .*?;\n", "whenEl")
        + source(r"^const KIND = \{\n.*?^\};\n", "KIND")
        + source(r"^const kind = .*?;\n", "kind")
        + source(r"^const laneJobs = .*?;\n", "laneJobs")
        + source(r"^function repoLogo\(name\) \{\n.*?^\}\n", "repoLogo()")
    )


@unittest.skipUnless(NODE, "node isn't on PATH")
class RailTest(unittest.TestCase):
    def run_js(self, snap: dict, expr: str, frozen: bool = False, ctl: dict | None = None, read: bool = True) -> str:
        script = (
            "const ICON = new Proxy({}, { get: () => '' });\n"
            "const who = (p, n) => `<span class=\"who\">${n}</span>`;\n"
            "const clock = (s) => 'at ' + s;\nconst hm = (s) => 'hm ' + s;\n"
            "const ago = (s) => '5 min';\nconst href = () => '?';\nconst load = () => {};\n"
            f"const frozen = () => {json.dumps(frozen)};\n"
            f"const wasRead = () => {json.dumps(read)};\n"
            "const ui = { page: 'overview' };\n"
            f"const ctl = {json.dumps(ctl or {})};\n"
            f"const snap = {json.dumps(snap)};\n"
            + helpers() + rail_source()
            + f"process.stdout.write(String({expr}));\n"
        )
        # on stdin: the script is too long for a Windows command line. TZ: when() reads local time.
        done = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, encoding="utf-8",
                              timeout=30, env={**os.environ, "TZ": "UTC"})
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    # ---- times, Stefan's format shortened
    def when(self, iso: str, now: str) -> str:
        return self.run_js({}, f"when({json.dumps(iso)}, new Date({json.dumps(now)}))")

    def test_a_time_today_is_its_clock_this_week_its_day_further_out_its_date(self):
        now = "2026-11-18T10:00:00Z"   # a Wednesday
        self.assertEqual(self.when("2026-11-18T15:53:00Z", now), "3:53pm")
        self.assertEqual(self.when("2026-11-20T16:35:00Z", now), "Friday 4:35pm")
        self.assertEqual(self.when("2026-11-25T00:10:00Z", now), "November 25 Wednesday 12:10am")

    # ---- Usage
    def usage(self, state: str = "busy", plan: int = 0) -> str:
        return self.run_js(sample.build(state), f"railPlan(snap.usage[{plan}])")

    def rows(self, html: str) -> list[tuple[str, str, str]]:
        return re.findall(r'<div class="u-row"><span class="lbl"[^>]*>(.*?)</span>.*?<span class="pct[^"]*">(.*?)</span>'
                          r'<span class="r-when">(.*?)</span></div>', html)

    def test_every_window_is_the_same_row_with_its_own_resets_line(self):
        rows = self.rows(self.usage())
        self.assertEqual([r[0] for r in rows], ["Session", "Weekly", "Weekly, Fable"])
        self.assertEqual([r[1] for r in rows], ["62%<small> left</small>", "54%<small> left</small>", "0%<small> left</small>"])
        # Weekly and Fable reset together, and each still says so under its own name
        self.assertTrue(all(r[2].startswith('<time') and "resets " in r[2] for r in rows), rows)

    def test_an_empty_bar_is_just_the_outline_and_its_figure_the_plain_colour(self):
        html = self.usage()
        fable = re.search(r'<span class="ubar([^"]*)"[^>]*aria-label="Weekly, Fable: 0% left">(.*?)</span>', html)
        self.assertIsNotNone(fable, html)
        self.assertEqual(fable.group(1).strip(), "")   # no tone: not red
        self.assertNotIn("fill", fable.group(2))
        self.assertIn('<span class="pct">0%<small> left</small></span>', html)

    def test_a_providers_line_is_its_plan_its_resets_left_and_when_it_was_read(self):
        meta = re.search(r'<span class="p-meta">(.*?)</span></p>', self.usage(plan=1)).group(1)
        self.assertRegex(meta, r"^Plus · 2 resets · <time [^>]*>read .+</time>$")

    def test_no_resets_left_still_says_so_and_no_count_says_nothing(self):
        snap = sample.build("busy")
        snap["usage"][0]["resets"] = {"available": 0}
        snap["usage"][1]["resets"] = None
        self.assertIn("Pro · 0 resets · ", self.run_js(snap, "railPlan(snap.usage[0])"))
        self.assertNotIn("reset", re.search(r'<span class="p-meta">(.*?)</span></p>', self.run_js(snap, "railPlan(snap.usage[1])")).group(1))

    def test_a_reconnecting_plan_says_so_and_a_failed_one_its_error(self):
        self.assertIn("reconnecting", self.usage("reconnecting"))
        failed = self.usage("usage-stale")
        self.assertIn('<p class="plan-note bad">The usage endpoint answered HTTP 429', failed)

    # ---- Repositories
    def repos(self, state: str, **kw) -> dict:
        html = self.run_js(sample.build(state), "railRepos()", **kw)
        return {name: (unescape(line), unescape(hover)) for name, hover, line in
                re.findall(r'<p class="nm">([\w-]+)</p><p class="doing"(?: title="([^"]*)")?>(.*?)</p>', html)}

    def test_a_repo_says_what_its_lanes_are_doing_with_who_and_how_long_on_hover(self):
        line, hover = self.repos("busy")[sample.LD]
        self.assertEqual(line, "Building #212 · Reviewing PR #210")
        self.assertIn("Claude: building #212 Archive view for old callers, 5 min in", hover)
        self.assertIn("ChatGPT: reviewing PR #210", hover)

    def test_a_repo_is_idle_waiting_or_stopped_and_never_says_who_merges(self):
        self.assertEqual(self.repos("busy")[sample.QR][0], "Idle")
        self.assertTrue(self.repos("reserve")[sample.QR][0].startswith("Waiting: The week is at 93%"))
        line, hover = self.repos("repo-stopped")[sample.LD]
        self.assertTrue(line.startswith("Stopped since "), line)
        self.assertIn("building #212", hover)   # the job it still finishes, on hover
        self.assertIn(self.run_js({}, f"stamp({json.dumps(next(r for r in sample.build('repo-stopped')['repos'] if r['name'] == sample.LD)['stopped']['at'])})"), hover)

    def test_a_stopped_repo_with_nothing_running_has_its_full_time_on_hover(self):
        # PR #147 review 1, F2: the short "Stopped since 12:15pm" had no title when no job ran
        snap = sample.build("repo-stopped")
        snap["lanes"] = [dict(l, jobs=[], job=None) for l in snap.get("lanes", [])]
        at = next(r for r in snap["repos"] if r["name"] == sample.LD)["stopped"]["at"]
        html = self.run_js(snap, "railRepos()")
        line, hover = {n: (unescape(l), unescape(h)) for n, h, l in
                       re.findall(r'<p class="nm">([\w-]+)</p><p class="doing"(?: title="([^"]*)")?>(.*?)</p>', html)}[sample.LD]
        self.assertTrue(line.startswith("Stopped since "), line)
        self.assertEqual(hover, "Stopped since " + self.run_js({}, f"stamp({json.dumps(at)})"))
        html = self.run_js(sample.build("side-by-side"), "railRepos()")
        self.assertNotIn("merge", html)

    def test_a_stop_asked_and_not_read_yet_says_so(self):
        line, hover = self.repos("busy", read=False, ctl={"repos": {sample.QR: {"stop": "after-job", "at": "2026-11-18T00:00:00Z"}}})[sample.QR]
        self.assertEqual((line, hover), ("Asked to stop", "The runner hasn't read it yet"))

    def test_stop_and_resume_are_icons_and_a_silent_runner_has_none(self):
        html = self.run_js(sample.build("repo-stopped"), "railRepos()")
        self.assertRegex(html, rf'<button class="btn sm icon solid"[^>]*aria-label="Resume {sample.LD}"')
        self.assertRegex(html, rf'<button class="btn sm icon"[^>]*aria-label="Stop {sample.QR}"')
        self.assertNotIn("<button", self.run_js(sample.build("dead"), "railRepos()", frozen=True))

    def test_a_repo_with_no_favicon_is_two_capitals_and_a_favicon_wins(self):
        snap = sample.build("busy")
        self.assertIsNone(snap["repos"][0]["icon"])   # the sample's made-up favicon is gone
        self.assertEqual(self.run_js(snap, "repoLogo('leads-dashboard') + repoLogo('queue-runner') + repoLogo('game-backdrop')"),
                         '<span class="rlogo" aria-hidden="true">LD</span><span class="rlogo" aria-hidden="true">QR</span>'
                         '<span class="rlogo" aria-hidden="true">GB</span>')
        snap["repos"][0]["icon"] = "data:image/png;base64,AAAA"
        self.assertEqual(self.run_js(snap, "repoLogo('leads-dashboard')"),
                         '<span class="rlogo img" aria-hidden="true"><img src="data:image/png;base64,AAAA" alt=""></span>')

    # ---- Health
    def test_health_is_a_dot_and_a_name_each_the_runner_under_local(self):
        html = self.run_js(sample.build("busy"), "status()")
        parts = re.split(r'<span class="h-label">(\w+)</span>', html.split('<div class="h-groups">')[1].split("</div>")[0])
        names = {g: re.findall(r'</i>([\w ]+)</span>', row) for g, row in zip(parts[1::2], parts[2::2])}
        self.assertEqual(names, {"Providers": ["Claude", "ChatGPT"], "Local": ["Queue runner", "T3 Code"], "External": ["GitHub"]})
        self.assertNotIn("since", re.sub(r'title="[^"]*"', "", html))   # since when is on hover only
        self.assertIn('title="Running since ', html)

    def test_a_silent_runner_is_a_red_dot_and_a_red_card(self):
        html = self.run_js(sample.build("dead"), "status()", frozen=True)
        self.assertIn('<section class="card health down">', html)
        self.assertIn('title="Silent since ', html)
        self.assertIn('<i class="dot bad"></i>Queue runner', html)

    # ---- the cards
    def test_each_card_has_an_equal_title_with_its_icon(self):
        html = self.run_js(sample.build("busy"), "rail()")
        heads = re.findall(r'<header class="card-head"><svg class="i hi"[^>]*>.*?</svg><h2>(\w+)</h2>', html)
        self.assertEqual(heads, ["Usage", "Repositories", "Health"])


if __name__ == "__main__":
    unittest.main()
