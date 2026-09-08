# MCP server for a single-project leader — requirements draft

Status: **requirements draft; the feature is not implemented**. Date: 2026-09-08.
Audience: product owner and engineering team.
Baseline: Xezar revision `6cd4aaa3605e8bcddf7bafd8f05ac96881ee35cc` and the current repository instructions. This is neither an approved protocol design nor a catalog of existing MCP tools.

Related specification: [Built-in project leader and standard process kit](builtin-project-leader-requirements.md). MCP is an independent capability usable by external clients. The built-in leader is a separate extension that depends on this project-scoped MCP interface; it is outside the implementation scope of this document, not a rejected product feature.

## 1. Goal and value

An external AI model running in an application such as Claude Code, Codex, or a similar client acts as project leader and operates Xezar through MCP. A human continues working in the cockpit. Both use the same state, business logic, rules, and permissions.

The value is end-to-end project coordination without manually clicking through the leader's instructions: organizing work, delegating, responding to blockers, assessing results, and handing work to the next stage. Scope includes **every project action available to the leader in the UI**, including configuration, work organization, and execution management. A “start task / read status” toolset alone does not meet the goal.

One leader manages one project. This MCP specification does not implement a leader inside Xezar or add an autonomous decision-making layer to the server. The separate built-in leader specification defines that extension without making it a prerequisite for external MCP clients.

## 2. Agreement status and actors

- **Agreed**: an external single-project leader, complete project-action coverage, shared UI/MCP state, server-enforced isolation, automatically written local connection configuration, and one-time setup of the leader's client application.
- **Technical proposal**: a suggested implementation of a requirement that still needs a design decision; it is not an approved mechanism.
- **Open**: a product or technical decision that has not yet been made.

| Actor | Responsibility |
| --- | --- |
| Human / project owner | Sets the goal and leader permissions, configures the client, makes reserved decisions, and can take over in the UI. |
| External leader | Owns priorities, scope, dependencies, acceptance criteria, and next-stage readiness; delegates, monitors, answers, and assesses results. |
| Xezar execution agent | Designs, implements, tests, and repairs within its assigned task boundaries. |
| Xezar | Enforces scope and rules, performs business operations, stores state, and exposes it through both interfaces. |
| Leader application / MCP client | Maintains the user-configured connection; it is not the authority that grants project access. |

The role split and separate tasks for successive stages are a reference scenario inspired by a project using the name Cezar. This document does not transfer that project's private content, models, branches, limits, or process rules to all Xezar users. Status-only monitoring during execution is an example project policy, not an MCP prohibition on reading history or changes. The separate built-in leader specification explicitly adopts the complete generalized operating model and standard kit. Its current reference snapshot is provisional; final source audit and extraction are deferred until the user signals readiness, without automatic monitoring.

## 3. Scope and exclusions

Included: project and catalog reads, work planning, task creation and configuration, workflow and agent selection, messages and answers, execution lifecycle controls, variants, task organization, project configuration, project processes, automations available in the UI, results, files, diffs, verification, and stage handoffs. This also covers Git operations and GitHub integration actions available to the leader in the UI, subject to their restrictions.

Excluded: managing multiple projects, their registry, other projects' tasks, global settings affecting other projects, other projects' accounts and secrets, and arbitrary operating-system processes. Implementing the built-in leader is outside **this document's scope** and is specified separately. Adding automatic merge or release is excluded. MCP access itself is not authorization to publish, merge, or perform another action requiring separate permission.

**Full-coverage boundary:** complete equivalence of project actions is required, not equivalence of the entire machine-administration UI. Pure presentation actions, such as scrolling, need no separate tool when equivalent information or operations are available. Excluding a business action merely because its current endpoint is global does not resolve the requirement: it requires the decision described in section 8.

## 4. Functional requirements

“MUST” describes a required outcome; labeled proposals do not prescribe an approved mechanism.

