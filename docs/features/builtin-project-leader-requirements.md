# Built-in project leader and standard process kit — requirements draft

Status: **requirements draft; the feature is not implemented**. Date: 2026-09-08.
Audience: product owner, product designer, and engineering team. This document records agreed outcomes, technical implications, proposals, and unresolved implementation decisions. It is not a claim that current backends or browser APIs already meet them.

**Reference-baseline status: deferred, awaiting the user's readiness signal.** The reference project is still being refined. The observations below are a provisional snapshot, not a final inventory of the complete transfer. Do not perform a further full source audit, extract the final kit, or automatically monitor the reference repository until the user explicitly says it is ready. This does not block completion of these requirements documents.

Dependency: [MCP server for a single-project leader](mcp-project-leader-requirements.md). MCP remains independently usable from native external applications. This feature adds a Xezar conversation and managed leader lifecycle that use the same project-bound MCP operations. It does not replace MCP or expand its authority.

Technical evidence: [local MCP client compatibility](mcp-client-compatibility.md), researched 2026-09-08. Latest decisions below supersede earlier approval and proposed-idempotency wording.

## 1. Product goal and boundaries

A user can work with an AI project leader inside Xezar, while choosing Claude Code, OpenCode, or Codex as the tool that runs the leader and selecting its model. The leader coordinates one project's work through MCP: plans, delegates, observes execution status, answers within its authority, evaluates completed results, and advances the process. Execution agents do the design, implementation, testing, and repair.

Xezar supplies one consistent conversation UI rather than embedding the original tools' interfaces. Recreating every native-client feature is unnecessary: users can independently connect a native application to the MCP interface. The first release supports text only, without attachments. It works in the browser on desktop and phone; a native mobile application is outside scope.

The product also ships a complete standard process kit with **every Xezar installation**. It must carry forward the entire reference way of working across Xezar, not just the leader or the current workflow/skill catalog: operating rules, maintained guidance, checks/guards, settings, context and evidence practices, recovery, shared-resource coordination, updates, catalog integrity, and compatibility. These are generalized for other repositories after the user releases the final reference baseline. Adding a project triggers autonomous repository analysis and adaptation of that kit without asking for approval at every adaptation step. Over time, the leader improves the project kit from observed outcomes while preserving mandatory quality and acceptance boundaries.

Not included: a multi-project leader, unrestricted machine administration, new release/publishing functions beyond existing project UI actions, native client UI embedding, attachments in the first leader UI, or a promise that background execution survives a stopped Xezar environment. Restart behavior for execution-agent processes is explicitly unresolved.

## 2. Agreement and ownership

- **Agreed requirement:** an outcome or boundary explicitly selected by the product owner. Implementation must meet it; technical choices remain open unless stated otherwise.
- **Technical implication:** an engineering consequence necessary to deliver an agreed outcome. The document identifies the required effect without pretending that a mechanism is already approved.
- **Proposal:** an implementation or additional guarantee requiring approval.
- **Open decision:** an unresolved product/technical choice; no assumed answer is authorization.

| Actor | Owns | Does not gain by implication |
| --- | --- | --- |
| Human project owner | Goal, Definition of Done (DoD), permissions, project executor rules/model allowlists, goal/DoD decisions, pause/resume, business acceptance | A notification or unanswered question is never implied approval. |
| Project leader | Priorities, scope within approved boundaries, dependencies, task acceptance criteria, workflow selection, executor selection, phase readiness, process improvement | Global administration or weakening mandatory quality/acceptance. Existing project UI merge/publication/deletion is autonomous; green status is still not business acceptance. |
| Execution agent | Technical design, implementation, meaningful tests, diagnosis, and repair within the brief | Permission to silently change the goal, lower acceptance, or substitute a draft PR for completion. |
| Xezar | Shared UI, durable conversation/plan state, project-scoped MCP, lifecycle controls, notifications, process-kit availability and history | Business authority that the user has not granted. |

## 3. Agreed functional requirements

| ID | Requirement |
| --- | --- |
| L-F01 | Provide one leader for one project through local-only project-bound MCP. Built-in and native clients compete for the same single logical client ownership; UI remains concurrent. A second client gets an occupied-project error. No manual disconnect UI is added. |
| L-F02 | At leader startup the user selects its tool (Claude Code, OpenCode, or Codex) and model. Xezar offers a consistent conversation interface, not an embedded copy of the vendor UI. |
| L-F03 | Restrict leader selection to a maintained list intended for models with the strongest reasoning capabilities. Xezar maintains the list and the user can edit it manually. Availability validation and the source/ranking policy remain open. |
| L-F04 | Provide a side panel that can be maximized, with responsive browser layouts on desktop and phone. Version one accepts text only and has no attachments. |
| L-F05 | Keep one persistent leader conversation per project, combining human conversation and task coordination. Hiding, maximizing, navigation, and reconnecting do not create another conversation or lose decisions. |
| L-F06 | Whenever the leader needs a decision or clarification, it ALWAYS presents a structured question with selectable options and a custom-answer entry, similar in interaction to AskUserQuestion. Behavior is uniform across supported backends; a prose question alone is insufficient. |
| L-F07 | A question produces an in-Xezar indicator and a system notification where supported and permitted, plus an optional subtle sound. Clicking the indicator/notification opens that specific question. Browser permissions, platform restrictions, and closed-page delivery must be validated; unsupported delivery must not be promised. |
| L-F08 | While Xezar runs and the leader is active, process significant pushed events and advance work even with the conversation closed. Do not continuously poll status/UI through model turns. Software receives events and independently schedules a model reaction; see MCP E-01–06. |
| L-F09 | An unanswered question blocks only work depending on that decision. Independent work continues; silence is not consent, cancellation, or a reason to stop the whole project. |
| L-F10 | Manual leader pause stops its new delegations and automatic decisions. Already started execution agents continue; stopping them is a separate UI action. Their results and questions remain available, and the human can continue using Xezar. |
| L-F11 | After a Xezar restart, the leader does NOT resume automatically. It waits for explicit manual resume, preserving conversation, decisions, and plan state. This requirement does not specify what happens to execution-agent processes during server restart. |
| L-F12 | After every resume, first reconcile current project context: changed task/project state, results, outstanding questions, and human actions. Only then may the leader decide or delegate again. |
| L-F13 | Project planning modes: A — propose plan and obtain approval before execution (default); B — autonomously decompose an agreed goal and delegate. Within approved goal/DoD, all existing project UI actions, including delete/merge/publication, are autonomous. Neither mode adds new release functions or bypasses quality. |
| L-F14 | After approval, revise the technical plan autonomously within approved goal and DoD. Leaving those boundaries requires a structured question. Routine technical changes do not. Changing goal/DoD is never a way to waive mandatory quality or weaken acceptance criteria. |
| L-F15 | Executor selection follows rules maintained separately for each project and a user-configured allowlist of tools/models. Rules and allowlists govern execution-agent choices independently of the leader model list. |
| L-F16 | With no matching project rule, choose primarily by complexity/difficulty: stronger reasoning for harder work, lighter models for simpler work. An imperfect fit does not trigger a question or block progress; select the closest suitable available, allowed executor. Total unavailability is an unresolved failure case, not an instruction to run without an executor. |
| L-F17 | When an executor fails, the leader may reassign the work to another executor within the approved goal and DoD. Preserve failure evidence; reassignment does not imply permission to weaken checks or expand scope. |
| L-F18 | Ship the complete standard kit with every installation, covering every role and practice in the future user-released baseline. The provisional snapshot below contains 11 workflow roles and 13 skill roles, associated settings responsibilities, checks, and operational practices; these counts are not a final upper bound. This is not an optional plugin or a selective subset. |
| L-F19 | On project addition, autonomously inspect the repository and adapt the kit to its branches, packages, toolchain, commands, policies, and constraints without per-change approval. Do not transplant private content or Daxko-specific assumptions. Unsupported or ambiguous requirements must be represented honestly rather than replaced with fabricated commands. |
| L-F20 | Over time, the leader analyzes results and chooses when improvements are useful. Improvement is not triggered by a prescribed schedule or fixed task counter. It may optimize project workflows, skills, and settings within authority. |
| L-F21 | Weakening mandatory quality controls or acceptance criteria is PROHIBITED, not an option to request approval for. Repair the solution or report a blocker. Preserve correctness, security, maintainability, meaningful tests/review and acceptance evidence; optimize time/cost only while maintaining quality. |
| L-F22 | Workflow changes affect subsequent tasks only. Already launched tasks complete on their selected version. Versioning must also cover referenced skills/settings/check definitions sufficiently to prevent changing the meaning of an in-flight workflow. The precise snapshot boundary is an open technical decision. |
| L-F23 | Keep process-change history with a short rationale and provide rollback. Reverting does not erase the audit trail or rewrite the versions already used by tasks. |
| L-F24 | A Xezar update delivers a newer standard kit; the leader adapts it while preserving local improvements. Conflicts must be surfaced and handled explicitly; the merge/versioning algorithm is open. |
| L-F25 | Monitor execution through significant status/milestone events, not continuous model polling or live code/transcript review. React to questions, blockers, dependency conflicts and completed evidence; use MCP E-01–06 and ignore presentation/log/token noise. |
| L-F26 | Writing workflows preserve the sequence preflight → setup → work/implementation → readiness → quality gates → evidence → handoff. Analysis, specification, review, and corrections have independent workflow roles; use the appropriate workflow rather than treating every request as implementation. |
| L-F27 | Use one authoritative project quality definition. Evidence binds exact revision AND content; subsequent changes invalidate it. Passed, failed and not-run remain distinct. Draft PR is not business completion; existing merge/publication is already within autonomous project capability, still subject to validation and quality. |
| L-F28 | Preserve the accepted bounded-repair rules: a workflow returns to its repair step at most **two times** after failed gates; the quality-gate skill allows at most **two repair attempts for the same failure**, then reports with evidence. No global leader-wide numeric limit covering executor changes has been agreed. |
| L-F29 | Reuse existing workflows/skills first. Use a focused brief for a one-off need; introduce a permanent skill/workflow only for a distinct repeatable need not already covered. Briefs state outcome, acceptance, boundaries, and dependencies and reference maintained documentation. |
| L-F30 | Completed handoffs identify outcome, task, phase, revision, relevant PR, passed/failed/not-run checks, unmet criteria, blockers, and evidence links. Keep compact checkpoints sufficient for continuation; inspect relevant failure excerpts and reuse evidence only while it remains valid. |
| L-F31 | Cover the complete reference operating model across the whole Xezar work process, not only the embedded leader or W/K catalog. Every identified practice must map to a generic capability/process, project adaptation, and verification evidence. Intentional deviations require an explicit user decision; no silent omission is permitted. |
| L-F32 | Defer the final source baseline, full re-audit, and complete practice extraction until the user explicitly signals that the reference is ready. Do not automatically monitor it. Preserve existing observations as provisional; requirements documentation may be completed while this dependency remains deferred. |
| L-F33 | At leader startup Xezar MUST supply a base role instruction covering identity, duties, exclusions, autonomy, quality, delegation, events and structured questions. It MUST apply after every resume. User may customize it per project; the leader MUST NOT edit its own role instruction in MVP, including through settings/file tools. This exception is excluded from autonomous kit/settings adaptation. Server enforcement is independent of prompt text. |
| L-F34 | Honor the shared MCP contract: one local logical owner/project with non-model liveness and stale-owner fencing; task survival on disconnect; mandatory rejection of stale writes followed by fresh read; operation-key idempotency; replay/current-state reconciliation; automatic UI updates and event-driven model reaction. |
| L-F35 | Project settings may be changed; shared settings may only expose needed effective capabilities/limits, without secrets or foreign project/account identities. No global account, limit or home-file administration. Executor model allowlists are scheduling rules, not per-operation MCP permission roles. |

