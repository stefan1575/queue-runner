# 09: Recover a job cut off by a usage limit

**What to build:** when a Claude or Sol job stops on a usage limit, the runner takes the reset time
T3 stored for the stop (5h05m from the stop if none), waits until 10 minutes after it, settles
the old thread, and starts a fresh one from the template brief plus the old thread's link and last
3 messages. It continues the old thread in place only when that thread is about 50k tokens or
less. Sol always restarts fresh on the same commit, reading its reset from the rollout's newest
`rate_limits` record (`~/.claude/docs/sol.md`, Gotchas; personal-ops
`.scratch/resume/audit/sol_wait.py` parses it). T3's "Resume after usage limits" stays off.

**Blocked by:** 03, 08

**Status:** done

- [x] Verify (spec): what `thread show --json` gives for a usage-limit stop (status, error,
      `resetAt`), for Claude and for Codex, read from T3's code since it can't be triggered on
      demand; tests use fixtures built from that. Note in Comments that the first real stop must
      confirm it.
- [x] Verify (spec): how a script settles a thread (CLI, T3's API, or leave it), and how to read a
      Claude thread's context size (its transcript's last usage record). Both recorded in
      `AGENTS.md`.
- [x] The resume decision (in place vs fresh) and the wait time are tested with fixed clocks.
- [x] The runner checks that T3's `autoResumeLimitedThreads` is off at start and logs a warning if
      it isn't, rather than racing it.

## Comments

- 2026-11-10, Claude: built in queue-runner `e9dd87a`, with Sol's review fixes in `262ab41`.
  - **`thread show --json` on a limit stop:** it shows the thread `failed` and Claude Code's
    message, but no reset time. The reset is only in T3's database, in the run's `error` turn
    item (`failure.class` `usage_limit`, `resetAt`), and the runner reads it there read-only.
    Codex: the runner runs Sol through codex-sol.sh, so no T3 Codex stop arises. Sol's reset
    comes from its rollout's newest `rate_limits` record. **The first real stop must confirm
    this**: the fixtures come from one real Claude stop on 2026-11-08, made before the runner.
  - **Settling a thread:** a script can't. The CLI has no command, and T3's `thread.settle` is
    reachable only through an MCP session minted in-process from T3's own auth. So the runner
    leaves the old thread unsettled.
  - **Context size:** T3's provider thread gives the Claude session id, which names the
    transcript. Its last real call's `usage` is the context. Both are recorded in queue-runner
    `AGENTS.md` (Usage limits; T3, as a script sees it).
  - **A fresh restart** stays on the same branch at the old thread's newest commit. It keeps
    anything uncommitted as a commit and removes the old worktree, because T3 makes the new one
    in the same folder.
  - **Sol review:** blocking with three Important findings, all fixed in `262ab41`:
    - R1: the old worktree folder collided with the new one.
    - R2: a failed restart dropped the PR's hold.
    - R3: an earlier run's limit message misread a later failure.
