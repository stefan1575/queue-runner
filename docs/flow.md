# The flow

The rules the runner carries out. The other docs say how each part does it.

## No AI waits

No AI turn is spent finding out whether it's time yet. A thread the runner starts doesn't
schedule, watch a PR, set a wake-up or poll. Waiting is the runner's job: for a reset, checks, a
blocker or a reply. A script may poll GitHub and files as often as it likes, because that costs
no tokens. Every fixed step is the script's; an agent is started only for work that needs one.

## The runner

- One `pythonw` process, started at logon. T3 Code stays open, because the runner uses its server
  through the `t3` CLI.
- **It serves** the repos in `config.toml`. In a repo Stefan merges, a clean PR waits for him;
  in the others, the runner merges it. When this repo's `main` moves, the runner updates its
  checkout and restarts on the new code between jobs (`docs/running.md`, Serving itself).
- **It runs the fixed flow:** it picks the next ticket, starts each job as a fresh T3 thread,
  reads the outcome, runs the review loop (below), merges, and files stops.
- **What it picks:** open issues labelled `ready-for-agent` whose `Blocked by:` issues are all
  closed (GitHub issues, or `.scratch/*/issues/*.md` in repos that keep issues locally), lowest
  number first. Writing specs and tickets stays in Stefan's own sessions; each ticket is small
  enough to finish inside one 5-hour window.
- **Judgement:** a case the flow doesn't cover gets a one-off Claude decision thread. It gets one
  narrow question and the state, and answers in a fixed format the runner acts on, or in a
  `needs-info` stop for Stefan. There's no resident orchestrator thread.
- **One Claude job and one review job at a time.**

## Labels

Every label a runner applies, removes, reads or creates. `tests/test_labels_doc.py` collects
them from where they're used (each `add_label`, `remove_label` and `create_issue` call, each
`.labels` check, each label query, the app's `RUNNER_LABELS`) and fails when this list and the
code disagree.

- `ready-for-agent`: the ticket is fully specified; the runner may pick and build it. Read, never
  applied: the work list and the picker only take an open issue that has it.
- `needs-info`: a stop waiting on Stefan, one issue per PR (`docs/stops.md`), and a base branch
  failing its checks. Applied when the runner files the issue.
- `needs-triage`: a Pre-existing review finding filed as its own issue, for Stefan to sort
  (`docs/reviews.md`). Applied when the runner files the issue.
- `ready-for-stefan`: a clean PR in a repo Stefan merges (`merge = "stefan"`), waiting for his
  merge (`docs/claude-lane.md`, Stefan merges). Applied by the merge pass, read back so it's put
  on once, and removed once the PR is no longer clean, is merged or is closed.
- `ready-to-merge`: only created, by the app, in a repo it serves (`docs/app.md`, Served),
  with `ready-for-agent` and `needs-info`. Nothing applies or reads it yet.

## Briefs are built, not kept

- **No handoff files.** For each job the runner fills a brief template (`queue_runner/templates/`)
  from sources that keep themselves current: the issue, the branch, the PR (its review comments
  and ledger, the `sol-review` status), and T3 (an earlier thread's link, status and last
  messages).
- **Commits are the notes.** A Claude job commits after every step, with the decision in the
  commit message, so a thread cut off by a limit loses at most one step.
- **Worktrees:** each Claude job runs in its own T3 worktree. A build branches from `origin/main`
  as `claude/<slug>-<issue>`; a fix round starts from the PR's head and pushes to its branch. The
  runner removes the worktree after the merge.

## Limits

- **Don't start what won't finish.** Before a Claude job, the runner reads Claude's 5-hour and
  weekly windows and the job kind's expected cost, learned from its own before-and-after records.
  If the job won't fit in the 5-hour window, it waits for the reset (`docs/usage.md`).
- **The weekly reserve:** part of the week stays unspent for Stefan until shortly before the
  weekly reset; after that the queue may spend it. Stefan can change the reserve or pause the
  queue.
- **Reviews aren't gated;** a review waits only on a real limit.
- **A limit mid-job:** the runner waits until after the reset and starts a fresh thread from the
  template brief plus the old thread's link and last messages, continuing the old thread only
  when it's small. After a reset the prompt cache is cold, so continuing re-reads the whole
  thread at the uncached price. A review always restarts fresh on the same commit. T3's own
  "Resume after usage limits" stays off: it would race the runner.
