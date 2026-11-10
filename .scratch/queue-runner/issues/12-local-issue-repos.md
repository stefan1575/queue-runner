# 12: Repos that keep their issues locally

**What to build:** the runner also picks tickets from repos that keep issues as local markdown
(`.scratch/*/issues/*.md`, per that repo's `docs/agents/issue-tracker.md`): status
`ready-for-agent`, every `Blocked by:` ticket `done`, lowest number first. Where the repo has a
GitHub remote, the flow is the same as for GitHub issues. Where it has none (personal-ops,
queue-runner), mechanics: the build runs on a worktree branch, Sol reviews the branch's diff
against `main`, the review and its ledger are appended to the ticket's `## Comments`, and a clean
review merges locally with `--no-ff`; a stop sets the ticket's status to `needs-info`.

**Blocked by:** 05

**Status:** done (2026-11-10: picking built; the no-remote flow dropped, see the last comment)

- [x] Both status forms in use (`Status: x` and `**Status:** x`, with or without a trailing date)
      are read.
- [x] Which local repos are served is config, empty by default; Stefan turns a repo on.
- [x] If the no-remote flow turns out to change what a repo does for Stefan (for example, Stefan's
      own sessions commit straight to `main` there), stop and ask under Comments rather than
      decide.
- [x] Tested against a sandbox repo with three tickets and a blocker chain.

## Comments

**2026-11-10, Claude (build, queue-runner `837414d`): stopped on the no-remote flow; built the
picking.** Built: `queue_runner/tickets.py` reads `.scratch/<feature>/issues/NN-<slug>.md`
(both status forms, trailing dates and notes, `Blocked by:` lines in the ticket's own feature),
and picks `ready-for-agent` with every blocker `done`, lowest number first. A repo opts in with
`issues = "local"` in `config.toml`; none does. Tested on a sandbox git repo with three tickets in
a blocker chain (`tests/test_tickets.py`), and read every real ticket in personal-ops and
royal-bully-ops (128): each one's status reads. For now the Claude lane skips local repos and
`--once --dry-run` only names the next ticket.

**Not built: the no-remote flow, because it changes how both repos work for you.** Neither
personal-ops nor queue-runner has a remote (royal-bully-ops neither), and in both your sessions,
and this `/implement` chain, commit straight to `main`. Three questions:

1. **Where the merge lands.** A local `--no-ff` merge goes into the `main` that's checked out in
   your working folder (personal-ops has uncommitted and untracked files right now). Either the
   runner runs `git merge --no-ff` there, or it moves `main` under your checkout, which leaves the
   folder showing the merge's changes reversed. And if `main` moves (your own commit) while
   Sol reviews the branch, the review was of a diff against an older `main`: re-review, or
   merge if it still merges cleanly? Options: (a) merge in the checkout only when it's
   on `main` and clean, and wait otherwise (said once); (b) a clean review stops for you to merge;
   (c) don't serve these repos with the runner.
2. **queue-runner's tickets live in personal-ops.** The ticket assumes ticket and code share a
   repo. Serving queue-runner means its builds branch in queue-runner while the runner writes the
   ticket's review, ledger and status into personal-ops' `main`: a second commit into your
   working checkout per review.
3. **This chain does the same job.** Each `/implement` here starts the next ticket. If the runner
   serves queue-runner, the chain must stop, or both pick the same ticket.

Also: turned on for personal-ops as it is, the runner's first pick would be
`excalidraw/01-move-setup-session.md` (lowest number), so you may want a per-repo list of the
features it serves.

**My recommendation:** (a), plus a `features` list per local repo, and leave queue-runner on this
chain until the cutover (13), so question 2 doesn't arise yet. Mechanics I'd decide once you
answer: a local ticket's key is `<feature>/NN` (numbers repeat across features), its branch
`claude/<feature>-NN-<slug>`.

**2026-11-10, Sol's review of `837414d`:** one Important finding, fixed in queue-runner
`2ae1706`: a blocker line ending in a full stop (`Blocked by: 01.`) named no blocker, so the
ticket after a stopped one was picked. Its nit fixed too: the dry run now goes on to the GitHub
build the lane would start after showing a local ticket. Sol also asked that question 1 cover
`main` moving during a review (added). 383 tests pass.

**2026-11-10, Stefan's answer (relayed by Claude):** no repo needs the no-remote flow. The
runner won't serve personal-ops, and queue-runner moved to GitHub as the private
`stefan1575/queue-runner`, with these tickets in its own `.scratch/queue-runner/`. So the
ticket closes with picking built and the no-remote flow dropped. Its leftovers (config and
`run.py` comments that still say the flow waits on Stefan) go in 14.
