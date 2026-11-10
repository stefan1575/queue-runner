# 03: Sol reviews an open PR's exact head (dry run)

**What to build:** the runner adopts every open PR in a configured repo that has no clean review
on its newest commit, waits until that commit's checks pass (not counting `sol-review`), and starts
a fresh Sol thread to review the exact head H, per `~/.claude/docs/pr-review.md` A round, steps
1–3. It parses the `sol-findings` ledger from Sol's reply and works out the verdict itself: clean,
blocking, a stop signal (which one), or failed (no readable ledger). In this ticket the comment it
would post is written to the run folder only. Sol's lane runs alongside the Claude lane: one Sol
job and one Claude job at a time.

Port what fits from `~/sol-pr-review.py` (`decide()`, the ledger and marker parsing, the brief's
inputs, diff ranges for later reviews, force-push handling); drop its labels, label polling,
session forks and spend limit. Rounds the old script posted count: numbering carries on from its
markers. leads-dashboard's `docs/agents/review-loop.md` and `REVIEW.md` define its words.

**Blocked by:** 02

**Status:** done (2026-11-09)

- [x] Verify (spec, Verify while building): a Sol thread from `t3 thread start --provider codex
      --model gpt-6.1-sol` runs at effort `high`, read from its rollout's settings. If it doesn't,
      Sol starts through `~/codex-sol.sh` instead. Whichever is used is recorded in `AGENTS.md`.
- [x] The review brief is built from sources: H, the ticket, the PR's comments and earlier
      ledgers (findings, classes, declines, replies since the last review), the repo's
      `AGENTS.md`, `REVIEW.md`, the whole diff for review 1, and the change since the last
      reviewed commit plus the whole diff from review 2.
- [x] The verdict comes from the ledger, never from Sol's prose; `decide()`'s cases (clean,
      blocking, same-class repeat, reopened, decline kept, review 3 still blocking, failed) are
      covered by tests ported or written.
