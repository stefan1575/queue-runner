# 26: Prototype the Usage page

Type: prototype

**Blocked by:** None

**Status:** needs-triage

Noted: 2026-11-15, from the planning thread on the dashboard's pages (Stefan asked what to
iterate next: "Overview, queue, usage, settings"). Not started, and its question isn't his yet.

Today `?page=usage` shows a card per plan with its bars, and a table of what a Claude job is
expected to cost (`dashboard/index.html`, `usagePage()`). It has never had a round of his notes.

**A question to start from (proposed, not his):** will the runner get through this week, and
how much of the week is the runner's versus his?

- Anything that shows burn over time needs history the snapshot doesn't carry yet, so a first
  take would draw it from sample data.
- Every page lives in the one file, `dashboard/index.html`, with shared CSS and shared sample
  data. Two threads editing it at once collide, and each would save the page as the same next
  take. Run this after the Queue page's thread (ticket 21), or in its own worktree on its own
  port (`--port`).

## Comments
