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
- **An answered ask stays greyed in the list until the runner acts on it** (mechanics).
- **Prototyped one page at a time, judged by eye:** the Inbox first (built, on sample data; take
  4 is `dashboard/earlier/take-4.html`), then the Overview (three cards: the Inbox in counts,
  what each lane is doing with its Stop button, a progress bar per feature with the next
  ticket), then the Queue (features with their bars and tickets in build order, a "what blocks
  what" view; no kanban board: the runner has at most one build and one review in flight, so
  its columns would hold one card each). **Still his to decide, when the Queue's turn comes:**
  whether features or tickets can be reordered from the page, which would be a new control.

## Comments

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
