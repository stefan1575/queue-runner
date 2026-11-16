# Prior art and dashboard UI/UX for the queue runner

Status: **done — desk research; live product checks outstanding**. Researched **2026-11-14** against primary product documentation, source repositories, specifications and first-party announcements. Recommendations are design judgments, not findings from user testing. Stefan is referred to as they/them. Product behavior below is what the cited sources document, not an end-to-end test.

## Recommendations first — five lines

1. **Partly reinventing:** evaluate Orchestrator.inc and OpenHands Software Factory before generalizing the execution engine; keep the runner's subscription reserve, bounded review policy and live-step rules as explicit policies. [1][6][7][11]
2. Keep **one global Needs you inbox**, followed by two compact Running now cards; use a PR timeline for review/fix history and a plain ordered queue for upcoming work. [2][48][57][60][63]
3. Default to **All repositories**, with a searchable repo picker in configured priority order; put **Add repository…** in a separate footer and priority editing in settings. Filtering must not change scheduling. [1][8][41][66][67][68]
4. Model **phase, execution, blockers, human action and data freshness separately**; an automatic quota wait or retry is not a human stop, and merged is not the same as live. [1][9][62][64]
5. Correct the prototype's control semantics before polishing: today's pause affects new Claude jobs, the reserve releases 24 hours before reset, and lane interruption/resume controls need capabilities the runner does not currently promise. [1][4][5]

## Scope and how to read the findings

Read the full local design, both earlier research notes and the source of both prototype pages. This report builds on the existing attention and integration recommendations; it does not repeat the Windows notification investigation or the detailed T3 authentication analysis. Local facts are cited to those files; external product claims have numbered primary-source links at the end. The prototype was inspected as source, not run or evaluated visually. [1][2][3][4][5]

The comparison treats the runner as a **deterministic delivery controller**, not merely a place to run several chats. Its review loop is also deliberately bounded: repeated findings and later blocking rounds can require Stefan's judgment, rather than continuing forever until a model says clean. That escalation policy, exact-head review, one writer per PR, separate merge and live milestones, and an account-wide usage reserve are the relevant comparison points. [1]

“Multi-repo” below means managing work across several repositories. It does not imply coordinated atomic changes across repositories. “Different reviewer” means a separately selectable reviewer model/harness or an external review service; a fresh session using the same model is weaker evidence. A product accepting a subscription login is not evidence that it predicts whether a job fits the remaining subscription window. [1][7][13]

## 1. Prior art: substantial overlap, a narrower remaining gap

### Comparison

Columns match the brief: **A** issue queue → unattended build → PR; **B** different reviewer with feedback/fix rounds; **C** automatic merge or an explicit human merge/review gate; **D** scheduling against consumer subscription windows; **E** one human-attention inbox; **F** local execution over the user's agent CLI(s); **G** multiple repos.

**Y** = directly documented; **P** = partial, configurable, historical, or requires composition; **?** = not established in the sources checked; **—** = outside the documented product scope. These are evidence classifications, not an exhaustive assertion that an undocumented feature cannot exist. In particular, **D has no verified match for the runner's complete preflight cost + weekly reserve + timed release policy**. [1][13][55]