- **Sleep:** the PC sleeps when idle. For each resume time the runner sets a one-off Windows
  wake.

## Notifications

- **The runner's stops** are a native Windows toast under the runner's own name and icon;
  clicking it opens the stop's `needs-info` issue.
- T3's thread notifications cover only threads that finish or need Stefan.

## The review loop

### Who runs it

- **Every PR gets reviewed, whoever opened it.** The runner adopts every open PR without a clean
  review on its newest commit, whichever session, cloud session or tool opened it.
- **Each review is a fresh thread on the reviewer model in `config.toml`, never a message to an
  earlier one. Fixes are a fresh Claude thread** in the PR's worktree. One writer per PR at a
  time.
- **Automated posts need no go-ahead:** reviews, statuses, `needs-info` and follow-up issues,
  and merges go out on Stefan's GitHub account. A message to a person still needs one.

### A round

1. **Rebuild the state from the PR** (its review comments and ledger) before acting. Handle a
   failed check or a human reply first; a conflict with the base gets a conflict round (Claude
   merges the base in and pushes), one conflicted PR at a time, oldest first. Otherwise wait
   until checks on the newest commit pass, not counting the `sol-review` status.
2. **Review one exact commit,** the head H. The brief gives H, the ticket and the PR's comments,
   the repo's `AGENTS.md` and relevant docs, `REVIEW.md` if there is one, and earlier findings,
   classes and declines. Review 1 reads the whole diff; later rounds read what changed since the
   last reviewed commit, with the whole diff for context. The reviewer may post on the PR, set
   statuses and file issues, but not edit code.
3. **Three tags:**
   - **Important** blocks. It needs file:line and a concrete failure, or a documented rule the
     change breaks. So is a screenshot that shows the screen wrong; shots that are missing or
     not enough for someone reading only the PR to see the change are a nit
     (`templates/build.md`, Screenshots: what a screenshot is for, and when there are enough).
   - **Nit** is optional, at most five, and needs no fix round.
   - **Pre-existing** becomes a linked `needs-triage` issue, unless it loses or exposes data,
     which makes it Important.
4. **Post the review with a ledger** (a fenced `sol-findings` JSON block): round, H, a stable ID,
   tag and class for each finding, its evidence, and the status of every earlier finding:
   `fixed`, `open`, `decline-accepted` or `decline-kept` (one not mentioned stays open). Reuse
   IDs; don't repost an unchanged finding as new. **Clean means no Important finding is open**,
   worked out by the runner from the ledger, not from the reviewer's say. A review without a
   readable ledger failed. Set the `sol-review` status on H, never on a newer commit.
5. **Blocking:** the fix thread fixes every case of each Important class on the PR's branch, with
   a failing test first where it fits, or declines a finding on the PR with its ID, the reason
   and evidence. A class names the cause (what in the code lets the failure happen), not the
   symptom, so the fix removes the cause: its commit message says the cause in one line, a
   second case of it gets a test where one fits, and a fix that only adjusts a value or a format
   says why the cause can't recur. The reviewer reconsiders a decline once. Then the new head is reviewed.

### Stops

A stop comes to Stefan:

- a new Important finding in the same class as an earlier one;
- a fixed finding reopening;
- a decline the reviewer keeps;
- a failed check; a conflict a conflict round couldn't resolve, or a PR's third conflict;
- review 3 still blocking. A Claude decision thread posts an **Approach note** first: is the
  approach wrong, what would change, and rework, fix on or hold? No fourth review without
  Stefan's answer.

Each stop is recorded on the PR and in one `needs-info` issue per PR, and toasted
(`docs/stops.md`).

### Merge

A clean review on the newest commit, checks passed on it, nothing open. Just before merging, the
runner reads the PR again: the head is still H, its checks passed on H, and no discussion is
open. If the head moved, it's reviewed again. The merge names the expected head (`sha=H`, a merge
commit). A repo's live steps that need an AI run in one Claude thread per batch, once no other
merge is about to land, so chained migrations go live in order. Merged and live are reported
separately.