The product owner's examples **Opus 5, Fable 5, Fable 5.1, and GPT 6 Astra** express the intended leader-model class. They are not verified provider model IDs, availability statements, or comparative benchmark rankings. No current SDK, transport, or model support is established by these examples. Compatibility discovery and model-list maintenance require L-D02.

## 4. Conversation, decisions, and lifecycle

### Decision interaction

A structured question must be identifiable and linked to the affected goal/plan/tasks. The UI shows options and always permits a custom answer. Answering resumes only the work that was awaiting that answer; stale, superseded, already answered, and unavailable questions need a clear state. These are technical implications of a durable conversation, targeted notifications, and dependency-only blocking, not a selected question schema or SDK.

A model emitting an ordinary question must not silently bypass the structured-question requirement. **Proposal:** normalize backend question events or model output into one validated question record. The feasibility and reliable enforcement for each backend require a prototype; native AskUserQuestion support must not be assumed.

System notifications are an agreed intent with environmental constraints, not a promise of universal browser delivery. The in-app indicator remains the dependable in-Xezar route. Record supported operating systems/browsers, permission-granted/denied cases, focus behavior, background-tab behavior, sound restrictions, and whether a fully closed page can be reached. Push infrastructure or service workers have not been selected.

### Observable leader states and transitions

The following are behavioral states for specification, not finalized storage enums. Every state must have an explicit exit; no hidden timer may be the only way to continue.

| State / condition | New decisions and delegations | Existing executors | Exit / required behavior |
| --- | --- | --- | --- |
| Not started | None | Independent of leader startup | User selects tool/model and starts. |
| Active | Allowed within permissions and approved goal/DoD | Continue under Xezar task rules | New events/messages, question, manual pause, or environment stop. |
| Waiting on one decision | Block only dependent work; independent work remains active | Independent executors continue; dependent launches wait | Valid human answer or a human change that resolves/supersedes the dependency. |
| Manually paused | None from the leader after pause takes effect | Continue; stopping them requires separate action | Explicit manual resume, then reconciliation. Results/questions accumulate. |
| Restarted, awaiting resume | None; never auto-start leader reasoning or delegation | Restart behavior for executor processes remains open | Explicit manual resume, then reconciliation. Persisted conversation/plan retained. |
| Reconciling after resume | No new automatic decision or delegation yet | Subject to current Xezar task state | Read current context and human changes, resolve discrepancies, then become active or ask a structured question. |
| Backend unavailable | No successful reasoning can be assumed | Do not claim their state changed merely because the leader backend failed | Recovery/reselection/error handling to be decided; show current truth rather than false progress. |

Closing the leader panel is not pause. Closing a browser is not a server restart. A server restart is not manual pause: only the leader's no-auto-resume and persisted-context behavior is agreed for restart. Define races at the instant of pause, in-flight tool calls, crashes, and late results in L-D04 without inventing permission to cancel execution agents.

### Plan boundaries

A plan records the agreed goal and DoD separately from its changeable task decomposition. Mode A presents a plan and obtains approval before delegating execution tasks for that plan. Analysis needed to propose that plan is not approval to launch its implementation. The already-authorized repository-onboarding adaptation is not a blanket authorization for unrelated business work.

After approval, replacing an implementation approach, rearranging safe dependencies, or changing an executor within the same goal/DoD does not require a new plan approval. Adding a business outcome requires a decision; dropping acceptance or weakening a mandatory control is prohibited, not an approval choice. Mode B grants autonomous decomposition of an agreed goal, not authority to invent a broader goal. Existing project UI operations have full autonomous MCP authority in either mode once the plan boundary permits them.

## 5. Reference inventory and standard-kit coverage

**Provisional reference snapshot, not the final transfer baseline.** Inventory inspected on 2026-09-08 in the user-designated local reference: its `AGENTS.md`, `docs/cezar.md`, and `.ai/cezar/workflows`, `.ai/cezar/skills`, `.ai/cezar/checks`. At the time of inspection, the files contained **11 workflows and 13 skills**. Later changes have not been audited; these numbers must not constrain the final inventory. The reference uses the Cezar name. The following inventory deliberately records generic roles rather than copying private briefs, credentials, package/domain rules, model pins, branch names, issue content, or deployment details.

This is source inspection, not proof that every reference workflow ran successfully end to end. The reference documentation distinguishes configured workflows from live-tested ones and contains historical behavior. File inventory and current scripts anchor this mapping; an installation count alone does not prove semantic parity.

### Workflow roles — all required

Names below identify the source workflow files; final product names may change only with an explicit equivalence mapping.

| ID | Workflow role | Required purpose / output | Standard skill roles |
| --- | --- | --- | --- |
| W-01 | `issue-triage` | Determine whether work is worth doing; refine scope and recommend implement, simplify, defer, or reject. No accidental implementation. | K-01 |
| W-02 | `business-analysis` | Establish business problem, rules, alternatives including status quo, testable acceptance, and recommendation. A business decision is distinct from technical design. | K-02 |
| W-03 | `plan-and-spec` | Produce a right-sized specification and implementation plan for accepted work. | K-03, K-12, K-13 |
| W-04 | `feature-implementation` | Implement code, tests, and relevant documentation under the approved brief. | K-04, K-12, K-13 |
| W-05 | `bug-fix` | Reproduce, establish root cause, demonstrate failing-then-passing regression coverage, and repair. | K-05, K-12, K-13 |
| W-06 | `code-review` | Independently assess a completed revision; report prioritized, actionable findings and evidence limits. | K-06 |
| W-07 | `address-review-findings` | Repair review findings, verify corrections, and update the same relevant work/PR with responses. | K-07, K-12, K-13 |
| W-08 | `testing-and-verification` | Add/strengthen meaningful tests and verify behavior without weakening gates. | K-08, K-12, K-13 |
| W-09 | `docs-maintenance` | Keep maintained and generated documentation accurate using the project's actual generation/drift rules. | K-09, K-12, K-13 |
| W-10 | `dependency-maintenance` | Update dependencies in attributable batches and verify them; obey project permission boundaries. | K-10, K-12, K-13 |
| W-11 | `release-prep` | Audit release inputs and prepare notes or a preparation PR; does not add release execution; existing project actions remain autonomous under the agreed plan boundary. | K-11, K-12, K-13 |

