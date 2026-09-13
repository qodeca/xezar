# Codex: waking an existing leader session

Decision date: **2026-09-13**. Part of [#374](https://github.com/qodeca/xezar/issues/374)
and [#73](https://github.com/qodeca/xezar/issues/73). Source revision:
`85a8e953573efac13091258e06968986fd5b117f`. Installed client: **codex-cli 0.154.0**,
macOS 26.6.2, arm64. This is a research decision, not a shipped connection feature or
an A-19/A-23 pass.

## Decision

**Go for attaching to a leader already running on Codex's shared local app-server.**
A second process connected through `codex app-server proxy`, found the TUI's live
thread by project cwd, resumed that same loaded thread and sent `turn/start`.
The existing TUI displayed the response. The final measurement recorded **one model
request caused by the event, zero additional requests in a 30-second quiet window**.
The endpoint was scripted; no personal account or real model was used.

The qualification matters: **plain `codex` joins an existing local listener, but did
not create that listener in the fresh npm installation tested here.** Managed
`app-server daemon start` refused because the isolated home lacked the standalone
installation it requires. xezar must discover an existing reachable session; it must
not install a daemon, launch a replacement leader, or resume a saved thread into a
second server merely to make attachment succeed. A missing listener keeps today's
working `leader_events` pull path.

`codex queue` is another executed wake path, including without a shared listener.
It is not selected for the first implementation: this probe established delayed
consumption, but not a correlated live reaction subscription, cancellation, or safe
reconciliation after ambiguous queue acceptance. It remains a programmatic fallback
candidate, not evidence that terminal injection is necessary.

## Delivery hierarchy and prior evidence

| Approved rung | Evidence and decision |
| --- | --- |
| Native event mechanism that demonstrably causes a turn | Generic MCP notifications remain rejected as a wake mechanism. [D-05 §4](mcp-d05-async-event-contract-decision.md#4-do-optional-notifications-wake-a-model-executed-answer-no) measured delivery without model reaction. That dated measurement was read, not rerun here. No new native MCP wake capability was established. |
| Official programmatic session interface | **Selected:** app-server over its existing Unix control socket, with `thread/resume` and `turn/start`. `queue --thread … --message …` also woke an ordinary TUI, but lacks the qualified observation/recovery path needed for this implementation. |
| Terminal text, last resort only with proof | Refused. The fixture used its own PTY, supplied the initial prompt as an argv argument, and answered terminal capability queries. It typed no event, approval, or shell command. Nothing touched the user's terminal. |

The [pi extension](pi-leader-extension.md) establishes the relevant pattern: a path
into the running client plus a separately observed reaction. Codex already exposes
that path when its shared server exists; it needs no pi-style extension in that case.
The [older Codex evidence](mcp-adapter-evidence-codex.md) remains dated evidence:
its owned-process spawn path was removed, and its X9 socket handshake was incomplete.
The successful WebSocket handshake below resolves that transport question, without
restoring process spawning.

## Executed environment and isolation

Both `codex --version` on PATH and the directly invoked npm CLI returned
`codex-cli 0.154.0`. The PATH entry is `/Users/marcinobel/.codex-cli/bin/codex`:
its wrapper hard-sets `CODEX_HOME=/Users/marcinobel/.codex-cli` and unsets
`CODEX_SQLITE_HOME`. Probes bypassed it using:

```text
/Users/marcinobel/.nvm/versions/node/v24.20.0/bin/codex
```

Every child received an explicit environment allowlist: PATH, a fresh HOME,
CODEX_HOME, TERM and a task-specific TMPDIR. No account environment variables or
credentials were copied. The custom provider used `requires_openai_auth = false`,
`wire_api = "responses"`, `supports_websockets = false`, model `scripted`, and a
Python HTTP server bound to `127.0.0.1` on an allocated port. Approval policy was
`never`; sandbox mode was `read-only`. The endpoint streamed a fixed Responses API
answer and saved every POST body, following the request-counting approach in
`packages/xezar/test/integration/mcp-real-clients.test.ts`.

Isolation was checked, not inferred from the environment:

- Successful app-server `initialize` replies named the exact isolated CODEX_HOME.
  Final run H returned `/Users/marcinobel/Projects/xezar/.local/cd-dfc69665h`.
- An evidence-directory CODEX_HOME, even through a short symlink, failed with
  `path must be shorter than SUN_LEN`: Codex canonicalizes the path. Short, real
  directories under the primary project's ignored `.local/` held disposable homes;
  transcripts, fixture scripts and counts remain under the durable run directory.
- Early A–G fixture directories were nested under the source repository. D's daemon
  stderr recorded an inherited MCP connection teardown, so those runs do **not**
  establish MCP isolation. H created its own Git root first and observed
  `mcpServerStatus/list → {data: [], nextCursor: null}`. H is the acceptance measurement.
- No probe was directed at the developer's real `~/.codex` or `~/.codex-cli` state.
  No auth file or personal configuration was copied. No real-account turns ran.
- The socket actually measured was
  `$CODEX_HOME/app-server-control/app-server-control.sock`. The older dogfooding
  observation of `~/.codex/ipc/ipc.sock` is not a discovery contract for this run.
  Do not scan or mutate that historical path on the assumption that it is equivalent.

## Protocol, discovery and measurements

Method and parameter names came from the installed binary:

```sh
"$CODEX_BIN" app-server generate-json-schema --experimental --out "$E/schema"
"$CODEX_BIN" --help
"$CODEX_BIN" app-server --help
"$CODEX_BIN" app-server daemon --help
"$CODEX_BIN" app-server proxy --help
"$CODEX_BIN" queue --help
```

`E` is the evidence directory specified below; `CODEX_BIN` is the npm entry above.
Generated schemas include `ThreadListParams`, `ThreadLoadedListParams`,
`ThreadResumeParams`, `TurnStartParams`, `TurnSteerParams` and `ThreadSetNameParams`.
They establish exact cwd filtering, loaded-thread enumeration, the required
`expectedTurnId` on steer, and `clientUserMessageId` correlation.

The [official app-server protocol documentation](https://learn.chatgpt.com/docs/app-server#protocol),
opened on the measurement date, supplied the missing transport detail: Unix sockets
use an HTTP WebSocket Upgrade, not newline-delimited JSON. **`proxy` forwards bytes;
it does not translate stdio JSONL into WebSocket frames.** Run D's JSONL handshake
therefore timed out. Runs E–H sent an HTTP Upgrade and masked WebSocket text frames
through the same proxy and received `101 Switching Protocols`, then initialized.
The generated RPC schemas and executed frames, rather than undocumented method
names, define this decision.

### Experiment ledger

| Run | Executed setup | Observation |
| --- | --- | --- |
| A | Fresh home; ordinary interactive TUI; proxy | Initial turn and title request completed. No managed control socket; proxy failed. |
| B | `app-server daemon start` before ordinary TUI | Managed startup refused: standalone install missing under the fresh home. No installation was attempted. |
| C | Ordinary TUI; separate stdio app-server lists persisted threads; `codex queue` targets that UUID | Listing found the thread, but `thread/loaded/list` on the separate server was empty. Queue acknowledged, then the **original TUI** made an event request at 10.201 s, approximately 6.5 s after enqueue, followed by a title request. No `thread/resume` was sent to that separate server. |
| D | Explicit local `app-server --listen unix://`; plain TUI; proxy with incorrect JSONL framing | `daemon version` reported a running 0.154.0 server; handshake timed out. Harness failure, not evidence that the socket is unusable. |
| E | Same setup, corrected WebSocket framing | Plain TUI's thread was already loaded on the shared server. External resume/start reached that TUI. Two event-associated POSTs: one leader response and one title request; zero further POSTs in 10 s. |
| F | TUI explicitly uses `--remote unix://` | Same successful shared-thread delivery and title overhead as E. |
| G | Plain TUI, thread explicitly named before delivery | One event POST, no new title POST, zero further POSTs in 30 s. |
| **H** | G plus separate Git root, empty MCP registry, 10 s baseline, targeting refusals | **One event POST, zero further POSTs in 30 s; visible response in the original TUI.** Wrong cwd returned no thread; stale steer and unknown thread were refused without another POST. |

A named thread is an explicit fixture condition, **not** a production instruction to
rename the user's session. Unnamed/default sessions in E/F incurred an additional
Codex title-generation request. Do not hide that request from total-cost accounting,
mislabel it as model polling, or claim the exact one-total-request result for all
sessions. C's prematurely started “quiet-window” overlaps delayed queue consumption;
it is not a passing quiet-window measurement.

### Final run H: exact command and transcript excerpts

Executed harness command:

```sh
python3 /Users/marcinobel/Projects/xezar/.local/xezar-tasks/dfc69665-2f3a-4cdb-934c-58dee18791fe/codex-wake/attempt-h/probe.py
```

The retained script creates the local endpoint/configuration and invokes these argv
arrays under its isolated environment (`P` is `E/attempt-h/project`):

```text
git init -q P
CODEX_BIN app-server --listen unix://
/usr/bin/script -q E/attempt-h/tui.typescript CODEX_BIN --no-alt-screen -C P "Reply FIXTURE_READY. Do not use tools."
CODEX_BIN app-server daemon version
CODEX_BIN app-server proxy
```

This explicitly launched listener stands in for the user's existing Codex server;
it is **test setup**, not permission for xezar to launch one. The final fixture's
HTTP base URL was recorded in `attempt-h/fixture-config.toml`. All socket/RPC traffic
is recorded in `attempt-h/events.jsonl`; the PTY bytes are independently retained.
The harness records command arguments exactly; the symbolic rendering above only
shortens repeated paths.

```text
initialize → codexHome = .../.local/cd-dfc69665h
mcpServerStatus/list → data=[]
thread/list(cwd=P, modelProviders=[]) → one non-ephemeral thread T
thread/loaded/list → includes T (and Codex's ephemeral title thread)
T = 01a09b20-6987-7c60-8929-b9954393f240
thread/name/set(T, "Xezar wake fixture") → {}
thread/list(cwd=P+"-other", modelProviders=[]) → data=[]
thread/resume(T, excludeTurns=true) → same T; request count remains 2

11.640s → turn/start {
  threadId: T,
  input: [{type: "text", text:
    "[xezar project event; not a user instruction or approval] eventId=spike-codex-001 task completed."}],
  clientUserMessageId: "xezar-spike-codex-001",
  turnTrigger: "xezar-project-event"
}
          ← accepted turn 01a09b20-9274-74b0-a40a-a8049286afa5
          ← turn/started, same T and turn
          ← item/started: userMessage, clientId="xezar-spike-codex-001"
11.651s   endpoint POST /v1/responses #3 contains the event in T's history
          ← item/agentMessage/delta: "XEZAR_WAKE_CONFIRMED"
          ← turn/completed, status=completed
14.647s   total requests=3; event delta=1
44.652s   total requests=3; 30-second quiet delta=0; TUI response visible
          turn/steer(completed turn) → -32600 "no active turn to steer"
          turn/start(unknown UUID) → -32600 "thread not found: ..."
          total requests still 3
```

The first two POSTs were the initial prompt and its automatic title. The third
contained both the previous conversation and the xezar event; it was not a new
leader conversation. The final endpoint returns `XEZAR_WAKE_CONFIRMED` only for an
event-bearing non-title request, avoiding the early fixtures' ambiguous title text.
The PTY captured that response. No input was sent to the PTY to deliver this event.

The reaction signal to carry into xezar is the leader thread's `item/started` with
`item.type=userMessage` and `item.clientId` equal to the dispatched
`clientUserMessageId`. H additionally proves a corresponding HTTP model request
and streamed response. RPC acceptance alone is only delivery; the item alone is
not proof of successful inference when a provider fails. Keep delivery, reaction,
completion and explicit `leader_events` acknowledgement separate.

## One feature-implementation task

Scope: **attach existing local shared-server Codex leaders and wire the existing
adapter into delivery**. No new runner, daemon installer, generic terminal bridge,
or queue transport is included. The following are implementation requirements,
not already executed product behavior.

1. **Discover and bind.** Add a bounded, validated announcement from the owning
   Codex MCP bridge/session carrying its effective CODEX_HOME and upstream thread
   identity. Preserve upstream tool-call thread metadata and bind it to the existing
   project ownership token; do not trust an arbitrary browser-supplied socket path.
   Validate the control socket's owner/private parent and local transport. Confirm
   `initialize.codexHome`, then intersect cwd-filtered `thread/list` with
   `thread/loaded/list` and the owning session's thread id. Canonical project paths
   must agree. Reject absent, stale or ambiguous matches; cwd alone is insufficient
   when two sessions share a project. Prove metadata propagation through the real
   bridge in the implementation tests; this spike used a single isolated candidate.
2. **Connect without spawning.** Implement a `CodexAppServerLink` using the existing
   `ws` dependency over a Unix socket, with the measured Upgrade/framing. A proxy
   subprocess was useful evidence; direct socket access avoids making xezar manage
   another process. Bound handshake/request timeouts, cap frames, handle ping/close,
   and dispose only xezar's link. Resume **only a verified loaded** thread to subscribe
   with `excludeTurns:true`, without changing its model, instructions or permissions.
3. **Wire the actual product path.** Add the `codex` attach variant and session enum
   member in `packages/contract/src/mcp-leader.ts`, with types inferred from Zod.
   Add a `LeaderDelivery.#act` branch that constructs `codexReactionTarget` from the
   discovered link/thread, preserves a working attachment on refusal, connects
   `onReaction` to the existing controller, and wakes that controller. Extend
   `CLIENT_WORDS`, capability/setup presentation, API parity and typed-body coverage.
   The current adapter is imported only by its test; merely adding another helper
   would repeat the original integration gap.
4. **Preserve safety and recovery.** Seed busy/prompt state when attaching; observation
   starting after an approval opened must not read as “no approval”. Do not answer
   approvals. Defer events while a prompt is open; use guarded steer only after the
   active-turn behavior is qualified. Refuse or defer uncertain state. Persist/reconcile
   event and client-message identities across reconnects before retrying ambiguous
   acceptance; a `clientUserMessageId` is correlation, not proven server idempotency.
   Reuse fencing, exclusive project ownership, echo filtering and journal replay.
   Never resurrect an unloaded thread to deliver pending events.
5. **Connection screen.** Attach is the user's opt-in to event-triggered model work.
   Discover the existing session without asking for paths, ports or a configuration
   file. Proposed connected copy: **“Codex connected. Project events can start a turn
   in your current session.”** With no reachable shared session, show verbatim:
   **“xezar cannot reach this running Codex session for project-event delivery. Your
   events are saved. Use leader_events in Codex to read them; retry connecting when
   this session is available on Codex's local app-server.”** Do not make boot depend
   on Codex or instruct users to manage a daemon as mandatory xezar setup. Hosted
   mode must not dial local-machine sockets.

| Acceptance criterion for that task | Verification and DoD mapping |
| --- | --- |
| Existing TUI, owning MCP session and exact project bind; another project/session is rejected without losing the current attachment | Real bridge metadata/daemon discovery integration test, including multiple matching cwd sessions, missing/wrong home, missing socket and saved-but-unloaded thread. **A-23 setup and exclusivity.** |
| A real project completion event traverses journal → controller → new `#act` branch → existing Codex TUI | Real service/bridge/TUI harness with request bodies and correlated notifications, not a hand-written `turn/start` alone. Named fixture: one event request and zero subsequent requests for at least 30 s. Include default-title accounting separately. **A-19 F2/F3; A-23 reaction.** |
| Busy, approval and disconnect boundaries neither lose nor duplicate events | Active steer, wrong expected turn, prompt already open at attach, provider failure, lost acceptance response, reconnect/replay, expiry/fencing, duplicate event and own-operation echo tests. Count model requests; prove meaningful regressions red without the fix. **A-19 reaction/recovery; A-23 exclusive owner.** |
| Recoverable missing capability and resource cleanup | Missing daemon/npm-only installation, readonly home, socket permission failure, Stop, TUI exit and daemon exit preserve journal/pull behavior and close only xezar resources. No event or heartbeat causes model polling. **A-19 idle behavior; A-23 usable setup.** |
| Actual model behavior and release-wide status are reported honestly | Follow the [DoD record](mcp-definition-of-done-record.md): a scripted endpoint proves a turn/request, not a real model's decision. The real-model clause and same-candidate cross-client A-23 remain pending until separately executed with authorized routing. This Codex slice cannot close #374 or #73. |

Active-turn/approval routing across multiple app-server clients, live ownership
metadata discovery, replay after an ambiguous send, Linux/Windows behavior, and a
real model's reaction were **not verified by this spike**. These are explicit
acceptance work within the feature task, not grounds to advertise unconditional
Codex support now. The installed protocol remains experimental; 0.154.0 is the
measured version, not a certified minimum.

## Evidence retention, ownership and validation

Durable evidence root, resolved using `.xezar/checks/lib/common.sh`:

```text
/Users/marcinobel/Projects/xezar/.local/xezar-tasks/dfc69665-2f3a-4cdb-934c-58dee18791fe/codex-wake/
```

The excerpts and decisions above are self-contained; these private locators support
local audit and are not required to read the maintained document. `SHA256SUMS` covers
the generated schema, all retained probe scripts, configs, request bodies and
transcripts. Failed attempts remain evidence. A's script/transcripts were moved into
`attempt-a/` after execution; its logged original command path is preserved. Short
runtime homes are disposable and are not the evidence archive.

| Evidence relative to that root | SHA-256 |
| --- | --- |
| `SHA256SUMS` | `518726596e503c2dfba3acae1b6463cf1ff54f8909591a9971c76a73218913b4` |
| `attempt-h/probe.py` | `bed5568bd364ffbf1c1844a56478cc4b90a07891e51984b916a2762a91d7ead6` |
| `attempt-h/events.jsonl` | `19df4f27814290ece80ebabf9260d6947bb295a7c76d9cdb0228461a5b9bec6d` |
| `attempt-h/pty.raw` | `cfd52c7ea78e5abf91b5f940cb13eed17c0ad46b498a8bb645d27f2644d8779a` |
| `attempt-h/request-3.json` | `f03a4e97c8d5d2267ec066939aa3cdd14f1d289ac5a53dd69e061b61dbeb01c3` |
| `attempt-h/summary.json` | `1619bc6236acc95c02c5ff400f129ca7b54bf24d064a62b28b91ed4a966c7415` |
| `attempt-c/events.jsonl` | `4e54214f313c63236c8e5c064a2652a96834f8a0719a6c758bef6da415a266bb` |
| `attempt-e/events.jsonl` | `7ed5744c6293041246cdcb6b5945956d4b99c70b34c7b4145fbe0a6bbb89b42c` |

Installed docs-maintenance skill SHA-256:
`00a85d0dcf4b82ba275b2cf1eeb6717de7909a1de5d9497f85c3f9ddefc300b8`;
OpenAI Docs skill: `aa6829e21df2223167c85d2e49b6337a7345c84c1033f1ec10182c7882b36d45`.
No predecessor checkpoint or repair attempt was present in the initial task evidence;
`XEZ_HANDOFF_FILE` was unset. This is the **Update docs** stage. Focused validation
checks this record's links, evidence hashes, request counts and diff. Full gates,
sealing and the draft PR belong to the subsequent workflow stages; the PR body must
say `Part of #374` and `Part of #73`, not closing keywords.

Dogfooding observations, at the evidence levels required by `.xezar/docs/dogfooding.md`:
**observed** wrapper override and Unix path-length failure; **real-client/fixture-tested**
WebSocket proxy wake and title overhead; **unknown** managed standalone bootstrap
and real-model behavior. Checking the transport's framing resolved a prior apparent
capability blocker. Checking the total POSTs prevented title work from being hidden
inside a claimed one-request measurement. Only this decision record is a maintained
source change; generated README ownership, peer decisions and project policy files
are untouched. Probe children were stopped by saved process handles, and no remaining
probe TUI process was found at cleanup; no command-line-pattern kill was used.
