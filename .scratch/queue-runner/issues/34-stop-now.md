# 34: Stop now

**What to build:** Stop now on a lane cuts its running job off at once, and the job carries on
later from where it stopped.

**Blocked by:** 30

**Status:** ready-for-agent

Spec: `../dashboard-live.md`; ticket 18's Decisions (Stop after this job, and Stop now).

- [ ] The reviewing lane: the running review is cut off (its process tree killed), counts for
      nothing (it isn't one of the two failed reviews a head gets), and the lane is stopped.
      The PR is reviewed afresh after Resume.
- [ ] The Claude lane: **find out first how a script can interrupt a T3 thread.** T3's CLI has
      no interrupt (`t3 thread`: `list`, `start`, `send`, `show`; checked 2026-11-15). Read
      T3's own code (AGENTS.md, T3 as a script sees it) for what its app sends, and write what
      you find there.
- [ ] If it can: the runner checks at start that T3 accepts the interrupt and says so in the
      snapshot (`sources`' `t3_interrupt`, the lane's `stop_now`). A cut-off build or fix ends
      like a usage-limit stop with no reset to wait for: its branch stays, and on Resume it
      carries on in place or afresh by its context size (`limits.py`).
- [ ] If it can't: `t3_interrupt` is not ok with the reason, Stop now is unavailable for
      Claude, Stop all asks that lane to stop after its job, and the ticket's Comments say what
      was tried.
- [ ] One live check is allowed, on a throwaway Haiku thread in the sandbox project
      (`scripts/live_sandbox.py`'s project), never on a served repo.

## Comments
