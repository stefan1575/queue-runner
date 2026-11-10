# 13: Cut over from the old script and the scheduled run

**What to build:** the runner takes over, per the spec's Cutover section, and the old machinery
stops:

- stop `~/sol-pr-review.py` and move `Sol PR review.lnk` from the Startup folder to
  `~/.claude/sol-pr-review/disabled-startup/`; fold each `held.json` into its PR's next step
  (never release a held session);
- delete T3 schedule `scheduled-task:6a9b68f4-5120-416f-9065-6ad295a34569` and the Windows task
  `T3 Code wake` (`~/t3-wake.ps1`);
- in leads-dashboard, rewrite `docs/agents/review-loop.md`, `AGENTS.md`'s review lines and
  `.claude/cloud/user-rules.md` ("the T3 Code orchestrator" → the runner; that file already has
  an uncommitted sending-rule change to keep), and retire
  `.scratch/leads-dashboard/briefs/orchestrator-daily.md` and
  `briefs/resume-opus-2026-11-06-0850/progress.md`, committing there per its own rules;
- change `~/.claude/docs/orchestration.md`'s Status line;
- drop 04's skip of the old labels, and put 10's shortcut in the Startup folder.

**Blocked by:** 06, 07, 09, 10, 11, 17 (Stefan merges leads-dashboard PRs himself from the cutover on)

**Status:** needs-info (2026-11-10: the rule-file wording below waits on Stefan's go)

- [ ] Recovery copies of every rule file edited go in personal-ops
      `.scratch/agent-instructions/<date>/` first (`~/.claude/CLAUDE.md`, Working notes).
- [x] Nothing from the old script is lost: each `held.json` and each open PR's state is accounted
      for in Comments.
- [x] The runner's first real cycle runs (a real review posted, or the frontier is empty and the
      log says so) and is noted in Comments.
- [ ] `~/.claude/docs/orchestration.md` and `sol.md` no longer describe the old script as running.

## Comments

**Done on 2026-11-10 (Claude, the implement thread):**

- **Code (1d60ec9):** the old script's labels (`needs-sol-review`, `sol-reviewed`) no longer hold a
  PR from review, fix rounds, stops, decisions or merging (`OLD_LABELS` is gone); AGENTS.md says so.
- **The old script** wasn't running (no process; its log's last line is 2026-11-06 20:26, a TLS
  timeout). `Sol PR review.lnk` moved from the Startup folder to
  `~/.claude/sol-pr-review/disabled-startup/`. `hold-claude` is left in place (harmless now, and it
  keeps the script from sending anything if someone starts it by hand).
- **Windows tasks:** `T3 Code wake` deleted, and `Queue runner resume wake 2026-11-09` too (a
  one-off from an earlier session, past, running the same `~/t3-wake.ps1`). Both exported first,
  with a copy of `t3-wake.ps1`, to `~/.queue-runner/cutover-2026-11-10/`
  (`Register-ScheduledTask -Xml (Get-Content ... -Raw) -TaskName ...` restores one).
- **T3 schedule** `scheduled-task:6a9b68f4-...` ("leads-dashboard queue: daily orchestrator run",
  paused) deleted. The two other T3 schedules (personal-ops) are past one-offs; left.
- **Startup:** `Queue runner.lnk` copied in; the runner was started from it (pid 3624, 16:56).

**Nothing lost from the old script:** no `held.json` exists anywhere under
`~/.claude/sol-pr-review/runs/` (searched), so nothing is held to fold in. Each open
leads-dashboard PR at the cutover:

| PR | Head | State | Its next step |
| --- | --- | --- | --- |
| #151 | 59f662b | old script's review 2, `stop` (repeated class), messaged a fork session 2026-11-06 | Stefan's: the runner leaves a head reviewed by someone else alone |
| #152 | 05b93b8 | review 1 blocking (old-script format, Stefan's session) | Stefan's session (ticket 05's note) |
| #153 | e6517b8 | never reviewed; conflicts with main | runner filed a `conflict` stop: #176 |
| #154 | 0cb8323 | never reviewed; conflicts with main | runner filed a `conflict` stop: #177 |
| #162 | 2d3d4a7 | review 1 blocking (Stefan's session) | Stefan's session |
| #163 | ff00ba1 | review 1 blocking (Stefan's session) | Stefan's session |
| #168 | 6e0c496 | review 1 blocking (a T3 child's `sol-review` marker) | Stefan's session |
| #173 | 1fa3cb8 | runner's review 1 (on a2326af) blocking, then pushed | runner reviews 1fa3cb8 (review 2) |

**For Stefan (needs-info):**

1. **Approve the rule-file wording below** (box 4 and box 1 wait on it: I edit no rule file outside
   this repo). Once you say go, recovery copies go to personal-ops
   `.scratch/agent-instructions/2026-11-10/` first.
