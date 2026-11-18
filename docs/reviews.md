# Reviews

The Sol lane: a review pass, Sol through codex-sol.sh, the Opus reviewer, and running tests inside a review.

## A Sol pass

The review loop's rules and words are `docs/flow.md`, The review loop; a served repo's
`REVIEW.md`, if it has one, says what to report.

1. **Settle.** Under `sol.lock`, a review the log shows open was cut off with its runner: it
   counts as `failed` (an Opus review's, the fallback or config.toml's, once its thread has ended: The Opus fallback). An open merge is settled from GitHub: `merged` or `failed`.
2. **Stops** (`stops.Stopper`, before merging, so a PR stopped now neither merges nor is
   reviewed; see `docs/stops.md`, Stops for Stefan).
3. **Merge** (`merge.Merger`, also right after a clean review is posted). A PR merges once the
   runner's own newest review of its head H is `clean` (a clean review that stops for Stefan is
   `stop`). Just before, it's read again: open, still at H (moved: nothing is tried, and Sol
   reviews the new head), not a draft, no Claude job writing to it, no live run open in the repo, its newest review comment
   the clean one on H, checks passed on H (`sol-review` not counted), no conflict, nothing said
   on it since that review (bots, `*[bot]`, aside) and no unresolved review thread. Why not is
   logged once. Then `PUT pulls/<n>/merge` with `sha=H` and `merge_method=merge` (a merge
   commit; Lovable syncs main), so GitHub refuses with 409 if H moved in between: `head-moved`.
   Two failed merges on H leave it until a push or `--release`. After the merge the worktrees of
   the PR's build and fix jobs are removed with their local branches (`GitCli.remove_worktree`:
   gone from `git worktree list` counts, since T3 may hold the empty folder), and one that
   can't be is said, and their threads are settled (`docs/stops.md`, Settling threads). The repo's live
   steps run later in the Claude
   lane (`docs/claude-lane.md`, Live steps). **In a repo Stefan merges** (`merge = "stefan"`), the PR is marked
   `ready-for-stefan` instead, and his merge is noticed on a later pass (`docs/claude-lane.md`, Stefan merges).
   **Merge job records** (kind `merge`): `sha` H, `head` the merge commit; outcomes `merged`,
   `head-moved`, `failed`.
