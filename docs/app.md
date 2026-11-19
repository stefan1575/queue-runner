# The app

The TypeScript rebuild of the runner (spec #68), in `app/`: one package, TypeScript on Node 24,
pnpm, Vitest. It grows ticket by ticket beside the Python runner (`queue_runner/`), which keeps
serving Stefan's repos until the cutover ticket. So far it signs in to T3 and lists the repos it
could serve (#149), opens as a desktop window that keeps running in the tray, with Settings
(#150; The desktop app, below), keeps its repositories in step with T3's projects (#151;
Repositories, below), knows which model does each kind of job and launches it (#152; Job
models, below), gates every job on its provider's usage, keeping your share of each week
(#153; Usage, below), has a Setup page that says what's missing before it can work (#162; Setup,
below), ships as a Windows installer built by CI on a version tag (#164; The installer,
below), builds a served repo's next ticket into a PR (#154; Builds, below), reviews every
open PR on its newest commit, posting the review with its ledger (#155; Reviews, below), and
closes the loop: a blocking review gets a fix round, and a clean one merges or is marked ready to
merge (#156; Fix rounds and merges, below).

## Run it

```
pnpm --dir app install
pnpm --dir app start -- --list    # every T3 project, its folder and GitHub remote; changes nothing
pnpm --dir app live:sign-in       # the live sign-in check (Live checks, below)
pnpm --dir app live:launch        # the live launch check, sandbox only (Live checks, below)
pnpm --dir app live:usage         # each provider's usage as the app reads it; acts on no project
pnpm --dir app live:build         # the live build check, sandbox only (Live checks, below)
pnpm --dir app live:review        # the live review check, GitHub sandbox, dry run (Live checks, below)
pnpm --dir app live:merge         # the live merge check, GitHub sandbox, review stubbed clean (Live checks, below)
pnpm --dir app desktop            # builds and opens the desktop app (The desktop app, below)
pnpm --dir app installer          # builds the Windows installer into installer-dist/ (The installer, below)
```

Node runs the `.ts` files as they are (type stripping): no build step, so the code uses only
erasable TypeScript (`erasableSyntaxOnly`: no enums, no parameter properties) and imports with
`.ts` extensions.

`--list` prints, per project, its title, its folder and `owner/name` on GitHub or `no GitHub
remote`, after a line naming T3's version and machine (from the WebSocket, so a sign-in T3
refuses there shows on every start). It exits 1 with T3's error when T3 is down or refuses.

## Test it

```
pnpm --dir app typecheck
pnpm --dir app test
```

CI runs both on Windows (`.github/workflows/tests.yml`, job `app`), beside the Python tests. A
push to `main` runs them first (`docs/tests.md`, Main is tested before a push). A PR that changes
the Time format watcher or its tests also runs `test/time-format.test.ts` 50 times in a row
(`.github/workflows/time-format-repeat.yml`), since those tests once failed CI now and then.

**Tests check the code, never Stefan's settings** (#172). A test builds its own settings, in a
temp folder or an in-memory store, and checks what the code does with them. No test reads the
app's real settings, the runner's `config.toml` or T3's real files, and none asserts one of
Stefan's values (a model, an effort, which repo he merges): changing a setting must never turn
main red (#169). `test/no-real-settings.test.ts` fails on a test file that reaches the user's
home or app-data folders, `T3_HOME` or `T3CODE_HOME`, T3's real runtime file or CLI
(`runtimeAddress()` or `t3Cli()` with no path), `config.toml`, or the real settings path, which
the settings tickets export as `SETTINGS_PATH` (`test/real-settings.ts` lists them all).

**Tests get time from a fake clock and files from a temp folder** (#202): none waits for real
time to pass or a real file watcher to fire, and a `vi.waitFor` waits only on the test's own fakes (`FakeT3.address`, the settings and the job log in `test/memory-files.ts`), never on real file I/O, which a test awaits; `test/no-real-time.test.ts` fails a test that reads
the real clock or runs on a real timer that no `vi.useFakeTimers()` around it fakes (a `toFake` list fakes only what it names), naming it (`test/real-time.ts`). Both checks read every app test file, `renderer/test/` included (`test/app-test-files.ts`).

## Rules for every rebuild ticket

- **T3 and GitHub only.** No reads of T3's database or settings, of Claude's or Codex's files,
  of `~/.claude` or `~/.codex`. No personal scripts. `gh` for GitHub. Starting T3's CLI is
  allowed only for signing in (pairing codes, and listing and revoking the app's own sessions).
  **The one exception:** T3's Time format, `timestampFormat` in T3's
  `~/.t3/userdata/client-settings.json`, which T3's server doesn't serve (The desktop app, The
  clock). The app reads that one setting, never writes the file, and watches it. The exception
  goes once T3's server serves client settings.
- **Seams, faked in tests:** T3 (MCP and WebSocket; `src/t3/seams.ts`: HTTP, the socket, the
  CLI, the address), GitHub (`src/github.ts`; `test/fake-github.ts` for the build lane's reads),
  local git in a served repo's folder (`src/git.ts`: the fetch and leftover-branch check a build
  needs, since T3 does neither), and the platform (Windows: tray, notifications,
  start at logon, wake). Tests never touch the network, T3, GitHub or the Task Scheduler
  (`test/fake-t3.ts` answers in memory). A temp folder a test makes is removed after it
  (`afterEach` with `rm(..., {recursive: true, force: true})`).
- **The Python runner keeps serving Stefan's repos until the cutover ticket.** The app acts only
  on projects switched to Served (Repositories ticket), and until the cutover only the sandbox
  project ("queue-runner sandbox") and the GitHub sandbox `stefan1575/queue-runner-sandbox` (its
  T3 project "queue-runner sandbox GitHub") are ever switched on, by live checks.
- **Port, don't redesign.** Today's runner and its docs (`docs/flow.md`, `docs/claude-lane.md`,
  `docs/reviews.md`, `docs/stops.md`, `docs/usage.md`, `docs/dashboard.md`) are the behaviour to
  port, with #68's changes on top. A rule you'd change is a comment on #68, not a quiet change.
- **No model or vendor name in code.** Models come from T3 and the settings (#121's rule);
  `test/no-model-names.test.ts` fails on one in `src`, `renderer/src` or `live`, comments
  included (tests and their fixtures may name them). The GitHub-facing
  names (`sol-review` status, `sol-findings` ledger, `<!-- sol-finding -->` marks) stay as they
  are, because open PRs in served repos read them across the cutover. So does the job branch
  prefix (`JOB_BRANCH_PREFIX`, `src/picker.ts`), since a branch today's runner left counts as in
  flight, and a repo's own `CLAUDE.md` is looked for by name: the test allows those two literals.
- **The briefs stay self-contained:** no skill names, no slash commands, nothing outside the repo
  (today's `tests/test_templates.py` rule, ported with the templates).
- **Live checks** are scripts under `app/live/` that refuse any project but the sandboxes, like
  today's `scripts/live_*.py`. One that acts on no project says so at its top.

## The desktop app

Electron (#68 stories 33 and 34, #36), one process for the runner: the runner runs in the main
process (`src/desktop/electron.ts`), and the window shows it. `pnpm --dir app desktop:build`
bundles the main process and its preload with esbuild and the window's page (`renderer/`, React
and Tailwind, the prototype app's stack) with Vite, into `desktop-dist/` (not committed);
`pnpm --dir app desktop` builds and runs it. The window's only door to the main process is the
preload's `window.runner` (`src/desktop/bridge.ts`: the view, its changes, saving a setting).
Code both sides use (`display.ts`, `settings-search.ts`) touches no Node. The window's own tests are under `renderer/test/`, in jsdom (`// @vitest-environment jsdom`), run by `pnpm --dir app test` with the rest.

- **The frame** (`src/desktop/shell.ts`, under test with Electron and the platform faked): one
  app at a time (a second start shows the first app's window and quits); closing the window hides
  it into the tray; Quit in the tray menu stops the app. `--hidden` (the logon entry's start)
  stays in the tray.
- **The platform module** (`src/platform/`): the tray and start at logon, Windows only
  (`windows.ts`, Electron's Tray and login item). Later tickets add notifications and wake. The
  logon entry is `Queue runner` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
  running the app as it was started, with `--hidden`. Electron's `openAtLogin` only looks under
  its default name, so the entry is found in `launchItems` by its own. It follows Start with
  Windows on every start and every change (checked live 2026-11-18, both ways).
- **The window**, as #36's layout prototype settled it (branch `prototype/settings-layout-36`,
  variant B): a sidebar with the repo switcher and a footer row (Settings and a greyed Usage on
  the left, a greyed Update on the right); the main area is empty until later tickets fill it.
  Settings opens as a pop-up over the page, closed by its X, Escape or a click outside, in T3
  Code's look (a skin on while it's open); the rest of the window keeps the prototype's look until
  Stefan decides whether the whole app takes T3's (#36, open). Search matches other words for a
  setting, its current value and a typo (`src/settings-search.ts`).
- **Settings** are `settings.json` in the state folder (`src/settings.ts`): Name (null follows
  the `gh` account: `gh api user`, its name, else its login), the date style (default
  `month-first`, "November 16, 2026 Monday"), Start with Windows (on) and each repo's choices
  (`repos`; Repositories, below) and whether Setup has been shown (`setupSeen`; Setup, below). Each change is checked,
  saved at once (written aside and renamed over) and sent to the window; there's no Save button.
  The state folder's location is the only thing in a machine file, `machine.json` in Electron's
  userData (`%APPDATA%\Queue runner`); a first start writes `%APPDATA%\Queue runner\state`
  there.
- **The clock** follows T3's Time format (`timestampFormat`: System default, 12-hour, 24-hour;
  #68 story 36). It is a setting of T3's own window, kept in `~/.t3/userdata/client-settings.json`
  (`T3CODE_HOME` moves it); T3's server doesn't hold it (`subscribeServerConfig`'s `settings` has
  no such key, checked live 2026-11-18 against T3 0.1.9, and no WebSocket method serves client
  settings). So, as Stefan settled on #150, the app reads it there: the one exception to "No
  reads of T3's database or settings" (Rules). `src/t3/time-format.ts` reads only that key, never
  writes the file, and reads it every 500 ms (it sees a file that's missing or replaced by a
  rename; a stat poll, `fs.watchFile`, missed changes on CI: a write made before its first stat,
  or a same-size one in the same clock tick), telling the window when the format changes. A file that's missing or
  unreadable, or has no such key or a value T3 doesn't offer, is System default. It goes once
  T3's server serves client settings. The app has no Time format setting of its own.

### Screenshots

`pnpm --dir app desktop:shoot <absolute dir>` renders the real window on a fresh state in a temp
folder (never the real state, lock or logon entry), on the sample T3 catalog
(`test/fixtures/server-config.json`, never the real T3): `window`, `setup` (every check passed),
`setup-failing` (T3 not running, gh signed out), `settings-name`,
`settings-repos`, `settings-models` (a new install), `settings-models-chosen` (the sample choices in
`test/fixtures/shoot-jobs.json`), `settings-share` (a new install) and `settings-share-kept` (the
sample share in `test/fixtures/shoot-shares.json`), on the fixture's usage moved so T3 read it a
minute before the shoot, with one sample provider T3 reads no usage for
(`shoot-unread-provider.json`, its row Coming soon), `settings-display`, `settings-machine` and `settings-search` (a
typo, "windos"), each `-light.png` and `-dark.png`, at 1440x900. The page's address opens Settings for it:
`#settings=<page>` or `#q=<search>`, and Setup: `#setup`. Setup's samples are the real checks run
on fixed answers (`sampleSetup` in `src/desktop/sample.ts`). Repositories is shot from a sample (`src/desktop/sample.ts`:
two served repos, one New and one with no GitHub remote), which reaches neither T3 nor GitHub.

## The installer

`pnpm --dir app installer` (#164; #68, Shipping) builds the desktop app and packs it with
electron-builder (`electron-builder.json`) into `installer-dist/Queue-runner-Setup-<version>.exe`
(not committed): NSIS, one click, per user (no administrator rights; the app goes to
`%LOCALAPPDATA%\Programs\queue-runner-app`), a Start menu shortcut, and the app started when it
finishes. That start is the first one, so Setup opens (Setup, below). The package holds only
`desktop-dist`, `desktop/` and `package.json`: Vite and esbuild bundle every package the app
uses, so they're all devDependencies and none ships in `node_modules`.

- **Uninstalling** removes the app, its shortcut and its logon entry (`installer/uninstall.nsh`
  deletes the Run value named `LOGON_ENTRY`, `src/platform/platform.ts`; not when an update runs
  the old uninstaller), and keeps `%APPDATA%\Queue runner`, machine.json and the state folder
  (`deleteAppDataOnUninstall: false`).
- **Unsigned for v1:** signing needs a paid certificate and can come later. SmartScreen stops a
  first run ("Windows protected your PC", Unknown publisher; More info, Run anyway), which the
  release notes (`release-notes.md`) say.
- **CI** (`.github/workflows/release.yml`, on Windows): a `v*` tag (`v0.1.0`) runs the typecheck
  and tests, builds the installer at the tag's version and attaches it to that tag's release,
  creating the release with `release-notes.md` if there's none. A PR that changes the packaging
  (the workflow, `electron-builder.json`, `installer/`, `package.json` or the lockfile) builds it
  without releasing. `package.json`'s `version` is the one a local build gets.
- **Checked by hand 2026-11-19** (0.1.0, on a PC with no `%APPDATA%\Queue runner` and no logon
  entry): installing added the Start menu shortcut, started the app, wrote the logon entry and
  opened Setup; the silent uninstall (`/S`) stopped the app and removed it, its shortcut, its Apps
  entry and the logon entry, and kept `%APPDATA%\Queue runner`. `test/installer.test.ts` checks
  the config those rest on.

## Repositories

`src/repos.ts` (#151; #68 stories 21 to 23 and 25), Settings / Repositories in the window
(`renderer/src/Repos.tsx`). The runner's repos are T3's projects, kept in step both ways:

- **From T3:** `src/t3/project-feed.ts` keeps T3's projects from `orchestration.subscribeShell`
  (The WebSocket API, below), never by polling. A stream that ends or fails keeps the last list,
  says why on the page, and opens again after 5 seconds; its new snapshot replaces the list.
- **Each repo's choices** are `repos` in `settings.json`, by T3 project id: `served`, `merge`
  (`runner` or `me`, default `me`) and `seen`. A project new from T3 arrives off with a "New"
  mark (`seen: false`), counted in blue on the page, until the page has shown it and gone away.
  `repos` is null until T3's projects are first seen: that first sight is a new install, where
  nothing is marked New. A project removed in T3 loses its choices. The window changes them only
  through `runner:repo` (`RepoAction`), never as a plain setting.
- **Adding** opens Windows' folder dialog (Electron's) and calls `t3_project_create {title: the
  folder's name, workspaceRoot}`. The project arrives through T3's events, off and not New. T3
  refuses a folder that's already a project, and the page says so.
- **Removing** asks first and calls `t3_project_delete {projectId}` only: the folder and GitHub
  are never touched. T3 0.1.9 refuses a project with threads ("The project is not empty;
  force=true is required to delete it") and `force: true` deletes its threads, so the app never
  forces at first: the dialog asks again, naming that the threads go too, and only then forces.
- **Served** needs a GitHub remote. Each folder's remote is read again on every T3 event, as
  the Repositories page opens, and when it's switched on, so no answer (gh failing or no remote)
  is kept for good; the last one known stays on show while it's read again. A project without
  one says "No GitHub remote" and its switch is off and disabled; one gh couldn't read says why
  and its switch stays usable, since switching on reads it again. A served repo whose remote
  can't be read shows as not served without losing its choice. Switching on first lists the repo's
  labels (`gh label list`) and creates whichever of `ready-for-agent`, `needs-info` and
  `ready-to-merge` is missing (`gh label create`; one made meanwhile is left as it is). gh
  failing leaves it off and the page says why. Switching off and who merges touch GitHub not at
  all. Until the cutover only the sandboxes are ever switched on (Rules).
- **Not settings:** the base branch is GitHub's default branch, and the folder is the T3
  project's.

## Job models

Which model does each kind of job (#152: #120's shape on #36's page, as the 2026-11-17 triage on
#68 settled). `src/jobs.ts` (shared with the window), `src/t3/catalog.ts`, `src/launch.ts`.

- **Kinds:** build, fix, conflict, decision, review, ask (#68 drops `live`). The `jobs` setting is
  `{default, <kind>: {own, fallback}}`, each a `{provider, model, effort}` (provider is T3's
  `instanceId`; effort null for a model with none) or null. Default gives every kind its model
  unless the kind has its own; a kind's fallback is for while its own provider is out of usage
  (which one a job runs on is the usage gate's call, #153); without one the job waits.
- **The choices are T3's**, from `subscribeServerConfig`'s `providers` (`src/t3/catalog-source.ts`
  keeps them, following `providerStatuses` and `settingsUpdated`; a stream that ends keeps the
  last answer, says why and is asked again in 30 s). Connected is `enabled` and `status: ready`.
  Each provider has `models` (`slug`, `name`, `isDefault`) and each model its options
  (`capabilities.optionDescriptors`); its effort is the select option whose id names an effort
  (`effort`, `reasoningEffort`: the driver's own id) or else the one labelled Reasoning, its
  default the option marked `isDefault`. Seen live 2026-11-19 (T3 0.1.9, three connected, eight
  disabled); `test/fixtures/server-config.json` is that answer trimmed, auth details dropped.
- **T3's default** is T3's `defaultModelSelection` when that's connected, else the first
  connected provider's default model at its default effort. A new install's Default follows it
  (null), and the page nudges until a choice or **Keep this** pins it (#36).
- **What a job runs on:** a choice T3 can't run (its provider not connected, its model not
  listed) falls to the next one up: the kind's own, Default, T3's default. So with one provider
  connected every kind runs on it, and the page offers only it (#68 story 19). An effort the
  model doesn't offer is the model's default.
- **Launching** (`launchJob`): `t3_thread_launch` with `{projectId, title, message, runtimeMode:
  full-access, modelSelection: {instanceId, model, options: [{id: <the model's effort option>,
  value}]}, workspaceStrategy?: {type: worktree, baseRef, branch}}`, on the choice the usage gate
  let in (the kind's model or its fallback), never the settings read again: a setting changed
  after the gate answered can't move the job. A choice T3 can't run by then launches nothing
  (docs/t3.md: Codex ignores `effort`, so the id matters).
- **The page** (Settings, Models): Default, then one row per kind, each "Follows Default" until
  set (an undo goes back), with its fallback under its model. The three dropdowns are fixed
  widths, so changing a provider moves nothing (#36). Models carries a blue count in the page
  list while Default follows T3's. Stefan's values (Opus 5.5 at medium for every kind, review on
  Sol at high with Opus 5.5 at high as its fallback, as `config.toml` has them) are set at the
  cutover, not in code.

## Usage

The usage gate (#153: #68 stories 20 and 29, #122's design, today's `docs/usage.md` ported per
provider). `src/usage.ts`, `src/shares.ts`, `src/costs.ts`, `src/cost-log.ts`, `src/gate.ts` (the
decision, pure) and `src/usage-gate.ts` (the state around it). The lanes that call it are later
tickets but the build lane (Builds, below); the tests drive it on fake T3's events.

- **Where each number comes from in T3** (found live 2026-11-19, T3 0.1.9; `pnpm --dir app
  live:usage`): every provider in `subscribeServerConfig`'s `providers` has `usageLimits`:
  `checkedAt` (when T3 read it), `windows` (each `{id, kind: session | weekly | monthly | other,
  label, usedPercent: 0-100, resetsAt, windowDurationMins}`), `resetCredits {availableCount,
  nextExpiresAt, options?}` when there are any, and `unavailable {reason: unsupported |
  probeFailed}` when T3 has no windows (it keeps the last good ones after a failed read). Seen:
  Claude's `five_hour` (session, 300 minutes), `seven_day` (weekly) and `seven_day_fable` (weekly,
  labelled `Weekly · Fable`: only that family's models); Codex's `primary` (session) and
  `secondary` (weekly), with 2 reset credits. T3 reads each instance's usage itself, about every
  5 minutes (its provider health refresh, `DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL`, and a 5-minute
  probe cache), and also merges what a running session reports; each change is a
  `providerStatuses` event carrying every provider (seen: one per instance per read, the two
  Claude instances a few seconds apart). The app asks no provider and polls nothing: it follows
  the stream it already holds for the catalog (`src/t3/catalog-source.ts`). `usageLimitSources`
  (T3's hub accounts, `usageLimitSourcesUpdated`) is another thing, unused here.
- **A login** is T3's `auth.workspaceId` (else `continuation.groupKey`, else the instance): two
  instances on one login (seen: `claudeAgent` and `claudeReviewer`) show the same windows, and a
  job running on either counts against both. Its name, in every reason and share row, is the
  shortest of its instances' names.
  A job started before T3 has named its provider's login (a build watched again on a cold start,
  before T3's first catalog) is given that login once T3 does, and counts against it from then.
- **The gate** (`checkJob`), before any job, reviews included (#106): each window of the job's
  provider that counts its model (a `<kind> · <family>` window counts only models whose id or
  name holds the family) must fit used + the expected cost of every job running on the same
  login (counted whole until it ends) + this job's, under 100 minus your share; a window with
  nothing used takes any job. Held, it waits for the jobs running there to end (no time), for
  the share's release, or for the window's reset plus 2 minutes; the longest timed wait is its
  one reason (`holdText`: "Claude's 5-hour window resets at 14:20; this build needs about 60%").
  No reading to decide on (none, one from before the last job on that login ended, or one over 30
  minutes old) holds it until T3's next. A provider T3 reports `unsupported` for is ungated, as
  #122 had it. A job that ends on its provider's usage limit (a build's `usage-limit`, a review's
  `out-of-usage`) holds that provider, gated or not, until the reset T3 gave plus two minutes, or
  an hour when T3 gave none, so the next job of the kind goes to its fallback (#155 F22). A reading
  T3 takes after the hold began decides instead, and one with room ends it, so a reset credit
  sends jobs back to the provider (#155 F25); a provider T3 reads no usage for has no such
  reading and stays held to the reset. A start restores these holds from the job log's ends
  (`UsageGate.limitsFrom`), under the same rule.
- **Which model** (`UsageGate.pick`): the kind's own; while that doesn't fit, its fallback if it
  has one and that fits (#152); else held with its own model's reason. `holds()` keeps each held
  job's reason and since when, for the dashboard.
- **Learned costs** (#122): per provider instance, model, effort and kind, in percent of each
  window by its id; the cautious default (build 60 of the 5 hours and 15 of the week, fix and
  conflict 40/10, decision, review and ask 15/4; any longer window takes the weekly figure) until
  3 solo records measured that window, then the largest of the last 5. A job's record (`usage.jsonl`
  in the state folder) is the reading it was let in on and T3's first reading of its provider
  after it ended, with `spent` per window (null for one that reset meanwhile) and `sharedWith`
  when another job ran on the same login meanwhile (then it teaches nothing). A torn last line is
  cut off; a bad line before it is an error. No plan setting: #118 closed it, the costs being
  percents that follow a plan change.
- **Your share** (Settings, Your share; `shares`, keyed `<driver>/<window id>`): one row per
  provider per weekly window, the percent kept (0% by default) and how many hours before the
  window's reset it's released (24 by default, at most 168). A connected provider T3 reads no
  usage for shows one row greyed, Coming soon. A provider that isn't connected shows no row (#36's
  open question 8): its jobs can't run anyway. Stefan's 5% of Claude's week is set at the
  cutover, not in code.

## Builds

The first job end to end (#154): a served repo's next ticket becomes a PR, as today's runner
builds (`docs/flow.md`, `docs/claude-lane.md`). `src/build-lane.ts`, `src/picker.ts`,
`src/briefs/build.ts`, `src/briefs/rules.ts`, `src/t3/thread-end.ts`, `src/job-log.ts`, `src/git.ts`.

- **Picking** (`src/picker.ts`, today's picker ported, `docs/layout.md`): an open issue labelled
  `ready-for-agent`, every blocker closed (GitHub's native blocked-by count, and `#N`,
  `owner/name#N` or issue URLs on a `Blocked by:` line or under a `## Blocked by` heading), not
  in flight (a `claude/*-<issue>` branch, an open PR on one or closing it, or one GitHub links to
  it), not a spec with open sub-issues, not held by the job log; lowest number first. Only repos
  switched to Served with a GitHub remote are read (`servedRepos`). The base is GitHub's default
  branch.
- **The brief** (`src/briefs/build.ts`): `templates/build.md` ported, with the user's name
  (Settings, Name; else the gh account's name, else its login) in place of "Stefan". It names no
  skill, no slash command and no path outside the repo (`test/brief.test.ts`): where today's brief
  names the runner's `scripts/evidence.py`, it says in words what that script does (compare the
  before and after, commit the shots to the `evidence` branch under `pr-<n>/` without touching
  the job's branch, link each by that commit).
- **Each rule is written once** (`src/briefs/rules.ts`): a rule more than one brief needs (the
  Before you push list, today's `templates/check.md` from closed PR #196; the screenshots; what
  is the user's to decide) is written there and filled into each brief that needs it. The build
  brief goes through Before you push before it pushes. `test/brief.test.ts` fails a brief file
  that writes one of them out itself.
- **Starting:** fetch `origin/<base>` (T3 doesn't), with the refspec named
  (`+refs/heads/<base>:refs/remotes/origin/<base>`), so the tracking ref is written whatever the
  clone's own refspec covers (a single-branch clone of another branch); then a leftover local
  branch of the job's name holds the job (`branch-exists`, said in the log line) and T3 isn't
  asked; else `launchJob` on the very model the gate let the job in on (its kind's or its
  fallback; Settings isn't read again) in a worktree from `origin/<base>` on
  `claude/<slug>-<issue>`, titled `Queue runner build: <project>#<n>`. The served set is asked
  again after the GitHub reads and right before the launch call: a repo switched off meanwhile
  gets no gate verdict, or is `not-started`.
- **After a restart, don't guess** (#154): a job is tied to a thread only by the thread id T3
  gave its own launch, never by a thread's title, branch or project. A launch that was sent and
  whose answer was lost (the connection dropped, T3 answered 5xx or unreadably: `NoAnswer`,
  `src/t3/seams.ts`) may still have started a thread, so it isn't taken as not started: the job
  ends `needs-user`, is dropped from the gate unmeasured, holds its issue, and its repo starts
  nothing until the user answers (`BuildLane.answered`, an `answered` line in the job log; the
  Inbox ticket asks). A launch T3 refused, or one that failed before the call was sent, started
  nothing: `not-started`.
- **One ticket at a time per repo** (#179): no build while the repo has an open PR, whoever
  opened it, read before the ticket is picked and again right before the launch (a PR opened
  meanwhile makes the job `not-started`). Clean means merged (Fix rounds and merges, below); merged
  is the end, with no live steps to wait on (#68), and a merge passes the build lane at once.
- **One build per repo, repos side by side** (#50): each pass takes every served repo with no build
  running, the one whose last job ended longest ago first (the job log's `lastEnded`). Each asks
  the usage gate first (`UsageGate.pick`, kind `build`); a held one says its reason once and waits.
  A pass waits for each build it starts to be launched, so the gate counts it before the next
  repo's verdict. A repo whose job started no thread (`not-started`, `branch-exists`) rests 5
  minutes. In the desktop app a pass runs at start, when the served set changes, when T3 reads new
  usage while a build is held, and every 5 minutes (GitHub is polled for new tickets).
- **The end comes from T3's thread events** (`src/t3/thread-end.ts`; The WebSocket API, below), not
  polling: `done` (the run completed; `done-no-pr` when GitHub answered that no PR came from the
  branch; a lookup that failed is never "none": the end has no `pr`, each pass, a start's
  included, looks it up again, and a `pr` line records what it found), `waiting` (a
  pending runtime request: a question to the user), `usage-limit` (with T3's `resetAt`) or
  `failed` (with the error item's message). A stream that drops opens again after 5 seconds.
- **The job log** is `jobs.jsonl` in the state folder (`src/job-log.ts`, today's `state.py` cut to
  a build): `start` (the model the gate let it in on, the cost it was let in at and T3's reading it
  was let in on, `cost` and `before`), `thread` (once T3 names it), `end` and, for a `needs-user`
  end, `answered` once the user has answered; `settled` once its thread is settled; `pr` once a
  PR lookup that failed at the end is done.
  Every build that started holds its issue but `not-started` (releasing is a later ticket). The
  usage before and after a job are its record in the gate's `usage.jsonl`, by the same job id: the
  gate counts the job from its let-in and measures it on T3's first reading after its end; a job
  that got no thread is dropped from the gate unmeasured.
- **Settling:** once the end is recorded, the thread is settled (`t3_thread_organize {threadId,
  action: settle}`; #68 story 5). Only threads the app launched are settled (story 13): the id
  comes from its own launch. One waiting on a question is left for the Inbox ticket and one
  stopped by a usage limit for the limits ticket; both are recorded as such and left unsettled.
  A settle is recorded (`settled`); an end with none (the app stopped between the two, or the
  settle failed) is settled on the next pass, a start's included. A log from before `settled`
  lines settles its ended builds' threads once more on the first start, which leaves a settled
  thread as it is.
- **An app that stopped mid-build:** on start, each build the log shows open is watched again to
  its end before any pass (so its repo still has one build), reserved in the gate at its logged
  `cost` and measured from its logged `before`, never from a reading taken mid-run (a line with
  neither, an older app's, is measured as teaching nothing). One with no saved thread id
  needs the user, as a lost launch answer does (After a restart, don't guess, above): no thread
  is adopted for it, and its repo starts nothing until the user answers.
- **The app's log** is its console for now (`say`): a line per start, hold, end and failure.

## Reviews

The review half of the loop (#155; `docs/flow.md` The review loop, `docs/reviews.md`, ported):
every open PR in a served repo without a review on its newest commit gets one, whoever opened it.
`src/review-lane.ts`, `src/review/ledger.ts`, `src/review/post.ts`, `src/briefs/review.ts`,
`src/review/deps.ts`, `src/t3/thread-reply.ts`, the review half of `src/git.ts` and `src/github.ts`.

- **Adoption** (`ReviewLane.whyNot`, cheapest first): not while a build writes to the PR's branch
  (open, waiting on a question, or cut off by a usage limit); not once the app reviewed its head H
  (`clean`, `blocking`, `stop`, `approach-note` in the job log); not after two failed reviews on H;
  not while one of the app's own review comments is on H already; and only once H's checks
  passed, `sol-review` not counted (`checks`: check runs and commit statuses). Why not is said once
  per PR. Lowest number first, repo by repo. Conflicts aren't looked at: GitHub runs no
  `pull_request` checks on a PR that conflicts, so it waits on its checks (#157 adds conflict
  rounds). Stops (#158) aren't filed yet: a `stop` or `approach-note` is recorded and posted, and
  nothing more happens.
- **One review at a time** (#106 runs them at once later). Each asks the usage gate
  (`UsageGate.pick`, kind `review`): the kind's own model, or its fallback while that provider has
  no room (#69); held, it says the gate's reason once and the pass ends. A pass runs at start (after
  an open review is carried on with), on T3's usage and the repos changing, after each review
  (but not after one whose head moved, so a stale list can't loop it), and every minute.
- **No outside tools** (`docs/reviews.md`, A review has no outside tools): a review runs only on
  a T3 provider instance the user named as set up without them, the `toolFreeInstances` setting
  (instance ids; empty on a new install, so no review runs until one is named), as today's
  fallback reviews run only on the instance `[review]` names (#127: `claudeReviewer`). T3 serves
  each instance's launch arguments (`subscribeServerConfig`'s `settings.providerInstances`, seen
  live 2026-11-19), but reading them would name a driver in code, so the list is the user's word.
  `launchJob` enforces it for every review, the lane's and the live check's alike, and fails
  closed: a review on an instance not listed, or on the one builds run on, launches nothing. The
  rule is one function, `noToolsRefusal` (`src/launch.ts`), which the lane, `launchJob` and the
  live check all ask; the list it takes is always the saved setting, never derived from the
  review's own choice. The lane asks first, so such a
  review waits and says why rather than failing; nor does one run on the instance builds run on,
  which has their tools, whatever the list says. The setting is in `settings.json` only, not yet
  on the Settings page; a Codex instance for reviews needs its MCP servers off in T3 (codex-sol.sh
  did that). Setting one up and listing it is the cutover's.
- **The checkout:** the PR's head is fetched into `refs/queue-runner/pr<n>` with `origin/<base>`
  (a head that moved since listing is `head-moved`, nothing counts), and checked out detached at
  `<state>/checkouts/<repo>-pr<n>`, its dependencies linked in from `<state>/deps/`
  (`src/review/deps.ts`: one `npm ci` or `bun install --frozen-lockfile` per lockfile key, the
  three newest kept per repo). It's removed after the review, `node_modules` unlinked first.
- **The thread:** `launchJob` with kind `review`, its working folder the checkout of H (T3's
  `workspaceStrategy: {type: existing_worktree, worktreePath}`: the checkout is a worktree of the
  project's repo), titled `Queue runner review: <project>#<n>`. The brief (`src/briefs/review.ts`,
  `templates/review.md` and today's `_brief`) names the checkout too, leaves the project's clone
  alone, and asks for no posts, no questions and tests in the foreground. Its inputs are in `<state>/runs/<repo>-pr<n>-r<K>-<time>/`, as today's: the diffs,
  `pr.md`, each closed issue with its comments, `conversation.md`, `evidence/`. Its end comes
  from T3's thread events (Builds); its reply is the run's last assistant message, read whole
  through `t3_thread_read` (`view: messages`, paged, then `textOffset` while truncated; T3's CLI's
  `runResultText`). A read that fails (T3 or GitHub busy a moment) is asked again after a wait,
  never taken as no reply, and so is one T3 cuts short: a continuation or a later message page
  that comes back empty, a page short of its limit that says there's more (T3 fills every page
  that does, #155 F20), or "more" with no position or offset to go on from, is read again, never taken as the reply's end; a reply that comes back empty is read again, and only three empty reads
  in a row are the thread's own. A question, a failure or that empty reply fails the review; a
  usage limit is `out-of-usage` and the next review waits on the gate. A step before the launch
  that fails (a git, GitHub or T3 step, a launch T3 refused, or the repo no longer served when it's
  asked again right before the launch) launched nothing: `not-started`, which doesn't count
  against H, and the PR rests 5 minutes.
- **Decide and post** (`src/review/ledger.ts`, `src/review/post.ts`, today's `ledger.py` and
  `post.py`): the verdict from the reply's last `sol-findings` block; clean means no Important
  finding open. **What blocks** (#155): an Important finding needs its file and line and how it
  comes up in real use (its `scenario`), or, for a problem that isn't a bug, a cost and the rule
  it breaks; one without is read as a nit. The brief tells the reviewer a bug that needs a made-up
  situation is a nit. A missing or thin screenshot is a nit: the reviewer marks that finding
  `"missing_screenshot": true`, and only the mark counts, never its wording (F16); a shot that shows the screen
  wrong is Important, and text-only output needs none. Then each new Pre-existing finding filed once as a `needs-triage` issue, the
  comment (its visible ledger and hidden marker), `sol-review` on H only, and a row in the app's
  Review table in the PR body, on every repo (#36): Step (the comment's link), Reviewer, Time,
  Commit, Verdict. The comment and the Reviewer cell name who reviewed: the model and effort as T3 labels
  them, and on the fallback `, fallback while <provider> is out of usage` (`reviewerName`). gh writes send their JSON on stdin (`--input -`). A comment
  that fails to post is posted again after a wait, unless the PR's comments show it got there
  after all. Once the comment is on the PR, the status and the row are tried again after each
  wait until both land, the job left open meanwhile: a stop or a restart carries on there, finds
  the comment posted, and sets them (F14). The run folder keeps `brief.md`, `reply.md`, `comment.md`, `decision.json`.
- **It starts clean** (#155): the app reads only what it posted itself. Its review comments carry
  their own marker (`<!-- queue-runner-app review round=N verdict=V sha=H findings=<base64> -->`);
  the Python runner's and the old script's (`<!-- sol-pr-review`) and hand-posted ones
  (`<!-- sol-review`) are never read, so a PR one of them reviewed gets a fresh review 1 (they
  still count as the runner's posts, not something a person said). Its Review table sits between
  `<!-- queue-runner-app review-table -->` and `<!-- /queue-runner-app review-table -->`, and only
  that table is ever changed: a body without it gets one at the end of its `## Review` section
  (below the Python runner's table, which is left as it is), or a new section after `## Evidence`.
  Markers and headings inside a fenced block are only text. A follow-up issue is known as the
  app's by its own mark (`<!-- queue-runner-app finding <repo>#<n> <id> -->`) or the same title,
  never by another runner's footer, whose finding IDs are its own reviews'.
  Each is filed before the comment, and a filing that fails (or open issues that can't be read)
  holds the comment back: the post is tried again after the wait, as a comment that fails to post
  is, and on a restart, so a review never finishes with a follow-up unfiled (#155 F24). The
  ledger's `unfiled` is the Python runner's and older comments' only.
- **The job log:** kind `review`, `issue` the PR, with `sha`, `round`, `reviewer`, the `cost` it
  was let in at, its `runDir`, its `checkout` and the repo's `folder`; its end `clean`, `blocking`,
  `stop`, `approach-note` (with `verdict`, `signals`, `link`), `failed`, `out-of-usage`,
  `head-moved`, `not-started` or `needs-user`. Once the end is recorded the thread is settled, whatever the end
  (nobody answers a review thread), with the builds' settle (`src/settle.ts`: a `settled` line,
  and an end with none settled on the next pass).
- **After a restart, don't guess** (as Builds): a review the log shows open whose thread id was
  saved carries on with that thread, before any other review starts: watched to its end, its reply
  read, decided and posted from its start line and the run folder's `review.json` (what deciding
  needs that the start line doesn't hold), its checkout removed and its thread settled. One posted
  before the app stopped (the app's own comment for its round and H is on the PR) is recorded, not
  posted again; its `sol-review` is set again and its row added if the body lacks it. One with no saved thread id (the app stopped before T3 named it) and a launch whose
  answer was lost (`NoAnswer`) end `needs-user`: no thread is ever matched to it by title, branch,
  project or anything listed in T3, its checkout stays for the thread T3 may have started, and its
  repo starts nothing, review or build, until the user answers (`ReviewLane.answered`; the Inbox
  ticket asks). A start line without a run folder (an earlier app's) has its thread watched to
  its end and counts `failed`.
- **The review lane and the build lane** share the repo's one ticket at a time (#179): the build
  lane starts nothing while a PR is open, and the review lane reviews that PR; a review waits while
  a build writes to its branch, and a job of either lane that needs the user holds both.
- **Not yet:** conflict rounds (#157), stops (#158). A review that ends tells the fix and merge
  lanes (`ended`), so a blocking one gets its round and a clean one merges without waiting for the
  minute's pass.

## Fix rounds and merges

The loop closed (#156; `docs/flow.md` The review loop and Merge, ported, with the owner's
2026-11-19 decisions on the ticket): a blocking review goes back to the builder to fix, the new head
is reviewed by a fresh reviewer, and a clean head merges, or waits for the user where they merge.
`src/fix-lane.ts`, `src/briefs/fix.ts`, `src/merge-lane.ts`, the PR steps in `src/job-log.ts`, the
merge half of `src/github.ts` and `src/git.ts`.

- **Which PRs get a round** (`FixLane`): the app's newest review of the PR's head H is `blocking`
  (a `stop` or `approach-note` goes to the user, #158), it's still the PR's newest review comment,
  no round ran on H yet (one per head: a round that ended without a push leaves the PR at H, which
  was reviewed already, so it waits for the user), and nothing writes to the branch (a build or fix
  open, waiting on a question or cut off by a usage limit: one writer per PR, and the review lane
  waits on a fix round the same way). A repo with a job that needs the user starts none.
- **Back to the builder:** the round goes to the thread that wrote the PR, its build's or the
  fresh fixer's that took over since, with `t3_thread_send {threadId, message, mode: queue}`
  (`queue` starts a new turn and never steers one), so it starts with that thread's context. The
  gate is asked about the model that thread runs on (`UsageGate.check`, kind `fix`), since that's
  what the turn spends; held, it waits and says why once. The start line keeps the thread's runs
  before the send (`knownRuns`, from `orchestration.getThreadProjection`), and the round's end is
  its new run's: the run id T3's answer names, else the newest run not among them, so a restart
  finds it too.
- **A fresh fixer instead,** a new thread on the fix kind's settings (`UsageGate.pick`, kind `fix`,
  its fallback while its provider has no room), titled `Queue runner fix: <project>#<n>`, when
  the review marks an earlier Important finding still open (`raised` before this round: the
  writer has shown it's stuck there), when no thread of the app's wrote the PR (a person opened
  it, or the build needs the user), or when T3 says the writer thread is gone (#156 F3), however it
  says so: the runs read before the send failing with "not found", or, when that read fails
  otherwise, T3's MCP answering `t3_thread_read` with `not_found`; or when T3 refuses the send
  because the thread can't take a turn (#156 F9). The installed T3's `sendToThread` (read
  2026-11-19 in its `server.asar`) answers, before it dispatches anything, `thread_not_found` for
  a deleted thread, `thread_not_sendable` for an archived one and `invalid_request` for a provider
  instance that's switched off; each sends a fresh fixer. A *settled* thread isn't checked there,
  so the builder's thread, which the app settles at its end, still takes the round. T3's answer to
  a send is `{delivery}` only, with no run id.
  A thread that's there but couldn't be read rests the PR and is tried again. It works in the PR's own worktree when `git worktree list` shows one on the
  PR's branch (T3's `existing_worktree`), else in a new worktree at H on
  `claude/fix-pr<n>-<sha7>` that pushes `HEAD` to the PR's branch, as today's runner does. A
  fresh fixer then writes the PR: the next round goes back to its thread.
- **The brief** (`src/briefs/fix.ts`): `templates/fix.md` ported, built from sources, never a
  handoff file: the open Important findings, their classes (fix every case of each), the nits,
  what earlier reviews settled, the PR's body, commits and files, the earlier threads' links. It
  says whether it's the writer's thread or a fresh fixer, and why. Fix or decline (a comment
  naming the finding's ID, the reason and the evidence); a screenshot finding is shot as the build
  brief's Screenshots say. It ends with the same Before you push list, the screenshot rule and
  what's the user's to decide (on the PR), from `src/briefs/rules.ts`.
- **Its end** comes from T3's thread events, as a build's; then the PR's head is read again (the
  end's `head`): pushed, the review lane is told (`ended`) and reviews the new head in a new
  thread; not pushed, it waits for the user. The thread is settled unless it waits on a question
  or stopped on a usage limit.
- **A send whose outcome isn't known is never `not-started`** (#156 F4): its answer lost
  (`NoAnswer`), T3 answering a failure after it may have taken it (`ToolFailed`: T3 answers
  `orchestration_error` when it takes a send and can't read the run back), or the app stopped
  before T3 answered (found on restart). The thread is read: a run it didn't have before the send
  is the round's, watched to its end; the thread gone means nothing ran, and a fresh fixer
  follows; anything else (no new run, or the thread can't be read) ends `needs-user`. Only a
  refusal before the tool ran (a 4xx, a refused token) or a call never sent is `not-started`.
- **After a restart, don't guess** (as Builds): a round the log shows open with its thread line is
  watched again; a send without one is read as above; a fresh fixer's launch without one, or one
  whose answer was lost, ends `needs-user`, and the repo starts nothing until the user answers
  (`FixLane.answered`).
- **A fork's PR gets no fixer** (#156 N2): a head in another repo than the PR's (GitHub's
  `head.repo`, or none for a deleted fork) would have a fixer push to this repo's branch of that
  name, a fork's `main` being this repo's `main`. Its blocking review ends a round on H as
  `needs-user`, so the repo starts nothing until the user answers, and H gets no round after.
- **Merging** (`MergeLane`), where the runner merges (`merge: runner`): a clean review on the
  newest commit, checks passed on it, nothing open. Just before merging the PR is read again: still
  open at H, not a draft, nothing writing to its branch, the repo not held for the user, fewer than
  2 failed merges on H, its newest review comment the clean one on H, checks passed on H
  (`sol-review` not counted), no conflict, nothing said since the clean review (bots and the
  runner's posts aside) and no unresolved review thread (GraphQL, every page). Then
  `PUT pulls/<n>/merge {sha: H, merge_method: merge}`: GitHub's 409 (the head moved meanwhile) is
  `head-moved`, nothing merges, and the review lane is told so the new head is reviewed.
- **"I merge" repos** (`merge: me`, the default): the re-checked clean PR gets `ready-to-merge`
  (it was `ready-for-stefan`) once per head and is never merged by the app. The mark comes off when
  the head moves, the review isn't clean any more or the re-check fails (a reply included). The
  platform's notifications are a later ticket, so the log line names the PR for now.
- **Merges noticed** (#156 F14), in every repo: each PR the app reviewed or marked that's gone from
  the open list is read once, whatever its label history. Merged (by the user, or by hand where
  the runner merges), its merge is recorded (`by: user`) and cleaned up like the app's, its label
  removed; closed unmerged, it's recorded `closed` and a mark on it comes off. Either way it's done
  with and never read again; GitHub's list lagging (still open) leaves it for the next pass.
- **After a merge, only what the app made** (#156 F15): a build's launch, and a fresh fixer's in
  a new worktree, write a `made` line for the branch T3 made (with its worktree) right after the
  launch. A `branch-exists` build, a fixer in the PR's own worktree and a round sent to a thread
  made nothing. The clean-up removes only branches with a `made` line from the PR's own jobs: its
  fix rounds (by the PR's number and branch) and its build, the one whose end names the PR or the
  one that made the PR's head branch, ended before the merge was recorded and names no other PR
  (#156 F11: a build that opened its PR and then failed has none on its end). It never touches a
  branch another job of the app's is on (one still running, or ended on another PR: a new build
  reusing the name). It removes the worktrees `git worktree list` shows on those branches, but
  never one with uncommitted changes (`git status --porcelain`, or git failing to say): that is
  left, said in the log, and its branch kept. Every thread of those jobs, reviews included, is
  settled: the merge is the latest point one can still be open (#68, story 7). Then a `cleaned`
  line; a worktree git keeps listing, or a settle that failed, leaves it owed for the next pass. T3
  may hold an emptied worktree folder until its thread settles (`docs/t3.md`): such folders are
  kept in the `cleaned` line and swept on later passes (`swept`). Merged is the end: no
  after-merge steps (#68).
- **PR steps in the job log:** a merge or a mark is a `step` line and its `step-end` (`merged`,
  `failed`, `head-moved`, `marked`, `unmarked`, `closed`), apart from jobs: it runs on no model, so the gate
  never counts it. A merge step with no end (the app stopped mid-merge) is read from GitHub on the
  next pass: merged, or failed. A read that fails is said and tried next pass, never taken as
  merged or gone.
- **When:** the fix lane watches open rounds again at start, then passes on usage, the repos, each
  review's end and every minute; the merge lane on each review's end, the repos and every minute.

## Setup

What the runner needs from the PC before it can work, checked (#162; #68 story 16, without
skills). `src/setup.ts` runs the checks in the main process through the app's own seams; the
window (`renderer/src/Setup.tsx`) shows each one passed, waiting, or missing with how to fix it
and what T3 or gh said.

- **T3 Code:** installed (its CLI is at `~/.t3/bin/t3.cmd`), running (`server-runtime.json` names
  an origin), and reachable with the app signed in: `subscribeServerConfig` answers on the
  WebSocket and `t3_project_list` on MCP, so both of the app's sign-ins are tried. A refused
  pairing code or OAuth step is "couldn't sign in"; anything else is "isn't answering".
- **Providers:** from that same server config; connected is `enabled` and `status: ready`, as the
  catalog counts it. Each connected one is listed; with none, each one switched on but not ready
  is shown with T3's message.
- **GitHub:** `gh auth status --hostname github.com --json hosts`: signed in names the login, a
  host whose `state` isn't `success` is a sign-in that no longer works, no hosts is signed out,
  and a gh that can't start is not installed. T3 runs the same gh, so its sign-in is T3's: T3
  serves no GitHub account of its own (`sourceControlHosts` was empty, seen live 2026-11-19
  against T3 0.1.9).
- **Resume after usage limits:** T3's `autoResumeLimitedThreads` (in the config's `settings`) must
  be off, since it would race the runner's own resumes. A T3 without the key passes.
- Providers and Resume wait while T3 can't be reached; gh is checked beside T3.
- **When:** the checks run at start and again on **Check again** (`runner:setup`; a run asked for
  during one is that run). Setup opens by itself on the first start only (`setupSeen` is then
  saved), and later from the sidebar's Setup button, which carries a red mark while a check wants
  fixing: it stands in for Health's link until Health is built. No skills are checked (#68,
  2026-11-18).

## Signing in

`src/t3/sign-in.ts`. **The app signs in under its own label, `Queue runner app`**: today's
runner revokes its older sessions by its label (`Queue runner`, exact match), and the app
revokes its own by `Queue runner app`, so neither signs the other out. Tokens stay in memory
only, never in a log, a record or a file. Both sessions start from a one-time pairing code
(`t3 auth pairing create --scope ... --ttl 5m --label "Queue runner app" --json`), and after
each sign-in the app revokes its own older sessions of that kind, keeping the newest.

- **MCP** (`/mcp`): T3's full-access OAuth flow for an outside MCP client, as the Python runner
  signs in (`docs/t3.md`, `queue_runner/t3_mcp.py`): a pairing code with the full-access scopes
  (`orchestration:read`, `orchestration:operate`, `settings:write`, `source-control:write`),
  then `POST /oauth/mcp/register`, `POST /oauth/mcp/decision` (`access: full-access`) and `POST
  /oauth/mcp/token` with PKCE. A 30-day `mcp-client` session. A token from `t3 auth session
  issue` isn't used: T3 refuses it writes to full-access threads (checked 2026-11-16).
- **The WebSocket** (`/ws`) **refuses MCP client sessions**: T3 rejects subject `mcp-client`
  everywhere but `/mcp` (`rejectMcpClientAudience` in `server.asar`; "MCP client sessions are only
  accepted by the MCP endpoint"), and the live check's upgrade with the MCP token was refused
  (1006). So the WebSocket gets a client session of its own, the way T3's own clients pair: a
  pairing code with `orchestration:read` (what `subscribeServerConfig` needs; later tickets add
  the scopes their methods need), exchanged at `POST /oauth/token` (form:
  `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<code>`,
  `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`,
  `requested_token_type=urn:ietf:params:oauth:token-type:access_token`,
  `client_label=Queue runner app`, `client_device_type=bot`). It answers `{access_token,
  token_type: Bearer, expires_in: 2591999, scope}`: a 30-day session with subject
  `one-time-token` and the app's label.
- **The address** is T3's `origin` in `~/.t3/userdata/server-runtime.json` (`T3CODE_HOME` moves
  it), read on every MCP call and every WebSocket connect, as T3's CLI reads it. A token minted on
  one address is never sent to another: T3 back on a new port means a new sign-in there.
- **A refused token is replaced once:** MCP's 401 or 403, or a WebSocket that never opens, drops
  the token and signs in again; refused again, the call fails. Calls that find no token wait for
  the one sign-in in progress.
- **The CLI** is `~/.t3/bin/t3.cmd`, a batch file, run through `cmd.exe /d /s /c` with arguments
  that have no cmd.exe specials (`src/t3/real.ts`).

## MCP

`src/t3/mcp.ts`, as the Python runner calls it: per tool call, `initialize`,
`notifications/initialized`, `tools/call`, then a `DELETE` with the `Mcp-Session-Id` to close the
session. The answer is JSON or an event stream (its last `data:` line). A tool's `isError` result
is a T3Error with its `code: message`. Projects: `t3_project_list {cursor, limit: 100}` answers
`{projects: [{id, title, workspaceRoot, repositoryIdentity, ...}], nextCursor}`, read until
`nextCursor` is null.

## The WebSocket API

`src/t3/ws.ts`. Found live on 2026-11-18 against T3 0.1.9 (`pnpm --dir app live:sign-in`), with
#68's reading of T3's code checked against it:

- **The upgrade:** `ws://127.0.0.1:<port>/ws?orchestrationProtocol=2` with `Authorization:
  Bearer <client session token>` (Node's WebSocket takes headers). Without
  `orchestrationProtocol=2` the upgrade fails (T3's code answers 426,
  `orchestration_protocol_incompatible`). An MCP client token is refused (above). T3's browser
  client uses a ticket instead (`POST /api/auth/websocket-ticket/rpc` with the bearer token,
  answering `{ticket, expiresAt}` five minutes ahead, then `/ws?orchestrationProtocol=2&wsTicket=`);
  that worked live too, but the header needs no extra request, so the app sends the header.
- **The protocol** is Effect RPC with JSON text frames. The app sends
  `{"_tag":"Request","id":"1","tag":"subscribeServerConfig","payload":{},"headers":[]}`. A
  stream answers `{"_tag":"Chunk","requestId":"1","values":[...]}`, which the client acks with
  `{"_tag":"Ack","requestId":"1"}` before T3 sends the next; it ends with
  `{"_tag":"Exit","requestId","exit":{"_tag":"Success"|"Failure",...}}`. A `Ping` is answered
  `Pong`; a `Defect` or `ClientProtocolError` fails the call.
- **`orchestration.subscribeShell`** (scope `orchestration:read`; the bare `subscribeShell` dies
  with "Unknown request tag"). Seen live 2026-11-19 against T3 0.1.9: a whole snapshot `{kind:
  "snapshot", snapshot: {projects, threads, archivedThreads, ...}}` (10 projects, 697 threads,
  1.6 MB in all), then a partial one naming `resolvedRepositoryIdentityRoots` (only those
  projects, no threads), then `thread.updated` items. From T3's schema: `project.updated
  {project}`, `project.removed {projectId}`, `thread.updated`, `thread.removed`, and
  `synchronized`/`snapshot-required` markers. A project has `id`, `title`, `workspaceRoot`,
  `repositoryIdentity`, `archivedAt`, `scripts` and more. The app (`src/t3/project-feed.ts`)
  opens the stream again at once on `snapshot-required`, so its whole snapshot replaces what was
  missed, and leaves out a project whose `archivedAt` is set, as T3 hides it.
- **`orchestration.subscribeThread {threadId}`** (scope `orchestration:read`; seen live
  2026-11-19 against T3 0.1.9, a Haiku thread in the sandbox): a `{kind: "snapshot",
  snapshotSequence, projection}` whose projection has `thread`, `runs`, `attempts`, `nodes`,
  `runtimeRequests`, `messages`, `turnItems` and more, then `{kind: "event", sequence, event:
  {type, payload, ...}}` items. Types seen: `provider-session.*`, `provider-thread.updated`,
  `provider-turn.updated`, `run.updated`, `run-attempt.updated`, `node.updated`,
  `message.updated`, `turn-item.updated`, `checkpoint.captured`; T3's schema adds
  `runtime-request.updated`. A run's `status` is one of `preparing`, `queued`, `starting`,
  `running`, `waiting`, `completed`, `interrupted`, `failed`, `cancelled`, `rolled_back`; the
  live run went `running`, then `waiting` for half a second, then `completed`. A runtime request
  is `pending`, `resolved`, `expired` or `cancelled`. A usage limit is a failed run whose root
  node's latest failed `error` turn item has `failure.class: usage_limit` and `failure.resetAt`
  (T3's own `latestRootProviderFailure` in `server.asar`).
- **`subscribeServerConfig`** (scope `orchestration:read`). Its payload's flags are all optional
  (`environmentThemes`, `usageLimitSources`, `usageLimitsCommand`, `workspaceSnapshotsOnDemand`,
  `providerCatalogsOnDemand`). With `{}` T3 sent one Chunk of 726,605 bytes with one value,
  `{version: 1, type: "snapshot", config}`; with `workspaceSnapshotsOnDemand` and
  `providerCatalogsOnDemand` it was 64,571 bytes. Nothing more came in 40 seconds (no Ping, no
  update). `config` has `environment` (`environmentId`, `label`: the machine, `platform`,
  `serverVersion`, `orchestrationProtocolVersion: 2`, `capabilities`), `auth` (`policy:
  desktop-managed-local`, `sessionMethods`), `cwd`, `keybindingsConfigPath`, `keybindings`,
  `issues`, `providers` (11 here: `instanceId`, `driver`, `status` such as `ready` or
  `disabled`, ...), `availableEditors`, `remoteOpenTargets`, `directEndpoints`, `observability`,
  `settings` (T3's settings: `defaultModelSelection`, `snoozeLimitedThreads`,
  `autoResumeLimitedThreads`, ...), `shell*` and `thread*` capability flags,
  `secretProviderSettings`, `secretReferences`, `secretRequestReferences`,
  `scratchWorkspaceRoot` and `newProjectsRoot`. The later events, from T3's schema (not seen
  live): `keybindingsUpdated`, `providerStatuses {providers}`, `settingsUpdated {settings}`,
  `environmentThemesUpdated {themes}` and `usageLimitSourcesUpdated {sources}`, each `{version:
  1, type, payload}`.
- **A method that answers once** (not a stream) sends no Chunk: its answer is the Exit's
  `exit.value` (`T3Ws.request`). `orchestration.getThreadProjection {threadId}` (scope
  `orchestration:read`) answers `{thread, runs, ...}`; each run keeps its `modelSelection`, effort
  included, which MCP's `t3_thread_read` doesn't show (checked live 2026-11-19).

## GitHub

`src/github.ts`: `gh repo view --json nameWithOwner,url` run in the project's folder (gh reads
its git remotes). Only a folder that's gone, or one of gh's three exit-1 answers for a folder with
no GitHub repo (`not a git repository`, `none of the git remotes configured for this repository
point to a known GitHub host` such as the sandbox's local `origin.git`, `no git remotes found`;
gh 2.x, seen live 2026-11-18), is `no GitHub remote`. Any other gh failure (exit 4 when not
signed in, `HTTP 401: Bad credentials`, offline, gh not installed, a repo gh can't see) is a
`GitHubError` with gh's exit code and first stderr line: `--list` prints `gh failed: ...` for
that project and exits 1. The gh seam keeps the exit code and stderr; a gh that can't start or
is killed is code -1 with Node's reason in stderr, never a gh exit code (so is the `t3` CLI's).

## Live checks

- `app/live/sign-in.ts` (`pnpm --dir app live:sign-in`): the app acts on no project. The check
  first starts today's runner's own MCP client (`scripts/live_runner_settle.py`, Python, the
  "queue-runner sandbox" project only), which signs in as the runner does and launches an idle
  thread. Then it starts the app twice; checks the app holds one session of each kind, gh failed
  for no project and the runner's sessions are all still active; and has the runner client
  settle its thread with the token it signed in with before the app did, which must work with
  no new sign-in. It records what `/ws` does with an MCP token and the frames
  `subscribeServerConfig` sent, and revokes the app's sessions (the runner client archives its
  thread and revokes its own). The runner client's sign-in revokes a running runner's older
  session, as `scripts/live_mcp.py` does: that runner signs in again on its next settle.
  **Run 2026-11-18, twice:** all ok; 10 projects, 6 on GitHub, gh failed for none; the runner
  client (session `d92c0baf`) settled thread `mcp:9a2c1fad` after both app starts with no new
  sign-in.
- `app/live/launch.ts` (`pnpm --dir app live:launch [-- --run <instance>:<model>]`): the
  "queue-runner sandbox" project only (it refuses to run without exactly one). One tiny thread per
  driver (the first connected provider for each effort option id, its default model), each at an
  effort that isn't the model's default, launched through `launchJob` in the project's folder;
  it reads the effort back from the run's `modelSelection` (`orchestration.getThreadProjection`)
  and archives the thread. **Run 2026-11-19:** Claude's Opus 5.5 and Haiku 5.5 completed with
  `effort: low` on their runs; Codex's `gpt-6-astra` run carried `reasoningEffort: low` but failed
  on ChatGPT's usage limit, so a completed Codex run is owed (the Python check ran one at
  `reasoningEffort: high` on 2026-11-17, docs/t3.md).
- `app/live/build.ts` (`pnpm --dir app live:build [-- --run <instance>:<model>]`): the
  "queue-runner sandbox" project only, like today's `scripts/live_sandbox.py`. A hand-made issue
  (add a line to README, commit, push to `origin`; the sandbox has no GitHub, so no picking, no
  PR) built through `BuildLane.build`, numbered afresh each run so an earlier run's branch never
  holds it, on T3's default model at its lowest effort unless `--run` names one; the gate isn't
  asked. It checks the end was `done`, the branch is on `origin`, the thread ran in its own
  worktree on the job branch on the asked model, and it was settled. **Run 2026-11-19** on Haiku
  5.5 at low: all ok, in about 20 seconds.
- `app/live/review.ts` (`pnpm --dir app live:review -- (--pr N | --open-pr) --run
  <instance>:<model> [--state <folder>]`): today's `scripts/live_review.py` for the app, dry run. One real review of
  one open PR in `stefan1575/queue-runner-sandbox` only (it refuses another clone), through
  `ReviewLane.review` with a `DryRunPoster`, after saying what adoption would decide (the sandbox
  has no CI, so it reviews anyway). The review runs in the one T3 project whose folder is a clone of
  the GitHub sandbox, found by that remote, not by title (it refuses none or several; #155 F21):
  "queue-runner sandbox GitHub", at `~/.queue-runner/gh-sandbox/repo`, set up by hand like the build
  check's. The build check's "queue-runner sandbox" (a local bare origin) is never it. Its checkout of the head is a worktree of that
  folder, removed at the end: T3 binds `existing_worktree` only to one of the project's own `git
  worktree list` paths (its launch's `assertProjectWorktree`, read in the installed server
  2026-11-19), so a checkout of a clone elsewhere is refused before a review starts (#155 F18).
  When T3 refuses the launch anyway, the check prints `T3 didn't start the review:` and its reason. `--pr N` reviews that
  PR and writes nothing to GitHub. `--open-pr` instead opens a small PR of its own (one function
  with an off-by-one), which writes to GitHub: it pushes a branch and opens the PR, then closes it
  and deletes the branch at the end. With neither (or both) it prints its usage and does nothing.
  `--run` is required (T3's default may have every tool, so there's none by default), and naming
  an instance there doesn't make it tool-free: the check reads the desktop app's saved settings
  (the state folder `%APPDATA%/Queue runner/machine.json` names, Electron's `userData` for the
  app's productName, or `--state <folder>`) and refuses, before it reads GitHub, an instance not
  in its `toolFreeInstances` or the one its builds run on. Seen 2026-11-19 with an empty
  `--state`: `refusing: the review would run on claudeAgent, which isn't one of the instances set
  up without outside tools`, exit 2. It checks a
  verdict was read from the ledger, the comment names its reviewer, nothing was posted and no
  `sol-review` set, the thread ran on the asked model and was settled, and the checkout is gone.
  **Run 2026-11-19** on `claudeReviewer` Haiku 5.5 at low: all ok, sandbox #4 reviewed blocking in
  about 30 seconds (F1, the loop bound, shown by running the function). **Run again 2026-11-19**
  with `--pr 5` after review 1's fixes, same model: all ok, blocking; with no flags it printed its
  usage and did nothing.
- `app/live/merge.ts` (`pnpm --dir app live:merge`): today's `scripts/live_merge.py` for the app,
  the merge path against `stefan1575/queue-runner-sandbox` only, in the T3 project cloned from it
  (found by its remote, as the review check's). The review is stubbed clean: no thread runs, and
  the clean reviews are decided from a clean reply and posted as the lane posts them. **It writes to
  GitHub:** a branch made in a worktree of the project's folder, as a build's, and its PR, a `ci`
  status on each head; review 1 clean on H1, then a push: the merge lane must not merge, and a merge
  naming H1 must get GitHub's 409; then review 2 clean on H2 and the lane merges: merged at H2 with
  a merge commit (two parents), one merge step, cleaned up, the worktree gone from `git worktree
  list` and the local branch deleted. The PR's branch is deleted on GitHub at the end. **Run
  2026-11-19:** all ok, sandbox PR #6 (H1 b6d200a refused with 409; merged at 5f18b12, merge commit
  e1c88e5). **Run again 2026-11-19** after #156 F11 (the clean-up finds the build by its branch):
  all ok, sandbox PR #7 (H1 5544615 refused with 409; merged at 4cae92e, merge commit 56bc728,
  worktree and local branch gone). **Run again 2026-11-19** after #156 F15 (the clean-up removes
  only what a `made` line records; the check records its build's): all ok, sandbox PR #8 (H1
  f266f22 refused with 409; merged at a82bd12, merge commit 2135b76, worktree and local branch
  gone).
- `app/live/usage.ts` (`pnpm --dir app live:usage [-- --minutes N]`): acts on no project. It
  subscribes to T3's server config and prints each connected provider's windows as the app reads
  them, then each `providerStatuses` event that changes one, for N minutes (5 by default). **Run
  2026-11-19:** three providers, each read again about every 5 minutes (Usage, above).
