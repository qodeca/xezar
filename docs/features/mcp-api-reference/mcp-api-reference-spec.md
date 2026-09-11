# MCP API reference – requirements and technical solution

Status: **specification for owner review; nothing here is implemented by this document**. Date: 2026-09-11.
Audience: the project owner first, then the engineers who build it.

Tracked by [#263](https://github.com/qodeca/xezar/issues/263). Related: [#261](https://github.com/qodeca/xezar/issues/261)
(the generated reference, in flight), [#262](https://github.com/qodeca/xezar/issues/262) (four leader gaps, in flight),
[epic #67](https://github.com/qodeca/xezar/issues/67).

**Baseline revision:** `ef4b7683ebbbcd17c1ede26b7fd4f870546e7e74` (`main`, 2026-09-11). Every file, symbol and count
below was read or measured at that revision. Counts move when tools change; re-derive them before relying on one.

## Summary for the owner

You asked for "a Swagger kind of documentation for the MCP ... a way for a human to verify the design and API of the MCP
server", and then for "the swagger type of UI". This document specifies both halves:

1. **A reference a machine can check.** A committed JSON file that is exactly what the MCP server tells a client about
   its tools, plus a generated Markdown page and a record-to-tool coverage table. A test fails `npm test` when any of
   them disagrees with the running code.
2. **A page a person can browse.** A read-only cockpit page under project Settings that shows the same data: every tool,
   its actions, its arguments, what it returns, what it refuses, and which inventory records it serves.

What it deliberately does **not** have: a "Try it" button. Section 13 explains why. In short: running a tool from the
cockpit would make the cockpit a second leader on the project and would forge the audit trail's "who did this".

Five questions need your decision. They are at the end, under [Open questions for the owner](#open-questions-for-the-owner),
each with a recommendation and what each choice costs.

## Contents

- [The seven findings, checked](#the-seven-findings-checked)
- [Part 1 – Requirements](#part-1--requirements)
- [Part 2 – Technical solution](#part-2--technical-solution)
- [Part 3 – Decisions](#part-3--decisions)
- [Part 4 – Current state, honestly](#part-4--current-state-honestly)
- [Open questions for the owner](#open-questions-for-the-owner)

## The seven findings, checked

The brief for this work stated seven findings. Each was checked against the source at the baseline revision.
Four are confirmed, three are partly wrong. None is wholly wrong, but the wrong parts matter for the design.

| # | The brief said | Verdict | What the source says |
| --- | --- | --- | --- |
| 1 | `toolListing()` in `tool.ts` converts each zod schema with native zod v4 `z.toJSONSchema(..., { io: 'input' })`, and `tools/list` in `bridge.ts` answers name, optional title, description, inputSchema and optional annotations for **8** registered tools plus a built-in `health` tool. | **Partly wrong – the count.** | The mechanism is exactly as stated (`packages/xezar/src/mcp/tool.ts:58-67`; `bridge.ts:117-119`). `toolListing()` also strips the `$schema` dialect key. But the registry (`packages/xezar/src/mcp/tools/index.ts`) holds **10** tools, not 8: `task_read`, `execution_control`, `discover_project`, `organise_work`, `task_create`, `handoff_git`, `read_results_evidence`, `project_config`, `local_handoff`, `leader_events`. With `health`, `tools/list` answers **11** entries, 53,134 bytes pretty-printed (measured). Note the results tool is named `read_results_evidence`, not `results_evidence`. Issue #261's own body already says 10. |
| 2 | The server exposes tools only; `SERVER_CAPABILITIES` advertises no resources and no prompts, and the bridge answers methodNotFound for them. | **Confirmed.** | `SERVER_CAPABILITIES = { tools: { listChanged: false } }` (`protocol.ts:31`). The bridge handles `initialize`, `ping`, `tools/list`, `tools/call`; every other method gets `-32601 Method not found` (`bridge.ts:140-141`). Logging is not advertised either, and `listChanged: false` means the list is fixed for the life of the process. Notifications, including `notifications/cancelled`, are accepted and ignored without an answer (`bridge.ts:95-98`). |
| 3 | No reader-facing catalog of the tools exists anywhere – not in docs/, not a README, not comments. | **Confirmed as "no catalog"; imprecise about comments.** | No document, README section or index lists the tools. Tool names appear only in passing in `mcp-client-acceptance-record.md`, the three `mcp-adapter-evidence-*.md` records, `mcp-parity-coverage-map.md` and `.xezar/docs/dogfooding.md` (files examined by grep). `mcp-result-evidence-fields.md` is a pre-implementation field record ("nothing here is implemented"), not a catalog. But each tool file does carry long design comments, and every tool sends its own `description` and per-argument `.describe()` text on the wire. What is missing is **one place** that lists them all for a human. |
| 4 | The coverage claim cannot be checked: the inventory's 140 records (89 `covered`) record outcomes, not tool names; naming tools was deferred to a step that never happened; Definition-of-Done clause 1 rests on a mapping that does not exist. | **Partly wrong.** | The counts are right: 140 records, 89 `covered`, 20 `global`, 31 `presentation` (recomputed from the rows, and pinned by `acceptance-parity.test.ts:1812-1816`). The inventory does say "Naming tools stays deferred" (`mcp-ui-action-inventory.md`, header). **But coverage is checked mechanically today.** #116 (PRs #248, #257) maps every `covered` record to at least one acceptance case (`P-01`…, `B-01`…), each case drives both the cockpit route and the MCP tool, and `npm test` fails when a covered record has no case or when `mcp-parity-coverage-map.md` drifts from the registered cases (`acceptance-parity.test.ts:1818-1854`). So DoD clause 1 does rest on an existing, checked mapping – record to **acceptance case**. What does not exist is the mapping record to **tool and action**. Today a human can only find which tool serves a record by reading test code. That is the gap this work closes. |
| 5 | The result side is inconsistent: only the envelope (`toolResultSchema` in `ipc.ts`) is shared; `execution_control` uses accepted\|done\|cancelled\|conflict\|failed; `task_create` adds running; `handoff_git` uses status 'failed' with refusedBy 'policy'\|'service' plus blocker/blockers; `project_config` has its own `Answer<T>` of ok/status/value\|error/body; `results_evidence` its own Answer/Envelope/unavailable; `task_read` its own status/body. | **Conclusion confirmed; three of the six examples are wrong.** | The envelope is the only shared shape (`ipc.ts:92-96`). `execution_control` (`executionControlResultSchema`, `execution-control.ts:163-181`) and `task_create` (`McpStatus`, `task-create.ts:351`) are as stated. `handoff_git` is **understated**: `refusedBy` has four values – `policy`, `service`, `quality`, `forge` – and a stale head is `status: 'conflict'` with `code: 'stale-head'` (`handoff-git.ts:423-490`). The other three examples cite **internal helper types that never reach the leader**. `Answer<T>` in `project-config.ts:484` (and an identical one in `execution-control.ts:199`) reads the in-process HTTP answer; the leader receives `{action, origin: 'mcp', result}` on success, `{action, origin, status: <HTTP number>, error}` as an error, or `{action, origin, refused: true, boundary}` (`project-config.ts:507-541`). `Answer` in `results-evidence.ts:308` and `task-reads.ts:341` is the same kind of plumbing; the real result is `Envelope` with `evidence: available\|unavailable\|stale` and a numeric `status` (`results-evidence.ts:187-229`), and `task_read` answers `{view, …}` with **no status field at all**. The real inconsistency, measured from what goes on the wire, is in [section 10.4](#104-what-the-reference-must-show-about-results). |
| 6 | Two meanings of "origin": journal events use human\|leader\|system (D-05); audit records use ui\|mcp\|automation\|cli and must be server-derived (D-06). | **Confirmed, and it is worse than stated.** | `mcpJournalOriginSchema = z.enum(['human', 'leader', 'system'])` (`packages/contract/src/mcp-journal.ts:54`); `auditOriginSchema = z.enum(['ui', 'mcp', 'automation', 'cli'])` (`packages/contract/src/mcp-audit.ts:28`), stamped from the door and never from the operation (`audit-trail.ts:23-35`; D-06 § 10.4). Not stated in the brief: the audit value leaks into tool results. `execution_control`, `project_config` and `local_handoff` put `origin: 'mcp'` on their results (`MCP_ORIGIN`, `service-adapter.ts:49`), while `leader_events` returns journal rows whose origin is `leader` for the same act. A leader sees both vocabularies in one session. |
| 7 | `mcp-project-leader-requirements.md` still says the feature "is not implemented". | **Confirmed.** | Line 3: "Status: **requirements draft; the feature is not implemented**". Line 7 also says it is "neither an approved protocol design nor a catalog of existing MCP tools", and section 11 still says only a later specification "should … assign tool names". The sibling task for #261 owns the one-line status fix; this document does not edit that file. |

## Part 1 – Requirements

"MUST" is a required outcome. Each requirement is testable; the test or evidence that proves it is named in
[section 15](#15-verification-plan). Existing requirement ids (`F-`, `N-`, `A-`, `U-M`, `D-`) are those of
[`mcp-project-leader-requirements.md`](../mcp-server/mcp-project-leader-requirements.md) and the D-decision records.

### 1. The reader and what they must be able to do

The reader is a person who did not build the MCP server and wants to judge it: the project owner reviewing the design,
or an engineer reviewing a pull request that changes a tool. They are not a leader model and they do not want to run
anything. They must be able to do four jobs without reading source code.

| ID | The reader must be able to |
| --- | --- |
| J-1 | **Review the tool surface.** See every tool, every action inside it, every argument with its type, whether it is required and its own description, and the hints the server gives clients (read-only, destructive, idempotent, open-world). |
| J-2 | **Check the promised UI coverage.** For each `covered` inventory record, see which tool and action serves it; for each tool action, see which records justify it; see any record that no tool serves as a named finding, not a gap hidden by a green table. |
| J-3 | **Understand what a tool returns and what it refuses.** See the shared result envelope, each tool's own status words, how a conflict differs from an error, and which actions are refused on principle with the boundary named. Where tools disagree, the reference says so. |
| J-4 | **See what the server deliberately does not expose.** No resources, no prompts, no logging, no account identity, no secret, no other project, no host-process control – each with the requirement that forbids it. |

### 2. The machine-readable artifact

| ID | Requirement | Traces to |
| --- | --- | --- |
| AR-01 | A committed JSON file MUST hold exactly the value `tools/list` answers: `[HEALTH_TOOL, ...tools.map(toolListing)]`, pretty-printed with two-space indentation, keys in the order `toolListing()` emits, and one trailing newline. | J-1 |
| AR-02 | The file MUST be produced by calling `toolListing()` and reading `HEALTH_TOOL`, never by re-deriving JSON Schema or parsing source text. | J-1; no-drift |
| AR-03 | The file MUST be valid JSON that a standard JSON Schema viewer can load tool by tool (each `inputSchema` is a JSON Schema object). | J-1 |
| AR-04 | The file MUST NOT contain a secret, an absolute path, a user name, an e-mail address or an account identity. | F-15, F-12, N-01 |
| AR-05 | The artifact MUST describe the server, not a project: it MUST NOT contain a project id, name or root. | N-01 |

### 3. The generated human-readable reference

| ID | Requirement | Traces to |
| --- | --- | --- |
| RF-01 | A Markdown reference MUST combine hand-written prose with generated tables. Each generated table MUST sit between a named pair of HTML comment markers, the pattern `mcp-parity-coverage-map.md` already uses. | J-1–J-4 |
| RF-02 | One generated row per tool MUST give: name, title, one-line purpose, the four annotation hints as words, whether any action requires `expectedVersion`, and whether any action accepts `operationId`. An annotation the tool omits MUST read as "not stated (client default)", never as a guessed value. | J-1 |
| RF-03 | Per tool, a generated argument table MUST give each argument's name, type, whether it is required, its allowed values when it is an enum, and the schema's own description **verbatim**. | J-1 |
| RF-04 | Per tool, a generated action list MUST give each action (the value of its `action`, `view` or `read` argument) and whether the action performs, reads or refuses. | J-1, J-3 |
| RF-05 | A result section MUST show the shared envelope and, per tool, the status words it returns today, which field carries them, and whether a refusal is an error result or an ordinary result. Where tools disagree it MUST say so in words. | J-3 |
| RF-06 | The two `origin` vocabularies MUST appear side by side with their owners (D-05, D-06), their meanings and the rule that the audit origin is server-derived. | J-3 |
| RF-07 | Cross-cutting rules MUST each link to the decision record that owns them: project scoping and refusals (D-03; F-01, F-02, F-16), stale-write and the version token (D-06, #250), operation ids and idempotency (D-06), the audit record (D-06), events and replay (D-05), the connection file (D-04), limits (D-09). | J-3 |
| RF-08 | A "what this server does not expose" section MUST list J-4's items, each with the requirement that forbids it. | J-4 |
| RF-09 | The reference MUST be reachable in one step from the MCP documents' entry point and from the MCP rows of `AGENTS.md`'s task-routing table. | J-1 |

### 4. Coverage traceability

| ID | Requirement | Traces to |
| --- | --- | --- |
| CT-01 | The mapping from inventory records to tool actions MUST be declared **once, as data**, in a module that ships with the server (not a test-only file), so the cockpit page and the tests read the same declaration. | J-2 |
| CT-02 | Every `covered` record MUST map to at least one tool action that exists in the live registry. | J-2; DoD 1 |
| CT-03 | Every tool action that performs or reads MUST appear against at least one `covered` record, or carry an explicit justification that names the requirement it serves (for example `health`, which exists so a client can learn the service is down – N-07 – and has no cockpit control). A justification is visible in the reference; it is never silent. | J-2 |
| CT-04 | Every refusal-only action (an action the schema accepts only to refuse it, such as `project_config set_workspace_config`) MUST map to at least one `global` record. | J-2, J-3 |
| CT-05 | No row MAY name a `presentation` record. Section 3 of the requirements says those need no tool; naming one would dress a non-action up as coverage. | J-2 |
| CT-06 | A `covered` record that no tool serves MUST appear as a named, never-passing entry that states what is missing. The status of a record MUST NOT be changed, and no mapping invented, to make the table close. | J-2 |
| CT-07 | The generated coverage table in the Markdown reference MUST equal the table re-rendered from the declaration, both ways. | J-2; no-drift |

### 5. The browsable cockpit view

| ID | Requirement | Traces to |
| --- | --- | --- |
| CV-01 | The cockpit MUST offer a read-only page that shows the reference: server identity and version, supported protocol revisions, advertised capabilities, every tool, its actions, its arguments, its result vocabulary, its refusals and its coverage rows. | J-1–J-4 |
| CV-02 | The page MUST render from the read-only route of section 11 alone. It MUST NOT hard-code a tool name, an action or a record id. | no-drift |
| CV-03 | Each tool MUST be a collapsed disclosure by default, expandable one at a time or all at once, and reachable by a link that opens that tool expanded. | J-1 |
| CV-04 | The page MUST distinguish, in **text** and not by colour alone, a read-only tool or action from one that changes project state, and a destructive one from a non-destructive one. | J-1, U-M08 |
| CV-05 | The page MUST show the coverage table with a filter by inventory status, and MUST show any never-passing coverage entry (CT-06) as prominently as a mapped one. | J-2 |
| CV-06 | The page MUST contain no control that executes, simulates or prepares a tool call: no "Try it", no "Send", no request builder, no copy-as-command. See [section 13](#13-the-hard-boundary-no-try-it). | F-16, F-18, A-17, A-23, D-06 § 10.4 |
| CV-07 | When the route answers "unavailable", the page MUST say so in one plain sentence with the reason, and the rest of the cockpit MUST keep working. | N-07 |

### 6. Non-functional requirements that already bind this repository

| ID | Requirement | Source |
| --- | --- | --- |
| NF-01 | **Zero config.** No setting, no `XEZ_*` variable, no port, no file a user must create. The page and route exist in every cockpit, local or hosted, with or without an MCP client. | AGENTS.md § Zero config |
| NF-02 | **MCP can never break the cockpit booting.** The route MUST load the tool registry lazily and MUST answer `{available: false, reason}` instead of failing when it cannot. A broken MCP module MUST leave the rest of the cockpit usable. | N-07; `startMcpSocket` in `packages/xezar/src/index.ts:388-409` |
| NF-03 | **No secret anywhere.** No secret, credential, launch key or environment value in the artifact, the generated page, the route response or the cockpit page. | F-15, A-12 |
| NF-04 | **No account identity, no other project.** No e-mail, login, organisation, plan or profile id; no other project's name or existence. | F-12, N-01 |
| NF-05 | **Contract shapes.** The route's response shape MUST be a zod schema in `packages/contract`, with its TypeScript type inferred (`z.infer`). No hand-written type, no schema declared in `server.ts` or in the api-client. A contract-parity check MUST prove the schema and the route agree in **both** directions. | AGENTS.md § The HTTP API |
| NF-06 | **Route registration.** The route MUST be registered by chaining into a family builder that is itself chained into the project `v1` chain, so it is mounted at both `/api/v1/<path>` and `/api/v1/p/:projectId/<path>`, reaches `AppType`, passes `route-parity.test.ts` and is inventoried in `BACKWARD_COMPATIBILITY.md` § 2. | AGENTS.md § The HTTP API; `bc-route-inventory.test.ts` |
| NF-07 | **Accessibility to the #114 bar.** Every control labelled and keyboard-reachable; visible focus; status and kind conveyed without colour; polite announcement of changed counts; readable errors; theme tokens only, light and dark; the settings drill-in on phones. | #114; U-M08, UX-M06 |
| NF-08 | **375 px.** At 375 px width the page MUST NOT scroll sideways (`scrollWidth` equals `clientWidth`); schemas and paths MUST wrap; tables MUST reflow. Verified in a real browser, as #114 was (PR #255). | #114 |
| NF-09 | **Read-only.** The route MUST be a `GET` with no side effect, no write to disk, no audit entry and no journal event. | CV-06 |
| NF-10 | **No network.** Building the reference MUST NOT reach the network or spawn a process. | AGENTS.md § Zero config |

### 7. The reference cannot silently drift from the code

"Cannot" has a mechanical meaning here: **a pull request that changes the tool surface without regenerating the
reference fails `npm test`, which is a required CI check, so it cannot merge.** No reviewer's attention is assumed.

| ID | Requirement |
| --- | --- |
| DR-01 | A test MUST fail when the committed JSON artifact differs by one byte from the live `[HEALTH_TOOL, ...tools.map(toolListing)]`. This covers a tool added, removed or renamed, and any change to a title, description, argument, enum value, default or annotation. |
| DR-02 | A test MUST fail when any generated table in the Markdown reference differs from the table re-rendered from the live registry and the coverage declaration. |
| DR-03 | A test MUST fail on any of CT-02 to CT-06 being violated, including when a tool gains an action that no record or justification covers. |
| DR-04 | A test MUST prove that the route answers the same tool list as a real bridge's `tools/list` (driven in-process through `runBridge`) and as the committed artifact – a three-way equality, so the page, the wire and the document cannot disagree. |
| DR-05 | A cockpit test MUST render the page from a route fixture that contains a tool the real registry does not have, and assert that tool appears. This proves the page has no hard-coded list. |
| DR-06 | Each drift test MUST be proven to fail without the change it guards (AGENTS.md: prove the regression test fails). The pull request MUST record the scratch change used and the red result observed. |
| DR-07 | Every failure message MUST say what to regenerate and how, so the fix is one command, not an investigation. |

## Part 2 – Technical solution

### 8. The drift-proof mechanism

#### 8.1 What this repository already does, and what is adopted

| Existing mechanism | What it does | Adopted? |
| --- | --- | --- |
| `acceptance-parity.test.ts` + `mcp-parity-coverage-map.md` | Tables live between `<!-- parity-map:<name>:start -->` and `:end` markers. The test re-renders them from registered data and asserts exact string equality (`acceptance-parity.test.ts:1800-1854`), with the expected table in the failure message. | **Adopted as the core mechanism** for the Markdown reference (RF-01, DR-02). It is proven in this codebase, needs no dependency, and a reviewer reads the table in a normal Markdown page. |
| `bc-route-inventory.test.ts` | Reads a **built app's** route table (`app.routes`) instead of grepping `server.ts`, because a regex over source quietly stops seeing routes when their registration style changes. | **Adopted as a principle**: every generated value comes from the live registry and `toolListing()` (AR-02). Nothing parses tool source text. |
| `contract-parity*.test.ts` | Proves a schema and a route are mutually assignable, in **both** directions, because a one-way check stays green on real drift. | **Adopted twice**: for the route's response schema (NF-05), and as the shape of the coverage check – records to actions **and** actions to records (CT-02, CT-03). |

#### 8.2 Rejected alternatives

| Alternative | Why it is rejected |
| --- | --- |
| A hand-maintained reference with a review checklist | Depends on attention; the requirements (DR-01 to DR-03) exist because attention fails. |
| A build-time generator that writes the reference into `web/dist` or `dist` only | Nothing committed means nothing to diff in a pull request, which is the owner's review surface. |
| A CI-only script outside `npm test` | A developer finds out after pushing; the repository's habit is that `npm test` fails locally first. |
| Vitest snapshots (`toMatchSnapshot`) | `vitest -u` rewrites them silently, and a `.snap` file is not a page a person reads. A committed artifact in `docs/` with an explicit regenerate message is the same check with a reviewable output. |
| Converting to OpenAPI / Swagger UI | MCP is JSON-RPC over stdio, not HTTP; an OpenAPI description would be a translation that can be wrong. It would also add a runtime dependency (Swagger UI) that the dependency budget in `CODE_REVIEW.md` does not allow. The owner's "Swagger" is read as "that kind of browsable reference", not that product. |
| Serving the committed `docs/` files from the route | `docs/` is not in the published package (`packages/xezar/package.json` `files`: `dist`, `web/dist`, `scripts`, `README.md`), and a committed file may describe another version than the one running. The route derives from the running code instead. |

### 9. The artifacts and where each lives

| Artifact | Path | Generated? | Owner |
| --- | --- | --- | --- |
| This specification | `docs/features/mcp-api-reference/mcp-api-reference-spec.md` | No | #263 |
| Machine-readable reference (AR-01) | `docs/features/mcp-server/mcp-api.json` | Yes, checked by DR-01 | #261 (in flight) |
| Human-readable reference (RF-01) | `docs/features/mcp-server/mcp-api.md` | Prose by hand, tables generated, checked by DR-02 | #261 (in flight) |
| Coverage and result declaration (CT-01) | `packages/xezar/src/mcp/api-reference.ts` – **a shipped module, not a `.testkit.ts`** | No – declared data plus one builder function | Implementation issue to be filed |
| Drift tests | `packages/xezar/src/mcp/mcp-api-doc.test.ts` | – | #261 (in flight) |
| Response schema (NF-05) | `packages/contract/src/mcp-api-reference.ts`, exported from `packages/contract/src/index.ts` | – | Implementation issue |
| Read-only route (section 11) | a `mcpReferenceRoutes` family in `packages/xezar/src/server/server.ts`, chained into `v1` | – | Implementation issue |
| Cockpit page (section 12) | `packages/web/src/routes/settings/mcp-api-section.tsx` plus one entry in `registry.tsx` | – | Implementation issue |
| Route inventory line | `BACKWARD_COMPATIBILITY.md` § 2 | – | Implementation issue |

The paths of the two generated documents follow the sibling brief for #261 so the two tasks do not collide. The
declaration module is the one deliberate change to that brief: see [Part 4](#part-4--current-state-honestly).

### 10. Coverage traceability, declared and checked both ways

#### 10.1 What a "tool action" is

A tool action is a pair (tool, value of its discriminator argument), read from the tool's **listed** JSON Schema. The
discriminator is whichever of `action`, `view` or `read` the schema declares as an enum. A tool with none of them
(`health`, `discover_project`) has exactly one implicit action. Measured at the baseline:

| Tool | Discriminator | Actions that perform or read | Refusal-only actions |
| --- | --- | --- | --- |
| `health` (built into the bridge) | none | 1 | 0 |
| `task_read` | `view` | 7 | 0 |
| `execution_control` | `action` | 8 | 0 |
| `discover_project` | none | 1 | 0 |
| `organise_work` | `action` | 17 | 0 |
| `task_create` | `action` (default `start`) | 4 | 0 |
| `handoff_git` | `action` | 7 | 0 |
| `read_results_evidence` | `read` | 17 | 0 |
| `project_config` | `action` | 35 | 20 (`REFUSED_ACTIONS`, `project-config.ts:171`) |
| `local_handoff` | `action` | 4 | 0 |
| `leader_events` | `action` | 2 | 0 |
| **Total** | | **103** | **20** |

A refusal-only action is still part of the schema a client sees, which is why it needs its own rule (CT-04).

#### 10.2 The declaration

`packages/xezar/src/mcp/api-reference.ts` exports plain data, typed but not zod-validated at runtime (it is code, not
input):

- **Coverage rows:** `{ record: 'I-001', tool: 'task_create', action: 'start' }`. One record may have several rows; one
  action may serve several records.
- **Justifications:** `{ tool: 'health', action: null, serves: ['N-07'], reason: '…' }` for an action that serves a
  requirement rather than a UI record. The reference prints them in their own table.
- **Refusal rows:** `{ tool: 'project_config', action: 'set_workspace_config', records: ['I-1xx'] }`, pointing at the
  `global` records the refusal enforces.
- **Result declarations:** per tool, the status field, its words, and whether a refusal is an error result (section 10.4).
- **One builder,** `buildMcpApiReference(tools, healthTool)`, which joins the live listing with the declaration. The
  route and the tests call the same builder.

The module lives in `src/mcp/`, not in `src/mcp/tools/`, because `tools/index.ts` is an append-only file shared by
parallel tasks and the tool directory is where peer work happens.

The inventory's record text stays in `docs/`. The cockpit page shows the record id, its status and its short outcome
label; the label is copied into the declaration and a test asserts it equals the inventory row's "Required MCP
equivalent (outcome)" cell, so the page works in a published install that has no `docs/` directory.

#### 10.3 The checks

All run in `npm test`. The inventory is read with the same row pattern `acceptance-parity.test.ts` uses
(`readInventory`, lines 1770-1777); the registry is read by importing it.

| Check | Fails when |
| --- | --- |
| C1 (CT-02) | A `covered` record has no row, or its row names a tool or action the live registry does not have. |
| C2 (CT-03) | A live action that performs or reads has neither a row nor a justification. |
| C3 (CT-04) | A refusal-only action has no row pointing at a `global` record. |
| C4 (CT-05) | A row names a `presentation` record. |
| C5 | A row or justification names an inventory id that does not exist, or a tool or action that does not exist. |
| C6 (CT-06) | Reported, never green: a record declared `unserved` with a reason runs as a vitest `todo` and is listed in the reference, exactly as `blocked(...)` does in the parity suite. |
| C7 (CT-07) | The generated coverage table in `mcp-api.md` differs from the re-rendered one. |

A stronger cross-check was considered: every row must also be exercised by a parity case that calls that tool. It is
**not** required now, because a case's tool calls are in its code, and reading them means parsing source text (the
thing 8.1 rejects). If the parity registry later records the tools a case calls as data, the check becomes cheap.

#### 10.4 What the reference must show about results

Measured from what goes on the wire at the baseline, not from helper types:

| Tool | Field that carries the outcome | Words | A refusal is | `structuredContent` |
| --- | --- | --- | --- | --- |
| `health` | `status` | `running`, `not-running`, `refused`, `unreachable`, `timeout`, `version-mismatch`, `aborted`, `not-registered`, `unsupported` | error result | yes |
| `task_create` | `status` + `accepted` | `accepted`, `running`, `done`, `failed`, `cancelled`, `conflict` | 409: ordinary `conflict`; other: error | yes |
| `execution_control` | `status` + `accepted` + `delivery` | `accepted`, `done`, `cancelled`, `conflict`, `failed` | `failed`: error; `conflict`: ordinary | yes |
| `organise_work` | `status` | `done`, `conflict` (+ stale-version payload) | 409: ordinary; other: error text | no |
| `handoff_git` | `status` + `refusedBy` + `blocker` | `done`, `failed`, `conflict`; `refusedBy`: `policy`, `service`, `quality`, `forge` | **ordinary** result, even when `failed` | no, by design |
| `local_handoff` | `status` + `outcome` | `done`, `failed`, `conflict`; outcome `opened`, `listed`, `unavailable`, `fallback`, `refused` | per `status` | yes |
| `project_config` | none on success; `status` is an **HTTP number** on failure; `refused` + `boundary` | – | error result | yes |
| `read_results_evidence` | `evidence`; `status` is an **HTTP number** | `available`, `unavailable`, `stale` | error for bad arguments; `unavailable` is ordinary | no |
| `task_read` | none | – | error text | no |
| `leader_events` | `status` | `ok`, `gap` | error result | yes |
| `discover_project` | per action `status` | `available`, `unavailable`, `read-only` | – (prose text, structured discovery) | yes |

Every tool can also answer the bridge's own transport outcomes (`not-running`, `refused`, `unreachable`, `timeout`,
`version-mismatch`, `aborted`) as an error result when the cockpit cannot be reached (`bridge.ts:241-292`); the `health`
row lists them because `health` is how a client asks.

Four facts a reader needs, and the reference must state:

- The word `status` means three different things: a lifecycle word, an HTTP status number, and an action's availability.
- `failed` is an error result in `execution_control` and an ordinary result in `handoff_git`.
- D-05 § 6.8 already decided a closed set, `accepted | running | done | failed | cancelled | conflict | uncertain`. No
  tool emits `uncertain` (grep of `packages/xezar/src/mcp/tools/`), and four tools do not use the set at all.
- Four tools have a zod result schema today: `execution_control`, `local_handoff`, `read_results_evidence` (its
  envelope) and `discover_project` (`packages/contract/src/mcp-discovery.ts`). For the others the result declaration
  in 10.2 is **declared, not derived**, and the reference must label it that way. Whether to unify is
  [open question 1](#open-questions-for-the-owner).

A related finding for the reference: `handoff_git` states no `readOnlyHint` at all (measured from the live listing), so
a client applies the MCP default. The page shows "not stated (client default)" (RF-02); it does not invent a value.

### 11. The read-only route

**Path.** `GET /api/v1/mcp/reference`, and through the `v1` chain also `GET /api/v1/p/:projectId/mcp/reference`.

**Why project-scoped when the data is the same for every project.** The page lives under project Settings, next to
"MCP connection", and every cockpit view lives under `/p/:projectId/`. Mounting it with the project family keeps the
cockpit's one scoping rule, costs nothing (`route-parity.test.ts` then asserts the three spellings answer identically,
which they will), and leaves room for a later per-project fact without a new route. The rejected alternative, a
workspace-level single mount, would be the only MCP page whose data comes from outside its own scope.

**Shape.** `mcpApiReferenceSchema` in `packages/contract/src/mcp-api-reference.ts`, a discriminated union on `available`:

```text
{ available: true,
  xezarVersion, protocolVersions: string[], capabilities: { tools: { listChanged: false } }, instructions,
  tools: [{ name, title?, description, inputSchema: <JSON Schema object>, annotations?,
            actions: [{ discriminator: 'action'|'view'|'read'|null, value: string|null,
                        disposition: 'performs'|'reads'|'refuses',
                        records: string[], justification?: { serves: string[], reason: string },
                        requiresExpectedVersion: boolean, acceptsOperationId: boolean }],
            result: { field: string|null, words: string[], refusalIsError: 'always'|'never'|'depends',
                      declared: boolean } }],
  coverage: [{ record, status: 'covered'|'global', outcome, tool, action }],
  unserved: [{ record, reason }],
  origins: { journal: ['human','leader','system'], audit: ['ui','mcp','automation','cli'] } }
| { available: false, reason: string }
```

`inputSchema` is typed as an opaque JSON object in the contract: it is JSON Schema, and describing JSON Schema in zod
would be a second definition that can drift. Optional keys are spread conditionally, and literal discriminants use
`as const`, the two mismatches AGENTS.md names.

**The handler.** It loads `./mcp/tools/index.ts`, `HEALTH_TOOL` and the declaration with a dynamic `import()`, calls
`buildMcpApiReference`, and caches the result for the life of the process (the list is fixed: `listChanged: false`).
Any failure answers `200 { available: false, reason }` and logs one warning – never a 500, never a crash. The client
fetches it once per cockpit version with no polling and no WebSocket topic, because the data cannot change while the
process runs.

**Why it must answer when the MCP service did not start.** Three reasons, in order of weight:

1. **The listing does not depend on the service.** It is static code. The bridge itself answers `tools/list` without
   touching the service, on purpose (`bridge.ts:30-33`, N-07). A route that needed the service would invent a
   dependency the protocol does not have.
2. **The page is most needed when MCP is broken.** A person diagnosing a failed MCP start (`startMcpSocket` logs "MCP
   bridge unavailable … the cockpit works without it") needs to see what the server would expose. Tying the page to the
   service would hide it in exactly that case.
3. **N-07 in reverse.** The rule is that MCP must never break the cockpit. A route that throws when MCP is absent would
   make an MCP problem a cockpit problem. The lazy import keeps the cockpit's static import graph free of the tool
   registry, as `startMcpSocket` already does for the service.

**Hosted mode.** The route answers in hosted mode too. It is a read with no secret, no path and no project data, so the
local-machine 409 that guards mutators does not apply.

**Registration.** One `mcpReferenceRoutes` chained family, validated as middleware if it ever takes a query (it takes
none today), chained into `v1`, reaching `AppType`. `typed-bodies.test.ts`, `route-parity.test.ts`,
`bc-route-inventory.test.ts` and a contract-parity assertion cover it.

### 12. The cockpit view

#### 12.1 Where it lives

A new **project** Settings entry, `mcp-api`, titled "MCP API", placed directly after "MCP connection" in
`packages/web/src/routes/settings/registry.tsx`. The "MCP connection" section gets one link to it ("See every tool this
server exposes"). Placement is [open question 4](#open-questions-for-the-owner).

#### 12.2 Information architecture

Top to bottom:

1. **Header.** "xezar MCP server", the running version, the supported protocol revisions, and one sentence: "This page
   describes the tools a leader can call. Nothing on it runs a tool."
2. **What this server does not expose.** Resources, prompts, logging, account identity, secrets, other projects,
   host processes – each with its requirement id (RF-08).
3. **Tools.** One disclosure per tool, in registry order, `health` first. The collapsed row shows: name, title, the
   effect label (12.3), and the number of actions.
4. **Expanded tool.** Purpose (its own description, verbatim); the four hints as words; an **actions** table (action,
   effect, records it serves or its justification, whether it needs `expectedVersion` or accepts `operationId`); an
   **arguments** table (name, type, required, allowed values, description verbatim); the **result** block (field,
   words, how a refusal arrives, and "declared, not derived" where true); and a closed "JSON Schema" disclosure showing
   the raw `inputSchema`.
5. **Coverage.** The record → tool action table with a filter by inventory status and a count of covered and not-served
   records. Never-served entries sit at the top, labelled "Not served", with their reason.
6. **Results and origins.** The shared envelope, the comparison table of 10.4, and the two `origin` vocabularies side by
   side.

#### 12.3 Collapsed and expanded state

- Every tool starts collapsed. A button with `aria-expanded` and `aria-controls` toggles it. "Expand all" and "Collapse
  all" sit above the list.
- A URL fragment `#tool-<name>` opens that tool expanded and moves focus to its heading, so a reviewer can link a
  colleague to one tool.
- Expansion state is presentation: not stored, not sent to the server.

#### 12.4 Read-only versus mutating

Two layers, both in text:

- **Tool level**, from annotations: `readOnlyHint: true` reads "Read-only"; otherwise "Changes project state", and
  `destructiveHint: true` adds "Can delete or overwrite". An omitted hint reads "not stated (client default)".
- **Action level**, from the declaration: "Reads", "Changes", or "Refused – <boundary>". This matters because tools mix:
  `project_config` has `get_config` and `set_config`, and `handoff_git` has `repo` and `merge`. A check keeps the two
  layers honest: an action of a `readOnlyHint: true` tool may not be declared "Changes", and an action whose schema needs
  `expectedVersion` or `operationId` may not be declared "Reads".

An icon may accompany a label; it never replaces it.

#### 12.5 Accessibility and narrow screens

The bar is the one #114 set and PR #255 met, applied to this page:

- Headings in order (page, section, tool). Tables use `<th scope>` and a caption.
- Every control labelled and reachable by keyboard; `:focus-visible` gives the existing visible ring.
- Effect, status and "Not served" conveyed in words; colour only reinforces.
- The coverage filter announces the new count through a polite live region.
- Theme tokens only, light and dark; no hard-coded colour, no inline style (the structural test in
  `mcp-a11y.test.tsx` is the model).
- At 375 px: no sideways scroll; `pre` blocks use `whitespace-pre-wrap` and `break-all`; tables reflow into stacked
  label–value lists below `md`; the settings drill-in and phone pill navigation are used; the bottom safe area is kept
  clear. Verified in a real browser at 375 px, as #114's QA was.

### 13. The hard boundary: no "Try it"

**Decision.** The cockpit page has no control that runs a tool, in any form (CV-06). This is not a missing feature; it
is a boundary.

**Why.** A Swagger page's "Try it" sends a request as the reader. On this server, *who* sends a request is the whole
security model:

1. **Single ownership.** Exactly one logical MCP client may own a project (F-18). A second owner is rejected with a
   project-occupied error (A-17), and the built-in leader and a native client obey the same rule (A-23). A "Try it" that
   calls a tool through MCP must either take the ownership lease from the real leader, or act beside it as a second
   owner. The first breaks the leader's session mid-work; the second is exactly what F-18 and A-17 forbid.
2. **Session binding.** A session is bound to one project from a trusted source and fenced by an owner generation
   (D-02, F-01). The cockpit is not a bound session; to call a tool it would need to mint or borrow one.
3. **Server-derived audit origin.** The audit origin is stamped from the door the call came through, never from the
   call, so that a caller cannot claim to be someone else (D-06 § 10.4; `audit-trail.ts:23-35`). A human pressing "Try
   it" would produce an `mcp`-origin audit entry and a `leader`-origin journal event for an act the leader did not take.
   That is the forgery the design exists to prevent, performed by the product itself.
4. **Nothing is gained.** Every project action a tool performs already has its cockpit control – that is what the
   inventory and the parity suite prove. A human who wants the effect uses the cockpit's own door, which is correctly
   recorded as `ui`.

**Rejected alternatives.**

| Alternative | Why it is rejected |
| --- | --- |
| "Try it" through MCP as the leader | Breaks 1, 2 and 3 above. |
| "Try it" that calls the cockpit's own HTTP routes instead | It is not a tool call at all: it skips the MCP-only guards (required `expectedVersion`, operation receipts, the owner fence), so a success would be false evidence about the MCP API while looking like it. |
| "Try it" for read-only tools only | Reads through MCP also go through the owner session, so 1 and 2 still apply; the cockpit already shows the same data; and a read-only exception is the first step of a boundary that erodes. |
| A request builder that only prepares JSON for the user to paste elsewhere | It invites a human to hand-author leader calls, which D-04 and F-15 steer away from, and it is a "Try it" one paste away. |

A future owner who wants a human to exercise tools needs a separate feature designed around ownership handover, not a
button on a reference page.

### 14. What this feature does not do

- It does not run, simulate, preview or prepare a tool call.
- It does not change any tool, schema, name, description, annotation, result shape or route that exists today.
- It does not unify the result vocabularies (open question 1).
- It does not add MCP resources, prompts, logging, `outputSchema` or any protocol feature.
- It does not change the inventory's records or statuses, or the parity suite's cases.
- It does not publish the reference outside the repository and the running cockpit: no website, no npm-published JSON.
- It does not add a setting, an environment variable, a port, a dependency or a WebSocket topic.
- It does not document the cockpit's HTTP API; `BACKWARD_COMPATIBILITY.md` § 2 remains that inventory.

### 15. Verification plan

| Requirement | Evidence | Kind |
| --- | --- | --- |
| AR-01–AR-05, DR-01 | `mcp-api-doc.test.ts`: artifact equals the live listing byte for byte; a scan finds no absolute path, e-mail, environment value or project name. | unit, `npm test` |
| RF-01–RF-08, DR-02 | Same test: each marker block equals its re-rendered table. | unit |
| CT-01–CT-07, DR-03 | Checks C1–C7 of 10.3. | unit |
| DR-04 | Route body `tools` deep-equals a `runBridge` in-process `tools/list` and the committed artifact. | unit |
| DR-06 | Pull request records a scratch description change turning DR-01 red, and a scratch unmapped action turning C2 red. | recorded proof |
| NF-02, CV-07 | Route test with the registry import made to fail: answers `200 {available:false}`; the rest of the app still answers `/api/v1/health`. | unit |
| NF-05, NF-06 | contract-parity assertion (both directions), `typed-bodies.test.ts`, `route-parity.test.ts`, `bc-route-inventory.test.ts`. | typecheck + unit |
| CV-01–CV-05, DR-05 | Cockpit tests render from a fixture with an invented tool; collapsed by default; fragment opens a tool; labels present; filter announces. | cockpit unit |
| CV-06 | Cockpit test: the page contains no `button`, `form` or link whose label or target suggests execution, and no `fetch` other than the reference query. | cockpit unit |
| NF-07 | Structural accessibility test modelled on `mcp-a11y.test.tsx`. | cockpit unit |
| NF-08 | Real-browser walkthrough at 375 px, light and dark, keyboard only, recorded on the pull request (`needs-qa`). | manual QA |

The cockpit half carries `needs-qa` under SDLC.md's QA gate. This specification itself is documentation only.

### 16. Risks

| Risk | Mitigation |
| --- | --- |
| The result declaration (10.2) is hand-written for the tools without a result schema and can be wrong while every check is green. | Label it "declared, not derived" on the page; open question 1 removes the gap if unification is chosen. |
| The drift tests make every tool change touch two more files. | That is the intent. DR-07 keeps the fix to one regenerate command. |
| A new action added by a parallel task (for example #262's `handoff_git ready`) fails C2 on whichever branch merges second. | Expected, and the right failure. Part 4 names it so it is not a surprise. |
| The page is 53 KB of schema and could feel heavy. | Collapsed by default; raw schema inside a closed disclosure; fetched once. |

## Part 3 – Decisions

Each decision: the choice, the reason, and the alternative rejected. Ids are local to this document.

| ID | Decision | Reason | Rejected alternative |
| --- | --- | --- | --- |
| R-01 | Generated tables between comment markers, checked by exact string equality in `npm test`. | The repository's proven doc-versus-code mechanism (`acceptance-parity.test.ts`). | Hand-maintained doc; snapshots; CI-only script (8.2). |
| R-02 | Every generated value comes from the live registry through `toolListing()`. | The `bc-route-inventory` lesson: a source-text reader silently stops seeing things. | Parsing tool source files. |
| R-03 | Coverage is checked both ways, records to actions and actions to records. | The `contract-parity` lesson: one-way checks pass on real drift. | Only checking that covered records map somewhere. |
| R-04 | The declaration is a shipped module, not a `.testkit.ts`. | The cockpit route needs it at runtime, and `tsconfig.json:30` excludes `*.testkit.ts` from the build. | A test-only mapping (what the sibling task started with). |
| R-05 | Actions that serve a requirement rather than a UI record carry a visible justification with a requirement id. | `health` exists for N-07 – so a client can learn the service is down – not for a cockpit control; forcing a record would be false. Whether any other action lacks a record is found by check C2, not assumed here. | Exempting them silently; inventing records. |
| R-06 | The route derives from running code and answers even when the MCP service did not start. | Section 11: the listing is static, the page is most needed when MCP is broken, and N-07. | Serving committed `docs/` files; requiring the service. |
| R-07 | The route is project-scoped and mounted at both spellings. | One scoping rule for every cockpit view; route-parity covers it for free. | A workspace-level single mount. |
| R-08 | Annotations the tool omits are shown as "not stated (client default)". | The reference describes, it does not correct. | Showing the MCP default as if the tool had stated it. |
| R-09 | No "Try it", in any form. | Section 13. | Four variants, all in 13. |
| R-10 | Result vocabularies are documented as they are, and their disagreement is stated. | The work documents; it must not change what it documents (brief rule). Whether to unify is the owner's call. | Quietly normalising words on the page, which would describe a server that does not exist. |
| R-11 | The paths of the generated documents follow the in-flight #261 brief. | Avoid two tasks writing the same files differently. | A new `docs/features/mcp-api-reference/` home for the artifacts. |

## Part 4 – Current state, honestly

Observed on 2026-09-11 around 08:10 UTC (`gh pr list -R qodeca/xezar --state open`, `gh issue list -R qodeca/xezar
--label release-0.14.0 --state open`, the primary checkout's run index, read-only).

### What exists

- The full MCP server is merged on `main`: the bridge and handshake (#86), binding and ownership (#87, #99), all ten
  registry tools (#90–#98, #251), stale-write rejection with `expectedVersion` (#250, PR #258), the event journal,
  catalog, reconnect and live UI sync (#103–#107), the three client reaction adapters (#108–#110), the service
  composed into `serve` (#243, PR #247), and the MCP settings surface including #114's accessibility pass (PR #255).
- The acceptance suites: isolation (PR #242), parity and collaboration A-05–A-11 with the published coverage map
  (#116, PRs #248, #257), durability A-13–A-16, A-21, A-22 (#117, PR #253), real clients A-01, A-17–A-20, A-23 (#118,
  PR #259).
- **No open pull request** at the time of observation.
- Open `release-0.14.0` issues: #262, #261, #119 (close the Definition of Done on one candidate revision), #117, #75,
  #74, #73, #71, #67.

### What is being built right now

| Task | Issue | What it is doing | Observed state |
| --- | --- | --- | --- |
| `36587b7b` (docs-maintenance) | #261 | The generated reference: `mcp-api.json`, `mcp-api.md`, the drift test and the coverage mapping; also the stale "not implemented" line and an `AGENTS.md` pointer. | Started 07:54 UTC. Two untracked files so far: `packages/xezar/src/mcp/mcp-api-doc.test.ts` and `packages/xezar/src/mcp/tools/api-coverage.testkit.ts`. No commit, no branch on the remote. |
| `b9b4feb6` (feature-implementation) | #262 | Four leader gaps: `handoff_git` can mark a draft PR ready; check whether a task's base branch is reachable; refuse a `save_workflow` overwrite that drops a check step; write D-04's connection file. | Started 07:54 UTC. Uncommitted edits in `handoff-git.ts`, `project-config.ts`, `server.ts`, `BACKWARD_COMPATIBILITY.md` and a new `connection-file.ts`. |
| `4a46f0d5` (testing) | #117 | Executing the test gate checks for the durability suite. | Branch `xez/4a46f0d5` carries the suite commits already merged via PR #253 plus merges of `main`. |

### What this specification changes about that work

1. **The mapping must ship.** The #261 task placed its mapping in `tools/api-coverage.testkit.ts`. A `.testkit.ts` file
   is excluded from the build (`packages/xezar/tsconfig.json:30`), so the cockpit route (section 11) could not read it.
   Under R-04 the declaration moves to a shipped module, `packages/xezar/src/mcp/api-reference.ts`. If #261 merges first
   with the testkit, the cockpit work moves the file; the checks stay the same.
2. **Refusal-only actions need their own rule.** `project_config` accepts 20 action names only to refuse them (10.1).
   A both-ways check that ignores them would either fail on all 20 or silently skip them. CT-04 maps them to `global`
   records.
3. **Protocol-plumbing actions need justifications.** `health` serves N-07, not a cockpit control, and C2 will find any
   other action without a record. R-05 gives such actions visible justification rows rather than an exemption.
4. **#262's new action will trip the check.** `handoff_git ready` adds a tool action. The inventory has no record for
   marking a pull request ready, and in the cockpit's API client no mark-ready call was found (files examined:
   `packages/web/src/api/client.ts`). Whichever of #261 and #262 merges second must add either an inventory record or a
   justification; the check will say so. Which of the two is right is [open question 3](#open-questions-for-the-owner).
5. **The results table in #261 should follow 10.4, not the brief's finding 5.** Three of that finding's examples are
   internal helper types that never reach the leader (see the findings table). A reference built from them would
   document plumbing, not the API.
6. **The count is 10 tools, not 8.** The #261 brief repeats the 8; its issue body already says 10.

## Open questions for the owner

These are decisions a person should make, not an agent. Each has a recommendation and what each choice costs.

**1. Result vocabularies: document as they are in 0.14.0, or unify them?**
Today ten tools report outcomes in at least six ways (10.4). D-05 § 6.8 already chose a closed set, `accepted | running
| done | failed | cancelled | conflict | uncertain`, and most tools do not follow it.

- *Document as-is in 0.14.0 (recommended).* The reference shows the disagreement plainly, and a one-line rule is added
  for new tools: use the D-05 set. Unification is filed for 0.15.0 as its own change. **Cost:** leaders keep reading
  each tool's own shape for one more release; the result declaration stays "declared, not derived" for the tools without a result schema.
- *Unify before 0.14.0.* One result schema in `packages/contract`, every tool answering it, optionally published as MCP
  `outputSchema`. **Cost:** changes the result shape of every tool that leaders already read; about 270 lines across 25 MCP test files match today's result words (an upper bound, since the journal and
  receipts reuse some of the same words – the true number is unknown until measured); invalidates the acceptance
  evidence #119 is collecting on one candidate revision, which would have to be re-run; and it is a break for any saved
  leader prompt. By estimate, not measurement, it would delay 0.14.0 by at least one full acceptance cycle.

**2. Should the MCP tool surface become a protected surface in `BACKWARD_COMPATIBILITY.md`?**
Today that file protects the cockpit's HTTP API, CLI, state files and more, but not MCP tool names, arguments or results
(one mention, the #250 stale-write guard).

- *Yes, as a new section with `mcp-api.json` as its inventory (recommended).* **Cost:** every tool change needs a
  compatibility note and a reviewer's judgement on whether it is a break. **Benefit:** a leader prompt that works today
  is not broken silently tomorrow, and the committed JSON makes breaks visible in the diff.
- *No, keep it free to change until the first external users.* **Cost:** none now; the risk moves to users of saved
  leader prompts and client configurations.

**3. A tool action that the cockpit does not have (like #262's "mark ready"): amend the closed inventory, or allow a
justification row?**

- *Amend the inventory with a new record and a decision entry, as D-102 did for automation delete and retry
  (recommended for business actions).* **Cost:** the inventory's pinned counts move (140 → 141 records, 89 → 90
  covered, `acceptance-parity.test.ts:1812-1816`), and the new record needs a parity case. **Benefit:** the inventory
  stays the single measure of coverage, as DoD clause 1 requires.
- *Allow a justification row naming a requirement (for example F-11).* **Cost:** a second, weaker path to "justified"
  that future business actions could also take. Recommended only for protocol plumbing (R-05).

**4. Where should the browsable page live?**

- *A project Settings section "MCP API", next to "MCP connection" (recommended).* **Cost:** one more Settings entry;
  reuses the drill-in and accessibility patterns #114 already proved.
- *A top-level cockpit page.* **Cost:** a navigation slot for an audience of reviewers, and a new layout to make
  accessible at 375 px from scratch.

**5. Should the cockpit page ship in 0.14.0, or follow it?**
The machine artifact, generated reference and traceability (#261) are already in flight for 0.14.0. The page adds a
route, a contract schema, a Settings section and a manual QA pass.

- *Ship the documents in 0.14.0 and the page in the next minor (recommended).* **Cost:** for one release the human view
  is the Markdown page on GitHub, not the cockpit. **Benefit:** 0.14.0's remaining work stays on closing the Definition
  of Done (#119) on one candidate revision.
- *Ship both in 0.14.0.* **Cost:** one more `needs-qa` cockpit change inside the release, and the #119 acceptance run
  must include it; roughly one implementation task plus QA.
