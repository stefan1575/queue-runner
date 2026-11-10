Conflict round on PR #$number in $github: $title

The queue runner started this job because the PR's head $sha7 conflicts with `$base`, so it can't
merge. Merge `$base` in, resolve the conflict, and push. Stefan isn't watching it live. Everything
you need is below or in the repo. There are no handoff files.

## Where you are

- Repo: `$github`, in a fresh T3 worktree at the PR's head `$sha` on a local branch
  `$work`. The PR's own branch is `$branch`, merging into `$base`.
- $agents
- **Push to the PR's branch, not to `$work`:** `git push origin HEAD:$branch`. If the push is
  rejected because `$branch` moved, don't force-push: say so on the PR and end your turn.

## What to do

1. `git fetch origin $base`, then `git merge origin/$base`. Merge, don't rebase: the PR's
   commits and their review comments stay as they are, and nothing needs a force-push.
2. Resolve each conflict so that both sides' intent survives: what the PR does, and what landed
   on `$base` since. Read the commits below that touch the same files to see why they changed.
   Where the two can't both hold (one removes what the other builds on), that is Stefan's call:
   see the last point.
3. Run the repo's checks and tests (its `AGENTS.md` says which) on the merged result and fix
   what the merge broke, in the PR's change only.
4. Commit the merge, with a message that names the conflicted files and how each was resolved,
   then push: `git push origin HEAD:$branch`. Sol reviews the new head afresh.

## The PR

$body

It closes: $closes

### Its commits (`$base..$sha7`)

$commits

### Files it changes

```
$diffstat
```

### Landed on `$base` since the PR left it

$landed

Read the whole change with `git diff origin/$base...HEAD`, and the PR's comments with
`gh pr view $number --repo $github --comments`.

## Earlier threads on this PR

$threads

## How to work

- Don't add features or fix review findings in this round: only the merge, its conflicts, and
  what the merge broke. Sol reviews the result.
- Skip any code-review step. Don't merge the PR, review it, set statuses or edit its
  `## Review` table: the runner does those.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- **If you can't resolve it** (the two sides' intent can't both hold, or it needs a choice only
  Stefan can make): don't push. Abort the merge (`git merge --abort`), comment on the PR
  (`gh pr comment $number --repo $github`) naming the conflicted files and the choice, and end
  your turn. A round that ends without a push goes to Stefan as a stop.
