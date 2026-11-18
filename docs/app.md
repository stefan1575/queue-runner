# The app

The TypeScript rebuild of the runner (spec #68), in `app/`: one package, TypeScript on Node 24,
pnpm, Vitest. It grows ticket by ticket beside the Python runner (`queue_runner/`), which keeps
serving Stefan's repos until the cutover ticket. So far (#149) it signs in to T3 and lists the
repos it could serve.

## Run it

```
pnpm --dir app install
pnpm --dir app start -- --list    # every T3 project, its folder and GitHub remote; changes nothing
pnpm --dir app live:sign-in       # the live sign-in check (Live checks, below)
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

CI runs both on Windows (`.github/workflows/tests.yml`, job `app`), beside the Python tests.

## Rules for every rebuild ticket

- **T3 and GitHub only.** No reads of T3's database or settings, of Claude's or Codex's files,
  of `~/.claude` or `~/.codex`. No personal scripts. `gh` for GitHub. Starting T3's CLI is
  allowed only for signing in (pairing codes, and listing and revoking the app's own sessions).
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
its git remotes). One gh finds no GitHub repo for (not a git folder, a remote elsewhere such as
the sandbox's local `origin.git`, or a folder that's gone) is `no GitHub remote`.

## Live checks

- `app/live/sign-in.ts` (`pnpm --dir app live:sign-in`): acts on no project. Notes today's
  runner's sessions, starts the app twice, and checks the app holds one session of each kind and
  the runner's sessions are all still active; records what `/ws` does with an MCP token and the
  frames `subscribeServerConfig` sent; revokes the app's sessions. **Run 2026-11-18:** all ok;
  the Python runner's session `1a581ed0` stayed active through both starts.