| Candidate | A | B | C | D | E | F | G | What overlaps; important difference / current status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Orchestrator.inc**, formerly Composio Agent Orchestrator | Y | Y, configured | Y, human-ready | ? | Y | Y | Y | Closest local alternative: workers, independent reviewers, CI/review/conflict feedback and attention notifications. Review defaults can inherit the worker model, so explicitly choose a different reviewer. Auto-review does not itself enable auto-merge; account usage visibility does not establish a reserve scheduler. Current repo and docs are substantially broader than old Composio YAML examples. [6][7][8][9][10][75] |
| **OpenHands + Agent Canvas Software Factory** | Y | P | Y | ? | P | P | P | Official recipe connects triage, issue implementation, separate review/test acceptance and a deterministic merge watchdog. Exact-head acceptance is especially close. Recipe uses model/API configuration and Docker execution; separate profiles are not proof of different model families. Set up the recipe per repo; no cross-repo priority/reserve policy established. [11] |
| **GitHub Copilot coding/cloud agent + Agent HQ / Mission Control / Agents** | Y | P | Y | ? | P | P | Y | Current docs expose centralized agent management, issue/event/scheduled automation and human PR review. Cloud Agent Merge repairs failed Actions and conflicts and works with auto-merge; the desktop app additionally addresses review comments. Local continuation exists, but the cloud workflow is not a local arbitrary-CLI queue. No guaranteed distinct-model review loop found. [14][15][16] |
| **OpenAI Codex Cloud + scheduled tasks + Code Review** | P | P | Y, human gate | ? | P | — for Cloud; P desktop | Y | Cloud tasks produce reviewable changes/PRs; scheduled work and automatic PR review supply components. Desktop scheduled tasks can work in local projects/worktrees. These are not documentation of a built-in cross-model, priority-ordered issue-draining daemon with a personal reserve. Current legacy Codex documentation URLs redirect to ChatGPT Learn. [17][18][19] |
| **Google Jules** | P | ? | Y, human gate | ? | P | — | Y | Repo-connected VM tasks and recurring schedules cover unattended maintenance. Scheduled is a dashboard tab; per-task VM/logs and explicitly authorized repos are documented. A distinct-model PR repair loop and predictive subscription scheduling were not established. [20][21] |
| **Cursor Cloud / Background Agents + Bugbot** | P | P | Y, review gate | ? | P | — for Cloud | Y | Cloud agents work in isolated VMs, including multi-repo environments. Bugbot Autofix starts a Cloud Agent from review findings and can publish fixes. This is real review→fix overlap, without evidence that the builder and reviewer must use different model families or that a bounded cross-provider loop is enforced. [22][23] |
| **Devin + Devin Review / bot-triggered Autofix** | Y | P | Y, human gate | ? | P | — for this cloud flow | Y | Linear condition triggers start ticket work; review-bot comments and CI failures can automatically trigger fixes. Cognition explicitly describes the resulting PR as ready for human review. Separate review service is documented; model-family independence is not. [24][25] |
| **Factory / Droid Missions** | P | P | P | P | P | Y, Droid | P | Milestone orchestration, fresh workers, validation and repair overlap strongly. Roles can use different models. Factory's own individual plans have 5-hour/7-day/30-day limits and Missions pause on limits; this is not proof of predictive scheduling against Stefan's Claude/ChatGPT subscription reserve. [12][13] |
| **Sweep** | P, historical | ? | P | ? | ? | — for former bot | P | Historical issue-bot reputation should not drive a new adoption decision: the repo now directs users to a JetBrains assistant and current docs emphasize that product. Treat the former bot as historical prior art; no explicit company shutdown or maintained replacement issue-queue service was established. [26][27] |
| **Vibe Kanban** | P | P, human feedback | Y, human workflow | ? | P | Y | P | Local agent workspaces, task board and inline review are good interface references. **Company shutdown announced April 10, 2026; community-maintained local future.** Announcement retires remote kanban issues/comments/projects/organizations. Do not assume the still-published cloud onboarding describes a supported service. [28][29] |
| **Conductor** | P | P | Y, human workflow | ? | P | Y, Mac | Y | Parallel workspaces, CLI agents, diff/check/review workflow. **Winding down:** Cloud became read-only November 13 and is scheduled to close November 20; local model/critical-fix support only through early 2027. Useful reference, poor fresh dependency for a Windows tool. [30][31] |
| **Claude Squad** | — | — | P, inspect/push | ? | P, session list | Y | ? | Terminal session/worktree manager, not a delivery controller. Multi-repo requests remain open in the checked issue list; do not infer a unified multi-repo queue from multiple sessions. Requires tmux and gh; Windows issues are reported upstream. Releases exist in 2026, so “dead” is unsupported. [32][33][76] |
| **Terragon** | P, historical automations | ? | P | ? | P | —, cloud sandboxes | Y | **Hosted service shut down February 9, 2026.** OSS snapshot supports multiple coding CLIs, subscriptions, PRs and automations, but expressly offers no maintenance/support guarantee. A cloud architecture reference, not a maintained drop-in local runner. [34][35] |
| **Sculptor / Imbue** | P | P, skills/manual review | Y, human workflow | ? | P | Y | Y | Connect repo → isolated workspace → agents → inspect/merge. Supports integrated and terminal harnesses. Explicit **experimental research preview**, with macOS/Linux downloads; a useful workbench reference rather than a verified unattended queue/review policy. [36] |
| **Crystal → Nimbalyst** | P | P, human diffs | Y, human workflow | ? | Y, agent asks | Y | P | Crystal is **no longer actively developed**; vendor identifies Nimbalyst as successor. Nimbalyst offers parallel heterogeneous sessions, session kanban, tasks, worktrees and mobile attention. No documented strict different-model acceptance/merge controller found. [37][38] |
| **Omnara** | P, build on platform | P | P | ? | P, approvals | P, own-machine daemon | P | Current positioning is a durable open-source agent API/control plane with any-model and own-machine execution, permissions and history. This is infrastructure for building such a system, not a verified turnkey GitHub delivery policy or arbitrary-CLI reserve scheduler. [39] |
| **Amp** | P | P | P, Ship/review | ? | P | Y, Amp CLI | Y | Threads can run locally, on runners or in cloud orbs; schedules/events start work. Activity has cross-project filters, and projects can include multiple repos. Good unified-history and project patterns; no verified independent-review acceptance policy or subscription reserve gate. [40][41] |
| **Superset → Paradev** | P | P | P | ? | P | Y | Y | The original Superset domain now redirects to **Paradev**, whose current product documents local/cloud workspaces, CLI-agent choice, automations and review/merge supervision. This is a rebrand, not evidence of abandonment. Do not confuse it with Apache Superset. [42] |
| **Backlog.md** | P, task source | — | — | — | P, task board | P, local task tools | P, repo-scoped | Markdown tasks, dependencies and a local Kanban UI are reusable issue-source/UI patterns. It structures agent work; it is not itself proof of a daemon running the full PR acceptance loop. [43] |
| **Taskmaster** | P | — | — | ? | P, task tools | P | P, project contexts | Planning/dependency/task tools via MCP/CLI; current README includes Claude Code and Codex subscription authentication. Authentication and task selection are not a quota scheduler or independent PR review gate. [44] |
| **Claude Code GitHub Actions** | Y, configured triggers | P, compose another reviewer | P, GitHub controls | ? | —, GitHub surfaces | P, self-hosted Actions possible | Y, per-repo workflows | Official event-driven issue→code/PR building block. Supports a subscription token as well as an API key. No native personal reserve/weekly-window scheduling is established by accepting that token. [45] |
| **CodeRabbit** | P | Y, composable service | Y, human gate | ? | P | P | Y | More than review-only today: Claude Code integration documents autonomous review/fix cycles; cloud Coding Agent supports plan/patch approval, Autofix, CI repair and conflicts. Local CLI integration still uses CodeRabbit's review service; it does not replace a whole local issue scheduler. [46][47] |
| **Graphite** | P | P | Y | ? | Y, PR inbox | — for agent service | Y | PR inbox, AI review and merge tooling; current Agents docs use Cursor Cloud Agents for PR creation/updates. Strong attention and review inspiration, not a demonstrated local subscription scheduler. [48][49] |
| **GitHub merge queue** | — | — | Y | — | P, queue/timeline | — | Y, per repo/branch | Tests changes with the target branch and queued changes; removes failed/conflicted entries. It protects integration, but does not perform agent implementation or judgment-based fixes. Availability requirements need checking for a particular private repo before adoption. [50] |
| **Mergify** | — | — | Y | — | P, conditions/reporting | — | Y | Queue and merge conditions, rule priority and reports of unmet requirements are established patterns. It can own the merge-policy part while another system owns builds/reviews. [51] |
| **bors-ng** | — | — | Y | — | P, PR comments | P, self-host bot | Y | Historical staged/batched integration prior art. **Archived April 4, 2024**; README recommends GitHub's built-in merge queue. Do not select it as a newly maintained foundation. [52] |
| **Renovate Dependency Dashboard** | —, dependency work only | — | P, approvals/automerge elsewhere | — | Y, per-repo issue | P, self-host Renovate | Y, per-repo dashboards | Excellent persistent-bot-status pattern: one updated issue, pending work, approvals and Closed/Ignored retries via checkboxes. Not a single global multi-repo attention inbox. [53] |
| **OpenAI Symphony** | Y | P, workflow-defined | P, workflow-defined | ? | P, tracker handoff | Y, Codex app-server | P | Very close architectural prior art: long-running issue polling, isolated workspaces and repository-owned workflow policy, including rate-limit telemetry. Reference demo uses Linear; adoption requires mapping the tracker/workflow and review policy. Explicit engineering preview; no documented equivalent of the runner's full reserve policy. [54][55] |
| **Aperant**, formerly Auto Claude | P | P, QA loop | P | ? | P | Y, desktop + Claude CLI | P | Autonomous tasks, issue import, QA and conflict resolution are close. Current README says a ground-up 3.0 rebuild is happening elsewhere and code PRs are paused. **Transitioning, not declared dead**; published capabilities do not establish different-model review or a personal reserve scheduler. [56] |

