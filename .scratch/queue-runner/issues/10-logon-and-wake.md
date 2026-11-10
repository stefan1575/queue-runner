# 10: Start at logon and wake the PC for resume times

**What to build:** the runner runs unattended. One `pythonw` instance starts at logon (a Startup
shortcut, single-instance guarded) and logs to its own file. Whenever it is waiting for a time
(a 5-hour reset, a limit's resume), it sets a one-off Windows wake task for that time so the
sleeping PC wakes; the keep-awake hooks hold the PC while a job runs. Wake tasks it set are
removed once used or no longer needed. The Startup shortcut is made but left out of the Startup
folder until the cutover (13), so the runner doesn't race the old script.

**Blocked by:** 09

**Status:** done

- [x] A second start exits at once, and the log says so.
- [x] Wake tasks are one-off, named as the runner's, set with wake-to-run, and cleaned up; tested
      against a fake scheduler, then checked live once by setting one a few minutes ahead and
      letting the PC sleep (or Stefan's word in Comments).
- [x] The runner survives T3 not being up yet at logon: it waits for T3's server, without AI.
- [x] `AGENTS.md` says how to stop, restart and read the runner's log.

## Comments

- 2026-11-10, Claude: built in queue-runner `a7f635d`, with fixes from Sol's review in `c350be3`
  (Sol found four Important issues, all fixed: a wake task set earlier was deleted in its last
  minute; the two 01:30s of a DST change shared a name; `--stop` could kill a reused pid; an
  unknown T3 project held the start forever). 330 tests pass.
  - **Single instance:** a second start logs `a second runner started (pid N) and exited at
    once` and exits 3. The shortcut is `~/.queue-runner/Queue runner.lnk` (pythonw `-m
    queue_runner` in the repo). It isn't in Startup yet; ticket 13 copies it there.
  - **Wake tasks** are in `\Queue runner\` and named `wake YYYY-MM-DD HHMM+0800`. Each is a
    one-off time trigger with wake to run. Its action is pythonw holding off sleep for 10 minutes.
    The next sync deletes it once it has fired or nothing waits for it, and Windows deletes it an
    hour after its time anyway. Tested against `FakeScheduler`.
  - **Live, without sleep** (`scripts/live_wake.py 2`): Task Scheduler showed `WakeToRun=True` and
    one `MSFT_TaskTimeTrigger` at 10:15+08:00 with no repetition. It ran at 10:15 (result
    `0x41301`, the hold still running) and was then removed.
  - **Sleep leg confirmed** (Stefan's go-ahead to run it, 2026-11-10): `live_wake.py 3 --sleep`
    slept the PC at 10:49:12, and it woke at 10:53:06. The System log named the source as
    `\Queue runner\wake 2026-11-10 1053+0800`. The task ran (`0x41301`, the hold running) and
    was removed. Still untested: waking from hibernate. The PC moves from sleep to hibernate after
    a while ("S4 Doze to Hibernate"), so a wait of hours may find it hibernated. Watch the first
    long wait.