| ID | Requirement |
| --- | --- |
| F-01 | The server MUST bind the leader connection to one project and enforce that scope on every read and write. An input parameter, project alias, or prompt content cannot change the binding. |
| F-02 | The server MUST validate ownership of every resource, including nested identifiers and bulk operations: tasks, groups, messages, files, worktrees, workflows, automations, and their results. A foreign identifier must not cause a read or side effect. |
| F-03 | The leader MUST be able to discover the bound project's identity, effective configuration, available actions, and restrictions without exposing the rest of the workspace. Missing backends, GitHub capabilities, or permissions must have understandable reasons. |
| F-04 | MCP MUST cover every project UI action available to the leader. The coverage matrix is mandatory evidence of completeness; grouping actions into tools, resources, or other MCP capabilities remains a design decision. |
| F-05 | The leader MUST be able to inspect existing workflows and skills, select them for a task, and perform project-scoped management actions offered by the UI. Do not invent skill CRUD operations that the UI does not offer. |
| F-06 | The leader MUST be able to create tasks with all project options of the UI form, including prompts and supported attachments, workflows, runners/models, variants, autonomy, and isolation. Validation and defaults are shared with the UI. The separate built-in leader's text-only first release does not reduce this MCP parity requirement. |
| F-07 | The leader MUST be able to organize work to the extent supported by the UI: inspect the queue, edit queued briefs and messages, change metadata, pin, archive, restore, delete, and manage Inbox items and variants. A need for new dependency or priority mechanisms does not mean those mechanisms already exist. |
| F-08 | The leader MUST be able to control task execution processes as the UI allows: start, cancel, finish, continue, and manage automatic resumes within the available scope. Controls must target processes belonging to the project; a generic “kill PID” operation does not meet that boundary. |
| F-09 | The leader MUST receive status, progress, questions, blockers, errors, and results. It MUST be able to answer, supplement a brief, and continue according to session state. A decision reserved for a human cannot be replaced by a model's answer. |
| F-10 | The leader MUST be able to assess completed results: read summaries, history, test evidence, files, diffs, commits, and PR/CI state available in the UI. Assessment must identify its revision; missing or stale evidence must be recognizable. |
| F-11 | The leader MUST be able to hand work onward through existing UI operations: feedback and continuation, variant selection, a new next-stage task, and commit/push/draft PR where authorized. Do not require a nonexistent review gate: the current gate is optional and autonomous runs skip it. |
| F-12 | The leader MUST be able to read and change its project's configuration to the same extent as the UI. Responses must distinguish local values, inherited values, and globally imposed limits. Changing a global source to affect one project is prohibited. |
| F-13 | Humans MUST see leader actions' effects in the UI and be able to continue the same work. MCP must see subsequent human changes; there must be no second store of tasks, configuration, or decisions. |
| F-14 | Xezar MUST automatically write local connection configuration inside the bound project's `.ai/xezar/`. The user configures the leader application once to use it. Not all applications automatically discover that file. Its name, format, and creation trigger remain open. |
| F-15 | Connection data must not require pasting into chat. Any credentials remain local and outside Git; they must not enter history, tool responses, or event logs. |
| F-16 | The server MUST reject unavailable and global actions even when a client knows their names or direct resource identifiers. Filtering the tool catalog does not replace execution authorization. |

## 5. Nonfunctional requirements

| ID | Requirement and assessment |
| --- | --- |
| N-01 | Isolation covers responses, errors, events, pagination, search, file paths, and side effects. An inaccessible resource must not reveal another project's name, content, or existence. |
| N-02 | UI and MCP operations use shared business rules, authorization, resource limits, locks, and state transitions. MCP must not write directly to JSON/NDJSON while bypassing services. |
| N-03 | Concurrent human/leader work must not silently lose changes or accept operations against an outdated state. **Proposal:** record versions or expected revisions on mutations, with a conflict response allowing a fresh read. |
| N-04 | History should identify the action, time, project, resource, outcome, and UI/MCP origin without storing secrets. The identity model and audit retention remain open; source attribution must not bypass permissions. |
| N-05 | Client disconnection must not lose or accidentally cancel a task. On reconnection, the leader reads current state and outstanding information; every long-running operation has an identifiable state and completion. |
| N-06 | Reads have size limits, pagination, or ranges, especially for history, diffs, and files. **Proposal:** observe changes using a cursor and bounded wait rather than frequently fetching full histories. Numeric limits require measurements and a decision. |
| N-07 | MCP must not block ordinary cockpit startup. Deleting recoverable connection state or lacking a client must degrade to a working Xezar. Do not require a new manually maintained file, database, or fixed port. |
| N-08 | Implementation preserves existing state, API, and agent-protocol compatibility. New persisted fields follow repository compatibility rules; upgrades must not break project binding or expand permissions. |
| N-09 | Tasks, files, and results are data, not sources of authority. Neither prompt injection nor instructions from another project can change the server-side connection scope. |
| N-10 | **Technical proposal requiring approval:** retrying the same mutation after losing its response must not create a second task, PR, or other effect. Consider an idempotency key bound to project, operation, and payload, with result lookup; retention and restart behavior remain open. |

