# Queue runner

A script with no AI in it that runs Stefan's fixed build-and-review flow: it picks the next
ticket, merges clean PRs and keeps the review loop moving, and starts fresh T3 Code threads only
for work that needs Claude (builds, fix rounds, decisions) or Sol (reviews). The design and its
rules live outside this repo: `~/Code/docs/orchestration.md`, `~/Code/docs/pr-review.md` and
`~/Code/docs/sol.md`.

**The tracker is GitHub issues:** the spec is #8, the dashboard's runner side #9 (under ticket
18, #27), each ticket a sub-issue with native blocked-by links. They were local markdown in
`.scratch/queue-runner/` until 2026-11-16. **A ticket number in these docs or a commit is the
local one: ticket NN is issue #(NN+9)**, and #8 has the table. The tracker's conventions are
`docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

**On GitHub as the private `stefan1575/queue-runner`.** Commit after every completed step, with a
message that says what changed and why. The runner serves this repo too: it reviews and merges
its own PRs, and restarts on its new code once main moves (`docs/running.md`, Serving itself).

## Run it

```
python3 -m queue_runner                       # run: both lanes, pass after pass (unattended: docs/running.md)
python3 -m queue_runner --once                # one pass of each lane: at most one Claude job per working repo, merges, at most one review
python3 -m queue_runner --once --dry-run      # print each repo's next Claude job and its brief, the stops it would file, what it would review and merge
python3 -m queue_runner --release NAME#N      # let the picker take a held issue again (a PR: retry its failed reviews, merges and fix round; let a stopped PR go)
python3 -m queue_runner --review NAME#N       # review that PR's head now, if adoption says it needs one
python3 -m queue_runner --gate                # Claude's usage now, the Claude jobs running, and what would start
python3 -m queue_runner --pause | --resume [LANE|NAME]   # stop a lane (claude by default; sol, all) or one served repo after its job, or let it carry on
python3 -m queue_runner --reserve PERCENT     # the share of the week kept for Stefan (default 5)
python3 -m queue_runner --stop                # stop the running runner
python3 -m queue_runner --inbox               # everything waiting on Stefan
python3 -m queue_runner --snapshot            # print the dashboard's snapshot (reads usage and GitHub once; writes nothing)
python3 -m dashboard                          # the dashboard: http://queue.localhost/ is the runner's, http://localhost:5289/ sample data
```

**`--once`, the bare command and `--review` start real Claude builds, fix rounds and decision
threads and real reviews** in the configured repos, **a review posts on GitHub** (its comment,
the `sol-review` status, follow-up issues and the PR body's Review row), **a clean review
merges**, and **a stop files a `needs-info` issue, comments on the PR and toasts**. Never run
them against leads-dashboard to try something: use the live checks (`docs/running.md`, Live
check). `--dry-run` posts, starts and merges nothing; it only fetches a PR's head into the
runner's local ref to print a fix brief.

`config.toml` names the served repos and the runner's folders and settings
(`docs/running.md`, The command line).

## Tests

```
python3 -m unittest
```

Standard library only (Python 3.15 from scoop; `python3` is its shim). Tests never touch the
network, GitHub, T3, Codex, the Task Scheduler or the real usage endpoint: each is an adapter,
faked in tests. A test that makes a temp folder cleans it up (`TemporaryDirectory` with
`addCleanup`; a bare `mkdtemp(` fails `tests/test_no_temp_leftovers.py`). CI runs the same
command on Windows on every PR and on main (`.github/workflows/tests.yml`). What each test file
covers: `docs/tests.md`.

## Where to look

Read the file for the area a task touches, before changing it:

- `docs/running.md`: the command line and `config.toml`, running unattended (logon, the log, wake
  tasks), restarting on its own code, stopping a lane or one repo, and the live checks.
- `docs/usage.md`: the usage gate before each Claude job, recovering from a usage limit (in place
  or fresh), and the effort Claude jobs run at.
- `docs/claude-lane.md`: the two lanes side by side, a Claude pass in order, the job log, fix and
  conflict rounds, decision threads, ask threads, live steps, repos Stefan merges, local tickets.
- `docs/reviews.md`: a Sol pass (adopt, review, decide, post, merge), Sol through codex-sol.sh,
  the Opus reviewer (fallback, or set in `config.toml`), and Sol running tests.
- `docs/stops.md`: stops for Stefan (main's own failure, a failed check's re-run, toasts), and
  settling, prefixing and refreshing the T3 threads the runner started.
- `docs/t3.md`: T3 Code's CLI, worktrees and database, as the runner reads them.
- `docs/dashboard.md`: the dashboard, its snapshot and control files, and each page (under
  review: Stefan is regrilling its pages).
- `docs/tests.md`: what each test file covers, and the fakes.
- `docs/layout.md`: what each module, template and script is for.
