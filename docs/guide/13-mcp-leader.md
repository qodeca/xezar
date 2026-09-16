# MCP project leader

Use a project leader when you want a coding-agent session to coordinate tasks through xezar: discover the project, start work, read results and respond to task events. The leader is a session you start in your agent application; `xezar mcp` connects it to the running cockpit on the same machine.

## Before setup: check that the running build carries leader delivery

The published npm 0.14.0 package does **not** include the leader door: `leader_events` actions `attach` and `status`, or pushed project events. Do not infer support from a version promised by this page. Check the running cockpit's capabilities instead:

1. In **Settings → MCP connection**, confirm that **Connection status** and **Attach leader** are present; or connect the MCP bridge, call `health` and `discover_project`, then confirm that `leader_events` accepts action `status`.
2. If `status` is an unknown action, or the settings card has no attachment control, that running build cannot complete the instructions below. Update to a build that carries the door, restart the cockpit and start a new client session.

`discover_project` establishes which project and effective capabilities this MCP session is bound to. `leader_events` `status` is the authoritative check for this session's attachment and push capability.

## To choose the leader's role

The operating rule is **xezar MCP tools for project coordination**. The leader does not drive the cockpit UI or call the HTTP API for ordinary work. It should be attached so project events reach it automatically; `leader_events` is the fallback when it is not attached or needs to catch up. Use `gh` for GitHub facts such as labels, review verdicts and merge state.

A connection is bound to one project, with one owning client at a time. The cockpit remains usable by a person alongside the leader. Configuring MCP, acquiring ownership and attaching for push delivery are distinct: having a config file does not prove the session is connected, and a connected session is not automatically attached.

Use these four labels in setup results; none implies the next one:

| State | Evidence |
| --- | --- |
| **Files prepared** | The chosen client's project snippet exists in a reviewable candidate. It may still need integration, trust, sign-in or an adapter. |
| **Connected** | That client made a real xezar MCP tool call for this project. A generated snippet or process start is not evidence. |
| **Attached** | `leader_events` action `attach` succeeded and `status` says this calling session owns it; for OpenCode, the person-attached target appears in status. |
| **Delivery verified** | While attached, the session received a real pushed event or called `leader_events` action `read` and inspected its replay or gap answer. Old durable cursor numbers alone do not prove the current session. |

Do not summarize these as “ready” while a later row is pending. Report the server's blocker and fix,
an unavailable `gh` or network-dependent package resolution as unavailable, and a read-only home as
no authority to mutate personal configuration. Hosted mode cannot perform local attachment. These
limits do not prevent independent tasks or preparation of a reviewable project-only snippet.

## To run a leader in each client

Start the local cockpit first. Configure the chosen client from the project root and start its session there. The client launches `npx -y @qodeca/xezar mcp` over stdio; the bridge forwards calls to the project's running cockpit. It is not another cockpit server.

xezar writes `.local/xezar/mcp-connection.json` automatically, but **none of these clients discovers that file**. Each client still needs its own registration below. Use one owning client per project.

The first-contact order for every client is `health` → `discover_project` → attach → `leader_events` `status`. For Claude Code, Codex and pi, attach is this MCP call with a new client-generated `operationId`; xezar derives the client from the calling session:

```json
{ "action": "attach", "operationId": "leader-attach-example-0001" }
```

Then verify attachment and push capability:

```json
{ "action": "status" }
```

`status` reports whether this session is attached and can receive pushes, its delivery cursors and any blocker. Reuse an operation ID only to repeat the same call after a lost answer; an old attach receipt does not attach a new session.

### Claude Code

**Prerequisites.** Run Claude Code and the cockpit on the same machine. Channels need a claude.ai or Anthropic Console API-key login, do not work on Bedrock, Vertex or Foundry, must be enabled by a Team or Enterprise administrator, and are off while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Pull with `leader_events` when Channels are unavailable.

**Register `xezar mcp`.** From the project root, local scope keeps the entry outside the repository:

```sh
claude mcp add --scope local xezar -- npx -y @qodeca/xezar mcp
```

If the project should carry the registration, use `claude mcp add --scope project xezar -- npx -y @qodeca/xezar mcp`; that writes project `.mcp.json` and each user must approve it.

**Launch.** Registration is not loaded into an already-running session. Start a **new** session after registering, with the exact per-launch flag:

```sh
claude --dangerously-load-development-channels server:xezar
```

Claude Code shows the development-channel warning on every launch. Accept it only when you intend to let xezar inject project events into this session. If `status` reports `claude-code-channel-not-advertised`, run `/mcp`, reconnect `xezar`, then attach again; restarting Claude Code while the cockpit is running does the same. Without the flag, read the journal instead of expecting a push.

