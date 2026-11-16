# Queue runner

A script with no AI in it that runs Stefan's fixed build-and-review flow and starts fresh T3 Code
threads only for work that needs Claude or Sol. The design and its rules live outside this repo:
`~/Code/docs/orchestration.md`, `~/Code/docs/pr-review.md` and `~/Code/docs/sol.md`. The
spec and the tickets that build it are GitHub issues: the spec is #8, the dashboard's runner
side #9 (under ticket 18, #27), each ticket a sub-issue with native blocked-by links. They were
local markdown in `.scratch/queue-runner/` until 2026-11-16 (moved from personal-ops on
2026-11-10). **A ticket number in this file or a commit is the local one: ticket NN is issue
#(NN+9)**, and #8 has the table. The tracker's conventions are `docs/agents/issue-tracker.md`
and `docs/agents/triage-labels.md`.

**On GitHub as the private `stefan1575/queue-runner`** (Stefan, 2026-11-10; it was local-only
before). Commit after every completed step, with a message that says what changed and why.

## Run it

```
python3 -m queue_runner                       # run: both lanes, pass after pass (unattended: see Running unattended)
python3 -m queue_runner --once                # one pass of each lane: at most one Claude job (a decision, a fix round or a build), merges, at most one Sol review
python3 -m queue_runner --once --dry-run      # print the next Claude job's brief (a job cut off by a usage limit first, then an ask thread Stefan asked for, then a decision, then a fix round), list the stops it would file, what Sol would review and what would merge
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (a PR: retry its failed reviews, merges and fix round; let a stopped PR go)
python3 -m queue_runner --review NAME#N       # Sol reviews that PR's head now, if adoption says it needs one
python3 -m queue_runner --gate                # Claude's usage now, and whether a build, fix or decision would start
python3 -m queue_runner --pause | --resume [LANE]   # stop a lane after its job, or let it carry on (claude by default; sol, all): the dashboard's Stop and Resume
python3 -m queue_runner --pause | --resume NAME     # stop one served repo in both lanes, or let it carry on: the Repositories card's Stop and Resume
python3 -m queue_runner --reserve PERCENT     # the share of the week kept for Stefan (default 5)
python3 -m queue_runner --stop                # stop the running runner
python3 -m queue_runner --inbox               # everything waiting on Stefan: PRs ready to merge, needs-info stops, threads waiting for his answer
python3 -m queue_runner --snapshot            # print the dashboard's snapshot from the state now (reads usage and GitHub once; no lock, writes nothing)
```

**`--once`, the bare command and `--review` start real Claude builds, fix rounds and decision
threads and real Sol reviews** in the configured repos, **a review posts on GitHub** (its comment, the `sol-review`
status, follow-up issues and the PR body's Review row), **a clean review merges**, and **a stop
files a `needs-info` issue, comments on the PR and toasts**. Don't run
them against leads-dashboard to try something: use the live checks (below). `--dry-run` posts,
starts and merges nothing; it only fetches a PR's head into the runner's local ref to print a
fix brief.

In production it runs under `pythonw`, so it never needs a console: every subprocess runs with
no window, and `print` goes nowhere (the log has it all). A lock on `<state_dir>/runner.lock` keeps a
second runner out: it logs `a second runner started (pid N) and exited at once` and exits 3;
`--dry-run`, `--release`, `--review` and `--stop` don't take it. Each Sol review holds `<state_dir>/sol.lock`, so
`--review` and the running lane never run two at once.

`config.toml` names the repos it serves (GitHub repo, local clone, base branch, and
`review_table` for a repo whose PR bodies keep a `## Review` table, `issues = "local"` for one
whose tickets are local markdown: Local tickets, below, `merge = "stefan"` for one whose PRs Stefan
merges himself: Stefan merges, below), in priority order (Stefan's build order on the dashboard
wins: The build order, below); the runner's `state_dir` and `log_dir` (`~/.queue-runner/`, outside every served repo);
`runs_dir`, `checkouts_dir` and `deps_dir` for reviews; `poll_seconds`, the pause after a pass that started
nothing; `adopt_reviews_before`, the cutover date before which a blocking review the runner
didn't run counts as its own for fix rounds (A Claude pass, step 4); `[claude]`, the T3
provider instance, model and `effort` (default `high`) for Claude jobs (The effort, below);
and `[sol]`,
`codex-sol.sh` and the Git bash that runs it. `--config <path>` reads another one.

## Running unattended

Ticket 10 (`orchestration.md`, The runner and Sleep).

- **Start:** at logon, `~/.queue-runner/Queue runner.lnk` (made by `scripts/make_shortcut.py`)
  runs `~/scoop/apps/python/current/pythonw.exe -m queue_runner` in this repo. A copy is in
  `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/` since the cutover (ticket 13), with
  `T3 Code (Beta).lnk` beside it (Stefan, 2026-11-10), so T3's server comes up at logon too. By
  hand: double-click the shortcut, or `pythonw -m queue_runner` from this folder.
- **The dashboard starts beside it** (ticket 29): `~/.queue-runner/Queue runner dashboard.lnk`
  runs the same pythonw `-m dashboard` in this repo (The dashboard, below). `python3
  scripts/make_shortcut.py` makes both shortcuts; `--startup` also copies both into the Startup
  folder (`--dir`, `--startup-dir` and `--pythonw` name other places; its test uses temp folders).
- **Stop:** `python3 -m queue_runner --stop` kills the process named in `<state_dir>/runner.pid`
  (written once it holds `runner.lock`, removed when it ends), and only a Python process: a stale pid
  that Windows gave to something else is left alone. A Claude job it was blocked on runs on in T3, and the
  next runner settles it (A Claude pass, Settle); a Sol review is cut off and counts as `failed`.
  Better to stop between jobs: the log says when one starts and ends.
- **Restart:** `--stop`, then start it again (the shortcut). A second start while one runs exits
  at once (above).
- **The log:** `~/.queue-runner/logs/runner.log` (`log_dir`), one stamped line per event,
  `runner started (pid N)` at each start; a crash's traceback ends with `runner stopped on an
  error`. Read the tail: `Get-Content ~/.queue-runner/logs/runner.log -Tail 40`.
- **T3 not up yet at logon:** before its first pass the runner calls `t3 thread list` on the first
  repo's project every 30 seconds until it answers, logging `Waiting for T3's server: ...` once
  (again only if the error changes) and `T3's server is up`. An unknown project
  (`No T3 Code project matches`) means the server answered: it says so and carries on. No AI, nothing else starts meanwhile.
- **Wake tasks** (`wake.py`): after every pass of either lane, the runner keeps one Task Scheduler
  task per time a lane waits for: the Claude lane's `gate_until` (the gate's reset, a limit's
  resume) and Sol's resume. They live in the folder `\Queue runner\`, named `wake YYYY-MM-DD
  HHMM+ZZZZ` (local, the minute after the time, with its UTC offset so a DST change can't merge two), one-off time triggers with **wake to run**, run as
  Stefan only while he's logged on, and run `pythonw -I -c ...` to hold off idle sleep for 10
  minutes (`SetThreadExecutionState`), so the runner's pass starts before the PC drops back to
  sleep; the keep-awake hooks then hold it while a job runs. A task whose time has passed, or
  that nothing waits for any more, is deleted at the next sync (said in the log), and each
  expires an hour after its time so Windows deletes it if the runner is gone. Times under a
  minute ahead get no new task, but one already set is kept until it fires. Plain idle polls (`poll_seconds`) set no wake: a sleeping PC just
  polls later. A lane Stefan stopped (Stopping a lane, below) waits for nothing, so it sets
  none, and neither lane does while `control.json` is unreadable. A Task Scheduler error is logged once and never stops the loop.
- **Sleeping by the wall clock:** the loop's waits (`run.wall_sleep`, the Sol lane's too) look at
  the wall clock every 30 seconds, since Windows' timers may not count time the PC slept.
- `--once` sets no wake tasks.
- **Live check** `python3 scripts/live_wake.py [MINUTES] [--sleep]`: sets one real wake task
  a few minutes ahead, prints its settings, waits for it, and removes it. Run on 2026-11-10
  without `--sleep`: `WakeToRun=True`, a one-off `MSFT_TaskTimeTrigger` at 10:15+08:00, it ran at
  10:15 (result `0x41301`, the hold still running), and was removed. **Woke the PC from sleep**
  on 2026-11-10 (`--sleep`): asleep 10:49:12, awake 10:53:06, and the System log named the wake
  source as `\Queue runner\wake 2026-11-10 1053+0800`; the task ran and was removed. Hibernate
  is still untested: the PC goes from sleep to
  hibernate after a while ("S4 Doze to Hibernate" in the System log), and whether a wake timer
  wakes it from hibernate depends on its firmware: a wait of hours may find the PC hibernated.

## Serving itself

Ticket 14. The runner serves its own repo, `stefan1575/queue-runner` (`config.toml`, last, after
game-backdrop and leads-dashboard; game-backdrop is first since 2026-11-15, Stefan's first run
under the dashboard): GitHub issues, builds, Sol reviews, and it merges its own clean PRs.
`.github/workflows/tests.yml` runs `python -m unittest` on Windows on every PR and on main, so
"checks passed on H" means the tests passed on H.

- **Restarting on new code** (`restart.py`): in continuous mode, when a served repo's `path` is
  the folder the runner's code runs from, the Claude lane fetches its base after every pass
  (between jobs). When `origin/main` is ahead and fast-forwards (the runner's own merge, or any
  push), it says `The runner's own code moved: restarting...`, lets the Sol lane finish its pass,
  runs `git merge --ff-only` in the checkout and ends the loop; the CLI lets go of `runner.lock`
  and `runner.pid`, starts the same command again (`sys.executable` and `sys.orig_argv`,
  detached), and waits until the new runner's pid is in `runner.pid` and it stays up 20 seconds:
  `runner restarted on <sha7> (pid N)`, then the new one's `runner started`. Another runner
  taking the lock instead counts as restarted.
- **New code that won't start** (dies, or doesn't take the lock in 2 minutes): the old runner
  logs `the new code failed to start: <last error line>`, toasts "Queue runner didn't restart"
  (opening the commit), and exits 1. The new one's stderr is in `<log_dir>/restart.err`. Fix it
  on main and start the shortcut by hand. Live check: `python3 scripts/live_restart.py` (a clone
  with a syntax error; a real toast). Run on 2026-11-10: `SyntaxError: invalid syntax`, toasted.
- **Left alone** (said once, the old code carries on): a checkout on another branch, one whose
  main has commits origin doesn't, and an update git refuses (a local change in the way), which
  isn't tried again until main moves on.

## The usage gate

