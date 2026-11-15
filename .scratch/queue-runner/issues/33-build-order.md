# 33: The order repos are built in, from the page

**What to build:** Stefan reorders the repos on the page, and the runner takes its next job
from them in that order.

**Blocked by:** 30

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`. `control.json`'s `repo_order` is already written by the page
(`dashboard/serve.py`, `apply_control`).

- [x] Both lanes go through the repos in `repo_order` when it names every served repo exactly
      once. Anything else is ignored and said once in the log; `config.toml`'s order is the
      default.
- [x] The snapshot's `repos`, the features' order and each lane's `queue` follow it, and
      `control_read_at` moves when it's taken up.
- [x] A job that is running is not interrupted by a new order.
- [x] `--once --dry-run` uses it too.

## Comments

- 2026-11-15 (built): `control.ordered` judges the order, `Runner.take_order` takes it up at the
  start of each lane's pass and replaces `config.repos` (`config.set_build_order`), so every
  part that goes through the repos follows and a job already running goes on. An empty
  `repo_order` (what `--pause` writes with no order set) is config.toml's order, said nothing.
  The snapshot reads control.json once for the stops and the order, so `repos` and
  `control_read_at` move together. **The features and each lane's queue are still empty** (ticket
  32 fills them); `Facts.repos` comes in the build order and says that they go through it, so
  ticket 32 should build them from `facts.repos`, not `config.repos`. Checked by hand on
  `queue.localhost` against a temp state folder: the page's up and down buttons wrote
  `repo_order`, and the next snapshot showed it, with `control_read_at` its `written_at`.
