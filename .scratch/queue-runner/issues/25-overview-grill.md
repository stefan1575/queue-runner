# 25: Grill: what is the Overview for?

Type: grilling

**Blocked by:** None

**Status:** ready-for-human

Opened: 2026-11-15, Stefan, on seeing the first Overview (ticket 20, take 9): "at first glance
it's way far off on what I want, or I don't actually know what I want. Think how I would use
it." He asked for a grill of its own, before any more of the page is built.

**The question:** when Stefan opens the dashboard, what is he there to find out and what does he
do next, and so what is the first page for (or is there one at all)?

## What's on the table

Take 9 (`python3 -m dashboard --sample`, no `?page=`; AGENTS.md, The dashboard) is three cards:
the Inbox in counts with the ask that's first in line, a line per lane with its Stop button and
its one next job, and a progress bar for each of the first three features. It is committed and
not agreed.

Why it may feel far off: **the frame already carries most of it on every page.** The sidebar's
Inbox entry has the count; the right rail has usage, the build order and the runner's status;
the top bar has Stop all. What the Overview adds to that is two lane lines and three bars. And
it has nothing for "what happened since I last looked".

## How he might use the dashboard (a guess, to be corrected)

- **After a toast** he goes straight to the ask: the toast opens the issue or the thread, so the
  first page isn't involved.
- **Coming back after hours or days** is the first page's real moment: is it still running, what
  needs me, what got done while I was away, what will it do next.
- **Before starting his own heavy session** he checks usage and may stop a lane.
- **When prioritising** he wants the Queue.

## Questions to put to him

- When does he actually open the dashboard, and what does he do next from it?
- Is the Overview where he lands, or should he land on the Inbox whenever it isn't empty?
- Does "what's next" mean the runner's next job, or how far along each feature is?
- Is it a page he visits, or one that sits open on a second monitor?
- What does he need to know about the time he was away?
- Is the feature the unit he thinks in, when the next build may belong to no feature?

One possible outcome is that there is no Overview: the pages are Inbox and Queue, and the lanes
find a place in the frame. So this comes before the Queue page too (ticket 21).

## What follows

Record the answers under `## Answer` here and as decisions in ticket 18. Rewrite ticket 20's
question from them. Then the Queue page (ticket 21), then the Overview (ticket 20) as several
structurally different variants on the one page, switched with `?variant=` (the `prototype`
skill's usual shape), which Stefan asked for.

## Comments