**First contact.** Call `health`, then `discover_project`. Call `leader_events` with action `attach` and a fresh operation ID, then action `status`. Check `self.attached`, `canPush` and any blocker; this is **attached**, not yet **delivery verified**.

**What a push looks like.** A real event appears in the session as a `<channel source="xezar" …>` message. It identifies xezar as the source, distinguishes the event from user instruction or approval, and names the cursor to acknowledge. This is the delivery evidence; after accounting for it, call `leader_events` action `ack` with that cursor and a fresh operation ID.

**Restart and compaction recovery.** After a cockpit restart, call a real tool, check `status`, attach with a new operation ID, then call `read` with no cursor. After a client restart or context compaction, also begin with `read` and no cursor. Page with `nextCursor` while `hasMore` is true, deduplicate by `eventId`, reconcile current task state, and acknowledge only the processed cursor. Historical counters do not prove current delivery.

**Tips and tricks.** Start the cockpit before the new Claude Code session so the bridge can advertise the channel. A `claude-code-bridge-too-old` blocker means the client must restart the current bridge. A `push-unconfirmed` blocker does not mean the row was lost: inspect the session and journal, then acknowledge only after the event has been handled.

### Codex

**Prerequisites.** Run Codex and the cockpit on the same machine, trust the project, and use the same Codex home for xezar and the shared app-server: `CODEX_HOME` when set, otherwise `~/.codex`.

**Register `xezar mcp`.** Add this project-scoped block to `.codex/config.toml`:

```toml
[mcp_servers.xezar]
command = "npx"
args = ["-y", "@qodeca/xezar", "mcp"]
```

Accept Codex's trust prompt for the project. Do not use `codex mcp add` for this registration: it writes machine-scope configuration rather than the project file.

**Launch.** Start the shared local app-server under the same Codex home xezar uses:

```sh
codex app-server --listen unix://
```

Then open the Codex TUI in the project. A plain TUI has joined the shared server in verified cases. If attach reports that the thread is not loaded, or the TUI remains in-process/unknown, reconnect it explicitly:

```sh
codex --remote unix://
```

That `--remote` form is conditional troubleshooting, not a universal launch requirement; evidence includes both a working plain TUI and a profile that needed the explicit remote connection.

**First contact.** From the intended TUI session call `health`, then `discover_project`; this real call lets xezar identify the loaded thread. Call `leader_events` `attach` with a fresh operation ID, then `status`. Follow the exact blocker if xezar reports a different Codex home, an unloaded thread, an open approval/question, or an unknown thread state.

**What a push looks like.** A project event starts a new turn in that existing Codex session. The event text identifies xezar, tells the leader to read current state before acting, and includes the cursor for `leader_events` `ack`. A successful attach or a delivery counter without that current-session turn is not push proof.

**Restart and compaction recovery.** After either side restarts, make a real tool call, check `status`, attach with a new operation ID, and call `read` with no cursor. Page, deduplicate, reconcile and acknowledge as described for Claude Code. Then verify one new started turn; an old loaded-thread or cursor count is not current delivery evidence.

**Tips and tricks.** Start the app-server before the TUI. Do not enter a socket path, port, home or thread ID into xezar; it discovers the calling session and refuses ambiguous or wrong-home targets. When push is blocked, journal reads remain available and do not require reconnecting the TUI to another server.

### pi

**Prerequisites.** pi is not an MCP client by itself. Install the tested adapter version once, and use a globally installed xezar package if you want the exact packaged extension path below:

```sh
pi install npm:pi-mcp-adapter@2.32.1
```

Verify `pi list` includes `npm:pi-mcp-adapter`. On startup in this project, pi should report `MCP: 1 servers connected` (or a higher number when other servers are configured).

**Register `xezar mcp`.** Add this project-scoped configuration to `.pi/mcp.json`:

```json
{
  "settings": { "directTools": true },
  "mcpServers": {
    "xezar": {
      "command": "npx",
      "args": ["-y", "@qodeca/xezar", "mcp"],
      "lifecycle": "keep-alive"
    }
  }
}
```

`directTools` exposes the tools to the model. `keep-alive` connects at startup and retains project ownership while idle; without it the adapter releases an idle bridge after ten minutes.

The adapter reads six files in this order, with later entries winning: `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.pi/agent/mcp.json`, project `.mcp.json`, then project `.pi/mcp.json`. Keep the xezar entry in the last file unless you intentionally want a broader scope.

