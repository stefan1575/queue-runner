# 43: The runner's status lists only what it depends on

**What to build:** the runner-status card on the right lists only the things the runner depends
on. "Stop now" leaves the list, because it is a feature and not a dependency.

**Blocked by:** None

**Status:** ready-for-agent

Raised by Stefan on 2026-11-15: "what does stop now mean in T3 code? Local dependency. What is
that supposed to mean?"

## What it was

Only the sample lists "Stop now for Claude" (`dashboard/sample.py`, source `t3_interrupt`):
whether T3 accepts an interrupt, which Stop now (ticket 34, pinned) would need. The real
snapshot never had it (`snapshot.SOURCES`: Claude usage, ChatGPT usage, T3 Code, GitHub).
Whether Stop now is available already shows on the lane's Stop button
(`lane.stop_now.note`).

## Decided (mine)

- The sources stay Providers (Claude, ChatGPT), Local (T3 Code) and External (GitHub).
- Ticket 34 shows Stop now's availability on the Stop button only.

- [ ] The sample has no `t3_interrupt` source, and its "no-interrupt" state shows on the Stop
      button instead.
- [ ] A test holds the sample's source ids to `snapshot.SOURCES`.
- [ ] AGENTS.md: The dashboard ("The runner's status lists its sources by group").

## Comments
