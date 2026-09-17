# Audit-trail origins — technical specification (2026-09-17)

Status: **Accepted implementation plan for GitHub issue #306**. Target: 0.16.0.

This record turns the local audit trail into one ordered history for changes entering through the cockpit HTTP door (`ui`), MCP (`mcp`), the automation runner (`automation`), and a headless command (`cli`). It is an implementation specification, not a claim that those four writers exist yet.

## 1. Authority, evidence notation, and boundaries

The owner settled the seven design questions on 2026-09-17: origin is derived from the door; every command-line subcommand is audited; an automation creates a record linked to its receipt; `ui` records the same action set as MCP (run-state changes and configuration writes; reads never), which § 6 derives from the complete current MCP action inventory; actors are door-specific; the file becomes `audit.ndjson`, rotates at 10 MB (10,000,000 bytes), and keeps five files; and every door uses one redaction seam. The same decision adds proxy attribution, refusal outcomes, sequence numbers, UTC timestamps, file modes, compatibility checks, and an ordered four-PR delivery.

Evidence labels in this record mean:

- **Verified (`file:line`)**: inspected in the current task worktree at the cited line.
- **Inferred**: a conclusion from cited source, not behavior exercised live.
- **Specified**: required future behavior; it makes no current-code claim.

The current contract permits all four origin strings, but its comments state that only `mcp` is emitted. **Verified** (`packages/contract/src/mcp-audit.ts:27-45`). The current record is `v: 1`, has a string `outcome` vocabulary of `ok | rejected | not-applied | unverified`, and has no `actor` or sequence field. **Verified** (`packages/contract/src/mcp-audit.ts:47-100`). The only production channel is composed as `.channel('mcp')`, and the door skips tools marked read-only. **Verified** (`packages/xezar/src/mcp/index.ts:283-300`). It records a thrown effect as `unverified`, a recognized stale-version refusal as `rejected`, and other settled tool results as `ok` or `unverified`. **Verified** (`packages/xezar/src/mcp/index.ts:301-334`).

The current writer appends synchronously to `mcp-audit.ndjson` with create mode `0600`, warns once, and lets the operation continue on a write error. **Verified** (`packages/xezar/src/mcp/audit-trail.ts:64-67`, `:145-160`, `:205-215`, `:268-274`). It neither locks nor rotates, and `mode: 0o600` does not repair an already-existing file's mode. **Inferred** from the sole append path (`packages/xezar/src/mcp/audit-trail.ts:205-215`) and the absence of another production writer established by the construction-site guard (`packages/xezar/src/mcp/audit-origin-wiring.test.ts:71-115`).

This feature does not add a cockpit page, an audit HTTP read route, remote export, cryptographic signing, hash chaining, authorization based on audit data, or publication of an audit file. Audit data remains disposable local state. A local agent or person with shell access to the project can read, edit, truncate, replace, or delete the audit files. The trail is operational evidence, not a tamper-proof security log.

## 2. Acceptance criteria

- **A1 — Contract:** every new record validates against the Zod-level v2 shapes in § 3, has a per-file-set monotonically increasing sequence, and has a UTC `Z` timestamp. An action record carries a door-derived origin and matching actor, and says either `applied` or `refused` with a bounded machine reason.
- **A2 — Four doors:** one real production action and one real refusal from each of `ui`, `mcp`, `automation`, and `cli` appear in the saved four-door harness with the expected actor and no caller-controlled origin. For `ui` and `mcp` the harness also holds one applied and one refused record for every mutation family F1–F10 in § 6.5, except where § 6 names a door that cannot apply that family.
- **A3 — Command line:** every valid top-level subcommand and every valid `projects` subcommand in the verified inventory in § 5 creates exactly one command-level action record; help/version flags and unknown commands follow the explicit exclusions there.
- **A4 — Safe shared file:** all four writers use the same project-scoped lock, sequence allocator, redaction seam, append path, rotation path, mode enforcement, and one-warning failure policy. Two processes crossing the limit neither lose nor duplicate an action record.
- **A5 — Compatibility:** the new name wins; the old name is a read-only fallback, is never rewritten, produces one deprecation warning when used, and cannot be removed before 0.18.0 and its tracking issue. The 0.15.0 reader result for every v2 record is measured and the breaking classification is documented.
- **A6 — Redaction:** the field inventory in § 9 is exhaustive. Configuration bodies persist key names and a digest of the redacted canonical summary, never values. A writer cannot append without calling the shared seam.
- **A7 — Recovery:** an unavailable lock, unwritable directory, failed mode repair, rotation failure, or append failure never changes the user's action result; it produces at most one audit warning for that project in that process.
- **A8 — Evidence:** unit, route, packaged-command, four-door, concurrency, redaction, old-reader, and 0.15.0 upgrade/downgrade tests pass, and each failing-first proof fails at its named break from § 11.
- **A9 — Shared action inventory:** `ui` and `mcp` read one semantic action inventory (§ 6). Every current MCP tool action and every current non-GET HTTP route is classified as a mutation or a read. A mutation reached through both doors gets the same action id from both. A read gets no record from either door. Removing one inventory row or one route descriptor fails the parity test.

## 3. Record contract

### 3.1 Zod-level shape

The contract package remains the only source of record types. The implementation may factor the schemas differently, but it must be mutually assignable to this shape and infer all TypeScript types with `z.infer`.

```ts
const auditIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const auditReasonSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
const auditTimestampSchema = z.iso.datetime()
  .refine((value) => value.endsWith('Z'), 'audit timestamps must be UTC');

const auditOutcomeV2Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('refused'), reason: auditReasonSchema }).strict(),
]);

const auditActorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ui'),
    proxyUser: z.object({
      value: z.string().min(1).max(128)
        .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), 'control characters are forbidden'),
      trust: z.literal('asserted-by-proxy'),
    }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal('mcp') }).strict(),
  z.object({
    type: z.literal('automation'),
    receiptId: auditIdSchema,
  }).strict(),
  z.object({
    type: z.literal('cli'),
    command: z.enum([
      'serve', 'run', 'init', 'projects.list', 'projects.add',
      'projects.remove', 'projects.tag', 'projects.port', 'mcp',
      'server-install', 'server-deploy', 'server-uninstall',
    ]),
  }).strict(),
]);

const auditBaseV2Schema = z.object({
  v: z.literal(2),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ts: auditTimestampSchema,
  projectId: auditIdSchema,
});

const auditActionV2Schema = auditBaseV2Schema.extend({
  kind: z.literal('action'),
  origin: z.enum(['ui', 'mcp', 'automation', 'cli']),
  actor: auditActorSchema,
  action: z.string().min(3).max(64).regex(/^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)+$/),
  resource: z.object({ kind: z.string().min(1).max(32), id: auditIdSchema }).strict().optional(),
  outcome: auditOutcomeV2Schema,
  ownerGeneration: z.number().int().nonnegative().optional(),
  operationKey: z.string().min(1).max(257).optional(),
  versionToken: z.string().max(200).optional(),
  fieldNames: z.array(z.string().min(1).max(64)).max(64).optional(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().superRefine((record, ctx) => {
  if (record.actor.type !== record.origin) ctx.addIssue({ code: 'custom', message: 'actor must match origin' });
  if (record.origin !== 'mcp' && (record.ownerGeneration !== undefined || record.operationKey !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'MCP join fields are MCP-only' });
  }
});

const auditRotatedV2Schema = auditBaseV2Schema.extend({
  kind: z.literal('rotated'),
  previousLastSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const auditRecordSchema = z.discriminatedUnion('kind', [
  auditActionV2Schema,
  auditRotatedV2Schema,
]);
export type AuditRecord = z.infer<typeof auditRecordSchema>;
```

