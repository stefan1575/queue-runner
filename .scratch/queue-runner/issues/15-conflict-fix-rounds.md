# 15: A conflict with main gets a fix round, one PR at a time

**What to build:** a PR that conflicts with its base gets a fix round (Claude merges the base in
and resolves it) instead of a stop for Stefan (Stefan, 2026-11-10, about leads-dashboard #153 and
#154: "do it sequentially"). One conflicted PR at a time, oldest first: the next one starts only
once the earlier one has merged or stopped, so each resolves against the newest `main`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] A conflicted PR gets a fix round, then a fresh Sol review of its new head.
- [ ] Two conflicted PRs are handled one after the other (tested with a sandbox pair).
- [ ] A conflict the fix round can't resolve, or a third conflict on the same PR, is still a stop.
