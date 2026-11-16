# 39: The runner's Claude jobs run at effort high

**What to build:** every Claude job the runner starts (a build, a fix or conflict round, a
decision, a live run) runs at Opus 5.5 with effort `high`, and the runner can show that it did.

**Blocked by:** None (can start immediately)

**Status:** done (2026-11-15)

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

- [x] The way that works is written in AGENTS.md (T3, as a script sees it, points to its own
      section, The effort), with how it was checked.
- [x] `config.toml`'s `[claude]` names the effort, and the runner applies it to every Claude
      job it starts, in every served repo (once Stefan sets each project's default: Comments).
- [x] A job's end record carries the effort its run used, read back from T3, so a wrong effort
      is seen and not assumed.
- [x] If a job ran at another effort than the config's, the log says so once per repo.
- [x] If no way exists, nothing is changed, and the ticket's Comments say what was tried. (A
      way exists: not needed.)

## Comments

- 2026-11-15 (built on `dash/39-claude-jobs-at-high`). **What sets the effort:** the T3
  project's default model, and only when the thread is started with no `--provider`/`--model`.
  With `--model`, `t3 thread start` sends `t3_thread_launch` a selection with no options, so the
  run gets the model's default (medium). With neither, launch takes the project's default with
  its options. But T3's settings are folded, so "the project's default" is its entry in
  `~/.t3/userdata/settings.json`'s `projectSettingsOverrides`, which T3's Settings page writes
  for a chosen project; the project row (`t3_project_update`, and where personal-ops' "Opus 5.5
  at high" is) is not read. Evidence and the three live checks: AGENTS.md, The effort.
- **Applied:** the runner starts a repo's job with no `--model` only when that override is the
  config's model at its effort with no fallback model; else with `--model`, as before, and it
  says so at start with the step. Every end record has `effort`, read from Claude Code's
  transcript (else T3's run record). Today none of the three served projects is set, so the
  runner says so for each, and its jobs run at medium until Stefan sets them (AGENTS.md, The
  effort, Stefan's step). The override path itself wasn't set live (no T3 tool writes it, and
  `settings.json` is T3's global settings): the first job after Stefan's step confirms it in
  its end record.
- The sandbox project's own row default was left at Haiku, effort high (from live check B).
