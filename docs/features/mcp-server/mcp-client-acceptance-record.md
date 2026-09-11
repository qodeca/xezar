# MCP real-client acceptance record — A-01, A-17, A-18, A-19, A-20, A-23

Issue: [#118](https://github.com/qodeca/xezar/issues/118). Phase 8 ([#75](https://github.com/qodeca/xezar/issues/75))
of [epic #67](https://github.com/qodeca/xezar/issues/67). Covers A-01, A-17, A-18, A-19, A-20 and A-23 of the
[requirements § 9](mcp-project-leader-requirements.md), per officially supported client.

Run date: **2026-09-11**. Revision under test: **`ed1492e`** (branch `xez/e9d1574e`, which is `main` at `df80a7e`
plus the two test files this record describes; no product file differs from `main`). Host: macOS 26.6.2
(arm64), Node v24.20.0. Clients, as installed on the host: **Claude Code 2.1.268**, **Codex CLI 0.154.0**,
**OpenCode 1.18.30**. These are installed versions, not certified minimums.

## Answer first

| Case | Claude Code | Codex | OpenCode | Product-level checks | What is missing |
| --- | --- | --- | --- | --- | --- |
| **A-01** setup | client leg **PASSED** | client leg **PASSED** | client leg **PASSED** | connection file: **FAILED**; tools reach the service: **PASSED** | **A-01 is FAILED**: nothing in the product writes D-04's `.local/xezar/mcp-connection.json` |
| **A-17** competing owner | **FAILED** | **FAILED** | **FAILED** | second bridge admitted: **FAILED**; same-owner concurrency and project B: pass | Exclusive ownership over a live session is not wired |
| **A-18** liveness, fencing, restart | — | — | — | **FAILED** (task survival and restart survival pass; fencing and idle-owner exclusivity fail) | Same as A-17 |
| **A-19** delivery and model reaction | **BLOCKED** | **BLOCKED** | **BLOCKED** | acceptance vs result and journal emission: **PASSED** | No delivery path to any client; no real model may run in a § 9 fixture |
| **A-20** live sync | — | — | — | cockpit half (browser): **PASSED**; leader half: **BLOCKED** on one clause | The no-recursive-loop clause needs push delivery to be observable |
| **A-23** exclusive owner, three clients | **FAILED** | **FAILED** | **FAILED** | — | Exclusivity (A-17) and reaction (A-19); the built-in-leader half was **NOT RUN** (out of scope) |

**No case in this record passes as a whole.** A-01's three client legs pass, A-20's cockpit half passes, and
A-19's product half passes; every whole case is FAILED or BLOCKED. The leader decided (2026-09-11)
that push delivery with a real model reaction, exclusive ownership over a live session and multi-project MCP
are outside release 0.14.0; this record shows exactly where that boundary bites and passes nothing on
documentation.

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

### A-01 — provisioning and one-time setup: FAILED

| Check | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| One-time step as documented | `claude mcp add --scope local` → exit 0, file inside the pinned folder | project `.codex/config.toml` + a trust entry | project `opencode.json` `mcp.xezar` block |
| Handshake / entry loaded | `claude mcp list` → `✔ Connected` | `mcpServerStatus/list` lists `xezar` | `opencode mcp list` → `✓ xezar connected` |
| The client reaches A (the `health` tool) | tool result names `alpha-proj` | `xezar 0.0.0-ab is running for project alpha project (alpha-proj).` | tool result names `alpha-proj` |
| A registry tool answers with A's data (`task_read`) | A's tasks | A's tasks | A's tasks |
| Nothing of B reaches the client | none | none | none |
| No connection data or secret in the client config | none (command only) | none | none |
| What the step added to A's working tree | nothing (local scope is outside the repo) | `?? .codex/config.toml` | `?? opencode.json` |

Product-level:

- **FAILED — the connection file.** A real `xezar serve` opened the MCP socket and wrote no
  `<root>/.local/xezar/mcp-connection.json`. D-04.1 and D-04.3 decided that file and its trigger; in the files
  examined, `mcp-connection.json` is named only by tests (`ab-fixture.ts` plants it for A-12). The discovery the
  clients actually use — the workspace registry plus the socket under `XEZ_HOME` (D-01 § 4) — works without it,
  but A-01 requires xezar to write the configuration into A's `.local/xezar/`, and it does not.
- **PASSED — the tools reach the service** in the shipped product (after #247). Before #247 every registry
  tool answered "not connected" (regression proof below).
- **The instructions** — one-time step separated from what xezar does, and no autodiscovery claim — are
  checked in the real cockpit by the browser spec: each of the three client cards has an "Automatic" part, a
  "One-time" part and a "does not discover `.local/xezar/mcp-connection.json`" line. PASSED.

### A-17 — only the competing owner is rejected: FAILED

- **FAILED.** With a live `xez mcp` bridge owning A, a second bridge process's `initialize` was accepted and its
  `organise_work pin` changed A. Required: `-32080` with `data.reason: "com.qodeca.xezar/project-occupied"`
  (D-02 § 4).
- **FAILED per client.** Claude Code (`claude mcp list` → `✔ Connected`), Codex (`mcpServer/tool/call
  organise_work pin` → done) and OpenCode (`opencode mcp list` → connected), each as the second logical client
  while A had a live owner, were all admitted.
- **Met:** 20 concurrent requests from the owner all succeeded; a client of project B reached B.
- **Control:** `ProjectOwnership`, driven directly, answers the D-02 occupied error for a second session, so the
  detector recognises a refusal when one exists. The mechanism exists; nothing calls it.
- **No manual disconnect UI** — checked in the real cockpit by the browser spec: the MCP connection screen has no
  disconnect, takeover, force, kick, evict or release control. PASSED (it also passed before #247: a guard).
- **Missing:** exclusive ownership over a live session. Nothing in the running service calls
  `ProjectOwnership`, and the bridge opens one socket connection per tool call, so there is no session whose
  close could be observed. Leader decision: a Phase 6 bridge protocol change, outside release 0.14.0.

### A-18 — liveness, fencing and restart: FAILED

- **FAILED — model silence.** After 6 s of owner silence (longer than D-02.5's 5 s renewal interval; no lease
  duration is asserted), a new client of A was admitted and wrote.
- **FAILED — fencing.** After the owner was SIGKILLed and a successor connected, the still-alive earlier
  client's write was accepted (the task title it wrote is the final one). Required: `-32081` /
  `com.qodeca.xezar/session-expired`.
- **FAILED — restart fencing.** A bridge process that survived a `xezar serve` restart made its next call and
  was answered normally. Required by D-02 § 5: its session ended with the service.
- **Met:** a task started through MCP (`mock:slow`, about 25 s) reached `done` after its owner was SIGKILLed;
  while the service was down, a tool call answered "xezar is not running for project …" (no hang); after the
  restart the pre-restart task and its result were still there.
- **Missing:** same as A-17.

### A-19 — acceptance, delivery and a real model reaction: BLOCKED per client

Product half, PASSED (real `xezar serve`):

- `task_create` answered in 38 ms with status `accepted`; the run read `queued` right after; `done` arrived
  about 27 s later.
- The project journal received `task.done` (E-01), `task.cancelled` (E-01, origin `human`) and
  `question.asked` (E-02).
- The `task.done` row of the task the leader started is origin `system`, not `leader`, so the echo guard does
  not hide it from that leader (the #243 fix).

Per client, **BLOCKED**:

- **Delivery** is not observable: nothing in the running service constructs an `EventController` or any of the
  three client adapters (#108–#110). `startMcpService` composes the journal, catalog, receipts, echo guard,
  audit and the leader read tool, and no adapter.
- **A real model reaction** is not observable in a § 9 fixture, which forbids personal accounts: every model
  here is the scripted endpoint, and a turn it answers is not a real model's reaction. The adapter records for
  Claude Code, Codex and OpenCode say the same.
- **Missing:** push delivery and a real model reaction (F-20). Leader decision: outside release 0.14.0. Not
  passed on documentation.

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
| **No recursive leader loop from echoes, logs, tokens or visual changes** | **BLOCKED**: nothing delivers rows to a leader, so no loop — or its absence — can be observed; only its precondition (the row above) is |

### A-23 — one exclusive owner across clients: FAILED per client

| Check | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Local setup (A-01 client leg) | met | met | met |
| Reaction (A-19) | BLOCKED | BLOCKED | BLOCKED |
| Exclusive owner against another owner of A | not met (A-17) | not met | not met |
| No covert second leader | not met: two clients held A at once | not met | not met |

The built-in-leader half is **NOT RUN**: the built-in leader is specified separately and is out of scope for
#118. A second native client stood in as "the other owner", which is enough to show the rule is not enforced.

## Regression proof

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
| `[product]` the connection file is written | fail | fail | a required behaviour that is missing |
| A-17, A-18, A-23 ownership checks | fail | fail | a required behaviour that is missing |
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

## Traceability

A-01, A-17, A-18, A-19, A-20, A-23; F-13, F-14, F-17–F-21; E-01–E-06 (E-01, E-02, E-04, E-05 observed); S-01;
D-02 (occupied and expired errors, § 4; restart, § 5), D-04 (connection file, § 2; per-client setup, § 3).