**Launch.** The MCP adapter exposes tools; pushed turns additionally require xezar's packaged leader extension. Load the file from a global xezar installation for one launch:

```sh
pi --extension "$(npm root -g)/@qodeca/xezar/scripts/pi-leader-extension.ts"
```

Or copy that same shipped file to `~/.pi/agent/extensions/` for every project, or to project `.pi/extensions/` for this project only:

```sh
cp "$(npm root -g)/@qodeca/xezar/scripts/pi-leader-extension.ts" ~/.pi/agent/extensions/
# project-only alternative, run from the project root:
cp "$(npm root -g)/@qodeca/xezar/scripts/pi-leader-extension.ts" .pi/extensions/
```

In a running pi, `/reload` rebuilds the extension runtime. Because reload also tears down its socket, attach again afterward with a new operation ID.

**First contact.** Start pi in the project root. Call `health`, `discover_project`, `leader_events` `attach` with a fresh operation ID, then `status`. If pi reports no xezar tools, re-check `pi list`, the startup MCP notice and the six-file precedence before diagnosing attachment.

**What a push looks like.** The extension starts a turn in the existing pi session containing the xezar event and the cursor to acknowledge. Without the extension, no MCP notification can start that turn; use `leader_events` `read` instead.

**Restart and compaction recovery.** After xezar, pi, `/reload`, `/new`, `/resume`, `/fork` or `/clone` rebuilds the runtime, call a real tool, check `status`, attach with a new operation ID, and `read` with no cursor. Page, deduplicate, reconcile and acknowledge before relying on a new push.

**Tips and tricks.** Any pi started in this project with the `keep-alive` entry can hold the project's one leader connection, so exit an unintended owner before switching clients. If `approveTools` covers a xezar tool, answer the approval in your pi window. The leader extension does not answer it, and a headless driver that does not answer can leave pi waiting indefinitely.

### OpenCode

**Prerequisites.** Run OpenCode and the cockpit on the same machine. Use one loopback `opencode serve` instance for the project; xezar attaches to an existing session and never launches one.

**Register `xezar mcp`.** Add this local server entry to project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "xezar": {
      "type": "local",
      "command": ["npx", "-y", "@qodeca/xezar", "mcp"],
      "enabled": true
    }
  }
}
```

The file is project scope. The written form is deterministic; `opencode mcp add` is interactive.

**Launch.** Choose an explicit loopback address so the value to enter in xezar is unambiguous, then attach the TUI to that server:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
opencode attach http://127.0.0.1:4096
```

The **Server address** is therefore `http://127.0.0.1:4096`. OpenCode's [documented server API](https://opencode.ai/docs/server/) says `GET /session` lists that server's sessions:

```sh
curl --fail --silent http://127.0.0.1:4096/session
```

Choose the `id` of the session whose `directory` is the project root. In xezar, a person opens **Settings → MCP connection → Connection status**, chooses OpenCode when the client picker is shown, enters that address and session ID, then chooses **Attach leader**. xezar checks the session exists and refuses one whose directory is another project.

**First contact.** In the intended OpenCode session call `health`, then `discover_project`. OpenCode is the attachment exception: `leader_events` cannot supply its HTTP address, so the person performs the attach in Settings. Back in the OpenCode session, call `leader_events` action `status` to inspect attachment and delivery, then call `read` once to establish the replay path.

**What a push looks like.** xezar submits the event through OpenCode's `prompt_async` route, which starts a turn in the named existing session. The turn identifies xezar, carries only the xezar tools, and names the acknowledgement cursor. A wrong-project, missing or stale session is refused rather than replaced.

**Restart and compaction recovery.** After xezar or `opencode serve` restarts, confirm the address and session still exist, reattach them in Settings, then call `status` and `read` with no cursor in the OpenCode session. After compaction, read, page, deduplicate, reconcile and acknowledge in the same way. Verify one new started turn; the prior person-driven attach is not proof after restart.

**Tips and tricks.** Keep the chosen `serve` port stable so the settings value remains meaningful. If status reports `session-not-found`, open the intended project session and select its new ID; for `wrong-project`, select the session whose `directory` exactly matches the project. If the server is unreachable, restart it at the recorded loopback address; xezar retains the events and retries. Xezar applies an xezar-tools-only permission map to the attached session, including later messages you type in that session; use another OpenCode session for unrelated work that needs other tools.

![MCP connection settings for person-driven OpenCode attachment](../screenshots/0.15.0/settings-mcp-connection-dark-1280.png)

## To stop an attachment

Claude Code, Codex and pi can detach their own session through MCP:

```json
{ "action": "stop", "operationId": "leader-stop-example-0001" }
```

