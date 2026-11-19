# Stops and threads

Stops for Stefan, and how the runner settles, prefixes and refreshes the T3 threads it started.

## Stops for Stefan

`stops.py` (`docs/flow.md`, Stops). Each Sol pass, for every open PR (not one a Claude job
is writing to), the runner looks for stops on its head H, and
files each kind once per H (`JobLog.stopped`). The kinds: `review` (the runner's review of H
stopped: a repeated class, a reopened finding, a kept decline; the reason is decide()'s text from
the run folder's `decision.json`), `no-push` (a fix round on H ended without pushing),
`failed-check` (only once a re-run failed too: A failed check is re-run once, below) and
`conflict` (only once a conflict round couldn't resolve it, the PR conflicts
again with the base its last round merged, or after 5 conflict rounds: `docs/claude-lane.md`, Conflict rounds). A review that stops files right after it posts. Two kinds are
filed by decisions in the Claude lane: `approach-note` (review 3 or later still blocking, filed
with the Approach note; the Sol pass files it again from the decision's record if filing failed)
and `decision` (a decision thread's question on a PR). Live runs file `live` and `live-todo` on a
merged PR (`docs/claude-lane.md`, Live steps).

**Filing** (automated posts, no go-ahead): the PR's one open `needs-info` issue, found by its
hidden `<!-- queue-runner needs-info owner/name#N -->` line, gets the stop as a comment; with
none open, one is filed (`PR #N needs Stefan: <title>`). Then a comment on the PR records the
stop and links the issue (`<!-- queue-runner stop kind=K sha=H issue=I -->`; `ledger.runner_post`
keeps it, like the reviews, from counting as a reply), then a toast. An issue that can't be filed
makes the stop `failed`, and the next pass files it; a failed PR comment or toast is said and
left. **Stop job records** (kind `stop`, `issue` = the PR): `stop` (the kind), `sha` H, `link`
the issue, `reason`; outcomes `filed`, `answered` (with `answer`: `issue-closed`, `replied`, `thread` when
Stefan decided it in its ask thread: `docs/claude-lane.md`, Deciding an ask in T3, or
`pr-closed` when its PR was merged or closed on GitHub: below) and `failed`.

**Left alone until Stefan answers:** while a stop is `filed`, the PR gets no review (even on a new
head), no fix round and no merge (`stops.held`). It's answered when its issue is closed or someone
(not a bot, not the runner's own posts) says something on the PR or on that issue after the
stop; `--release NAME#PR` lets it go too. **Its PR merged or closed on GitHub** (issue #88:
Stefan merging or closing it without deciding left the stop, and its ask thread's "Decide: ",
there for good) answers it too, `pr-closed`: each of its `needs-info` issues still open gets a
one-line note (hidden `stop pr-closed pr=N` line, so a retry doesn't post it twice) and is
closed, completed for a merge and not planned for a close, and only then is the stop recorded,
so GitHub failing leaves it `filed` for the next pass. An issue he closed himself still reads
`issue-closed`. `live` and `live-todo` stops sit on merged PRs by design, so a merge never
answers them, and an issue one of them shares is left open (no note): closing it would answer
that live work without Stefan. Answers are read at the start of each Sol pass. A
closed issue puts the PR back in the loop; a reply holds it until a decision acts on what it asks
(`docs/claude-lane.md`, Decision threads). Every comment the runner posts outside a review carries a hidden
`<!-- queue-runner ... -->` line (`ledger.RUNNER_MARK`), so none counts as a reply.

**Main's own failure** (issue #98; `Stopper.base_pass`, `hold_for_base`; on 2026-11-16 a red
`main` stopped PRs #87 and #95 for Stefan one by one, each failing only main's broken test, and a
build started from it). Each Sol pass, before any PR's stops, the runner reads the checks on the
head of the repo's base (`base` in config.toml, `GhCli.branch_head`). Then, for a PR into that
base with a failed check on H, before #93's re-run (re-running what main fails wastes a run): when
**every** check that failed on H fails on the base too, by name, the failure is the base's. The PR
gets no stop and no re-run, and is held on H (a `base-hold` job, `held`, its `reason` the checks;
the log and the Sol lane's line say `not now, main fails tests too`). The repo gets **one** stop
instead, the first time the base is seen red: a `needs-info` issue "main fails its checks" (the
failing checks, the base's head, its Actions runs; hidden line `stops.base_mark`), a toast, and a
`base` job (`issue` null, `branch` the base, `sha` its head, `link` the issue, `signals` the
failing checks), `filed` (or `failed`, filed next pass). A second PR held by the same red base
files nothing. While it's `filed`, or `failed` to file (PR #110's review 1, F4: the red base
holds builds whether GitHub took the issue or not), no build starts in the repo (A Claude pass,
step 5). **A hold is checked again each pass** while the base is red (F1): a check failing on H
that the base doesn't fail ends it `own-failure` (#93's re-run, then a stop, follow), and
nothing failing on H any more ends it `cleared`. Each pass judges H's failures as they are now
(review 2, F5): once its own failure passes its re-run and H fails only what the base fails,
it's held again. **It
resolves itself, so no ask thread opens for it:** once the base's checks pass, each PR still at
its held head is brought up to date with GitHub's update-branch (`PUT pulls/<n>/update-branch`
with `expected_head_sha`, as `gh pr update-branch`; no AI): `updated`, and it goes through checks
and review as usual; GitHub refusing (HTTP 422: a conflict) is `update-failed` and left to the
conflict round; any other failure (GitHub down) keeps the hold, tried again next pass (F2); a PR
with a Claude job writing to its branch (`JobLog.writer`) waits for that job to end (F3); a PR
that moved or closed meanwhile is `moved`. Holds are read apart from the stop, so they're tried
again after it's closed, and a stop whose issue never filed is closed with nothing posted. Then the runner comments on the issue,
closes it as completed (`closed`, `head` the passing commit), or tries again next pass if it
can't. A base with no checks reported yet isn't red; one whose new head is still running its
checks, with the stop open, counts its last failing checks. A check that fails on H but passes on
the base (or a PR failing more than the base does) is the PR's, and stops as below. A stacked PR
(into another branch) is never compared. The Inbox lists the base stop once, as `broken`, on its
issue (`base-<job>`), holding up the held PRs and every new build.

**A failed check is re-run once** (issue #93; `Stopper.retry_checks` and `_failed_check`;
game-backdrop PR #18 was stopped on 2026-11-16 by `actions/checkout` failing with `Repository
not found`, and attempt 2 of the same run passed untouched). Each Sol pass, before looking for
stops, a failed check on H whose failures are all GitHub Actions check runs
(`Checks.runs`: the run id from the check run's `details_url`, app `github-actions`) gets its
failed jobs re-run (`POST actions/runs/<id>/rerun-failed-jobs`, as `gh run rerun <id>
--failed`), **once per run and head** (PR #105's F1: a run that fails after another's re-run
passed gets its own): a `rerun` job per run on H (`runs` the run's id, failed attempt and URL;
`reason` that run's own failed checks, `Checks.by_run`, so its pass or its stop names
only them: F5), its start record written before GitHub is asked, so one a dead runner left
open is settled from the run (F2: moved past that attempt, `rerun`; else `not-started` and asked
again). Meanwhile it's no stop and Sol waits for the checks as for pending ones. It's a
`failed-check` stop when a re-run's attempt has ended and its conclusion isn't a pass (the run's
own `status`, `run_attempt` and `conclusion`, read from `actions/runs/<id>`, since check-runs can
list the old failure for a while after the re-run passed: F4); at once when a failure is a commit status or
another app's check (they can't be re-run), when the run is already past attempt 1 without the
runner's re-run (re-run by hand), or when GitHub refused the re-run (`rerun` job `failed`, so it
never loops). Any step counts, not only checkout: a real failure fails again a few minutes
later. **A pass on the re-run is said on the PR** once, in one line linking the run's failed
attempt (`.../actions/runs/<id>/attempts/<n>`), under the runner's mark, so a flaky check stays
visible; the job ends `passed` only once the comment is on the PR (F3: a post that fails is
tried again next pass, and one already there, by its hidden `rerun passed sha=H run=N` line,
isn't posted twice). A new head gets its own re-run. The PR's timeline and the
activity list say each.

**A failed check is checked again once the base moves** (issue #199; `Stopper.recheck`,
`_after_update`; on 2026-11-19 one flaky test, fixed on main in #198, stopped #188, #191 and #196
as `failed-check`, and `--release` only re-ran their old checks, which test the old merge commit
and failed again). A `failed-check` stop records `base`, the head of the PR's base when it was
filed (`branch_head`; None if GitHub didn't say). Each Sol pass, first in a PR's stop check, a PR
whose open stops are all `failed-check`, the newest on its head H, with its base's head B now
not the stop's `base` (a stop filed before #199 has none, so counts as moved, as a conflict
round's record without one does), is brought up to date with its base: GitHub's update-branch
with `expected_head_sha` H, as for a base hold. A `recheck` job (`sha` H, `base` B, `about` the
stop, `link` its issue), **once per PR and base head**, so a PR failing on every main never
loops. **Left alone, said once each:** another kind of stop open on the PR (Stefan's anyway),
the PR moved from H, a Claude job writing to it (`JobLog.writer`: waits for that job), a
conflict (`has_conflict`: the conflict round's, as today), the repo's base red (the base hold's,
above), or B already the stop's base or a recheck's. GitHub refusing (HTTP 422) is
`update-failed`, left for Stefan; GitHub not answering is `not-started`, tried again next pass.
Then `updated`, and the stop still holds the PR while **the new head's checks** run: once they
pass, the stop's `needs-info` issue gets a comment (main moved, the checks pass on the new head;
hidden `recheck passed pr=N sha=H'` line, so a retry doesn't post it twice) and is closed as
completed (left open if a stop of another kind shares it), the PR's open `failed-check` stops
end `answered` with `answer` `passed-after-update`, the recheck `passed` (`head` the new head),
and the PR goes back to review. A comment or close that fails is tried again next pass. A check
failing on the new head is the new head's like any: #93's one re-run, then a `failed-check` stop
on it (recording B), which ends the recheck `failed-again`, so Stefan sees only a failure that
survived the fix. The Inbox doesn't list a stop settled so as answered (it's the runner's, not
his), and the PR's timeline says each step as the runner's.

**Toasts** (`toast.py`): a native Windows toast under the runner's own name and icon. The runner
registers its AppUserModelID `Stefan.QueueRunner` under
`HKCU\Software\Classes\AppUserModelId\` (display name "Queue runner", `IconUri`
`queue_runner/assets/icon.png`, drawn by `scripts/make_icon.py`), then Windows PowerShell shows
the toast through WinRT's `CreateToastNotifier(<that id>)`, hidden; Windows shows the registered
name and icon, not PowerShell's. The toast is `activationType="protocol"` with the URL as its
`launch` (and its one button), so a click opens it with no activator. Checked live on
2026-11-10: a test toast showed as "Queue runner" with the icon. A stop's toast opens its
`needs-info` issue. A build or fix thread that exits waiting for an answer (exit 2) gets a
decision first; only when its question is Stefan's does it toast, opening the thread, because
T3's own notifications stay off (below). Tests use a fake
toaster; `Runner` and `Reviewer` default to `NoToaster`, and the CLI passes `WindowsToaster`.

**T3's thread notifications stay off** (`notificationMode` in `~/.t3/userdata/client-settings.json`).
Checked 2026-11-10 in the app's client code (`resources/server.asar`, the notification gate):
it notifies on every completed thread ("Thread completed") and on every thread that needs
attention (input, approval, usage limit, failure), for all threads not archived or hidden; only a
thread whose run Stefan stopped skips the completion one. There's no setting to limit them to
threads that need Stefan, so the runner toasts instead.

## Settling threads

`t3_mcp.py` and `t3.settle_quietly` (ticket 70; spec #68). The runner settles the threads it
started once it's done with them, so they leave Stefan's sidebar. It never settles a thread it
didn't start: only ids from its own job records.

- **When:** a build, fix or conflict thread once its end is recorded (`Runner.finish`,
  `finish_fix`, so a dead runner's settle too), whatever the outcome except `waiting`; a decision
  thread once its answer is read (`Decider.run`), unless it asked back (exit 2); an Opus
  review's thread (the fallback or config.toml's) once the review's end is recorded, whatever
  the outcome, one that asked back too, since nobody answers it (`Reviewer._settle`, issue #77),
  and a dead runner's once the Sol lane counts it failed (`Reviewer.settle`); and at a merge
  (`Merger.after_merge`: the runner's, Stefan's, or one cut off with its runner), every thread
  the runner started for the PR (`JobLog.pr_threads`: its builds and fixes, the decisions on it
  or on one of those jobs, its Opus fallback reviews), the latest point one can still be open:
  so one that waited, asked back or whose settle failed goes then (review 1's F1). **An ask
  thread, and a job whose question waits on Stefan,** are settled once they no longer need him
  (Threads that need Stefan, below), or once their prompt cache expires (A stale waiting thread,
  below); an ask thread never at a merge (a decision acted on from
  one carries its id). **Not settled:** live threads.
- **A settled thread stays readable:** `thread show` and `thread list` still give it and its
  messages (checked live 2026-11-16), so decisions and restarts read its last reply as before.
  **A message to a settled thread unsettles it** (T3's `thread.unsettled` on a new turn,
  `server.asar`): a retry or a limit's resume in place shows it again, and its own end settles
  it again.
- **A failed settle** is said (`<job>: settling its thread <id> in T3 failed (...); left as it
  is`: one Stefan archived is refused too, and isn't in the sidebar) and never raised: no lane
  stops on one, and nothing retries it but the merge.
- **The interface:** `T3Cli` gains `settle` and `rename` (#71's, below), which go to its `mcp`, a
  `t3_mcp.T3Mcp` (`cli.main` passes one; with none they raise `T3Error`). Everything else stays
  on the CLI. `--review` and `--dry-run` get no MCP client and settle nothing.

### Threads that need Stefan

`prefixes.py` (issue #71; spec #68). While a runner thread needs Stefan, its title says so, so
the sidebar tells him at a glance what's his to do. Only two prefixes (everything else is
settled), and only on threads the runner started (ids from its job records):

- **"Decide: "** on an ask thread (`docs/claude-lane.md`, Deciding an ask in T3) while its stop is `filed`, not
  released and not decided (`waiting_on_stefan`). `AskThreads.open` launches it with the prefix;
  the job's own `title` stays plain.
- **"Answer: "** on a build or fix thread whose question a decision left to him (the `waiting`
  question's `stop`: the Inbox's "Threads waiting for your answer"), while the job is still
  `waiting` and not released. Answered in the thread and asking again, it keeps the prefix.
- **Off, and settled,** once it no longer needs him: decided in the ask thread or on GitHub (a
  reply, a closed issue), answered in the thread or on GitHub, or `--release`d. A thread a later
  job carries on (his answer sent to it) waits for that job: its end settles it, or its own
  question to him prefixes it again.
- **A waiting job answered on GitHub** (`waiting.py`, review 1's F1): its stop comment (on the
  build's issue or the fix round's PR) says to answer in the thread or there. Each Claude pass,
  after the lane's switch and in the repos the lanes work, the runner reads each such job's issue
  or PR. **His reply** after the question was put to him (bots and the runner's own posts aside)
  is sent to the thread, quoted, as a continued job (in place or fresh, gated as the job's kind,
  after a limited job and an ask thread and before decisions); the job ends `continued` with
  `reason` `github` and `answer` the newest reply's time, so a reply goes once and the next
  question waits for words after it. **The issue closed, or the PR merged or closed,** ends the
  job `closed` (`reason` says which). GitHub failing is said once per job and read again next
  pass.
- **`Prefixes.sync`** runs in each Claude pass right after settling, before the build order and
  the lane's switch (so titles are kept right while a dead runner's job runs on, and while the
  Claude lane is stopped, as renaming isn't a job), and again after the ask threads' and
  GitHub's answers are read. It works from the job log and the title T3 gives now (`thread list`, once per repo,
  only for a repo with a thread to change): `titled` strips any prefix before adding one, so a
  prefix is never doubled, and a restarted runner puts right what an earlier one left (an ask
  thread opened before #71 gets its prefix). A thread still running keeps its prefix until its
  run ends. A rename or settle that fails is said once (`<job>: renaming its thread <id> in T3
  failed (...); tried again next pass`) and tried again next pass; nothing stops on one. What's
  in order is remembered for the process, so a quiet pass calls T3 for nothing.

### A stale waiting thread

Issue #72 (spec #68). A thread that needs Stefan goes cold once its prompt cache expires: answering
it then re-reads its whole context uncached.

- **Stale** (`limits.stale`): T3 says when the thread's prompt cache expires, and that time has
  passed. T3's CLI doesn't show it; `T3Store.cache_expires_at` reads the newest
  `tokenUsage.promptCacheExpiresAt` on the thread's rows in `orchestration_v2_projection_provider_turns`
  (T3 sets it on a Claude turn as its request's start plus the cache's TTL, an hour: read in
  `server.asar` 2026-11-16, where T3's own idle compaction reads it too;
  `tests/fixtures/t3/provider-turn-claude.json` is a real row). **No expiry reported is never
  stale.**
- **Settled** (`Prefixes.sync`, each pass): a "Decide:" or "Answer:" thread that is stale and not
  running is settled, keeping its prefix; its Inbox item stays (the job log doesn't change), and
  the log says `<job>: its prompt cache expired at ..., so its thread <id> is settled; ...`. One
  Stefan writes in again (T3 unsettles it) is settled again only once its new cache expires.
- **The Inbox** (`ask_threads.mark`, from the snapshot's `stale`: `Snapshots._stale`, the
  runner's `T3Store`): a stale item's `decide` is `{state: "stale", label, note}` (Decide in a
  fresh T3 thread, or Answer in a fresh T3 thread), then `asked` once clicked, then `open` on the
  fresh thread. A fresh (not stale) item is as before: an ask thread opens itself, and a thread
  waiting for his answer has `decide` null and its own link. The page posts `{"ask": <id>,
  "fresh": true}` (`asks.<id>.fresh`, `{"at"}`, the latest click standing; `Switch.fresh`).
- **The fresh thread** (`AskThreads.next`, `open`; gated as a decision): only for a request made
  after the newest thread on that ask was opened, and only while that thread is stale (one that
  isn't is said once and left). An ask on a stop gets a new `ask` job with the ask's brief plus
  `templates/stale.md` (the cold thread's link and its last 3 messages, as a limit restart
  carries them); the newest ask thread on a stop is the one read and prefixed, and the cold one's
  "Decide: " comes off. **A thread waiting for his answer** gets a conversation thread with no
  worktree, `Answer: Queue runner answer: <repo>#<n>` (an `ask` job `about` the waiting job,
  `question` `waiting`, `resume` `{how: fresh, after, cold, why}`), briefed with the question,
  the job's sources, the cold thread and `templates/answer.md`; its `answer` block (`text`) is
  sent to the waiting job (`AskThreads.reply`, `Runner.continue_job`, in place or fresh by the
  same rule, gated as the job's kind), which ends `continued` with `reason` `thread`. Not the
  build itself restarted fresh: that would spend a whole reorienting run before Stefan said
  anything, and its turn would end `done` or `no-push`. A GitHub reply read in the same pass
  goes first (`waiting.py`), and the fresh thread's block is then never read; so is one read in
  the pass GitHub ends the job `closed` (its issue closed, its PR merged) or after a release:
  `AskThreads.reply` checks the job log again before it hands the answer on (review 1's F1).
- `--once --dry-run` prints a fresh ask thread's brief too, but reads no expiry (none is stale).

**The token.** T3's MCP endpoint (`<origin>/mcp`, the origin read from
`~/.t3/userdata/server-runtime.json` on every call) takes only an MCP client session: subject
`mcp-client`, a bearer token. Its access is its runtime-mode ceiling, and T3 refuses a write to
any thread whose mode is above it (`runtime_mode_escalation_denied`). Every runner thread is
`full-access` (the CLI's own session is). Read in `server.asar` and checked live on 2026-11-16:

- **`t3 auth session issue --subject mcp-client`** (the issue's first plan) makes a session with
  no ceiling, which T3 reads as `approval-required`: it can read threads, but it **can't settle,
  rename or send to a runner thread, and can't launch a `full-access` thread**. Not used.
- **So the runner signs in as an outside MCP client** (`T3Mcp._mint`): `t3 auth pairing create`
  with the full-access scopes (`orchestration:read`, `orchestration:operate`, `settings:write`,
  `source-control:write`) for 5 minutes gives a one-time code; then `POST /oauth/mcp/register`
  (a client named `Queue runner`), `POST /oauth/mcp/decision` with `{_tag: "pairing-code",
  access: "full-access", code}`, and `POST /oauth/mcp/token` with PKCE. That session is
  `full-access`, good for 30 days (`MCP_CLIENT_SESSION_TTL`), labelled `Queue runner` in `t3 auth
  session list`: the access the CLI mints for itself on every `thread` call. **It can launch
  `full-access` threads** (`t3_thread_launch` with `runtimeMode: full-access`, checked live), so
  the TypeScript rebuild can use it for everything.
- **Kept in memory only:** never in a log, a record or a file. One per runner process, minted on
  the first settle; T3 refusing it (401) mints another, once. After each sign-in the runner
  revokes its older `Queue runner` sessions, so restarts don't pile them up (a second process,
  `--once`, then signs the first out, which signs in again on its next settle).
