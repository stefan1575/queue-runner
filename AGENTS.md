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
python3 -m queue_runner --once                # one pass of each lane: at most one Claude job (a fix round or a build), merges, at most one Sol review
python3 -m queue_runner --once --dry-run      # print the next Claude job's brief (a fix round first), list what Sol would review and what would merge
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (a PR: retry its failed reviews, merges and fix round)
python3 -m queue_runner --review NAME#N       # Sol reviews that PR's head now, if adoption says it needs one
```

**`--once`, the bare command and `--review` start real Claude builds and fix rounds and real Sol
reviews** in the configured repos, **a review posts on GitHub** (its comment, the `sol-review`
status, follow-up issues and the PR body's Review row), and **a clean review merges**. Don't run
them against leads-dashboard to try something: use the live checks (below). `--dry-run` posts,
starts and merges nothing; it only fetches a PR's head into the runner's local ref to print a
fix brief.

In production it runs under `pythonw`, so it never needs a console: every subprocess runs with
no window. A lock on `<state_dir>/runner.lock` keeps a second runner out (exit 3); `--dry-run`,
`--release` and `--review` don't take it. Each Sol review holds `<state_dir>/sol.lock`, so
`--review` and the running lane never run two at once.

`config.toml` names the repos it serves (GitHub repo, local clone, base branch, and
`review_table` for a repo whose PR bodies keep a `## Review` table), in priority order; the runner's `state_dir` and `log_dir` (`~/.queue-runner/`, outside every served repo);
`runs_dir` and `checkouts_dir` for reviews; `poll_seconds`, the pause after a pass that started
nothing; `[claude]`, the T3 provider instance and model for Claude jobs; and `[sol]`,
`codex-sol.sh` and the Git bash that runs it. `--config <path>` reads another one.

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
   nothing: if its thread is gone for good, `--release` the issue.
2. **A fix round** (`fix.py`), before any build, so open PRs finish first. A PR gets one when
   the runner's own newest review of its head H is `blocking` (decide()'s `fix`; a stop or an
   approach note goes to Stefan) and that review is still the PR's newest review comment. PRs
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
3. **Pick and build** (`run.py`): the first repo with a pickable issue gets one build. The runner
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

**Fix job records** (kind `fix`, `issue` = the PR, `branch` = the PR's) add `sha` (H), `round`
and `head` (the PR's head afterwards, read from GitHub), with `commits` the ones it pushed
(`H..head`). Outcomes: `pushed` (exit 0, the head moved: Sol reviews the new head), `no-push`
(exit 0 at H: H was reviewed, so the PR waits for Stefan; ticket 06 files the stop), `failed`,
`waiting`, `branch-exists` and `not-started`, as for builds.

## A Sol pass

The review loop's rules are `~/.claude/docs/pr-review.md`; leads-dashboard's
`docs/agents/review-loop.md` and `REVIEW.md` define the words.

1. **Settle.** Under `sol.lock`, a review the log shows open was cut off with its runner: it
   counts as `failed`. An open merge is settled from GitHub: `merged` or `failed`.
2. **Merge** (`merge.Merger`, also right after a clean review is posted). A PR merges once the
   runner's own newest review of its head H is `clean` (a clean review that stops for Stefan is
   `stop`). Just before, it's read again: open, still at H (moved: nothing is tried, and Sol
   reviews the new head), not a draft, no Claude job writing to it, its newest review comment
   the clean one on H, checks passed on H (`sol-review` not counted), no conflict, nothing said
   on it since that review (bots, `*[bot]`, aside) and no unresolved review thread. Why not is
   logged once. Then `PUT pulls/<n>/merge` with `sha=H` and `merge_method=merge` (a merge
   commit; Lovable syncs main), so GitHub refuses with 409 if H moved in between: `head-moved`.
   Two failed merges on H leave it until a push or `--release`. After the merge the worktrees of
   the PR's build and fix jobs are removed with their local branches (`GitCli.remove_worktree`:
   gone from `git worktree list` counts, since T3 may hold the empty folder), and one that
   can't be is said. The repo's live steps (leads-dashboard: Lovable) are ticket 11's.
   **Merge job records** (kind `merge`): `sha` H, `head` the merge commit; outcomes `merged`,
   `head-moved`, `failed`.
