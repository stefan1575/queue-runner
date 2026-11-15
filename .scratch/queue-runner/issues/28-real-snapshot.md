# 28: The runner writes a real snapshot

**What to build:** the running runner publishes `<state_dir>/snapshot.json`, so the dashboard
shows the truth about the runner: that it's up, what each lane is doing or why it isn't, usage,
and that it's paused. The work lists stay empty until tickets 31 and 32.

**Blocked by:** None (can start immediately)

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`. The shape is `dashboard/sample.py`.

- [x] `queue_runner/snapshot.py`: a pure `build(...)` (no I/O, a fixed clock in tests) and a
      publisher that writes the file whole (a temp file, then `os.replace`).
- [x] In continuous mode it is written after every pass of either lane and at least every
      `write_every` seconds (30) while the runner is up, also while a lane is blocked inside a
      job. A write that fails is logged once and never stops a lane.
- [x] Real in this ticket: `version`, `written_at`, `write_every`, `control_read_at` (null),
      `runner` (pid, start time, commit), `start_hint`, `sources` (GitHub, T3, Claude usage,
      ChatGPT usage: each from the last real call of its kind, with when), `repos` in config
      order, `usage`, `knob`, `costs`, `roles`, and `lanes`: `state`, the open `job` from the
      job log with its thread link, `wait` (`until`, `reason`, from the gate's verdict or a
      limit's resume), `stop_now` as not available.
- [x] A lane paused through `gate.json` reads `state: "stopped"`, with when.
- [x] `asks`, `answered`, `features`, `issues`, `prs`, `activity` and each lane's `queue` are
      present and empty, and the page shows a real snapshot like that without an error.
- [x] `python3 -m queue_runner --snapshot` prints one snapshot built from the real state. It
      takes no lock and starts, posts and records nothing.
- [x] A contract test holds the real snapshot to the sample's keys: top level, and inside a
      lane, a usage plan, a window and a source.
- [x] `--once` writes no snapshot.

## Comments

- 2026-11-15 (the build): `queue_runner/snapshot.py` (`build`, `Facts`, `Snapshots`, `Calls`,
  `Watch`, `Publisher`), wired into `run.py` and `cli.py`; tests in `tests/test_snapshot.py` and
  `tests/test_snapshot_runner.py`. Checked against a real snapshot (`--snapshot` from the live,
  paused state, and a made-up one with a fix running, ChatGPT waiting and GitHub failing), served
  with `python3 -m dashboard --state-dir <temp>`: no page threw. Decisions the spec didn't settle:
  - Paused with a Claude job still running reads `stopping` (the job, then nothing), as the
    sample's stop-after-job does; `stopped` once no job is open. "When" is gate.json's mtime.
  - A lane with nothing to do and no wait reads `idle` (the page already says "Idle" for it).
  - A source never called since the runner started is `ok: true`, note "Not called yet",
    `checked_at: null`; a failing source's `checked_at` is its last good call, as the page reads
    it. Every adapter call counts: a GitHub 404 marks GitHub failing until its next answer.
  - ChatGPT's usage is the newest `rate_limits` record with a window in any of Codex's 20 newest
    rollouts (`sol.latest_limits`): the plan is the account's, so Stefan's own sessions count.
  - The 5-minute usage reads, and looking up an open job's T3 thread, happen only on the
    publisher's own 30-second writes; a write after a pass reuses what is known. A job's title is
    what the pass that started it read (`Runner.titles`); a job a dead runner left open has none.
  - `stop_now` is `available: false` ("Stop now isn't built yet"): ticket 30's.
  - `--snapshot` takes the runner's pid and start from runner.pid (its mtime), and the commit from
    the checkout it runs in.
  - The page changed only where real data is null: a source never answered, a window not
    started, usage not read yet, the runner's start or pid unknown (`dashboard/index.html`).
