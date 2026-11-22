# Layout

What each module and script is for.

- `queue_runner/picker.py`: which ticket is next: open, `ready-for-agent`, every blocker closed
  (GitHub's native dependencies, read from the REST `issue_dependencies_summary.blocked_by`,
  which counts only open blockers: checked 2026-11-16, #73; or `#N`, `owner/name#N` or issue URLs on a `Blocked by:` line or
  under a `## Blocked by` heading), not already in flight (a `claude/*-<issue>` branch, an open
  PR on one, or an open PR that closes it or that GitHub links to it by hand), not a spec with
  open sub-issues (its children are the work); lowest number first. The job branches `claude/<slug>-<issue>` from
  `origin/<base>`. `pickable` yields every build in that order (the dashboard's queue).
- `queue_runner/brief.py` and `templates/<kind>.md`: a job's brief, filled from the issue and the
  repo; no handoff files.
- `queue_runner/github.py`: the GitHub seam and its `gh api` adapter.
- `queue_runner/t3.py`: the T3 seam and its CLI adapter; `settle_quietly`.
- `queue_runner/t3_mcp.py`: T3's MCP endpoint called directly, for settle and rename (ticket 70).
- `queue_runner/prefixes.py`: "Decide: " and "Answer: " on the threads that need Stefan, off
  and settled once they don't (issue #71).
- `queue_runner/waiting.py`: a waiting thread's question answered on GitHub: his reply sent to
  it, or the job ended once its issue or PR is closed (issue #71).
- `queue_runner/git.py`: local git around a job (fetch, leftover branch, the branch's commits),
  a review's checkout (the PR's head, a detached worktree, diffs), a fix brief's commits and
  files, and removing a job's worktree after its PR merged.
- `queue_runner/state.py`: the job log.
- `queue_runner/run.py`: the two lanes (the Claude lane's plan, gate and one worker per repo),
  a build job, a fix round's thread, a continued job and the loop.
- `queue_runner/ask_threads.py` and `templates/ask.md`: an ask decided in a T3 thread Stefan
  opens from the Inbox: opening it, reading its answer, and the ask's `decide` in the snapshot;
  a fresh thread in place of a stale one (`templates/stale.md`, and `templates/answer.md` for a
  question a waiting job asked: issue #72).
- `queue_runner/decisions.py` and `templates/decision.md`: decision threads: the cases, the
  brief, the answer and acting on it.
- `queue_runner/fix.py`, `templates/fix.md` and `templates/conflict.md`: which PRs get a fix
  round or a conflict round, and their briefs.
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
- `queue_runner/post.py`: posting a review: follow-up issues, the comment and `sol-review`.
- `queue_runner/sol.py`: the Sol seam and its codex-sol.sh adapter.
- `queue_runner/fallback.py`: the Opus fallback reviewer while Sol is out of usage: the Sol
  seam over a T3 thread, gated, and its label (issue #69).
- `queue_runner/deps.py`: a review checkout's dependencies, cached per lockfile and linked in.
- `queue_runner/usage.py`: Claude's usage windows and reset credits from `api/oauth/usage`, with
  the Claude login; `CachedUsage`, the one reader that asks it at most once every 5 minutes
  (issue 66), and `Reading`.
- `queue_runner/codex_usage.py`: ChatGPT's usage windows and reset credits through `codex
  app-server` (ticket 42).
- `queue_runner/gate.py`: the usage gate: `decide()` beside the jobs running (`Running`),
  Stefan's knob (`gate.json`), learned costs (`usage.jsonl`).
- `queue_runner/control.py`: each lane's switch: reading `control.json` (and gate.json's older
  pause), writing it for `--pause` and `--resume`, and what the runner says (ticket 30); each
  repo's stop, `stopped_repos` (ticket 37); each ask's
  entry, `Switch.asks`, read only (ticket 36).
- `queue_runner/config.py`: the served repos and the runner's folders; the stopped repos
  (`set_stopped`), and `working`, the repos the lanes take work from.
- `queue_runner/limits.py` and `templates/restart.md`: usage-limit stops: T3's record of the
  reset, the transcript's last call (its context and its request's start), when a job resumes,
  in place or fresh for any job picking up an earlier thread (`resume_choice`), the auto-resume
  warning.
- `queue_runner/effort.py`: the effort Claude jobs run at: the provider, model and effort every
  job names (`claude_job`, #119), and the effort a run used, read back (ticket 39).
- `queue_runner/lock.py`: `runner.lock` and `sol.lock`.
- `queue_runner/wake.py`: the wake tasks: `Waker.sync` and the `schtasks` adapter.
- `queue_runner/restart.py`: restarting on its own new code after main moves (ticket 14).
- `queue_runner/snapshot.py`: the dashboard's `snapshot.json`: the facts, `build()`, the
  sources' last calls, the usage readings and the publisher (ticket 28).
- `queue_runner/favicon.py`: a repo's favicon for its mark on the dashboard, found as T3 Code finds one.
- `queue_runner/cli.py`: the command line.
- `dashboard/`: the dashboard, apart from the runner: `index.html` (the page), `serve.py` (its
  server and the control file), `sample.py` (the snapshot's shape, in every state), `earlier/`
  (the page before each rework, until its look is agreed).
- `scripts/live_sandbox.py`, `scripts/live_review.py`, `scripts/live_fix_brief.py`,
  `scripts/live_merge.py` and `scripts/live_mcp.py`: the live checks. `scripts/live_runner_settle.py`
  is today's runner's MCP client for the app's live check (`app/live/sign-in.ts`), not run on its own.
- `scripts/shoot.py`: screenshots of the dashboard's sample states at any commit, for a PR's
  evidence (`docs/dashboard.md`, Screenshots).
- `scripts/codex-sol.sh`: runs one Sol review in Codex at the effort it's given (`queue_runner/sol.py`).
- `scripts/evidence.py`: shoots and publishes a PR's screenshots for build and fix jobs (`templates/build.md`, Screenshots).
- `scripts/make_icon.py`: draws the toast icon, `queue_runner/assets/icon.png`.
- `scripts/make_shortcut.py`: makes the logon shortcuts, the runner's and the dashboard's
  (`--startup` copies both into the Startup folder); `scripts/live_wake.py`: the wake task's
  live check; `scripts/live_restart.py`: a restart onto broken code, toasted.
- `app/`: the TypeScript rebuild (spec #68), apart from `queue_runner/`: `src/t3/` (T3's seams,
  sign-in, MCP and WebSocket; `src/t3/thread-end.ts`, a run's end from its events),
  `src/github.ts`, `src/projects.ts`, `src/app.ts` (the command line), the build lane
  (`src/build-lane.ts`, `src/picker.ts`, `src/briefs/build.ts` and the rules the briefs share in `src/briefs/rules.ts`, `src/job-log.ts`, `src/git.ts`; a job's thread settled, `src/settle.ts`), the review lane (`src/review-lane.ts`, `src/review/`,
  `src/briefs/review.ts`, `src/t3/thread-reply.ts`), `test/` (on `test/fake-t3.ts`) and `live/` (its live checks). `docs/app.md`.
