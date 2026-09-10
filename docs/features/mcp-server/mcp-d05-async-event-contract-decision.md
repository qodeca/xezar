# D-05 — the async event and tool contract

Status: **decision record with executed evidence**. It closes the **Open** decision D-05 in section 10 of
[the MCP requirements contract](mcp-project-leader-requirements.md). It ships **no production surface**:
Phase 5 ([#72](https://github.com/qodeca/xezar/issues/72)) implements what is decided here.
Spike issue: [#82](https://github.com/qodeca/xezar/issues/82). Phase: [#69](https://github.com/qodeca/xezar/issues/69). Epic: [#67](https://github.com/qodeca/xezar/issues/67).

Date: **2026-09-10**. Repository revision the evidence was taken at:
`9fdcf0e878999783db6c2a69dec93a7d00ccea44`. Host: macOS 26.6.2, arm64, Node v24.20.0.

## How to read this document

The requirements contract distinguishes **Agreed**, **Technical proposal** and **Open**, and this record
preserves that split. Every substantive statement below is tagged:

| Tag | Meaning |
| --- | --- |
| **Agreed** | Already fixed by the requirements contract. Restated here for context; not reopened. |
| **Decided** | This spike closes it. It was Open before this document. |
| **Proposal** | Suggested here, still needs a decision by the issue named next to it. Not settled. |
| **Open** | Still has no decision, and this record does not make one. |

Evidence is labelled the same way the compatibility report labels it, with one addition this spike
earns:

| Label | Meaning |
| --- | --- |
| **Executed** | Run on this machine on 2026-09-10; the transcript is quoted or its measurement is printed below. |
| **Read from source** | Read in this repository at `9fdcf0e`, with file and line. |
| **Documentation only** | An official page says so; no local run confirms it. |
| **Not attempted** | Named, with the reason it was not run. |

“Should work” appears nowhere in this record. Absence claims are scoped to what was examined.

## 1. What is Agreed and is not reopened here

- **Agreed** — the significant-event catalog E-01–E-06 (requirements § 6). This record decides how such an
  event is identified, ordered, replayed and acknowledged; it does not add, remove or reinterpret a
  catalog row.
- **Agreed** — no model polling (F-20, N-06). Non-model heartbeat, transport reconnect, acknowledgements
  and bounded recovery are allowed.
- **Agreed** — F-20: a long operation returns acceptance plus an operation/task identifier promptly, and
  **delivery to an application and starting a model turn are separately verified outcomes**.
- **Agreed** — F-21: reconnect delivers outstanding significant events and current authoritative state.
- **Agreed** — requirements § 8: an unfiltered workspace stream must not reach MCP.
- **Agreed** — the delivery hierarchy of § 12: native mechanism first, official programmatic session
  interface second, terminal text only as a last fallback after runtime evidence. Every event identifies
  xezar as its source and never impersonates a user instruction or approval.

## 2. Evidence executed for this spike

All three required clients were driven against a throwaway stdio MCP probe server written for this spike.
The probe logged every JSON-RPC frame in both directions with a receive timestamp. **The probe and every
log stay out of this commit** — they lived under this task's scratch directory, outside the worktree.

Installed versions, read with `--version` on 2026-09-10 (**Executed**):

| Client | Version observed here | Version in the compatibility report (2026-09-08) |
| --- | --- | --- |
| Claude Code | **2.1.268** | 2.1.263 |
| Codex CLI | **0.154.0** | 0.153.4 |
| OpenCode | **1.18.30** | 1.18.29 |

The spike brief for #82 named Claude Code 2.1.267; the binary on this machine reported **2.1.268**. The
observed value is the one used throughout. All three are installed versions, not certified minimums.

Experiments run, in order:

| # | Experiment | Result section |
| --- | --- | --- |
| E1 | Live `initialize` handshake, per client, against the probe | § 3 |
| E2 | Real model turn per client calling one tool and echoing the returned operation id | § 3, § 8 |
| E3 | Unsolicited server→client notifications (`tools/list_changed`, `resources/updated`, `logging/message`) fired 400 ms after `initialized`, during a live turn | § 4 |
| E4 | The same three notifications fired **30 s after** `initialized`, at a genuinely **idle** OpenCode session held open by `opencode serve` | § 4 |
| E5 | Persisted-event density measured over the nine real task transcripts in this machine's `.local/xezar/runs/` | § 9 |
| E6 | Acceptance latency of the existing `POST /api/v1/runs`, n=12, `XEZ_DRY_RUN=1`, isolated `XEZ_HOME` | § 7, § 8 |
| E7 | Journal row size measured by serialising the envelope this record decides | § 8 |

## 3. What each required client actually negotiated

This is the acceptance criterion of #82. Every row is **Executed**. The `capabilities` column is the
client's own `initialize` `params.capabilities`, verbatim.

| Client | `protocolVersion` it asked for | Client capabilities it declared | Requests it issued after `initialized` |
| --- | --- | --- | --- |
| Claude Code 2.1.268 | `2025-11-25` | `{"roots":{"listChanged":true},"elicitation":{}}` | `tools/list`; then, in a real session only, `prompts/list` and `resources/list`; then `tools/call` |
| Codex CLI 0.154.0 | **`2025-06-18`** | `{"experimental":{"codex/auth-change":{}},"elicitation":{"form":{},"url":{}}}` | `tools/list` only; then `tools/call` |
| OpenCode 1.18.30 | `2025-11-25` | `{"roots":{}}` | `tools/list` only; then `tools/call` |

The probe advertised, on every connection, the full optional set the compatibility report warns about:
`tools.listChanged`, `resources.subscribe`, `resources.listChanged`, `prompts.listChanged`, `logging`,
`completions`, and an experimental `tasks` block declaring `tools/call` task support.

### 3.1 Transcripts

Claude Code 2.1.268, real session (`claude -p` with `--mcp-config --strict-mcp-config`, so nothing was
written to any configuration file). Timestamps are milliseconds since probe start.

```
2ms   client->server  {"method":"initialize","params":{"protocolVersion":"2025-11-25",
                       "capabilities":{"roots":{"listChanged":true},"elicitation":{}},
                       "clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.268",...}},
                       "jsonrpc":"2.0","id":0}
2ms   server->client  result.protocolVersion=2025-11-25, capabilities as above
16ms  client->server  {"jsonrpc":"2.0","method":"notifications/initialized"}
17ms  client->server  {"method":"tools/list","id":1}
17ms  client->server  {"method":"prompts/list","id":2}
17ms  client->server  {"method":"resources/list","id":3}
417ms server->client  notifications/tools/list_changed
417ms server->client  notifications/resources/updated {"uri":"xez://spike/project/events"}
417ms server->client  notifications/message {"level":"info",...}
423ms client->server  {"method":"tools/list","id":4}          <-- reaction to list_changed ONLY
4186ms client->server {"method":"tools/call","params":{"name":"xez_spike_start_long_operation",
                       "arguments":{"note":"hello"},
                       "_meta":{"claudecode/toolUseId":"toolu_...","progressToken":5}},"id":5}
4186ms server->client result: text "{\"accepted\":true,\"operationId\":\"xop_spike_0001\",\"status\":\"accepted\"}"
5350ms note           SIGINT   <-- the client tore the stdio server down at end of turn
```

The model's final answer was exactly `xop_spike_0001`.

Codex CLI 0.154.0, real session (`codex exec --approve-for-me`):

```
3ms    client->server {"jsonrpc":"2.0","id":0,"method":"initialize","params":{
                       "protocolVersion":"2025-06-18",
                       "capabilities":{"experimental":{"codex/auth-change":{}},
                                       "elicitation":{"form":{},"url":{}}},
                       "clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.154.0"}}}
5ms    client->server {"jsonrpc":"2.0","method":"notifications/initialized"}
5ms    client->server {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
407ms  server->client notifications/tools/list_changed
407ms  server->client notifications/resources/updated
407ms  server->client notifications/message
                      <-- NO client request follows any of the three
11498ms client->server tools/call, _meta carries callId, threadId, itemId, progressToken and
                       x-codex-turn-metadata {session_id, thread_id, turn_id, turn_started_at_unix_ms,
                       workspaces{...}, model, codex_version, sandbox, reasoning_effort}
11498ms server->client result: the same accepted/operationId payload
13336ms note          SIGTERM  <-- the client tore the stdio server down at end of turn
```

The model's final answer was exactly `xop_spike_0001`.

OpenCode 1.18.30, real session (`opencode run`):

```
2ms     client->server {"method":"initialize","params":{"protocolVersion":"2025-11-25",
                        "capabilities":{"roots":{}},
                        "clientInfo":{"name":"opencode","version":"1.18.30"}},"id":0}
9ms     client->server notifications/initialized
9ms     client->server {"method":"tools/list","id":1}
409ms   server->client the three notifications
557ms   client->server {"method":"tools/list","id":2}   <-- reaction to list_changed ONLY
13940ms client->server tools/call, _meta {"progressToken":3}
13940ms server->client result: the same accepted/operationId payload
14104ms client->server {"method":"notifications/cancelled","params":{"requestId":3,
                        "reason":"AbortError: The operation was aborted."}}
```

The model's final answer was exactly `xop_spike_0001`. Note the last line: OpenCode cancelled request `3`
**after** it had already received and used the result. A server must tolerate a cancellation for a request
it has already answered.

### 3.2 The four capabilities that were advertised and never taken up

**Executed**, and scoped to the handshakes run here: across all six connections (three health-check or
list connections and three real model turns), **no client sent `resources/subscribe`, no client sent a
`tasks/*` request, no client sent `logging/setLevel`, and no client sent `completion/complete`** — even
though the probe advertised `resources.subscribe`, an experimental `tasks` block, `logging` and
`completions` in every `initialize` result. Claude Code called `resources/list` once, in a real session
only, and never read or subscribed to the resource it was told about.

This is not proof that these features are impossible in these clients. It is proof that **advertising them
does not cause any of the three to use them**, which is the only thing the delivery design may depend on.

## 4. Do optional notifications wake a model? Executed answer: no

The compatibility report states that resource-update and list-change notifications carry protocol
information and do not prescribe an application's decision to run a model, and that progress and tool-list
changes must not be misused as task-completion prompts. That is the claim this spike tested directly.

**E3 — notifications during a live turn** (§ 3.1 transcripts): Claude Code and OpenCode each answered
`notifications/tools/list_changed` with exactly one `tools/list` refresh. Codex did not react at all.
None of the three reacted to `notifications/resources/updated` or to `notifications/message`.

**E4 — notifications at a genuinely idle session.** `opencode serve` was booted on `127.0.0.1:4399`, its
`/event` stream was recorded, one session was created and one short prompt was completed. The probe was
configured to fire its three notifications **30 s after** `initialized`, by which time the turn was long
over and the session was idle. Observed (**Executed**):

```
probe log:
  7ms      client->server tools/list (id 1)              <-- the turn's own tool discovery
  30008ms  note           firing unsolicited server notifications now
  30008ms  server->client notifications/tools/list_changed
  30009ms  server->client notifications/resources/updated
  30009ms  server->client notifications/message
  30010ms  client->server {"method":"tools/list","id":2}  <-- 2 ms later

opencode /event stream:
  data: {"type":"mcp.tools.changed","properties":{"server":"xez-probe"}}
  ... and nothing else. No message.updated, no assistant turn, no session activity.
```

So, at an idle session: the notification **was delivered**, it **did produce an application-level event**
(`mcp.tools.changed` on OpenCode's own `/event` feed), and it **did not start a model turn**. That is
delivery without reaction, in one observation — exactly the separation F-20 requires be verified
separately, and exactly the trap the report names.

Two further **Executed** facts from E4 that constrain any design:

- OpenCode connects a configured MCP server **lazily**. Between `opencode serve` starting and the first
  prompt, the probe process was never launched: for 45 s of a live server with an existing session, there
  was no MCP connection at all to notify. After the first turn the connection **stayed** open.
- Both non-interactive clients tore the stdio server down at end of turn — Claude Code sent SIGINT at
  5350 ms, Codex sent SIGTERM at 13336 ms. In `claude -p` and `codex exec` there is **no idle MCP
  connection in existence** to deliver an event over.

## 5. What the current repository already provides (read from source)

Every claim in this section is **Read from source** at `9fdcf0e`.

| Fact | Where |
| --- | --- |
| Event identity today is `(runId, seq)`. `seq` is allocated **per run**, not per project. | `packages/xezar/src/runs/store.ts:1330` (`nextSeq(runId)`) |
| After a restart the counter is rehydrated from the file's maximum `seq`, so numbers are never reused. | `packages/xezar/src/runs/store.ts:1341` (`rehydrateSeq`) |
| `emitEphemeral` allocates a `seq` and fans the event out **without writing it to disk**, so the persisted `seq` series may contain gaps by design; dedup compares with `>`. | `packages/xezar/src/runs/store.ts:1245` |
| The per-run SSE endpoint replays from NDJSON, buffers live events during replay, dedupes on `event.seq > maxSeq`, then sends an authoritative `run` snapshot, then a 15 s keepalive `ping`. It also honours `Last-Event-ID`. | `packages/xezar/src/server/server.ts:4650`, `:4663`–`:4715` |
| The “cursor too old” answer already exists and is a `409` with the message `history cursor is no longer valid — reload the newest page`; an unparseable cursor is a `400`. | `packages/xezar/src/runs/event-history.ts:51`, `:415`, `:631` |
| One protocol-level page is a fixed 100 items. | `packages/contract/src/events.ts:31` (`RUN_HISTORY_PAGE_ITEMS`) |
| `runEventSchema` is deliberately a `z.looseObject` with `type: string`, because the on-disk vocabulary is append-only and old recordings must keep replaying. | `packages/contract/src/events.ts:22` |
| The WebSocket bus is workspace-level and single-mount, never mirrored under `/api/v1/p/:projectId`; a topic is legible to an untrusted-but-admitted loopback connection only when its publisher sets `loopbackReadable`, which defaults to `false`. | `packages/xezar/src/server/ws.ts:28`, `:65`, `:230` |
| The hub's heartbeat is 30 000 ms and doubles as the reaper. | `packages/xezar/src/server/ws.ts:34` |
| Workspace-level SSE names are a closed set (`project-added`, `project-removed`, `checkout-progress`, `provider-status`, `automation-change`) carried only on `/api/v1/workspace/events`. | `packages/xezar/src/server/server.ts:498`–`:503` |

### 5.1 Source corrections to the two documents

Where a document and the source disagree, the source wins. Two corrections, both **Read from source**:

1. **There is no per-project event sequence in xezar today.** The compatibility report's proposal of “a
   project event journal with stable event IDs … and a replay cursor” cannot be satisfied by re-exposing
   the existing `seq`: it is per run (`store.ts:1330`). A leader event feed needs its own sequence. This
   record decides one; see § 6.1.
2. **A task's terminal status is not a persisted event type.** Status lives on the `RunRecord` and reaches
   the cockpit as the SSE `run` frame (`server.ts:4685`–`:4688`); the NDJSON carries `lifecycle` rows whose
   payload is human-readable text (`workflows/run.ts:1192`, `:2344`, `:2388`). E-01 therefore cannot be
   implemented by forwarding one event type — it must be **derived** from a status transition. This is the
   single largest piece of Phase 5 work implied by the catalog, and neither document says it.

## 6. Decisions

### 6.1 Event identity — **Decided**

The leader event feed is a **separate per-project journal**, not a re-broadcast of run NDJSON.

- Each journal row carries `journalSeq`: a **per-project, gapless, monotonically increasing integer**,
  assigned at append time by a single writer per project.
- The client-facing identity is the string `eventId = "<projectId>:<journalSeq>"`. Deduplication is on
  `eventId` alone. Nothing else — not `ts`, not a payload hash — is an identity.
- A row derived from a run event also carries `source: { runId, runSeq }`, so a leader can join a journal
  row back to the transcript it came from. `runSeq` is **provenance, never identity and never order**.

Why gapless, when the existing run `seq` is not: `emitEphemeral` (`store.ts:1245`) allocates numbers for
frames that never reach disk, so a gap in a run's persisted `seq` series means nothing and a client cannot
use it to detect loss. The journal must not inherit that property — a leader has to be able to say “I have
1..N and nothing is missing”. Only a durably appended row gets a `journalSeq`. This is a deliberate
divergence from the mechanism next door and is recorded as such so nobody later “fixes” it into
consistency.

Measured caveat (**Executed**, E5): across the nine real transcripts on this machine, persisted line count
equalled the maximum `seq` in every file (2061 of 2061), so **no gap was observed in this sample**. The gap
is a property of the code path, not of this sample. Both facts are recorded because a reader who checks
only the data would wrongly conclude the run `seq` is dense.

### 6.2 Ordering domains — **Decided**

**Exactly one ordering domain: the project.** `journalSeq` is a total order over everything the leader for
that project may see.

- Per-run ordering is a *derived* property: rows from one run appear in `journalSeq` order, which is their
  run order, because one writer appends per project.
- Reason a per-run domain was rejected: E-04, E-05 and E-06 are not run-scoped at all (a human changing the
  goal, a configuration change affecting execution, an executor-availability change). A leader that must
  decide “the human narrowed the goal, *then* task X finished” cannot get that from per-run sequences.
- `ts` is metadata and is **never** an ordering key. Two rows can share a millisecond, and a host clock can
  move.
- There is **no** cross-project ordering, and none is exposed. Requirements § 8 prohibits an unfiltered
  workspace stream reaching MCP, and one global sequence would be exactly that — its gaps would leak the
  existence and rate of other projects' activity (N-01).

### 6.3 What enters the journal — **Decided**

Only E-01–E-06. The row envelope (the shape measured in E7):

```json
{
  "journalSeq": 1048576,
  "ts": "2026-09-10T21:14:07.512Z",
  "projectId": "xezar",
  "category": "E-01",
  "kind": "task.terminal",
  "subject": { "type": "run", "id": "<runId>", "version": "<sha or revision token>" },
  "origin": "human",
  "causedBy": null,
  "summary": "task finished: failed at step gates (2 of 4)",
  "source": { "runId": "<runId>", "runSeq": 331 }
}
```

- `category` is the catalog row (E-01…E-06) and is closed. `kind` is a finer machine label and is open for
  additive growth, following the same append-only reasoning that makes `runEventSchema` a loose object
  (`contract/src/events.ts:22`).
- `origin` ∈ `human | leader | system`, and `causedBy` is the operation id of the leader operation that
  produced the row, or `null`. Together they are the echo-loop guard F-13 and the compatibility report both
  require: an adapter drops a row whose `causedBy` is its own outstanding operation **and** whose `origin`
  is `leader`. It does not drop a row merely because it recognises the run.
- `subject.version` is what makes N-03 stale-write rejection expressible and what A-10 means by “assessment
  revision is identifiable”. The exact version token is **D-06** ([#83](https://github.com/qodeca/xezar/issues/83)); this record only fixes that the field exists on
  every row and is carried through replay unchanged.
- The row carries a **summary, never a payload**. No diff, no transcript text, no file content, no token
  counter. A leader that wants the artefact calls a read tool, which is bounded and paginated (N-06).
- **Decided, negative:** `item.started` / `item.completed` / `tool-call` / `tool-result` / `text` /
  `token-usage` / `cost` never enter the journal. In the measured sample the four highest-volume of those
  types alone are **1848 of 2061** persisted events (§ 9), and requirements § 6 says presentation changes,
  log lines and token counters do not trigger leader reasoning.

### 6.4 Transport of the journal to the leader — **Decided**

- **The journal does not ride the cockpit WebSocket bus.** Topics on that hub are workspace-level and
  single-mount by construction (`ws.ts:28`), and the upgrade guard admits any loopback origin because WS has
  no CORS, so a topic must only carry data safe for any local page. A per-project leader feed is neither.
  Requirements § 8's prohibition on an unfiltered workspace stream reaching MCP settles it.
- If Phase 7 ([#74](https://github.com/qodeca/xezar/issues/74)) wants a live MCP-connection indicator in the cockpit, that **is** a topic on the
  existing hub — added as a topic, never as a second `new WebSocket` — and it must be left at the default
  `loopbackReadable: false` and must carry connection status only, never journal rows.
- The cockpit's own live update on MCP-caused change (F-13) needs **no new channel**: the existing
  per-project SSE stream already carries it, because MCP mutations go through the same shared services
  (N-02) and therefore through the same store events.
- The wire the leader's adapter reads the journal over is **D-01** ([#79](https://github.com/qodeca/xezar/issues/79)). This record fixes the *contract*,
  not the pipe.

### 6.5 Replay — **Decided**

- The cursor is opaque to the client and encodes `{ projectId, journalSeq, journalEpoch }`. `journalEpoch`
  changes whenever the journal is truncated or recreated, so a cursor from a previous journal is detected
  rather than silently mis-resolved.
- On reconnect the server replays **strictly greater than** the cursor's `journalSeq`, in `journalSeq`
  order, then delivers an authoritative current-state snapshot. This is the algorithm the run SSE endpoint
  already uses (`server.ts:4696`–`:4710`) — buffer live rows during replay, dedupe with `>`, then snapshot.
  It is adopted, not invented.
- A cursor older than retention gets an explicit **`cursor_too_old`** result carrying the oldest retained
  `journalSeq` and the current-state snapshot, so the gap is **stated**, not silently skipped. A-21 requires
  gaps be explicit and recoverable. The HTTP-side precedent for the same condition already exists and is a
  `409` (`event-history.ts:415`); the MCP-side mapping to a JSON-RPC or application error is **D-01/D-02**.
  This record does not name a code, because naming a made-up code as standard is what the report forbids.
- A malformed cursor is rejected, never treated as “start from zero”. Treating it as zero would replay the
  whole retention window into a model turn.
- Replay reads are bounded and paginated at **100 rows per call**, reusing `RUN_HISTORY_PAGE_ITEMS`
  (`contract/src/events.ts:31`) rather than introducing a second page size. See § 9 for what 100 rows costs.

### 6.6 Acknowledgements — **Decided**

Three cursors, recorded independently, because F-20 makes delivery and reaction separately verified
outcomes and A-19 says a notification in a log is not proof of reaction.

| Cursor | Advanced by | Meaning | Drives retention? |
| --- | --- | --- | --- |
| `deliveredSeq` | the adapter, non-model | the transport handed the row to the client process | no |
| `ackedSeq` | the leader, by an explicit tool call | the leader has durably taken the row into account | **yes** |
| `reactedSeq` | the adapter, non-model | a model turn carrying that row was actually started | no |

- The ack is **monotonic and idempotent**: an ack for a `journalSeq` at or below `ackedSeq` is a successful
  no-op, never a rewind and never an error. Re-delivery after a lost ack must be free.
- A rewind is a **different** request (“replay from cursor X”), never an ack with a smaller number. Making
  ack bidirectional is how a retry silently becomes a rollback.
- Delivery is **at-least-once**. The leader deduplicates on `eventId`. Exactly-once is not offered and must
  not be implied: A-15 and A-21 both require replay duplicates to cause no repeated effect, which is a
  property of the *consumer*, and N-10's operation-key idempotency is what makes that safe on the write
  side.
- `reactedSeq` lagging `deliveredSeq` is a **normal, reportable state**, not a fault. It is the honest state
  for a paused leader (requirements § 13, “Leader paused”) and for a client with no working adapter.
- **Executed**, this matters concretely: at the idle OpenCode session in E4, `deliveredSeq` would have
  advanced and `reactedSeq` would not have. A single-cursor design would have reported that event as
  handled.

### 6.7 Which MCP features are negotiated — **Decided**

Driven by § 3 and § 4, not by documentation.

| Feature | Decision | Basis |
| --- | --- | --- |
| `tools` | **Required.** The only capability the contract depends on. | Executed: all three clients called `tools/list` and completed a `tools/call` round trip |
| Protocol version | **Negotiate live.** Accept at least `2025-06-18` and `2025-11-25`; never assume a revision. | Executed: Codex 0.154.0 asked for **`2025-06-18`** |
| `resources` / `resources/subscribe` | **Advertised optionally; carries no contract meaning.** Nothing in the event contract may require a subscription. | Executed: no client subscribed in six connections; only Claude even listed resources |
| `tools.listChanged` | **May be advertised; must never carry event meaning.** | Executed: Claude and OpenCode re-list on it, Codex ignores it; and § 4 shows it does not start a turn |
| `logging` notifications | **Not used for significant events.** Diagnostics only, if at all. | Executed: no client reacted to `notifications/message` |
| Progress notifications | **Never a completion signal.** May be emitted for a long tool call as UI courtesy only. | Executed: all three clients supplied `_meta.progressToken` unprompted, so the temptation is real |
| MCP Tasks (experimental) | **Not depended on.** | Executed: no client issued a `tasks/*` request; and Codex's negotiated `2025-06-18` predates the revision the Tasks utility is specified in |
| `sampling` | **Not depended on.** Would be a second way to start a model turn. | Executed: no client declared it |
| `elicitation` | **Not depended on.** | Executed: Claude and Codex declare it, OpenCode does not — so it cannot be a requirement across the required set |
| `roots` | Recorded, unused by this contract. | Executed: Claude `{listChanged:true}`, OpenCode `{}`, Codex none |

The portable baseline the compatibility report *recommends* — a short ordinary tool result acknowledging a
xezar operation id, plus a reliable event adapter — is hereby **Decided as the required baseline**, on the
strength of § 3 and § 4 rather than on the recommendation.

### 6.8 The tool-call side of a long operation — **Decided**

A start mutation returns **promptly**, with an ordinary (non-error) tool result whose text block is a
compact JSON object:

```json
{
  "accepted": true,
  "operationId": "<durable operation identity>",
  "status": "accepted",
  "subject": { "type": "run", "id": "<runId>" },
  "journalSeq": 1048576,
  "expectedVersion": "<version token>"
}
```

- `status` is a closed set: `accepted | running | done | failed | cancelled | conflict | uncertain`. It
  matches N-05 (“accepted/running/terminal or explicit uncertain”) and the labels § 13 U-M07 asks the UI to
  show. **An acknowledgement is never reported as completed.**
- `journalSeq` is the journal position **at acceptance**. It is what lets a leader ask for “everything after
  the moment my operation was accepted” without guessing a timestamp.
- **The text block is authoritative.** `structuredContent` may be added when the negotiated revision
  supports it, but it may never be the only carrier: Codex negotiated `2025-06-18` here, and the acceptance
  contract must not depend on a field a required client's revision may not carry. This is a decision the
  live handshake forced.
- **A business conflict is not an `isError` result.** A stale-write rejection (N-03) comes back as
  `status: "conflict"` on a normal result, because clients render `isError: true` as a tool malfunction and
  the leader is required to *reason* about a conflict and read fresh state. `isError: true` stays for a
  genuine tool failure. The conflict payload itself is **D-06** ([#83](https://github.com/qodeca/xezar/issues/83)).
- The result is a **slim projection**. **Read from source**: today's `POST /api/v1/runs` answers with the
  whole `RunRecord` — 13 top-level keys including `steps` and `workflowDef` (**Executed**, E6). That shape
  must not become a tool result; it puts a workflow definition into a model's context on every start.
- **No polling tool is provided as the primary path.** A status read exists for *recovery* — after a lost
  response, per A-14 and N-10 — and the tool description must say so, because a status tool that reads as
  routine is how a model invents a polling loop that F-20 forbids.

### 6.9 Delivery and reaction per client — the honest state

**Decided** here: the contract above is satisfied by the tool half in all three clients (**Executed**,
§ 3). The reaction half is **not** decided here — the adapters are Phase 6
([#73](https://github.com/qodeca/xezar/issues/73)) — but this spike narrows what Phase 6 may assume.

| Client | Tool half (acceptance + operation id) | Native notification reaction | What Phase 6 must therefore build |
| --- | --- | --- | --- |
| Claude Code 2.1.268 | **Executed**: works, model echoed the operation id | **Executed**: `tools/list_changed` → one `tools/list`. No turn. No reaction to `resources/updated` or `message` | An adapter. Channels remains **Documentation only** and preview-gated; this spike did **not** attempt Channels (**Not attempted**: it needs a documented development opt-in or a distribution/organization eligibility this machine cannot be assumed to hold, and a failed eligibility test would prove nothing) |
| Codex CLI 0.154.0 | **Executed**: works, model echoed the operation id | **Executed**: no reaction to any of the three notifications | An adapter. **Executed and useful**: Codex sends `_meta.x-codex-turn-metadata` with `session_id`, `thread_id` and `turn_id` on every `tools/call`, so the server can learn the exact thread the leader is running in without inventing a handle |
| OpenCode 1.18.30 | **Executed**: works, model echoed the operation id | **Executed**: `tools/list_changed` → one `tools/list` **and** an `mcp.tools.changed` row on `/event`. No turn, even at a 30 s-idle session | An adapter. **Executed**: the connection survives a turn and `/event` is observable, so this is the one client where the delivery half was proven at an idle session on this machine |

Two constraints this places on Phase 6, both **Executed**:

1. In `claude -p` and `codex exec` the stdio server is killed at end of turn (SIGINT at 5350 ms, SIGTERM at
   13336 ms). An adapter that assumes a long-lived MCP connection in those modes has no connection.
2. OpenCode connects MCP lazily — 45 s of a live `opencode serve` with an open session produced no MCP
   process at all until the first prompt. “The server is running” is not “the leader is reachable”.

## 7. Acceptance is prompt — measured, not assumed

**Executed** (E6). The existing `POST /api/v1/runs` was called 12 times against a xezar booted from
`packages/xezar/dist` with `XEZ_DRY_RUN=1`, an isolated `XEZ_HOME`, and a throwaway git repository, with
`worktree: false`:

```
n=12   min 3.5 ms   median 9.4 ms   p95 42.6 ms   max 42.6 ms
all: 3.5 4.2 4.5 5.2 5.7 5.7 9.4 10.0 10.2 12.6 20.1 42.6
first response: HTTP 201, status "queued", 13 top-level keys
```

So the acceptance half of F-20 is already a property of the current server: it returns an identifier and a
non-terminal status in single-digit to low-tens milliseconds. The MCP layer adds a projection, not a wait.
The number this justifies is in § 9.

## 8. Numbers decided here, and the experiment behind each

Requirements N-06 and D-09 leave mechanisms and numeric limits to engineering. Each number below is decided
with its basis. **A number with nothing behind it is not allowed, and none appears here.** Where
[#84](https://github.com/qodeca/xezar/issues/84) (D-09, operational limits and packaging) sets a workspace-wide bound that is smaller, **the smaller
bound wins** and this record does not override it.

| # | Value | Decided as | Experiment / reasoning |
| --- | --- | --- | --- |
| N1 | **Journal retention: 10 000 rows per project, and never less than 14 days** | Decided | E5 + E7. Measured 13.9 significant-candidate events per real task (125 over nine transcripts). 10 000 rows ≈ **719 tasks** of leader-visible history. E7 measured the § 6.3 envelope at **399 bytes**, so full retention is **3.81 MiB per project** — less than the **4.80 MiB** of transcript bytes those nine tasks already occupy on this machine. The day floor exists because a project that runs one task a week would otherwise never age a row out, and A-21 requires retention be documented from design |
| N2 | **Journal page: 100 rows per read** | Decided | Reuses `RUN_HISTORY_PAGE_ITEMS` (`contract/src/events.ts:31`) rather than adding a second page size. At the measured 399 bytes/row that is **≈ 39 KB** per page — one comfortable MCP message |
| N3 | **No coalescing window for E-01–E-06** | Decided | E5. At 13.9 significant rows per task there is no volume to save, and coalescing is exactly what would merge “human answered” with “human then cancelled” into one row. The volume that *would* need coalescing — 479 `item.started`, 478 `item.completed`, 446 `tool-call`, 445 `tool-result` — is precisely what § 6.3 keeps out of the journal |
| N4 | **The delivered cursor is persisted per row, not batched** | Decided | E5, same measurement: at ~14 rows per task, batching buys nothing measurable and costs a lost-events window on every crash |
| N5 | **Acceptance budget: p95 ≤ 250 ms, hard ceiling 2 000 ms** | Decided | E6. Measured p95 of the real acceptance path is **42.6 ms** — 5.9× headroom to the budget and 47× to the ceiling. The budget is a regression alarm on a path that is already fast, not an aspiration |
| N6 | **Liveness: MCP `ping` at 30 000 ms** | Decided | Reuses the hub's existing `HEARTBEAT_MS` (`ws.ts:34`) instead of inventing a cadence. Protocol `ping` needs no model turn, which is what N-06 permits |
| N7 | **Journal SSE-style keepalive: 15 000 ms**, if the chosen transport is a stream | Decided, conditional on D-01 | Reuses the run-stream keepalive (`server.ts:4714`). Conditional because D-01 ([#79](https://github.com/qodeca/xezar/issues/79)) owns the transport |

Not decided here, and deliberately: **lease, fencing and occupancy timeouts** (D-02, [#80](https://github.com/qodeca/xezar/issues/80)), **operation-key
retention and collision** (D-06, [#83](https://github.com/qodeca/xezar/issues/83)), **audit retention** (D-06), **packaging and workspace-wide operational
bounds** (D-09, [#84](https://github.com/qodeca/xezar/issues/84)).

## 9. Measured event mix (E5)

Read-only pass over the nine real task transcripts in this machine's `.local/xezar/runs/`, 2061 persisted
events, 5 037 813 bytes (**Executed**):

| Type | Count | In the journal? |
| --- | --- | --- |
| `item.started` | 479 | no |
| `item.completed` | 478 | no |
| `tool-call` | 446 | no |
| `tool-result` | 445 | no |
| `note` | 48 | only when it is an E-02/E-04 row |
| `step-start` | 38 | no |
| `text` | 33 | no |
| `step-end` | 29 | candidate for E-03 |
| `check-output` | 28 | no |
| `lifecycle` | 10 | candidate for E-01 |
| `session.started` / `turn.started` | 9 / 9 | no |
| `done`, `session.ended`, `turn.completed`, `turn-end` | 2, 2, 1, 1 | candidate for E-01 |
| `usage.updated`, `token-usage`, `cost` | 1 each | no — § 6 excludes token counters explicitly |

Mean 229 persisted events per task; mean 2444 bytes per persisted event. Significant candidates: 125, or
**6.1 %** of the stream. The other 93.9 % is what an unfiltered feed would put into a model's context.

## 10. What is still unverified

Stated as required by #82's acceptance criterion. Each item names why.

1. **A model turn started by a xezar event, in any of the three clients.** **Not attempted as a full
   loop** — that is the Phase 6 adapter ([#73](https://github.com/qodeca/xezar/issues/73)). What *was* executed is the negative half: at an idle
   session, an optional MCP notification is delivered and starts no turn (§ 4).
2. **Claude Channels.** **Not attempted.** It is a research preview whose custom channels need a documented
   development opt-in or permitted distribution/organization configuration; ordinary installation is not
   proof of eligibility, and a failure here would not distinguish “not eligible” from “does not work”.
   Everything this record says about Channels is **Documentation only**, inherited from the compatibility
   report.
3. **Codex app-server `turn/start` / `thread/resume` / `turn/steer` as a reaction path.** **Not attempted**
   here. The *input* it needs was proven available: Codex hands the server `session_id`, `thread_id` and
   `turn_id` on every `tools/call` (**Executed**, § 3.1). Whether those handles drive a turn is Phase 6.
4. **OpenCode `POST /session/:id/prompt_async` as a reaction path.** Partially executed: the route was used
   in E4 to drive a turn from outside the client, and it worked. That it can be driven **by a xezar event
   without impersonating the user** is not proven and is Phase 6's obligation, including § 12's rule that
   every event identifies xezar as its source.
5. **Behaviour across a xezar restart with a live leader.** **Not attempted.** The journal's epoch field
   (§ 6.5) is designed for it; nothing here tests it.
6. **Two logical clients racing the same journal.** **Not attempted** — ownership is D-02 ([#80](https://github.com/qodeca/xezar/issues/80)).
7. **Whether any of the three clients would use `resources/subscribe` or MCP Tasks in configurations not
   exercised here.** Not established either way. The claim made in § 3.2 is scoped to the six connections
   executed: none used them.
8. **Interactive-mode lifetimes.** The SIGINT/SIGTERM observations in § 4 are from `claude -p` and
   `codex exec`. The interactive TUIs were **Not attempted** — they cannot be driven non-interactively from
   this task.
9. **The E-01–E-06 derivation rules themselves.** § 5.1 establishes that E-01 must be derived from a status
   transition rather than forwarded from an event type. The precise mapping from every status transition
   and human action to a `category`/`kind` pair is Phase 5 implementation work, not settled here.

## 11. Incidental findings from running the experiments

Recorded because they cost time to discover and are **Executed**, not because D-05 depends on them.

- `codex mcp add` / `codex mcp list` in Codex 0.154.0 did **not** honour a `CODEX_HOME` pointing at an empty
  sandbox directory: the added server appeared in the default listing, alongside the operator's existing
  entry, and the sandbox directory stayed empty. A running app-server daemon (`~/.codex/ipc/ipc.sock`,
  started by the desktop application) owns that registration. The spike's entry was removed afterwards and
  the removal was verified. Anyone isolating Codex configuration for a test should not assume `CODEX_HOME`
  covers the MCP registry.
- Codex's `tools/call` `_meta.x-codex-turn-metadata` includes a `workspaces` map with the repository path,
  its `origin` remote URL and the latest commit hash. Any MCP server a Codex user connects receives that.
  It is not a xezar leak and changes nothing here, but a reviewer of the eventual server should know the
  field arrives.
- OpenCode's `/event` stream emits `server.heartbeat` on its own cadence (14 beats over the observation
  window) — an existing precedent for the non-model heartbeat N-06 permits.

## 12. Traceability

Covers **D-05**, and the parts of **F-20**, **F-21**, **N-06** and **E-01–E-06** that concern event
identity, ordering, replay, acknowledgement, negotiated features and the acceptance shape of a long
operation. Contributes evidence to **A-15**, **A-19**, **A-20**, **A-21** and **A-23**; passes none of them
— A-19 and A-23 require a real model reaction, which § 10 records as unverified.

Boundaries, so no peer spike is contradicted: transport and bridge are **D-01** ([#79](https://github.com/qodeca/xezar/issues/79)); session binding,
liveness and occupancy are **D-02** ([#80](https://github.com/qodeca/xezar/issues/80)); the connection file and one-time client setup are **D-04**
([#81](https://github.com/qodeca/xezar/issues/81)); version checks, durable operation keys and audit retention are **D-06** ([#83](https://github.com/qodeca/xezar/issues/83)); operational limits,
retention bounds and packaging are **D-09** ([#84](https://github.com/qodeca/xezar/issues/84)); the twelve required client behaviours are
[#85](https://github.com/qodeca/xezar/issues/85). **Tool names are not assigned here** — requirements § 11 reserves that for the implementation
specification, and the placeholder used in the transcripts above
(`xez_spike_start_long_operation`) belongs to the throwaway probe, not to xezar.