### The closest alternatives, and what Stefan could adopt

**Orchestrator.inc deserves the first local evaluation.** Its reviewer is separate from the branch-owning worker, can be selected independently, and can automatically feed required comments back to that worker. Automatic review waits until the worker is idle; unchanged feedback is deduplicated. These are close to the runner's one-writer and review-loop concerns. Its conflict automation requests a rebase, whereas this runner intentionally merges the base without force-pushing. Adoption therefore needs a policy comparison, not just a feature checklist. [1][7][75]

**OpenHands Software Factory deserves the second evaluation.** It already supplies most of the delivery chain, including a non-agent watchdog and acceptance tied to the current commit. Its documented recipe is API/Docker based, not the same consumer-CLI operating model. It is an alternative if Stefan is willing to change that execution/economic boundary; its screenshot walkthrough is worth studying even if they keep this runner. [11]

**Symphony is the strongest small-controller architectural reference.** Its spec separates tracker, workspace management, agent runner, orchestration state and observability, and keeps policy in `WORKFLOW.md`. It explicitly treats review/merge policy as workflow concerns rather than a universal service policy. Reuse those boundaries and recovery ideas; do not assume downloading it reproduces Stefan's cross-model ledger and post-merge live steps. [1][55]

**For a smaller change, compose existing parts.** CodeRabbit can replace a custom review-service integration if its findings, cost and acceptance semantics fit; GitHub auto-merge/merge queue or Mergify can own integration policy; Backlog.md or Taskmaster can provide task structure if the current GitHub issue conventions become inadequate. Each saves a component, and each still needs wiring to the runner's own policy. No installation or account connection was performed. [43][44][46][47][50][51]

### T3 Code ecosystem: update to the earlier research

The earlier note found general plugin proposals rather than a shipped panel SDK. **PR #33606 is now closed and unmerged**, as is #6158; this changes the earlier “open proposal” status, not the architectural recommendation. Latest stable returned by GitHub during this research was **v0.1.9**, published November 11. Its tagged docs support MCP Apps for Claude/Codex and external MCP control, but an inline tool-result app is not a permanent independent navigation extension. [3][72][73][74][77]

Bounded searches of public T3 docs, issues and repositories found **no verified ready-made T3 plugin implementing this runner's whole queue/review/reserve/live flow**. T3's thread message queue and auto-resume behavior are relevant building blocks, not evidence of a multi-repo delivery scheduler. This is a search result, not proof that no private plugin or unindexed project exists. Keep the runner-owned page and optional T3 browser embedding recommendation from the earlier note; do not adopt an unmerged SDK as though it shipped. [3][72][73][74][78]

### Verdict

**Partly reinventing, with a genuine but narrower policy gap.** Unattended issue implementation, independent review, feedback-to-fix automation, merge gating, local multi-agent supervision and attention inboxes all have substantial prior art. The checked sources do not establish a ready-made product combining Stefan's deterministic, bounded review rules with predictive scheduling against their existing consumer subscription windows, a human weekly reserve, local CLI/T3 recovery, ordered repo service and their post-merge live-step protocol. That combination can justify a small controller; it does not justify inventing new dashboard interaction conventions. Evaluate Orchestrator.inc/OpenHands before making the controller general purpose, and copy established inbox, run-detail and filtering patterns now. [1][6][7][11][13][15][24][48][54][55]

## 2. UI patterns worth copying

### A focused operational page, with details on demand

Use **Needs you → Running now → Up next / Blocked → Recent results** on the overview, retaining Usage, Activity and Settings as secondary destinations. This follows the earlier recommendation and fits the existing prototype's content. It avoids making Stefan reconstruct their next action from a wall of all agent sessions. A repo filter changes the content scope; the global attention count and access to both shared lanes remain visible. This is a proposed design for this runner. [1][2][4][5][48][57]

