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

### Important (each one blocks the merge)

$important

**Classes to fix:** $classes. Fix every case of each class in the PR's change, not only the line
cited: look for the same kind of problem everywhere the PR touches.

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

- For each Important finding: before fixing it, write its cause in one line in the commit message:
  what in the code lets the failure happen, not the scenario Sol describes. Write a failing test
  first where one fits. Fix the cause, and add a test for a second case of it besides Sol's
  scenario where one fits, then fix every other case of its class. A fix that only adjusts a
  value or a format (a precision, a pattern, a timeout, an indentation) rather than removing the
  cause says in the commit message why the cause can't recur.
- If a finding is wrong, decline it: comment on the PR (`gh pr comment $number --repo $github`)
  naming the finding's ID, the reason and the evidence. The best evidence is a test, committed
  and pushed, that passes now and would fail if the finding were right. Sol reconsiders a decline
  once, in the next review.
- **A missing or wrong screenshot finding:** shoot and publish them with the runner's script
  (`python3 -I $evidence shoot URL OUT.png --size 1440x900`, or `screen OUT.png` for the
  desktop, then `publish --repo . --into pr-$number FILE.png ...`, which prints the image lines),
  don't open them yourself, add them to the PR body, and push (an empty commit if the
  code didn't change, so there is a new head to review). If the screen can't be captured,
  say so on the PR and end your turn.
- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- End the round by pushing to `$branch`. A round that ends without a push isn't reviewed again:
  the PR waits for Stefan. Don't review your own work: the runner has the new head reviewed.
- Don't merge, review, set statuses or edit the PR's `## Review` table: the runner does those.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- If something only Stefan can decide stops you: push what you have, comment the question on the
  PR, and end your turn.
