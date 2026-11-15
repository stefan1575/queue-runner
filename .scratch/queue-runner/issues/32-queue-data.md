# 32: The work, the PRs and what happened, in the snapshot

**What to build:** the snapshot's `issues`, `features`, `prs`, `activity` and each lane's
`queue` are real, so the Queue, Overview and Activity pages show the actual work and what the
runner takes up next.

**Blocked by:** 28

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`. The shapes and their orders are in `dashboard/sample.py`
(`_issues`, `_prs`, `_activity`, `_number`, `_order`, `_tickets`, `_queue`) and AGENTS.md (The
dashboard).

- [x] `issues`: each served repo's open issues, and the closed ones of a feature that still has
      open work, with `state` (`done` only once live, `merged`, `review`, `fixing`, `building`,
      `you`, `ready`, `blocked`, `not-ready`), `feature`, `pr`, `blocked_by`, `note` and
      `pick`: the order the picker would really build them in.
- [x] `features`: a spec issue with sub-issues is a feature; in build order, each with its
      `tickets` in the order they're built.
- [x] `prs`: each open PR with `status`, `next`, `checks` (the merge re-check's own reasons)
      and its `timeline` by head from the job log.
- [x] Each lane's `queue` in the order it really takes things up: a job a limit cut off, live
      steps, fix and conflict rounds, then builds; the PRs waiting for review. `queue_empty`
      says why there's none.
- [x] `activity`: the job log, newest first, the latest 200, each a whole sentence.
- [x] A PR left alone (a review from before the cutover, two failed reviews) says so in its
      `status` and `next`, with what lets it go.
- [x] GitHub is read in the passes, at most once per pass per repo beyond what the pass already
      reads. When it can't be read, the last lists stay and the GitHub source says so.
- [x] A contract test holds a real issue, feature, PR, queue entry and activity row to the
      sample's keys.

## Comments

2026-11-15 (built): `queue_runner/work.py`. The read goes through the lanes' own code (decisions,
the live batch, fix candidates, the picker's whole order, review candidates, the merge
re-check as steps), so the queues agree with `--once --dry-run`; checked on the real state the
same day: Claude's queue is leads-dashboard's live steps (PR #209), the fix round on PR #208,
then game-backdrop #4 to #9; the reviewing lane's is empty (every open PR is reviewed, held,
conflicted or left alone), as the dry run says. No change to the sample or the page was needed.

Decisions the spec didn't settle:
- The queue lists only what may go now: a conflicted PR waiting for another's conflict round is
  out of it, and its PR's `next` says why.
- Decisions are in the Claude queue (first after a limited job), as `Runner.choose` takes them.
- Every open issue with sub-issues is a feature, a map too (leads-dashboard #12); a feature
  inside another is left out of the outer one's tickets. "Spec:" and "Map:" come off the title.
- The runner's own `needs-info` issues aren't listed as issues: they are asks.
- A held PR's `held` and a writer are read with the rest (up to one Sol pass old); the open job
  on a PR is the job log now.
- The read takes about a minute for the three repos (80 `gh` calls, half the Inbox's), after
  each Sol pass; one `Memo` makes each call once for both.
