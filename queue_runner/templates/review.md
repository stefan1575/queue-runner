# Review PR #$number: $title

Repo: $github. This workdir is a checkout of the PR's head, exactly $sha ($sha7). The PR merges
`$branch` into `$base`. Whoever wrote it, it merges only once your review is clean. GitHub isn't
reachable from here, so everything you need is in this workdir and in `$rundir`:
$files

Review independently (the only files you change are tests you add to show a problem):
1. **Correctness:** does the change do what it claims? Does anything else in the repo depend on what
   it changes? Trace the callers.
2. **Spec fit:** does it do what the issue asks, and is anything it asks missing?
3. **Standards:** does it follow this repo's $agents and `docs/agents/`?
4. **Tests:** do the tests cover the behaviour it changes? $tests
5. **Screenshots:** a screenshot lets a reader see a change instead of taking the builder's word
   for it, and leaves a record of how the screen got this way. Behaviour is proved by its tests;
   screenshots are for a ticket that changes what a person looks at. You are their reader: look
   at each shot the PR gives. They are enough when, reading only the PR, you can see the change
   the ticket asked for, and the shots show what the PR says. When you can't, that is
   **important** (`rule`: "a visible change needs screenshots"): name the screen you need to see.
$again$guide
Tag every finding:
- **important** blocks the merge. It needs `file` and `line`, plus either a `scenario` (a failure
  concrete enough to become a failing test: this input or state, this wrong result) or a `cost` and
  a `rule` (the named later cost, and the spec line or documented standard it breaks). A finding
  without that evidence is a nit at most.
- **nit** never blocks. Give at most five.
- **pre-existing** is a problem in code this PR didn't change; it is filed as a follow-up issue.
  One that loses or exposes data is important instead.
`class` names the cause: what in the code lets the failure happen, not what goes wrong (for
example "log records matched by comparing timestamps written at different precisions", not
"recovery event loses timestamp precision"), so the fix removes the cause and covers every case
of it, not only the one you cite. Cite file and line as repo-relative paths
(`src/lib/callsling.ts:74`): your reply is posted as a comment on the PR.

Write your review first: what you found, with evidence, then what you covered and what you
couldn't check. Then, last of all, end your reply with exactly one fenced block tagged
`sol-findings`, holding every ${new}finding as JSON (an empty list if there are none)$statuses.
IDs are short: F1, F2, ...

```sol-findings
{"findings": [{"id": "$next_id", "tag": "important", "class": "...", "file": "src/lib/callsling.ts", "line": 74, "scenario": "...", "cost": "", "rule": ""}]$example}
```

The verdict is read from this block, not from your prose: clean when no important finding with
its evidence is open$open_scope. A reply without a readable block counts as a failed review.
