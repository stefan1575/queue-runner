# 14: Serve queue-runner from GitHub

**What to build:** the runner serves its own repo, `stefan1575/queue-runner`, like leads-dashboard:
GitHub issues, PRs, Sol reviews, and merging itself when the review is clean (Stefan,
2026-11-10: queue-runner keeps going without him).

- add the repo to `config.toml` after leads-dashboard;
- a GitHub Actions check that runs the tests, so "checks passed on the newest commit" means
  something here;
- after it merges into itself, the runner restarts on the new code; if the new code won't
  start, toast Stefan (it can't fix itself);
- drop ticket 12's leftovers: the comments in `config.toml` and `run.py` that say the
  no-remote flow waits on Stefan.

**Blocked by:** None

**Status:** done (2026-11-10: built and landed; boxes 1 and 2 wait on the runner's first real cycle in its own repo, issue #1: see Comments)

- [ ] One real PR in queue-runner goes through build, Sol review and merge, noted in Comments.
- [ ] A merge into queue-runner restarts the runner, and the restart is in the log.
- [x] A runner that fails to start after its own merge toasts; checked once with a broken stub.

## Comments

**2026-11-10, Claude (build, branch `claude/ticket-14`):** built.

- `config.toml` serves `stefan1575/queue-runner` after leads-dashboard, merged by the runner.
- `.github/workflows/tests.yml` runs `python -m unittest` on Windows (Python 3.15) on every PR and
  on main; its check run is what the merge re-check and adoption wait for.
- `queue_runner/restart.py`: between Claude jobs, the loop fetches the runner's own checkout's
  `main`; when `origin/main` is ahead and fast-forwards, it lets the Sol lane finish its pass,
  fast-forwards the checkout, lets go of the lock and starts the same command again, and waits
  for the new runner to take the lock and stay up 20 seconds. **Mechanics I chose:** any push to
  main triggers it, not only the runner's own merges, so the checkout never lags what's merged
  (Stefan's sessions that push to main no longer need to restart it by hand; doing so anyway is
  harmless). A checkout on another branch, with its own commits, or that git won't update is
  left alone, said once in the log, and the old code carries on.
- New code that won't start toasts "Queue runner didn't restart" with its last error line and
  the old runner exits 1. **Checked once with a broken stub** (`scripts/live_restart.py`, a
  clone whose `cli.py` won't parse): `Restart on 4ca683f: the new code failed to start:
  SyntaxError: invalid syntax`, and the toast went out.
- Ticket 12's leftovers are gone from `config.toml`, `run.py`, `cli.py` and AGENTS.md.

**Sol's review** (one, of `23a2c9f..f2980df`): blocking, two Important findings, both fixed in
`54fa35b`: a checkout switched to another branch while the Sol lane finished was fast-forwarded
on that branch (the branch is now checked again just before updating), and a restart whose
process couldn't be created exited without a toast (it now toasts). No nits.

**Set up for the real cycle (boxes 1 and 2), not waited for:** labels `ready-for-agent`,
`needs-info`, `needs-triage` and `ready-for-human` made in stefan1575/queue-runner, and
[issue #1](https://github.com/stefan1575/queue-runner/issues/1) filed, `ready-for-agent`: add a
README that points to AGENTS.md. Once leads-dashboard has nothing pickable, the runner builds it,
the `tests` check runs on the PR, Sol reviews it, and a clean review merges. What to look for in
`~/.queue-runner/logs/runner.log`:
1. `merge queue-runner#<PR>: merged at <H7>` (box 1: tick it, with the PR's number);
2. then `The runner's own code moved: restarting on the new code...`, `runner restarted on
   <sha7> (pid N)` and the new `runner started (pid N)` (box 2).
If the first GitHub Actions run fails on Windows for an environment reason (not a test), the PR
waits at `failed-check` with a stop filed; fix the workflow on main.

**Draft for `~/.claude/docs/orchestration.md`** (not edited; for Stefan to approve), after the
first bullet of "The runner":

> - **It serves:** leads-dashboard (Stefan merges its PRs) and its own repo, queue-runner, whose
>   clean PRs it merges itself. When queue-runner's `main` moves, it updates its checkout and
>   restarts on the new code between jobs; if the new code won't start, it toasts. A session
>   that pushes to queue-runner's `main` needn't restart it.
