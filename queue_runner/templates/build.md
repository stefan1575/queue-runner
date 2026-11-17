Build GitHub issue #$number in $github: $title

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

- Write a failing test first where one fits, then only the code that makes it pass. One test at
  a time.
- Run the typecheck and the tests you touch as you go, and the full test suite once at the end.
- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- If the change alters what a person sees, take the before screenshots first, before you change
  anything (see Screenshots below).
- When the issue is done, push `$branch` and open the PR with the body below, with
  `Closes #$number` in it. Where the repo's own rules ask for more, add it. Don't review your own
  work: the runner has the PR reviewed. Then end your turn.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- If something only Stefan can decide stops you: commit and push what you have, comment the
  question on the issue, swap its `ready-for-agent` label for `needs-info`, and end your turn.

## The PR body

Keep it short, with no preamble.

```markdown
## Summary

<the smallest sketch that makes the change clear: pseudocode, a call tree, a file tree or a diff>

## Evidence

Visible: <yes, what changes on screen | no, why nothing does>

| Before | After |
|---|---|
| <screenshot, or the test failing> | <screenshot, or the test passing> |

## Merge Danger

**Door:** <one-way (hard to undo) or two-way (easy to roll back)>

**Blast radius:** <a word or two: what could break>
```

## Screenshots

When something a person sees changes, wherever the cause is, the PR needs a before and after
screenshot of each state the change touches. A new screen has no before: show each of its states.
A visible PR without them doesn't merge.

The repo's docs say how to render each of its states. A change that shows only in the app's own
data, not in a sample state it can render, is shot from that data: the repo's docs say how to
build it and shoot it (a sample page shot instead is the same before and after). Take and publish
them with the runner's script, and don't open the images yourself (they cost tokens on every
later turn; the reviewer looks):

```
python3 -I $evidence shoot URL OUT.png --size 1440x900   # a page, in headless Edge
python3 -I $evidence screen OUT.png                       # the whole desktop
python3 -I $evidence publish --repo . --into pr-<the PR's number> FILE.png ...
```

Name the files `before-<state>-<page>.png` and `after-<state>-<page>.png`, and keep them out of
the commits. Publish them once the PR is open, into `pr-<the PR's number>`: that folder is the
only one the review reads. `publish` prints one Markdown image line per file: put them in the
Evidence table (`gh pr edit <number> --body-file ...`). If the screen can't be captured, write
`Screenshot owed: <why>` there instead. `publish` refuses a before and after whose bytes are the
same and names both: the shot missed the change, so reshoot what the change touches, or write
`Screenshot owed: <why>` for that state.
