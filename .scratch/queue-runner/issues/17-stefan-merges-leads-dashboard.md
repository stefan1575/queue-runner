# 17: Stefan merges leads-dashboard PRs; the runner tells him when one is ready

**What to build:** for leads-dashboard the runner no longer merges. When a PR is ready (Sol's
review clean on its newest commit, checks passed, nothing open), the runner marks it ready for
Stefan: a toast that opens the PR, and a `ready-for-stefan` label. It notices when Stefan merges
(the PR's state on its next pass) and then runs the live steps (11). Queue-runner keeps merging
itself (14). Per repo in `config.toml`: `merge = "runner"` or `merge = "stefan"`.

The problem this solves (Stefan, 2026-11-10): he can't tell when something needs him. So
`python3 -m queue_runner --needs-me` lists everything waiting on him in one place: PRs ready to
merge, `needs-info` stops, threads waiting for an answer.

Rule changes, with wording shown to Stefan before they're written: `~/.claude/CLAUDE.md`
("Merge when the review is clean"), `~/.claude/docs/pr-review.md`, and leads-dashboard's
`docs/agents/review-loop.md` (13 rewrites the rest of that file).

**Blocked by:** None

**Status:** ready-for-agent

- [ ] A ready leads-dashboard PR gets its toast and label once, not every pass.
- [ ] Stefan's merge is noticed and the live steps run after it.
- [ ] `--needs-me` lists all three kinds, and says "nothing" when there's nothing.
