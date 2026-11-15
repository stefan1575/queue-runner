# 20: Prototype the Overview page

Type: prototype

**Blocked by:** None

**Status:** ready-for-human

Pinned: 2026-11-15, Stefan, until the Inbox page is agreed (ticket 18). It needs him at the
screen: he judges it by eye.

**The question:** what does the first glance show, so that it answers "what's on my plate, what's
running, what's next" without a click?

## Where it starts from (ticket 18, Decisions, the split)

- The Overview only summarises. Each card opens its page.
- Three cards, as proposed and not yet seen: the **Inbox** in counts by kind, with how long the
  oldest has waited and the top ask's one line; **Running now**, a line per lane (what it's
  doing and for how long, or why it's idle) with its Stop button; **Progress**, a bar per
  feature that still has open work, in build order, the top three, each with its next ticket.
- Done means live. A feature's bar has, left to right: done, merged but not live, in a PR,
  building, waiting on him (blue), ready, blocked.
- Charts over raw data (Stefan): the page is for a glance, not for reading rows.

## Today

`?page=` with nothing is the Overview: it shows the two lanes as they were, marked "Not rebuilt
yet" (`dashboard/index.html`, `lanes()`).

## How

Sample data only, on the existing page (`python3 -m dashboard --sample`), as the Inbox was done.
Copy the page to `dashboard/earlier/` as the next take first. The snapshot already carries
`asks`, `lanes`, `features` and each issue's `feature`, `state`, `blocked_by` and `pick`; "merged
but not live" is a state the sample doesn't have yet.

## Comments
