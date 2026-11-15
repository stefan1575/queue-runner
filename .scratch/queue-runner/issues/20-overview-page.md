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

2026-11-15, **first take built, for Stefan's eye** (the page before it is
`dashboard/earlier/take-8.html`). `python3 -m dashboard --sample`, no `?page=`. Three cards, top
to bottom:

- **Inbox**, blue while something waits: "3 waiting on you", unread and oldest as the Inbox says
  them; a row per kind with a cell per ask and its count (a row opens the Inbox at that kind's
  first ask); "First in line", the ask the runner lists first, its situation in a sentence,
  which opens that ask. Snoozed and decided are one quiet line. Empty, it is a plain card:
  "Nothing waits on you".
- **Running now**: a line per lane: what it's doing and for how long (amber while it works), or
  why it isn't (waiting until when and why, stopped, idle), its Stop button, and one "Next"
  with "then N more" opening the Queue. It has no page of its own to open.
- **Progress**: the first three features with open work, each with its bar (a cell per
  ticket), the one ticket that says where it stands and "N of M done". Under them the legend,
  and a line counting what isn't shown (more features, tickets with no feature).

Decided while building, each Stefan's to overturn:

- **One next item per lane is kept**, not dropped: it is the literal answer to "what's next" for
  that lane. The rest of a lane's queue waits for the Queue page (ticket 21).
- **Build order of features** is the repos' order, then the feature whose first open ticket has
  the lowest number (how the runner picks). The sample's `features` now come in that order.
- **A feature's one ticket**: what waits on him first; else the next ready one; else what's
  building or in a PR; else what goes live next; else what blocks it.
- **Merged but not live is green and hatched**, building is amber and hatched: the hatched cell
  is the earlier step in its colour. `not-ready` tickets count as blocked.
- **A cell per ticket**, not a proportional fill, so a bar can be counted and each cell names its
  ticket on hover.
- The sample has a `merged` issue state, and enough tickets that the first three features show
  all seven kinds of cell between them.

Not built, and why: a second arrangement, one list of features where each row carries its bar,
the ask that waits on him and the job running on it. It answers all three questions in one
place, but work with no feature (three open tickets in the sample, the next build among them)
would have nowhere to show.

Open for his eye: whether the first three features in build order are the right three (the
next build in the sample, #211, belongs to no feature, so nothing on the Overview names it);
the hatched cells; whether "First in line" should also carry the ask's question.