W-03–05 and W-07–11 are the eight current source workflows with the writing sequence and `onFail.max: 2`. W-01, W-02, and W-06 are separate analysis/review workflows and must not gain fake implementation or PR stages just to match that sequence. Read-only permissions and allowed side effects are adapted from the actual role, not inferred solely from its name. The standard kit preserves the role while respecting project-specific publication permissions.

### Skill roles — all required

Source filenames carry a project prefix; the table removes it for the generic product role.

| ID | Source role without project prefix | Generic contract to preserve |
| --- | --- | --- |
| K-01 | `issue-triage` | Establish validity, scope, and a justified disposition before implementation. |
| K-02 | `business-analysis` | Separate business need, rules, alternatives, acceptance criteria, and explicit decisions; no inferred business approval. |
| K-03 | `planning-spec` | Translate accepted needs into a bounded technical plan/specification. |
| K-04 | `implementation` | Implement within constraints; perform focused checks and leave authoritative full gates/handoff to their stages. |
| K-05 | `bug-investigation` | Reproduce and diagnose before fixing; prove the regression test catches the original failure. |
| K-06 | `code-review` | Review completed code or documents against relevant contracts; green code gates do not prove semantic quality of an analysis. |
| K-07 | `review-response` | Address findings explicitly with verified corrections and a response per finding. |
| K-08 | `testing` | Improve verification without lowering mandatory quality thresholds. |
| K-09 | `docs-maintenance` | Respect canonical documentation sources and generated-file ownership; detect documentation drift. |
| K-10 | `dependency-maintenance` | Make bounded, attributable dependency changes with proper checks. |
| K-11 | `release-prep` | Prepare a reviewable release package/notes without assuming publication authority. |
| K-12 | `quality-gates` | One authoritative gate definition, exact passed/failed/not-run reporting, current evidence, and at most two repairs of the same failure. |
| K-13 | `handoff-draft-pr` | Verify current gate evidence and readiness, bind writes to the correct task checkout/ref, and hand off honestly with unmet criteria. |

### Check infrastructure and good practices — preserve effects, adapt mechanisms

The reference contains six top-level check entry files and two shared helpers. Generic delivery must preserve their contracts, not blindly run the original shell commands.

| ID | Reference component / practice | Required generic effect | Adapt per project |
| --- | --- | --- | --- |
| C-01 | `worktree-preflight.sh` | Fail closed on invalid task/checkout/branch identity, unresolved Git operations, broken ignore hygiene, or missing required contracts. Readiness stops blocked work before expensive gates; evidence modes record/verify the judged content. | Project branch policy, task paths, Git availability, read-only exceptions, contract locations. |
| C-02 | `worktree-setup.sh` | Idempotent setup; check toolchain, report base freshness, establish dependency freshness, and record task context. Do not copy secrets into worktrees. | Runtime/package manager, lockfile, install command, package layout. |
| C-03 | `repo-gates.sh` | One canonical ordered gate list, authoritative summary, separate not-run/failure, and freshness-aware setup reuse. | Actual CI/quality commands and their dependencies; not a universal Node/pnpm command list. |
| C-04 | `catalog-check.mjs` | Reject misspelled/unsupported configuration and workflow keys, unresolved skills, invalid retries, and workflow shapes that break required interaction. | Actual supported Xezar schema and execution semantics; no silent unknown-key stripping as proof of correctness. |
| C-05 | `infra-tests.sh` | Behavior tests on disposable fixtures for isolation, setup, catalog, readiness, evidence, and handoff contracts. | Supported project environments and product test tooling. |
| C-06 | `worktree-git.sh` | Revalidate task checkout before Git writes and bind commit/push to that checkout and named ref; never let a stale working directory redirect writes. | Xezar branch ownership and allowed Git operations. |
| C-07 | `lib/common.sh`, `lib/manifest.mjs` | Shared identity/freshness logic and durable task/evidence metadata instead of conflicting implementations. | Storage format/location, fingerprints, retention, versioning. |
| C-08 | Bounded briefs, handoffs, checkpoints | Reference maintained docs; record task/revision/phase/next action; inspect relevant failure excerpts; reuse only still-valid evidence. | Project documentation and artifact locations. |
| C-09 | Readiness before quality gates | An unresolved required decision blocks dependent progression before gates and publication; a text question cannot be ignored by a nonterminal workflow stage. | A real server-side decision boundary is preferable to copying a `BLOCKED` file workaround; mechanism open. |
| C-10 | Evidence and Git handoff | Seal revision plus content, revalidate before push, avoid duplicate PR paths, and never label draft PR as business acceptance. | Project GitHub/other integration availability and approval rules. |
| C-11 | Shared-resource awareness | Worktrees do not isolate quotas, package caches, ports, external services, or host resources. Preserve enforced scheduling/locks. | Project and workspace limits without changing other projects through leader MCP. |

### Settings coverage — no silent omissions

“All settings” means preserving each responsibility from the reference with a generic mapping; it does not mean copying its literal numbers, credentials, branches, or model choices.

| ID | Setting responsibility observed | Generic standard-kit treatment |
| --- | --- | --- |
| T-01 | Skill sources and executable-instruction trust | Respect project-approved sources and confidentiality; adaptation does not import private instructions or grant trust to an arbitrary source. |
| T-02 | Base branch and branch/worktree discipline | Discover and enforce the project's integration/release policy; no hardcoded reference branch or branch prefix. |
| T-03 | Runner, per-run/per-step model, planner/namer selection, model lock behavior | Map to real supported runtime settings and project allowlists; a UI default must not be mistaken for an enforced execution setting. |
| T-04 | System prompt and project conventions | Adapt maintained instructions for isolation, quality, evidence, generated files, and authority boundaries without leaking reference-specific content. |
| T-05 | Review gate and draft-PR handoff | Preserve a deliberate, nonduplicating handoff and approval policy; optional engine review status is distinct from independent review and business acceptance. |
| T-06 | Worktree retention and evidence retention | Keep useful results/checkpoints accessible after checkout cleanup; discover actual supported retention semantics. |
| T-07 | Worktree/autonomy composer defaults | Align defaults with project policy and the new leader lifecycle; do not confuse execution-agent autonomy with leader planning approval. |
| T-08 | Project concurrency, workspace concurrency, memory limits | Preserve actual enforcement and shared-resource protection; project leader cannot change global limits for other projects. Resolve overrides through MCP D-03. |
| T-09 | Environment switches and config precedence | Use effective supported settings; reject ignored/invented knobs. Do not transfer reference-specific environment assumptions or silently widen exposure. |

After the user's readiness signal, and before finalizing the transfer implementation, refine W/K/C/T and the practice register below into a source-to-product inventory covering every source file, setting, and organizational practice. Record “retained role / adapted mechanism / project-specific literal excluded” with justification and a verification case. No workflow, skill, or organizational practice may be silently dropped under the label “adaptation”; an intentional deviation requires the user's explicit decision. Keep private source locations and content out of shipped artifacts; these role tables are sufficient provenance for this requirements draft.


### Whole-process traceability register — final audit deferred

The following is a **required audit structure and provisional coverage map**, not a completed content audit. Named source documents beyond the inspected snapshot are targets for the later audit, not claims that their current contents have been read or transferred. The exact file inventory and immutable source revision will be established only after the user's readiness signal. Include every remaining maintained document and applicable engineering rule; do not treat this list as exhaustive.

