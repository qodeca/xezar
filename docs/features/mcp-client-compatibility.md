# Local MCP client compatibility and event-driven leader integration

Research date: **2026-09-08**. Scope: Claude Code, Codex, OpenCode, and local-only Xezar MCP. This is documentation/source-of-interface verification, **not a runtime integration test**. No model turns, MCP servers, client configurations, or credentials were exercised. No dependencies were installed. The reference-process audit remains deferred.

Related requirements: [MCP](mcp-project-leader-requirements.md) and [built-in leader](builtin-project-leader-requirements.md). All three clients remain required for the initial release; the gaps below are implementation obligations, not waived scope.

## Evidence status and versions

- **Verified documentation:** an official page explicitly describes the interface; this does not certify a working Xezar integration.
- **Verified local CLI:** read-only `--version`/`--help` observations on this machine.
- **Proposed:** an engineering composition of documented interfaces that still needs implementation and tests.
- **Unverified:** no reviewed official source establishes the behavior; this is not proof that it is impossible.

Local versions: Claude Code **2.1.263**, Codex CLI **0.153.4**, OpenCode **1.18.29**. CLI help confirmed Claude prompt/stream/MCP options and Codex app-server/config/resume entry points. OpenCode's version was obtained; no startup was attempted. These are installed versions, not claims of latest versions or certified minimums. Official living documentation was retrieved on the research date. The explicitly versioned protocol references below are **MCP 2025-11-25**; negotiate actual supported versions during implementation rather than assuming every client implements that revision or its optional features.

## Client findings

