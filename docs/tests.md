# Tests

What each test file covers, and the fakes.

```
python3 -m unittest
```

Standard library only (Python 3.15 from scoop; `python3` is its shim). Tests never touch the
network: GitHub is the `GhCli` adapter in `queue_runner/github.py`, faked in tests with
`tests/fakes.py` (`FakeGitHub`) or with canned `gh api` JSON (`tests/test_github.py`). T3 is the
`T3Cli` adapter (`queue_runner/t3.py`), tested on output captured from the real CLI
(`tests/fixtures/t3/`, `tests/test_t3.py`), and faked with git in `tests/fakes_t3.py` for the run loop
(`tests/test_run.py`). The Sol lane is tested against `FakeGitHubForReviews` (every write goes to its `posts`, in
order; a call named in `fail` raises), `FakeReviewGit` and `FakeSol` (`tests/test_review.py`); `decide()` and the marker formats in
`tests/test_ledger.py`; the codex-sol.sh adapter in `tests/test_sol.py`; dependencies in `tests/test_deps.py` (a
fake install) and the junction kept on removal and a checkout git can't delete (a deny-delete ACL) in `tests/test_git.py`. Stops and toasts are in `tests/test_stops.py` (a fake toaster), with a failed Actions check's one re-run per run and head (`FakeGitHubForReviews.workflow_runs` and `rerun_failed`). Main's own failure (#98): `tests/test_base_red.py`, through the real `Runner` (`FakeGitHubForReviews.base_heads`, `update_branch`, `close_completed`): a PR held and one base stop, a second PR filing nothing, no build but a fix round while main is red, each held PR updated and the stop closed once main passes, a refused update, the PR's own failure still a stop, and the Inbox's one broken ask; then PR #110's review 1: a new failure main doesn't have on a held head, an update that fails for another reason, a held PR with a writer, and an issue that couldn't be filed. Merging
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
test that runs `main` passes one, so none reads the real endpoint; a short job's after-read
waiting for the budget). One reading, one budget (issue 66): `CachedUsageTest` in
`tests/test_usage.py`, and `tests/test_usage_budget.py`: the CLI's wiring on `StubEndpoint`
(`fakes.py`: a real `OAuthUsage` whose fetch answers 429 within a minute of its last call),
Stefan's 2026-11-16 Refresh replayed, an hour of all four callers with every call 5 minutes
apart, a 429 beside a recent reading, a stale one, and the after-job read; `EndedElsewhereTest`
(a thread that ends outside a measured pass), `DeadFallbackReviewTest` (a dead runner's
fallback review, either lane seeing it end first) and `MeasuredRaceTest` (the other lane saying a
job ended mid-read), and `tests/test_review2_fallback_settle.py` (PR 67's review 2, as Sol wrote
it).
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
`tests/test_ask_threads.py` (a decided ask thread) and `tests/test_fallback.py`.
Threads that need Stefan: `tests/test_prefixes.py` (`titled` and `plain`; through the real
`Runner` with `FakeT3.rename` changing the title: an ask thread opened "Decide:", one from before
prefixed once by a restarted runner, its prefix off and settled when decided in the thread, on
GitHub or released, kept while running, a failed rename said once; a build and a fix round
stopped on a question "Answer:", off and settled once answered in the thread or on GitHub (a
reply sent to the thread once, a closed issue, a merged PR) or released, kept when it asks again,
and a quiet pass that calls T3 for nothing).
A stale waiting thread: `CacheExpiryTest` in `tests/test_limits.py` (a real provider turn, the
newest, none reported), `StaleAskTest` in `tests/test_prefixes.py` (settled once, prefix kept,
warmed and settled again; a build waiting on Stefan too, its Inbox item kept) and
`tests/test_stale_threads.py` (the request; through the real `Runner` with `FakeLimits.expires`:
a stale ask opened afresh with the old thread's link and messages, taken once, a thread not
stale left, an old request ignored; a stale waiting build's answer thread, its answer sent once,
GitHub's winning; the snapshot's `decide` from `mark`, held to the sample's `stale` state, and
the sample's pretend runner).
Read and snoozed: `tests/test_read_snoozed.py` (control.json's `asks` read and kept by
`control.py`, and the snapshot's `read` and `snoozed_until` from `snapshot.build` on the Inbox's
fixtures); the requests, dropping gone asks and the sample's pretend runner in `test_dashboard.py`.
The logon shortcuts: `tests/test_make_shortcut.py` (real `.lnk` files in temp folders, read back
through WScript.Shell).
The runner's snapshot:
`tests/test_snapshot.py` (`build` from plain facts with a fixed clock, `Calls`, `Watch`,
`Publisher`, `Snapshots` on a temp state folder, `ReconnectingTest`: the first reads after a
wake failing are reconnecting and red only once they last, and the contract: the real snapshot holds the
sample's keys at the top, in a lane, its job, a plan, a window and a source, and every sample
lists `SOURCES` and nothing else) and
`tests/test_snapshot_runner.py` (through `main`: written while a build blocks the lane, after a
run, paused, none with `--once`, `--snapshot` with the lock held; `main`'s `sol_usage` and
`snapshot_every` keep it off the real Codex and fast). `sol.latest_limits` (Codex's rollouts, no
longer the snapshot's read) is in `tests/test_sol.py`.
Usage refresh and resets (ticket 42): `tests/test_usage_refresh.py` (the control request, a
Refresh inside and outside Claude's budget on `StubEndpoint`, a 429 and a 401, the sample's
pretend runner),
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
Repos side by side (#50): `tests/test_side_by_side.py` (two served repos through `main` and the
real `Runner`: a build in each at once, held at a barrier so they must overlap; no second job in
a repo while its first runs; a stopped repo and a dead runner's running job each holding only
their own repo; the gate with room for one (config.toml's order on a tie, else the repo that
waited longest), a held job not holding back a later one that fits, shared passes teaching
nothing; both jobs cut off by a limit and each recovered in its repo; new code waiting for the
running jobs; the dry run and `--gate`; the snapshot while both run; an old `repo_order` ignored
silently and dropped on write). The gate beside running jobs: `RunningJobsTest` in
`tests/test_gate.py`. `FakeT3` takes a lock, as two workers call it at once. The Opus review
beside the Claude lane: `tests/test_review_beside_lane.py` (an open review holding a build, one
the Sol lane let in, the review held by a running build, `shared_with` both ways whichever
started first, a review alone still teaching, `--gate`).
Stopping one repo: `tests/test_repo_stop.py` (leads-dashboard with live steps due and
game-backdrop first through the run loop: game-backdrop's build, with leads-dashboard's live steps
beside it unless stopped; each kind of Claude
work and the Sol lane's stops, merges and reviews with a control run unstopped; a review that ends
after its repo was stopped; `apply_control` and `--pause NAME` writing the same file; the log said
once, an unserved name, an unreadable entry, wake tasks, the Inbox, the snapshot, `--gate`, the
dry run, and the sample's `repo-stopped` state).
`tests/test_git.py` runs `GitCli` on a real local repo in a
temp folder, with a bare clone as origin for a PR's screenshots (`evidence`: copied out, none,
and an unreadable origin raising rather than reading as none).
The picker and a build job's start: `tests/test_picker.py`; a build's brief:
`tests/test_brief.py`; the job log read back as a restarted runner reads it:
`tests/test_state.py`; `scripts/shoot.py`'s file names (a before and an after never share one): `tests/test_shoot.py`;
no bare `mkdtemp(` in the tests: `tests/test_no_temp_leftovers.py`
(`docs/reviews.md`, Sol runs tests); the dashboard's favicons, meter and repository rows:
`tests/test_favicon.py`, `tests/test_meter.py` and `tests/test_repo_rows.py`
(`docs/dashboard.md`).
