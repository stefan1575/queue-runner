# 16: Sol's review checkout can run the repo's tests

**What to build:** Sol's sandbox (`~/codex-sol.sh` and the runner's checkout) has Node on PATH and
the repo's dependencies installed (or linked from a cache), so Sol can run a repo's tests while it
reviews, mainly to confirm a suspected bug with a failing test (tickets 03 and 04: Sol couldn't).
CI still gates the merge.

**Blocked by:** None

**Status:** done (2026-11-10)

- [x] One leads-dashboard review where Sol runs `npm test`, shown in its reply.
- [x] A checkout's install doesn't slow every review: measured in Comments.

## Comments

**2026-11-10, built (Claude, branch claude/ticket-16).** What's there (AGENTS.md, Sol runs tests):

- `queue_runner/deps.py`: a review checkout's `node_modules` is a junction to
  `~/.queue-runner/deps/<repo>-<key>/node_modules`, installed once per key (the lockfile, the
  dependency fields of package.json, `.npmrc`, `bunfig.toml`, `patches/`). leads-dashboard tracks
  `bun.lock` and its CI runs `bun install --frozen-lockfile`, so the cache does the same
  (`package-lock.json` is gitignored there; a repo with one gets `npm ci`).
- **bun is installed** at `~/.bun/bin/bun.exe` (1.4.4, from scoop's hash-checked zip). `scoop
  install bun` downloaded the main zip and then stalled on the "baseline" zip at about 20 KB/s,
  so I stopped it, uninstalled the failed scoop entry, and put bun where bun's own installer
  puts it. `deps.find_bun` looks there first. `scoop install bun` can replace it later.
- `~/codex-sol.sh`: Node on PATH (fnm's default), and `--write` / `--writable-root DIR`
  (workspace-write sandbox, network still off, plus a Files rule in the prompt). Without `--write`
  it runs as before. The copy from before is in personal-ops
  `.scratch/agent-instructions/2026-11-10/codex-sol.sh.before-ticket-16` (commit 4c1d293).
- The brief's step 4 tells Sol to run `npm test` and the network-free scripts the change touches
  (not browser tests), to add a failing test to confirm a bug, and to quote each run's summary line.

**Found on the way (checked live):**
- Codex's read-only sandbox stops vitest at once: EPERM writing `node_modules/.vite-temp`. So
  reviews now run in workspace-write, with only the checkout and the cache's `.vite-temp` and
  `.vite` writable. Writing into an installed package is denied (checked).
- `git worktree remove --force` follows a junction and empties its target. Removing a checkout
  would have wiped the cache, so `GitCli.remove_checkout` unlinks it first (test in `test_git.py`).
- `tempfile.mkdtemp` gives an owner-only ACL on Windows (Python 3.13+), and the sandbox user then
  couldn't read the cache. The install folder is made with `os.makedirs`, so it inherits
  `CodexSandboxUsers` read (test in `test_deps.py`).
- leads-dashboard's `src/test/callsling-relay.test.ts` has one test that fails on Windows outside
  any sandbox too (EPERM removing its temp folder), so it's pre-existing. The brief says a failure
  the change doesn't explain is no finding.

**Measured (box 2):** on a leads-dashboard checkout at origin/main, the first review with a new
lockfile installs it cold in **49.5 s** (50.3 s the second time). Every review after that, until
`bun.lock` or the dependencies change, links the cache in **0.02 s**. In the sandbox, `npm test`
took about 30 s for the whole suite (302 passed, 8 skipped, and the one Windows flake).

**Box 1:** `scripts/live_review.py leads-dashboard#181` (a dry run, nothing posted) at 0470a6e:
the log says `dependencies cached (leads-dashboard-7aa4f99fb213)`, and `reply.md.log` says
`sandbox: workspace-write [workdir, /tmp, $TMPDIR, ...
ode_modules\.vite-temp,
...
ode_modules\.vite]` and `reasoning effort: high`. Sol's reply has a checks table:
`npm test` → `Tests 333 passed | 8 skipped (341)`, typecheck exit 0, lint 0 errors / 7 warnings,
check:migrations OK. It also tried `npm run test:e2e`, which stalled with no Playwright browser;
the brief now leaves browser tests to CI. The review took 4.5 minutes and was clean. Its run folder
is `~/.queue-runner/live-review/runs/leads-dashboard-pr181-r3-20261110-213051/`.

**What to look for in the runner's first real review on the new code:** in `runner.log`,
`review leads-dashboard#N: dependencies cached (...)` (or `installed in Ns`) before
`Sol reviews`; in the posted comment, the commands Sol ran with their summary lines.

**Sol's review** of d1926fc..40d1a17 (one, at high): four Important findings, all fixed in
1b317fe. (1) A second install of the same key could delete a cache in use: it now keeps the
published one, in its own temp folder. (2) `.npmrc`, `bunfig.toml` and `patches/` weren't in the
key. (3) The whole cache was writable, so a test could change packages that later reviews reuse:
now only `.vite-temp` and `.vite` are. (4) Pruning `app` matched `app-tools-*`: it now matches
the exact name. No nits.

**Rule files:** nothing outside this repo says Sol's review is read-only (`sol.md`,
`pr-review.md`, `orchestration.md`, leads-dashboard's review docs), so no wording to approve.