| Client | Local transport and project setup — verified documentation | Event-to-model reaction | Leader instruction mechanism |
| --- | --- | --- | --- |
| Claude Code | stdio and HTTP MCP are documented. Project `.mcp.json` and local/project scopes exist; startup can use an explicit MCP configuration. Xezar's generated `.ai/xezar/` file still needs client setup and is not universally discovered. [MCP setup](https://code.claude.com/docs/en/mcp) | **Documented specialized path:** Channels pushes into a running session. This is not generic resource/list-change notification behavior. Channels is a research preview; current docs describe account/organization constraints; this report certifies no minimum version. [Channels](https://code.claude.com/docs/en/channels) | `--append-system-prompt` / file form adds role instructions; replacement flags have different semantics. Reapply on each new invocation/resume as needed, since flags are invocation-specific. [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Codex | stdio and Streamable HTTP; trusted project `.codex/config.toml`. Initialization `instructions` is server guidance, not a security boundary or guaranteed full leader-role channel. [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | **Unverified for a plain native MCP connection:** no reviewed page establishes automatic model wake on arbitrary server events. **Documented adapter surface:** app-server `turn/start` begins generation; `thread/resume` reopens history and `turn/steer` targets an active turn. [App Server](https://learn.chatgpt.com/docs/app-server) | `developer_instructions` injects extra session guidance; `model_instructions_file` replaces built-in instructions. Prefer additive leader guidance and explicitly test resume precedence. Do not invent a uniform `systemPrompt` API. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) |
| OpenCode | Local MCP uses `type: local` and a command; URL-based servers also exist. [MCP configuration](https://opencode.ai/docs/mcp-servers/) Project `opencode.json` is documented. [Project configuration](https://opencode.ai/docs/config/) | **Unverified for generic MCP notifications.** Documented server `POST /session/:id/prompt_async` accepts an asynchronous prompt, while `/event` exposes application events. These enable a proposed event adapter, not automatic MCP wake by themselves. [Server API](https://opencode.ai/docs/server/) | Custom agent `prompt` can reference a file, including project-relative configuration. [Agents](https://opencode.ai/docs/agents/) Server messages accept `system` and `agent`; confirm their interaction on resume in runtime tests. [Server API](https://opencode.ai/docs/server/) |

Claude Channels uses stdio, an experimental capability, and `notifications/claude/channel`. Custom channels need the documented development opt-in or permitted distribution/organization configuration during preview; ordinary installation is not proof of eligibility. The channel's `instructions` also guide the model. Therefore Channels is promising for native Claude reaction but not a universal production dependency without eligibility checks. [Channels reference](https://code.claude.com/docs/en/channels-reference)

OpenCode plugins expose lifecycle/event hooks and a client object. A local plugin can be investigated as the bridge from Xezar events to the selected session; the hook alone is not an Xezar event subscription. [Plugins](https://opencode.ai/docs/plugins/) The SDK exposes an application event stream; subscribing observes OpenCode, not arbitrary Xezar events. [SDK](https://opencode.ai/docs/sdk/) An adapter must explicitly subscribe to Xezar's project event feed and submit the resulting turn.

Claude's programmatic interface supports structured output and continuation/resume, providing another integration route for a Xezar-managed leader. [Programmatic usage](https://code.claude.com/docs/en/headless) It still needs an event controller; a completed print command is not an always-listening client. The existing Xezar runner adapters are useful implementation anchors, not evidence that the new event flow has already been tested.

### Optional MCP features are not a wakeup guarantee

Resource subscriptions are optional negotiated capabilities. Resource-update and list-change notifications carry protocol information; they do not prescribe an application's decision to run a model. Do not misuse tool-list changes or progress messages as task-completion prompts. [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)

MCP Tasks in the reviewed revision are experimental, support deferred results, and make status notifications optional. They cannot alone fulfill guaranteed Xezar delivery and proactive reaction. Initial support for Tasks and resource subscriptions in **each of the three installed clients remains unverified**; generic MCP tool support does not prove these capabilities. A short ordinary tool result acknowledging a Xezar operation ID plus a reliable event adapter is the recommended portable baseline. [Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)

## Recommended architecture — proposed mechanisms, agreed outcomes

**Recommend a local stdio MCP bridge for initial client setup**, backed by the running Xezar service over protected local IPC. All three document local process-based MCP, and Claude Channels specifically requires stdio. The bridge is a transport adapter, not another task store or business engine. Choose the IPC primitive, packaging, and startup discovery in design. Loopback Streamable HTTP remains a viable alternative for clients, but does not solve model wakeups. No remote exposure is part of version one.

A non-model controller maintains the logical project session, listens for significant Xezar events, queues/coalesces them, and dispatches to a client-specific reaction adapter. For the built-in leader, use the selected backend's programmatic session interface. For native clients, evaluate Claude Channels, an OpenCode plugin, and a supported Codex app-server integration. A native client/session that cannot be targeted through a supported interface remains a compatibility blocker; do not simulate keystrokes, secretly create a second leader, or substitute model polling.

The event controller and the backend's MCP bridge belong to **one logical client owner**, not two clients. Ownership is enforced by Xezar, not asserted by arbitrary model parameters. The built-in leader and an external native client cannot simultaneously own the same project. UI remains available concurrently. Different projects can have different owners.

Application events, tool responses, and transport notifications have distinct responsibilities:

1. A start mutation validates current state and returns acceptance plus an operation/task identifier promptly. Completion comes later; transport acceptance is not business completion.
2. Xezar records a significant event and updates open UI through its shared state/event mechanisms. An adapter delivers the event and separately schedules the model's reaction. Record delivery and reaction progress independently.
3. No new model turn is needed for heartbeat, transport retry, event acknowledgement, or deduplication. Log lines, token counters, and presentation changes do not wake the leader.
4. Model reaction uses the current state and approved goal/DoD. Reconnect delivers outstanding significant events and reconciles authoritative state. Paused/restarted-awaiting-resume built-in leaders accumulate events without automatic reasoning.

## Ownership, replay, conflicts, and idempotency

### One logical owner

An HTTP request ending or an SSE stream closing is not the end of a logical session. The MCP HTTP specification explicitly supports related requests, multiple streams, and session identifiers; expired HTTP session IDs require reinitialization. SSE replay is optional and stream-specific, not a complete cross-restart Xezar event journal. [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Use confirmed stdio/process/channel termination plus non-model liveness checks to release occupancy. Protocol `ping` can support liveness without generation. [Ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping) **Proposal:** atomic per-project owner acquisition, an expiring lease, and a fencing generation checked before mutations. Silence of the model is not failure. A client returning after expiry must establish a new session; stale generation cannot write even if the old process remains alive. Exact timeouts and renewal rules are not approved values.

MCP initialization and shutdown have protocol rules but no reviewed universal “project busy” error. [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) Define a protocol-compliant application error indicating occupied project, with no competing owner's private data; choose JSON-RPC/application error mapping and any HTTP status in design. Do not label a made-up code as standard. No manual disconnect control is being added to UI.

### Reliable events

**Proposal:** a project event journal with stable event IDs, resource version, origin, causal operation ID, and a replay cursor; use at-least-once delivery with adapter deduplication and state reconciliation. Order events per project or explicitly define ordering domains; handle completion arriving after a human cancellation/change. Persistent acknowledgement and replay retention must be designed, including a cursor-too-old response and current-state recovery. No retention duration is agreed. Native SSE cursor support cannot be assumed to supply all this.

Do not react recursively to the leader's own operation acknowledgements. Preserve causal origin so actual new outcomes remain actionable while echoes, duplicate delivery, and presentation updates do not trigger loops. Runtime tests must prove both delivery and a real subsequent model action; seeing a notification in logs is insufficient.

### Mandatory stale-write rejection and operation identity

Reject a leader mutation based on state changed by the human since its read. Return a clear conflict, require a fresh read, and let the leader decide again. A version/expected-revision mechanism is proposed; silent overwrite or automatic reconciliation of the stale mutation is not allowed.

Use a durable application operation/idempotency key, bound to project, action, and payload. JSON-RPC IDs correlate requests/responses and must not be assumed to provide persistent deduplication. [Base protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic) A retry returns the original result or current status without repeating effects; a deliberately new identical task uses a new operation identity. Persist the decision before external effects where possible. If a crash occurs after an external effect but before receipt storage, reconcile its outcome and return an explicit uncertain/in-progress status rather than repeat blindly. Collision, retention, restart, and external-system reconciliation need executable specifications.

## Material gaps and next engineering gates

- **Native proactive reaction across all three clients is not yet runtime-proven.** Codex and OpenCode need a validated adapter path; Claude's preview eligibility is a deployment constraint. Required-client scope is unchanged.
- **Choose adapter/distribution and local IPC**, then validate one owner across native and built-in use. Handover has no force-disconnect UI; design orderly shutdown/reconnect and busy feedback.
- **Role instruction delivery:** validate effective instruction text/version after startup and every resume for all three tools. Xezar supplies a base role; only the user may customize it per project. The leader cannot edit that instruction in MVP, including through file/settings tools. Prompt text is not enforcement.
- **Run a compatibility spike before claiming support:** tool call; project scope; second-client rejection; process crash/lease expiry/fencing; idle-but-live session; asynchronous completion causing a real model reaction; human event; replay/dedup; stale mutation; idempotent lost response; prompt persistence. Do not consume real user task permissions for these fixtures.
- **Quality and authority are settled product rules**, not open transport questions: all project UI functions, including deletion and existing merge/publication, are autonomous; UI confirmation clicks need not be duplicated. Shared settings are safe read-only, and quality gates/acceptance cannot be weakened. Keep plan/goal decisions separate.

No integration has been certified by this report. The documentation research establishes usable interfaces and a concrete adapter architecture, while identifying where implementation and real-client tests are still required. It does not resume the deferred reference-practice audit.

## Approved event-reaction delivery hierarchy

**Approved event-reaction delivery hierarchy:** (1) use native event mechanisms when the client demonstrably reacts to them; (2) otherwise deliver a message through the official programmatic session interface; (3) use terminal text input only as a last fallback after runtime evidence proves reliability. This ordering is approved; terminal feasibility is not proven. Every event identifies Xezar as its source and must never impersonate user instructions or approval. If correct project/session targeting, separation from approval prompts/shell/user typing/active turns, and duplicate prevention cannot be established, refuse terminal delivery and expose a recoverable blocker. Tests must include each of these hazards, reconnect/retry and a real subsequent model reaction. No model polling, second logical owner, or wider project scope is introduced.