The `origin`/`actor` coupling is part of validation, not a writer convention. A request body has no `origin`, `actor`, `seq`, `ts`, or `projectId` field. Unknown keys are rejected before persistence by the strict v2 shape. `ownerGeneration` and `operationKey` remain optional, top-level, and MCP-only so the join fields stay available while the new actor remains a small identity description.

This is not an additive evolution of the current `outcome` field: v1 already uses a different string enum. **Verified** (`packages/contract/src/mcp-audit.ts:47-49`, `:72-100`). Version 2 deliberately changes it to a structured applied/refused result, so PR 1 must classify the persisted-record change as breaking under the repository rule that making an existing file unreadable is breaking. **Verified rule** (`BACKWARD_COMPATIBILITY.md:3-8`). This conclusion is not reopened as an owner question; it is the required consequence of the settled outcome vocabulary.

### 3.2 Meaning

- `applied` means the requested state-changing operation took effect or a command invocation reached its defined effect. It does not mean the spawned task later succeeded.
- `refused` means the door rejected the operation before its effect. `reason` is a stable machine code, never an error message.
- An error after the effect may have started is not falsely recorded as refused. Until a third owner-approved state exists, it produces no action record and emits the one warning, because the v2 vocabulary has no honest “unknown whether applied” value.
- `seq` is monotonic across the live file and its four retained rotated siblings. Persisted values never duplicate or decrease; a quarantined corrupt line may leave an observable gap. A failed append persists no allocation, so the next successful writer derives its value from the last valid persisted record.
- Both marker and action timestamps come from `new Date().toISOString()` and therefore end in `Z`. One operation gets one sampled timestamp; a rotation marker samples its own timestamp.
- `kind: rotated` is the first complete line in a newly created live file. Its `previousLastSeq` points to the last sequence allocated before rotation; the following action receives the next sequence.

## 4. One writer, four door adapters

`AuditTrail` becomes the project-scoped storage service. `AuditChannel` remains the door adapter, but it accepts a typed actor factory and can write only through `redactAuditInput` and `appendAuditRecord`. Every construction site must be enumerated by the existing wiring guard, updated from one expected door to the four sites below. **Verified current guard** (`packages/xezar/src/mcp/audit-origin-wiring.test.ts:71-115`).

| Door | Required construction and hook | What settles the record |
| --- | --- | --- |
| `mcp` | Keep construction in `composeDoor`, where the project id, data directory, warning sink, and MCP connection secrets already meet. **Verified current site** (`packages/xezar/src/mcp/index.ts:190-213`, `:268-285`). Move the read-only decision from tool-level annotation to the shared action inventory in § 6 so read actions inside a mixed tool are not audited. | The existing MCP result classifier maps a pre-effect refusal to `refused`; successful mutation to `applied`. A post-effect/ambiguous tool error follows § 3.2. The server mints origin and actor; tool arguments cannot override them. |
| `ui` | Construct `channel('ui')` in each lazily built project context and expose an audit decorator to the chained route families that § 6 maps. The decorator wraps the inventoried route handler after Zod middleware, not the global Hono app and not a client header. Project contexts are currently the per-registered-project construction boundary. **Verified** (`packages/xezar/src/server/project-context.ts:1-120`). Project-scoped families are mounted under both prefixes and workspace families once. **Verified** (`packages/xezar/src/server/server.ts:6061-6064`). A project-scoped route writes to its resolved project's audit. A workspace-level route writes to the project it names (`:projectId`, or the root it registers or clones once resolved); a route that names no project, or whose target cannot be resolved, writes to the server's boot project. **Specified**, by the same rule § 5 uses for the invocation project. | 2xx after the effect is `applied`; a known 4xx refusal before effect is `refused` with a route-owned code. 5xx or thrown ambiguity follows § 3.2. No GET/HEAD/OPTIONS route is audited. |
| `automation` | Construct `channel('automation')` in the workspace automation handle and pass it into `ProjectAutomationScheduler`. Write beside the existing receipt transition: reservation already mints `receiptId` before launch, launch receives it, and success/error writes the receipt. **Verified** (`packages/xezar/src/automations/scheduler.ts:108-121`; server composition at `packages/xezar/src/server/server.ts:6121-6148`). | A launched run is `applied`, linked through `actor.receiptId` and `resource: {kind:'run', id}`. A duplicate receipt, held lease, disabled capability, filter miss, and preview are reads/no-ops and are not action records. A launch refusal known to precede `RunManager.startRun` is `refused`; an ambiguous throw follows § 3.2. |
| `cli` | Create one CLI channel after the command's project scope and data directory are resolved, before dispatch in `main`; pass it explicitly to command handlers. The current dispatch is one switch over all top-level commands. **Verified** (`packages/xezar/src/index.ts:120-147`, `:187-252`). `projects` continues to work without a server. **Verified** (`packages/xezar/src/workspace/projects-cli.ts:14-23`). | Record once per valid subcommand invocation at its effect boundary, using the canonical command id in § 5. Pre-effect validation/policy failures are `refused`; a command that started its effect is `applied` even if a spawned task or hosted service later reports failure. An ambiguous effect follows § 3.2. |

The route decorator and command wrapper must accept a closed `AuditDescriptor` produced next to the action definition. There is no “audit all mutations” fallback: a new mutation without a descriptor fails the inventory test, while a read cannot become audited merely because it shares a mixed MCP tool or route family.

## 5. Complete command-line inventory

The current top-level dispatch contains `serve`, `run`, `init`, `projects`, `mcp`, `server-install`, `server-deploy`, and `server-uninstall`, with bare invocation defaulting to `serve`. **Verified** (`packages/xezar/src/index.ts:187-247`). The current `projects` dispatcher contains `list`, `add`, `remove`/`rm`, `tag`, and `port`. **Verified** (`packages/xezar/src/workspace/projects-cli.ts:35-44`, `:55-94`). The help banner currently omits `tag`, so the implementation PR that touches the command inventory must correct that separately; this spec does not treat the omission as a new command. **Verified** (`packages/xezar/src/index.ts:64-77`; `packages/xezar/src/workspace/projects-cli.ts:35-44`).

