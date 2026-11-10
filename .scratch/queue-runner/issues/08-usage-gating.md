# 08: Don't start a Claude job that won't fit

**What to build:** before each Claude job the runner reads Claude's 5-hour and weekly windows
(`https://api.anthropic.com/api/oauth/usage` with the Claude login, as T3 does) and the job kind's
expected cost, and waits for the 5-hour reset when the job won't fit. The weekly reserve keeps 5%
of the week for Stefan until 24 hours before the weekly reset. Sol isn't gated. Stefan has a knob:
change the reserve, pause the queue, resume it (a small command, mechanics yours).

**Blocked by:** 02

**Status:** done (2026-11-10)

- [x] Where the Claude login's token comes from is found (T3's code shows it) and read without
      ever logging or copying it; the response's windows (used percent, reset time) are parsed
      from a saved real response.
- [x] Each Claude job records usage before and after; the expected cost per job kind is learned
      from those records, cautious (a high default) until there are a few.
- [x] The gate's decisions (fits, wait for the 5-hour reset, weekly reserve holds, reserve
      released inside the last 24h, paused) are tested with fixed clocks and fake usage.
- [x] `pause`, `resume` and `reserve <percent>` work while the runner runs, and its log says why
      it is waiting and until when.

## Comments

**2026-11-10, built** in `~/Code/Personal/queue-runner`, commits `31436ad`, `13b71c6` and
`e260514` (the code review's fixes). All tests pass (`python3 -m unittest`, 281). The runner's
`AGENTS.md` documents it under "The usage gate". Checked live: `python3 -m queue_runner --gate`
read real usage (5 hours 85% used, the week 23%), and said a build and a fix wait for the 5-hour
reset while a decision fits.

What's there:
- **Token:** read the way T3 reads it (`readAccessToken` in its `server.asar`):
  `claudeAiOauth.accessToken` in `~/.claude/.credentials.json`, or under `$CLAUDE_CONFIG_DIR`.
  It goes only into the request header. No log, record or error message holds it.
- **The gate:** checked before each build, fix round and decision thread. Sol isn't gated, and
  neither is your `rework`/`fix on`/`hold` reply.
  - It waits for the 5-hour reset when the job won't fit.
  - Your weekly reserve holds until 24h before the weekly reset, and is released inside those 24
    hours.
  - A full week waits for the weekly reset.
  - When usage can't be read, nothing starts.
  - The log says once why the lane is waiting and until when.
- **Your knob:** `python3 -m queue_runner --pause`, `--resume` and `--reserve N`, plus `--gate` to
  see where things stand. The setting lives in `~/.queue-runner/state/gate.json`. A running
  runner picks it up within one `poll_seconds`. Pausing doesn't stop a running job or Sol.
- **Learned cost:** `usage.jsonl` keeps usage before and after each Claude job.
  - Until there are 3 records, the cautious defaults apply: a build 60% of 5 hours and 15% of the
    week, a fix 40/10, a decision 15/4.
  - After that, it uses the largest of the last 5.
  - A decision that may continue a build or fix must fit with that job's cost added.

Left for later: a gate wait sets no Windows wake, so a sleeping PC misses the reset. That's
ticket 10's job (logon and wake).
