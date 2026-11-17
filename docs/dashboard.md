> Under review: Stefan is regrilling the dashboard's pages (#29, #30, #34, #35), so this is moved from `AGENTS.md` word for word and not yet checked against the code.

## The dashboard

`dashboard/` (ticket 18; Stefan, 2026-11-15). **Three pages do three jobs** (Stefan, 2026-11-15,
after four takes that put everything on one page): **Overview** is the first glance, **Inbox** is
what waits on him ("Needs you" before; the name is his), **Queue** is the work. Activity, Usage
and Settings follow. **The Inbox is agreed** (Stefan, 2026-11-15, after takes 5 to 7, kept in
`dashboard/earlier/`). **The Overview on the page is a first take that Stefan didn't take to**
(ticket 20: three cards, below; "way far off on what I want, or I don't actually know what I
want"). **What's next, in order** (Stefan: "Queue, Inbox, then Overview, because Overview
represents the data where it's from"): the Queue page (ticket 21), **built as three variants
switched with `?variant=a|b|c`, waiting for Stefan to judge them** (The Queue page, below);
then, if it's still needed, a grill on what the Overview is for (ticket 25); then the Overview
again (ticket 20), also as variants. Its frame is the one Stefan asked
for in the prototype rounds: a sidebar for getting around (the repository switcher and the
pages), one centred column, and the machine's readings floating on the right, in his order:
usage, the repositories, then the runner's status. **It is its own process and depends on nothing:** no build step, no
package, no network, no runner code, no T3, no GitHub. One HTML file, served by Python's standard
library.

```
python3 -m dashboard    # http://queue.localhost/ is the runner's; http://localhost:5289/ is sample data
```

- **One process, and the address is the switch** (ticket 29; Stefan, 2026-11-15). The request's
  `Host` picks the data: `queue.localhost:<port>`, and `queue.localhost` with no port, are the
  runner's snapshot and control file in `--state-dir` (no port: http://queue.localhost/, through
  `~/Code/tools/localhost-proxy`, Caddy in Docker Desktop holding 127.0.0.1:80 for every
  `*.localhost` app and passing the Host on; Stefan, 2026-11-16); `localhost:<port>` and `127.0.0.1:<port>` are sample data, whose controls go to
  a temp folder removed when the dashboard stops. Any other `Host` is refused (403). There is no
  `--sample` any more. `?sample=<state>` and `/earlier/take-N.html` work on the sample addresses
  only, and the real snapshot is served with any `sample` key taken out, so the sample menu and
  the Queue's variant pill (both shown only when `snap.sample` is set) never show there. The
  start line names both addresses and which is which.
- **A control is taken only from the address it was sent to:** `POST /control` needs an
  `Origin` equal to `http://<its Host>` (a browser sends one on every POST), so the sample page
  can never write the real control file, and a request with no `Origin` (not a page) is refused.
- **No snapshot yet** on the real address: `/snapshot.json` is a 404 whose `start` says how to
  start the runner (its shortcut, or `pythonw -m queue_runner` in this repo), and the page
  shows that and no controls.
- **One dashboard per port** (`serve.Server`): it binds with `SO_EXCLUSIVEADDRUSE` and without
  `SO_REUSEADDR` (Python's `HTTPServer` sets it, which on Windows let three dashboards listen on
  5289 at once). A second start says `A dashboard is already running on port N` and exits 3. It
  starts at logon from the Startup folder (Running unattended, above).

- **Two files are the whole contract,** both in the state folder (`--state-dir`, default
  `~/.queue-runner/state`). `snapshot.json`: the runner writes it whole, the page reads it.
  `control.json`: the page writes it whole, the runner reads it. **The runner writes
  `snapshot.json`** (ticket 28, below) and obeys `control.json`'s stops (ticket 30: Stopping a
  lane, above; ticket 37: Stopping one repo, above).