| ID | Source practice / source family | Generic Xezar capability or process | Project-specific adaptation | Verification / acceptance and current status |
| --- | --- | --- | --- | --- |
| X-01 | `AGENTS.md` and relevant `CLAUDE.md` operating/engineering rules | Responsibility split, authority, intervention boundaries, project contracts and delivery discipline | Map general governance; exclude private API/domain implementation facts while retaining the applicable quality obligation | L-A13, L-A17, L-A23 and L-A27; AGENTS sampled, full cross-document audit deferred. |
| X-02 | `docs/cezar.md`, catalog and configuration guidance | Installed baseline, capability truth, setup, catalog operation and documented limitations | Product naming, discovered tooling/settings, actual supported defaults | L-A01–03, L-A16, L-A27; provisional inspection only. |
| X-03 | `.ai/cezar/docs/ui-operations.md` | End-to-end user/leader operation, questions, handoffs, review and action semantics | Xezar UI/MCP equivalents and project permissions | L-A05–13, L-A23–24, L-A27; previously sampled, final coverage deferred. |
| X-04 | `.ai/cezar/docs/recovery.md` and recover/resume guidance | Truthful recovery, preserved work/context/evidence, safe continuation and post-recovery checks | Actual Xezar lifecycle, branch/worktree recovery, retained artifacts | L-A09–11, L-A21, L-A27; content audit deferred; new agreed leader restart semantics take precedence. |
| X-05 | `.ai/cezar/docs/parallel-tasks.md` and shared-resource practices | Dependency-aware parallel work, conflict handling, safe resource coordination | Project/global caps, quotas, ports, caches and external resource constraints | L-A08–09, L-A14, L-A24, L-A27; full audit deferred. |
| X-06 | `.ai/cezar/docs/business-analysis.md` and analysis/spec/review practices | Distinguish whether to act, business need, technical approach, and business acceptance | Project stakeholders, domain rules and maintained document locations | L-A12–13, L-A16, L-A23, L-A27; full audit deferred. |
| X-07 | `.ai/cezar/docs/worktrees.md`, isolation and safe Git guards | Checkout identity, fail-closed writes, setup, readiness and safe handoff | Branch naming/policy, toolchain, Git capabilities, cleanup semantics | L-A17–18, L-A21, L-A27; check contracts sampled, document re-audit deferred. |
| X-08 | All remaining maintained `.ai/cezar/docs` content, including any indexes, lessons or evidence guidance present at baseline | Capture additional organizational rules, lessons and operating constraints across the entire work process | Classify each practice independently; never discard a document because it is absent from this provisional list | L-A27; exact filenames and practices intentionally await final audit. |
| X-09 | Workflows, skills, checks/guards and helpers | Complete role catalog with executable gate, evidence, retry and handoff contracts | W/K/C mappings plus any additions at the released baseline | L-A01, L-A16–19, L-A27; 11/13 provisional counts, no final upper bound. |
| X-10 | Context discipline, evidence/checkpoints, retained logs and findings | Bounded briefs, durable commitments, revision/content evidence and truthful reporting | Retention/storage, compaction strategy, project artifact ownership | L-A10–11, L-A18, L-A23, L-A26–27; exact final practice inventory deferred. |
| X-11 | Settings, upgrade procedures, catalog validation and compatibility practices | Effective settings, nonbreaking upgrades, upstream/local adaptation, rollback and schema integrity | Supported settings scopes, backend/product versions and optional capabilities | L-A02–03, L-A21–22, L-A27; provisional T/C mappings require final audit. |
| X-12 | Any additional practice discovered in the user-released source baseline | Add a named generic process/capability or record an explicit user-approved deviation | State why a literal is private/project-specific and what general obligation remains | L-A27; no uncategorized or silently omitted practices at final acceptance. |

The later audit register must record an immutable source revision, file/section, distinct practice ID, actual rule, generic Xezar mapping, project adaptation, related requirement, verification case, evidence revision/result, and any explicit user-approved deviation. Split documents containing multiple practices into multiple records. “Document reviewed” is not evidence that each practice is represented.

The final material-transfer gate remains **deferred, awaiting the user's readiness signal**. There is no scheduled watcher or background re-audit. Once released, audit the source as it then exists, compare it with this provisional snapshot, and update requirements/coverage as needed. Finishing these English documents does not claim completion of that audit or of the transfer.

## 6. Standard-kit adaptation, improvement, and updates

### Onboarding

When a project is added, analyze its maintained instructions, repository structure, manifest/toolchain, existing test/build commands, CI, Git policies, and available backend capabilities. Prepare the project kit automatically. Discovery may determine that a role is currently unavailable due to a missing dependency, but must retain the role and explain the prerequisite. It must not falsely mark missing tests as passed or invent an unrelated gate to make onboarding look complete.

The kit is always distributed even if the leader has not been started. The execution mechanism for onboarding analysis before the user selects a leader model is open in L-D03; its authority is limited to the agreed analysis/adaptation. Do not use this uncertainty to make installation optional or require approval for every routine adaptation. Do not start unrelated execution work as a side effect.

### Learning from outcomes

The leader chooses the moment to improve based on observed project results: recurring failures, unnecessary repeated work, mismatched executor choices, ambiguous briefs, or poor handoffs are possible inputs, not a mandated algorithm or trigger counter. The improvement may change a workflow, skill, or allowed project setting. It records the change and a short rationale and remains reversible.

Preserve existing controls' actual guarantees. A faster replacement that never runs by default is not equivalent to the control it replaces. Removing a required test, lowering a mandatory threshold, hiding failure, or discarding acceptance is prohibited. The leader improves the solution or reports a blocker. Its own role instruction is user-controlled and cannot be self-edited in MVP, even if a proposed edit seems beneficial. This exception is outside autonomous workflow/skill/settings optimization.

### Versioning and updates

**Technical implication:** an in-flight task needs an immutable or reproducible view of the workflow and the referenced skill/check/configuration values that affect its execution. Merely snapshotting a YAML name while loading the latest skill text would violate L-F22. Define whether queued-but-not-started tasks count as already launched; this boundary is open and must be visible rather than silently changing queued work.

**Proposal:** maintain an upstream kit version, a project adaptation layer, and immutable execution snapshots, with change records and rollback targets. Use a three-way comparison between the previous standard, new standard, and local adaptations. This is a proposal, not an approved storage or merge algorithm.

A product upgrade delivers the updated base kit. The leader adapts it without discarding local improvements. A conflict must be visible with affected behavior and options; no silent overwrite. Process updates must not bypass the restart rule: when the leader awaits manual resume after restart, reasoning/adaptation by that leader also waits. Kit delivery itself can occur without resuming it. Whether other paused-state onboarding/maintenance operations can run needs an explicit lifecycle decision.

## 7. Quality evidence and bounded repair

The authoritative gate stage runs the project's canonical checks. Execution steps use focused checks as needed rather than redundantly rerunning the full list. A missing prerequisite or credential-dependent skipped suite is **not-run**, not passed. A failed required gate or unresolved required decision cannot produce a successful handoff. If the project has no Git revision, an equivalent immutable content identity is a technical design decision; never fabricate a SHA.

Evidence binds to the judged revision and content, including relevant uncommitted/generated changes. Later changes invalidate that evidence; recheck the changed result before handoff. Define fingerprint scope and nondeterministic-output handling in L-D07. Code-quality gates cannot by themselves establish business correctness of a requirements document or acceptance of a feature. Autonomous use of an existing merge action does not change this distinction.

Two distinct agreed limits apply:

1. **Workflow level:** after failed gates, return to the configured repair step at most twice. An initial execution is not a repair return. If the next failure would require a third return, stop that workflow's repair loop and report; do not run its successful handoff.
2. **Skill level:** at most two repair attempts on the same failure. Then stop repeating and report the hypothesis, attempted fixes, failing command/relevant output, revision, and blockers.

The leader may reassign failed work under L-F17. **No overall leader-wide retry number was agreed.** Defining failure identity, preserving attempt history across reassignment, and preventing endless cycles from resetting per-executor counters are open in L-D08. This gap cannot be resolved by silently choosing a new numeric budget or presenting unlimited reassignment as safe completion behavior.

## 8. Architecture and nonfunctional requirements

Current integration anchors: [agent protocol](../../AGENT_PROTOCOL.md), [runner factory](../../packages/xezar/src/core/runner-factory.ts), [RunManager](../../packages/xezar/src/workflows/run.ts), [RunStore](../../packages/xezar/src/runs/store.ts), [project context](../../packages/xezar/src/server/project-context.ts), [workspace semaphore](../../packages/xezar/src/workspace/semaphore.ts), [UI shell](../../packages/web/src/app.tsx), [settings registry](../../packages/web/src/routes/settings/registry.tsx), [events](../../packages/web/src/api/global-events.tsx), [workflows](../../packages/xezar/src/workflows/types.ts), and [skills discovery](../../packages/xezar/src/skills.ts).

These anchors establish where to investigate, not proof that a persistent leader, all question semantics, or background wakeups already exist. Code currently exposes persistent runner sessions; their suitability for a leader runtime must be verified for each selected backend. Do not assume a vendor SDK or native app supplies the required lifecycle.

