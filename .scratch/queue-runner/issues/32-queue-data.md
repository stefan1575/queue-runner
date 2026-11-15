# 32: The work, the PRs and what happened, in the snapshot

**What to build:** the snapshot's `issues`, `features`, `prs`, `activity` and each lane's
`queue` are real, so the Queue, Overview and Activity pages show the actual work and what the
runner takes up next.

**Blocked by:** 28

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. The shapes and their orders are in `dashboard/sample.py`
(`_issues`, `_prs`, `_activity`, `_number`, `_order`, `_tickets`, `_queue`) and AGENTS.md (The
dashboard).

- [ ] `issues`: each served repo's open issues, and the closed ones of a feature that still has
      open work, with `state` (`done` only once live, `merged`, `review`, `fixing`, `building`,
      `you`, `ready`, `blocked`, `not-ready`), `feature`, `pr`, `blocked_by`, `note` and
      `pick`: the order the picker would really build them in.
- [ ] `features`: a spec issue with sub-issues is a feature; in build order, each with its
      `tickets` in the order they're built.
- [ ] `prs`: each open PR with `status`, `next`, `checks` (the merge re-check's own reasons)
      and its `timeline` by head from the job log.
- [ ] Each lane's `queue` in the order it really takes things up: a job a limit cut off, live
      steps, fix and conflict rounds, then builds; the PRs waiting for review. `queue_empty`
      says why there's none.
- [ ] `activity`: the job log, newest first, the latest 200, each a whole sentence.
- [ ] A PR left alone (a review from before the cutover, two failed reviews) says so in its
      `status` and `next`, with what lets it go.
- [ ] GitHub is read in the passes, at most once per pass per repo beyond what the pass already
      reads. When it can't be read, the last lists stay and the GitHub source says so.
- [ ] A contract test holds a real issue, feature, PR, queue entry and activity row to the
      sample's keys.

## Comments
