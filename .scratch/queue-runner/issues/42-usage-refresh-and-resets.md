# 42: Usage you can refresh, with each plan's reset credits

**What to build:** the Usage card's Details link becomes a Refresh button that reads Claude's
and ChatGPT's usage again now. Each plan also shows how many reset credits it has, when it has
any.

**Blocked by:** None (builds on the dashboard-live branch)

**Status:** done (2026-11-16)

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

- [x] The snapshot's plan carries `resets` (`{"available": N}` or null), Claude's and ChatGPT's,
      from the same read as the windows. The sample shows one plan with credits and one without.
- [x] `POST /control` takes `{"usage": "refresh"}` with its time. The runner reads both plans
      on its next tick, no more than once a minute, and the snapshot carries the new `read_at`.
- [x] The Usage card's head has Refresh (an icon with "Refresh" on hover) where Details was. It
      spins until the read lands, and is off while the runner is silent.
- [x] Tests never call Anthropic or read real credentials: a fixture response with
      `resetCredits`, and one without.
- [x] AGENTS.md: The dashboard (Usage) and the snapshot's `usage` shape.

## Comments

- **Mechanics** (2026-11-16, the build; mine, each in a line):
  - Claude's resets: the usage call now always adds `?cedar_ember=1&skip_spend=1` (T3's
    params), so one call gives both windows and credits; counted as T3 does (every usable grant's
    `resets_left`, 0 when the next grant isn't usable). Read live: 2 (a full reset, a Fable reset).
  - ChatGPT's resets aren't in Codex's rollouts, so ChatGPT's usage is now read through
    `codex app-server` (`account/rateLimits/read`) for windows and credits together: "the same
    read" honestly, and Refresh then reads OpenAI afresh, not a file. Read live: Plus, 3.
    `sol.latest_limits` stays for its tests; nothing in the snapshot uses it now.
  - No fallback to the rollouts when the app server fails: the plan keeps its last good read and
    says the error, like Claude's.
  - `resets` is `{"available": N}` whenever the plan reported a count (0 included), null when it
    has none to give; the page shows only N > 0.
  - control.json keeps the request as `usage.refresh_at`, written only once asked, and kept by
    every other write (the page's and `--pause`/`--resume`'s).
  - The snapshot's `usage_refresh` (`asked_at`, `done_at`) says which request was read for, so
    the spinner stops even when the read fails; the card then names the plan it couldn't read.
  - A request newer than the one last read waits for a tick a minute past the last forced read.
    One left from before a restart is taken by the first read, with no extra call.
  - The button is also off when the snapshot has no `usage_refresh` (a runner on older code,
    such as the one running now), so it can't spin forever.
  - The sample: Claude has 2 resets, ChatGPT none; its pretend runner reads both plans 3 seconds
    after a refresh.

- **Built** (2026-11-16, `dash/42-usage-refresh`): everything in the checklist. Tests:
  `tests/test_usage_refresh.py`, `tests/test_codex_usage.py` (a stand-in app server) and
  `ResetsTest` in `tests/test_usage.py`, on fixtures from real answers with ids replaced; no
  test calls Anthropic or OpenAI or reads a login. Checked by hand on a `--sample` dashboard:
  Refresh spins and stops, and is off in the `dead` state. Left out: redeeming a reset (Stefan's,
  in T3, as decided). Worth knowing: starting `codex app-server` rewrites Codex's shared
  `~/.codex/models_cache.json` (seen 2026-11-16) with the plain CLI's model list; T3's own Codex
  check refreshes it again. Whether a Sol review's `codex exec` does the same isn't checked. With
  a read every 5 minutes, Stefan may want to judge it.