| ID / classification | Required outcome or proposal |
| --- | --- |
| L-N01 / implication | All leader task operations use project-bound MCP with the same single-owner rule, including native clients. Full project-action authority does not grant global administration or permit role-prompt self-editing. |
| L-N02 / implication | Persist conversation, goal/DoD, plan, decisions, unresolved questions, task references, and leader lifecycle sufficiently for manual recovery. Context compaction must preserve binding commitments; exact storage and compaction strategy are open. |
| L-N03 / implication | Significant events in MCP E-01–06 reach an active leader without model status polling or open chat. Reconcile duplicates, ordering and missed events; delivery and actual model reaction are separate required tests. |
| L-N04 / implication | Stale leader mutations MUST be rejected after human changes; fresh read precedes a new decision. Idempotency keyed by durable operation identity MUST avoid duplicate effects. Versions, journals and dedup mechanisms remain technical choices, not optional outcomes. |
| L-N05 / implication | Structured questions and decisions have consistent semantics across backends, survive the agreed restart recovery, and link notifications to the exact pending question. Do not expose connection credentials or sensitive backend configuration in chat. |
| L-N06 / implication | Lifecycle and resource management must distinguish the leader from execution agents without bypassing global caps or creating dead-end states. Leader resource accounting, liveness, backend unavailability, and stop behavior need a design. |
| L-N07 / implication | Process history/rollback preserves active versions and cannot weaken mandatory quality/acceptance. Detect UI/adaptation/upstream conflicts. Leader role prompt is user-editable only, excluded from autonomous changes. |
| L-N08 / implication | Missing backends, unsupported projects, denied notifications, and unavailable models are explicit capability states. Ordinary Xezar remains usable; never report unavailable analysis/execution as completed. |
| L-N09 / implication | All shipped generic kit content is free of reference credentials, proprietary domain assumptions, fixed private paths, and project-specific commands masquerading as universal defaults. |
| L-N10 / proposal | Measure response, event/reaction latency, conversation/retention and resource limits before release. Values remain undecided; this does not make required continuity or background reaction optional. |

No new package, transport, endpoint, flag, or persistence filename is selected here. Any HTTP additions must use shared Zod contracts, middleware validation, chained registration, and `/api/v1` per [AGENTS.md](../../AGENTS.md). Storage must preserve existing state compatibility and zero-config behavior. Autonomous onboarding and always-shipped kit are explicit product requirements; the design must reconcile their operation/cost with repository opt-in rules rather than silently disabling them or inventing an undocumented environment variable.

## 9. End-to-end scenarios

### R-01: first project and default planning

A user adds a repository. Xezar makes the full kit available and performs authorized analysis/adaptation. The user starts the leader by selecting tool/model, describes a goal in the side panel, and receives a proposed plan in default mode A. The leader requests approval through a structured question. After approval it delegates, follows statuses, assesses completed evidence, and advances. A technical-plan adjustment within goal/DoD proceeds without another approval; a proposed expansion waits for one.

### R-02: parallel work and a decision

Two independent tasks run. One needs a business decision; the leader asks a structured question, marks it in Xezar, and attempts notification according to browser capability. Only dependent work waits. The other task finishes and its next independent stage starts even with the conversation panel closed. Clicking the notification opens the unresolved question; a custom answer is accepted just like a listed option.

### R-03: pause, human edits, and resume

The human pauses the leader. Existing executors continue, and the human changes task organization or a project setting in the UI. Results/questions accumulate without new leader decisions or delegations. On manual resume, the leader reads these changes before taking action. After a later server restart it again waits for manual resume; this does not imply that executor processes were preserved or killed.

### R-04: failure and executor replacement

A workflow fails its gate, follows its bounded repair loop, and eventually reports a failure with evidence if exhausted. The leader may reassign the task to another suitable allowed executor without expanding goal/DoD. The history retains the original attempts. Cross-executor loop prevention follows the eventual L-D08 decision; no hidden reset or invented global limit is claimed here.

### R-05: improvement and product update

After inspecting outcomes, the leader chooses to improve a project workflow and records why. New tasks use the updated version; an active task keeps its original effective process. The human can roll back. A Xezar update provides a new standard version; local improvements are preserved during adaptation, and unresolved conflicts are surfaced. A paused or restarted-awaiting-resume leader is not silently reactivated for this maintenance.

## 10. Testable acceptance criteria

**O — obligatory:** all acceptance outcomes below are required. Proposed technical mechanisms and unchosen numeric limits do not defer continuity, conflicts, idempotency or event-driven reaction. L-A27 remains blocked on the explicitly deferred source baseline.

Use two isolated projects, controlled backends, deterministic task/question fixtures, and project kits with different toolchains. Run common behavior cases for each supported leader backend. Real backend/browser validation is additionally required; mocks alone do not establish compatibility. Evidence records implementation SHA, kit version, fixture, backend/model identity actually used, browser where relevant, result, and limitations. User-supplied example model names are not substitute compatibility evidence.

