# 31: The Inbox shows what really waits on Stefan

**What to build:** the snapshot's `asks` and `answered` are the real ones, so the Inbox page
lists every PR ready for him to merge, every stop, and every thread waiting for his answer,
each written to be picked up cold.

**Blocked by:** 28

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`. `queue_runner/inbox.py` already collects the three kinds for
`--inbox`; the ask's shape is in AGENTS.md (The dashboard, "An ask is written to be picked up
cold") and `dashboard/sample.py`.

- [x] One collection feeds both the snapshot and `--inbox`, so they can't disagree.
- [x] Each ask has a stable `id` across snapshots, `kind`, `repo`, `ref`, `pr`, `subject` (the
      PR's or issue's title), `since`, `situation`, `about`, `because`, `timeline`, `question`,
      `options`, `holds_up` and `go` (`label`, `url`, `where`).
- [x] Kinds: `merge` (ready for him in a repo he merges), `stuck` (a review stop, an approach
      note, a fix round that pushed nothing, a conflict it couldn't resolve), `decision` (a
      decision's stop, a build a decision left to him, a thread waiting for his answer),
      `broken` (a failed check, a live run that stopped).
- [x] The sentences come from templates, with no AI: `about` from the issue's or PR's own first
      lines, clipped; `because` from the stop's reason; `timeline` from the job log, oldest
      first, one whole sentence per step with its time (built, each review and its verdict,
      each fix round, the stop).
- [x] An approach note's ask offers `rework`, `fix on` and `hold`, with the note's
      recommendation marked.
- [x] `answered`: a stop he has answered that the runner hasn't finished acting on, with `at`,
      `said` and `next`.
- [x] Order: broken, stuck, decision, merge; oldest first inside a kind.
- [x] GitHub is read in the pass, not for the snapshot. When it can't be read, the last asks
      stay, and the GitHub source says since when and what that affects.
- [x] A contract test holds a real ask of each kind to the sample ask's keys.

## Comments

- 2026-11-15 (the build): `inbox.collect` is the one collection (`--inbox` prints it,
  `inbox.Reader` keeps the Sol lane's last read for the snapshot); `queue_runner/asks.py` writes
  the asks from it and the job log. Tests in `tests/test_asks.py`, `CollectTest` in
  `tests/test_inbox.py` and `InboxTest` in `tests/test_snapshot_runner.py`. Checked by hand on
  `http://queue.localhost:5311/?page=inbox` against a scratch snapshot of today's real state
  (seven asks: three stuck, four ready to merge).
- **The sample changed:** its two `answered` asks gained `options` (the ticket wants `options`
  on every ask; the page doesn't show them on an answered one), so the contract test holds.
- **holds_up reads GitHub's native dependencies** (`GhCli.blocking`) as well as `Blocked by:`
  lines: leads-dashboard records its blockers only natively, so text alone found none.
- **Not built:** a timeline can't tell what came before the runner's job log (PRs #151 and #152
  start at a conflict round). Today's state has no `decision` or `broken` ask, so those kinds
  were checked in tests only.
