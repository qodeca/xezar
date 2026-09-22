# AGENT_PROTOCOL.md — the xezar agent protocol

xezar runs coding-agent CLIs behind **one backend-agnostic seam** and renders
every backend through **one normalized event vocabulary**. This document is the
operational contract for that seam: what a runner must implement, what it must
emit, how the emissions are tested, and what a *new* runner (e.g. `pi`, pre-rename PR 387)
has to satisfy to be a first-class backend rather than a second-class one. `pi`
(pre-rename PR 387) was the last one added, and §9 is its worked example.

It is the concise, load-bearing contract. The code
in `packages/xezar/src/core/` implements it; this file cites the code. When the two
disagree, **the code wins** — the golden fixtures and the parity test are
executable, the prose is not.

The protocol has **two layers that ship together**:

- **v1 `AgentEvent`** — the original flat stream. Persisted in old NDJSON
  recordings and still consumed by `xezar run`'s console renderer. Never
  removed; old recordings must keep replaying forever.
- **v2 `UiEvent`** — the normalized, item-lifecycle protocol the redesigned
  cockpit renders. Emitted **alongside** v1, never replacing it. A mixed NDJSON
  file (v1 + v2 lines) is valid by design.

---

## 1. The runner seam (`packages/xezar/src/core/agent-runner.ts`)

Every backend is one class implementing `AgentRunner`, constructed through the
single factory `createRunner(backend)` in `packages/xezar/src/core/runner-factory.ts`. Nothing
outside `packages/xezar/src/core/` should ever `new` a concrete runner or branch on the backend
id — that is the whole point of the seam.

### Identity

```ts
const RUNNER_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;  // the source of truth
type RunnerId     = (typeof RUNNER_IDS)[number];                   // user-selectable
type AgentBackend = RunnerId | 'claude-cli';                       // + legacy id, still parses
```

`RUNNER_IDS` is the tuple the server’s enumerations derive from — the zod schemas
in `packages/xezar` (config, run store, workflow steps, request bodies), the
server-install "at least one agent CLI" gate, and the CLI-handoff registry.
Some lists still repeat the literals: `runnerSchema` in `packages/contract/src/health.ts`,
`UiBackend` in `ui-events.ts` and its api-client mirror, and `BackendCheck.name`
in `backend-detect.ts`, among others. Find the remaining copies with
`rg "'claude', 'codex', 'opencode', 'pi'" packages` and update them for a new runner;
the contract cannot import the server.
Inside `packages/xezar`, use `RUNNER_IDS` / `isRunnerId()` where possible — re-listing
ids is how a runner silently goes missing from one seam (pre-rename PR 387 review).

`claude-cli` is a **legacy** backend id kept so old `runs.json` records and
NDJSON transcripts still parse; `createRunner` maps it onto `claude`. Follow that
precedent — never repurpose or remove a shipped id.

### `AgentRunner`

```ts
interface AgentRunner {
  readonly backend: AgentBackend;
  readonly defaultTimeoutMs?: number;   // what a spec with no `timeoutMs` falls through to
  run(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void): Promise<AgentRunResult>;
  startSession(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void, opts?: SessionOptions): AgentSession;
  interrupt(): Promise<void>;
}
```

