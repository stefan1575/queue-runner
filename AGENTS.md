# Queue runner

A script with no AI in it that runs Stefan's build-and-review flow: it picks the next ticket,
keeps the review loop moving, merges clean PRs, and starts T3 Code threads for the work that
needs an agent. The flow's rules live outside this repo: `~/Code/docs/orchestration.md`,
`~/Code/docs/pr-review.md` and `~/Code/docs/sol.md`.

**On GitHub as the private `stefan1575/queue-runner`**, with GitHub issues as its tracker
(`docs/agents/issue-tracker.md`). Commit after every completed step, with a message that says
what changed and why. The runner serves this repo too: it reviews and merges its own PRs and
restarts on its new code once main moves (`docs/running.md`, Serving itself).

## Run it

```
python3 -m queue_runner --once --dry-run   # what it would start, post and merge; changes nothing
```

Every command and `config.toml`: `docs/running.md`, The command line. **`--once`, the bare
command and `--review` are real:** they start Claude threads and reviews, post on GitHub, merge
clean PRs and file stops. Never run them against a served repo to try something; use the live
checks (`docs/running.md`, Live check).

## Tests

```
python3 -m unittest
```

Standard library only. Tests never touch the network, GitHub, T3, Codex, the Task Scheduler or
the usage endpoint: each is an adapter, faked in tests. A test that makes a temp folder cleans
it up (`TemporaryDirectory` with `addCleanup`; `tests/test_no_temp_leftovers.py` fails a bare
`mkdtemp(`).

## Where to look

`docs/` has one file per area (running, usage, claude-lane, reviews, stops, t3, dashboard,
tests, layout). Read the one a task touches before changing it.
