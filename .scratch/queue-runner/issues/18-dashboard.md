# 18: The dashboard

**What to build:** a local page that tells Stefan what needs him, then what the runner is doing,
then the work and what blocks what, with stop and resume and the order repos are built in. It
is its own background process, apart from the runner and from T3, so that neither can break it
and it can say truthfully that the runner has stopped.

**Blocked by:** 17

**Status:** ready-for-agent

The page and its server are built (`dashboard/`, on sample data; AGENTS.md, The dashboard). What's
left is the runner's side, to be split into tickets once Stefan agrees the page:

- [ ] The runner publishes `<state_dir>/snapshot.json` on every pass and at least every
      `write_every` seconds while it's up, in the shape `dashboard/sample.py` builds.
- [ ] The dashboard starts at logon beside the runner, with no extra setup.
- [ ] The runner reads `<state_dir>/control.json`: stop a lane after its job, resume it, and the
      order repos are built in; `control_read_at` in the snapshot says which write it acted on.
- [ ] Stop now: Sol's review is cut off; Claude's thread is interrupted through T3's API, the
      one place the runner depends on it. The runner checks at start that T3 accepts the
      interrupt and says so in the snapshot (`sources`, `stop_now`); when it doesn't, only that
      button goes.
- [ ] A stopped PR's ask opens a T3 thread to decide in, started when Stefan clicks, and the
      runner reads the answer from it.

## Decisions (Stefan, 2026-11-15)

After four prototype rounds (`../prototype-app/`, kept as history) and an audit of them:

- **Inbox first, tracker second.** The page opens on what needs Stefan. The work list and the
  pyramid (what blocks what, by feature, so he can see what to prioritise) come after.
- **Every ask links out to where it's answered,** a T3 thread or the PR. No answer buttons on
  the page: a product decision gets a conversation, not a click. Mechanical decisions never
  reach the inbox.
- **Its own process, no dependencies.** One HTML file with no build step, served by Python's
  standard library. It reads one file the runner writes and writes one file the runner reads.
  It never imports runner code and never calls T3 or GitHub.
- **Stop after this job, and Stop now.** This replaces "pause means after the current step":
  Stefan's usage for another project can matter more than finishing a job. A cut-off Claude job
  is treated like a usage-limit stop (the branch stays; it resumes in place or afresh).
  T3's command line has no interrupt (`t3 thread` has `list`, `start`, `send`, `show`; checked
  2026-11-15), so Stop now for Claude needs T3's API. Stefan accepted that one dependency, with
  its health shown on the page.
- **Build order is a control,** not only config: Stefan reorders the repos from the page.
  Repo order only for now; pinning one issue as next is not built.

- **The frame is the one from the prototype rounds** (Stefan, 2026-11-15, after the first
  rebuild dropped it): a sidebar with the repository switcher, the pages (Dashboard, Activity,
  Usage, Settings) and the runner's health; one centred column; usage floating on the right like
  T3 Code's, with the build order under it. Claude and ChatGPT carry their own marks. Needs you
  keeps one size whichever repository is picked. Type is 16px and up.

## Decisions (Stefan, 2026-11-15, later: the split)

Takes 3 and 4 rearranged Needs you inside one box on the one page (tabs, then rows on top), and
both missed: the box shared the page with the lanes and the work, so it had to stay small. A
grill settled the split instead:

- **Three pages, three jobs.** Overview (the first glance), Inbox (what waits on him), Queue (the
  work), then Activity, Usage and Settings as they are. Overview only summarises; each card
  opens its page.
- **"Needs you" is the Inbox.** His word. The CLI's `--needs-me` becomes `--inbox` once the page
  is agreed (not yet: the prototype doesn't touch the runner's code). The snapshot's `asks`
  keeps its name.
- **Done means live.** In a feature's progress, a ticket counts as done once its live steps ran
  (merged is live in a repo with none). "Merged, not live yet" is its own state.
- **The Inbox keeps all four kinds:** decision, stuck, merge, and broken only when it stops a
  lane; a health warning that stops nothing stays a dot on the right.
- **Dev before prod is its own effort** (ticket 19), not the dashboard's.
- **An ask Stefan has decided moves to a Decided group at the foot of the list**, which folds to
  one line, tagged "Runner's turn" until a lane takes it up and "Working" while one does.
- **Prototyped one page at a time, judged by eye:** the Inbox first (built, on sample data; take
  4 is `dashboard/earlier/take-4.html`), then the Overview (three cards: the Inbox in counts,
  what each lane is doing with its Stop button, a progress bar per feature with the next
  ticket), then the Queue (features with their bars and tickets in build order, a "what blocks
  what" view; no kanban board: the runner has at most one build and one review in flight, so
  its columns would hold one card each). **Still his to decide, when the Queue's turn comes:**
  whether features or tickets can be reordered from the page, which would be a new control.

