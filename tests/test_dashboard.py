"""The dashboard's server and its sample snapshots. No runner, no T3, no GitHub: two files."""
import http.client
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dashboard import sample
from dashboard.serve import App, Refused, apply_control, serve

NOW = "2026-11-15T13:00:00+08:00"


class ApplyControlTest(unittest.TestCase):
    def test_a_lane_is_asked_to_stop_and_the_others_keep_what_they_were_asked(self):
        first = apply_control({}, {"lane": "claude", "stop": "after-job"}, NOW)
        both = apply_control(first, {"lane": "sol", "stop": "now"}, "2026-11-15T13:05:00+08:00")
        self.assertEqual(both["lanes"]["claude"], {"stop": "after-job", "at": NOW})
        self.assertEqual(both["lanes"]["sol"], {"stop": "now", "at": "2026-11-15T13:05:00+08:00"})
        self.assertEqual(both["written_at"], "2026-11-15T13:05:00+08:00")
        self.assertEqual(both["version"], 1)

    def test_null_asks_a_lane_to_carry_on(self):
        stopped = apply_control({}, {"lane": "claude", "stop": "now"}, NOW)
        resumed = apply_control(stopped, {"lane": "claude", "stop": None}, NOW)
        self.assertIsNone(resumed["lanes"]["claude"]["stop"])

    def test_the_build_order_replaces_the_one_before_and_keeps_the_lanes(self):
        c = apply_control({}, {"lane": "claude", "stop": "now"}, NOW)
        c = apply_control(c, {"repo_order": ["queue-runner", "leads-dashboard"]}, NOW)
        self.assertEqual(c["repo_order"], ["queue-runner", "leads-dashboard"])
        self.assertEqual(c["lanes"]["claude"]["stop"], "now")

    def test_anything_else_is_refused(self):
        for body in (
            {"lane": "claude", "stop": "maybe"},
            {"lane": "../x", "stop": "now"},
            {"lane": 3, "stop": "now"},
            {"lane": "claude"},
            {"repo_order": []},
            {"repo_order": ["a", "a"]},
            {"repo_order": ["a", 2]},
            {"repo_order": "a"},
            {"lane": "claude", "stop": "now", "repo_order": ["a"]},
            {"paused": True},
            ["lane"],
            "now",
        ):
            with self.subTest(body=body), self.assertRaises(Refused):
                apply_control({}, body, NOW)


class AppTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="qr-dashboard-test-"))
        self.app = App(self.dir, clock=lambda: NOW)

    def test_no_snapshot_yet_says_where_it_looked(self):
        status, body = self.app.snapshot()
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["path"], str(self.dir / "snapshot.json"))

    def test_the_runners_snapshot_is_served_as_written(self):
        raw = json.dumps({"version": 1, "asks": []}).encode()
        (self.dir / "snapshot.json").write_bytes(raw)
        self.assertEqual(self.app.snapshot(), (200, raw))

    def test_a_snapshot_that_isnt_json_is_a_fault_not_an_empty_page(self):
        (self.dir / "snapshot.json").write_text("{ torn", encoding="utf-8")
        status, body = self.app.snapshot()
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)["error"], "unreadable")

    def test_a_control_request_is_written_whole_to_the_state_folder(self):
        self.app.write_control({"lane": "claude", "stop": "after-job"})
        on_disk = json.loads((self.dir / "control.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, {"version": 1, "written_at": NOW, "lanes": {"claude": {"stop": "after-job", "at": NOW}}, "repo_order": []})
        self.assertEqual(self.app.control(), on_disk)
        self.assertEqual([p.name for p in self.dir.iterdir()], ["control.json"])   # no temp file left

    def test_a_refused_request_writes_nothing(self):
        with self.assertRaises(Refused):
            self.app.write_control({"lane": "claude", "stop": "sideways"})
        self.assertFalse((self.dir / "control.json").exists())

    def test_an_unreadable_control_file_reads_as_nothing_asked(self):
        (self.dir / "control.json").write_text("not json", encoding="utf-8")
        self.assertEqual(self.app.control(), {"version": 1, "lanes": {}, "repo_order": []})
        self.app.write_control({"lane": "sol", "stop": "now"})
        self.assertEqual(self.app.control()["lanes"], {"sol": {"stop": "now", "at": NOW}})


class SampleTest(unittest.TestCase):
    T = datetime(2026, 11, 15, 13, 0, tzinfo=timezone(timedelta(hours=8)))

    def test_every_state_is_a_whole_version_1_snapshot(self):
        for name in sample.STATES:
            with self.subTest(state=name):
                s = sample.build(name, base=self.T, now=self.T)
                json.dumps(s)
                self.assertEqual(s["version"], 1)
                for key in ("written_at", "write_every", "control_read_at", "runner", "sources", "repos",
                            "asks", "lanes", "usage", "features", "issues", "prs"):
                    self.assertIn(key, s)
                self.assertEqual(s["sample"]["state"], name)
                keys = {f"{i['repo']}#{i['n']}" for i in s["issues"]}
                for i in s["issues"]:
                    self.assertLessEqual(set(i["blocked_by"]), keys, i["title"])
                for a in s["asks"]:
                    self.assertTrue(a["go"]["url"].startswith("https://"), a["id"])

    def test_an_unknown_state_is_an_error(self):
        with self.assertRaises(ValueError):
            sample.build("nope")

    def test_ready_work_is_numbered_in_the_order_the_runner_builds(self):
        s = sample.build("busy", base=self.T, now=self.T)
        picks = sorted((i["pick"], i["repo"], i["n"]) for i in s["issues"] if i["pick"])
        self.assertEqual(picks, [(1, "leads-dashboard", 211), (2, "leads-dashboard", 226), (3, "queue-runner", 5), (4, "queue-runner", 6)])
        self.assertTrue(all(i["pick"] is None for i in s["issues"] if i["state"] != "ready"))

    def test_the_dead_runner_stopped_writing_and_reads_no_control(self):
        asked = {"written_at": (self.T - timedelta(minutes=5)).isoformat(), "lanes": {"claude": {"stop": "now", "at": self.T.isoformat()}}}
        s = sample.build("dead", base=self.T, now=self.T, control=asked)
        self.assertEqual(datetime.fromisoformat(s["written_at"]), self.T - timedelta(minutes=42))
        self.assertIsNone(s["control_read_at"])
        self.assertEqual(s["lanes"][0]["state"], "working")

    def test_the_pretend_runner_reads_control_a_few_seconds_after_it_was_written(self):
        written = self.T.isoformat()
        asked = {"written_at": written, "lanes": {"claude": {"stop": "after-job", "at": written}, "sol": {"stop": "now", "at": written}},
                 "repo_order": ["queue-runner", "leads-dashboard"]}
        early = sample.build("busy", base=self.T, now=self.T + timedelta(seconds=1), control=asked)
        self.assertIsNone(early["control_read_at"])
        self.assertEqual([l["state"] for l in early["lanes"]], ["working", "working"])

        later = sample.build("busy", base=self.T, now=self.T + timedelta(seconds=sample.ACK_SECONDS), control=asked)
        self.assertEqual(later["control_read_at"], written)
        claude, sol = later["lanes"]
        self.assertEqual(claude["state"], "stopping")
        self.assertIsNotNone(claude["job"])
        self.assertEqual(sol["state"], "stopped")
        self.assertIsNone(sol["job"])
        self.assertEqual(sol["stopped"]["during"], "PR #210 Callers list: filter by tag")
        self.assertEqual([r["name"] for r in later["repos"]], ["queue-runner", "leads-dashboard"])
        first = next(i for i in later["issues"] if i["pick"] == 1)
        self.assertEqual((first["repo"], first["n"]), ("queue-runner", 5))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="qr-dashboard-test-"))
        self.app = App(self.dir, sample=True, clock=lambda: NOW)
        self.server = serve(self.app, 0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(conn.close)
        conn.request(method, path, body=body, headers=headers or {})
        r = conn.getresponse()
        return r.status, r.getheader("Content-Type"), r.read()

    def post(self, body, **headers):
        return self.call("POST", "/control", json.dumps(body), {"Content-Type": "application/json", **headers})

    def test_the_page_the_snapshot_and_the_control_file_are_served(self):
        status, kind, body = self.call("GET", "/")
        self.assertEqual((status, kind), (200, "text/html; charset=utf-8"))
        self.assertIn(b"<title>Queue runner</title>", body)
        status, _, body = self.call("GET", "/snapshot.json?sample=clear")
        self.assertEqual((status, json.loads(body)["asks"]), (200, []))
        status, _, body = self.call("GET", "/control.json")
        self.assertEqual((status, json.loads(body)["lanes"]), (200, {}))
        self.assertEqual(self.call("GET", "/config.toml")[0], 404)

    def test_the_page_has_no_address_outside_itself_to_load(self):
        page = (Path(__file__).resolve().parent.parent / "dashboard" / "index.html").read_text(encoding="utf-8")
        for needle in ('src="http', "@import", "url(http", 'rel="stylesheet"'):
            self.assertNotIn(needle, page)

    def test_a_request_from_the_page_is_written(self):
        status, _, body = self.post({"lane": "claude", "stop": "after-job"}, Origin=f"http://127.0.0.1:{self.port}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["lanes"]["claude"]["stop"], "after-job")
        self.assertEqual(self.app.control()["lanes"]["claude"]["stop"], "after-job")

    def test_another_sites_page_cant_write_controls_or_read_the_snapshot(self):
        self.assertEqual(self.post({"lane": "claude", "stop": "now"}, Origin="http://evil.example")[0], 403)
        self.assertEqual(self.post({"lane": "claude", "stop": "now"}, Host="evil.example")[0], 403)
        self.assertEqual(self.call("GET", "/snapshot.json", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.app.control()["lanes"], {})

    def test_a_request_that_isnt_small_json_is_refused(self):
        self.assertEqual(self.call("POST", "/control", '{"lane":"claude","stop":"now"}', {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("POST", "/control", "{ torn", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.post({"lane": "claude", "stop": "sideways"})[0], 400)
        self.assertEqual(self.call("POST", "/control", "", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.call("POST", "/elsewhere", "{}", {"Content-Type": "application/json"})[0], 404)
        self.assertEqual(self.app.control()["lanes"], {})


if __name__ == "__main__":
    unittest.main()
