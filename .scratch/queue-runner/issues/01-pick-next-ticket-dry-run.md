# 01: Pick the next ticket and print its build brief (dry run)

**What to build:** the runner's tracer bullet. Stefan runs the runner once in dry-run mode and it
names the job it would start next: for each configured repo it lists open GitHub issues labelled
`ready-for-agent` whose `Blocked by:` issues are all closed, takes the lowest number, and prints
the build job (repo, issue, branch `claude/<slug>-<issue>` from `origin/main`) with its brief
filled from the build template. Nothing is started, posted or written outside the runner's own
folder.

Read first: `.scratch/queue-runner/spec.md` (personal-ops), `~/.claude/docs/orchestration.md`,
`~/.claude/docs/pr-review.md`, `~/.claude/docs/sol.md`. The code goes in its own local git repo,
`~/Code/Personal/queue-runner`, created by this ticket; it never gets a remote. Python (it runs
under `pythonw`), standard library first; tests run with no network, through fakes at the seams
for GitHub (`gh`) and T3 (`t3`).

**Blocked by:** None (can start immediately).

**Status:** done (2026-11-07)

- [x] `~/Code/Personal/queue-runner` exists as a local git repo with an `AGENTS.md` that says what
      it is, how to run it and its tests, and that it never goes to GitHub.
- [x] A config names the repos it serves (to start: leads-dashboard,
      `RoyalBullyAgency-RBA/leads-dashboard` at `~/Code/Work/leads-dashboard`) and where the
      runner keeps its state and logs (outside any repo it serves).
- [x] The picker: open, `ready-for-agent`, every `Blocked by:` issue closed, lowest number first;
      an issue that already has an open PR or a `claude/*-<issue>` branch isn't picked again.
      Tested against fake GitHub data, including a blocker that is still open and one that's
      closed.
- [x] The build brief is a template filled from the issue (title, body, comments) and the repo
      (its `AGENTS.md` pointer), with no handoff files. It tells the job to commit after every
      step with the decision in the commit message, and to open the PR per the repo's own rules
      when done. Mechanics: the build job opens its PR; the runner later finds it by branch.
- [x] `--once --dry-run` against the real leads-dashboard prints the job it would start and its
      brief; the output is pasted into this ticket's Comments.

## Comments

**2026-11-07, built** in `~/Code/Personal/queue-runner` (commits `d846db0`, `c95fa2a`). 36 tests,
all pass (`python3 -m unittest`). Sol reviewed it twice at effort high: review 1 blocking (three
Important), review 2 clean on `c95fa2a`.

Decisions (mechanics):
- **Blockers** are read three ways: GitHub's native dependencies (`issue_dependencies_summary`,
  which leads-dashboard mostly uses), a `Blocked by:` line, or a `## Blocked by` section; refs
  may be `#N`, `owner/name#N` or issue URLs, and another repo's blocker is checked there.
