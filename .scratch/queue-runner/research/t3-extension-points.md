# T3 Code extension points and a queue-runner dashboard

Status: **done**. Researched 2026-11-10. Recommendation: **serve a standalone localhost dashboard from the runner; optionally view that same URL in T3's browser pane.** No shipped integration found promises the indefinite compatibility required by a literal zero-maintenance constraint.

## Scope and versions

Read the queue runner's [AGENTS.md](C:/Users/Anon/Code/Personal/queue-runner/AGENTS.md), its T3 adapter, job records, ticket parsing and pause controls. Inspected the installed app read-only and queried upstream source, releases, issues and PRs. No app updates, agent runs, token issuance or browser actions were performed.

- Installed app and CLI: **0.1.7**, app commit **322f6544dfad**. Local evidence: `C:/Users/Anon/AppData/Local/Programs/t3code/resources/app.asar/package.json:3` (version), `:5` (commit), and `C:/Users/Anon/.t3/bin/t3.cmd:1` (launcher). The launcher executes the app's bundled server CLI; `t3 --version` returned `t3 v0.1.7`.
- Latest non-prerelease returned by GitHub: **v0.1.8**, published 2026-11-09 22:46:42 UTC. Latest desktop nightly found: **v0.1.9-nightly.20261110.4452**, published 2026-11-10 02:59:35 UTC. [Stable release][release-stable], [nightly release][release-nightly].
- Upstream `main` inspected at **633438d54f17b99f73f1a09466ecbe4a6aa0d545**. Source links below use that immutable commit unless a release or installed version is explicitly named. Issue and PR states are as checked on the research date.

## 1. Supported extensions, plugins, custom panels and MCP Apps

**There is a documented MCP Apps integration, but I found no shipped general T3 UI extension SDK for adding an independent sidebar item, route or permanent panel.** This is a bounded finding from the current source tree, user docs and the proposals below, rather than a claim that extensibility can never ship.

The most relevant general plugin proposals are still proposals:

