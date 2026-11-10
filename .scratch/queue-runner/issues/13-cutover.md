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

**Blocked by:** 06, 07, 09, 10, 11

**Status:** ready-for-agent

- [ ] Recovery copies of every rule file edited go in personal-ops
      `.scratch/agent-instructions/<date>/` first (`~/.claude/CLAUDE.md`, Working notes).
- [ ] Nothing from the old script is lost: each `held.json` and each open PR's state is accounted
      for in Comments.
- [ ] The runner's first real cycle runs (a real review posted, or the frontier is empty and the
      log says so) and is noted in Comments.
- [ ] `~/.claude/docs/orchestration.md` and `sol.md` no longer describe the old script as running.