| ID / status | Given | When | Then / required evidence | Traceability |
| --- | --- | --- | --- | --- |
| L-A01 / O | Fresh Xezar installation and no project customization | Inspect distribution and add a project | All roles from the user-released baseline, including the provisional 11 workflow and 13 skill roles, C-01–11 and T-01–09 mappings are present; authorized analysis/adaptation runs without per-change approval. No private reference content or unrelated business tasks are introduced. | L-F18–19; W/K/C/T |
| L-A02 / O | Repositories with materially different toolchains/branches and one unsupported prerequisite | Adapt each project | Correct project commands/policies replace reference literals; unsupported prerequisites are explicit, not fabricated or passed. Every generic role remains mapped. | L-F19, L-F21; L-N08–09; T-01–09 |
| L-A03 / O | Leader not started, permitted reasoning list and installed backend capabilities known | Select tool/model and start for each supported backend | Actual tool/model matches selection, only maintained/user-edited eligible list is offered, unavailable choices are not falsely reported as running, and no vendor UI is embedded. | L-F02–03; L-D02 |
| L-A04 / O | Project conversation exists on desktop and supported phone browser | Hide/open/maximize panel, navigate, reconnect, enter text | Same single conversation, decisions, and plan persist; responsive controls remain usable. No attachment flow appears in version one. | L-F04–05; L-N02 |
| L-A05 / O | Each backend needs a decision or clarification | Emit an option question and exercise a custom response | Same structured UI with options and custom answer, stable question association, and consistent answer delivery. Plain prose alone cannot satisfy the case. | L-F06; L-N05 |
| L-A06 / O | Pending question; browser notification permission granted/denied; sound on/off | Raise question and click available indicator/notification | Xezar marks the question; supported/permitted system delivery occurs; optional sound respects preference/capability. Clicking opens the exact question. Tested unsupported/closed-page limits are documented, not claimed away. | L-F07; L-D05 |
| L-A07 / O | Leader active, Xezar environment running, conversation panel closed | Executor completes a task and a next stage is ready | Leader observes the result and advances within scope without opening chat. No implication of survival while Xezar is stopped. | L-F08; L-N03 |
| L-A08 / O | One branch of a plan needs an answer and another is independent | Leave question unanswered, complete independent work, then answer | Only dependent work waits; independent progression continues. No timeout assumes approval. Answer unlocks only the appropriate dependent work. | L-F09; L-N05 |
| L-A09 / O | Leader active with running executors and outstanding work | Manually pause, wait for results/questions, make human UI changes | No new leader delegation/automatic decision after pause takes effect; executors continue, results/questions remain, human UI works. Separate executor-stop action remains distinguishable. | L-F10; L-D04 |
| L-A10 / O | Conversation, decisions, plan, and task references persisted | Restart Xezar | Leader awaits manual resume with preserved context; no automatic reasoning/delegation. Test report states observed executor-process behavior separately and does not infer it from leader pause. | L-F11; L-N02; L-D04 |
| L-A11 / O | Manually paused or restarted leader; tasks/results/questions/human settings changed | Manually resume | Reconciliation completes before the first new automatic decision or delegation; decisions use current state rather than the stale conversation alone. | L-F12; L-N02–03 |
| L-A12 / O | New project in mode A with a proposed goal | Ask for execution and withhold plan approval, then approve | A is the default; leader presents plan and structured approval question; no dependent execution tasks launch before approval. After approval it may proceed. | L-F06, L-F13 |
| L-A13 / O | Mode B selected; goal/DoD agreed | Decompose and change technical plan internally; propose goal expansion and quality weakening | Internal changes proceed; goal expansion requires structured decision. Weakening quality/acceptance is rejected outright. Existing project merge/deletion/publication needs no operation confirmation. | L-F13–14, L-F21, L-F34 |
| L-A14 / O | Projects A/B have different executor rules and allowlists | Assign matched-rule, unmatched-rule, hard/simple, and imperfect-fit tasks | Project-specific rules apply; fallback primarily follows difficulty and stays available/allowed; imperfect fit does not prompt or block. Zero available executors produces the explicitly designed unavailable state. | L-F15–16; L-D02–03 |
| L-A15 / O | Executor failed with retained evidence | Leader reassigns within goal/DoD | Another available allowed executor receives relevant failure context without changing acceptance or bypassing required controls. No invented leader-wide retry number is asserted. | L-F17, L-F28; L-D08 |
| L-A16 / O | All kit roles installed and adapted | Exercise each W-01–11 role with its K/C responsibilities and representative input | Each produces its distinct output/permission behavior; analysis/review do not accidentally implement. Writing roles follow the ordered sequence and publish only with existing authority. Catalog validity alone is insufficient evidence. | L-F18, L-F26, L-F29; W/K/C |
| L-A17 / O | Writing task has invalid isolation or an unresolved required decision before gates | Attempt progression | Preflight/readiness prevents the dependent work/gates/handoff as appropriate; no text-only question silently allows continued publication. Project-specific paths/branches are validated. | L-F21, L-F26; C-01, C-06, C-09 |
| L-A18 / O | Canonical gate definition, missing prerequisite, failed check, and passed check fixtures | Run gates and handoff; change content after evidence creation | Passed/failed/not-run remain distinct; failure or missing required checks cannot yield successful handoff. Revision/content mismatch invalidates evidence until reverified. | L-F27, L-F30; K-12–13; C-03, C-10 |
| L-A19 / O | Repeated gate failure in a writing workflow and repeated identical skill failure | Exhaust repair opportunities | Workflow makes no more than two repair returns; skill makes no more than two repair attempts for that failure, then reports evidence. A third workflow return or successful handoff after exhaustion is prevented. | L-F28; W-03–05, W-07–11; K-12 |
| L-A20 / O | Leader has project improvement authority | Choose an improvement and attempt quality weakening or self-edit of role prompt | Rationale/history recorded for allowed kit change; weakening is prohibited, not offered for approval. Self-edit is rejected; only user can change project role instruction. | L-F20–21, L-F23, L-F33 |
| L-A21 / O | Task running on kit version V1; leader changes workflow/skill/check configuration to V2 | Finish old task, launch new task, then roll back | Old task uses its original effective process; new task uses the adopted version. Rollback restores a selectable prior process without erasing history or rewriting old task evidence. Queued-task behavior follows the explicit version boundary. | L-F22–23; L-N07; L-D06 |
| L-A22 / O | Locally improved kit; product update contains new standard and conflicting/nonconflicting edits | Apply update and adapt; also test leader awaiting restart resume | New standard is delivered, local improvements preserved, conflicts surfaced. Leader is not silently resumed by upgrade. Required roles/control coverage remains intact. | L-F24; L-D06 |
| L-A23 / O | Completed result, green gates, and a draft PR with an unmet business criterion | Leader evaluates phase readiness and produces handoff | Unmet criteria and evidence revision remain explicit. Draft/green status alone does not claim completion or business acceptance; existing merge/publication authority comes from the agreed project capability, never from weakening quality. | L-F25, L-F27, L-F30 |
| L-A24 / O | Built-in or external client owns project A; B independent | Start competing client and attempt foreign/global actions; mutate A through owner | One owner only; second receives compliant occupied-project error. UI remains concurrent and updates automatically. Project actions autonomous; foreign/global writes rejected. | L-F01, L-F34–35; MCP F-17–21 |
| L-A25 / O | Duplicate/late events, lost mutation response, and human edit | Retry same operation identity and stale mutation, then issue new identical task with new key | Same key returns original result/status, no duplicate; new key permits intentional duplicate content. Stale write is rejected until fresh read. Causal echoes do not trigger loops. | L-N03–04, L-F34; MCP N-03, N-10 |
| L-A26 / O | Long conversation and backend restart/resume | Recover under designed context strategy | Approved goals/DoD, decisions/questions and effective process references remain; role instruction reapplied. No false recovery claim. Numeric resource targets are separately designed, not grounds to waive continuity. | L-N02, L-F11–12, L-F33 |
| L-A27 / O — deferred until source readiness | User has explicitly released a final source baseline and the full audit register exists | Review every identified practice across the entire source, not just workflow/skill files, against implementation and verification evidence | Every practice maps to a generic Xezar capability/process and project adaptation, with evidence on the candidate revision. Every intentional deviation has an explicit user decision. No unclassified or silently omitted practice remains. This case is not claimed passed while the source audit is deferred. | L-F31–32; X-01–12; W/K/C/T |
| L-A28 / O | User has not yet signaled that the reference is ready | Complete the two requirements documents and inspect planned follow-up activity | Documents label the baseline provisional and audit deferred; no full re-audit, final extraction, scheduled watcher or automatic monitoring is started. Documentation completion is allowed; final transfer completeness is not claimed. | L-F32; X-01–12 |
| L-A29 / O | Each required tool selected and user-customized project role instruction exists | Start and resume leader in each tool | Actual effective role includes duties, exclusions, autonomy, quality, delegation, events and structured questions. Backend-specific mapping is tested; no fabricated uniform system-prompt API. User changes are applied; leader self-edit paths fail. | L-F33; compatibility report |
| L-A30 / O | Model idle while Xezar active | Deliver every MCP E-01–06 event through each client adapter | A real model reaction follows significant delivery without status-polling turns. Logs/tokens/visual events do not wake it; paused or restart-awaiting-resume leader queues instead. | L-F08–12, L-F25, L-F34 |
| L-A31 / O | Logical owner idle, then disconnected/expired | Exercise heartbeat, death detection, competing acquisition, stale writes and reconnect | Non-model liveness releases only on confirmed end/expiry; single owner enforced; expired client reconnects. Executors and results survive client disconnect. | L-F01, L-F34 |
| L-A32 / O | UI and leader active on same project | MCP mutation, human goal/AC/task/config edit, then disconnect/reconnect UI/client | Open UI updates without reload; significant human changes delivered; outstanding events and current state reconcile. No self-trigger loops or silent stale overwrite. | L-F34–35 |
| L-A33 / O | Mandatory gates and global config exist | Attempt to relax required controls, including by changing DoD; inspect shared state | Weakening blocked without approval option. Shared reads contain only safe effective capabilities/limits; no foreign identities/secrets or global writes. Improve solution or report blocker. | L-F14, L-F21, L-F35 |

### Whole-feature Definition of Done

The built-in leader and process-kit feature is complete only when:

1. Every L-F01–35 requirement has implementation evidence on one release-candidate revision. All obligatory L-A01–33 cases pass at the appropriate stage; L-A27 cannot pass before the user releases the final source baseline; `not-run`, skipped, or a model's unverified assertion is not a pass. Record backend/browser coverage and accepted environmental limits explicitly.
2. The dependent MCP capabilities satisfy their own mandatory acceptance criteria and finalized UI-action coverage matrix. The leader UI never becomes a substitute for incomplete project management via MCP, and external MCP use remains independent.
3. The full final source-practice register, including the provisional W/K/C/T and X-01–12 families and all later identified practices, has reviewed source-to-generic mappings and meaningful verification evidence. Intentional deviations have explicit user decisions; current 11/13 counts do not define the full transfer. None is dropped silently; no confidential reference data or hardcoded reference technology is shipped.
4. Demonstrate a complete business flow: add/adapt project → choose leader → default approved plan or mode B → delegate → structured decision with independent progression → completed-revision review → repair/handoff/next stage → human takeover. Demonstrate pause and server restart as distinct cases, both followed by reconciliation before action.
5. Demonstrate process improvement, immutable active-task behavior, rationale/history, rollback, and standard-kit upgrade preserving local changes. Evidence proves mandatory checks and acceptance cannot be weakened; approval is not a bypass.
6. Backend feasibility is validated for each advertised tool, and browser notification/mobile behavior is documented from tests. No example model name or assumed SDK support substitutes for an actual supported integration. Native mobile apps and attachments are not silently claimed.
7. Resolve L-D01–11 sufficiently to implement the agreed outcomes, including total executor unavailability, pause races, context continuity, kit conflicts, and cross-executor retry-loop prevention. The absence of an agreed global retry number is not silently converted into one. All AC outcomes are obligatory; proposed versions, journaling, leases and performance numbers are engineering mechanisms, not permission to defer agreed outcomes.
8. Future implementation passes the repository quality gate in [AGENTS.md](../../AGENTS.md) and [SDLC.md](../../SDLC.md), targeted integration tests, and human product review of the whole flow. This documentation-only change does not require running that implementation gate.
9. Product accepts role/process coverage and UX behavior; engineering accepts scope isolation, state/evidence correctness, recovery, and compatibility. Known limitations do not contradict any obligatory requirement.

## 11. Open decisions and implementation research

