# 02: Start a build job in a T3 worktree and record its outcome

**What to build:** the runner starts the picked build for real: a fresh T3 Claude thread through
`~/.t3/bin/t3.cmd thread start --wait --json` in its own T3 worktree, branch
`claude/<slug>-<issue>` from `origin/main`, with the brief from 01. Its process blocks on `--wait`
(no AI waits), then records the outcome: thread id and link, exit code (0 done, 1 failed run,
2 the agent is waiting for an answer), the branch's commits and the PR opened from it, if any. At
most one Claude job runs at a time. The run loop exists from here on (`--once` and a continuous
mode), though nothing starts it at logon yet.

**Blocked by:** 01

**Status:** done (2026-11-09)

- [x] A T3 adapter wraps `thread start|send|show|list` and parses their `--json`; its parsing is
      tested on JSON captured from the real CLI (saved as fixtures).
- [x] A job record per run (kind, repo, issue/PR, thread, start and end, exit code, outcome) is
      appended to the runner's state, so a restarted runner knows what ran and what's open.
- [x] Exit 1 and exit 2 don't loop: the job is recorded as failed or waiting and its issue isn't
      picked again until handled (decision threads come in 07; until then it's logged and left).
- [x] Verified live once, cheaply: a sandbox git repo (a local bare repo as `origin` is enough),
      a trivial ticket ("add a line to README and commit"), a real T3 thread in a worktree; the
      record and the commit on the branch are checked and noted in Comments. No leads-dashboard
      build is started by this ticket.
- [x] Records how T3 worktrees are made and removed from a script (CLI flag, API, or `git
      worktree`), for 05 to use; noted in the runner's `AGENTS.md`.

## Comments

**2026-11-09, built** in `~/Code/Personal/queue-runner`, commits `aa66d15` to `78dd607`. There
are 76 tests and all pass (`python3 -m unittest`). Sol reviewed it three times at effort high.
Review 1 was blocking: three Important findings and one Nit. Review 2 was blocking: two of
those were fixed only in part. Review 3 was clean on `ff70cd6`. The commit after that only adds
a line to `AGENTS.md`. The first attempt's thread was settled; its fixture threads were reused
or settled.

What's there: `t3.py` (the adapter, tested on real CLI output in `tests/fixtures/t3/`),
`state.py` (the job log), `run.py` (the pass, a build, the loop, the lock) and `git.py`.
`python3 -m queue_runner` runs pass after pass; `--once` runs one pass; `--release NAME#N` frees a
held issue. `AGENTS.md` in the runner repo covers the rest.

Decisions (mechanics):
- **The job log** is `~/.queue-runner/state/jobs.jsonl`, append-only: `start`, `end` and
  `release` events. The start record is written and synced to disk before `t3` blocks. So a
  runner that dies mid-job finds the job open on restart, and finds its thread by title
  (`Queue runner build: <repo>#<n>`). A record torn by a crash is dropped.
- **Outcomes:** `done` (exit 0, with a PR), `done-no-pr`, `failed` (exit 1), `waiting` (exit 2),
  `branch-exists` (a leftover local `claude/*` branch, which T3's `git worktree add -b` would trip
  on) and `not-started` (T3 failed before any thread existed). Every outcome but `not-started`
  holds the issue, so the picker skips it until `--release`; decision threads (07) take over
  later. `not-started` is retried after `poll_seconds`, at no token cost.
- **One Claude job at a time:** the pass blocks on `--wait`, and a byte lock on
  `runner.lock` keeps a second runner out (exit 3). A thread from a dead runner that's still
  running, a waiting thread that's running again, or one T3 can't read means the pass starts
  nothing.
- **A waiting job is settled later:** if Stefan answers it in T3 and it completes, the next pass
  records it done, with commits and PR.
- **Exit 1 has two meanings** in T3's CLI: a run that ended badly (JSON on stdout) or T3 itself
  failing (nothing on stdout). Exit 2 couldn't be produced live: T3 offers no AskUserQuestion,
  and full-access threads ask for no approvals. Its fixture is built from T3's own code
  (`finishRun`).
- **Worktrees, for 05:** T3 makes them (`--worktree origin/<base> --branch <name>`, under
  `~/.t3/worktrees/<project folder>/`). T3 doesn't fetch first, so the runner fetches. The CLI
  can't remove them: `git worktree remove` unregisters the worktree and deletes its files, but
  T3 held the empty folder open until about 30 minutes later, after its thread was settled. All
  in the runner's `AGENTS.md`.

**For Stefan (not blocking this ticket):** T3's CLI has no flag for reasoning effort, so
runner-started Claude builds run at T3's default effort for Opus, not `high`. T3 sets effort
through session options, and only `ultrathink` goes into the prompt. Raising it needs a CLI flag
in T3, or a different way to start threads. The open question in the spec about Sol's effort
under `t3 thread start` is the same gap.

**Live check, 2026-11-09:** `python3 scripts/live_sandbox.py` ran one real build through
`Runner.run_build`, on Haiku, with the hand-made issue "Add a line to README". It ran in the
sandbox `~/.queue-runner/sandbox/repo` (T3 project "queue-runner sandbox", with a bare `origin`).
No leads-dashboard build was started. The record:

~~~~text
Starting build sandbox#1 on claude/add-a-line-to-1 from origin/main
build sandbox#1 ended: done (exit 0, 1 commits) https://app.t3.codes/threads/264b77bb-5ec7-4453-8ee5-7d0162886008/mcp%3A013dfad4-f504-4a7f-b047-354705769379
{
  "id": "20261109-191825-build-sandbox-1-b569e8",
  "kind": "build", "repo": "sandbox", "issue": 1, "branch": "claude/add-a-line-to-1",
  "title": "Queue runner build: sandbox#1",
  "started_at": "2026-11-09T19:18:25+08:00", "ended_at": "2026-11-09T19:18:52+08:00",
  "thread_id": "mcp:013dfad4-f504-4a7f-b047-354705769379",
  "exit_code": 0, "status": "completed", "outcome": "done",
  "commits": [{"sha": "0356926c0b7197a3e0f69a706bdef90854d3bb9c", "subject": "Add a line to README"}],
  "pr": null,
  "worktree": "C:\\Users\\Anon\\.t3\\worktrees\\repo\\claude-add-a-line-to-1",
  "error": null
}
~~~~

Checked by hand afterwards: `0356926 Add a line to README` was on `claude/add-a-line-to-1` in
that worktree, its `README.md` ended with the line, and the branch was in `origin.git`. A rerun
was held as `branch-exists`, with no thread started. The branch was then deleted on both sides,
and the worktree removed.
