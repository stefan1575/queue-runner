# 43: The runner's status lists only what it depends on

**What to build:** the runner-status card on the right lists only the things the runner depends
on. "Stop now" leaves the list, because it is a feature and not a dependency.

**Blocked by:** None

**Status:** done (2026-11-16)

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

- [x] The sample has no `t3_interrupt` source, and its "no-interrupt" state shows on the Stop
      button instead.
- [x] A test holds the sample's source ids to `snapshot.SOURCES`.
- [x] AGENTS.md: The dashboard ("The runner's status lists its sources by group").

## Comments

- 2026-11-16 (built): `dashboard/sample.py` lists only the runner's four sources; the
  `t3_interrupt` source is gone, and the `no-interrupt` state now only turns the Claude lane's
  `stop_now` off, its note ("T3 refuses the interrupt since its last update: stop after the job
  instead.") showing on the Stop button's Now item. `ContractTest.test_the_samples_sources_are_the_runners`
  (`tests/test_snapshot.py`) holds every sample state's sources to `snapshot.SOURCES`. AGENTS.md:
  The dashboard and Tests. `index.html` needed no change: the status card and the Stop menu
  already draw from the data. Nothing left out.
  - Mine: the test holds each source's id, group, name and short (not just the ids), so the
    sample can't drift from the real labels either; order isn't held, since the page groups them.
  - Mine: the `no-interrupt` state keeps its name and description, so `?sample=no-interrupt`
    links still open it.
