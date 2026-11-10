# Spec: the queue runner

Status: ready-for-agent
Written 2026-11-07 from a grilling with Stefan (T3 thread "Mechanical Timer Without Repeated AI
Calls"). The rules it serves are already written: `~/.claude/docs/orchestration.md` (the design),
`~/.claude/docs/pr-review.md` (the review loop), `~/.claude/docs/sol.md` (Sol). Read those first;
this file adds the why, the facts found, and what the build must verify.

## Problem

Stefan is on Claude's $20 plan. The T3-default orchestration spends Claude on waiting: a daily
scheduled thread that often only says "not yet" (~35–50k input-token equivalents a run), PR
watches that wake the orchestrator for every check and comment, and resuming big threads after
their prompt cache has expired (~2× the thread's size before it does anything). Meanwhile Stefan
opens every thread by hand (`/to-spec`, `/to-tickets`, `/implement`, review, fix, merge).

## Solution

A script with no AI in it runs the fixed flow and starts fresh T3 threads only for work that
needs Claude or Sol. Its decisions, settled in the grilling:

1. **No AI waits.** No scheduled runs, PR watches or self-wakes. The runner polls GitHub and
   files (free) and blocks on `t3 thread start --wait`.
2. **Scope:** waits, the whole review loop (Sol review on exact head H, verdict from the
   `sol-findings` ledger, stops, merge with expected head), starting builds and fix rounds, and
   live steps. Code repos first; non-code repos where the same flow fits.
3. **Picking:** `ready-for-agent` issues whose `Blocked by:` are all closed, lowest first. A case
   the flow doesn't cover → a one-off Claude decision thread with one narrow question, answering
   in a fixed JSON the runner acts on, or a `needs-info` stop.
4. **Briefs built from sources, no handoff files:** a template per job kind filled from the
   issue, branch, PR ledger and T3 thread state. `progress.md` and `notes.md` are retired. Jobs
   commit after every step, with the decision in the commit message.
5. **Limit recovery:** reset time from T3 (fallback 5h05m) + 10 min; then settle the old thread
   and start fresh with its link and last 3 messages; continue in place only if the old thread is
   ≤ ~50k tokens. Sol restarts fresh on the same commit. T3's auto-resume stays off.
6. **Gating:** don't start a Claude job whose predicted cost exceeds what's left of the 5-hour
   window; wait for the reset. Weekly: keep 5% for Stefan until 24h before the weekly reset. A
   knob for Stefan: change the reserve, pause, resume. Sol isn't gated.
7. **Concurrency:** one Claude job and one Sol job at a time.
8. **Worktrees:** each Claude job in its own T3 worktree; builds `claude/<slug>-<issue>` from
   `origin/main`; fix rounds from the PR head, pushing to its branch; removed after merge.
9. **Live steps** (leads-dashboard: Lovable connector `deploy_project`, `query_database` for
   migrations, then `npm run check:live-schema`): one Claude thread per batch, once no other merge
   is about to land. Cost over speed.
10. **Notifications:** T3 "Thread notifications" → Notifications only (if it can't be limited to
    threads that need Stefan, leave it off and toast from the runner). Runner stops: a native
    Windows toast under the runner's own name and icon, not PowerShell; click opens the
    `needs-info` issue. Claude Code's own pushes stay at defaults.
11. **Sleep:** a one-off Windows wake task per resume time; keep-awake hooks hold the PC during
    jobs. Delete the daily `T3 Code wake` task.
12. **GitHub posts:** automated posts in the repo's own PRs and issues need no go-ahead; messages
    to people do (`~/.claude/CLAUDE.md`).

## Facts found (2026-11-07)

- **T3 CLI:** `~/.t3/bin/t3.cmd` (T3 server 0.1.5 on `127.0.0.1:3773`). `thread start [--title]
  [--provider] [--model] [--worktree <base>] [--branch] [--wait] [--json] <project> <message|->`;
  `--wait` exits 1 on a failed run, 2 when the agent waits for an answer. `thread send <id>`,
  `thread show <id> [--messages N] --json`, `thread list --project <path> --json` (status,
  `settled`, `link`, `latestRunId`, model). No flag for reasoning effort.
- **T3 stores a usage-limit stop with its reset time** (`usage-limit-recovery:<runId>`,
  `resetAt`). Its own "Resume after usage limits" (`autoResumeLimitedThreads`, off) sends
  "Continue where you left off." to the same thread; "Snooze until limits reset" is off too.
- **T3 reads Claude's plan windows** from `https://api.anthropic.com/api/oauth/usage` with the
  Claude login (windows `five_hour`/`seven_day` with used percent and reset). Sol's are in the
  Codex rollout's newest `rate_limits` record (`sol.md`, Gotchas); `audit/sol_wait.py` parses them.
- **T3 thread notifications:** `notificationMode` in `~/.t3/userdata/client-settings.json`, now
  `off`; modes `off`, `notifications`, `sound`, `notifications-and-sound`. It's a native
  notification when T3 isn't focused; click opens the thread.
- **Measured token costs** are in `orchestration.md`. A fresh thread's first call was 33k (17k
  cache read, 16k cache write); this grilling session ran 37 calls, 2.44M cache read, 139k cache
  write, 25k output.
- **Prior art:** `~/sol-pr-review.py` (label loop: `decide()`, markers, the review comment format,
  out-of-usage wait file), personal-ops `.scratch/resume/audit/run.sh` (detached Sol driver with
  limit and capacity retries). Reuse what fits; the new runner has no labels and no session forks.

## Verify while building

- A Sol thread from `t3 thread start --provider codex --model gpt-6.1-sol` runs at effort
  `high` (read its rollout's settings). If not, start Sol through `~/codex-sol.sh`.
- What `thread show --json` gives for a usage-limit stop (status, error, `resetAt`), for Claude
  and for Codex. Can't be triggered on demand: read T3's code, then confirm on the first real stop.
- Whether T3 can toast only for threads that need input.
- How a script settles a thread (the CLI has no settle command; T3's API or leave it).
- How to read a Claude thread's context size (its transcript's last usage record).

## Cutover (when the runner works)

- Stop `~/sol-pr-review.py`, move `Sol PR review.lnk` to `~/.claude/sol-pr-review/disabled-startup/`,
  fold each `held.json` into its PR's next step (never release a held session).
- Delete T3 schedule `scheduled-task:6a9b68f4-5120-416f-9065-6ad295a34569` (paused 2026-11-07)
  and the Windows task `T3 Code wake` (`~/t3-wake.ps1`).
- leads-dashboard: rewrite `docs/agents/review-loop.md`, `AGENTS.md`'s review lines and
  `.claude/cloud/user-rules.md` ("the T3 Code orchestrator" → the runner) to match; retire
  `.scratch/leads-dashboard/briefs/orchestrator-daily.md` and
  `briefs/resume-opus-2026-11-06-0850/progress.md`. Commit there per its own rules. The cloud
  copy already has an uncommitted sending-rule change (with its 2026-11-07 exception).
- Change `orchestration.md`'s Status line once the runner runs.

## Out of scope

- `/to-spec` and `/to-tickets` stay Stefan's sessions.
- Buying usage, overage, or moving Claude work to other models.

## Comments