| ID | Decision / research | Boundary that is already agreed |
| --- | --- | --- |
| L-D01 | Local MCP adapters, owner binding, event reaction and handover; coordinate MCP D-01–09 | All three clients required, same machine, one logical owner/project, concurrent UI. Native versus built-in handover cannot create two owners; no disconnect UI. |
| L-D02 | Leader backend adapters, actual model IDs/capabilities, curated-list maintenance, user edits, authentication and switching behavior | Tool/model selected by user; reasoning-focused leader list is editable; no unverified model/SDK claims. |
| L-D03 | Onboarding runtime, executor-rule schema, total unavailability and field mapping | Project writes/safe shared reads are settled; no global administration. Executor allowlists are not MCP operation roles. |
| L-D04 | Durable lifecycle and event delivery, pause acknowledgement/in-flight calls, crash races, executor survival/recovery on server restart, concurrent human edits | No leader auto-resume after restart; manual pause leaves started executors running; reconcile before resumed action. |
| L-D05 | Question schema/normalization, backend enforcement, notifications and sound, supported phone browsers, fully closed-page delivery | Every decision/clarification uses options plus custom answer; in-Xezar indicator and targeted opening; no unverified notification compatibility promises. |
| L-D06 | Kit packaging, snapshots, queued-task version boundary, history/rollback scope, upstream/local conflict algorithm, maintenance while paused | Kit always ships; active tasks keep their effective version; local improvements preserved and conflicts visible. |
| L-D07 | Quality-gate discovery/authority, content fingerprint scope, invalidation and retained evidence after cleanup; projects without Git | One canonical definition; evidence bound to actual content; failed/not-run are not passed. |
| L-D08 | Failure identity and retry history across changed executors/workflows; prevention of endless reset loops | Workflow repair returns ≤2; skill attempts on same failure ≤2; no agreed overall leader-wide numeric cap. |
| L-D09 | Context/instruction persistence, event journal/replay and operation-key implementation, liveness and bounds | Conflicts rejected; idempotency and automatic significant events mandatory. Xezar base role + user project customization applied at start/resume; no leader self-edit. |
| L-D10 | Kit update governance, immutable-role-prompt protection and control-equivalence validation | Quality/acceptance weakening prohibited, including via approval or DoD changes; full project-action autonomy remains. Always-installed kit unchanged. |
| L-D11 | Final source baseline, complete practice audit and source-to-product register | **Deferred until the user explicitly signals readiness.** Current observations are provisional. No automatic monitoring or further full audit now; deliberate deviations later require explicit user decisions. |

## 12. Documentation status and next gate

This document authorizes no implementation, commit, push, issue, release, or operational change by itself. The current deliverable is an English requirements draft. The requirements documents can be completed now. Before finalizing the material-transfer implementation, wait for the user's readiness signal, audit that source baseline, resolve critical decisions, refine the full practice inventory, and attach a test plan to every requirement. Do not replace unresolved mechanisms with claims that the feature already works.

## 13. Engineering handoff and readiness audit

**Approved event-reaction delivery hierarchy:** (1) use native event mechanisms when the client demonstrably reacts to them; (2) otherwise deliver a message through the official programmatic session interface; (3) use terminal text input only as a last fallback after runtime evidence proves reliability. This ordering is approved; terminal feasibility is not proven. Every event identifies Xezar as its source and must never impersonate user instructions or approval. If correct project/session targeting, separation from approval prompts/shell/user typing/active turns, and duplicate prevention cannot be established, refuse terminal delivery and expose a recoverable blocker. Tests must include each of these hazards, reconnect/retry and a real subsequent model reaction. No model polling, second logical owner, or wider project scope is introduced.


This document is the standalone product contract for the built-in leader and complete process-kit workstream. It depends on the separately specified MCP capability; it does not reimplement that server or require the human to know the earlier interview. Technical evidence is in [client compatibility](mcp-client-compatibility.md).

**Ready for planning:** yes, for the agreed leader behavior and interfaces. The kit role/process mapping is provisional. **Ready for bounded implementation/design:** conversation and panel, structured questions, plan modes, pause/reconciliation state machine, user-only instruction editing, immutable kit history scaffolding, and backend adapters can be developed against a project-MCP fixture. All are subject to the final interface and real-backend verification.

**Not ready for whole-scope implementation sign-off or completion:** MCP event-to-model adapters for all three clients are not runtime-certified; the complete source-practice baseline is deferred until the user says Daxko is ready. The latter blocks final kit extraction, full transfer coverage and L-A27, not unrelated conversation/settings layouts or requirements planning. Do not perform a new full source audit or set up monitoring to resolve it automatically.

Required dependency contract: project-bound local MCP grants one logical owner, full project operations, safe shared reads, conflict rejection and operation-key idempotency. It acknowledges asynchronous work, pushes significant events and replays outstanding events plus state after reconnect. UI remains concurrent and updates automatically. Built-in and external clients cannot simultaneously own the project; design handover without a manual disconnect control.

For a self-contained leader implementation, significant events are: task completion/failure/cancellation/blocking; questions and human answers; quality-gate results or completed results ready for assessment; human goal/AC/instruction/plan/task-state changes; execution-relevant configuration/workflow changes; executor-availability changes. Log lines, token counters and presentation changes do not wake the model. The controller handles transport liveness/replay without model turns and queues events while paused or awaiting manual restart resume.

Required role-instruction contract: Xezar supplies role identity, duties, exclusions, delegation, quality, autonomy, events and structured-question behavior. The user can customize per project; the leader cannot self-edit in MVP. At startup and after every resume, the adapter establishes and verifies effective instruction version/content before reasoning. Use the documented backend-specific mechanism; no uniform vendor system-prompt API is assumed. Enforcement remains in services, not merely the prompt.

Engineering freedom: choose state schemas, backend process/control adapters, question normalization, instruction storage, event cursor/ack design, version snapshots and conflict handling without changing product rules. Preserve the user-only prompt exception during autonomous skill/settings adaptation. Correctness, security, maintainability and acceptance evidence take precedence over speed/cost; neither quality weakening nor its approval flow is in scope.

Suggested work packages: MCP interface fixture and all-backend spike → persistent leader/question/plan/lifecycle model → responsive UI and notifications → immutable process-version/history/rollback infrastructure → final user-released source audit and full-kit adaptation → complete acceptance. Keep source-dependent tasks explicitly waiting for the user's readiness signal. Global retry limits, notification platforms and executor restart behavior require design decisions; do not invent numerical policy or promise compatibility before tests.

Material risks: model wakeup gap, state/context loss at resume, duplicate delegation, pause races, backend question normalization, notification restrictions, source incompleteness, evidence invalidation and adaptive changes to mandatory controls. Product choices are already settled on autonomy, one owner, planning, quality and global scope; do not reopen them as per-button permission questions.

## 14. UX/UI design handoff

This section specifies the leader interface independently of the interview. **Required** means agreed behavior or necessary visibility of it; **proposal** identifies routine design choices, not new approved product policy. The standard-kit source audit stays deferred; designers can work on generic process/history screens without pretending the final catalog is known.

### Existing UI evidence and reuse boundaries

Use the [app shell](../../packages/web/src/components/app-shell.tsx), [project settings shell](../../packages/web/src/routes/settings/settings-shell.tsx), and [task composer](../../packages/web/src/components/composer/composer.tsx) as visual/interaction anchors. Do not inherit the composer's attachment features into the text-only leader release. [Submit-shortcut handling](../../packages/web/src/lib/use-submit-shortcut.ts) protects IME input/repeated keys; [keyboard viewport handling](../../packages/web/src/lib/keyboard-inset.ts) accounts for mobile keyboards. Reuse their guarantees where suitable rather than assuming the existing layout fits a second panel.

The existing [AskCard](../../packages/web/src/routes/task-thread/ask-card.tsx) has options, free-form reply and answered summaries; it can resume a closed execution session when answered. **That automatic resume cannot be copied into a paused/restarted leader**: record the answer while preserving manual resume/reconciliation. The existing [run notification component](../../packages/web/src/components/run-notifications.tsx) uses cached transitions and does not establish the required question-specific deep link. [Notification settings](../../packages/web/src/routes/settings/notifications-section.tsx) are human/global browser preferences; the leader cannot change them through project MCP. These are identified implementation gaps, not reasons to add global leader authority.

### Information architecture and entry points

**Proposal:** a persistent “Project leader” entry within the active project's shell opens its single conversation in a side panel. Header: project identity, actual selected tool/model, lifecycle status, pending-decision count, maximize/restore/close and lifecycle controls. Body: conversation, structured questions and plan/result cards. Footer: text input and send. Secondary navigation links to current plan, relevant tasks, process history and project leader settings; no new parallel conversation system.

Project leader settings contain planning mode, executor selection rules/allowed models, user-editable leader role instruction, and links to kit versions/history. Shared effective limits are readable but not editable here. Human notification preferences can link to their existing settings location without granting the leader global write access. Exact placement, routes and grouping are proposals. Project MCP setup remains the separate project's connection screen.

### Journeys and controls