- **The runner's snapshot** (`queue_runner/snapshot.py`, ticket 28; spec
  `.scratch/queue-runner/dashboard-live.md`). In continuous mode only (`--once` writes none):
  `Publisher` writes it whole (a temp file, then `os.replace`) after every pass of either lane,
  and every `write_every` (30) seconds from its own thread, so it goes on while a lane is
  blocked in a job. A write that fails is logged once (`The dashboard snapshot was not
  written ...`, then `... is written again`) and never stops a lane. `build(Facts)` is pure, one
  small function per part; `Snapshots` gathers the facts: the job log (each lane's open jobs),
  each lane's switch (`control.read`: a stopped lane is `stopped`, `stopped.at` when Stefan
  asked, or gate.json's mtime for the older pause; `stopping` while its job still runs; an
  unreadable control.json makes an idle lane `waiting` with the reason; `control_read_at` is
  the `written_at` of the control.json the snapshot read, since each lane reads it again before
  it starts anything; `knob.paused` is whether the Claude lane is stopped), gate.json's reserve, the learned costs (`CostBook.learned`), the Claude lane's wait as its last
  pass left it (`Runner.claude_wait`: the gate's verdict text or a limit's resume) and each
  repo's (`Runner.repo_waits`: the gate's word on that repo's job, #50), Sol's resume
  (`JobLog.sol_resume_at`), and the titles the passes read (`Runner.titles`). **Sources** are the
  last real call of each kind: the CLI wraps GitHub and T3 in `Calls.watch`, and the gate's
  usage reader tells `Calls` each attempt (`on_call`), so every call the passes make is recorded
  (a failing one keeps its last good time). **GitHub is never read for the snapshot.** Only the
  publisher's own 30-second writes read afresh: Claude's usage, through the gate's own reader
  (The usage gate, One reading, one budget), and ChatGPT's (`codex_usage.CodexUsage`, ticket
  42: Usage, below) every 5 minutes (`READ_EVERY`) or on a Refresh, and an open Claude job's
  thread in T3 until found. `asks` and `answered` are ticket 31's (The Inbox's asks, below);
  `features`, `issues`, `prs`, `activity` and each lane's `queue` ticket 32's (The work lists,
  below). `stop_now` is unavailable until ticket 34. `--snapshot` prints one built the same way
  with no runner in memory (its pid and start from runner.pid, a limit's wait from the job log),
  reading GitHub once itself for the Inbox and the work (git only read: nothing fetched).
- **The snapshot's shape is what `dashboard/sample.py` builds** (version 1): `written_at` and
  `write_every` (a snapshot older than three times that, or 90 seconds, means the runner has
  gone quiet: the page says so, greys the health readings and takes the controls away),
  `control_read_at`, `sources` (health; `short` is the name beside its dot, `group` sorts them
  on the page: `provider`, `local` or `external`), `repos` in config.toml's
  order (each with `icon`, its favicon as a data: URL or null: `queue_runner/favicon.py`, below;
  `stopped`, `{"at"}` or null: ticket 37; `doing`, the Claude job running in it,
  shaped as a lane's `job`, or null; and `wait`, `{until, reason}` while none starts in it
  because the gate held its job or something holds every repo, or null: #50), `asks` (below; each with `read` and
  `snoozed_until`: Read and snoozed, below; null, as `answered` is, until the Sol lane's first
  Inbox read, and while any repo has had no read GitHub answered (`Inbox.unread`: a first read
  that failed lists only the job log's part, PR #104's review 1, F1), so a control written
  meanwhile drops no ask's marks and the page says "Inbox not read yet": issue #92, the
  sample's `inbox-unread` state), `answered` (asks Stefan has answered that the runner hasn't acted on
  yet: an ask plus `answered`: `at`, `said`, `next`; not counted as waiting on him), `lanes` (each with `job`, the newest job it runs, and `jobs`, every one,
  oldest first: the Claude lane's one per repo, #50; and its `queue`, what it takes up next, in
  order, across repositories, a job a limit cut off first, and for the reviewing lane the PRs waiting for their review; `queue_empty` says why there's none), `usage` (a plan
  each: `id`, `provider`, `name`, `plan`, `read_at`, `error`, `windows`, `resets`,
  `{"available": N}` or null, and `next_read_at`, when Claude's endpoint may be asked again while
  that's ahead, null for ChatGPT: Usage, below), `usage_refresh` (`{"asked_at", "done_at"}`, the
  Refresh the runner last read for, or null), `features` (the repos'
  order, then the feature whose first open ticket has the lowest number, a finished one last; each with `tickets`, its
  tickets' `repo#n` keys in the order they're built: what has started first, furthest along first, then a blocker
  before what it blocks, lowest number first, one not marked ready last), `issues` (with `pick`, the order ready work is
  built in, and `state`: `done` only once it's live, `merged` while it's merged and its live
  steps haven't run, `review` and `fixing` in a PR, `building`, `you`, `ready`, `blocked`,
  `not-ready`), `prs` (each with its timeline by head), `activity` (what happened, newest first),
  `costs` (what the gate expects each kind of Claude job to take), `roles` (which lane does each
  kind of job) and `knob` (`gate.json`). A lane and a plan name their `provider` (`claude`,
  `chatgpt`), which picks the mark beside the name; the reviewing lane's id stays `sol`. Times
  are ISO strings; the page formats them. `sample.STATES` names every state the page has to show.
- **Control** (`serve.apply_control`): `POST /control` takes `{"lane", "stop"}` (`"after-job"`,
  `"now"` or null to carry on), `{"repo", "stop"}` (`"after-job"` or null: Stopping one repo,
  above), an ask's `{"ask", "read"}` (true or false) and `{"ask",
  "snooze_until"}` (an ISO time with its offset, kept in this PC's, or null), or `{"ask": <id>,
  "open": true}` (`asks.<id>.open`: Deciding an ask in T3, above), or `{"ask": <id>, "fresh":
  true}` (`asks.<id>.fresh`: A stale waiting thread, below), or `{"usage": "refresh"}`
  (`usage.refresh_at`: Usage, below), and anything else is refused, `{"repo_order"}` too
  since #61 (and a `repo_order` already in the file is dropped, #50);
  each write keeps what the others wrote. The page shows a request as asked until
  `control_read_at` reaches its time.
- **Usage** (ticket 42): the Usage card's head has Refresh (an icon, "Refresh" on hover), and
  Details beside it again (Stefan, 2026-11-16, liking the prototype's floating card), which opens
  the Usage page; the page stays in the sidebar too. It posts `{"usage": "refresh"}`; the
  publisher's next fresh tick (30 seconds at most) takes it whatever `READ_EVERY` says, and the
  snapshot's `usage_refresh.asked_at` names the request it took. **It doesn't force Claude's
  call** (issue 66): ChatGPT is read; Claude's reader asks its endpoint only if its 5-minute
  budget allows, so inside it the card says when the reading was taken and when the next read
  can be ("Claude: read 2 min ago. Next read from 14:06."), and outside it Claude is read as
  now. The button spins until the request is taken (the page reads every 2 seconds meanwhile),
  then the card says which plan it couldn't read; it's off while the runner is silent or its
  snapshot has no `usage_refresh` (older code). A request left from before the runner started
  is taken by its first read. **A failure shows only when it matters:** a plan (Claude's or
  ChatGPT's) has an `error`, and its source's dot turns red, only once its reads have failed for
  10 minutes (`usage.SHOW_AFTER`) and its reading is past 30 minutes (the error then says no
  Claude job starts until a read answers), its login is the trouble (no token, HTTP 401), or it
  has no reading; until then it shows its numbers and "read N min ago". Whether a plan failed is
  the snapshot's `error` alone, never a time the page compares. The sample's `usage-stale` state
  shows a reading 40 minutes old.
- **Reconnecting, not red** (Stefan, 2026-11-17, after the PC slept 05:58 to 12:05 and the first
  reads after it woke failed: gh timed out, Claude's token had expired in its sleep and a Claude
  Code session refreshed it four minutes later, Codex's app server started slow; the next reads
  answered). Three states, not two: answering, reconnecting, and red. **A failure is red only
  once it has lasted 10 minutes** (`usage.SHOW_AFTER`, two more tries at the usual 5 minutes),
  or for a plan as above; until then the source or plan has `retrying`, since when its calls
  have failed, and the page shows a grey dot and "Reconnecting since 12:05", the plan its last
  reading with "reconnecting" after it, and no banner. A failure that clears in that time never
  shows red. Since when is kept beside each call (`Call.since`, `Reading.since`, and the third
  part of `inbox.Reader.stale`'s and `work.Reader.stale`'s entries); a repo GitHub couldn't be
  read for, under 10 minutes, makes the GitHub source reconnecting and says nothing about the
  Inbox or the work lists yet (`snapshot._reconnecting`, `_lasting`). One that has lasted
  makes it red, whatever another repo or its latest call says: red clears `retrying`
  (`asks.stale_github`, `work.stale_github`), and the page reads `retrying` only beside `ok`.
  Nothing the runner does
  changes: it retries as before, and the gate decides on its own rule (`docs/usage.md`). The
  sample's `reconnecting` state shows it. **Reset credits** come from
  the same read as the windows, counted as T3 counts them: Claude's from the usage answer's
  `cedar_ember` grants (usable, not paused or ended; none when the grant to use next isn't one:
  `usage.resets`, T3's `claudeResetCreditsToContract`), ChatGPT's from `codex app-server`'s
  `account/rateLimits/read`, `rateLimitResetCredits.availableCount` (`codex_usage.py`, T3's
  `probeCodexAppServerProvider`, read 2026-11-16). That call also gives ChatGPT's windows, so it
  replaced Codex's rollouts (which carry no credits) as the snapshot's ChatGPT read: the app
  server started for one call (Codex on PATH, else the Codex app's copy), `initialize`,
  `initialized`, the read, about a second, 20 at most; Codex reads its own login. Starting it
  rewrites Codex's shared `~/.codex/models_cache.json` (seen 2026-11-16; T3's own check writes it
  again). A plan
  says "2 resets left" on its line, and nothing when it has none. **Redeeming one isn't on the
  page:** it spends the credit, so it stays Stefan's, in T3.
- **The Repositories card** (#61, Stefan 2026-11-16: "just stop and resume") was the Build order
  card: no numbers or arrows, the repos in config.toml's order (the snapshot's `repos`), on every
  page; Settings has no copy of it. Each row says what that repo is doing now (#50, `repoRows`):
  "Building #212, 35 min in.", "Waiting: <why>.", or "Idle.", then who merges; a stopped one
  "Stopped since <clock>" and the job it still finishes. No note under the list (Stefan,
  2026-11-16). Each row starts with the repo's mark and ends with Stop or Resume as an icon
  (pause, play; named on hover and for a screen reader). **A repo's mark** (`repoLogo`, also on
  Inbox rows): its favicon, else its first two letters on a plain tile ("Le", "Qu"). The runner
  finds the favicon as T3 Code finds a project's (`favicon.py`: T3's well-known paths in order,
  then a `<link rel="icon">` in index.html or a root route, under `public/` then the root; read
  from T3 Code's server bundle 2026-11-16), and the snapshot carries it as a data: URL, so the
  page stays one file reading one file; one over 64 KB, or a type a browser can't draw, is left
  out, and so is any file outside the repo, by `..` or through a link (a symlink or junction:
  each path is resolved before it's compared with the resolved root; PR #103's review 1, F1).
  An answer is kept 10 minutes, a miss 1, as T3 keeps them (`tests/test_favicon.py`).
  `tests/test_repo_rows.py` runs `repoRows()` in node on the
  sample's states. A lane running several jobs says "2 at once" and lists each with its thread
  (`laneSays`); `laneOn` finds an ask's job among a lane's `jobs`. The sample's `side-by-side`
  state runs a build in each repo.
- **What's left** (#60, Stefan 2026-11-16: "71% left as opposed to the current usage"): each
  usage window says `100 - used` as "N% left", on the Usage card and page, with when it resets
  under its bar, short ("Resets 22:56", "Resets Wed 23:38"; the whole stamp on hover); the
  card is laid out as the prototype's floating card Stefan liked (label, bar, bold figure; "read
  21:55" by the plan's name), a little roomier; the bar holds what's
  left, amber at 15% left or less and red at none, and the share kept for you is blue at its left
  end, never wider than what's left (none at 0% left: PR #62's F1, `tests/test_meter.py` runs the
  page's `meter()` in node). The snapshot still carries `used`.
- **A stopped repo on the page** (ticket 37): each row of the Repositories card has Stop or Resume
  and says "Stopped since ..." (or "Asked to stop/resume: the runner hasn't read it yet"); its
  work reads as stopped wherever it's listed: a dashed "Stopped" tag beside its name on Inbox rows
  and repo tags, "Stopped." in the repository switcher, and "Its repository is stopped" as an
  unfinished ticket's standing on the Queue (`repoOff`, `offTag`, `standing`). The sample's
  `repo-stopped` state stops leads-dashboard while its two jobs finish: the queues hold
  queue-runner's work only, and its asks stay.
- **Only this PC:** it binds 127.0.0.1, and refuses a request whose `Host` isn't its own address
  or whose `Origin` is another site's, so a web page elsewhere can't stop a lane.
- **An ask is written to be picked up cold** (Stefan: he may come back a week later with the
  context gone). `kind` says why it came to him: `stuck` (the runner tried and couldn't get it
  through), `decision` (a product decision is his), `merge` (ready, his to merge) or `broken`
  (something failed). Then `situation` (it in one sentence), `about` (what the work is),
  `because` (the specifics), `timeline` (what has happened, oldest first: each step's `at` and
  a whole sentence as `text`; Stefan found fragments too short to read), `question`, `options`,
  `holds_up` and `go` (where it's answered: `label`, `url`, and `where`, `t3` or `github`, which
  picks the mark on the button), `decide` and `also` (whether it can be decided in a T3 thread
  and where that stands, and the other place to answer it: Deciding an ask in T3, above). The
  runner lists asks in the order they're worth taking.
- **The Inbox's asks** (ticket 31; `inbox.py` and `asks.py`). **One collection:**
  `inbox.collect` reads the job log and GitHub for what waits on Stefan (`ready` PRs, open
  `stop`s, `build`s a decision left to him, waiting `thread`s, and `answered` stops), each with
  what its ask is written from: the PR's or issue's title, page and body, the body of the issue
  a PR closes, what it holds up (GitHub's native dependencies, `GhCli.blocking`, and `Blocked
  by:` lines: leads-dashboard records its blockers only natively), an Approach note's text and
  Stefan's words, and each review's `decision.json` from its run folder. `--inbox` prints it;
  **the Sol lane reads it after every pass while a snapshot is published** (`Runner._read_inbox`,
  `inbox.Reader`), even while Stefan has stopped that lane (it only reads), and the snapshot
  writes from that read, never from GitHub. **GitHub down:** a repo it can't read keeps the last
  good read's asks, and the GitHub source turns red with that read's time and an `affects`
  line (`asks.stale_github`). **Part-way** (one ask's PR, issue, dependencies or comments
  failing, `_Reader.fill`): that ask is the last good read's (`inbox.key`, `Inbox.unfilled`;
  listed bare only if there's none), the others this read's, and the source says so the same
  way, with the time of the repo's last whole read. GitHub saying a thing isn't there (HTTP
  404, a deleted issue: `inbox.gone`) is the ask's own state: said, the ask listed as the job
  log has it, and not stale. **Templates, no AI** (`asks.render`): `about` is the first prose
  (markdown stripped) under the closed issue's "What to build" or "Summary", else its first
  paragraph, else the PR's, clipped to 300 characters; `because` the stop's reason plus the
  Important findings still open ("Open now: F3, ..."), an approach note's first paragraph after
  it; `timeline` the job log on that PR or issue, oldest first, a whole sentence per step (a
  build, each review and the kinds of problem it raised, each fix or conflict round, decisions,
  stops, answers, ready marks, merges, live runs, `--release`s; a tie goes to the job written
  first). **Kinds:** a review stop, approach note, `no-push` and `conflict` are `stuck`; a
  failed check, a `live` stop and a base stop (once per repo, #98) `broken`; a decision's stop
  on a PR, a build a decision left to him, a waiting thread and `live-todo` `decision`; a ready
  PR `merge`. Listed broken, stuck, decision, merge, oldest first inside a kind. **Ids** are
  stable: `stop-<job>`, `decision-<decision job>`, `thread-<job>`, `merge-<repo>-<n>-<head7>`,
  `base-<job>`. An approach note
  offers rework, fix on and hold with its recommendation marked; a PR stop offers a reply, hold
  or closing the issue; a merge, a waiting thread none. **Answered** (`inbox.finished`): the
  newest answered stop on an open PR stays until the runner has acted: after a reply, the
  decision on it ended (and the fix round it ordered); after a closed issue, the next job on the
  PR ended. `said` is his newest words on the PR or its issue since the stop (`closed #N` for a
  closed issue); `next` says what the runner does with it.
