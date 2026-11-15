# Queue runner

A script with no AI in it that runs Stefan's fixed build-and-review flow and starts fresh T3 Code
threads only for work that needs Claude or Sol. The design and its rules live outside this repo:
`~/Code/docs/orchestration.md`, `~/Code/docs/pr-review.md` and `~/Code/docs/sol.md`. The
spec and the tickets that build it are in this repo's `.scratch/queue-runner/` (`spec.md`,
`issues/NN-*.md`; moved from personal-ops on 2026-11-10). The tracker's conventions are
`docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

**On GitHub as the private `stefan1575/queue-runner`** (Stefan, 2026-11-10; it was local-only
before). Commit after every completed step, with a message that says what changed and why.

## Run it

```
python3 -m queue_runner                       # run: both lanes, pass after pass (unattended: see Running unattended)
python3 -m queue_runner --once                # one pass of each lane: at most one Claude job (a decision, a fix round or a build), merges, at most one Sol review
python3 -m queue_runner --once --dry-run      # print the next Claude job's brief (a job cut off by a usage limit first, then a decision, then a fix round), list the stops it would file, what Sol would review and what would merge
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (a PR: retry its failed reviews, merges and fix round; let a stopped PR go)
python3 -m queue_runner --review NAME#N       # Sol reviews that PR's head now, if adoption says it needs one
python3 -m queue_runner --gate                # Claude's usage now, and whether a build, fix or decision would start
python3 -m queue_runner --pause | --resume    # Stefan's knob: start no Claude job, or start them again
python3 -m queue_runner --reserve PERCENT     # the share of the week kept for Stefan (default 5)
python3 -m queue_runner --stop                # stop the running runner
python3 -m queue_runner --inbox               # everything waiting on Stefan: PRs ready to merge, needs-info stops, threads waiting for his answer
python3 -m queue_runner --snapshot            # print the dashboard's snapshot from the state now (reads usage once; no lock, writes nothing)
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
merges himself: Stefan merges, below), in priority order; the runner's `state_dir` and `log_dir` (`~/.queue-runner/`, outside every served repo);
`runs_dir`, `checkouts_dir` and `deps_dir` for reviews; `poll_seconds`, the pause after a pass that started
nothing; `[claude]`, the T3 provider instance and model for Claude jobs; and `[sol]`,
`codex-sol.sh` and the Git bash that runs it. `--config <path>` reads another one.

## Running unattended

Ticket 10 (`orchestration.md`, The runner and Sleep).

- **Start:** at logon, `~/.queue-runner/Queue runner.lnk` (made by `scripts/make_shortcut.py`)
  runs `~/scoop/apps/python/current/pythonw.exe -m queue_runner` in this repo. A copy is in
  `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/` since the cutover (ticket 13), with
  `T3 Code (Beta).lnk` beside it (Stefan, 2026-11-10), so T3's server comes up at logon too. By
  hand: double-click the shortcut, or `pythonw -m queue_runner` from this folder.
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
  polls later. A Task Scheduler error is logged once and never stops the loop.
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

Ticket 14. The runner serves its own repo, `stefan1575/queue-runner` (`config.toml`, after
leads-dashboard): GitHub issues, builds, Sol reviews, and it merges its own clean PRs.
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
isn't gated**, and neither is an Approach-note answer read from Stefan's words (no thread).

- **Reading usage:** `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta:
  oauth-2025-04-20` and the Claude login's token, as T3 does (`readClaudeResetCredits` and
  `readAccessToken` in `resources/server.asar`, read 2026-11-10): `claudeAiOauth.accessToken` in
  `$CLAUDE_CONFIG_DIR` or `~/.claude`, `.credentials.json`. Claude Code refreshes it whenever it
  runs. The token goes only into the request header: no log, record or error holds it. The
  response's `five_hour` and `seven_day` are `{utilization: 0-100, resets_at}`; null means not
  started. `tests/fixtures/usage/oauth-usage.json` is a real response.
