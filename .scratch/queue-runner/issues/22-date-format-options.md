# 22: Let Stefan choose how the dashboard writes a date

**Blocked by:** None

**Status:** needs-triage

Pinned: 2026-11-15, Stefan ("options will be pinned").

The dashboard writes a point in time whole, in the one format he asked for: "November 15, 2026
Sunday 1:14pm" (`stamp()` in `dashboard/index.html`). He called that format opinionated and
isn't sure it's the last word.

What's pinned: a setting on the Settings page for the format (for example weekday first, a
24-hour clock, a short form for the right panel where the whole date takes a line of its own
under each usage bar). Where it's kept is open: the browser, or `control.json` so that every
browser agrees.

## Comments
