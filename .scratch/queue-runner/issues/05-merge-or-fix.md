# 05: Merge a clean PR, or run a fix round on a blocking one

**What to build:** the runner acts on the verdict. **Clean:** just before merging it reads the PR
again (head still H, checks passed on H, no open discussion), merges with the expected head
(`gh api repos/<o>/<r>/pulls/<n>/merge -X PUT -f sha=H -f merge_method=merge`), removes the job's
worktree and logs "merged". If the head moved, it reviews again. **Blocking:** it starts a fresh
Claude fix thread in the PR's worktree from the PR head, with a fix brief built from the ledger
(every case of each Important class, failing test first where it fits, or a decline on the PR with
the finding's ID, reason and evidence), which pushes to the PR's branch; the next review then
runs on the new head. One writer per PR at a time.

**Blocked by:** 04

**Status:** done (2026-11-10)

- [x] The pre-merge re-check and the expected-head merge are tested against fakes, including a
      head that moved and a check that failed between review and merge.
- [x] The fix brief has no handoff file: findings, classes and earlier declines come from the
      ledger, the branch's commits and diff from git, an earlier thread's link from T3.
- [x] A fix thread that ends without pushing is recorded and not re-reviewed on the same head.
- [x] A worktree is removed after its PR merges; the repo's live steps are not run here (11).
- [x] One cheap live check of the fix-round start (a dry run printing the fix brief for a real
      blocking PR is enough) and of the merge path against a sandbox repo, noted in Comments.

## Comments

**2026-11-10, built** in `~/Code/Personal/queue-runner`, commits `e411a12` and `842ef70` (the
code review's fixes); 198 tests pass (`python3 -m unittest`). The runner's `AGENTS.md` has the
whole flow (A Claude pass, step 2; A Sol pass, step 2).

What's there:
- **Merge** (`merge.py`, in the Sol lane): right after a clean review posts, and each pass for a
  PR the runner found clean on its head. Before merging, the PR is read again: open, still at H,
  not a draft, no Claude job writing to it, its newest review comment the clean one on H, checks
  passed on H, no conflict, nothing said since bar bots, and no unresolved review thread. Then
  `PUT .../merge` with `sha=H` and `merge_method=merge`. After a merge, the PR's build and fix
  worktrees and local branches are removed. Live steps are left to 11.
- **Fix round** (`fix.py`, `templates/fix.md`, in the Claude lane, ahead of new builds): a fresh
  thread whose brief comes from the ledger, git and the job log, with no handoff file. It pushes
  to the PR's branch, and Sol reviews the new head.

Decisions (mechanics):
- **The fix round's worktree:** a fresh T3 worktree at H, on a local branch
  `claude/fix-pr<n>-<H7>` that never goes to origin. The round pushes with
  `git push origin HEAD:<pr-branch>`. It can't use the PR's own worktree: T3's CLI can only start
  a thread in the project folder or a new worktree, and the build's worktree may still hold the
  PR's branch.
- **One round per head.** Once a round on H ends, H gets no other, whatever the outcome, until
  `--release NAME#PR`. A round that ends without pushing is recorded as `no-push`. H was already
  reviewed, so the PR waits for you (06 files the stop).
- **One writer per PR** (`JobLog.writer`): while a build or fix job is open, or waiting for an
  answer, on a PR's branch, the PR gets no review, no merge and no other round.
- **"No open discussion"** means three things: no comment, review reply or review body since the
  clean review (bots aside), no unresolved review thread, and not a draft.
- **Failed merges:** two on the same H leave the PR until a new push or `--release`.
- **Order of decisions in `--once`:** the Claude lane picks its job before the Sol lane starts.
  So the results of that pass's review wait for the next pass.

**Live, 2026-11-10:**
- **Fix-round start:** `python3 scripts/live_fix_brief.py leads-dashboard#173` printed the fix
  brief for the runner's review 1 of `a2326af`. The brief had F1 with its class and cost, the PR,
  its one commit and `GLOSSARY.md | 23 +`, and "none started by the runner" for earlier threads.
  Since then #173's head has moved to `1fa3cb8`, so the real lane would have Sol review that
  instead. No other open PR has a blocking runner review.
- **Merge path:** I made a private GitHub sandbox, `stefan1575/queue-runner-sandbox`, for this
  check. It's safe to delete; the local sandbox has no GitHub. `python3 scripts/live_merge.py`
  ran there on PR #1, with Sol stubbed as clean and everything else real:
  1. Review 1 was clean on `413cf31`. Then a push moved the head to `68b8bad`, and the merge pass
     didn't merge.
  2. A merge that expected the old head was refused by GitHub ("Head branch was modified",
     HTTP 409).
  3. Review 2 was clean on `68b8bad` and the Sol lane merged it (merge commit `866210b`, two
     parents). The build worktree and its branch were removed.

**For you (not blocking):**
- **PRs reviewed in your sessions:** the runner acts only on its own reviews. A PR whose newest
  review was hand-run, like leads-dashboard #152, #162, #163 and #168, all blocking on their
  heads, gets no fix round or merge from it. Those PRs stay with the sessions that reviewed them,
  as before.
- **A round that only declines** and pushes nothing ends as `no-push`. Sol then never reconsiders
  the decline, so the PR comes to you. The brief asks for a pushed test as the evidence, which
  avoids this.
- **A repo with no CI** never merges, because "checks passed on H" needs at least one check.
  leads-dashboard has CI.
