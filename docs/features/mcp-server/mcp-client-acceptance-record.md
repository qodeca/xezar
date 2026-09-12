# MCP real-client acceptance record — A-01, A-17, A-18, A-19, A-20, A-23

Issue: [#118](https://github.com/qodeca/xezar/issues/118). Phase 8 ([#75](https://github.com/qodeca/xezar/issues/75))
of [epic #67](https://github.com/qodeca/xezar/issues/67). Covers A-01, A-17, A-18, A-19, A-20 and A-23 of the
[requirements § 9](mcp-project-leader-requirements.md), per officially supported client.

Run date: **2026-09-11**. Revision under test: **`ed1492e`** (branch `xez/e9d1574e`, which is `main` at `df80a7e`
plus the two test files this record describes; no product file differs from `main`). Host: macOS 26.6.2
(arm64), Node v24.20.0. Clients, as installed on the host: **Claude Code 2.1.268**, **Codex CLI 0.154.0**,
**OpenCode 1.18.30**. These are installed versions, not certified minimums.

**A-01 re-run, 2026-09-11, [#262](https://github.com/qodeca/xezar/issues/262).** Only the A-01 cases were
run again, on branch `xez/b9b4feb6` (`main` at `ef4b768` plus the #262 changes, uncommitted at the time of the
run), with the same clients and versions on the same host. All five A-01 legs **PASSED**, including the
connection file, which the MCP service now writes. `mcp-real-clients.test.ts` itself was not changed.

**Whole-suite re-run, 2026-09-12, [#330](https://github.com/qodeca/xezar/issues/330) WP5 — the run the table
below is from.** The suite gained its fourth client, **pi**, and #330's PI-07 asks for a pi column *on the same
revision as the other three*, so every case was run again rather than pi's alone. Revision under test:
**`1192065`** (branch `xez/c17af4a9`, `main` at `ae6de7f` plus this branch's test and documentation commits;
the only product file that differs from `main` is a one-word fix to a user-facing string, § Findings worth
keeping). Host: macOS 26.6.2 (Darwin 25.6.0, arm64), Node v24.20.0. Clients as installed: **Claude Code
2.1.268**, **Codex CLI 0.154.0**, **OpenCode 1.18.30**, **pi 0.85.1** with **pi-mcp-adapter 2.32.1**. Installed
versions, not certified minimums.

**Three cases changed verdict, and not because of pi.** A-17, A-18 and A-23 were FAILED in the original run for
one reason — exclusive ownership over a live session was not wired. It is wired: #302/#305
([`a0cf85e`](https://github.com/qodeca/xezar/commit/a0cf85e)) landed on 2026-09-11 at 15:20, **after** the
original run's base `df80a7e` (08:07), and the suite had not been run between. Every ownership check now passes,
for every client. The 2026-09-11 observations are kept below, marked as history, because a record that quietly
overwrites what it once measured cannot be checked.

## Answer first

| Case | Claude Code | Codex | OpenCode | pi | Product-level checks | What is missing |
| --- | --- | --- | --- | --- | --- | --- |
| **A-01** setup | client leg **PASSED** | client leg **PASSED** | client leg **PASSED** | client leg **PASSED**; the `approveTools` edge path **FAILED** | connection file: **PASSED** (#262); tools reach the service: **PASSED** | A gated pi tool blocks instead of ending — see A-01 below |
| **A-17** competing owner | **PASSED** (FAILED before #302) | **PASSED** (was FAILED) | **PASSED** (was FAILED) | **PASSED** | second bridge refused: **PASSED**; same-owner concurrency and project B: pass | Nothing — **A-17 is PASSED** since #302 |
| **A-18** liveness, fencing, restart | — | — | — | **PASSED** (pi owning A, and a restart on pi's own side) | **PASSED** (was FAILED): idle owner, crash hand-over, stale fencing and restart fencing all hold | Nothing measured here; the adapter's 10-minute idle close was not re-run (WP1 measured it) |
| **A-19** delivery and model reaction | **BLOCKED** | **BLOCKED** | **BLOCKED** | **BLOCKED** on the real-model clause alone — delivery, the reaction and the absence of a polling turn are all **executed** | acceptance vs result and journal emission: **PASSED** | For pi: only a real model's decision. For the three: no attach path exists for them at all. |
| **A-20** live sync | — | — | — | the no-recursive-loop clause: **PASSED** | cockpit half (browser): **PASSED**; leader half: **BLOCKED** on that one clause | For the three, the clause still needs a delivery path; for pi it is observed |
| **A-23** exclusive owner | **BLOCKED** (was FAILED) | **BLOCKED** (was FAILED) | **BLOCKED** (was FAILED) | **BLOCKED** | — | Only reaction (A-19). Exclusivity now holds for all four; the built-in-leader half is **NOT RUN** (out of scope) |

**A-01, A-17 and A-18 pass as wholes; A-19, A-20 and A-23 are BLOCKED, and for pi only on the clause no § 9
fixture may observe.** What changed since 2026-09-11 is ownership (#302) and a delivery path for one client
(#311 with #330 WP2). What has not changed is that a real model's decision cannot be measured here, for any
client — so A-19 is BLOCKED for all four and A-23 with it. The leader decided (2026-09-11) that a real model
reaction and multi-project MCP are outside release 0.14.0; exclusive ownership, which the same decision put
outside it, landed anyway. This record passes nothing on documentation.

**One row FAILS and it is pi's**: a xezar tool the person gated behind pi-mcp-adapter's `approveTools` makes a
headless pi wait for ever. It is reported to the owner on #330 rather than settled here — see A-01.

## How to read this record

| Label | Meaning |
| --- | --- |
| **PASSED** | Every required check was executed and met, on the revision above. |
| **FAILED** | A required check was executed and not met. The missing piece is named. |
| **BLOCKED** | A required check cannot be observed in a § 9 fixture, or depends on a piece that does not exist. Never a pass. |
| **NOT RUN** | Not attempted, with the reason. Never a pass. |

"Observed" below means executed on this host against real processes. "Fixture-tested" means proved against
an in-process stand-in. "Inferred" is never used as a verdict.

## Where the evidence is, and how to reproduce it

The suite is two files:

- `packages/xezar/test/integration/mcp-real-clients.test.ts` — the real-client harness (node:test). It is
  outside every gate on purpose: `npm test` and `npm run test:unit` must never need a server or a machine's
  installed agent CLIs. Run it after `npm run build`, from `packages/xezar`:

  ```sh
  TMPDIR=/tmp node --import ../../scripts/test-local-state.mjs --import tsx --test test/integration/mcp-real-clients.test.ts
  ```

  It writes `.local/qa/mcp-real-clients/<stamp>/`: `environment.json`, `results.json`, `results.md` and one
  transcript per process. A FAILED case fails its test; a BLOCKED case is reported as a todo that throws
  (`⚠ … # … BLOCKED`), which node:test counts neither as a pass nor as a failure; a client that is not
  installed is skipped as NOT RUN.

  **pi needs the network once per run** and says so when it cannot have it: pi is not an MCP client by itself
  (its own README: "**No MCP**"), so the leg's one-time step is `pi install npm:pi-mcp-adapter@2.32.1` into a
  throwaway `PI_CODING_AGENT_DIR`, proved to have landed there, and every pi scenario copies from that. A
  failed install is NOT RUN for pi and changes nothing for the other three. The developer's `~/.pi` is never
  read or written — #330's PI-07 names a run that reads it as a falsifier — and **both** `HOME` and
  `PI_CODING_AGENT_DIR` are pinned, because pi reads its whole per-user directory from the second (#329) and
  the adapter reads three MCP files from the first.
- `packages/web/e2e/mcp-live-sync.e2e.ts` — the cockpit half of A-20, in the browser suite
  (`npm run test:e2e`; one spec: `sh scripts/test-env-up.sh`, then
  `npm test -- --config packages/web/e2e/vitest.config.ts mcp-live-sync`). The issue names the file
  `mcp-live-sync.spec.ts`; the browser suite only collects `*.e2e.ts`
  (`packages/web/e2e/vitest.config.ts`), so a `.spec.ts` file would never run. It is `.e2e.ts` for that
  reason.

Runs recorded here (local, private evidence under the task's `.local/xezar-tasks/<runId>/mcp-real-clients/`,
with a `MANIFEST.sha256`):

| Run | What | Result file SHA-256 (first 16) |
| --- | --- | --- |
| `2026-09-11T06-20-21-481Z` | Full harness on `ed1492e` — the verdicts in this record | `b702056599ef8bc6` (`results.json`) |
| `e2e-final.log` | Browser spec on `ed1492e`: **4 of 4 passed**, agent-browser installed, not skipped | `632289356cc6dd1a` |
| `2026-09-11T06-14-52-113Z` | Regression proof: the `[product]` cases against the pre-#247 service | `fda42ba7d6ccf4a4` (`results.json`) |
| `e2e-a20-redproof.log` | Regression proof: the browser spec against the pre-#247 service | `c0a5a0a91f68834e` |
| `2026-09-12T10-38-38-106Z` | **Whole suite on `1192065`** — the verdicts in this record. 28 tests: 18 pass, 9 todo (BLOCKED), 1 fail (pi's `approveTools` edge path) | see `MANIFEST.sha256` in the WP5 evidence folder |

The WP5 run's own evidence — `environment.json` (both client versions and the adapter version), `results.json`,
`results.md`, one transcript per process including every pi RPC frame, and the scripted endpoint's full request
log — is in that task's private folder, `.local/xezar-tasks/<runId>/wp5/`, with a `MANIFEST.sha256`. It is never
committed and holds no credential: the only key string is the dummy value in the fixture `models.json`.

## The fixture

- **Two projects.** The shared A/B world (`packages/xezar/test/helpers/ab-fixture.ts`, #115): two real git
  repositories, A's real `RunManager`, the real MCP service loop on one Unix socket per project,
  `XEZ_DRY_RUN=1`, stubbed provider auth. The harness adds only the workspace registry entries for A and B in
  the world's `XEZ_HOME`, which is what a separate bridge PROCESS needs to find those sockets.
- **The shipped product.** A real `xezar serve` (`packages/xezar/dist/index.js`) over a fresh fixture
  repository, with `XEZ_DRY_RUN=1`, an isolated `XEZ_HOME` and the agent config folders pinned empty. Every
  `[product]` case, every restart and every event-journal check runs here, because the A/B world composes its
  tools in-process and does not attach the event catalog.
- **Real clients, isolated.** Each client runs with `HOME` and its own config folder pinned to a scratch
  folder, and every `ANTHROPIC_*`, `OPENAI_*`, `CODEX_*`, `CLAUDE_*`, `OPENCODE_*`, `XDG_*` and `XEZ_*` variable
  removed. Isolation is proven per run: Claude Code's `mcp add` named a file inside the pinned folder, and
  Codex's `initialize` answered the pinned `codexHome`. A `codex` on PATH that is a wrapper script assigning
  `CODEX_HOME` (D-01 § 9.3) was refused, and the next real binary on PATH was used.
- **No model.** Any model turn went to a scripted local Anthropic-Messages endpoint inside the harness
  ("CALL health" becomes a tool call; a tool result becomes an acknowledgement). Claude Code ran with
  `--bare`, which never reads OAuth or the keychain, and a dummy key string. Codex needed no turn at all
  (app-server `mcpServer/tool/call`). No personal account, no secret and no real user task permission was
  used.
- **Setup as documented, with one substitution.** The one-time step is D-04 § 3's, as the cockpit's MCP
  connection screen shows it. The command is this revision's built bridge (`node …/dist/index.js mcp`)
  instead of `npx -y @qodeca/xezar mcp`, which would fetch the published package. Each entry carries
  `XEZ_HOME` because the fixture service runs under an isolated home; a real user's entry needs neither.

## Results, per case

### A-01 — provisioning and one-time setup: PASSED (since #262; FAILED in the original run)

| Check | Claude Code | Codex | OpenCode | pi |
| --- | --- | --- | --- | --- |
| One-time step as documented | `claude mcp add --scope local` → exit 0, file inside the pinned folder | project `.codex/config.toml` + a trust entry | project `opencode.json` `mcp.xezar` block | `pi install npm:pi-mcp-adapter@2.32.1` → the package and `settings.json` inside the pinned `PI_CODING_AGENT_DIR`, plus its `mcp.json` entry (`directTools`, `lifecycle: keep-alive`) |
| Handshake / entry loaded | `claude mcp list` → `✔ Connected` | `mcpServerStatus/list` lists `xezar` | `opencode mcp list` → `✓ xezar connected` | the adapter's own notice: `MCP: 1 servers connected (11 tools)`, then `MCP: direct tools refreshed (+11, ~0, -0)`. pi has no `mcp list` command, so that notice IS the handshake evidence |
| The client reaches A (the `health` tool) | tool result names `alpha-proj` | `xezar 0.0.0-ab is running for project alpha project (alpha-proj).` | tool result names `alpha-proj` | `xezar 0.0.0-ab is running for project alpha project (alpha-proj).` |
| A registry tool answers with A's data (`task_read`) | A's tasks | A's tasks | A's tasks | A's tasks |
| Nothing of B reaches the client | none | none | none | none |
| No connection data or secret in the client config | none (command only) | none | none | none (a command and the two fixture variables) |
| What the step added to A's working tree | nothing (local scope is outside the repo) | `?? .codex/config.toml` | `?? opencode.json` | nothing (the entry lives in the pinned folder, outside the repository) |
| The model is offered the tools as first-class tools | (measured through its turn) | (n/a — no turn) | (measured through its turn) | all 11: `xezar_health`, `xezar_task_read`, `xezar_execution_control`, `xezar_discover_project`, `xezar_organise_work`, `xezar_task_create`, `xezar_handoff_git`, `xezar_read_results_evidence`, `xezar_project_config`, `xezar_local_handoff`, `xezar_leader_events` |

**pi's edge path, and it FAILED: a tool gated behind `approveTools`.** #330's PI-08 asks for "a named
`approval_required` state, not a hang". With `approveTools: ['health']` on the xezar entry and a headless pi:

| Check | Result |
| --- | --- |
| The gate names what it is asking for | **PASSED** — `extension_ui_request`, `method: "select"`, `title: "MCP: xezar wants to run health"`, options `Allow once` / `Allow for session` / `Deny` |
| The gated call does not hang when nobody can answer | **FAILED** — no `agent_settled` in 30 s past the dialog. The frame carries **no `timeout`**, and pi's `docs/rpc.md` § Extension UI Requests says a dialog blocks until the client sends `extension_ui_response` and auto-resolves only when a `timeout` is present |
| Answering it closes the turn, and the refusal is reported | **PASSED** — `extension_ui_response` with `Deny` ended the turn at once and the model was told `approval_denied`: "The user declined approval to run MCP tool \"health\" on server \"xezar\"." |

So the named state PI-08 asks for exists, and nothing reaches it: **no part of xezar answers such a dialog** —
`core/pi-runner.ts`, `scripts/pi-leader-extension.ts` and `mcp/adapters/pi.ts` never mention
`extension_ui_request`. A person at their own pi TUI answers it themselves, so an interactive leader does
not hang; it bites where nobody is watching, which is the case A-19 exists for. **Reported to the owner on #330
with three options rather than settled here.** Its second half — whether a xezar pi TASK blocks the same way,
since `core/pi-runner.ts` answers no dialog either — is wider than #330 and was not measured.

Product-level:

- **PASSED since #262 — the connection file.** In the re-run a real `xezar serve` wrote
  `<root>/.local/xezar/mcp-connection.json`, mode `600`, matched by `.local/.gitignore`. What the original run
  observed, kept for the record: **FAILED** — a real `xezar serve` opened the MCP socket and wrote no
  `<root>/.local/xezar/mcp-connection.json`. D-04.1 and D-04.3 decided that file and its trigger; in the files
  examined, `mcp-connection.json` is named only by tests (`ab-fixture.ts` plants it for A-12). The discovery the
  clients actually use — the workspace registry plus the socket under `XEZ_HOME` (D-01 § 4) — works without it,
  but A-01 requires xezar to write the configuration into A's `.local/xezar/`, and it does not.
- **PASSED — the tools reach the service** in the shipped product (after #247). Before #247 every registry
  tool answered "not connected" (regression proof below).
- **The instructions** — one-time step separated from what xezar does, and no autodiscovery claim — are
  checked in the real cockpit by the browser spec: each of the three client cards has an "Automatic" part, a
  "One-time" part and a "does not discover `.local/xezar/mcp-connection.json`" line. PASSED.

### A-17 — only the competing owner is rejected: PASSED (2026-09-12; FAILED in the original run)

- **PASSED.** With a live `xez mcp` bridge owning A, a second bridge process's `initialize` answered `-32080`
  with `data.reason: "com.qodeca.xezar/project-occupied"` (D-02 § 4) and never reached a tool.
- **PASSED per client, all four.** Each was started as the second logical client while A had a live owner:
  Claude Code and OpenCode reported the occupied error and were not connected; Codex's thread-scoped MCP start
  failed with the same `-32080`; **pi** reported it as its own notice —
  `MCP: Failed to connect to xezar: This project is occupied: …` — and, with a cold adapter cache, the model was
  offered **0** xezar tools and reached nothing of A.
- **Met:** 20 concurrent requests from the owner all succeeded; a client of project B reached B.
- **Control:** `ProjectOwnership`, driven directly, answers the D-02 occupied error for a second session, so the
  detector recognises a refusal when one exists — and now so does the service.
- **No manual disconnect UI** — checked in the real cockpit by the browser spec: the MCP connection screen has no
  disconnect, takeover, force, kick, evict or release control. PASSED (it also passed before #247: a guard).
- **What the model is told is still less than what the operator is told (PI-3, shared with all four).** pi's
  model sees no xezar tool and no reason; the occupied text reaches the notice channel and the operator. WP1
  measured the warm-cache variant too: the first call answers `MCP server "xezar" not available (failed 0s ago)`
  with `isError: false`, and the reason reaches nobody. Open, and not pi-specific.

**What the original run observed, kept as history:** FAILED. A second bridge's `initialize` was accepted and its
`organise_work pin` changed A; all three clients were admitted; and the record said "nothing in the running
service calls `ProjectOwnership`". #302/#305 ([`a0cf85e`](https://github.com/qodeca/xezar/commit/a0cf85e)) wired
it, hours after that run's base.

### A-18 — liveness, fencing and restart: PASSED (2026-09-12; FAILED in the original run)

- **PASSED — model silence.** After 6 s of owner silence (longer than D-02.5's 5 s renewal interval; no lease
  duration is asserted), a new client of A was refused as occupied.
- **PASSED — fencing.** After the owner was SIGKILLed a successor acquired, and the still-alive earlier client's
  write answered `-32081` / `com.qodeca.xezar/session-expired`.
- **PASSED — restart fencing.** A bridge process that survived a `xezar serve` restart had its next call fenced
  and had to reconnect, as D-02 § 5 requires.
- **Met:** a task started through MCP (`mock:slow`, about 25 s) reached `done` after its owner was SIGKILLed;
  while the service was down, a tool call answered "xezar is not running for project …" (no hang); after the
  restart the pre-restart task and its result were still there.

**pi, with both its legs on one process: PASSED.** A real pi owning A through its own `pi-mcp-adapter`
connection kept it through 6 s of making no call at all, a second bridge was refused `-32080`, and pi made **no
model request** to keep it — the live connection renews the lease, model silence is not a signal.

**A restart on PI's own side: PASSED.** WP2 restarted only the xezar side and named this as WP5's. The person's
pi exits; xezar's leader extension removes its descriptor **and its whole private `0700` directory**; the leader
status reports a recoverable blocker rather than an attached leader that hears nothing; the journal still holds
the rows pi had reacted to; a fresh pi announces itself in the same project with nothing configured, and
`POST /api/v1/mcp/leader {attach, pi}` answers 200 again.

**Not re-run here:** the adapter's 10-minute idle close. WP1 measured it on `5031bf8` — with the adapter's
defaults the bridge was gone between 601 s and 661 s after the last call and another client took A; with
`lifecycle: "keep-alive"`, which this fixture's entry and the cockpit's pi card both carry, pi still held A at
700 s. A 700 s wait per condition does not belong in this harness.

**What the original run observed, kept as history:** FAILED on model silence, on fencing a stale owner and on
restart fencing, for the same reason A-17 failed — ownership was not wired. Task survival and restart survival
passed then too.

### A-19 — acceptance, delivery and a real model reaction: BLOCKED per client

Product half, PASSED (real `xezar serve`):

- `task_create` answered in 38 ms with status `accepted`; the run read `queued` right after; `done` arrived
  about 27 s later.
- The project journal received `task.done` (E-01), `task.cancelled` (E-01, origin `human`) and
  `question.asked` (E-02).
- The `task.done` row of the task the leader started is origin `system`, not `leader`, so the echo guard does
  not hide it from that leader (the #243 fix).

**pi: BLOCKED on the real-model clause alone. Everything else in the row is EXECUTED.**

ONE pi process carried both legs — `pi-mcp-adapter` 2.32.1 as the MCP client and xezar's own
`scripts/pi-leader-extension.ts` as the reaction link — in front of a real `xezar serve`. Both legs on one
process is #330's PI-04, and it is a requirement rather than tidiness: delivery needs an MCP session that OWNS
the project (`LeaderDelivery`'s `no-owner-session` blocker), and here that session is pi's own, so the client leg
is the precondition of the reaction leg.

| Check | Observed |
| --- | --- |
| The reaction target is a real adapter, not the blocker | `POST /api/v1/mcp/leader {attach, pi}` → **200**, `leader: {client: "pi", state: "attached"}`. `LeaderDelivery.#piTarget()` read the extension's descriptor and dialled its socket |
| Nothing had reached pi's model before the event | **0 model requests** while pi sat connected, attached and idle |
| The event reached the journal | E-01 `task.done`, origin `system` (not `leader`, so the echo guard does not withhold it — the #243 fix) |
| Delivery is observed | the dispatch arrived in pi's conversation as a `user` message beginning `[xezar event notification]` |
| A model reaction followed, with nobody typing anything | **1** model request, carrying the row's own `eventId` |
| No status-polling turn brought it about | it was the **first** request of the session; **0** more across a 40 s window and **0** more across a further 45 s window, longer than the controller's 30 s heartbeat |
| The model was still offered every xezar tool in that request | all **11** `xezar_*` tools — PI-04's second half, on one process |
| Delivery and reaction are reported separately, and both advanced | `deliveredSeq: 1, reactedSeq: 1, latestSeq: 1, state: idle` |
| **A REAL model reaction** | **not observable.** § 9 forbids personal accounts, so the model is a scripted OpenAI-completions endpoint inside the harness. pi really started a turn and really sent an inference request carrying the event; what a real model *decides* is not measured. OB-5 / PI-4, open for all four clients |

Every request was counted at that endpoint's own log, never read from pi. This is an independent confirmation of
#358's count of 1: a different fixture, a different revision, and pi reached through its own MCP adapter rather
than with `--no-extensions`.

Claude Code, Codex and OpenCode, **BLOCKED**:

- **No attach path exists for them.** `LeaderDelivery.#act` builds a target for `opencode` and `pi` only, and the
  contract's `client` enum (`packages/contract/src/mcp-leader.ts`) is `['opencode', 'pi']`. A Claude Code or
  Codex session in a terminal has no address xezar could attach to; an OpenCode one has (`opencode serve`) but
  was not run here. Read from source on this revision, not re-measured. Note that the original run's stated
  reason — "nothing in the running service constructs an `EventController` or any client adapter" — is no longer
  true: #311 constructs both.
- **A real model reaction** is not observable in a § 9 fixture, for the same reason it is not for pi.
- **Missing:** an adapter and an attach path for those clients, and a real model reaction (F-20). Leader
  decision: outside release 0.14.0. Not passed on documentation.

### A-20 — live sync: cockpit half PASSED, leader half BLOCKED on one clause

Cockpit half (browser, `mcp-live-sync.e2e.ts`, 4 of 4):

- A leader's MCP rename (the real `xez mcp` bridge, `organise_work set_title`) appeared in the open task list,
  and a value planted in the page was still there: **no reload**.
- The cockpit's server was stopped and started again; a rename made after the restart appeared on the same,
  never-reloaded page: **the cockpit reconnects and reconciles**.

Leader half (real `xezar serve`):

| Check | Result |
| --- | --- |
| An MCP mutation reaches the cockpit's live stream (`GET /api/v1/workspace/events`) | met |
| A human queued-prompt edit reaches the journal (E-04 `goal.changed`, origin `human`) | met |
| A human configuration write reaches the journal (E-05 `config.changed`, origin `human`) | met (after #252) |
| The human changes reach the leader (`leader_events read` returns both event ids) | met (after #251) |
| Reconnect reconciles (a fresh session reads the human's edit and the leader's title) | met |
| Reconnect re-delivers what was not acknowledged, and nothing after `ack` | met |
| The leader's own significant effect (it cancelled a task) is origin `leader` with the operation that caused it | met |
| **No recursive leader loop from echoes, logs, tokens or visual changes** | **BLOCKED** for a leader with no attach path; **PASSED for pi** — see below |

**The loop clause, for pi: PASSED.** It was BLOCKED in the original run because nothing delivered rows to a
leader, so neither a loop nor its absence could be seen. For pi something does deliver, so the clause itself is
measurable — and what it means with a live delivery path is quiescence. After the real reaction above, 45 s with
the leader attached, the project owned and the heartbeat running produced **no further model request**
(1 → 1) and the cursors came to rest (`reactedSeq === latestSeq`, `state: idle`). The reaction's own aftermath —
its echo rows, its logs, its tokens — started nothing.

The rest of A-20, the cockpit half and the six leader-half rows above, is not client-specific and was not re-run
per client. One of those rows needed a correction to the harness rather than to the product: the
`leader_events` `ack` call did not carry an `operationId`, which #264 made required, so it answered
"ack needs operationId" and a behaviour that works read as missing.

### A-23 — one exclusive owner across clients: BLOCKED per client (FAILED in the original run)

| Check | Claude Code | Codex | OpenCode | pi |
| --- | --- | --- | --- | --- |
| Local setup (A-01 client leg) | met | met | met | met |
| Reaction (A-19) | BLOCKED | BLOCKED | BLOCKED | BLOCKED on the real-model clause alone |
| Exclusive owner against another owner of A | **met** (A-17; not met before #302) | **met** | **met** | **met** |
| No covert second leader | **met** | **met** | **met** | **met** |

So A-23 is now BLOCKED rather than FAILED, for every client, and on one clause: a real model's decision. Its
exclusivity half, which was the whole of its failure in the original run, holds.

The built-in-leader half is **NOT RUN**: the built-in leader is specified separately and is out of scope for
#118. A second native client stood in as "the other owner", which is enough to show the rule IS enforced.

## Regression proof

This section is the **2026-09-11** regression proof and is kept as it was written. Two of its "a required
behaviour that is missing" rows have since been closed by #262 and #302; the table below marks which, and the
per-case sections above carry the 2026-09-12 readings. No row of this proof was re-run.

The five files #247 changed in the service (`src/index.ts`, `src/mcp/index.ts`, `src/mcp/service.ts`,
`src/mcp/event-catalog.ts`, `src/server/server.ts`) were checked out at `06abdcd` (the commit before #247), the
server was rebuilt, the tests were run, and the files were restored and rebuilt (`git status` clean after).

| Test | On `main` | Before #247 | Kind |
| --- | --- | --- | --- |
| `[product]` the MCP tools of a real `xezar serve` reach the service | pass | **fail** ("not connected") | proves the wiring |
| `[product]` a task's significant events reach the project journal | pass | **fail** (no journal) | proves the wiring |
| `[product]` A-20 leader half | 7 of 8 met | **nothing met** | proves the wiring |
| Browser: the MCP rename appears without a reload | pass | **fail** (`organise_work … is not connected`) | proves the wiring |
| Browser: a change across a reconnect appears on the same page | pass | **fail** (same) | proves the wiring |
| Browser: the setup cards separate automatic from one-time | pass | pass | guard — pins copy that must not regress |
| Browser: no manual disconnect or takeover control | pass | pass | guard |
| `[product]` the connection file is written | fail | fail | a required behaviour that was missing — **written since #262** |
| A-17, A-18, A-23 ownership checks | fail | fail | a required behaviour that was missing — **enforced since #302**, and passing on 2026-09-12 |
| Evidence hygiene (no world secret in any transcript) | pass | pass | guard over the evidence itself |

## Findings worth keeping

- **Codex does load a TRUSTED project's `.codex/config.toml`.** `mcpServerStatus/list` listed `xezar` from the
  project file once the project had a `trust_level = "trusted"` entry (codex-cli 0.154.0, app-server). This
  agrees with D-04 § 3.2 and scopes D-01 § 9.2's "no project-scoped MCP configuration" to an untrusted project.
- **A Bun-built client reads `$PWD`, not its process working directory.** OpenCode spawned with a working
  directory but an inherited `PWD` from elsewhere loaded no project `opencode.json` (`Model not found`), while
  `opencode mcp list` from the same directory did. A harness that spawns OpenCode must set `PWD`. This is a
  harness fact, not a product defect.
- **`claude --bare` reads MCP servers only from `--mcp-config`.** A local-scope entry is proven by
  `claude mcp list`; a model turn under `--bare` needs the same entry passed through `--mcp-config`.
- **The `health` result reaches Claude Code as structured content** (`{"project":{"id":…}}`), not as the
  text Codex shows. A check that matches only the text would fail a working Claude Code setup.

Added by the 2026-09-12 run (#330 WP5):

- **The pi blocker's one remedy named a file xezar does not ship, and it is fixed here.** `PI_EXTENSION_FIX` told
  the person to run `pi --extension <xezar>/scripts/pi-leader-extension.mjs`. There is no such file: the
  extension ships as `scripts/pi-leader-extension.ts`, which is what the tarball carries, what
  `pi-leader-extension.md` documents and what pi loads. `.mjs` appeared exactly once in the repository, on the
  only path where being wrong costs the person their remedy. `pi.test.ts` now takes the path out of the string
  and checks the file is in the package and that `files` would publish it. **This is the one product file this
  branch changes.**
- **`no-owner-session`'s message and fix name OpenCode even when the attached leader is pi.** Observed on the
  pi-side restart: with a pi leader attached and no owner session, the blocker reads "OpenCode connects its xezar
  MCP server only when it first needs it" and the fix is "Let the attached OpenCode session call a xezar tool
  once". The code and the shape are right and nothing is lost; the words are for the wrong product. Not fixed
  here (it is `leader-delivery.ts`'s wording, outside this record's scope) and worth a follow-up.
- **The pi leader socket is driveable by any process running as the same user, and that is not hypothetical.**
  Mid-run, a peer agent's own pi probe was pointed at this harness's live leader socket: its two prompts arrived
  as model requests 17 and 18 of a case whose whole claim is that request 1 was the only one, and the failure
  read as "the heartbeat polled". The extension's `0700` directory guards other **accounts**, which is what
  `pi-leader-extension.md` claims and all it claims — but "It starts nothing on its own. A turn happens only when
  xezar hands over an event" reads as though xezar were the only writer. On a machine running many agents as one
  user it is not. The harness now gives each pi a private `TMPDIR` outside the globbable `/tmp/xez-pi-*`
  namespace, and **names** a model request it did not cause instead of counting it, because "the leader polled"
  and "something else wrote into this pi" must not read the same.
- **The A-01 client legs had lost an assumption to #302.** Each spawns a bridge xezar does not own, which exits a
  moment after the command we awaited returns; since ownership is enforced, the next leg's handshake met `-32080`
  and a working Codex read as FAILED. Each leg now waits for the project to be free, bounded, and records how
  long the release took — D-02 § 4 claims it happens on disconnect, so that is worth measuring rather than
  sleeping through. Codex passes on this run; it failed this way in two earlier runs of the same revision, so
  treat that leg as order-sensitive until the release is measured rather than waited for.

## Traceability

A-01, A-17, A-18, A-19, A-20, A-23; F-13, F-14, F-17–F-21; E-01–E-06 (E-01, E-02, E-04, E-05 observed); S-01;
D-02 (occupied and expired errors, § 4; restart, § 5), D-04 (connection file, § 2; per-client setup, § 3).

For pi specifically (#330): PI-02 (reaches A through the real bridge), PI-04 (a delivered event starts a turn,
and the same pi process still sees every xezar tool), PI-07 (a pi column on the same revision as the other
three), PI-08 (the edge paths — pi missing is NOT RUN, and `approveTools` **FAILED**). The two halves of pi's own
record are `mcp-adapter-evidence-pi.md`; this record holds the acceptance verdicts.
