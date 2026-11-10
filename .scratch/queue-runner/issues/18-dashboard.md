# 18: A minimal dashboard

**What to build:** a local page the runner serves (or what Sol's research recommends, in
`../research/t3-extension-points.md`), kept minimal until Stefan grills it: first what needs
Stefan (17's `--needs-me` list), then the current job, the queue with what blocks what, and
pause and resume. Pause means "after the current step". Stopping a step partway would leave a
half-made commit or a half-posted review. Zero maintenance: nothing that breaks when T3 updates.

**Blocked by:** 17

**Status:** ready-for-agent

- [ ] Opens from the logon shortcut's runner, with no extra setup.
- [ ] Pause and resume from the page take effect at the next step, shown in the log.
