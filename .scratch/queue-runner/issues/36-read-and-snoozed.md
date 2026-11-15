# 36: Read and snoozed, kept by the runner

**What to build:** which asks Stefan has read or snoozed is the same in every browser, because
the real page keeps it with the runner instead of in the browser.

**Blocked by:** 31

**Status:** ready-for-agent

Spec: `../dashboard-live.md`. Today both live in the browser's localStorage (AGENTS.md, The
dashboard, Read and snoozed), so Firefox and Chrome disagree.

- [ ] `POST /control` takes `{"ask": <id>, "read": true|false}` and `{"ask": <id>,
      "snooze_until": <ISO time>|null}`, kept under `asks` in `control.json`.
- [ ] The snapshot's asks carry `read` and `snoozed_until`, and the page reads those. A snooze
      whose time has passed is over.
- [ ] A snoozed ask is out of the count and still holds its work up.
- [ ] Entries for asks that no longer exist are dropped.
- [ ] The sample addresses behave the same, through the sample's own control file.

## Comments