| Invocation | Canonical action | Record point and resource |
| --- | --- | --- |
| `xezar` or `xezar serve` | `cli.serve` | `applied` after the server owns its listening socket; refusal before a listener uses a bounded reason. Resource is the bound project. |
| `xezar run …` | `cli.run` | `applied` once `startRun` returns; resource is the run id. Missing task, unknown workflow, or provider gate is `refused`. The task/prompt and model value are never fields. |
| `xezar init` | `cli.init` | `applied` after the non-overwriting scaffold completes, including an already-present no-op; resource is the project. |
| `xezar projects` / `projects list` | `cli.projects.list` | One `applied` command record in the invocation project's data directory. This is the explicit exception to “reads never”: the owner required every CLI subcommand. It stores neither listed roots nor project count. |
| `projects add [dir]` | `cli.projects.add` | Target directory's project audit when registration resolves it; otherwise the invocation project's audit records a refusal. Never store the path. |
| `projects remove <id>` / `rm <id>` | `cli.projects.remove` | Both spellings normalize to one action. Resolve and open the target project's audit before removing the registry row; unknown-id refusal falls back to the invocation project. |
| `projects tag <id> [tags…]` | `cli.projects.tag` | Target project resource; store field name `tags` and a digest of the redacted normalized summary, never tag strings. |
| `projects port <id> [port]` | `cli.projects.port` | Target project resource; store field name `port` and a digest of the redacted normalized summary, never the supplied value. |
| `xezar mcp` | `cli.mcp` | `applied` after bridge connection/handshake; bridge refusal is `refused`. Individual tool mutations remain separate `mcp` records. |
| `server-install` | `cli.serverInstall` | Invocation project; `applied` when the installer begins its selected plan, refusal before that point. Domain, port, platform-specific output, and paths are excluded. |
| `server-deploy` | `cli.serverDeploy` | Invocation project; same boundary as install. |
| `server-uninstall` | `cli.serverUninstall` | Invocation project; same boundary as install. |

`--help` and `--version` are flags that return before command/project resolution. **Verified** (`packages/xezar/src/index.ts:153-163`). They create no audit record. An unknown top-level command or unknown `projects` word is not a valid subcommand and creates no record; this keeps arbitrary caller text out of the action field. Global invocation validation currently happens before project resolution and writes nothing. **Verified** (`packages/xezar/src/index.ts:165-190`). That remains true for malformed global flags.

## 6. Shared action inventory for `ui` and `mcp`

The owner's rule is that `ui` records the same action set as MCP. So there is one semantic inventory, not a UI allowlist that is written by hand. Each row has a dotted action id, a class (`mutation` or `read`), the MCP `tool.action` values that reach it, and the HTTP method plus route template that reach it. A route whose body selects the effect (for example `archived: false`, `mode`, or `action`) maps each body value to its own row. Both doors take the action id from this table, so the same effect gets the same id whichever door it came through. **Specified.**

The inventory is derived from the current MCP action set. Only the `readOnlyHint: true` tools skip the door today, so every action of every other tool is audited now, reads included. **Verified** (`packages/xezar/src/mcp/index.ts:286-297`; annotations at `packages/xezar/src/mcp/tools/task-reads.ts:437`, `discovery.ts:385`, `results-evidence.ts:275`, `handoff-git.ts:632`). V2 keeps every MCP action that changes state, or that is refused at a boundary whose cockpit counterpart changes state. It drops the reads (§ 6.3). The current server registers 63 non-GET routes. **Verified** (count of `.post(`, `.put(`, `.patch(`, `.delete(` in `packages/xezar/src/server/server.ts`). Sixty of them map to mutation rows below, and three are read-like. No GET, HEAD or OPTIONS route, SSE replay or WebSocket subscription is ever audited.

MCP action lists are verified at `packages/xezar/src/mcp/tools/execution-control.ts:58-65`, `work-organisation.ts:91-107`, `task-create.ts:40`, `handoff-git.ts:114`, `project-config.ts:111-148` and `:185-271`, `local-handoff.ts:40`, and `leader-events.ts:97`. Route lines below are in `packages/xezar/src/server/server.ts`.

### 6.1 Mutations reachable through both doors

