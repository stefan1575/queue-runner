# Running the runner

How the runner is started, kept running, restarted on its own code, stopped per lane or per repo, and checked live.

## The command line

Every command, with what it does in full:

```
python3 -m queue_runner                       # run: both lanes, pass after pass (unattended: see Running unattended)
python3 -m queue_runner --once                # one pass of each lane: at most one Claude job per working repo (a decision, a fix round or a build), merges, at most one Sol review
python3 -m queue_runner --once --dry-run      # print each working repo's next Claude job and its brief (a job cut off by a usage limit first, then an ask thread Stefan asked for, then a decision, then a fix round), list the stops it would file, what Sol would review and what would merge
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (a PR: retry its failed reviews, merges and fix round; let a stopped PR go)
python3 -m queue_runner --review NAME#N       # Sol reviews that PR's head now, if adoption says it needs one
python3 -m queue_runner --gate                # Claude's usage now, the Claude jobs running, and whether a build, fix or decision would start and how many could at once
python3 -m queue_runner --pause | --resume [LANE]   # stop a lane after its job, or let it carry on (claude by default; sol, all): the dashboard's Stop and Resume
python3 -m queue_runner --pause | --resume NAME     # stop one served repo in both lanes, or let it carry on: the Repositories card's Stop and Resume
python3 -m queue_runner --reserve PERCENT     # the share of the week kept for Stefan (default 5)
python3 -m queue_runner --stop                # stop the running runner
python3 -m queue_runner --inbox               # everything waiting on Stefan: PRs ready to merge, needs-info stops, threads waiting for his answer
python3 -m queue_runner --snapshot            # print the dashboard's snapshot from the state now (reads usage and GitHub once; no lock, writes nothing)
```

The repo was local-only until 2026-11-10, when it went to GitHub as the private
`stefan1575/queue-runner` (Stefan). Its tickets were moved from personal-ops into
`.scratch/queue-runner/` the same day, and were local markdown there until 2026-11-16.

In production it runs under `pythonw`, so it never needs a console: every subprocess runs with
no window, and `print` goes nowhere (the log has it all). A lock on `<state_dir>/runner.lock` keeps a
second runner out: it logs `a second runner started (pid N) and exited at once` and exits 3;
`--dry-run`, `--release`, `--review` and `--stop` don't take it. Each Sol review holds `<state_dir>/sol.lock`, so
`--review` and the running lane never run two at once.

`config.toml` names the repos it serves (GitHub repo, local clone, base branch, and
`review_table` for a repo whose PR bodies keep a `## Review` table, `issues = "local"` for one
whose tickets are local markdown: `docs/claude-lane.md`, Local tickets, `merge = "stefan"` for one whose PRs Stefan
merges himself: `docs/claude-lane.md`, Stefan merges), in an order that breaks ties between repos' work
(`docs/claude-lane.md`, Two lanes); the runner's `state_dir` and `log_dir` (`~/.queue-runner/`, outside every served repo);
`runs_dir`, `checkouts_dir` and `deps_dir` for reviews; `poll_seconds`, the pause after a pass that started
nothing; `adopt_reviews_before`, the cutover date before which a blocking review the runner
didn't run counts as its own for fix rounds (A Claude pass, step 4); `[jobs]`, what each job
kind runs on (below); and `[sol]`, `codex-sol.sh` and the Git bash that runs it (the Codex
adapter). `--config <path>` reads another one.