- **In flight** means a `claude/*-<issue>` branch, an open PR on one, an open PR whose closing
  keyword names the issue, or an open PR GitHub links to it by hand (one GraphQL query per repo;
  REST doesn't expose the links). Added after Sol's review 1.
- **A ready issue with open sub-issues isn't built**: it's a spec or map, and its children are the
  work. Sol called this an extra rule; declined and accepted in review 2. Without it the runner
  would pick #102 ("Spec: a Client's config…", 10 open sub-issues) as one build job.
- **Repos are in priority order** in `config.toml`; the first one with work gets the next job.
  State and logs: `~/.queue-runner/state` and `~/.queue-runner/logs`.
- **The brief opens with `/implement`**, so the job runs the usual flow, and tells it to skip
  `/implement`'s code-review step (Sol reviews the PR), commit each step with the decision, open
  the PR per the repo's rules and end its turn; a question only Stefan can answer becomes a
  comment and a `ready-for-agent` → `needs-info` swap on the issue.

**For Stefan (not blocking this ticket):** the dry run picks **#139**, "Review script: tagged
findings…", which is a ticket for `~/sol-pr-review.py`, retired on 2026-11-06. #137 (its spec),
#140 and #141 are the same. They're still labelled `ready-for-agent`, so once ticket 02 starts
builds the runner would build them. Relabel or close them before then.

`python3 -m queue_runner --once --dry-run` against the real leads-dashboard, 2026-11-07:

~~~~text
Would start a build job (dry run: nothing started)
  repo:   RoyalBullyAgency-RBA/leads-dashboard (C:\Users\Anon\Code\Work\leads-dashboard)
  issue:  #139 Review script: tagged findings, the verdict from them, and a status on the reviewed commit
  branch: claude/review-script-tagged-findings-139 from origin/main
  brief:
------------------------------------------------------------------------
/implement GitHub issue #139 in RoyalBullyAgency-RBA/leads-dashboard: Review script: tagged findings, the verdict from them, and a status on the reviewed commit

The queue runner started this job; Stefan isn't watching it live. Everything you need is below or
in the repo. There are no handoff files.

## Where you are

- Repo: `RoyalBullyAgency-RBA/leads-dashboard`, in a T3 worktree on branch `claude/review-script-tagged-findings-139`, made from `origin/main`.
- Read the repo's `AGENTS.md` first, and the docs it points to for what you touch.

## The issue: #139 Review script: tagged findings, the verdict from them, and a status on the reviewed commit

## Parent

#137

## What to build

The review script on Stefan's PC (`sol-pr-review`) runs one Sol call per review. The call covers spec and standards, and Sol's brief includes `REVIEW.md` when the repo has one. Sol ends its reply with its findings in a fixed format: an ID, a tag (Important, Nit or Pre-existing), a class, the file and line, and the failure scenario or the later cost with the rule it breaks.

The script works out the verdict from the findings: clean when no Important finding is open. Then it:
- posts the readable review with a hidden marker that holds the reviewed commit and the findings;
- sets a `sol-review` status (success or failure) on that exact commit;
- files each Pre-existing finding as a follow-up issue labelled `needs-triage`, linked from the review comment.

A reply whose findings can't be read is a failed review.

The decisions move into one function with no I/O, tested with the standard library's unittest beside the script. It takes the PR's state and Sol's reply, and returns the comment, the verdict, the status, the message and the issues to file. This is a local-only ticket: the script lives outside the repo, so keep a dated backup before editing, as the earlier ones are kept.

## Acceptance criteria

- [ ] One Sol call per review, with `REVIEW.md` in the brief when present.
- [ ] The verdict comes from the parsed findings. The `VERDICT:` line is no longer read.
- [ ] `sol-review` is set on the reviewed commit. A later push leaves the new commit without it.
- [ ] Pre-existing findings become `needs-triage` issues, linked from the comment.
- [ ] Unit tests for the decision function pass, using real recorded replies and hand-made ones, including an unreadable reply.
- [ ] One `--dry-run` on a real PR shows a well-formed comment and message.

## Blocked by

None (can start immediately).

## Comments on the issue

**stefan1575**, 2026-11-05T10:53:08Z:

## Built locally (2026-11-05)

`~/sol-pr-review.py` changed in place. Backup from before the change: `~/sol-pr-review.py.bak-2026-11-05-139`. The script is still stopped: nothing was started, and the shortcut stays in `disabled-startup/`.

**What changed**
- **Brief:** still one Sol call. It includes the checkout's `REVIEW.md` in full, under "This repo's review guidelines", when the file exists. The P0/P1/P2 ranking and the `VERDICT:` line are gone. Sol now tags each finding `important`, `nit` or `pre-existing`, with the evidence rules, and is told that a finding without that evidence is a nit at most. It ends its reply with one fenced `sol-findings` JSON block: `{"findings": [{"id", "tag", "class", "file", "line", "scenario", "cost", "rule"}]}`. On a later review, Sol is told to keep an earlier finding's ID.
- **`decide(repo, n, sha, rnd, earlier, has_review_md, reply, wt=None, rundir=None)`** does no I/O. It returns `verdict`, `body`, `status`, `issues`, `message` (`clean`/`fix`/`stop`) and `findings`, and raises `SolFailed` when the block is missing or can't be read. That covers bad JSON, no `findings` list, an unknown tag, a missing ID and a duplicate ID.
  - An `important` finding without file + line + (scenario, or cost + rule) becomes a nit, and the comment says so.
  - Nits after the first five are dropped, and the comment names them.
  - The verdict is blocking only when an `important` finding with its evidence is left.
- **Comment:** the heading and `<sub>` line are kept. The block is taken out of the prose and replaced by a `### Findings` table (ID, tag, class, linked file:line). The marker is `<!-- sol-pr-review round= verdict= sha= findings=<base64 JSON> -->`. `MARK` still matches older markers, so round counting is unchanged.
- **After posting** (never under `--dry-run`):
  - the label swap now runs first, so a later failure is logged and can't trigger a second review;
  - each new pre-existing finding is filed as a `needs-triage` issue linking the PR and the comment, and the comment is edited to link the issues. An ID already marked pre-existing in an earlier marker isn't filed again;
  - `sol-review` is set to success or failure on the reviewed sha, with `target_url` pointing to the comment.
- **`message_for`:** the text is unchanged except "Fix every Important finding" (was "every P0 and P1") and "List any nits you leave" (was "P2s").
- A dry run also writes `decision.json` and `followup-<id>.md` to the run folder.

**Tests:** `~/sol-pr-review-test.py`, standard-library unittest. `python3 -I ~/sol-pr-review-test.py`: **20 tests, all pass.** They cover parsing, the clean and blocking verdicts, the downgrade, more than five nits, unreadable replies (including an old reply with only a `VERDICT:` line), pre-existing findings not filed again on review 2, the marker round trip (text containing `-->` included), the brief and the message wording. The real fixture is PR #120 review 1 (`runs/leads-dashboard-pr120-r1-20261027-001123/reply.md`), with its prose turned into a block by hand. A second one checks the local `/C:/...` paths from PR #135 review 4. I also ran `review()` once with gh, git and Sol stubbed, in dry, posting and unreadable modes, to check the order of its calls.

**Still to do**
- [ ] The `--dry-run` on a real PR. It calls Sol, and Sol is out of usage until about 01:00, so it waits until Sol is back.
- [ ] A Sol review of this change, also waiting until Sol is back.
- `docs/agents/cloud-sessions.md` still describes the `VERDICT:` line. It is left for the docs ticket.

Left open.

## How to work

- Commit after every step, with the decision in the commit message: what you chose and why. A
  usage limit can cut this thread off at any point, and the next job starts from your commits.
- When the issue is done, push `claude/review-script-tagged-findings-139` and open the PR the way the repo's own rules say, with
  `Closes #139` in its body. Skip `/implement`'s code-review step: the runner has Sol review
  the PR. Then end your turn.
- Don't schedule, watch or wait on anything (no scheduled tasks, PR watches, wake-ups or
  monitors). The runner does the waiting.
- If something only Stefan can decide stops you: commit and push what you have, comment the
  question on the issue, swap its `ready-for-agent` label for `needs-info`, and end your turn.

------------------------------------------------------------------------
~~~~