| Family | Action id | MCP `tool.action` | HTTP route (line) |
| --- | --- | --- | --- |
| F1 run | `run.start` | `task_create.start` | `POST /runs` (3701) |
| F1 run | `run.startFromInbox` | `task_create.start_from_inbox`, `organise_work.start_inbox_item` | `POST /todos/:id/start` (4872) |
| F1 run | `run.update` | `organise_work.set_title`, `organise_work.edit_brief` | `PATCH /runs/:id` (3872); `fieldNames` says which one |
| F1 run | `run.cancel` | `execution_control.cancel` | `POST /runs/:id/cancel` (3910) |
| F1 run | `run.message` | `execution_control.send_message`, `execution_control.answer_question` when they reach this route | `POST /runs/:id/messages` (3924) |
| F1 run | `run.continue` | `execution_control.continue`; `send_message` and `answer_question` when they reach this route | `POST /runs/:id/continue` (4062) |
| F1 run | `run.finish` | `execution_control.finish` | `POST /runs/:id/finish` (4049) |
| F1 run | `run.queuedMessage.edit` | `execution_control.edit_queued_message`, `organise_work.edit_queued_message` | `PATCH /runs/:id/queued-messages/:msgId` (3988) |
| F1 run | `run.queuedMessage.remove` | `execution_control.remove_queued_message`, `organise_work.remove_queued_message` | `DELETE /runs/:id/queued-messages/:msgId` (4032) |
| F1 run | `run.autoResume.cancel` | `execution_control.cancel_auto_resume` | `DELETE /runs/:id/auto-resume` (3675) |
| F1 run | `run.archive` / `run.restore` | `organise_work.archive` / `.restore` | `POST /runs/:id/archive` (3637), by `archived` |
| F1 run | `run.pin` / `run.unpin` | `organise_work.pin` / `.unpin` | `POST /runs/:id/pin` (3659), by `pinned` |
| F1 run | `run.markRead` / `run.markUnread` | `organise_work.mark_read` / `.mark_unread` | `POST /runs/:id/read` (3686) / `POST /runs/:id/unread` (3693) |
| F1 run | `run.markAllRead` | `organise_work.mark_all_read` | `POST /runs/read-all` (3635) |
| F1 run | `run.archiveFinished` | `organise_work.archive_finished` | `POST /runs/archive-finished` (3631) |
| F1 run | `run.delete` | `organise_work.delete` | `DELETE /runs/:id` (4525) |
| F1 run | `group.pickVariant` | `organise_work.pick_variant` | `POST /groups/:groupId/pick` (4584) |
| F1 run | `inbox.remove` | `organise_work.remove_inbox_item` | `DELETE /todos/:id` (4852) |
| F2 Git/PR/worktree | `run.git.commit` | `handoff_git.commit` | `POST /runs/:id/git/commit` (4423) |
| F2 Git/PR/worktree | `run.git.push` | `handoff_git.push` | `POST /runs/:id/git/push` (4438) |
| F2 Git/PR/worktree | `run.pr.create` | `handoff_git.create_pr` | `POST /runs/:id/pr` (4467) |
| F2 Git/PR/worktree | `pr.ready` | `handoff_git.ready` | `POST /github/prs/:number/ready` (5334) |
| F2 Git/PR/worktree | `pr.merge` | `handoff_git.merge` | `POST /github/prs/:number/merge` (5302) |
| F2 Git/PR/worktree | `repo.branch` | `handoff_git.branch` | `POST /repo/branch` (5477) |
| F2 Git/PR/worktree | `run.worktree.remove` | `project_config.remove_worktree` | `POST /runs/:id/remove-worktree` (4511) |
| F2 Git/PR/worktree | `worktree.reclaim` | `project_config.reclaim_worktrees` | `POST /worktrees/reclaim` (4746) |
| F3 local handoff | `run.openInTerminal` | `local_handoff.open_task_in_terminal` | `POST /runs/:id/open-in-cli` (4101) |
| F3 local handoff | `run.openInApp` | `local_handoff.open_task_in_app` | `POST /runs/:id/open-in` (4143) |
| F3 local handoff | `project.openInApp` | `local_handoff.open_project_in_app`; `project_config.open_in_app` (always refused) | `POST /open-in` (4648) |
| F4 project config | `project.config.set` | `project_config.set_config` | `PUT /config` (5529) |
| F4 project config | `project.registry.update` | `project_config.set_project` | `PATCH /projects/:projectId` (2527), workspace-level |
| F4 project config | `project.uiState.set` | `project_config.set_prompt_templates` | `PUT /ui-state` (3191); `fieldNames` separates templates from other preferences |
| F4 project config | `agentConfig.write` | `project_config.write_agent_config` | `PUT /agent-config/:id` (5713) |
| F5 workflow files | `workflow.save` | `project_config.save_workflow`, `task_create.save_plan` | `POST /workflows` (3217) |
| F5 workflow files | `workflow.delete` | `project_config.delete_workflow` | `DELETE /workflows/:name` (3255) |
| F6 automations | `automation.create` | `project_config.create_automation` | `POST /automations` (3404) |
| F6 automations | `automation.update` | `project_config.update_automation` | `PUT /automations/:id` (3442) |
| F6 automations | `automation.delete` | `project_config.delete_automation` | `DELETE /automations/:id` (3460) |
| F6 automations | `automation.enable` | `project_config.enable_automation` | `POST /automations/:id/enable` (3470) |
| F6 automations | `automation.pause` | `project_config.pause_automation` | `POST /automations/:id/pause` (3489) |
| F6 automations | `automation.checkExecute` | `project_config.check_automation` with `mode: execute` | `POST /automations/:id/check` (3502) with `mode: execute` |
| F6 automations | `automation.receipt.retry` | `project_config.retry_automation_receipt` | `POST /automation-log/:receiptId/retry` (3544) |
| F7 skills/onboarding | `skills.refresh` | `project_config.refresh_skills` | `POST /skills/refresh` (3178) |
| F7 skills/onboarding | `onboarding.dismissOffer` | `project_config.dismiss_onboarding_offer` | `POST /onboarding/offered` (4808) |
| F8 leader session | `leader.attach` / `leader.stop` | `leader_events.attach` / `.stop` | `POST /mcp/leader` (5775), by `action` |

`automation.checkExecute` is the manual trigger through `ui` or `mcp`. A run that the automation runner launches is still the separate `automation.launch` record of the `automation` door (§ 4).

### 6.2 Mutations that MCP always refuses

These MCP actions dispatch nothing. They answer with a boundary refusal. **Verified** (`packages/xezar/src/mcp/tools/project-config.ts:185-271`). They pass the door today, so they are part of the audited MCP action set. In v2 `mcp` records each one as `refused`, and its reason is the boundary in snake case (for example `workspace_settings`). `ui` records the same action id as `applied` or `refused`. MCP can never apply these, so the MCP applied case does not exist.

| Family | Action id | MCP `tool.action` | HTTP route (line) |
| --- | --- | --- | --- |
| F9 project registry | `project.registry.add` | `project_config.add_project` | `POST /projects` (2410) |
| F9 project registry | `project.registry.clone` | `project_config.clone_project` | `POST /projects/checkout` (2595) |
| F9 project registry | `project.registry.remove` | `project_config.remove_project` | `DELETE /projects/:projectId` (2417) |
| F10 workspace | `workspace.config.set` | `project_config.set_workspace_config` | `PUT /workspace/config` (2936) |
| F10 workspace | `workspace.uiState.set` | `project_config.set_workspace_ui_state`, `project_config.import_skills` | `PUT /workspace/ui-state` (3055); `importedSkills` is a field of that shape. **Verified** (`packages/contract/src/workspace.ts:242`, `:278`) |
| F10 workspace | `skills.applyUpdates` | `project_config.apply_skill_updates` | `POST /workspace/skills-update/apply` (2844) |
| F10 workspace | `provider.setEnabled` | `project_config.set_provider_enabled` | `PUT /providers/:provider/enabled` (1775) |
| F10 workspace | `provider.retry` | `project_config.retry_provider` | `POST /providers/:provider/retry` (1803) |
| F10 workspace | `provider.connect` | `project_config.connect_provider` | `POST /providers/connect` (1820) |
| F10 workspace | `account.create` | `project_config.create_account` | `POST /workspace/agent-profiles` (2045) |
| F10 workspace | `account.update` | `project_config.update_account` | `PATCH /workspace/agent-profiles/:id` (2097) |
| F10 workspace | `account.openFile` | `project_config.open_account_file` | `POST /workspace/agent-profiles/:id/open` (2219) |
| F10 workspace | `account.select` | `project_config.select_account` | `PUT /workspace/agent-profiles/selection` (2271) |
| F10 workspace | `account.remove` | `project_config.remove_account` | `DELETE /workspace/agent-profiles/:id` (2324) |

§ 15.1 asks the owner to confirm this group. The recommendation is to keep it, and it applies until the owner answers.

### 6.3 Reads: no record from either door

- Every action of `task_read`, `discover_project`, `read_results_evidence` and the bridge `health` tool.
- The read actions inside mutating tools: `organise_work.list_queue`; `handoff_git.repo` and `.merge_state`; `local_handoff.list_apps`; `leader_events.read` and `.status`; `project_config` `get_config`, `get_project`, `get_prompt_templates`, `get_limits`, `get_capabilities`, `get_account`, `list_agent_config`, `read_agent_config`, `list_workflows`, `parse_workflow`, `list_skills`, `get_skill`, `list_importable_skills`, `check_skill_updates`, `list_automations`, `get_automation`, `get_automation_check`, `get_automation_log`, and `list_worktrees`.
- Refused reads: `project_config` `check_account_status`, `get_account_details`, `browse_folders` and `get_launch_key`. Their cockpit counterparts are reads.
- Preview requests: `task_create.plan` / `POST /plan` (3302), `parse_workflow` / `POST /workflows/parse` (3281), `check_skill_updates` / `POST /workspace/skills-update/check` (2837), and `check_automation` with `mode: preview` on `POST /automations/:id/check` (3502).

