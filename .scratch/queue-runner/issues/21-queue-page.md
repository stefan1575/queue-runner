# 21: Prototype the Queue page

Type: prototype

**Blocked by:** 20

**Status:** ready-for-human

Pinned: 2026-11-15, Stefan, until the Inbox and then the Overview are agreed. It needs him at
the screen: he judges it by eye.

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
