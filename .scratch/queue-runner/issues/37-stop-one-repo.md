# 37: Stop one repo

**What to decide and build:** Stefan stops and resumes one repo from the page, so the runner
works on the others and leaves that one alone.

**Blocked by:** 30

**Status:** needs-triage

Pinned by Stefan on 2026-11-15 ("I also want a per repo pause. Pin it for now"), while choosing
game-backdrop as the dashboard's first real run.

## Why it matters for that first run

The build order (ticket 33) only orders builds. The Claude lane takes a decision, a repo's live
steps and a fix round before any build, in any repo (`Runner.choose`, `queue_runner/run.py`).
So with game-backdrop first and leads-dashboard still served, Resume starts leads-dashboard's
waiting jobs first: today that is the live steps for PR #209, which deploy to production, then
the fix round on PR #208. Only then does game-backdrop's first build start.

## To settle

- What a stopped repo holds back: every Claude job for it and its reviews and merges, or
  Claude's jobs only.
- Whether its asks still show in the Inbox (they should: stopping the work doesn't answer them).
- Where the record lives: `control.json`, beside the lanes (`repos.<name>.stop`), written by
  the page and by `--pause NAME` and `--resume NAME`.
- Whether Stop now applies to a repo, or only "after its job".

## Comments
