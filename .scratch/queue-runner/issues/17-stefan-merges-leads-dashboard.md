# 17: Stefan merges leads-dashboard PRs; the runner tells him when one is ready

**What to build:** for leads-dashboard the runner no longer merges. When a PR is ready (Sol's
review clean on its newest commit, checks passed, nothing open), the runner marks it ready for
Stefan: a toast that opens the PR, and a `ready-for-stefan` label. It notices when Stefan merges
(the PR's state on its next pass) and then runs the live steps (11). Queue-runner keeps merging
itself (14). Per repo in `config.toml`: `merge = "runner"` or `merge = "stefan"`.

The problem this solves (Stefan, 2026-11-10): he can't tell when something needs him. So
`python3 -m queue_runner --needs-me` lists everything waiting on him in one place: PRs ready to
merge, `needs-info` stops, threads waiting for an answer.

Rule changes, with wording shown to Stefan before they're written: `~/.claude/CLAUDE.md`
("Merge when the review is clean"), `~/.claude/docs/pr-review.md`, and leads-dashboard's
`docs/agents/review-loop.md` (13 rewrites the rest of that file).

**Blocked by:** None

**Status:** done (2026-11-10)

- [x] A ready leads-dashboard PR gets its toast and label once, not every pass.
- [x] Stefan's merge is noticed and the live steps run after it.
- [x] `--needs-me` lists all three kinds, and says "nothing" when there's nothing.

## Comments

**Built (2026-11-10).** `config.toml`'s leads-dashboard entry says `merge = "stefan"`; `merge.py`
marks a ready PR (`ready-for-stefan` label and a toast, a `ready` job `marked`, once per head),
takes the mark off when the head moves or the PR is held, and records Stefan's merge as a `merge`
job `merged` when a marked PR leaves the open list (its worktrees removed). The live steps read his
merge from git as before, and no ready PR holds them in a repo he merges. `--needs-me`
(`needs_me.py`) lists ready PRs, filed stops, builds a decision left to him, and threads waiting
for his answer. Tests: `StefanMergesTest` (`tests/test_merge.py`), `tests/test_needs_me.py`, one
in `tests/test_live.py`. AGENTS.md: Stefan merges.

Not checked live: no real leads-dashboard PR has gone through it (the runner isn't cut over, 13).
A **rebase merge** names no PR in its commits, so its live steps wait for the next PR's batch:
merge with a merge commit (GitHub's default button) or squash.

**Rule changes, drafted for Stefan to approve** (not written; the files are outside this repo):

1. `~/.claude/CLAUDE.md`, "Merge when the review is clean", replace the bullet with:

   > - **Merge when the review is clean** (user, 2026-11-05; leads-dashboard changed 2026-11-10).
   >   Once Sol's review is clean on a PR's newest commit, its checks passed on that commit, and no
   >   finding or reply on it is still open, the queue runner merges it itself, except in
   >   leads-dashboard, where I merge: the runner labels the PR `ready-for-stefan` and toasts me
   >   once, and runs the live steps after my merge. A session never merges a leads-dashboard PR.
   >   Anything that blocks a merge (a finding Sol keeps open, the review loop's note at review 3,
   >   a failed check, a conflict) comes to me instead. After a merge, finish what the repo says
   >   makes a merge live (leads-dashboard: `docs/agents/lovable-cloud.md`) and tell me in one
   >   line. `python3 -m queue_runner --needs-me` lists everything waiting on me.

   (The cloud copies in each repo's `.claude/cloud/user-rules.md` need the same change, per
   CLAUDE.md's "Cloud sessions don't read this file".)

2. `~/.claude/docs/pr-review.md`, `## Merge`, replace the first sentence ("A clean review, in any
   round, merges per `~/.claude/CLAUDE.md`.") and "The runner does this itself." with:

   > A clean review, in any round, merges per `~/.claude/CLAUDE.md`: the runner merges, except in
   > a repo whose `config.toml` entry says `merge = "stefan"` (leads-dashboard), where it labels
   > the PR `ready-for-stefan`, toasts Stefan once per head, takes the label off if the head moves
   > or the PR stops, and notices his merge on its next pass.

   and add after "Report merged and live separately.":

   > A merge Stefan makes needs a merge commit or a squash (a rebase merge names no PR, so its
   > live steps wait for the next PR).

3. leads-dashboard `docs/agents/review-loop.md`, step 3 of the loop, replace
   "3. **Merge** when clean, after checking the head is still the reviewed commit." with:

   > 3. **Ready for Stefan** when clean: the queue runner labels the PR `ready-for-stefan` and
   >    toasts him; Stefan merges it (a merge commit or a squash, not a rebase), and the runner
   >    runs the live steps after.

   and in "Opening a PR", step 2, replace "After a merge it finishes the live steps" with "After
   Stefan merges, it finishes the live steps". (13 rewrites the rest of that file.)
