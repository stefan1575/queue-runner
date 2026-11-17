# Usage

The usage gate before each Claude job, recovering from a usage limit, and the effort Claude jobs run at.

## The usage gate

`gate.py` and `usage.py` (ticket 08; `docs/flow.md`, Limits). Before each Claude job (a build,
a fix round, a decision thread; a continued job runs inside its decision's pass), after settling
and choosing it, the Claude lane reads Claude's windows and the job kind's expected cost, and the
expected cost of every Claude job still running (#50: `docs/claude-lane.md`, Two lanes). **Sol
isn't gated**, and neither is an Approach-note answer read from Stefan's words (no thread). The
Opus review (while Sol is out of usage, or every review when config.toml says Claude reviews:
`docs/reviews.md`, The Opus fallback) is: the Sol lane checks it as kind `review` (default cost 15% of 5 hours, 4%
of the week, about a decision's, until three are learned: issue #76) and records what it spent the same
way; it isn't one of the Claude lane's kinds (`gate.CLAUDE_KINDS`), so that lane's measurement
never counts it, and `--gate` prints it as its own line, held by the reviewing lane's stop.

- **Reading usage:** `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta:
  oauth-2025-04-20` and the Claude login's token, as T3 does (`readClaudeResetCredits` and
  `readAccessToken` in `resources/server.asar`, read 2026-11-10): `claudeAiOauth.accessToken` in
  `$CLAUDE_CONFIG_DIR` or `~/.claude`, `.credentials.json`. Claude Code refreshes it whenever it
  runs. The token goes only into the request header: no log, record or error holds it. The
  response's `five_hour` and `seven_day` are `{utilization: 0-100, resets_at}`; null means not
  started. `tests/fixtures/usage/oauth-usage.json` is a real response. The call adds
  `?cedar_ember=1&skip_spend=1`, as T3's does, so the same answer has the reset credits (ticket
  42; `oauth-usage-resets.json`): `Usage.resets` (The dashboard, Usage).
- **One reading, one budget** (issue 66; T3's `CAPABILITIES_PROBE_TTL` and
  `resolveUsageLimitsAfterProbe`, read 2026-11-16): the endpoint answers 429 when it's asked
  about once a minute (per login, shared with T3 and Claude Code), so `usage.CachedUsage`, the
  one reader `cli._gate` makes and the snapshot shares, asks it at most once every 5 minutes
  (`CALL_EVERY`), failed calls counted, whoever asks: the gate, the after-job read, the
  snapshot's 5-minute read and Refresh. Inside that it gives back the cached reading with the
  time it was taken. A failed call keeps the last good reading, its error beside it; no
  Retry-After, no back-off. A login that can't be read asks nothing, so it spends no call.
  `OAuthUsage.call_every` is the budget; the tests' `FakeUsage` says 0.
- **Which reading a check decides on:** one taken after the last Claude job ended and no older
  than 30 minutes (`STALE_AFTER`), even if the latest call failed. A 429 beside such a reading
  never holds the lane. "Ended" is any Claude thread the runner sees end (`Gate.job_ended`): a
  measured job's, and outside a measured pass a dead runner's build, fix or live job settled, a
  waiting job that ran on Stefan's answer (ended, or asking again: a `latest_run_id` newer than the run its end record names, told once by that run id, seen running or not, #85), a decision thread whose
  retry or answer never reached its job (PR 67's review 1, F1), and a dead runner's Opus review
  (the fallback, or config.toml's) whose thread has ended (review 2, F2: The Opus fallback, The
  job record). With the
  job's id it's told once, so the two lanes both seeing one thread end don't throw away a
  reading taken in between; and a job's after-read is judged against its own end, not one the
  other lane said meanwhile. A job settled with no thread holds nothing. An ask thread runs on with Stefan unwatched, like his own sessions, so it
  doesn't count.
- **Fits:** the 5-hour window's used percent plus the job's expected cost must be at most 100,
  or the lane waits for its reset (plus 2 minutes); a window with nothing used takes any job. The
  week must leave `reserve` percent (5 by default) for Stefan until 24 hours before its reset,
  or the lane waits for that release; inside the last 24 hours the reserve may be spent. No room
  even then: it waits for the weekly reset. No reading to decide on (none yet, one from before the
  last job, or one past 30 minutes: Claude usage `unreadable`) starts nothing until the endpoint
  may be asked again, or the next pass when it may be now (a login that couldn't be read).
- **Beside running jobs** (#50; `gate.Running`, `Gate.check(..., running=)`): a job starts only
  when its cost fits after the expected cost of every Claude job still running (this runner's
  workers, a dead runner's job still running in T3, and the Sol lane's Opus review: the one it
  let in, or one open in the job log, as `review <repo>#<PR>` at the `review` cost) and every one
  let in before it in the same pass, each counted whole whatever it has spent so far, so it errs high. One that fits alone but
  not beside them waits for one of them to end (`running`, no time: the lane plans again when a
  job ends): `Claude lane waits on <repo>: build would fit alone, but the Claude job running
  (build first#4) is expected to take ...`. Beside a running job a window with nothing used no
  longer takes any job. With the cautious defaults two builds never fit together (60 + 60); the
  learned costs (4% for a build on 2026-11-16) let them.
- **Waiting:** a held job's repo waits; the log says once per repo why and until when (`Claude
  lane waits on <repo>: ...`, and again only when that changes), and the loop sleeps
  `poll_seconds` or until the gate opens, if sooner, or until a running job ends; `gate_until`
  sets a wake task, the wait for the next read too. A pass that started nothing because of it
  is `gated`. The Sol lane goes on.
- **The after-job read** (`Gate.measured`) makes the call that serves the next check. After a
  job under 5 minutes the budget doesn't allow one yet, so it waits for it on the wall clock
  in the job's own worker (#50; `run.wall_sleep`; the log says `Reading Claude's usage after
  the job at ... (<job>)`), then reads:
  the next check would wait for that reading anyway, and a short job's cost is still learned. A
  reading the snapshot took after the job ended serves too. A failed one is recorded with
  `after` null and its error, and the next check waits for the next read.
- **The knob** is `<state_dir>/gate.json` (`reserve` only, since ticket 30), written whole by
  `--reserve N` without the runner lock, and read before every Claude job, so it works while the
  runner runs (within one `poll_seconds`). Stopping a lane isn't the gate's: it's `control.json`
  (`docs/running.md`, Stopping a lane), read before the gate; an older `paused: true` here is read there.
- **Learned cost:** each Claude job pass that started a thread appends to
  `<state_dir>/usage.jsonl`: the kind, the jobs it started, usage before (the gate's read) and
  after, and `spent` per window (null for a window that reset mid-job). The expected cost per kind
  is the cautious default (build 60% of 5 hours and 15% of the week, fix 40/10, decision 15/4)
  until 3 records have that window's `spent`, then the largest of the last 5. Utilization comes
  in whole percents, and Stefan's own sessions in the same window count too, so it errs high. A
  decision that may continue a build or fix (its question allows `retry` or `answer`) must fit
  with that job's cost added; a pass in which it did is recorded under the continued job's kind.
  A pass that ran beside another Claude job (an Opus review included, either way) measured
  both: its record has `shared_with` (the others' labels) and teaches nothing. So while both
  repos (and reviews) stay busy, nearly every pass is shared and a kind's expected cost stays at
  its last five solo passes until one runs alone again.
  `usage.jsonl` is written like the job log (`state.append_record`: synced, a torn last line cut
  off); a bad line elsewhere, like an unreadable `gate.json`, starts nothing until it's fixed.
- `Runner` without a `gate` (the tests, `live_sandbox.py`) starts every job; the CLI always passes
  one.

## Usage limits

`limits.py` (ticket 09; `docs/flow.md`, Limits). A build or fix thread that ends failed on a
Claude usage limit ends `usage-limit`, not `failed`, so no decision thread (which would hit the
same limit) is started on it.

- **Spotting one:** T3's record of the run's failure (`docs/t3.md`) decides: `usage_limit` is a limit
  stop, any other class isn't. Only with no record (or none readable) does Claude Code's message
  count, in the run's error or the run's own last assistant message, never an earlier run's
  ("You've hit your weekly limit · resets ...", "Claude API rate limit reached").
- **When:** 10 minutes after the reset T3 stored for the stop; 5h05m from the stop if it stored
  none. The end record has `resume_at`, `context` (the thread's tokens, or null) and
  `last_request` (when its last real request started, or null). Until then
  the Claude lane starts nothing in any repo (`gated`, said once: the limit is the whole
  account's; with several jobs cut off, until the latest `resume_at`); the Sol lane goes on. A
  limit cuts off each job running beside the one that met it the same way, and each is recovered
  in its own repo, first there, before any other job in it. Then the usage gate checks the job
  as usual.
- **In place or fresh** (ticket 38; `limits.resume_choice`, the one rule every caller uses: a
  limit's recovery and a decision's `retry` or `answer`). It reads only what it can measure, at
  the moment the job resumes: when the thread's last real request started and its context.
  - **Warm** (that request started under 55 minutes ago, `WARM_FOR`): continue in place, any
    size. Claude Code's subscription cache lasts an hour from a request's start; 55 minutes is
    the research's margin under it.
  - **Cold and under 120k tokens** (`COLD_FRESH_MIN`): continue in place.
  - **Cold and 120k or more:** a fresh thread. 120k is the research's cold break-even
    (`C* = F + o*E / (w + (n-1)*r)`: 93.6k for leads-dashboard's 50k starts, 113.6k for
    queue-runner's 70k, with 25k of rereading and 5k of extra output) rounded up toward
    continuing, since what a fresh thread loses isn't priced. The arithmetic and where its
    evidence is thin are beside the constant in `limits.py`.
  - **Unknown** age (no request record names the last call) is cold; unknown size is large.
  In place is a continued job (`t3 thread send`; after a limit the message is
  `limits.RESUME_MESSAGE`). Fresh is the job's own brief rebuilt from its sources (the issue;
  for a fix, the fix brief from the same review of H), plus `templates/restart.md` (how the old
  thread stopped and why it isn't continued, its link, where it starts, what it left
  uncommitted, its last 3 messages). The new job's start record has `resume` (`how`
  `in-place` or `fresh`, `why`, `last_request`, `idle_minutes`, `context`), and the log line
  says the same (`Continuing ... in place: warm (...)`, `Restarting ... fresh after the usage
  limit (cold (...) and N tokens ...)`). The stop's own log line says what would be chosen at
  its resume time; the recovery chooses again when it runs. T3 can't make a worktree on a branch that exists, and makes it at the same
  folder (`~/.t3/worktrees/<project>/<branch>`), so `GitCli.free_branch` keeps the branch's tip
  under `refs/queue-runner/limit/<branch>` and anything uncommitted (untracked files too) as a
  `git stash create` commit under `.../<branch>-uncommitted`, removes the old worktree and
  deletes the branch; T3 then makes the same branch again at that tip, in that folder
  (`--worktree <tip> --branch <same>`). For a fix that's the round's own local branch
  `claude/fix-pr<n>-<H7>`; it still pushes to the PR's.
- **The new job** has the old job's kind, issue, branch, title, H and round, `about` the old
  job (that's what marks it recovered) and `resume`. One that never reached a thread (`not-started`,
  `not-sent`) doesn't count, so the next pass tries again. A fresh restart whose brief or branch
  can't be made (the old worktree won't go, the review isn't in the log) ends `restart-failed`:
  it isn't tried again, the old job stays the PR's writer, and Stefan gets a toast, until
  `--release`.
- **Until then it's the PR's writer** (`JobLog.writer`): Sol doesn't review a head it pushed
  before the limit, nothing merges, and no other fix round starts. `--release` lets it go.
- **The old thread** was settled when its stop was recorded (`docs/stops.md`, Settling threads); a resume
  in place unsettles it.
- **T3's "Resume after usage limits"** (`autoResumeLimitedThreads` in
  `~/.t3/userdata/settings.json`, off by default) stays off: it would send "Continue where you
  left off." to the same thread itself. The runner logs a warning at start if it's on.
- **Sol** isn't a T3 thread (`docs/reviews.md`, Sol, as a script sees it), so none of this applies to it: an `out-of-usage` review
  counts for nothing and the PR is reviewed afresh, on its head then, once the Sol lane resumes:
  10 minutes after the reset in Sol's own rollout (codex-sol.sh logs `session id:` in
  `reply.md.log`; its `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl`'s newest `rate_limits`
  record; the window at 99% or more, the later one if both), else the time Sol's error names,
  else 30 minutes. Until then reviews go to the Opus fallback (`docs/reviews.md`, The Opus fallback).

**First real stop: confirm.** The fixtures are from one real Claude stop (2026-11-08, a weekly
limit, before the runner existed): `tests/fixtures/t3/turn-item-usage-limit.json`,
`thread-show-usage-limit.json`, `provider-thread-claude.json` and
`tests/fixtures/claude/transcript-limit-stop.jsonl` (its text left out). The first stop under
the runner should confirm the log line `<thread> stopped on a usage limit; T3 says it resets at
...` and the end record's `resume_at` and `context`.

## The effort

`effort.py` (ticket 39; issue #120). Every job runs at its kind's `[jobs]` effort
(`docs/running.md`, The command line; Stefan's config: Opus 5.5 `medium`), or its fallback's while
its own provider is out of usage (`Effort.spec`: `JobLog.out_until`).

- **Every job names its provider, model and effort** (issue #119): builds, fix and conflict
  rounds, decisions, live steps, Opus reviews and ask threads start through T3's MCP launch
  (`T3Cli.start`/`launch`, `docs/t3.md`) with `Effort.job(kind)`: its kind's provider, model and
  effort, whatever the T3 project's default model is, recorded in its start record and launched
  from there (`effort.asked`). A continued job (`t3 thread send`) keeps its thread's selection.
  Checked live on 2026-11-17 (`docs/t3.md`).
- **A fallback while a provider is out** (issue #120): a provider is out while a build or fix on
  it was cut off by a limit and nobody picked it up yet, or its newest review found it out
  (`JobLog.out_until`). While one is, a Claude-lane kind with a `fallback` starts on it (a repo
  whose own job was cut off still waits for that job's reset); with no kind able to start, the
  lane waits as before. A job not on Claude skips the usage gate.
- **Before #119** T3's CLI was the only way in, and `t3 thread start --provider --model` sends no
  effort option, so a run got the model's default (Opus 5.5's is medium). The runner leaned on
  the T3 project's default model instead (`projectSettingsOverrides[<id>].defaultModelSelection`
  in T3's `settings.json`, set by hand): that workaround and its start line are gone. Entries
  set for it in T3's settings stay and do nothing for the runner.
- **Read back** (`T3Files.run_effort`, into the end record's `effort`): the `effort` on the
  thread's Claude transcript's assistant records since the run started (Claude Code's own record
  of what it sent; `<synthetic>` ones skipped), else the effort option on T3's run record, else
  null. Anything but the config's effort is said once per repo (`<repo>: <job> ran at effort
  medium, not high`), and an unreadable one too; it's said again only when it changes. Only
  `main` reads T3's files (`effort.T3Files`, read-only); a `Runner` without an `Effort`'s files
  (tests, `live_merge.py`) records no effort.
