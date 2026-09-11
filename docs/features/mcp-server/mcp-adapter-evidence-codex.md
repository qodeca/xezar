# Codex reaction adapter – runtime evidence

Issue: [#109](https://github.com/qodeca/xezar/issues/109), Phase 6 ([#73](https://github.com/qodeca/xezar/issues/73)) of
[epic #67](https://github.com/qodeca/xezar/issues/67). Covers F-17, F-20, F-21, D-01, D-04, A-19 and A-23 of the
[requirements](mcp-project-leader-requirements.md), for Codex only. The code is
`packages/xezar/src/mcp/adapters/codex.ts`; its unit suite is `codex.test.ts` beside it.

Run date: **2026-09-11**, 03:40–04:10 UTC. Repository base: `c1ffa95`. Host: macOS 26.6.2, arm64, Node v24.20.0.

## Answer first

- **A native MCP notification does not wake the Codex model.** Executed twice here against **codex-cli 0.154.0**: four
  unsolicited notifications reached Codex after an accepted tool call, and no turn and no model request followed
  (X1). This repeats D-05 § 4 and the #85 spike (T06) on the same version.
- **App-server `turn/start` was required, and it works through the real adapter.** An event appended to the real
  project journal went through the real event controller and this adapter, and Codex's next model request carried
  it – with **zero model requests** in the idle window before it (X2). No polling turn exists anywhere in the path.
- **`turn/steer` against an active turn:** accepted immediately, guarded by `expectedTurnId`; the steered input
  reaches the model at the turn's **next** model request, not at steer time. A wrong `expectedTurnId` and a steer
  after the turn ended are both refused. A `turn/start` sent while a turn is running is silently folded into that
  turn and answers the running turn's id (X3).
- **Role instruction across `thread/resume`:** the `developerInstructions` given at `thread/start` stays in effect after
  `thread/resume` in a new app-server process. A **different** `developerInstructions` (or a `config` override) given
  at resume was **not** applied – the original stayed and the new one never reached the model. `baseInstructions`
  **replaced** Codex's built-in instructions (16 979 characters became 56). The adapter therefore uses
  `developerInstructions` only (X5).
- **Delivery hierarchy, as built:** rung 1 (native) is not used – no demonstrated reaction. Rung 2 (app-server) is used.
  Rung 3 (terminal) is **refused** with a recoverable blocker; nothing in the adapter can type into a terminal.
- **Open blocker, kept in scope:** a Codex session the user opened in their own terminal is not targetable. The one
  attempt to reach a thread through a shared app-server socket did not complete a handshake (X9). See
  [Open blockers](#open-blockers).
- **This is not A-19 evidence.** A scripted local model endpoint stood in for a real model (fixture rules forbid
  personal accounts). It proves Codex started model work carrying the event; it does not prove what a real model
  decides.

## How to read this record

Every statement carries one label:

| Label | Meaning |
| --- | --- |
| **Executed** | Run on this machine on 2026-09-11 in this task; the transcript excerpt is below. |
| **Executed in #85 / D-05** | Run by an earlier spike on the same machine and the same Codex version; cited, not re-run. |
| **Fixture-tested** | Proven by a named case in `codex.test.ts` (or an earlier suite) against a fake app-server. |
| **UNVERIFIED** | Not observed. The reason is given. Documentation alone never moves a claim out of this label. |

"Reacted" means the same thing it meant in #85: Codex itself sent a new model request that carried the event, and the
scripted endpoint received it. The adapter records the reaction (`reactedSeq`) when app-server reports the event's
`userMessage` item starting – the point at which Codex samples the model with it – and never on delivery.

## Environment and fixtures

| Item | Value |
| --- | --- |
| `codex --version` | **`codex-cli 0.154.0`** (Executed). The brief's research machine had 0.153.4. An installed version, not a certified minimum. |
| Binary | The npm binary, invoked directly. The personal wrapper earlier on `PATH` (see D-01 § 9.3) pins its own `CODEX_HOME` and was **not** used. Every app-server `initialize` answered `"codexHome":"/private/tmp/xez109/codex-home"`, which confirms the isolation took. |
| Isolation | `HOME` and `CODEX_HOME` in `/tmp/xez109`; `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY` unset; a custom model provider (`wire_api = "responses"`) pointed at `127.0.0.1:48609` with a dummy key string that is not a credential; `approval_policy = "never"`, `sandbox_mode = "read-only"` except where a scenario overrides them per thread; fresh scratch Git repositories as projects. `XEZ_DRY_RUN=1` in every process. |
| Model | A scripted Responses-API endpoint (the #85 harness, extended): it echoes the last input, calls a named tool on `CALL <name>`, delays its answer 8 s on `SLOW`, calls `exec_command` on `RUNCMD`, and logs every request with the role markers it contains and whether it carries a xezar event. |
| xezar code under test | Real `EventJournal` (#103), `ProjectOwnership` (#99), `EventController` (#107) and this adapter, run from the task worktree. The **only stand-in** is the journal append: the E-01–E-06 emitter (#104) is not on `main` yet, so the driver appends the row itself. |
| MCP servers | The #85 probe server (for the native-notification test) and xezar's real bridge `xez mcp` (for the tool-call row). |

No personal account, credential, or real user task was used. Logs, request dumps and the drivers stay in the task's
evidence folder (`.local/xezar-tasks/<runId>/codex-adapter/`), which is never committed.

`codex-app-server-runner.ts` is an **implementation anchor** – the adapter reuses its transport helpers to spawn and
speak to app-server. It is not cited anywhere below as evidence that this event flow works; only the runs are.

## The twelve-behaviour record

The row list is the one #85 used (the issue says twelve; its body names thirteen behaviours once "process crash,
lease expiry and fencing" is split). Rows marked for #85 were not re-run here because nothing in this adapter changes
them.

| Behaviour | Codex result | Label |
| --- | --- | --- |
| tool call | **PASS** through xezar's real bridge: a trusted project `.codex/config.toml` (the D-04 § 3.2 block) started `xez mcp`, the model called `health`, and the bridge's answer reached the model (X12). With no cockpit registered in the isolated `XEZ_HOME`, that answer is the legible "not a xezar project yet" result, not a transport error. A tool that reaches a running service is **UNVERIFIED** here (not attempted: no project was registered and served); the #85 probe call is the client-side precedent. | Executed (X12) / Executed in #85 (T02) |
| project scope | A trusted project `.codex/config.toml` binds the server; an untrusted one is silently not loaded. The adapter adds a second guard: a dispatch for any project other than the adapter's own is refused, never delivered. | Executed in #85 (T14) and D-04 § 8.3; the adapter guard is Fixture-tested (`refuses a dispatch for another project`) |
| second-client rejection | A second event controller for a project already owned is refused with project-occupied. The adapter never acquires: it is handed a session by the controller. | Fixture-tested in #107's suite; the Codex client side (app-server `mcpServer/startupStatus/updated` carries the error) Executed in #85 (T08) |
| process crash | App-server crash: deliveries fail, the controller goes `disconnected` and keeps the rows; a new app-server process with `thread/resume` and a new session delivers them once (X7). Bridge crash: Codex does not restart a crashed stdio MCP server – every later call fails with `Transport closed`. | Executed here (X7) / Executed in #85 (T09) |
| lease expiry | The controller re-checks ownership before every dispatch and at every heartbeat and ends when the lease is gone; the adapter then receives nothing. | Fixture-tested in #107's suite. **UNVERIFIED** end to end with a live Codex – not attempted, the lease is xezar state and no Codex behaviour is involved |
| fencing | As above: a stale session cannot dispatch. | Fixture-tested in #99/#107. **UNVERIFIED** with a live Codex, same reason |
| idle-but-live session | Six seconds idle after the tool call: zero model requests (X2). The heartbeat is `thread/read`, which reached no model (X10). A 300 s idle with 10/10 pings answered. | Executed (X2, X10) / Executed in #85 (T12) |
| asynchronous completion causing a real model reaction | **Reacted through app-server `turn/start`**, with no model request between the tool result and the event (X2). Native notifications: no reaction (X1). | Executed |
| human event | A `human`-origin row appended to the real journal reached the model once (X2, X4). A human change in the cockpit emitting that row is **UNVERIFIED** here: the emitter (#104) is not on `main`. | Executed (journal → model); UNVERIFIED (cockpit → journal) |
| replay and dedup | After a crash and reconnect, the new session redelivered exactly the rows after the leader's last ack (2 and 3, not the acked 1) in one turn (X7). Two controller retries of the same rows produced one turn and one model request (X6). App-server itself does not deduplicate (X6). | Executed |
| stale mutation | Codex surfaces a conflict result's text to the model intact. | Executed in #85 (T10); the stale-write check itself is #100 |
| idempotent lost response | app-server's answer to `turn/start` was held 2.5 s, past the controller's attempt limit: two attempts were aborted, the third waited for the first and sent nothing new – one turn, one model request (X6). Client side: Codex times out a tool call once and does not retry it. | Executed here (X6) / Executed in #85 (T11) |
| prompt persistence | The role instruction given at `thread/start` persisted across `thread/resume` in a new process; a different one given at resume did not replace it (X5). | Executed |

### Reaction paths by the approved hierarchy

| Rung | Codex 0.154.0 | Label |
| --- | --- | --- |
| 1. Native MCP notification (`notifications/message`, `resources/updated`, `resources/list_changed`, `claude/channel`) | **FAIL** – delivered to Codex, no turn, no model request (X1) | Executed |
| 2. Official programmatic session interface (app-server `turn/start`, `turn/steer`) | **PASS** – through the real adapter and controller (X2, X3) | Executed |
| 3. Terminal text input | **REFUSED** – `codexTerminalDelivery()` returns a recoverable blocker and nothing is attempted | Fixture-tested (`terminal delivery is refused …`) |

The rung-3 preconditions the contract lists, and what this adapter does about each on rung 2 instead:

| Hazard | On rung 2 (built) | Label |
| --- | --- | --- |
| Project targeting | One adapter per bound project; a dispatch for another project is refused. | Fixture-tested |
| Session targeting | The adapter only speaks to an app-server connection it was handed, and filters every notification by the leader's `threadId`; a steer carries `expectedTurnId`, which app-server enforces (X3). | Executed (X3) / Fixture-tested (`ignores another thread's …`) |
| Approval prompts | While app-server waits on an approval or user-input prompt for the thread, nothing is handed over; the adapter never answers a prompt (X8). | Executed (X8) / Fixture-tested |
| The shell | Nothing in the adapter reaches a shell or a terminal. | By construction; Fixture-tested (rung 3 refused) |
| User typing | Not applicable to an app-server session xezar holds: there is no terminal line to share. A user's own TUI session is the open blocker below. | Blocker B1 |
| Active turns | Steered, never a second turn (X3). | Executed |
| Duplicate prevention | Rows already handed over are never re-sent; a retry waits for the attempt before it. App-server does **not** deduplicate a repeated `clientUserMessageId` (X6), so this is the adapter's job. | Executed (X6) / Fixture-tested |

## Decisions this adapter makes, and the evidence behind each

Each is an engineering decision under requirements § 12. None changes an Agreed outcome.

1. **Delivery through app-server `turn/start`, or `turn/steer` into the leader's active turn.** Evidence: X2, X3. The
   steer is the documented way to target an active turn, and its `expectedTurnId` precondition is what makes a race
   safe: when the turn ends first, the steer is refused and the adapter starts a new turn instead.
2. **Delivery and reaction are recorded apart.** `deliver` resolves when app-server accepted the request; the reaction is
   recorded when the event's `userMessage` item starts, matched by `clientId` (which app-server echoes from
   `clientUserMessageId`, X6). For a steer that is several seconds later (8.2 s in X3), and in between the controller
   correctly shows `deliveredSeq 1, reactedSeq 0`.
3. **The adapter deduplicates, because app-server does not.** Two `turn/start` requests with the same
   `clientUserMessageId` produced two turns and two model requests (X6).
4. **Approval prompts block hand-off; the adapter never answers one.** Evidence: X8. The session's host answers prompts;
   `CodexAppServerLink` – the only thing the adapter holds – has no way to.
5. **Role instruction in `developerInstructions` only, supplied on `thread/start` and on every `thread/resume`.**
   `baseInstructions` replaces Codex's built-in prompt (X5) and is never sent. Re-supplying on resume is harmless on
   0.154.0 (it is ignored, X5) and keeps the adapter correct if a later version honours it.
6. **The echo guard is opt-in and narrow.** A `leader` row whose `causedBy` the caller names as its own outstanding
   operation is dropped; nothing else is (X4, D-05 § 6.3).
7. **The event text names xezar as its source, disclaims user instruction and approval, and quotes every summary as a
   JSON string**, so text inside a summary cannot pose as the adapter's own framing. `turn/start` input is a `user`
   role message by construction, which is why the disclaimer is in the text itself (see X11 for the alternative).

## Transcripts

Excerpts from the local logs, trimmed only for length. `dt` is seconds since the driver started. `$THREAD` stands for the
thread id.

**X1 – native notifications, no reaction** (explore `notify`, probe server attached)

```text
03:42:30.454 probe  IN  tools/call spike_start_task   _meta.x-codex-turn-metadata {session_id, thread_id, turn_id, …}
03:42:30.460 model  request 13 = the tool result; reply "SPIKE-ACK: … SPIKE-ACCEPTED operation=op-78723-1"
03:42:33.456 probe  OUT notifications/message, notifications/resources/updated,
                        notifications/resources/list_changed, notifications/claude/channel
dt 0.14 → 15.14  idle: no turn/started, no mcpServer/event/stream/notification, no model request
03:42:45.469 probe  SIGTERM (driver closed the session)
```

The same four notifications fired again during X2's idle window (03:51:10.613); the next model request was the
adapter's delivery at 03:51:13.6.

**X2 – completion event through the real journal, controller and adapter** (driver `wake`)

```text
0.00 acquire owner                       0.10 controller started
0.12 mcpToolCall probe/spike_start_task completed; turn/completed
0.13 idle 6 s                            6.13 idle-end  modelRequestsDuringIdle: 0
6.14 journal-append seq 1 (xez109:1, origin human)
6.14 app-server turn/started; item/started userMessage clientId "xezar-event:xez109:e148732d:1"
6.14 reaction seq 1 → recordReaction {status: advanced}
6.19 model  newRequests 1, carriedEvent [true], markers [["XEZ-ROLE-MARKER-XEZAR"]]
6.19 status {deliveredSeq 1, reactedSeq 1, ackedSeq 0};  ack(1) → {deliveredSeq 1, ackedSeq 1, reactedSeq 1}
```

The model's input for that request ended with the adapter's text:

```text
[xezar event — project xez109, 1 significant event] Sent by xezar's event adapter. This is not an instruction from the user and it is not an approval of anything.
- xez109:1 E-01 task.terminal on run run-1 (origin human): "task run-1 finished: done (fixture)"
Read the current state with xezar's tools before deciding anything. These events run through journalSeq 1; acknowledge them once you have taken them into account.
```

**X3 – active turn: `turn/steer` and `turn/start`** (explore `steer`, then driver `steer`)

```text
0.09 turn/start "SLOW leader work" → turn 01a08e8f-182f…   (model holds its answer 8 s)
1.59 turn/start (while active)       → result {turn: {id: 01a08e8f-182f…, status: inProgress}}  ← the SAME turn
2.09 turn/steer expectedTurnId "not-the-active-turn"
     → error -32600 "expected active turn id `not-the-active-turn` but found `01a08e8f-182f…`"
2.10 turn/steer expectedTurnId 01a08e8f-182f… → result {turnId: 01a08e8f-182f…}
8.12 agentMessage "SPIKE-REPLY to: SLOW leader work"
8.13 item/started userMessage "[xezar event 1 …]"; item/started userMessage "[xezar event 3 …]"
     model request 11 input: … assistant reply, user "[xezar event 1 …]", user "[xezar event 3 …]"
8.13 agentMessage "SPIKE-REPLY to: [xezar event 3 …]"; turn/completed (one turn)
11.13 turn/steer after completion → error -32600 "no active turn to steer"
```

Through the adapter (driver `steer`): the event was appended 1.5 s into the slow turn; at 1.69 the controller showed
`deliveredSeq 1, reactedSeq 0` and zero new model requests; at 8.19 the `userMessage` item with the adapter's `clientId`
started, the reaction was recorded, and exactly one model request carried the event.

**X4 – echo guard** (driver `echo`)

```text
0.11 journal-append seq 1 origin leader causedBy op-leader-own-0001
3.11 after-echo {deliveredSeq 1, reactedSeq 0}, modelRequests 0
3.11 journal-append seq 2 origin human
3.14 reaction seq 2;  4.66 model newRequests 1 (carries xez109:2 only)
```

**X5 – role instruction precedence across `thread/resume`** (explore `resume` and `controls`; each resume in a NEW
app-server process; config.toml has `developer_instructions = "XEZ-ROLE-MARKER-CONFIG …"`)

| Step | Marker(s) in the model request | Base instructions |
| --- | --- | --- |
| `thread/start` with `developerInstructions` START | START (CONFIG absent) | built-in, 16 979 chars |
| `thread/resume`, no role parameter | START | built-in |
| `thread/resume` with `developerInstructions` RESUME | START (RESUME **absent**) | built-in |
| `thread/resume` with `baseInstructions` BASE | START in the developer message | **replaced**: 56 chars, starting "XEZ-ROLE-MARKER-BASE" |
| Control: `thread/start` with no role parameter | CONFIG | built-in |
| Control: `thread/resume` with `config.developer_instructions` OVERRIDE | CONFIG (OVERRIDE **absent**) | built-in |
| Control: a second thread with `developerInstructions` STARTTWO | STARTTWO | built-in |

Read: a thread's developer instructions are fixed when the thread starts. `thread/start`'s parameter wins over
config.toml; nothing supplied at resume changed them in any observed case. Through the adapter's own
`openCodexLeaderThread`, the xezar role marker was present in every model request (X2, X7).

**X6 – duplicates** (explore `dedupe`, driver `retry`)

```text
explore: turn/start clientUserMessageId "xezar-event:xez109:5-5" → turn 01a08e8f-1534…, model request 8
         turn/start clientUserMessageId "xezar-event:xez109:5-5" → turn 01a08e8f-1556…, model request 9
         both userMessage items carry clientId "xezar-event:xez109:5-5" – echoed, not deduplicated
driver (heartbeat 1 s, so one attempt may take 1 s; the first turn/start answer held 2.5 s):
0.11 deliver-attempt 1 seqs [1,2]; holding-answer 2500 ms
1.11 attempt 1 aborted by the controller → rejected "aborted"
1.13 deliver-attempt 2 seqs [1,2]       2.13 attempt 2 aborted → rejected
2.15 deliver-attempt 3 seqs [1,2]       (waits for attempt 1's request to settle)
2.61 reaction seq 2; attempt 3 resolved, handedThrough 2
5.66 turnsStarted 1, turn/start requests 1, model requests 1, status {deliveredSeq 2, reactedSeq 2}
```

**X7 – app-server crash and reconnect** (driver `reconnect`)

```text
0.12 journal-append seq 1; 0.15 reaction seq 1; 0.17 ack(1) → advanced
0.17 SIGKILL app-server pid 38735; journal-append seq 2, seq 3
0.46 controller-warn "MCP event delivery for project xez109 failed 5 times — retrying every 30s while the session owns the project"
3.17 while-down {state disconnected, deliveredSeq 1, ackedSeq 1, reactedSeq 1, latestSeq 3}, link closed
3.26 NEW app-server pid 50377; thread/resume of the same thread, role re-supplied; new controller session
3.32 item/started userMessage clientId "xezar-event:xez109:d1a9881b:1"; reaction seq 3
5.36 model newRequests 1, carriedEvent [true], markers [["XEZ-ROLE-MARKER-XEZAR"]]
     that request's last input names xez109:2 and xez109:3 only; status {deliveredSeq 3, ackedSeq 1, reactedSeq 3}
```

The five failures in 0.3 s are the controller's bounded round (#107: at most 5 attempts, backoff ≤ 200 ms); after
it, a closed link is retried once per heartbeat. Nothing was lost while the app-server was down.

**X8 – approval prompt open on the leader's thread** (driver `approval`; thread with `approvalPolicy: untrusted`)

```text
0.20 server-request id 0 item/commandExecution/requestApproval   (model asked to run `touch …`)
0.25 adapter promptOpen true; journal-append seq 1
4.25 while-prompt-open {state dispatching, deliveredSeq 0}, adapter handedThrough 0, model requests 0
4.25 the stand-in human declines (the driver answers the prompt, as a host would)
4.25 serverRequest/resolved; item/started userMessage clientId "xezar-event:xez109:61e7f362:1"; reaction seq 1
5.80 model newRequests 1, carriedEvent [true]; status {deliveredSeq 1, reactedSeq 1}
```

If a prompt stays open longer than one controller attempt (30 s), the attempt is aborted with nothing sent and the
controller's bounded retry takes over; the rows stay in the journal. Fixture-tested
(`a prompt that never resolves is bounded …`); not run live for 30 s.

**X9 – a thread in another client, through a shared app-server** (explore `shared`)

```text
0.00 codex app-server --listen unix:///tmp/xez109/app.sock      (pid 23019)
1.50 client U: codex app-server proxy --sock /tmp/xez109/app.sock  (pid 24054)
     initialize → no answer; still none after 2 min 17 s; the run was stopped by its PIDs
```

Not established. Whether the proxy expects a different socket (the managed daemon's), a different framing, or an
extra step was not determined. `codex queue --thread <id> --message <text>` ("Queue a message for an existing session",
read from `--help`) was therefore never reached. **UNVERIFIED.**

**X10 – non-model heartbeat** (explore `heartbeat`): three `thread/read` and one `thread/loaded/list` on a live thread;
model log line count unchanged (1 → 1).

**X11 – `thread/inject_items`, observed and not adopted** (explore `inject`)

```text
0.12 thread/inject_items [{type: message, role: developer, content: "[xezar event 6 …]"}] → {}
5.12 no turn/started in 5 s
5.12 turn/start input [] → a new turn; model request 3: last input item is role "developer" with the event
5.13 agentMessage "SPIKE-REPLY to: [xezar event 6 … (injected as a developer item)]"
```

This carries an event to the model as a `developer` item instead of a `user` message. It is not in the adapter surface
the compatibility report documents (`turn/start`, `thread/resume`, `turn/steer`), so it is recorded as a candidate, not
built on. See the follow-up below.

**X12 – tool call through xezar's real bridge, configured the D-04 way** (explore `bridge`, project
`/tmp/xez109/projx` with a `trust_level = "trusted"` entry and this `.codex/config.toml`)

```toml
[mcp_servers.xezar]
command = "node"
args = ["--import", "<worktree>/node_modules/tsx/dist/loader.mjs", "<worktree>/packages/xezar/src/index.ts", "mcp"]
default_tools_approval_mode = "approve"
env = { XEZ_HOME = "/tmp/xez109/xezhome", XEZ_DRY_RUN = "1" }
```

The block is D-04 § 3.2's with one deliberate change: it runs this branch's source instead of
`npx -y @qodeca/xezar mcp`, so the run is offline and tests the code under review.

```text
0.84 item/started mcpToolCall server "xezar" tool "health" readOnlyHint true
0.85 item/completed … result "This directory is not a xezar project yet. Start the cockpit here once with `xez`
     (or `npx @qodeca/xezar`) so it is registered, then call this tool again."  structuredContent {status: not-registered}
0.85 agentMessage "SPIKE-ACK: … {\"status\":\"not-registered\"}"; turn/completed
```

## Open blockers

Each keeps Codex in scope. None is solved by polling.

| ID | Blocker | Adapter or client extension that would close it | Evidence status |
| --- | --- | --- | --- |
| B1 | A Codex session the user opened in their own terminal cannot be reached: its thread lives in that process, and attaching a second writer to it is the covert second leader the contract forbids. `codexReactionTarget` answers `codex-session-not-targetable` (recoverable; events wait in the journal). | An app-server both the TUI and xezar attach to as clients (`codex --remote unix://…` with `codex app-server --listen`, or the managed `codex app-server daemon`), plus `codex queue --thread` or `turn/start` from xezar's client. | X9 attempted, handshake not established. **UNVERIFIED.** |
| B2 | No real-model reaction (A-19, A-23). | One run of X2 against a real model account on the release-candidate revision, under a separate decision about which account may be used. | Not attempted: fixture rules forbid personal accounts. |
| B3 | A user's change to the per-project role instruction does not reach a resumed thread (X5). | Start a new thread when the role changes, or a Codex parameter that updates a thread's developer instructions. | Executed (the non-application); no remedy tested. |
| B4 | Who hosts the approval prompts of an adapter-owned leader session. The adapter observes and waits; something must show the prompt to the human. | The leader-session host (outside this issue). | Design gap, recorded. |

## What is still UNVERIFIED

1. A model turn started by a xezar event **in a Codex TUI** (B1).
2. What a **real** model does with the event (B2).
3. That Codex's sandbox prevents the leader from editing its own role instruction in the thread's rollout under
   `CODEX_HOME` (requirements § 12). Not attempted. xezar's side holds: no MCP tool exposes the role text, and the
   adapter takes it only from its caller. Prompt text is not enforcement.
4. Whether `turn/start` folding into a running turn (X3) is stable across Codex versions. The adapter does not depend on
   it: it steers when it knows a turn is active, and records the reaction by `clientId` either way.
5. Lease expiry and fencing with a live Codex session attached (xezar state; fixture-tested only).
6. A prompt held open for longer than one 30 s controller attempt, live.

## Follow-ups this record names

- B1: establish the shared-app-server handshake (X9) or the managed daemon path, then test `codex queue` and a
  second-client `turn/start` against a TUI attached with `--remote`.
- X11: decide whether `thread/inject_items` plus an empty `turn/start` may replace the `user`-role message, after
  confirming it is a supported app-server method rather than an experimental one.
- B2: the A-19 real-model run.
