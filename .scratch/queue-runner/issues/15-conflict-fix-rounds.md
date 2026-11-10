# 15: A conflict with main gets a fix round, one PR at a time

**What to build:** a PR that conflicts with its base gets a fix round (Claude merges the base in
and resolves it) instead of a stop for Stefan (Stefan, 2026-11-10, about leads-dashboard #153 and
#154: "do it sequentially"). One conflicted PR at a time, oldest first: the next one starts only
once the earlier one has merged or stopped, so each resolves against the newest `main`.

**Blocked by:** None

**Status:** done (2026-11-10)

- [x] A conflicted PR gets a fix round, then a fresh Sol review of its new head.
- [x] Two conflicted PRs are handled one after the other (tested with a sandbox pair).
- [x] A conflict the fix round can't resolve, or a third conflict on the same PR, is still a stop.

## Comments

**2026-11-10, built (claude/ticket-15).** A PR with no blocking runner review whose head conflicts
with its base gets a conflict round: a fix job with `cause: conflict`, thread `Queue runner
conflict: <repo>#<PR>`, brief `templates/conflict.md` (merge `origin/<base>` in, resolve keeping
both sides, run the checks, push; or abort, comment the choice and push nothing). Sol reviews the
pushed head afresh. One at a time per repo, lowest number first: while an open PR that had a
conflict round isn't held for Stefan, the others wait. Still a stop: the round on H couldn't
resolve it (`no-push`, `head-unknown`, `branch-exists`), or a third conflict after rounds on two
earlier heads. `--release` counts afresh; Stefan's `fix` reply to a conflict stop orders one more
round. AGENTS.md, Conflict rounds.

- **The pair test** is `tests/test_conflicts.py` (two faked conflicted PRs through the real
  `Runner`: #20 resolves, waits on pending checks, is reviewed clean and merged, then #21's round
  starts), not a GitHub sandbox pair: the real pair below is the live check.
- **Sol's review** (one run, `gpt-6.1-sol` high) found three Important issues, all fixed in
  `bab5fdb` with tests: two resumed conflicted PRs waited for each other forever; a reply
  decision's `fix` after an unresolved conflict was ignored; an ordinary fix round that ended
  `branch-exists` on a conflicted head left no stop. No nits.

**Real cycle set up: leads-dashboard #153 and #154** (both CONFLICTING, heads `e6517b8` and
`0cb8323`; their pre-ticket conflict stops are issues #176 and #177). After the restart on the
new code, `--release leads-dashboard#153` and `--release leads-dashboard#154` were run, so the
runner takes them. What to look for in `~/.queue-runner/logs/runner.log`:

1. `Starting fix leads-dashboard#153 (...) to resolve its conflict with main` (after the usage
   gate), and `fix leads-dashboard#154: not now, PR #153 resolves its conflict first` (said only
   when #154 is reached; the lane stops at the first PR it starts).
2. `fix leads-dashboard#153 ended: pushed`, then Sol's review 1 of the new head (`review
   leads-dashboard#153: Sol reviews ...`).
3. While #153 is open and not stopped: `fix leads-dashboard#154: not now, PR #153 had a conflict
   round and hasn't merged or stopped yet`. leads-dashboard is a repo Stefan merges, so #154's
   round waits for **Stefan's merge of #153** (or a stop on it).
4. If the round can't resolve it: `ended: no-push`, then a `conflict` stop on #153 (`the conflict
   round on e6517b8 couldn't resolve it`) added to its needs-info issue, and #154's round starts.

Issues #176 and #177 are still open on GitHub; the release means the runner no longer reads
them. Stefan may close them.

**Rule-file wording for Stefan to approve** (not edited):

- `~/.claude/docs/pr-review.md`, A round, step 1: replace "Handle a failed check, a conflict or a
  human reply first." with "Handle a failed check or a human reply first; a conflict with the
  base gets a conflict round (Claude merges the base in and pushes), one conflicted PR at a time,
  oldest first, each after the one before merged or stopped."
- `~/.claude/docs/pr-review.md`, Stops: replace "- a failed check or a conflict;" with "- a failed
  check; a conflict a conflict round couldn't resolve, or a PR's third conflict;".
- leads-dashboard `docs/agents/review-loop.md`, the outcome's Stop signals: replace "- **failed
  check or conflict** on the PR." with "- **failed check** on the PR, or a **conflict** that a
  conflict round couldn't resolve (or the PR's third). A conflict first gets a conflict round,
  one PR at a time."

The two `pr-review.md` drafts above were applied word for word on 2026-11-10 (Stefan's go); recovery copy in personal-ops `.scratch/agent-instructions/2026-11-10/pr-review.md.before-conflict-rounds`. The leads-dashboard review-loop.md draft goes to Stefan's leads-dashboard session.
