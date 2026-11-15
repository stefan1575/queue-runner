# 29: The dashboard's addresses, one at a time, at logon

**What to build:** `http://queue.localhost:5289/` shows the runner's real snapshot and writes
its real controls; `http://localhost:5289/` and `http://127.0.0.1:5289/` show sample data. Only
one dashboard runs, and it starts at logon beside the runner.

**Blocked by:** None (can start immediately)

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`. Today `dashboard/serve.py:132` answers `queue.localhost` with 403,
and seven dashboards were found listening at once, three of them on 5289 (Python's
`HTTPServer` sets `allow_reuse_address`, which on Windows lets a second process bind the port).

- [x] One process serves both. The request's `Host` picks the data: `queue.localhost:<port>` is
      real (`--state-dir`), `localhost:<port>` and `127.0.0.1:<port>` are sample, with their
      controls in a temp folder. Any other `Host` is refused as now.
- [x] A `POST /control` is taken only when its `Origin` is the address it was sent to, so the
      sample page can never write the real control file.
- [x] `--sample` goes. `?sample=<state>` and `/earlier/take-N.html` work on the sample
      addresses only. The variant pill and the sample menu never show on the real address.
- [x] The real address with no `snapshot.json` yet says the runner hasn't written one, with how
      to start it, and offers no controls.
- [x] The port is bound exclusively. A second start says a dashboard is already running there
      and exits 3. A test starts two on one port.
- [x] `scripts/make_shortcut.py` also makes `Queue runner dashboard.lnk` (`pythonw -m
      dashboard` in this repo), and with `--startup` copies both shortcuts into the Startup
      folder. Its paths can be given, so a test makes them in a temp folder. Don't run it
      against the real folders.
- [x] The start line prints both addresses and which is which.

## Comments

- 2026-11-15 (build): Built on `dash/29-dashboard-addresses`. Choices the ticket left open:
  - A `POST /control` with no `Origin` is refused too, not only a wrong one: browsers send
    `Origin` on every POST, and the CLI writes `control.json` itself, not through the server.
  - The real address strips a `sample` key from the runner's snapshot before serving it, so the
    sample menu and the variant pill can't show there whatever the file holds.
  - "How to start it" is the server's: the 404's `start` field (`serve.START_RUNNER`), which the
    page shows under "The runner hasn't written a snapshot yet". The page offered no controls
    without a snapshot already.
  - The sample's controls go in a `TemporaryDirectory`, removed when the dashboard stops.
  - Exclusive bind is `SO_EXCLUSIVEADDRUSE` on Windows, with `allow_reuse_address` off
    everywhere. Checked: with `SO_REUSEADDR` put back, the two-start test fails (the second binds).
  - `make_shortcut.py` takes `--dir`, `--startup-dir` and `--pythonw`; its test makes real `.lnk`
    files in temp folders and reads them back. It was not run against the real folders.
  - Checked by hand on port 5307 with a temp `--state-dir`: `queue.localhost` gave the 404 with
    the start hint, `localhost` the sample, `/earlier/take-1.html` 200 on `127.0.0.1` and 404 on
    `queue.localhost`, the sample's `Origin` refused on the real address, the real one written,
    and a second start exited 3.
