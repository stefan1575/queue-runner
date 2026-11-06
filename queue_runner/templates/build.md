/implement GitHub issue #$number in $github: $title

The queue runner started this job; Stefan isn't watching it live. Everything you need is below or
in the repo. There are no handoff files.

## Where you are

- Repo: `$github`, in a T3 worktree on branch `$branch`, made from `$base`.
- $agents

## The issue: #$number $title

$body

## Comments on the issue

$comments

## How to work

- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- When the issue is done, push `$branch` and open the PR the way the repo's own rules say, with
  `Closes #$number` in its body. Skip `/implement`'s code-review step: the runner has Sol review
  the PR. Then end your turn.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- If something only Stefan can decide stops you: commit and push what you have, comment the
  question on the issue, swap its `ready-for-agent` label for `needs-info`, and end your turn.
