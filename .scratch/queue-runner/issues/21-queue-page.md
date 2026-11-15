# 21: Prototype the Queue page

Type: prototype

**Blocked by:** None

**Status:** ready-for-human

**Next up** (Stefan, 2026-11-15). It needs him at the screen: he judges it by eye.

**It goes before the Overview** (Stefan, 2026-11-15; ticket 20 is blocked by this one now):
"Queue, Inbox, then Overview, because Overview represents the data where it's from, like it's
dripping down." The Overview summarises this page, so what build order means for features,
which ticket is a feature's "next" and how a feature's bar reads are decided here. Build it as
several structurally different variants on the one page, switched with `?variant=`. He isn't
sure the Overview should be a page of its own at all, so one variant should show the Queue as
where he lands, with the summary on top.

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

`?page=queue&variant=a|b|c` shows three arrangements of the same work on sample data, for
Stefan to judge (Comments, 2026-11-15, take 10). The page before them is
`dashboard/earlier/take-9.html`.

## Comments

2026-11-15: the Overview's first take (ticket 20, take 9) left three things here to start from,
none agreed: `featureBar(feature)` in `dashboard/index.html` (a cell per ticket: done, merged
but not live, in a PR, building, waiting on him, ready, blocked); the sample's `merged` issue
state and its `features` in build order (the repos' order, then the feature whose first open
ticket has the lowest number); and one "Next" per lane on the Overview, with the rest of each
lane's queue owed to this page (its old markup is in `dashboard/earlier/take-8.html`).

2026-11-15, **take 10: the Queue as three variants, not judged yet.** `python3 -m dashboard
--sample`, then `?page=queue&variant=a|b|c`; the pill over the sidebar's foot or the left and
right arrow keys turn between them. Take 9 is kept as `dashboard/earlier/take-9.html`.

- **A, features first** (this ticket's starting point): a card per feature in build order, its
  bar, what's left in a sentence, its tickets as rows in the order they're built; a chip or a
  feature's name narrows the page to that feature; "What blocks what" is the pyramid of the
  same scope; each lane's queue is the last card.
- **B, the page you land on**: what waits on him (a tile per ask) and what's running (each
  lane with its Stop button and its whole queue) on top, the features folded to a line each
  under them. It's there to judge whether a separate Overview is needed.
- **C, tracks**: every row runs left to right. A lane's row is what it's on and then its
  queue, numbered; a feature's row is its tickets one after another until "Usable". Picking a
  ticket lights up what it waits on and what it holds up.

**Still his:** which variant, or which pieces of each; and whether features or tickets can be
reordered from the page (not built in any of them). Where the control would sit: in A, up and
down arrows on a feature's card head and at the end of a ticket's row; in B, on the folded
feature lines and on a lane's queue rows; in C, on a lane's row itself, moving a cell left or
right, with a feature's arrows beside its name.

Choices made while building it, each mine and open to change:

- "When is this feature usable" is answered as what's left and who it waits on ("4 to go: 2
  wait on you, 1 merged but not live, 1 blocked."), not as a date: the runner has no honest
  date to give.
- "What's next" is each lane's own queue, in the runner's order. Tickets that are still
  blocked get no number: which is built first depends on when their blockers merge, so a
  blocked ticket says "After #226" instead of a place in line.
- A feature's tickets are ordered by the snapshot, not the page: `features[].tickets`, what
  has started first (furthest along first), then a blocker before what it blocks, lowest
  number first, one not marked ready last.
- A ticket's row or cell says more than its state: who is on it and for how long, its place in
  a lane's queue ("3rd in Claude's queue"), or what it comes after. One that waits on him
  carries the Inbox's tag (Stuck, Ready to merge, Your decision) and opens that ask.
- Work that belongs to no feature is shown as a feature of its own, "No feature", after the
  features with open work and without a "Usable" end.
- A finished feature stays on the page, last, as "Usable". The sample has one now ("Missed-call
  texts") so that can be judged.
- The sample's reviewing lane has one PR waiting (PR #232) in every state but "Inbox empty", so
  a review queue can be judged too; before, it was always empty.
- Done tickets stay in a feature's rows, dimmed (A, B); on a track (C) each is a narrow green
  cell with a tick, named on hover, so the room goes to what's left.
- A lane's Stop button is wherever the lane is shown, in all three; "Stop all" stays in the
  top bar.
- B shows up to six asks as tiles and says how many more are in the Inbox.
- The pill sits over the sidebar's foot, where Stefan had the Inbox's layout pill moved, and
  shows with sample data only.
- The list and the "By feature" strip of the old Work card are gone; the pyramid is kept as it
  was ("What blocks what" in A and B).
- Under about 520px a track (C) stands its cells on end, top to bottom.
