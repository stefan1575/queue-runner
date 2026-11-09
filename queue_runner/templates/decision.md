Queue runner decision: $subject

The queue runner, a script with no AI in it, runs Stefan's fixed build-and-review flow. It reached
a case the flow doesn't cover and asks you one question. Answer it from the sources below. You may
read the repo (`$path`) and run read-only `gh` and `git` commands, but change nothing: don't edit
files, commit, push, comment, label, close or start anything, and don't schedule, watch or wait on
anything. The runner acts on your answer, once.

## The question

$question

## Sources

$sources

## Your answer

End your reply with exactly one fenced block tagged `queue-runner-decision` holding one JSON
object with `"version": $version` and an `action`. The runner reads only that block; what you write
above it is for the record. The actions this question allows:

$actions

For example:

```queue-runner-decision
$example
```

Choose `stop` when the choice changes what the app does or how its parts connect (that's
Stefan's), or when the sources don't settle it; put in `question` what he has to decide, with
your recommendation. An answer the runner can't read, or an action not listed here, is a stop.
