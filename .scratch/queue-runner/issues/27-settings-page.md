# 27: Settle what the Settings page holds

Type: grilling

**Blocked by:** None

**Status:** needs-triage

Noted: 2026-11-15, from the planning thread on the dashboard's pages. Not started.

Today `?page=settings` shows the build order, his share of each plan, who does what and the
connections (`dashboard/index.html`, `settings()`). Only the build order can be changed from the
page.

The page is mostly a list of decisions: each new knob is a new control the runner has to obey
(`control.json`). So this is a short grill on which knobs exist at all, more than a look to
prototype. Three pinned tickets land here and none is triaged: 22 (date format), 23 (a share
kept of Fable's week and of ChatGPT's) and 24 (snooze times).

## Comments
