# 30: Stop and resume a lane, from the page or the CLI

**What to build:** Stefan stops a lane after its job and resumes it from the page, and the
CLI's `--pause` and `--resume` do the same thing. The page, `--gate` and the log use one word
for it, and the pause the runner is in today carries over.

**Blocked by:** 28

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md` (One switch; Today's pause must survive).

- [x] The runner reads `<state_dir>/control.json` before each lane starts a job, and at least
      every `poll_seconds`. `lanes.<id>.stop` of `"after-job"` lets the lane's job finish and
      starts nothing after it; null lets it carry on. `"now"` is treated as `"after-job"`
      until ticket 34.
- [x] The snapshot's lane reads `stopping` while its job runs out and `stopped` (with
      `stopped.at`) after, and `control_read_at` is the `written_at` of the control file the
      runner last acted on, so the page's "asked" turns into the state.
- [x] The reviewing lane obeys too: stopped, it starts no review and merges nothing.
- [x] `--pause [LANE]` and `--resume [LANE]` (default `claude`; `sol`, `all`) write
      `control.json` in the page's format. A test holds the runner's writer and
      `dashboard/serve.py`'s to the same file.
- [x] `gate.json` keeps `reserve` only. With `paused: true` there and no entry for the Claude
      lane in `control.json`, the lane is stopped. An entry, either way, wins.
- [x] **A runner started with `{"paused": true, "reserve": 5.0}` in `gate.json` and no
      `control.json` starts no Claude job.** Tested through the run loop.
- [x] `--gate`, `--once --dry-run` and the log say "stopped by Stefan" where they said paused,
      with how to resume from either end.
- [x] An unreadable `control.json` starts nothing in either lane until it's fixed, and the
      snapshot says so.
- [x] A stopped lane sets no wake task.
- [x] On the page: Stop on a working lane, Resume on a stopped one, and Stop all, each checked
      against a real control file.

## Comments

- 2026-11-15 (build): Built on `dash/30-one-switch`: `queue_runner/control.py` (the switch: `read`,
  `ask`, `carry_over`, the words), wired into `run.py` (both lanes, wake tasks), `snapshot.py`
  and `cli.py`; tests in `tests/test_switch.py`. Checked by hand on
  `http://queue.localhost:<port>/` against a temp state folder, with the real `Snapshots` and
  `Publisher` writing it every 2 seconds: Stop on a working Claude lane (After this build) wrote
  `{"stop": "after-job"}` and the lane read `stopping`, then `stopped` once its job ended, with
  Resume; Resume wrote null and it read idle; Stop all and Resume all wrote both lanes;
  `--pause sol` from the CLI showed the reviewing lane stopped; and gate.json's
  `{"paused": true}` with no control.json showed the Claude lane stopped, whose Resume won over
  it. Choices the ticket left open:
  - The Claude lane settles before it reads its switch (settling records how a dead runner's jobs
    ended and starts nothing), so a lane stopped after a crash doesn't show a finished job as
    `stopping` for ever. Nothing after settling runs while it's stopped: no decision, live
    step, fix round, pick or GitHub read.
  - A stopped reviewing lane skips its whole pass: no stop filed, no merge, no ready mark, no
    review (as it already did while ChatGPT was out of usage). `--review NAME#N` is Stefan's
    own command and still runs.
  - `control_read_at` is the `written_at` of the control.json the snapshot itself read, and each
    lane's state is drawn from that read: every lane reads the file again before it starts
    anything, so the page never shows a state a lane isn't obeying. A Resume shows at once;
    the lane starts its next job within one `poll_seconds`.
  - Unreadable means not JSON, not an object, `lanes` not an object, or an entry without a
    `stop` the page could have written (an unknown lane's bad entry too). Then an idle lane
    reads `waiting` (no `until`, the reason naming the file) and a lane mid-job `working`; any
    Stop or Resume on the page, or `--pause`/`--resume`, writes the file afresh and fixes it.
  - The CLI's writer reads leniently, as `serve.App.control` does (it keeps what it can use),
    while the runner's reader is strict: the two writers leave the same file (tested).
  - gate.json's older pause is moved into control.json by the CLI (`--pause`, `--resume` or
    `--reserve`) with its `at` from gate.json's mtime, and gate.json is then left with
    `reserve` only; the runner never writes either file. `Knob` lost `paused`, and the gate's
    `decide` its `paused` verdict.
  - `knob.paused` in the snapshot (the sample has it) now says whether the Claude lane is
    stopped, the switch's one word; an unreadable gate.json gives `paused` false and `reserve`
    null.
  - `--pause` and `--resume` log `Stefan: <the command>` (they logged `gate knob: ...`).
  - The page needed no change: its Stop, Resume and Stop all already wrote what the runner reads.
