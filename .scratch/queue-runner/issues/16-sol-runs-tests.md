# 16: Sol's review checkout can run the repo's tests

**What to build:** Sol's sandbox (`~/codex-sol.sh` and the runner's checkout) has Node on PATH and
the repo's dependencies installed (or linked from a cache), so Sol can run a repo's tests while it
reviews, mainly to confirm a suspected bug with a failing test (tickets 03 and 04: Sol couldn't).
CI still gates the merge.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] One leads-dashboard review where Sol runs `npm test`, shown in its reply.
- [ ] A checkout's install doesn't slow every review: measured in Comments.
