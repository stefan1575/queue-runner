"""The dashboard's server and its sample snapshots. No runner, no T3, no GitHub: two files."""
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dashboard import sample
from dashboard.serve import App, Refused, apply_control, serve

REPO = Path(__file__).resolve().parent.parent

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

    def test_no_snapshot_yet_says_where_it_looked_and_how_to_start_the_runner(self):
        status, body = self.app.snapshot()
        self.assertEqual(status, 404)
        body = json.loads(body)
        self.assertEqual((body["error"], body["path"]), ("missing", str(self.dir / "snapshot.json")))
        self.assertIn("Queue runner.lnk", body["start"])
        self.assertIn("pythonw -m queue_runner", body["start"])
        self.assertIn(str(REPO), body["start"])

    def test_the_runners_snapshot_is_served_as_written(self):
        raw = json.dumps({"version": 1, "asks": []}).encode()
        (self.dir / "snapshot.json").write_bytes(raw)
        self.assertEqual(self.app.snapshot(), (200, raw))

    def test_the_runners_snapshot_never_carries_the_sample_menu(self):
        # The page shows the sample menu and the Queue's variant pill only when `sample` is set.
        (self.dir / "snapshot.json").write_text(json.dumps({"version": 1, "sample": {"state": "busy"}}), encoding="utf-8")
        status, body = self.app.snapshot("busy")
        self.assertEqual((status, json.loads(body)), (200, {"version": 1}))

    def test_a_snapshot_that_isnt_json_is_a_fault_not_an_empty_page(self):
        (self.dir / "snapshot.json").write_text("{ torn", encoding="utf-8")
        status, body = self.app.snapshot()
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body)["error"], "unreadable")

    def test_a_control_request_is_written_whole_to_the_state_folder(self):
        self.app.write_control({"lane": "claude", "stop": "after-job"})
        on_disk = json.loads((self.dir / "control.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk, {"version": 1, "written_at": NOW, "lanes": {"claude": {"stop": "after-job", "at": NOW}}, "repo_order": [], "repos": {}, "asks": {}})
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
                            "asks", "answered", "lanes", "usage", "features", "issues", "prs", "activity", "costs", "roles", "knob"):
                    self.assertIn(key, s)
                self.assertEqual(s["sample"]["state"], name)
                self.assertLessEqual({x["group"] for x in s["sources"]}, {"provider", "local", "external"})
                keys = {f"{i['repo']}#{i['n']}" for i in s["issues"]}
                for i in s["issues"]:
                    self.assertLessEqual(set(i["blocked_by"]), keys, i["title"])
                for a in s["answered"]:
                    for key in ("at", "said", "next"):
                        self.assertTrue(a["answered"][key], f"{a['id']} {key}")
                self.assertFalse({a["id"] for a in s["asks"]} & {a["id"] for a in s["answered"]})
                for a in s["asks"] + s["answered"]:
                    self.assertTrue(a["go"]["url"].startswith("https://"), a["id"])
                    self.assertIn(a["go"]["where"], ("t3", "github"), a["id"])
                    times = [datetime.fromisoformat(e["at"]) for e in a["timeline"]]
                    self.assertEqual(times, sorted(times), a["id"])   # the story is told oldest first
                    self.assertTrue(times and all(e["text"].endswith(".") for e in a["timeline"]), a["id"])
                    self.assertIn(a["kind"], ("stuck", "decision", "merge", "broken"), a["id"])
                    for key in ("situation", "about", "because", "story", "question"):
                        self.assertTrue(a[key], f"{a['id']} {key}")   # each can be picked up cold

    def test_every_lane_and_plan_names_its_provider_and_every_role_a_lane(self):
        s = sample.build("busy", base=self.T, now=self.T)
        self.assertEqual([(l["id"], l["provider"], l["name"]) for l in s["lanes"]],
                         [("claude", "claude", "Claude"), ("sol", "chatgpt", "ChatGPT")])
        self.assertEqual([p["provider"] for p in s["usage"]], ["claude", "chatgpt"])
        self.assertLessEqual({r["lane"] for r in s["roles"]}, {l["id"] for l in s["lanes"]})

    def test_activity_is_newest_first_and_holds_every_prs_events(self):
        s = sample.build("busy", base=self.T, now=self.T)
        times = [datetime.fromisoformat(a["at"]) for a in s["activity"]]
        self.assertEqual(times, sorted(times, reverse=True))
        self.assertGreaterEqual(len(s["activity"]), sum(len(p["timeline"]) for p in s["prs"]))
        repos = {r["name"] for r in s["repos"]}
        for a in s["activity"]:
            self.assertIn(a["repo"], repos | {None}, a["title"])

    def test_an_unknown_state_is_an_error(self):
        with self.assertRaises(ValueError):
            sample.build("nope")

    def test_ready_work_is_numbered_in_the_order_the_runner_builds(self):
        s = sample.build("busy", base=self.T, now=self.T)
        picks = sorted((i["pick"], i["repo"], i["n"]) for i in s["issues"] if i["pick"])
        self.assertEqual(picks, [(1, "leads-dashboard", 211), (2, "leads-dashboard", 213), (3, "leads-dashboard", 226),
                                 (4, "queue-runner", 5), (5, "queue-runner", 6)])
        self.assertTrue(all(i["pick"] is None for i in s["issues"] if i["state"] != "ready"))

    def test_each_lane_has_its_own_queue_fix_rounds_before_builds_in_pick_order(self):
        s = sample.build("busy", base=self.T, now=self.T)
        claude, sol = s["lanes"]
        self.assertEqual([(q["kind"], q["repo"], q["ref"]) for q in claude["queue"]], [
            ("fix", "leads-dashboard", "PR #204"), ("build", "leads-dashboard", "#211"), ("build", "leads-dashboard", "#213"),
            ("build", "leads-dashboard", "#226"), ("build", "queue-runner", "#5"), ("build", "queue-runner", "#6")])
        self.assertEqual([(q["kind"], q["repo"], q["ref"]) for q in sol["queue"]], [("review", "leads-dashboard", "PR #232")])
        calm = sample.build("clear", base=self.T, now=self.T)["lanes"][1]
        self.assertEqual((calm["queue"], calm["queue_empty"]), ([], "Nothing is waiting for review."))

    def test_a_job_a_limit_cut_off_is_first_in_its_lanes_queue(self):
        claude = sample.build("limit", base=self.T, now=self.T)["lanes"][0]
        self.assertEqual((claude["state"], claude["queue"][0]["kind"], claude["queue"][0]["ref"]), ("waiting", "build", "#212"))

    def test_features_come_in_build_order_and_the_first_three_show_every_part_of_a_progress_bar(self):
        s = sample.build("busy", base=self.T, now=self.T)
        self.assertEqual([f["title"] for f in s["features"]],
                         ["Ring-to numbers", "Callers", "Client onboarding", "Analytics", "Dashboard", "Missed-call texts"])
        top = {f["id"] for f in s["features"][:3]}
        states = {i["state"] for i in s["issues"] if i["feature"] in top}
        # done, merged but not live, in a PR, building, waiting on Stefan, ready, blocked
        self.assertLessEqual({"done", "merged", "review", "building", "you", "ready", "blocked"}, states)
        swapped = {"written_at": self.T.isoformat(), "repo_order": ["queue-runner", "leads-dashboard"]}
        later = sample.build("busy", base=self.T, now=self.T + timedelta(seconds=sample.ACK_SECONDS), control=swapped)
        self.assertEqual(later["features"][0]["title"], "Dashboard")

    def test_a_features_tickets_come_in_the_order_they_are_built(self):
        for name in sample.STATES:
            with self.subTest(state=name):
                s = sample.build(name, base=self.T, now=self.T)
                issues = {f"{i['repo']}#{i['n']}": i for i in s["issues"]}
                for f in s["features"]:
                    own = [k for k, i in issues.items() if i["feature"] == f["id"]]
                    self.assertEqual(sorted(f["tickets"]), sorted(own), f["title"])   # each of its tickets, once
                    for at, k in enumerate(f["tickets"]):
                        for b in issues[k]["blocked_by"]:
                            if b in f["tickets"]:
                                self.assertLess(f["tickets"].index(b), at, f"{b} blocks {k}")
        s = sample.build("busy", base=self.T, now=self.T)
        issues = {f"{i['repo']}#{i['n']}": i for i in s["issues"]}
        by_title = {f["title"]: [int(k.split("#")[1]) for k in f["tickets"]] for f in s["features"]}
        self.assertEqual(by_title["Callers"], [193, 205, 212, 213, 218])   # done, in a PR, building, ready, not ready
        self.assertEqual(by_title["Analytics"], [196, 217, 226, 227, 228, 229, 230])
        self.assertEqual({issues[k]["state"] for k in s["features"][-1]["tickets"]}, {"done"})   # a finished one goes last

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
        self.real_dir = Path(tempfile.mkdtemp(prefix="qr-dashboard-real-"))
        self.app = App(self.dir, sample=True, clock=lambda: NOW)
        self.real = App(self.real_dir, clock=lambda: NOW)
        self.server = serve(self.real, self.app, 0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def at(self, host):
        return {"Host": f"{host}:{self.port}"}

    def test_the_host_picks_the_data_queue_localhost_is_the_runners_and_the_rest_are_sample(self):
        raw = json.dumps({"version": 1, "asks": [], "written_at": NOW}).encode()
        (self.real_dir / "snapshot.json").write_bytes(raw)
        status, _, body = self.call("GET", "/snapshot.json?sample=busy", headers=self.at("queue.localhost"))
        self.assertEqual((status, body), (200, raw))   # ?sample= means nothing on the real address
        for host in ("localhost", "127.0.0.1"):
            status, _, body = self.call("GET", "/snapshot.json?sample=busy", headers=self.at(host))
            self.assertEqual((status, json.loads(body)["sample"]["state"]), (200, "busy"), host)
        status, kind, _ = self.call("GET", "/", headers=self.at("queue.localhost"))
        self.assertEqual((status, kind), (200, "text/html; charset=utf-8"))
        for host in ("queue.localhost:1", "evil.localhost:%d" % self.port, "queue.localhost", "127.0.0.1"):
            self.assertEqual(self.call("GET", "/snapshot.json", headers={"Host": host})[0], 403, host)

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(conn.close)
        conn.request(method, path, body=body, headers=headers or {})
        r = conn.getresponse()
        return r.status, r.getheader("Content-Type"), r.read()

    def post(self, body, **headers):
        return self.call("POST", "/control", json.dumps(body), {"Content-Type": "application/json", **headers})

    def json_post(self, path, body):   # from the sample page, as a browser sends it
        return self.call("POST", path, body, {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"})

    def test_a_control_is_taken_only_from_the_address_it_was_sent_to(self):
        real, sample = f"http://queue.localhost:{self.port}", f"http://localhost:{self.port}"
        stop = {"lane": "claude", "stop": "now"}
        self.assertEqual(self.post(stop, Origin=sample, **self.at("queue.localhost"))[0], 403)   # the sample page
        self.assertEqual(self.post(stop, Origin=f"http://127.0.0.1:{self.port}", **self.at("queue.localhost"))[0], 403)
        self.assertEqual(self.post(stop, **self.at("queue.localhost"))[0], 403)   # no Origin: not from a page
        self.assertEqual(self.post(stop, Origin=real, **self.at("localhost"))[0], 403)
        self.assertFalse((self.real_dir / "control.json").exists())
        self.assertEqual(self.app.control()["lanes"], {})

        self.assertEqual(self.post(stop, Origin=real, **self.at("queue.localhost"))[0], 200)
        self.assertEqual(self.real.control()["lanes"]["claude"]["stop"], "now")
        self.assertEqual(self.app.control()["lanes"], {})   # the sample's controls are its own
        self.assertEqual(self.post({"lane": "sol", "stop": "now"}, Origin=sample, **self.at("localhost"))[0], 200)
        self.assertEqual(set(self.real.control()["lanes"]), {"claude"})
        self.assertEqual(set(self.app.control()["lanes"]), {"sol"})

    def test_the_page_the_snapshot_and_the_control_file_are_served(self):
        status, kind, body = self.call("GET", "/")
        self.assertEqual((status, kind), (200, "text/html; charset=utf-8"))
        self.assertIn(b"<title>Queue runner</title>", body)
        status, _, body = self.call("GET", "/snapshot.json?sample=clear")
        snap = json.loads(body)
        self.assertEqual((status, snap["asks"], snap["answered"]), (200, [], []))
        status, _, body = self.call("GET", "/control.json")
        self.assertEqual((status, json.loads(body)["lanes"]), (200, {}))
        self.assertEqual(self.call("GET", "/config.toml")[0], 404)

    def test_an_earlier_take_of_the_page_is_served_with_sample_data_only(self):
        for take in ("take-1", "take-2", "take-3", "take-4", "take-5", "take-6", "take-7", "take-8", "take-9"):
            status, kind, body = self.call("GET", f"/earlier/{take}.html")
            self.assertEqual((status, kind), (200, "text/html; charset=utf-8"))
            self.assertIn(b"<title>Queue runner</title>", body)
        for path in ("/earlier/take-999.html", "/earlier/serve.py", "/earlier/..%2Fserve.py", "/earlier/"):
            self.assertEqual(self.call("GET", path)[0], 404, path)
        self.assertEqual(self.call("GET", "/earlier/take-1.html", headers=self.at("localhost"))[0], 200)
        self.assertEqual(self.call("GET", "/earlier/take-1.html", headers=self.at("queue.localhost"))[0], 404)

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
        origin = {"Origin": f"http://127.0.0.1:{self.port}"}
        self.assertEqual(self.call("POST", "/control", '{"lane":"claude","stop":"now"}', {"Content-Type": "text/plain", **origin})[0], 415)
        self.assertEqual(self.json_post("/control", "{ torn")[0], 400)
        self.assertEqual(self.post({"lane": "claude", "stop": "sideways"}, **origin)[0], 400)
        self.assertEqual(self.json_post("/control", "")[0], 400)
        self.assertEqual(self.json_post("/elsewhere", "{}")[0], 404)
        self.assertEqual(self.app.control()["lanes"], {})


class StartTest(unittest.TestCase):
    """`python3 -m dashboard` as it's started at logon: one process, both addresses, one per port."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="qr-dashboard-start-"))
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]

    def start(self):
        p = subprocess.Popen([sys.executable, "-m", "dashboard", "--port", str(self.port), "--state-dir", str(self.dir)],
                             cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env={**os.environ, "PYTHONUNBUFFERED": "1"})
        self.addCleanup(lambda: (p.kill(), p.wait(), p.stdout.close()))
        return p

    def test_the_start_line_names_both_addresses_and_which_is_which(self):
        first = self.start()
        line = first.stdout.readline()
        self.assertIn(f"http://queue.localhost:{self.port}/", line)
        self.assertIn(f"http://localhost:{self.port}/", line)
        real, sample = line.split(f"http://localhost:{self.port}/")
        self.assertIn("runner", real)
        self.assertIn("sample", sample)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        self.addCleanup(conn.close)
        conn.request("GET", "/snapshot.json", headers={"Host": f"localhost:{self.port}"})
        self.assertIn("sample", json.loads(conn.getresponse().read()))

    def test_there_is_no_sample_switch_any_more_the_address_is_the_switch(self):
        from dashboard.serve import main
        with self.assertRaises(SystemExit) as e, open(os.devnull, "w") as quiet:
            sys.stderr, err = quiet, sys.stderr
            try:
                main(["--sample", "--port", str(self.port)])
            finally:
                sys.stderr = err
        self.assertEqual(e.exception.code, 2)

    def test_a_second_dashboard_on_the_same_port_says_so_and_exits_3(self):
        first = self.start()
        first.stdout.readline()   # it's listening
        second = self.start()
        out, _ = second.communicate(timeout=30)
        self.assertEqual(second.returncode, 3, out)
        self.assertIn(f"A dashboard is already running on port {self.port}", out)
        self.assertIsNone(first.poll())


if __name__ == "__main__":
    unittest.main()