Some of these fill a cache or keep delivery bookkeeping. For example, `leader_events.read` saves its delivered cursor. **Verified** (`packages/xezar/src/mcp/reconnect.ts:206-211`). The `refresh` forms of `get_capabilities` and the GitHub reads re-probe their caches. They change no project state that a person set, so they stay reads. That is a deliberate change: `mcp` stops writing a record for `task_create.plan`, `leader_events.read` and the read actions of mixed tools.

### 6.4 MCP mutations with no HTTP route

- `leader.ack` (`leader_events.ack`). It calls `LeaderCursors.ack` directly. **Verified** (`packages/xezar/src/mcp/reconnect.ts:226-228`; action at `packages/xezar/src/mcp/tools/leader-events.ts:97`). No HTTP route acknowledges leader events, so only `mcp` can write this action. The inventory row says `ui: none` explicitly.

No other current MCP mutation lacks an HTTP route.

### 6.5 HTTP mutations with no MCP action, families, and the parity rule

Every one of the 60 current mutating routes has an MCP action in § 6.1 or § 6.2. So there is no HTTP-only mutation to put under open questions. The one borderline group, where the MCP action exists but can only refuse, is § 6.2, and § 15.1 lists it.

The families for tests and acceptance are F1–F10 as named in the tables. F8 also holds the MCP-only `leader.ack`. F9 and F10 have no MCP applied case.

The parity test (PR 2) makes the inventory the authority and not the tool annotation:

1. Every entry in `TOOL_ACTION_COVERAGE` has exactly one inventory class. **Verified source** (`packages/xezar/src/mcp/tools/api-coverage.testkit.ts:28`).
2. Every non-GET route in the built app route table (the same source `packages/xezar/src/server/bc-route-inventory.test.ts` reads) has a mutation descriptor or a read reason.
3. Every mutation row has an MCP mapping and either an HTTP route or an explicit `ui: none`.
4. An empty inventory, an empty route table or an empty MCP coverage map fails the test. It is never read as "no auditable mutations".

A new MCP action or a new non-GET route without a row fails the suite. The implementer cannot leave it out quietly.

## 7. Shared lock, sequence, append, and rotation

### 7.1 Files and ownership

- Live: `<dataDir>/audit.ndjson`.
- Rotated: `audit.ndjson.1` through `audit.ndjson.4`; live plus four archives is the five-file retention set.
- Lock: `<dataDir>/audit.ndjson.lock`, mode `0600`; data directory mode remains the project-data convention.
- Legacy fallback: `<dataDir>/mcp-audit.ndjson`; it is not counted in retention and is never locked, renamed, chmodded, appended, or rotated by 0.16.0.

All live and rotated files are created and repaired to `0600`. If the writer cannot establish `0600`, it writes nothing and uses the normal warning path. The current writer only supplies a create mode. **Verified** (`packages/xezar/src/mcp/audit-trail.ts:205-215`).

D-09 previously selected count-based audit retention while leaving the count unresolved. **Verified** (`docs/features/mcp-server/mcp-d09-limits-retention-packaging-decision.md:75-84`, `:124-131`). The owner's later 10 MB/five-file decision supersedes that mechanism for #306; PR 3 updates D-09 as well as D-06 so maintained decisions do not disagree.

### 7.2 Lock algorithm

Factor the proven `open(path, 'wx', 0o600)` lock into a reusable bounded file-lock helper without changing workspace-config's fail-open policy. The current config lock has an in-process queue, a 2 s wait, 20 ms polling, 30 s stale threshold, PID/timestamp metadata, dead-owner takeover, and `finally` release. **Verified** (`packages/xezar/src/workspace/config-lock.ts:35-55`, `:79-112`, `:119-190`). Audit uses the same constants and stale rules but a different timeout result: it **skips the audit write** instead of writing unlocked.

For each attempted action record:

1. Queue by absolute lock path inside the process.
2. Acquire `audit.ndjson.lock` atomically. Reclaim only a dead/invalid owner or a lock older than 30 s. Wait at most 2 s.
3. If acquisition, directory creation, or lock metadata fails, return `null`, warn once, and do not change the user's action result.
4. Under the lock, determine the last allocated sequence from the last valid v2 line of live then rotated files. A corrupt/truncated tail is quarantined; scan backward to the last valid record. If no v2 record exists, start at 1. Never derive sequence outside the lock.
5. Redact and validate the action candidate. Invalid/redaction-refused candidates use the same warning path and append nothing.
6. Serialize one line plus `\n` to bytes. If `liveSize + actionBytes <= 10_000_000`, append it and set/repair mode `0600`.
7. Otherwise rotate under the same lock: delete `.4`; rename `.3→.4`, `.2→.3`, `.1→.2`, and live→`.1`; chmod every retained file `0600`; create live `0600`; append a `rotated` marker as its first line; then append the action as its second line. The marker and action receive consecutive sequences. No other process can observe a partially chosen generation while holding the protocol lock.
8. Close file handles, release in `finally`, then return the persisted action record. A failure at any filesystem step stops that attempted audit write, leaves recoverable files as found, warns once, and never rolls back or masks the user's operation.

The size check includes the pending action but not a speculative marker. A single bounded action fits well below 10 MB. Rotation is pre-append, so a successful live file is never intentionally over the limit. A crash can leave a completed rename without a marker; the next lock holder repairs by creating live and writing the marker before its own action, using the maximum retained sequence. It never synthesizes the action that may have been lost in the crash.

One warning means one line per project-scoped `AuditTrail` per process, shared by lock, mode, rotation, validation, and append failures. The text contains a bounded error code only—never a path, record, proxy user, receipt, or payload—and ends with “the action continued without an audit record.”

## 8. File-name compatibility and readers

Reads follow this exact precedence:

1. If `audit.ndjson` exists, read the new live file and its retained rotations oldest-to-newest. Ignore `mcp-audit.ndjson` even when it also exists.
2. If the new live file is absent and `mcp-audit.ndjson` exists, read that legacy file using the v1 schema, do not rewrite it, and emit one deprecation line per process: `xezar: mcp-audit.ndjson is deprecated; reading it read-only (removal not before 0.18.0)`.
3. If neither exists, return an empty trail without warning.

The alias is removed no earlier than 0.18.0 and only after a dedicated tracking issue exists, the two-version window has elapsed, and release notes give the manual preservation path. PR 1 creates/links that issue. The alias never merges two histories: “new wins” is deterministic and prevents duplicate lines after an interrupted migration. Both files may remain on disk indefinitely.