## 6. UI → MCP coverage matrix

This is an **initial inventory of operation families from code**, not proof of completed coverage of every control. Function names are search anchors in the linked files. “Required equivalent” describes an outcome, not an approved MCP tool name.

Sources: [UI client](../packages/web/src/api/client.ts), [UI queries and mutations](../packages/web/src/api/queries.ts), [routing](../packages/web/src/routes.tsx), [settings registry](../packages/web/src/routes/settings/registry.tsx), [server](../packages/xezar/src/server/server.ts).

| ID | UI action/family and code evidence | Required MCP equivalent | Boundary / mapping status |
| --- | --- | --- | --- |
| M-01 | Task lists/details: `getRuns`, `getRun`, `getRunHistory`, `getRunHistoryContext` | List, filter, and read tasks, history, and current state | Bound project only; global `getRunsIndex` must not leak into MCP. |
| M-02 | New task form: `createRun`, `postPlan`, [new-task](../packages/web/src/routes/new-task.tsx) | Plan and start with every form option | Further audit of each field and default required. |
| M-03 | Sessions: `sendMessage`, `continueRun`, `editQueuedMessage`, `removeQueuedMessage`, [task-thread](../packages/web/src/routes/task-thread/task-thread.tsx) | Questions, answers, continuation, and queued-message editing | Session state and authority to answer shared with UI. |
| M-04 | Controls: `cancelRun`, `finishRun`, `cancelAutoResume` | Same task-process transitions | Cancel and Finish are not substitutes for resource scheduling; no arbitrary PID. |
| M-05 | Organization: `patchRun`, `pinRun`, `archiveRun`, `archiveFinished`, `deleteRun`, seen/unseen actions | Metadata, pins, archives, deletion, read state | Audit shared user-state semantics; bulk actions remain project-local. |
| M-06 | Inbox: `getTodos`, `startTodo`, `removeTodo` | Read, execute, or remove an item | Preserve current availability and feature flags. |
| M-07 | Variants: `getGroup`, `pickVariant` | Compare and choose a result | Every run in the group must belong to this project. |
| M-08 | Results: `getRunDiff`, `getRunChanges`, `getRunFile`, `getRunCommits`, `getRunCommit`, `getRunHandoff` | Completed artifacts and evidence identified by revision | Validate paths, limits, media, and worktree boundaries. |
| M-09 | Task Git: `commitRun`, `pushRun`, `createRunPr` | Commit/push/draft PR equivalents | No new publishing privileges; identify task and revision in results. |
| M-10 | Project Git: `getRepo`, `getRepoChanges`, `getRepoCommit`, `createRepoBranch` | Inspect and perform project branch operations | Main-checkout operations respect existing locks. |
| M-11 | GitHub: `getGithub`, `getGithubSearch`, `getGithubComments`, `getGithubChecks`, `getGithubPrChanges` | Issues/PRs, comments, changes, and CI | Resolve the GitHub repository from the bound project, not arbitrary input. |
| M-12 | Existing `getGithubPrMergeState`, `mergeGithubPr` | Manual merge scope requires D-07 | Do not add automatic merge. Do not hide this row while claiming full coverage. |
| M-13 | Workflows: `getWorkflows`, `createWorkflow`, `parseWorkflow`, `deleteWorkflow` | Catalog, validation, saving, and deletion | Preserve built-in workflow rules and YAML limits. |
| M-14 | Skills: `getSkills`, `getImportableSkills`, `refreshSkills`; `getSkillsUpdate`, `checkSkillsUpdate`, `applySkillsUpdate` | Catalog and project actions available in UI | A shared catalog update may be global despite projectId; D-03. |
| M-15 | Configuration: `getConfig`, `putConfig`; Agents, Worktrees, Prompt templates, Bookmarklets sections | Read/change project settings | A field-level matrix is required; do not expose connection secrets. |
| M-16 | Agent files: `getAgentConfig`, `getAgentConfigFile`, `putAgentConfigFile`; profile choice `selectAgentProfile` | Project-bound configuration and selection | A project UI route can open a home-directory file; assess actual effects, not just API paths. D-03. |
| M-17 | Worktrees: `getWorktrees`, `reclaimWorktrees`, `removeRunWorktree` | Inspect and clean worktrees | Project only; same active-work protections. |
| M-18 | Automations: `getAutomations`, `createAutomation`, `updateAutomation`, `setAutomationEnabled`, `checkAutomation`, `getAutomationCheck`, `getAutomationLog` | Project schedules, checks, and results | Checks/logs need a project owner even behind an unscoped endpoint. |
| M-19 | App handoff: `openRunInCli`, `openRunIn`, `openRunFileInApp`, `openProjectIn` | Equivalent handoff in supported environments | Explicitly report unavailable desktop capability; do not promise launching UI on the MCP client's machine. |
| M-20 | Layout/organization: `getUiState`, `putUiState`, `getWorkspaceUiState`, `putWorkspaceUiState` | Semantic project organization available to the leader | Do not copy global preferences or require one tool per gesture. Audit separates data from presentation. |
| M-21 | Global Resources, Accounts, Projects, Appearance, Notifications, and Skills settings | No global equivalent for the project leader | Global mutations and foreign data excluded; only safe effective project constraints allowed. |
| M-22 | Provider connect/enable/retry and account create/edit/delete | Separate effects; shared administration excluded | No global login sessions or account files for the leader; D-03. |