`gate.py` and `usage.py` (ticket 08; `orchestration.md`, Limits). Before each Claude job (a build,
a fix round, a decision thread; a continued job runs inside its decision's pass), after settling
and choosing it, the Claude lane reads Claude's windows and the job kind's expected cost. **Sol
isn't gated**, and neither is an Approach-note answer read from Stefan's words (no thread). The
Opus review while Sol is out of usage is (The Opus fallback, below): the Sol lane checks it as
kind `review` (default cost 30% of 5 hours, 8% of the week) and records what it spent the same
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
- **Fits:** the 5-hour window's used percent plus the job's expected cost must be at most 100,
  or the lane waits for its reset (plus 2 minutes); a window with nothing used takes any job. The
  week must leave `reserve` percent (5 by default) for Stefan until 24 hours before its reset,
  or the lane waits for that release; inside the last 24 hours the reserve may be spent. No room
  even then: it waits for the weekly reset. Unreadable usage (no login, HTTP 401, the endpoint
  down) starts nothing and is read again next pass.
- **Waiting:** a held pass is `gated`; the log says once why and until when (`Claude lane waits:
  ...`, and again only when that changes), and the loop sleeps `poll_seconds` or until the gate
  opens, if sooner. The Sol lane goes on.
- **The knob** is `<state_dir>/gate.json` (`reserve` only, since ticket 30), written whole by
  `--reserve N` without the runner lock, and read before every Claude job, so it works while the
  runner runs (within one `poll_seconds`). Stopping a lane isn't the gate's: it's `control.json`
  (Stopping a lane, below), read before the gate; an older `paused: true` here is read there.
- **Learned cost:** each Claude job pass that started a thread appends to
  `<state_dir>/usage.jsonl`: the kind, the jobs it started, usage before (the gate's read) and
  after, and `spent` per window (null for a window that reset mid-job). The expected cost per kind
  is the cautious default (build 60% of 5 hours and 15% of the week, fix 40/10, decision 15/4)
  until 3 records have that window's `spent`, then the largest of the last 5. Utilization comes
  in whole percents, and Stefan's own sessions in the same window count too, so it errs high. A
  decision that may continue a build or fix (its question allows `retry` or `answer`) must fit
  with that job's cost added; a pass in which it did is recorded under the continued job's kind.
  `usage.jsonl` is written like the job log (`state.append_record`: synced, a torn last line cut
  off); a bad line elsewhere, like an unreadable `gate.json`, starts nothing until it's fixed.
- `Runner` without a `gate` (the tests, `live_sandbox.py`) starts every job; the CLI always passes
  one.

## Usage limits

`limits.py` (ticket 09; `orchestration.md`, Limits). A build or fix thread that ends failed on a
Claude usage limit ends `usage-limit`, not `failed`, so no decision thread (which would hit the
same limit) is started on it.

- **Spotting one:** T3's record of the run's failure (below) decides: `usage_limit` is a limit
  stop, any other class isn't. Only with no record (or none readable) does Claude Code's message
  count, in the run's error or the run's own last assistant message, never an earlier run's
  ("You've hit your weekly limit · resets ...", "Claude API rate limit reached").
- **When:** 10 minutes after the reset T3 stored for the stop; 5h05m from the stop if it stored
  none. The end record has `resume_at`, `context` (the thread's tokens, or null) and
  `last_request` (when its last real request started, or null). Until then
  the Claude lane starts nothing (`gated`, said once: the limit is the whole account's); the Sol
  lane goes on. Then the usage gate checks the job as usual.
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
- **The old thread** was settled when its stop was recorded (Settling threads, below); a resume
  in place unsettles it.
- **T3's "Resume after usage limits"** (`autoResumeLimitedThreads` in
  `~/.t3/userdata/settings.json`, off by default) stays off: it would send "Continue where you
  left off." to the same thread itself. The runner logs a warning at start if it's on.
- **Sol** isn't a T3 thread (below), so none of this applies to it: an `out-of-usage` review
  counts for nothing and the PR is reviewed afresh, on its head then, once the Sol lane resumes:
  10 minutes after the reset in Sol's own rollout (codex-sol.sh logs `session id:` in
  `reply.md.log`; its `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl`'s newest `rate_limits`
  record; the window at 99% or more, the later one if both), else the time Sol's error names,
  else 30 minutes. Until then reviews go to the Opus fallback (The Opus fallback, below).

**First real stop: confirm.** The fixtures are from one real Claude stop (2026-11-08, a weekly
limit, before the runner existed): `tests/fixtures/t3/turn-item-usage-limit.json`,
`thread-show-usage-limit.json`, `provider-thread-claude.json` and
`tests/fixtures/claude/transcript-limit-stop.jsonl` (its text left out). The first stop under
the runner should confirm the log line `<thread> stopped on a usage limit; T3 says it resets at
...` and the end record's `resume_at` and `context`.

## Two lanes

One Claude job and one Sol job at a time (`run.py`): the Claude lane runs in the main thread
and blocks on `t3 thread start --wait` while a build or fix round runs; the Sol lane
(`review.py`) runs alongside in a thread: merges, then one review a pass. Both write the one job
log (a lock per file inside the process). `--once` chooses the Claude job before the Sol lane
starts, so what that pass's review decides waits for the next pass.

**One writer per PR** (`JobLog.writer`): while a build or fix job is open on a PR's branch, or
waiting for an answer (until it ends or is released), Sol doesn't review it, it doesn't merge,
and it gets no other fix round.

## Stopping a lane

`control.py` (ticket 30; spec `.scratch/queue-runner/dashboard-live.md`, One switch). **One
switch per lane:** `<state_dir>/control.json`'s `lanes.<id>.stop`, which the dashboard's Stop,
Resume and Stop all write (`dashboard/serve.py`, `apply_control`) and `--pause [LANE]` and
`--resume [LANE]` write in the same format (`control.ask`; `LANE` is `claude` by default, `sol`
or `all`). `"after-job"` lets the lane's job finish and starts nothing after it; null carries
on; `"now"` is read as `"after-job"` until ticket 34.

- **Read** (`control.read`, never raises) at the start of each lane's pass: the Claude lane after
  settling (`Runner.plan`, a pass that ends `stopped`), the Sol lane before it files a stop,
  merges or reviews anything (`Runner._sol_pass`), so a stopped Sol lane does none of them.
  `--once` obeys too; `--review` is Stefan's own and doesn't ask (but merges nothing after,
  below). The log says once
  `The Claude lane is stopped by Stefan: it starts no job (Resume on the dashboard, or python3
  -m queue_runner --resume)` (the reviewing lane's: `... --resume sol`), and `... runs again:
  Stefan resumed it` when it changes.
- **Asked again between jobs, in both lanes,** so a Stop asked while a job runs lets it finish
  and starts nothing after it, in that pass too: the Sol lane before its merge pass, before
  each merge in it (`Merger.merge_pass(halted=...)`), before each repo's stops and before its
  review (`Reviewer.lane_stopped`); a review that ends after the Stop posts, and its merge or
  stop waits for Resume (`Reviewer.stopped_now`, as for a stopped repo); the Claude lane before
  a decision's retry or answer (`Runner.continue_job`): the decision ends `not-started` and the
  earlier job stays as it was, so the case is decided again after Resume.
- **Unreadable** (not JSON, not an object, `lanes` or `repos` there but not an object, a lane's
  or repo's entry that isn't an object or has no `stop` the page could have written: a missing
  `stop` is never a Resume): neither lane starts anything until it's fixed, said once. An odd
  `repo_order` or ask entry is ignored instead (The build order, Read and snoozed). Any Stop or
  Resume on the page, any other request it sends, or `--pause`/`--resume`, writes it afresh
  from what they can read (`control.repaired`, and the page's `serve.usable`, the same file
  from either end) and **lets go only of what it names**: an entry it can't use is written
  stopped (`after-job`), and with no lanes to read (not JSON, not an object, `lanes` not one)
  each lane is, so Resume on one lane leaves the other held until it's resumed too. JSON `null`
  is not an object either: both ends mark no file as `MISSING`, never None, which `null` parses
  to (review 2's F9). A `repos`
  that isn't an object names no repo and is dropped. The page reads control.json through the
  same repair (`App.control`), so it shows those lanes stopped.
- **The older pause:** with `paused: true` in gate.json and no `claude` entry in control.json,
  the Claude lane is stopped (since gate.json's mtime). An entry, either way, wins. The CLI's
  `ask` (and `--reserve`, through `carry_over`) moves that pause into control.json and leaves
  gate.json with `reserve` only; the runner itself writes neither file. Today's runner was
  paused that way, so restarting onto this code starts no Claude job.
- **Wake tasks:** a stopped lane sets none (`Runner.wake_times`).
- `--gate` prints each lane's switch first (and each kind `waits: the Claude lane is stopped by
  Stefan` while it is); `--once --dry-run` says a stopped lane's line before what it would do
  once resumed.

## The build order

`control.ordered` and `Runner.take_order` (ticket 33). **`control.json`'s `repo_order`**, which
the dashboard's Build order card wrote until #61 (2026-11-16: the page can't reorder now, and
`POST /control` refuses it; a value already in the file is kept, and #50 stops the runner reading
it), is the order both lanes go through the served repos: the first repo with work gets the next job, and the Sol lane files stops, merges
and reviews in that order.

- **Used only when it names every served repo exactly once.** Missing or `[]` is config.toml's
  order, said nothing. Anything else (a repo left out, one not served, one twice, not a list of
  names) is ignored, config.toml's order stands, and the log says once why: `control.json's
  repo_order is ignored (it leaves out queue-runner): repos are taken in config.toml's order,
  ...`. It never makes control.json unreadable: the stops stand. A new order is said once:
  `Repos are taken in Stefan's build order now: ...`.
- **Taken up at the start of each lane's pass** (`plan`, after settling, and `_sol_pass`), next
  to the stop, so a job already running goes on; the next pass chooses in the new order.
  `config.set_build_order` replaces `config.repos` (the one change made to a loaded Config),
  never changing the list in place, so a lane already going through the repos finishes in the
  order it began; every part that reads `config.repos` follows. `config.toml_order` keeps
  config.toml's.
- **The snapshot** reads control.json once for the stops and the order: its `repos` are in the
  order the lanes take up next, so the one that first shows a new order is the one whose
  `control_read_at` is that file's `written_at`. The features and each lane's queue go through
  `Facts.repos` in that order (ticket 32: The work lists, below).
- `--once --dry-run` says the order first (`dry run: repos are taken in Stefan's build order:
  ...`, config.toml's, or why his is ignored) and chooses in it.

## Stopping one repo

`config.working` and `Runner._take_repo_stops` (ticket 37; Stefan, 2026-11-15: so game-backdrop
can be the first real run while leads-dashboard stays served). **`control.json`'s
`repos.<name>.stop`** (`"after-job"` or null, with its `at`; Stop now stays a lane's) is written by
the Repositories card's Stop and Resume (`apply_control`'s `{"repo", "stop"}`) and by `--pause NAME`
and `--resume NAME` (`control.ask(..., repos=[NAME])`; a lane's id and `all` keep their meaning, and
any other name is refused with exit 2).

- **A stopped repo gets nothing from either lane:** no decision, live run, fix or conflict round,
  limit recovery or build in the Claude lane; no stop filed, merge, ready mark, noticing of
  Stefan's merge or review in the Sol lane. Each of those goes through `config.working(config)`,
  the build order less the stopped repos (`decisions.next_case`, `live.served`, `Runner.next_fix`,
  `Runner.choose`'s builds and limited jobs, `stops.stop_pass`, `merge.merge_pass`,
  `Reviewer.review_pass`); `config.repos` keeps every repo for what is only looked up or shown (a
  job's own repo when it's settled, the Inbox, the snapshot). The next repo's work is taken.
- **A job already running on it finishes** and is settled as usual. A review that ends after its
  repo was stopped (`Reviewer.stopped_now` reads control.json then) merges nothing and files no
  stop: both wait for Resume, when the next pass does them.
- **Taken up with the build order** at the start of each lane's pass (`take_order`), said once
  each: `leads-dashboard is stopped by Stefan: neither lane takes up its work, ...` and
  `leads-dashboard runs again: Stefan resumed it`. A name that isn't served is ignored and said
  once (`control.json stops old-repo, which is not served: ignored`). An entry the page couldn't
  have written (`"now"`, not an object) makes control.json unreadable, as a lane's does.
- **Its asks stay in the Inbox** (`inbox.collect` reads every repo); stopping the work answers
  nothing. **Its waits set no wake task:** a stopped repo's limited job and live run are skipped,
  so they set no `gate_until`. The usage limit is the account's, so another repo's job may then
  start and meet the gate or the limit itself.
- `--gate` lists the stopped repos after the lanes; `--once --dry-run` says them after the order
  and chooses as the lanes would.
- The snapshot's repo carries `stopped` (`{"at"}` or null); `control_read_at` moves as for any
  write.
- `--review NAME#N` is Stefan's own and still reviews a stopped repo's PR, but merges nothing after.

## A Claude pass

1. **Settle.** A build or fix job the log shows open was left by a runner that died mid-job: its
   thread is found by title (`Queue runner build: <repo>#<n>` or `Queue runner fix: <repo>#<PR>`,
   created after the job's start record). Still
   running: the pass starts nothing (one Claude job at a time). Ended: its outcome is recorded.
   No thread: `not-started`. A `waiting` job whose thread has since completed or failed is
   recorded again. One that's running again, or that T3 can't read, also makes the pass start
   nothing: if its thread is gone for good, `--release` the issue. A decision left open was cut
   off with its runner: `not-started`, so it's decided again.
2. **An ask thread** (`ask_threads.py`; Deciding an ask in T3, below): first each open ask
   thread's newest reply is read and a readable answer acted on; then, before any decision, a
   thread Stefan asked for from the Inbox is opened (not waited on). A job a limit cut off still
   comes first.
   **A decision** (`decisions.py`; Decision threads, below), before any fix round or build: the
   first case the fixed flow doesn't cover.
3. **Live steps** (`live.py`; Live steps, below): a repo's merges since its last live run, once no
   other merge is about to land.
4. **A fix round** (`fix.py`), before any build, so open PRs finish first. A PR gets one when
   the runner's own newest review of its head H is `blocking` (decide()'s `fix`; a stop or an
   approach note goes to Stefan) and that review is still the PR's newest review comment, or
   when that review stopped and a decision has since ordered a round (`Fixer.order`: Stefan's
   rework or fix on, or a decision thread's `fix`; one more round on H, its text first in the
   brief under `## Direction first`). **A review
   from before the cutover** (issue 3; `Fixer.adopted`): with no runner review of H, the PR's
   newest review comment, in any readable format (the old script's marker, or Sol's visible
   `sol-findings` block from a T3 child), blocking on H and posted before `config.toml`'s
   `adopt_reviews_before` (GitHub's UTC time; 2026-11-10, `''` adopts none), counts as the
   runner's review of H: its findings, classes and declines feed the brief, and a restarted
   round finds it by its round. Checked on 2026-11-10: leads-dashboard #152, #162, #163 and #168
   each get a round from their old review 1. A PR whose newest review was hand-run after the
   cutover is left to the session that ran it, and so is one that decide() would have sent to
   Stefan (`ledger.escalation`, read from the ledgers: a kept decline, a reopened finding, an
   earlier class repeated, or review 3 or later still blocking), since stops and Approach notes
   read only the runner's own reviews. Such a PR gets no conflict round either
   (`Fixer.old_escalation`, PR #4's review 2): nothing automatic runs on it until a decision
   orders a round on H. **One round per head:**
   once a round on H ended (except `not-started`), H gets no other until `--release NAME#PR`. The
   runner fetches the PR's head (moved since listing: nothing starts, Sol reviews it first),
   writes a start record (`sha` H, `round` the review's, `branch` the PR's), then blocks on
   `t3 thread start --wait --json --worktree H --branch claude/fix-pr<n>-<H7>`: a fresh T3
   worktree at H on a local branch that never goes to origin, because T3 can't run a thread in
   an existing worktree and the build's may still hold the PR's branch. The thread pushes to the
   PR's branch (`git push origin HEAD:<branch>`). The brief (`templates/fix.md`) has no handoff
   file: the open Important findings and their classes, the nits and the findings fixed or
   declined before, from the newest review's ledger; the PR's description and the issues it
   closes; its commits and changed files from git (`origin/<base>..H`); the earlier build and
   fix threads' links from the job log (as T3 gave them).

   **A conflict round** (ticket 15; Conflict rounds, below) is a fix round too, for a PR with
   no blocking review whose head conflicts with its base.
5. **Pick and build** (`run.py`): the first repo with a pickable issue gets one build. The runner
   fetches `origin/<base>`, writes a start record, then blocks on
   `t3 thread start --wait --json --worktree origin/<base> --branch claude/<slug>-<n>` with the
   brief on stdin. Afterwards it records the outcome.

**The job log** is `<state_dir>/jobs.jsonl` (`state.py`): `start`, `end` and `release` events, one
JSON object per line, each synced to disk as it's written. A last line torn by a crash is
ignored and cut off by the next write; a bad line anywhere else is an error. An end record has the thread id and link, run id, T3's exit code and
status, the branch's commits, the PR found by branch, the worktree path, `effort` (the effort
the run used, read back: The effort, below; on every Claude job's end, decisions and live runs
too) and any error.
Outcomes: `done` (exit 0, a PR found), `done-no-pr`, `failed` (exit 1), `waiting` (exit 2),
`continued` (it was waiting, and a decision's answer went to its thread as a later job),
`usage-limit` (exit 1 on a Claude usage limit: Usage limits, above),
`branch-exists` (a local `claude/*` branch left over, so T3 couldn't make it again) and
`not-started` (T3 failed before any thread existed). Every build that got that far holds its
issue: the picker skips it until `--release`. Only `not-started` holds nothing, so the next pass
retries it.

**Fix job records** (kind `fix`, `issue` = the PR, `branch` = the PR's) add `sha` (H), `round`
and `head` (the PR's head afterwards, read from GitHub), with `commits` the ones it pushed
(`H..head`). Outcomes: `pushed` (exit 0, the head moved: Sol reviews the new head), `no-push`
(exit 0 at H: H was reviewed, so the PR waits for Stefan: a `no-push` stop),
`head-unknown` (exit 0, but GitHub couldn't say afterwards; the Sol lane still reads the real
head), `failed`, `usage-limit`,
`waiting`, `branch-exists` and `not-started`, as for builds. A conflict round's records have
`cause` `conflict` and no `round`; its `no-push` is a `conflict` stop, not a `no-push` one (H was
never reviewed). A continued or restarted job keeps its `cause`.

## Conflict rounds

`fix.py` and `templates/conflict.md` (ticket 15; Stefan, 2026-11-10, about leads-dashboard #153
and #154: "do it sequentially"). A PR whose head H conflicts with its base (GitHub's `mergeable`
false) and that has no blocking runner review on H gets a fix round instead of a stop: a thread
`Queue runner conflict: <repo>#<PR>`, made like any fix round (a T3 worktree at H on
`claude/fix-pr<n>-<H7>`, pushing to the PR's branch), told to `git merge origin/<base>` (merge,
not rebase: nothing is force-pushed), resolve keeping both sides' intent, run the repo's checks,
and push; or, when the two sides can't both hold, abort, comment the choice on the PR and push
nothing. Its brief has the PR, its commits and files, the base's commits since the PR left it
(the newest 30) and the earlier threads. The pushed head is reviewed by Sol afresh, as any new
head. A blocking review on H gets its ordinary fix round first.

- **One at a time** (`Fixer.resolving`): in a repo, while an open PR that had a conflict round
  (not released) isn't held for Stefan (`stops.held`: a stop, his hold...), it's on its way to
  merging, and no other PR's conflict round starts; among the rest, the lowest number goes
  first. One that conflicts again holds back only higher numbers, so two never wait for each
  other. So each resolves against the base the one before landed on. In a repo Stefan merges,
  "merged" is his merge: the next waits for it.
- **Still a stop** (`stops.conflict_stop`, filed by the Sol pass as kind `conflict`): the newest
  round on H ended `no-push`, `head-unknown` or `branch-exists` and H still conflicts (an
  ordinary fix round's `no-push` is its own `no-push` stop); or the PR had
  conflict rounds on two earlier heads and conflicts again (a third conflict). `failed` and
  `waiting` rounds get a decision first, `usage-limit` a restart, as for any fix round.
  `--release NAME#PR` lets the PR have conflict rounds again, counting afresh. A decision that
  orders a fix on H after the stop (Stefan's reply) gets one more conflict round on H, its text
  first in the brief under `## Direction first`. A conflict stop
  filed on H before a round on H (before this ticket every conflict was a stop) doesn't count
  as the round's own stop.
- Until then the Sol lane leaves a conflicted head alone (`it conflicts with <base>: a conflict
  round (or a stop) comes first`), and the merge re-check never merges it.

**A continued job** (a decision's `retry` or `answer`): a new build or fix job of the same issue,
branch, title and H, whose start record carries the earlier job's `thread_id` and `about` (its
id), and `resume`: whether the earlier thread is continued in place or a fresh thread starts
(Usage limits, In place or fresh; the same rule). In place, the runner sends the message with `t3 thread send --wait --json`, and records the end as for
any job of its kind; a dead runner's settle finds the thread by its id. A message that never
reached a run (T3 failed and the thread isn't running) ends the new job `not-sent` (it counts for
nothing; the issue stays held), puts a waiting job back to `waiting`, and the decision
`not-started`, so the case is decided again. **A fresh thread T3 never started** (it failed
before one existed, or a dead runner's settle finds none) is the same (`Runner._uncontinue`):
the new job ends `not-started`, which holds the issue still (a build with `about` doesn't free
it) and is no newer job to the decisions (`Decider.cases` passes over `not-started` and
`not-sent`), the waiting job is `waiting` again, and the case is decided again.

## Decision threads

`decisions.py` and `templates/decision.md` (ticket 07; `orchestration.md`, Judgement). When the
fixed flow can't say what to do next, the Claude lane starts a one-off thread, `Queue runner
decision: <repo>#<n>`, in the repo's T3 project with no worktree (it changes nothing), with one
question and the state it needs: the PR and its open findings and classes from the ledger, the
issue, the job's thread link, error and commits, the thread's last 3 messages (`thread show
--messages 3`), Stefan's words since a stop, and the earlier threads' links. Each source is
clipped to 3000 characters, so a decision costs about one fresh-thread call.

**The answer** is the reply's last ```` ```queue-runner-decision ```` block: one JSON object,
`"version": 1`, `action` one the question allows, with its fields as non-empty strings. Anything
else (no block, bad JSON, another version, an action not allowed, a missing field, a thread that
failed or asked back) is a stop that says why.

| Question | When | Actions |
| --- | --- | --- |
| `approach-note` | the runner's review 3 or later of H is `approach-note` | `approach-note` (`note`, `recommend`: rework, fix on or hold): posted on the PR under `## Approach note`, then the `approach-note` stop links it; `stop` |
| `reply` | Stefan replied to a stop (the PR or its `needs-info` issue) | `fix` (`add`), `carry-on`, `hold`, `stop` |
| `failed` | a build or fix thread ended failed, nothing pushed | `retry` (`add`), `close` (`reason`, builds only), `stop` |
| `waiting` | a build or fix thread waits for an answer | `answer` (`text`), `stop` |
| `no-pr` | a build ended `done-no-pr` | `retry`, `close`, `stop` |

**Stefan's answer to an Approach note** needs no thread when his newest words (on the PR or the
issue) start with `rework`, `fix on` or `hold`: `fix on` and `rework` order one more fix round
(rework's brief says to rework the approach as the note and his reply say), `hold` leaves the PR
until `--release`. **No fourth review without it** (`stops.held`): while the runner's newest
review of the PR (on any head) is an approach note, the PR gets no review (even on a new head)
and no fix round until that note's own stop is filed and answered, by a closed issue or by a
decision after it that says `fix` or `carry-on`; another stop's answer doesn't count. The note is
written for that review even if the head has moved since. A reply not yet decided on holds the PR
too, and one reply that answers several stops is decided once (`stops.undecided_replies`).

**Settled once read:** the decision thread is settled once its answer is read, unless it asked
back (Settling threads, below).

**Acting:** `retry` and `answer` pick up the earlier job (A continued job, above): in its thread
while that's warm or cold and under 120k tokens, else in a fresh thread on the same branch
(`limits.resume_choice`; Usage limits, In place or fresh). A fresh thread's brief starts with
`## Direction first`: how the earlier thread stopped, for an `answer` the question it asked (its
last message, quoted), and the decision's message; then the job's own brief and
`templates/restart.md`. A waiting job picked up fresh ends `continued` too. A fresh start whose
brief or branch can't be made ends `restart-failed` and toasts, as after a limit; the decision
stands, so it isn't decided again until `--release`. `close` comments and closes
the issue as not planned; `fix`, `carry-on` and `hold` are read from the decision's record. A
stop goes where Stefan answers it: on a PR, the `needs-info` issue (kind `decision`, or
`approach-note`); on a build, a comment on its issue, which the build holds until `--release`; on
a waiting thread, a comment that links the thread, and a toast that opens it. **Once each:** a
case is decided once (`JobLog.decided`, a release included), and after 3 decisions on one issue's
or PR's failed, waiting or PR-less jobs the next goes straight to Stefan with no thread.

**Decision job records** (kind `decision`, `issue` the issue or PR, `sha` H on a PR, `about` the
job decided on: the review, the stop, or the build or fix; `question`): the outcome is the action
taken, `reason` the text acted on, `link` the thread (an approach note: the note's comment),
`error` why an answer couldn't be read; `not-started` when T3 started no thread, so the next pass
tries again.

## Deciding an ask in T3

`ask_threads.py` and `templates/ask.md` (ticket 35; spec `.scratch/queue-runner/dashboard-live.md`).
On a stopped PR's ask (a stop of kind `review`, `approach-note`, `no-push`, `conflict`,
`failed-check` or `decision`; not a live run's), the Inbox offers **Decide in T3**: the page writes
`{"ask": <id>, "open": true}` (`control.json`'s `asks.<id>.open`, `{"at"}`; the first time stands,
and ticket 36's keys in the same record are kept). The runner starts a thread for it only on that
click, never by itself.

- **Opening** (`AskThreads.next`, `open`): the Claude lane, after a limited job and before any
  decision, takes the oldest request whose stop is still `filed` and not released
  (`JobLog.released_ids`: a release leaves a stop's outcome `filed`), in a repo it works, with
  the PR open, and starts `Queue runner ask: <repo>#<n>` in the repo's T3 project with no worktree,
  **without waiting** (`T3Cli.launch`: `t3 thread start --json` prints `{threadId, projectId,
  runId}`, read in `server.asar` 2026-11-15), then reads its link with `thread show`. Gated as a
  decision; it teaches the learned costs nothing (`measured` records only passes that made a
  Claude job of a gated kind). A stopped Claude lane or repo keeps the request and starts nothing
  until Resume. **Once per ask:** an `ask` job (`about` the stop, `sha` its H, `question`
  `reply`) ends `opened` with the thread's `thread_id`, `run_id` and `link`; T3 failing ends it
  `not-started`, and the next pass tries again. A link T3 didn't give at the start is recorded
  when the thread is next read.
- **The brief** is the ask as the Inbox writes it (`asks.ask`, from the PR read now), the PR's open
  findings and classes (`Decider._pr_part`) and the earlier threads; it tells the thread to set the
  case out with a recommendation, talk it through, change nothing, and only once Stefan has
  decided end with a `queue-runner-decision` block: the `reply` question's `fix` (`add`),
  `carry-on`, `hold` or `stop` (`question`).
- **Reading the answer** (`read_answers`, each Claude pass after the lane's switch, before
  choosing): each opened thread's newest message (`thread show --messages 1`). Nothing happens
  while it runs, when Stefan spoke last, or with no block yet; a block it can't act on is said once
  and waits for another. A readable one ends the stop `answered` with `answer` `thread`, then a
  `decision` job (`question` `reply`, `about` the stop, `sha` the PR's head now, `link` the
  thread) is acted on by `Decider.act`, exactly as a decision thread on Stefan's reply: `fix`
  orders one more round on H (`Fixer.order`), `hold` holds, `stop` files a `decision` stop.
- **An answer on GitHub meanwhile still counts:** a stop no longer `filed` (his reply, a closed
  issue, a release) or already decided is that answer's, and the thread's later block is never
  acted on; once the thread's answer is recorded, the stop isn't `filed`, so a later reply
  answers nothing. Decided once either way.
- **The snapshot** (`ask_threads.mark`): every ask has `decide` and `also`. `decide` is null for an
  ask that can't be opened, else `{state, at, note}`: `offered`; `asked` (the runner read the
  request: `note` says when it starts, `waits_text`: when the Claude lane or the repo is resumed,
  once Claude's current job ends, once the gate opens, or on the lane's next pass; or that T3
  couldn't start it); `open` (`go` is the thread, "Decide in T3", and `also` the needs-info issue).
  An ask answered in its thread moves to `answered` with `said` "In T3: <the decision's text>",
  `go` the thread and `also` the issue; its timeline says "You opened a thread in T3 to decide
  it." and "You decided in T3."
- **The page** (`answerAt` in `dashboard/index.html`): offered, a Decide in T3 button beside the
  needs-info link; asked, the button greyed with "You asked at ... The runner hasn't read it yet."
  until `control_read_at` reaches it, then `decide.note`; open, the thread's link and the issue's.
- `--once --dry-run` prints the ask thread it would open, with its brief.

## Live steps

`live.py` and `templates/live.md` (ticket 11; `pr-review.md`, Merge). A repo whose `config.toml`
entry has `live_doc` (leads-dashboard: `docs/agents/lovable-cloud.md`; `live_migrations` and
`live_functions` default to `supabase/migrations` and `supabase/functions`) gets one Claude thread
per batch, `Queue runner live: <repo>`, gated as kind `live` (default cost 20% of 5 hours, 5% of
the week), after decisions and before fix rounds. Merged and live are reported apart: the merge
pass says `merged`, the live run says `live` (the log, and a **Live.** comment on each PR).

- **The batch** is read from git, not handoff files: `origin/<base>` now (T) against where the
  last live run reached (R): the PRs from the first-parent subjects (`Merge pull request #N`, or
  a squash's `(#N)`), the migrations added under `live_migrations` (in file order, their
  timestamps), migrations changed or deleted (the repo forbids it: the thread is told to stop)
  and the edge functions changed. Commits with no PR (Lovable's own pushes) wait for the next PR.
- **About to land** (`LiveSteps.about_to_land`): an open merge, review or fix job in the repo, or
  an open PR whose runner review of its head is clean and that the merge re-check would merge now
  or that would once its checks pass. While one is, no live run starts (said once). A clean PR
  held for Stefan doesn't hold the live steps, whatever its checks; in a repo Stefan merges, no
  clean PR does (when he merges it is his call).
- **The Sol lane, alongside:** while a live job is open, nothing merges in that repo
  (`Merger.why_not`), so the batch stays the one the thread was given. After writing its start
  record the run reads the base and about-to-land again; a merge that landed or began since the
  batch was read ends it `not-started`, and the next pass reads the batch afresh.
- **The thread** runs in a T3 worktree at T on `claude/live-<T7>-<id6>`, never pushed, removed
  after (`.env` is tracked, so `npm run check:live-schema` runs there with plain node). Its brief:
  the live doc to follow, the PRs, commits, migrations in order, functions, migrations an earlier
  run applied, Stefan's words after the last live stop, and the fixed answer block. It may not
  ask Lovable in its chat (credits): such steps go in `stefan`.
- **The answer** is the reply's last ```` ```queue-runner-live ```` block: `version` 1, `result`
  `live`, `partial` (with `failed`) or `stop` (with `question`), `applied` (the migrations it
  applied this run), `stefan`, optional `notes`. `live` that didn't apply every listed migration
  reads as `partial`; a file it wasn't given, or anything unreadable, is `failed`.
- **First sight** is recorded before anything may hold it, so a merge after it is always a live
  run's.
- **State** is the job log, kind `live`: `sha` R, `head` T, `issue` the batch's newest PR; at the
  end `applied`, `prs`, `reason`. Outcomes: `live` (R moves to T), `partial`, `stop`, `failed`,
  `usage-limit` (waits for `resume_at`; no stop), `not-started`, and `assumed`: **on first sight
  of a repo the runner records its base's head as live**, since the steps before were Stefan's.
  A run that didn't go live keeps R; its `applied` are left out of the next run's list, and a
  `failed` or `usage-limit` run marks its batch "maybe applied", so the next thread checks each
  migration through `query_database` before running it. A migration an earlier run applied that a
  later merge edited is listed as changed (the thread stops). A `usage-limit` run's `resume_at`
  is the idle lane's `gate_until`, so a wake task is set for it. A dead runner's open live job is settled
  from its thread's last reply, like a build.
- **Stops:** `partial`, `stop` and `failed` file a `live` stop (Stops for Stefan, below) on the
  batch's newest PR; no live run starts in that repo until it's answered (issue closed or a
  reply) or `--release <repo>#<that PR>`, and one that couldn't be filed is filed next pass.
  `stefan` steps on a `live` result file a `live-todo` stop, which holds nothing.
- `--once --dry-run` prints the live run it would start, with its brief, and records nothing.

## Stefan merges

`merge.py` (ticket 17). A repo whose `config.toml` entry says `merge = "stefan"` (leads-dashboard,
since 2026-11-10; game-backdrop, since 2026-11-15) isn't merged by the runner; `merge = "runner"` (the default) is.

- **Ready:** where the merge pass would merge (the same re-check, A Sol pass, step 3, except an
  open live run doesn't hold it: his merge goes in the next batch), it labels the PR
  `ready-for-stefan` and toasts "<repo> PR #N is ready to merge", opening the PR, **once per
  head**: a `ready` job, `marked` (`failed` if the label couldn't be added: the next pass tries
  again, and the toast waits for it). A failed toast is said and left.
- **Unready:** a marked PR whose head moved, or that the re-check no longer passes (a stop, his
  hold, a reply since the clean review, a failed check...), loses the label (`ready` job `unmarked`, with `reason`); a removal that fails is tried
  again next pass. A clean review of the new head, or the hold's answer, marks it again, with a
  new toast.
- **His merge:** a marked PR gone from the open list is read once: merged, it gets a `merge` job
  `merged` (`reason` "Stefan merged it"), its label and its build and fix worktrees go and their
  threads are settled as after the runner's own merge, and the log says `Stefan merged it; its live steps follow`; closed
  unmerged, it's `unmarked` and the label goes (so a reopened PR isn't left ready). The live steps then read the merge from git as for any merge (a
  merge commit or a squash's `(#N)`; **a rebase merge names no PR**, so its commits wait for the
  next PR's batch).
- **`--inbox`** (`inbox.py`, read only; `--needs-me` until 2026-11-15): the PRs ready to merge (the re-check passes now,
  as the merge pass reads it), the `needs-info` stops filed and not answered or released,
  the builds a decision left to Stefan (until `--release`), and the threads waiting for his
  answer (a decision's `stop` on a waiting job), with their links; `Nothing waits on you.` when
  there's nothing. A repo GitHub can't read is said after the list. It prints `inbox.collect`,
  the one collection the dashboard's Inbox is written from too (The Inbox's asks, below).
- `--once --dry-run`'s merge lines say `would mark ready for Stefan at H` (or `ready for Stefan
  at H`) instead of `would merge`.

## Local tickets

`tickets.py` (ticket 12). A repo whose `config.toml` entry says `issues = "local"` keeps its
tickets as markdown, `.scratch/<feature>/issues/NN-<slug>.md` (its
`docs/agents/issue-tracker.md`). **No repo is local by default**; Stefan turns one on.

- **Status:** the first `Status:` line above `## Comments`, in either form (`Status: x` or
  `**Status:** x`), with or without a trailing date or note: `done (2026-11-10)`, `done.` and
  `needs-info (2026-11-10: ...)` read as their first word. Done is `done` (or `resolved`, a
  wayfinding child's done).
- **Blockers:** the numbers on the first `Blocked by:` line (`05`, `01, 02`,
  `03-sol-review-dry-run.md`, `#04`; words and dates in brackets and `None` name nothing), in
  the ticket's own feature folder. A blocker with no file blocks.
- **Picking** (`pick_ticket`): `ready-for-agent`, every blocker done, lowest number first, a tie
  going to the feature first by name. Numbers repeat across features, so a ticket is
  `<feature>/NN`. Checked on 2026-11-10 against every ticket in personal-ops and royal-bully-ops
  (128): each has a status this reads.
- **Not built:** the Claude lane skips local repos, and `--once --dry-run` only names the
  next ticket. The no-remote flow was dropped (ticket 12): queue-runner moved to GitHub and
  personal-ops is not served (Stefan, 2026-11-10).

## A Sol pass

The review loop's rules are `~/Code/docs/pr-review.md`; leads-dashboard's
`docs/agents/review-loop.md` and `REVIEW.md` define the words.

1. **Settle.** Under `sol.lock`, a review the log shows open was cut off with its runner: it
   counts as `failed`. An open merge is settled from GitHub: `merged` or `failed`.
2. **Stops** (`stops.Stopper`, before merging, so a PR stopped now neither merges nor is
   reviewed; see Stops for Stefan, below).
3. **Merge** (`merge.Merger`, also right after a clean review is posted). A PR merges once the
   runner's own newest review of its head H is `clean` (a clean review that stops for Stefan is
   `stop`). Just before, it's read again: open, still at H (moved: nothing is tried, and Sol
   reviews the new head), not a draft, no Claude job writing to it, no live run open in the repo, its newest review comment
   the clean one on H, checks passed on H (`sol-review` not counted), no conflict, nothing said
   on it since that review (bots, `*[bot]`, aside) and no unresolved review thread. Why not is
   logged once. Then `PUT pulls/<n>/merge` with `sha=H` and `merge_method=merge` (a merge
   commit; Lovable syncs main), so GitHub refuses with 409 if H moved in between: `head-moved`.
   Two failed merges on H leave it until a push or `--release`. After the merge the worktrees of
   the PR's build and fix jobs are removed with their local branches (`GitCli.remove_worktree`:
   gone from `git worktree list` counts, since T3 may hold the empty folder), and one that
   can't be is said, and their threads are settled (Settling threads, below). The repo's live
   steps (leads-dashboard: Lovable) run later in the Claude
   lane (Live steps, below). **In a repo Stefan merges** (leads-dashboard), the PR is marked
   `ready-for-stefan` instead, and his merge is noticed on a later pass (Stefan merges, below).
   **Merge job records** (kind `merge`): `sha` H, `head` the merge commit; outcomes `merged`,
   `head-moved`, `failed`.
4. **Adopt** (`Reviewer.why_not`): open PRs, lowest number first. The old script's labels
   (`needs-sol-review`, `sol-reviewed`) mean nothing since the cutover (ticket 13). A PR is left alone, and why is
   logged once, while a build or fix job writes to its branch, once the runner reviewed its
   head H, after two failed reviews on H (until a push or `--release NAME#N`), while a review
   comment is on H already (any of the three formats below), while H's checks are running or
   none have reported (`sol-review` isn't counted), while it's stopped for Stefan, and when a
   check failed (a stop) or it conflicts with its base (a conflict round, or a stop: Conflict
   rounds, above). GitHub failing on one PR skips only that
   PR.
5. **Review H.** Fetch `refs/pull/<n>/head` into `refs/queue-runner/pr<n>` and the PR's base
   (PRs stack: the base isn't always main); if the head moved since listing, `head-moved` and
   nothing counts. Sol reads a detached checkout at H under `checkouts_dir`, removed afterwards,
   with its dependencies linked in so it can run the tests (Sol runs tests, below).
   Its inputs are in the run folder, `runs_dir/<repo>-pr<n>-r<K>-<time>/`: `change.diff` (review
   1, or after a force-push: the whole diff, `origin/<base>...H`; later: the change since the last
   reviewed commit) and `full.diff` (later reviews), `pr.md`, `issue-<k>.md` (`issue-<owner>_<name>-<k>.md` in another repo) for each issue it
   closes with its comments, `conversation.md` (comments, review threads, review bodies, earlier
   ledgers). `brief.md` (`templates/review.md`) lists them, points to `AGENTS.md`, has
   `REVIEW.md` in full and, from review 2, the open findings, the classes so far, the IDs used
   and the replies since the last review.
6. **Decide** (`ledger.py`, no I/O): the verdict and outcome come from the last `sol-findings`
   block in Sol's reply, never its prose. Clean when no Important finding is open; outcomes, in
   order: `stop` (a new Important finding in an earlier class, a closed finding reopened, a
   decline Sol kept), `approach-note` (blocking from review 3 on: there's no spend guard any
   more, so every blocking review from 3 comes to Stefan), `merge` (clean), `fix`. An Important
   finding without file, line and a scenario (or a cost and rule) counts as a nit; nits past five
   are dropped and named. No readable block: `failed`.
7. **Write.** `comment.md` (heading, Sol's prose with links made GitHub-relative, findings
   tables, notes, a visible `sol-findings` ledger of the PR's whole state, and the old script's
   hidden marker) and `decision.json` (verdict, outcome, signals, the `sol-review` status,
   follow-up issues).
8. **Post** (`post.GitHubPoster`; automated posts need no go-ahead, `~/Code/global/CLAUDE.md`). In
   order: each new Pre-existing finding as a `needs-triage` issue, with a hidden
   `<!-- sol-finding owner/name#N ID -->` line (an open issue with that line, the old script's
   footer for the PR and ID, or the same title is linked instead of filed again); the comment,
   linking them, its ledger recording each issue's URL (`issue`); `sol-review` on H, never the
   PR's head now; with `review_table`, a row in the PR body's `## Review` table, read afresh
   (`with_review_row`, ported from the old script). The comment is the review's record: if it
   can't be posted the review is `failed` and the PR is reviewed again. A failure after it is
   said and left. A filing that fails is marked `unfiled` in the ledger, and the next review
   files it. Issues go before the comment, as the old script did, so the comment can link them;
   a comment that fails after them leaves the issues, which the retry links by their hidden
   line. `DryRunPoster` posts nothing (`live_review.py`, `--dry-run`), and a `Reviewer` given
   it merges nothing either.

**Findings across reviews** (`decide`): Sol reuses IDs. A finding listed again under a new ID
with the same tag, class, file and line as an open or filed one, and no status given for the old
one, takes the old ID (so it's no new finding in an earlier class), and a finding listed again
is shown under Earlier findings, not as new. An earlier Pre-existing finding counts as filed
unless it's `unfiled`.

**Review numbering carries on** from the PR's comments, whichever wrote them: the old script's
and the runner's marker `<!-- sol-pr-review round=N verdict=V sha=H findings=<base64> -->`, and a
review Sol posted itself from a T3 child (leads-dashboard #168): `<!-- sol-review round=N head=H
-->`, with the verdict in its heading and the findings in its visible block. The newest review
holds the PR's whole state.

**Review job records** (kind `review`, `issue` = the PR) add `sha`, `round`, `verdict`, `signals`,
`run_dir` and `resume_at`. Outcomes: `clean`, `blocking`, `stop`, `approach-note` (H was
reviewed), `failed`, `out-of-usage` and `head-moved` (nothing counts).

## Stops for Stefan

`stops.py` (`~/Code/docs/pr-review.md`, Stops). Each Sol pass, for every open PR (not one a Claude job
is writing to), the runner looks for stops on its head H, and
files each kind once per H (`JobLog.stopped`). The kinds: `review` (the runner's review of H
stopped: a repeated class, a reopened finding, a kept decline; the reason is decide()'s text from
the run folder's `decision.json`), `no-push` (a fix round on H ended without pushing),
`failed-check` and `conflict` (only once a conflict round couldn't resolve it, or a third
conflict: Conflict rounds, above). A review that stops files right after it posts. Two kinds are
filed by decisions in the Claude lane: `approach-note` (review 3 or later still blocking, filed
with the Approach note; the Sol pass files it again from the decision's record if filing failed)
and `decision` (a decision thread's question on a PR). Live runs file `live` and `live-todo` on a
merged PR (Live steps, above).

**Filing** (automated posts, no go-ahead): the PR's one open `needs-info` issue, found by its
hidden `<!-- queue-runner needs-info owner/name#N -->` line, gets the stop as a comment; with
none open, one is filed (`PR #N needs Stefan: <title>`). Then a comment on the PR records the
stop and links the issue (`<!-- queue-runner stop kind=K sha=H issue=I -->`; `ledger.runner_post`
keeps it, like the reviews, from counting as a reply), then a toast. An issue that can't be filed
makes the stop `failed`, and the next pass files it; a failed PR comment or toast is said and
left. **Stop job records** (kind `stop`, `issue` = the PR): `stop` (the kind), `sha` H, `link`
the issue, `reason`; outcomes `filed`, `answered` (with `answer`: `issue-closed`, `replied`, or `thread` when
Stefan decided it in its ask thread: Deciding an ask in T3, above) and
`failed`.

**Left alone until Stefan answers:** while a stop is `filed`, the PR gets no review (even on a new
head), no fix round and no merge (`stops.held`). It's answered when its issue is closed or someone
(not a bot, not the runner's own posts) says something on the PR or on that issue after the
stop; `--release NAME#PR` lets it go too. Answers are read at the start of each Sol pass. A
closed issue puts the PR back in the loop; a reply holds it until a decision acts on what it asks
(Decision threads, above). Every comment the runner posts outside a review carries a hidden
`<!-- queue-runner ... -->` line (`ledger.RUNNER_MARK`), so none counts as a reply.

**Toasts** (`toast.py`): a native Windows toast under the runner's own name and icon. The runner
registers its AppUserModelID `Stefan.QueueRunner` under
`HKCU\Software\Classes\AppUserModelId\` (display name "Queue runner", `IconUri`
`queue_runner/assets/icon.png`, drawn by `scripts/make_icon.py`), then Windows PowerShell shows
the toast through WinRT's `CreateToastNotifier(<that id>)`, hidden; Windows shows the registered
name and icon, not PowerShell's. The toast is `activationType="protocol"` with the URL as its
`launch` (and its one button), so a click opens it with no activator. Checked live on
2026-11-10: a test toast showed as "Queue runner" with the icon. A stop's toast opens its
`needs-info` issue. A build or fix thread that exits waiting for an answer (exit 2) gets a
decision first; only when its question is Stefan's does it toast, opening the thread, because
T3's own notifications stay off (below). Tests use a fake
toaster; `Runner` and `Reviewer` default to `NoToaster`, and the CLI passes `WindowsToaster`.

**T3's thread notifications stay off** (`notificationMode` in `~/.t3/userdata/client-settings.json`).
Checked 2026-11-10 in the app's client code (`resources/server.asar`, the notification gate):
it notifies on every completed thread ("Thread completed") and on every thread that needs
attention (input, approval, usage limit, failure), for all threads not archived or hidden; only a
thread whose run Stefan stopped skips the completion one. There's no setting to limit them to
threads that need Stefan, so the runner toasts instead.

## The dashboard

`dashboard/` (ticket 18; Stefan, 2026-11-15). **Three pages do three jobs** (Stefan, 2026-11-15,
after four takes that put everything on one page): **Overview** is the first glance, **Inbox** is
what waits on him ("Needs you" before; the name is his), **Queue** is the work. Activity, Usage
and Settings follow. **The Inbox is agreed** (Stefan, 2026-11-15, after takes 5 to 7, kept in
`dashboard/earlier/`). **The Overview on the page is a first take that Stefan didn't take to**
(ticket 20: three cards, below; "way far off on what I want, or I don't actually know what I
want"). **What's next, in order** (Stefan: "Queue, Inbox, then Overview, because Overview
represents the data where it's from"): the Queue page (ticket 21), **built as three variants
switched with `?variant=a|b|c`, waiting for Stefan to judge them** (The Queue page, below);
then, if it's still needed, a grill on what the Overview is for (ticket 25); then the Overview
again (ticket 20), also as variants. Its frame is the one Stefan asked
for in the prototype rounds: a sidebar for getting around (the repository switcher and the
pages), one centred column, and the machine's readings floating on the right, in his order:
usage, the build order, then the runner's status. **It is its own process and depends on nothing:** no build step, no
package, no network, no runner code, no T3, no GitHub. One HTML file, served by Python's standard
library.

```
python3 -m dashboard    # http://queue.localhost/ is the runner's; http://localhost:5289/ is sample data
```

- **One process, and the address is the switch** (ticket 29; Stefan, 2026-11-15). The request's
  `Host` picks the data: `queue.localhost:<port>`, and `queue.localhost` with no port, are the
  runner's snapshot and control file in `--state-dir` (no port: http://queue.localhost/, through
  `~/Code/tools/localhost-proxy`, Caddy in Docker Desktop holding 127.0.0.1:80 for every
  `*.localhost` app and passing the Host on; Stefan, 2026-11-16); `localhost:<port>` and `127.0.0.1:<port>` are sample data, whose controls go to
  a temp folder removed when the dashboard stops. Any other `Host` is refused (403). There is no
  `--sample` any more. `?sample=<state>` and `/earlier/take-N.html` work on the sample addresses
  only, and the real snapshot is served with any `sample` key taken out, so the sample menu and
  the Queue's variant pill (both shown only when `snap.sample` is set) never show there. The
  start line names both addresses and which is which.
- **A control is taken only from the address it was sent to:** `POST /control` needs an
  `Origin` equal to `http://<its Host>` (a browser sends one on every POST), so the sample page
  can never write the real control file, and a request with no `Origin` (not a page) is refused.
- **No snapshot yet** on the real address: `/snapshot.json` is a 404 whose `start` says how to
  start the runner (its shortcut, or `pythonw -m queue_runner` in this repo), and the page
  shows that and no controls.
- **One dashboard per port** (`serve.Server`): it binds with `SO_EXCLUSIVEADDRUSE` and without
  `SO_REUSEADDR` (Python's `HTTPServer` sets it, which on Windows let three dashboards listen on
  5289 at once). A second start says `A dashboard is already running on port N` and exits 3. It
  starts at logon from the Startup folder (Running unattended, above).

- **Two files are the whole contract,** both in the state folder (`--state-dir`, default
  `~/.queue-runner/state`). `snapshot.json`: the runner writes it whole, the page reads it.
  `control.json`: the page writes it whole, the runner reads it. **The runner writes
  `snapshot.json`** (ticket 28, below) and obeys `control.json`'s stops (ticket 30: Stopping a
  lane, above) and its `repo_order` (ticket 33: The build order, above).
- **The runner's snapshot** (`queue_runner/snapshot.py`, ticket 28; spec
  `.scratch/queue-runner/dashboard-live.md`). In continuous mode only (`--once` writes none):
  `Publisher` writes it whole (a temp file, then `os.replace`) after every pass of either lane,
  and every `write_every` (30) seconds from its own thread, so it goes on while a lane is
  blocked in a job. A write that fails is logged once (`The dashboard snapshot was not
  written ...`, then `... is written again`) and never stops a lane. `build(Facts)` is pure, one
  small function per part; `Snapshots` gathers the facts: the job log (each lane's open job),
  each lane's switch (`control.read`: a stopped lane is `stopped`, `stopped.at` when Stefan
  asked, or gate.json's mtime for the older pause; `stopping` while its job still runs; an
  unreadable control.json makes an idle lane `waiting` with the reason; `control_read_at` is
  the `written_at` of the control.json the snapshot read, since each lane reads it again before
  it starts anything; `knob.paused` is whether the Claude lane is stopped), gate.json's reserve, the learned costs (`CostBook.learned`), the Claude lane's wait as its last
  pass left it (`Runner.claude_wait`: the gate's verdict text or a limit's resume), Sol's resume
  (`JobLog.sol_resume_at`), and the titles the passes read (`Runner.titles`). **Sources** are the
  last real call of each kind: the CLI wraps GitHub and T3 in `Calls.watch` and the gate's usage
  reader in a `Watch`, so every call the passes make is recorded (a failing one keeps its last
  good time). **GitHub is never read for the snapshot.** Only the publisher's own 30-second writes
  read afresh: Claude's usage and ChatGPT's (`codex_usage.CodexUsage`, ticket 42: Usage, below)
  at most every 5 minutes (`READ_EVERY`) or on a Refresh, and an open Claude job's
  thread in T3 until found. `asks` and `answered` are ticket 31's (The Inbox's asks, below);
  `features`, `issues`, `prs`, `activity` and each lane's `queue` ticket 32's (The work lists,
  below). `stop_now` is unavailable until ticket 34. `--snapshot` prints one built the same way
  with no runner in memory (its pid and start from runner.pid, a limit's wait from the job log),
  reading GitHub once itself for the Inbox and the work (git only read: nothing fetched).
- **The snapshot's shape is what `dashboard/sample.py` builds** (version 1): `written_at` and
  `write_every` (a snapshot older than three times that, or 90 seconds, means the runner has
  gone quiet: the page says so, greys the health readings and takes the controls away),
  `control_read_at`, `sources` (health; `short` is the name beside its dot, `group` sorts them
  on the page: `provider`, `local` or `external`), `repos` in build
  order (each with `stopped`, `{"at"}` or null: ticket 37), `asks` (below; each with `read` and
  `snoozed_until`: Read and snoozed, below), `answered` (asks Stefan has answered that the runner hasn't acted on
  yet: an ask plus `answered`: `at`, `said`, `next`; not counted as waiting on him), `lanes` (each with its `queue`, what it takes up next, in order, across
  repositories, a job a limit cut off first, and for the reviewing lane the PRs waiting for their review; `queue_empty` says why there's none), `usage` (a plan
  each: `id`, `provider`, `name`, `plan`, `read_at`, `error`, `windows`, and `resets`,
  `{"available": N}` or null: Usage, below), `usage_refresh` (`{"asked_at", "done_at"}`, the
  Refresh the runner last read for, or null), `features` (in build order: the repos'
  order, then the feature whose first open ticket has the lowest number, a finished one last; each with `tickets`, its
  tickets' `repo#n` keys in the order they're built: what has started first, furthest along first, then a blocker
  before what it blocks, lowest number first, one not marked ready last), `issues` (with `pick`, the order ready work is
  built in, and `state`: `done` only once it's live, `merged` while it's merged and its live
  steps haven't run, `review` and `fixing` in a PR, `building`, `you`, `ready`, `blocked`,
  `not-ready`), `prs` (each with its timeline by head), `activity` (what happened, newest first),
  `costs` (what the gate expects each kind of Claude job to take), `roles` (which lane does each
  kind of job) and `knob` (`gate.json`). A lane and a plan name their `provider` (`claude`,
  `chatgpt`), which picks the mark beside the name; the reviewing lane's id stays `sol`. Times
  are ISO strings; the page formats them. `sample.STATES` names every state the page has to show.
- **Control** (`serve.apply_control`): `POST /control` takes `{"lane", "stop"}` (`"after-job"`,
  `"now"` or null to carry on), `{"repo", "stop"}` (`"after-job"` or null: Stopping one repo,
  above), an ask's `{"ask", "read"}` (true or false) and `{"ask",
  "snooze_until"}` (an ISO time with its offset, kept in this PC's, or null), or `{"ask": <id>,
  "open": true}` (`asks.<id>.open`: Deciding an ask in T3, above), or `{"usage": "refresh"}`
  (`usage.refresh_at`: Usage, below), and anything else is refused, `{"repo_order"}` too
  since #61;
  each write keeps what the others wrote. The page shows a request as asked until
  `control_read_at` reaches its time.
- **Usage** (ticket 42): the Usage card's head has Refresh (an icon, "Refresh" on hover) where
  Details was; the Usage page stays in the sidebar. It posts `{"usage": "refresh"}`; the
  publisher's next fresh tick (30 seconds at most) reads both plans whatever `READ_EVERY` says,
  no more than once a minute (`FORCE_EVERY`; a later request waits for a later tick), and the
  snapshot's `usage_refresh.asked_at` names the request it took. The button spins until then
  (the page reads every 2 seconds meanwhile), then the card says which plan it couldn't read; it's
  off while the runner is silent or its snapshot has no `usage_refresh` (older code). A request
  left from before the runner started is taken by its first read. **Reset credits** come from
  the same read as the windows, counted as T3 counts them: Claude's from the usage answer's
  `cedar_ember` grants (usable, not paused or ended; none when the grant to use next isn't one:
  `usage.resets`, T3's `claudeResetCreditsToContract`), ChatGPT's from `codex app-server`'s
  `account/rateLimits/read`, `rateLimitResetCredits.availableCount` (`codex_usage.py`, T3's
  `probeCodexAppServerProvider`, read 2026-11-16). That call also gives ChatGPT's windows, so it
  replaced Codex's rollouts (which carry no credits) as the snapshot's ChatGPT read: the app
  server started for one call (Codex on PATH, else the Codex app's copy), `initialize`,
  `initialized`, the read, about a second, 20 at most; Codex reads its own login. Starting it
  rewrites Codex's shared `~/.codex/models_cache.json` (seen 2026-11-16; T3's own check writes it
  again). A plan
  says "2 resets left" on its line, and nothing when it has none. **Redeeming one isn't on the
  page:** it spends the credit, so it stays Stefan's, in T3.
- **The Repositories card** (#61, Stefan 2026-11-16: "just stop and resume") was the Build order
  card: no numbers or arrows, the repos in the order the runner takes them up (config.toml's,
  or a `repo_order` still in control.json: the snapshot's `repos`), its note "Taken up in this
  order." naming neither (PR #62's F2), on every page; Settings has no copy of it.
- **What's left** (#60, Stefan 2026-11-16: "71% left as opposed to the current usage"): each
  usage window says `100 - used` as "N% left", on the Usage card and page; the bar holds what's
  left, amber at 15% left or less and red at none, and the share kept for you is blue at its left
  end, never wider than what's left (none at 0% left: PR #62's F1, `tests/test_meter.py` runs the
  page's `meter()` in node). The snapshot still carries `used`.
- **A stopped repo on the page** (ticket 37): each row of the Repositories card has Stop or Resume
  and says "Stopped since ..." (or "Asked to stop/resume: the runner hasn't read it yet"); its
  work reads as stopped wherever it's listed: a dashed "Stopped" tag beside its name on Inbox rows
  and repo tags, "Stopped." in the repository switcher, and "Its repository is stopped" as an
  unfinished ticket's standing on the Queue (`repoOff`, `offTag`, `standing`). The sample's
  `repo-stopped` state stops leads-dashboard while its two jobs finish: the queues hold
  queue-runner's work only, and its asks stay.
- **Only this PC:** it binds 127.0.0.1, and refuses a request whose `Host` isn't its own address
  or whose `Origin` is another site's, so a web page elsewhere can't stop a lane.
- **An ask is written to be picked up cold** (Stefan: he may come back a week later with the
  context gone). `kind` says why it came to him: `stuck` (the runner tried and couldn't get it
  through), `decision` (a product decision is his), `merge` (ready, his to merge) or `broken`
  (something failed). Then `situation` (it in one sentence), `about` (what the work is),
  `because` (the specifics), `timeline` (what has happened, oldest first: each step's `at` and
  a whole sentence as `text`; Stefan found fragments too short to read), `question`, `options`,
  `holds_up` and `go` (where it's answered: `label`, `url`, and `where`, `t3` or `github`, which
  picks the mark on the button), `decide` and `also` (whether it can be decided in a T3 thread
  and where that stands, and the other place to answer it: Deciding an ask in T3, above). The
  runner lists asks in the order they're worth taking.
- **The Inbox's asks** (ticket 31; `inbox.py` and `asks.py`). **One collection:**
  `inbox.collect` reads the job log and GitHub for what waits on Stefan (`ready` PRs, open
  `stop`s, `build`s a decision left to him, waiting `thread`s, and `answered` stops), each with
  what its ask is written from: the PR's or issue's title, page and body, the body of the issue
  a PR closes, what it holds up (GitHub's native dependencies, `GhCli.blocking`, and `Blocked
  by:` lines: leads-dashboard records its blockers only natively), an Approach note's text and
  Stefan's words, and each review's `decision.json` from its run folder. `--inbox` prints it;
  **the Sol lane reads it after every pass while a snapshot is published** (`Runner._read_inbox`,
  `inbox.Reader`), even while Stefan has stopped that lane (it only reads), and the snapshot
  writes from that read, never from GitHub. **GitHub down:** a repo it can't read keeps the last
  good read's asks, and the GitHub source turns red with that read's time and an `affects`
  line (`asks.stale_github`). **Part-way** (one ask's PR, issue, dependencies or comments
  failing, `_Reader.fill`): that ask is the last good read's (`inbox.key`, `Inbox.unfilled`;
  listed bare only if there's none), the others this read's, and the source says so the same
  way, with the time of the repo's last whole read. GitHub saying a thing isn't there (HTTP
  404, a deleted issue: `inbox.gone`) is the ask's own state: said, the ask listed as the job
  log has it, and not stale. **Templates, no AI** (`asks.render`): `about` is the first prose
  (markdown stripped) under the closed issue's "What to build" or "Summary", else its first
  paragraph, else the PR's, clipped to 300 characters; `because` the stop's reason plus the
  Important findings still open ("Open now: F3, ..."), an approach note's first paragraph after
  it; `timeline` the job log on that PR or issue, oldest first, a whole sentence per step (a
  build, each review and the kinds of problem it raised, each fix or conflict round, decisions,
  stops, answers, ready marks, merges, live runs, `--release`s; a tie goes to the job written
  first). **Kinds:** a review stop, approach note, `no-push` and `conflict` are `stuck`; a
  failed check and a `live` stop `broken`; a decision's stop on a PR, a build a decision left to
  him, a waiting thread and `live-todo` `decision`; a ready PR `merge`. Listed broken, stuck,
  decision, merge, oldest first inside a kind. **Ids** are stable: `stop-<job>`,
  `decision-<decision job>`, `thread-<job>`, `merge-<repo>-<n>-<head7>`. An approach note
  offers rework, fix on and hold with its recommendation marked; a PR stop offers a reply, hold
  or closing the issue; a merge, a waiting thread none. **Answered** (`inbox.finished`): the
  newest answered stop on an open PR stays until the runner has acted: after a reply, the
  decision on it ended (and the fix round it ordered); after a closed issue, the next job on the
  PR ended. `said` is his newest words on the PR or its issue since the stop (`closed #N` for a
  closed issue); `next` says what the runner does with it.
- **The work lists** (ticket 32; `work.py`). **The read** (`work.read_repo`, kept per repo by
  `work.Reader`): the Sol lane reads it after every pass while a snapshot is published, with the
  Inbox, through one `work.Memo` (each GitHub call once for both: about 80 `gh` calls and a
  minute for the three served repos, 2026-11-15, half of it the Inbox's). It goes through the
  lanes' own code, so the queues are what the lanes take up: `Decider.cases`,
  `LiveSteps.batch(record=False)` on a git that never fetches (`work.NoFetch`) and a stopper that
  files nothing, `Fixer.candidates`, `picker.pickable` (every build `pick` could take, in its
  order), `Reviewer.candidates`, and `Merger.steps` (the merge re-check step by step: `why_not`
  is its first failing step). Issues come from `GhCli.work_issues` (one paged GraphQL query:
  labels, parent, sub-issues, native blockers). Every repo is read, a stopped one too, and
  `--snapshot` reads the same way. **GitHub down:** a repo it can't read keeps its last good
  read, and the GitHub source says so (`work.stale_github`, after the Inbox's line). **A
  part failing on its own** (the builds, what's in flight, decisions, live steps, what's merged
  and not live, the findings, fix rounds or reviews, or one PR's merge re-check, reviews, or
  its own reading in the lanes' readers, said there as `reading it failed`) keeps that part
  from the last good read (`work.kept`, `RepoRead.failed`; a PR's own parts only while its
  head is the same), and the repo is stale, since its last whole read, until a read has every
  part. **The
  lists** (`work.lists`, `work.queue`) are written from the last read and the job log now, in
  `Facts.repos`' order, a stopped repo's work left out of both queues. **The Claude lane's
  queue** is `Runner.choose`'s order: the jobs a limit cut off, decisions, live steps (ref the
  batch's newest PR), fix and conflict rounds (only those that may go now: the next conflicted
  PR waits), then builds in the picker's order; its open job isn't listed again. **The reviewing
  lane's** is the PRs Sol would review now. **Issues:** each repo's open issues but its specs
  and maps (an issue with sub-issues is a feature) and the runner's `needs-info` issues, plus
  each feature's closed sub-issues (`done`, or `merged` while a merge commit since the last live
  run names its branch). An issue with an open PR takes its PR's family (`you` while it's held or
  ready for him, `fixing` while a round is queued or running, else `review`), with the PR's
  status as `note`; then an ask on it is `you`; a build the job log holds says what it left
  (`building`, or `you` with the `--release` that frees it; a build a release settled holds
  nothing, `View.released`); then in flight, `not-ready` without
  `ready-for-agent`, `ready` if the picker would take it (`pick` its place in the Claude
  queue's builds), else `blocked`. `blocked_by` is GitHub's dependencies and `Blocked by:` lines,
  as `repo#n`. **Features:** each open issue with sub-issues ("Spec:" or "Map:" taken off its
  title), its tickets its direct sub-issues, ordered as `dashboard/sample.py` orders them.
  **PRs:** `status` and `next` from the open job on it, its repo's stop, a hold for Stefan, the
  merge re-check (`checks`, one per step, for a PR clean on its head), its fix or conflict round
  and its place in the queue, then why Sol leaves it: **left alone** says so and what lets it go
  (a review posted before the cutover or by hand: a new head; two failed reviews: a push or
  `--release`). `timeline` is the job log on it by head (its build on the first head reviewed or
  fixed), each event a whole sentence (`asks.Story`'s), a review with its findings from its
  `decision.json`. **Activity:** every job's events and the releases, newest first, the latest
  200, with the issue's or PR's title as `detail`.
- **How it looks** is explained at the top of `dashboard/index.html`. **The Inbox reads like a
  mail client:** the list down the left for the page's whole height, in the runner's order,
  with the sidebar's Inbox entry carrying the count. **A row reads like a thread in T3's
  sidebar** (Stefan): the repository's mark and name on top with the tag (Stuck, Ready to
  merge, Your decision, Broken; each with its icon) and the age, then the subject and the
  situation in a sentence. The mark is the repository's first letter on a plain tile until the
  snapshot carries a favicon. **A row's actions are icons over its age** (ticket 44; Stefan,
  2026-11-15: "a logo, just like in T3"), shown while the row is hovered or has focus or its
  menu is open, and on the open row where there's no hover (under 1040px, or a touch screen):
  a waiting row's envelope (Mark unread, or Mark read on an unread one) and clock (Snooze, its
  menu fixed to the window under the clock: `placeRowMenu`), a snoozed row's struck clock
  (Unsnooze), a decided row none. Each names itself in a tooltip at once (`data-tip`), and acts
  without opening the ask. `u` and `s` do the same for the open ask. **The briefing is layout C** (Stefan's pick): the situation as
  the headline and the story as a timeline down the left (what it is, the specifics, each step
  with its time), and the one blue panel standing on the right: what it needs from him, the
  options, what it holds up and the link it's answered at. **Two groups at the list's foot,
  each folding to one line** (remembered in the browser): Snoozed, and Decided, which holds an
  ask he has answered until the runner is through with it, tagged "Runner's turn" until a
  lane's job is on it (same repo and ref or PR) and "Working", pulsing amber, while one is. So
  "handled" and "still held" can be told apart. The up and down arrow keys walk the list. The Inbox
  takes all the width there is (Stefan, 2026-11-15; the other pages keep their 1120px column),
  its briefing keeps a readable measure inside that, and under 2000px its right panel steps
  aside behind the Usage button. A decided ask's line says what he said and what the runner
  is doing with it ("You said "fix on". Claude is fixing PR #209, 4 min in."). A lane has one
  Stop button, which asks which stop is meant while a job runs.
- **The Overview only summarises, in three cards read top to bottom** (ticket 20, proposed and not agreed;
  `overview()` in `dashboard/index.html`). **Inbox** (`plate()`): blue while something waits.
  The count in the Inbox's own words ("3 waiting on you", unread, oldest), a row per kind with
  a cell per ask (Stuck, Your decision, Ready to merge, Broken; a kind's row opens the Inbox at
  its first ask), and "First in line": the ask the runner lists first, its situation in a
  sentence, which opens that ask. With nothing waiting the card is plain and says so.
  **Running now** (`running()`, `lane()`, `stopButton()`): a line per lane: what it's doing and
  for how long, or why it isn't, its Stop button, and **the one thing it takes up next** with
  "then N more" opening the Queue. A lane's whole queue belongs to the Queue page (ticket 21);
  its old markup is in `dashboard/earlier/take-8.html`. **Progress** (`progress()`): the first
  three features with open work, in the snapshot's order, each with its bar, the one ticket
  that says where it stands (what waits on him first, which opens that ask; else the next
  ready one; else what's moving) and "N of M done". A line under them counts the features and
  the featureless tickets it doesn't show. Each card's head opens its page; Running now has no
  page of its own.
- **The Queue page is a prototype in three variants** (ticket 21; `queue()` in
  `dashboard/index.html`, sample data only, none agreed). `?page=queue&variant=a|b|c`; the pill
  over the sidebar's foot and the left and right arrow keys turn between them (the pill shows
  on the sample addresses only), and the last one looked at is remembered in the browser. **A, features
  first** (`queueA`): a card per feature in build order, with its bar, what's left in a sentence
  ("4 to go: 2 wait on you, 1 merged but not live, 1 blocked.") and its tickets as rows in the
  order they're built; a chip or a feature's name narrows the page to it (`?feature=<id>`,
  `none` for the work that belongs to no feature); "What blocks what" draws the same scope as
  the pyramid; each lane's queue is the last card. **B, the page you land on** (`queueB`):
  three bands, what waits on him (a tile per ask, opening it in the Inbox), what's running
  (each lane with its Stop button and its whole queue), then the features folded to a line
  each, which unfolds to the ticket rows. **C, tracks** (`queueC`): every row runs left to
  right; a lane's row is what it's on and then its queue, numbered; a feature's row is its
  tickets one after another, the cells along its top being its bar, ending in "Usable";
  picking a ticket lights up what it waits on and what it holds up in every row. All three
  read `queueModel()` (each feature's tickets in the snapshot's order, each ticket's place in
  a lane's queue, the lane on it now) and `standing(ticket)` (its state's word and what comes
  next for it: "3rd in Claude's queue", "After #226"). Work with no feature is shown as a
  feature of its own, "No feature", without an end; a finished feature says "Usable". A
  ticket that waits on him carries the Inbox's own tag and opens its ask. **Reordering
  features or tickets from the page is not built: it's Stefan's to decide** (a new control
  the runner would have to obey). Once he picks, fold the winner in, and move the other
  variants and the pill to a throwaway branch (the `prototype` skill).
- **A feature's bar** on the Overview is `featureBar(feature)`; the Queue's is
  `ticketBar(title, tickets)`, the same cells in the order given: a cell per ticket, named on hover, in `SEGMENTS`' order: done (live), merged but
  not live, in a PR, building, waiting on him, ready, blocked (`not-ready` counts as blocked).
  Colour is the state's family and a hatched cell is the earlier step in it: green solid is
  done and green hatched merged, amber solid is in a PR and amber hatched building, blue is
  his, an outline is ready, a faint cell blocked. `--run-fill` is the amber for a cell (the
  text amber is too dark to fill with in light mode).
- **Read and snoozed** (Stefan, 2026-11-15: "like an IRL inbox"): an ask he hasn't opened is
  unread (a dot, bold); opening it reads it, and its row's envelope puts it back (the open
  one stays unread until another is opened: `ui.hold`). Snooze takes an ask
  out of the list and the count until a time he picks (3 hours, tomorrow 9:00, next Monday
  9:00); it sits in the Snoozed group, still holding its work up, and its row's Unsnooze
  icon undoes it. The briefing has no buttons for either (ticket 44). Choosing the snooze times in Settings is pinned (ticket 24).
  **Both are kept with the runner** (ticket 36), so every browser agrees: the page asks
  `{"ask", "read"}` and `{"ask", "snooze_until"}` (Control, above), kept in `control.json` as
  `asks.<id>` with `read` and `snooze_until` beside that object's other keys (ticket 35's
  `open`); the runner reads them (`Switch.asks`, leniently: an entry it can't use is left out
  and never stops a lane) and the snapshot's asks and answered asks carry `read` (false with no
  entry) and `snoozed_until`, null once its time has passed (`snapshot._marks`). A snoozed ask
  stays in `asks`, so it still holds its work up; the page leaves it out of the count. Until
  `control_read_at` reaches the page's last write, its entry stands in for the snapshot's
  (`mark()` in `index.html`), so a click shows at once. **An ask that's gone takes its entry
  with it:** each write drops the entries of asks the snapshot no longer lists (asks or
  answered; `App.ask_ids`, every sample state's on the sample addresses; no snapshot to go by
  drops nothing). An ask is keyed by its id only: a stop, review or head that comes back is a
  new job and a new id, so it's unread again. The sample's pretend runner reads its own control
  file's `asks` like the rest (`_obey`). The folded groups stay in the browser. The runner
  holding a snoozed ask's toast isn't built.
- **A point in time is written whole** (Stefan, 2026-11-15): `stamp()` gives "November 15, 2026
  Sunday 1:14pm", for when an ask began waiting, a usage window's reset, the runner's start and
  a snooze's end. A list row keeps the short age ("2 h") with the whole time on hover. Choosing
  the format is pinned (ticket 22).
- **The runner's status lists its sources by group,** in his order: Providers (Claude, ChatGPT),
  Local (T3 Code), External (GitHub). **Only what the runner depends on** (ticket 43): the
  sample's sources are `snapshot.SOURCES` (a test holds them), and whether Stop now is available
  shows on the lane's Stop button (`stop_now.note`), not here.
  Nothing on the page moves by itself (Stefan). Colour is state only: blue is Stefan's, amber
  is working, green is done or healthy, red is broken; a usage bar says what's **left**, as T3
  Code does ("65% left"; the snapshot keeps `used`), its fill shrinking as it's used, amber with
  15% left and red with none, and its blue start is the share kept for him; Claude's clay and OpenAI's black or
  white are on their marks and names only (the marks are Simple Icons', CC0, inline). Fonts are
  ones Windows ships (Segoe UI Variable, Sitka for an ask's question, Cascadia Mono), 16px and up.
- **Stop all** (the top bar) is one `{"lane", "stop"}` request per lane; a lane whose Stop now is
  unavailable is asked to stop after its job instead.
- `?page=inbox|queue|activity|usage|settings` (none is the Overview), `?ask=<id>` (the ask open
  in the Inbox), `?repo=<name>` (the switcher's choice, which narrows every page),
  `?variant=a|b|c` and `?feature=<id>` (the Queue's arrangement, and the feature A is narrowed
  to), `?view=pyramid` and `?pr=<repo>:<n>` open the page there.
- **Earlier takes, while the look is being agreed:** `dashboard/earlier/take-N.html` is the page
  as it was before a rework, served at `/earlier/take-N.html` on the sample addresses only and linked
  from the sidebar's sample menu (`sample.EARLIER`). Before reworking the page again, copy it
  there as the next take (take 8 is the page before the Overview was built, take 9 the page
  before the Queue was), add it to
  `sample.EARLIER` and to the route's test. Delete the folder, its route and its test once
  Stefan agrees the page.
- **A dashboard started before a change to `sample.py` keeps serving the old sample** (the page
  itself is read afresh on every request). Stop it and start it again, or use `--port`.
- The earlier React prototype is `.scratch/queue-runner/prototype-app/` (history only).

## Sol, as a script sees it

- **Sol runs through `~/Code/tools/codex-sol/codex-sol.sh`, not a T3 thread** (`queue_runner/sol.py`). Checked
  2026-11-09: a thread from `t3 thread start --provider codex --model gpt-6.1-sol` ran at effort
  **low**: its rollout (`~/.codex/sessions/2026/11/09/rollout-2026-11-09T19-36-32-*.jsonl`) has
  a `configuration_update` record with `reasoning.effort: "low"`, though `~/.codex/config.toml`
  says high; T3 sends its own default, and its CLI has no effort flag. `codex-sol.sh --job
  review --effort high` logs `reasoning effort: high` in `reply.md.log`. Each run is a fresh
  Codex session with no network: Sol can't post, so the runner posts (04). Files are read-only
  except the checkout and `deps_dir` (`--write`, `--writable-root`: Sol runs tests, below).
- It runs under Git's bash by full path, through a parent bash that waits: codex-sol.sh's
  watchdog ends the run once its caller is gone. 75 minutes, then tree-killed and `failed`.
- **Out of usage** ("hit your usage limit" in `run.out` or `reply.md.log`): `out-of-usage`, and
  the Sol lane starts no Sol review until 10 minutes after the reset in Sol's rollout, else the
  time Sol names, else 30 minutes (Usage limits, above); meanwhile the Opus fallback reviews
  (below), and stops and merges go on.

## The Opus fallback

`fallback.py` (issue #69, part of #68; Stefan, 2026-11-16: Sol was out from 15:46 to 18:36 and
every PR waited). While Sol is out of usage (`JobLog.sol_resume_at` in the future), the Sol lane
doesn't wait: a PR that needs a review gets one from a T3 thread on the Claude model
(`[claude]`: Opus 5.5), from the same review brief, posted as Sol's are.

- **Who reviews** (`Reviewer._who`, asked once a PR needs a review, after stops and merges, which
  go on while Sol is out with or without the fallback): Sol; the fallback while Sol is out, if
  the usage gate lets it (kind `review`: The usage gate, above; `Opus fallback review waits: ...`
  said once while it holds); or nobody, until the next pass. The Runner gives the Reviewer the
  fallback (`OpusFallback`, with T3, the gate and the effort); `--review NAME#N`, the live checks
  and `Reviewer`s made without one wait for Sol as before.
- **The Sol seam** (`OpusThread.review(brief, reply, workdir, out, writable)`, as
  `SolCli.review`): the brief is Sol's, after a preamble (`brief-opus.md` in the run folder) that
  says to work in the runner's checkout of H (where the dependencies are linked in), change
  nothing in the project folder, post and push nothing, and ask nothing. The thread is `Queue
  runner review: <repo>#<n>`, `t3 thread start --wait` in the repo's project folder with no
  worktree (T3 can't start one in an existing folder), started as every Claude job is
  (`Effort.flags`: The effort, below). Its reply's last `sol-findings` block is the verdict
  (`ledger.decide`), as for Sol. A thread T3 couldn't start, that failed, that waits for an
  answer or that left no reply is a `failed` review (two on a head leave it, as for Sol's).
- **The label** (`fallback.label`): "Opus 5.5 high, fallback while Sol is out", with the effort
  the run used, read back (`Effort.used`), else the config's. It's in the comment's heading
  (`## Sol review N · V · <label>`, so `HEADING` still reads it) and byline, the `sol-review`
  status's description (`<label>: Clean: ...`; the context stays `sol-review`), the Review row
  (`[Review N, <label>](...)`) and `decision.json`'s `reviewer`. The hidden marker is the same,
  so the review counts as any other: **a clean fallback review merges** (or marks
  `ready-for-stefan`), and a blocking one gets a fix round.
- **The job record:** kind `review` with `reviewer` `opus-fallback` in its start record, and the
  thread's `thread_id`, `run_id` and `effort` in its end. `sol_resume_at` reads only Sol's own
  reviews, so fallback reviews never end the wait; **once Sol's reset has passed, the next review
  goes to Sol**, and if Sol is still out, its `out-of-usage` starts the fallback again. A runner
  that dies mid-review counts the review `failed` as for Sol's (its T3 thread runs on; its reply
  is never read).
- **Alongside the Claude lane:** the fallback runs in the Sol lane, beside whatever Claude job
  runs. Each is gated on its own, so a build and a fallback review that each fit may together
  take more of the 5-hour window than either check saw.
- **On the dashboard:** the Sol lane's wait says Opus reviews meanwhile, a lane on a fallback
  review names Claude's model, and the work lists and the Inbox's timelines say a review was
  Opus's.

## Sol runs tests

`deps.py` (ticket 16). Sol can run a repo's tests while it reviews, mainly to confirm a suspected
bug with a failing test; CI still gates the merge.

- **Dependencies:** after the checkout, `Deps.prepare` links `node_modules` into it as a junction
  to `<deps_dir>/<repo>-<key>/node_modules`, installed once per key: the lockfile plus
  package.json's dependency fields (a script change reuses it). `bun.lock` installs with
  `bun install --frozen-lockfile`, as leads-dashboard's CI does (bun 1.4.4 at
  `~/.bun/bin/bun.exe`, installed 2026-11-10; `package-lock.json` is gitignored there), `package-lock.json` with `npm ci`, into a
  temp folder moved into place. A marker in `node_modules` (`.queue-runner-ready`) is checked on
  every use; gone, it installs again. The 3 most recently used caches per repo are kept. No
  `package.json`, no lockfile, no bun, or a failed install: nothing is linked, the brief says why,
  and the review goes on. The log says `dependencies installed in Ns (<repo>-<key>)` or
  `cached`.
- **`git worktree remove --force` follows a junction and empties its target** (checked
  2026-11-10), so `GitCli.remove_checkout` unlinks `node_modules` first (`Deps.unlink`).
- **The sandbox:** Codex's read-only sandbox stops vitest at once (EPERM writing
  `node_modules/.vite-temp`), so a review runs `codex-sol.sh --write`, with a
  `--writable-root` for each of the cache's `node_modules/.vite-temp` and `.vite`
  (`Prepared.writable`): Codex's workspace-write sandbox, the checkout and those two writable,
  the installed packages not (checked: writing into one is denied), the network off. codex-sol.sh
  adds a Files rule (write only there) and puts fnm's default Node first on PATH
  (`$FNM_DIR/aliases/default`), since the runner starts without fnm's shell PATH.
- **The sandbox user reads the cache through `~/.queue-runner`'s inherited ACL**
  (`CodexSandboxUsers` RX). An install folder made with `tempfile.mkdtemp` gets an owner-only ACL
  on Windows and can't be read (vitest "not recognized", EPERM on stat), so it's `os.makedirs`.
- **Temp folders Sol's tests leave can't be deleted by Stefan** (ticket 45, 2026-11-16). Codex's
  sandbox has no writable `%TEMP%`, so Sol sets `TEMP` to `<checkout>/.review-tmp` itself; a
  folder made there with `mkdtemp` is owner-only, owned by the sandbox user, and Stefan's account
  can neither delete it nor take it over without admin. `git worktree remove --force` then
  unregisters the checkout but leaves its folder, and the next review's `worktree add` refused
  the path (PR #4's and PR #6's failed reviews). So: **this repo's tests clean up every temp
  folder they make** (`TemporaryDirectory` with `addCleanup`; `tests/test_no_temp_leftovers.py`
  fails on a bare `mkdtemp(`), and a checkout git can't delete is moved aside to
  `<checkout>.stale-<time>` (`GitCli.remove_checkout`, also at the next `checkout`), so the
  review goes on. Before each checkout `GitCli.sweep_stale` deletes the folders moved aside
  where it can; the log says once of each it can't. Pointing Sol's `TEMP` elsewhere wouldn't
  help: a folder the sandbox user makes is owner-only wherever it is. Clearing one by hand needs
  an elevated shell: `takeown /f <folder> /r /d y`, `icacls <folder> /grant Anon:(OI)(CI)F /t`,
  then delete it.
- **The brief** (step 4, `review._tests`) tells Sol what it can run: `npm test`, a failing test it
  adds, each command named with its summary line quoted; a failure the change doesn't explain
  (Windows only) is no finding. leads-dashboard's `src/test/callsling-relay.test.ts` has one
  test that fails on Windows outside any sandbox too (EPERM removing its temp folder).

## Settling threads

`t3_mcp.py` and `t3.settle_quietly` (ticket 70; spec #68). The runner settles the threads it
started once it's done with them, so they leave Stefan's sidebar. It never settles a thread it
didn't start: only ids from its own job records.

- **When:** a build, fix or conflict thread once its end is recorded (`Runner.finish`,
  `finish_fix`, so a dead runner's settle too), whatever the outcome except `waiting`; a decision
  thread once its answer is read (`Decider.run`), and an Opus fallback review's thread once its
  reply is read (`fallback.OpusThread`), unless either asked back (exit 2); and at a merge
  (`Merger.after_merge`: the runner's, Stefan's, or one cut off with its runner), every thread
  the runner started for the PR (`JobLog.pr_threads`: its builds and fixes, the decisions on it
  or on one of those jobs, its Opus fallback reviews), the latest point one can still be open:
  so one that waited, asked back or whose settle failed goes then (review 1's F1). **Not
  settled:** ask threads, even at a merge (a decision acted on from one carries its id), and jobs
  waiting on Stefan until their PR merges (a later ticket of #68); live threads. A fallback
  review cut off with its runner records no thread id, so its thread stays.
- **A settled thread stays readable:** `thread show` and `thread list` still give it and its
  messages (checked live 2026-11-16), so decisions and restarts read its last reply as before.
  **A message to a settled thread unsettles it** (T3's `thread.unsettled` on a new turn,
  `server.asar`): a retry or a limit's resume in place shows it again, and its own end settles
  it again.
- **A failed settle** is said (`<job>: settling its thread <id> in T3 failed (...); left as it
  is`: one Stefan archived is refused too, and isn't in the sidebar) and never raised: no lane
  stops on one, and nothing retries it but the merge.
- **The interface:** `T3Cli` gains `settle` and `rename` (#71's), which go to its `mcp`, a
  `t3_mcp.T3Mcp` (`cli.main` passes one; with none they raise `T3Error`). Everything else stays
  on the CLI. `--review` and `--dry-run` get no MCP client and settle nothing.

**The token.** T3's MCP endpoint (`<origin>/mcp`, the origin read from
`~/.t3/userdata/server-runtime.json` on every call) takes only an MCP client session: subject
`mcp-client`, a bearer token. Its access is its runtime-mode ceiling, and T3 refuses a write to
any thread whose mode is above it (`runtime_mode_escalation_denied`). Every runner thread is
`full-access` (the CLI's own session is). Read in `server.asar` and checked live on 2026-11-16:

- **`t3 auth session issue --subject mcp-client`** (the issue's first plan) makes a session with
  no ceiling, which T3 reads as `approval-required`: it can read threads, but it **can't settle,
  rename or send to a runner thread, and can't launch a `full-access` thread**. Not used.
- **So the runner signs in as an outside MCP client** (`T3Mcp._mint`): `t3 auth pairing create`
  with the full-access scopes (`orchestration:read`, `orchestration:operate`, `settings:write`,
  `source-control:write`) for 5 minutes gives a one-time code; then `POST /oauth/mcp/register`
  (a client named `Queue runner`), `POST /oauth/mcp/decision` with `{_tag: "pairing-code",
  access: "full-access", code}`, and `POST /oauth/mcp/token` with PKCE. That session is
  `full-access`, good for 30 days (`MCP_CLIENT_SESSION_TTL`), labelled `Queue runner` in `t3 auth
  session list`: the access the CLI mints for itself on every `thread` call. **It can launch
  `full-access` threads** (`t3_thread_launch` with `runtimeMode: full-access`, checked live), so
  the TypeScript rebuild can use it for everything.
- **Kept in memory only:** never in a log, a record or a file. One per runner process, minted on
  the first settle; T3 refusing it (401) mints another, once. After each sign-in the runner
  revokes its older `Queue runner` sessions, so restarts don't pile them up (a second process,
  `--once`, then signs the first out, which signs in again on its next settle).

## T3, as a script sees it

- **The CLI** is `~/.t3/bin/t3.cmd` (`queue_runner/t3.py`), a batch file, so the runner keeps
  cmd.exe specials out of its arguments and sends every message on stdin (`-`).
- **`thread start|send --wait --json`** prints `{threadId, runId, status, reply, error}` whenever
  a thread exists, and exits 0 (completed), 2 (waiting for an answer) or 1 (any other end:
  failed, interrupted, cancelled). It also exits 1 with nothing on stdout when T3 itself fails
  (server down, unknown project): `T3Error`. Source: `finishRun` and `ThreadNeedsInputError` in
  the app's `resources/server.asar` (`apps/server/dist/binCli-*.mjs`).
- **No reasoning-effort flag.** T3 sets effort through the thread's model selection (its
  `options`, `{id: "effort", value}`); only `ultrathink` goes into the prompt (`Ultrathink:`).
  How the runner gets `high` anyway is The effort, below.
- **Worktrees are made by T3**: `--worktree <base ref> --branch <name>` runs
  `git worktree add -b <name>` from the base ref, under `~/.t3/worktrees/<project folder>/<branch
  with / as ->`. T3 doesn't fetch first, so the runner fetches `origin/<base>`. A leftover local
  branch of that name makes it fail. `thread show --json` gives the thread's `branch` and
  `worktreePath` (`thread list` doesn't).
- **Worktrees are removed by the script** (`merge.Merger.remove_worktrees`, after a merge): the
  CLI has no command for it. Run
  `git -C <repo> worktree remove --force <worktreePath>`, then `git branch -D <branch>`. Checked
  live on 2026-11-09 (without `--force`, on a clean worktree): git unregistered the worktree and deleted its files, but exited 1 with
  "failed to delete '<path>': Permission denied" because T3 still holds the empty folder open.
  So treat a worktree gone from `git worktree list` as removed, and sweep empty folders under
  `~/.t3/worktrees/` later. About 30 minutes later, after the thread was settled (through T3's
  MCP `t3_thread_organize`), `rmdir` worked. Whether settling the thread or the time freed it
  is unknown. T3's own cleanup (Settings → storage: `worktreeOnMerge`, off by
  default; and on thread delete) is the alternative. It isn't used, because it would race the
  runner.
- **Settling and renaming a thread** go through T3's MCP endpoint, not the CLI (it has no such
  command): Settling threads, above.
- **A usage-limit stop, as T3 shows it** (read 2026-11-10 from `server.asar` and a real stop):
  `thread show --json` gives the thread `status: failed` and Claude Code's message as the last
  assistant message; it has no reset time. `--wait --json` exits 1 with the run's error. The
  reset is only in T3's database, `~/.t3/userdata/statev2.sqlite`, which `limits.T3Store` reads
  read-only: `orchestration_v2_projection_turn_items` where `thread_id`, `run_id` and `type =
  'error'`, `payload_json.failure` `{class: "usage_limit", resetAt}` (T3's own recovery,
  `usage-limit-recovery:<runId>`, checks the same `resetAt`). The CLI never shows a Codex thread's
  stop either; the runner has none (Sol runs through codex-sol.sh).
- **A Claude thread's context size:** `orchestration_v2_projection_provider_threads` (`thread_id`,
  `driver = 'claudeAgent'`, newest `last_run_ordinal`) has the Claude session id in
  `payload_json.nativeThreadRef.nativeId`; Claude Code's transcript is
  `~/.claude/projects/<folder>/<session id>.jsonl`, and the context is its last real assistant
  record's `usage`: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens +
  output_tokens` (Claude Code's `<synthetic>` limit message has zeros and is skipped). Checked on
  the real stop: 108,633 tokens. **When that call's request started** (ticket 38,
  `limits.last_call`): the assistant record's `requestRef` names an `api-request` record (`id`,
  `timestamp`: the request's start, which the cache's hour counts from) in the same transcript;
  no such record (older Claude Code; the real stop's fixture has none) reads as unknown.
  `tests/fixtures/claude/transcript-requests.jsonl` is hand-made in the shape of a real
  2.1.319 transcript.

## The effort

`effort.py` (ticket 39; Stefan, 2026-11-15: "keep it at high by default", until his Claude Max
plan ends). Every Claude job (build, fix or conflict round, decision, live run) is meant to run
at `[claude] effort` (`high`).

- **What T3 does** (read 2026-11-15 in `resources/server.asar`, `apps/server/dist/`):
  `threadStartCommand` (`binCli-*.mjs`) calls MCP's `t3_thread_launch` with
  `modelSelection: {instanceId, model}` and no options when `--provider` and `--model` are given,
  and with no `modelSelection` when they aren't. `t3_thread_launch` (`server-*.mjs`) takes the
  given selection as it is; with none, the project's default (`resolveProjectSettings` then
  `resolveNewThreadModelSelection`), options and all, swapped for the fallback model while the
  default's provider is out of usage. A selection with no effort option compiles to the model's
  default (`compileClaudeModelSelection`: Opus 5.5's is medium, `model-manifest.json`).
- **Where a project's default lives:** T3's settings are folded (`projectSettingsFolded: true` in
  `~/.t3/userdata/settings.json`), so launch reads only that file's
  `projectSettingsOverrides[<project id>].defaultModelSelection`, else its global
  `defaultModelSelection` (`resolveProjectOverrides`, `ManagedEndpointRuntime-*.mjs`). The
  project row's `default_model_selection_json` (`projection_projects`, what MCP's
  `t3_project_update` writes; personal-ops has Opus 5.5 at high there) is not read once folded.
  T3's Settings page with a project chosen, New threads, Model ("Model for new threads in this
  project.") writes the override (client `ProjectDefaultsSettings-*.js`).
- **Checked live on 2026-11-15** in the "queue-runner sandbox" project, Haiku threads, reading
  each run's `modelSelection` in `orchestration_v2_projection_runs` and its Claude transcript:
  A, `--provider claudeAgent --model claude-haiku-5-5`: the run's selection has no options, and
  the transcript's API request had `output_config.effort: "medium"`, its assistant record
  `effort: "medium"`. Then the sandbox's project row was set to Haiku at high with
  `t3_project_update` (it still is). B, no `--model`: refused, "Pass modelSelection: the project
  has no default model.", so the row isn't read. C, `--model` again: medium, as A. The override
  itself wasn't set live: no T3 tool writes it, and editing `settings.json` changes T3's global
  settings. That step is code-read; each job's read-back confirms it.
- **So the runner** (`Effort.flags`) starts a repo's job with no `--provider`/`--model` only when
  its T3 project's default, read as launch reads it (`T3Files.project_default`), is the config's
  provider, model and effort and no fallback model is set (one would start it on another
  model); else with `--model` as before, at the model's default. It says which, per repo, at
  start and again whenever it changes, with the step when it isn't set. A continued job (`t3
  thread send`) keeps its thread's selection.
- **Read back** (`T3Files.run_effort`, into the end record's `effort`): the `effort` on the
  thread's Claude transcript's assistant records since the run started (Claude Code's own record
  of what it sent; `<synthetic>` ones skipped), else the effort option on T3's run record, else
  null. Anything but the config's effort is said once per repo (`<repo>: <job> ran at effort
  medium, not high`), and an unreadable one too; it's said again only when it changes. Only
  `main` reads T3's files (`effort.T3Files`, read-only); a `Runner` without an `Effort` (tests,
  `live_merge.py`) starts with `--model` and records no effort.
- **Stefan's step, once per served project** (game-backdrop, leads-dashboard, queue-runner; none
  is set on 2026-11-15, so all three run at medium until then): in T3, Settings, choose the
  project, New threads, Model: Claude Opus 5.5, Reasoning: High, and leave its fallback model
  unset. The runner's start line then says `<repo>: its T3 project's default model is
  claude-opus-5-5 at effort high; its Claude jobs start on it (no --model)`. If it still says
  "it has no default model", the change went to the project row, which launch doesn't read.

## Live check

```
python3 scripts/live_sandbox.py
```

This runs one real build job, a small Haiku thread, through `Runner.run_build` on a hand-made
issue ("Add a line to README") in the sandbox. The sandbox is `~/.queue-runner/sandbox/repo`: T3
project "queue-runner sandbox", with a bare `../origin.git` as its `origin` and no GitHub. Its
job log and runner log stay in `~/.queue-runner/sandbox/`. It says how the sandbox's jobs start
(The effort, above) and its record has the `effort` read back. Its thread is settled at its end
(Settling threads, above): that signs in to T3's MCP endpoint, which signs a running runner out
until its next settle. Before running it again, delete the
`claude/add-a-line-to-1` branch locally and in `origin.git`, or the job is held as
`branch-exists`.

```
python3 scripts/live_review.py NAME#N
```

This has Sol review one real PR's head through `Reviewer.review`, as a dry run: it prints what
adoption would say and reviews anyway, posting nothing. Its job log, run folder and checkout
stay in `~/.queue-runner/live-review/`, apart from the runner's state, so the runner still
reviews that head for real. It costs one Sol review (not gated).

```
python3 scripts/live_fix_brief.py NAME#N
```

This prints the fix brief for the runner's newest blocking review of a real PR, built as the
Claude lane would, even if the head has moved since (it says what the lane would do now). It
starts, posts and records nothing; it fetches the PR's head into the runner's local ref.

```
python3 scripts/live_merge.py
```

This runs the merge path for real, with Sol stubbed clean (no tokens), against the private GitHub
sandbox `stefan1575/queue-runner-sandbox` (cloned at `~/.queue-runner/gh-sandbox/repo`; safe to
delete). It opens a PR from a worktree that plays a build's, passes a `ci` status, reviews it
clean without merging, pushes again (the merge pass must not merge, and GitHub must refuse the
old expected head with 409), then reviews the new head clean and lets the Sol lane merge it,
checking the merge commit and that the worktree and branch are gone. Each run makes a new PR;
its job log and run folders stay in `~/.queue-runner/live-merge/<time>/`.

```
python3 scripts/live_mcp.py
```

This checks the direct MCP client (Settling threads, above) in the "queue-runner sandbox" project
only, and refuses a served repo; it costs no tokens. It signs in as the runner does, launches an
idle `full-access` thread, shows a `t3 auth session issue` token refused it, settles it, reads it
back with `thread show`, renames it, archives it and revokes its own session. Run on 2026-11-16:
all passed.

## Tests

```
python3 -m unittest
```

Standard library only (Python 3.15 from scoop; `python3` is its shim). Tests never touch the
network: GitHub is the `GhCli` adapter in `queue_runner/github.py`, faked in tests with
`tests/fakes.py` (`FakeGitHub`) or with canned `gh api` JSON (`tests/test_github.py`). T3 is the
`T3Cli` adapter (`queue_runner/t3.py`), tested on output captured from the real CLI
(`tests/fixtures/t3/`), and faked with git in `tests/fakes_t3.py` for the run loop
(`tests/test_run.py`). The Sol lane is tested against `FakeGitHubForReviews` (every write goes to its `posts`, in
order; a call named in `fail` raises), `FakeReviewGit` and `FakeSol` (`tests/test_review.py`); `decide()` and the marker formats in
`tests/test_ledger.py`; the codex-sol.sh adapter in `tests/test_sol.py`; dependencies in `tests/test_deps.py` (a
fake install) and the junction kept on removal and a checkout git can't delete (a deny-delete ACL) in `tests/test_git.py`. Stops and toasts are in `tests/test_stops.py` (a fake toaster). Merging
(`tests/test_merge.py`) plays GitHub moving on through `FakeGitHubForReviews.now` (a PR's fields
now), `threads` and `push_before_merge`; fix rounds (`tests/test_fix.py`) run the real `Runner`
with a T3 fake whose thread pushes; `AdoptedReviewTest` runs them all again with a cutover
set, and adopts a review from before it (not one after). Conflict rounds (`tests/test_conflicts.py`): a pair of
conflicted PRs through the real `Runner`, one after the other, with a T3 fake whose thread
resolves (or doesn't), and the stops. Decisions (`tests/test_decisions.py`): the answer block
parsed, and each case and action through the real `Runner`, `FakeT3` giving a decision thread's
reply (`decision_reply`), each thread's last messages and the runs `send` starts.
The usage gate: `tests/test_usage.py` (the real response, the login, never the token),
`tests/test_gate.py` (`decide()` with a fixed clock, the knob, learned costs) and
`tests/test_gating.py` (the run loop and the knob through `main`, `FakeUsage` in `fakes.py`; every
test that runs `main` passes one, so none reads the real endpoint).
The Opus fallback: `tests/test_fallback.py` (through the Sol seam, `FakeT3` and
`FakeGitHubForReviews`: the thread and its brief, the comment, status, Review row and
`decision.json` naming it, the effort read back in the label, failed and waiting threads, the
gate holding it back and learning its cost, `--gate`'s line, the switch back to Sol after the
reset, a clean fallback review merging or marking ready, a blocking one's fix round through the
real `Runner`).
Limit recovery: `tests/test_limits.py` (the resume time, in place or fresh (`resume_choice` with
a fixed clock), the last call's request start, `T3Store` on a temp
SQLite holding the real stop's rows, the transcript, the auto-resume warning) and
`LimitRecoveryTest` in `tests/test_run.py` and a fix round's in `tests/test_fix.py` (fixed clocks,
`FakeLimits` in `fakes.py`, whose `starts` and `default_start` give a thread's last request
start; every test that runs `main` passes it, and a `t3_settings` path, so none reads T3's real
database or settings). A decision's `retry` and `answer` in place or fresh: the `cold` tests in
`tests/test_decisions.py` (its `Runner` gets a `FakeLimits` whose threads are warm unless a test
says otherwise).
The effort: `tests/test_effort.py` (`[claude] effort`; `T3Files` on a temp `settings.json`,
SQLite and transcript folder; the start flags, end records and log lines through a real build,
decision, continued job, fix round and live run with `FakeFiles`; the start line through `main`
with a `T3Store` on the temp files).
Local tickets: `tests/test_tickets.py` (both status forms, blocker lines, a sandbox git repo
with three tickets in a blocker chain) and `LocalTicketsDryRunTest` in `tests/test_cli.py`.
Live steps: `tests/test_live.py` (the answer block, the batch from `FakeLiveGit`, about to land,
each outcome and its stop, a restart through the real `Runner`); `GitCli`'s first-parent log and
changed files in `tests/test_git.py`.
Stefan merges: `StefanMergesTest` in `tests/test_merge.py` (marked once, unmarked on a new head
or a stop, his merge noticed once, a closed PR, a failed label) and `tests/test_inbox.py`
(`--inbox` through `main`, and the `merge` setting).
Serving itself: `tests/test_restart.py` (`SelfUpdate` on a real checkout with a bare origin,
`relaunch` with a fake process and toaster, the loop through `main`).
Running unattended: `tests/test_wake.py` (`Waker` against `FakeScheduler` in `fakes.py`, the
task XML, `Schtasks` on canned calls, `wall_sleep`, a second start, waiting for T3, `--stop`
with a fake kill); every test that runs `main` continuously passes a waker, so none touches the
real Task Scheduler.
Deciding an ask in T3: `tests/test_ask_threads.py` (the page's request, the record kept by
`--pause`/`--resume`, `T3Cli.launch` on canned output, then the decision tests' stopped PR #20
through the real `Runner` with `FakeT3.launch`: opened once on his click, gated, kept while a lane
or repo is stopped, its answer read and acted on, a GitHub answer winning, the snapshot's `decide`
and `also` held to the sample, and `--once --dry-run`).
The dashboard: `tests/test_dashboard.py` (control requests, the server on a free port with both
addresses' `Host` and `Origin`, every sample state, that the page loads nothing from outside
itself, and `python -m dashboard` started twice on one free port: the start line, exit 3).
Settling threads: `tests/test_t3_mcp.py` (`T3Mcp` against a fake T3 server: the sign-in, PKCE,
the older sessions revoked, a refused token minted again once, a failed tool, an event stream, no
server) and, through the real `Runner` with `FakeT3.settle` (settled threads stay readable; a
`send` unsettles), each job kind's settle and a failing one in `tests/test_fix.py`,
`tests/test_conflicts.py`, `tests/test_decisions.py` (a build, its decision, a retry, a waiting
build, a decision that asked back, a dead runner's build), `tests/test_merge.py` and
`tests/test_ask_threads.py` (an ask thread is left) and `tests/test_fallback.py`.
Read and snoozed: `tests/test_read_snoozed.py` (control.json's `asks` read and kept by
`control.py`, and the snapshot's `read` and `snoozed_until` from `snapshot.build` on the Inbox's
fixtures); the requests, dropping gone asks and the sample's pretend runner in `test_dashboard.py`.
The logon shortcuts: `tests/test_make_shortcut.py` (real `.lnk` files in temp folders, read back
through WScript.Shell).
The runner's snapshot:
`tests/test_snapshot.py` (`build` from plain facts with a fixed clock, `Calls`, `Watch`,
`Publisher`, `Snapshots` on a temp state folder, and the contract: the real snapshot holds the
sample's keys at the top, in a lane, its job, a plan, a window and a source, and every sample
lists `SOURCES` and nothing else) and
`tests/test_snapshot_runner.py` (through `main`: written while a build blocks the lane, after a
run, paused, none with `--once`, `--snapshot` with the lock held; `main`'s `sol_usage` and
`snapshot_every` keep it off the real Codex and fast). `sol.latest_limits` (Codex's rollouts, no
longer the snapshot's read) is in `tests/test_sol.py`.
Usage refresh and resets (ticket 42): `tests/test_usage_refresh.py` (the control request, the
publisher's forced read and its once a minute, the sample's pretend runner),
`tests/test_codex_usage.py` (real `account/rateLimits/read` answers in `fixtures/codex/`, with
and without reset credits, through `fixtures/codex/fake_app_server.py`, so no test starts Codex)
and `ResetsTest` in `tests/test_usage.py`.
The Inbox's asks: `tests/test_asks.py` (`collect` on a temp job log and `FakeGitHubForReviews`,
written by `snapshot.build`: each kind's sentences and timeline, the approach note's options,
holds_up from native dependencies and blocker lines, the order, `answered` until the runner has
acted, GitHub down through `inbox.Reader`, and a real ask of each kind held to the sample's
keys); `CollectTest` in `tests/test_inbox.py` (`--inbox` prints the collection);
`InboxTest` in `tests/test_snapshot_runner.py` (a Sol pass reads it, only with a publisher).
The work lists: `tests/test_work.py` (`work.Reader` on a temp job log and `FakeGitHubForReviews`
with its `work_list`, written by `snapshot.build`: each lane's queue in its order, the build
order and a stopped repo, a limited job and the running one, decisions, conflict rounds, live
steps with `FakeLiveGit` and nothing fetched; each issue state, features and their order; each
PR status, left alone included; timelines and activity; GitHub down; and a real issue, feature,
PR, queue entry and activity row held to the sample's keys); `WorkTest` and `--snapshot`'s
GitHub read in `tests/test_snapshot_runner.py`; `GhCli.work_issues` in `tests/test_github.py`.
Stopping a lane: `tests/test_switch.py` (today's gate.json pause through the run loop, each
stop through `main` and `Runner.run_once`, the older pause against an entry, `--pause` and
`--resume`, the same file from the CLI's writer and `serve.App.write_control`, `--gate` and the
dry run's words, an unreadable control.json in every shape, read and repaired from both
ends, the wake tasks a stopped lane doesn't set, and a Stop asked mid-review or mid-merge).
The build order: `tests/test_build_order.py` (two served repos through `main` and the real
`Runner`: each lane in `repo_order`, the orders that are ignored and said once, a new order
written mid-job, the dry run, and the snapshot's `repos` and `control_read_at`).
Stopping one repo: `tests/test_repo_stop.py` (leads-dashboard with live steps due and
game-backdrop first through the run loop: game-backdrop's build comes first; each kind of Claude
work and the Sol lane's stops, merges and reviews with a control run unstopped; a review that ends
after its repo was stopped; `apply_control` and `--pause NAME` writing the same file; the log said
once, an unserved name, an unreadable entry, wake tasks, the Inbox, the snapshot, `--gate`, the
dry run, and the sample's `repo-stopped` state).
`tests/test_git.py` runs `GitCli` on a real local repo in a
temp folder.

## Layout

- `queue_runner/picker.py`: which ticket is next: open, `ready-for-agent`, every blocker closed
  (GitHub's native dependencies, or `#N`, `owner/name#N` or issue URLs on a `Blocked by:` line or
  under a `## Blocked by` heading), not already in flight (a `claude/*-<issue>` branch, an open
  PR on one, or an open PR that closes it or that GitHub links to it by hand), not a spec with
  open sub-issues (its children are the work); lowest number first. The job branches `claude/<slug>-<issue>` from
  `origin/<base>`. `pickable` yields every build in that order (the dashboard's queue).
- `queue_runner/tickets.py`: local tickets: status, blockers and the next one (ticket 12).
- `queue_runner/brief.py` and `templates/<kind>.md`: a job's brief, filled from the issue and the
  repo; no handoff files.
- `queue_runner/github.py`: the GitHub seam and its `gh api` adapter.
- `queue_runner/t3.py`: the T3 seam and its CLI adapter; `settle_quietly`.
- `queue_runner/t3_mcp.py`: T3's MCP endpoint called directly, for settle and rename (ticket 70).
- `queue_runner/git.py`: local git around a job (fetch, leftover branch, the branch's commits),
  a review's checkout (the PR's head, a detached worktree, diffs), a fix brief's commits and
  files, and removing a job's worktree after its PR merged.
- `queue_runner/state.py`: the job log.
- `queue_runner/run.py`: the two lanes, a build job, a fix round's thread, a continued job and
  the loop.
- `queue_runner/ask_threads.py` and `templates/ask.md`: an ask decided in a T3 thread Stefan
  opens from the Inbox: opening it, reading its answer, and the ask's `decide` in the snapshot.
- `queue_runner/decisions.py` and `templates/decision.md`: decision threads: the cases, the
  brief, the answer and acting on it.
- `queue_runner/fix.py`, `templates/fix.md` and `templates/conflict.md`: which PRs get a fix
  round or a conflict round, and their briefs.
- `queue_runner/live.py` and `templates/live.md`: live steps after merges: the batch, about to
  land, the brief, the answer and its stops.
- `queue_runner/merge.py`: the pre-merge re-check, the expected-head merge and the worktrees
  removed after; in a repo Stefan merges, the `ready-for-stefan` mark and noticing his merge.
- `queue_runner/inbox.py`: `--inbox`, everything waiting on Stefan: `collect`, the one
  collection, and `Reader`, the Sol lane's last read for the snapshot.
- `queue_runner/asks.py`: the Inbox's asks written from that collection and the job log.
- `queue_runner/work.py`: the dashboard's work lists (ticket 32): the read of each repo through
  the lanes' own code (`Reader`, `Memo`), and the queues, issues, features, PRs and activity. A fix round's local branch name (`fix_branch`) is `fix.py`'s.
- `queue_runner/review.py` and `templates/review.md`: the Sol lane: adoption, the brief, a review.
- `queue_runner/ledger.py`: earlier reviews from a PR's comments, and `decide()`.
- `queue_runner/stops.py`: stops for Stefan: which, the `needs-info` issue, the PR comment, the
  toast, and holding the PR until he answers.
- `queue_runner/toast.py` and `assets/icon.png`: the runner's own Windows toast.
- `queue_runner/post.py`: posting a review: follow-up issues, the comment, `sol-review`, the
  PR body's Review row.
- `queue_runner/sol.py`: the Sol seam and its codex-sol.sh adapter.
- `queue_runner/fallback.py`: the Opus fallback reviewer while Sol is out of usage: the Sol
  seam over a T3 thread, gated, and its label (issue #69).
- `queue_runner/deps.py`: a review checkout's dependencies, cached per lockfile and linked in.
- `queue_runner/usage.py`: Claude's usage windows and reset credits from `api/oauth/usage`, with
  the Claude login.
- `queue_runner/codex_usage.py`: ChatGPT's usage windows and reset credits through `codex
  app-server` (ticket 42).
- `queue_runner/gate.py`: the usage gate: `decide()`, Stefan's knob (`gate.json`), learned costs
  (`usage.jsonl`).
- `queue_runner/control.py`: each lane's switch: reading `control.json` (and gate.json's older
  pause), writing it for `--pause` and `--resume`, and what the runner says (ticket 30); the
  build order, `ordered` (ticket 33); each repo's stop, `stopped_repos` (ticket 37); each ask's
  entry, `Switch.asks`, read only (ticket 36).
- `queue_runner/config.py`: the served repos and the runner's folders; the build order
  (`set_build_order`) and the stopped repos (`set_stopped`), and `working`, the repos the lanes
  take work from.
- `queue_runner/limits.py` and `templates/restart.md`: usage-limit stops: T3's record of the
  reset, the transcript's last call (its context and its request's start), when a job resumes,
  in place or fresh for any job picking up an earlier thread (`resume_choice`), the auto-resume
  warning.
- `queue_runner/effort.py`: the effort Claude jobs run at: the start flags from the T3 project's
  default, and the effort a run used, read back (ticket 39).
- `queue_runner/lock.py`: `runner.lock` and `sol.lock`.
- `queue_runner/wake.py`: the wake tasks: `Waker.sync` and the `schtasks` adapter.
- `queue_runner/restart.py`: restarting on its own new code after main moves (ticket 14).
- `queue_runner/snapshot.py`: the dashboard's `snapshot.json`: the facts, `build()`, the
  sources' last calls, the usage readings and the publisher (ticket 28).
- `queue_runner/cli.py`: the command line.
- `dashboard/`: the dashboard, apart from the runner: `index.html` (the page), `serve.py` (its
  server and the control file), `sample.py` (the snapshot's shape, in every state), `earlier/`
  (the page before each rework, until its look is agreed).
- `scripts/live_sandbox.py`, `scripts/live_review.py`, `scripts/live_fix_brief.py`,
  `scripts/live_merge.py` and `scripts/live_mcp.py`: the live checks.
- `scripts/make_icon.py`: draws the toast icon, `queue_runner/assets/icon.png`.
- `scripts/make_shortcut.py`: makes the logon shortcuts, the runner's and the dashboard's
  (`--startup` copies both into the Startup folder); `scripts/live_wake.py`: the wake task's
  live check; `scripts/live_restart.py`: a restart onto broken code, toasted.