- **Fits:** the 5-hour window's used percent plus the job's expected cost must be at most 100,
  or the lane waits for its reset (plus 2 minutes); a window with nothing used takes any job. The
  week must leave `reserve` percent (5 by default) for Stefan until 24 hours before its reset,
  or the lane waits for that release; inside the last 24 hours the reserve may be spent. No room
  even then: it waits for the weekly reset. Unreadable usage (no login, HTTP 401, the endpoint
  down) starts nothing and is read again next pass.
- **Waiting:** a held pass is `gated`; the log says once why and until when (`Claude lane waits:
  ...`, and again only when that changes), and the loop sleeps `poll_seconds` or until the gate
  opens, if sooner. The Sol lane goes on.
- **The knob** is `<state_dir>/gate.json` (`paused`, `reserve`), written whole by `--pause`,
  `--resume` and `--reserve N` without the runner lock, and read before every Claude job, so it
  works while the runner runs (within one `poll_seconds`). Pausing doesn't stop a running job or
  the Sol lane.
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
  none. The end record has `resume_at` and `context` (the thread's tokens, or null). Until then
  the Claude lane starts nothing (`gated`, said once: the limit is the whole account's); the Sol
  lane goes on. Then the usage gate checks the job as usual.
- **In place or fresh:** `context` of about 50k tokens or less (`IN_PLACE_MAX`) continues the
  old thread, as a continued job (`t3 thread send`, the message `limits.RESUME_MESSAGE`).
  Anything bigger, or unknown, starts a fresh thread: the job's own brief rebuilt from its
  sources (the issue; for a fix, the fix brief from the same review of H), plus
  `templates/restart.md` (the old thread's link, where it starts, what it left uncommitted, its
  last 3 messages). T3 can't make a worktree on a branch that exists, and makes it at the same
  folder (`~/.t3/worktrees/<project>/<branch>`), so `GitCli.free_branch` keeps the branch's tip
  under `refs/queue-runner/limit/<branch>` and anything uncommitted (untracked files too) as a
  `git stash create` commit under `.../<branch>-uncommitted`, removes the old worktree and
  deletes the branch; T3 then makes the same branch again at that tip, in that folder
  (`--worktree <tip> --branch <same>`). For a fix that's the round's own local branch
  `claude/fix-pr<n>-<H7>`; it still pushes to the PR's.
- **The new job** has the old job's kind, issue, branch, title, H and round, and `about` the old
  job: that's what marks it recovered. One that never reached a thread (`not-started`,
  `not-sent`) doesn't count, so the next pass tries again. A fresh restart whose brief or branch
  can't be made (the old worktree won't go, the review isn't in the log) ends `restart-failed`:
  it isn't tried again, the old job stays the PR's writer, and Stefan gets a toast, until
  `--release`.
- **Until then it's the PR's writer** (`JobLog.writer`): Sol doesn't review a head it pushed
  before the limit, nothing merges, and no other fix round starts. `--release` lets it go.
- **The old thread is left as it is** (not settled): see T3, below.
- **T3's "Resume after usage limits"** (`autoResumeLimitedThreads` in
  `~/.t3/userdata/settings.json`, off by default) stays off: it would send "Continue where you
  left off." to the same thread itself. The runner logs a warning at start if it's on.
- **Sol** isn't a T3 thread (below), so none of this applies to it: an `out-of-usage` review
  counts for nothing and the PR is reviewed afresh, on its head then, once the Sol lane resumes:
  10 minutes after the reset in Sol's own rollout (codex-sol.sh logs `session id:` in
  `reply.md.log`; its `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl`'s newest `rate_limits`
  record; the window at 99% or more, the later one if both), else the time Sol's error names,
  else 30 minutes.

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

## A Claude pass