### Closing the inventory

Before approving the solution design, inspect all active UI routes and components, context menus, shortcuts, forms, bulk operations, and error states. A client export alone proves neither a visible action nor complete UI coverage; inspect call sites, direct requests, and browser-local state.

Every action needs a record with: UI source and symbol, availability conditions, inputs/outputs, rules and required permission, actual effect scope, MCP equivalent, test ID, and status “covered / global / presentation / open decision”. Split M-01–M-22 wherever rules differ. Product and engineering approve the inventory; an unresolved project action prevents a full-parity claim.

## 7. Reference scenarios

### S-01: connection and human collaboration

1. Xezar creates local connection configuration for project A in its `.ai/xezar/`.
2. The user points the leader application at this connection once, following client-specific instructions. Connection data is not pasted into the conversation.
3. The leader reads A's server-confirmed identity, configuration, and capabilities. It cannot switch to B.
4. The leader chooses a workflow and starts a task; a human sees it in the UI, adds a requirement, and the leader reads that same change.

### S-02: staged delivery

The leader creates separate tasks: triage → business analysis → plan/specification → implementation → verification → draft PR → review → corrections. This is a reference process, not a mandatory workflow for all MCP users.

Each brief states the goal, scope, constraints, acceptance criteria, dependencies, and expected output. The leader selects an existing workflow; the execution agent chooses solution details. During execution the leader monitors status and responds to questions and blockers. After completion it reads the result and evidence for a specific revision, checks acceptance, and starts the next stage or a correction task. A revision change invalidates the assumption that previous evidence covers the current result. The review stage is distinct from the engine's optional `review` status.

### S-03: scope escape attempt

Leader A supplies a B task ID, a B message ID inside task A, a foreign automation result ID, or a path escaping the resource. The server rejects access before reading or mutating. A changed project parameter, `default` alias, cursor, URL, or symlink cannot change scope. Project B's UI and state remain unchanged.

### S-04: conflict and connection loss

A human finishes or changes a task after the leader reads it. The leader's stale command is revalidated, and its response allows a fresh state read. After losing a task-start response, the leader must be able to determine the outcome; proposal N-10 would allow retrying the same intent without a second task. Conflict and idempotency details remain open.

## 8. Technical boundaries in the existing architecture

