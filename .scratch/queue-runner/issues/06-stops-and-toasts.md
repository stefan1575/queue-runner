# 06: File stops for Stefan and toast them

**What to build:** when the loop has to come to Stefan (`~/.claude/docs/pr-review.md`, Stops: a
same-class Important finding, a fixed finding reopening, a decline Sol keeps, a failed check or a
conflict, review 3 still blocking), the runner records the stop on the PR, opens or updates one
`needs-info` issue per PR, toasts Stefan, and leaves that PR alone until Stefan answers. The toast
is a native Windows toast under the runner's own name and icon (not PowerShell's); clicking it
opens the `needs-info` issue. Mechanics: the PR re-enters the loop when its `needs-info` issue is
closed or Stefan replies on the PR (a reply goes to 07's decision thread). Review 3's Approach
note is 07's; until 07 lands, review 3 stops without it.

**Blocked by:** 04

**Status:** done (2026-11-10)

- [x] Each stop kind is detected and filed, tested against fakes; a second stop on the same PR
      updates its existing `needs-info` issue rather than opening another.
- [x] The toast shows the runner's name and icon, says which PR and why, and opens the issue on
      click; checked live once with a test toast (screenshot or Stefan's word in Comments).
- [x] Verify (spec): whether T3's thread notifications can be limited to threads that need
      Stefan. If so, set `notificationMode` to notifications only; if not, leave it `off` and
      have the runner toast for a job thread that exits waiting for an answer (exit 2). Record
      the finding in Comments.

## Comments

**2026-11-10, built** in `~/Code/Personal/queue-runner`, commits `85dfaf7` and `29208a8` (the
code review's fixes). All 220 tests pass (`python3 -m unittest`). The runner's `AGENTS.md`
documents the flow under "Stops for Stefan".

What's there:
- **Stops** (`stops.py`, in the Sol lane, before merges): every open PR's head H is checked
  each pass, and each kind is filed once per H. The kinds:
  - `review`: a repeated class, a reopened finding, or a kept decline.
  - `approach-note`: review 3 or later still blocking.
  - `no-push`: a fix round that pushed nothing (05 handed this one over).
  - `failed-check`.
  - `conflict`.

  PRs the old script has, or that a Claude job is still writing to, get no stops.
- **Filing:** the PR's one open `needs-info` issue, found by a hidden line, gets a later stop
  as a comment; with none open, one is filed. A comment on the PR records the stop and links
  the issue. Then a toast whose click opens the issue.
- **Hold:** while a stop is unanswered, the PR gets no review (even on a new head), no fix round
  and no merge. It's answered when its issue is closed or someone replies on the PR; the
  runner's own comments and bots don't count. `--release NAME#PR` also lets it go.

**Toast, checked live 2026-11-10:** a test toast showed as **Queue runner** with the runner's
own icon, not PowerShell's (screenshot: `.scratch/queue-runner/evidence/06-test-toast.png`). It
works by registering the runner's own AppUserModelID (`Stefan.QueueRunner`) under
`HKCU\Software\Classes\AppUserModelId`; PowerShell only carries the WinRT call. A click opens
the URL through `activationType="protocol"`, and the button does too. **I didn't click it
myself.** It pointed at the sandbox repo's issues page; a word from you that clicking opens
the page would close that part.

**Verify, T3's thread notifications:** they can't be limited to threads that need you. T3's
client code (`resources/server.asar`, the notification gate) notifies on every completed thread
and on every thread that needs attention. That covers input, approval, usage limit and failure,
for every thread that isn't archived or hidden. So `notificationMode` stays `off` (it is), and
the runner toasts when a build or fix thread exits waiting for an answer (exit 2); the click
opens the thread.

**For you (not blocking):**
- **On the first real run,** leads-dashboard #153 and #154 conflict with main, so each gets a
  `needs-info` issue, a PR comment and a toast (`--once --dry-run` lists them under "Stops for
  Stefan").
- **Closing the issue on a head already reviewed starts nothing new.** For a `review`,
  `approach-note` or `no-push` stop, the PR goes back to the loop, but the loop has nothing to do
  at that head until a push (or `--release` for another fix round). Acting on what you decide
  (rework, fix on, hold) is 07's: its decision thread reads your answer. For a failed check or a
  conflict, closing the issue after a rerun or a fix lets the PR carry on.
- **Earlier full test runs during this build** may have shown you one or two real toasts titled
  "first: a build thread asks you something". A test went through the CLI without a fake toaster.
  The code review caught it, and it's fixed in `29208a8`.