| Surface | Primary-source pattern | What to copy for the runner |
| --- | --- | --- |
| **Needs you** | Linear separates Priority notifications and offers keyboard triage/snooze; Graphite groups PRs by the action/handback stage. GitHub distinguishes Read, Saved and Done. [48][57][59] | One row per outstanding ask: repo/ref, decision or action, reason, age, what it blocks, destination. Labels such as **Answer**, **Decide**, **Merge**, **Finish live steps** are more useful than a generic “Error.” Viewing/opening a destination does not resolve the ask. |
| **Incoming work versus human stops** | Linear Triage is an intake queue, distinct from personal Inbox; it offers accept, decline, duplicate and snooze. [58] | Keep Ready/Blocked tickets in Queue. Keep only actual human actions in Needs you. A dependency on an unanswered ticket can appear under that ask as impact, without creating five duplicate asks. |
| **Running now** | GitHub exposes live agent logs; Orchestrator separates activity from PR readiness; Factory Mission Control shows work/progress/validation together. [9][12][14] | Exactly two shared lane cards: **Builder · Claude** and **Reviewer · Sol**, each with repo, ticket/PR, job kind, elapsed time and last observed event. Show a concrete next condition when idle. Do not invent “writing commit 3” if the runner only knows the thread is running. |
| **Queue and blockers** | Actions' graph links dependent jobs; Backlog.md exposes what a task waits on and what it unblocks. Mergify explains unmet queue conditions. [43][51][60] | Default to an ordered list, with **Next build candidate** and a plain reason per blocked item. Show blocker links in a detail drawer. A graph/tree is optional exploration; several blockers form a DAG, so a tree must disclose duplicated nodes and handle cycles/missing references. |
| **PR lifecycle** | Actions shows live job dependencies; Inngest exposes step timing and retry attempts; Temporal separates workflow history from pending activities. [60][62][63] | One chronological PR timeline with explicit commits: build → review r1 on H1 → fix → review r2 on H2 → clean → checks/merge gate → merged → live. Fix/review repetitions stay in the timeline rather than multiplying top-level columns. |
| **Controls** | OpenHands exposes automation toggles; Orchestrator distinguishes automation pausing from session/controller interruption. [11][75] | **Pause new Claude jobs**, **Resume Claude jobs**, **Weekly reserve: N%**, **Release hold**. Display scope next to each. A held-item release retries eligibility under the normal gate; it does not force a merge or waive review. |
| **Usage** | Factory exposes subscription windows and `/limits`; Orchestrator exposes provider-account usage/reset information. [10][13] | Two separately labelled Claude meters, 5-hour and weekly; used %, reset timestamp, reserved segment on weekly, and the job-fitting explanation. Keep usage account-wide and show when it was read. Sol gets its own provider-specific availability, not a borrowed Claude reserve. |
| **History/log** | Inngest splits steps into attempts and errors; Trigger.dev distinguishes a run from its retries and updates statuses in place. [63][64][65] | Human-readable activity by repo, item and job kind. Expand to attempts, raw outcome, head, review round, thread/PR link and log location. Keep failed attempts visible without mislabelling recovered work as finally failed. |

These recommendations deliberately preserve an **action inbox**, not a generic notification feed. Orchestrator's bell includes both asks and merge/completion updates; that is useful prior art, but its whole feed should not become this runner's “Needs you” badge. Linear/GitHub snoozing or dismissal also should not silently release a runner hold. If Later is implemented, specify whether it merely reorders, hides until a time, or changes scheduling. [1][9][57][59]

### A short screenshot study list

These are first-party published images or pages containing them; no login is needed to read the cited documentation. Images illustrate their publishers' products, not a tested proposal for Stefan.