1. **Settle.** A build or fix job the log shows open was left by a runner that died mid-job: its
   thread is found by title (`Queue runner build: <repo>#<n>` or `Queue runner fix: <repo>#<PR>`,
   created after the job's start record). Still
   running: the pass starts nothing (one Claude job at a time). Ended: its outcome is recorded.
   No thread: `not-started`. A `waiting` job whose thread has since completed or failed is
   recorded again. One that's running again, or that T3 can't read, also makes the pass start
   nothing: if its thread is gone for good, `--release` the issue. A decision left open was cut
   off with its runner: `not-started`, so it's decided again.
2. **A decision** (`decisions.py`; Decision threads, below), before any fix round or build: the
   first case the fixed flow doesn't cover.
3. **Live steps** (`live.py`; Live steps, below): a repo's merges since its last live run, once no
   other merge is about to land.
4. **A fix round** (`fix.py`), before any build, so open PRs finish first. A PR gets one when
   the runner's own newest review of its head H is `blocking` (decide()'s `fix`; a stop or an
   approach note goes to Stefan) and that review is still the PR's newest review comment, or
   when that review stopped and a decision has since ordered a round (`Fixer.order`: Stefan's
   rework or fix on, or a decision thread's `fix`; one more round on H, its text first in the
   brief under `## Direction first`). PRs
   whose newest review was hand-run are left to the session that ran it. **One round per head:**
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
status, the branch's commits, the PR found by branch, the worktree path and any error.
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
id). The runner sends the message with `t3 thread send --wait --json`, and records the end as for
any job of its kind; a dead runner's settle finds the thread by its id. A message that never
reached a run (T3 failed and the thread isn't running) ends the new job `not-sent` (it counts for
nothing; the issue stays held), puts a waiting job back to `waiting`, and the decision
`not-started`, so the case is decided again.

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

