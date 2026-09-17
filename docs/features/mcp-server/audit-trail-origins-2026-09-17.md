# Audit-trail origins — technical specification (2026-09-17)

Status: **Accepted implementation plan for GitHub issue #306**. Target: 0.16.0.

This record turns the local audit trail into one ordered history for changes entering through the cockpit HTTP door (`ui`), MCP (`mcp`), the automation runner (`automation`), and a headless command (`cli`). It is an implementation specification, not a claim that those four writers exist yet.

## 1. Authority, evidence notation, and boundaries

The owner settled the seven design questions on 2026-09-17: origin is derived from the door; every command-line subcommand is audited; an automation creates a record linked to its receipt; UI covers the MCP-equivalent run-state and configuration changes but never reads; actors are door-specific; the file becomes `audit.ndjson`, rotates at 10 MB (10,000,000 bytes), and keeps five files; and every door uses one redaction seam. The same decision adds proxy attribution, refusal outcomes, sequence numbers, UTC timestamps, file modes, compatibility checks, and an ordered four-PR delivery.

Evidence labels in this record mean:

- **Verified (`file:line`)**: inspected in the current task worktree at the cited line.
- **Inferred**: a conclusion from cited source, not behavior exercised live.
- **Specified**: required future behavior; it makes no current-code claim.

The current contract permits all four origin strings, but its comments state that only `mcp` is emitted. **Verified** (`packages/contract/src/mcp-audit.ts:27-45`). The current record is `v: 1`, has a string `outcome` vocabulary of `ok | rejected | not-applied | unverified`, and has no `actor` or sequence field. **Verified** (`packages/contract/src/mcp-audit.ts:47-100`). The only production channel is composed as `.channel('mcp')`, and the door skips tools marked read-only. **Verified** (`packages/xezar/src/mcp/index.ts:283-300`). It records a thrown effect as `unverified`, a recognized stale-version refusal as `rejected`, and other settled tool results as `ok` or `unverified`. **Verified** (`packages/xezar/src/mcp/index.ts:301-334`).

The current writer appends synchronously to `mcp-audit.ndjson` with create mode `0600`, warns once, and lets the operation continue on a write error. **Verified** (`packages/xezar/src/mcp/audit-trail.ts:64-67`, `:145-160`, `:205-215`, `:268-274`). It neither locks nor rotates, and `mode: 0o600` does not repair an already-existing file's mode. **Inferred** from the sole append path (`packages/xezar/src/mcp/audit-trail.ts:205-215`) and the absence of another production writer established by the construction-site guard (`packages/xezar/src/mcp/audit-origin-wiring.test.ts:71-115`).

This feature does not add a cockpit page, an audit HTTP read route, remote export, cryptographic signing, hash chaining, authorization based on audit data, or publication of an audit file. Audit data remains disposable local state. A local agent or person with shell access to the project can read, edit, truncate, replace, or delete the audit files. The trail is operational evidence, not a tamper-proof security log.

## 2. Acceptance criteria

