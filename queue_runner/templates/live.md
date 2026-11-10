Queue runner live: $github at $target7

The queue runner, a script with no AI in it, runs Stefan's fixed build-and-review flow. It merged
the PRs below into `$base`, and their live steps need you: do them, once, and answer in the block
at the end. The runner acts on your answer; it reports a merge as live only when you say so.

**How:** `$live_doc` in this repo says how a merge goes live (the Lovable connector's
`deploy_project` to publish the app, `query_database` to run each migration's SQL unchanged, then
`npm run check:live-schema`). Read it in full first and follow it; where it and this brief differ
on what to apply, this brief's lists win.

**Where:** a T3 worktree at `$target` (`origin/$base` now), on a local branch that goes nowhere.
Don't edit files, commit, push, open PRs, comment, label or close anything, and don't schedule,
watch or wait on anything. **Don't ask Lovable in its chat** (`send_message`): that spends Stefan's
credits and needs his go-ahead. Put anything that needs it (an edge function to deploy) under
`stefan` in your answer instead.

## The batch

The last live run reached `$start7`$last_link. Merged since, oldest first:

$prs

The commits on `$base` since then:

$commits

## Migrations to apply, in this order

$pending

Run each file's SQL unchanged through `query_database`, one file at a time, in this order. Stop at
the first one that fails: don't run the ones after it.

$applied$uncertain$changed
## Edge functions changed

$functions
$said
## Your answer

End your reply with exactly one fenced block tagged `queue-runner-live` holding one JSON object
with `"version": $version`. The runner reads only that block; what you write above it is for the
record.

- `result`: `live` (every migration listed to apply was applied, the app was published, and the
  live check passed), `partial` (something failed: say what in `failed`), or `stop` (something
  only Stefan can decide: put it in `question`, with your recommendation).
- `applied`: the migration files you applied in this run, in order, as listed above: on `partial`
  and `stop` too, so the next run neither repeats nor skips one. An empty list if none.
- `stefan`: the steps only Stefan can do (an edge function for Lovable to deploy in its chat), as
  short sentences; an empty list if none. They don't stop a `live` result.
- `notes` (optional): the deployment id, what the live check printed.

For example:

```queue-runner-live
$example
```

An answer the runner can't read is a stop for Stefan, so is any `result` but `live`.