The current reader skips malformed/schema-invalid lines and counts them as quarantined rather than crashing. **Verified** (`packages/xezar/src/mcp/audit-trail.ts:170-203`). The v2 shape changes `v` and `outcome`, so the released 0.15.0 v1 schema is expected to reject and skip every v2 action and marker. The compatibility test must execute 0.15.0 rather than restating that inference. If observed, PR 1 records the state-file change as breaking in `BACKWARD_COMPATIBILITY.md`, `CHANGELOG.md`, and the 0.16.0 upgrade note. The regenerated `docs/features/mcp-server/mcp-api.json` diff is attached to PR 1 evidence, not hand-edited.

Downgrade safety means 0.15.0 starts, reads its untouched legacy file, ignores `audit.ndjson`, and neither crashes nor deletes bytes. It does **not** mean 0.15.0 can display v2 records. Upgrade safety means 0.16.0 preserves the legacy bytes, starts a new v2 history, and follows the precedence above.

## 9. Redaction seam and field inventory

`redactAuditInput(descriptor, doorContext)` is the only constructor accepted by the storage writer. It returns either a validated `auditActionV2Schema` input without storage-owned fields or a refusal to audit. `appendAuditRecord` is module-private; door modules cannot append JSON themselves. A source guard enumerates every `AuditChannel` construction and fails if it cannot prove that its `record` method calls the seam.

Common persisted fields are limited to `v`, `kind`, `seq`, UTC `ts`, trusted-scope `projectId`, server-owned `origin`, validated `actor`, allowlisted `action`, bounded resource kind/id, outcome/reason, optional MCP join fields, sorted `fieldNames`, and a SHA-256 digest. No prompt, message, task brief, command output, diff, file path, repository root, URL, email, header set, query string, raw request body, error message, candidate title, tag, domain, model, workflow contents, or config value has a field.

| Door | Inputs the seam may inspect | Fields it may persist | Must be dropped before hashing/persistence |
| --- | --- | --- | --- |
| `ui` | Validated route body, route template/params, trusted project scope, response status, proxy assertion context | § 6 action; bounded resource id (run, group, inbox entry, automation, receipt, workflow name, agent-config id, project id, PR number, provider or account id); outcome; accepted `fieldNames`; digest of the canonical redacted summary; optional asserted proxy user | All config values; prompts/messages/attachments; commit messages, PR titles and bodies, branch names; workflow YAML and automation prompts; account labels, folders and file paths; registered roots and clone URLs; raw body; arbitrary route params; all headers except the separately sanitized trusted proxy assertion; response/error text |
| `mcp` | Zod-parsed action args, server project binding, fencing generation, operation id, settled tool result | Normalized action/resource/outcome; `ownerGeneration`; `operationKey`; valid version token; config key names; digest of the canonical redacted summary | Caller origin/actor/project; prompt/message content; arbitrary tool result; secrets and connection token; config values before digest |
| `automation` | Definition id/revision, reserved receipt, allowlisted event enum, launch result/refusal | `actor.receiptId`; action `automation.launch`; automation or run resource; outcome; digest of `{automationId, revision, event}` after redaction | Candidate title/body, author, labels, assignees, URL, repository string, rendered task, poller/log error text |
| `cli` | Canonical parsed command id, trusted resolved project, normalized option-key inventory, effect result | `actor.command`; canonical action/resource/outcome; option/config key names; digest of canonical redacted summary | `argv`; task text; paths; tags; port/domain/model/workflow values; environment; stdout/stderr; error text |

For any configuration write, `fieldNames` is the sorted distinct list of accepted top-level key names. The digest is over the canonical, fully redacted parsed body: secret values are replaced before hashing, and no value is persisted as a separate field or plaintext. The same rule applies to CLI `projects tag/port`.

The current writer hashes a canonical parsed payload and drops known-secret-shaped optional identifiers, while retaining no raw payload field. **Verified** (`packages/xezar/src/mcp/audit-trail.ts:218-259`, `:322-371`). V2 replaces door-local use of that helper with the one seam above; environment-secret scanning remains defense in depth, not the primary field allowlist.

### Proxy user trust rule

The sole identity header is `X-Xezar-User` (case-insensitive per HTTP). It is read only when `capabilities.localHandoff` is false **and** the request's immediate TCP peer is loopback. The bundled nginx configuration sets it from nginx's authenticated `$remote_user` and overwrites any incoming value. A non-loopback peer—including a client reaching a non-loopback `--bind-host` directly or an external container proxy whose peer cannot be authenticated without configuration—is not trusted for identity and the header is ignored. This is the safe zero-config default; the action is still audited as `ui` with no user.

After trust succeeds, trim surrounding whitespace, remove C0/C1 control characters and DEL, cap to 128 UTF-16 code units, and omit an empty result. Persist it only as `{ value, trust: 'asserted-by-proxy' }`; never call it authenticated, verified, or an account. Local mode ignores the header even from loopback. The tests send a forged header directly around the proxy (absent actor field) and through the bundled authenticated proxy (sanitized asserted field present).

Hosted mode is currently derived from `XEZ_REMOTE=1` or a non-loopback bind. **Verified** (`packages/xezar/src/server/capabilities.ts:128-159`). The bundled nginx currently forwards host/address/protocol headers but no user header. **Verified** (`packages/xezar/src/server-install/platforms/ubuntu-vps.ts:136-167`). Therefore adding `X-Xezar-User $remote_user` belongs to PR 2 with the server-side trust rule; accepting arbitrary forwarded-user headers would be a security regression.

## 10. UX design

There is no new cockpit surface. The user-facing surfaces are the audit file and a single terminal warning/deprecation line, so `skip-design` is appropriate.

1. **Reader and job.** A local operator or support engineer opens the file after a state change to answer what door acted, what resource changed, whether it applied or was refused, and in what order. They next correlate the bounded ids with existing run/receipt data.
2. **First read.** Every line is self-contained: `seq`, UTC `ts`, origin/actor, action, resource, and outcome are visible without expanding another object except the small actor/outcome objects.
3. **Scanning many.** NDJSON stays chronological; numeric `seq` exposes gaps/duplicates; rotations read oldest-to-newest. No search UI is added because shell/editor tools already scan at most five bounded files.
4. **Critical distinction.** `applied` versus `refused` is written in words. A proxy user is explicitly `asserted-by-proxy`, never “verified”; color and icon do not carry either distinction.
5. **States.** Missing files mean no retained history; legacy-only emits the deprecation line; malformed lines are skipped and counted by readers; write/lock/rotation failure gives one actionable warning that the action continued unaudited; a refused action remains a normal record, not an error rendering.
6. **Deliberately absent.** No cockpit browser, export, filters, actor accounts, cryptographic proof, restore button, or merged legacy/new view is built. Those would widen access, identity, or retention beyond #306.
7. **Accessibility.** Terminal lines are plain text with no color-only meaning and work in lines/quiet contexts according to their existing warning channel. The file is text. Keyboard, focus, theme, announcements, and 375 px browser layout are not applicable because no visual control changes.
8. **Narrow output.** Warning text may wrap; the error code and “action continued without an audit record” never disappear. Records are not pretty-printed, so terminal width never changes stored bytes.
9. **Measured worst case.** Five files × 10,000,000 bytes gives a 50 MB retained target, excluding the read-only legacy file and a bounded overshoot only from a crash/recovery edge. Proxy user is 128 UTF-16 code units, identifiers 128 characters, action/reason 64, field names 64 entries. Lock wait is at most 2 s. These are specified bounds; representative record byte size and rotation duration remain to be measured in PR 3.

