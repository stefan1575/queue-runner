# 37: Stop one repo

**What to build:** Stefan stops and resumes one repo from the page or the CLI, so the runner
works on the others and leaves that one alone.

**Blocked by:** 30

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. Pinned by Stefan on 2026-11-15, then unpinned the same day ("go
ahead... I think that's an important feature"): it is what lets game-backdrop be the
dashboard's first real run while leads-dashboard stays served.

## Why the build order isn't enough

The build order (ticket 33) only orders builds. The Claude lane takes a decision, a repo's live
steps and a fix round before any build, in any repo (`Runner.choose`, `queue_runner/run.py`).
With game-backdrop first and leads-dashboard still served, a dry run on 2026-11-15 chose
leads-dashboard's live steps for PR #209 (a production deploy) as the first job after Resume.

## Decided (mine, Stefan's to overturn)

- A stopped repo gets nothing from either lane: no build, fix or conflict round, decision or
  live run, no review, no merge, no ready mark and no stop filed.
- Its asks still show in the Inbox. Stopping the work doesn't answer them.
- Only "after its job": a job already running on the repo finishes. Stop now stays a lane's.
- The record is `control.json`, beside the lanes: `repos.<name>.stop` (`"after-job"` or null)
  with its time.

- [ ] `POST /control` takes `{"repo": <name>, "stop": "after-job" | null}`; `--pause NAME` and
      `--resume NAME` write the same file, where NAME is a served repo's name (a lane's id and
      `all` keep their meaning from ticket 30).
- [ ] Both lanes skip a stopped repo in everything they choose and do, and take the next
      repo's work. A job running on it when it's stopped finishes.
- [ ] **With leads-dashboard stopped and game-backdrop first, the Claude lane's first job is
      game-backdrop's build, not leads-dashboard's live steps.** Tested through the run loop.
- [ ] The snapshot's repo carries `stopped` (with when), and `control_read_at` moves when it's
      taken up. `--gate`, `--once --dry-run` and the log say which repos are stopped.
- [ ] On the page, each repo in the build order card has Stop and Resume, and a stopped repo
      reads as stopped wherever its work is listed. The sample shows one stopped repo in a
      state of its own.
- [ ] A stopped repo's asks stay in the Inbox, and its wake times set no wake task.
- [ ] A repo name in `control.json` that isn't served is ignored and said once.

## Comments