**`[jobs]`** (issue #120): each job kind's T3 provider instance (`claudeAgent` or `codex`), model
and effort, and optionally a `fallback` used while its own provider is out of usage (without
one, the job waits for the reset). The kinds are `build`, `fix`, `conflict`, `decision`,
`live`, `review` and `ask` (an Inbox ask thread); each takes `[jobs.default]`'s keys unless it
names its own, and `[jobs.default]`'s missing keys are Opus 5.5 at `high`. Efforts are checked
per provider: Claude Code's `low`..`max`; the Codex CLI's `minimal`..`max`. A review on `codex`
runs through the Codex adapter (`docs/reviews.md`); every other job, and a review on any other
provider, starts through T3's MCP launch with its provider, model and effort named (`docs/t3.md`).
A job not on Claude skips the usage gate, which reads Claude's usage (`docs/usage.md`). A config
with no `[jobs]` runs Opus 5.5 high for every kind but review, which is Sol high with Opus 5.5
high as its fallback. The old `[claude]` and `[review]` tables fail at load with a message
saying what to write instead.

```toml
[jobs.default]            # every kind not named below
provider = "claudeAgent"
model = "claude-opus-5-5"
effort = "medium"

[jobs.review]
provider = "codex"
model = "gpt-6.1-sol"
effort = "high"
fallback = { provider = "claudeAgent", model = "claude-opus-5-5", effort = "high" }
```

## Running unattended

Ticket 10 (`docs/flow.md`, The runner and Limits).

- **Start:** at logon, `~/.queue-runner/Queue runner.lnk` (made by `scripts/make_shortcut.py`)
  runs `~/scoop/apps/python/current/pythonw.exe -m queue_runner` in this repo. A copy is in
  `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/` since the cutover (ticket 13), with
  `T3 Code (Beta).lnk` beside it (Stefan, 2026-11-10), so T3's server comes up at logon too. By
  hand: double-click the shortcut, or `pythonw -m queue_runner` from this folder.
- **The dashboard starts beside it** (ticket 29): `~/.queue-runner/Queue runner dashboard.lnk`
  runs the same pythonw `-m dashboard` in this repo (`docs/dashboard.md`, The dashboard). `python3
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
  the folder the runner's code runs from, the Claude lane fetches its base after every pass.
  When `origin/main` is ahead and fast-forwards (the runner's own merge, or any push), the Claude
  lane starts no more jobs (`The runner's own code moved: it starts no Claude job, and restarts
  ... once the jobs running end (...)`, while any run: two repos taking turns would otherwise
  hold it off for good); once none runs it says `The runner's own code moved: restarting...`,
  lets the Sol lane finish its pass,
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
  `stop` is never a Resume): neither lane starts anything until it's fixed, said once. An old
  `repo_order` (Two lanes) or an odd ask entry is ignored instead (Read and snoozed). Any Stop or
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
  the served repos less the stopped ones (`decisions.next_case`, `live.served`, `Runner.next_fix`,
  `Runner.choose`'s builds and limited jobs, `stops.stop_pass`, `merge.merge_pass`,
  `Reviewer.review_pass`); `config.repos` keeps every repo for what is only looked up or shown (a
  job's own repo when it's settled, the Inbox, the snapshot). The other repos' jobs go on.
- **A job already running on it finishes** and is settled as usual. A review that ends after its
  repo was stopped (`Reviewer.stopped_now` reads control.json then) merges nothing and files no
  stop: both wait for Resume, when the next pass does them.
- **Taken up** at the start of each lane's pass (`Runner.take_stops`), said once
  each: `leads-dashboard is stopped by Stefan: neither lane takes up its work, ...` and
  `leads-dashboard runs again: Stefan resumed it`. A name that isn't served is ignored and said
  once (`control.json stops old-repo, which is not served: ignored`). An entry the page couldn't
  have written (`"now"`, not an object) makes control.json unreadable, as a lane's does.
- **Its asks stay in the Inbox** (`inbox.collect` reads every repo); stopping the work answers
  nothing. **Its waits set no wake task:** a stopped repo's limited job and live run are skipped,
  so they set no `gate_until`. The usage limit is the account's, so another repo's job may then
  start and meet the gate or the limit itself.
- `--gate` lists the stopped repos after the lanes; `--once --dry-run` says them first and lists
  no job for them.
- The snapshot's repo carries `stopped` (`{"at"}` or null), and `doing` while its last job
  finishes; `control_read_at` moves as for any write.
- `--review NAME#N` is Stefan's own and still reviews a stopped repo's PR, but merges nothing after.

## Live check

```
python3 scripts/live_sandbox.py
```

This runs one real build job, a small Haiku thread, through `Runner.run_build` on a hand-made
issue ("Add a line to README") in the sandbox. The sandbox is `~/.queue-runner/sandbox/repo`: T3
project "queue-runner sandbox", with a bare `../origin.git` as its `origin` and no GitHub. Its
job log and runner log stay in `~/.queue-runner/sandbox/`. Its thread names Haiku and the config's effort
(`docs/usage.md`, The effort) and its record has the `effort` read back. Its thread is settled at its end
(`docs/stops.md`, Settling threads): that signs in to T3's MCP endpoint, which signs a running runner out
until its next settle. Before running it again, delete the
`claude/add-a-line-to-1` branch locally and in `origin.git`, or the job is held as
`branch-exists`.

```
python3 scripts/live_launch.py [--codex codex gpt-6.1-sol]
```

This launches a throwaway thread through T3's MCP with its model and effort named (Haiku at
`low`; with `--codex`, that model at `reasoningEffort: high`) in a new sandbox worktree, waits
for it, reads the effort back, then removes the worktree and branch and settles the thread.
Run on 2026-11-17: both ran at the effort asked (`docs/t3.md`). A Codex run's effort is read by
hand from its rollout. Like `live_mcp.py`, it signs in, so a running runner signs in again.

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

This checks the direct MCP client (`docs/stops.md`, Settling threads) in the "queue-runner sandbox" project
only, and refuses a served repo; it costs no tokens. It signs in as the runner does, launches an
idle `full-access` thread, shows a `t3 auth session issue` token refused it, settles it, reads it
back with `thread show`, renames it, archives it and revokes its own session. Run on 2026-11-16:
all passed.
