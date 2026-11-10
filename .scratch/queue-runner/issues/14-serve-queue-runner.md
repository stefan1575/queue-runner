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

**Status:** ready-for-agent

- [ ] One real PR in queue-runner goes through build, Sol review and merge, noted in Comments.
- [ ] A merge into queue-runner restarts the runner, and the restart is in the log.
- [ ] A runner that fails to start after its own merge toasts; checked once with a broken stub.
