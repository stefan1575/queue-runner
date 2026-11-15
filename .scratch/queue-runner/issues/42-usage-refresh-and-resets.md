# 42: Usage you can refresh, with each plan's reset credits

**What to build:** the Usage card's Details link becomes a Refresh button that reads Claude's
and ChatGPT's usage again now. Each plan also shows how many reset credits it has, when it has
any.

**Blocked by:** None (builds on the dashboard-live branch)

**Status:** ready-for-agent

Raised by Stefan on 2026-11-15, on the right-hand Usage card: "wire them up to be live, and also
show the amount of resets that they have, if applicable... a refresh where it re-requests...
instead of the Details button."

## Already done

**Live is built** (ticket 28): the real snapshot reads both plans' usage every 5 minutes
(`snapshot.READ_EVERY`). The "17:40" Stefan saw came from a sample dashboard started at 17:41
(`--sample --port 5291`), whose times are fixed when it starts. The real page,
`http://queue.localhost:5289/`, shows the runner's reads once the dashboard-live branch is
merged and installed.

## Decided (mine, Stefan's to overturn)

- **Refresh** posts `{"usage": "refresh"}` to `/control`. The runner's publisher sees it on
  its next tick (at most `WRITE_EVERY`, 30 s), reads both plans whatever `READ_EVERY` says,
  and writes the snapshot. A forced read is allowed once a minute. The button spins until
  `read_at` passes the request's time, and says so if the read failed.
- **Reset credits** are read where T3 reads them: each account's
  `usageLimits.resetCredits.availableCount` (T3's `resources/server.asar`;
  `readClaudeResetCredits` for Claude). The plan's line says "2 resets left". A plan without
  any shows nothing.
- Redeeming a reset isn't on the page. It spends the credit, so it stays Stefan's, in T3.
- The Usage page stays in the sidebar.

- [ ] The snapshot's plan carries `resets` (`{"available": N}` or null), Claude's and ChatGPT's,
      from the same read as the windows. The sample shows one plan with credits and one without.
- [ ] `POST /control` takes `{"usage": "refresh"}` with its time. The runner reads both plans
      on its next tick, no more than once a minute, and the snapshot carries the new `read_at`.
- [ ] The Usage card's head has Refresh (an icon with "Refresh" on hover) where Details was. It
      spins until the read lands, and is off while the runner is silent.
- [ ] Tests never call Anthropic or read real credentials: a fixture response with
      `resetCredits`, and one without.
- [ ] AGENTS.md: The dashboard (Usage) and the snapshot's `usage` shape.

## Comments
