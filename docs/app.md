# The app

The TypeScript rebuild of the runner (spec #68), in `app/`: one package, TypeScript on Node 24,
pnpm, Vitest. It grows ticket by ticket beside the Python runner (`queue_runner/`), which keeps
serving Stefan's repos until the cutover ticket. So far it signs in to T3 and lists the repos it
could serve (#149), opens as a desktop window that keeps running in the tray, with Settings
(#150; The desktop app, below), and keeps its repositories in step with T3's projects
(#151; Repositories, below).

## Run it

```
pnpm --dir app install
pnpm --dir app start -- --list    # every T3 project, its folder and GitHub remote; changes nothing
pnpm --dir app live:sign-in       # the live sign-in check (Live checks, below)
pnpm --dir app desktop            # builds and opens the desktop app (The desktop app, below)
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
push to `main` runs them first (`docs/tests.md`, Main is tested before a push).

**Tests check the code, never Stefan's settings** (#172). A test builds its own settings, in a
temp folder or an in-memory store, and checks what the code does with them. No test reads the
app's real settings, the runner's `config.toml` or T3's real files, and none asserts one of
Stefan's values (a model, an effort, which repo he merges): changing a setting must never turn
main red (#169). `test/no-real-settings.test.ts` fails on a test file that reaches the user's
home or app-data folders, `T3_HOME` or `T3CODE_HOME`, T3's real runtime file or CLI
(`runtimeAddress()` or `t3Cli()` with no path), `config.toml`, or the real settings path, which
the settings tickets export as `SETTINGS_PATH` (`test/real-settings.ts` lists them all).

## Rules for every rebuild ticket

- **T3 and GitHub only.** No reads of T3's database or settings, of Claude's or Codex's files,
  of `~/.claude` or `~/.codex`. No personal scripts. `gh` for GitHub. Starting T3's CLI is
  allowed only for signing in (pairing codes, and listing and revoking the app's own sessions).
  **The one exception:** T3's Time format, `timestampFormat` in T3's
  `~/.t3/userdata/client-settings.json`, which T3's server doesn't serve (The desktop app, The
  clock). The app reads that one setting, never writes the file, and watches it. The exception
  goes once T3's server serves client settings.
- **Seams, faked in tests:** T3 (MCP and WebSocket; `src/t3/seams.ts`: HTTP, the socket, the
  CLI, the address), GitHub (`src/github.ts`), and the platform (Windows: tray, notifications,
  start at logon, wake). Tests never touch the network, T3, GitHub or the Task Scheduler
  (`test/fake-t3.ts` answers in memory). A temp folder a test makes is removed after it
  (`afterEach` with `rm(..., {recursive: true, force: true})`).
- **The Python runner keeps serving Stefan's repos until the cutover ticket.** The app acts only
  on projects switched to Served (Repositories ticket), and until the cutover only the sandbox
  project ("queue-runner sandbox") and the GitHub sandbox `stefan1575/queue-runner-sandbox` are
  ever switched on, by live checks.
- **Port, don't redesign.** Today's runner and its docs (`docs/flow.md`, `docs/claude-lane.md`,
  `docs/reviews.md`, `docs/stops.md`, `docs/usage.md`, `docs/dashboard.md`) are the behaviour to
  port, with #68's changes on top. A rule you'd change is a comment on #68, not a quiet change.
- **No model or vendor name in code.** Models come from settings (#121's rule). The GitHub-facing
  names (`sol-review` status, `sol-findings` ledger, `<!-- sol-finding -->` marks) stay as they
  are, because open PRs in served repos read them across the cutover.
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
  (`repos`; Repositories, below). Each change is checked,
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
  writes the file, and polls it (`fs.watchFile`, every 500 ms: it sees a file that's missing or
  replaced by a rename), telling the window when the format changes. A file that's missing or
  unreadable, or has no such key or a value T3 doesn't offer, is System default. It goes once
  T3's server serves client settings. The app has no Time format setting of its own.

### Screenshots

`pnpm --dir app desktop:shoot <absolute dir>` renders the real window on a fresh state in a temp
folder (never the real state, lock or logon entry): `window`, `settings-name`,
`settings-repos`, `settings-display`, `settings-machine` and `settings-search` (a typo, "windos"), each
`-light.png` and `-dark.png`, at 1440x900. The page's address opens Settings for it:
`#settings=<page>` or `#q=<search>`. Repositories is shot from a sample (`src/desktop/sample.ts`:
two served repos, one New and one with no GitHub remote), which reaches neither T3 nor GitHub.

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
- **Served** needs a GitHub remote, read again when it's switched on: a project without one says
  "No GitHub remote" and its switch is off and disabled. Switching on first lists the repo's
  labels (`gh label list`) and creates whichever of `ready-for-agent`, `needs-info` and
  `ready-to-merge` is missing (`gh label create`; one made meanwhile is left as it is). gh
  failing leaves it off and the page says why. Switching off and who merges touch GitHub not at
  all. Until the cutover only the sandboxes are ever switched on (Rules).
- **Not settings:** the base branch is GitHub's default branch, and the folder is the T3
  project's.

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
  `repositoryIdentity`, `archivedAt`, `scripts` and more.
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
