# 36: Read and snoozed, kept by the runner

**What to build:** which asks Stefan has read or snoozed is the same in every browser, because
the real page keeps it with the runner instead of in the browser.

**Blocked by:** 31

**Status:** done (2026-11-15)

Spec: `../dashboard-live.md`. Today both live in the browser's localStorage (AGENTS.md, The
dashboard, Read and snoozed), so Firefox and Chrome disagree.

- [x] `POST /control` takes `{"ask": <id>, "read": true|false}` and `{"ask": <id>,
      "snooze_until": <ISO time>|null}`, kept under `asks` in `control.json`.
- [x] The snapshot's asks carry `read` and `snoozed_until`, and the page reads those. A snooze
      whose time has passed is over.
- [x] A snoozed ask is out of the count and still holds its work up.
- [x] Entries for asks that no longer exist are dropped.
- [x] The sample addresses behave the same, through the sample's own control file.

## Comments

- 2026-11-15 (built): the sample changed with the page, as the spec asks: every sample ask
  and answered ask now carries `read` (false) and `snoozed_until` (null), and the pretend
  runner (`_obey`) applies its own control file's `asks` a few seconds after the write. An ask
  is keyed by its id alone (the page used `id@since`): a stop, review or head that comes back
  is a new job, so a new id, and unread again. Dropping gone asks happens when the page
  writes (the runner writes no control file): against the snapshot's asks and answered asks,
  every sample state's on the sample addresses, and nothing is dropped with no snapshot to go
  by. A bad `asks` entry is left out, never making control.json unreadable. Not built: the
  runner holding a snoozed ask's toast.
