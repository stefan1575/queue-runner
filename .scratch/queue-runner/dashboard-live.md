# The dashboard on real data

The spec for tickets 28 to 36: ticket 18's runner side, split (Stefan, 2026-11-15: "let's
prioritize that first over the UI"; "implement everything end to end"). The page's look is not
part of this. The Overview and Queue variants (tickets 20, 21, 25 to 27) rearrange the same
snapshot and go on separately.

## Decided

- **Real and sample by address** (Stefan, 2026-11-15): `http://queue.localhost:5289/` is the
  real one, the runner's own snapshot and controls. `http://localhost:5289/` and
  `http://127.0.0.1:5289/` are sample data, for judging the page. One process serves both.
- **One switch** (Stefan, 2026-11-15): pausing and the page's Stop on the Claude lane are the
  same thing. The CLI and the page read and write one record, so both always say the same word.
- **The record is `control.json`** (mine): `lanes.<id>.stop` is `"after-job"`, `"now"` or null.
  `--pause` and `--resume` write it as the page does. `gate.json` keeps only `reserve`.
- **Today's pause must survive** (mine): the runner is paused now through `gate.json`
  (`{"paused": true, "reserve": 5.0}`), and there is no `control.json`. A runner starting on the
  new code with those two facts starts no Claude job, and the page shows the lane stopped.
- **`dashboard/sample.py` is the contract.** The real snapshot has the shape it builds. Where a
  real field can't be filled honestly, change the sample and the page together, and say so in
  the ticket's Comments.
- **The runner has no AI in it**, so an ask's sentences come from templates filled from the job
  log, GitHub and the stop's own reason.
- **GitHub is read by the passes, not by the snapshot.** The publisher reuses what a pass read
  and writes from memory between passes. Reading Claude's usage for the snapshot is allowed at
  most once every 5 minutes.

## For whoever builds a ticket

- **A live runner is running on this PC, on older code, paused, against `~/.queue-runner/`.**
  Don't run `python3 -m queue_runner` bare or with `--once`, `--review`, `--release`, `--pause`,
  `--resume`, `--reserve` or `--stop`, and write nothing under `~/.queue-runner/` or the Startup
  folder. Tests use temp folders. `--once --dry-run`, `--gate` and `--inbox` only read.
- Standard library only. Tests never touch the network, T3, Task Scheduler or the real state.
- `dashboard/` imports nothing from `queue_runner/`, and the runner nothing from `dashboard/`.
  Tests may import both to hold them to one contract.
- **Leave the page's layout alone.** Change `dashboard/index.html` only where real data needs
  it (a field read differently, a missing-field guard, a control's request).
- Build with the `tdd` skill. Run one test file often and `python3 -m unittest` at the end.
- Update `AGENTS.md` in the same commits: The dashboard, Run it, Layout and Tests.
- Work on a branch `dash/NN-<slug>` based on `dashboard-live`. Never name a branch `claude/*`
  (the runner's picker reads those as its own builds), and push nothing.
- When done: tick the ticket's boxes, set its Status to `done (date)`, merge `dashboard-live`'s
  tip into your branch, run the full suite, commit.
