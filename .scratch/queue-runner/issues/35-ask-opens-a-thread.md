# 35: An ask opens a T3 thread to decide in

**What to build:** on a stopped PR's ask, Stefan clicks "Decide in T3"; the runner starts a
thread briefed with the ask, he talks it through there, and the runner acts on the answer the
thread ends with.

**Blocked by:** 30, 31

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`; ticket 18's last box. Decided here (mine, his to overturn):

- The thread starts only on his click, never by itself.
- It is a Claude job, gated as a decision. While the Claude lane is stopped the request is
  kept, and the page says it starts when the lane resumes.
- The answer is the `reply` question's (`decisions.py`): `fix`, `carry-on`, `hold` or `stop`,
  in a `queue-runner-decision` block, acted on as a reply to the stop is today.

- [x] `POST /control` takes `{"ask": <id>, "open": true}`; anything else about an ask is
      refused. The page shows it as asked until the runner has read it.
- [x] The runner starts `Queue runner ask: <repo>#<n>` in the repo's T3 project with no
      worktree and doesn't wait on it; its brief (`templates/ask.md`) has the ask, the PR's
      open findings and the earlier threads, and tells the thread to end with the block once
      Stefan has decided.
- [x] Once per ask. The ask's `go` then opens the thread, and the `needs-info` issue stays
      linked as the other place to answer.
- [x] Each pass the runner reads the thread's last reply; a readable block is acted on and
      recorded, and the ask moves to `answered`. No block yet changes nothing.
- [x] An answer on GitHub meanwhile still counts, and the stop is decided once.

## Comments

- 2026-11-15 (built): `queue_runner/ask_threads.py` and `templates/ask.md`; AGENTS.md "Deciding an
  ask in T3". **The sample changed with the page** (the spec's rule): every ask now has `decide`
  (null, or `{state: offered | asked | open, at, note}`) and `also` (the other place to answer:
  the needs-info issue once `go` is the thread). In the sample, ask-152 is `open` and the `many`
  state's ask-qr4 is `offered`, its `go` now its needs-info issue; the pretend runner plays
  reading a request. Mechanics decided here: the asks that can be opened are PR stops a reply
  answers (not `live` or `live-todo`); a stop answered in its thread is `answered` with `answer`
  `thread`, followed by a `reply` decision whose `link` is the thread; an ask thread is opened
  before decisions (after a job a limit cut off) and its answers are read at the start of each
  Claude pass, after the lane's switch, so a stopped lane or repo neither opens nor reads; a
  malformed block is said once and waits for another; the ask thread teaches the gate's learned
  costs nothing; `--once --dry-run` prints the thread it would open. Checked by hand on
  `queue.localhost` against a temp state folder: offered, asked and unread, asked with the
  Claude lane stopped ("It starts when you resume the Claude lane."), open (the thread and the
  needs-info issue), and answered in the Decided group.
