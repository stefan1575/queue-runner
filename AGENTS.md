# Queue runner

A script with no AI in it that runs Stefan's fixed build-and-review flow and starts fresh T3 Code
threads only for work that needs Claude or Sol. The design and its rules live outside this repo:
`~/.claude/docs/orchestration.md`, `~/.claude/docs/pr-review.md` and `~/.claude/docs/sol.md`. The
spec and the tickets that build it are in personal-ops `.scratch/queue-runner/` (`spec.md`,
`issues/NN-*.md`).

**This repo never goes to GitHub**: local git only, no remote, no push. Commit after every
completed step, with a message that says what changed and why.

## Run it

```
python3 -m queue_runner                       # run: both lanes, pass after pass (nothing starts it at logon yet)
python3 -m queue_runner --once                # one pass of each lane: at most one build, at most one Sol review
python3 -m queue_runner --once --dry-run      # name the next build job, print its brief, list what Sol would review
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (and retry a PR's failed reviews)
python3 -m queue_runner --review NAME#N       # Sol reviews that PR's head now, if adoption says it needs one
```

**`--once` and the bare command start real Claude builds and real Sol reviews** in the
configured repos. Don't run them against leads-dashboard to try something: use
`scripts/live_sandbox.py` and `scripts/live_review.py` (below).

In production it runs under `pythonw`, so it never needs a console: every subprocess runs with
no window. A lock on `<state_dir>/runner.lock` keeps a second runner out (exit 3); `--dry-run`,
`--release` and `--review` don't take it. Each Sol review holds `<state_dir>/sol.lock`, so
`--review` and the running lane never run two at once.

`config.toml` names the repos it serves (GitHub repo, local clone, base branch), in priority
order; the runner's `state_dir` and `log_dir` (`~/.queue-runner/`, outside every served repo);
`runs_dir` and `checkouts_dir` for reviews; `poll_seconds`, the pause after a pass that started
nothing; `[claude]`, the T3 provider instance and model for Claude jobs; and `[sol]`,
`codex-sol.sh` and the Git bash that runs it. `--config <path>` reads another one.

## Two lanes

One Claude job and one Sol job at a time (`run.py`): the Claude lane runs in the main thread
and blocks on `t3 thread start --wait` while a build runs; the Sol lane (`review.py`) runs
alongside in a thread, one review a pass. Both write the one job log (a lock per file inside
the process).

## A Claude pass

