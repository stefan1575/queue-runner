# The dashboard on real data: where it stands

The spec (Decided, For whoever builds a ticket) is issue #9 since 2026-11-16, and each ticket is
an issue under it: ticket NN is #(NN+9). This file is the handoff for picking the work up after
Stefan's rethink; delete it once PR #6 is merged.

**Merging `dashboard-live` or a `dash/*` branch into main:** those branches still carry their
copies of the ticket files, which main deleted. Take the deletion; the issue holds the text.

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