- The [HTTP server](../packages/xezar/src/server/server.ts) exposes `/api/v1` and project routes `/api/v1/p/:projectId`. Route scope is not proof of MCP authorization. The server derives project identity from a trusted connection binding; it must not forward an arbitrary `projectId` to a global API client.
- [ProjectContext](../packages/xezar/src/server/project-context.ts) joins the repository, RunStore, RunManager, and AutomationStore. **Proposal:** an MCP adapter invokes shared service operations with a narrowed context and resource checks. An HTTP-based alternative needs equivalent authorization; a proxy to every route is insufficient.
- [RunManager](../packages/xezar/src/workflows/run.ts), [RunStore](../packages/xezar/src/runs/store.ts), and [WorkspaceSemaphore](../packages/xezar/src/workspace/semaphore.ts) retain ownership of task lifecycle, state, and limits. MCP adds neither a second queue nor its own agent-process controller. Cover new tasks, Continue, and restart recovery.
- [Zod contracts](../packages/contract/src/index.ts) and [validators](../packages/xezar/src/server/validators.ts) anchor shared shapes and rules. Placement of MCP-specific schemas remains open. Any new HTTP API preserves the contracts, middleware, versioning, and chained route registration required by AGENTS.md.
- [Global UI events](../packages/web/src/api/global-events.tsx), [task SSE](../packages/web/src/api/run-events.ts), and [WebSocket](../packages/xezar/src/server/ws.ts) update the cockpit. MCP should use the same state source after project filtering. An unfiltered workspace stream is prohibited. MCP client notification transport remains open.
- The [UI settings registry](../packages/web/src/routes/settings/registry.tsx) separates project/global sections, but a section URL does not determine all effects. `agent-config` includes home files; accounts, resource limits, model locks, and skill updates can affect more than one project.
- **Proposal for shared settings:** expose safe effective values and their origins; add a project override only where it can actually be enforced without changing B. Other changes go to a human administrator in the UI. Overrides are not an approved implementation yet. A field inventory must establish whether this meets complete project coverage.
- [Paths](../packages/xezar/src/paths.ts) and [CLI startup](../packages/xezar/src/index.ts) are integration points for the connection file and Git ignore maintenance. State must be recoverable and written without exposing secrets. File presence or location alone is not a security boundary.
- The [agent protocol](../AGENT_PROTOCOL.md) describes execution backends; leader MCP is a separate control interface. It requires no new execution backend. Exposing MCP does not itself start a model inside Xezar. The built-in leader's runtime is specified in the companion document and consumes this interface.

The hard boundary covers MCP server authority and the operations it exposes. It is not whole-machine isolation: an external application may have its own tools, and execution agents may have broad shell access. Those processes' permissions require separate description; MCP must not promise a sandbox that existing runners do not provide.

## 9. Whole-feature acceptance criteria

**O — obligatory** criteria follow from agreed project coverage, isolation, shared state, and local connection setup. They describe behavior independently of transport. **P — proposed for approval** criteria specify additional engineering guarantees and must not be presented as product-owner-approved. Record their disposition and link accepted proposals to the implementation plan.

Shared fixture: projects A and B, separate tasks, groups, messages, workflows, files, and automations; leader client bound to A; human UI; controlled backends without personal accounts. Before isolation tests, record B's state and external effects. Afterwards inspect responses, events, leader-visible logs, and B's unchanged state. Checking an error code alone is insufficient.

