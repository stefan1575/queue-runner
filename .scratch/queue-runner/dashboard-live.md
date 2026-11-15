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

## Where it stands (2026-11-16, 01:10)

Stefan stopped here to rethink. Nothing below is live: the running runner is the Nov 11 code,
with its Claude lane paused.

- **Built:** tickets 28 to 33 and 35 to 39, on the branch `dashboard-live` (head `e695d2c`,
  764 tests passing), open as PR #6, now a draft. Tickets 34 and 40 are pinned, 41 needs triage.
- **Review:** Sol's review 1 found eight Important findings (F1 to F8), all fixed. Review 2
  found one more, F9, in F2's class, so the runner stopped the loop for Stefan (needs-info
  issue #7). F9: with `control.json` holding JSON `null`, resuming one lane lets the other go
  too, in `queue_runner/control.py` (`repaired`) and `dashboard/serve.py` (`usable`): both
  treat a parsed `null` as a missing file. Sol's test for it is still readable at
  `~/.queue-runner/checkouts/queue-runner-pr6/tests/test_review2_controls.py` (the checkout
  left behind, ticket 45; it goes at the next review of PR #6, so copy the test first).
- **Not in PR #6:** tickets 42, 43 and 44, built by another session on `dash/42-usage-refresh`,
  `dash/43-status-sources` and `dash/44-inbox-row-icons`. 42 conflicts with the fix round in
  `serve.py`, `sol.py` and `snapshot.py`, and its new control request must start from
  `usable()`.
- **Before a first run on game-backdrop:** F9 fixed and PR #6 merged; each served T3 project's
  default model set to Opus 5.5 at high (ticket 39's Comments); the seven old dashboards
  stopped and `python3 scripts/make_shortcut.py --startup` run; then on
  `http://queue.localhost:5289/` stop leads-dashboard and resume the Claude lane.
- **Known and not fixed:** a second review of a PR in this repo fails until the leftover
  checkout is moved aside (ticket 45; also what holds PR #4); reading the work lists takes
  about 70 seconds a pass; the page was checked in a browser by each ticket's builder, not as
  a whole.