2. **#151, #152, #162, #163, #168 sit outside the runner.** Their newest review isn't the
   runner's, so it gives them no fix round, and adoption skips a head that already has a review.
   Ticket 05 said they stay with your sessions; with the orchestrator retired, nothing moves them
   unless you do. If you'd rather the runner take them, the smallest change is: a non-runner
   blocking review on H counts as the runner's for fix rounds (`fix`, or `approach-note` from
   review 3), and a non-runner `stop` (#151) is filed as a stop for you. Say which.
3. **T3 Code doesn't start at logon** (not in the Startup folder or `HKCU\...\Run`). The deleted
   `t3-wake.ps1` used to open it at 09:00. After a reboot the runner waits for T3's server until
   you open it. Adding T3 Code to Startup would close that; say if you want it.
4. **The `## Review` table's merge and live-Check rows:** the orchestrator wrote them; the runner
   doesn't (it posts a **Live.** comment after its live thread instead). The drafts below say so. If you
   want the rows back, that's a runner ticket.

**Drafts (exact wording):**

1. `~/.claude/docs/orchestration.md`, replace the Status paragraph ("**Status (2026-11-07): being
   built** ... (last section).") with:

   > **Status (2026-11-10): running.** The runner starts at logon from the Startup folder; it was
   > first started by hand on 2026-11-10 and took over from `~/sol-pr-review.py` and the T3 Code orchestrator (queue-runner
   > ticket 13). Its own rules are in `~/Code/Personal/queue-runner/AGENTS.md`. Stefan's own
   > sessions work as before (last section).

   and in `## The runner`, replace "`~/Code/Personal/queue-runner` (local git only, never
   GitHub)" with "`~/Code/Personal/queue-runner` (private GitHub `stefan1575/queue-runner`)".

2. `~/.claude/docs/sol.md`, `## PR review`, replace the "**`~/sol-pr-review.py` is retired**"
   paragraph with:

   > **`~/sol-pr-review.py` is retired** (2026-11-06) **and stopped** (2026-11-10, queue-runner
   > ticket 13): `Sol PR review.lnk` is in `~/.claude/sol-pr-review/disabled-startup/`, and its
   > labels mean nothing. Don't restart it, cloud sessions included: the queue runner reviews
   > every PR.

3. leads-dashboard `docs/agents/review-loop.md`: the whole file as
   `.scratch/queue-runner/drafts/13-review-loop.md` (in this repo; `diff` it against the live
   one). It also takes in ticket 17's draft 3 (Ready for Stefan).

4. leads-dashboard `AGENTS.md`, `## Pull requests`: replace "run by the T3 Code orchestrator on
   Stefan's PC" with "run by the queue runner on Stefan's PC", and replace "and the orchestrator
   the merge and the Check on `main` as the last rows." with "and the runner posts a **Live.**
   comment once its live thread has finished the live steps after Stefan merges."

5. leads-dashboard `.claude/cloud/user-rules.md` (keeping its uncommitted sending-rule change):
   - under `## Review: Sol, from Stefan's PC`, replace "the T3 Code orchestrator there adopts every
     PR without a clean review, runs the fix rounds and merges (Stefan, 2026-11-07)" with "the
     queue runner there adopts every PR without a clean review and runs the fix rounds (Stefan,
     2026-11-07; the runner since 2026-11-10)";
   - replace the "**Merges happen on Stefan's PC**" bullet's body with: "Stefan merges a PR once
     the queue runner has labelled it `ready-for-stefan` (its review clean on the newest commit,
     its checks passed). This session opens the PR and stops, and never merges."

6. leads-dashboard: delete `.scratch/leads-dashboard/briefs/orchestrator-daily.md` (its schedule
   is gone) and `briefs/resume-opus-2026-11-06-0850/progress.md` (a settled handoff), committed
   there per its own rules with the four edits above, in one commit: "The queue runner runs the
   review loop (queue-runner ticket 13); the orchestrator's briefs retire".

**First real cycle (2026-11-10 16:56-16:59):** the runner started from the Startup shortcut
(pid 3624), recorded leads-dashboard's first sight (everything up to `ff58c6d` on main counts as
live), filed `conflict` stops on #153 (#176) and #154 (#177), started build #109 (the usage gate:
5 hours 23% used, the week 35%), and Sol's review 2 of #173 on `1fa3cb8` posted
(https://github.com/RoyalBullyAgency-RBA/leads-dashboard/pull/173#issuecomment-6763253661):
blocking, next a fix round, which follows once the #109 build ends (one Claude job at a time).
#109's 2026-11-04 hold comment is out of date: both blockers it names (#108, #126) are closed.

**Sol review (2026-11-10, eba92e7..92f8c3a):** no regression found in the label removal (399 tests
pass). Three Important findings, all on the drafts, all fixed: the review-loop draft now names the
exception (a head whose newest review isn't the runner's stays with Stefan), says the runner, not
Sol or the live thread, posts issues and **Live.** comments, and gives the two-failed-reviews
limit and `--release` apart from Sol's usage resets. Nits taken: the Status draft no longer says
the runner started at logon (it was started by hand), and a stops test lost "the old script" from
its name. No second review (the fixes are wording).