## 11. Verification and named breaks

A test is not a failing-first proof until it fails against its named deliberate break and passes with the implementation restored. Preserve each proof log in the implementing task's durable evidence.

| Layer | Required proof | Named break that must make it fail |
| --- | --- | --- |
| Contract unit | Parse one action/refusal per actor, marker, UTC-only timestamps, sequence bounds, actor/origin match, MCP-only join fields | `B-CONTRACT-ORIGIN`: remove the actor/origin refinement; mismatch fixture must turn green only when broken |
| Writer unit | Normal append, monotonic sequences, corrupt-tail recovery, `0600`, marker first, five-file retention, one warning | `B-WRITER-SEQ`: allocate `seq` before acquiring the lock; two-writer assertion must fail |
| Rotation concurrency unit/process | Two independent processes cross 10 MiB; exactly two action ids, unique consecutive sequences, one marker, no sixth file | `B-ROTATE-OUTSIDE-LOCK`: move size check/rename before lock; barrier fixture must lose or duplicate deterministically |
| Failure unit | Unwritable folder and failed chmod/rename/append leave the supplied effect result unchanged and warn once | `B-FAIL-CLOSED`: rethrow the filesystem error; user-action assertion must fail |
| Inventory parity | The four checks in § 6.5: every MCP action and every non-GET route is classified, every mutation maps to both doors or says `ui: none`, and empty inputs fail | `B-INVENTORY-OMIT`: delete one row (for example `automation.create`); the route-table and MCP-coverage assertions must fail |
| Route tests | For every family F1–F10, each mapped route writes exactly one record with its § 6 action id when applied, and one `refused` record for a route-owned 4xx before effect; workspace-level routes write to the project § 4 names; every § 6.3 read-like POST and one GET per family write none; direct and trusted-proxy user cases | `B-UI-FAMILY`: remove the descriptors of one family at a time; that family's applied and refused assertions must fail. `B-UI-HEADER`: accept `X-Xezar-User` without the immediate-peer check; the direct-forgery assertion must fail |
| MCP unit/integration | For every family F1–F8, one applied and one refused action; for F9 and F10, the boundary refusal writes `refused` with its boundary reason; every § 6.3 read action in a mixed tool writes none; one stale-version refusal; caller origin ignored; each paired case gets the same action id as its route test | `B-MCP-MIXED-READ`: restore the tool-level annotation shortcut; the mixed-read count must fail. `B-DOOR-NAME-SPLIT`: give one paired action a different id in one door; the same-id assertion must fail |
| Automation integration | Reserved receipt links to one applied launch; pre-launch refusal records refused; duplicate/no-match/preview write none | `B-AUTO-RECEIPT`: create the audit actor before receipt reservation; receipt equality must fail |
| Packaged command line | Install the packed tarball and invoke every row in § 5 in isolated data folders; `rm` normalizes; help/version/unknown exclusions hold; one refused case | `B-CLI-PROJECTS-TAG`: omit `tag` from the canonical command map; coverage assertion must fail |
| Redaction per field class, per door | Plant identifier secret, free text, path/URL, control text, config value, and door-specific secret in each door; no planted value appears as plaintext and secret replacement happens before the digest | `B-REDACT-<DOOR>-<CLASS>`: bypass that door/class transform one at a time; byte/digest assertions must fail for every mutation |
| Seam guard | Every production channel calls `redactAuditInput`; direct filesystem append is absent | `B-SEAM-BYPASS`: replace one channel call with `appendFile`; source/construction guard must fail |
| Saved four-door harness | One applied and one refused action per door; for `ui` and `mcp`, one applied and one refused action per family F1–F10 (F9 and F10: `mcp` refused only); hosted UI variant; rotation with two writers; legacy-only and both-name states. Effects that leave the machine (push, PR, merge, app launch, provider login) use the existing dry-run or injected fakes, never a real merge or launch. Save transcript and file hashes | `B-HARNESS-DOOR`: disable each door adapter in turn; the expected door matrix must fail. `B-HARNESS-FAMILY`: drop one family from the `ui` descriptors; the family matrix must fail |
| Old-reader contract | Run the exact 0.15.0 `auditEntrySchema`/reader over every v2 fixture and record parse vs quarantine without crash; attach regenerated `mcp-api.json` diff | `B-OLD-READER-THROW`: replace line-level skip with parse; mixed v1/v2 fixture must crash |
| Upgrade and downgrade package test (never trimmed) | Create a real data folder with 0.15.0, preserve a v1 record, upgrade to candidate, create all four origins and both filenames, run a 0.15.0 MCP bridge beside the 0.16.0 server, downgrade to 0.15.0, and verify startup plus byte preservation | `B-ALIAS-REWRITE`: rename/delete the legacy file during upgrade; legacy hash and downgrade assertions must fail |

The route tests exercise the real Hono middleware/handler boundary, not a helper alone. The packaged command test uses `npm pack` output, not `tsx src/index.ts`. The four-door harness is committed and reusable by QA. The 0.15.0 fixture/test is committed in the repository and never reduced to a hand-built JSON approximation.

## 12. Default-path and lifecycle regression review

- **Default path:** with no new setting or environment variable, all valid changes continue even when auditing is unavailable. The file is created lazily. No config is required. This preserves the zero-config and best-effort guarantees.
- **State exits:** lock wait exits by acquire, stale takeover, or bounded skip; write exits by persisted record or warned skip; rotation exits by complete marker+action or warned partial recovery; legacy mode exits when a new live file exists; deprecation exits only after the version/tracking conditions; each door action exits as applied, refused, or no record plus warning for ambiguity/failure.
- **Construction sites:** contract schemas; audit storage/channel; MCP composition; the § 6 shared action inventory; project-context/server route decorator for project-scoped and workspace-level families; automation scheduler handle; CLI dispatch and projects dispatcher; bundled nginx; API reference generator; compatibility/changelog documentation; test/harness/package fixtures.
- **Default-path guard:** removing the sole MCP audit-writer behavior is not hidden behind the three new channels. PR 1 must keep MCP writes on by default under the new filename; PR 2 must demonstrate all four with no flag.
- **Fail-open input guarantee:** an empty action inventory is a test failure, not “there were no auditable mutations.” Inventory tests pin the expected current action and command sets, and the § 6.5 parity test fails on an empty route table or MCP coverage map.

## 13. Ordered delivery

Every implementation PR is `risk-high`, targets the current default path, contains its own named-break evidence, and is independently reviewable. Later PRs do not retroactively supply an earlier PR's compatibility note.

### PR 1 — contract, rename, and legacy alias

