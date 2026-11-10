# 07: Decision threads for cases the flow doesn't cover

**What to build:** when the fixed flow can't say what to do next, the runner starts a one-off
Claude thread with one narrow question and the state it needs, and the thread answers in a fixed
JSON block the runner parses and acts on, or with a `needs-info` stop for Stefan (06). There is no
resident orchestrator. Uses to start with: review 3 still blocking (the thread writes and posts
the `## Approach note`, then the runner stops for Stefan's rework / fix on / hold); a human reply
on a PR; a build or fix thread that ended failed (exit 1) or waiting for an answer (exit 2); a
build that ended without a PR.

**Blocked by:** 06

**Status:** done (2026-11-10)

- [x] One answer schema, versioned, with a closed set of actions the runner knows (for example:
      retry with this added to the brief, start a fix round, stop for Stefan with this question,
      close as not needed); anything else is treated as a stop.
- [x] The brief is one question plus sources (issue, PR, ledger, the earlier thread's link and
      last 3 messages), kept small: a decision thread should cost about one fresh-thread call.
- [x] Parsing and each action are tested against fakes, including an unreadable answer (a stop).
- [x] Stefan's answer to an Approach note (rework, fix on, hold) is read from the PR or the
      `needs-info` issue and acted on; a fourth review never runs without it.

## Comments

**2026-11-10, built** in `~/Code/Personal/queue-runner`, commits `86f627e` and `55f016a` (the
code review's fixes). All tests pass (`python3 -m unittest`). The runner's `AGENTS.md` documents
it under "Decision threads". A live `--once --dry-run` against leads-dashboard ran clean (no
decision pending there now). No decision thread has run live yet.

What's there:
- **Answer:** a `queue-runner-decision` JSON block, `version: 1`. Each question allows only
  some actions: `retry`, `answer`, `fix`, `carry-on`, `hold`, `close`, `approach-note`, `stop`.
  Anything unreadable, or an action the question doesn't allow, is a stop that says why.
- **Approach note:** review 3+ still blocking → a thread writes the note, the runner posts it on
  the PR under `## Approach note` and files the `approach-note` stop linking it. No further review
  or fix round runs until that stop is answered.
- **Your answer:** a reply on the PR or the `needs-info` issue that starts with `rework`,
  `fix on` or `hold` is acted on with no thread. Any other reply goes to a decision thread.
- **Jobs that ended failed, waiting or without a PR:** `retry`/`answer` send the earlier thread
  a message and it carries on; `close` closes the issue as not planned; `stop` puts the question
  on the issue/PR. After 3 decisions on one issue or PR the next comes straight to you.

Mechanics I chose (one line each):
- **rework** = one more fix round on the same PR, told to rework the approach as the note and
  your reply say. **fix on** = one more fix round on the open findings. **hold** = left alone
  until `--release`. Closing the `needs-info` issue counts as "carry on".
- A thread waiting for an answer no longer toasts you straight away: the decision thread answers
  it if it's mechanics, and toasts you (opening the thread) only if it's yours.
- "A human reply on a PR" means a reply to a stop; replies outside a stop already reach the next
  Sol review's brief.