3. **Adopt** (`Reviewer.why_not`): open PRs, lowest number first. A PR is left alone, and why is
   logged once, while it's labelled `needs-sol-review` or `sol-reviewed` (the old
   `~/sol-pr-review.py` reviews those until the cutover, ticket 13), while a build or fix job writes to its branch, once the runner reviewed its
   head H, after two failed reviews on H (until a push or `--release NAME#N`), while a review
   comment is on H already (any of the three formats below), while H's checks are running or
   none have reported (`sol-review` isn't counted), and when a check failed or it conflicts with
   its base (stops for Stefan: ticket 06 files them). GitHub failing on one PR skips only that
   PR.
4. **Review H.** Fetch `refs/pull/<n>/head` into `refs/queue-runner/pr<n>` and the PR's base
   (PRs stack: the base isn't always main); if the head moved since listing, `head-moved` and
   nothing counts. Sol reads a detached checkout at H under `checkouts_dir`, removed afterwards.
   Its inputs are in the run folder, `runs_dir/<repo>-pr<n>-r<K>-<time>/`: `change.diff` (review
   1, or after a force-push: the whole diff, `origin/<base>...H`; later: the change since the last
   reviewed commit) and `full.diff` (later reviews), `pr.md`, `issue-<k>.md` (`issue-<owner>_<name>-<k>.md` in another repo) for each issue it
   closes with its comments, `conversation.md` (comments, review threads, review bodies, earlier
   ledgers). `brief.md` (`templates/review.md`) lists them, points to `AGENTS.md`, has
   `REVIEW.md` in full and, from review 2, the open findings, the classes so far, the IDs used
   and the replies since the last review.
5. **Decide** (`ledger.py`, no I/O): the verdict and outcome come from the last `sol-findings`
   block in Sol's reply, never its prose. Clean when no Important finding is open; outcomes, in
   order: `stop` (a new Important finding in an earlier class, a closed finding reopened, a
   decline Sol kept), `approach-note` (blocking from review 3 on: there's no spend guard any
   more, so every blocking review from 3 comes to Stefan), `merge` (clean), `fix`. An Important
   finding without file, line and a scenario (or a cost and rule) counts as a nit; nits past five
   are dropped and named. No readable block: `failed`.
6. **Write.** `comment.md` (heading, Sol's prose with links made GitHub-relative, findings
   tables, notes, a visible `sol-findings` ledger of the PR's whole state, and the old script's
   hidden marker) and `decision.json` (verdict, outcome, signals, the `sol-review` status,
   follow-up issues).
7. **Post** (`post.GitHubPoster`; automated posts need no go-ahead, `~/.claude/CLAUDE.md`). In
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
`tests/test_ledger.py`; the codex-sol.sh adapter in `tests/test_sol.py`. Merging
(`tests/test_merge.py`) plays GitHub moving on through `FakeGitHubForReviews.now` (a PR's fields
now), `threads` and `push_before_merge`; fix rounds (`tests/test_fix.py`) run the real `Runner`
with a T3 fake whose thread pushes. `tests/test_git.py` runs `GitCli` on a real local repo in a
temp folder.

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
- `queue_runner/git.py`: local git around a job (fetch, leftover branch, the branch's commits),
  a review's checkout (the PR's head, a detached worktree, diffs), a fix brief's commits and
  files, and removing a job's worktree after its PR merged.
- `queue_runner/state.py`: the job log.
- `queue_runner/run.py`: the two lanes, a build job, a fix round's thread and the loop.
- `queue_runner/fix.py` and `templates/fix.md`: which PRs get a fix round, and its brief.
- `queue_runner/merge.py`: the pre-merge re-check, the expected-head merge and the worktrees
  removed after.
- `queue_runner/review.py` and `templates/review.md`: the Sol lane: adoption, the brief, a review.
- `queue_runner/ledger.py`: earlier reviews from a PR's comments, and `decide()`.
- `queue_runner/post.py`: posting a review: follow-up issues, the comment, `sol-review`, the
  PR body's Review row.
- `queue_runner/sol.py`: the Sol seam and its codex-sol.sh adapter.
- `queue_runner/lock.py`: `runner.lock` and `sol.lock`.
- `queue_runner/cli.py`: the command line.
- `scripts/live_sandbox.py`, `scripts/live_review.py`, `scripts/live_fix_brief.py` and
  `scripts/live_merge.py`: the live checks.
