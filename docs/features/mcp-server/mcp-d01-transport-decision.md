# D-01 — local MCP transport and bridge architecture

Decision record. Date: **2026-09-10**. Spike for [#79](https://github.com/qodeca/xezar/issues/79),
phase 2 of [epic #67](https://github.com/qodeca/xezar/issues/67).

This record closes **D-01** in
[the requirements draft](mcp-project-leader-requirements.md) § 10. It ships **no production code**.
The prototypes that produced the evidence below were written under `/tmp` and are deliberately not
part of this repository; every command needed to rebuild them is quoted verbatim.

It decides the transport, the IPC primitive, the protocol negotiation, the bridge process and where
the bridge sits relative to the running xezar service. It does **not** decide ownership leases
(D-02), the connection-file format (D-04), the event contract (D-05) or operational limits (D-09).

## 0. How to read this document

Two label systems are used, and every statement carries one of each where it matters.

**Agreement status** — the three-way split the requirements draft defines in § 2, preserved here:

| Label | Meaning |
| --- | --- |
| **Agreed** | Already fixed by the requirements draft or by `AGENTS.md`. Not reopened here. |
| **Decided here** | Was `Open` in D-01; this record decides it and names the evidence. |
| **Technical proposal** | A suggestion that still needs its own decision. Not approved by this record. |
| **Open** | No decision yet, here or anywhere. |

**Evidence status** — how each factual claim was established:

| Label | Meaning |
| --- | --- |
| **Executed and observed** | A command was run on this machine on 2026-09-10 and its output is quoted or summarised. |
| **Read from source** | Read in this repository at the cited `file:line`. |
| **Read from official documentation** | Taken from a vendor page, via [the compatibility report](mcp-client-compatibility.md). |
| **Not attempted** | Not tested, with the reason stated. |

"Should work" appears nowhere in this document. Absence claims are scoped to the files or commands
examined.

Machine used for every measurement: macOS 26.6.2 (arm64, `Darwin 25.6.0`), Node v24.20.0, uid 501.
Installed clients at measurement time: **Claude Code 2.1.267** (`claude --version`; its own MCP
`clientInfo` reported `2.1.268` four minutes later — a background auto-update is the likely cause,
not verified), **Codex CLI 0.154.0**, **OpenCode 1.18.30**. These are installed versions, not
minimum supported versions.

## 1. The decision

| # | Question | Decision | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1.1 | Transport to the MCP client | **stdio**. One bridge process per client session, spawned by the client itself, speaking newline-framed JSON-RPC on its own stdin/stdout. | Decided here | E1, E2, E3 |
| 1.2 | IPC primitive from the bridge to the running service | **A Unix domain socket** (`AF_UNIX`, `SOCK_STREAM`) owned by the running xezar service — `net.createServer(path)` in Node, so no dependency is added. Frames are newline-delimited JSON, the same framing as the stdio leg. On Windows the same Node API listens on a **named pipe**; that half is untested (§ 10). | Decided here | E4, E5, E7 |
| 1.3 | Socket location | `<xezarHomeDir()>/ipc/<projectId>.sock`, i.e. normally `~/.xezar/ipc/<projectId>.sock`, where `projectId` is the id the workspace registry already allocated. Directory mode `0700`, socket mode `0600`. **Not** inside the project's `.local/xezar/`. | Decided here | E5 (the path-length measurement that forced it), E7 (the permission measurement) |
| 1.4 | Fallback when that path is too long | If `<xezarHomeDir()>/ipc/<projectId>.sock` would exceed the OS limit measured in E5, substitute the first 12 hex characters of the SHA-256 of the project root for `<projectId>`. The limit is the operating system's, not a xezar constant. | Decided here | E5 |
| 1.5 | Where project identity comes from | **The socket the bridge connected to.** The service allocates one socket per registered project and answers only for that project on it. No `projectId` parameter, alias, root path or prompt content from the client is consulted. | Decided here (mechanism); **Agreed** (the requirement — § 8, F-01, N-09) | E3 |
| 1.6 | Protocol negotiation | Echo the client's requested `protocolVersion` when the bridge supports it; otherwise answer with the newest the bridge supports and let the client decide. The bridge must support **at least `2025-06-18` and `2025-11-25`** at implementation time, because the three required clients do not agree today. | Decided here | E1, E2, E3 |
| 1.7 | How the bridge starts | A new positional subcommand on the existing CLI: **`xez mcp`**. It is spawned by the MCP client, never by a user and never by a service manager. It starts **no** server, opens **no** port and creates **no** daemon. | Decided here | E8, § 7 |
| 1.8 | Behaviour when the xezar service is not running | The bridge still starts, still completes the MCP handshake and still lists its tools. Each tool call answers with a structured "xezar is not running here" result. The client shows a healthy server. | Decided here; satisfies **Agreed** N-07 | E6 |
| 1.9 | New `XEZ_*` environment variable | **None for the default path.** Nothing must be authored, exported or remembered. If implementation later adds one (an override of the socket path for tests is the plausible case), the same commit updates `.env.example` — that file is owned by [#84](https://github.com/qodeca/xezar/issues/84) and is deliberately untouched by this spike. | Decided here; **Agreed** constraint (`AGENTS.md` § Zero config) | — |
| 1.10 | Model wakeup | **Not solved by any transport, including this one.** Waking a model is adapter work under D-05 and the approved delivery hierarchy in § 12 of the requirements draft. Choosing stdio neither helps nor hurts it, except that Claude Channels requires stdio. | **Open** (unchanged) | Read from official documentation, via the compatibility report |

### Why this shape, in one paragraph

The client already knows how to start a local process and talk to it on stdio; all three required
clients do it and one of them (Claude Channels) can do nothing else. A process the client starts
needs no port, no discovery protocol and no daemon, which is exactly what `AGENTS.md` § Zero config
asks for. But that process must not *be* xezar — the run state, the semaphore and the project
context live in the already-running service. So the bridge is a thin adapter with two legs: MCP on
stdio facing the client, and a Unix socket facing the service. The socket is what makes the project
binding trustworthy: the service chooses which socket serves which project, so identity is a
property of the connection, not of anything the client says. That is the literal requirement in § 8
of the requirements draft, and it is the requirement loopback HTTP cannot meet (§ 3.1).

## 2. Evidence — what was run, and what was seen

Every experiment below was **executed and observed** on 2026-09-10 unless its own row says
otherwise. The prototype was a ~70-line Node script (`/tmp/d01-spike/bridge.mjs`) that answered
`initialize`, `ping`, `tools/list` and `tools/call`, logging every framed message with a monotonic
offset; and a second script (`/tmp/d01-spike/backend.mjs`) standing in for the running service on a
Unix socket. Neither is part of this repository.

### E1 — Claude Code handshake against a stdio MCP server

```sh
export CLAUDE_CONFIG_DIR=/tmp/d01-spike/claude-home   # keeps the real ~/.claude untouched
cd /tmp/d01-spike/proj
claude mcp add --scope local xezar-d01 -- /usr/bin/env SPIKE_LOG=… node /tmp/d01-spike/bridge.mjs
/usr/bin/time -p claude mcp list
```

Observed: `xezar-d01: … - ✔ Connected`, `real 0.57` (a second run: `real 0.69`). The bridge's own
log shows the whole handshake inside **3 ms** of process start:

```
+2ms in  {"method":"initialize","params":{"protocolVersion":"2025-11-25",
          "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
          "clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.268"}},"id":0}
+3ms in  {"method":"notifications/initialized"}
+3ms in  {"method":"tools/list","id":1}
```

`claude mcp list` performs a real connection health check, not a config dump — the CLI prints
`Checking MCP server health…` and the server process is genuinely spawned and spoken to. No model
turn was started and no tokens were consumed.

### E2 — OpenCode handshake against the same stdio MCP server

A project-scoped `/tmp/d01-spike/proj/opencode.json` with `"type": "local"` and
`"command": ["node", "/tmp/d01-spike/bridge.mjs"]`, then `opencode mcp list`.

Observed: `✓ xezar-d01 connected`, `real 0.54`. Bridge log:

```
+2ms in {"method":"initialize","params":{"protocolVersion":"2025-11-25",
         "capabilities":{"roots":{}},"clientInfo":{"name":"opencode","version":"1.18.30"}},"id":0}
+6ms in {"method":"notifications/initialized"}
+6ms in {"method":"tools/list","id":1}
+181ms stdin-closed
```

The same listing also showed the user's own URL-based MCP server as `✗ fusion failed — SSE error:
Unable to connect` while the client itself kept working. That is the observed failure presentation
of a **URL** transport whose endpoint is down, and it is the comparison § 3.1 rests on.

### E3 — Codex handshake **and a tool call**, with no model turn

`codex mcp list` does **not** connect (`real 0.04`, no bridge log written), so the handshake was
driven through the app-server protocol instead. `codex app-server generate-json-schema --out …`
names the two methods used: `mcpServerStatus/list` and `mcpServer/tool/call`.

```sh
CODEX_HOME=/tmp/d01-spike/codex-home codex app-server        # isolated config, real binary (see § 9.3)
# → initialize → initialized → thread/start {cwd} → mcpServer/tool/call
```

Observed, client side:

```
+40ms <- initialize result … "codexHome":"/private/tmp/d01-spike/codex-home"
+53ms <- thread/start        … thread id 01a08d17-…
+74ms <- mcpServer/tool/call result:
         {"content":[{"type":"text","text":
          "{\"ok\":true,\"ms\":1,\"body\":{\"boundProject\":\"projectA\",\"echoAsked\":null,…}}"}]}
```

Observed, bridge side:

```
+2ms in {"id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18",
         "capabilities":{"experimental":{"codex/auth-change":{}},"elicitation":{"form":{},"url":{}}},
         "clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.154.0"}}}
+3ms in {"id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
+3ms in {"id":2,"method":"tools/call","params":{"_meta":{"threadId":"01a08d17-…"},
         "name":"spike_project_identity","arguments":{"projectId":"projectB-ATTEMPT"}}}
+4ms out {"id":2,"result":{"content":[…"boundProject":"projectA"…]}}
```

Three things were measured here, and each one decides something above.

1. **Codex offers `2025-06-18`, not `2025-11-25`.** Claude Code and OpenCode both offered
   `2025-11-25`. This is the measured reason for decision 1.6, and it confirms the compatibility
   report's instruction to negotiate rather than assume a revision.
2. **The `projectId` the client sent was ignored and the binding held.** The call carried
   `arguments: {"projectId": "projectB-ATTEMPT"}`. The bridge forwarded a request with no project
   field; the socket-owning backend answered `boundProject: "projectA"`, `echoAsked: null`. This is
   the mechanism of decision 1.5 exercised end to end through a real client — A-02's shape, at
   transport level only.
3. **Codex probes `resources/list` and `resources/templates/list` and tolerates `-32601`.** The
   prototype answered "no method" to both and Codex still reported the server healthy. A bridge that
   implements tools only is therefore viable for Codex; whether it is viable for the other two in a
   full session is **not attempted**.

Codex also attaches its own `threadId` in `_meta` on every `tools/call`. That is a useful
correlation hint for D-02 — and it is client-supplied, so it can never be the authority.

### E4 — cost of the bridge process

```sh
node /tmp/d01-spike/measure-spawn.mjs   # 10 cold spawns, spawn → initialize response
```

Observed: `20.4 20.4 20.4 20.7 20.7 20.9 21.2 21.3 21.9 22.0` ms; **median 20.9 ms**. A bare
`node -e ''` on the same machine is `real 0.02`. So the prototype adds roughly 1 ms over Node's own
startup.

The **real** bridge will not be 70 lines. The published CLI on this machine, `xez --version`
(v0.13.1), takes `real 0.11 / 0.12 / 0.13`. That is the realistic floor if `xez mcp` loads the whole
entry module graph, and it is the argument for keeping the `mcp` branch of the CLI switch behind
lazy imports. Both figures are far inside any client health-check budget observed here (E1: 0.57 s
end to end, including Claude's own boot).

### E5 — the Unix socket path length limit, measured

```sh
node -e '…listen on paths of increasing length…'
```

Observed, exactly:

```
len 100 => OK   len 101 => OK   len 102 => OK   len 103 => OK   len 104 => OK   len 105 => EINVAL
```

So the usable limit on this machine is **104 bytes**. That is an operating-system constant
(`sun_path`), not a xezar choice, which is why decisions 1.3 and 1.4 may cite it without an
approval.

It is load-bearing, not theoretical. Measured path lengths:

| Candidate socket path | Bytes |
| --- | --- |
| `<this repo's own task worktree>/.local/xezar/mcp.sock` | **114 — over the limit** |
| `/Users/marcinobel/Projects/xezar/.local/xezar/mcp.sock` (main checkout) | 54 |
| `~/.xezar/ipc/<projectId>.sock` | 42 |

And it bit for real during this very spike, in a way nobody planned. Booting the repository's own
server under `tsx` from the task worktree failed outright:

```
Error: listen EINVAL: invalid argument
  /Users/…/.local/xezar/tmp/6fb486a0-…/tsx-501/15749.pipe
```

That path is **105 bytes** — one over the measured limit. xezar sets `TMPDIR` to the per-task
worktree tmp directory, `tsx` puts its IPC socket under `TMPDIR`, and the combination exceeded
`sun_path`. Setting a short `TMPDIR` booted the server immediately. This is recorded as a real
observation in § 9.5; for D-01 it is the direct reason the MCP socket does not live under the
project.

### E6 — N-07: the xezar service is not running

The backend stand-in was stopped by saved PID, leaving the socket path absent. Then, unchanged:

| Client | Command | Observed |
| --- | --- | --- |
| Claude Code | `claude mcp list` | `✔ Connected` (`real 0.69`) |
| OpenCode | `opencode mcp list` | `✓ xezar-d01 connected` |
| Codex | `mcpServer/tool/call` through app-server | `{"ok":false,"ms":1,"reason":"ENOENT"}` returned as an ordinary tool result |

No client reported a failed server, no client failed to start, and the tool call returned a legible
reason in ~1 ms rather than hanging. Contrast E2, where a URL-based MCP server whose endpoint was
down rendered as `✗ failed`.

### E7 — Unix socket access control, measured

```sh
node -e '…connect; chmod 000; connect; chmod 600; connect; chmod dir 000; connect; restore…'
```

Observed on macOS 26.6.2, as uid 501 (the owner):

```
mode 755:          CONNECTED
socket mode 000:   REFUSED EACCES
socket mode 600:   CONNECTED
directory 000:     REFUSED EACCES
directory 700:     CONNECTED
```

Both the socket file's mode and the containing directory's mode are enforced on this host — the
permission check applies even to the owning uid. Node creates the socket at umask default (**755**
was observed), so the service must `chmod` it explicitly; the prototype did, and mode 600 connected
normally.

Note what this does *not* establish: it is same-user access only, on one operating system. See
§ 10.3 and § 10.4.

### E8 — how a client actually finds the server

A fresh temp project was given **both** candidate files at once:

- `<project>/.mcp.json` naming the bridge, and
- `<project>/.local/xezar/mcp.json` naming the bridge — the location F-14 specifies.

`claude mcp list` in that directory reported exactly one entry:

```
xezar-root: node /tmp/d01-spike/bridge.mjs - ⏸ Pending approval (run `claude` to approve)
```

Two measured facts. The repo-root `.mcp.json` **is** discovered — but it is not connected until the
user approves it interactively. The `.local/xezar/mcp.json` file is **not discovered at all** by
Claude Code in the case examined. F-14 already says "Not all applications automatically discover
that file"; this is the measurement behind that sentence.

For Codex, `<project>/.codex/config.toml` containing `[mcp_servers.projectlevel]` produced
`No MCP servers configured yet.` from `codex mcp list` — see the scoped correction in § 9.2. For
OpenCode, the project-level `opencode.json` **was** read (E2).

### E9 — what a loopback HTTP caller looks like to the real server

The repository's own server was booted on a throwaway repo
(`tsx packages/xezar/src/index.ts serve --repo /tmp/d01-spike/proj --port 4399 --no-open`, with
`XEZ_HOME` and `TMPDIR` pointed at temp directories and `XEZ_DRY_RUN=1`), then probed with `curl`:

| Request | Status | Body |
| --- | --- | --- |
| `POST /api/v1/runs`, **no `Origin`** (a plain local process) | **400** | `{"error":"task: Invalid input: expected string, received undefined"}` |
| `POST /api/v1/runs`, `Origin: https://evil.tld` | 403 | `forbidden: cross-origin request rejected` |
| `POST /api/v1/runs`, `Host: evil.tld` | 403 | `forbidden: unexpected Host header … (see #426)` |
| `GET /api/v1/runs`, no `Origin` | 200 | `[]` |
| `GET /api/v1/launch-key`, no `Origin` | 200 | `{"key":"aa79a470-…"}` |
| `GET /api/v1/projects`, no `Origin` | 200 | the whole registry, including **other projects' absolute roots** |

The guard works exactly as designed and as documented — against **browsers**. Against a local
process it is not a boundary at all: a 400 from body validation means the request reached the route.
The first row is the entire argument of § 3.1.

## 3. Rejected alternatives

### 3.1 Loopback Streamable HTTP MCP, served by the xezar service

The compatibility report calls this "a viable alternative for clients". It is rejected here, for
four independent reasons, of which the first alone is sufficient.

1. **The loopback HTTP surface carries no caller identity, so it cannot bind an owner.**
   *Executed and observed (E9).* Any process running as this user reaches any route by sending a
   request with a loopback `Host` and no `Origin` header — the guard's cross-origin check is skipped
   entirely when `Origin` is absent (`packages/xezar/src/server/server.ts:1254`, the
   `if (origin !== undefined)` branch). The server therefore cannot distinguish the leader's MCP
   client from any other local program, which is precisely what F-01, F-18 and § 8 require it to do.
   § 8 states the constraint in one sentence: *"A loopback HTTP alternative needs equivalent
   project/owner enforcement; a proxy to every route is insufficient."* A per-request bearer token
   could be bolted on, but then it is a credential the user must be given and a file the user must
   be told about — see reason 3 — and § 8 also warns that "file presence or location alone is not a
   security boundary". The existing `launch-key`
   (`packages/xezar/src/server/launch-key.ts:11`) is not that credential: it is a bookmarklet secret
   scoped to auto-starting a run from `/new?auto=1`, not an owner identity.
2. **A web page can reach loopback HTTP. It cannot open a Unix socket.** The `/api/*` request-origin
   guard exists because any page the user visits can `fetch` `127.0.0.1` and any DNS-rebound domain
   can try to read the answers (`packages/xezar/src/server/server.ts:1220–1253`, read from source).
   An MCP endpoint on that same surface inherits that whole threat model and needs that whole guard.
   A `AF_UNIX` socket has no URL and no browser API, so the class of attack does not apply.
   *Read from source, plus E9 for the guard's live behaviour.*
3. **It reintroduces a port to discover.** The CLI's port defaults to `4321`
   (`packages/xezar/src/index.ts:87`) and any user may change it with `--port`; a second cockpit on
   the same machine must. The client's MCP configuration is static, so either the user types the
   port into it — "a port to remember", forbidden by `AGENTS.md` § Zero config — or xezar rewrites
   the client's own config file every time the port changes. Neither is proxy-free or daemon-free.
   *Read from source.*
4. **Its "service down" behaviour is worse.** *Executed and observed (E2 vs E6).* A URL-based MCP
   entry whose endpoint is down renders as `✗ failed` in the client. The stdio bridge renders as
   connected and explains the situation inside a tool result. N-07 asks for a degraded working state,
   not a failure banner.

And the point the issue explicitly asks to be stated: **it solves no model wakeup.** *Read from
official documentation, via the compatibility report.* No reviewed page establishes that a plain
native MCP connection — over stdio or over HTTP — makes Codex or OpenCode start a turn on a server
event. Waking a model is adapter work (Claude Channels, an OpenCode plugin, a Codex app-server
integration), it is D-05's problem, and switching the transport to HTTP would not move it one step
closer. Choosing HTTP would therefore give up the four points above and buy nothing.

### 3.2 Loopback HTTP plus a scope-injecting reverse proxy

Rejected by § 8 in terms — *"a proxy to every route is insufficient"* — and by E9 for the same
reason as § 3.1: a proxy that adds a project header still cannot tell which local process is on the
other end of the socket it accepted.

### 3.3 A second long-lived daemon that owns the socket

Rejected by `AGENTS.md` § Zero config: "no daemon to manage… prefer a proxy-free, daemon-free
mechanism when one exists". One exists. The socket is created and owned by the xezar service that is
already running; when there is no service, there is no socket, and § 5 describes what the client
sees. Nothing new is installed, supervised or restarted.

### 3.4 Putting the socket inside the project's `.local/xezar/`

This is where F-14 puts the *connection configuration*, so it was the obvious first choice for the
socket too. Rejected on measured grounds: for this repository's own task worktree the path is **114
bytes** against a measured **104-byte** limit (E5), and the identical failure was observed live when
`tsx` could not create its own IPC socket under the worktree `TMPDIR` at 105 bytes. A socket that
fails to bind in xezar's own default working arrangement is not a candidate.

This does **not** move the connection *descriptor*: F-14 is Agreed and the descriptor stays in
`.local/xezar/`. Only the socket moves, and the descriptor names the socket path — see § 4.

### 3.5 The bridge calling the service's HTTP API instead of a socket

Rejected: it inherits reasons 1 and 3 of § 3.1 in full (no caller identity, port discovery) while
adding a second hop. The IPC leg exists to be *narrower* than the HTTP API, not to re-expose it: it
carries project-scoped operations that the service resolves through its own
`ProjectContext` (`packages/xezar/src/server/project-context.ts`), never a forwarded `projectId`.

### 3.6 An MCP server embedded in the service with no bridge process at all

Not an alternative to this decision, because it is not a transport. Every one of the three required
clients starts a local **process** for a local MCP server; two of them can also be given a URL, and
that path is § 3.1. Something must own the client's stdin and stdout. The bridge is that something,
and keeping it thin is what makes it an adapter rather than "another task store or business engine"
(compatibility report, § Recommended architecture).

### 3.7 MCP Tasks or resource subscriptions as the delivery mechanism

Out of D-01's scope and rejected as a *transport* premise. The compatibility report records that
Tasks are experimental in the reviewed revision, that status notifications are optional, and that
initial support in each of the three installed clients is unverified. *Read from official
documentation.* This record's transport does not depend on either feature; whether the event
contract later negotiates them is D-05.

## 4. How the bridge starts, and how a client discovers it

**Starting it — decided here.** A new positional subcommand, `xez mcp`, alongside `serve`, `run`,
`init`, `projects` and the `server-*` family in the existing `parseArgs` switch
(`packages/xezar/src/index.ts:125–179`). Verified today: `mcp` is not a command — `xez mcp` prints
`unknown command: mcp` from the `default:` branch at `packages/xezar/src/index.ts:175` and exits
non-zero. *Executed and observed.*

`xez mcp`:

- reads its project from the working directory it was started in, resolving the repo root the same
  way `serve` does, or from an explicit `--repo` (already a global flag,
  `packages/xezar/src/index.ts:88`);
- resolves that root to the workspace-registry project id, and from it to
  `<xezarHomeDir()>/ipc/<projectId>.sock` (`packages/xezar/src/paths.ts:16` is the only place a home
  is derived — nothing here re-derives `homedir()`);
- connects, or does not, and either way serves MCP on stdio (§ 5);
- **starts no server and opens no port.**

The cwd is used only to *find* the socket. It never becomes the authority: the service answers a
connection with the project that socket belongs to, and a cwd that maps to no registered project
finds no socket and degrades exactly as § 5 describes. This distinction is what keeps decision 1.5
inside § 8's rule.

All three clients were observed spawning the MCP server with the session's project directory as its
working directory (E1, E2, E3 all logged `cwd: /private/tmp/d01-spike/proj`). *Executed and
observed, in the modes examined only.*

**Discovering it — one one-time step per client, and there is no way around that.** *Executed and
observed (E8), and consistent with F-14 and the compatibility report.*

| Client | Where the one-time entry goes | Observed cost |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope local xezar -- xez mcp` (writes the user's own Claude config, not the repo), or a repo-root `.mcp.json` | `--scope local` connected immediately (E1). A repo-root `.mcp.json` is discovered but sits at `⏸ Pending approval` until the user approves it interactively (E8). |
| OpenCode | project `opencode.json`, `"type": "local"`, `"command": ["xez", "mcp"]` | Read and connected with no approval step (E2). |
| Codex | the per-user `config.toml` under `CODEX_HOME`: `[mcp_servers.xezar] command = "xez"`, `args = ["mcp"]` | Connected (E3). A repo-level `.codex/config.toml` was **not** picked up — § 9.2. |

**Technical proposal, not decided here:** that `xez mcp setup [--client claude|codex|opencode]`
prints or writes that one-time entry, so the user runs one command instead of editing a file. The
name, the write-vs-print behaviour and the interaction with the F-14 descriptor belong to **D-04**,
which owns the connection file. This record only establishes that the step is unavoidable and that
nothing secret passes through it: the bridge command line contains no credential, because identity
comes from the socket (§ 1.5). That is what keeps F-15 satisfied without any special handling.

## 5. When the xezar service is not running

**Agreed requirement (N-07):** MCP must not block ordinary cockpit startup, and a missing peer must
degrade to a working xezar, never a failed boot.

**Decided here**, and measured in E6:

1. `xez mcp` does not require the socket to exist in order to start. It completes `initialize`,
   answers `tools/list` in full, and answers `ping`.
2. Every tool call attempts the connection at call time and fails fast. A missing socket surfaces as
   `ENOENT`, a stale socket file as `ECONNREFUSED`; both are returned as an ordinary MCP tool result
   whose text says xezar is not running for this project and how to start it. Not a transport error,
   not a hang, and no retry loop — so no retry-count or backoff constant is introduced by this
   record.
3. There is no reconnect timer to invent, because the next tool call is the next attempt. A cockpit
   started later is picked up on the following call with no client restart.
4. The reverse direction is equally required and is a **property of the design rather than a
   measurement**: the service creates the socket as part of serving a project and never blocks boot
   on it. A home directory that is read-only or unwritable must log one warning and continue — the
   same rule `initWorkspace` already follows (`packages/xezar/src/index.ts:199`, read from
   source). Under that failure the socket is absent and clients see case 1. This half was **not
   attempted**: there is no implementation to fail yet.

Measured: with the backend stopped, Claude Code reported `✔ Connected`, OpenCode reported
`✓ connected`, and Codex's tool call returned `{"ok":false,"ms":1,"reason":"ENOENT"}` (E6). The
comparison case matters — a URL-based MCP server with a dead endpoint rendered as `✗ failed` in the
same client listing (E2).

## 6. Project binding, and why it meets § 8

**Agreed:** "The server derives project identity from a trusted connection binding; it must not
forward an arbitrary `projectId` to a global API client" (§ 8). "An input parameter, project alias,
or prompt content cannot change the binding" (F-01). "Tasks, files, and results are data, not
sources of authority" (N-09).

**Decided here:** the trusted connection binding is **which socket the peer connected to**.

- The service allocates the socket per registered project and holds the project's `ProjectContext`
  behind it. The peer cannot name a project; there is no field for it.
- Measured end to end through a real client in E3: a `tools/call` carrying
  `arguments: {"projectId": "projectB-ATTEMPT"}` came back `boundProject: "projectA"` with
  `echoAsked: null`.
- The client's own session id (Codex's `_meta.threadId`, E3) and the client's `roots` capability
  (Claude Code and OpenCode both advertised `roots`, E1 and E2) are visible to the bridge and are
  **client-supplied**. They may inform diagnostics. They may never inform authorization.

**What the socket does and does not protect.** *Executed and observed (E7):* file mode and directory
mode are both enforced on macOS 26.6.2, so `0700` on `<xezarHomeDir()>/ipc/` plus `0600` on the
socket restricts the connection to this operating-system user. That is the same trust boundary the
existing HTTP server already assumes and a strictly narrower one than loopback TCP, which is
reachable by every local process **and** by any web page the user visits (E9). It is **not**
isolation between programs run by the same user — nothing here claims a sandbox the existing runners
do not provide (§ 8, last paragraph).

**Not found in the interfaces examined:** a way to read the connecting peer's uid from Node's `net`
module on a Unix socket (no `SO_PEERCRED`/`LOCAL_PEERCRED` accessor is exposed by the documented API
surface reviewed for this spike). Peer-credential checking is therefore **not** part of this
decision, and the filesystem modes measured in E7 are the whole of the same-user boundary. If a
future requirement needs peer uid, it needs a native addon, and that is new scope.

**Still Open, and deliberately untouched here:** exactly one logical owner per project (F-18), lease
and fencing generation, and release on confirmed death or expiry (F-19). Those are **D-02**. This
record contributes one measured input to them and stops:

> **E10 — a killed owner is observed immediately, with no timeout.** A client held an open Unix
> socket connection to the service stand-in and was then `kill -9`'d. The service observed `close`
> at the same instant (connection open 1988 ms; the kill was issued ~1990 ms after it opened).
> *Executed and observed.*
>
> The consequence for D-02 is narrow but real: for the **confirmed-termination** case a stream
> socket needs **no timeout at all**, because the operating system delivers the event. A lease is
> needed only for the cases the OS cannot report — an idle-but-live owner, or a leaked descriptor.
> Choosing that lease value stays D-02's decision and no number for it appears in this document.

## 7. Integration points in this repository

Each was read at the cited location on the current branch.

| Integration point | Location | What D-01 touches |
| --- | --- | --- |
| CLI entry, `node:util` `parseArgs`, `serve` as the default command | `packages/xezar/src/index.ts:4` (import), `:85` (`parseArgs`), `:125` (`positionals[0] ?? 'serve'`), `:131` (`case 'serve'`), `:175` (`default:` → `unknown command`) | One new `case 'mcp':` in that switch. No new framework, no new global flag. `--repo` (`:88`) is reused. |
| Per-user home resolution | `packages/xezar/src/paths.ts:16` (`xezarHomeDir`) | The socket directory is derived here and nowhere else, so `XEZ_HOME` keeps tests and containers off a real home — the rule `AGENTS.md` already states for this file. `agentHomePaths` (`:179`) is unrelated to the socket and is only relevant to § 9.3. |
| HTTP server bound to loopback | `packages/xezar/src/server/server.ts:5725–5728` (`serve({ …, hostname: deps.bindHost ?? '127.0.0.1' })`) | Unchanged. The MCP transport adds no HTTP route and does not widen the bind. |
| `/api/*` request-origin guard | `packages/xezar/src/server/server.ts:1220` (comment), `:1254` (`app.use('/api/*', …)`), `:1259` (loopback `Host` test) | Unchanged, and the reason § 3.1 rejects loopback HTTP: the guard is a browser perimeter, not a caller identity (E9). |
| CORS, `/api/v1/health` only | `packages/xezar/src/server/server.ts:1430` (`healthCors`), `:1440` (`app.use(\`${V1_PREFIX}/health\`, healthCors)`) | Unchanged and not widened. Nothing in this decision needs a cross-origin route. |
| Project context | `packages/xezar/src/server/project-context.ts` | The socket's server side resolves through the existing per-project context; MCP adds no second store and no second queue (§ 8). |
| Launch key | `packages/xezar/src/server/launch-key.ts:11` | Named only to say it is **not** reused as an MCP credential (§ 3.1, reason 1). |
| `.local/.gitignore` maintenance (`ensureDataGitignore`) | `packages/xezar/src/index.ts` (`init`), per `AGENTS.md` § Task routing | No new state file lands in `.local/xezar/` from this decision — the socket lives under `~/.xezar/ipc/`. The F-14 descriptor is D-04's, and D-04 owns that gitignore consequence. |

**Not found in the files examined:** any existing MCP server implementation, and any dependency on
`@modelcontextprotocol/*`. Searching `packages/xezar/src` for `mcp` returns agent-output tool-display
code (`core/tool-display.ts`, `core/codex-ui-mapper.ts` and their tests), not a server.

## 8. Values fixed here, and values deliberately not fixed

**Fixed here, each with the experiment that fixed it:**

| Value | Fixed to | What fixed it |
| --- | --- | --- |
| Transport | stdio | E1–E3: all three required clients handshake with one stdio server. Claude Channels needs stdio (read from official documentation). |
| IPC primitive | `AF_UNIX` stream socket, newline-delimited JSON | E3 (1 ms round trip through the bridge), E7 (mode enforcement), E10 (immediate death signal) |
| Maximum socket path | 104 bytes — an OS limit, not a xezar constant | E5 (105 ⇒ `EINVAL`, 104 ⇒ OK), confirmed by a live `tsx` failure at 105 bytes |
| Socket directory | `<xezarHomeDir()>/ipc/`, mode `0700`; socket mode `0600` | E5 (a project-local path is 114 bytes here), E7 (both modes enforced) |
| Protocol revisions the bridge must support | at least `2025-06-18` **and** `2025-11-25` | E1/E2 (`2025-11-25` from Claude Code and OpenCode) vs E3 (`2025-06-18` from Codex) |
| CLI subcommand | `xez mcp` | E8/§ 4: the name is currently unclaimed; `xez mcp` exits `unknown command: mcp` today |
| Retry/backoff on a dead socket | **none** — fail fast on each call | E6: the failure is legible and returns in ~1 ms; a retry loop would only add a constant nobody measured |
| Timeout for confirmed owner death | **none** — the OS reports it | E10 |

**Deliberately not fixed here.** Each remains exactly as its row in § 10 of the requirements draft
leaves it, and this record does not narrow any of them:

- **D-02** — owner lease duration, fencing generation, renewal, idle-but-live handling, restart
  behaviour, and the protocol-compliant "project occupied" error mapping. E10 is an input, not an
  answer.
- **D-04** — the connection descriptor's name and format in `.local/xezar/`, and the shape of the
  one-time client setup helper (§ 4 marks it a technical proposal).
- **D-05** — event ids, ordering, replay, acknowledgement, retention, and which client adapter wakes
  which model. No retention duration and no event-delivery number appears in this document.
- **D-06** — operation identity, expected-version checks, collision and restart rules.
- **D-09** — operational limits, payload caps, pagination sizes.
- **Tool names and granularity** — the prototype's `spike_project_identity` is a fixture name and is
  not a proposal.

## 9. Corrections and environment facts

Where a document and this repository's source disagree, the source wins. Where a document and a
measurement disagree, the measurement is recorded with its scope.

**9.1 Client versions have moved since the compatibility report.** That report (2026-09-08) records
Claude Code 2.1.263, Codex 0.153.4, OpenCode 1.18.29. Measured on 2026-09-10: **2.1.267** (reporting
`2.1.268` over MCP minutes later), **0.154.0**, **1.18.30**. Nothing in the report's conclusions
depended on the exact patch versions; this is a freshness note, not a contradiction.

**9.2 Codex has no project-scoped MCP configuration, in the case examined.** `AGENTS.md` § Validation
states that `<repo>/.codex/config.toml` "resolve[s] from the repo root, not from any home". Measured:
a `<project>/.codex/config.toml` containing `[mcp_servers.projectlevel]` produced
`No MCP servers configured yet.` from `codex mcp list` run in that project with an isolated
`CODEX_HOME`. *Executed and observed, scoped to `mcp_servers`, codex 0.154.0, and the `codex mcp list`
command.* It does not disprove the `AGENTS.md` sentence for model keys, which is what that sentence
is about. The consequence for D-01 is concrete: **Codex's entry for the bridge is per-user, so the
project must come from the spawn cwd** (observed in E3) rather than from a per-project config file.

**9.3 On this machine, `codex` on `PATH` is a wrapper that pins `CODEX_HOME` itself.**
`which codex` → `/Users/marcinobel/.codex-cli/bin/codex`, a 429-byte shell script ending in
`exec /usr/bin/env -u CODEX_SQLITE_HOME CODEX_HOME=/Users/marcinobel/.codex-cli … codex "$@"`.
An outer `CODEX_HOME` (and `CODEX_CLI_HOME`, and `CODEX_CONFIG_DIR`) is therefore ignored, which was
found the hard way: an isolated-home experiment wrote into the real user config and had to be undone
with `codex mcp remove`. *Executed and observed.* This is a property of this machine, **not** a bug in
`packages/xezar/src/paths.ts:179`, which honours the vendor-documented `CODEX_HOME` correctly. It is
worth recording because `AGENTS.md` § Validation relies on pinning `CODEX_HOME` to isolate the
browser suite's Codex config: on a host with a wrapper like this one, that pin does not reach the
binary. The real binary at `~/.nvm/versions/node/v24.20.0/bin/codex` honours `CODEX_HOME` normally,
and E3 used it directly.

**9.4 One stale code comment.** `packages/xezar/src/server/server.ts:5721` says "only `/api/health`
is CORS-open". The code registers `${V1_PREFIX}/health` at `:1440`, i.e. `/api/v1/health`; the guard
block at `:1273` spells it through `V1_PREFIX` for exactly this reason. Behaviour is correct; the
comment predates the versioned surface. Not fixed here — this spike owns one file.

**9.5 A xezar dogfooding observation, from this spike's own environment.** Booting the repository's
server under `tsx` from a task worktree failed with
`Error: listen EINVAL … /Users/…/.local/xezar/tmp/<runId>/tsx-501/<pid>.pipe` — a **105-byte** path
against the 104-byte limit measured in E5. xezar sets `TMPDIR` to the per-task worktree tmp
directory; `tsx` places its IPC socket under `TMPDIR`; the sum is one byte over. A short `TMPDIR`
booted it immediately. *Executed and observed.* This is not an MCP bug and this record does not
propose a fix, but it is a real, reproducible constraint on any Unix socket created under a xezar
task worktree, and it is the reason § 3.4 exists.

## 10. What remains unproven

Explicitly, and without hedging.

1. **No model reaction was tested, at all.** Every measurement here stops at the transport. Nothing
   in this record shows that Claude Code, Codex or OpenCode will *start a turn* because xezar emitted
   an event. **Not attempted:** it needs a real model turn on the user's own account, which the
   compatibility report's own guidance forbids for fixtures. A-19 and A-23 remain unpassed and D-05
   remains Open.
2. **Windows is untested.** Decision 1.2 asserts that the same Node `net` API listens on a named pipe.
   **Not attempted:** no Windows host was available. The path-length limit measured in E5 is a Unix
   `sun_path` limit and does not apply to named pipes; the fallback in 1.4 is therefore Unix-only and
   the Windows naming scheme is undecided.
3. **Cross-user denial was not demonstrated.** E7 shows that the mode bits are enforced *for the
   owner*. **Not attempted:** proving that a *different* local user is refused needs a second account
   on this machine.
4. **Only one operating system was measured.** E5, E7 and E10 ran on macOS 26.6.2 only. Linux and
   other BSDs are **not attempted**; the `0700` directory is expected to be the portable half of the
   protection, and that expectation is untested here.
5. **The real bridge's startup cost is unmeasured.** E4 measured a 70-line prototype (median 20.9 ms)
   and the published CLI's `--version` path (~0.11–0.13 s). The cost of `xez mcp` under the actual
   entry-module graph is unknown until it exists.
6. **The service side is a stand-in.** `backend.mjs` answered from a socket; it is not
   `ProjectContext`, `RunManager`, `RunStore` or `WorkspaceSemaphore`. That the real service can
   create, own and serve one socket per project without blocking boot is **not attempted** — there is
   no implementation to test.
7. **Exclusive ownership is not implemented or tested.** F-18's second-client rejection, the fencing
   generation and the occupied-project error shape were not exercised. E10 measures only that a
   killed peer's `close` arrives immediately.
8. **Concurrency and volume are unmeasured.** One round trip took 1 ms (E3). Nothing was measured
   under parallel calls, large payloads or a long-lived event stream on the IPC leg. Any pagination
   or payload cap belongs to D-09 and none is proposed here.
9. **Claude Channels was not exercised.** Its stdio requirement is **read from official
   documentation** via the compatibility report, along with its research-preview eligibility
   constraints. Whether this machine's account is eligible is **not attempted**.
10. **Client behaviour was observed only in the modes examined.** `claude mcp list`, `opencode mcp
    list` and the Codex app-server path each spawn the server their own way. That all three spawn it
    with the session's project as cwd (E1–E3) is an observation about those commands, not a
    guarantee about every mode of every client — and § 4's cwd resolution depends on it.
11. **The bridge answered `-32601` to `resources/list` and stayed healthy in Codex (E3).** Whether
    Claude Code and OpenCode tolerate the same in a full interactive session, rather than in a health
    check, is **not attempted**.

## 11. Traceability

Covers **D-01**. Constrained by **F-17** (local only, all three clients required — no remote
transport is proposed and none is reachable from this design) and **N-07** (§ 5, measured in E6).
Inputs to, and explicitly not decisions on, **D-02** (§ 6, E10), **D-04** (§ 4), **D-05** (§ 1.10,
§ 3.7) and **D-09** (§ 8).

Requirements this record's mechanism is designed to serve, none of which it proves:
**F-01** and **F-16** (binding, § 6), **F-14**/**F-15** (§ 4 — nothing secret crosses the setup step),
**F-18**/**F-19** (§ 6, deferred), **N-09** (§ 6), **N-01** and **N-02** (the IPC leg calls shared
services through the existing project context, § 3.5).

Acceptance criteria this record touches without passing: **A-01** (connection provisioning and
one-time setup — § 4 measures the cost of the step, it does not run the criterion), **A-02** (the
binding shape is exercised at transport level only, E3), **A-16** (degradation, § 5, measured for the
client half in E6), **A-17**/**A-18** (untouched, D-02), **A-19**/**A-23** (untested, § 10.1).

Prototype code lives in `/tmp/d01-spike/` on the machine that produced these measurements and is not
committed. It is rebuildable from the commands quoted in § 2.