Scope: v2 schemas; `audit.ndjson`; v1 read-only fallback/new-wins precedence; MCP writer moved to the new live name; v1/v2 reader behavior; regenerated API reference; D-06 § 10 and reference-page updates; removal tracking issue.

Falsifiable acceptance:

- With only `mcp-audit.ndjson`, the reader returns v1 rows, leaves file hash unchanged, and warns once.
- With both names, only `audit.ndjson` rows are returned and neither file changes.
- One real MCP mutation writes a v2 record to `audit.ndjson` with no opt-in flag.
- The exact 0.15.0 reader result for every v2 fixture is recorded.

Documentation in this PR: `BACKWARD_COMPATIBILITY.md` records the v2 outcome/filename break, alias precedence, downgrade limit, and removal floor; `CHANGELOG.md` calls the 0.16.0 state-file change breaking and gives the upgrade path; D-06 § 10.2/10.5/10.6 and `mcp-api.md/json` stop claiming MCP-only/current old filename.

### PR 2 — writers for UI, MCP inventory, automation, and CLI

Scope: shared descriptor/redaction entry point (without the exhaustive adversarial proofs reserved for PR 4); the § 6 shared action inventory with its MCP and HTTP mappings and the § 6.5 parity test; UI decorator for every mapped project-scoped and workspace-level route family (F1–F10); MCP per-action read/mutation decision from the same inventory; automation receipt hook; full CLI map; `X-Xezar-User` trust/sanitization and bundled nginx overwrite; saved four-door harness with the family matrix.

Falsifiable acceptance:

- The parity test classifies every current MCP action and every current non-GET route; deleting one row or one family's descriptors fails it.
- For `ui` and `mcp`, each family F1–F10 has one applied and one refused record with the same action id in both doors (F9 and F10: `mcp` refused only; `leader.ack`: `mcp` only).
- The harness contains exactly one applied and one refused expected record per door and no record for an enumerated read/no-op.
- A caller-supplied origin never changes a record.
- A forged proxy user around the proxy is absent; the bundled proxy assertion is present and labeled asserted.
- Every valid § 5 subcommand has packaged-command evidence.

Documentation in this PR: `BACKWARD_COMPATIBILITY.md` adds the actor/origin, command-recording, and proxy-assertion semantics; `CHANGELOG.md` announces the three new origins and the audit behavior of commands. The README upgrade note names the new audit location if PR 1 did not already place it in the release-facing section.

### PR 3 — shared locking, sequence, modes, and rotation

Scope: reusable bounded lock primitive; audit-specific skip-not-unlocked policy; sequence allocation; `0600` repair; 10 MB rotation; five-file set; marker/recovery; two-process fixture.

Falsifiable acceptance:

- A synchronized two-process boundary test retains both action ids once, with unique ordered sequences.
- The new live file begins with one marker after rotation; only five retained files exist and all are `0600`.
- Unwritable/lock-timeout/chmod/rename failures leave the user's sentinel effect unchanged and emit one warning.

Documentation in this PR: `BACKWARD_COMPATIBILITY.md` adds rotation ordering, sequence, marker, modes, and retained-file naming; `CHANGELOG.md` announces the 10 MB/five-file retention and best-effort failure behavior. D-06 § 10.5 and D-09 receive the final retention algorithm; D-06 retains the explicit local-shell tampering limit.

### PR 4 — exhaustive redaction and compatibility proofs

Scope: per-field-class/per-door failing-first tests, seam bypass guard, final saved-harness secret planting, packaged 0.15.0 upgrade/downgrade test, and full evidence attachment.

Falsifiable acceptance:

- Every `B-REDACT-<DOOR>-<CLASS>` mutation exposes its planted value and fails.
- A direct append bypass fails the seam guard.
- The real 0.15.0 → candidate → 0.15.0 folder test preserves both filenames and hashes, starts both versions, and exercises a 0.15.0 bridge beside the candidate server.

Documentation in this PR: `BACKWARD_COMPATIBILITY.md` changes only if the executable compatibility proof differs from PR 1's recorded result; `CHANGELOG.md` adds a security/redaction note and must not soften the breaking note. No new compatibility behavior is deferred to this documentation-only proof PR.

## 14. Risks, dependencies, and rollback

- **Ambiguous outcome:** the owner chose two v2 outcomes while current code has an unverified state. The design avoids lying by skipping ambiguous action records with a warning; reviewers must reject any mapping of an uncertain post-effect failure to `refused`.
- **Cross-process ordering:** sync MCP writes, async route/automation paths, and short-lived CLIs converge on one lock. No adapter may retain a private sequence cache.
- **Proxy spoofing:** only the bundled loopback proxy can supply an actor by default. External proxies still get complete `ui` records without identity rather than a spoofable name.
- **Downgrade visibility:** 0.15.0 cannot see v2 history. The untouched legacy bytes and documented breaking minor release are the recovery path.
- **Rotation crash:** filesystem rename groups are not transactional. The next writer repairs a missing live file and marker but cannot promise a record whose process died mid-write.
- **Rollback:** revert door adapters first while retaining v2 reader/writer compatibility; do not restore writes to the legacy filename. If v2 itself must roll back before release, restore the v1 writer and remove all v2 files only in fixtures—never rewrite a user's data.

Dependencies: PR 1 precedes every writer; PR 2 supplies the four construction sites before the construction guard can require them; PR 3 owns concurrency/retention; PR 4 depends on all preceding behaviors. The API-reference generator and packed-command harness are required evidence, not optional tooling.

## 15. Open questions

None of the seven settled questions is reopened. One confirmation is open for the owner (§ 15.1). The recommendation there applies until the owner answers, so it does not block PR 1.

### 15.1 Owner confirmation: mutations that MCP can only refuse

- **Question.** The 14 workspace routes in § 6.2 (project registry add/clone/remove, workspace config and preferences, skill updates, providers, and agent accounts) have an MCP action, but that action always refuses. Should `ui` record them?
- **Option A – keep them (recommended).** MCP already audits these actions as refusals, so "the same action set as MCP" includes them. They are also the widest changes a person can make, because each one reaches every project. Cost: PR 2 needs the F9 and F10 route tests and the workspace-level project attribution in § 4.
- **Option B – leave them out.** The `ui` door then records none of them, and `mcp` still records its refusals. Cost: a cockpit change to the registry, providers or accounts leaves no audit record. Also the two doors no longer cover the same set.
- **HTTP-only mutations.** There are none today (§ 6.5). A new mutating route without an MCP action must come back here as a question with a recommendation. The implementer must not decide it.

Implementation must still measure and report, without changing this contract:

- representative v2 record byte size and two-process rotation duration on supported local filesystems;
- the exact released 0.15.0 parse/quarantine counts and `mcp-api.json` generated diff;
- the tracking-issue number for legacy-alias removal, created in PR 1;
- whether an external non-loopback proxy can later gain trustworthy identity through a separately designed, opt-in authenticated peer mechanism. Until then its user header remains ignored.