- **The work lists** (ticket 32; `work.py`). **The read** (`work.read_repo`, kept per repo by
  `work.Reader`): the Sol lane reads it after every pass while a snapshot is published, with the
  Inbox, through one `work.Memo` (each GitHub call once for both: about 80 `gh` calls and a
  minute for the three served repos, 2026-11-15, half of it the Inbox's). It goes through the
  lanes' own code, so the queues are what the lanes take up: `Decider.cases`,
  `LiveSteps.batch(record=False)` on a git that never fetches (`work.NoFetch`) and a stopper that
  files nothing, `Fixer.candidates`, `picker.pickable` (every build `pick` could take, in its
  order), `Reviewer.candidates`, and `Merger.steps` (the merge re-check step by step: `why_not`
  is its first failing step). Issues come from `GhCli.work_issues` (one paged GraphQL query:
  labels, parent, sub-issues, native blockers). Every repo is read, a stopped one too, and
  `--snapshot` reads the same way. **GitHub down:** a repo it can't read keeps its last good
  read, and the GitHub source says so (`work.stale_github`, after the Inbox's line). **A
  part failing on its own** (the builds, what's in flight, decisions, live steps, what's merged
  and not live, the findings, fix rounds or reviews, or one PR's merge re-check, reviews, or
  its own reading in the lanes' readers, said there as `reading it failed`) keeps that part
  from the last good read (`work.kept`, `RepoRead.failed`; a PR's own parts only while its
  head is the same), and the repo is stale, since its last whole read, until a read has every
  part. **The
  lists** (`work.lists`, `work.queue`) are written from the last read and the job log now, in
  `Facts.repos`' order, a stopped repo's work left out of both queues. **The Claude lane's
  queue** is `Runner.choose`'s order: the jobs a limit cut off, decisions, live steps (ref the
  batch's newest PR), fix and conflict rounds (only those that may go now: the next conflicted
  PR waits), then builds in the picker's order; its open job isn't listed again. **The reviewing
  lane's** is the PRs Sol would review now. **Issues:** each repo's open issues but its specs
  and maps (an issue with sub-issues is a feature) and the runner's `needs-info` issues, plus
  each feature's closed sub-issues (`done`, or `merged` while a merge commit since the last live
  run names its branch). An issue with an open PR takes its PR's family (`you` while it's held or
  ready for him, `fixing` while a round is queued or running, else `review`), with the PR's
  status as `note`; then an ask on it is `you`; a build the job log holds says what it left
  (`building`, or `you` with the `--release` that frees it; a build a release settled holds
  nothing, `View.released`); then in flight, `not-ready` without
  `ready-for-agent`, `ready` if the picker would take it (`pick` its place in the Claude
  queue's builds), else `blocked`. `blocked_by` is GitHub's dependencies and `Blocked by:` lines,
  as `repo#n`. **Features:** each open issue with sub-issues ("Spec:" or "Map:" taken off its
  title), its tickets its direct sub-issues, ordered as `dashboard/sample.py` orders them.
  **PRs:** `status` and `next` from the open job on it, its repo's stop, a hold for Stefan, the
  merge re-check (`checks`, one per step, for a PR clean on its head), its fix or conflict round
  and its place in the queue, then why Sol leaves it: **left alone** says so and what lets it go
  (a review posted before the cutover or by hand: a new head; two failed reviews: a push or
  `--release`). `timeline` is the job log on it by head (its build on the first head reviewed or
  fixed), each event a whole sentence (`asks.Story`'s), a review with its findings from its
  `decision.json`. **Activity:** every job's events and the releases, newest first, the latest
  200, with the issue's or PR's title as `detail`.
- **How it looks** is explained at the top of `dashboard/index.html`. **The Inbox reads like a
  mail client:** the list down the left for the page's whole height, in the runner's order,
  with the sidebar's Inbox entry carrying the count. **A row reads like a thread in T3's
  sidebar** (Stefan): the repository's mark and name on top with the tag (Stuck, Ready to
  merge, Your decision, Broken; each with its icon) and the age, then the subject and the
  situation in a sentence. The mark is the repository's first letter on a plain tile until the
  snapshot carries a favicon. **A row's actions are icons over its age** (ticket 44; Stefan,
  2026-11-15: "a logo, just like in T3"), shown while the row is hovered or has focus or its
  menu is open, and on the open row where there's no hover (under 1040px, or a touch screen):
  a waiting row's envelope (Mark unread, or Mark read on an unread one) and clock (Snooze, its
  menu fixed to the window under the clock: `placeRowMenu`), a snoozed row's struck clock
  (Unsnooze), a decided row none. Each names itself in a tooltip at once (`data-tip`), and acts
  without opening the ask. `u` and `s` do the same for the open ask. **The briefing is layout C** (Stefan's pick): the situation as
  the headline and the story as a timeline down the left (what it is, the specifics, each step
  with its time), and the one blue panel standing on the right: what it needs from him, the
  options, what it holds up and the link it's answered at. **Two groups at the list's foot,
  each folding to one line** (remembered in the browser): Snoozed, and Decided, which holds an
  ask he has answered until the runner is through with it, tagged "Runner's turn" until a
  lane's job is on it (same repo and ref or PR) and "Working", pulsing amber, while one is. So
  "handled" and "still held" can be told apart. The up and down arrow keys walk the list. The Inbox
  takes all the width there is (Stefan, 2026-11-15; the other pages keep their 1120px column),
  its briefing keeps a readable measure inside that, and under 2000px its right panel steps
  aside behind the Usage button. A decided ask's line says what he said and what the runner
  is doing with it ("You said "fix on". Claude is fixing PR #209, 4 min in."). A lane has one
  Stop button, which asks which stop is meant while a job runs.
- **The Overview only summarises, in three cards read top to bottom** (ticket 20, proposed and not agreed;
  `overview()` in `dashboard/index.html`). **Inbox** (`plate()`): blue while something waits.
  The count in the Inbox's own words ("3 waiting on you", unread, oldest), a row per kind with
  a cell per ask (Stuck, Your decision, Ready to merge, Broken; a kind's row opens the Inbox at
  its first ask), and "First in line": the ask the runner lists first, its situation in a
  sentence, which opens that ask. With nothing waiting the card is plain and says so.
  **Running now** (`running()`, `lane()`, `stopButton()`): a line per lane: what it's doing and
  for how long, or why it isn't, its Stop button, and **the one thing it takes up next** with
  "then N more" opening the Queue. A lane's whole queue belongs to the Queue page (ticket 21);
  its old markup is in `dashboard/earlier/take-8.html`. **Progress** (`progress()`): the first
  three features with open work, in the snapshot's order, each with its bar, the one ticket
  that says where it stands (what waits on him first, which opens that ask; else the next
  ready one; else what's moving) and "N of M done". A line under them counts the features and
  the featureless tickets it doesn't show. Each card's head opens its page; Running now has no
  page of its own.
- **The Queue page is a prototype in three variants** (ticket 21; `queue()` in
  `dashboard/index.html`, sample data only, none agreed). `?page=queue&variant=a|b|c`; the pill
  over the sidebar's foot and the left and right arrow keys turn between them (the pill shows
  on the sample addresses only), and the last one looked at is remembered in the browser. **A, features
  first** (`queueA`): a card per feature in the repos' order, with its bar, what's left in a sentence
  ("4 to go: 2 wait on you, 1 merged but not live, 1 blocked.") and its tickets as rows in the
  order they're built; a chip or a feature's name narrows the page to it (`?feature=<id>`,
  `none` for the work that belongs to no feature); "What blocks what" draws the same scope as
  the pyramid; each lane's queue is the last card. **B, the page you land on** (`queueB`):
  three bands, what waits on him (a tile per ask, opening it in the Inbox), what's running
  (each lane with its Stop button and its whole queue), then the features folded to a line
  each, which unfolds to the ticket rows. **C, tracks** (`queueC`): every row runs left to
  right; a lane's row is what it's on and then its queue, numbered; a feature's row is its
  tickets one after another, the cells along its top being its bar, ending in "Usable";
  picking a ticket lights up what it waits on and what it holds up in every row. All three
  read `queueModel()` (each feature's tickets in the snapshot's order, each ticket's place in
  a lane's queue, the lane on it now) and `standing(ticket)` (its state's word and what comes
  next for it: "3rd in Claude's queue", "After #226"). Work with no feature is shown as a
  feature of its own, "No feature", without an end; a finished feature says "Usable". A
  ticket that waits on him carries the Inbox's own tag and opens its ask. **Reordering
  features or tickets from the page is not built: it's Stefan's to decide** (a new control
  the runner would have to obey). Once he picks, fold the winner in, and move the other
  variants and the pill to a throwaway branch (the `prototype` skill).
- **A feature's bar** on the Overview is `featureBar(feature)`; the Queue's is
  `ticketBar(title, tickets)`, the same cells in the order given: a cell per ticket, named on hover, in `SEGMENTS`' order: done (live), merged but
  not live, in a PR, building, waiting on him, ready, blocked (`not-ready` counts as blocked).
  Colour is the state's family and a hatched cell is the earlier step in it: green solid is
  done and green hatched merged, amber solid is in a PR and amber hatched building, blue is
  his, an outline is ready, a faint cell blocked. `--run-fill` is the amber for a cell (the
  text amber is too dark to fill with in light mode).
- **Read and snoozed** (Stefan, 2026-11-15: "like an IRL inbox"): an ask he hasn't opened is
  unread (a dot, bold); opening it reads it, and its row's envelope puts it back (the open
  one stays unread until another is opened: `ui.hold`). Snooze takes an ask
  out of the list and the count until a time he picks (3 hours, tomorrow 9:00, next Monday
  9:00); it sits in the Snoozed group, still holding its work up, and its row's Unsnooze
  icon undoes it. The briefing has no buttons for either (ticket 44). Choosing the snooze times in Settings is pinned (ticket 24).
  **Both are kept with the runner** (ticket 36), so every browser agrees: the page asks
  `{"ask", "read"}` and `{"ask", "snooze_until"}` (Control, above), kept in `control.json` as
  `asks.<id>` with `read` and `snooze_until` beside that object's other keys (ticket 35's
  `open`); the runner reads them (`Switch.asks`, leniently: an entry it can't use is left out
  and never stops a lane) and the snapshot's asks and answered asks carry `read` (false with no
  entry) and `snoozed_until`, null once its time has passed (`snapshot._marks`). A snoozed ask
  stays in `asks`, so it still holds its work up; the page leaves it out of the count. Until
  `control_read_at` reaches the page's last write, its entry stands in for the snapshot's
  (`mark()` in `index.html`), so a click shows at once. **An ask that's gone takes its entry
  with it:** each write drops the entries of asks the snapshot no longer lists (asks or
  answered; `App.ask_ids`, every sample state's that lists asks on the sample addresses; no snapshot
  to go by drops nothing, and nor does one whose `asks` is null: issue #92). An ask is keyed by its id only: a stop, review or head that comes back is a
  new job and a new id, so it's unread again. The sample's pretend runner reads its own control
  file's `asks` like the rest (`_obey`). The folded groups stay in the browser. The runner
  holding a snoozed ask's toast isn't built.
- **A point in time is written whole** (Stefan, 2026-11-15): `stamp()` gives "November 15, 2026
  Sunday 1:14pm", for when an ask began waiting, a usage window's reset, the runner's start and
  a snooze's end. A list row keeps the short age ("2 h") with the whole time on hover. Choosing
  the format is pinned (ticket 22).
- **The runner's status lists its sources by group,** in his order: Providers (Claude, ChatGPT),
  Local (T3 Code), External (GitHub). **Only what the runner depends on** (ticket 43): the
  sample's sources are `snapshot.SOURCES` (a test holds them), and whether Stop now is available
  shows on the lane's Stop button (`stop_now.note`), not here.
  Nothing on the page moves by itself (Stefan). Colour is state only: blue is Stefan's, amber
  is working, green is done or healthy, red is broken; a usage bar says what's **left**, as T3
  Code does ("65% left"; the snapshot keeps `used`), its fill shrinking as it's used, amber with
  15% left and red with none, and its blue start is the share kept for him; Claude's clay and OpenAI's black or
  white are on their marks only (the marks are Simple Icons', CC0, inline). A provider's name is
  the page's own type, in the text colour, the same for both, as T3 Code sets them (Stefan,
  2026-11-16: until then Claude's was a serif in clay). Fonts are
  ones Windows ships (Segoe UI Variable, Sitka for an ask's question, Cascadia Mono), 16px and up.
- **Stop all** (the top bar) is one `{"lane", "stop"}` request per lane; a lane whose Stop now is
  unavailable is asked to stop after its job instead.
- `?page=inbox|queue|activity|usage|settings` (none is the Overview), `?ask=<id>` (the ask open
  in the Inbox), `?repo=<name>` (the switcher's choice, which narrows every page),
  `?variant=a|b|c` and `?feature=<id>` (the Queue's arrangement, and the feature A is narrowed
  to), `?view=pyramid` and `?pr=<repo>:<n>` open the page there.
- **Earlier takes, while the look is being agreed:** `dashboard/earlier/take-N.html` is the page
  as it was before a rework, served at `/earlier/take-N.html` on the sample addresses only and linked
  from the sidebar's sample menu (`sample.EARLIER`). Before reworking the page again, copy it
  there as the next take (take 8 is the page before the Overview was built, take 9 the page
  before the Queue was), add it to
  `sample.EARLIER` and to the route's test. Delete the folder, its route and its test once
  Stefan agrees the page.
- **A dashboard started before a change to `sample.py` keeps serving the old sample** (the page
  itself is read afresh on every request). Stop it and start it again, or use `--port`.
- The earlier React prototype is `.scratch/queue-runner/prototype-app/` (history only).

## Screenshots

A PR that changes anything the page shows (whichever module the cause is in) needs before and
after screenshots of each sample state it touches (`templates/build.md`, Screenshots;
Stefan, 2026-11-17). `scripts/shoot.py` runs the dashboard from the checkout, or from any commit with
`--commit`, on a free port of its own, and shoots `?sample=STATE&page=PAGE` at 1440×900:

```
python3 scripts/shoot.py --commit origin/main --out shots reconnecting/settings reconnecting/usage   # before
python3 scripts/shoot.py --out shots reconnecting/settings reconnecting/usage                         # after
python3 -I scripts/evidence.py publish --repo . --into pr-<N> shots/*.png
```

The script names them `before-<state>-<page>.png` with `--commit` and `after-<state>-<page>.png`
without (`--label before|after` overrides), so both land in one folder side by side. A new state goes in
`sample.STATES` first, so it can be shot; when the before has no such state, shoot the closest one
and say so. Don't use the dashboard already on 5289 for this: it may be running older code. The
review copies the PR's shots into Sol's run folder (`docs/reviews.md`).