| Study this | Published screenshot / walkthrough | Specific detail to examine |
| --- | --- | --- |
| Linear Inbox | [Inbox screenshot](https://webassets.linear.app/images/ornj730p/production/b442b340278740de70919c868dce1afca4335fe7-3600x2080.png), [documentation][57] | Compact list plus selected detail; action priority separate from other updates. |
| Graphite PR inbox | [Inbox sections and customization screenshots][48] | “Needs your review,” “Returned to you,” “Waiting for review,” and “Merging and recently merged.” |
| Factory Mission Control | [Running mission screenshot](https://factory.com/static/mission-control-7a5684.png), [article][12] | Current work, feature progress and validation output in one context. |
| OpenHands Software Factory | [Setup recording](https://mintcdn.com/allhandsai/7dRlHtWF6hCDgR7f/openhands/static/img/software-factory/setup.gif), [dashboard and acceptance screenshots][11] | Separate role configuration, automation health, current-head acceptance and final merge. |
| GitHub Actions | [Workflow visualization screenshot and guide][60] | Dependency connectors, recognizable job status and drill-down. |
| Buildkite | [Waterfall screenshot](https://buildkite.com/docs/assets/waterfall-view-DLHVAw8m.png), [guide][61] | Separate waiting, dispatch and execution duration. Its waterfall excludes wait/block/input steps, so it cannot directly stand in for a human-stop inbox. |
| Trigger.dev | [New-runs banner](https://trigger.dev/changelog/live-runs-page/new-runs-banner.jpg), [child-status tooltip](https://trigger.dev/changelog/live-runs-page/child-run-statuses.jpg), [changelog][65] | Existing rows update; new rows wait behind an explicit banner, avoiding disruptive list reordering. |
| Vibe Kanban | [Planning board](https://www.vibekanban.com/images/hero-panel-plan.png), [review panel](https://www.vibekanban.com/images/hero-panel-review.png), [product page][28] | Strong plan/prompt/review separation; use as historical UI reference with the shutdown caveat. |
| Primer SelectPanel | [Anatomy, grouping, footer and failure-state examples][67] | Search, stable groups, a separate additional-action footer and retryable loading errors. |

Temporal's public Web UI guide and Inngest's trace guide are better behavioral references here than invented screenshots: inspect their distinction between a logical run, a pending step and a retry. No authenticated dashboard or vendor demo was opened. [62][63]

### What to keep and correct in the existing prototype

`index.html` has three useful alternatives: A inbox-first, B strip board, C briefing/tree with a two-lane time strip. It covers needs-you, all-clear, Claude quota wait, manually stopped lane and unreadable GitHub. `app.html` consolidates Overview, Needs you, Queue, Activity, Usage and Controls, adds Board/Tree plus a blocker drawer, and adds Sol-out-of-usage. The content inventory is already close; the next iteration needs stronger state semantics more than another visual theme. [4][5]

Recommended adjustments, based on the design rather than new implementation:

- **Keep A's attention priority and app.html's detail drawer.** Make Queue a list by default; offer the board/tree as secondary views only when they help understand blockers. [2][4][5][43]
- **Add PR detail/history.** Neither current drawer represents review rounds, the reviewed SHA, fix attempts, merge gates and live batches together. Show each review against its head; when H moves, keep the old clean result in history and show the new head awaiting review. [1][4][5]
- **Fix pause copy.** The current runner prevents new Claude jobs; it does not pause Sol, cut a running job at a “step” boundary, or promise automatic continuation from the exact same instruction. The prototype's global pause-on-Sol-stop and per-lane “Stop after this step” are proposed capabilities, not present behavior. [1][4][5]
- **Fix reserve copy.** The prototype says six hours before reset and includes a Monday-reset “spend this week” switch. The design says the last **24 hours**, uses the provider's actual reset, and exposes a persistent reserve percentage knob. Do not ship a temporary-override switch without implementing its expiration. [1][4][5]
- **Make usage honest.** Claude before/after readings include Stefan's other sessions and reset-window uncertainty. They are observed window deltas, not precise per-job billing. Continuous Sol percentage meters and the fake cost-by-model table need real telemetry before presenting them as facts. [1][5]
- **Do not clear an ask just because its link opened.** `app.html` currently moves the fake ask to Done on its action handler; “Open PR” is not a confirmed merge. Acknowledge opening, retain the ask, and let the runner confirm resolution. [1][5][59]
- **Complete the missing cases.** Add empty queue, service stopped, startup waiting for T3, usage unreadable, restart recovery, decision running, held PR, clean-but-checks-pending, conflict round, merge-ready, live partial/unknown and merged-with-human-live-todo. Also show “3 asks in other repos” while filtered. These are proposed test scenarios derived from the actual flow. [1]

## 3. Multiple repositories: aggregate first, filter second

### What the primary sources actually establish

| Product/pattern | Navigation and scope | Adding repositories | Ordering evidence and implication |
| --- | --- | --- | --- |
| Graphite | Unified PR inbox over selected default repos; action-based sections. [48] | Select which repos belong in the inbox. | Section ordering is customizable. Do not assume that means repository scheduling priority. |
| Orchestrator.inc | Sidebar of projects/sessions plus a cross-project board. [8] | Register local repo path; current `project add` does not clone URLs. | Per-project settings are independent; no runner-style global repo priority is established by this guide. |
| Amp | Recent/pinned threads grouped by project; Activity filters across projects. [40] | Connected GitHub/GitLab picker, HTTPS URL for other hosts, or scratch repo. [41] | Pinned first, then active by project; older threads collapse. This is attention/recency ordering, not execution priority. |
| Vercel | Shared navigation at team and project scope; projects act as filters. [66] | Add New → Project → import a Git repository. [79] | The useful pattern is preserving the current page while changing scope, rather than sending the user to a different application. |
| Jules | Repo-connected tasks with independent VM/log context. [20] | GitHub explicitly authorizes access to selected repos. | Access selection and task environment selection are separate concerns from queue priority. |
| Primer | Searchable single/multi-select panel, grouping and footer actions. [67] | Additional navigation/action belongs in a footer. | A component can preserve domain order; search is optional for very small lists. |

### Recommended choice for 2–10 priority-ordered repos

Use **one repo scope picker above the page content**, alongside the existing functional navigation. Start with **All repositories**; list `1 · owner/repo`, `2 · owner/repo`, etc. in configuration order. Give each row a small human-ask count and optional health indicator. Search filters that stable order; it does not silently sort by recent use. This is a design proposal combining a unified inbox/filter model with the runner's actual priority contract. [1][48][66][67]

Keep **Needs you, Queue, Activity** as the sidebar destinations. A permanent second sidebar containing only two repository names is unnecessary; at ten repos, the picker still works. Preserve page and filter in the URL, e.g. `?repo=owner/name#queue`, and preserve selection after refresh. Keep a visible route back to global attention. Amp's URL-backed filters provide precedent for bookmarkable scope. [40]

**Selection is a viewing action; priority is a scheduling setting.** Put “Edit repository priority” in Settings with an ordered list and keyboard-accessible Move up/Move down. Explain the consequence: after recovery/decisions/live/fixes, the first eligible repo supplies the next build. Do not offer drag-and-drop on the displayed queue unless the scheduler really accepts manual order. Show a warning of possible starvation for lower-priority repos as an explanatory consequence of strict priority, not as a proven current incident. [1]

The next work is not always the first Ready issue: the Claude lane considers recovery/settlement, decisions, live work and fixes before a new build, while the Sol lane independently merges/reviews. Label the list **Build candidates, in priority order**, and show **Next Claude job: fix …** above it. A repo filter must not imply a dedicated Claude/Sol pair for every repo; there are two lanes total. [1]

### Adding/importing a repo

Put **Add repository…** below a divider in the picker, as a separate button/footer outside its selectable repo options. A remote repo selection and a local execution folder are different facts. The proposed add flow is: [1][8][41][67]

1. **Use a local repository** by default for today's runner: select folder, read Git remotes/base branch, show detected `owner/repo`, and validate that the folder is a usable clone. Do not infer that a GitHub authorization automatically created a local clone. [1][8]
2. Offer **Clone from URL / Choose from GitHub** later if implemented: choose the authorized remote and destination folder, then clone explicitly. Display GitHub permissions separately from agent login/setup. A GitHub App can restrict access to selected repositories. [41][71]
3. Review **base branch, issue source, merge owner, optional live-step doc and insertion priority**. Use the product label **Human merges** rather than hardcoding Stefan's name in a general-purpose version. Existing configuration has these distinct policies. [1]
4. Finish with a **configured but disabled** repo until checks/settings are confirmed, so import does not unexpectedly start issue builds. This is a proposed onboarding policy, not existing runner functionality. Adding it requires an actual enabled/disabled setting; the dashboard cannot pretend that policy exists today. [1]

### Accessibility: choose the implementation pattern deliberately

The WAI-ARIA APG allows both editable and select-only comboboxes; an ordinary single-select can be sufficient for a tiny fixed list. For a custom editable picker, provide an accessible name, `aria-expanded`, `aria-controls`, appropriate popup/listbox semantics, selected/active-option tracking, arrow navigation, Enter selection and Escape dismissal. Preserve ordinary text-editing keys. **Add repository is an action, not a fake repository option**; keep it outside the listbox and reachable by keyboard. [68]

Primer SelectPanel is a **dialog-based** searchable selection pattern with grouping and a footer, not a synonym for every APG combobox. Either use that component's complete accessible pattern or implement an APG combobox; do not mix dialog focus trapping with listbox focus rules by appearance alone. At two repos a native select plus adjacent Add button is a reasonable first implementation; adopt a searchable component as the list grows. [67][68]

## 4. A minimal user-facing state model

### Use separate dimensions rather than one giant enum

The following is a **proposed projection of existing runner facts**, not a request to rename the JSONL outcomes. Derive the display from the current item/head, active writer, effective review, hold, job and gate. Keep the raw events available in details. Orchestrator similarly derives display state from runtime/PR facts; Trigger.dev distinguishes runs from attempts; Temporal can keep a workflow Running while a task fails or waits. [1][9][62][64][80]

For each work item carry five display dimensions: **phase** (what part of delivery), **execution** (queued/running/waiting/finished), **blockers** (why progress cannot occur), **attention** (a concrete human action or none), and **freshness** (observed time/error). This prevents combinatorial labels such as “review-failed-gated-held-stale” while preserving the facts Stefan needs. [1]

### A. Issue/ticket

| Main state | Meaning and secondary information |
| --- | --- |
| **Not ready** | Backlog/intake; not marked ready for the agent, or a parent/spec with unfinished children. |
| **Ready** | Meets issue-level eligibility; may still wait for a free lane or usage. Show position and any lane-wide wait separately. |
| **In progress** | Has an active/recoverable build or a linked open PR; keep the issue here while its PR is reviewed/fixed. |
| **Blocked** | A dependency or missing prerequisite prevents eligibility. Show the exact blocker; it is not automatically a human ask. |
| **Held** | A prior job/explicit hold prevents another build until release or resolution. Add **Needs you** only when the runner has actually assigned a decision/action to the human. |
| **Done / Closed** | Distinguish completion from “closed, not planned” in the reason. A merged issue may still have pending live work on its PR. |

These states summarize picker, writer, hold and tracker behavior; they are not all literal GitHub labels. A ready issue waiting for a quota reset should remain Ready, with “Claude resumes after …”; a usage-limited build remains In progress, with “Waiting for usage,” so a second build cannot be accidentally offered. [1]

### B. Pull request

Use eight phases: **Building/draft → Awaiting review → Reviewing → Fixing → Ready → Merging → Merged**, plus **Closed without merge**. Fixing covers ordinary and conflict rounds, with the cause shown in text. It can return to Awaiting review on a new head. Pausing/holding is an overlay, not a ninth pipeline column. [1]

**Ready** needs a gate summary, not just a green review badge:

- **Clean, waiting for checks**: no human merge action yet.
- **Clean, waiting for other merge conditions**: show the specific writer/live/reply/thread condition.
- **Ready for your merge**: current re-check passes and the repo's policy assigns merging to the human; appears in Needs you.
- **Ready for automatic merge**: current re-check passes and runner-owned merge is enabled; show the next automatic step.

All four use review evidence tied to the displayed head. A newly pushed head invalidates readiness immediately while preserving the old clean review in history. The distinction mirrors Graphite's Approved/Waiting/Merging groupings but applies this runner's stricter merge re-check. [1][48]

Track **live state independently** once merged: **Not required**, **Pending**, **Running**, **Live**, **Needs attention**, or **Unknown**. A partial/failed batch can be Merged + Needs attention; uncertain application after an interrupted/usage-limited job must not be displayed as unapplied or fully live. “Assumed live at first observation” deserves that qualifier. Human `live-todo` can coexist with a successful Live result and does not imply the repo's automation is held. Live progress is batch-scoped, so link every affected PR to one batch rather than inventing one job per PR. [1]

### C. Lane and job

| Object | Minimal states | What to show with them |
| --- | --- | --- |
| **Lane** | **Working**, **Idle**, **Waiting**, **Paused**, **Unavailable** | Working includes build/fix/conflict/decision/live or review/merge activity. Waiting has an automatic condition and optional resume time. Paused means the supported operator policy inhibits new starts. Unavailable means a required dependency/read failed; include freshness and retry behavior. |
| **Job/run** | **Queued**, **Running**, **Waiting**, **Succeeded**, **Failed**, **Canceled** | Kind, item, model/harness, attempt, timestamps and result. Recovery/settling is a Running subphase or recovery note. Distinguish a failed attempt from a final failed logical job. |

“Waiting” needs a subtype: **usage reset**, **capacity**, **checks**, **dependency**, or **human input**. Only the last subtype contributes to Needs you, and only after the runner's decision/escalation logic has assigned it to the human. The existing CLI pause applies to Claude starts; Sol is not Paused simply because Claude is. Job Canceled is useful only where an explicit cancellation is actually observed; do not map a crash to canceled. [1][64]

Comparable vocabulary is familiar: Orchestrator uses Active, Idle, Waiting for input, Blocked and Exited; Trigger.dev uses Queued, Executing, Waiting, Completed, Canceled and Failed among more detailed outcomes. Temporal's Running can include waiting. Borrow the broad vocabulary while retaining the runner's domain-specific reasons. [9][64][80]

### D. Runner

Use process states **Starting**, **Running**, **Restarting**, **Stopped**, **Failed**. Put **Claude starts paused** beside process state as a policy flag. Put **Degraded** beside it as a health flag with the affected dependency/repo. “Running · Claude starts paused · Sol reviewing …” is accurate; “Everything paused” is not. Before T3 answers at startup, show Starting / Waiting for T3. During self-update, show Restarting with the observed handoff; do not claim a successful restart until the runner's own confirmation. [1]

The page connection is another dimension: **Live**, **Reconnecting**, **Stale**. If the server stops responding, label last-known process state with its timestamp rather than asserting that the runner died. Similarly, unreadable GitHub means “Could not check all attention,” not “Nothing needs you.” Do not convert a runtime probe failure into proof of a dead session; Orchestrator makes that distinction explicitly. [1][2][9]

### Collapse internal outcomes by consequence

| Internal event/outcome | Display projection | Attention / recovery meaning |
| --- | --- | --- |
| `not-started` | **Queued / retry pending**, with attempt detail | No thread existed; ordinary build eligibility is not consumed. A repeatable infrastructure failure can show Unavailable, without inventing a stop. |
| `not-sent` | Earlier job stays **Waiting**; continuation attempt **Failed to send** in history | No new agent run; preserve the prior hold and let the runner retry its decision flow. |
| `branch-exists` | **Held — workspace/branch prevents start** | Do not label Building or success. The runner's job-kind/decision/stop rules determine whether Stefan is needed. |
| `usage-limit`, `out-of-usage`, gate `gated` | Lane/job **Waiting for usage**, with resume time or Unknown | Automatic recovery; no human ask merely because a provider quota was reached. Preserve PR writer ownership where applicable. |
| Review/merge `head-moved` | PR **Awaiting review** for the current head | Prior attempt is superseded, not a new human failure; no clean status is carried forward. |
| Review `blocking` | PR **Fixing queued**, with findings count | Automated fix if eligible. If escalation/hold applies, overlay Held and the actual ask instead. |
| Review `stop`, `approach-note` | **Held / decision pending**, then **Needs your decision** when the stop exists | An approach-note decision job may still be automatic. Do not announce a human ask before its note/stop is actually available. |
| Build/fix `failed`, `waiting`, build `done-no-pr` | **Recovery/decision pending**; attempt retains its actual result | A decision runs first. Only its stop goes into Needs you; `done-no-pr` is not issue delivery success. |
| Fix `pushed` | **Awaiting review** on new head | Fix job succeeded; PR is not necessarily clean. |
| Fix `no-push` | **Held**, with no-change/conflict reason | Follow the runner's stop handling; do not call the head accepted. |
| Fix `head-unknown` | **Checking PR head / status unknown** | Reconcile with GitHub before projecting success or a human ask; conflict rules may produce a stop. |
| Ready `marked` / `unmarked` | **Ready for your merge** / readiness withdrawn | A label is a mark, not evidence of a completed merge. |
| Merge `merged` | **Merged**, then independent live state | Never collapse “merged” into “live.” |
| Live `partial`, `stop`, `failed` | **Merged · Live needs attention** | Show applied/maybe-applied facts and batch stop; hold further live runs in that repo as designed. |
| Live `usage-limit` | **Merged · Live waiting for usage** | Automatic wait; applied state may be uncertain and needs verification on recovery. |
| Live `assumed` | **Live — assumed at first observation** | Baseline, not proof that the runner executed those steps. |
| `restart-failed`, unreadable gate/log | **Held / Runner needs repair**, according to scope | Show the actual repair/release route; keep separate from ordinary review findings. |
| Stop filing `failed`, toast failed | **Escalation pending** or delivery warning | A failed toast must not remove a durable ask; an unfiled stop must not be falsely represented as a successfully linked needs-info issue. |

This mapping follows the documented job-kind-specific semantics, not string matching alone. For example, `failed` on a review attempt, a live batch and a build have different next steps. Release events change eligibility; they are not proof that the original problem was fixed. Keep a stable identity such as `(repository, PR/issue, stop, head)` and link repeated observations to the same ask. [1][2]

### A useful PR detail contract

Show **identity + current head + current phase**, then **what happens next / why it waits**, then **the one available human action**, and then the timeline. Expand a review to its verdict/findings and a fix to pushed commits; expand a live batch to migrations/functions and human todos. Include external source links rather than embedding all raw logs on the overview. This is a proposed interaction contract grounded in the runner's ledger and the run-detail patterns above. [1][48][62][63]

## 5. Going agnostic: keep these seams small

1. **Separate delivery policy from agent sessions.** Define start/send/read/cancel/recover and capability metadata behind an AgentSession adapter; preserve provider thread IDs and links as opaque data. T3 CLI can remain the first adapter. Direct agent CLIs, Codex app-server or ACP are additional adapters, not reasons to rewrite merge/hold policy. Orchestrator and Symphony provide concrete boundary examples. [1][6][55]
2. **Use ACP where its session capabilities fit.** ACP standardizes editor/client↔agent communication, with local subprocess JSON-RPC over stdio; remote support is still described as work in progress. Check actual model, effort, permissions and resume support per implementation. **MCP** instead connects AI applications to tools/data; it can expose runner status/control or invoke T3's external tools, but neither standard defines this runner's queue policy or subscription reserve. [69][70][74]
3. **Separate quota policy from quota measurement.** A UsageProvider returns observed windows/reset times/freshness and capability/unknown state; policy decides fits/reserve/retry. Do not require every agent to expose Claude-shaped five-hour/week telemetry or reinterpret API spend as subscription availability. Keep reviewer/builder roles independent from Claude/Codex brand names. [1][10][13]
4. **Keep forge, issue source and execution checkout separate.** Continue with existing local gh authentication for Stefan; make GitHub App installation an optional multi-user distribution path, using selected-repo permissions and installation identity rather than distributing Stefan's PAT. App hosting/auth still needs an implementation. Repo onboarding can support GitHub picker, local folder and clone URL independently. [1][8][41][71]
5. **Publish a runner-owned read model and control API.** Keep dashboard projections and command acknowledgements outside T3. Embed the same localhost page when useful; support an MCP App only as an optional viewer/control surface with its host lifecycle limitations. This carries forward the earlier recommendation instead of introducing another UI/plugin dependency. [2][3][73]

## Coverage and checks not done

**Every named candidate was checked**: GitHub Copilot/Agent HQ/Mission Control, Codex Cloud, Jules, Cursor, Devin, Factory, Sweep, OpenHands, Vibe Kanban, Conductor, Claude Squad, Terragon, Sculptor, Crystal/Nimbalyst, Omnara, Amp, Superset/Paradev, Backlog.md, Taskmaster, Claude Code GitHub Actions, CodeRabbit, Graphite, GitHub merge queue, Mergify, bors-ng and Renovate. Added Orchestrator.inc, Symphony and Aperant because their primary sources showed substantial overlap. UI sources additionally cover Linear, GitHub notifications/Actions, Buildkite, Temporal, Inngest, Trigger.dev, Primer, Vercel and WAI-ARIA APG. [6]–[80]

**Reachability and evidence limits:** no entire named candidate was unreachable. Some guessed/legacy routes failed: Factory's old Missions/index URLs redirected or could not be fetched, an OpenHands setup Markdown route failed, and several CodeRabbit Markdown/old onboarding routes failed. Read the accessible first-party Missions/pricing, Software Factory and canonical CodeRabbit pages instead. Sweep's docs homepage was indexed but a direct fetch returned HTTP 502; its accessible source repo confirms the JetBrains pivot. Amp's guessed `/docs/automations` route failed; its accessible Threads page establishes scheduled/event starts, but deeper scheduling semantics remain unverified. Primary sources disagree in freshness in places: Vibe's setup docs remain live despite its shutdown announcement, and Conductor's general marketing/FAQ is less decisive than its dated wind-down changelog. Prefer the explicit announcements. [11][12][13][26][27][29][31][40][46][47]

Not done:

- No sign-ins, product installations, trial accounts, authenticated inboxes or hands-on workflow runs; no claim of comparative reliability, review quality or operating cost.
- No exhaustive public-code audit of every candidate; **?** means unverified, and separate reviewer is not proof of a different underlying model.
- No proof of absence of private/unindexed T3 plugins; no T3 update, API authentication, agent launch or installed-app reinspection.
- No prototype browser rendering, screenshots of Stefan's UI, screen-reader/keyboard testing or usability study. Screenshot links are publisher assets extracted from their public pages.
- No implementation, runner invocation, GitHub posts, notifications, remote pushes, dependency changes or repository tests. Tests are not needed for this research artifact. Only this Markdown file was written; existing untracked research/prototype files were left alone. The completed report is committed locally under the repo's working agreement.

## Numbered primary-source references

Local evidence is deliberately distinguished from web evidence. URLs without a pinned version describe what was observable on 2026-11-14 and may change.

[1]: C:/Users/Anon/Code/Personal/queue-runner/AGENTS.md
[2]: C:/Users/Anon/Code/Personal/queue-runner/.scratch/queue-runner/research/attention-ux.md
[3]: C:/Users/Anon/Code/Personal/queue-runner/.scratch/queue-runner/research/t3-extension-points.md
[4]: C:/Users/Anon/Code/Personal/queue-runner/.scratch/queue-runner/prototype-dashboard/index.html
[5]: C:/Users/Anon/Code/Personal/queue-runner/.scratch/queue-runner/prototype-dashboard/app.html
[6]: https://github.com/OrchestratorInc/agent-orchestrator
[7]: https://docs.orchestrator.inc/guides/review-loop/
[8]: https://docs.orchestrator.inc/guides/multi-project/
[9]: https://docs.orchestrator.inc/dashboard/
[10]: https://docs.orchestrator.inc/plugins/agents/codex/
[11]: https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md
[12]: https://factory.com/news/missions
[13]: https://docs.factory.com/pricing/individuals
[14]: https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/agent-management
[15]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests
[16]: https://docs.github.com/en/copilot/how-tos/github-copilot-app/managing-issues-and-pull-requests
[17]: https://learn.chatgpt.com/docs/cloud.md
[18]: https://learn.chatgpt.com/docs/automations.md
[19]: https://developers.openai.com/blog/custom-code-review-rules-for-codex
[20]: https://jules.google/docs/tasks-repos
[21]: https://jules.google/docs/scheduled-tasks
[22]: https://cursor.com/docs/cloud-agent
[23]: https://prod.cursor.com/docs/bugbot
[24]: https://cognition.com/blog/closing-the-agent-loop-devin-autofixes-review-comments
[25]: https://docs.devin.ai/integrations/linear
[26]: https://github.com/sweepai/sweep
[27]: https://docs.sweep.dev/
[28]: https://www.vibekanban.com/
[29]: https://www.vibekanban.com/blog/shutdown
[30]: https://www.conductor.build/Docs
[31]: https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta
[32]: https://github.com/smtg-ai/claude-squad
[33]: https://github.com/smtg-ai/claude-squad/issues
[34]: https://www.terragonlabs.com/
[35]: https://github.com/terragon-labs/terragon-oss
[36]: https://github.com/imbue-ai/sculptor
[37]: https://github.com/Nimbalyst/nimbalyst
[38]: https://nimbalyst.com/crystal/
[39]: https://www.omnara.com/
[40]: https://ampcode.com/docs/threads
[41]: https://ampcode.com/docs/projects
[42]: https://paradev.com/
[43]: https://github.com/MrLesk/Backlog.md
[44]: https://github.com/eyaltoledano/claude-task-master/blob/main/README.md
[45]: https://code.claude.com/docs/en/github-actions
[46]: https://docs.coderabbit.ai/cli/claude-code-integration
[47]: https://docs.coderabbit.ai/code
[48]: https://graphite.com/docs/use-pr-inbox
[49]: https://graphite.com/docs/agents
[50]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
[51]: https://docs.mergify.com/merge-queue/rules/
[52]: https://github.com/bors-ng/bors-ng
[53]: https://docs.renovatebot.com/key-concepts/dashboard/
[54]: https://github.com/openai/symphony
[55]: https://github.com/openai/symphony/blob/main/SPEC.md
[56]: https://github.com/AndyMik90/Aperant
[57]: https://linear.app/docs/inbox
[58]: https://linear.app/docs/triage
[59]: https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox
[60]: https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph
[61]: https://buildkite.com/docs/pipelines/insights/waterfall
[62]: https://docs.temporal.io/web-ui
[63]: https://www.inngest.com/docs/platform-and-operations/traces
[64]: https://trigger.dev/docs/runs
[65]: https://trigger.dev/changelog/live-runs-page
[66]: https://vercel.com/changelog/dashboard-navigation-redesign-rollout
[67]: https://primer.style/product/components/select-panel/guidelines/
[68]: https://www.w3.org/WAI/ARIA/apg/patterns/combobox/
[69]: https://agentclientprotocol.com/get-started/introduction
[70]: https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro
[71]: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps
[72]: https://github.com/pingdotgg/t3code/pull/33606
[73]: https://github.com/pingdotgg/t3code/blob/v0.1.9/docs/user/html-renders.md
[74]: https://github.com/pingdotgg/t3code/blob/v0.1.9/docs/user/outside-agents.md
[75]: https://docs.orchestrator.inc/configuration/lifecycle-automation/
[76]: https://github.com/smtg-ai/claude-squad/releases
[77]: https://github.com/pingdotgg/t3code/releases/tag/v0.1.9
[78]: https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
[79]: https://vercel.com/docs/projects/managing-projects
[80]: https://docs.temporal.io/workflow-execution
