# 33: The order repos are built in, from the page

**What to build:** Stefan reorders the repos on the page, and the runner takes its next job
from them in that order.

**Blocked by:** 30

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. `control.json`'s `repo_order` is already written by the page
(`dashboard/serve.py`, `apply_control`).

- [ ] Both lanes go through the repos in `repo_order` when it names every served repo exactly
      once. Anything else is ignored and said once in the log; `config.toml`'s order is the
      default.
- [ ] The snapshot's `repos`, the features' order and each lane's `queue` follow it, and
      `control_read_at` moves when it's taken up.
- [ ] A job that is running is not interrupted by a new order.
- [ ] `--once --dry-run` uses it too.

## Comments