1. **Settle.** A job the log shows open was left by a runner that died mid-job: its thread is
   found by title (`Queue runner build: <repo>#<n>`, created after the job's start record). Still
   running: the pass starts nothing (one Claude job at a time). Ended: its outcome is recorded.
   No thread: `not-started`. A `waiting` job whose thread has since completed or failed is
   recorded again. One that's running again, or that T3 can't read, also makes the pass start
   nothing: if its thread is gone for good, `--release` the issue.
2. **Pick and build** (`run.py`): the first repo with a pickable issue gets one build. The runner
   fetches `origin/<base>`, writes a start record, then blocks on
   `t3 thread start --wait --json --worktree origin/<base> --branch claude/<slug>-<n>` with the
   brief on stdin. Afterwards it records the outcome.

**The job log** is `<state_dir>/jobs.jsonl` (`state.py`): `start`, `end` and `release` events, one
JSON object per line, each synced to disk as it's written. A last line torn by a crash is
ignored and cut off by the next write; a bad line anywhere else is an error. An end record has the thread id and link, run id, T3's exit code and
status, the branch's commits, the PR found by branch, the worktree path and any error.
Outcomes: `done` (exit 0, a PR found), `done-no-pr`, `failed` (exit 1), `waiting` (exit 2),
`branch-exists` (a local `claude/*` branch left over, so T3 couldn't make it again) and
`not-started` (T3 failed before any thread existed). Every build that got that far holds its
issue: the picker skips it until `--release`. Only `not-started` holds nothing, so the next pass
retries it.

## A Sol pass

The review loop's rules are `~/.claude/docs/pr-review.md`; leads-dashboard's
`docs/agents/review-loop.md` and `REVIEW.md` define the words.

1. **Settle.** Under `sol.lock`, a review the log shows open was cut off with its runner: it
   counts as `failed`.
2. **Adopt** (`Reviewer.why_not`): open PRs, lowest number first. A PR is left alone, and why is
   logged once, while a build job is still writing to its branch, once the runner reviewed its
   head H, after two failed reviews on H (until a push or `--release NAME#N`), while a review
   comment is on H already (any of the three formats below), while H's checks are running or
   none have reported (`sol-review` isn't counted), and when a check failed or it conflicts with
   its base (stops for Stefan: ticket 06 files them). GitHub failing on one PR skips only that
   PR.
3. **Review H.** Fetch `refs/pull/<n>/head` into `refs/queue-runner/pr<n>` and the PR's base
   (PRs stack: the base isn't always main); if the head moved since listing, `head-moved` and
   nothing counts. Sol reads a detached checkout at H under `checkouts_dir`, removed afterwards.
   Its inputs are in the run folder, `runs_dir/<repo>-pr<n>-r<K>-<time>/`: `change.diff` (review
   1, or after a force-push: the whole diff, `origin/<base>...H`; later: the change since the last
   reviewed commit) and `full.diff` (later reviews), `pr.md`, `issue-<k>.md` for each issue it
   closes with its comments, `conversation.md` (comments, review threads, review bodies, earlier
   ledgers). `brief.md` (`templates/review.md`) lists them, points to `AGENTS.md`, has
   `REVIEW.md` in full and, from review 2, the open findings, the classes so far, the IDs used
   and the replies since the last review.
4. **Decide** (`ledger.py`, no I/O): the verdict and outcome come from the last `sol-findings`
   block in Sol's reply, never its prose. Clean when no Important finding is open; outcomes, in
   order: `stop` (a new Important finding in an earlier class, a closed finding reopened, a
   decline Sol kept), `approach-note` (blocking from review 3 on: there's no spend guard any
   more, so every blocking review from 3 comes to Stefan), `merge` (clean), `fix`. An Important
   finding without file, line and a scenario (or a cost and rule) counts as a nit; nits past five
   are dropped and named. No readable block: `failed`.
5. **Write, don't post (ticket 03).** `comment.md` (the would-be comment: heading, Sol's prose
   with links made GitHub-relative, findings tables, notes, a visible `sol-findings` ledger of
   the PR's whole state, and the old script's hidden marker) and `decision.json` (verdict,
   outcome, signals, the would-be `sol-review` status, follow-up issues). `DryRunPoster` posts
   nothing; ticket 04 replaces it.

**Review numbering carries on** from the PR's comments, whichever wrote them: the old script's
and the runner's marker `<!-- sol-pr-review round=N verdict=V sha=H findings=<base64> -->`, and a
review Sol posted itself from a T3 child (leads-dashboard #168): `<!-- sol-review round=N head=H
-->`, with the verdict in its heading and the findings in its visible block. The newest review
holds the PR's whole state.

**Review job records** (kind `review`, `issue` = the PR) add `sha`, `round`, `verdict`, `signals`,
`run_dir` and `resume_at`. Outcomes: `clean`, `blocking`, `stop`, `approach-note` (H was
reviewed), `failed`, `out-of-usage` and `head-moved` (nothing counts).

## Sol, as a script sees it

- **Sol runs through `~/codex-sol.sh`, not a T3 thread** (`queue_runner/sol.py`). Checked
  2026-11-09: a thread from `t3 thread start --provider codex --model gpt-6.1-sol` ran at effort
  **low**: its rollout (`~/.codex/sessions/2026/11/09/rollout-2026-11-09T19-36-32-*.jsonl`) has
  a `configuration_update` record with `reasoning.effort: "low"`, though `~/.codex/config.toml`
  says high; T3 sends its own default, and its CLI has no effort flag. `codex-sol.sh --job
  review --effort high` logs `reasoning effort: high` in `reply.md.log`. Each run is a fresh
  Codex session, read-only, with no network: Sol can't post, so the runner posts (04).
- It runs under Git's bash by full path, through a parent bash that waits: codex-sol.sh's
  watchdog ends the run once its caller is gone. 75 minutes, then tree-killed and `failed`.
- **Out of usage** ("hit your usage limit" in `run.out` or `reply.md.log`): `out-of-usage`, and
  the Sol lane starts no review until 10 minutes after the reset Sol names (30 minutes if it
  names none). Ticket 09 does the rest of limit recovery.

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
- **Worktrees are removed by the script** (for ticket 05): the CLI has no command for it. Run
  `git -C <repo> worktree remove --force <worktreePath>`, then `git branch -D <branch>`. Checked
  live on 2026-11-09 (without `--force`, on a clean worktree): git unregistered the worktree and deleted its files, but exited 1 with
  "failed to delete '<path>': Permission denied" because T3 still holds the empty folder open.
  So treat a worktree gone from `git worktree list` as removed, and sweep empty folders under
  `~/.t3/worktrees/` later. About 30 minutes later, after the thread was settled (through T3's
  MCP `t3_thread_organize`), `rmdir` worked. Whether settling the thread or the time freed it
  is unknown. T3's own cleanup (Settings → storage: `worktreeOnMerge`, off by
  default; and on thread delete) is the alternative. It isn't used, because it would race the
  runner.
- **Settling a thread:** the CLI has no command for it (spec, Verify while building).

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
reviews that head for real once reviews post. It costs one Sol review (not gated).

## Tests

```
python3 -m unittest
```

Standard library only (Python 3.15 from scoop; `python3` is its shim). Tests never touch the
network: GitHub is the `GhCli` adapter in `queue_runner/github.py`, faked in tests with
`tests/fakes.py` (`FakeGitHub`) or with canned `gh api` JSON (`tests/test_github.py`). T3 is the
`T3Cli` adapter (`queue_runner/t3.py`), tested on output captured from the real CLI
(`tests/fixtures/t3/`), and faked with git in `tests/fakes_t3.py` for the run loop
(`tests/test_run.py`). The Sol lane is tested against `FakeGitHubForReviews`, `FakeReviewGit`
and `FakeSol` (`tests/test_review.py`); `decide()` and the marker formats in
`tests/test_ledger.py`; the codex-sol.sh adapter in `tests/test_sol.py`.

## Layout

- `queue_runner/picker.py`: which ticket is next: open, `ready-for-agent`, every blocker closed
  (GitHub's native dependencies, or `#N`, `owner/name#N` or issue URLs on a `Blocked by:` line or
  under a `## Blocked by` heading), not already in flight (a `claude/*-<issue>` branch, an open
  PR on one, or an open PR that closes it or that GitHub links to it by hand), not a spec with
  open sub-issues (its children are the work); lowest number first. The job branches `claude/<slug>-<issue>` from
  `origin/<base>`.
- `queue_runner/brief.py` and `templates/<kind>.md`: a job's brief, filled from the issue and the
  repo; no handoff files.
- `queue_runner/github.py`: the GitHub seam and its `gh api` adapter.
- `queue_runner/t3.py`: the T3 seam and its CLI adapter.
- `queue_runner/git.py`: local git around a job (fetch, leftover branch, the branch's commits)
  and a review's checkout (the PR's head, a detached worktree, diffs).
- `queue_runner/state.py`: the job log.
- `queue_runner/run.py`: the two lanes, a build job and the loop.
- `queue_runner/review.py` and `templates/review.md`: the Sol lane: adoption, the brief, a review.
- `queue_runner/ledger.py`: earlier reviews from a PR's comments, and `decide()`.
- `queue_runner/sol.py`: the Sol seam and its codex-sol.sh adapter.
- `queue_runner/lock.py`: `runner.lock` and `sol.lock`.
- `queue_runner/cli.py`: the command line.
- `scripts/live_sandbox.py` and `scripts/live_review.py`: the live checks.
