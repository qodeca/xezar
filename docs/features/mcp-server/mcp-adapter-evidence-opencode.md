# OpenCode reaction adapter – runtime evidence

Issue: [#110](https://github.com/qodeca/xezar/issues/110). Phase 6 ([#73](https://github.com/qodeca/xezar/issues/73)) of
[epic #67](https://github.com/qodeca/xezar/issues/67). Covers F-17, F-20, F-21, D-01, D-04, A-19 and A-23 of the
[requirements](mcp-project-leader-requirements.md), for OpenCode only.

Code: `packages/xezar/src/mcp/adapters/opencode.ts` and its test. Run date: **2026-09-11**, 03:39–03:58 UTC.
Repository base of the runs: `c1ffa95`. The branch was then brought up to `main` at `772f2a7`. There, the
two "nothing in the files examined" claims below (no controller wiring, a socket with only `health` and
`tools/call`) were checked again and still held. Host: macOS (Darwin 25.6.0, arm64), Node v24.20.0.
OpenCode: **1.18.30** – `opencode --version` printed `1.18.30`, and `GET /global/health` on every
`opencode serve` used here answered `{"healthy":true,"version":"1.18.30"}`. This is the installed version,
not a certified minimum.

## Answer first

- **`prompt_async` produced a model turn carrying a xezar event.** A row appended to the real xezar
  project journal went through the real event controller (#107) to this adapter. The adapter called
  `POST /session/:id/prompt_async`. OpenCode then started a turn, and the model endpoint received a request
  whose last user message was that event (R-01). The same held for a human event (R-03), after a busy turn
  (R-04), after a permission prompt (R-05) and after an OpenCode server restart (R-07).
- **A plugin produced no reaction, and it is not the bridge.** The probe plugin's `event` hook received only
  OpenCode's own event types. It received 0 xezar journal rows, because a plugin has no xezar feed to
  subscribe to (see [Plugins](#plugins-observe-opencode-not-xezar)).
- **Native MCP notifications are not used.** They were not run again here. D-05 § 4 and the spike report
  (T07) measured that they reach OpenCode and start no turn, at a busy or an idle session.
- **The subscription is to the xezar feed.** The event controller calls `EventJournal.subscribe` on the bound
  project's journal (transcript line `xezar.journal.subscribe`). Every submission was caused by a journal
  row. OpenCode's own `/event` stream is read only to watch OpenCode: its safe moments and the turn that
  follows a submission. An OpenCode frame never causes a submission (R-02; unit test "the xezar project
  feed is the only trigger").
- **`system` and `agent` must be sent with every message, including after a resume.** Each one applies
  only to the message it is sent with. The agent's prompt comes first in the system text, and `system`
  follows it. Neither one carries over to the next message, and a server restart does not change that (R-07).
  The adapter sends both every time.
- **The adapter never touches XDG_CONFIG_HOME.** It reads and writes no environment variable, imports
  neither `node:fs` nor `node:child_process`, and three unit tests check this. The harness removed every
  `XDG_*` variable from the OpenCode child. It isolated OpenCode only through `HOME` and
  `OPENCODE_CONFIG_DIR`.
- **A real model reaction is still UNVERIFIED.** Every turn here reached a scripted local endpoint, not a
  real model. This is the spike report's measurement rule, used because the fixture rules forbid personal
  accounts. It proves that OpenCode starts a real turn. It does not prove what a real model decides.
  The spike's OB-5 is still open.
- **Two blockers remain.** Both are recoverable, and OpenCode stays in scope. (1) Nothing in xezar knows the
  URL and session id of the leader's OpenCode session yet. (2) Nothing in the running service starts the
  event controller with this adapter yet. See [Open blockers](#open-blockers).

## How to read this record

Evidence labels follow the spike report:

| Label | Meaning |
| --- | --- |
| **Executed** | Run on this machine on 2026-09-11. The transcript line is quoted below, and the full log is in the task's evidence folder. |
| **Fixture-tested** | Proved by the committed unit test against a fake `opencode serve`, offline. |
| **Read from source** | Read in this repository at `c1ffa95`. |
| **Not attempted** | Not run, and the reason is given. |
| **UNVERIFIED** | Not observed. It is not inferred either. |

**Model reaction, as measured here.** OpenCode "reacted" when it created the assistant message whose
`parentID` is the adapter's submission, **and** the scripted endpoint received an inference request whose
last user message carried the event. The adapter reports the first of these to the controller as
`reactedSeq`. The harness checked the second in the endpoint's request log.

## Environment and fixtures

| Piece | What it was |
| --- | --- |
| OpenCode | `opencode serve --hostname 127.0.0.1` from a scratch fixture project (a fresh `git init`). Environment: `env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_STATE_HOME -u XDG_CACHE_HOME HOME=<scratch>/home OPENCODE_CONFIG_DIR=<scratch>/cfg XEZ_DRY_RUN=1`. `GET /path` confirmed that config and state resolved under the scratch home. |
| Model | A scripted endpoint on `127.0.0.1:4499` that speaks the Anthropic Messages API. OpenCode reached it through a project `provider` with a dummy key string, which is not a credential. It logged each request and noted whether the role markers `XEZ-ROLE-MARKER-AGENT` (in the agent's prompt file) and `XEZ-ROLE-MARKER-SYSTEM` (in xezar's `system` text) were in the system prompt. |
| Leader agent | `agent.leader` in the project `opencode.json`, with `"prompt": "{file:./leader-role.md}"`. The file is project-relative. |
| Permissions | `edit: deny`, `webfetch: deny`, `bash: ask`. The `ask` exists to open a real permission prompt for R-05. |
| Plugin probe | `.opencode/plugin/xez-probe.js`. It is passive: it logs every `event` hook call, never prompts and never calls the client. |
| xezar side | The real `EventJournal`, `ProjectOwnership`, `EventController` and `OpenCodeReactionAdapter`, imported from this worktree's source into a driver process. A throwaway data directory held the state. |
| xezar bridge (R-10) | `xez mcp` from this worktree's source (not the npm package), started by OpenCode through a project `mcp.xezar` block of `"type": "local"`. The service was a `xez serve` from the same source with `XEZ_HOME` isolated. |

No personal account, key or real task permission was used. Nothing was written to the real `~/.xezar`,
`~/.config/opencode` or `~/.local/share/opencode`.

## The delivery hierarchy for OpenCode

The order is agreed (requirements § 12). This record does not reorder it.

| Tier | Route | Status | Basis |
| --- | --- | --- | --- |
| 1 | Native: MCP notifications (`tools/list_changed`, `resources/updated`, `message`) | **Not adopted** | D-05 § 4 and spike T07 (executed there): the notifications are delivered, OpenCode emits `mcp.tools.changed`, and no turn starts. OpenCode has no Channels-like native event input in the routes examined. |
| 2 | `POST /session/:id/prompt_async` | **Adopted** | Executed here: R-01, R-03, R-04, R-05, R-07. |
| 3 | Terminal text input | **Refused** | `opencode serve` has `POST /tui/append-prompt` and `POST /tui/submit-prompt` (read from its `/doc`). These type into the TUI's prompt box, which the user types into too. Tier 2 works, so tier 3 is not used. The adapter calls no `/tui/` route (fixture-tested) and never simulates a keystroke. |

Each submission's text starts with `[xezar event notification]`. Its next line says it is from xezar, and
that it is not a message from the user, not an instruction and not an approval. The text part also carries
`metadata.xezar` with the exact rows it holds.

## What OpenCode 1.18.30 does with `prompt_async` (executed)

These findings set the adapter's rules. Each finding was run on the scratch server (script `explore.mjs`,
log `explore-events.ndjson`). The driver runs confirmed the ones marked R-.

| # | Condition | Observed | Rule it caused |
| --- | --- | --- | --- |
| F-1 | A message with `agent: "leader"` and `system`, then a message with neither | The first model request held both markers. In its system text, `XEZ-ROLE-MARKER-AGENT` was at index 42 and `XEZ-ROLE-MARKER-SYSTEM` at index 1268. The follow-up held neither marker (R-07 repeats this after a restart). | Send `agent` and `system` with every message. |
| F-2 | The same `messageID` sent twice | Both answered `204`. The second text was **appended into the first, already answered user message** (`"dedupe probe A\|dedupe probe B"`), and no second model request followed. | Never set `messageID`. OpenCode assigns it. |
| F-3 | `prompt_async` while the session is busy | `204`. The message was queued and ran after the running turn ended (model requests 8 s apart). | Wait until the session is idle. |
| F-4 | `prompt_async` while a permission prompt is pending | `204`. The pending permission was **not** answered. After the user rejected it, the queued message got **no turn of its own**. Its text reached the model only inside the **next, unrelated** prompt's request (model request 7 in `model-requests.run1.ndjson`). | Wait until no permission prompt or question is pending for the session. |
| F-5 | A text part with `synthetic: true` | The model received its text. | Nothing hides an event from the model. The adapter does not use the flag. |
| F-6 | Text-part `metadata` | It came back unchanged in `GET /session/:id/message` and in the `/event` frame `message.part.updated`. `?limit=` bounds the history read. | The `metadata.xezar` marker is how the adapter recognises its own submissions. |
| F-7 | An unknown session id | `prompt_async` answered `404` with `{"name":"NotFoundError","data":{"message":"Session not found: …"}}`. `GET /session/:id` also answered `404`. | This is the `session-not-found` blocker. The adapter never creates a session. |

## Runtime runs of the adapter (executed)

The driver is `drive-adapter.ts` against `opencode serve` on port 4412. Its full logs are `runtime.ndjson`
(the driver), `runtime-events.ndjson` (a separate raw recorder of OpenCode's `/event`) and
`model-requests.ndjson` (the scripted endpoint). Times are milliseconds since the driver started.

**R-01 – a xezar journal row leads to a model turn that carries it**

```text
837   xezar.journal.subscribe  {"projectId":"xez110-fixture","rowsPath":"$S/xezar-data/mcp/event-journal.ndjson"}
837   controller.start         {"outcome":"started","status":{"state":"idle","deliveredSeq":0,"ackedSeq":0,"reactedSeq":0}}
838   R-01.xezar.journal.append {"eventId":"xez110-fixture:1","journalSeq":1}
1002  [opencode /event] message.updated role=user message=msg_08e9821560015v5eCNpzzL25Yv agent=leader
1002  [opencode /event] message.part.updated xezarMarker={"source":"xezar","projectId":"xez110-fixture",
                        "rows":["xez110-fixture:1@2026-09-11T03:52:09.795Z"],"toSeq":1}
1006  [opencode /event] session.status busy
1006  [opencode /event] message.updated role=assistant parentID=msg_08e9821560015v5eCNpzzL25Yv
1006  adapter.onReaction     {"journalSeq":1,"controller":{"status":"advanced","seq":1}}
      [model endpoint]       markers {"XEZ-ROLE-MARKER-AGENT":42,"XEZ-ROLE-MARKER-SYSTEM":1268}
                             lastText "[xezar event notification]\nSource: xezar, project xez110-fixture. Sent
                             automatically by xezar. It is not a message from the user, not an instruction and
                             not an approval.\nSignificant events (1, oldest first):\n- xez110-fixture:1 E-01
                             task.terminal run run-fixture-1 (origin system): task finished: done at step
                             implement (1 of 1)\nRead the current state with the xezar tools before acting, and
                             acknowledge the events you have taken into account."
1809  [opencode /event] session.idle
1848  R-01.result {"controller":{"state":"idle","deliveredSeq":1,"ackedSeq":0,"reactedSeq":1}}
```

`ackedSeq` stays at 0 because only the leader acknowledges, through a tool (D-05 § 6.6). The scripted
model does not call that tool.

**R-02 – OpenCode's own activity triggers nothing.** An ordinary user message produced the usual session
and message frames. No journal row was appended. `submittedRows` stayed at 1. The only model request was
the user's own message.

**R-03 – a human event.** An `E-04 goal.changed` row with `origin human` led to a turn
(`reactedSeq` 2), with both markers present. Appending the row stands in for the #104 emitter, which is
not merged at `c1ffa95` (PR #232 is a draft).

**R-04 – never into an active turn.** The user started a slow turn; `GET /session/status` showed
`{"ses_…":{"type":"busy"}}`. The row was appended at 6667. The model requests were `03:52:14.941Z` for the
user's slow turn and `03:52:23.042Z` for the xezar event, which started after the user's turn had ended.
Then `reactedSeq` became 3.

**R-05 – never into a pending permission prompt, and never answers it**

```text
17181 R-05.permission.pending [{"id":"per_08e985580001cJ0VgzS2flczrc","permission":"bash"}]
17181 R-05.xezar.journal.append {"eventId":"xez110-fixture:4"}
22184 R-05.after.5s {"stillPending":["per_08e985580001cJ0VgzS2flczrc"],"modelRequestsSoFar":["user: CALL bash"],"reacted":false}
22187 R-05.user.rejected.permission            <-- the harness, playing the user
22191 [opencode /event] permission.replied reject
22249 [opencode /event] session.idle            <-- the user's turn ends
22262 [opencode /event] message.part.updated xezarMarker {... "rows":["xez110-fixture:4@…"],"toSeq":4}
22269 [opencode /event] message.updated role=assistant parentID=<that message>   <-- its own turn
22269 adapter.onReaction {"journalSeq":4}
```

Compare F-4. With no wait, the same situation left the event without a turn of its own.

**R-06 – a restart on the xezar side causes no second turn.** The controller and the adapter were closed
and new ones were started. The leader had acknowledged nothing, so the new controller session was owed
rows 1–4 again (at-least-once, D-05 § 6.6). The new adapter read the session's recent history and found
all four rows in its own markers. It submitted nothing: `newModelRequests` was 0. It reported their
turns, which it had found in the history.

**R-07 – resume across an OpenCode server restart**

```text
26408 opencode.serve.stopped
26409 R-07.xezar.journal.append.while.down {"eventId":"xez110-fixture:5"}
26493 controller.warn "[xez] MCP event delivery for project xez110-fixture failed 5 times — retrying every 5s …"
27910 R-07.while.down {"controller":{"state":"disconnected","deliveredSeq":4,"latestSeq":5},
                       "adapter2":{"route":"blocked","blocker":{"code":"server-unreachable","recoverable":true,…}}}
28670 opencode.serve.up (new process, same session id, same scratch data)
28951 adapter.onReaction {"journalSeq":5}
      [model endpoint] markers {"XEZ-ROLE-MARKER-AGENT":42,"XEZ-ROLE-MARKER-SYSTEM":1268}   <-- adapter's message
32692 control, same session, message with neither agent nor system: markers AGENT -1, SYSTEM -1
37713 control, agent only:  AGENT 42, SYSTEM -1
      control, system only: AGENT -1, the alternative system marker at 9733 (after the default agent's prompt)
```

**R-08 – blockers.** Each case was blocked, `recoverable: true`, with 0 model requests: `no-target` (no
session known), `session-not-found` (a made-up id), `wrong-project` (a session in another directory) and
`server-unreachable` (a closed port).

**R-09 – idle but live.** The session was idle for 16 s, with the controller's heartbeat set to 5 s (a
fixture value; production uses D-09's 30 s). The result was 0 model requests. The heartbeat is
`GET /session/:id` and nothing else.

**R-10 – the real xezar bridge inside OpenCode.** Before the first prompt, `GET /mcp` showed
`{"xezar":{"status":"connected"}}`. The model was offered `xezar_discover_project`, `xezar_execution_control`,
`xezar_handoff_git`, `xezar_health`, `xezar_organise_work`, `xezar_task_create` and `xezar_task_read`. It
called `xezar_health`, which returned `xezar 0.13.1 is running for project proj (proj).`. It called
`xezar_discover_project`, which returned `Bound to xezar project "proj" (id proj).` and the reasons each
unavailable action is unavailable. The binding came from the working directory and the isolated registry,
not from the model.

## The twelve behaviours, for the OpenCode adapter

This record uses the same 13 rows as the spike report, because the issue's "twelve" names 13 behaviours.
A row that depends only on xezar server logic, and not on this adapter, says so.

| Behaviour | Result for OpenCode with this adapter | Evidence |
| --- | --- | --- |
| tool call | **PASS** – the real xezar bridge, not a probe | Executed, R-10 |
| project scope | **PASS** – the bridge bound the project from the working directory and registry. The adapter refuses a session opened in another directory. | Executed, R-10, R-08 `wrong-project`; fixture-tested |
| second-client rejection | **Partly.** The adapter never creates a session and targets only the one it was given (fixture-tested: no `POST /session`). The one-controller-per-journal refusal belongs to #107. A live two-client race was **not attempted**. | Fixture-tested; read from source (`event-controller.ts`) |
| process crash | **PASS for an OpenCode server stop.** The rows were kept, the controller went `disconnected` and retried, and the event was delivered after the restart (R-07). A crash of the **bridge** process (spike T09, FAIL) was **not attempted** again; OB-4 carries it. | Executed, R-07 |
| lease expiry | **Not attempted.** The lease belongs to the owner slot and the controller (#87, #107). The adapter holds no lease. | – |
| fencing | **Not attempted.** Same reason. | – |
| idle-but-live session | **PASS** – heartbeats with no model turn | Executed, R-09 |
| asynchronous completion causing a real model reaction | **PASS through tier 2**, with the scripted model. **Real model: UNVERIFIED.** | Executed, R-01, R-04, R-05, R-07 |
| human event | **PASS** – an `origin human` row led to a turn. The harness appended the row in place of the unmerged #104 emitter. | Executed, R-03 |
| replay and dedup | **PASS** – the redelivered rows got no second turn | Executed, R-06; fixture-tested (re-dispatch, restart, lost `204`, recreated journal) |
| stale mutation | **Not attempted.** It is server logic (#100) and does not pass through the adapter. | – |
| idempotent lost response | **Adapter slice fixture-tested.** When the `204` is lost, the retry reads the history and does not submit again. Live: **not attempted**, because a real server's answer cannot be dropped without a proxy, and building one was out of scope. | Fixture-tested |
| prompt persistence | **PASS with re-supply** – after a restart, the markers were present when the adapter sent them and absent when a message did not. | Executed, R-07 |

## Plugins observe OpenCode, not xezar

The probe plugin loaded in every server started for this record (6 loads). Its `event` hook received
1 037 calls in total (570 in `plugin-events.run1.ndjson`, 467 in `plugin-events.ndjson`), of these types
only: `session.created`, `session.updated`, `session.status`, `session.idle`, `session.diff`,
`message.updated`, `message.part.updated`, `message.part.delta`, `permission.asked`, `permission.replied`,
`plugin.added`, `catalog.updated`, `reference.updated`, `integration.updated`. **Not one was a xezar event.**
The only lines that contain "xezar" are the plugin's own load lines, and only because the scratch path
contains it.

This is structural, not a missed configuration. A plugin runs inside OpenCode. To follow xezar it would
need a xezar feed it can reach. The D-01 socket answers `health` and `tools/call` only (read from source,
`packages/xezar/src/mcp/service.ts`, the `switch (request.method)`), and no other xezar surface in the files
examined exposes the project journal to another process. A plugin bridge was therefore not built.
**The extension that would make it possible:** a journal subscription on the per-project socket, with the
same binding, ownership and cursor rules as the controller. This adapter makes the plugin unnecessary for
a session on `opencode serve`.

## No XDG_CONFIG_HOME anywhere in the adapter

- The adapter source does not contain the string `XDG_`, not even in comments (fixture-tested).
- Its code has no `process.` reference and imports neither `node:fs` nor `node:child_process`, so it can
  neither read nor set an environment variable, nor write a file (fixture-tested).
- `process.env` is identical before and after a full delivery, its turn and a heartbeat (fixture-tested).
- The harness isolated OpenCode with `HOME` and `OPENCODE_CONFIG_DIR` in the child's environment only, and
  removed every `XDG_*` variable with `env -u` (executed, `serve.sh`). The real user's `gh` and git config
  were not touched.

## Tests and red proof

`opencode.test.ts` has 31 cases. It runs offline against a fake `opencode serve` whose shapes come from
OpenCode 1.18.30's own `/doc` and from the findings above. It needs no OpenCode binary, model or login,
so it runs the same way with `XEZ_DRY_RUN=1` as without it. One case runs the real journal, owner slot
and controller.

Red proof (executed, `mutate.sh`). Each guard was broken in turn in the committed adapter, the test file
was run, and the source was restored to HEAD:

| Mutation | Result |
| --- | --- |
| Source removed | the test file fails to load |
| No wait for idle / permission / question | 4 failed |
| Rows already submitted are not skipped | 3 failed |
| `system` not re-sent | 2 failed |
| No history read (restart, lost `204`) | 2 failed |
| No echo guard | 1 failed |
| Turn watcher armed only after the `204` | 1 failed. This mutation **stayed green** in the first version of the suite. A case was added in which the whole turn reaches the adapter before the `204`, and that case fails. |
| No project targeting check | 1 failed |

## Open blockers

Each blocker keeps OpenCode in scope, and none is solved by polling.

| ID | Blocker | What would close it | Status |
| --- | --- | --- | --- |
| OC-1 (the spike's OB-3) | Nothing in xezar knows **which** OpenCode server and session the leader runs in. The adapter needs `{ baseUrl, sessionId }` and refuses to guess, so it holds on the `no-target` blocker. A TUI started with `opencode attach <url>` against an `opencode serve` is reachable the same way as R-01. Whether a plain `opencode` TUI exposes such a server is **UNVERIFIED**. | A trusted source for the target: the user enters it in the project's MCP connection settings, or OpenCode passes its server URL and session id to the MCP server it spawns. It must never come from the model. | Open |
| OC-2 | Nothing in the running service starts `EventController` with a reaction adapter. A search of `packages/xezar/src` (non-test files) found no caller of `EventController.start` and none of `OpenCodeReactionAdapter`. The chain is proven in the driver only. | Wire the controller and this adapter into the MCP service on the connection's lease (#73). That is outside this issue's files. | Open |
| OC-3 (the spike's OB-5) | No real-model reaction. | A run with a real model account on the release-candidate revision, after an account decision. | Open |
| OC-4 (the spike's OB-4) | No recovery after the xezar **bridge** process crashes: OpenCode drops the tools (spike T09). | Watch the bridge's health and reconnect through OpenCode's `POST /mcp/:name/connect` route, which exists in 1.18.30's `/doc`. Its behaviour is **UNVERIFIED**. | Open |

## Corrections and observations against earlier documents

- **Versions:** the same OpenCode, 1.18.30, as D-05 and the spike report; the issue body's 1.18.29 is the
  compatibility report's older reading.
- **Lazy MCP connection:** D-05 § 4 saw no MCP process for 45 s before the first prompt. In R-10, `GET /mcp`
  answered `connected` 266 ms after the server came up, before any prompt. The likely explanation is that
  the `GET /mcp` read itself connects the server, but that is **UNVERIFIED**. Either way, "the server is
  running" still does not mean "the leader is reachable".
- **Role instructions:** the compatibility report says a custom agent's `prompt` can reference a
  project-relative file. That was executed here (`{file:./leader-role.md}`, R-01). Because the leader can edit
  that file with its own tools, it cannot carry xezar's base instruction under § 12. The adapter sends
  xezar's text as `system` instead. Prompt text is still not enforcement.
- **Isolating OpenCode without XDG:** D-04 § 8.4 found `OPENCODE_CONFIG_DIR` alone did not hide the machine's
  global OpenCode config. Pinning `HOME` for the child as well, with no `XDG_*` variable set, did hide it:
  `GET /path` reported config and state under the scratch home.

## Evidence location

The full logs, the harness (`scripted-model.mjs`, `serve.sh`, `explore.mjs`, `probe-meta.mjs`,
`drive-adapter.ts`, `drive-bridge.mjs`, `mutate.sh`), the fixture files and a SHA-256 manifest are in this task's
evidence folder, `.local/xezar-tasks/<runId>/opencode-adapter/`. That folder is never committed. It holds
no credentials: the only key string is the dummy value in the fixture `opencode.json`.