- `run()` is a one-shot convenience; `startSession()` is the real contract.
- `defaultTimeoutMs` (#460) is REPORTED, never set: `AgentRunSpec.timeoutMs` still decides, and
  this only says what an absent one falls through to, so a caller can name a step's deadline
  without re-deriving a number per backend. Return the same field the session reads, or the two
  will drift. It is optional, and absent means UNKNOWN — a caller then has no deadline to speak
  of rather than a guessed one — so an existing runner and a test double stay valid without it.
- Each backend runs as a **persistent process** so multi-turn follow-ups,
  `waiting`, interrupt and resume all work: claude = stream-json over
  stdin/stdout; codex = `codex app-server` JSON-RPC 2.0 (JSONL) over
  stdin/stdout; opencode = `opencode serve` over HTTP + SSE; pi =
  `pi --mode rpc` over JSONL stdin/stdout.

### `AgentSession`

A live session over one spawned process, alive between turns:

```ts
interface AgentSession {
  result: Promise<AgentRunResult>;   // resolves when the process exits
  readonly pid?: number;             // root of the run's process tree (resource telemetry, pre-rename issue 348)
  onProcessStart?(listener: (pid: number) => void): void;  // for a child that starts after startSession returns
  sendMessage(content: ContentBlock[]): boolean;  // false when closed
  end(): void;                       // graceful: end input, SIGTERM→SIGKILL watchdog
  interrupt(): void;                 // hard stop (cancel)
  readonly open: boolean;
}
```

`startSession` RETURNS SYNCHRONOUSLY, and that stays true even for a runner that cannot spawn its
child synchronously. pi has to ask its binary a capability question first — `--mcp-config` belongs
to an optional extension, and the answer depends on the task's own folder and account (#548) — so
it returns a facade over the child that is about to exist: messages, `end()` and `interrupt()`
arriving in that window are replayed onto the real session, and `result` settles with its result.
The one thing a facade cannot answer synchronously is `pid`, so such a runner implements the
optional `onProcessStart`, which fires with the pid when the child exists and again if the runner
restarts the child itself. A runner whose child exists before `startSession` returns omits it —
`pid` is then the whole story. `RunManager.publishSession` reads `pid` first and falls back to
`onProcessStart`, so resource telemetry never tracks a pid that is already gone.

A termination the runner itself caused is **not** an agent failure (pre-rename issue 703).
`end()` arms a SIGTERM→SIGKILL watchdog for CLIs that ignore EOF, and
`interrupt()` signals outright; the agent CLIs install their own handlers and
exit `128 + signal`. A runner MUST therefore record that it sent the signal and
settle such an exit on the normal path — `isSignalTerminationExit(exitCode)`
(`packages/xezar/src/core/agent-runner.ts`) plus a `note` — instead of throwing. Throwing makes
a finished run settle as `failed` and a cancelled run settle as `failed` too.

**The other half of that bit is an obligation too: when the runner sent NO signal and the CLI still
exits `128 + signal`, name the signal.** Report it through `foreignSignalExitMessage(cli, exitCode)`
(same file) rather than surfacing a bare exit code. The runner cannot know who sent it, so the
message claims exactly what the runner does know — that xezar sent nothing — and no more. This is
not cosmetic: #156 was five agent CLIs SIGTERMed by a peer task's unscoped
`pkill -f "repo-gates.sh --fast"`, which matches every agent carrying that string in its own
`--append-system-prompt` argv, i.e. every agent running a kit skill. A bare exit code turned that
into a day of forensics; the named signal turns it into one read.

That watchdog MUST gate its SIGKILL escalation on real termination, never on
`ChildProcess.killed` (pre-rename issue 844). Node sets `killed` when a signal is *delivered*,
so the watchdog's own SIGTERM flips it while the CLI — which handles the
signal — keeps running, and the escalation written for exactly that case is
skipped. Use `trackChildExit(child)` (`packages/xezar/src/core/agent-runner.ts`),
which seeds from `exitCode`/`signalCode` and listens for `exit`.

The **wall-clock deadline is a third termination path, and it carries the same
obligation.** `AgentRunSpec.timeoutMs` is not advisory: when it expires a runner MUST
escalate to `SIGKILL` after `KILL_GRACE_MS`, gated on `trackChildExit` exactly as above.
Leaving it at a single `interrupt()` is what made a step's `timeout:` enforceable on some
backends and merely a suggestion on another — the defect was invisible because the
escalation branch existed in the source and simply never ran. `pi-runner.ts` is the
reference implementation (for the deadline path; its `timeoutKillTimer` is cleared only after `waitForExit`); a new runner should mirror it rather than invent a variant.

Two constraints on that path are load-bearing and neither is inferable from the code
around them:

- **Destroy stdout** when the deadline fires, or the NDJSON read loop can block forever on
  a process that is ignoring the signal — and then **swallow the resulting premature-close
  error while `timedOut`**, or a timeout surfaces as a spurious runner throw rather than as
  the timeout it is.
- **Do NOT clear the escalation timer in the read loop's `finally`.** Destroying stdout ends
  that loop within a microtask, so a `finally` disarms the `SIGKILL` long before its grace
  period elapses. Clear it after `waitForExit` instead. This is the single easiest way to
  ship an escalation that is present in the diff, reviewed, and dead.

`SessionOptions`:

- `autonomous?` — nobody is watching: a backend’s native blocking question
  (pi extension dialog, #369) is refused at once and recorded as a note, never
  raised as an ask card.

- `autoEndAfterFirstTurn?` — single-turn behavior for non-interactive workflow
  steps; interactive sessions control `end()` themselves.
- `onUiEvent?: (e: UiEvent) => void` — the **v2 channel**. It receives the
  normalized `UiEvent` stream emitted alongside the v1 `AgentEvent`s passed to
  `onEvent`. A runner that omits `onUiEvent` support degrades to v1-only — but a
  first-class backend MUST wire it (see §7).

### `AgentRunSpec`

The input to a run. Backend-agnostic; each runner translates it to its transport.
Notable fields (full doc-comments in the source):

- `userPrompt` (required), `systemPrompt?`, `images?` (first-message content
  blocks — pasted screenshots), `cwd` (the run dir and the only writable root),
  `model?`, `timeoutMs?`, `env?` (merged over `process.env` — carries
  `XEZ_HANDOFF_FILE` / `XEZ_TODOS_FILE` / `XEZ_TASK_ID`).
- `allowedTools?` / `bashAllowlist?` / `additionalDirectories?` — tool access.
  **Caveat (pre-rename issue 430):** the zero-config default (`DEFAULT_ALLOWED_TOOLS`) includes
  unrestricted `Bash`, and OpenCode does not honor `allowedTools` at all. Codex
  honours one signal from it: a read-only step (neither `Edit` nor `Write`) runs
  CONFINED, every other step keeps full access (§ 6, "Read-only steps").
  Treat the default `auto` permission mode as full shell access, not a
  sandbox: a writing Codex step uses `danger-full-access` with
  `approvalPolicy: never`.
  **OpenCode does NOT auto-approve every permission (#578 corrects the prior
  claim here).** It defaults `external_directory` (a tool touching a path
  outside the session directory — `$XEZ_HANDOFF_FILE`, pasted attachments,
  the run's own NDJSON dir) and `doom_loop` (repeated identical calls) to
  `ask`, publishing `permission.asked` on the SSE bus and blocking the tool
  call until the ask is answered. Before #578 nothing read that event, so the
  ask sat forever and the run died on the generic 30-minute step timeout with
  no named cause. The runner now answers every ask as soon as it arrives, on
  `POST /permission/:requestID/reply` with `{"reply": "once"|"reject"}`
  (`permission.reply` in the live 1.18.31 OpenAPI; the deprecated
  `POST /session/:id/permissions/:id` wants `{"response"}` instead and
  answers `{"reply"}` with 400). The policy is fail-closed
  (`opencode-permissions.ts`): `once` only for an `external_directory` ask
  whose every pattern is an absolute path — at most one trailing `/*` or
  `/**` segment, no other wildcard, no `..` — that resolves, symlinks
  included, inside `spec.cwd`, `spec.additionalDirectories`, the OS temp
  dir, or the run's own task-evidence directories in the primary checkout
  (`.local/xezar/tasks/<runId>/` and the frozen `.local/xezar-tasks/<runId>/`
  of the #665 dual-read window, resolved from `spec.primaryRoot`/`spec.cwd`
  and `XEZ_TASK_ID`, #686 — the only path a run must reach outside its own
  `cwd` that the other backends already reach through the prompt's handoff
  contract); `reject` for every other ask and every other permission (`webfetch`,
  `bash`, `doom_loop`, `read`, `edit`, …), never `always`. A denial is a v1
  `note` plus a v2 non-fatal `session.error`, which does not mark the turn
  errored. The session fails with a named error (not the generic timeout)
  when a reply cannot be sent, when the same ask is denied
  `MAX_REPEATED_PERMISSION_DENIAL` (3) times consecutively — an allowed ask
  or a different denial resets that count — or after
  `MAX_PERMISSION_DENIALS` (20) denials in total. Since #692 it also fails with
  a named error when the session produces nothing at all for
  `REJECT_SILENCE_MS` (5 minutes) after a `reject` — the observed shape where a
  correct refusal was followed by no output and no new turn, which a non-final
  step could only leave through the 30-minute wall clock and the last,
  uncapped step could not leave at all. A new assistant part the MODEL produces
  disarms it (`text`, `reasoning`, `tool`, `subtask`, `step-start`); a
  `session.idle` deliberately does not, because the turn ending in silence is
  the failure, and neither does the `step-finish`/`patch` bookkeeping the server
  writes for the round trip that just ended — it arrives after every refusal, so
  counting it would make the bound unreachable. Nothing is armed on a run with
  no denied ask.
  Configurable restrictive modes are
  specified by `2026-07-17-permission-modes` (pre-rename issue 475).
- **Codex MCP isolation (#324):** before `thread/start` / `thread/resume` the
  Codex runner calls `config/read` for the run's cwd and passes a `config`
  override that switches off every MCP server not declared solely by the
  project's `.codex/` layer, xezar's own bridge, and the `plugins` / `apps`
  features (`codex-run-isolation.ts`). An app-server that cannot answer fails
  the run closed. The other runners do not isolate MCP servers yet.
- `sessionId?` / `resume?` — stable session id for interactive takeover and for
  `--resume` ("Continue" after a run ends).

**System prompt channel** — a backend without a dedicated system-prompt input
must deliver `spec.systemPrompt` as a leading block of the opening user message.
Use the shared helper so the mapping is uniform:

```ts
prependSystemPrompt(spec.systemPrompt, spec.userPrompt)
// claude, pi:      --append-system-prompt   (native channel, do NOT prepend)
// codex / opencode: prepended here
```

`ContentBlock` mirrors the Anthropic wire format (`text` | `image` base64) so it
can be written to the claude CLI's stdin verbatim.

---

## 2. v1 `AgentEvent` — the flat stream

The original normalized stream. Still emitted by every runner, still persisted,
still rendered by `xezar run`. **Do not remove or rename a variant** — v1 event
`type` strings are part of the on-disk NDJSON format.

```ts
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  | { type: 'image'; mediaType: string; data: string }        // base64; run manager re-emits a URL
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'cost'; usd: number }
  | { type: 'session'; sessionId: string }                    // backend's real session id, once known
  | { type: 'turn-end' }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Every v1 event stays **derivable** from the v2 stream, so a consumer can migrate
one panel at a time. New work should read v2; v1 exists for the console renderer
and old recordings.

### `token-usage` accounting semantics

`tokensUsed` is the figure the runner reports; the run manager turns it into the
step total. `BACKENDS_WITH_CUMULATIVE_TOKENS` in
`packages/xezar/src/workflows/run.ts` is the single source for which interpretation
applies:

- **Codex** reports the thread's cumulative total from
  `thread/tokenUsage/updated` → `tokenUsage.total.totalTokens`. After a
  `thread/resume`, that total already includes the pre-resume executions, so the
  resumed step total is Codex's reported figure itself (and must not add
  `startTokens` again).
- **Claude, pi, and OpenCode** each begin accumulating tokens at zero in their
  session object. Their reported figure is therefore this execution's accumulated
  spend, and the step total is `startTokens + reported`.

The classification is accounting behavior, not a display preference: classifying a
cumulative runner as per-execution double-counts pre-resume tokens on the step.

### Xezar-owned run metadata events

`provider-auth-required` is not emitted by a backend runner. The server derives it
from an authoritative v1/v2 authentication error, persists a provider id, opaque
incident id, and optional `stepId`, and the cockpit renders recovery guidance. It
does not change backend parity or expose the raw error.

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/xezar/src/core/ui-events.ts`)

Pure vocabulary: no runtime imports, no runner coupling. Mirrored into the
api-client package at `packages/api-client/src/protocol/ui-events.ts`; the mirror is
**checked**, not trusted. `packages/xezar/src/server/api-types.test.ts` pins every export
of this file against its twin in both directions, so drift fails `npm run typecheck` (the
gate) rather than the UI at runtime. An interface is pinned by shape AND by key set,
because assignability alone cannot see a property that is optional on one side and absent
on the other. The same file also compares the two EXPORT LISTS at runtime, so a type added
here and not to the mirror fails before any shape is examined. That guard was absent
between the day `@qodeca/xezar-contract` retired the original and #190; if it is ever
retired again, say so here and in the mirror's own header.

### Design rules baked in

1. **Item-lifecycle model** (Codex/ACP style): one stable `id` per item with
   `started → delta → updated → completed` phases. Of the four backends in
   `RUNNER_IDS`, codex and opencode are natively item-shaped; claude and pi are
   mapped onto it.
2. **ACP vocabulary** wherever a choice is arbitrary (tool status/kind, plan
   entries, diff shape, stop reasons) — ecosystem alignment.
3. **Per-capability degradation, never per-backend** — see §6.

### The item model (one id-keyed stream for text, reasoning and tools)

```ts
type UiItem = UiMessageItem | UiReasoningItem | UiToolItem;
```

- `UiMessageItem` — `kind:'message'`, `role`, `text`, `phase?:'commentary'|'final'`.
- `UiReasoningItem` — `kind:'reasoning'`, `text` (extended thinking / reasoning summary).
- `UiToolItem` — `kind:'tool'`, `name` (backend tool name), `toolKind`, `title`
  (human line computed once — see §5), `status`, `input?`, `output?`, `error?`,
  `diffs?: FileDiff[]`, `locations?`, `exitCode?`, `parentItemId?`.

`parentItemId` nests subagent work under the tool item that spawned it (claude
`parent_tool_use_id`, opencode `subtask` parts, Codex collaboration receiver
thread ids).

### Enumerations

```ts
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';
type ToolKind   = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'task'|'plan'|'other';
type StopReason = 'end_turn'|'max_tokens'|'refusal'|'cancelled'|'timeout'|'error';
type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
```

Supporting shapes: `PlanEntry` (`content`, `status`, `priority?`, `activeForm?`),
`TokenUsage` (raw `input`/`output`/`cacheRead?`/`cacheWrite?`/`reasoning?`/`total`,
`contextWindow?` — **never pre-weighted**; cost weighting is a presentation
concern), `FileDiff` (`path`, `oldText: string|null` where `null` = newly
created, `newText?`, `unified?`), `ToolLocation`, and the reserved
`PermissionOption`/`PermissionOptionKind`.

### The events

```ts
type UiEvent =
  | UiSessionStartedEvent    // 'session.started'  — sessionId, backend, model?, cwd?, tools?
  | UiSessionEndedEvent      // 'session.ended'    — reason: StopReason (replaces v1 done / fatal error)
  | UiSessionErrorEvent      // 'session.error'    — message, fatal (v1 note + error unified)
  | UiTurnStartedEvent       // 'turn.started'     — turnId
  | UiTurnCompletedEvent     // 'turn.completed'   — turnId, stopReason, usage?, costUsd?
  | UiItemStartedEvent       // 'item.started'     — item (tools usually pending/running)
  | UiItemDeltaEvent         // 'item.delta'       — itemId, field:'text'|'reasoning'|'output', delta
  | UiItemUpdatedEvent       // 'item.updated'     — item (status flips, streamed snapshots)
  | UiItemCompletedEvent     // 'item.completed'   — item (final snapshot, safe to persist)
  | UiPlanUpdatedEvent       // 'plan.updated'     — entries: PlanEntry[] (FULL replacement, ACP semantics)
  | UiPermissionRequestedEvent  // 'permission.requested' — RESERVED (types only; wired when approvals become optional)
  | UiPermissionResolvedEvent   // 'permission.resolved'  — RESERVED
  | UiAskRequestedEvent      // 'ask.requested'    — requestId, questions[] (AskUser; the cockpit renders option chips)
  | UiUsageUpdatedEvent      // 'usage.updated'    — usage: TokenUsage, costUsd? (cumulative-for-session)
  | UiImageEvent;            // 'image'            — itemId?, mediaType, data (base64; manager re-emits URL)
```

**AskUser (`ask.requested`, pre-rename issues 473 and 565).** The portable path remains
backend-neutral: the agent asks a structured
multiple-choice question by ending a turn with a `XEZ:ASK <json>` control marker
(a sibling of `XEZ:DONE` / `XEZ:MONITORING`); the RunManager detects it on the
*assembled* turn text — uniform across every runner with no mapper
work — validates the payload (`packages/xezar/src/core/ask.ts`, modeled on Claude Code's
`AskUserQuestion`: 1–4 questions, 2–4 options each, `header` ≤12 chars), emits
`ask.requested` and parks the run `waiting` — in the workflow's last agent step, the
only one that can wait. An earlier step runs one turn, so the same marker there fails
the step and stops the run (#317, `unfinishedStepReason`). The cockpit renders clickable option
chips; the user's pick (or a free-form reply) rides the normal reply seam
(`POST /api/v1/runs/:id/messages`), and the card resolves client-side when that
message lands (no `ask.resolved` event). Codex additionally bridges its native
`item/tool/requestUserInput` server request onto the same event and routes the
next answer back as the documented JSON-RPC response. Malformed or unsupported
native requests receive an error response rather than hanging the turn. pi does
the same for its extension-UI dialogs (#369, `packages/xezar/src/core/pi-dialog.ts`):
an `extension_ui_request` with `method: select` or `confirm` BLOCKS pi until the
client writes the correlated `extension_ui_response`, and it carries no `timeout`
(pi-mcp-adapter's `approveTools` gate is one), so the runner raises it as
`ask.requested` carrying pi's own options and answers it from the next
`sendMessage`; a reply naming none of the options cancels the dialog rather than
guessing. When `SessionOptions.autonomous` is set the runner refuses at once
(`Deny` when the dialog offers it, `confirmed: false` for a confirm, else
`cancelled`) and records the refusal as a note — never a silent approval, never
an unbounded wait. pi puts no length limit on a choice and the card caps a label
at 60 characters, so the card label and the wire value are kept as an
index-aligned pair: a long choice is shown shortened with an ellipsis and the
click still sends pi the full value, and the single-select reply is never split
on a comma (`Allow, once` is one choice). Dialogs the card cannot carry
(`input`, `editor`, a `select` outside 2–4 options, or one whose choices would
render as the same label) are cancelled on arrival, a dialog still pending at `end()`
or `interrupt()` is cancelled first, fire-and-forget methods get no response, and
`notify` becomes a transcript note. A
malformed marker degrades to plain text — the prose fallback is never made
worse.

Two bounded forgiveness layers sit **under** that schema, and neither loosens
it. `normalizeAskRequest` recovers presentation drift (unknown keys dropped, an
over-long `header`/`description` clipped) — never counts, never choices.
`closeUnbalancedJson` (pre-rename issue 936) recovers the one syntax slip agents actually make:
a payload complete except for its closing brackets, because a hand-written
one-line blob dropped a trailing `}` or the output-token limit cut the stream.
It appends the missing closers and re-parses, but only when the payload ends on
a **completed** structural value (`}` or `]`), the scan ends outside a string,
and every closer matched its opener — a stream cut mid-string, after a `,`, or
after a `:` is still refused, and an already-balanced payload (a trailing comma,
say) has nothing to repair. The repaired text goes through the unchanged schema,
so a repair yielding fewer than 2 options still degrades to plain text. What a
repair *can* lose is whatever the cut already took: a stream severed exactly on
an option boundary yields a real card missing a trailing option, or missing a
trailing `multiSelect` — so a recovered card is never passed off as a clean
parse. `AskMarkerParseResult` carries `repaired`, and the run records a
danger-toned recovery note asking the user to check the options, and how many
they may pick, against what was asked; the raw marker is stripped from the
transcript along with the card it produced. A native
`AskUserQuestion`
control-protocol bridge for claude (the `control_request can_use_tool` path) is a
possible future enhancement; the marker is the portable baseline.

`item.completed` carries **snapshots**, not deltas — safe to persist. `item.delta`
carries **appends** to one field of a live item and must not be persisted as a
standalone truth.

---

## 4. Per-backend mapping (summary)

Each backend has a mapper (`packages/xezar/src/core/<backend>-ui-mapper.ts`) turning its wire
transport into `UiEvent`s. Those mappers and their golden fixtures (§7) are the authority; the
load-bearing rows:

The table covers the first three backends. `pi` (`--mode rpc` JSONL) is mapped the
same way, and its authority is `packages/xezar/src/core/pi-ui-mapper.ts` with the
golden fixtures under `packages/xezar/src/core/__fixtures__/pi/`; `ui-parity.test.ts`
runs all four.

| v2 event / field | claude (stream-json) | codex (app-server JSON-RPC) | opencode (serve HTTP+SSE) |
|---|---|---|---|
| `session.started` | `system/init` (model, tools, cwd) | `thread/started` / `thread/start` result | `POST /session` response |
| `turn.started` | each stdin user message | `turn/started` | each prompt POST |
| `turn.completed` + `stopReason` | `result` subtype (`success→end_turn`, `error_max_turns→max_tokens`, `error_during_execution→error`) | `turn/completed→end_turn`, `turn/failed→error`, interrupt→`cancelled` | `session.idle→end_turn` (or `error` if a `session.error` preceded) |
| message item | `assistant` `text` blocks (deltas via `--include-partial-messages`) | `agentMessage` items | text parts |
| reasoning item | `thinking` blocks | `reasoning` items (+ `textDelta`) | `reasoning` parts |
| tool item | `tool_use`→running, `tool_result`→completed/failed, `permission_denials`→`declined` | `commandExecution`→execute (+`exitCode`, `outputDelta`), `fileChange`→edit (`diffs`), `mcpToolCall`→other, `webSearch`→fetch, collaboration spawn→task | tool parts (state `pending/running/completed/error→failed`, `patch` parts→`diffs`) |
| `item.delta` `output` (live terminal) | *(none — card fills on completion; per-capability degradation)* | `item/commandExecution/outputDelta` | running-state metadata |
| `plan.updated` | `TodoWrite` input | `turn/plan/updated` notification (plan-mode `plan` items fold in only until `turn/plan/updated` has spoken in the current turn) | `todowrite` tool |
| subagent nesting (`parentItemId`) | `parent_tool_use_id` | collaboration receiver thread id (review mode remains childless) | child-session parts under a `subtask` |
| `usage.updated` | `result.usage` + `total_cost_usd` | `thread/tokenUsage/updated` (no USD) | `message.updated` tokens/cost + `step-finish` |

`token-usage` has a separate step-accounting mapping, because the number a runner
emits is not uniformly scoped:

| backend | reported `token-usage` figure | resumed step total |
|---|---|---|
| claude | Accumulated from zero by the session object; this execution's spend. | `startTokens + reported` |
| codex | The thread's cumulative `thread/tokenUsage/updated` → `tokenUsage.total.totalTokens`; after `thread/resume`, it includes pre-resume executions. | Codex's reported figure itself; do not add `startTokens`. |
| opencode | Accumulated from zero by the session object; this execution's spend. | `startTokens + reported` |
| pi | Accumulated from zero by the session object; this execution's spend. | `startTokens + reported` |

**Mapper robustness contract.** Inputs come off the wire and may be `null`,
partial or malformed. A mapper **must never throw**: unparseable NDJSON lines are
skipped (`packages/xezar/src/core/ndjson.ts` + the mapper), unknown message/content types
produce **no events**, and malformed entries in a `plan.updated` payload are
filtered out (a non-array plan emits no plan event at all). Mapper state is
**explicit and immutable** — each mapper's map function takes `(frame, state)`
and returns `{ events, state }`, never mutating the passed-in state
(`mapClaudeMessage` / `mapCodexNotification` / `mapOpencodeEvent` / `mapPiRpcMessage`,
each paired with a `create<Backend>UiState`; see the claude mapper's "state carries across
messages" tests).

---

## 5. The tool display model (`packages/xezar/src/core/tool-display.ts`)

`toolDisplay(name, input)` turns a backend tool name + raw input into
`{ toolKind, title, subtitle? }`, computed **once** in the protocol layer (never
in components) so the thread, activity groups and notifications all say the same
thing. It is a pure function over untrusted input and **must never throw**. Tool
names are matched case-insensitively, so claude's `Bash` and opencode's `bash`
share one row; unknown tools keep the backend's name as the title with a
heuristic subtitle. `mcp__server__tool` names collapse to `server.tool`.

---

## 6. Backend parity — the hard rule (`packages/xezar/src/core/ui-parity.test.ts`)

> Every capability in the parity matrix MUST be emitted by **every**
> backend, so the GUI degrades **per-capability, never per-backend**.

This is made executable: `ui-parity.test.ts` asserts each capability over each
backend's golden-fixture expected output. If a mapper change drops a capability —
or a new fixture set forgets one — a named row fails. The matrix:

- `plan.updated` with entries (TodoWrite / todoList / todowrite)
- tool status `running`, `completed`, `failed`
- reasoning items (thinking / reasoning items / reasoning parts)
- structured diffs (Edit input / fileChange.changes / patch parts)
- sub-agent task items (Task / review-mode span / subtask parts) — one item per
  sub-agent: codex's `enteredReviewMode`/`exitedReviewMode` pair folds into a
  single `task` item with a running→completed lifecycle, so a consumer counting
  task items counts agents, not frames (pre-rename issue 474)
- `usage.updated` with raw token counts
- `turn.completed` with a `stopReason`
- `turn.completed` with per-turn DIRECTIONAL usage (`usage.input` and
  `usage.output` both > 0)
- sub-agent **nesting** via `parentItemId` where the upstream wire attributes
  child work to a parent

A new backend is not "done" until it produces every row.

### Read-only steps — per backend (#849)

Tool limits are the one place backends do NOT reach parity, so the difference is stated rather
than hidden. A step is **read-only** when its resolved `allowedTools` names neither `Edit` nor
`Write` (`isReadOnlyStep` in `claude-cli-runner.ts`; `undefined` is not read-only, an empty list
is). That is the only signal: no step key, no `XEZ_*` variable.

| Backend | Read-only step | Mechanism | Pinned by |
| --- | --- | --- | --- |
| Claude Code | **ENFORCED** (was MODE-DENIED before #849) | `--disallowedTools Edit,Write,NotebookEdit` beside `--allowedTools`: the tools are removed, so neither `--permission-mode acceptEdits` (`XEZ_APPROVAL_GATE=1`) nor a project's `permissions.allow` brings them back. Before #849 an unlisted Edit/Write was only denied by `dontAsk` | `claude-cli-runner.test.ts` |
| Codex | **CONFINED** (was NOT APPLIED before #849) | `thread/start` and `thread/resume` carry `sandbox: 'workspace-write'` plus `config.sandbox_workspace_write = { network_access: true, writable_roots: spec.additionalDirectories }` (`codexPermissions`). Codex's file edits and shell may write only inside the worktree and the run's own evidence, handoff and tmp directories; the network stays on so a review can `git fetch` and post with `gh`, unless `XEZ_CODEX_NETWORK=0` turns it off. Not ENFORCED: the worktree, and so the branch, stays writable, individual tool names and `bashAllowlist` are still ignored, and MCP tools stay under the per-thread scoping of #324 (`codex-run-isolation.ts`), not the sandbox. `read-only` was rejected because it also drops all network and every write outside the worktree | `codex-app-server-runner.test.ts` |
| pi | partly: edit/write absent | `--tools` from the mapped list (`Read,Grep,Glob,Bash` → `read,grep,find,bash`). `bash` stays; a non-empty `bashAllowlist` is passed as `--xezar-bash-allowlist=<JSON>` to xezar's pi extension (`scripts/pi-worktree-guard.ts`, loaded for it alone on a run with no worktree), which applies Claude Code's `Bash(<entry>:*)` rule to every bash call: the entry itself or the entry followed by whitespace; every part of a compound command (`;`, `&&`, `||`, `\|`, `&`, newline, `$(…)`, backticks) must match on its own; any unquoted `>` or `<`, a heredoc `<<` and process substitution `<(` are refused outright, and so is a `find` part carrying `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint`, `-fprint0`, `-fprintf` or `-fls` (an argument that runs a command, deletes or writes, which an entry `find` would otherwise match; the table `COMMAND_RUNNING_ARGUMENTS` is where another such program goes) and a command it cannot split (an unclosed quote or substitution). A list with no non-blank entry still removes `bash`, as Claude Code emits no rule for it (#856) | `pi-runner.test.ts`, `pi-worktree-guard.test.ts` |
| OpenCode | **NOT APPLIED** | nothing derived from `allowedTools` reaches the server; the agent can edit, write and run any command | — |

Plain `Bash` in a read-only list is still a shell on Claude Code and pi, and inside the worktree on
Codex; a `bashAllowlist` narrows it on Claude Code and pi, by the same prefix rule (Claude: `Bash(<prefix>:*)` entries only; pi: the extension above). A new runner states its row here, and a runner that
cannot enforce a read-only step says NOT APPLIED rather than implying it.

### A reviewer's verdict packet — the step declares the role (#460, #851)

Every agent step is spawned with `XEZ_TASK_ID`, `XEZ_STEP_ID` and `XEZ_HANDOFF_FILE`, on every
backend alike, so any step CAN write a reviewer packet at `${XEZ_HANDOFF_FILE}.verdict.json`. What
decides whether the engine records it is not the backend and not the packet: at the step's
settlement the engine reads the step's `verdictRole` from the workflow definition the run persisted
(`workflowDef`), and records the packet only when its `role` equals that declaration. A step with no
`verdictRole` — every `quick-task`, every writing step — has any packet it leaves refused into
`verdictIssues` with a named reason, and consumed. The roles are `TASK_VERDICT_ROLES` in
`packages/contract/src/task-verdict.ts`, the only declaration: `code-review`, `design-review`, `qa`
and `architecture-review`, each with its own words (`architecture-review` speaks a code review's,
APPROVE or REQUEST CHANGES). A runner needs nothing for this beyond passing those three variables;
the packet shape and the refusal rules are in `docs/features/mcp-server/mcp-reviewer-verdicts.md`.

## 7. The golden-fixture testing contract

Each backend has, under `packages/xezar/src/core/__fixtures__/<backend>/`:

- `<name>.ndjson` — a **wire-faithful** transcript of the backend's real output
  (shapes taken from the backend's own published protocol documentation and
  cross-checked against its actual CLI / the dry-run mock, e.g. `packages/xezar/scripts/mock-claude.mjs`).
- `<name>.expected.json` — the **exact** `UiEvent[]` the mapper must produce for
  that transcript.

`<backend>-ui-mapper.test.ts` replays each fixture **exactly as the runner drives
the mapper** (seed turn started before the first line; malformed lines skipped),
round-trips the result through JSON (so a stray `undefined` fails loudly, since
these events get persisted as NDJSON), and asserts `toStrictEqual` against the
`.expected.json`. The same `.expected.json` files feed the parity test in §6.

> Verify fixtures against **upstream wire shapes**, never against your own
> assumptions. Pre-rename PR 443's root cause was a fixture that encoded an *assumed*
> codex shape (`todoList` items that the app-server never emits), which hid a bug
> where a codex plan never rendered at all. When adding a fixture, cite the
> upstream schema/source it was derived from, as pre-rename PR 443 did.

## 8. Persistence & transport

- **NDJSON** — one append-only `runs/<id>.ndjson` per run, one JSON object per
  line (`seq`, `ts`, `type`, free extra keys). Never rewrite, reorder or
  re-number; readers skip bad lines. Both v1 and v2 events live here; a mixed
  file is valid. Xezar-owned task events are additive too: for example,
  `provider-auth-required` records only `{ provider, authFailureId, stepId? }`
  when a runtime rejection needs user authorization; it never carries vendor
  error text or credentials.
- **SSE** — the server replays from NDJSON then streams live, deduped by `seq`.
  Event names: `run-event` (v1) and `ui-event` (v2 dotted types). These names are
  a protected contract (see `BACKWARD_COMPATIBILITY.md` §2).

---

## 9. Adding a new runner (the pre-rename PR 387 `pi` checklist, as it was actually done)

A new backend is a **single class behind the seam** plus its mapper, fixtures and
the parity row — never backend-specific types leaking past
`packages/xezar/src/core/`. Pre-rename PR 387 added `pi` and enumerated every place the
runner union was duplicated; that list is the concrete map, and the union now
derives from one `RUNNER_IDS` tuple in `agent-runner.ts` so most of it is
typecheck-enforced rather than hand-tracked.

To be first-class:

1. **Runner** — `packages/xezar/src/core/pi-runner.ts` implementing `AgentRunner` /
   `AgentSession` (persistent process; `pid`; `sendMessage`/`end`/`interrupt`;
   `result`). Honor `AgentRunSpec` uniformly — use `prependSystemPrompt` if the
   backend has no native system-prompt channel. Implement all THREE termination paths
   to the same standard (`end()`, `interrupt()`, and the `timeoutMs` deadline): each
   escalates SIGTERM→SIGKILL gated on `trackChildExit`, and each records that the runner
   sent the signal so the exit settles on the normal path, and report a `128 + signal` exit the
   runner did NOT cause through `foreignSignalExitMessage`. See § the termination rules above;
   `pi-runner.ts` is the reference for the deadline path; `claude-cli-runner.ts` for the
   `end()` SIGTERM→SIGKILL watchdog (but not its timer cleanup). No runner covers all three yet.
   A backend's NATIVE question — a request that blocks
   the turn until the client answers — must never wait unbounded: bridge it onto `ask.requested`
   and answer it from the next `sendMessage`, refuse it explicitly when
   `SessionOptions.autonomous` is set, and cancel it at `end()`/`interrupt()` (codex's
   `requestUserInput`, pi's extension dialogs — #369).
2. **Factory** — add the id to `RunnerId` / `RUNNER_IDS` (`agent-runner.ts`) and
   a `case` in `createRunner` (`runner-factory.ts`). Add `UiBackend` in
   `ui-events.ts` **and its mirror** `packages/api-client/src/protocol/ui-events.ts`
   — and add its pair to `api-types.test.ts`, which fails the gate until you do (see §3).
3. **Detection** — a `probePi()` in `backend-detect.ts` plus the `BackendCheck`
   name union; degrade gracefully when the CLI is absent (never fail boot). If it
   needs a binary override, add `XEZ_PI_BIN` — and per AGENTS.md's zero-config
   rule, document any new `XEZ_*` var in `.env.example` in the same commit.
4. **Mapper** — `packages/xezar/src/core/<runner>-ui-mapper.ts` emitting the full
   v2 `UiEvent` stream **alongside** v1. Never throw on malformed input; explicit
   immutable state.
5. **v1 alongside v2** — wire `SessionOptions.onUiEvent`; keep the v1
   `AgentEvent` stream flowing unchanged.
6. **Golden fixtures** — `packages/xezar/src/core/__fixtures__/<runner>/*.ndjson` +
   `*.expected.json`, wire-faithful and citing their upstream source, covering
   **every** parity matrix capability (§6), and a `<runner>-ui-mapper.test.ts`
   replaying them.
7. **Parity** — add the id to `BACKENDS` in `ui-parity.test.ts`; every capability
   row must pass. (If the backend has no wire parent attribution, document the
   nesting cell's substitute the way codex's review-mode items are handled.)
8. **Plumbing** — the run-store `runner` enum, workflow step schema, the
   `POST /api/v1/runs` / `PUT /api/v1/config` bodies, `resumeCommand()`
   (`packages/contract/src/resume-command.ts`), the contract’s `runnerSchema`
   (`packages/contract/src/health.ts`, which the cockpit’s `Runner` type is inferred from),
   `RUNNER_LABEL` in `packages/web/src/lib/runner-label.ts`, composer pills/presets,
   and Settings → Agents. Keep additive
   so old `runs.json` records still parse (the `runner` enum keeps `claude-cli`
   parseable — follow that precedent).
   Two of those places are **resume policy**, and both are total `Record<RunnerId, boolean>`
   maps in `packages/xezar/src/workflows/run.ts` precisely so a fifth id is a compile error
   rather than a default (#676, #732): `BACKENDS_WITHOUT_RESUME` — does the runner actually
   honour `spec.resume`, or does it always open a new conversation? — and
   `BACKENDS_WITH_CUMULATIVE_TOKENS` — is the `token-usage` figure this EXECUTION's own, or the
   session's running total? A new runner author MUST answer that question in this map;
   answering it wrong double-bills a resumed step. See §2's `token-usage` accounting
   semantics.
9. **Model selection** — accept `provider/model` where relevant, and never silently
   drop or substitute a model. A backend with no default provider gets no
   `defaultProvider` in `BACKEND_MODEL_MAP` (`model-identity.ts`), so a bare id
   fails loud — opencode and pi already work this way.
10. **Credentials** — one entry in `BACKEND_ALLOW_PREFIXES` (`agent-env.ts`):
   `buildChildEnv` is least-privilege per backend, so a multi-provider runner
   must receive credentials for every provider its own model ids can name
   without widening other backends.

## 10. The plan channel (pre-rename PR 443)

Pre-rename PR 443 hardened `plan.updated` after finding the plan never reached the cockpit
dock — for a different reason on each backend. It has landed; the rules below are
current behaviour, and any new runner should follow them:

- **Claude** — current-session plans use `TaskCreate` / `TaskUpdate` / `TaskList`
  (not only `TodoWrite`); classify all of them as plan tools and fold them into
  a snapshot keyed by the task id the harness reports in each tool's **result**.
- **Codex** — the real plan channel is the turn-level notification
  `turn/plan/updated`, not a `todoList` item (which the app-server never emits);
  map it to `plan.updated` as a full replacement.
- **OpenCode** — `status` is free-form upstream; `cancelled` is a documented
  value. Don't whitelist a few statuses and silently drop the rest — an
  unrecognized status degrades to `pending` so a todo the agent wrote stays on
  screen.
- **General** — `plan.updated` is full-replacement; only a genuinely empty list
  clears the dock (a malformed frame maps to zero events, never a wipe).

The `plan.updated` **event name and payload structure are unchanged**; pre-rename PR 443
extended the *handling*, not the wire shape. `PlanStatus` has since gained a fourth
value, `cancelled` — see §3.

---

## Compatibility

The agent event protocol is a protected surface: see `BACKWARD_COMPATIBILITY.md`
§7. In short — v1 `AgentEvent` `type` strings and v2 `UiEvent` dotted types are
additive-only; removing/renaming one, or breaking the parity requirement, is a
breaking change requiring the documented deprecation path.

## Related documents

- `AGENTS.md` — repo working rules; the "Agent runners / backends" routing row.
- `BACKWARD_COMPATIBILITY.md` — §7 (this protocol) and §2/§3 (SSE names, NDJSON).
