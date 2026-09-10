# MCP client behaviour spike – runtime report

Issue: [#85](https://github.com/qodeca/xezar/issues/85), Phase 2 of [epic #67](https://github.com/qodeca/xezar/issues/67). Covers D-01, D-05, F-17, F-20, F-21, A-19 and A-23 of the [requirements](mcp-project-leader-requirements.md). Technical appendix to the [client compatibility report](mcp-client-compatibility.md).

Run date: **2026-09-10**, 21:36–21:54 UTC. Repository base: `057ea48`. This is a spike: it records a decision and its evidence and ships no production code. The throwaway server, model endpoint and drivers used here were never committed.

## Answer first

- **All three clients called a tool** on a local stdio MCP server on this machine (Claude Code, Codex, OpenCode).
- **No client started a model turn from an MCP server notification.** The spike server sent four kinds of notification after an asynchronous completion. None of the three clients reacted. Claude Code Channels did not register under the fixture rules.
- **Every client started a model turn when the event came through its official programmatic session interface:** Claude Code `-p --input-format stream-json` (stdin), Codex app-server `turn/start`, OpenCode `POST /session/:id/prompt_async`.
- So step 1 of the approved delivery hierarchy (native mechanism) is **not demonstrated for any client**, and step 2 (programmatic session interface) **works for all three**, but only for a session the adapter itself started. A session the user opened in their own terminal stays an **open blocker** for each client (see [Open blockers](#open-blockers)).
- **Tally, 13 rows × 3 clients:** Claude Code 8 PASS, 1 FAIL, 4 NOT ATTEMPTED. Codex 8 PASS, 1 FAIL, 4 NOT ATTEMPTED. OpenCode 7 PASS, 2 FAIL, 4 NOT ATTEMPTED.
- **This is not A-19 or A-23 evidence.** A scripted model endpoint stood in for a real model, the revision is not a release candidate, and no xezar MCP server exists yet. Server-side behaviours (leases, fencing, replay, human events) could not be run end to end.

## How to read this report

**Evidence labels.** Every statement is one of: *executed and observed* (a run in this spike, with a transcript ID), *read from official documentation* (with the page and date), or *not attempted* (with the reason). "Should work" is not used.

**Agreement status.** The requirements document's three-way split is kept. *Agreed* outcomes (for example the delivery hierarchy, all three clients required, no model polling) are fixed and are not reopened here. *Engineering decision (this spike)* marks a choice made under the authority in requirements § 12 ("Engineering may choose transport/IPC, schemas, storage, version/lease values and packaging…"); each one names the experiment behind it. *Open* marks what has no decision.

**Model reaction, as measured here.** A client "reacted" when **the client itself sent a new inference request that carried the event** to the model endpoint, and that request arrived. Every run used a scripted local endpoint in place of a real model, because the fixture rules forbid personal accounts and secrets. This proves the client-side mechanism (a real turn was started); it does not prove what a real model would decide. A real-model run on the release-candidate revision is still required for A-19.

**Client-level slice.** Most rows name a guarantee that lives in the xezar server (ownership, leases, journal, stale-write check). No xezar MCP server exists yet: a search of `packages/` for `modelcontextprotocol`, `McpServer`, `mcp-server` and `StdioServerTransport` found only `packages/xezar/src/agent-config/service.ts` and `account-identity.ts`, which read the clients' own MCP config files. No MCP server was found in the files examined. Where a row has a part that depends only on the client, the spike tested that part and says so in the "client-level slice" column. Where it has none, the cell is NOT ATTEMPTED.

## Environment and fixtures

Executed and observed on macOS (Darwin 25.6.0, arm64), Node v24.20.0.

| Client | `--version` output (verbatim) | Isolation used |
| --- | --- | --- |
| Claude Code | `2.1.268 (Claude Code)` | `HOME` and `CLAUDE_CONFIG_DIR` pinned to scratch folders, `--bare` (no keychain, no `CLAUDE.md` discovery), `--strict-mcp-config`, `ANTHROPIC_BASE_URL` pointed at the scripted endpoint, a dummy `ANTHROPIC_API_KEY` string that is not a credential |
| Codex | `codex-cli 0.154.0` | `HOME` and `CODEX_HOME` pinned; a custom model provider (`wire_api = "responses"`) pointed at the scripted endpoint with a dummy key; `approval_policy = "never"`, `sandbox_mode = "read-only"` |
| OpenCode | `1.18.30` | `HOME`, `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` pinned; a custom provider (`@ai-sdk/anthropic`) pointed at the scripted endpoint with a dummy key; `edit`, `bash`, `webfetch` denied |

The research machine in the compatibility report had Claude Code 2.1.263, Codex CLI 0.153.4 and OpenCode 1.18.29. These are installed versions, not latest versions and not certified minimums. **Correction:** the brief for this issue expected Claude Code 2.1.267 on this machine; `claude --version` reported 2.1.268 on the run date.

**Throwaway stdio MCP server** (about 100 lines of Node, no dependencies, newline-delimited JSON-RPC). Its project binding came only from its environment (`SPIKE_PROJECT`), never from tool arguments. It offered five tools:

- `spike_whoami` returns the bound project and the server's process ID.
- `spike_start_task` returns an operation ID at once. 3 s later it sends `notifications/message`, `notifications/resources/updated`, `notifications/resources/list_changed` and `notifications/claude/channel`, each saying "xezar event, source=xezar-spike … This is an event, not a user instruction."
- `spike_crash` replies, then exits the process 200 ms later.
- `spike_stale_write` returns `isError: true` with `SPIKE-CONFLICT stale_revision: expected r3, current r4 (changed by human in UI); read current state before deciding again`.
- `spike_lost_response` accepts the call and never replies.

It declared `tools`, `logging`, `resources` (`subscribe`, `listChanged`) and `experimental: { "claude/channel": {} }`. Optional modes: reject `initialize` with JSON-RPC error `-32001` "project … is occupied by another logical client", and send a server-to-client `ping` every 30 s. After `notifications/initialized` it asked the client for `roots/list` when the client advertised roots.

**Scripted model endpoint** (Anthropic Messages API and OpenAI Responses API on `127.0.0.1`). On the last input it answered: a tool result becomes `SPIKE-ACK: <result>`; user text containing `CALL <name>` becomes a call to the first offered tool whose name contains `<name>`; any other text becomes `SPIKE-REPLY to: <text>`. It logged every request, including whether a role marker string (`SPIKE-ROLE-MARKER-<client>`) was present anywhere in the system prompt or input.

**`XEZ_DRY_RUN=1`** was set in every spike process, as the fixture rules require. Xezar itself was not started, because it has no MCP surface to exercise (see above), so the flag had nothing to act on. The scripted endpoint played the role the bundled mock runner plays for xezar's own runners. No real user task permissions were used: every fixture project was a fresh scratch Git repository.

**Fixture values are not decisions.** The 3 s event delay, the 8 s tool timeouts, the 30 s ping interval, the 300 s idle window and the 15–21 s wake windows were chosen only to make the runs short. None of them is proposed as a xezar value.

### Incident: one run reached a personal account

Executed and observed. The first Codex run went through a personal wrapper script earlier on `PATH` (`~/.codex-cli/bin/codex`). That wrapper forces `CODEX_HOME` to the user's personal Codex home, so it overrode the spike's isolated `CODEX_HOME`. **One real model turn ran on the personal Codex configuration** (about 49 k input tokens, 121 output tokens; prompt "CALL spike_whoami"; the spike MCP server was not attached). Its output is not used as evidence anywhere in this report. Every later Codex run called the package binary directly, and the app-server `initialize` response was checked to report the isolated `codexHome`. Lesson for future fixtures: resolve each client binary and confirm its effective home before the first run; setting the vendor home variable is not enough when a wrapper sits on `PATH`.

## Results

Behaviour rows are taken verbatim from the issue body. **Count note:** the issue title says "twelve", but its body lists eleven semicolon-separated items, one of which ("process crash, lease expiry and fencing") names three behaviours. This report gives every named behaviour its own row, so it has 13 rows. No behaviour was dropped.

| Behaviour | Client-level slice this spike could exercise | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- | --- |
| tool call | The model calls a tool on a local stdio MCP server; the result reaches the model. | **PASS** – `mcp__spike__spike_whoami` called, result returned to the model (T01). | **PASS** – `spike_whoami` called in namespace `mcp__spike` (T02). Needed `default_tools_approval_mode = "approve"`; without it the call failed (T02a). | **PASS** – `spike_spike_whoami` called (T03). |
| project scope | The project binding reaches the bridge from per-project client configuration, not from the model; the client reports its workspace. Server-side isolation (F-01, F-02, A-02–A-04) not exercised: no xezar MCP server. | **PASS** – binding from `--mcp-config`; `roots/list` answered with the fixture project folder (T14). Project `.mcp.json` not tested. | **PASS** – a trusted project `.codex/config.toml` overrode the global server of the same name and bound it to project D (T14). Codex did not advertise `roots`; it sent the workspace path in `tools/call` `_meta`. | **PASS** – binding from project `opencode.json`; `roots/list` answered with the fixture project folder (T14). |
| second-client rejection | The bridge rejects `initialize` with an occupied-project error; the client does not use the server and exposes the error text to an adapter. The ownership decision itself is xezar's and was not exercised. | **PASS** – server marked `failed`; debug log holds the code and text; the model got no spike tools (T08). | **PASS** – app-server `mcpServer/startupStatus/updated` carried `failed` and the full error text (T08). `codex exec --json` showed nothing. | **PASS** – `GET /mcp` returned `failed` with the full error text (T08). `opencode run` output showed nothing. |
| process crash | The bridge process dies mid-session; what the client does next. | **PASS** – closure detected; the next tool call started a fresh server process and succeeded (T09). | **FAIL** – after the crash every call failed: `tool call failed for spike/spike_whoami … Transport closed`; no restart within 6 s (T09). | **FAIL** – after the crash the spike tools disappeared from the model's tool list with no message; no restart within 6 s (T09). |
| lease expiry | None. A lease is xezar server state. | **NOT ATTEMPTED** – needs the xezar owner registry and lease; no MCP server found in the files examined. | **NOT ATTEMPTED** – same reason. | **NOT ATTEMPTED** – same reason. |
| fencing | None. The owner-generation check before a mutation is xezar server logic. | **NOT ATTEMPTED** – needs the xezar owner generation; no MCP server found in the files examined. | **NOT ATTEMPTED** – same reason. | **NOT ATTEMPTED** – same reason. |
| idle-but-live session | The session stays idle for 300 s: the bridge stays connected, answers server pings without model turns, and serves the next call from the same process. | **PASS** – 10 of 10 pings answered; same process before and after; no model request during idle (T12). | **PASS** – 10 of 10 pings answered; same process; no model request during idle (T12). | **PASS** – 10 of 10 pings answered; same process; no model request during idle (T12). |
| asynchronous completion causing a real model reaction | After `spike_start_task` returns, the completion event arrives later; does a model turn start? Measured as defined in [How to read this report](#how-to-read-this-report). | **PASS** – through the step-2 adapter: an event message on stdin started a turn that carried the event (T04). Native: the four notifications started no turn, and Channels did not register (T04, T05). | **PASS** – through the step-2 adapter: app-server `turn/start` started a turn that carried the event (T06). Native: no `turn/started` in the 12 s after the notifications (T06). | **PASS** – through the step-2 adapter: `prompt_async` started a turn that carried the event (T07). Native: no model request in the 12 s after the notifications (T07). |
| human event | None beyond the previous row. The event source (a human change in the UI) and echo suppression (A-20) are xezar logic. | **NOT ATTEMPTED** – no xezar event source or project event journal found in the files examined. Delivery would use the same adapter as the previous row. | **NOT ATTEMPTED** – same reason. | **NOT ATTEMPTED** – same reason. |
| replay and dedup | None. The event journal, cursor and deduplication are xezar server state. | **NOT ATTEMPTED** – needs the xezar event journal; none found in the files examined. | **NOT ATTEMPTED** – same reason. | **NOT ATTEMPTED** – same reason. |
| stale mutation | A conflict returned by the bridge reaches the model as an error. The stale-write check itself is xezar's and was not exercised. | **PASS** – `is_error: true`, conflict text intact in the model input (T10). | **PASS** – tool item `failed`, conflict text intact in the model input (T10). | **PASS** – conflict text intact in the model input (T10). |
| idempotent lost response | A tool call whose reply never arrives: the client times out, reports it, and does not silently retry. Same-key retry semantics are xezar's and were not exercised. | **PASS** – timed out after 8 s (`MCP_TOOL_TIMEOUT=8000`), sent `notifications/cancelled`, one `tools/call` only (T11). | **PASS** – timed out after 8 s (`tool_timeout_sec = 8`), one `tools/call` only, no cancellation sent (T11). | **PASS** – timed out after 60 s with no timeout configured, sent `notifications/cancelled` twice, one `tools/call` only (T11). |
| prompt persistence | The role instruction is still in effect after the session resumes. | **FAIL** – after `--resume` without `--append-system-prompt` the role marker was gone; with the flag re-supplied it was present (T13). | **PASS** – `developer_instructions` from config was present after `thread/resume` in a new app-server process (T13). | **FAIL** – `opencode run --session` without `--agent` lost the role marker; re-sending `agent` with every server-API message kept it (T13). |

### Reaction paths by the approved hierarchy

The hierarchy is *Agreed* and is not reordered here: (1) native event mechanism when the client demonstrably reacts, (2) the official programmatic session interface, (3) terminal text input only after runtime evidence proves it reliable.

| Path | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| 1a. Generic MCP notifications (`notifications/message`, `resources/updated`, `resources/list_changed`) | FAIL – no turn in the 16.5 s after the notifications (T04) | FAIL – no turn in the 12 s after the notifications; no `mcpServer/event/stream/notification` reached the app-server client (T06) | FAIL – no model request in the 12 s after the notifications (T07) |
| 1b. Claude Code Channels (`notifications/claude/channel` with `--dangerously-load-development-channels server:spike`) | FAIL – channel did not register; no turn (T05) | not applicable | not applicable |
| 2. Official programmatic session interface | PASS – `-p --input-format stream-json` stdin (T04) | PASS – app-server `turn/start` (T06) | PASS – `POST /session/:id/prompt_async` (T07) |
| 3. Terminal text input | NOT ATTEMPTED – refused: step 2 works, and simulated keystrokes are prohibited | NOT ATTEMPTED – same | NOT ATTEMPTED – same |

No client sent `resources/subscribe`, even though the server advertised `subscribe: true` (all MCP logs, executed and observed). No model polling was used anywhere.

## Decisions

Each item is an *engineering decision (this spike)* under requirements § 12, recorded in this report and feeding D-01 and D-05. None of them changes an *Agreed* outcome.

1. **Initial client transport: a local stdio bridge.** Evidence: all three clients connected over stdio and called tools (T01–T03), kept the bridge alive while idle (T12), and answered server pings (T12). This confirms the compatibility report's recommendation with runtime evidence. The IPC between bridge and xezar service stays *Open*.
2. **Event reaction route: step 2 for every client, for sessions the adapter starts.** Claude Code: a `-p --input-format stream-json --output-format stream-json` session whose stdin the adapter owns. Codex: an app-server connection that calls `turn/start` on the thread. OpenCode: `POST /session/:id/prompt_async` on an `opencode serve` instance. Evidence: T04, T06, T07. Step 1 is not adopted for any client, because no native reaction was demonstrated (T04–T07). Step 3 is refused.
3. **Ownership is decided behind the bridge, in the xezar service.** Every client session spawned its own bridge process, and Claude Code's recovery after a crash spawned yet another (T09, T12). A check inside one bridge process cannot see a second client. This is what F-18 already requires; the spike shows why the bridge cannot hold that state.
4. **The adapter re-supplies the role instruction on every invocation or message.** Claude Code: `--append-system-prompt` on every run, including resume. OpenCode: `agent` on every message. Codex: `developer_instructions` in the configuration it starts with. Evidence: T13. Prompt text is still not enforcement (requirements § 5).
5. **The bridge treats `notifications/cancelled` as advisory, never as an undo.** OpenCode sent it for calls that had already returned a result (T07, T10). A cancellation must not reverse an accepted operation; the operation's own status stays authoritative (N-10).
6. **Tool calls return acceptance, not completion.** The only client default timeout measured was OpenCode's 60 s (T11); the others were set to 8 s for the fixture. No bridge timeout value is decided here, and none should be invented from these fixture numbers. F-20's accept-then-event contract already keeps tool calls short.
7. **The occupied-project error needs its own path to the model.** In all three clients the rejection was visible to an adapter or operator, but the model only saw that the tools were missing (T08). If the leader must know why, the adapter has to tell it. How it does so stays *Open*.

## Open blockers

Each blocker keeps the client in scope. None is solved by model polling.

| ID | Client | Blocker | Adapter or client extension that would close it | Evidence status |
| --- | --- | --- | --- | --- |
| OB-1 | Claude Code | No native reaction in a session the user opened themselves. | **Claude Code Channels** (`notifications/claude/channel`, opted in with `--channels`, or the development flag for a custom channel). Under the fixture rules it did not register: GrowthBook was off ("a third-party provider, or telemetry opted out"), and the session notice read `flag=false(disabled)` (T05). Establishing eligibility needs a run with an eligible account, which the fixture rules exclude. Alternative for sessions xezar starts: the stream-json adapter (T04). `claude --bg` with `claude attach` might let a user view an adapter-owned session, but that is untested. | Channels requirements read from [Channels](https://code.claude.com/docs/en/channels) on 2026-09-10: they need claude.ai or Console API-key authentication, Team and Enterprise organizations must enable them, and `-p` mode is supported. No minimum version is certified. |
| OB-2 | Codex | No native reaction in an interactive `codex` session. | An app-server integration against the session's own app-server. Candidates: the shared local app-server daemon (`codex app-server daemon`) and `codex queue --thread <id> --message <text>` ("Queue a message for an existing session", read from `--help`). Only an app-server process started by the adapter was proven (T06). | Help text read; untested. |
| OB-3 | OpenCode | No native reaction in an interactive OpenCode TUI session. | The adapter drives the same `opencode serve` instance the user attaches to with `opencode attach <url>` (read from `--help`), using `prompt_async`; or a local plugin bridge that subscribes to xezar's project event feed ([Plugins](https://opencode.ai/docs/plugins/)). Only a server started by the adapter was proven (T07). | Help text and documentation read; untested. |
| OB-4 | Codex, OpenCode | No recovery after the bridge process crashes (T09). | The adapter watches bridge health and restarts the client session: for Codex a new app-server plus `thread/resume` (continuation proven in T13); for OpenCode a reconnect through its server API (unverified). A crash-resistant thin bridge lowers the risk. | Codex resume observed; OpenCode reconnect untested. |
| OB-5 | All three | No real-model reaction evidence (A-19). | A run with a real model account on the release-candidate revision, under a separate decision about which account may be used. | Not attempted: fixture rules forbid personal accounts. |

## Corrections and observations against earlier documents

- **Versions:** see [Environment and fixtures](#environment-and-fixtures). Claude Code on this machine was 2.1.268, not 2.1.267.
- **Resource subscriptions** (compatibility report: "unverified"): in these runs no client subscribed, although the server offered it. That is observed behaviour, not proof that subscription is impossible.
- **Protocol versions negotiated** (executed and observed): Claude Code and OpenCode sent `2025-11-25`; Codex sent `2025-06-18`. The compatibility report's advice to negotiate rather than assume one revision holds.
- **Codex tool approval** (not in the compatibility report): with `approval_policy = "never"`, an MCP tool call fails with "MCP tool call requires approval, but approval policy is never" unless `mcp_servers.<id>.default_tools_approval_mode` (or a per-tool `approval_mode`) is set ([Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), read 2026-09-10; T02a).
- **Codex tool shape:** Codex sends a server's MCP tools to the model as one `namespace` tool named `mcp__<server>`, and the model's call carries `namespace` plus the bare tool name (T02).
- **Client-supplied context is not a trust source:** Codex put the workspace path and Git commit in `tools/call` `_meta` (`x-codex-turn-metadata`); Claude Code and OpenCode answered `roots/list`. Both are useful hints, but under F-01 and N-09 the binding must come from the trusted connection, never from these fields.

## Transcripts

Excerpts from the local logs, trimmed only for length. `$SPIKE` stands for the scratch folder.

**T01 – Claude Code tool call** (`claude --bare -p "CALL spike_whoami" --mcp-config … --strict-mcp-config --allowedTools mcp__spike__spike_whoami`)

```text
assistant  [{"type":"tool_use","id":"toolu_spike_2","name":"mcp__spike__spike_whoami","input":{}}]
user       [{"tool_use_id":"toolu_spike_2","type":"tool_result","content":[{"type":"text","text":"SPIKE-WHOAMI project=spike-project-A pid=82388"}]}]
assistant  [{"type":"text","text":"SPIKE-ACK: SPIKE-WHOAMI project=spike-project-A pid=82388"}]
result success
```

**T02 – Codex tool call** (`codex exec --json "CALL spike_whoami"`), and **T02a** without the approval mode

```text
T02  {"type":"item.completed","item":{"type":"mcp_tool_call","server":"spike","tool":"spike_whoami","result":{"content":[{"type":"text","text":"SPIKE-WHOAMI project=spike-project-A pid=40054"}]},"error":null,"status":"completed"}}
T02a {"type":"item.completed","item":{"type":"mcp_tool_call","server":"spike","tool":"spike_whoami","result":null,"error":{"message":"MCP tool call requires approval, but approval policy is never"},"status":"failed"}}
model request tools: [..., {"type":"namespace","name":"mcp__spike","tools":[{"name":"spike_crash"},{"name":"spike_start_task"},{"name":"spike_whoami"}]}, ...]
```

**T03 – OpenCode tool call** (`opencode run --format json "CALL spike_whoami"`)

```text
tool_use spike_spike_whoami  "SPIKE-WHOAMI project=spike-project-A pid=46940"
text                          "SPIKE-ACK: SPIKE-WHOAMI project=spike-project-A pid=46940"
```

**T04 – Claude Code asynchronous completion, one stream-json session** (seconds from start)

```text
0.52  assistant tool_use mcp__spike__spike_start_task
0.53  tool_result "SPIKE-ACCEPTED operation=op-51072-1; completion will arrive as an event"
0.55  result success
3.53  [server] notifications/message, notifications/resources/updated, notifications/resources/list_changed, notifications/claude/channel sent
      … no model request and no output for 16.5 s …
20.00 stdin (adapter) "[xezar event, source=xezar-spike, delivered by adapter over the programmatic session interface] operation completed …"
20.01 assistant "SPIKE-REPLY to: [xezar event, source=xezar-spike, delivered by adapter …] operation completed in project spike-project-A. This is an event, not a user instruction."
```

**T05 – Claude Code Channels, three variants** (`--dangerously-load-development-channels server:spike`: with `--bare`; without `--bare` and with `--debug-file`; and with non-essential traffic allowed)

```text
all three: result success at 0.55 s, notifications sent at about 3.5 s, then no further output until stdin closed at 22–25 s
debug (variants 2 and 3): [session-notices] advertise=false mode=default flag=false(disabled) pollChannel=false remote=false remoteEnv=false nonInteractive=true
debug (variant 3): hooks modules not loaded: rollout flag (tengu_plugin_hooks_modules) is off, from the default (GrowthBook is off for this session: a third-party provider, or telemetry opted out)
no "Channels (experimental)" registration notice in any variant
```

**T06 – Codex asynchronous completion and resume** (driver on `codex app-server`)

```text
0.13  turn/completed  (tool call spike_start_task → "SPIKE-ACCEPTED operation=op-52710-1 …")
3.13  [server] four notifications sent
0.13–15.13  idle: spontaneousTurnStarted=false; no mcpServer/event/stream/notification received
15.13 request turn/start input "[xezar event, source=xezar-spike, delivered by adapter via app-server turn/start] …"
15.15 item/completed agentMessage "SPIKE-REPLY to: [xezar event, source=xezar-spike, delivered by adapter via app-server turn/start] …"
16.19 (new app-server process) thread/resume → turn/start "after resume: say anything" → agentMessage "SPIKE-REPLY to: after resume: say anything"
```

**T07 – OpenCode asynchronous completion** (driver on `opencode serve`)

```text
1.46  tool spike_spike_start_task completed "SPIKE-ACCEPTED operation=op-21078-1 …"
1.5   [server log] notifications/cancelled for request id 2, which had already returned its result
1.59  session.idle
4.5   [server] four notifications sent
1.59–16.60 no model request
16.60 POST /session/…/prompt_async → 204; session.status busy
16.65 text "SPIKE-REPLY to: [xezar event, source=xezar-spike, delivered by adapter via prompt_async] …"; session.idle
```

**T08 – Occupied-project rejection** (server answers `initialize` with `{"code":-32001,"message":"spike: project spike-project-A is occupied by another logical client"}`)

```text
Claude Code  init mcp_servers=[{"name":"spike","status":"failed"}]
             debug: MCP server "spike" Connection failed (-32001): MCP error -32001: spike: project spike-project-A is occupied by another logical client
Codex        mcpServer/startupStatus/updated {"name":"spike","status":"failed","error":"MCP client for `spike` failed to start: MCP startup failed: handshaking with MCP server failed: JSON-RPC error: -32001: spike: project spike-project-A is occupied by another logical cl…"}
             codex exec --json: no item mentions the failure
OpenCode     GET /mcp → {"spike":{"status":"failed","error":"MCP error -32001: spike: project spike-project-A is occupied by another logical client"}}
             opencode run --print-logs: level=WARN message="server unavailable" key=spike type=local status=failed
all three    the model's next reply: "SPIKE-NO-TOOL matching spike_whoami; offered: (none with spike)"
```

**T09 – Bridge crash** (`spike_crash`, then `spike_whoami` 3–4 s later)

```text
Claude Code  debug: STDIO connection closed after 4s (cleanly) … Cleared connection cache for reconnection
             next call: Starting connection … Successfully connected … "SPIKE-WHOAMI project=spike-project-A pid=81550" (was pid 66912)
Codex        6.17 mcpToolCall spike_whoami failed "tool call error: tool call failed for `spike/spike_whoami` … Transport closed"
             9.21 same failure again; no new server process started
OpenCode     next two replies: "SPIKE-NO-TOOL matching spike_whoami; offered: (none with spike)"; no new server process started
```

**T10 – Stale mutation surfaced**

```text
Claude Code  tool_result {"content":"SPIKE-CONFLICT stale_revision: expected r3, current r4 (changed by human in UI); read current state before deciding again","is_error":true}
Codex        mcpToolCall spike_stale_write status "failed"; model input carried "SPIKE-CONFLICT stale_revision: …"
OpenCode     assistant "SPIKE-ACK: SPIKE-CONFLICT stale_revision: expected r3, current r4 (changed by human in UI); read current state before deciding again"
```

**T11 – Lost response**

```text
Claude Code  8 s: tool_result "MCP server \"spike\" tool \"spike_lost_response\" timed out after 8s" (is_error)
             server: one tools/call; notifications/cancelled {"requestId":2,"reason":"McpError: MCP error -32001: Request timed out"}
Codex        8.0 s: "tool call error: tool call failed for `spike/spike_lost_response` … timed out awaiting tools/call after 8s"
             server: one tools/call; no cancellation
OpenCode     60.0 s: "MCP error -32001: Request timed out"
             server: one tools/call; notifications/cancelled twice ("Request timed out", then "AbortError: The operation was aborted.")
```

**T12 – Idle but live, 300 s, server ping every 30 s**

```text
Claude Code  pid 48735 at 21:48:01 and 21:53:01; pings answered 10/10
Codex        pid 57547 at 21:48:04 and 21:53:04; pings answered 10/10
OpenCode     pid 61627 at 21:48:07 and 21:53:07; pings answered 10/10
model requests from the three idle sessions between 21:48:07 and 21:53:01: none
```

**T13 – Prompt persistence** (did the model request contain `SPIKE-ROLE-MARKER-<client>`?)

```text
Claude Code  run 1 with --append-system-prompt: marker present
             --resume without the flag: marker absent
             --resume with the flag: marker present
Codex        developer_instructions in config: marker present in every request, including after thread/resume in a new app-server process
OpenCode     opencode run --agent leader: marker present
             opencode run --session <id> without --agent: marker absent
             server API, agent "leader" sent with each message: marker present on both messages
```

**T14 – Project scope**

```text
Claude Code  roots/list → {"roots":[{"uri":"file://$SPIKE/projA"}]}; whoami "project=spike-project-A" from --mcp-config env
Codex        trusted $SPIKE/projD/.codex/config.toml → "SPIKE-WHOAMI project=spike-project-D-from-project-config"
             tools/call _meta x-codex-turn-metadata.workspaces {"$SPIKE/projD": {"latest_git_commit_hash": …, "has_changes": true}}
OpenCode     roots/list → {"roots":[{"uri":"file://$SPIKE/projA"}]}; whoami "project=spike-project-A" from project opencode.json
```

## Evidence location and reproduction

Full logs, request dumps, the harness scripts and a SHA-256 manifest are kept locally in the task's evidence folder (`.local/xezar-tasks/<runId>/spike/`), which is never committed. They contain no credentials; the only key strings are dummy values.

To reproduce, build the same three pieces outside the repository: the stdio server described in [Environment and fixtures](#environment-and-fixtures); a scripted endpoint that speaks the Anthropic Messages API (streaming) and the OpenAI Responses API (streaming, with `namespace` tools); and one driver per client, which holds a stream-json session open (Claude Code), speaks newline-delimited JSON-RPC to `codex app-server`, or calls `opencode serve` over HTTP and reads `/event`. Pin each client's home as in the isolation table, and confirm the effective home before the first run.

## What would move each NOT ATTEMPTED cell

- **lease expiry, fencing:** a xezar owner registry with lease and generation behind the bridge (D-02). Then the spike harness can race two clients and an expired owner against it.
- **human event:** the project event journal and a UI change that emits a significant event (D-05). Delivery uses the step-2 adapters proven above.
- **replay and dedup:** the same journal with a replay cursor, then a reconnect with a valid and an old cursor (A-21).
- **A real-model reaction** (A-19, OB-5): an account decision, then the T04, T06 and T07 drivers pointed at a real model on the release-candidate revision.
