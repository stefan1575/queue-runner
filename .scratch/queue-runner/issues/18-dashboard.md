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

## Comments

2026-11-15: the original ticket asked for a page the runner serves, with pause after the
current step only. Both changed above.