- **A1 — Contract:** every new record validates against the Zod-level v2 shapes in § 3, has a per-file-set monotonically increasing sequence, and has a UTC `Z` timestamp. An action record carries a door-derived origin and matching actor, and says either `applied` or `refused` with a bounded machine reason.
- **A2 — Four doors:** one real production action and one real refusal from each of `ui`, `mcp`, `automation`, and `cli` appear in the saved four-door harness with the expected actor and no caller-controlled origin.
- **A3 — Command line:** every valid top-level subcommand and every valid `projects` subcommand in the verified inventory in § 5 creates exactly one command-level action record; help/version flags and unknown commands follow the explicit exclusions there.
- **A4 — Safe shared file:** all four writers use the same project-scoped lock, sequence allocator, redaction seam, append path, rotation path, mode enforcement, and one-warning failure policy. Two processes crossing the limit neither lose nor duplicate an action record.
- **A5 — Compatibility:** the new name wins; the old name is a read-only fallback, is never rewritten, produces one deprecation warning when used, and cannot be removed before 0.18.0 and its tracking issue. The 0.15.0 reader result for every v2 record is measured and the breaking classification is documented.
- **A6 — Redaction:** the field inventory in § 9 is exhaustive. Configuration bodies persist key names and a digest of the redacted canonical summary, never values. A writer cannot append without calling the shared seam.
- **A7 — Recovery:** an unavailable lock, unwritable directory, failed mode repair, rotation failure, or append failure never changes the user's action result; it produces at most one audit warning for that project in that process.
- **A8 — Evidence:** unit, route, packaged-command, four-door, concurrency, redaction, old-reader, and 0.15.0 upgrade/downgrade tests pass, and each failing-first proof fails at its named break from § 11.

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
| `mcp` | Keep construction in `composeDoor`, where the project id, data directory, warning sink, and MCP connection secrets already meet. **Verified current site** (`packages/xezar/src/mcp/index.ts:190-213`, `:268-285`). Move the read-only decision from tool-level annotation to the normalized action inventory so read actions inside a mixed tool are not audited. | The existing MCP result classifier maps a pre-effect refusal to `refused`; successful mutation to `applied`. A post-effect/ambiguous tool error follows § 3.2. The server mints origin and actor; tool arguments cannot override them. |
| `ui` | Construct `channel('ui')` in each lazily built project context and expose an audit decorator to the chained project route families. The decorator wraps the allowlisted route handler after Zod middleware, not the global Hono app and not a client header. Project contexts are currently the per-registered-project construction boundary. **Verified** (`packages/xezar/src/server/project-context.ts:1-120`). Run and config route families are chained and project-scoped. **Verified** (`packages/xezar/src/server/server.ts:3625-3701`, `:5522-5529`, `:5684-5713`). | 2xx after the effect is `applied`; a known 4xx refusal before effect is `refused` with a route-owned code. 5xx or thrown ambiguity follows § 3.2. No GET/HEAD/OPTIONS route is audited. |
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

## 6. UI action inventory

UI audits state changes, not transport activity. The allowlist is shared semantically with MCP and includes:

- run creation and lifecycle/organization changes: start, patch title/brief, cancel, message/continue/finish, queued-message edit/remove, archive/restore, pin/unpin, read/unread/read-all, archive-finished, cancel auto-resume, and delete;
- project, workspace, and agent configuration writes reached through `PUT /config`, `PUT /workspace/config`, and `PUT /agent-config/:id`;
- the MCP equivalents of those actions, normalized to the same dotted action names even where MCP tool/action spelling differs.

The current run family exposes the corresponding mutators between `POST /runs/archive-finished` and `DELETE /runs/:id`; it also contains local handoff, Git, PR, and worktree operations. **Verified** (`packages/xezar/src/server/server.ts:3625-3701`, `:3872-4062`, `:4101-4153`, `:4423-4535`). The last group is outside the owner-defined run-state/config set and is not added silently; widening it requires a follow-up decision and inventory row. The three configuration writers are current project/workspace/agent-config routes. **Verified** (`packages/xezar/src/server/server.ts:2933-2937`, `:5522-5529`, `:5684-5713`).

