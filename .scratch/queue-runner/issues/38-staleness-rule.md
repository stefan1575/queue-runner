# 38: Continue a thread or start fresh, by how stale it is

**What to build:** whenever the runner is about to send more work to an existing Claude thread,
it continues that thread while its cache is still warm, and otherwise starts a fresh one with a
restart brief when the thread is large enough for that to be cheaper.

**Blocked by:** None (can start immediately)

**Status:** done (2026-11-15)

Stefan, 2026-11-15: "automatic stopping and resuming via creating a new session, dependent on
staleness... implement that as well." The research is
`C:\Users\Anon\Code\Personal\queue-runner\.scratch\queue-runner\research\token-economics.md`
(not committed: read it at that path, not in your worktree), with `subscription-economics.md`
and `in-place-vs-fresh.svg` beside it. Its recommendations 1 to 3 are the rule; its break-even
section is where the numbers come from.

## Today

- After a usage limit, a job continues in place only at about 50k tokens or less, else fresh
  (`limits.py`, `IN_PLACE_MAX`). The research found 50k is not an economic cliff.
- A decision's `retry` or `answer` always continues the old thread, whatever its size and
  however long ago it last ran (`Runner.continue_job`).
- Every build and fix round already starts as a fresh thread.

## Decided (mine, Stefan's to overturn)

- The runner has no AI, so "nearly finished" and "still coherent" can't be judged. The rule
  uses only what it can measure: when the thread's last request started, and its context size.
- **Warm:** the last request started less than 55 minutes ago. Continue in place, any size.
- **Cold:** continue in place below the size at which the research's break-even favours a
  fresh brief; at or above it, start fresh. State the number and where it comes from.
- Unknown age or size counts as cold and large: fresh, as an unknown size does today.
- One rule in one place, used by every caller.

- [x] One function decides in place or fresh from the last request's start, the context size
      and now, with no I/O; its thresholds are named constants with the research cited.
- [x] Limit recovery uses it in place of `IN_PLACE_MAX`.
- [x] A decision's `retry` and `answer` use it. Fresh means the job's own brief rebuilt from
      its sources plus `templates/restart.md`, as limit recovery does, with the decision's
      text first; for an `answer`, the thread's question and the answer are in the brief.
- [x] The last request's start is read where the context size already is (T3's database and
      Claude Code's transcript, `limits.T3Store`), read-only.
- [x] The job's records say which was chosen and why (age, size), and the log line does too.
- [x] The branch and anything uncommitted survive a fresh start, as they do today
      (`GitCli.free_branch`).
- [x] AGENTS.md's Usage limits and Decision threads sections describe the rule.

## Comments

**2026-11-15, built (branch `dash/38-staleness-rule`).** The rule is `limits.resume_choice`
(no I/O), used by `Runner.continue_job` for a limit's recovery and a decision's `retry` and
`answer` alike:

- **Warm** (the last real request started under 55 minutes ago, `WARM_FOR`): in place, any size.
- **Cold, under 120,000 tokens** (`COLD_FRESH_MIN`): in place.
- **Cold, 120,000 or more**, or the size unknown: a fresh thread. An unknown age is cold.

**Where 120k comes from.** `subscription-economics.md` section 4's cold crossover, above which a
fresh thread is cheaper: `C* = F + o*E / (w + (n-1)*r)`, with `F = S + D` the fresh thread's
context after reorienting, `E` its extra output, `n` the requests left, and the central
subscription scenario `w = 1.21`, `r = .027`, `o = 4.49`, `D = 25k`, `E = 5k`. `C*` is largest at
`n = 1`: `o*E/w = 4.49 * 5,000 / 1.21 = 18.6k`.

- leads-dashboard, `S = 50k` (the median first request, 50,333): `F = 75k`, `C* = 93.6k` at
  n = 1, 90.5k at n = 10, 83.9k at n = 50 (the research's table).
- queue-runner, `S = 70k` (its sessions' first requests were 70.4k-74.2k): `F = 95k`,
  `C* = 113.6k` at n = 1, 110.5k at n = 10.

So 120k is the larger repo's crossover rounded up. The margin leans toward continuing because
the model doesn't price what a fresh thread loses (hypotheses, files read, test results).

**Where the evidence is thin.** The subscription weights are a scenario fitted to Pro data, not
measured Max rates. Reorientation (`D`, `E`) was never measured: at `D = 50k`, `E = 15k` the cold
crossover is 127k-146k, and 120k would restart a little early. `S` is a first request, not a
measured restart brief. The research itself calls a single cold number "an explicitly
provisional heuristic" (its shorthand was ~100k for `S = 50k`). The context compared is the
runner's (input plus the last reply's output), a few thousand tokens above the research's
input-only `C`. Warm continues at any size because a warm restart only pays at about 131k-636k
tokens with 50 to 5 requests left, and the runner can't count the requests left.

**Read where the size is.** `limits.last_call` reads the transcript T3's database points to: the
last real assistant record's `requestRef` names an `api-request` record whose `timestamp` is the
request's start. The real stop's fixture predates `requestRef` and reads as unknown (cold). The new
fixture `tests/fixtures/claude/transcript-requests.jsonl` is hand-made in the shape of a real
Claude Code 2.1.319 transcript. A limit stop's end record also keeps `last_request`, so
`--once --dry-run` can say the choice.

**Records.** A job picking up an earlier one has `resume` in its start record: `how`, `why`,
`last_request`, `idle_minutes`, `context`. The log says `Continuing <job> in place: <why>` or
`Restarting <job> fresh after the usage limit (<why>)` or `... fresh for the decision (<why>)`.

**Decisions I made.** A fresh start for a decision puts `## Direction first` before the job's own
brief: how the earlier thread stopped, the question it asked (its last assistant message, quoted)
for an `answer`, and the decision's message. A waiting job picked up fresh ends `continued`, as an
in-place one does. A fresh start for a decision that can't be made ends `restart-failed` and
toasts, as after a limit, and the decision stands, so it isn't decided again. `restart.md` is now
general: "Picking up from an earlier thread", saying how the old one stopped and why it isn't
continued.