| ID / status | Given | When | Then / evidence | Traceability |
| --- | --- | --- | --- | --- |
| A-01 / O | Xezar runs for A; no local connection configuration exists. | Follow the agreed connection provisioning and one-time setup for every officially supported client. | Xezar writes configuration into A's `.ai/xezar/`. The client accesses A without manually authoring connection data or pasting it into chat. Instructions distinguish the one-time user step and do not assume autodiscovery. Evidence: each client setup and local-file inspection. | F-14–15; D-01, D-02, D-04 |
| A-02 / O | Connection bound to A; B contains identifiable resources. | Read A's identity, then supply B through a parameter, alias, or call content. | Legal A access works. No variation changes scope, reveals B, or acts on B. Server rejection also works with a custom client. | F-01–03, F-16; all M |
| A-03 / O | Valid B IDs and mixed A/B resource lists are known. | Perform single/bulk reads and mutations, including B message inside A task, foreign run in a group, and B automation result ID. | Server validates every resource and relationship before access. B's data/state remain unchanged; no response reveals a foreign resource's existence. Partial-success policy for allowed items is explicit. | F-02, F-16, N-01; M-01, M-03–08, M-17–18 |
| A-04 / O | A/B have distinct files/history; large lists and events exist. | Search, paginate, supply foreign cursors, absolute/`..`/symlink paths, and request workspace events. | Every returned item belongs to A and an authorized resource. No B content, names, metadata, or secrets appear in results, errors, or streams. Forbidden paths are rejected. | F-01–03, F-16, N-01; M-01, M-08, M-11, M-18 |
| A-05 / O | Every UI action inventoried; D-03 and D-07 resolved. | Exercise UI and MCP counterparts from equivalent starting states, covering form fields, permissions, and unavailability conditions. | Equivalent business outcomes, defaults, rules, validation, and effects. Each matrix record links a test and evidence; no project action is unmapped. Start/status success alone is insufficient. | F-04–12; M-01–22 |
| A-06 / O | At least two workflows, task options, queued tasks, and variants exist. | Through MCP choose workflow/runner/model, create a task, edit its queued brief, organize tasks, and compare/select a variant. | Options behave as in UI, changes appear in the relevant views, and winner/other-variant effects follow product rules. | F-05–07, F-13; M-02, M-05–07, M-13–14 |
| A-07 / O | A has queued, running, waiting, and completed tasks; B also runs a task. | Exercise all controls, answer a question, edit a message, continue a closed session, and attempt an invalid transition. | Effects match UI; invalid transitions leave state unchanged. The correct question receives the answer, A controls do not stop B processes, and no unrestricted host-process control exists. | F-08–09, F-16; M-03–04 |
| A-08 / O | Human UI and leader connection both target A. | Leader creates/modifies a task; human answers and changes configuration in UI; leader reads and continues. | Both operate on the same task/configuration, see each other's effects, and can take over. No MCP-only duplicate history or configuration exists. | F-13, N-02; M-01–05, M-15 |
| A-09 / O | Known local A and global A/B values; agent config files have different scopes. | Change A's setting, then attempt global-source, home-file, shared-account, or limit changes through the project interface. | Authorized A changes appear in UI; B is unchanged. Global actions are rejected or require separate human action outside leader authority. Safe effective values and restrictions follow the approved field matrix. | F-12, F-16; M-14–16, M-20–22; D-03 |
| A-10 / O | Completed task has summary, changes, and test evidence for a specific SHA. | Read result, files/diff, commits, PR/CI through MCP and send feedback or create a next-stage task; repeat after SHA change and with missing evidence. | Same data as UI; assessment revision is identifiable. Missing/stale evidence is recognizable; the next task references the assessed result. `done` alone is not proof of passing tests. | F-10–11; M-08–11 |
| A-11 / O | Leader permissions and human-reserved actions, including publication, are defined. | Invoke an allowed action, one requiring approval, and a forbidden action directly despite catalog hiding. | MCP respects UI rules and does not expand authority. A model answer does not execute a human-reserved decision. Human approval permits policy-compliant continuation. No automatic merge/release is added. | F-09, F-11, F-16; M-09, M-12, M-19; D-07–08 |
| A-12 / O | Connection configuration has local data and any credential; B has different data. | Exercise startup, errors, tools, events, and history; inspect Git and leader-visible outputs. | No connection data enters chat, no secret enters history/responses/logs, and the file is effectively excluded from Git. B information is not exposed. | F-15, N-01; D-02, D-04 |
| A-13 / P | Human changed a task after leader's last read. | Leader submits a command based on old state. | Approved conflict mechanism rejects or safely reconciles the stale mutation without losing the human change. A fresh read is possible; evidence includes concurrent calls. | N-03; M-03–05, M-15; D-06 |
| A-14 / P | Server executed a mutation but client lost its response. | Retry the same intent; also test restart and changed payload under agreed key-retention rules. | After N-10 approval, one effect exists, such as one task or PR; original result is readable. Different payload under the same key has an unambiguous outcome without an accidental duplicate. | N-10; all mutations, especially M-02, M-09, M-18; D-06 |
| A-15 / P | Task runs, history is large, client disconnects and returns. | Reconnect, retrieve missed information, exceed agreed limits, and exercise an unavailable backend. | Disconnect does not lose/cancel the task. Monitoring consumes no execution-agent slot. Results/latency obey agreed limits; errors/cursors permit bounded recovery. | N-05–06; M-01, M-03–04, M-08; D-05, D-09 |
| A-16 / P | Client absent or recoverable MCP state deleted/corrupt; older Xezar tasks/sessions exist. | Start/restart Xezar, upgrade, and recover configuration using the agreed procedure. | Ordinary cockpit still works; old data/sessions remain compatible. Recovery neither expands permissions nor rebinds A to B. Audit identifies actions without secrets. | N-04, N-07–08; D-02, D-04, D-06 |

