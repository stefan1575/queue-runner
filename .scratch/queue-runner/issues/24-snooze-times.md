# 24: Snooze times Stefan sets himself, in Settings

**Blocked by:** None

**Status:** needs-triage

Pinned: 2026-11-15, Stefan ("pin that the snooze time is at the settings or something. I don't
know where, but I want to make it granular").

Today the Inbox's Snooze menu offers three fixed choices: for 3 hours, until tomorrow 9:00, and
until next Monday 9:00 (`snoozeChoices()` in `dashboard/index.html`). Snoozes live in the
browser's localStorage while the page is a prototype (AGENTS.md, The dashboard).

What he wants: to set those choices himself, more finely. Where the setting lives is open:
Settings is the likely home ("or something"), and the menu could also take a time of his own.

To settle before building: which of these he means, or both:
- the menu's choices are set in Settings (how many, and each as a span or a time of day);
- the menu also takes a time picked on the spot.

And whether snoozes move to `control.json` at the same time (already planned, so every
browser agrees and the runner can hold a snoozed ask's toast), since a setting kept in one
browser would disagree the same way.

## Comments
