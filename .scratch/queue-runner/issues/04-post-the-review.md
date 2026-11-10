# 04: Post the review on the PR

**What to build:** a review from 03 goes out on GitHub as an automated post (no go-ahead needed,
`~/.claude/CLAUDE.md`): the review comment with its `sol-findings` ledger and hidden marker, the
`sol-review` status set on H (never on a newer commit), each new Pre-existing finding filed once
as a linked `needs-triage` issue (recorded URLs and open issues checked first), and the repo's
own records (leads-dashboard: the PR body's `## Review` row). A failed review posts nothing and
leaves the PR to be reviewed again.

**Blocked by:** 03

**Status:** done (2026-11-10)

- [x] Posting is behind the same seam as the dry run, so tests check the exact comment, status
      and issue calls against fakes.
- [x] A finding already filed isn't filed again; an unchanged finding isn't reposted as new.
- [x] Until the cutover (13) the old `~/sol-pr-review.py` still runs: the runner skips any PR
      labelled `needs-sol-review` or `sol-reviewed`, so the two never review the same PR.
- [x] Verified live on one open leads-dashboard PR outside the old script's labels if there is
      one; otherwise against fakes only, with the first real post left to 13. Comments say which.

## Comments

**2026-11-10, built** in `~/Code/Personal/queue-runner`, commits `8005c23` and `20eb88f`; 157
tests pass (`python3 -m unittest`). It reuses the stopped first attempt's uncommitted work
(`post.py` and the GitHub writes), checked and tested here. Its one bug: `live_review.py` would
have posted, because the `Reviewer` default became the real poster; it now passes `DryRunPoster`,
as `--dry-run` does.

What's there: `post.GitHubPoster` behind the dry run's poster seam. Tests check every write, in
order, against `FakeGitHubForReviews.posts`. The order is: each new Pre-existing finding as a
`needs-triage` issue, the comment linking them, `sol-review` on H (the reviewed commit, never the
PR's head now), then, for a repo with `review_table` (leads-dashboard), a row in the PR body's
`## Review` table, ported from the old script. `needs-sol-review` and `sol-reviewed` PRs are left
to the old script until 13. The runner's `AGENTS.md` has the rest (A Sol pass, steps 5 and 6).

Decisions (mechanics):
- **Not filed twice:** a follow-up issue carries a hidden `<!-- sol-finding owner/name#N ID -->`
  line, and the ledger records its URL. Before filing, the runner checks recorded findings by ID
  and checks open issues for that line, the old script's footer or the same title.
- **Not reposted as new:** a finding Sol gives a new ID, with the same tag, class, file and line
  as an open or filed one, takes the old ID. So it doesn't fire the repeated-class stop. One
  listed again shows under Earlier findings ("Still open (listed again)"), not as new.
- **Failures:** if the comment can't be posted, the review is `failed` and the PR is reviewed
  again. A status or body edit that fails is logged and the review stands. A filing that fails
  is marked `unfiled` in the ledger, and the next review files it (found by the spec review).
- **Issues before the comment**, as the old script did, so the comment can link them. The spec
  review flagged that a comment failing after them leaves the issues on GitHub. That was kept:
  the retry links them by their hidden line instead of filing again (tested). The issue body
  links the PR, not the comment, which doesn't exist yet.

**Live, 2026-11-10, on leads-dashboard #173** ("Glossary: whether a Lead was reached (#39)"),
the one open PR outside the old script's labels that adoption would take. The others: #151 is
`sol-reviewed`, #152, #162, #163 and #168 have a review on their head, and #153 and #154
conflict with main. `python3 -m queue_runner --review leads-dashboard#173` posted
[review 1](https://github.com/RoyalBullyAgency-RBA/leads-dashboard/pull/173#issuecomment-6745316562),
**blocking**, with one Important finding. F1, at `GLOSSARY.md:103`: "Needs follow-up" reads the
latest Message as the person's, but `GLOSSARY.md:70` says every Message is one the person sent,
so a Client's reply doesn't fit. It set `sol-review` failure on `a2326af` and added the row to
the PR body's Review table. No Pre-existing finding, so no issue was filed live; filing is
checked against fakes only. Sol ran at `reasoning effort: high`. The run folder is
`~/.queue-runner/runs/leads-dashboard-pr173-r1-20261110-002451/`. The next step for #173 is a
fix round (ticket 05).

**For Stefan (not blocking):** Sol said #39's body was unavailable. #173 names #39 but doesn't
close it, so the brief leaves it out. Sol still couldn't run tests (no Node or `node_modules` in
its sandbox, as in 03).
