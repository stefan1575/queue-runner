# The Claude lane

What the Claude lane does each pass: builds, fix and conflict rounds, decisions, ask threads, live steps, and the repos Stefan merges or keeps local tickets for.

## Two lanes

**One Claude job per working repo, and one Sol job, at a time** (`run.py`; #50, Stefan
2026-11-15: "they both run in parallel... since they are both different repos"; twice the burn on
the 5-hour window accepted, 2026-11-16, with no cap beyond the usage gate). Both lanes write the
one job log (a lock per file inside the process).

- **The Claude lane** plans in the main thread (`Runner.plan`): it settles, then chooses each
  working repo's own job, in the order A Claude pass (below) gives within a repo, skipping a repo
  whose job still runs (`choose`, `_choose_in`; `Start`). The gate lets each in, in turn, only
  when it fits beside the jobs running and the ones let in before it (`_admit`; The usage gate,
  Beside running jobs). Each starts in a worker thread of its own (`Worker`, `_launch`) that
  blocks on `t3 thread start --wait`. A job that doesn't fit doesn't hold back a later repo's
  that does.
- **Who goes first** when the gate has room for one more: the repo whose work has waited
  longest, read as since its last Claude job ended (`Runner._waited`, from the job log, so a
  restart keeps it; a job that never reached a thread doesn't count), config.toml's order
  breaking a tie. Neither repo starves: the one just served goes behind.
- **The loop** (`run_forever`) plans again whenever a job ends (`Runner._ended`), and every
  `poll_seconds` (by the wall clock) while jobs run, for the other repos. A repo whose job started
  no thread (`not-started`, `branch-exists`...) rests `poll_seconds` before it's tried again,
  as the one lane paused after such a pass. `run_pass`, `run_once` and `--once` wait for the jobs
  they start.
- **The Sol lane** (`review.py`) runs alongside in a thread: merges, then one review a pass,
  taking the repos in config.toml's order. `--once` chooses the Claude jobs before the Sol lane
  starts, so what that pass's review decides waits for the next pass.
- **No build order:** ticket 33's `control.json` `repo_order` (the Build order card until #61) is
  no longer read or written. A file that still has it is read as before for its stops, the order
  is ignored without a word, and the next write drops it.
- `--once --dry-run` lists each working repo's job under `dry run: <repo>'s Claude job:`
  (`Nothing to start in <repo>: ...` for one with none; `none: <job> is still running there` for
  one whose Claude job is open in the job log, which the lane skips), after a limit that holds
  every repo.
  `--gate` lists the Claude jobs running (open in the job log) and the working repos with none,
  then each kind's verdict beside them and how many of it could start at once.

**One writer per PR** (`JobLog.writer`): while a build or fix job is open on a PR's branch, or
waiting for an answer (until it ends or is released), Sol doesn't review it, it doesn't merge,
and it gets no other fix round. A repo has one Claude job at a time, so two never write one PR.

## A Claude pass

1. **Settle.** A build or fix job the log shows open was left by a runner that died mid-job: its
   thread is found by title (`Queue runner build: <repo>#<n>` or `Queue runner fix: <repo>#<PR>`,
   created after the job's start record). Still
   running: its repo gets no other job (one Claude job per repo), and the gate counts it. Ended: its outcome is recorded.
   No thread: `not-started`. A `waiting` job whose thread has since completed or failed is
   recorded again. One that's running again, or that T3 can't read, also makes the pass start
   nothing: if its thread is gone for good, `--release` the issue. A decision left open was cut
   off with its runner: `not-started`, so it's decided again.
2. **An ask thread** (`ask_threads.py`; Deciding an ask in T3, below): first each open ask
   thread's newest reply is read and a readable answer acted on; then, before any decision, a
   thread Stefan asked for from the Inbox is opened (not waited on). A job a limit cut off still
   comes first.
   **A decision** (`decisions.py`; Decision threads, below), before any fix round or build: the
   first case the fixed flow doesn't cover.
3. **Live steps** (`live.py`; Live steps, below): a repo's merges since its last live run, once no
   other merge is about to land.
4. **A fix round** (`fix.py`), before any build, so open PRs finish first. A PR gets one when
   the runner's own newest review of its head H is `blocking` (decide()'s `fix`; a stop or an
   approach note goes to Stefan) and that review is still the PR's newest review comment, or
   when that review stopped and a decision has since ordered a round (`Fixer.order`: Stefan's
   rework or fix on, or a decision thread's `fix`; one more round on H, its text first in the
   brief under `## Direction first`). **A review
   from before the cutover** (issue 3; `Fixer.adopted`): with no runner review of H, the PR's
   newest review comment, in any readable format (the old script's marker, or Sol's visible
   `sol-findings` block from a T3 child), blocking on H and posted before `config.toml`'s
   `adopt_reviews_before` (GitHub's UTC time; 2026-11-10, `''` adopts none), counts as the
   runner's review of H: its findings, classes and declines feed the brief, and a restarted
   round finds it by its round. Checked on 2026-11-10: leads-dashboard #152, #162, #163 and #168
   each get a round from their old review 1. A PR whose newest review was hand-run after the
   cutover is left to the session that ran it, and so is one that decide() would have sent to
   Stefan (`ledger.escalation`, read from the ledgers: a kept decline, a reopened finding, an
   earlier class repeated, or review 3 or later still blocking), since stops and Approach notes
   read only the runner's own reviews. Such a PR gets no conflict round either
   (`Fixer.old_escalation`, PR #4's review 2): nothing automatic runs on it until a decision
   orders a round on H. **One round per head:**
   once a round on H ended (except `not-started`), H gets no other until `--release NAME#PR`. The
   runner fetches the PR's head (moved since listing: nothing starts, Sol reviews it first),
   writes a start record (`sha` H, `round` the review's, `branch` the PR's), then blocks on
   `t3 thread start --wait --json --worktree H --branch claude/fix-pr<n>-<H7>`: a fresh T3
   worktree at H on a local branch that never goes to origin, because T3 can't run a thread in
   an existing worktree and the build's may still hold the PR's branch. The thread pushes to the
   PR's branch (`git push origin HEAD:<branch>`). The brief (`templates/fix.md`) has no handoff
   file: the open Important findings and their classes, the nits and the findings fixed or
   declined before, from the newest review's ledger; the PR's description and the issues it
   closes; its commits and changed files from git (`origin/<base>..H`); the earlier build and
   fix threads' links from the job log (as T3 gave them).

   **A conflict round** (ticket 15; Conflict rounds, below) is a fix round too, for a PR with
   no blocking review whose head conflicts with its base.
5. **Pick and build** (`run.py`): a repo with a pickable issue gets one build, **unless its
   base fails its checks** (an open base stop, `stops.red_base`: Stops for Stefan, Main's own
   failure): then no build starts there, said once per base head (`first: no build starts while
   main fails its checks (...)`), and the dashboard's Claude queue lists none; fix rounds,
   conflict rounds and decisions above still run. The runner
   fetches `origin/<base>`, writes a start record, then blocks on
   `t3 thread start --wait --json --worktree origin/<base> --branch claude/<slug>-<n>` with the
   brief on stdin. Afterwards it records the outcome.

**The job log** is `<state_dir>/jobs.jsonl` (`state.py`): `start`, `end` and `release` events, one
JSON object per line, each synced to disk as it's written. A last line torn by a crash is
ignored and cut off by the next write; a bad line anywhere else is an error. An end record has the thread id and link, run id, T3's exit code and
status, the branch's commits, the PR found by branch, the worktree path, `effort` (the effort
the run used, read back: `docs/usage.md`, The effort; on every Claude job's end, decisions and live runs
too) and any error.
Outcomes: `done` (exit 0, a PR found), `done-no-pr`, `failed` (exit 1), `waiting` (exit 2),
`continued` (it was waiting, and a decision's answer, or Stefan's reply on GitHub, went to
its thread as a later job), `closed` (it waited for Stefan, and its issue or PR was closed or
merged on GitHub: `docs/stops.md`, Threads that need Stefan), `usage-limit` (exit 1 on a Claude usage limit: `docs/usage.md`, Usage limits),
`branch-exists` (a local `claude/*` branch left over, so T3 couldn't make it again) and
`not-started` (T3 failed before any thread existed). Every build that got that far holds its
issue: the picker skips it until `--release`. Only `not-started` holds nothing, so the next pass
retries it.

**Fix job records** (kind `fix`, `issue` = the PR, `branch` = the PR's) add `sha` (H), `round`
and `head` (the PR's head afterwards, read from GitHub), with `commits` the ones it pushed
(`H..head`). Outcomes: `pushed` (exit 0, the head moved: Sol reviews the new head), `no-push`
(exit 0 at H: H was reviewed, so the PR waits for Stefan: a `no-push` stop),
`head-unknown` (exit 0, but GitHub couldn't say afterwards; the Sol lane still reads the real
head), `failed`, `usage-limit`,
`waiting`, `branch-exists` and `not-started`, as for builds. A conflict round's records have
`cause` `conflict`, `base` (the sha of `origin/<base>` it merged, read after the fetch; issue
#91) and no `round`; its `no-push` is a `conflict` stop, not a `no-push` one (H was never
reviewed). A continued or restarted job keeps its `cause` and `base`.

## Conflict rounds

`fix.py` and `templates/conflict.md` (ticket 15; Stefan, 2026-11-10, about leads-dashboard #153
and #154: "do it sequentially"). A PR whose head H conflicts with its base (GitHub's `mergeable`
false) and that has no blocking runner review on H gets a fix round instead of a stop: a thread
`Queue runner conflict: <repo>#<PR>`, made like any fix round (a T3 worktree at H on
`claude/fix-pr<n>-<H7>`, pushing to the PR's branch), told to `git merge origin/<base>` (merge,
not rebase: nothing is force-pushed), resolve keeping both sides' intent, run the repo's checks,
and push; or, when the two sides can't both hold, abort, comment the choice on the PR and push
nothing. Its brief has the PR, its commits and files, the base's commits since the PR left it
(the newest 30) and the earlier threads. The pushed head is reviewed by Sol afresh, as any new
head. A blocking review on H gets its ordinary fix round first.

- **One at a time** (`Fixer.resolving`): in a repo, while an open PR that had a conflict round
  (not released) isn't held for Stefan (`stops.held`: a stop, his hold...), it's on its way to
  merging, and no other PR's conflict round starts; among the rest, the lowest number goes
  first. One that conflicts again holds back only higher numbers, so two never wait for each
  other. So each resolves against the base the one before landed on. In a repo Stefan merges,
  "merged" is his merge: the next waits for it.
- **Still a stop** (`stops.conflict_stop`, filed by the Sol pass as kind `conflict`), only when
  another conflict round wouldn't help (issue #91, Stefan 2026-11-16: PRs #67 and #74 were
  stopped on a third conflict that only meant `main` had moved, with nothing to decide):
  - the newest round on H ended `no-push`, `head-unknown` or `branch-exists` and H still
    conflicts (an ordinary fix round's `no-push` is its own `no-push` stop);
  - **the base hasn't moved:** the PR conflicts again with the same base commit its last
    conflict round on an earlier head merged (that round's `base` equals GitHub's base sha for
    the PR now, `PullRequest.base_sha`), so its push didn't resolve it. A record without
    `base` (before #91), or GitHub not giving the base sha, counts as a different base;
  - **the ceiling:** after `MAX_CONFLICT_ROUNDS` (5) conflict rounds since the last release (a
    round a limit's recovery or a decision's retry or answer carried on is one round:
    `stops.rounds_counted`), the
    PR stops anyway ("5 conflict rounds, main keeps moving under it"), so a PR that never lands
    doesn't burn usage.

  A conflict after `main` moved, below the ceiling, gets another conflict round and no stop.
  `failed` and `waiting` rounds get a decision first, `usage-limit` a restart, as for any fix
  round. `--release NAME#PR` lets the PR have conflict rounds again, counting afresh. A decision that
  orders a fix on H after the stop (Stefan's reply) gets one more conflict round on H, its text
  first in the brief under `## Direction first`. A conflict stop
  filed on H before a round on H (before this ticket every conflict was a stop) doesn't count
  as the round's own stop.
- Until then the Sol lane leaves a conflicted head alone (`it conflicts with <base>: a conflict
  round (or a stop) comes first`), and the merge re-check never merges it.

**A continued job** (a decision's `retry` or `answer`): a new build or fix job of the same issue,
branch, title and H, whose start record carries the earlier job's `thread_id` and `about` (its
id), and `resume`: whether the earlier thread is continued in place or a fresh thread starts
(Usage limits, In place or fresh; the same rule). In place, the runner sends the message with `t3 thread send --wait --json`, and records the end as for
any job of its kind; a dead runner's settle finds the thread by its id. A message that never
reached a run (T3 failed and the thread isn't running) ends the new job `not-sent` (it counts for
nothing; the issue stays held), puts a waiting job back to `waiting`, and the decision
`not-started`, so the case is decided again. **A fresh thread T3 never started** (it failed
before one existed, or a dead runner's settle finds none) is the same (`Runner._uncontinue`):
the new job ends `not-started`, which holds the issue still (a build with `about` doesn't free
it) and is no newer job to the decisions (`Decider.cases` passes over `not-started` and
`not-sent`), the waiting job is `waiting` again, and the case is decided again.

## Decision threads

`decisions.py` and `templates/decision.md` (ticket 07; `orchestration.md`, Judgement). When the
fixed flow can't say what to do next, the Claude lane starts a one-off thread, `Queue runner
decision: <repo>#<n>`, in the repo's T3 project with no worktree (it changes nothing), with one
question and the state it needs: the PR and its open findings and classes from the ledger, the
issue, the job's thread link, error and commits, the thread's last 3 messages (`thread show
--messages 3`), Stefan's words since a stop, and the earlier threads' links. Each source is
clipped to 3000 characters, so a decision costs about one fresh-thread call.

**The answer** is the reply's last ```` ```queue-runner-decision ```` block: one JSON object,
`"version": 1`, `action` one the question allows, with its fields as non-empty strings. Anything
else (no block, bad JSON, another version, an action not allowed, a missing field, a thread that
failed or asked back) is a stop that says why.

| Question | When | Actions |
| --- | --- | --- |
| `approach-note` | the runner's review 3 or later of H is `approach-note` | `approach-note` (`note`, `recommend`: rework, fix on or hold): posted on the PR under `## Approach note`, then the `approach-note` stop links it; `stop` |
| `reply` | Stefan replied to a stop (the PR or its `needs-info` issue) | `fix` (`add`), `carry-on`, `hold`, `stop` |
| `failed` | a build or fix thread ended failed, nothing pushed | `retry` (`add`), `close` (`reason`, builds only), `stop` |
| `waiting` | a build or fix thread waits for an answer | `answer` (`text`), `stop` |
| `no-pr` | a build ended `done-no-pr` | `retry`, `close`, `stop` |

**Stefan's answer to an Approach note** needs no thread when his newest words (on the PR or the
issue) start with `rework`, `fix on` or `hold`: `fix on` and `rework` order one more fix round
(rework's brief says to rework the approach as the note and his reply say), `hold` leaves the PR
until `--release`. **No fourth review without it** (`stops.held`): while the runner's newest
review of the PR (on any head) is an approach note, the PR gets no review (even on a new head)
and no fix round until that note's own stop is filed and answered, by a closed issue or by a
decision after it that says `fix` or `carry-on`; another stop's answer doesn't count. The note is
written for that review even if the head has moved since. A reply not yet decided on holds the PR
too, and one reply that answers several stops is decided once (`stops.undecided_replies`).

**Settled once read:** the decision thread is settled once its answer is read, unless it asked
back (`docs/stops.md`, Settling threads).

**Acting:** `retry` and `answer` pick up the earlier job (A continued job, above): in its thread
while that's warm or cold and under 120k tokens, else in a fresh thread on the same branch
(`limits.resume_choice`; Usage limits, In place or fresh). A fresh thread's brief starts with
`## Direction first`: how the earlier thread stopped, for an `answer` the question it asked (its
last message, quoted), and the decision's message; then the job's own brief and
`templates/restart.md`. A waiting job picked up fresh ends `continued` too. A fresh start whose
brief or branch can't be made ends `restart-failed` and toasts, as after a limit; the decision
stands, so it isn't decided again until `--release`. `close` comments and closes
the issue as not planned; `fix`, `carry-on` and `hold` are read from the decision's record. A
stop goes where Stefan answers it: on a PR, the `needs-info` issue (kind `decision`, or
`approach-note`); on a build, a comment on its issue, which the build holds until `--release`; on
a waiting thread, a comment that links the thread and says a reply there is sent to it
(Threads that need Stefan, A waiting job answered on GitHub), and a toast that opens it. **Once each:** a
case is decided once (`JobLog.decided`, a release included), and after 3 decisions on one issue's
or PR's failed, waiting or PR-less jobs the next goes straight to Stefan with no thread.

**Decision job records** (kind `decision`, `issue` the issue or PR, `sha` H on a PR, `about` the
job decided on: the review, the stop, or the build or fix; `question`): the outcome is the action
taken, `reason` the text acted on, `link` the thread (an approach note: the note's comment),
`error` why an answer couldn't be read; `not-started` when T3 started no thread, so the next pass
tries again.

## Deciding an ask in T3

`ask_threads.py` and `templates/ask.md` (ticket 35; spec `.scratch/queue-runner/dashboard-live.md`).
On a stopped PR's ask (a stop of kind `review`, `approach-note`, `no-push`, `conflict`,
`failed-check` or `decision`; not a live run's), the Inbox offers **Decide in T3**: the page writes
`{"ask": <id>, "open": true}` (`control.json`'s `asks.<id>.open`, `{"at"}`; the first time stands,
and ticket 36's keys in the same record are kept). The runner starts a thread for it only on that
click, never by itself.

- **Opening** (`AskThreads.next`, `open`): the Claude lane, after a limited job and before any
  decision, takes the oldest request whose stop is still `filed` and not released
  (`JobLog.released_ids`: a release leaves a stop's outcome `filed`), in a repo it works, with
  the PR open, and starts `Decide: Queue runner ask: <repo>#<n>` (the job's own `title` has no
  prefix: `docs/stops.md`, Threads that need Stefan) in the repo's T3 project with no worktree,
  **without waiting** (`T3Cli.launch`: `t3 thread start --json` prints `{threadId, projectId,
  runId}`, read in `server.asar` 2026-11-15), then reads its link with `thread show`. Gated as a
  decision; it teaches the learned costs nothing (`measured` records only passes that made a
  Claude job of a gated kind). A stopped Claude lane or repo keeps the request and starts nothing
  until Resume. **Once per ask:** an `ask` job (`about` the stop, `sha` its H, `question`
  `reply`) ends `opened` with the thread's `thread_id`, `run_id` and `link`; T3 failing ends it
  `not-started`, and the next pass tries again. A link T3 didn't give at the start is recorded
  when the thread is next read.
- **The brief** is the ask as the Inbox writes it (`asks.ask`, from the PR read now), the PR's open
  findings and classes (`Decider._pr_part`) and the earlier threads; it tells the thread to set the
  case out with a recommendation, talk it through, change nothing, and only once Stefan has
  decided end with a `queue-runner-decision` block: the `reply` question's `fix` (`add`),
  `carry-on`, `hold` or `stop` (`question`).
- **Reading the answer** (`read_answers`, each Claude pass after the lane's switch, before
  choosing): each opened thread's newest message (`thread show --messages 1`). Nothing happens
  while it runs, when Stefan spoke last, or with no block yet; a block it can't act on is said once
  and waits for another. A readable one ends the stop `answered` with `answer` `thread`, then a
  `decision` job (`question` `reply`, `about` the stop, `sha` the PR's head now, `link` the
  thread) is acted on by `Decider.act`, exactly as a decision thread on Stefan's reply: `fix`
  orders one more round on H (`Fixer.order`), `hold` holds, `stop` files a `decision` stop.
- **An answer on GitHub meanwhile still counts:** a stop no longer `filed` (his reply, a closed
  issue, a release) or already decided is that answer's, and the thread's later block is never
  acted on. The Sol lane answers stops alongside, so each check that guards an action reads the
  stop from the job log again after every slow read that action needs (`AskThreads._now`; issue
  #84: the Sol lane answered PR #67's stop two seconds before its thread opened). `open` builds
  the brief (its GitHub reads) first, then reads the stop: answered or released after the ask was
  chosen, it gets no thread and no `ask` job, said once. Answered while T3 starts the thread, the
  `ask` job keeps the thread's id, the thread is settled, and it's said. `read_answers` reads the
  stop again after the thread and the PR, just before acting. Once the thread's answer is
  recorded, the stop isn't `filed`, so a later reply answers nothing. Decided once either way.
- **The snapshot** (`ask_threads.mark`): every ask has `decide` and `also`. `decide` is null for an
  ask that can't be opened, else `{state, at, note}`: `offered`; `asked` (the runner read the
  request: `note` says when it starts, `waits_text`: when the Claude lane or the repo is resumed,
  once Claude's current job ends, once the gate opens, or on the lane's next pass; or that T3
  couldn't start it); `open` (`go` is the thread, "Decide in T3", and `also` the needs-info issue).
  An ask answered in its thread moves to `answered` with `said` "In T3: <the decision's text>",
  `go` the thread and `also` the issue; its timeline says "You opened a thread in T3 to decide
  it." and "You decided in T3."
- **The page** (`answerAt` in `dashboard/index.html`): offered, a Decide in T3 button beside the
  needs-info link; asked, the button greyed with "You asked at ... The runner hasn't read it yet."
  until `control_read_at` reaches it, then `decide.note`; open, the thread's link and the issue's.
- `--once --dry-run` prints the ask thread it would open, with its brief.

## Live steps

`live.py` and `templates/live.md` (ticket 11; `pr-review.md`, Merge). A repo whose `config.toml`
entry has `live_doc` (leads-dashboard: `docs/agents/lovable-cloud.md`; `live_migrations` and
`live_functions` default to `supabase/migrations` and `supabase/functions`) gets one Claude thread
per batch, `Queue runner live: <repo>`, gated as kind `live` (default cost 20% of 5 hours, 5% of
the week), after decisions and before fix rounds. Merged and live are reported apart: the merge
pass says `merged`, the live run says `live` (the log, and a **Live.** comment on each PR).

- **The batch** is read from git, not handoff files: `origin/<base>` now (T) against where the
  last live run reached (R): the PRs from the first-parent subjects (`Merge pull request #N`, or
  a squash's `(#N)`), the migrations added under `live_migrations` (in file order, their
  timestamps), migrations changed or deleted (the repo forbids it: the thread is told to stop)
  and the edge functions changed. Commits with no PR (Lovable's own pushes) wait for the next PR.
- **About to land** (`LiveSteps.about_to_land`): an open merge, review or fix job in the repo, or
  an open PR whose runner review of its head is clean and that the merge re-check would merge now
  or that would once its checks pass. While one is, no live run starts (said once). A clean PR
  held for Stefan doesn't hold the live steps, whatever its checks; in a repo Stefan merges, no
  clean PR does (when he merges it is his call).
- **The Sol lane, alongside:** while a live job is open, nothing merges in that repo
  (`Merger.why_not`), so the batch stays the one the thread was given. After writing its start
  record the run reads the base and about-to-land again; a merge that landed or began since the
  batch was read ends it `not-started`, and the next pass reads the batch afresh.
- **The thread** runs in a T3 worktree at T on `claude/live-<T7>-<id6>`, never pushed, removed
  after (`.env` is tracked, so `npm run check:live-schema` runs there with plain node). Its brief:
  the live doc to follow, the PRs, commits, migrations in order, functions, migrations an earlier
  run applied, Stefan's words after the last live stop, and the fixed answer block. It may not
  ask Lovable in its chat (credits): such steps go in `stefan`.
- **The answer** is the reply's last ```` ```queue-runner-live ```` block: `version` 1, `result`
  `live`, `partial` (with `failed`) or `stop` (with `question`), `applied` (the migrations it
  applied this run), `stefan`, optional `notes`. `live` that didn't apply every listed migration
  reads as `partial`; a file it wasn't given, or anything unreadable, is `failed`.
- **First sight** is recorded before anything may hold it, so a merge after it is always a live
  run's.
- **State** is the job log, kind `live`: `sha` R, `head` T, `issue` the batch's newest PR; at the
  end `applied`, `prs`, `reason`. Outcomes: `live` (R moves to T), `partial`, `stop`, `failed`,
  `usage-limit` (waits for `resume_at`; no stop), `not-started`, and `assumed`: **on first sight
  of a repo the runner records its base's head as live**, since the steps before were Stefan's.
  A run that didn't go live keeps R; its `applied` are left out of the next run's list, and a
  `failed` or `usage-limit` run marks its batch "maybe applied", so the next thread checks each
  migration through `query_database` before running it. A migration an earlier run applied that a
  later merge edited is listed as changed (the thread stops). A `usage-limit` run's `resume_at`
  is the idle lane's `gate_until`, so a wake task is set for it. A dead runner's open live job is settled
  from its thread's last reply, like a build.
- **Stops:** `partial`, `stop` and `failed` file a `live` stop (`docs/stops.md`, Stops for Stefan) on the
  batch's newest PR; no live run starts in that repo until it's answered (issue closed or a
  reply) or `--release <repo>#<that PR>`, and one that couldn't be filed is filed next pass.
  `stefan` steps on a `live` result file a `live-todo` stop, which holds nothing.
- `--once --dry-run` prints the live run it would start, with its brief, and records nothing.

## Stefan merges

`merge.py` (ticket 17). A repo whose `config.toml` entry says `merge = "stefan"` (leads-dashboard,
since 2026-11-10; game-backdrop, since 2026-11-15) isn't merged by the runner; `merge = "runner"` (the default) is.

- **Ready:** where the merge pass would merge (the same re-check, A Sol pass, step 3, except an
  open live run doesn't hold it: his merge goes in the next batch), it labels the PR
  `ready-for-stefan` and toasts "<repo> PR #N is ready to merge", opening the PR, **once per
  head**: a `ready` job, `marked` (`failed` if the label couldn't be added: the next pass tries
  again, and the toast waits for it). A failed toast is said and left.
- **Unready:** a marked PR whose head moved, or that the re-check no longer passes (a stop, his
  hold, a reply since the clean review, a failed check...), loses the label (`ready` job `unmarked`, with `reason`); a removal that fails is tried
  again next pass. A clean review of the new head, or the hold's answer, marks it again, with a
  new toast.
- **His merge:** a marked PR gone from the open list is read once: merged, it gets a `merge` job
  `merged` (`reason` "Stefan merged it"), its label and its build and fix worktrees go and their
  threads are settled as after the runner's own merge, and the log says `Stefan merged it; its live steps follow`; closed
  unmerged, it's `unmarked` and the label goes (so a reopened PR isn't left ready). The live steps then read the merge from git as for any merge (a
  merge commit or a squash's `(#N)`; **a rebase merge names no PR**, so its commits wait for the
  next PR's batch).
- **`--inbox`** (`inbox.py`, read only; `--needs-me` until 2026-11-15): the PRs ready to merge (the re-check passes now,
  as the merge pass reads it), the `needs-info` stops filed and not answered or released,
  the builds a decision left to Stefan (until `--release`), and the threads waiting for his
  answer (a decision's `stop` on a waiting job), with their links; `Nothing waits on you.` when
  there's nothing. A repo GitHub can't read is said after the list. It prints `inbox.collect`,
  the one collection the dashboard's Inbox is written from too (`docs/dashboard.md`, The Inbox's asks).
- `--once --dry-run`'s merge lines say `would mark ready for Stefan at H` (or `ready for Stefan
  at H`) instead of `would merge`.

## Local tickets

`tickets.py` (ticket 12). A repo whose `config.toml` entry says `issues = "local"` keeps its
tickets as markdown, `.scratch/<feature>/issues/NN-<slug>.md` (its
`docs/agents/issue-tracker.md`). **No repo is local by default**; Stefan turns one on.

- **Status:** the first `Status:` line above `## Comments`, in either form (`Status: x` or
  `**Status:** x`), with or without a trailing date or note: `done (2026-11-10)`, `done.` and
  `needs-info (2026-11-10: ...)` read as their first word. Done is `done` (or `resolved`, a
  wayfinding child's done).
- **Blockers:** the numbers on the first `Blocked by:` line (`05`, `01, 02`,
  `03-sol-review-dry-run.md`, `#04`; words and dates in brackets and `None` name nothing), in
  the ticket's own feature folder. A blocker with no file blocks.
- **Picking** (`pick_ticket`): `ready-for-agent`, every blocker done, lowest number first, a tie
  going to the feature first by name. Numbers repeat across features, so a ticket is
  `<feature>/NN`. Checked on 2026-11-10 against every ticket in personal-ops and royal-bully-ops
  (128): each has a status this reads.
- **Not built:** the Claude lane skips local repos, and `--once --dry-run` only names the
  next ticket. The no-remote flow was dropped (ticket 12): queue-runner moved to GitHub and
  personal-ops is not served (Stefan, 2026-11-10).