Implementation tests should use isolated data and `XEZ_DRY_RUN=1`, without personal accounts or secrets. Real MCP clients and agreed transports need separate integration validation. This documentation change does not run those tests or claim these criteria have passed.

### Whole-feature Definition of Done

The feature is **complete across the entire agreed scope** only when all of the following hold:

1. Every UI business action has a final matrix record and product-owner-approved classification; every project action has a working MCP equivalent. Coverage is measured against this inventory, not tool or endpoint counts. No unresolved project action may remain in a full-coverage claim.
2. All O criteria (A-01–A-12) pass on **the same release-candidate revision**. Evidence identifies SHA, fixture configuration, client, scenario, and result. `Skipped`, old-revision evidence, and model assertions alone are not passes.
3. Product and engineering explicitly resolve P criteria (A-13–A-16). Accepted proposals become release gates and must pass; rejected/deferred ones have recorded reasons and limitations. Server isolation, complete project scope, and shared state cannot be deferred this way.
4. D-01–D-09 are resolved as needed for the released version. Documentation states the actual transport, startup method, connection file, supported clients, authorization model, limitations, and setup without secrets in conversation.
5. The settings-field matrix removes project/global ambiguity. Engineering proves A operations do not affect B through accounts, skills, or files. Negative tests cover each resource family, not just `projectId`.
6. Demonstrate the complete human/leader flow: configuration → delegation → question/answer → completed result with evidence → next stage or corrections → further UI work. No global administration, automatic merge/release, or built-in leader implementation is hidden in this MCP deliverable. The companion leader feature has its own acceptance gate.
7. Implementation meets the repository quality gate in [AGENTS.md](../AGENTS.md) and [SDLC.md](../SDLC.md); MCP integration tests and UI/MCP evidence are reviewable. This applies to future implementation, not builds for this documentation change.
8. Product approves leader-action coverage and the responsible engineer approves technical evidence. Known limitations contradict no obligatory criterion.

## 10. Open decisions

| ID | Decision | Constraint / proposal |
| --- | --- | --- |
| D-01 | MCP transport, protocol version, library, process model | stdio, HTTP, and startup method are not selected. Compare client compatibility, Xezar startup integration, recovery, and avoiding a mandatory daemon. Consult current official specifications before choosing. |
| D-02 | Authentication, project binding, revocation, reconnection | Mechanism undecided. Binding is server-enforced across restart; changing file/parameter cannot redirect existing authority. Define project removal, relocation, and re-registration behavior. |
| D-03 | Local/inherited/shared settings matrix | Resolve accounts/project profile, agent-config, models, limits, skills, and UI state; approve overrides or explicit administrative boundaries. Required for full coverage, not a post-launch detail. |
| D-04 | Connection file and client adapters | Name, format, generation timing, port-change updates, distribution, installation integration, client list, and one-time instructions remain open. No universal autodiscovery assumption. |
| D-05 | Tools, reads, and observation granularity | Derive from the completed UI matrix; not one button = one tool. Define errors, pagination, media, cursors, and capability discovery. |
| D-06 | Conflicts, idempotency, audit | Approve or revise N-03/N-10; define leader identity, retention, limits, and crash behavior. |
| D-07 | Existing manual UI merge | Decide whether/how the leader may invoke it under existing authority. Full coverage requires an explicit decision; current scope does not authorize adding automatic merge or release. |
| D-08 | Human approvals and local applications | Define waiting/resumption after a decision using UI permissions; missing desktop capability must not appear as a successful handoff. |
| D-09 | Operational limits and feature exposure | Establish measurable latency, size limits, and startup policy. Network/process expansion respects repository opt-in rules; no new flag or name has been selected. |

## 11. Ready-for-implementation gate

Product approves scope boundaries, exceptions, and the approval process. Engineering closes the UI inventory, actual project/global effects, and transport/security design. Every requirement has assigned evidence, and isolation/completeness-critical decisions are resolved. Only then should an implementation specification assign tool names, the connection filename, and startup commands.
