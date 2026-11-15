# 19: A dev environment before prod

**What to decide:** whether work the runner merges should land in a dev environment before it
reaches production, and what that changes in the flow.

**Blocked by:** None

**Status:** needs-triage

Raised by Stefan on 2026-11-15, while settling what "done" means on the dashboard: "maybe it
should be a separate dev environment before prod... everything is rawdogged in main."

## Today

- leads-dashboard merges straight to `main`, and Lovable syncs `main`.
- The live steps (AGENTS.md, Live steps) then apply the batch's migrations to the one live
  Supabase and deploy its edge functions. Nothing sits between merged and production.
- A migration that fails halfway leaves production between two states (the `partial` outcome),
  which comes to Stefan as a `live` stop.

## What a dev environment would change (to grill, not decided)

- Where merges go: a `dev` branch first, or `main` with a second Supabase project behind it.
- What the live steps target, and whether they run twice (dev, then prod).
- When Stefan's merge happens in a repo he merges: into dev, or as the promotion to prod.
- What promotes dev to prod: Stefan, a check, or time.
- Whether Lovable can serve two environments from one repo at all.

## The dashboard doesn't wait for it

"Live" on the dashboard means the live steps ran. If a dev environment arrives, a feature's
progress bar gains an "on dev" state between merged and live; nothing else moves (ticket 18,
Decisions).

## Comments
