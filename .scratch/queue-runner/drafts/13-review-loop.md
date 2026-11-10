# Review loop

Every PR, whichever session built it (local, cloud, Lovable or the queue runner's build thread), is
reviewed by Sol before it merges, and only by Sol: a session never reviews its own work (spec
#137). Since 2026-11-10 the loop is run by the queue runner on Stefan's PC
(`stefan1575/queue-runner`, a script with no AI in it): it adopts every open PR without a clean
review on its newest commit, starts each Sol review and each Claude fix round, and posts each
review, status, follow-up issue and stop itself. Sol posts nothing; a Claude build or fix thread
it starts only pushes, opens its PR, and comments a decline or a question for Stefan. **The exception:** a PR whose newest review on its head isn't the
runner's (one from Stefan's own session, the old script or the orchestrator) gets no review and
no fix round from it; it stays with Stefan until a new commit is pushed. Its
global rules are Stefan's `~/.claude/docs/pr-review.md`, outside this repo. `~/sol-pr-review.py`,
the label script that ran the loop before, and the T3 Code orchestrator that ran it from
2026-11-07, are retired; their labels (`needs-sol-review`, `sol-reviewed`) mean nothing now.

This doc defines the loop's words and this repo's parts of it.

## Words

- **Review N**: Sol's Nth review of a PR, one Sol call covering spec and standards together,
  posted as a `## Sol review N · Clean` (or `· Blocking`) comment. A failed review isn't
  counted. The comment's hidden marker calls it `round=N`; that is the only place "round" means
  a review.
- **Fix round**: the work between review N and review N+1, done by a fresh Claude thread the
  runner starts: fix or decline each open Important finding, and push to the PR's branch.
- **Important**: a finding that blocks the merge. It needs a file and line, plus either a
  failure scenario concrete enough to become a failing test, or a named later cost and the rule
  it breaks. One without that evidence counts as a Nit, and the comment says so.
  What counts as Important in this repo, what never to report and what to always check are in
  `REVIEW.md`, which Sol reads in full on every review.
- **Nit**: never blocks; fixing it is optional. A review keeps the first five and names the
  ones it dropped.
- **Pre-existing**: a problem in code the PR didn't change. The runner files it as a
  `needs-triage` issue, linked from the review comment, once per finding ID; it doesn't block.
  One that loses or exposes data is tagged Important instead.
- **Class**: the kind of problem a finding names ("write made outside the app logged wrongly").
  A fix covers every case of the class, not only the line cited. From review 2 Sol is given the
  classes raised so far and reuses a name word for word for the same kind.
- **Decline**: the fix thread's answer to a finding whose test it can't make fail: a PR comment
  naming the finding's ID, the reason, and the test that wouldn't fail, with no code change.
  Sol gets one reply on it, in the next review: decline accepted closes it; decline kept open
  stops the loop.
- **Approach note**: what the runner posts instead of a fix round when review 3 is still blocking:
  a PR comment headed `## Approach note` saying whether the approach is wrong, which class keeps
  recurring, and what it would change. Stefan then picks rework, fix on, or hold.

## How a review runs

- **Each review is a fresh Sol run** (`~/.claude/docs/sol.md`) on the exact head commit, once
  ordinary checks on it have passed. Its brief: the diff, the PR body, each issue it closes (with
  comments), the PR's comments and `REVIEW.md`. Sol reads a checkout of the head and posts
  nothing; the runner posts what it found.
- **Diff-only re-review.** From review 2, Sol reviews only the change since the last reviewed
  commit, with the full diff for context; if that commit was force-pushed away, it reviews the
  full diff and the comment says so. The brief lists the open findings and the replies posted
  since the last review (PR comments, review threads, review bodies). Sol gives each open
  finding a status: `fixed`, `open`, `decline-accepted` or `decline-kept`. One it gives no
  status stays open. It repeats nothing already posted; a closed finding that comes back keeps
  its old ID and is marked reopened.
- **The `sol-findings` block.** Sol ends its review with one fenced `sol-findings` JSON block:
  each finding's `id`, `tag` (`important`, `nit`, `pre-existing`), `class`, `file`, `line`, and
  `scenario` or `cost` + `rule`; from review 2, an `earlier` list of statuses. The runner, not
  Sol, works out the verdict from it: **clean** when no Important finding, new or earlier, is
  open. A review without a readable block is a failed review.
- **State lives on the PR.** Each review comment's marker holds the reviewed commit and every
  finding with its status, so a new run loses nothing. Reviews the old script and the
  orchestrator posted count, and the numbering carries on from them.
- **Posting:** the runner files the Pre-existing issues, posts the comment, sets the `sol-review` commit status
  (success when clean, failure when blocking) on the reviewed commit, and appends a row to the
  PR body's `## Review` table (making the section after `## Evidence` if it's missing). A commit
  pushed after the review has no `sol-review` status, so it never looks reviewed.
- **The outcome**, checked in this order:
  1. **Stop** when a signal fires:
     - **repeated class**: a new Important finding has the class of an Important finding from
       an earlier review (compared lower case, words only);
     - **reopened**: a closed finding, of any tag, came back;
     - **decline kept**: Sol kept a decline open;
     - **failed check or conflict** on the PR.
  2. **Approach note** when review 3 is blocking. No fourth review without Stefan's answer.
  3. **Ready for Stefan** when clean: the runner labels the PR `ready-for-stefan` and toasts him;
     Stefan merges it (a merge commit or a squash, not a rebase), and the runner runs the live
     steps after.
  4. **Fix** otherwise: a fresh Claude thread, then the next review.

  Stops and approach notes end with Stefan, through a `needs-info` issue.
  `python3 -m queue_runner --needs-me` lists what waits on him.
- **Failed review:** nothing counts, and the runner reviews the head again on a later pass.
  After two failed reviews on one head it stops trying until a new commit is pushed or Stefan
  runs `python3 -m queue_runner --release leads-dashboard#N`.
- **Sol out of usage:** nothing counts; the runner reviews the PR afresh after Sol's reset, with
  no limit on tries.

## Opening a PR

1. **Open the PR** once the checks pass, with its body from the `pr` skill. Answer the
   template's **Tested** (how the change was tested) and **Undo** (how to undo it) prompts. The
   plugin copy, `mattpocock-skills:pr`, lacks them; add them by hand there. The body also has:
   - a `## Review` section after Evidence, with the table header
     `| Step | Time (UTC) | Commit | Verdict |` and a first row saying it's waiting on Sol;
   - `Closes #N`, one keyword per issue.
2. **Stop.** A runner's build or fix thread ends with its report; any other session tells
   Stefan in one line that the PR is waiting on Sol. No label and no session line: the runner
   adopts the PR. After Stefan merges, a live thread the runner starts finishes the live steps
   as `docs/agents/lovable-cloud.md` says, and the runner then posts a **Live.** comment on each
   PR it covered.

## Briefs for other workers

A brief that hands a PR to a worker points to this doc. It never spells out a loop of its own.
