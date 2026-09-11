# MCP server for a single-project leader — requirements draft

Status: **requirements contract; the feature is implemented** (`xezar mcp` and the tools inside `xezar serve`). Date: 2026-09-08; status updated 2026-09-11.
Audience: product owner and engineering team.
API reference: [MCP API reference](mcp-api.md) — every tool, its arguments and results, and which tool action serves each inventory record.
Updated agreement: local-only MVP, one active logical client per project, full autonomous project actions, mandatory events/conflict rejection/idempotency, and non-waivable quality. Technical research: [client compatibility and recommendation](mcp-client-compatibility.md).

Baseline: Xezar revision `6cd4aaa3605e8bcddf7bafd8f05ac96881ee35cc` and the current repository instructions. This is neither an approved protocol design nor a catalog of existing MCP tools.

Tracked by [epic #67](https://github.com/qodeca/xezar/issues/67), which breaks this document into eight phases of implementation issues. That epic is the backlog; this document stays the contract.

Related specification: [Built-in project leader and standard process kit](../builtin-project-leader/builtin-project-leader-requirements.md). MCP is an independent capability usable by external clients. The built-in leader is a separate extension that depends on this project-scoped MCP interface; it is outside the implementation scope of this document, not a rejected product feature.

## 1. Goal and value

An external AI model running in Claude Code, Codex, OpenCode, or pi (all four are required initial clients; pi needs the third-party `pi-mcp-adapter` extension, because pi itself ships no MCP support) acts as project leader and operates Xezar through MCP. A human continues working in the cockpit. Both use the same state, business logic, rules, and permissions.

The value is end-to-end project coordination without manually clicking through the leader's instructions: organizing work, delegating, responding to blockers, assessing results, and handing work to the next stage. Scope includes **every project action available to the leader in the UI**, including configuration, work organization, and execution management. A “start task / read status” toolset alone does not meet the goal.

One leader manages one project. This MCP specification does not implement a leader inside Xezar or add an autonomous decision-making layer to the server. The separate built-in leader specification defines that extension without making it a prerequisite for external MCP clients.

## 2. Agreement status and actors

- **Agreed**: an external single-project leader, complete project-action coverage, shared UI/MCP state, server-enforced isolation, automatically written local connection configuration, and one-time setup of the leader's client application.
- **Technical proposal**: a suggested implementation of a requirement that still needs a design decision; it is not an approved mechanism.
- **Open**: a product or technical decision that has not yet been made.

| Actor | Responsibility |
| --- | --- |
| Human / project owner | Sets the goal/DoD, configures the client, approves plans and out-of-boundary changes, and can take over in the UI. MVP grants full project-action authority, not operation-specific roles. |
| External leader | Owns priorities, scope, dependencies, acceptance criteria, and next-stage readiness; delegates, monitors, answers, and assesses results. |
| Xezar execution agent | Designs, implements, tests, and repairs within its assigned task boundaries. |
| Xezar | Enforces scope and rules, performs business operations, stores state, and exposes it through both interfaces. |
| Leader application / MCP client | Maintains the user-configured connection; it is not the authority that grants project access. |

The role split and separate tasks for successive stages are a reference scenario inspired by a project using the name Cezar. This document does not transfer that project's private content, models, branches, limits, or process rules to all Xezar users. Status-only monitoring during execution is an example project policy, not an MCP prohibition on reading history or changes. The separate built-in leader specification explicitly adopts the complete generalized operating model and standard kit. Its current `.ai/xezar/` baseline was statically audited after the readiness signal on 2026-09-09; see the [source register](../builtin-project-leader/standard-process-source-audit.md). This does not certify implementation or any MCP client, and no automatic source monitoring is enabled.

## 3. Scope and exclusions

Included: project and catalog reads, work planning, task creation and configuration, workflow and agent selection, messages and answers, execution lifecycle controls, variants, task organization, project configuration, project processes, automations available in the UI, results, files, diffs, verification, and stage handoffs. This also covers Git operations and GitHub integration actions available to the leader in the UI, subject to their restrictions.

Excluded: managing multiple projects, their registry, other projects' tasks, global settings affecting other projects, other projects' accounts and secrets, and arbitrary operating-system processes. Implementing the built-in leader is outside **this document's scope** and is specified separately. The MCP server adds no new merge/release feature. Existing project UI functions, including task deletion, merge and publication where present, are available autonomously to the client even when UI has a confirmation dialog. MCP need not reproduce confirmation clicks. Business validation and mandatory quality gates remain enforced. No per-operation roles or allowlists are introduced in MVP. Plan approval and changes outside approved goal/DoD remain human decisions, and cannot waive quality. Version one is local-only: Xezar and client run on the same machine, with no remote MCP access.

**Full-coverage boundary:** complete equivalence of project actions is required, not equivalence of the entire machine-administration UI. Pure presentation actions, such as scrolling, need no separate tool when equivalent information or operations are available. Excluding a business action merely because its current endpoint is global does not resolve the requirement: it requires the field-by-field implementation mapping described in section 8. The agreed boundary is project writes and only safe effective-capability/limit reads from shared settings.

## 4. Functional requirements

“MUST” describes a required outcome; labeled proposals do not prescribe an approved mechanism.

| ID | Requirement |
| --- | --- |
| F-01 | The server MUST bind the leader connection to one project and enforce that scope on every read and write. An input parameter, project alias, or prompt content cannot change the binding. |
| F-02 | The server MUST validate ownership of every resource, including nested identifiers and bulk operations: tasks, groups, messages, files, worktrees, workflows, automations, and their results. A foreign identifier must not cause a read or side effect. |
| F-03 | The leader MUST discover the bound project, effective capabilities/limits, and available actions without exposing other projects, account identities or secrets. All project UI actions are in scope; unavailable dependencies have understandable reasons. |
| F-04 | MCP MUST cover every project UI action, including destructive actions and existing merge/publication. No per-operation roles/allowlists or duplicated UI confirmation clicks in MVP. Shared validation and mandatory quality gates still apply. The action matrix proves completeness; tool granularity remains a design choice. |
| F-05 | The leader MUST be able to inspect existing workflows and skills, select them for a task, and perform project-scoped management actions offered by the UI. Do not invent skill CRUD operations that the UI does not offer. |
| F-06 | The leader MUST be able to create tasks with all project options of the UI form, including prompts and supported attachments, workflows, runners/models, variants, autonomy, and isolation. Validation and defaults are shared with the UI. The separate built-in leader's text-only first release does not reduce this MCP parity requirement. |
| F-07 | The leader MUST be able to organize work to the extent supported by the UI: inspect the queue, edit queued briefs and messages, change metadata, pin, archive, restore, delete, and manage Inbox items and variants. A need for new dependency or priority mechanisms does not mean those mechanisms already exist. |
| F-08 | The leader MUST be able to control task execution processes as the UI allows: start, cancel, finish, continue, and manage automatic resumes within the available scope. Controls must target processes belonging to the project; a generic “kill PID” operation does not meet that boundary. |
| F-09 | The leader MUST receive significant status, question, human-answer, blocker, error, and result events automatically. It can answer and continue according to session state. Plan approval and decisions outside approved goal/DoD remain human decisions; project operations within those boundaries are autonomous. |
| F-10 | The leader MUST be able to assess completed results: read summaries, history, test evidence, files, diffs, commits, and PR/CI state available in the UI. Assessment must identify its revision; missing or stale evidence must be recognizable. |
| F-11 | The leader MUST hand work onward through existing UI operations: feedback, continuation, variants, next-stage tasks, commit/push/draft PR, and existing merge/publication. These are autonomous project capabilities; no new release engine is introduced. Optional runtime review status remains distinct from mandatory quality and business acceptance. |
| F-12 | The leader MUST read/change project settings. Shared settings are read-only and reveal only needed effective capabilities/limits, without secrets, account identities, or other-project data. Global accounts, limits, and home files cannot be administered. The boundary is agreed; field mapping remains engineering work. |
| F-13 | MCP effects MUST automatically update open UI without manual reload. UI reconciles current state on reconnect; significant human changes are emitted to the leader. One authoritative state and causal origins prevent echo loops. |
| F-14 | Xezar MUST automatically write local connection configuration inside the bound project's `.local/xezar/`. The user configures the leader application once to use it. Not all applications automatically discover that file. Its name, format, and creation trigger remain open. |
| F-15 | Connection data must not require pasting into chat. Any credentials remain local and outside Git; they must not enter history, tool responses, or event logs. |
| F-16 | The server MUST reject global, foreign-project, expired-owner and otherwise invalid operations even when a client knows identifiers or tool names. Catalog filtering and prompt text do not replace enforcement. |
| F-17 | Version one MUST run locally with client and Xezar on the same machine. Claude Code, Codex, OpenCode and pi are required initial clients; pi is supported through the `pi-mcp-adapter` extension, which its one-time setup installs. Validated adapters may be necessary for proactive reaction. Remote access is out of scope. |
| F-18 | Exactly one active logical MCP client/session may own a project. UI stays concurrent; different projects may have different clients. Reject a second client with a protocol/transport-compliant project-occupied error. Multiple requests/streams of the same logical owner are not additional clients. No manual disconnect UI is added. |
| F-19 | Detect confirmed process/channel closure and use background liveness checks without model turns to release occupancy after confirmed termination or expiry. Model silence and one HTTP/SSE ending are not session death. After expiry the old client must reconnect; no two owners can mutate. Lease/fencing/timeouts remain design details. |
| F-20 | Long operations MUST be asynchronous: return acceptance and an operation/task ID, then automatically deliver significant events and enable client/model reaction without continuous model polling. Delivery to an application and starting a model turn are separately verified outcomes. |
| F-21 | Reconnect MUST deliver outstanding significant events and current authoritative state. Define ordering, deduplication and replay without inventing approved retention values. Client disconnect does not stop started tasks; results remain in UI and after reconnect. |
| F-22 | Mandatory quality checks and acceptance criteria MUST NOT be weakened, including by asking for approval to bypass them. Improve the solution or report a blocker. Optimize correctness, security, maintainability and acceptance evidence before time/cost; goal/DoD changes cannot be a quality bypass. |

## 5. Nonfunctional requirements

| ID | Requirement and assessment |
| --- | --- |
| N-01 | Isolation covers responses, errors, events, pagination, search, file paths, and side effects. An inaccessible resource must not reveal another project's name, content, or existence. |
| N-02 | UI and MCP operations use shared business rules, authorization, resource limits, locks, and state transitions. MCP must not write directly to JSON/NDJSON while bypassing services. |
| N-03 | **Agreed outcome:** reject any stale leader mutation when a human changed the relevant state after the leader read it. The leader must read current state before deciding again; no silent overwrite or automatic acceptance of the stale mutation. Expected-version/revision checks are a proposed mechanism. |
| N-04 | History should identify the action, time, project, resource, outcome, and UI/MCP origin without storing secrets. The identity model and audit retention remain open; source attribution must not bypass permissions. |
| N-05 | **Mandatory:** disconnect never loses or cancels a started task. Results remain available in UI and reconnect; long operations expose accepted/running/terminal or explicit uncertain states. Client occupancy is separate from executor lifetime. |
| N-06 | Reads are bounded and paginated. Significant events are pushed without continuous model polling. Non-model heartbeat, transport reconnect, acknowledgements and bounded recovery are allowed. Mechanisms and numeric limits remain engineering decisions. |
| N-07 | MCP must not block ordinary cockpit startup. Deleting recoverable connection state or lacking a client must degrade to a working Xezar. Do not require a new manually maintained file, database, or fixed port. |
| N-08 | Implementation preserves existing state, API, and agent-protocol compatibility. New persisted fields follow repository compatibility rules; upgrades must not break project binding or expand permissions. |
| N-09 | Tasks, files, and results are data, not sources of authority. Neither prompt injection nor instructions from another project can change the server-side connection scope. |
| N-10 | **Agreed mandatory idempotency:** retrying the same operation identity returns the original result or current status without another effect. Deliberately new identical work uses a new identity. Bind key to project/action/payload; do not deduplicate by text alone or assume JSON-RPC request ID is durable. Specify collisions, restart retention and uncertain external effects. |

## 6. UI → MCP coverage matrix

This is an **initial inventory of operation families from code**, not proof of completed coverage of every control. Function names are search anchors in the linked files. “Required equivalent” describes an outcome, not an approved MCP tool name.

Sources: [UI client](../../../packages/web/src/api/client.ts), [UI queries and mutations](../../../packages/web/src/api/queries.ts), [routing](../../../packages/web/src/routes.tsx), [settings registry](../../../packages/web/src/routes/settings/registry.tsx), [server](../../../packages/xezar/src/server/server.ts).

| ID | UI action/family and code evidence | Required MCP equivalent | Boundary / mapping status |
| --- | --- | --- | --- |
| M-01 | Task lists/details: `getRuns`, `getRun`, `getRunHistory`, `getRunHistoryContext` | List, filter, and read tasks, history, and current state | Bound project only; global `getRunsIndex` must not leak into MCP. |
| M-02 | New task form: `createRun`, `postPlan`, [new-task](../../../packages/web/src/routes/new-task.tsx) | Plan and start with every form option | Further audit of each field and default required. |
| M-03 | Sessions: `sendMessage`, `continueRun`, `editQueuedMessage`, `removeQueuedMessage`, [task-thread](../../../packages/web/src/routes/task-thread/task-thread.tsx) | Questions, answers, continuation, and queued-message editing | Session state and authority to answer shared with UI. |
| M-04 | Controls: `cancelRun`, `finishRun`, `cancelAutoResume` | Same task-process transitions | Cancel and Finish are not substitutes for resource scheduling; no arbitrary PID. |
| M-05 | Organization: `patchRun`, `pinRun`, `archiveRun`, `archiveFinished`, `deleteRun`, seen/unseen actions | Metadata, pins, archives, deletion, read state | Audit shared user-state semantics; bulk actions remain project-local. |
| M-06 | Inbox: `getTodos`, `startTodo`, `removeTodo` | Read, execute, or remove an item | Preserve current availability and feature flags. |
| M-07 | Variants: `getGroup`, `pickVariant` | Compare and choose a result | Every run in the group must belong to this project. |
| M-08 | Results: `getRunDiff`, `getRunChanges`, `getRunFile`, `getRunCommits`, `getRunCommit`, `getRunHandoff` | Completed artifacts and evidence identified by revision | Validate paths, limits, media, and worktree boundaries. |
| M-09 | Task Git: `commitRun`, `pushRun`, `createRunPr` | Commit/push/draft PR equivalents | Autonomous project actions with shared validation/quality; identify task and revision. |
| M-10 | Project Git: `getRepo`, `getRepoChanges`, `getRepoCommit`, `createRepoBranch` | Inspect and perform project branch operations | Main-checkout operations respect existing locks. |
| M-11 | GitHub: `getGithub`, `getGithubSearch`, `getGithubComments`, `getGithubChecks`, `getGithubPrChanges` | Issues/PRs, comments, changes, and CI | Resolve the GitHub repository from the bound project, not arbitrary input. |
| M-12 | Existing `getGithubPrMergeState`, `mergeGithubPr` | Inspect and invoke existing merge autonomously | Settled scope; preserve quality/branch/state checks. No duplicated confirmation click or newly invented release feature. |
| M-13 | Workflows: `getWorkflows`, `createWorkflow`, `parseWorkflow`, `deleteWorkflow` | Catalog, validation, saving, and deletion | Preserve built-in workflow rules and YAML limits. |
| M-14 | Skills: `getSkills`, `getImportableSkills`, `refreshSkills`; `getSkillsUpdate`, `checkSkillsUpdate`, `applySkillsUpdate` | Catalog and project actions available in UI | A shared catalog update may be global despite projectId; D-03. |
| M-15 | Configuration: `getConfig`, `putConfig`; Agents, Worktrees, Prompt templates, Bookmarklets sections | Read/change project settings | A field-level matrix is required; do not expose connection secrets. |
| M-16 | Agent files/profile selection: `getAgentConfig`, `getAgentConfigFile`, `putAgentConfigFile`, `selectAgentProfile` | Project configuration and selection only | Home/global file administration excluded even behind a project route; safe effective limits only. Leader-role prompt has the companion MVP self-edit prohibition. |
| M-17 | Worktrees: `getWorktrees`, `reclaimWorktrees`, `removeRunWorktree` | Inspect and clean worktrees | Project only; same active-work protections. |
| M-18 | Automations: `getAutomations`, `createAutomation`, `updateAutomation`, `setAutomationEnabled`, `checkAutomation`, `getAutomationCheck`, `getAutomationLog` | Project schedules, checks, and results | Checks/logs need a project owner even behind an unscoped endpoint. |
| M-19 | App handoff: `openRunInCli`, `openRunIn`, `openRunFileInApp`, `openProjectIn` | Equivalent handoff in supported environments | Explicitly report unavailable desktop capability; do not promise launching UI on the MCP client's machine. |
| M-20 | Layout/organization: `getUiState`, `putUiState`, `getWorkspaceUiState`, `putWorkspaceUiState` | Semantic project organization available to the leader | Do not copy global preferences or require one tool per gesture. Audit separates data from presentation. |
| M-21 | Global Resources, Accounts, Projects, Appearance, Notifications, and Skills settings | No global equivalent for the project leader | Global mutations and foreign data excluded; only safe effective project constraints allowed. |
| M-22 | Provider connect/enable/retry and account create/edit/delete | Separate effects; shared administration excluded | No global login sessions or account files for the leader; D-03. |

### Closing the inventory

Before approving the solution design, inspect all active UI routes and components, context menus, shortcuts, forms, bulk operations, and error states. A client export alone proves neither a visible action nor complete UI coverage; inspect call sites, direct requests, and browser-local state.

Every action needs a record with: UI source and symbol, availability conditions, inputs/outputs, validation/quality rules, actual effect scope, MCP equivalent, test ID, and status “covered / global / presentation / open decision”. Split M-01–M-22 wherever rules differ. Product and engineering approve the inventory; an unresolved project action prevents a full-parity claim.

### Significant event catalog (agreed)

| ID | Event that enables leader reaction |
| --- | --- |
| E-01 | Task completion, failure, cancellation or blocking. |
| E-02 | A question requiring attention and a human answer to a question. |
| E-03 | Quality-gate result or a completed result ready for assessment. |
| E-04 | Human change to goal, acceptance criteria, instruction, plan or task state. |
| E-05 | Configuration/workflow change affecting execution. |
| E-06 | Executor availability change affecting execution. |

Presentation-only changes, log lines and token counters do not trigger leader reasoning. Events carry project scope and sufficient causal context to avoid self-triggering loops. Replay/current-state recovery and background liveness are software work, not continuous model polling. Protocol receipt and actual client/model reaction must both be demonstrated; [the compatibility report](mcp-client-compatibility.md) identifies required adapters and current evidence gaps.

## 7. Reference scenarios

### S-01: connection and human collaboration

1. Xezar creates local connection configuration for project A in its `.local/xezar/`.
2. The user points the leader application at this connection once, following client-specific instructions. Connection data is not pasted into the conversation.
3. The leader reads A's server-confirmed identity, configuration, and capabilities. It cannot switch to B.
4. The leader chooses a workflow and starts a task; a human sees it in the UI, adds a requirement, and the leader reads that same change.

### S-02: staged delivery

The leader creates separate tasks: triage → business analysis → plan/specification → implementation → verification → draft PR → review → corrections. This is a reference process, not a mandatory workflow for all MCP users.

Each brief states the goal, scope, constraints, acceptance criteria, dependencies, and expected output. The leader selects an existing workflow; the execution agent chooses solution details. During execution the leader monitors status and responds to questions and blockers. After completion it reads the result and evidence for a specific revision, checks acceptance, and starts the next stage or a correction task. A revision change invalidates the assumption that previous evidence covers the current result. The review stage is distinct from the engine's optional `review` status.

### S-03: scope escape attempt

Leader A supplies a B task ID, a B message ID inside task A, a foreign automation result ID, or a path escaping the resource. The server rejects access before reading or mutating. A changed project parameter, `default` alias, cursor, URL, or symlink cannot change scope. Project B's UI and state remain unchanged.

### S-04: conflict and connection loss

A human finishes or changes a task after the leader reads it. The leader's stale mutation is rejected, and its response requires a fresh state read before another decision. After losing a task-start response, the leader must be able to determine the outcome; mandatory N-10 permits retrying the same operation identity without a second task. Conflict and idempotency details remain open.

## 8. Technical boundaries in the existing architecture

- The [HTTP server](../../../packages/xezar/src/server/server.ts) exposes `/api/v1` and project routes `/api/v1/p/:projectId`. Route scope is not proof of MCP authorization. The server derives project identity from a trusted connection binding; it must not forward an arbitrary `projectId` to a global API client.
- [ProjectContext](../../../packages/xezar/src/server/project-context.ts) joins the repository, RunStore, RunManager, and AutomationStore. **Proposal:** an MCP adapter invokes shared service operations with a narrowed context and resource checks. A loopback HTTP alternative needs equivalent project/owner enforcement; a proxy to every route is insufficient.
- [RunManager](../../../packages/xezar/src/workflows/run.ts), [RunStore](../../../packages/xezar/src/runs/store.ts), and [WorkspaceSemaphore](../../../packages/xezar/src/workspace/semaphore.ts) retain ownership of task lifecycle, state, and limits. MCP adds neither a second queue nor its own agent-process controller. Cover new tasks, Continue, and restart recovery.
- [Zod contracts](../../../packages/contract/src/index.ts) and [validators](../../../packages/xezar/src/server/validators.ts) anchor shared shapes and rules. Placement of MCP-specific schemas remains open. Any new HTTP API preserves the contracts, middleware, versioning, and chained route registration required by AGENTS.md.
- [Global UI events](../../../packages/web/src/api/global-events.tsx), [task SSE](../../../packages/web/src/api/run-events.ts), and [WebSocket](../../../packages/xezar/src/server/ws.ts) update the cockpit. MCP should use the same state source after project filtering. An unfiltered workspace stream is prohibited. MCP client notification transport remains open.
- The [UI settings registry](../../../packages/web/src/routes/settings/registry.tsx) separates project/global sections, but a section URL does not determine all effects. `agent-config` includes home files; accounts, resource limits, model locks, and skill updates can affect more than one project.
- **Agreed shared-setting boundary:** expose only safe effective limits/capabilities needed for this project. Allow project settings writes, never global account/limit/home-file administration. Field-by-field classification is engineering work. Any project override must be actually local in effect; do not expand global authority to implement it.
- [Paths](../../../packages/xezar/src/paths.ts) and [CLI startup](../../../packages/xezar/src/index.ts) are integration points for the connection file and Git ignore maintenance. State must be recoverable and written without exposing secrets. File presence or location alone is not a security boundary.
- The [agent protocol](../../../AGENT_PROTOCOL.md) describes execution backends; leader MCP is a separate control interface. It requires no new execution backend. Exposing MCP does not itself start a model inside Xezar. The built-in leader's runtime is specified in the companion document and consumes this interface.

The hard boundary covers MCP server authority and the operations it exposes. It is not whole-machine isolation: an external application may have its own tools, and execution agents may have broad shell access. Those processes' permissions require separate description; MCP must not promise a sandbox that existing runners do not provide.

## 9. Whole-feature acceptance criteria

**All acceptance cases are obligatory outcomes.** Proposed mechanisms and numeric limits remain engineering decisions; they cannot make isolation, idempotency, stale-write rejection, task survival, compatibility or asynchronous reaction optional.

Shared fixture: projects A and B, separate tasks, groups, messages, workflows, files, and automations; leader client bound to A; human UI; controlled backends without personal accounts. Before isolation tests, record B's state and external effects. Afterwards inspect responses, events, leader-visible logs, and B's unchanged state. Checking an error code alone is insufficient.

| ID / status | Given | When | Then / evidence | Traceability |
| --- | --- | --- | --- | --- |
| A-01 / O | Xezar runs for A; no local connection configuration exists. | Follow the agreed connection provisioning and one-time setup for every officially supported client. | Xezar writes configuration into A's `.local/xezar/`. The client accesses A without manually authoring connection data or pasting it into chat. Instructions distinguish the one-time user step and do not assume autodiscovery. Evidence: each client setup and local-file inspection. | F-14–15; D-01, D-02, D-04 |
| A-02 / O | Connection bound to A; B contains identifiable resources. | Read A's identity, then supply B through a parameter, alias, or call content. | Legal A access works. No variation changes scope, reveals B, or acts on B. Server rejection also works with a custom client. | F-01–03, F-16; all M |
| A-03 / O | Valid B IDs and mixed A/B resource lists are known. | Perform single/bulk reads and mutations, including B message inside A task, foreign run in a group, and B automation result ID. | Server validates every resource and relationship before access. B's data/state remain unchanged; no response reveals a foreign resource's existence. Partial-success policy for allowed items is explicit. | F-02, F-16, N-01; M-01, M-03–08, M-17–18 |
| A-04 / O | A/B have distinct files/history; large lists and events exist. | Search, paginate, supply foreign cursors, absolute/`..`/symlink paths, and request workspace events. | Every returned item belongs to A and an authorized resource. No B content, names, metadata, or secrets appear in results, errors, or streams. Forbidden paths are rejected. | F-01–03, F-16, N-01; M-01, M-08, M-11, M-18 |
| A-05 / O | Every UI action inventoried; settings/action mapping complete under the agreed boundaries. | Exercise UI and MCP counterparts from equivalent starting states, covering form fields, permissions, and unavailability conditions. | Equivalent business outcomes, defaults, rules, validation, and effects. Each matrix record links a test and evidence; no project action is unmapped. Start/status success alone is insufficient. | F-04–12; M-01–22 |
| A-06 / O | At least two workflows, task options, queued tasks, and variants exist. | Through MCP choose workflow/runner/model, create a task, edit its queued brief, organize tasks, and compare/select a variant. | Options behave as in UI, changes appear in the relevant views, and winner/other-variant effects follow product rules. | F-05–07, F-13; M-02, M-05–07, M-13–14 |
| A-07 / O | A has queued, running, waiting, and completed tasks; B also runs a task. | Exercise all controls, answer a question, edit a message, continue a closed session, and attempt an invalid transition. | Effects match UI; invalid transitions leave state unchanged. The correct question receives the answer, A controls do not stop B processes, and no unrestricted host-process control exists. | F-08–09, F-16; M-03–04 |
| A-08 / O | Human UI and leader connection both target A. | Leader creates/modifies a task; human answers and changes configuration in UI; leader reads and continues. | Both operate on the same task/configuration, see each other's effects, and can take over. No MCP-only duplicate history or configuration exists. | F-13, N-02; M-01–05, M-15 |
| A-09 / O | Known local A and global A/B values; agent config files have different scopes. | Change A's setting, then attempt global-source, home-file, shared-account, or limit changes through the project interface. | Authorized A changes appear in UI; B is unchanged. Global actions are rejected or require separate human action outside leader authority. Safe effective values and restrictions follow the approved field matrix. | F-12, F-16; M-14–16, M-20–22; D-03 |
| A-10 / O | Completed task has summary, changes, and test evidence for a specific SHA. | Read result, files/diff, commits, PR/CI through MCP and send feedback or create a next-stage task; repeat after SHA change and with missing evidence. | Same data as UI; assessment revision is identifiable. Missing/stale evidence is recognizable; the next task references the assessed result. `done` alone is not proof of passing tests. | F-10–11; M-08–11 |
| A-11 / O | All project actions enabled and goal/DoD agreed | Invoke deletion and existing merge/publication despite UI confirmation; attempt global write and quality weakening | Project actions need no per-operation human click, but shared validation and mandatory gates remain. Global writes and quality bypass fail; out-of-goal changes need a decision. | F-04, F-11–12, F-16, F-22; M-09, M-12, M-21–22 |
| A-12 / O | Connection configuration has local data and any credential; B has different data. | Exercise startup, errors, tools, events, and history; inspect Git and leader-visible outputs. | No connection data enters chat, no secret enters history/responses/logs, and the file is effectively excluded from Git. B information is not exposed. | F-15, N-01; D-02, D-04 |
| A-13 / O | Human changed a resource after leader read | Submit the stale leader mutation, then read current state | Reject the stale write without changing human state; the leader decides again only after fresh read. No silent overwrite/reconciliation acceptance. Test concurrent calls. | N-03; M-03–05, M-15 |
| A-14 / O | Mutation executed but response lost | Retry same operation key; then intentionally submit identical work with a new key; test crash and collision | Same key gives original result/status without duplicate; new key permits new identical task. Conflicting payload and uncertain external outcome are explicit and never blindly repeated. | N-10; all mutations |
| A-15 / O | Task runs; client disconnects and returns | Complete task offline, reconnect and retrieve events/state | Task/result survives; outstanding significant events and current state are delivered. No model status-poll loop or leader-slot heartbeat. Replay duplicates do not cause repeated effects. | F-19–21; N-05–06, N-10 |
| A-16 / O | Older state and sessions exist, MCP absent/corrupt or server restarting | Start/recover/upgrade using designed procedure | Ordinary cockpit remains usable, compatible data retained, no expanded authority or two project owners. Built-in leader still requires manual resume after restart. | N-07–08; F-18–19 |
| A-17 / O | Client A owns project P; UI is open | Connect a second logical client, open several requests/streams for A, and connect to another project | Reject only the competing owner with a documented compliant occupied-project error; same-owner requests and other projects work. No manual disconnect UI. | F-17–19 |
| A-18 / O | Owner is idle but live, then crashes or expires | Run non-model liveness checks; race reconnect/new client and submit old-owner writes | Model silence does not release ownership; confirmed termination/expiry does. Exactly one owner wins, stale owner is fenced and must reconnect; started tasks continue. Test restart too. | F-18–21 |
| A-19 / O | Each required client/adapter is connected, model idle | Start a long task, complete/fail/cancel/block it and emit every significant event class | Immediate acceptance is distinct from result. Delivery is observed and then a real model reaction occurs without status-polling turns. No event in logs alone counts as reaction proof. | F-17, F-20–21; E-01–06 |
| A-20 / O | UI open and leader event feed connected | Mutate through MCP, then make significant human changes in UI | UI updates without reload; human changes reach leader. Reconnect reconciles. No recursive leader loop from operation echoes, logs, tokens or visual changes. | F-13, F-20–21 |
| A-21 / O | Events pending while client offline | Reconnect with valid/old cursor and duplicates/out-of-order events | Outstanding significant events plus current state delivered; gaps explicit and recoverable. No duplicate decision/effect. Retention is documented from design, not assumed. | F-21; N-10 |
| A-22 / O | Global settings and mandatory quality controls exist | Attempt global admin or weakening gates/acceptance, including via an approval request | Only safe effective reads allowed; no secrets/foreign identities. Weakening is prohibited, not an approval option. Solution repaired or blocker reported. | F-12, F-22 |
| A-23 / O | Native client or built-in leader owns P | Attempt to start the other; test four clients on local-only setup | Same exclusive owner rule applies; handover requires old ownership to end, no covert second leader. Claude Code, Codex, OpenCode and pi each pass local setup and reaction tests. | F-17–21 |

Implementation tests should use isolated data and `XEZ_DRY_RUN=1`, without personal accounts or secrets. Real MCP clients and agreed transports need separate integration validation. This documentation change does not run those tests or claim these criteria have passed.

### Whole-feature Definition of Done

The feature is **complete across the entire agreed scope** only when all of the following hold:

1. Every UI business action has a final matrix record and product-owner-approved classification; every project action has a working MCP equivalent. Coverage is measured against this inventory, not tool or endpoint counts. No unresolved project action may remain in a full-coverage claim.
2. All criteria (A-01–A-23) pass on **the same release-candidate revision**. Evidence identifies SHA, fixture configuration, client, scenario, and result. `Skipped`, old-revision evidence, and model assertions alone are not passes.
3. Required outcomes are not deferred as optional mechanisms: stale-write rejection, idempotency, task survival, exclusive ownership, async delivery/model reaction, live UI updates and unchanged quality all pass. Engineering selects lease, versioning, replay and error details and records their tested behavior.
4. D-01–D-09 are resolved as needed for the released version. Documentation states the actual transport, startup method, connection file, supported clients, project/owner enforcement model, limitations, and setup without secrets in conversation.
5. The settings-field matrix removes project/global ambiguity. Engineering proves A operations do not affect B through accounts, skills, or files. Negative tests cover each resource family, not just `projectId`.
6. Demonstrate the complete human/leader flow: configuration → delegation → question/answer → completed result with evidence → next stage or corrections → further UI work. No global administration, newly added release engine, or built-in leader implementation is hidden in this MCP deliverable; existing UI merge/publication is explicitly in scope autonomously. The companion leader feature has its own acceptance gate.
7. Implementation meets the repository quality gate in [AGENTS.md](../../../AGENTS.md) and [SDLC.md](../../../SDLC.md); MCP integration tests and UI/MCP evidence are reviewable. This applies to future implementation, not builds for this documentation change.
8. Product approves leader-action coverage and the responsible engineer approves technical evidence. Known limitations contradict no obligatory criterion.

## 10. Open decisions

| ID | Decision | Constraint / proposal |
| --- | --- | --- |
| D-01 | Local transport, protocol negotiation, bridge and adapters | Local-only and all four initial clients are agreed. See compatibility report: stdio bridge plus client reaction adapters recommended; IPC/runtime tests remain design work. |
| D-02 | Session binding, liveness, occupancy and handover | One logical owner/project, automatic release on confirmed death/expiry, no manual disconnect UI. Choose lease/fencing/timeout and restart behavior; old expired owner must reinitialize. |
| D-03 | Shared/project field mapping | Product boundary settled: project writes, safe effective capability/limit reads only from global state. No global account/home-file/limit administration. Audit fields and implement enforcement. |
| D-04 | Connection file and adapters | File remains local in project .local/xezar; select format/name and one-time client setup, including real event-to-model integration. No universal autodiscovery. |
| D-05 | Async event and tool contract | Agreed significant-event catalog and no model polling; choose event IDs/order/replay/acknowledgements, negotiated features and adapters. |
| D-06 | Version checks, durable operation keys, audit | Stale writes must be rejected and idempotency is mandatory. Specify exact keys, collision, restart, external-side-effect uncertainty and retention; not open product guarantees. |
| D-07 | Existing merge/publication mapping | Settled: existing project UI actions autonomous, including delete/merge; no duplicated confirmation click. Preserve validation/quality and add no new release feature. |
| D-08 | Goal decisions and local application handoff | Goal/DoD boundary decisions remain; per-operation confirmation is not required. Missing desktop capability is explicit. Built-in/native handover respects the single owner. |
| D-09 | Operational limits and packaging | Choose measured bounds/retention and protected local exposure. No remote MVP or fixed approved timeout; heartbeat/replay run without model turns. |

## 11. Ready-for-implementation gate

Product scope is settled as stated above; engineering closes field/action mapping and designs the local owner/event adapters. Engineering closes the UI inventory, actual project/global effects, and transport/security design. Every requirement has assigned evidence, and isolation/completeness-critical decisions are resolved. This gate was the precondition for assigning tool names, the connection filename and startup commands. It has since been passed (status updated 2026-09-11): [D-04](mcp-d04-connection-file-decision.md) fixes the connection file and client setup, and the [MCP API reference](mcp-api.md) publishes the tool names.

## 12. Engineering handoff and readiness audit

**Approved event-reaction delivery hierarchy:** (1) use native event mechanisms when the client demonstrably reacts to them; (2) otherwise deliver a message through the official programmatic session interface; (3) use terminal text input only as a last fallback after runtime evidence proves reliability. This ordering is approved; terminal feasibility is not proven. Every event identifies Xezar as its source and must never impersonate user instructions or approval. If correct project/session targeting, separation from approval prompts/shell/user typing/active turns, and duplicate prevention cannot be established, refuse terminal delivery and expose a recoverable blocker. Tests must include each of these hazards, reconnect/retry and a real subsequent model reaction. No model polling, second logical owner, or wider project scope is introduced.


This document is the standalone product contract for the MCP workstream. The linked compatibility report is its technical evidence appendix. No knowledge of the interview is required; earlier product decisions in conversation that conflict with this revision are superseded by this text.

**Ready for planning:** yes. The scope, all four required clients, local-only operation, exclusive logical ownership, full project autonomy, immutable quality boundary, events, stale-write rejection and operation-key idempotency are specified. Engineering may choose transport/IPC, schemas, storage, version/lease values and packaging without asking the product owner about each routine detail, provided the required outcomes remain unchanged.

**Ready for bounded implementation:** shared service adapters, project/owner validation, durable operation identity, state-version checks, event catalog/journal, and local setup/error UI can be designed and implemented against fixtures. Do not expose a partially protected real integration as complete. The existing UI inventory still requires field/action-level closure. No Daxko audit is needed for this MCP workstream.

**Not yet ready to claim the entire feature implementable/certified without additional evidence:** generic native-client notifications are not proven to wake Codex/OpenCode models, and do not wake pi (observed with pi 0.85.1 and pi-mcp-adapter 2.32.1); Claude Channels has preview/eligibility constraints. A client-adapter spike must prove the selected integration in all four tools. All clients remain required; a supported native session that cannot be targeted needs an adapter/client extension, not removal from scope or model polling.

Minimum interface contract to refine in design:

- Session acquisition binds trusted project identity and one owner generation; occupied/expired responses are explicit and protocol-compliant, not fabricated standard error names.
- Mutations carry expected state and stable operation identity. Acceptance returns identifiers and status; completed, failed, conflicted and uncertain outcomes are distinguishable. Reuse of the same operation key is not a fresh action.
- Events expose project/resource/version, meaningful category, origin/causality and replay identity sufficient for deduplication. Every event handler reconciles authoritative state; delivery is distinct from model reaction.
- UI and MCP call common business services; same validation and quality apply, while UI confirmation clicks are not MCP permissions. Project writes and safe shared reads are enforced independently of prompts.
- Client-adapter contract includes initialization, role/server guidance, significant-event delivery, active/idle turn scheduling, reconnect, liveness and shutdown. It cannot acquire a second owner for the same leader.

Suggested work packages: close UI/field inventory → implement common operations and ownership/version/idempotency fixtures → validate all client reaction adapters → implement replay and automatic UI synchronization → exercise complete A-01–23 acceptance on one candidate revision. Work packages may overlap; a transport spike is not a passed full-feature gate.

Risks requiring engineering resolution: stale processes after expiry; external side effects with lost receipts; two independent streams delivering duplicates; human edits racing decisions; native-client integration limits; private data in global settings; prompt-based attempts to weaken quality. Product clarification is needed only if no supported adapter can meet the required native-client behavior or if a discovered UI action cannot be classified under the agreed project/global boundary. Do not silently relax either requirement.

## 13. UX/UI design handoff

This section completes the MCP design brief without adding a second leader UI, operation roles, manual disconnect, or secret-sharing steps. **Required** rows express agreed behavior or necessary visibility of it. **Proposal** rows give routine design guidance for review; labels and layout are not previously approved product decisions.

### Existing UI evidence and information architecture

The [settings registry](../../../packages/web/src/routes/settings/registry.tsx) and [settings shell](../../../packages/web/src/routes/settings/settings-shell.tsx) separate project and global settings and support desktop navigation/mobile drill-in. The [app shell](../../../packages/web/src/components/app-shell.tsx) supplies project navigation and a mobile drawer; the [global events provider](../../../packages/web/src/api/global-events.tsx) is the current shared-state update anchor. These are code observations, not evidence that an MCP settings screen already exists.

**Proposed placement:** one project Settings entry named “MCP connection”, available from the active project and linked from leader setup when ownership is relevant. Its information hierarchy is: project identity and local-only scope → connection/client status → client-specific setup → capabilities and limitations → actionable errors. Keep transport/debug detail collapsed. Do not expose global administration as part of project MCP setup. Final route/title and breakpoint behavior are designer choices within the current shell.

### Entry points and user journeys

| ID / classification | Journey and required content/controls |
| --- | --- |
| U-M01 / required | From project settings, identify the bound project and that MCP client/Xezar must be on the same machine. Show configuration readiness and one-time setup guidance for Claude Code, Codex, OpenCode and pi (including installing the `pi-mcp-adapter` extension). The automatically generated project file is not described as automatically discovered by every client. |
| U-M02 / proposal | Present client choice and short sequential instructions, a nonsecret local configuration location, and safe copyable setup guidance. Do not copy credentials into UI instructions/chat or add an editor for raw secret-bearing configuration. Mark adapter/Channels prerequisites and unsupported client versions explicitly. |
| U-M03 / required | Connecting a second logical client shows that this project is occupied, not a generic server failure. Explain that UI still works and running tasks are unaffected. Offer setup/help and a client-side reconnect path when appropriate; no “Disconnect other client”, “Force takeover”, or manual disconnect control. Do not expose another owner's secret/session identifiers. |
| U-M04 / required | Open task views reflect MCP actions without reload. A reconnect reconciles current state; pending or last-known data is not presented as newly confirmed. Important human edits reach the client without requiring the user to notify it manually. |
| U-M05 / required | Stale-operation feedback distinguishes rejection from failure after execution. Explain that the leader must reread current state. Retried operation feedback shows original/current outcome, while a deliberately new identical task is allowed as a separate action. No UI “retry” silently generates a new operation identity. |
| U-M06 / required | Capabilities distinguish usable project functions, unavailable dependencies, and read-only shared constraints. Full project authority includes delete/merge; do not introduce role toggles or permission checklists. Quality validation failures remain visible and cannot be dismissed as accepted exceptions. |
| U-M07 / proposal | Operation status uses short labels such as “Accepted”, “Running”, “Completed”, “Failed”, “Conflict — not applied”, or “Outcome being verified”, with task/result navigation. An acknowledgement is never labeled completed. Preserve operation context on transient error. |
| U-M08 / proposal | Keyboard-operable navigation, labeled controls, visible focus, meaningful non-color status text, polite status announcements, and readable errors. On narrow screens use the existing settings drill-in pattern; configuration paths wrap and controls remain usable without horizontal scrolling. Preserve light/dark behavior. |

### State inventory and recovery

| State | Visible meaning / action |
| --- | --- |
| Empty / configuration not generated | Project exists but connection configuration is not ready. Explain the prerequisite and generation outcome; do not require the user to manually invent connection data. |
| Loading / discovering | Show bounded progress and selected project; withhold unconfirmed capability values. |
| Ready / no active client | One-time setup guidance available; do not imply a running model or active session. |
| Connecting | Distinguish connection establishment from model startup. Repeated transport requests are not multiple clients. |
| Active logical client | “Connected” means owner/session live, not necessarily that the model is generating. UI can still mutate project state. |
| Occupied / rejected second client | Project is in use. Explain automatic release after confirmed end/expiry; offer no forced takeover. |
| Waiting | A task may await a human decision without MCP being disconnected. Link to the relevant question/task; do not change occupancy based on model silence. |
| Leader paused | This is a leader state, not an MCP disconnect control. Refer to leader status only when applicable; avoid conflating pause and release. |
| Server restarting / unavailable | Previously displayed data is last-known. After recovery show actual owner/configuration state; do not imply tasks were canceled or the leader resumed. |
| Disconnected / reconnecting | Started tasks continue. State/results are reconciled after reconnect; show an actionable connection problem rather than “task failed”. |
| Expired owner | Old client must reinitialize. Stale operation rejected; a new client may already own the project. |
| Error / conflict / uncertain external outcome | State clearly whether no mutation occurred, it was accepted, or its outcome needs verification. Preserve identifiers for safe retry; never offer blind repeat with a new key. |
| Unsupported / capability unavailable | Name the missing client/adapter/dependency or read-only boundary without disclosing secrets or other projects. Link to setup guidance, not global controls via MCP. |

Suggested copy is descriptive, not a final localization catalog. Exact lease countdowns must not be designed before timing semantics exist; show truthful connection status without inventing a timeout.

### UX acceptance and design readiness

| ID / classification | Given / when | Expected design evidence | Traceability |
| --- | --- | --- | --- |
| UX-M01 / required | New user opens project MCP setup and selects each initial client | Journey identifies project, local-only scope, automatic file creation and actual one-time setup. No secrets in chat, misleading autodiscovery, or unsupported wakeup promise. | F-14–17; U-M01–02; A-01, A-23 |
| UX-M02 / required | Another client already owns project; owner later expires | Occupied and expired states are distinguishable; reconnect guidance is actionable, no manual disconnect/takeover/roles, no cancellation claim. | F-18–21; U-M03; A-17–18 |
| UX-M03 / required | MCP mutates while UI open, then UI reconnects | Updated state appears automatically, last-known/loading state is honest, and task/result navigation remains project-scoped. | F-13; U-M04; A-20 |
| UX-M04 / required | Human edit invalidates a command; response loss causes retry | Conflict says not applied, retry preserves operation identity and shows original/status outcome; deliberate new action is distinct. | N-03, N-10; U-M05, U-M07; A-13–14 |
| UX-M05 / required | Capability unavailable or quality gate failed | Clear reason and next legitimate action; no global edit control, quality waiver, hidden confirmation requirement or false completion. | F-04, F-12, F-22; U-M06; A-22 |
| UX-M06 / proposal | Keyboard-only, screen-reader and narrow-screen walkthrough | Labeled focusable controls, understandable status/error announcements, non-color cues and usable layout. Review against existing UI patterns rather than assuming reuse is sufficient. | U-M08 |

**Ready for UX planning/design:** project setup, capability/status, occupied/error/conflict/retry and live-sync states are specified; designers may choose layout/copy using the proposed settings placement. **Not ready for final setup copy and end-to-end usability sign-off:** actual adapter installation, transport errors and lease timings need engineering validation. These do not block designing unaffected states. No new product question is needed for routine layout. Escalate only a client integration that cannot meet automatic reaction or a genuine project/global ambiguity, not per-button choices.

Design checklist: map U-M01–08 to screens/flows; account for every state above; include recovery and safe retry; document accessibility/responsive behavior; cross-reference UX-M01–06 and A-01–23; have engineering verify setup copy against the selected adapters. Whole-feature completion additionally requires all required UX cases; proposed layout/accessibility specifics receive explicit design review without weakening functional scope.

### Process-evidence implications from the 2026-09-09 source audit

The [leader source register](../builtin-project-leader/standard-process-source-audit.md) refines result data needed by existing project operations, not MCP authority or transport scope. Result/evidence reads must distinguish historical validity, current reuse/eligibility, candidate identity, attempt outcomes and CI-tested head/merge identity. Missing/unavailable evidence cannot become passed through API normalization. Recovery and integration calls must use actual project/task/target identity and existing service resource enforcement; a model-supplied authority record cannot grant ownership. Keep these fields in the shared contract/UI-action inventory and cover them in A-05, A-10 and A-13–14, coordinated with leader L-A37–43. No new global access, per-operation approvals or release engine is introduced.
