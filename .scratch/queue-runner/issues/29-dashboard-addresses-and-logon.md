# 29: The dashboard's addresses, one at a time, at logon

**What to build:** `http://queue.localhost:5289/` shows the runner's real snapshot and writes
its real controls; `http://localhost:5289/` and `http://127.0.0.1:5289/` show sample data. Only
one dashboard runs, and it starts at logon beside the runner.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. Today `dashboard/serve.py:132` answers `queue.localhost` with 403,
and seven dashboards were found listening at once, three of them on 5289 (Python's
`HTTPServer` sets `allow_reuse_address`, which on Windows lets a second process bind the port).

- [ ] One process serves both. The request's `Host` picks the data: `queue.localhost:<port>` is
      real (`--state-dir`), `localhost:<port>` and `127.0.0.1:<port>` are sample, with their
      controls in a temp folder. Any other `Host` is refused as now.
- [ ] A `POST /control` is taken only when its `Origin` is the address it was sent to, so the
      sample page can never write the real control file.
- [ ] `--sample` goes. `?sample=<state>` and `/earlier/take-N.html` work on the sample
      addresses only. The variant pill and the sample menu never show on the real address.
- [ ] The real address with no `snapshot.json` yet says the runner hasn't written one, with how
      to start it, and offers no controls.
- [ ] The port is bound exclusively. A second start says a dashboard is already running there
      and exits 3. A test starts two on one port.
- [ ] `scripts/make_shortcut.py` also makes `Queue runner dashboard.lnk` (`pythonw -m
      dashboard` in this repo), and with `--startup` copies both shortcuts into the Startup
      folder. Its paths can be given, so a test makes them in a temp folder. Don't run it
      against the real folders.
- [ ] The start line prints both addresses and which is which.

## Comments