Use a new operation ID for each new attach, stop or acknowledgement. `status` takes no operation ID. A person can replace or stop a person-attached OpenCode target from **Settings → MCP connection**.

## To choose among the eleven tools

The [tool registry](../../packages/xezar/src/mcp/tools/index.ts) has ten service tools, plus the bridge's `health` tool: **eleven total**. Use [MCP API](../features/mcp-server/mcp-api.md) for exact arguments, action names and required operation IDs; it is also available in project **Settings → MCP API**.

| Tool | Use it for |
| --- | --- |
| `health` | Check whether the bound project's cockpit is running. |
| `discover_project` | Read project identity, capabilities, limits and available actions. |
| `task_read` | Inspect tasks and their history. |
| `task_create` | Create a task with explicit source and execution options; use action `start` with the project's issue-filing skill and `autonomous: false` to start the same approval-required issue draft as **New issue** on the GitHub tab. |
| `execution_control` | Control execution and communicate with a task session. |
| `organise_work` | Organize tasks, including queue and archive operations. |
| `handoff_git` | Supported repository, commit, push, PR and merge operations, subject to their checks. |
| `read_results_evidence` | Read task results, changes and evidence. |
| `project_config` | Read or change supported project configuration. |
| `local_handoff` | Open supported task/project destinations on the xezar host. |
| `leader_events` | Attach or stop this session, check attachment status, read significant project events and acknowledge those handled. |

Read `discover_project` before assuming an action is available. Inspect each mutation's result; requesting a task or operation is not proof that downstream work succeeded.

## To recover with `leader_events`

Attached leaders receive pushed events: channel messages for Claude Code, started turns for Codex, OpenCode and pi. If no leader is attached, or delivery is blocked, pull the journal:

```json
{ "action": "read" }
```

Process every event in the page using the returned current task state, then acknowledge that response's `nextCursor` with a client-generated operation ID. Individual events do not carry a cursor:

```json
{
  "action": "ack",
  "cursor": "<nextCursor from the processed page>",
  "operationId": "leader-ack-example-0001"
}
```

Replace the cursor placeholder; use a new operation ID for a new acknowledgement and reuse it only to repeat that same acknowledgement. A read does not acknowledge anything, so unacknowledged events can appear again. If `hasMore` is `true`, read the next page immediately after acknowledging the processed page; otherwise do not poll. Read again on your next connection or when a pushed event names a gap. If the response reports a gap, reconcile the supplied current state and recovery guidance before acknowledging `gap.resumeCursor`. Treat cursors as opaque; another project's cursor is refused.

After a xezar restart, the journal and explicit acknowledgement can survive but the attachment does
not. The per-client restart checklists above restore the progression **files prepared → connected →
attached → delivery verified** without treating old counters as current proof. `task.stalled` is only
an advisory observation and stops nothing. A task completion does not prove a pending reviewer
verdict. Replay is at-least-once within retained durable state, bounded by the retention and page
limits below; a gap is a recovery state, not delivery proof, until its current state has been
reconciled.

## To understand the limits

- The client and cockpit must be on the same machine, and MCP is unavailable in hosted mode. An HTTP URL for a remote cockpit is not an MCP endpoint.
- One client owns the project at a time. There is no **Force takeover** or **Disconnect other client** control. End the owning client normally before connecting another.
- Attachment targets an existing client session. It does not start a leader agent process or establish GitHub authorization.
- A blocked or unconfirmed push is not proof that the model acted. Read the status and journal, then verify resulting task state.
- A xezar-launched Codex task is not the leader: its per-thread isolation disables xezar's bridge, home MCP servers, plugins and apps. Configure the leader in your own client session.
- Setup commands here match the shipped settings guidance. Vendor-client behavior has not been newly live-tested for this guide; the pi adapter version is a recorded compatibility point, and Codex's explicit `--remote unix://` path remains conditional because the recorded evidence is mixed.

## Related settings / env / config

- Project **Settings → MCP connection**: setup, status and attachment; **MCP API**: read-only tool reference.
- [MCP API reference](../features/mcp-server/mcp-api.md), [connection UI source](../../packages/web/src/routes/settings/mcp-connection-section.tsx), [leader control source](../../packages/web/src/routes/settings/mcp-leader-control.tsx).
- [Environment contract](../../.env.example): `XEZ_HOME`, `CODEX_HOME` and hosted-mode settings. Client config belongs to the agent; xezar runtime connection files belong under `.local/xezar/`.

Next: [Remote access](14-remote-access.md)

Describes the current capability-detected leader workflow. The published npm 0.14.0 package does not carry the leader door.
