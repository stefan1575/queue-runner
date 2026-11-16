# Interrupting a T3 thread from a script (issue #43, Stop now)

Status: **done, code-read only.** Researched 2026-11-16 for [stefan1575/queue-runner#43](https://github.com/stefan1575/queue-runner/issues/43). No live check was run: the only open route needs a bearer token minted for the script (see 3 and "The live check").

**Answer: yes, with caveats.** T3's CLI has no interrupt, and its MCP route won't reach the runner's threads. But a script can do what the app does. It runs `t3 auth session issue --scope orchestration:operate --ttl 5m --token-only`, a public, documented CLI command for headless clients. It then opens T3's WebSocket at `ws://127.0.0.1:3773/ws?orchestrationProtocol=2` with `Authorization: Bearer <token>` and sends one Effect-RPC request, `orchestration.dispatchCommand`, with `{type: "run.interrupt", commandId, threadId, runId, reason}`. T3 then interrupts the Claude turn through the Claude SDK. The run ends `interrupted`, and the runner's blocked `t3 thread start|send --wait --json` returns `status: "interrupted"` and exits 1. The worktree and branch are left alone, and `t3 thread send` can continue the thread. The caveats:

- The wire protocol is T3's private, versioned app RPC (protocol 2; a mismatch gets HTTP 426), not a stable public API.
- The runner is stdlib-only and Python has no WebSocket client, so it needs a small hand-written RFC 6455 client.
- Each Stop now mints a short-lived session in T3's auth store, which the runner should revoke afterwards.

AGENTS.md's claim that a script "can't" mint a session is half right. It can't do it in-process the way `t3 thread` does, but `t3 auth session issue` does it on the script's behalf. That session is accepted by the WebSocket RPC, not by `/mcp`.

## Scope and versions

- Installed app and CLI: **0.1.9**, commit **24e77473ecf4** (`C:/Users/Anon/AppData/Local/Programs/t3code/resources/app.asar/package.json:3-5`; `t3 --version` → `t3 v0.1.9`). That's the [latest stable release][rel-stable], published 2026-11-11, whose tag points at [24e77473ecf41bc1f7142529c7911c1c1aae1d76][tag]. The newest nightly is [v0.1.10-nightly.20261116.4761][rel-nightly] (6b7027b1f43e).
- Read: `resources/server.asar` and `resources/app.asar`, extracted read-only to the scratchpad. Bundle files are `apps/server/dist/<name>-<hash>.mjs`, cited below by file and function, with line numbers in this build. Also the upstream source at the installed commit (links below), and `queue_runner/t3.py`, `run.py` and `snapshot.py`.
- T3's database was read read-only once, for thread runtime modes (finding 3). No secret was read, no session was issued, and nothing under `~/.t3/` was changed.

## 1. What the app sends when you stop a thread

**The Stop button and the `thread.stop` keybinding** call `EnvironmentCommands.interruptThreadTurn` in the web client (`dist/client/assets/runtime-DGxAt5gI.js`; it is bound as `"thread.stop": Bh` in `_chat-CtJYXWM7.js`). On a server whose environment says `capabilities.threadStop === true`, which 0.1.9 always does (`ServerEnvironment.ts`, `ManagedEndpointRuntime-*.mjs:130111`), it sends:

```json
{"type": "thread.stop", "commandId": "<uuid>", "threadId": "<thread>"}
```

Otherwise it finds the newest preparing/starting/running/waiting run and sends `{"type": "run.interrupt", "commandId", "threadId", "runId", "holdQueue": true}`.

- **Transport:** the app's WebSocket RPC, method `orchestration.dispatchCommand` ([`ORCHESTRATION_V2_WS_METHODS`][ws-methods]; client `X = e => _i(oa.dispatchCommand, e)` in `runtime-DGxAt5gI.js`). This is not HTTP or MCP.
- **The two commands, as the contracts define them:**
  - [`run.interrupt`][cmd-run-interrupt]: `{commandId, threadId, runId, reason?, holdQueue?}`.
  - [`thread.stop`][cmd-thread-stop]: `{commandId, threadId, reason?}`. It is the Stop button's whole action: interrupt whichever turn runs, hold the queued messages, end PR watches and stop delegated tasks (doc comment on `stop` in [`OrchestratorMcpThreadInterruptInput`][mcp-interrupt-input]).
- **Compared with `thread.settle`:** `thread.settle` goes through the same `orchestration.dispatchCommand` (`ThreadManagementService` dispatches `{type: "thread.settle", commandId, threadId}`, `runtimeLayer-*.mjs:153000`). Both are orchestration commands on one dispatcher; only the payload differs.
- **The orchestrator's switch** sends `run.interrupt` to `dispatchRunInterrupt`, and with `holdQueue` also cancels orphaned delegated follow-ups. It sends `thread.stop` to `dispatchThreadStop` ([Orchestrator.ts:13784][orch-switch], `runtimeLayer-*.mjs:151946`).
- **What `dispatchRunInterrupt` does** ([Orchestrator.ts:11863][orch-dri]):
  - It writes a `run_interrupt_request` turn item whose message is `reason ?? "Stopped by user"`.
  - For a running provider turn it queues a `provider-turn.interrupt` effect.
  - For a run that never reached its provider, it marks the attempt, node and run `interrupted` at once ("Run interrupted before provider start").
  - Otherwise it fails with "Run <id> is not interruptible."
- **The effect worker** calls `ProviderTurnControlService.interrupt` ([EffectWorker.ts:154][effect-worker]). For Claude that is the Agent SDK's `query.interrupt()` ([ClaudeAdapterV2.ts:1526][claude-interrupt]).
- **If the provider doesn't answer:** a `ProviderAdapterInterruptTimeoutError` becomes `thread.interrupt.unresponsive` ([EffectWorker.ts:199][effect-worker-unresp]). That only stamps `unresponsiveAt` on the request item ([Orchestrator.ts:11552][orch-unresp]). The hard kill is a separate RPC, `orchestration.forceStopThread`: `ThreadManagementService.forceStopThread` ([ThreadManagementService.ts:1200][tms-force]) kills the thread's agent scope (`agentScope.kill`), then dispatches `run.interrupt`.

## 2. Every path that reaches it

| Path | Sends | Who can use it |
| --- | --- | --- |
| App (Stop button, keybinding) | `thread.stop`, or `run.interrupt` + `holdQueue` | The app's browser session (cookie) |
| WebSocket RPC `orchestration.dispatchCommand` | any client-dispatchable command, incl. `run.interrupt` and `thread.stop` | any session with scope `orchestration:operate` ([RpcAuthorization.ts:42][rpc-scope]), incl. a bearer token from `t3 auth session issue` |
| WebSocket RPC `orchestration.forceStopThread` | kill the agent scope + `run.interrupt` | same scope ([RpcAuthorization.ts:46][rpc-scope]) |
| MCP tool `t3_thread_interrupt` over HTTP `/mcp` | `run.interrupt` (no `holdQueue`; reason `Stopped by an agent[: reason]`), or `thread.stop` with `stop: true` | MCP-client sessions only (3) |
| CLI `t3 thread …` | nothing: `list`, `start`, `send`, `show` only ([cli/thread.ts:768][cli-thread-cmds]) | n/a |
| CLI hidden `acp-mcp-call <tool> <json>` | any MCP tool, incl. `t3_thread_interrupt` | only with `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION` in its environment ([AcpMcpStdioBridge.ts:339][acp-env]); meant for ACP agent terminals T3 starts |

**The MCP tool's server side:** `t3_thread_interrupt` ([tools.ts:298][mcp-tool]; handler `OrchestratorMcpService.interruptThread`, [OrchestratorMcpService.ts:3217][mcp-impl]):

- It loads the target, checks the caller's runtime and interaction modes against the target thread's (`resolveRuntimeMode` / `resolveInteractionMode`), then either:
  - dispatches `thread.stop` (with `stop: true`), or
  - calls `ThreadManagementService.interruptThread` ([ThreadManagementService.ts:1152][tms-interrupt]). That picks the newest active run, or checks the given `runId`, and dispatches `run.interrupt`.
- It returns `{threadId, runId, status}`, where status is `interrupt_requested`, `no_active_run`, or the run's terminal status if it had already ended ([`OrchestratorMcpThreadInterruptResult`][mcp-interrupt-result]).
- The CLI's own MCP session from `issueMcpClientSession` could call it, but no CLI command does.

**Upstream has no CLI interrupt yet:**

- [`v0.1.9` `cli/thread.ts`][cli-thread-cmds] and [nightly 20261116.4761's][cli-thread-nightly] both register only `list`, `start`, `send` and `show`.
- [PR #23943][pr-23943] ("feat(cli): … interrupt runs", adds `t3 thread interrupt <thread> [--json]` calling `t3_thread_interrupt`) was **closed unmerged** on 2026-10-23, "until there's maintainer approval" on [discussion #23945][disc-23945]. That discussion is still open, with one +1 asking for interrupt.
- [Issue #33851][issue-33851] ("CLI parity: `t3 thread interrupt|configure` …") was closed **not planned** on 2026-11-10 and moved to [discussion #33855][disc-33855], also still open.
- Searching open PRs for "thread interrupt" and "cli interrupt" turned up nothing else that adds one.

## 3. Auth: what a caller outside the app needs

- **The server's address** is in `~/.t3/userdata/server-runtime.json` (keys `origin`, `port`, `pid`, `version`…; here `http://127.0.0.1:3773`). The CLI reads the same file (`readPersistedServerRuntimeState` in `withThreadTools`).
- **Where tokens live:** session rows are in an `auth_sessions` table (`persistence/AuthSessions.ts`). Tokens are signed with a key named `server-signing-key`, kept in T3's secret store under `~/.t3/userdata/secrets/` (`AuthSessions.ts`, `relayTracing-*.mjs:4474`). A script must never read that key to forge tokens. A secret like this should only be minted through T3.
- **`t3 auth session issue` is the public way to get a token.** It is documented as "Issue a scoped bearer access token for headless or remote clients" ([cli/auth.ts:169][cli-auth]). It takes `--scope` (repeatable), `--ttl`, `--label`, `--subject`, `--token-only` and `--json`. Like `withThreadTools`, it runs T3's `EnvironmentAuth` in the CLI process (`runWithEnvironmentAuth`) and calls `issueSession` ([EnvironmentAuth.ts:1097][ea-issue]). That makes a `bearer-access-token` session with subject `DEFAULT_SESSION_SUBJECT` and no DPoP binding. `t3 auth session revoke <id>` ends it, and `t3 auth session list` lists sessions without their tokens.
- **The WebSocket accepts that token.** `/ws` ([ws.ts:3542][ws-route]) first requires `?orchestrationProtocol=2` ([ws.ts:741][ws-proto]), else HTTP 426. It then calls `authenticateWebSocketUpgrade(request, "rpc")` ([ws.ts:3559][ws-auth]), which falls back to `authenticateRequest` when there's no `wsTicket` ([EnvironmentAuth.ts:1262][ea-wsup]). `selectRequestCredential` takes `Authorization: Bearer …` ([EnvironmentAuth.ts:655][ea-cred]). The browser-origin check applies only to cookie credentials ([EnvironmentAuth.ts:788][ea-origin]), so a script with no `Origin` header passes. `orchestration.dispatchCommand` needs only `orchestration:operate` ([RpcAuthorization.ts:42][rpc-scope]).
- **The WebSocket RPC has no runtime-mode ceiling.** Its handler dispatches the command with `createdBy: "user"` ([ws.ts:2054][ws-dispatch]).
- **`/mcp` won't take that token.** `authenticateMcpClient` accepts only sessions whose subject is `mcp-client` ([EnvironmentAuth.ts:1316][ea-mcp]). In the other direction, `rejectMcpClientAudience` keeps MCP sessions off the RPC routes ([EnvironmentAuth.ts:617][ea-reject]).
- **Faking the MCP subject doesn't help either.** `--subject mcp-client` would pass that check, but the session would carry no `runtimeModeCeiling`, so `authenticateMcpClient` gives it `approval-required`. An outside caller's limits are that ceiling (`loadCaller` → `clientModeCeiling`, [OrchestratorMcpService.ts:1111][mcp-caller]), and `resolveRuntimeMode` refuses a target broader than the caller (`runtime_mode_escalation_denied`, [delegatedTaskModes.ts:36][modes]). All 422 threads in this T3 are `full-access` (read-only count of `orchestration_v2_projection_threads.runtime_mode`, 2026-11-16), so the interrupt would be refused. It would also lean on an internal constant. Only `issueMcpClientSession` sets a `full-access` ceiling ([EnvironmentAuth.ts:1341][ea-mcp-issue]), and only in-process (`withThreadTools`, [cli/thread.ts:206][cli-wtt]).
- **The hidden `acp-mcp-call`** needs an MCP-client bearer token in `T3_ACP_MCP_AUTHORIZATION` ([AcpMcpStdioBridge.ts:339][acp-env]). It mints nothing, so it has the same problem. Its JSON argument would also have to cross `t3.cmd`, whose cmd.exe parsing `t3.py` guards against (`"` is a special).
- **Loopback gives no exemption.** Every route authenticates, and I found no unauthenticated loopback path in `EnvironmentAuth` or `ws.ts`.

**So AGENTS.md ("T3, as a script sees it", the settle bullet) is right about `/mcp` but too broad.** A Python script can get a usable session by running `t3 auth session issue`. It works for the app's WebSocket RPC, not for MCP. The same route would also let a script settle threads (`thread.settle`).

**Wire format** (Effect 4.1.2 RPC, JSON serialization; `layerJson` → `RpcSerialization.json`, `runtimeLayer-*.mjs:15439`; client request shape in `effect/dist/rpc/RpcClient.js`, `runtimeLayer-*.mjs:15892`):

- **Framing:** one JSON object per WebSocket text frame. The server accepts a bare object or an array of them.
- **Request:** `{"_tag": "Request", "id": "<string>", "tag": "orchestration.dispatchCommand", "payload": {…command…}, "headers": []}`.
- **Reply:** an `Exit` message with `exit._tag` `Success`, whose value is `{sequence}`, or `Failure` with an `OrchestrationV2DispatchCommandError` (`message`, `detail`).
- **Unverified:** the exact `headers` encoding, and whether the server's Ping must be answered for a one-shot request (open questions).

## 4. What an interrupt does to the run

- **Run status: `interrupted`.** With a live Claude session, the SDK's interrupt makes Claude end the turn. ClaudeAdapterV2 then finalises the turn as `interrupted`: `finalizeActiveTurn({status: interrupted ? "interrupted" : …})`, and `terminalStatusFromResult` maps `aborted_tools` / `aborted_streaming` to `interrupted` ([ClaudeAdapterV2.ts:3959][claude-status]). With no session (`isNone(sessionOption)`), `settleInterruptedRun` marks it interrupted directly ([Orchestrator.ts:11151][orch-settle]). Before the provider starts, `dispatchRunInterrupt` marks the run `interrupted` itself (1). The thread then has no active run, so `thread show` reads it idle, or by its latest run's status.
- **What `--wait --json` returns.** `t3 thread start|send --wait --json` waits through `t3_thread_wait`, which returns on a terminal run. `finishRun` ([cli/thread.ts:478][cli-finish]) prints `{threadId, runId, status: "interrupted", reply: null, error}`. `error` is the run's `error` turn item's text, likely null after an interrupt because the interrupt writes `run_interrupt_*` items, not `error` (unverified). It then raises `ThreadRunEndedError` ([cli/thread.ts:107][cli-ended]), which has no exit-code override and so **exits 1**. Only `ThreadNeedsInputError` sets 2 ([cli/thread.ts:100][cli-needs]). This matches AGENTS.md and `t3.py`: `RunResult(exit_code=1, status="interrupted")`.
- **The worktree and branch survive.** No code in the interrupt path (`dispatchRunInterrupt`, `settleInterruptedRun`, `holdStoppedThread`, the `provider-turn.interrupt` effect) touches the workspace. They emit only run, attempt, node, turn-item and provider-turn events. Worktrees are removed only by T3's thread-delete or merge cleanup, which the runner doesn't use (AGENTS.md).
- **`t3 thread send` can continue it.** After the interrupt the thread has no active run, so `t3_thread_send` (mode `auto`) starts a new turn on the same provider thread. Claude's session is kept: the SDK interrupt doesn't close the query (ClaudeAdapterV2 keeps `close` separate), and upstream fixed interrupted Claude context surviving revert in [PR #25695][pr-25695].
- **Don't use `holdQueue: true` or `thread.stop`.** Both put the thread in the app's "stopped" state: `holdStoppedThread` ([Orchestrator.ts:11406][orch-hold]) holds queued runs and switches off limit auto-resume. A new message joins a held queue unless it comes from the web or mobile app (`heldRunsToRelease` checks `creationSource === "web" | "mobile"`, `runtimeLayer-*.mjs:146715`). The runner's threads never have queued messages, so this is defensive. The MCP tool's default (`run.interrupt`, no `holdQueue`) is the shape to copy. Upstream has an open bug about a held message with no way to release it ([#37196][issue-37196]).

## 5. Killing the Claude Code process instead

- **It's possible but worse.** T3 runs Claude through the Claude Agent SDK, which runs a `claude` child process for the query.
- **The process is hard to pick out.** Telling it apart from Stefan's own Claude sessions, and from other T3 threads, means matching process trees to the provider session id (`orchestration_v2_projection_provider_threads.payload_json.nativeThreadRef.nativeId`). That isn't on any process's command line I checked.
- **T3 records a different end.** A query that dies without T3 asking is not a requested interrupt. The adapter's closed-query path ends calls as `failed` unless `context.stopping` (`runtimeLayer-*.mjs:53645`), so the run would most likely read `failed`, not `interrupted` (unverified). The runner would then treat a Stop now like a crash.
- **Other risks:** T3's provider-restart logic may start a new runtime, the transcript can be cut mid-write, and `limits.py`'s context read may land on a partial record.
- **T3's own hard stop is better.** `orchestration.forceStopThread` (1) kills the agent scope *and* records `run.interrupt` with `FORCE_STOP_REASON`. It needs the same token and transport as the soft interrupt, so it's the right fallback if a soft interrupt is marked unresponsive.

## 6. Upstream status

- **Installed is the latest stable:** 0.1.9 = [v0.1.9][rel-stable] (commit 24e77473ecf4). Neither v0.1.9 nor nightly 0.1.10-nightly.20261116.4761 has a CLI interrupt (2).
- **Proposals:** [PR #23943][pr-23943] was closed unmerged, pending [discussion #23945][disc-23945] (open). [Issue #33851][issue-33851] was closed not-planned and moved to [discussion #33855][disc-33855] (open).
- **Related merged work, all about labels:** [#24299][pr-24299] and [#33420][pr-33420] (an agent's Stop no longer reads as the user's). None adds a script route.
- **Docs:** the [outside-agents doc][outside-agents] covers MCP over OAuth, and `t3 auth session issue` is the headless route.

## What the runner would do

This matches #43's acceptance criteria. It's a sketch, not a design decision.

- **One small module, `t3_control.py` (stdlib only):**
  - `token()` runs `t3 auth session issue --scope orchestration:operate --ttl 5m --label queue-runner-stop --json` through `T3Cli._call`. Its arguments have no cmd.exe specials. It returns `{sessionId, token}`, and the token stays in memory: never logged, never in the job log or snapshot.
  - `dispatch(command)` reads `origin` from `server-runtime.json` and does a minimal RFC 6455 client handshake to `/ws?orchestrationProtocol=2` with `Authorization: Bearer`. It sends one `Request` frame for `orchestration.dispatchCommand`, reads until the matching `Exit`, then closes.
  - `revoke(sessionId)` runs `t3 auth session revoke <id>` in a `finally`.
- **Startup check, giving `sources`' `t3_interrupt`:**
  - Mint a token and connect. A 101 response means auth and protocol are fine. A 426 is not ok: "T3's orchestration protocol changed". A 401 or 403 is not ok with T3's message.
  - Then dispatch a harmless `run.interrupt` for a thread that has a *terminal* latest run, e.g. the newest settled-or-idle thread in the sandbox project or a served repo, read by `t3 thread list|show`. The decider rejects it with "Run … is not interruptible." before emitting any event (`dispatchRunInterrupt`). That error proves auth, scope, command decoding and the dispatcher all work. A decode or unknown-command error means not ok, with its reason. If no terminal thread exists, stop at the 101 and say "not exercised".
  - Revoke the token, and say the result once at start.
  - Open question: whether a rejected command leaves any trace in `startup.enqueueCommand`.
- **Stop now on the Claude lane (`stop_now`):**
  - Available only while `t3_interrupt` is ok; otherwise the reason. Stop all then asks that lane to stop after its job.
  - Find the running job's thread the same way the runner already does: `Runner.find_thread`, by id, else by title and start time, because `start --wait` hasn't returned an id yet. The run id is `latest_run_id` from `t3 thread show`.
  - Record that this job is being stopped *before* sending. Then dispatch `{type: "run.interrupt", commandId: "queue-runner:stop-now:<runId>", threadId, runId, reason: "Stop now (queue runner)"}`. A stable `commandId` makes a retry replay instead of a second interrupt: the ws handler skips analytics on `result.replayed`, `ws.ts:2054`.
  - The blocked `start|send --wait` call then returns exit 1, `status: "interrupted"`. The runner sees its own stop mark and ends the job like a usage-limit stop with no reset: the branch stays, and Resume carries on in place (`t3 thread send`) or afresh by context size (`limits.py`).
  - Any other `interrupted` (Stefan pressing Stop in the app) stays as today.
- **Fallback:** if after ~30 s the run is still active and its `run_interrupt_request` item has `unresponsiveAt`, offer `orchestration.forceStopThread` (`{threadId, runId}`). Don't kill processes.
- **Tests:** a fake `dispatch` seam for the lane logic. A `tests/fixtures/t3/` pair of recorded frames (request and `Exit`) for the codec. The one live sandbox check exercises the real path.

## The live check

**Not run.** The only route open to a script needs a bearer token that `t3 auth session issue` mints, and minting it adds a row to T3's auth store under `~/.t3/userdata/`. The brief said not to run the check if the path needs a secret, and not to change files under `~/.t3/`. When the runner builds this, the allowed single check fits it well, if Stefan agrees to the token:

1. Start a small Haiku thread in "queue-runner sandbox" (`scripts/live_sandbox.py`'s project) with `t3 thread start --wait --json`.
2. Interrupt it from a second process with the sketch above.
3. Record the CLI's JSON and exit code, `thread show --json`'s status, the run's row in `orchestration_v2_projection_runs`, the worktree and branch, and whether `t3 thread send` continues it.
4. Revoke the session.

## Open questions

- **The exact Effect RPC frame details:** whether `headers` must be `[]` (array of pairs) or may be left out, whether `id` must be a decimal string, and whether a one-shot client must answer the server's `Ping` or send an `Ack`. Settle these with the live check, or by reading `effect@4.1.2` `dist/rpc/RpcMessage.js` and `RpcServer.js` in the bundle.
- **What `error` holds** in `--wait --json` after an interrupt (expected null).
- **Whether killing the SDK's process ends the run `failed`** (5): expected, not checked.
- **Whether a rejected probe dispatch** (startup check) is recorded anywhere, e.g. a command receipt for replay.
- **Whether T3 minds a short-lived bearer session per Stop now,** with possible lock contention while the server runs. `t3 thread` already mints and revokes one per command, so this is likely fine.
- **Drift:** the RPC is protocol 2 and private to T3's own clients ([earlier note](t3-extension-points.md), section 3). An update that bumps the protocol makes the startup check fail with 426, which is the visible signal to update the client.

## Primary-source references

[tag]: https://github.com/pingdotgg/t3code/tree/24e77473ecf41bc1f7142529c7911c1c1aae1d76
[rel-stable]: https://github.com/pingdotgg/t3code/releases/tag/v0.1.9
[rel-nightly]: https://github.com/pingdotgg/t3code/releases/tag/v0.1.10-nightly.20261116.4761
[ws-methods]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/packages/contracts/src/orchestrationV2.ts#L3618
[cmd-run-interrupt]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/packages/contracts/src/orchestrationV2.ts#L3269
[cmd-thread-stop]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/packages/contracts/src/orchestrationV2.ts#L2936
[mcp-interrupt-input]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/packages/contracts/src/orchestratorMcp.ts#L561-L573
[mcp-interrupt-result]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/packages/contracts/src/orchestratorMcp.ts#L576-L584
[orch-switch]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Orchestrator.ts#L13784-L13813
[orch-dri]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Orchestrator.ts#L11863
[orch-settle]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Orchestrator.ts#L11151
[orch-hold]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Orchestrator.ts#L11406
[orch-unresp]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Orchestrator.ts#L11552
[effect-worker]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/EffectWorker.ts#L154
[effect-worker-unresp]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/EffectWorker.ts#L199
[claude-interrupt]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1526
[claude-status]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L3959
[tms-interrupt]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/ThreadManagementService.ts#L1152
[tms-force]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/orchestration-v2/ThreadManagementService.ts#L1200
[mcp-tool]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/mcp/toolkits/orchestrator/tools.ts#L298
[mcp-impl]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/mcp/OrchestratorMcpService.ts#L3217
[mcp-caller]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/mcp/OrchestratorMcpService.ts#L1111-L1129
[modes]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/mcp/delegatedTaskModes.ts#L36
[rpc-scope]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/RpcAuthorization.ts#L42-L46
[ws-route]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/ws.ts#L3542
[ws-proto]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/ws.ts#L741
[ws-auth]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/ws.ts#L3559
[ws-dispatch]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/ws.ts#L2054
[ea-issue]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L1097
[ea-wsup]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L1262
[ea-cred]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L655
[ea-origin]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L788
[ea-mcp]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L1316
[ea-mcp-issue]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L1341
[ea-reject]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/auth/EnvironmentAuth.ts#L617
[cli-auth]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/cli/auth.ts#L169
[cli-wtt]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/cli/thread.ts#L206-L230
[cli-finish]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/cli/thread.ts#L478
[cli-ended]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/cli/thread.ts#L107
[cli-needs]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/cli/thread.ts#L100
[cli-thread-cmds]: https://github.com/pingdotgg/t3code/blob/v0.1.9/apps/server/src/cli/thread.ts#L768-L776
[cli-thread-nightly]: https://github.com/pingdotgg/t3code/blob/v0.1.10-nightly.20261116.4761/apps/server/src/cli/thread.ts#L953-L961
[acp-env]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/apps/server/src/mcp/AcpMcpStdioBridge.ts#L339-L342
[pr-23943]: https://github.com/pingdotgg/t3code/pull/23943
[disc-23945]: https://github.com/pingdotgg/t3code/discussions/23945
[issue-33851]: https://github.com/pingdotgg/t3code/issues/33851
[disc-33855]: https://github.com/pingdotgg/t3code/discussions/33855
[issue-37196]: https://github.com/pingdotgg/t3code/issues/37196
[pr-24299]: https://github.com/pingdotgg/t3code/pull/24299
[pr-33420]: https://github.com/pingdotgg/t3code/pull/33420
[pr-25695]: https://github.com/pingdotgg/t3code/pull/25695
[outside-agents]: https://github.com/pingdotgg/t3code/blob/24e77473ecf41bc1f7142529c7911c1c1aae1d76/docs/user/outside-agents.md