## Comments

2026-11-15, **the order changed after Stefan's first look at the Overview** (ticket 20, take 9:
"way far off on what I want, or I don't actually know what I want"). A grill on what the
Overview is for comes first (ticket 25), then the Queue page (ticket 21), then the Overview
again (ticket 20), as several variants. Take 9 stays on the page, proposed and not agreed.

2026-11-15, **the Inbox is agreed** (Stefan: "settle this"). Last change: Snoozed is a folding
group at the list's foot like Decided, each row with its Unsnooze button. Granular snooze
times in Settings are pinned as ticket 24. Overview and Queue (tickets 20 and 21) are next.

2026-11-15, Stefan's third round (take 7, kept as `dashboard/earlier/take-7.html`): **layout C
is settled**, so A, B and the layout pill are gone. A row now reads like a thread in T3's
sidebar: the repository's mark and name on top with the tag, then the title and the
situation. Decided asks sit in their own folding group at the foot, "Working" with a pulse
while a lane is on them. The repository's mark is its first letter on a plain tile for now:
the snapshot carries no favicon. The research pass on rows was dropped: T3 is the reference.

2026-11-15, Stefan's second round of notes on the Inbox (that page is `dashboard/earlier/take-6.html`),
taken up: the layout pill floats over the sidebar's foot and takes no room; the Inbox takes all
the width; an answered ask's row is a tick and one sentence; each step of the story so far has
its time and a whole sentence (`timeline`); the reserve's line under Claude's usage has no date.
`--needs-me` is now `--inbox` (`queue_runner/inbox.py`). **Still open, his:** the briefing's
layout, A, B or C; and how a list row should look to be read at a glance (title, icon, the
one-line situation, the unread dot), which he wants a research pass on before it's settled.
A share of Fable's week and of ChatGPT's kept for him is pinned as ticket 23.

2026-11-15, Stefan's notes on the Inbox page (take 5, kept as `dashboard/earlier/take-5.html`),
taken up the same day: the Inbox's column is wider than the other pages'; each kind of ask has
its icon and the button carries the mark of where it's answered; read and unread, and snooze
(both in the browser for now); every point in time written whole ("November 15, 2026 Sunday
1:14pm"); the runner's sources grouped as providers, local and external. **Open, his to pick:**
which of three layouts of the briefing reads best (`?variant=A|B|C`). **This session is the
Inbox only:** the Overview and the Queue are pinned as tickets 20 and 21, the date format's
options as ticket 22.

2026-11-15: the page was rebuilt a second time, joining the two before it: the prototype
rounds' frame (above) around what the audit settled (questions shown open, links out, stop
after or now, build order, the pyramid, one HTML file). The first rebuild is kept as
`dashboard/earlier/take-1.html` to compare against until the look is agreed.

2026-11-15: the original ticket asked for a page the runner serves, with pause after the
current step only. Both changed above.

2026-11-15, later: Stefan's notes on that page, taken up over two more takes (`take-2.html` is
the page he annotated; `take-3.html` put the lanes on top with a tab per ask, which he
rejected). Now: Needs you stays on top and reads like an inbox, a line per ask and the picked
one open under them, each written to be read cold a week later (why it came to him, what the
work is, what has happened). The lanes sit under it with one Stop button each and their own
queue of what comes next. No moving line on a working lane. On the right, in his order: usage
(a reset time under every window, a clearer rule between Claude and ChatGPT, wider), the build
order, then the runner's status, moved from the sidebar because the left is for getting around.
**Work is next, on its own:** at first glance it doesn't say what to do with it; Stefan's idea
is a feature of the app with its prerequisites in view.

The runner's side grows by this: it has to write each ask's `kind`, `situation`, `about`,
`because` and `story`, and each lane's `queue`.

2026-11-15, later, **corrected: the Queue page (ticket 21) is next, as several variants**; the
grill (ticket 25) waits until the Overview's turn. Stefan's order is Queue, Inbox (agreed), then
Overview, since the Overview shows what the other two hold.

2026-11-15, **the runner side is split into tickets 28 to 36** (spec: `../dashboard-live.md`), built ahead
of the Overview and Queue looks at Stefan's word: "let's prioritize that first over the UI". Two things
he decided on the way: `queue.localhost` is the real dashboard and `localhost` the sample one, and
pausing is the same switch as the page's Stop on the Claude lane.
