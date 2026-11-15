# 31: The Inbox shows what really waits on Stefan

**What to build:** the snapshot's `asks` and `answered` are the real ones, so the Inbox page
lists every PR ready for him to merge, every stop, and every thread waiting for his answer,
each written to be picked up cold.

**Blocked by:** 28

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. `queue_runner/inbox.py` already collects the three kinds for
`--inbox`; the ask's shape is in AGENTS.md (The dashboard, "An ask is written to be picked up
cold") and `dashboard/sample.py`.

- [ ] One collection feeds both the snapshot and `--inbox`, so they can't disagree.
- [ ] Each ask has a stable `id` across snapshots, `kind`, `repo`, `ref`, `pr`, `subject` (the
      PR's or issue's title), `since`, `situation`, `about`, `because`, `timeline`, `question`,
      `options`, `holds_up` and `go` (`label`, `url`, `where`).
- [ ] Kinds: `merge` (ready for him in a repo he merges), `stuck` (a review stop, an approach
      note, a fix round that pushed nothing, a conflict it couldn't resolve), `decision` (a
      decision's stop, a build a decision left to him, a thread waiting for his answer),
      `broken` (a failed check, a live run that stopped).
- [ ] The sentences come from templates, with no AI: `about` from the issue's or PR's own first
      lines, clipped; `because` from the stop's reason; `timeline` from the job log, oldest
      first, one whole sentence per step with its time (built, each review and its verdict,
      each fix round, the stop).
- [ ] An approach note's ask offers `rework`, `fix on` and `hold`, with the note's
      recommendation marked.
- [ ] `answered`: a stop he has answered that the runner hasn't finished acting on, with `at`,
      `said` and `next`.
- [ ] Order: broken, stuck, decision, merge; oldest first inside a kind.
- [ ] GitHub is read in the pass, not for the snapshot. When it can't be read, the last asks
      stay, and the GitHub source says since when and what that affects.
- [ ] A contract test holds a real ask of each kind to the sample ask's keys.

## Comments
