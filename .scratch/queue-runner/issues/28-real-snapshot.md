# 28: The runner writes a real snapshot

**What to build:** the running runner publishes `<state_dir>/snapshot.json`, so the dashboard
shows the truth about the runner: that it's up, what each lane is doing or why it isn't, usage,
and that it's paused. The work lists stay empty until tickets 31 and 32.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. The shape is `dashboard/sample.py`.

- [ ] `queue_runner/snapshot.py`: a pure `build(...)` (no I/O, a fixed clock in tests) and a
      publisher that writes the file whole (a temp file, then `os.replace`).
- [ ] In continuous mode it is written after every pass of either lane and at least every
      `write_every` seconds (30) while the runner is up, also while a lane is blocked inside a
      job. A write that fails is logged once and never stops a lane.
- [ ] Real in this ticket: `version`, `written_at`, `write_every`, `control_read_at` (null),
      `runner` (pid, start time, commit), `start_hint`, `sources` (GitHub, T3, Claude usage,
      ChatGPT usage: each from the last real call of its kind, with when), `repos` in config
      order, `usage`, `knob`, `costs`, `roles`, and `lanes`: `state`, the open `job` from the
      job log with its thread link, `wait` (`until`, `reason`, from the gate's verdict or a
      limit's resume), `stop_now` as not available.
- [ ] A lane paused through `gate.json` reads `state: "stopped"`, with when.
- [ ] `asks`, `answered`, `features`, `issues`, `prs`, `activity` and each lane's `queue` are
      present and empty, and the page shows a real snapshot like that without an error.
- [ ] `python3 -m queue_runner --snapshot` prints one snapshot built from the real state. It
      takes no lock and starts, posts and records nothing.
- [ ] A contract test holds the real snapshot to the sample's keys: top level, and inside a
      lane, a usage plan, a window and a source.
- [ ] `--once` writes no snapshot.

## Comments
