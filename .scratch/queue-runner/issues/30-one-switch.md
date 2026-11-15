# 30: Stop and resume a lane, from the page or the CLI

**What to build:** Stefan stops a lane after its job and resumes it from the page, and the
CLI's `--pause` and `--resume` do the same thing. The page, `--gate` and the log use one word
for it, and the pause the runner is in today carries over.

**Blocked by:** 28

**Status:** ready-for-agent

Spec: `../dashboard-live.md` (One switch; Today's pause must survive).

- [ ] The runner reads `<state_dir>/control.json` before each lane starts a job, and at least
      every `poll_seconds`. `lanes.<id>.stop` of `"after-job"` lets the lane's job finish and
      starts nothing after it; null lets it carry on. `"now"` is treated as `"after-job"`
      until ticket 34.
- [ ] The snapshot's lane reads `stopping` while its job runs out and `stopped` (with
      `stopped.at`) after, and `control_read_at` is the `written_at` of the control file the
      runner last acted on, so the page's "asked" turns into the state.
- [ ] The reviewing lane obeys too: stopped, it starts no review and merges nothing.
- [ ] `--pause [LANE]` and `--resume [LANE]` (default `claude`; `sol`, `all`) write
      `control.json` in the page's format. A test holds the runner's writer and
      `dashboard/serve.py`'s to the same file.
- [ ] `gate.json` keeps `reserve` only. With `paused: true` there and no entry for the Claude
      lane in `control.json`, the lane is stopped. An entry, either way, wins.
- [ ] **A runner started with `{"paused": true, "reserve": 5.0}` in `gate.json` and no
      `control.json` starts no Claude job.** Tested through the run loop.
- [ ] `--gate`, `--once --dry-run` and the log say "stopped by Stefan" where they said paused,
      with how to resume from either end.
- [ ] An unreadable `control.json` starts nothing in either lane until it's fixed, and the
      snapshot says so.
- [ ] A stopped lane sets no wake task.
- [ ] On the page: Stop on a working lane, Resume on a stopped one, and Stop all, each checked
      against a real control file.

## Comments