No read route, planning/preview request, file/diff/commit fetch, health call, SSE replay, WebSocket subscription, local-open request, Git/PR action, workflow-file edit, skills refresh, onboarding acknowledgement, project registry operation, provider connection, or automation-definition management is in this UI allowlist. Some have MCP mutating-tool wrappers today, so the implementation must make the shared action inventory—not tool annotation—the authority. **Inferred** from the current tool-level read-only shortcut (`packages/xezar/src/mcp/index.ts:286-300`) and the mixed `project_config` action switch (`packages/xezar/src/mcp/tools/project-config.ts:856-1298`).

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
| `ui` | Validated route body, route template/params, trusted project scope, response status, proxy assertion context | Normalized action; run/config resource id; outcome; config `fieldNames`; digest of the canonical redacted summary; optional asserted proxy user | All config values; prompts/messages/attachments; raw body; arbitrary route params; all headers except the separately sanitized trusted proxy assertion; response/error text |
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
| Route tests | Each allowlisted UI route writes once; GET writes none; direct and trusted-proxy user cases; one 4xx refusal | `B-UI-HEADER`: accept `X-Xezar-User` without immediate-peer check; direct-forgery assertion must fail |
| MCP unit/integration | Real mutating tool writes; read action in a mixed tool writes none; one stale/refused action; caller origin ignored | `B-MCP-MIXED-READ`: restore the tool-level annotation shortcut; mixed read count must fail |
| Automation integration | Reserved receipt links to one applied launch; pre-launch refusal records refused; duplicate/no-match/preview write none | `B-AUTO-RECEIPT`: create the audit actor before receipt reservation; receipt equality must fail |
| Packaged command line | Install the packed tarball and invoke every row in § 5 in isolated data folders; `rm` normalizes; help/version/unknown exclusions hold; one refused case | `B-CLI-PROJECTS-TAG`: omit `tag` from the canonical command map; coverage assertion must fail |
| Redaction per field class, per door | Plant identifier secret, free text, path/URL, control text, config value, and door-specific secret in each door; no planted value appears as plaintext and secret replacement happens before the digest | `B-REDACT-<DOOR>-<CLASS>`: bypass that door/class transform one at a time; byte/digest assertions must fail for every mutation |
| Seam guard | Every production channel calls `redactAuditInput`; direct filesystem append is absent | `B-SEAM-BYPASS`: replace one channel call with `appendFile`; source/construction guard must fail |
| Saved four-door harness | One applied and one refused action per door, hosted UI variant, rotation with two writers, legacy-only and both-name states; save transcript and file hashes | `B-HARNESS-DOOR`: disable each door adapter in turn; expected 8-action matrix must fail |
| Old-reader contract | Run the exact 0.15.0 `auditEntrySchema`/reader over every v2 fixture and record parse vs quarantine without crash; attach regenerated `mcp-api.json` diff | `B-OLD-READER-THROW`: replace line-level skip with parse; mixed v1/v2 fixture must crash |
| Upgrade and downgrade package test (never trimmed) | Create a real data folder with 0.15.0, preserve a v1 record, upgrade to candidate, create all four origins and both filenames, run a 0.15.0 MCP bridge beside the 0.16.0 server, downgrade to 0.15.0, and verify startup plus byte preservation | `B-ALIAS-REWRITE`: rename/delete the legacy file during upgrade; legacy hash and downgrade assertions must fail |

The route tests exercise the real Hono middleware/handler boundary, not a helper alone. The packaged command test uses `npm pack` output, not `tsx src/index.ts`. The four-door harness is committed and reusable by QA. The 0.15.0 fixture/test is committed in the repository and never reduced to a hand-built JSON approximation.

## 12. Default-path and lifecycle regression review

- **Default path:** with no new setting or environment variable, all valid changes continue even when auditing is unavailable. The file is created lazily. No config is required. This preserves the zero-config and best-effort guarantees.
- **State exits:** lock wait exits by acquire, stale takeover, or bounded skip; write exits by persisted record or warned skip; rotation exits by complete marker+action or warned partial recovery; legacy mode exits when a new live file exists; deprecation exits only after the version/tracking conditions; each door action exits as applied, refused, or no record plus warning for ambiguity/failure.
- **Construction sites:** contract schemas; audit storage/channel; MCP composition; project-context/server route decorator; automation scheduler handle; CLI dispatch and projects dispatcher; bundled nginx; API reference generator; compatibility/changelog documentation; test/harness/package fixtures.
- **Default-path guard:** removing the sole MCP audit-writer behavior is not hidden behind the three new channels. PR 1 must keep MCP writes on by default under the new filename; PR 2 must demonstrate all four with no flag.
- **Fail-open input guarantee:** an empty action inventory is a test failure, not “there were no auditable mutations.” Inventory tests pin the expected current action and command sets.

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

Scope: shared descriptor/redaction entry point (without the exhaustive adversarial proofs reserved for PR 4); explicit action inventory; project-context UI decorator; MCP per-action read/mutation decision; automation receipt hook; full CLI map; `X-Xezar-User` trust/sanitization and bundled nginx overwrite; saved four-door harness.

Falsifiable acceptance:

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

No owner decision is missing and none of the seven settled questions is reopened.

Implementation must still measure and report, without changing this contract:

- representative v2 record byte size and two-process rotation duration on supported local filesystems;
- the exact released 0.15.0 parse/quarantine counts and `mcp-api.json` generated diff;
- the tracking-issue number for legacy-alias removal, created in PR 1;
- whether an external non-loopback proxy can later gain trustworthy identity through a separately designed, opt-in authenticated peer mechanism. Until then its user header remains ignored.
