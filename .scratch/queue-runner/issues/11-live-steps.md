# 11: Run the repo's live steps after merges

**What to build:** after merges in a repo with live steps that need an AI (leads-dashboard: the
Lovable connector's `deploy_project`, `query_database` for migrations, then
`npm run check:live-schema`; its `docs/agents/lovable-cloud.md`), the runner starts one Claude
thread per batch, once no other merge is about to land (no PR in that repo is clean and awaiting
its merge, and no review or fix is running on one), so chained migrations go live in order. Cost
over speed. Merged and live are reported separately.

**Blocked by:** 05

**Status:** done (2026-11-10)

- [x] The live brief is built from sources: the merges since the last live run (their PRs and
      migration files), the repo's live doc, and the last live thread's link.
- [x] "About to land" is decided by the runner from GitHub state and its own job records, tested
      against fakes.
- [x] The live thread answers in a fixed JSON (live, partial with what failed, or stop), and a
      failure becomes a `needs-info` stop (06).
- [x] Where the last live run reached is kept in the runner's state, so a restart doesn't redo or
      skip a migration.

## Comments

**Built, 2026-11-10** (queue-runner `d3c4694`, Sol's review fixed in `ca14670`, docs `0e0cbbf`).
`queue_runner/live.py`, `templates/live.md`, `tests/test_live.py`; AGENTS.md, Live steps. Mechanics
chosen: state in the job log (kind `live`: `sha` the reach, `head` the target, `applied`); the
batch from git first-parent subjects and `--name-status`; the thread in a T3 worktree at the
target (`.env` is tracked, so `check:live-schema` runs there); it may not ask Lovable in its chat
(credits), so changed edge functions come back under `stefan` as a `live-todo` stop that holds
nothing; `partial`, `stop` and unreadable answers file a `live` stop on the batch's newest PR that
holds the repo's live runs until answered or released; while a live run is open, nothing merges
in that repo. Gate cost default 20% / 5%. `config.toml` has `live_doc` on leads-dashboard.

**Sol's review** (one run, high): five Important findings, all fixed: first sight could be held
by an about-to-land PR and then swallow its merge; a batch could go stale while the Sol lane
merged alongside; a migration edited after a partial run applied it went unnoticed; a held clean
PR with pending checks held live runs; a live run's usage-limit set no wake. No nits.

**For the cutover (13):** on first sight the runner records `origin/main` as already live
(`assumed`), since the steps before it were Stefan's. Before its first real pass, confirm
leads-dashboard's live state matches `main` (the newest merges then were #166 and #167, with the
`callsling_fill_in*` and `callsling_sync_recent_cycle` migrations and a changed `callsling-sync`);
anything not live by then is Stefan's to finish by hand. No real live thread has run yet: the
first one is the live check, and its log line `live leads-dashboard: ... live at ...` (or the
`live` stop) should be read. Checked live: the brief built from real git and GitHub
(37f2be1..origin/main gave the six PRs, four migrations in order, `callsling-sync`), and
`--once --dry-run` against the real config.
