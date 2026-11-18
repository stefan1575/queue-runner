Fix round on PR #$number in $github: $title

The queue runner started this job because Sol's review $round of the PR's head $sha7 is blocking.
Stefan isn't watching it live. Everything you need is below or in the repo. There are no handoff
files.

## Where you are

- Repo: `$github`, in a fresh T3 worktree at the PR's head `$sha` on a local branch
  `$work`. The PR's own branch is `$branch`, merging into `$base`.
- $agents
- **Push to the PR's branch, not to `$work`:** `git push origin HEAD:$branch`. If the push is
  rejected because `$branch` moved, don't force-push: say so on the PR and end your turn.

${direction}## What Sol's review $round found

The review: $review_link

### Important (each blocks the merge until it's fixed or declined)

$important

**Classes:** $classes. For each finding you fix, fix every case of its class in the PR's change,
not only the line cited: look for the same kind of problem everywhere the PR touches.

### Nits (optional)

$nits

### Settled in earlier reviews

$settled

## The PR

$body

It closes: $closes

### Its commits (`$base..$sha7`)

$commits

### Files it changes

```
$diffstat
```

Read the whole change with `git diff origin/$base...HEAD`, and the review comments with
`gh pr view $number --repo $github --comments`.

## Earlier threads on this PR

$threads

## How to work

- **Weigh every finding before you act on it: the review is advice, not orders.** Fix what
  matters for what the repo is for and what its rules ask. Decline what's wrong, or right but not
  worth it here (a case no real use reaches, a fix that costs more than the harm it prevents),
  with the reason. Sol reconsiders a decline once, and your call stands unless Sol quotes a rule
  the repo wrote down (its `AGENTS.md`, `docs/` or the spec) that the finding breaks. Leave nits
  that don't earn their change.
- For each Important finding you fix: before fixing it, write its cause in one line in the commit
  message: what in the code lets the failure happen, not the scenario Sol describes. Write a failing
  test first where one fits. Fix the cause, and add a test for a second case of it besides Sol's
  scenario where one fits, then fix every other case of its class. A fix that only adjusts a value
  or a format (a precision, a pattern, a timeout, an indentation) rather than removing the cause
  says in the commit message why the cause can't recur.
- To decline a finding, comment on the PR (`gh pr comment $number --repo $github`) naming its
  ID and the reason. For one you say is wrong, the best evidence is a test, committed and pushed,
  that passes now and would fail if the finding were right. For one not worth it, say what it
  would cost and why that's more than it saves. Sol reconsiders a decline once, in the next
  review. A round that declines everything still pushes (an empty commit), so there's a new head
  to review.
- **A missing or wrong screenshot finding:** shoot the screens a person would notice changing, what
  the PR sets out to change, not every case its tests cover (a test is the evidence for those);
  where a finding asks for more than that, decline that part. Where the repo's `AGENTS.md` says how
  to shoot its states (its own harness, or never `screen`), do it that way; otherwise shoot and
  publish them with the runner's script (`python3 -I $evidence shoot URL OUT.png --size 1440x900`,
  or `screen OUT.png` for the desktop, then `publish --repo . --into pr-$number FILE.png ...`, which
  prints the image lines), don't open them yourself, add them to the PR body, and push (an empty
  commit if the code didn't change, so there is a new head to review). A change that shows only in
  the app's own data is shot from that data, not a sample page: the repo's docs say how. If
  `publish` refuses a before and after as byte-identical, the shot missed the change: reshoot it, or
  write `Screenshot owed: <why>`. If the screen can't be captured, say so on the PR and end your
  turn.
- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- End the round by pushing to `$branch`. A round that ends without a push isn't reviewed again:
  the PR waits for Stefan. Don't review your own work: the runner has the new head reviewed.
- Don't merge, review, set statuses or edit the PR's `## Review` table: the runner does those.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- If something only Stefan can decide stops you: push what you have, comment the question on the
  PR, and end your turn.