**Acting:** `retry` and `answer` continue the earlier thread (above); `close` comments and closes
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
since 2026-11-10) isn't merged by the runner; `merge = "runner"` (the default) is.

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
  `merged` (`reason` "Stefan merged it"), its label and its build and fix worktrees go as after
  the runner's own merge, and the log says `Stefan merged it; its live steps follow`; closed
  unmerged, it's `unmarked` and the label goes (so a reopened PR isn't left ready). The live steps then read the merge from git as for any merge (a
  merge commit or a squash's `(#N)`; **a rebase merge names no PR**, so its commits wait for the
  next PR's batch).
- **`--inbox`** (`inbox.py`, read only; `--needs-me` until 2026-11-15): the PRs ready to merge (the re-check passes now,
  as the merge pass reads it), the `needs-info` stops filed and not answered or released,
  the builds a decision left to Stefan (until `--release`), and the threads waiting for his
  answer (a decision's `stop` on a waiting job), with their links; `Nothing waits on you.` when
  there's nothing. A repo GitHub can't read is said after the list.
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
   can't be is said. The repo's live steps (leads-dashboard: Lovable) run later in the Claude
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
the issue, `reason`; outcomes `filed`, `answered` (with `answer`: `issue-closed` or `replied`) and
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
python3 -m dashboard             # the runner's snapshot, http://127.0.0.1:5289/
python3 -m dashboard --sample    # sample data, no runner needed; ?sample=<state> picks a state
```

- **Two files are the whole contract,** both in the state folder (`--state-dir`, default
  `~/.queue-runner/state`). `snapshot.json`: the runner writes it whole, the page reads it.
  `control.json`: the page writes it whole, the runner reads it. **The runner writes
  `snapshot.json`** (ticket 28, below); it reads no `control.json` yet (ticket 30).
- **The runner's snapshot** (`queue_runner/snapshot.py`, ticket 28; spec
  `.scratch/queue-runner/dashboard-live.md`). In continuous mode only (`--once` writes none):
  `Publisher` writes it whole (a temp file, then `os.replace`) after every pass of either lane,
  and every `write_every` (30) seconds from its own thread, so it goes on while a lane is
  blocked in a job. A write that fails is logged once (`The dashboard snapshot was not
  written ...`, then `... is written again`) and never stops a lane. `build(Facts)` is pure, one
  small function per part; `Snapshots` gathers the facts: the job log (each lane's open job),
  `gate.json` (paused: the Claude lane `stopped`, `stopped.at` gate.json's mtime; `stopping` while
  a job still runs), the learned costs (`CostBook.learned`), the Claude lane's wait as its last
  pass left it (`Runner.claude_wait`: the gate's verdict text or a limit's resume), Sol's resume
  (`JobLog.sol_resume_at`), and the titles the passes read (`Runner.titles`). **Sources** are the
  last real call of each kind: the CLI wraps GitHub and T3 in `Calls.watch` and the gate's usage
  reader in a `Watch`, so every call the passes make is recorded (a failing one keeps its last
  good time). **GitHub is never read for the snapshot.** Only the publisher's own 30-second writes
  read afresh: Claude's usage and ChatGPT's (`sol.latest_limits`, the newest `rate_limits` in
  Codex's rollouts, the account's) at most every 5 minutes (`READ_EVERY`), and an open Claude job's
  thread in T3 until found. Empty until tickets 31 and 32: `asks`, `answered`, `features`,
  `issues`, `prs`, `activity` and each lane's `queue` (`_work` and `_queue`, where those tickets
  plug in). `stop_now` is unavailable until ticket 30. `--snapshot` prints one built the same way
  with no runner in memory (its pid and start from runner.pid, a limit's wait from the job log).
- **The snapshot's shape is what `dashboard/sample.py` builds** (version 1): `written_at` and
  `write_every` (a snapshot older than three times that, or 90 seconds, means the runner has
  gone quiet: the page says so, greys the health readings and takes the controls away),
  `control_read_at`, `sources` (health; `short` is the name beside its dot, `group` sorts them
  on the page: `provider`, `local` or `external`), `repos` in build
  order, `asks` (below), `answered` (asks Stefan has answered that the runner hasn't acted on
  yet: an ask plus `answered`: `at`, `said`, `next`; not counted as waiting on him), `lanes` (each with its `queue`, what it takes up next, in order, across
  repositories, a job a limit cut off first, and for the reviewing lane the PRs waiting for their review; `queue_empty` says why there's none), `usage`, `features` (in build order: the repos'
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
  `"now"` or null to carry on) or `{"repo_order": [...]}`, and anything else is refused. The page
  shows a request as asked until `control_read_at` reaches its time.
- **Only this PC:** it binds 127.0.0.1, and refuses a request whose `Host` isn't its own address
  or whose `Origin` is another site's, so a web page elsewhere can't stop a lane.
- **An ask is written to be picked up cold** (Stefan: he may come back a week later with the
  context gone). `kind` says why it came to him: `stuck` (the runner tried and couldn't get it
  through), `decision` (a product decision is his), `merge` (ready, his to merge) or `broken`
  (something failed). Then `situation` (it in one sentence), `about` (what the work is),
  `because` (the specifics), `timeline` (what has happened, oldest first: each step's `at` and
  a whole sentence as `text`; Stefan found fragments too short to read), `question`, `options`,
  `holds_up` and `go` (where it's answered: `label`, `url`, and `where`, `t3` or `github`, which
  picks the mark on the button). The runner lists asks in the order they're worth taking.
- **How it looks** is explained at the top of `dashboard/index.html`. **The Inbox reads like a
  mail client:** the list down the left for the page's whole height, in the runner's order,
  with the sidebar's Inbox entry carrying the count. **A row reads like a thread in T3's
  sidebar** (Stefan): the repository's mark and name on top with the tag (Stuck, Ready to
  merge, Your decision, Broken; each with its icon) and the age, then the subject and the
  situation in a sentence. The mark is the repository's first letter on a plain tile until the
  snapshot carries a favicon. **The briefing is layout C** (Stefan's pick): the situation as
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
  with `--sample` only), and the last one looked at is remembered in the browser. **A, features
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
  unread (a dot, bold); opening it reads it, and Mark unread puts it back. Snooze takes an ask
  out of the list and the count until a time he picks (3 hours, tomorrow 9:00, next Monday
  9:00); it sits in the Snoozed group, still holding its work up, and its row's Unsnooze
  button (or the briefing's) undoes it. Choosing the snooze times in Settings is pinned (ticket 24).
  **Both live in the browser's localStorage while the page is a prototype**, so Firefox and
  Chrome disagree; the real ones go through `control.json` (not built), so every browser agrees
  and the runner can hold a snoozed ask's toast.
- **A point in time is written whole** (Stefan, 2026-11-15): `stamp()` gives "November 15, 2026
  Sunday 1:14pm", for when an ask began waiting, a usage window's reset, the runner's start and
  a snooze's end. A list row keeps the short age ("2 h") with the whole time on hover. Choosing
  the format is pinned (ticket 22).
- **The runner's status lists its sources by group,** in his order: Providers (Claude, ChatGPT),
  Local (T3 Code, Stop now), External (GitHub).
  Nothing on the page moves by itself (Stefan). Colour is state only: blue is Stefan's, amber
  is working, green is done or healthy, red is broken; a usage bar turns amber from 85% and red
  at the limit, and its blue end is the share kept for him; Claude's clay and OpenAI's black or
  white are on their marks and names only (the marks are Simple Icons', CC0, inline). Fonts are
  ones Windows ships (Segoe UI Variable, Sitka for an ask's question, Cascadia Mono), 16px and up.
- **Stop all** (the top bar) is one `{"lane", "stop"}` request per lane; a lane whose Stop now is
  unavailable is asked to stop after its job instead.
- `?page=inbox|queue|activity|usage|settings` (none is the Overview), `?ask=<id>` (the ask open
  in the Inbox), `?repo=<name>` (the switcher's choice, which narrows every page),
  `?variant=a|b|c` and `?feature=<id>` (the Queue's arrangement, and the feature A is narrowed
  to), `?view=pyramid` and `?pr=<repo>:<n>` open the page there.
- **Earlier takes, while the look is being agreed:** `dashboard/earlier/take-N.html` is the page
  as it was before a rework, served at `/earlier/take-N.html` with `--sample` only and linked
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
  the Sol lane starts no review until 10 minutes after the reset in Sol's rollout, else the time
  Sol names, else 30 minutes (Usage limits, above).

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
- **The brief** (step 4, `review._tests`) tells Sol what it can run: `npm test`, a failing test it
  adds, each command named with its summary line quoted; a failure the change doesn't explain
  (Windows only) is no finding. leads-dashboard's `src/test/callsling-relay.test.ts` has one
  test that fails on Windows outside any sandbox too (EPERM removing its temp folder).

## T3, as a script sees it

- **The CLI** is `~/.t3/bin/t3.cmd` (`queue_runner/t3.py`), a batch file, so the runner keeps
  cmd.exe specials out of its arguments and sends every message on stdin (`-`).
- **`thread start|send --wait --json`** prints `{threadId, runId, status, reply, error}` whenever
  a thread exists, and exits 0 (completed), 2 (waiting for an answer) or 1 (any other end:
  failed, interrupted, cancelled). It also exits 1 with nothing on stdout when T3 itself fails
  (server down, unknown project): `T3Error`. Source: `finishRun` and `ThreadNeedsInputError` in
  the app's `resources/server.asar` (`apps/server/dist/binCli-*.mjs`).
- **No reasoning-effort flag.** CLI threads get T3's default effort for the model. T3 sets
  effort through session options; only `ultrathink` goes into the prompt (`Ultrathink:`).
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
- **Settling a thread: a script can't, so the runner leaves threads unsettled.** The CLI has no
  settle command. T3 settles through its `thread.settle` orchestration command, which the app
  and MCP's `t3_thread_organize` send; the CLI reaches T3's MCP endpoint only by minting a session
  from T3's local auth in-process (`withThreadTools`, `issueMcpClientSession` in
  `apps/server/dist/binCli-*.mjs`, read 2026-11-10), which a Python script can't do. A thread
  left unsettled costs nothing: T3's auto-resume is off (Usage limits, above) and its
  notifications are off.
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
  the real stop: 108,633 tokens.

## Live check

```
python3 scripts/live_sandbox.py
```

This runs one real build job, a small Haiku thread, through `Runner.run_build` on a hand-made
issue ("Add a line to README") in the sandbox. The sandbox is `~/.queue-runner/sandbox/repo`: T3
project "queue-runner sandbox", with a bare `../origin.git` as its `origin` and no GitHub. Its
job log and runner log stay in `~/.queue-runner/sandbox/`. Before running it again, delete the
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
fake install) and the junction kept on removal in `tests/test_git.py`. Stops and toasts are in `tests/test_stops.py` (a fake toaster). Merging
(`tests/test_merge.py`) plays GitHub moving on through `FakeGitHubForReviews.now` (a PR's fields
now), `threads` and `push_before_merge`; fix rounds (`tests/test_fix.py`) run the real `Runner`
with a T3 fake whose thread pushes. Conflict rounds (`tests/test_conflicts.py`): a pair of
conflicted PRs through the real `Runner`, one after the other, with a T3 fake whose thread
resolves (or doesn't), and the stops. Decisions (`tests/test_decisions.py`): the answer block
parsed, and each case and action through the real `Runner`, `FakeT3` giving a decision thread's
reply (`decision_reply`), each thread's last messages and the runs `send` starts.
The usage gate: `tests/test_usage.py` (the real response, the login, never the token),
`tests/test_gate.py` (`decide()` with a fixed clock, the knob, learned costs) and
`tests/test_gating.py` (the run loop and the knob through `main`, `FakeUsage` in `fakes.py`; every
test that runs `main` passes one, so none reads the real endpoint).
Limit recovery: `tests/test_limits.py` (the resume time, in place or fresh, `T3Store` on a temp
SQLite holding the real stop's rows, the transcript, the auto-resume warning) and
`LimitRecoveryTest` in `tests/test_run.py` and a fix round's in `tests/test_fix.py` (fixed clocks,
`FakeLimits` in `fakes.py`; every test that runs `main` passes it, and a `t3_settings` path, so
none reads T3's real database or settings).
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
The dashboard: `tests/test_dashboard.py` (control requests, the server on a free port, every
sample state, and that the page loads nothing from outside itself). The runner's snapshot:
`tests/test_snapshot.py` (`build` from plain facts with a fixed clock, `Calls`, `Watch`,
`Publisher`, `Snapshots` on a temp state folder, and the contract: the real snapshot holds the
sample's keys at the top, in a lane, its job, a plan, a window and a source) and
`tests/test_snapshot_runner.py` (through `main`: written while a build blocks the lane, after a
run, paused, none with `--once`, `--snapshot` with the lock held; `main`'s `sol_usage` and
`snapshot_every` keep it off Codex's real rollouts and fast). `sol.latest_limits` is in
`tests/test_sol.py`.
`tests/test_git.py` runs `GitCli` on a real local repo in a
temp folder.

## Layout

- `queue_runner/picker.py`: which ticket is next: open, `ready-for-agent`, every blocker closed
  (GitHub's native dependencies, or `#N`, `owner/name#N` or issue URLs on a `Blocked by:` line or
  under a `## Blocked by` heading), not already in flight (a `claude/*-<issue>` branch, an open
  PR on one, or an open PR that closes it or that GitHub links to it by hand), not a spec with
  open sub-issues (its children are the work); lowest number first. The job branches `claude/<slug>-<issue>` from
  `origin/<base>`.
- `queue_runner/tickets.py`: local tickets: status, blockers and the next one (ticket 12).
- `queue_runner/brief.py` and `templates/<kind>.md`: a job's brief, filled from the issue and the
  repo; no handoff files.
- `queue_runner/github.py`: the GitHub seam and its `gh api` adapter.
- `queue_runner/t3.py`: the T3 seam and its CLI adapter.
- `queue_runner/git.py`: local git around a job (fetch, leftover branch, the branch's commits),
  a review's checkout (the PR's head, a detached worktree, diffs), a fix brief's commits and
  files, and removing a job's worktree after its PR merged.
- `queue_runner/state.py`: the job log.
- `queue_runner/run.py`: the two lanes, a build job, a fix round's thread, a continued job and
  the loop.
- `queue_runner/decisions.py` and `templates/decision.md`: decision threads: the cases, the
  brief, the answer and acting on it.
- `queue_runner/fix.py`, `templates/fix.md` and `templates/conflict.md`: which PRs get a fix
  round or a conflict round, and their briefs.
- `queue_runner/live.py` and `templates/live.md`: live steps after merges: the batch, about to
  land, the brief, the answer and its stops.
- `queue_runner/merge.py`: the pre-merge re-check, the expected-head merge and the worktrees
  removed after; in a repo Stefan merges, the `ready-for-stefan` mark and noticing his merge.
- `queue_runner/inbox.py`: `--inbox`, everything waiting on Stefan. A fix round's local branch name (`fix_branch`) is `fix.py`'s.
- `queue_runner/review.py` and `templates/review.md`: the Sol lane: adoption, the brief, a review.
- `queue_runner/ledger.py`: earlier reviews from a PR's comments, and `decide()`.
- `queue_runner/stops.py`: stops for Stefan: which, the `needs-info` issue, the PR comment, the
  toast, and holding the PR until he answers.
- `queue_runner/toast.py` and `assets/icon.png`: the runner's own Windows toast.
- `queue_runner/post.py`: posting a review: follow-up issues, the comment, `sol-review`, the
  PR body's Review row.
- `queue_runner/sol.py`: the Sol seam and its codex-sol.sh adapter.
- `queue_runner/deps.py`: a review checkout's dependencies, cached per lockfile and linked in.
- `queue_runner/usage.py`: Claude's usage windows from `api/oauth/usage`, with the Claude login.
- `queue_runner/gate.py`: the usage gate: `decide()`, Stefan's knob (`gate.json`), learned costs
  (`usage.jsonl`).
- `queue_runner/limits.py` and `templates/restart.md`: usage-limit stops: T3's record of the
  reset, the transcript's context, when and how a job resumes, the auto-resume warning.
- `queue_runner/lock.py`: `runner.lock` and `sol.lock`.
- `queue_runner/wake.py`: the wake tasks: `Waker.sync` and the `schtasks` adapter.
- `queue_runner/restart.py`: restarting on its own new code after main moves (ticket 14).
- `queue_runner/snapshot.py`: the dashboard's `snapshot.json`: the facts, `build()`, the
  sources' last calls, the usage readings and the publisher (ticket 28).
- `queue_runner/cli.py`: the command line.
- `dashboard/`: the dashboard, apart from the runner: `index.html` (the page), `serve.py` (its
  server and the control file), `sample.py` (the snapshot's shape, in every state), `earlier/`
  (the page before each rework, until its look is agreed).
- `scripts/live_sandbox.py`, `scripts/live_review.py`, `scripts/live_fix_brief.py` and
  `scripts/live_merge.py`: the live checks.
- `scripts/make_icon.py`: draws the toast icon, `queue_runner/assets/icon.png`.
- `scripts/make_shortcut.py`: makes the logon shortcut; `scripts/live_wake.py`: the wake task's
  live check; `scripts/live_restart.py`: a restart onto broken code, toasted.