- [x] Dry run on one real open leads-dashboard PR (Sol isn't gated): the would-be comment and
      verdict are in the run folder and summarised in Comments. If no PR is open, run it against
      a merged PR's head and say so.

## Comments

**2026-11-09, built** in `~/Code/Personal/queue-runner`, commits `2ce199e` to `f672918`. There
are 140 tests and all pass (`python3 -m unittest`). Sol reviewed it three times at effort high.
Review 1 was blocking with three Important findings: an unreadable earlier ledger wiped the PR's
findings, a PR whose build waits for an answer could be reviewed, and a ticket closed by URL was
left out of the brief. Review 2 was blocking: part of F1 was still open, and F4 was new (two
issue files could collide). F4 repeats F3's class, which in the PR loop would be a stop for
Stefan. It wasn't treated as one here, because it was a file-name edge, not a sign the approach
was wrong. Review 3 was clean on `f672918`. It accepted one decline: an old marker with no
`findings=` field still counts as a review with no findings, because the old script wrote
markers like that before 2026-11-05 (leads-dashboard #88, #106, #120).

What's there: `ledger.py` (earlier reviews and `decide()`, no I/O), `review.py` with
`templates/review.md` (the Sol lane: which PRs it takes, the brief, a review), `sol.py` (the
`codex-sol.sh` adapter), `lock.py` (`runner.lock`, `sol.lock`), and new calls in `github.py`
and `git.py`. `run.py` now runs two lanes. `python3 -m queue_runner --review NAME#N` reviews one
PR now. `--once --dry-run` also lists what Sol would review. `scripts/live_review.py` is the
live check. The runner's `AGENTS.md` has the rest.

**Verify: Sol's effort.** A thread from `t3 thread start --provider codex --model gpt-6.1-sol`
ran at effort **low**. Its rollout
(`~/.codex/sessions/2026/11/09/rollout-2026-11-09T19-36-32-*.jsonl`) has a
`configuration_update` with `reasoning.effort: "low"`, though `~/.codex/config.toml` says high.
T3's CLI has no effort flag. So Sol starts through `~/codex-sol.sh --job review --effort high`.
Its log showed `reasoning effort: high` on the live run. This is recorded in the runner's
`AGENTS.md` (Sol, as a script sees it). That T3 check thread, "Queue runner effort check", is in
the sandbox project and wasn't settled.

Decisions (mechanics):
- **Which PRs it takes:** open PRs, lowest number first, one review a pass. It leaves a PR alone
  while a build is open or waiting on its branch, once a review (any of the three marker formats)
  or this runner's own dry run is on H, after two failed reviews on H (until a push or
  `--release NAME#N`), and while H's checks are running or haven't reported (`sol-review` isn't
  counted). A failed check or a conflict is logged as a stop for Stefan and left for ticket 06.
  It says why once per PR, not every pass. GitHub failing on one PR skips only that PR (this
  was found live: a TLS timeout).
- **Exact head:** the runner fetches `refs/pull/N/head` and checks it against the listed H; if
  they differ the outcome is `head-moved` and nothing counts. Diffs run against the PR's own
  base, since PRs stack (#168's base is #162's branch). The detached checkout and its ref are
  removed afterwards; that was checked live.
- **Formats read:** the old script's marker; the runner's own (the same marker plus a visible
  `sol-findings` ledger in a collapsed `<details>`); and #168's hand-run
  `<!-- sol-review round=N head=H -->` with its visible block. A comment whose ledger can't be
  read isn't counted.
- **Approach note from review 3 on, not only at 3:** with the spend guard gone, every blocking
  review from 3 comes to Stefan. Otherwise nothing would stop a PR that kept blocking.
- **Out of usage:** the Sol lane pauses until 10 minutes after the reset Sol names, or for 30
  minutes if it names none. The rest of limit recovery is ticket 09.
- **The two lanes:** the Claude lane runs in the main thread and the Sol lane in a second
  thread. The job log takes a lock per file. Each review holds `sol.lock`, so `--review` and the
  running lane never overlap.

**Dry run, 2026-11-09, on leads-dashboard #154** ("A Client's Jobs CRM, with a key never shown
again (#118)"). Seven PRs were open, and none could be taken: #151, #152, #162, #163 and #168
already have a review on their head (each blocking; their next step is a fix round, ticket 05),
and #153 and #154 conflict with main. #154 had never been reviewed and its checks pass, so
`scripts/live_review.py` reviewed it anyway, as a dry run. It noted first: "Adoption would say:
it conflicts with main: a stop for Stefan." It ran with its own state folder,
`~/.queue-runner/live-review/`, so this dry run won't stop ticket 04 from posting a review on
that head. Nothing was posted.

- **Run folder:** `~/.queue-runner/live-review/runs/leads-dashboard-pr154-r1-20261109-195414/`
  (`brief.md`, `change.diff`, `pr.md`, `issue-118.md`, `reply.md`, `reply.md.log`, `comment.md`,
  `decision.json`).
- **Verdict:** review 1 on `0cb8323` is **clean**, next step merge. It has no findings, and the
  would-be `sol-review` status is `success` ("Clean: no Important finding, 0 nits").
- **The would-be comment** is headed `## Sol review 1 · Clean`. Sol traced the config forms,
  mutations and key RPCs (metadata only, `20261105181800_jobs_crm.sql:39`), and checked the
  grants, RLS, `HIDDEN`, secrets and migration history. The comment ends with the ledger and
  `<!-- sol-pr-review round=1 verdict=clean sha=0cb83239… findings=W10= -->`.
- Sol used 95,543 tokens, at `reasoning effort: high`, read-only, and took 3 minutes.

**For Stefan (not blocking):**
- **Sol couldn't run #154's tests.** Node isn't on PATH in `codex-sol.sh`'s sandbox, and the
  fresh checkout has no `node_modules`. So its "clean" rests on reading the code plus CI having
  passed on H. The hand-run reviews from T3 children did run tests. A fix would be Node on
  Sol's PATH and a `node_modules` link into the checkout. Say if that's wanted (04 or later).
- **#153 and #154 conflict with main**, so the runner will stop on both for you (ticket 06).