4. **Adopt** (`Reviewer.why_not`): open PRs, lowest number first. The old script's labels
   (`needs-sol-review`, `sol-reviewed`) mean nothing since the cutover (ticket 13). A PR is left alone, and why is
   logged once, while a build or fix job writes to its branch, once the runner reviewed its
   head H, after two failed reviews on H (until a push or `--release NAME#N`), while a review
   comment is on H already (any of the three formats below), while H's checks are running or
   none have reported (`sol-review` isn't counted), while it's stopped for Stefan, and when a
   check failed (re-run once, then a stop: `docs/stops.md`, Stops for Stefan) or it conflicts with its base (a conflict round, or a stop:
   `docs/claude-lane.md`, Conflict rounds). GitHub failing on one PR skips only that
   PR.
5. **Review H.** Fetch `refs/pull/<n>/head` into `refs/queue-runner/pr<n>` and the PR's base
   (PRs stack: the base isn't always main); if the head moved since listing, `head-moved` and
   nothing counts. Sol reads a detached checkout at H under `checkouts_dir`, removed afterwards,
   with its dependencies linked in so it can run the tests (Sol runs tests, below).
   Its inputs are in the run folder, `runs_dir/<repo>-pr<n>-r<K>-<time>/`: `change.diff` (review
   1, or after a force-push: the whole diff, `origin/<base>...H`; later: the change since the last
   reviewed commit) and `full.diff` (later reviews), `pr.md`, `issue-<k>.md` (`issue-<owner>_<name>-<k>.md` in another repo) for each issue it
   closes with its comments, `conversation.md` (comments, review threads, review bodies, earlier
   ledgers). `evidence/`: the PR's screenshots, copied from `pr-<n>/` on the repo's
   `evidence` branch (`GitCli.evidence`; origin unreadable fails the review, so it's tried
   again, rather than reading as no screenshots); the brief's check 5 has Sol look at them and block when,
   reading only the PR, it can't see the change the ticket asked for (what build jobs are told is
   in `templates/build.md`, Screenshots). `brief.md` (`templates/review.md`) lists them, points to `AGENTS.md`, has
   `REVIEW.md` in full and, from review 2, the open findings, the classes so far, the IDs used
   and the replies since the last review. A finding's `class` names its cause, what in the code
   lets the failure happen, not the symptom: the fix brief (`templates/fix.md`, How to work) has
   the fix round write that cause in one line in its commit message, fix it, test a second case
   of it where one fits, and say why the cause can't recur when it only adjusts a value or a
   format (#135).
6. **Decide** (`ledger.py`, no I/O): the verdict and outcome come from the last `sol-findings`
   block in Sol's reply, never its prose. Clean when no Important finding is open; outcomes, in
   order: `stop` (a new Important finding in an earlier class, a closed finding reopened, a
   decline Sol kept), `approach-note` (blocking from review 3 on: there's no spend guard any
   more, so every blocking review from 3 comes to Stefan), `merge` (clean), `fix`. An Important
   finding without file, line and a scenario (or a cost and rule) counts as a nit; nits past five
   are dropped and named. No readable block: `failed`.
7. **Write.** `comment.md` (heading, Sol's prose with links made GitHub-relative, findings
   tables, notes, a visible `sol-findings` ledger of the PR's whole state, and the old script's
   hidden marker) and `decision.json` (verdict, outcome, signals, the `sol-review` status,
   follow-up issues).
8. **Post** (`post.GitHubPoster`; automated posts need no go-ahead, `docs/flow.md`, Who runs it). In
   order: each new Pre-existing finding as a `needs-triage` issue, with a hidden
   `<!-- sol-finding owner/name#N ID -->` line (an open issue with that line, the old script's
   footer for the PR and ID, or the same title is linked instead of filed again); the comment,
   linking them, its ledger recording each issue's URL (`issue`); `sol-review` on H, never the
   PR's head now; with `review_table`, a row in the PR body's `## Review` table, read afresh
   (`with_review_row`, ported from the old script). The comment is the review's record: if it
   can't be posted the review is `failed` and the PR is reviewed again. A failure after it is
   said and left. A filing that fails is marked `unfiled` in the ledger, and the next review
   files it. Issues go before the comment, as the old script did, so the comment can link them;
   a comment that fails after them leaves the issues, which the retry links by their hidden
   line. `DryRunPoster` posts nothing (`live_review.py`, `--dry-run`), and a `Reviewer` given
   it merges nothing either.

**Findings across reviews** (`decide`): Sol reuses IDs. A finding listed again under a new ID
with the same tag, class, file and line as an open or filed one, and no status given for the old
one, takes the old ID (so it's no new finding in an earlier class), and a finding listed again
is shown under Earlier findings, not as new. An earlier Pre-existing finding counts as filed
unless it's `unfiled`.

**Review numbering carries on** from the PR's comments, whichever wrote them: the old script's
and the runner's marker `<!-- sol-pr-review round=N verdict=V sha=H findings=<base64> -->`, and a
review Sol posted itself from a T3 child (leads-dashboard #168): `<!-- sol-review round=N head=H
-->`, with the verdict in its heading and the findings in its visible block. The newest review
holds the PR's whole state.

**Review job records** (kind `review`, `issue` = the PR) add `sha`, `round`, `verdict`, `signals`,
`run_dir` and `resume_at`. Outcomes: `clean`, `blocking`, `stop`, `approach-note` (H was
reviewed), `failed`, `out-of-usage` and `head-moved` (nothing counts).

## Sol, as a script sees it

- **Sol runs through `scripts/codex-sol.sh`, not a T3 thread** (`queue_runner/sol.py`). Since
  #119 a T3 thread could run it at its effort (`reasoningEffort`, `docs/t3.md`); moving it is a
  later step of #68. Checked
  2026-11-09: a thread from `t3 thread start --provider codex --model gpt-6.1-sol` ran at effort
  **low**: its rollout (`~/.codex/sessions/2026/11/09/rollout-2026-11-09T19-36-32-*.jsonl`) has
  a `configuration_update` record with `reasoning.effort: "low"`, though `~/.codex/config.toml`
  says high; T3 sends its own default, and its CLI has no effort flag. `codex-sol.sh --job
  review --effort high` logs `reasoning effort: high` in `reply.md.log`. Each run is a fresh
  Codex session with no network: Sol can't post, so the runner posts (04). Files are read-only
  except the checkout and `deps_dir` (`--write`, `--writable-root`: Sol runs tests, below).
- **A review has no outside tools, whoever reviews** (Stefan, 2026-11-17: reviews stay
  provider-agnostic). A review reads the checkout and runs its tests; it reaches no account, no
  browser and nothing outside the repo. Each reviewer's launcher holds to it, and a new one must:
  - **Sol** (checked 2026-11-17: Sol reported no MCP tools): codex-sol.sh turns off ChatGPT's
    apps and plugins (`features.apps`, `features.plugins`) and each MCP server `codex mcp list`
    shows enabled, so nothing in `~/.codex/config.toml` reaches it: not Stefan's Work Chrome
    (whose Playwright MCP lives in `~/Code/tools/browser`), not ClickUp, not the `codex_apps`
    tools that deploy sites and change settings. It fails closed (`mcp_off`; PR #127's review 1,
    F2): a list that fails, isn't JSON, holds a server it can't read or a name `-c` can't take
    ends the job with exit 1 (a `failed` review) before Codex starts, never a run with a server
    on. The list is parsed whole as JSON (`python3 -I`), never line by line, so no layout of it
    can leave a server on (review 2, F3); with no `python3` the job stops too.
    `tests/test_codex_sol_mcp.py` runs that block under Git's bash with a fake `codex`.
  - **Opus** (checked 2026-11-17: the thread found no MCP tools, even with ToolSearch): it starts
    on the T3 provider instance `[review] claude_provider` names, `claudeReviewer` in
    `~/.t3/userdata/settings.json` (`providerInstances`; back the file up first), driver
    `claudeAgent`, launch args `--strict-mcp-config --no-chrome --disallowedTools mcp__t3-code`
    (Claude's own MCP config, Claude in Chrome and T3's own tools off) and environment
    `ENABLE_CLAUDEAI_MCP_SERVERS=false` (the claude.ai connectors off). The key defaults to
    `claudeReviewer`; it can't be empty or `[claude]`'s instance (The Opus fallback). Started by name, it runs
    at `[claude]`'s model and effort, named at launch as every Claude job's are (#119), and the
    effort is read back as before.
- It runs under Git's bash by full path, through a parent bash that waits: codex-sol.sh's
  watchdog ends the run once its caller is gone. 75 minutes, then tree-killed and `failed`.
- **Out of usage** ("hit your usage limit" in `run.out` or `reply.md.log`): `out-of-usage`, and
  the Sol lane starts no Sol review until 10 minutes after the reset in Sol's rollout, else the
  time Sol names, else 30 minutes (`docs/usage.md`, Usage limits); meanwhile the Opus fallback reviews
  (below), and stops and merges go on.
- **Usage back before that** (issue #130; Stefan, 2026-11-18: a ChatGPT reset credit used on a
  week-long wait, and Opus went on reviewing): while Sol waits, the Sol lane reads ChatGPT's usage
  on every pass, whether or not a PR needs a review (`Reviewer._sol_waits`, `_sol_back`), through
  the dashboard's own reader (`snapshot.Watch`, one for both, built in `cli.main`), using its last
  reading and reading again once that's `SOL_BACK_EVERY` (5 minutes) old, whatever it said. The
  check and the read are one step under the reader's lock (`Watch.read_if_due`), so the lane and
  the dashboard never both read. A reading taken after the out-of-usage review ended, with every
  window under 99% (`sol.FULL`), ends the wait. "After" means from the second after the review's
  end stamp on: the job log stamps to the second, so a reading inside that second may predate
  the end. The wait ends with a `sol-back` record in the job log (`JobLog.sol_back`: the
  out-of-usage review's job id, the reading's time, its windows and the `resume_at` it ends),
  said once, and the next review goes to Sol. The record clears only the review it names, so no
  reader compares stamps of different precision (PR 131's review 2, F6), and a later
  out-of-usage review starts a wait of its own.
  `JobLog.sol_resume_at` reads the record, so the dashboard's wait, the wake times and a restarted
  runner agree. A window at 99% or more, a reading from before the review ran out, or a failed
  read (said once per error) leaves the wait standing. `--review NAME#N` reads it too, so
  Stefan's own review isn't refused for a wait that's over; a Reviewer made without a reader (the
  live checks, most tests) waits for the reset.

## The Opus fallback

`fallback.py` (issue #69, part of #68; Stefan, 2026-11-16: Sol was out from 15:46 to 18:36 and
every PR waited). While Sol is out of usage (`JobLog.sol_resume_at` in the future), the Sol lane
doesn't wait: a PR that needs a review gets one from a T3 thread on the Claude model
(`[claude]`: Opus 5.5), from the same review brief, posted as Sol's are.

- **Who reviews** (`Reviewer._who`, asked once a PR needs a review, after stops and merges, which
  go on while Sol is out with or without the fallback): Sol; the fallback while Sol is out, if
  the usage gate lets it (kind `review`: `docs/usage.md`, The usage gate; `Opus fallback review waits: ...`
  said once while it holds); or nobody, until the next pass. The Runner gives the Reviewer the
  fallback (`OpusFallback`, with T3, the gate and the effort); `--review NAME#N`, the live checks
  and `Reviewer`s made without one wait for Sol as before.
- **The Sol seam** (`OpusThread.review(brief, reply, workdir, out, writable)`, as
  `SolCli.review`): the brief is Sol's, after a preamble (`brief-opus.md` in the run folder) that
  says to work in the runner's checkout of H (where the dependencies are linked in), change
  nothing in the project folder, post and push nothing, and ask nothing. The thread is `Queue
  runner review: <repo>#<n>`, started and waited on through T3's MCP in the repo's project
  folder with no worktree (T3 can't start one in an existing folder), its model and effort named
  as every Claude job's are (`docs/usage.md`, The effort), always on `[review] claude_provider`'s
  no-tools instance (A review has no outside tools, above), never on `[claude]`'s or the
  project's default, which have the build's tools. That key defaults to `claudeReviewer`; empty
  or `[claude]`'s own is a config error, and a thread asked to start on either is a `failed`
  review, never one with tools (PR #127's review 1, F1). Its reply's last `sol-findings` block is the verdict
  (`ledger.decide`), as for Sol. A thread T3 couldn't start, that failed, that waits for an
  answer or that left no reply is a `failed` review (two on a head leave it, as for Sol's).
- **The label** (`fallback.label`): "Opus 5.5 high, fallback while Sol is out", with the effort
  the run used, read back (`Effort.used`), else the config's. It's in the comment's heading
  (`## Sol review N · V · <label>`, so `HEADING` still reads it) and byline, the `sol-review`
  status's description (`<label>: Clean: ...`; the context stays `sol-review`), the Review row
  (`[Review N, <label>](...)`) and `decision.json`'s `reviewer`. The hidden marker is the same,
  so the review counts as any other: **a clean fallback review merges** (or marks
  `ready-for-stefan`), and a blocking one gets a fix round.
- **The job record:** kind `review` with `reviewer` `opus-fallback` in its start record, and the
  thread's `thread_id`, `run_id` and `effort` in its end. `sol_resume_at` reads only Sol's own
  reviews, so fallback reviews never end the wait; **once Sol's reset has passed, or ChatGPT's
  reading shows usage again (Usage back before that, above), the next review goes to Sol**, and
  if Sol is still out, its `out-of-usage` starts the fallback again.
- **A runner that dies mid-review** (PR 67's review 2, F2): its T3 thread runs on, and its reply
  is never read. The next runner finds the thread by its title (`t3.find_job_thread`, as for a
  build). While it runs (or T3 can't say), the job stays open, said once in the Sol lane: that
  PR isn't reviewed (`why_not`), and the Claude lane starts nothing in any repo
  (`Runner._fallback_runs`: Stefan's rule on PR 67's review 2, kept beside #50's one job per
  repo; the Sol lane's own review now, `Reviewer.live`, still runs beside it). Once it has ended, the Sol lane counts the review `failed`, with its `thread_id`
  and `run_id`, settles its thread (#77), and whichever lane saw the end first tells the gate
  (The usage gate, Which reading). No thread found: `failed`, holding nothing. A Reviewer with no fallback (`--review`)
  leaves such a review open for the runner's. Until then the dashboard shows it as the
  reviewing lane's job.
- **Alongside the Claude lane:** the fallback runs in the Sol lane, beside the Claude lane's
  jobs, and each side's gate counts the other (PR #74's review 1, F1): the review's check counts
  the Claude jobs running (`OpusFallback.check(label, ...)`, with the Runner as its `beside`),
  and once let in it's one of the Claude jobs running for the Claude lane until it ends
  (`Runner.review_began`, `review_ended`), so a build that fits alone but not beside it waits.
  One lock (`Runner.gate_lock`) keeps each lane's check and its admission together. Each side's
  record has the other's label in `shared_with`. `--gate` counts an open Opus review among the
  jobs running and checks the review beside the Claude lane's.
- **On the dashboard:** the Sol lane's wait says Opus reviews meanwhile, a lane on a fallback
  review names Claude's model, and the work lists and the Inbox's timelines say a review was
  Opus's.

### Claude reviews every PR (`[review] provider`)

Issue #76 (Stefan, 2026-11-16: "Claude for now, until I say so, a full override"). A patch to
this runner until the TypeScript rebuild makes the reviewer role a setting (#68, #36's grill);
the key copies that role's shape, provider first.

```toml
[review]
provider = "claude"   # "chatgpt" (Sol) is the default
```

- **With "claude"**, `Reviewer._who` sends every review to the Opus thread above, whether or not
  Sol is out of usage, through the usage gate (`Opus review waits: ...` said once while it
  holds). Sol isn't asked, and its out-of-usage wait plays no part: the snapshot drops it, and
  the reviewing lane shows as Claude's (provider, name and model), so the Settings page's Who
  does what row for Review says Claude.
- **What says so:** the label is "Opus 5.5 high, set in config.toml" (`fallback.WHY`), in the
  same places as the fallback's; the job's `reviewer` is `opus-config` (`fallback.SET`); the log
  says `Opus (config.toml says so) reviews ...`; `--gate` prints `review (Opus, set in
  config.toml)`. The preamble says Opus reviews in Sol's place, not that Sol is out.
- **Reviewers with no T3 thread to start** (`--review NAME#N`, the live checks) still run Sol by
  name.
- **Back to Sol:** set `provider = "chatgpt"` (or remove `[review]`) on main; the runner restarts
  on the merge (`docs/running.md`, Restarting on new code). Any other value stops the runner at load, naming
  the key.
- **Issue #77:** a running review counts among the Claude jobs running at the `review` cost, as
  `review <repo>#<PR>` (Alongside the Claude lane, above), and its thread is settled once the
  review's end is recorded, whatever the outcome, a dead runner's too (`docs/stops.md`, Settling threads).

## Sol runs tests

`deps.py` (ticket 16). Sol can run a repo's tests while it reviews, mainly to confirm a suspected
bug with a failing test; CI still gates the merge.

- **Dependencies:** after the checkout, `Deps.prepare` links `node_modules` into it as a junction
  to `<deps_dir>/<repo>-<key>/node_modules`, installed once per key: the lockfile plus
  package.json's dependency fields (a script change reuses it). `bun.lock` installs with
  `bun install --frozen-lockfile`, as leads-dashboard's CI does (bun 1.4.4 at
  `~/.bun/bin/bun.exe`, installed 2026-11-10; `package-lock.json` is gitignored there), `package-lock.json` with `npm ci`, into a
  temp folder moved into place. A marker in `node_modules` (`.queue-runner-ready`) is checked on
  every use; gone, it installs again. The 3 most recently used caches per repo are kept. No
  `package.json`, no lockfile, no bun, or a failed install: nothing is linked, the brief says why,
  and the review goes on. The log says `dependencies installed in Ns (<repo>-<key>)` or
  `cached`.
- **`git worktree remove --force` follows a junction and empties its target** (checked
  2026-11-10), so `GitCli.remove_checkout` unlinks `node_modules` first (`Deps.unlink`).
- **The sandbox:** Codex's read-only sandbox stops vitest at once (EPERM writing
  `node_modules/.vite-temp`), so a review runs `codex-sol.sh --write`, with a
  `--writable-root` for each of the cache's `node_modules/.vite-temp` and `.vite`
  (`Prepared.writable`): Codex's workspace-write sandbox, the checkout and those two writable,
  the installed packages not (checked: writing into one is denied), the network off. codex-sol.sh
  adds a Files rule (write only there) and puts fnm's default Node first on PATH
  (`$FNM_DIR/aliases/default`), since the runner starts without fnm's shell PATH.
- **The sandbox user reads the cache through `~/.queue-runner`'s inherited ACL**
  (`CodexSandboxUsers` RX). An install folder made with `tempfile.mkdtemp` gets an owner-only ACL
  on Windows and can't be read (vitest "not recognized", EPERM on stat), so it's `os.makedirs`.
- **Temp folders Sol's tests leave can't be deleted by Stefan** (ticket 45, 2026-11-16). Codex's
  sandbox has no writable `%TEMP%`, so Sol sets `TEMP` to `<checkout>/.review-tmp` itself; a
  folder made there with `mkdtemp` is owner-only, owned by the sandbox user, and Stefan's account
  can neither delete it nor take it over without admin. `git worktree remove --force` then
  unregisters the checkout but leaves its folder, and the next review's `worktree add` refused
  the path (PR #4's and PR #6's failed reviews). So: **this repo's tests clean up every temp
  folder they make** (`TemporaryDirectory` with `addCleanup`; `tests/test_no_temp_leftovers.py`
  fails on a bare `mkdtemp(`), and a checkout git can't delete is moved aside to
  `<checkout>.stale-<time>` (`GitCli.remove_checkout`, also at the next `checkout`), so the
  review goes on. Before each checkout `GitCli.sweep_stale` deletes the folders moved aside
  where it can; the log says once of each it can't. Pointing Sol's `TEMP` elsewhere wouldn't
  help: a folder the sandbox user makes is owner-only wherever it is. Clearing one by hand needs
  an elevated shell: `takeown /f <folder> /r /d y`, `icacls <folder> /grant Anon:(OI)(CI)F /t`,
  then delete it.
- **The brief** (step 4, `review._tests`) tells Sol what it can run: `npm test`, a failing test it
  adds, each command named with its summary line quoted; a failure the change doesn't explain
  (Windows only) is no finding. leads-dashboard's `src/test/callsling-relay.test.ts` has one
  test that fails on Windows outside any sandbox too (EPERM removing its temp folder).
