# 45: A second review fails when Sol's checkout can't be removed

**What to build:** a PR in this repo gets its second and later reviews without anyone clearing
a folder by hand.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Found on 2026-11-16, on PR #6's review 2, and it is what stopped PR #4 on 2026-11-11 ("2 failed
reviews on f2610f8"). Both failed twice with:

```
git worktree add --detach ~/.queue-runner/checkouts/queue-runner-pr6 refs/queue-runner/pr6 failed (128)
fatal: '.../checkouts/queue-runner-pr6' already exists
```

## Why

- While Sol reviews, this repo's tests run in Codex's sandbox and make temp folders with
  `tempfile.mkdtemp` under the checkout's `.review-tmp/`. On Windows those get an owner-only
  ACL (AGENTS.md, Sol runs tests), and the owner is the sandbox user.
- After the review, `GitCli.remove_checkout` (`queue_runner/git.py`) runs `git worktree remove
  --force`. Git unregisters the worktree and deletes what it can, but can't delete those
  folders, so the checkout's folder stays.
- The next review's `GitCli.checkout` calls `remove_checkout` again (nothing left for git to
  remove) and then `git worktree add` at the same path, which refuses because it exists.
- Stefan's own account can't delete them either (`rm -rf`: permission denied). Renaming the
  checkout folder works. `queue-runner-pr6.stale-20261116` was moved aside by hand that way.

leads-dashboard hasn't hit it: its reviews 2 and 3 ran. Its tests don't make folders this way.

- [ ] A checkout folder that survives removal never fails the next review: it is deleted if it
      can be, else moved aside, and the review goes on. Tested with a folder git can't remove.
- [ ] Folders moved aside are swept when they can be deleted, and the log says once when one
      can't.
- [ ] Sol's temp folders are made where the runner can delete them, or outside the checkout,
      if that can be done without widening the sandbox.
- [ ] `queue-runner-pr4`, `queue-runner-pr5` and `queue-runner-pr6.stale-20261116` under
      `~/.queue-runner/checkouts/` are cleared, or the ticket says what Stefan must run to
      clear them.
- [ ] PR #4 is reviewed again after `--release queue-runner#4` (Stefan's to run).

## Comments
