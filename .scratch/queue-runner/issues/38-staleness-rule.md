# 38: Continue a thread or start fresh, by how stale it is

**What to build:** whenever the runner is about to send more work to an existing Claude thread,
it continues that thread while its cache is still warm, and otherwise starts a fresh one with a
restart brief when the thread is large enough for that to be cheaper.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Stefan, 2026-11-15: "automatic stopping and resuming via creating a new session, dependent on
staleness... implement that as well." The research is
`C:\Users\Anon\Code\Personal\queue-runner\.scratch\queue-runner\research\token-economics.md`
(not committed: read it at that path, not in your worktree), with `subscription-economics.md`
and `in-place-vs-fresh.svg` beside it. Its recommendations 1 to 3 are the rule; its break-even
section is where the numbers come from.

## Today

- After a usage limit, a job continues in place only at about 50k tokens or less, else fresh
  (`limits.py`, `IN_PLACE_MAX`). The research found 50k is not an economic cliff.
- A decision's `retry` or `answer` always continues the old thread, whatever its size and
  however long ago it last ran (`Runner.continue_job`).
- Every build and fix round already starts as a fresh thread.

## Decided (mine, Stefan's to overturn)

- The runner has no AI, so "nearly finished" and "still coherent" can't be judged. The rule
  uses only what it can measure: when the thread's last request started, and its context size.
- **Warm:** the last request started less than 55 minutes ago. Continue in place, any size.
- **Cold:** continue in place below the size at which the research's break-even favours a
  fresh brief; at or above it, start fresh. State the number and where it comes from.
- Unknown age or size counts as cold and large: fresh, as an unknown size does today.
- One rule in one place, used by every caller.

- [ ] One function decides in place or fresh from the last request's start, the context size
      and now, with no I/O; its thresholds are named constants with the research cited.
- [ ] Limit recovery uses it in place of `IN_PLACE_MAX`.
- [ ] A decision's `retry` and `answer` use it. Fresh means the job's own brief rebuilt from
      its sources plus `templates/restart.md`, as limit recovery does, with the decision's
      text first; for an `answer`, the thread's question and the answer are in the brief.
- [ ] The last request's start is read where the context size already is (T3's database and
      Claude Code's transcript, `limits.T3Store`), read-only.
- [ ] The job's records say which was chosen and why (age, size), and the log line does too.
- [ ] The branch and anything uncommitted survive a fresh start, as they do today
      (`GitCli.free_branch`).
- [ ] AGENTS.md's Usage limits and Decision threads sections describe the rule.

## Comments