| ID / classification | Design requirement or proposal |
| --- | --- |
| U-L01 / required | First start presents tool and leader model choices, eligible/available status and the selected project. Explain any unavailable model/adapter and occupied MCP session; no hidden fallback to a disallowed model or second owner. Starting resumes the one project conversation rather than creating a new task-like chat each time. |
| U-L02 / required | Side panel can maximize/restore; closing it only hides conversation, not pauses the leader. On a phone browser provide a usable full-width conversation treatment, navigation back to tasks and text composer above the keyboard. No native-mobile or remote-MCP promise: phone UI uses whatever existing Xezar deployment supports while MCP endpoints stay same-machine only. |
| U-L03 / required | Header visibly distinguishes active, waiting-on-decision, paused, restarting/awaiting manual resume, reconciling, disconnected and backend unavailable. “Pause leader” stops new leader decisions/delegation, not executors. “Resume leader” first reconciles. Do not add MCP “disconnect other client”. |
| U-L04 / required | Default plan approval shows goal, DoD/AC, task decomposition, dependencies and expected outcomes before approval. Mode B is a project setting clearly labeled autonomous planning within agreed goal/DoD. Mode changes do not silently approve an already-pending plan or expand scope; precise application to an existing pending plan requires an explicit documented rule. |
| U-L05 / required | Every decision/clarification is a structured question with options and custom answer in the same discoverable interaction. Show why it is needed, affected/dependent tasks and what can continue independently. Pending, submitting, answered, superseded and delivery-error states are distinguishable. Preserve draft answer on error. |
| U-L06 / required | In-app marker plus supported/permitted system notification and optional subtle sound point to the exact question. A deep link opens project conversation, reveals/focuses the question and preserves its current answered/pending status. No surprise auto-resume after pause/restart merely from opening or answering it. |
| U-L07 / required | Conversation combines human discussion and coordination but makes plan, task/result links and structured decisions distinguishable. Task links remain within project and return to the same conversation. Live execution shows concise status/milestones; completed output exposes revision, checks and unmet AC for assessment. No model polling or log/token noise disguised as progress. |
| U-L08 / required | Process adaptation/history shows version, short reason, affected workflow/skill/settings, active-task version and the version used for subsequent work. Rollback identifies its target/effects and keeps history. Upstream/local conflicts show both affected behavior and unresolved state without silent overwrite. Final role names/content are provisional until source audit is released. |
| U-L09 / required | Leader role instruction editor is for the user only, clearly distinct from automatically adapted skills/system settings. Show base instruction and project customization/effective result, save status and validation; runtime applies effective version at startup/resume. No leader-driven “improve my prompt” action. Reject model attempts through alternate file/settings routes. |
| U-L10 / required | Show unavailable executors/backends, refused stale writes, uncertain operation outcome and safe retry status without losing conversation/plan context. An imperfect available executor match is handled automatically, not presented as a mandatory question. Total unavailability has an honest blocking state. |
| U-L11 / proposal | Use cards for plans, questions and finished handoffs with compact summaries and optional detail. Keep current goal/DoD and pending questions reachable without searching long history. Label proposed/planned/running/completed states explicitly; draft PR does not visually imply business acceptance. |
| U-L12 / proposal | Keyboard access, focus return on panel close/maximize, labeled icon buttons, non-color status and restrained live announcements. Retain IME-safe text submission and prevent accidental repeated sends. Do not force scroll when the user reads history; provide a new-activity indicator. Support contrast, zoom, reduced motion and touch-safe controls using existing design primitives. |

### Required state/feedback inventory

| State | Visible meaning, allowed action and recovery |
| --- | --- |
| Empty / never started | Explain leader purpose and one-conversation scope; offer tool/model start. Distinguish kit pending adaptation from missing leader. |
| Loading / restoring conversation | Show restoration, not a fabricated empty conversation; do not discard draft input or decisions. |
| Starting / acquiring client | Show startup and selected backend; occupied project is an actionable client error, not permission to replace owner. |
| Active / model idle | Leader can react to significant events. Idle is not disconnected; status display does not itself trigger model turns. |
| Planning / awaiting plan approval | Plan visible, dependent launches withheld; approve or provide structured feedback within the plan question. No implied approval from changing a UI tab. |
| Waiting on decision | Highlight specific pending question and dependency scope; independent work continues. |
| Pausing / paused | Distinguish pending pause acknowledgement from applied pause. Once applied no new decisions/delegation; running tasks continue and their stop controls remain separate. |
| Restarting / awaiting manual resume | Preserved conversation/decisions/plan shown as recovered state; explicit Resume needed. Do not claim what happened to executor processes without server evidence. |
| Reconciling | Explain that current tasks, results, questions and human changes are being gathered. No fresh delegation before completion. |
| Disconnected / reconnecting | Keep last-known content visibly stale; tasks/results survive client disconnect. On recovery reconcile, respecting whether manual resume is required. |
| Error / stale conflict / uncertain outcome | Differentiate rejected-not-applied from accepted-but-result-unknown. Safe retry retains operation identity; never silently resubmit a new task. |
| Backend/model/executor unavailable | Name available corrective action (user backend selection or dependency setup); do not lose plan or claim an unavailable run succeeded. No routine prompt for merely imperfect model fit. |
| Question answered/superseded | Show durable answer or why it no longer applies. Deep links remain informative and do not resubmit stale decisions. |
| Kit adapting / update conflict / rollback | Show current and candidate versions, rationale and progress; no active-task version drift. Quality weakening is a refusal/blocker, never an “Approve waiver” state. |

Suggested labels are design proposals, not protocol states. Shared backend capabilities should drive unavailable controls with reasons rather than leaving users to infer failure from disabled icons.

### UX acceptance scenarios

| ID / classification | Given / when | Expected design evidence | Traceability |
| --- | --- | --- | --- |
| UX-L01 / required | User starts leader, hides/maximizes panel, navigates tasks and returns on desktop/phone | One persistent text conversation, clear project/tool/model, no attachments, usable keyboard layout and no accidental pause on close. | L-F02–05; U-L01–02; L-A03–04 |
| UX-L02 / required | User pauses, answers pending question while paused, then resumes after human changes | Answer preserved without auto-resume; executor continuation explicit; reconciliation precedes action. Restart has separate manual-resume state. | L-F10–12; U-L03, U-L05–06; L-A09–11 |
| UX-L03 / required | Default mode creates plan; mode B chosen; an out-of-goal change proposed | Goal/DoD and plan approval visible, routine internal changes do not ask again, mode change is not implicit approval. No quality waiver or merge-confirmation layer added. | L-F13–14, L-F21; U-L04; L-A12–13 |
| UX-L04 / required | Question arrives while panel hidden, another task independent; choose option/custom response or open stale deep link | Specific question and dependencies reachable, independent work not shown globally blocked, answer/error/answered states truthful; notification click targets exact question without silent resume. | L-F06–09; U-L05–07; L-A05–08 |
| UX-L05 / required | User inspects completed result and process update/rollback conflict | Revision/check outcomes/unmet AC distinct from draft PR; version/rationale and active-versus-next effects clear; no false final kit inventory. | L-F22–24, L-F27–30; U-L07–08; L-A18, L-A21–23 |
| UX-L06 / required | User edits project role instruction; model attempts same; leader resumes | Effective user customization/save state visible; model edit rejected; startup/resume uses tested instruction version. Editor is distinct from adaptive skills. | L-F33; U-L09; L-A29 |
| UX-L07 / required | Backend unavailable, project occupied, stale mutation or lost response | Specific feedback and legitimate recovery, no second owner, no duplicate retry effect, preserved text/plan; no misleading “all tasks stopped”. | L-F01, L-F34–35; U-L10; L-A24–25, L-A31–32 |
| UX-L08 / proposal | Keyboard/screen-reader/zoom/reduced-motion and phone-keyboard walkthrough | Focus remains meaningful, statuses have textual cues, live announcements are not noisy, draft/custom input stays accessible, and history reading is not forcibly interrupted. | U-L11–12 |

### Design readiness audit

**Ready for design:** main panel/maximize/mobile flow; startup choices; persistent conversation; structured questions; plan modes; pause/resume/reconciliation; task navigation; user-only instruction editing; generic kit history/rollback/conflict screens; explicit empty/error/unavailable states. Proposed placement/cards/copy can be refined by the designer without a new product interview for every control.

**Needs engineering validation before final UX sign-off:** native client adapter startup/occupied errors, actual system notification/deep-link support per browser, pause acknowledgement races, effective prompt application and queued-task version boundary. **Deferred source-dependent detail:** final kit content and complete practice map await the user's signal; this blocks final catalog content/transfer acceptance, not generic screen design.

One bounded unresolved interaction needs an explicit design/product rule: changing planning mode while a plan is already awaiting approval. Recommended conservative treatment is to apply the new mode to later goals and keep the pending plan awaiting its explicit decision. This is a proposal, not an invented prior agreement. Handover between external/native and built-in client also requires a supported orderly end/reconnect flow; no forced-disconnect UI is authorized.

Checklist before design handoff: map U-L01–12 to screens and reusable components; include every state and deep-link case; annotate required versus proposed behavior; show user-only role editing and immutable quality; define focus/responsive/notification fallbacks; attach UX-L01–08 to component/integration acceptance; mark source and adapter gaps honestly. Required UX cases join the whole-feature DoD; proposed visual/accessibility details receive design review and must not reduce agreed functional scope.
