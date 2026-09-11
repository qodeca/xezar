# Claude Code reaction adapter – runtime evidence

> **2026-09-11 — the spawn path this record describes was removed** before release 0.14.0 (owner decision on #311: xezar does not start agent processes). The Claude Code adapter's stream-json session needed a process xezar started, so it is gone from the product; this record stays as the evidence of what was measured. A leader in this client gets no push and reads its events with `leader_events`. See #323 and #324.

Issue: [#108](https://github.com/qodeca/xezar/issues/108). Phase 6 ([#73](https://github.com/qodeca/xezar/issues/73))
of [epic #67](https://github.com/qodeca/xezar/issues/67). Covers F-17, F-20, F-21, D-01, D-04, A-19 and A-23 of
[the requirements](mcp-project-leader-requirements.md), for Claude Code only.

Run date: **2026-09-11**, 03:40–04:10 UTC. Repository base: `c1ffa95` (main), plus the adapter in
`packages/xezar/src/mcp/adapters/claude-code.ts` on branch `xez/3bb8bc35`. Host: macOS (Darwin 25.6.0, arm64),
Node v24.20.0. The branch was then merged up to `74bc465`, and later `ef557fb`, before handoff. Every file the live run exercised
(`mcp/service.ts`, `mcp/bridge.ts`, `mcp/event-controller.ts`, `mcp/event-journal.ts`, `src/index.ts`) is
unchanged between the two (`git diff --stat c1ffa95..74bc465` on them is empty), and the unit suite passes on
the merged base. `74bc465` only adds MCP tools to the list the model is offered. `ef557fb` adds the #104
event-catalog module (`mcp/event-catalog.ts`); at that revision nothing outside its own tests and the
contract index imports it, so it does not change what the running service does. The branch was later merged
up to `eb8fa76` (#98 local handoff, #110 OpenCode adapter, #109 Codex adapter). Of the files above, only
`mcp/tools/index.ts` changed: it adds the `local_handoff` tool to the list the model is offered.

## Answer first

- **The adapter makes Claude Code start a turn, through step 2 of the hierarchy (OBSERVED).** The mechanism is
  one stream-json `user` line that the adapter writes to the stdin of a `claude -p --input-format stream-json`
  process that xezar started and owns. The line carries a journal row inside a message that names xezar as
  its source. Claude Code then sends a new inference request that carries it (L-S2, L-S3, L-S5). That a
  **real model** reacts to that request is **INFERRED**, not observed: a scripted endpoint answered every
  request here (OB-5).
- **Step 1 is not used.** Generic MCP notifications start no turn (D-05 § 4, spike T04). A Channels push did
  not register on 2.1.268 under isolated fixtures (CH1). Channels stays a research preview. **Eligibility was
  not established**, and nothing here presents Channels as generally available.
- **Step 3 is refused.** Terminal input is never used. A Claude Code session the user opened themselves is a
  recorded, recoverable blocker (OB-1 below), not a keystroke.
- **Every acceptance item has a transcript**, with one limit that decides the verdict: the model was a
  **scripted local endpoint**, not a real model. That proves Claude Code started a real turn carrying the
  event. It does not prove what a real model decides. **This is not an A-19 pass** (OB-5).
- **A failed API call is not counted as a reaction.** Claude Code echoes the message and then prints a
  made-up `assistant` frame (`"model":"<synthetic>"`) when the API call fails (A1). The adapter treats that
  frame as "no model answered" and keeps the rows owed. A code review found this case; the first version of
  the adapter would have over-reported it.
- **Two gaps in `main` were found and worked around in the harness, not fixed here.** Nothing constructs the
  adapter in the service yet. No running service code emits E-01–E-06 journal rows yet: #104 was still open during the live runs, and
  merged at `ef557fb` as a module nothing imports. Also, the
  MCP task tools answer `task_create is not connected to the xezar service in this session` (finding F-1).

## How to read this record

Evidence labels, as in the [spike report](mcp-client-behaviour-spike-report.md):

| Label | Meaning |
| --- | --- |
| **Executed** | Run on this machine on 2026-09-11. The transcript ID points to § Transcripts. |
| **Fixture-tested** | Proved by `claude-code.test.ts` against a fake stream-json process, not a real CLI. |
| **Read from source** | Read in this repository at the revision above, with the file named. |
| **Documentation only** | A vendor page or `--help` says so; no run here confirms it. |
| **Not attempted** | Named, with the reason. |
| **INFERRED** | Expected from what was observed, but not observed itself. Never counted as a pass. |

**Model reaction, as measured here** (the spike's definition, kept): Claude Code itself sent a new inference
request that carried the event, and that request arrived. The adapter records it only after Claude Code echoes
the message back (`isReplay`) **and** the model's `assistant` output follows. In every run here that output
came from the scripted endpoint, so "the model" below means the endpoint's fixed rules. What a real model
would decide is **INFERRED** only.

**Implementation anchors are not evidence.** The adapter reuses `resolveClaudeExecutable`, the EOF grace
constants (`core/claude-cli-runner.ts`) and `buildChildEnv` (`core/agent-env.ts`). Those modules run task
agents. That they work for tasks proves nothing about this event flow. Everything claimed below comes from
the runs in this record.

## What is documented, and what is not

Carried forward from the [compatibility report](mcp-client-compatibility.md), with what this issue observed.

| Topic | Documented | Observed here |
| --- | --- | --- |
| stdio MCP, explicit MCP configuration | Yes | **Executed**: `--mcp-config` (inline JSON) with `--strict-mcp-config` connected exactly one server, `xezar`, through the real `xez mcp` bridge (L-S2) |
| Project `.mcp.json`, local and project scopes (D-04 § 3.1) | Yes | **Not attempted**: the adapter-owned session uses `--strict-mcp-config`, so it ignores both scopes on purpose. That keeps a one-time registration from adding a second `xezar` server to the same session |
| Role instruction: `--append-system-prompt` (or its file form); replacement flags differ | Yes | **Executed**: appended text reached every request after startup and after resume (P3b, P3c, L-S5). The adapter never passes `--system-prompt` |
| Flags are invocation-specific | Yes | **Executed**: `--resume` without the flag ran with **no** role text (P3a). The adapter reapplies the flag on every start and resume |
| `--system-prompt-snapshot on` (the default) reuses the first recorded prompt on every resume | `claude --help` on 2.1.268 only | **Executed, and the opposite was seen**: a resume with **new** text used the new text (P3b), and a resume without the flag had none (P3a). The help text says the option has "No effect where system-prompt recording is not yet enabled". So the adapter does not rely on it. It stays **Open** whether a later version enables recording |
| Programmatic interface: stream-json input, continuation, resume | Yes | **Executed**: used for every delivery. A completed print command is not an always-listening client, so the #107 controller drives it |
| Channels (`notifications/claude/channel`) pushes into a running session | Yes, as a **research preview** with account and organisation constraints | **Executed, did not register**: see § Channels eligibility, as observed |
| Minimum Claude Code version | **Not certified** | Installed version observed: `2.1.268 (Claude Code)`. This is not a minimum |

## Environment and fixtures

**Executed** on 2026-09-11. `claude --version` printed `2.1.268 (Claude Code)`. The binary was resolved first:
`~/.local/bin/claude` is a symlink to `~/.local/share/claude/versions/2.1.268`, a Mach-O executable, not a
wrapper script. The spike's Codex incident (a wrapper overriding the isolated home) cannot repeat that way.

| Piece | What ran | Isolation |
| --- | --- | --- |
| Claude Code | The installed 2.1.268 binary, behind a two-line fixture wrapper that adds `--bare` | `HOME` and `CLAUDE_CONFIG_DIR` pinned to scratch folders under `/tmp`. `--bare` means no keychain, no OAuth and no `CLAUDE.md` discovery. `ANTHROPIC_BASE_URL` pointed at the scripted endpoint. `ANTHROPIC_API_KEY` held a dummy string, not a credential. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |
| Model | A scripted Anthropic Messages endpoint on `127.0.0.1` (about 90 lines of Node) | Not a model. It logs every request, including which role marker is in the system prompt, and answers from fixed rules |
| xezar service | `packages/xezar/dist/index.js serve`, built from this branch | `XEZ_DRY_RUN=1` (task agents are the bundled mocks), `XEZ_HOME` pinned to scratch, a fresh scratch git repository as the project |
| MCP bridge | The real `xez mcp` (`dist/index.js mcp`), spawned by Claude Code from the adapter's `--mcp-config` | Finds the project's socket under the isolated `XEZ_HOME` |
| Journal, owner slot, controller | The real `EventJournal` (#103), `ProjectOwnership` (#99) and `EventController` (#107) | A scratch data directory owned by the harness |

**Stand-ins, stated so nobody mistakes them for product behaviour:**

1. **The harness appends the journal rows.** Nothing in `main` emitted E-01–E-06 during the runs (#104
   was an open pull request; it merged afterwards at `ef557fb`, and nothing imports it yet). Each appended row uses the D-05 § 6.3 envelope, validated by the real journal.
   For L-S3 the harness learns that the task finished through `fs.watch` on the fixture project's
   `runs.json`, and then appends the E-01 row. That watch is not a model turn, and it is not product
   behaviour.
2. **The harness wires the controller and the adapter.** The MCP service does not construct either yet
   (**Read from source**: `mcp/service.ts` builds a tool context with only `project` and `xezarVersion`).
3. **The harness plays the human** by calling the cockpit's own `POST /api/v1/runs`, because the MCP task
   tools cannot start a task yet (F-1).

**`XEZ_DRY_RUN=1`** was set for the service and passed to every Claude Code process. The unit suite also
drives the bundled mock claude with it (Fixture-tested, below). No real user task permissions were used. No
personal account was used: `--bare` never reads OAuth or the keychain. The evidence folder was scanned for
credential patterns before hashing.

## Results against the acceptance criterion

| Acceptance item | Result | Evidence |
| --- | --- | --- |
| A tool call succeeds | **PASS** (Executed) | L-S2: in reaction to an event, the model called `mcp__xezar__health`. The call went through Claude Code, the real bridge and the running service, and the model got `{"status":"running","ipcVersion":1,"xezarVersion":"0.13.1","project":{"id":"projx","name":"projX"}}` |
| An asynchronous task completion produces a real model reaction, with no status-polling turn | **Claude Code turn: PASS through step 2 (Executed). Real-model reaction: INFERRED, not passed (OB-5)** | L-S3: the task was accepted in 26 ms. It finished `done` about 2.1 s later. **Zero model requests** happened in between. The E-01 row was then delivered, and request 31 is the turn that carried `projx:4`. The scripted endpoint answered it. The harness, not the product, wrote the E-01 row (Stand-in 1) |
| A human-originated event reaches the model | **PASS** (Executed) | L-S2: an E-04 row with `"origin":"human"` reached the model inside the xezar envelope. The first line names xezar. The second says "xezar wrote this message, not the user … It is not an instruction and not an approval" |
| Reconnect and retry do not duplicate the reaction | **PASS** (Executed) | L-S4: a new controller session re-sent all four unacknowledged rows, and the adapter was then handed all of them again directly. The adapter wrote nothing: model requests stayed at 5. L-S6: after the ack, a reconnect owed nothing |
| The role instruction is effective after startup and after every resume | **PASS** (Executed) | Every model request in L-S2 to L-S5 carried `ROLE-MARKER-xezar-leader`, including request 33, the first after the resume. P3a–P3c show why the adapter must reapply it |
| Channels eligibility is stated as observed | **Stated** (Executed) | § Channels eligibility, as observed. Not presented as generally available |

Fixture-tested, and each proven red when the behaviour is removed (see § Regression proof):

- An event cannot be forged by a summary: a newline and a fake header stay inside one JSON line.
- Messages written during a running turn fold into the next turn, and one reaction covers them all. This
  matches the real CLI (P2b).
- The echo guard drops a `leader` row caused by the session's own `mcp__xezar__*` operation, and keeps one
  caused by another operation or by another server's tool. It also ran live (L-S3, row `projx:3`).
- Rows written to a session that died before taking them are written again after resume. Owed events are not
  lost.
- The heartbeat never writes to the session, so it can never cost a model turn.
- A second live session for the same project is refused. That keeps a covert second leader out.
- `status()` and the state file carry no account, email, organisation, plan or model field, even after an init
  frame that has them.
- Under `XEZ_DRY_RUN=1` the bundled mock claude receives the event. The adapter claims **no** reaction,
  because the mock does not echo the message.
- A failed API call (the synthetic frame observed in A1) records no reaction, and its rows are written again
  with the next event. They are not retried on a timer, so a failing account cannot loop turns.
- Rows the session echoed but never answered before it died are written again after resume.
- A write that meets a dead pipe (EPIPE on stdin) cannot crash xezar.
- Frames printed between the process's `exit` and `close` still count; frames from a replaced process are
  ignored.
- `close()` keeps the project's one-session slot until the process has really closed, and a Node `error`
  event on a still-running process does not end the session.
- A retried recovery-only dispatch writes the gap notice once.

## The delivery hierarchy, as implemented

The order is Agreed (requirements § 12) and is not changed here. `claudeCodeRoute()` returns these steps.

| Step | Mechanism | Adapter-owned session | Session the user opened | Basis |
| --- | --- | --- | --- | --- |
| 1 | Native: MCP notifications | Not used | Not used | D-05 § 4 and spike T04 (Executed): delivered, no turn |
| 1 | Native: Claude Code Channels | Not used | Not demonstrated, so a blocker | CH1 (Executed): did not register |
| 2 | stream-json stdin of a session the adapter started | **Used** | Unavailable: xezar does not own that stdin | L-S2, L-S3, L-S5 (Executed) |
| 3 | Terminal text input | **Refused** | **Refused** | Nothing proves session targeting, separation from approval prompts, the shell, user typing or active turns, or duplicate prevention for a terminal. So the refusal is required |

The adapter starts a session only when a caller asks (`start`, `resume`). It never starts one from `deliver`.
A dead session stays `stopped`, with a recoverable blocker in `status()`, until someone resumes it (L-S5). This
follows requirements A-16 and the compatibility report's "restarted-awaiting-resume" state. It is a
deliberate human exit, not an accidental dead end. Events keep accumulating in the journal meanwhile, and the
controller retries every 30 s (B-17). The retry is non-model: `deliver` rejects at once while no session runs.

## The leader cannot edit its own instruction

- The instruction rides on argv (`--append-system-prompt`), resolved by the caller on every start and resume.
  No file is involved that the leader could reach.
- The session runs with `--permission-mode dontAsk` and `--allowedTools mcp__xezar`. **Executed (D1)**: the
  model asked to run `Bash` (`touch …/owned2.txt`). Claude Code answered "Permission to use Bash has been
  denied because Claude Code is running in don't ask mode", and no file was created. `Write` was not offered to
  the model at all in the `--bare` fixture. Whether it is offered without `--bare` was **not attempted**;
  `dontAsk` denies it either way (Documentation only).
- `--strict-mcp-config` loads only the `xezar` server, so no other MCP server can add a write tool.
- **Remaining limit, not closed here:** allow rules in the user's own Claude Code settings files still apply
  under `dontAsk`. A user who has pre-approved, say, `Bash` in `~/.claude/settings.json` gives that approval to
  this session too. Prompt text is not enforcement, and this record does not claim it is.

## Channels eligibility, as observed

**Executed (CH1)** on Claude Code 2.1.268. A throwaway stdio server declared
`capabilities.experimental["claude/channel"]` with `instructions` naming xezar as the source. It sent one
`notifications/claude/channel` event 3 s after `initialized`. The session was started with
`--dangerously-load-development-channels server:probe`, without `--bare`, with a debug file, and with the
isolated home and the dummy key.

- The server connected (`"status":"connected"`), and the notification left the server at 3005 ms.
- In the 17 s that followed, **no model request arrived**.
- The debug log read
  `[session-notices] advertise=false mode=dontAsk flag=false(disabled) pollChannel=false remote=false remoteEnv=false nonInteractive=true`.
- `claude --help` on 2.1.268 lists no `--channels` flag. The development flag is not in the help text either.

**What eligibility required, as far as observed:** the isolated fixture had neither claude.ai nor Console
authentication, and the feature gate reported `flag=false(disabled)`. The [Channels](https://code.claude.com/docs/en/channels)
page (read 2026-09-10 for the spike, not re-read here) requires claude.ai or Console API-key authentication,
and Team and Enterprise organisations must enable it. **No account or organisation configuration was found
that makes Channels work**, because none could be tried: the fixture rules exclude personal accounts. A failed
run here cannot tell "not eligible" apart from "does not work". So Channels is recorded as **not
demonstrated**, never as unavailable, and never as generally available.

## Findings

- **F-1 – MCP task tools are not wired to the service in `main`** (Executed, L-S2). `task_create` returned
  `task_create is not connected to the xezar service in this session.`
  **Read from source**: `mcp/service.ts` builds the tool context as `{ project, xezarVersion }`, with no
  `service`, and `mcp/tools/task-create.ts` refuses without one. So a leader in `main` cannot start a task
  through MCP yet. That belongs to the service-wiring work, not to this adapter. The operation id the leader
  sent (`op-leader-0001`) was still read from its tool call, which is what the live echo probe used.
- **F-2 – Claude Code gives the model `structuredContent`, not the text block, for this bridge's results**
  (Executed, L-S2). The model saw the JSON object, not the prose line
  "xezar 0.13.1 is running for project …". D-05 § 6.8 decides that the text block is authoritative. For Claude
  Code 2.1.268, the structured copy is what reaches the model. A tool whose structured and text halves
  disagree would mislead a Claude leader.
- **F-3 – Queued messages fold into one turn** (Executed, P2b). Two messages written while a turn was running
  came back as **one** echo with two text blocks, then **one** turn. So a reaction cannot be counted by writes.
  The adapter matches a per-message token inside the echo instead.
- **F-4 – The echo arrives right before the model output, not when the message is read** (Executed, P2b).
  With a 4 s scripted delay, the echo of the first message appeared at 4116 ms, just before its `assistant`
  frame. It is therefore a conservative signal: it marks a turn about to produce output, not queue entry.
- **F-6 – A failed API call ends in a synthetic assistant frame after the echo** (Executed, A1). With a
  scripted HTTP 400, Claude Code printed the echo, then
  `{"type":"assistant","message":{"model":"<synthetic>",…"API Error: 400 scripted bad request"},"error":"unknown"}`,
  then a `result` with `is_error: true`. Counting any assistant frame after the echo as a reaction would
  therefore report a turn that never ran. The adapter excludes frames with `model: "<synthetic>"`, an `error`
  field or `isApiErrorMessage`.
- **F-7 – An HTTP 401 is retried silently** (Executed, A1). With a scripted 401, Claude Code retried with
  growing waits (requests at 0, 0.6, 1.6, 3.9, 8.3, 17.7, 35.8 and 74.1 s, and on) and printed no echo and no
  frame meanwhile. So a leader whose credentials stop working shows delivery without reaction, which is the
  honest state. How long it retries before giving up was not measured.
- **F-5 – An idle stream-json session makes no model request** (Executed, L-S1). A session with no first
  prompt stayed 15 s with zero model requests. Claude Code sent only one non-model `GET /api/hello` at start.

## Open blockers

Each blocker keeps Claude Code in scope. None is solved by model polling.

| ID | Blocker | Adapter or client extension that would close it | Status |
| --- | --- | --- | --- |
| OB-1 | No supported interface wakes a Claude Code session **the user opened themselves** | **Claude Code Channels**, once an eligible account and organisation are allowed and a run shows the model reacting. Until then, the adapter-owned session (this adapter) is the working route | Channels did not register (CH1); eligibility needs an account decision |
| OB-5 | No real-model reaction evidence (A-19) | The harness in this record, pointed at a real model on the release-candidate revision, under a separate decision about which account may be used | Not attempted: the fixture rules forbid personal accounts |
| OB-6 | Nothing constructs the adapter in the running service, and nothing emits journal rows | Service wiring that opens the journal, starts the controller for the owning session and hands it this adapter; calling the #104 emitter (`mcp/event-catalog.ts`) from the places state changes | Wiring not in `main` at `ef557fb`; the emitter module is, unused. The harness did both (Stand-ins 1 and 2) |
| OB-8 | The echo guard learns the session's own `operationId`s from the `assistant` frame that carries the tool call. If Claude Code ever starts the MCP call before printing that frame, a row caused by it could reach `deliver` first and pass the guard | An operation list fed from the xezar side (the service knows which session sent each operation) instead of from stdout | Raised by the code review; not observed and not tested live. The consequence is one extra message the leader deduplicates, not a lost event |
| OB-7 | The production path runs without `--bare`, on the user's own login | A run on a machine and account allowed for it | Not attempted: same account rule as OB-5 |

## Regression proof

Every behaviour below was removed from the source in turn, and the suite was run against the broken copy
(**Executed**, 2026-09-11). The source was restored and compared byte for byte after each run.

First version (23 tests):

| Change to the source | Result |
| --- | --- |
| Baseline | 23 passed |
| No `--append-system-prompt` on resume | 2 failed |
| No deduplication of already-written rows | 3 failed |
| Reaction recorded without the echo | 4 failed |
| No echo guard | 1 failed |
| No carry-over of unconfirmed rows | 1 failed |
| Source file absent | the suite cannot load: red |

After the review fixes (31 tests):

| Change to the source | Result |
| --- | --- |
| Baseline | 31 passed |
| No `error` listener on stdin (EPIPE) | 1 failed |
| A synthetic assistant frame counts as a reaction | 1 failed |
| The session ends on `exit` instead of `close` | 2 failed |
| Frames from a replaced process are not ignored | 1 failed |
| `close()` frees the project slot before the process closes | 1 failed |
| An `error` event on a running process ends the session | 1 failed |
| A retried recovery notice is written again | 1 failed |
| Echoed but unanswered rows are dropped when the session dies | 1 failed |
| No `--append-system-prompt` on resume | 2 failed |
| No deduplication of already-written rows | 3 failed |
| No echo guard | 1 failed |

The live harness was then run a third time on the fixed code, with the same outcome in every step: acceptance
in 32 ms, zero model requests between acceptance and the completion event, no new request after reconnect and
retry, and the role marker present after resume.

Manual QA re-ran the same harness at `5a4af6d` (2026-09-11) with the same outcome: acceptance in 29 ms, zero
model requests until the task was `done`, then one request carrying `projx:4`; no new request after reconnect
and retry; the role marker present after resume.

## Transcripts

Excerpts from the local logs, trimmed only for length. Timestamps are milliseconds from each run's start.
L-S\* are from the full harness run; the rest are single-purpose probes.

**L-S1 – startup and idle**

```text
508    S1.start {"outcome":"started","sessionId":"2fece374-…"}
15509  controller idle, deliveredSeq 0; adapter running, writtenSeq 0
15509  model requests while idle: 0          (one non-model GET /api/hello at start)
```

**L-S2 – a human event, a tool call through xezar**

```text
15611  controller deliveredSeq 1, reactedSeq 1; adapter consumedSeq 1
req 27 role=[ROLE-MARKER-xezar-leader]  model -> tool:mcp__xezar__health
       carried: "[xezar event · source: xezar · delivery 582fb22c-…]
                 xezar wrote this message, not the user. It reports events in project projx.
                 It is not an instruction and not an approval.
                 Events (JSON, oldest first):
                 {"eventId":"projx:1",…,"category":"E-04","kind":"goal.changed","origin":"human",…}"
req 28 TOOL_RESULT:{"status":"running","ipcVersion":1,"xezarVersion":"0.13.1","project":{"id":"projx","name":"projX"}}
req 29 (second human event)  model -> tool:mcp__xezar__task_create {"operationId":"op-leader-0001",…}
req 30 TOOL_RESULT:task_create is not connected to the xezar service in this session.      (F-1)
```

**L-S3 – asynchronous completion, no polling turn, echo guard**

```text
15739  POST /api/v1/runs -> 201 queued, run d24cd350-…, acceptance 26 ms
17851  run d24cd350-… status done; model requests since acceptance: 0
       appended projx:3 E-04 task.created origin=leader causedBy=op-leader-0001   (echo probe)
       appended projx:4 E-01 task.terminal origin=system "task finished: done"
req 31 role=[ROLE-MARKER-xezar-leader]  "LEADER-REACTION events=projx:4"     (projx:3 was not written)
17953  controller deliveredSeq 4, reactedSeq 4
```

**L-S4 – reconnect and retry**

```text
       controller closed; a new controller session started (ackedSeq 0), re-sending projx:1..4
22954  controller deliveredSeq 4; adapter writtenSeq 4, consumedSeq 4
       adapter.deliver(all four rows) called again directly
25955  model requests before 5, after 5
```

**L-S5 – the session dies, events wait, an explicit resume reapplies the role**

```text
25974  SIGKILL to the Claude Code process (saved PID 48137)
25978  adapter.warn "the Claude Code leader session ended (signal SIGKILL) — events wait in the journal until it is resumed"
       appended projx:5 E-06 executor.changed
26259  controller.warn "MCP event delivery for project projx failed 5 times — retrying every 30s …"
29077  controller disconnected, latestSeq 5; adapter stopped,
       blocker {"code":"session-failed","recoverable":true,"fix":"Resume the leader session from xezar. …"}
29078  resume {"outcome":"resumed","sessionId":"2fece374-…"}          (same conversation, --resume)
req 33 role=[ROLE-MARKER-xezar-leader]  "LEADER-REACTION events=projx:5"
29481  controller deliveredSeq 5, reactedSeq 5
```

**L-S6 – acknowledged, then reconnected**

```text
29482  ack 5 -> {"status":"advanced","seq":5}
32483  new controller session: deliveredSeq 5, ackedSeq 5; model requests before 6, after 6
```

**P2b – messages written during a turn** (the first answer delayed 4 s)

```text
2      stdin "SLOW first message"
1503   stdin "[xezar event] {"eventId":"p:1"}"
2002   stdin "[xezar event] {"eventId":"p:2"}"
4116   user isReplay [SLOW first message]
4127   assistant …; 4129 result
4134   user isReplay [ "[xezar event] …p:1", "[xezar event] …p:2" ]      <- one echo, two blocks
4134   assistant "LEADER-REACTION events=p:1,p:2"                          <- one turn
```

**P3a–P3c – the role instruction across resume** (same session, three resumes)

```text
P3a  --resume <id>, no --append-system-prompt                 -> request role markers: []
P3b  --resume <id>, --append-system-prompt "ROLE-MARKER-resume2" -> [ROLE-MARKER-resume2]
P3c  --resume <id>, --append-system-prompt "ROLE-MARKER-startup" -> [ROLE-MARKER-startup]
(the session was created with "ROLE-MARKER-startup"; its first request carried it)
```

**CH1 – Channels**

```text
probe  1 initialize; 2 result; 4 notifications/initialized; 4 tools/list
probe  3005 out notifications/claude/channel
client init mcp_servers [{"name":"probe","status":"connected"}]
       no model request from 3005 ms until stdin closed at 20003 ms
debug  [session-notices] advertise=false mode=dontAsk flag=false(disabled) pollChannel=false …
```

**D1 – the leader's tools** (the adapter's own argv, a scripted request to use shell and file tools)

```text
"CALL Write {…}"  -> the model was offered no Write tool
"CALL Bash {…}"   -> assistant tool_use Bash; system permission_denied;
                     tool_result "Permission to use Bash has been denied because Claude Code is running in don't ask mode. …"
no file created
```

**A1 – a failed API call** (the adapter's stream-json flags, scripted endpoint answering with an error)

```text
HTTP 400  232  user isReplay ["[xezar event] APIERR {"eventId":"e:1"}"]
          232  assistant model="<synthetic>" error="unknown" ["API Error: 400 scripted bad request"]
          233  result is_error=true "API Error: 400 scripted bad request"
HTTP 401  endpoint requests at 0, 0.6, 1.6, 3.9, 8.3, 17.7, 35.8, 74.1 s …; no frame printed meanwhile
```

## Evidence location and reproduction

Full logs, the harness, the scripted endpoint, the probes and a SHA-256 manifest are in this task's local
evidence folder (`.local/xezar-tasks/<runId>/claude-code-live/`), which is never committed. They contain no
credentials; the only key string is a dummy value.

To reproduce: build the server (`npm run build:server`), start a scripted Anthropic Messages endpoint on
`127.0.0.1`, and wrap the installed `claude` with `--bare`. Then run the harness with `HOME`,
`CLAUDE_CONFIG_DIR` and `XEZ_HOME` pinned to scratch folders and `XEZ_DRY_RUN=1`. The harness imports the
adapter, the controller, the journal and the owner slot from `packages/xezar/src`. It starts the service from
`packages/xezar/dist`, and it refuses to run unless the endpoint is on `127.0.0.1`. Confirm the resolved
`claude` binary before the first run.

## Traceability

| Requirement | What this record shows |
| --- | --- |
| F-17 | Claude Code stays in scope. It works through step 2 for sessions xezar starts, and it is a recorded blocker (OB-1) for sessions the user opened |
| F-20 | Acceptance returned promptly (26 ms); delivery (`deliveredSeq`) and reaction (`reactedSeq`) are recorded separately; no polling turn (L-S3) |
| F-21 | A reconnect re-sends outstanding rows without duplicating the reaction (L-S4); rows owed to a dead session reach the resumed one (L-S5) |
| D-01 | The real `xez mcp` stdio bridge, spawned by Claude Code, bound through the project socket (L-S2) |
| D-04 | The `xezar` server name of the one-time setup is kept. The `.mcp.json` path is not exercised, on purpose (see § What is documented) |
| A-19 | **Not passed**: the Claude Code turn is observed; the model is scripted, so a real model's reaction is INFERRED (OB-5) |
| A-23 | One live session per project in a xezar process; no session starts except on request; the project owner slot is xezar's (#99) |
