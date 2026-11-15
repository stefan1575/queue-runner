# 21: Prototype the Queue page

Type: prototype

**Blocked by:** 25

**Status:** ready-for-human

Pinned: 2026-11-15, Stefan, until the grill on what the Overview is for (ticket 25), which may
change what this page has to hold. It needs him at the screen: he judges it by eye.

**It goes before the Overview** (Stefan, 2026-11-15; ticket 20 is blocked by this one now): the
Overview summarises this page, so what build order means for features, which ticket is a
feature's "next" and how a feature's bar reads are decided here.

**The question:** how should the work be shown so that "what's next" and "when is this feature
usable" are answered at a glance, one ticket after another until a feature is done?

## Where it starts from (ticket 18, Decisions, the split)

- It opens on the features, in build order, each with its progress bar and its tickets under it
  in the order they'll be built. Picking a feature narrows the page to it (Stefan's "per
  effort" filter).
- A "what blocks what" view of the same scope (the pyramid that exists today).
- Each lane's own queue of what it takes up next moves here from the Overview.
- No kanban board: the runner has at most one Claude job and one review in flight (AGENTS.md,
  Two lanes), so the in-progress columns would hold one card each.

## His to decide when this starts

Whether features or tickets can be reordered from the page. Today only the order of
repositories is a control (`control.json`'s `repo_order`); reordering below that would be a new
control the runner has to obey.

## Today

`?page=queue` shows the work list and the pyramid as they were, marked "Not rebuilt yet"
(`dashboard/index.html`, `work()`).

## Comments

2026-11-15: the Overview's first take (ticket 20, take 9) left three things here to start from,
none agreed: `featureBar(feature)` in `dashboard/index.html` (a cell per ticket: done, merged
but not live, in a PR, building, waiting on him, ready, blocked); the sample's `merged` issue
state and its `features` in build order (the repos' order, then the feature whose first open
ticket has the lowest number); and one "Next" per lane on the Overview, with the rest of each
lane's queue owed to this page (its old markup is in `dashboard/earlier/take-8.html`).
