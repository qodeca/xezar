# MCP API reference – requirements and technical solution

Status: **specification for owner review; nothing here is implemented by this document**. Date: 2026-09-11.
Audience: the project owner first, then the engineers who build it.

Tracked by [#263](https://github.com/qodeca/xezar/issues/263). Related: [#261](https://github.com/qodeca/xezar/issues/261)
(the generated reference, in flight), [#262](https://github.com/qodeca/xezar/issues/262) (four leader gaps, in flight),
[epic #67](https://github.com/qodeca/xezar/issues/67).

**Baseline revision:** `ef4b7683ebbbcd17c1ede26b7fd4f870546e7e74` (`main`, 2026-09-11). Every file, symbol and count
below was read or measured at that revision. Counts move when tools change; re-derive them before relying on one.

**Amended** on 2026-09-11 by [#274](https://github.com/qodeca/xezar/issues/274): prior-art research (Part 5), a UX
design (Part 6) and what the research changes (Part 7). The amendment's measurements were taken at
`6f699bf` (`main`), whose tool surface is the same as the baseline's. Entries it changes are marked "(amended, #274)".

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

The amendment adds three things. **Prior art** (Part 5): the MCP Inspector is a debugging tool, not a reviewing tool;
the MCP ecosystem has **no** convention for publishing a server's tools as a document; and the OpenAPI renderers get
"read or write" for free from HTTP methods, which MCP does not have. **A UX design** (Part 6): who the page is for (the
reviewer), what they must learn in thirty seconds, how the effect of every tool shows without opening it, how refusals
are gathered in one place, and how the missing "Try it" reads as a decision. **What changed** (Part 7): most decisions
are confirmed; four details change, and none of the five questions below changes.

Five questions need your decision. They are at the end, under [Open questions for the owner](#open-questions-for-the-owner),
each with a recommendation and what each choice costs.

## Contents

- [The seven findings, checked](#the-seven-findings-checked)
- [Part 1 – Requirements](#part-1--requirements)
- [Part 2 – Technical solution](#part-2--technical-solution)
- [Part 3 – Decisions](#part-3--decisions)
- [Part 4 – Current state, honestly](#part-4--current-state-honestly)
- [Part 5 – Prior art](#part-5--prior-art)
- [Part 6 – UX design](#part-6--ux-design)
- [Part 7 – What the research changes](#part-7--what-the-research-changes)
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
| RF-02 | One generated row per tool MUST give: name, title, one-line purpose, the four annotation hints as words, whether any action requires `expectedVersion`, and whether any action accepts `operationId`. An annotation the tool omits MUST read as "not stated", followed by the default the protocol tells a client to assume (S7 in 17.8), never as the tool's own value. A destructive or idempotent hint omitted by a read-only tool MUST read as "not applicable (read-only)", because the protocol gives it no meaning there. (amended, #274) | J-1 |
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
| CV-08 | Before anything is expanded, a summary directly under the header MUST state: the number of tools; how many change project state and how many of those state they may be destructive; how many are read-only; the number of always-refused actions, linked to the refusals section; and the number of covered records served, naming every record not served. Every number MUST be computed from the route. See [18.2](#182-the-first-thirty-seconds). (added, #274) | J-1–J-3 |
| CV-09 | Every collapsed tool row MUST show the tool's effect in words ("Read-only", "Changes project state", "Destructive", or "Read-only: not stated" with the assumed default) and its action counts by disposition. An effect filter (All, Changes project state, Read-only) MUST announce the new count. See [18.3](#183-scanning-eleven-tools-and-seeing-what-changes-things). (added, #274) | J-1, U-M08 |
| CV-10 | Text inside a collapsed tool – action names, argument names, descriptions – MUST be reachable with the browser's find-in-page, and a match MUST open that tool. (added, #274) | J-1 |
| CV-11 | The expanded tool MUST show its actions table before its arguments; list required arguments before optional ones; name types in words; show an enum of more than 10 values as its first 10 plus a control that reveals the rest; show the discriminator argument by reference to the actions table, not as a repeated enum; and show nesting beyond one level as path-prefixed rows, not as a third level of disclosure. See [18.4](#184-reading-a-schema-without-drowning). (added, #274) | J-1 |
| CV-12 | One section MUST gather everything the server will not do, in three groups: never exposed, always refused (refusal-only actions and refused arguments, each with its boundary) and refused at call time (each saying whether it arrives as an error or an ordinary result, and labelled "declared, not derived" where true). Each expanded tool MUST show its own items from that section. A refused argument MUST NOT be shown as an optional input. See [18.5](#185-the-refusals-what-will-this-not-let-me-do). (added, #274) | J-3, J-4 |
| CV-13 | The header MUST say in one sentence that the page is read-only by design and why. Each expanded tool MUST end with its cockpit equivalents ("Do this in the cockpit") from the coverage rows, or the justification where there is none. The page MUST NOT render a disabled or locked run control. See [18.6](#186-the-absent-try-it-deliberate-not-unfinished). (added, #274) | CV-06; F-18 |
| CV-14 | The page MUST handle each state in [18.7](#187-failure-and-empty-states) with the text given there: loading, unavailable, MCP service not running, hosted mode, no tools besides `health`, a tool with no arguments, a schema it cannot lay out, an empty filter, and no unserved records. A schema it cannot lay out MUST affect only its own tool. (added, #274) | N-07, NF-02 |

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
| Machine-readable reference (AR-01) | `docs/features/mcp-server/mcp-api.json` | Yes, checked by DR-01 | #261 (merged in #268) |
| Human-readable reference (RF-01) | `docs/features/mcp-server/mcp-api.md` | Prose by hand, tables generated, checked by DR-02 | #261 (merged in #268) |
| Coverage and result declaration (CT-01) | `packages/xezar/src/mcp/api-reference.ts` – **a shipped module, not a `.testkit.ts`** | No – declared data plus one builder function | Implementation issue to be filed |
| Drift tests | `packages/xezar/src/mcp/mcp-api-doc.test.ts` | – | #261 (merged in #268) |
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
                        boundary?: string,
                        records: string[], justification?: { serves: string[], reason: string },
                        requiresExpectedVersion: boolean, acceptsOperationId: boolean }],
            refusedArguments: [{ name: string, boundary: string }],
            result: { field: string|null, words: string[], refusalIsError: 'always'|'never'|'depends',
                      declared: boolean } }],
  coverage: [{ record, status: 'covered'|'global', outcome, tool, action }],
  unserved: [{ record, reason }],
  notExposed: [{ what: string, forbiddenBy: string[] }],
  origins: { journal: ['human','leader','system'], audit: ['ui','mcp','automation','cli'] } }
| { available: false, reason: string }
```

(amended, #274) `boundary` is present exactly when `disposition` is `refuses`; it is the one-line reason the page prints
as "Refused – <boundary>" (12.4). `refusedArguments` comes from the declaration, because the listing cannot express it:
`project_config`'s `projectId` is listed with an empty schema, which accepts anything, and only its description says it
is never accepted (18.4). `notExposed` carries J-4's list as data, so the page hard-codes none of it (CV-02).

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

Top to bottom (amended, #274 – the summary is new, and "not exposed" moved into the refusals section; the reasons are in
[18.2](#182-the-first-thirty-seconds) and [18.5](#185-the-refusals-what-will-this-not-let-me-do)):

1. **Header.** "xezar MCP server", the running version, the supported protocol revisions, and one sentence that the page
   is read-only by design and why (18.6), with a "Why?" disclosure.
2. **Summary.** The five statements of 18.2 (CV-08).
3. **Tools.** One disclosure per tool, in registry order, `health` first, with the effect filter above it. The collapsed
   row shows: name, title, the effect label (12.4) and the action counts by disposition (CV-09).
4. **Expanded tool.** Purpose (its own description, verbatim); the four hints as words; an **actions** table (action,
   effect, cockpit equivalent or justification, whether it needs `expectedVersion` or accepts `operationId`); an
   **arguments** table laid out as 18.4 describes; the tool's own refusals (CV-12); the **result** block (field, words,
   how a refusal arrives, and "declared, not derived" where true); "Do this in the cockpit" (CV-13); and a closed "JSON
   Schema" disclosure showing the raw `inputSchema`.
5. **What this server will not do.** The three groups of 18.5, including what it does not expose (RF-08).
6. **Coverage.** The record → tool action table with a filter by inventory status and a count of covered and not-served
   records. Never-served entries sit at the top, labelled "Not served", with their reason.
7. **Results and origins.** The shared envelope, the comparison table of 10.4, and the two `origin` vocabularies side by
   side.

#### 12.3 Collapsed and expanded state

- Every tool starts collapsed. Each tool is a native `<details>` element with a `<summary>` row (amended, #274; R-13).
  It keeps the disclosure semantics and keyboard behaviour, and the browser opens it by itself when find-in-page matches
  text inside it (CV-10; 17.6). A script-driven collapsible that removes its content from the page would lose that. "Expand
  all" and "Collapse all" sit above the list and set `open`.
- A URL fragment `#tool-<name>` opens that tool expanded and moves focus to its heading, so a reviewer can link a
  colleague to one tool.
- Expansion state is presentation: not stored, not sent to the server.

#### 12.4 Read-only versus mutating

Two layers, both in text:

- **Tool level**, from annotations: `readOnlyHint: true` reads "Read-only"; otherwise "Changes project state", and
  `destructiveHint: true` (or not stated) adds "Destructive – may delete or overwrite". An omitted hint reads "not
  stated" plus the default a client assumes. The words are the MCP Inspector's (amended, #274; R-12). The full table is
  in [18.3](#183-scanning-eleven-tools-and-seeing-what-changes-things).
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
- It does not build a search box, a version-diff view, a samples panel, client setup snippets, links from an action to a
  cockpit screen, a call history, a download button or reviewer comments. The reasons are in
  [18.8](#188-what-we-will-not-build-and-why). (amended, #274)

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
| CV-08, CV-09 | From a fixture with known hints: the summary's numbers equal the fixture's; each row shows its effect word and counts; a tool with no `readOnlyHint` reads "Read-only: not stated"; a read-only tool shows no destructive flag; the filter announces the new count. | cockpit unit |
| CV-10 | Structural: each tool is a `details` element whose content stays in the page while collapsed. The find-in-page opening itself is browser behaviour and is checked in the 375 px walkthrough. | cockpit unit + manual QA |
| CV-11 | Fixture with a 17-value enum, a discriminator, required and optional arguments and three-level nesting: order, "Show all 17", discriminator by reference, path-prefixed third level. | cockpit unit |
| CV-12, CV-13 | Fixture with a refusal-only action and a refused argument: both appear in the refusals section and in their tool; the refused argument is not in the optional inputs; each tool ends with "Do this in the cockpit"; no disabled run control exists. | cockpit unit |
| CV-14 | One case per state in 18.7, including a tool whose schema throws while rendering, with every other tool still present. | cockpit unit |
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
| R-08 | Annotations the tool omits are shown as "not stated", followed by the default the protocol tells a client to assume. A destructive or idempotent hint on a read-only tool reads "not applicable". (amended, #274) | The reference describes, it does not correct. The defaults are documented (S7), so naming them is describing, not guessing, and it tells a reviewer what clients will actually do. | Showing the MCP default as if the tool had stated it; showing only "client default" without saying what that is. |
| R-09 | No "Try it", in any form. | Section 13. | Four variants, all in 13. |
| R-10 | Result vocabularies are documented as they are, and their disagreement is stated. | The work documents; it must not change what it documents (brief rule). Whether to unify is the owner's call. | Quietly normalising words on the page, which would describe a server that does not exist. |
| R-11 | The paths of the generated documents follow the in-flight #261 brief. | Avoid two tasks writing the same files differently. | A new `docs/features/mcp-api-reference/` home for the artifacts. |
| R-12 | The effect words are the MCP Inspector's: read-only, destructive, idempotent, open-world (added, #274). | They are what people who browse MCP servers already know (17.2). | New words of our own ("Can delete or overwrite" as the label). |
| R-13 | Each tool is a native `<details>` element (added, #274). | Find-in-page opens it in current Chrome, Firefox and Safari (S20), so a reviewer can search argument names across collapsed tools. | A script-driven collapsible, which hides its content from find-in-page. |
| R-14 | At most two disclosure levels below the page: a tool, then a nested object. Deeper fields are path-prefixed rows (added, #274). | More than two levels usually hurts (S18); real schemas nest three deep (18.4). | A disclosure per nesting level. |
| R-15 | No search box (added, #274). | Eleven tools fit on one screen; the effect filter, find-in-page and links cover the need (18.3). | A search box like the Inspector's or Swagger UI's tag filter, which serve much larger surfaces. |
| R-16 | In place of "Try it": a one-line reason in the header and a "Do this in the cockpit" list in each tool; no disabled control (added, #274). | No renderer explains its missing console (17.5); a disabled control misstates the reason; the cockpit door is the correctly audited one (13). | Silence; a disabled button; a link to documentation only. |

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

## Part 5 – Prior art

Added by [#274](https://github.com/qodeca/xezar/issues/274). Parts 1 to 4 reasoned from this repository outward. This part
looks at how the same problem is already solved elsewhere, so the page feels familiar where familiarity helps and differs
only where this server's rules force it to.

### 17. How other tools solve this

#### 17.1 Method and limits

- **Web access was available and used.** Every claim below carries its source and the date it was read. All sources were
  read on **2026-09-11**. The table in 17.8 lists them.
- Where a page summary could be wrong, the claim was re-checked against the raw source text. One summary was wrong: it
  said the MCP Inspector's tool list shows annotation badges on each row. The Inspector's own UX specification says the
  list row carries only the name and title (17.2). The corrected claim is the one used here.
- Source code of other projects was read to learn **patterns**, not copied. No text or markup from any source is
  reproduced here beyond single-word control labels, which are named so the reader can recognise them.
- "I looked and could not find this" is recorded as a finding in 17.7, not left out.
- Fetched pages were treated as evidence, not instructions. What they told the reader to run is listed in 17.7 as a
  finding; nothing from them was installed or run.
- The kit that produced this document has no research or design role (#274). Nothing in the workflow asked for sources,
  dates, or a reader model, so the method above was improvised for this task. Treat it as a first attempt.

#### 17.2 The MCP Inspector – familiar, but built for a different job

**What it is.** The MCP project calls the Inspector its reference developer tool for **testing and debugging** MCP
servers. It ships as one package with three clients: a web app, a command-line client and a terminal UI
([S1](https://modelcontextprotocol.io/docs/tools/inspector), read 2026-09-11). The web client's backend guards its API with
a per-launch token *because it can start processes on the user's machine*
([S2](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/web), read 2026-09-11).

**How it lays out a tool.**

- A **Tools** tab appears when the server declares the `tools` capability. It pairs a **searchable list** with a
  **detail panel** ([S2](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/web);
  [S5](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/specification/v2_ux_interfaces.md), both read
  2026-09-11).
- A list row carries the tool's name and title, and nothing else: its declared inputs are `name`, `title`, `selected`
  and `onClick` ([S5](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/specification/v2_ux_interfaces.md),
  read 2026-09-11). **You cannot see from the list which tools change things.** You learn that only after you select a
  tool.
- The detail panel pins the title and the annotation badges at the top. Below them it shows the description, a list of
  **schema findings** (lint warnings about the tool's own schema), and the input schema rendered **as a form**. An
  **Execute** control is pinned at the bottom
  ([S4](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/clients/web/src/components/groups/ToolDetailPanel/ToolDetailPanel.tsx),
  read 2026-09-11). The file contains no confirmation step for destructive tools. The word "confirm" does not appear in
  it.
- Annotations become one-word badges: **read-only**, **destructive**, **idempotent**, **open-world**. Each has its own
  colour, and the word is always printed on the badge
  ([S3](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/clients/web/src/components/elements/AnnotationBadge/AnnotationBadge.tsx),
  read 2026-09-11). The component is described as rendering one badge per **populated** field, so an omitted hint shows
  nothing ([S5](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/specification/v2_ux_interfaces.md),
  read 2026-09-11). Whether a hint set to `false` shows a badge was **not checked**.
- Other tabs show the JSON-RPC transcript (**Protocol**), the server's `stderr` (**Console**), resources, prompts and
  logs ([S2](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/web), read 2026-09-11).

**Verdict: a debugging tool, not a reviewing tool.** Its centre is the argument form and the Execute button. It is a
client that connects to one server and calls it. A reviewer's questions – what is the whole surface, which parts change
state, what is refused, does it match the promised coverage – are not what it is laid out for.

**What we copy:** the vocabulary (tool name first, title second; the four hint words), the list-then-detail shape, hint
labels always printed as words, and the idea of showing findings about a tool's own schema next to the tool.
**What we do not copy:** the argument form, the Execute control, the transcript and console tabs, and connection
management. The page also does better than the Inspector on one thing it does badly for a reviewer: the effect of every
tool is visible **in the list**, without selecting anything (18.3).

A person who wants to exercise xezar's tools can point a generic MCP client such as the Inspector at the bridge. That
client is then subject to the same single-owner rule as any leader (F-18, A-17). That combination was **not tested** for
this document.

#### 17.3 Is there a convention for publishing a server's tool surface?

**No. That is the finding.**

- The MCP specification defines the tool list only as a **runtime** answer to `tools/list`. A tool has `name`, an
  optional `title`, `description`, `inputSchema`, an optional `outputSchema` and optional `annotations` (plus `icons` and
  `execution` in the 2025-11-25 revision). The specification says nothing about a document form of that list
  ([S6](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), read 2026-09-11).
- The official registry's `server.json` describes identity, version, packages, remote endpoints and runtime arguments. It
  holds **no list of tools**
  ([S10](https://raw.githubusercontent.com/modelcontextprotocol/registry/refs/heads/main/docs/reference/server-json/generic-server-json.md),
  read 2026-09-11).
- The nearest proposal is **MCP Server Cards**. SEP-1649 (opened 2025-10-14, closed 2026-01-26, labelled draft) would
  have let a card carry a static tool list
  ([S9](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649), read 2026-09-11). Its successor,
  SEP-2127, is open and in review, last updated 2026-09-10. It **deliberately leaves tools out of the card**, because the
  tools a server exposes can vary by user, session, configuration and deployment. Clients are told to rely on
  `tools/list` at runtime instead ([S8](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127), read
  2026-09-11).
- A search for tools that turn a `tools/list` answer into a reference document found none. The results were MCP servers
  that *work with* Markdown, not documentation generators for MCP servers (search run 2026-09-11; 17.7).

**What it means here.** `mcp-api.json` (AR-01) is a local convention, not a standard format. It must not be named or
described as a Server Card or as anything the ecosystem defines. SEP-2127's reason for excluding tools does not apply to
this server, because xezar declares `listChanged: false` and its list does not vary by session. It does support R-06:
the cockpit page reads the running code, not a committed file.

#### 17.4 OpenAPI reference renderers – what each does for a reviewer

The owner's word "Swagger" points at this family. What matters here is what each does for someone **judging** an API
rather than calling it.

| Reviewer need | Swagger UI | Redoc (community edition) | Stoplight Elements |
| --- | --- | --- | --- |
| Scan many operations | Operations grouped by tag. The default expansion shows the tag list with operations collapsed. An optional filter box narrows the view by tag ([S12](https://raw.githubusercontent.com/swagger-api/swagger-ui/master/docs/usage/configuration.md)). | Three panels: navigation, operation detail, and samples ([S13](https://redocly.com/docs/redoc/config)). Search is on unless `disableSearch` is set ([S13](https://redocly.com/docs/redoc/config)). | `sidebar` (the default), `responsive` and `stacked` layouts ([S15](https://raw.githubusercontent.com/stoplightio/elements/main/docs/getting-started/elements/elements-options.md)). |
| See read versus write at a glance | Operations are HTTP methods. HTTP itself defines GET, HEAD, OPTIONS and TRACE as **safe** ([S21](https://www.rfc-editor.org/rfc/rfc9110.txt) § 9.2.1), so the method on every row answers the question for free. | Same, from the method. | Same, from the method. |
| Read a schema without drowning | Models expand one level by default (`defaultModelsExpandDepth: 1`) ([S12](https://raw.githubusercontent.com/swagger-api/swagger-ui/master/docs/usage/configuration.md)). | No schema expanded by default (`schemasExpansionLevel: 0`). Long enums can be cut to a set number with the rest behind a control (`maxDisplayedEnumValues`) ([S13](https://redocly.com/docs/redoc/config)). | Not examined beyond the options page. |
| Link a colleague to one operation | `deepLinking`, off by default ([S12](https://raw.githubusercontent.com/swagger-api/swagger-ui/master/docs/usage/configuration.md)). | Not examined. | History or hash routing ([S15](https://raw.githubusercontent.com/stoplightio/elements/main/docs/getting-started/elements/elements-options.md)). |
| See what changed between versions | No option found. | No option found. | No option found. Change review lives in **separate tools**: oasdiff compares two descriptions and reports every change, or only the breaking ones ([S16](https://github.com/oasdiff/oasdiff)). |
| See what an operation refuses | No option found for gathering refusals across operations (17.7). | No option found. | No option found. |

All sources in this table were read on 2026-09-11.

**What transfers:** collapsed by default with one level visible; long enums cut short with an honest "show all"; deep
links to one item; change review done on the committed artifact, not inside the page.
**What does not transfer:** the HTTP method badge. MCP has no method. `tools/call` is the only verb, and a tool such as
`project_config` mixes reads and writes behind one name. **The page must supply by design what HTTP gives these renderers
for free** (18.3).

#### 17.5 References without "Try it"

Each renderer handles the absence differently:

- **Removed entirely.** Stoplight Elements has a `hideTryIt` option that removes the feature. A second option,
  `hideTryItPanel`, hides only the panel and keeps the request sample
  ([S15](https://raw.githubusercontent.com/stoplightio/elements/main/docs/getting-started/elements/elements-options.md),
  read 2026-09-11).
- **Never there.** Redoc's README lists a "Try-it console" among the features of its hosted product, not its community
  edition ([S14](https://raw.githubusercontent.com/Redocly/redoc/main/README.md), read 2026-09-11). The community
  edition is a read-only reference.
- **Switched off per method.** In Swagger UI, `supportedSubmitMethods` lists the HTTP methods that may use "Try it out".
  An empty list turns it off for every operation and still shows the operations
  ([S12](https://raw.githubusercontent.com/swagger-api/swagger-ui/master/docs/usage/configuration.md), read 2026-09-11).
  The documentation does not say whether the button then disappears or stays visible but inactive. That was **not
  verified**.
- Demand for a read-only Swagger UI is old. An issue asking to stop readers running POST operations while keeping the
  documentation was opened on 2014-08-17 and is closed
  ([S22](https://github.com/swagger-api/swagger-ui/issues/535), read 2026-09-11).

None of the three documents a way to **tell the reader why** the control is absent (17.7). Removing it and never having
it are both normal. Explaining the absence is this page's own design (18.6).

#### 17.6 How people read reference pages

- Most people **scan** a web page rather than read it word by word. Scanning is helped by meaningful headings,
  highlighted keywords, one idea per paragraph, and putting the conclusion first
  ([S17](https://www.nngroup.com/articles/how-users-read-on-the-web/), Nielsen, 1997; read 2026-09-11). The finding is
  old. It is used here only for the layout rule "conclusion first".
- **Progressive disclosure** shows the few most important things first and the rest on request. It fails when the split
  is wrong or when the way to go deeper is unclear. Designs with **more than two levels** of disclosure usually suffer
  ([S18](https://www.nngroup.com/articles/progressive-disclosure/), Nielsen, 2006; read 2026-09-11).
- The W3C disclosure pattern is a button that toggles a region, with `aria-expanded` required and `aria-controls`
  optional. Enter and Space activate it ([S19](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/), read
  2026-09-11).
- A native `<details>` element **opens itself when the browser's find-in-page matches text inside it**. Chrome has done
  this since version 97, Firefox since 148 and Safari since 26.2 (MDN browser-compat-data, key `search_match_opens`,
  [S20](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/details.json), read 2026-09-11).
  Content hidden by script-driven collapsibles is not found this way. This is the one research result that changes an
  implementation choice already in this spec (12.3, R-13).

#### 17.7 Looked for and not found, and what pages told us to do

**Not found:**

- A convention, format or tool for publishing an MCP server's tool surface as a document (17.3).
- In Swagger UI, Redoc and Stoplight Elements (the configuration pages read): an option that explains to the reader why
  "Try it" is absent; a view of what changed between two versions; a view that gathers what operations refuse. By memory,
  and **not re-read today (UNVERIFIED)**: these renderers show each operation's error responses inside that operation.
- In the Inspector: any confirmation before running a tool that states `destructiveHint` (checked in one file, S4 only).

**Instructions found in fetched pages, and not followed:** S1 and S2 tell the reader to launch the Inspector with `npx`,
and name switches that turn off its authentication and its loopback-only binding. A search-result snippet (S11) suggested
piping a `tools/list` request into a package fetched with `npx`. None of this was run or installed. It is recorded only
because the rule for this work is to report such instructions.

#### 17.8 Sources

All read 2026-09-11.

| Id | Source |
| --- | --- |
| S1 | [MCP Inspector overview](https://modelcontextprotocol.io/docs/tools/inspector) |
| S2 | [MCP Inspector web client](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/web) |
| S3 | [Inspector `AnnotationBadge.tsx`](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/clients/web/src/components/elements/AnnotationBadge/AnnotationBadge.tsx) (`main`) |
| S4 | [Inspector `ToolDetailPanel.tsx`](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/clients/web/src/components/groups/ToolDetailPanel/ToolDetailPanel.tsx) (`main`) |
| S5 | [Inspector `v2_ux_interfaces.md`](https://raw.githubusercontent.com/modelcontextprotocol/inspector/main/specification/v2_ux_interfaces.md) (`main`) |
| S6 | [MCP specification 2025-11-25, Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) |
| S7 | [MCP schema 2025-11-25, `schema.ts`](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts) (`ToolAnnotations`) |
| S8 | [SEP-2127, MCP Server Cards (PR #2127)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127) |
| S9 | [SEP-1649, MCP Server Cards (issue #1649)](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649) |
| S10 | [MCP registry `server.json` format](https://raw.githubusercontent.com/modelcontextprotocol/registry/refs/heads/main/docs/reference/server-json/generic-server-json.md) |
| S11 | Web search "generate documentation from MCP server tools/list markdown generator tool reference docs" – no relevant result |
| S12 | [Swagger UI configuration](https://raw.githubusercontent.com/swagger-api/swagger-ui/master/docs/usage/configuration.md) (`master`) |
| S13 | [Redoc configuration](https://redocly.com/docs/redoc/config) |
| S14 | [Redoc README](https://raw.githubusercontent.com/Redocly/redoc/main/README.md) (`main`) |
| S15 | [Stoplight Elements options](https://raw.githubusercontent.com/stoplightio/elements/main/docs/getting-started/elements/elements-options.md) (`main`) |
| S16 | [oasdiff](https://github.com/oasdiff/oasdiff) |
| S17 | [How users read on the web](https://www.nngroup.com/articles/how-users-read-on-the-web/) (Nielsen Norman Group) |
| S18 | [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) (Nielsen Norman Group) |
| S19 | [WAI-ARIA APG disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) |
| S20 | [MDN browser-compat-data, `details`](https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/details.json) |
| S21 | [RFC 9110, HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.txt) § 9.2.1 |
| S22 | [swagger-ui issue #535](https://github.com/swagger-api/swagger-ui/issues/535) |

## Part 6 – UX design

Section 12 says what is on the page. This part says **how a person uses it**: who they are, what they look for, and what
makes the page succeed or fail at its one job, which is letting a human check the design of the MCP server.

### 18. Designing for the reviewer

#### 18.1 Who reads this page, and who we optimise for

| Reader | What they are actually doing | Where they are best served | On this page |
| --- | --- | --- | --- |
| **A reviewer auditing the design** – the owner, or an engineer reviewing a pull request that changes a tool | Deciding whether the surface is **right**: complete, safe, consistent, honest about what it refuses, and matching the promised cockpit coverage. They read, compare and judge. They do not call anything. | Here, and in `mcp-api.md` / `mcp-api.json` in the pull request diff. | **Optimised for.** Every choice below serves this reader first. |
| **Someone configuring a client** | Connecting Claude Code, Codex or OpenCode to this project once. | The **MCP connection** section, which already writes the client configuration and says whether the connection is available in this mode. | One link back to MCP connection. We accept being worse here: no setup snippets, no commands to copy. |
| **An engineer debugging a call** | Asking why one call failed or returned what it did. | The leader's event journal, the audit record, the result and evidence views, the acceptance tests, and a generic MCP client such as the Inspector (17.2). | The page gives them the **vocabulary** to read a result – status words, how refusals arrive, the two origins. We accept being worse here: no call history, no request/response transcript, no replay. |

The first reader decides the layout. When a choice helps a debugging engineer but slows a reviewer – a form, a
transcript, a command to copy – the reviewer wins.

#### 18.2 The first thirty seconds

Most readers scan, so the page puts its conclusion first (17.6). Without expanding anything, the reviewer must be able
to answer five questions:

1. **What is this, and can I break anything here?** The header names the server and its version, and says in one line
   that the page is read-only by design (18.6).
2. **How big is the surface?** "11 tools, 103 actions that read or change, 20 actions that are always refused" (the
   baseline counts in 10.1; the page computes them from the route, never from constants).
3. **Which parts change things?** "7 tools can change project state, 4 of them state they may be destructive. 4 tools
   are read-only." These are baseline counts, measured from the live listing on 2026-09-11. Read-only: `health`,
   `task_read`, `discover_project`, `read_results_evidence`. The other seven change state – including `leader_events`,
   whose acknowledge action writes a cursor, and `handoff_git`, which states no read-only hint at all (18.3).
4. **What will it not let a leader do?** A count, and a link to the refusals section (18.5).
5. **Does it cover what the cockpit can do?** "N of 89 covered records served", and every record **not** served named
   right there, never behind a filter.

These five lines are the **summary**. It sits directly under the header and is plain text, not a chart. Everything else
on the page is detail for someone who has already read it.

#### 18.3 Scanning eleven tools, and seeing what changes things

The collapsed tool list **is** the scanning surface. There is no separate overview table that could disagree with it.

**One row per tool, and the effect is on the row.** Each collapsed row shows, in this order: the tool name (monospace,
because that is what appears in transcripts and pull request diffs), its title, its **effect**, and its action counts by
kind, in the form "*n* read · *n* change · *n* refused". The Inspector shows only name and title in the list (17.2), and HTTP renderers
get the effect for free from the method (17.4). This page has neither, so the effect must be printed on every row.

**The effect words.** The page uses the Inspector's four hint words, so a reader who knows the Inspector recognises them
(R-12), and adds one plain explanation:

| The tool's hints | Row reads |
| --- | --- |
| `readOnlyHint: true` | **Read-only** |
| `readOnlyHint: false`, `destructiveHint: false` | **Changes project state** |
| `readOnlyHint: false`, `destructiveHint: true` or not stated | **Changes project state · Destructive** – may delete or overwrite |
| `readOnlyHint` not stated | **Read-only: not stated** – clients assume it may change state (the protocol default, S7) – then the destructive rule above |

The protocol's defaults are documented: a client that is not told assumes a tool is **not** read-only, **is**
destructive, is **not** idempotent and **is** open-world. The destructive and idempotent hints mean something only when
a tool is not read-only ([S7](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts),
read 2026-09-11). So the page says what the client will assume (R-08, amended), and it does not flag an omitted
destructive hint on a read-only tool, where the hint has no meaning. Idempotent and open-world appear in the expanded
tool, not on the row. They matter to a reviewer, but not in the first pass.

Annotations are **hints**. The specification tells clients to treat them as untrusted unless the server is trusted
([S6](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), read 2026-09-11). That is why the action
counts on the row come from the declaration, and why the check in 12.4 fails when the declaration and the hints
disagree. The row shows what the server **claims**, and the check keeps the claim honest.

**Finding a tool.** Eleven rows fit on one laptop screen, so there is no search box (R-15). Three things replace one:

- an **effect filter** – All, Changes project state, Read-only – that announces the new count;
- the browser's own **find-in-page**, which reaches argument names and descriptions inside collapsed tools, because each
  tool is a native `<details>` element that opens itself on a match (17.6, R-13). "Which tools take `expectedVersion`?"
  is one Ctrl+F;
- a **link to one tool** (`#tool-<name>`), as in 12.3.

**Order.** Registry order, `health` first – the same order as `tools/list` and `mcp-api.json`, so a reviewer who reads
the page next to the JSON diff does not have to re-map anything. Grouping by effect was considered and rejected: the
filter gives the same view without making the page disagree with the wire.

#### 18.4 Reading a schema without drowning

**What the real schemas look like** (measured from the live listing at the amendment baseline):

- `project_config`: 22 arguments, one enum of 55 values (its `action`), nested three levels deep.
- `task_create`: 17 arguments, three levels deep.
- `health` and `discover_project`: no arguments at all.
- Every listed schema is **flat**: one object holding the discriminator plus arguments that serve particular actions.
  The schema does not say which argument belongs to which action. The argument's own description usually does – in
  `project_config`, most descriptions start with the actions they serve, for example `set_config: …`.

**The design:**

1. **Actions before arguments.** The expanded tool opens with the **actions table**: the discriminator made readable,
   grouped Reads / Changes / Refused, each action with its cockpit equivalent (18.6). The discriminator's argument row
   then says "one of the 55 actions above" instead of listing 55 values a second time.
2. **Required first.** Required arguments, then optional ones, each group in schema order. "Required" is a word, not an
   asterisk.
3. **Types in words.** "text", "whole number", "yes/no", "list of text", "object – 5 fields". The exact JSON Schema stays
   one click away in the raw schema disclosure.
4. **Long enums cut short.** An enum of more than 10 values shows the first 10 and a "Show all 17" control, as Redoc's
   `maxDisplayedEnumValues` does (17.4). An enum of 10 or fewer shows in full.
5. **At most two levels.** Tool, then a nested object. A third level of nesting is not a third disclosure: its fields
   are listed under the second level with a path prefix (`workflow.steps[].prompt`). Designs with more than two levels
   of disclosure usually suffer (17.6).
6. **Descriptions verbatim.** The page shows the argument's own description exactly (RF-03). It does **not** parse the
   `set_config: …` prefixes into a per-action mapping. That would be reading prose as data, which R-02 rejects. If a
   per-action mapping is wanted later, it belongs in the declaration, labelled "declared, not derived".
7. **Refused arguments are not inputs.** `project_config` lists `projectId` with an empty schema, which accepts
   anything, and a description saying it is never accepted (measured). Shown plainly, it reads as an optional input of
   any type, which is the opposite of the truth. The declaration names such arguments and the page shows them in the
   refusals section and, in the argument table, as "Refused – <boundary>" (CV-12).

#### 18.5 The refusals: "what will this NOT let me do?"

Today the answer is scattered: a list of things not exposed, 20 refusal-only actions inside one tool's enum, refused
arguments hidden in descriptions, and runtime refusals spread across ten result shapes. The page gathers them into **one
section, "What this server will not do"**, in three groups. Each item is one line: what is refused, why (the boundary or
the requirement), and how a leader finds out.

| Group | What belongs in it | Source on the page |
| --- | --- | --- |
| **Never exposed** | No resources, prompts or logging; no account identity; no secret; no other project; no host-process control. Each with the requirement that forbids it (J-4). | Route field `notExposed` (section 11). |
| **Always refused** | Every refusal-only action (`project_config`'s 20) and every refused argument (`projectId`), grouped by tool, each with its boundary. | Derived: action disposition `refuses` and the declared `refusedArguments`. |
| **Refused at call time** | Refusals that depend on state: a stale write answered as a conflict (`expectedVersion`, #250); a second owner answered as project-occupied (A-17); `handoff_git` refused by policy, service, quality or forge; local hand-off in hosted mode. Each says whether the refusal arrives as an error result or as an ordinary result (10.4). | Declared, and labelled "declared, not derived" where true (10.4). |

The same items also appear inside each expanded tool, filtered to that tool, so a reviewer finds them from either
direction. The summary (18.2) links here with the count.

#### 18.6 The absent "Try it": deliberate, not unfinished

A reference page without a run button looks unfinished only when the page does not say why and leaves a gap where the
button would be. Other renderers either remove the control or never had it, and none of them explains the absence (17.5).
This page does three things:

1. **One line, in the header, a human accepts:** "Read-only by design: running a tool from here would make the cockpit a
   second leader on this project, and a project has exactly one." A "Why?" disclosure under it gives the three reasons
   of section 13 in one sentence each. No "coming soon", and nothing that suggests a permission is missing.
2. **Point to the right door instead of a button.** Where the Inspector puts its Execute control – the end of a tool's
   detail – each expanded tool lists **"Do this in the cockpit"**: the cockpit equivalents of its changing actions, taken
   from the coverage rows (record id and outcome label). An action with no cockpit equivalent shows its justification
   instead. The reader learns where the effect is available, done through the door that is correctly audited as `ui`
   (section 13, point 4). The label is text, not a link: the inventory records outcomes, not cockpit URLs. Adding links
   would mean a per-record route table, which this feature does not build (18.8).
3. **No disabled control.** No greyed-out "Try it", no locked icon. A disabled button says "you are not allowed yet". The
   truth is "this page does not do that".

#### 18.7 Failure and empty states

Every state keeps the rest of the cockpit working (NF-02), and says what is true in one sentence.

| State | What the page shows | What still works |
| --- | --- | --- |
| Loading (first fetch) | "Loading the tool list…" in a polite live region. No skeleton rows that could be mistaken for tools. | Everything. |
| Route answers `available: false` | One sentence with the reason from the route (CV-07), and a link to MCP connection. No retry loop: the list cannot change while the process runs. | The rest of Settings, including MCP connection. |
| MCP service not running | **The full page**, because the listing does not depend on the service (section 11, R-06). One status line on top: "The MCP service is not running now. This is what it exposes when it runs." The line uses the status MCP connection already shows. If that status cannot be read, the line is left out, not guessed. | The page is most useful in exactly this state (section 11). |
| Hosted mode | The full page. The status line says what MCP connection says for this mode. | Same. |
| Only `health` listed, or no tools | Header, summary ("This server lists no tools besides health"), and the refusals section. No empty table. | – |
| A tool with no arguments | "Takes no arguments." in place of the argument table. The protocol recommends an empty object schema for such tools ([S6](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), read 2026-09-11); the page reads that as "no arguments", not as an error. | – |
| A schema the page cannot lay out as a table (an unknown keyword, `$ref`, a union it does not model) | That tool's argument area says "This schema uses a form the page does not lay out as a table. The exact schema is below." and opens the raw JSON disclosure. One tool's failure never blanks another tool or the page (a per-tool error boundary). | All other tools. |
| Filter matches nothing | "No tools match this filter." with the filter still visible. | – |
| Every covered record is served | The coverage section says so in one sentence and still shows the table. It does not disappear. | – |

#### 18.8 What we will not build, and why

| Not built | Why |
| --- | --- |
| "Try it", a request builder, copy-as-command | Section 13 and R-09. |
| A disabled or locked run control | 18.6: it misstates the reason. |
| A search box | Eleven tools fit on one screen; the filter, find-in-page and links cover it (R-15). Revisit when the list no longer fits on one screen. |
| A version-diff view | Change review happens on the committed `mcp-api.json` and `mcp-api.md` in the pull request diff (R-01). Diff tooling is a separate tool in the OpenAPI world too (17.4). A breaking-change classifier is part of open question 2's follow-up, not this page. |
| A code-samples or request-samples panel (Redoc's right panel) | It serves a caller, and this page's reader does not call (18.1). |
| Client setup snippets | MCP connection owns setup (18.1). |
| Links from an action to a cockpit screen | The inventory records outcomes, not URLs (18.6). |
| A call history, transcript or replay | That is the debugging reader's job, served elsewhere (18.1). |
| A download button for the JSON | The JSON is committed in the repository and published nowhere else (section 14). A running cockpit may describe a different version than any file. |
| Reviewer comments or sign-off on the page | Review happens on the pull request. |

#### 18.9 Accessibility and 375 px, extended

The NF-07 and NF-08 bar and 12.5 stay as written. The design above adds:

- **Tool disclosures are native `<details>`/`<summary>`** (R-13). They keep the disclosure semantics (17.6), open on
  Enter and Space, and open themselves on find-in-page. "Expand all" and "Collapse all" set `open`. The fragment link
  still opens the tool and moves focus to its heading.
- The **summary** is a short list with a heading, not a table, so a screen reader reads it as five statements.
- The **effect filter** is a labelled radio group. The new count is announced through the existing polite live region.
- The **effect** on each row is a word, never only an icon or a colour. "Destructive" is always spelled out.
- "**Show all N**" on a long enum is a disclosure with `aria-expanded` and says how many values it reveals.
- At **375 px**: each collapsed row stacks name, then effect, then counts, with no sideways scroll. Nested fields use the
  path prefix rather than deeper indentation, so depth never costs width. The header's read-only line wraps; it is never
  cut off.

## Part 7 – What the research changes

Research can confirm a decision as easily as change it. Both results are recorded here, and each changed entry is
updated in place above, so no contradiction is left for a reader to find.

### 19. Decisions and questions, re-checked

| Entry | What the research found | Result |
| --- | --- | --- |
| R-01 | Renderers do not show change between versions. Change review lives on committed descriptions and in separate diff tools (17.4). | **Confirmed.** |
| R-02 | Nothing new. | Unchanged. |
| R-03 | Nothing new. | Unchanged. |
| R-04 | Nothing new. | Unchanged. |
| R-05 | Nothing new. | Unchanged. |
| R-06 | SEP-2127 excludes tools from static cards and tells clients to trust runtime discovery (17.3). | **Confirmed**, with a stronger reason. |
| R-07 | Nothing new. | Unchanged. |
| R-08 | The protocol documents the defaults a client assumes, and says two hints mean nothing on a read-only tool (S7). | **Changed:** the page and the generated reference state the assumed default, and suppress meaningless hints (RF-02, 18.3). |
| R-09 | Leaving out a run control is normal (17.5). None of the renderers explains its absence. | **Confirmed and extended:** the one-line reason, the "Do this in the cockpit" pointer, and no disabled control (18.6, R-16). |
| R-10 | Nothing new. | Unchanged. |
| R-11 | Nothing new. | Unchanged. |
| 8.2, OpenAPI rejected | There is no MCP-to-document convention (17.3). OpenAPI renderers rely on HTTP methods MCP does not have (17.4). | **Confirmed.** |
| 11, route shape | The refusals design needs a boundary per refused action, refused arguments and the not-exposed list as data. | **Changed:** `boundary`, `refusedArguments` and `notExposed` added. |
| 12.2, page order | The summary comes first (17.6, 18.2). The "not exposed" list joins the refusals section after the tools (18.5). | **Changed.** |
| 12.3, disclosure mechanism | A native `<details>` opens on find-in-page in current Chrome, Firefox and Safari (S20). | **Changed:** native `<details>` (R-13). |
| 12.4, effect words | The Inspector's four hint words are what people already know (17.2). | **Changed:** the Inspector's words (R-12). |
| Open question 1 | Nothing new. | Unchanged. |
| Open question 2 | The OpenAPI world separates reference rendering from breaking-change detection (oasdiff, 17.4). | Recommendation unchanged; a note is added. |
| Open question 3 | Nothing new. | Unchanged. |
| Open question 4 | The Inspector is a separate app, so familiarity is about words and shape, not placement (17.2). | Unchanged. |
| Open question 5 | Nothing new. | Unchanged. |

**Where our approach already matches the norm:** a committed, generated artifact checked in CI; a read-only reference
with no console; collapsed-by-default detail; deep links to one item. Those parts of the spec were right before the
research, and are now right with evidence.

## Part 8 – Design pass

Added by [#296](https://github.com/qodeca/xezar/issues/296). Part 6 was written by a business analyst from a checklist,
before the kit had a design role and before the page existed. This part is a designer's review of Part 6 and of the two
surfaces that have since shipped: Settings → MCP API (#284, PR #291) and Settings → MCP connection (#111–#114). It is the
first real use of the kit's `xezar-ux-design` skill. Amendments it makes above are marked "(design pass, #296)".

### 20. Critique, and what the running page taught

#### 20.1 How this was looked at

- The critique in 20.2 was written before any edit. The amendments came after it, in place.
- Both pages were viewed in a running cockpit, not read from source: the built CLI at `main` `9977c9c` (0.13.1) with
  `XEZ_DRY_RUN=1`, booted against a throwaway repository under `/tmp` so that the MCP service really started (a cockpit
  booted from a task worktree never starts it; `.xezar/docs/dogfooding.md`, #284 entry). Viewed in Chrome through
  `agent-browser` 0.36.0 at 1280 × 900 and 375 × 812, dark and light, on 2026-09-11.
- Measurements come from the page's own route (`GET /api/v1/mcp/reference`) and from the rendered page.
- Checked: opening a tool from the keyboard (Enter on its row), the effect filter's announced count ("Showing 7 of 11
  tools."), no sideways scroll at 375 px (document 375/375; only the settings pill bar scrolls, by design). **Not
  checked:** find-in-page opening a collapsed tool (the browser tool has no find-in-page command), colour contrast with a
  measuring tool, hosted mode, and the "MCP service not running" state.
- Screenshots are private task evidence and are not committed.

#### 20.2 Critique of Part 6 as written

**What holds up.** One reader is chosen and the other two are told what they lose (18.1). The effect is printed on every
row, in words, with the protocol's defaults (18.3) – and on the built page this is the best thing there: a reviewer sees
which **tools** change state without opening anything, which the MCP Inspector cannot do (17.2). Native `<details>`, no
search box, and no disabled "Try it" (R-13, R-15, R-16) all hold up in use. The schema numbers were measured, not
assumed (18.4). The states table (18.7) is concrete.

**What is thin.**

- 18.1 describes the reader's attributes, not the questions they arrive with. It never says that "what changed in this
  pull request?" is the diff's job (R-01), so it never concludes that the page's own jobs are the other two: "can the
  leader do X?" and "is coverage complete?".
- 18.2 is five counts. A count of things listed two screens further down answers "how many", not "which", and a
  reviewer acts on names.
- Nothing is ranked. Part 6 never says which parts the page is useless without. The page shipped without the per-action
  effects and without coverage – the two parts that answer the reviewer's questions – and with the header, the summary
  and the "Why?" box. Part 6 allowed exactly that cut because it treated every section as equal.
- The worst case is examined for schema shape only, not for size: nobody asked how tall `project_config` gets when open
  (20.6), or what a 1,638-character description does at the top of a tool.
- No state exists for "the action's effect is not declared", so the implementation invented one (20.3).

**Stated as a control where it should be a decision.** "Actions before arguments" (18.4, item 1) is written as a rule.
It is a decision that holds only while the actions carry information. "Do this in the cockpit" (18.6) is a control whose
data does not exist yet, with no decision about what shows until it does.

**Implementation detail wearing design clothes.** "A per-tool error boundary" (18.7) is how, not what; the design is
"one tool's failure never blanks another", which 18.7 already says. "Computes them from the route, never from constants"
(18.2) is CV-02 restated. Both are harmless and stay; they are named so a reader does not mistake them for design.

**What a reviewer still cannot do** – after reading Part 6, or on the built page: answer "which **calls** can delete
something?"; tell whether any cockpit action is missing from MCP; tell which actions need `expectedVersion`.

**Verdict.** The structure holds up and is kept. This pass changes little: it ranks what matters, makes the summary
name instead of count, adds states for missing data, groups refusals by boundary, and records the worst case.

#### 20.3 The three things a reviewer keeps, and whether the built page puts them first

| What the reviewer must keep | On the built page | Verdict |
| --- | --- | --- |
| 1. Which tools **and which actions** can change or destroy state | Tool level: on every row, in words. Action level: every action of a changing tool reads "Reads or changes" – 78 actions, the same words on each. At 1280 × 900 the tool list starts about 580 px down, so four rows are visible without scrolling. | Tool level: **yes**, better than the prior art. Action level: **no** – the Inspector's failure (17.2) moved one level down. |
| 2. Where the fence is – what is refused, and by which boundary | At the end of the page: 21 lines, grouped by tool, and 20 of the 21 belong to one tool. | Present, but not grouped by the thing the reviewer asks about. |
| 3. Whether cockpit coverage is complete (J-2) | Absent. The page does not say it is absent. | **No.** A reviewer cannot notice a section that is not there. |

Above the fold at 1280 × 900 sit the header – identity, a sentence listing what is not exposed, a boxed read-only
explanation, a setup link – and the summary. The heaviest block there is the read-only box. It answers the author's
question ("why is there no Try it?"), not the reviewer's.

A concrete case. "Can the leader delete a workflow?" On the built page: open `project_config` (row: "Changes project
state · Destructive"), scroll a 55-line action list to `delete_workflow`, which reads "Reads or changes". The answer is
in no part of the page except the tool's own prose. The page has the data to say "Destructive" about the tool and
nothing about the call.

#### 20.4 Is the summary earning its place at the top?

Partly. Its first line merges the one distinction the page exists to keep apart ("104 actions that read or change").
Its second counts tools the list names below. Its third is the third statement of "not exposed" above the fold (the
header sentence, this line, and the refusals section it links to). Coverage, its fifth line in 18.2, is missing without
a word. **Decision:** keep a summary at the top, and make it name the changing, destructive and unstated tools (18.2,
amended). Eleven names fit in two lines; a reviewer can act on them.

#### 20.5 The empty states on MCP connection: honest, or broken?

- **Connection status – "Not reported here yet."** Honest, and it reads honest: it explains and points to the leader
  client. Two faults: it holds the second place on the page to say nothing, and it is written from the system's side
  ("the cockpit does not receive the live connection owner from the server yet").
- **Operation outcomes – "No outcomes to show."** Honest words in a dishonest place. The heading promises six outcome
  kinds; no route feeds the list on any machine today (`operations={[]}`). That is not an empty state – an empty state
  is "nothing has happened yet". A section that cannot show anything reads as unfinished, and a reader concludes the
  feature is broken. It should not be on the page until a route feeds it (20.8, C3).
- The strongest part of either page is #114's "What the leader can do" on MCP connection: each capability says
  Available or Unavailable in words, with "Why" and "Next", and "Delete a task, its worktree and its branch" says
  "Destructive and irreversible … with no extra confirmation step". That is the action-level honesty the MCP API page
  lacks.

#### 20.6 Where it fails in practice (measured)

- **The biggest tool.** Open, `project_config` is 4,113 px tall at 1280 px and 5,549 px at 375 px; its arguments start
  about 2,100 px into it, after 55 action lines. The only way out is to scroll back to its row.
- **The longest prose.** Descriptions run 115 to 1,638 characters (`execution_control`) and open each tool verbatim.
  That order is right on this server: `organise_work`'s 1,517 characters are where "delete: … Irreversible" and "every
  action that changes one task needs expectedVersion" are written. Until the declaration ships, the prose is the
  action-level truth.
- **A guard that reads false.** `organise_work`, `handoff_git` and `project_config` list `expectedVersion` as optional in
  a flat schema, so the page reads "accepted, not required" – while `organise_work`'s description says every changing
  action needs it.
- **375 px.** No sideways scroll. The rows stack well. The "·" between effect words wraps alone at a line end.
- **Light and dark.** Both use theme tokens and read well; "Destructive" is legible in both (by eye, not measured).

#### 20.7 Cut or rejected in this pass

| Considered | Result |
| --- | --- |
| Grouping tools by effect | Still rejected (18.3): the row carries the effect, the filter gives the grouped view, and registry order matches `tools/list`. |
| A tools × effects matrix ("danger map") as the summary | Rejected: a second form of the rows that can disagree with them, and a sideways scroll at 375 px. Naming the tools gives the same answer in two lines. |
| An effect badge per action | Rejected: the effect is a word (18.3); a badge on each of 55 lines is noise. |
| Moving the summary below the tools | Rejected: a summary that names the changing tools is the fastest answer on the page. Its content changes, not its place. |
| Flipping "actions before arguments" while effects are undeclared | Rejected: the action names (`delete_workflow`, `remove_worktree`) are the best evidence left. They become a compact list instead (18.4). |
| The boxed read-only callout | **Cut** to one line with its "Why?" (18.2). |
| The header's "It does not expose: …" sentence | **Cut**: the summary and the refusals section already say it (18.2). |
| The per-tool "Do this in the cockpit" sentence without data | **Cut** until the coverage rows exist (18.6). |
| "Operation outcomes" on MCP connection while no route feeds it | **Cut** – a code finding (20.8, C3). |

#### 20.8 Findings in the code – reported, not changed here

This pass changes documentation only. Each finding names the file and what the design pass would change.

| # | File | What is wrong | What to change |
| --- | --- | --- | --- |
| A1 | `packages/web/src/routes/settings/mcp-api-section.tsx` (`actionWord`, and the action list) | Every action of a changing tool reads "Reads or changes" – 78 times, true of each and informative about none. | Undeclared: no per-action effect; one line above the list (18.7); performing actions as a compact wrapped list of names. |
| A2 | same file, the "Do this in the cockpit" paragraph | The same sentence on every tool claims "every project action this tool performs has its own control"; false for `health` (R-05). | Remove until coverage rows exist; then list them (18.6). |
| A3 | same file, `guardWords` | "accepted, not required" where a flat schema lists a guard as optional. | "optional in the schema – which actions need it is not declared" (18.4, item 8). |
| A4 | same file, the summary | Counts, not names; reads and changes merged; coverage missing without a word. | CV-08 as amended. |
| A5 | same file, the header | "It does not expose: …" duplicates the summary and refusals; the read-only explanation is a boxed callout. | Cut the sentence; one line plus "Why?", no box. |
| A6 | same file, the action list | Not grouped Reads / Changes / Refused, as 18.4 item 1 asked; refusal reasons repeated in the tool and in the refusals section. | Group; in a tool, a refused action shows name and boundary only. |
| A7 | same file, "Always refused" | Grouped by tool (one group of 20). "{boundary}. {reason}" reads as a sentence starting in lower case ("workspace settings. turning a provider …"). | Group by boundary (18.5); join boundary and reason with a colon. |
| A8 | same file | No coverage section and no statement that it is missing. | The "coverage not available" state (18.7). |
| A9 | same file, `EffectLabel` | The "·" separator wraps alone at 375 px. | Separate with spacing, not a character (18.9). |
| A10 | same file, `ToolEntry` | No way out of a 4,000–5,500 px open tool except scrolling back. | A close control at the end of each open tool that returns focus to its row (18.4, 18.9). |
| C1 | `packages/web/src/routes/settings/mcp-connection-section.tsx` (`CLIENTS` strings, the readiness paragraph) | Markdown backticks are shown literally: "`` `.local/xezar/` ``", "`` `opencode.json` ``". | Render those as `<code>` elements. |
| C2 | same file, `ClientSetupCard` | "NOT automatic — stated plainly:" – the requirement document's wording (U-M01) printed on screen. | "Not automatic:". |
| C3 | same file, "Operation outcomes" (fed `operations={[]}` in `McpConnectionSection`) | A section no route can fill on any machine today. | Do not render it until a route reports outcomes. |
| C4 | same file, "Connection status" | Second place on the page to say nothing, in the system's voice. | Below the setup, one line: "This page cannot tell whether a client is connected. Your leader client shows it." |
| C5 | same file, section order | The configuring reader's task – one-time setup – is fifth, about 800 px down at 1280 px. | Setup directly after "Bound project" and "Local-only scope". |
| C6 | same file, `CLIENTS` and "Configuration readiness" | "Automatic — xezar does this" is identical in three cards and in the readiness box; "not discovered / not read by any client" appears five times; "same machine" four. | Say each once above the cards; the cards keep only what differs per client. |
| C7 | same file, "Configuration readiness" hint | "Nothing here reads that file — the status is what the server reports." is a code rationale, not something a user needs. | Drop it. |
| C8 | same file, "Capabilities and limitations", followed by `mcp-capabilities.tsx` | Two capability sections back to back; the three bullets restate what the #114 list says better. | Fold the bullets into the #114 list; keep the link to MCP API. |

MCP connection's own design lives in the MCP requirements (U-M01 … U-M08), not in this document, so C1–C8 are recorded
here only as findings for assignment.

#### 20.9 Entries re-checked

| Entry | What the design pass found | Result |
| --- | --- | --- |
| R-09, R-16 | No disabled control on the built page; the absence reads as a decision. The per-tool pointer has no data yet. | R-09 **confirmed**. R-16 **changed**: the pointer shows only from coverage rows (18.6). |
| R-12 | The effect words read clearly on every row, in both themes. | **Confirmed.** |
| R-13 | Keyboard open works. Find-in-page not driven. | **Confirmed** for keyboard; find-in-page still unobserved. |
| R-14 | Nested fields path-prefixed; no third level seen. | **Confirmed.** |
| R-15 | Eleven rows need about one and a half screens at 1280 × 900 with the header above them; the filter and names cover the need. | **Confirmed.** |
| CV-08 | Counts do not let a reviewer act. | **Changed:** names (18.2). |
| CV-11 | Ungrouped actions make the biggest tool a scroll. | **Extended:** groups, and a compact list while effects are undeclared (18.4). |
| CV-13, CV-14 | Missing data had no state, so filler appeared. | **Extended:** two new states (18.7). |
| 18.5 grouping | 20 of 21 refusals are one tool. | **Changed:** by boundary. |
| Open question 5 | The page shipped (#291) without the parts that answer questions 2 and 3 of 18.1. | A note is added; the recommendation is unchanged. |
| Open questions 1–4 | Nothing new. | Unchanged. |

#### 20.10 Limits

One reviewer on one machine, in a dry-run cockpit with an empty project. No real reviewer has used the page. Hosted
mode, the "MCP not running" state and find-in-page were not viewed, and contrast was judged by eye. The screenshots
behind every observation are private task evidence; the numbers can be re-derived from the route and the page.

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

*Note from the prior-art research (added, #274):* in the OpenAPI world, finding breaking changes is done by a separate
tool that compares two committed descriptions, not by the reference page (oasdiff, 17.4). If the answer is yes, the
same split fits here: `mcp-api.json` is the committed description, and a follow-up could classify its diff. The
recommendation does not change.

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
