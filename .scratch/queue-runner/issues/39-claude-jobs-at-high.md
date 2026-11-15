# 39: The runner's Claude jobs run at effort high

**What to build:** every Claude job the runner starts (a build, a fix or conflict round, a
decision, a live run) runs at Opus 5.5 with effort `high`, and the runner can show that it did.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Stefan, 2026-11-15: "keep it at high by default", until his Claude Max subscription ends
(`~/Code/wiki/plans-and-models.md`). Today they run at medium: T3's command line has no effort
flag, so a thread gets T3's default for the model (`config.toml`, `[claude]`).

## Find out first

- `t3 thread start --help` says `--model` "defaults to the project's default model". A T3
  project can hold a default model selection with options (personal-ops has Opus 5.5 with
  `effort: high`). Does a thread started from the command line take that selection's effort,
  with `--model` given and without it?
- Check on one throwaway Haiku thread in the sandbox project (`scripts/live_sandbox.py`'s
  project, never a served repo), and read the effort the run really used from T3's own record
  of it, as ticket 02 did for Sol (AGENTS.md, Sol as a script sees it).
- If the project default doesn't do it, read T3's code for what does, and say what you found.

- [ ] The way that works is written in AGENTS.md (T3, as a script sees it), with how it was
      checked.
- [ ] `config.toml`'s `[claude]` names the effort, and the runner applies it to every Claude
      job it starts, in every served repo.
- [ ] A job's end record carries the effort its run used, read back from T3, so a wrong effort
      is seen and not assumed.
- [ ] If a job ran at another effort than the config's, the log says so once per repo.
- [ ] If no way exists, nothing is changed, and the ticket's Comments say what was tried.

## Comments