- [PR #33606][plugin-new], opened November 9, is **open and unmerged**. It proposes `@t3tools/plugin-sdk`, local `t3-plugin.json` packages, right panels, commands, styles, settings, server RPC and agent tools. Its author explicitly says maintainers have not approved the direction or scope. Its SDK and example documentation belong to that PR, not the inspected shipped tree.
- [PR #6158][plugin-old] proposed sidebar pages and command-palette entries using sandboxed iframes and Git-installed plugin sources. It is **closed without merging**. An older, broader host/SDK/marketplace proposal, [PR #3993][plugin-earlier], is also **closed without merging**. Searching an old PR's documentation can therefore produce a convincing-looking SDK that the app never shipped.
- [Discussion #6837][plugin-discussion] requests lifecycle hooks and declarative UI contributions. [RFC #6977][sdk-rfc] requests a local app SDK and custom project surfaces, and explicitly asks maintainers to identify public, stable entry points. These are requests, not compatibility commitments.

**MCP Apps are a real, narrower extension point.** An MCP server can expose a tool associated with a UI resource, and T3 renders the interactive result in the thread where the agent invoked it. The installed 0.1.7 source documents **Codex** support. The 0.1.8 docs document **Codex and Claude**, with Claude Code **2.1.301 or newer** required. Other providers fall back to ordinary tool results. [Installed-version documentation][apps-installed], [0.1.8 documentation][apps-stable].

This integration follows the MCP Apps standard and is documented as a feature, without an experimental label in that section. That is stronger evidence than an unmerged plugin PR, but it is not a T3 promise to preserve all host behavior indefinitely. Claude support was added by [merged PR #29803][apps-claude]; its implementation notes describe use of a private Claude SDK request method. That dependency is T3's responsibility, but it is another reason not to claim guaranteed future compatibility.

MCP/provider extensions and T3-owned panels are different surfaces: an inline MCP tool result does not grant an app permission to register a T3 sidebar item or custom route. The docs describe placement in a thread and optional full-screen display, not persistent application navigation. [MCP Apps behavior][apps-stable].

## 2. Localhost pages and MCP-provided UI inside T3

**A localhost dashboard can use T3's ordinary browser pane without modifying T3.** The user docs explicitly describe local ports opening as `http://localhost:<port>`, and allow a project script's **Preview URL** to specify HTTPS or a path. The URL contract itself names `localhost:5173` as valid input. On this Windows PC, the runner and desktop app share the same host, so `http://127.0.0.1:<dashboard-port>/` is the straightforward address. [Local-server documentation][browser-local], [URL contract][preview-url].

This is the best supported way to have the dashboard visually inside T3 today: open a normal web page in its browser panel. Keep its content, assets and controls served by the runner. It needs no plugin loader, custom React integration, patched ASAR archive or T3 database access. This recommendation is an inference from the documented browser capability.

**Update survival has two meanings:** the runner's page and HTTP interface can remain independent of T3 updates; a particular T3 tab, its placement and automatic restoration are T3 behavior. I found no guarantee that an arbitrary dashboard tab remains open and restored across every future update. The same URL should therefore remain usable in a normal browser even if T3's browser UI changes. T3 documents connection restarts during server updates. [Updating][updates].

For future remote use, verify which machine owns the browser: current docs describe environment-hosted tabs and localhost on that host, while [issue #27625][remote-loopback] records an older desktop behavior where a user-opened tab resolved localhost on the client. This ambiguity does not affect the present same-PC setup, but it rules out assuming every historical version forwards remote loopback ports.

**Do not confuse browser navigation with HTML visual replies.** T3's generated HTML preview documentation explicitly blocks private/reserved network destinations during previewing. A self-contained visual reply is not the documented way to display a runner's live localhost service. [Visual-reply restrictions][html-restrictions].

**An MCP App can also show a dashboard, but it adds lifecycle and interaction requirements:**

- An agent must first call the MCP tool so its UI appears in a thread.
- The app can remain visible after that agent stops, but using its tool-backed controls requires the creating thread's agent session to be running. The documented recovery is to send another message in that thread.
- Calls to tools that are not marked read-only require confirmation. Pause/resume changes state, so those controls should not be disguised as read-only calls.
- Full-screen display is supported, but attention requests can return the app to its thread; navigating away stops the app.

These are documented host behaviors, not hypothetical problems. They make MCP Apps a poor default for an always-available, AI-free runner control surface. [MCP Apps documentation][apps-stable].

## 3. CLI effort selection and server API

### CLI: still missing in the checked releases

The installed `t3 thread start --help` lists provider and model selection but no effort or generic model-option flag. Its bundled implementation sends only `instanceId` and `model` in the explicit `modelSelection`: `C:/Users/Anon/AppData/Local/Programs/t3code/resources/server.asar/apps/server/dist/binCli-CqQmsJvg.mjs:10843` (launch call), `:10848` (selection).

Neither **v0.1.8** nor **v0.1.9-nightly.20261110.4452** adds the flag: both still define the same flags and construct an explicit selection without options. This was checked in release-tagged code, not inferred from a missing changelog entry. [Stable CLI source][cli-stable], [nightly CLI source][cli-nightly].

There is direct upstream work on it:

- [Issue #29863][effort-issue]: **open**, requests effort selection on `start` and `send`.
- [PR #27189][effort-pr]: **open, unmerged**, adds `--effort` on both commands and validates against the model catalog.
- [PR #26887][effort-start-pr]: **open, unmerged**, adds `--effort` on `start`.
- [PR #23932][options-pr]: **open, unmerged**, proposes repeatable `--option id=value` on `start`.

An upgrade to the checked latest stable or nightly therefore does **not** resolve this CLI limitation. Do not rely on provider configuration as a guaranteed effort override: the issue documents T3 sending its own per-turn default. That observed behavior is consistent with the runner's own [AGENTS.md:519](C:/Users/Anon/Code/Personal/queue-runner/AGENTS.md:519).

### Server: supports options, with a narrower stability conclusion

**Yes, the server already accepts model options. No, I found no permanent external API compatibility promise.** There are two useful surfaces:

1. **Documented external MCP over HTTP at `/mcp`.** Outside clients can discover providers/models, launch threads and configure them. `t3_thread_launch` accepts `modelSelection`; `t3_thread_configure` accepts it on an existing thread. The shared selection schema includes an optional options array. [Outside-agent documentation][outside-agents], [launch tool][launch-tool], [configure tool][configure-tool], [selection schema][selection], [option schema][option-schema]. For example, the model-selection portion can be:

   ```json
   {
     "instanceId": "codex",
     "model": "gpt-6.1-sol",
     "options": [{"id": "reasoningEffort", "value": "high"}]
   }
   ```

   This is a selection object, not a complete HTTP request. Use the actual provider instance and model catalog. Codex uses `reasoningEffort`; Claude uses `effort`; supported levels vary by model, as the effort PR's catalog lookup explains. [PR #27189][effort-pr].

   This surface is usable by software without AI; Python is not inherently excluded. External MCP clients use OAuth, and T3's user docs say sign-in lasts **30 days**, followed by approval again. That is a poor fit for a hard no-intervention requirement. OAuth MCP credentials are also expressly restricted to `/mcp` and rejected by ordinary HTTP/WS RPC routes. [Sign-in lifecycle][outside-agents], [auth audience rules][auth].

2. **The app's typed WebSocket RPC.** Its RPC contract exposes `orchestration.launchThread` and command dispatch; launch input takes `ModelSelection`, and `thread.model-selection.set` changes it. [launch RPC][rpc], [command dispatch][rpc-dispatch], [launch schema][orchestration], [selection-change command][selection-command]. Authentication includes scoped sessions and WebSocket tickets; the installed CLI also exposes `t3 auth session issue` for headless clients. I inspected its help without issuing a token. [Auth implementation][auth-cli], [auth architecture][auth].

   This protocol is **versioned**, currently orchestration protocol **2**, and advertises capabilities for mixed-version clients. It is not an undocumented, entirely unversioned socket. However, incompatible clients receive HTTP **426** and an instruction to update; T3's docs expressly require matching orchestration protocols. The contracts and client-runtime packages are **private**, rather than a published stable third-party SDK. [Protocol descriptor][protocol], [server compatibility check][ws], [update compatibility][update-compat], [contracts package][contracts-package], [client-runtime package][runtime-package].

The architecture docs call RPC the boundary between independently versioned clients and servers, and tell clients to use capability negotiation. That is meaningful compatibility engineering; it does not establish indefinite support for a separately frozen Python client. [Architecture][architecture], [remote compatibility guidance][remote-architecture]. Avoid scraping auth databases, importing hashed bundles or copying the app's current socket implementation to bypass the missing CLI flag under a zero-maintenance requirement.

## 4. Dashboard recommendation under the hard constraint

**Build the dashboard as a runner-owned localhost page, with T3's browser pane as an optional viewer.** This recommendation concerns architecture only; nothing was implemented by this research.

- Serve a small HTML/CSS/JavaScript page and a runner-owned status endpoint from Python. Keep assets local and use simple polling. This can remain independent of T3's UI framework, ASAR layout, authentication and protocol versions.
- Make the runner supply the facts it already knows: current job and lane, queued/blocked tickets and blocker edges, usage wait/pause state, recent outcomes and items needing Stefan. Reuse its job records and ticket parsing. [JobLog](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/state.py:136), [ticket blockers](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/tickets.py:56), [ticket selection](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/tickets.py:113).
- Have pause/resume call the runner's existing control logic. Label the semantics accurately: current pause prevents **new Claude jobs**; the running job and Sol lane continue. The current CLI already states this, and the gate update uses atomic replacement. [Pause control](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/cli.py:83), [gate writer](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/gate.py:131).
- Link attention items to the relevant PR, issue or stored T3 thread link. A PR requiring Stefan's merge can open its forge page for that action. Keep merge eligibility in the runner so the dashboard does not introduce a second policy implementation. The runner already has merge guards and stop handling. [Merge rules](C:/Users/Anon/Code/Personal/queue-runner/AGENTS.md:393), [attention/stop records](C:/Users/Anon/Code/Personal/queue-runner/AGENTS.md:471).

An MCP App is reasonable only if embedding inside a thread matters more than immediate availability and session-free controls. A custom T3 plugin should wait for an actually merged, documented SDK and an explicit compatibility policy. Adopting #33606 today would mean maintaining a fork or an unreleased integration, directly conflicting with Stefan's constraint.

**Limit of the recommendation:** no research can guarantee that every dependency will work forever. This design removes *new T3-specific dashboard maintenance*. It cannot make the entire runner maintenance-free: its existing limit recovery reads T3's private SQLite projections and Claude transcripts, and its CLI adapter parses T3 JSON. Those existing dependencies should remain outside the dashboard and degrade independently. [Existing private-data dependency](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/limits.py:1), [CLI adapter](C:/Users/Anon/Code/Personal/queue-runner/queue_runner/t3.py:1). A literal end-to-end zero-maintenance guarantee is not supported by the evidence.

## What could not be checked

- Future compatibility, maintainer intent beyond published statements, and whether pending PRs will merge. All issue/PR states can change after this report.
- A real dashboard surviving an installed-app update or restarting with its tab restored. No app update or live browser/session experiment was performed; browser support is established from official docs/source.
- End-to-end MCP OAuth, effort-setting launches, or a custom MCP App on this PC. No credentials were read or minted, settings changed, or AI threads started. Installed bundled CLI code and upstream schemas establish the current interfaces, not a new live integration test.
- An exhaustive proof that no undocumented mod mechanism exists. The conclusion is about a shipped, supported general UI extension system in the inspected source/docs, with the known proposals checked explicitly.

Only this Markdown file was created. No commits were made.

## Primary-source references

[release-stable]: https://github.com/pingdotgg/t3code/releases/tag/v0.1.8
[release-nightly]: https://github.com/pingdotgg/t3code/releases/tag/v0.1.9-nightly.20261110.4452
[plugin-new]: https://github.com/pingdotgg/t3code/pull/33606
[plugin-old]: https://github.com/pingdotgg/t3code/pull/6158
[plugin-earlier]: https://github.com/pingdotgg/t3code/pull/3993
[plugin-discussion]: https://github.com/pingdotgg/t3code/discussions/6837
[sdk-rfc]: https://github.com/pingdotgg/t3code/discussions/6977
[apps-installed]: https://github.com/pingdotgg/t3code/blob/322f6544dfad/docs/user/html-renders.md#L11-L17
[apps-stable]: https://github.com/pingdotgg/t3code/blob/v0.1.8/docs/user/html-renders.md#L13-L19
[apps-claude]: https://github.com/pingdotgg/t3code/pull/29803
[browser-local]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/user/remote-access.md#L239-L272
[preview-url]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/preview.ts#L379
[remote-loopback]: https://github.com/pingdotgg/t3code/issues/27625
[html-restrictions]: https://github.com/pingdotgg/t3code/blob/v0.1.8/docs/user/html-renders.md#L1-L11
[updates]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/user/updating.md#L62-L85
[cli-stable]: https://github.com/pingdotgg/t3code/blob/v0.1.8/apps/server/src/cli/thread.ts#L600-L664
[cli-nightly]: https://github.com/pingdotgg/t3code/blob/v0.1.9-nightly.20261110.4452/apps/server/src/cli/thread.ts#L600-L664
[effort-issue]: https://github.com/pingdotgg/t3code/issues/29863
[effort-pr]: https://github.com/pingdotgg/t3code/pull/27189
[effort-start-pr]: https://github.com/pingdotgg/t3code/pull/26887
[options-pr]: https://github.com/pingdotgg/t3code/pull/23932
[outside-agents]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/user/outside-agents.md
[launch-tool]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/apps/server/src/mcp/toolkits/project/tools.ts#L124-L163
[configure-tool]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/apps/server/src/mcp/toolkits/thread/tools.ts#L147-L163
[selection]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/modelSelection.ts#L9-L13
[option-schema]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/model.ts#L48-L73
[rpc]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/rpc.ts#L1908-L1911
[rpc-dispatch]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/rpc.ts#L1772-L1775
[selection-command]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/orchestrationV2.ts#L3169-L3174
[orchestration]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/orchestrationV2.ts#L3686-L3695
[auth]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/internals/environment-auth.md#L42-L86
[auth-cli]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/apps/server/src/cli/auth.ts#L169-L186
[protocol]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/src/environment.ts#L13-L21
[ws]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/apps/server/src/ws.ts#L3541-L3552
[update-compat]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/user/updating.md#L87-L96
[contracts-package]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/contracts/package.json#L1-L13
[runtime-package]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/packages/client-runtime/package.json#L1-L8
[architecture]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/internals/overview.md#L16-L19
[remote-architecture]: https://github.com/pingdotgg/t3code/blob/633438d54f17b99f73f1a09466ecbe4a6aa0d545/docs/internals/remote.md#L170-L174
