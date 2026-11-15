# 35: An ask opens a T3 thread to decide in

**What to build:** on a stopped PR's ask, Stefan clicks "Decide in T3"; the runner starts a
thread briefed with the ask, he talks it through there, and the runner acts on the answer the
thread ends with.

**Blocked by:** 30, 31

**Status:** ready-for-agent

Spec: `../dashboard-live.md`; ticket 18's last box. Decided here (mine, his to overturn):

- The thread starts only on his click, never by itself.
- It is a Claude job, gated as a decision. While the Claude lane is stopped the request is
  kept, and the page says it starts when the lane resumes.
- The answer is the `reply` question's (`decisions.py`): `fix`, `carry-on`, `hold` or `stop`,
  in a `queue-runner-decision` block, acted on as a reply to the stop is today.

- [ ] `POST /control` takes `{"ask": <id>, "open": true}`; anything else about an ask is
      refused. The page shows it as asked until the runner has read it.
- [ ] The runner starts `Queue runner ask: <repo>#<n>` in the repo's T3 project with no
      worktree and doesn't wait on it; its brief (`templates/ask.md`) has the ask, the PR's
      open findings and the earlier threads, and tells the thread to end with the block once
      Stefan has decided.
- [ ] Once per ask. The ask's `go` then opens the thread, and the `needs-info` issue stays
      linked as the other place to answer.
- [ ] Each pass the runner reads the thread's last reply; a readable block is acted on and
      recorded, and the ask moves to `answered`. No block yet changes nothing.
- [ ] An answer on GitHub meanwhile still counts, and the stop is decided once.

## Comments
