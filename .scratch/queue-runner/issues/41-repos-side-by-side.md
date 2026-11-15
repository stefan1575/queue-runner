# 41: Repos run side by side, stopped and resumed instead of ordered

**What to build:** each served repo gets its own Claude job at the same time, so game-backdrop
and leads-dashboard move in parallel. The Build order card loses its up and down arrows and
keeps each repo's Stop and Resume.

**Blocked by:** 38, 39 (both change how a Claude job starts, in `run.py`)

**Status:** needs-triage

Raised by Stefan on 2026-11-15, on the Build order card: "instead of the build order priority,
I'm thinking of like pausing and resuming them instead, where they both run in parallel...
since they are both different repos."

## What changes underneath

Today there is one Claude job at a time across every repo (AGENTS.md, Two lanes: the Claude
lane blocks on `t3 thread start --wait`). The build order (ticket 33) only decides which repo
that one job comes from. Per-repo Stop and Resume already exist (ticket 37). So dropping the
order is small; running repos in parallel is the real work: the Claude lane becomes one worker
per working repo.

**The cost is usage.** Two jobs at once spend the 5-hour window about twice as fast. On
2026-11-15 four parallel builders took Claude's window to 100%. The gate has to count the
jobs already running before it starts another.

## Decided (mine, Stefan's to overturn)

- One Claude job per working repo at once; no cap beyond the usage gate.
- The gate starts a job only when its expected cost fits after the cost of every job still
  running (`gate.py`, `CostBook.expected`).
- When the gate has room for only one more job, it goes to the repo whose oldest ready work has
  waited longest, so neither repo starves. config.toml's order breaks a tie.
- The Sol lane stays one review at a time, taking the repos in turn. Reviews are short and
  ChatGPT isn't gated.
- `control.json`'s `repo_order` is no longer read or written. A file that still has it is
  read as before for its stops, and the order is ignored without a word.

## To settle with Stefan

- Is twice the burn on the 5-hour window acceptable, or should parallel jobs be capped at two?

- [ ] The Claude lane runs one job per working repo at once. A stopped repo (ticket 37) gets
      none. One writer per PR still holds.
- [ ] The gate counts running jobs' expected cost before starting another, and a limit cuts
      off each running job as it does one today (limit recovery, ticket 9).
- [ ] The Build order card becomes a "Repositories" card: each repo's Stop or Resume and what
      it is doing now. No arrows, no numbers. Settings loses its Build order card the same way.
- [ ] `POST /control` refuses `repo_order`. The snapshot's lanes show a job per repo.
- [ ] `--once --dry-run` lists the job each repo would start; `--gate` says how many could start.
- [ ] AGENTS.md: Two lanes, The build order (removed), Stopping one repo, The usage gate.

## Comments
