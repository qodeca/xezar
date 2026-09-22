/**
 * The shared audit action inventory (#306, part 2) — spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 6.
 *
 * The owner's rule is that the cockpit door (`ui`) records the same action set as MCP. So there is
 * ONE semantic inventory, not a UI allowlist written by hand next to an MCP one: every row is a
 * dotted action id, the MCP `tool:action` keys that reach it, and the HTTP method + route template
 * that reach it. Both doors take the action id from here, so one effect gets one id whichever door
 * it came through.
 *
 * This table is the authority, not a tool's `readOnlyHint`: a read action inside a mutating tool
 * (`organise_work list_queue`) writes no record, and a mutation cannot go unaudited because it
 * shares a tool with reads. There is no "audit every mutation" fallback in either direction — an
 * MCP action or a non-GET route that is in neither list below fails `audit-inventory.test.ts`.
 *
 * Keys use the `tool:action` spelling of `TOOL_ACTION_COVERAGE` (`tools/api-coverage.testkit.ts`),
 * or the bare tool name for a tool without an action argument. Route templates are the ones
 * registered in `server/server.ts`, relative to `/api/v1` (and `/api/v1/p/:projectId` for the
 * project-scoped families).
 */

/** The ten mutation families of spec § 6.5 — the unit tests and the four-door harness count by. */
export type AuditFamily = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';

export type AuditHttpMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AuditHttpRoute {
  readonly method: AuditHttpMethod;
  /** The route template exactly as registered, e.g. `/runs/:id/cancel`. */
  readonly path: string;
}

export interface AuditActionRow {
  readonly id: string;
  readonly family: AuditFamily;
  /** The MCP `tool:action` keys that reach this action. Never empty (spec § 6.5 rule 3). */
  readonly mcp: readonly string[];
  /** The HTTP routes that reach it, or `'none'` where no route exists (`leader.ack`, § 6.4). */
  readonly ui: readonly AuditHttpRoute[] | 'none';
}

const post = (path: string): AuditHttpRoute => ({ method: 'POST', path });
const put = (path: string): AuditHttpRoute => ({ method: 'PUT', path });
const patch = (path: string): AuditHttpRoute => ({ method: 'PATCH', path });
const del = (path: string): AuditHttpRoute => ({ method: 'DELETE', path });

/** § 6.1, § 6.2 and § 6.4: every state-changing action either door can reach. */
export const AUDIT_ACTIONS: readonly AuditActionRow[] = [
  // F1 run
  { id: 'run.start', family: 'F1', mcp: ['task_create:start'], ui: [post('/runs')] },
  {
    id: 'run.startFromInbox',
    family: 'F1',
    mcp: ['task_create:start_from_inbox', 'organise_work:start_inbox_item'],
    ui: [post('/todos/:id/start')],
  },
  { id: 'run.update', family: 'F1', mcp: ['organise_work:set_title', 'organise_work:edit_brief'], ui: [patch('/runs/:id')] },
  { id: 'run.cancel', family: 'F1', mcp: ['execution_control:cancel'], ui: [post('/runs/:id/cancel')] },
  {
    id: 'run.message',
    family: 'F1',
    mcp: ['execution_control:send_message', 'execution_control:answer_question'],
    ui: [post('/runs/:id/messages')],
  },
  {
    id: 'run.continue',
    family: 'F1',
    mcp: ['execution_control:continue', 'execution_control:send_message', 'execution_control:answer_question'],
    ui: [post('/runs/:id/continue')],
  },
  { id: 'run.finish', family: 'F1', mcp: ['execution_control:finish'], ui: [post('/runs/:id/finish')] },
  {
    id: 'run.queuedMessage.edit',
    family: 'F1',
    mcp: ['execution_control:edit_queued_message', 'organise_work:edit_queued_message'],
    ui: [patch('/runs/:id/queued-messages/:msgId')],
  },
  {
    id: 'run.queuedMessage.remove',
    family: 'F1',
    mcp: ['execution_control:remove_queued_message', 'organise_work:remove_queued_message'],
    ui: [del('/runs/:id/queued-messages/:msgId')],
  },
  { id: 'run.autoResume.cancel', family: 'F1', mcp: ['execution_control:cancel_auto_resume'], ui: [del('/runs/:id/auto-resume')] },
  { id: 'run.archive', family: 'F1', mcp: ['organise_work:archive'], ui: [post('/runs/:id/archive')] },
  { id: 'run.restore', family: 'F1', mcp: ['organise_work:restore'], ui: [post('/runs/:id/archive')] },
  { id: 'run.pin', family: 'F1', mcp: ['organise_work:pin'], ui: [post('/runs/:id/pin')] },
  { id: 'run.unpin', family: 'F1', mcp: ['organise_work:unpin'], ui: [post('/runs/:id/pin')] },
  { id: 'run.markRead', family: 'F1', mcp: ['organise_work:mark_read'], ui: [post('/runs/:id/read')] },
  { id: 'run.markUnread', family: 'F1', mcp: ['organise_work:mark_unread'], ui: [post('/runs/:id/unread')] },
  { id: 'run.markAllRead', family: 'F1', mcp: ['organise_work:mark_all_read'], ui: [post('/runs/read-all')] },
  { id: 'run.archiveFinished', family: 'F1', mcp: ['organise_work:archive_finished'], ui: [post('/runs/archive-finished')] },
  { id: 'run.delete', family: 'F1', mcp: ['organise_work:delete'], ui: [del('/runs/:id')] },
  { id: 'group.pickVariant', family: 'F1', mcp: ['organise_work:pick_variant'], ui: [post('/groups/:groupId/pick')] },
  { id: 'inbox.remove', family: 'F1', mcp: ['organise_work:remove_inbox_item'], ui: [del('/todos/:id')] },
  // F2 Git, pull requests, worktrees
  { id: 'run.git.commit', family: 'F2', mcp: ['handoff_git:commit'], ui: [post('/runs/:id/git/commit')] },
  { id: 'run.git.push', family: 'F2', mcp: ['handoff_git:push'], ui: [post('/runs/:id/git/push')] },
  { id: 'run.pr.create', family: 'F2', mcp: ['handoff_git:create_pr'], ui: [post('/runs/:id/pr')] },
  { id: 'pr.ready', family: 'F2', mcp: ['handoff_git:ready'], ui: [post('/github/prs/:number/ready')] },
  { id: 'pr.merge', family: 'F2', mcp: ['handoff_git:merge'], ui: [post('/github/prs/:number/merge')] },
  { id: 'repo.branch', family: 'F2', mcp: ['handoff_git:branch'], ui: [post('/repo/branch')] },
  { id: 'run.worktree.remove', family: 'F2', mcp: ['project_config:remove_worktree'], ui: [post('/runs/:id/remove-worktree')] },
  { id: 'worktree.reclaim', family: 'F2', mcp: ['project_config:reclaim_worktrees'], ui: [post('/worktrees/reclaim')] },
  // F3 local handoff
  { id: 'run.openInTerminal', family: 'F3', mcp: ['local_handoff:open_task_in_terminal'], ui: [post('/runs/:id/open-in-cli')] },
  { id: 'run.openInApp', family: 'F3', mcp: ['local_handoff:open_task_in_app'], ui: [post('/runs/:id/open-in')] },
  {
    id: 'project.openInApp',
    family: 'F3',
    mcp: ['local_handoff:open_project_in_app', 'project_config:open_in_app'],
    ui: [post('/open-in')],
  },
  // F4 project configuration
  { id: 'project.config.set', family: 'F4', mcp: ['project_config:set_config'], ui: [put('/config')] },
  { id: 'project.registry.update', family: 'F4', mcp: ['project_config:set_project'], ui: [patch('/projects/:projectId')] },
  { id: 'project.uiState.set', family: 'F4', mcp: ['project_config:set_prompt_templates'], ui: [put('/ui-state')] },
  { id: 'agentConfig.write', family: 'F4', mcp: ['project_config:write_agent_config'], ui: [put('/agent-config/:id')] },
  // F5 workflow files
  { id: 'workflow.save', family: 'F5', mcp: ['project_config:save_workflow', 'task_create:save_plan'], ui: [post('/workflows')] },
  { id: 'workflow.delete', family: 'F5', mcp: ['project_config:delete_workflow'], ui: [del('/workflows/:name')] },
  // F6 automations
  { id: 'automation.create', family: 'F6', mcp: ['project_config:create_automation'], ui: [post('/automations')] },
  { id: 'automation.update', family: 'F6', mcp: ['project_config:update_automation'], ui: [put('/automations/:id')] },
  { id: 'automation.delete', family: 'F6', mcp: ['project_config:delete_automation'], ui: [del('/automations/:id')] },
  { id: 'automation.enable', family: 'F6', mcp: ['project_config:enable_automation'], ui: [post('/automations/:id/enable')] },
  { id: 'automation.pause', family: 'F6', mcp: ['project_config:pause_automation'], ui: [post('/automations/:id/pause')] },
  { id: 'automation.checkExecute', family: 'F6', mcp: ['project_config:check_automation'], ui: [post('/automations/:id/check')] },
  {
    id: 'automation.receipt.retry',
    family: 'F6',
    mcp: ['project_config:retry_automation_receipt'],
    ui: [post('/automation-log/:receiptId/retry')],
  },
  // F7 skills and onboarding
  { id: 'skills.refresh', family: 'F7', mcp: ['project_config:refresh_skills'], ui: [post('/skills/refresh')] },
  { id: 'onboarding.dismissOffer', family: 'F7', mcp: ['project_config:dismiss_onboarding_offer'], ui: [post('/onboarding/offered')] },
  // F8 leader session
  { id: 'leader.attach', family: 'F8', mcp: ['leader_events:attach'], ui: [post('/mcp/leader')] },
  { id: 'leader.stop', family: 'F8', mcp: ['leader_events:stop'], ui: [post('/mcp/leader')] },
  { id: 'leader.ack', family: 'F8', mcp: ['leader_events:ack'], ui: 'none' },
  // F9 project registry — MCP can only refuse these (§ 6.2)
  { id: 'project.registry.add', family: 'F9', mcp: ['project_config:add_project'], ui: [post('/projects')] },
  { id: 'project.registry.clone', family: 'F9', mcp: ['project_config:clone_project'], ui: [post('/projects/checkout')] },
  { id: 'project.registry.remove', family: 'F9', mcp: ['project_config:remove_project'], ui: [del('/projects/:projectId')] },
  // F10 workspace — MCP refuses these (§ 6.2), except the settings write: the owner's rule of
  // 2026-09-20 (#677 B1, widened to the two folder paths by B2) made `workspace.config.set` a real
  // MCP mutation through the same route.
  // Its record needed no change — the row already named both doors, and the action was never in
  // `AUDIT_MCP_READS` — which is why a reversal here is one row of code and no new record shape.
  { id: 'workspace.config.set', family: 'F10', mcp: ['project_config:set_workspace_config'], ui: [put('/workspace/config')] },
  // The preference bag followed with #677 B3: both MCP keys below are real writes now, through
  // the same `PUT /workspace/ui-state`. Like the settings row above, the record needed no change
  // — it already named both doors and both actions, and neither was ever in `AUDIT_MCP_READS`.
  {
    id: 'workspace.uiState.set',
    family: 'F10',
    mcp: ['project_config:set_workspace_ui_state', 'project_config:import_skills'],
    ui: [put('/workspace/ui-state')],
  },
  { id: 'skills.applyUpdates', family: 'F10', mcp: ['project_config:apply_skill_updates'], ui: [post('/workspace/skills-update/apply')] },
  // The provider switch followed with #677 B4: both MCP keys are real writes now, through the two
  // routes below. Like the two rows above, the records needed no change — each already named both
  // doors, and neither action was ever in `AUDIT_MCP_READS`, so a leader's switch and a person's
  // click land on one action id. `provider.connect` below is the one that did NOT move.
  { id: 'provider.setEnabled', family: 'F10', mcp: ['project_config:set_provider_enabled'], ui: [put('/providers/:provider/enabled')] },
  { id: 'provider.retry', family: 'F10', mcp: ['project_config:retry_provider'], ui: [post('/providers/:provider/retry')] },
  { id: 'provider.connect', family: 'F10', mcp: ['project_config:connect_provider'], ui: [post('/providers/connect')] },
  // The agent accounts followed with #677 B5: the four MCP keys below are real writes now,
  // through the four routes beside them. Like every row above them, the records needed no change
  // — each already named both doors, and none of the four was ever in `AUDIT_MCP_READS`, so a
  // leader's write and a person's click land on one action id. `account.openFile` is the one that
  // did NOT move (it hands a path to a desktop application), and the family's two GETs — status
  // and details — record nothing at either door, which is why they are reads below rather than
  // rows here.
  { id: 'account.create', family: 'F10', mcp: ['project_config:create_account'], ui: [post('/workspace/agent-profiles')] },
  { id: 'account.update', family: 'F10', mcp: ['project_config:update_account'], ui: [patch('/workspace/agent-profiles/:id')] },
  { id: 'account.openFile', family: 'F10', mcp: ['project_config:open_account_file'], ui: [post('/workspace/agent-profiles/:id/open')] },
  { id: 'account.select', family: 'F10', mcp: ['project_config:select_account'], ui: [put('/workspace/agent-profiles/selection')] },
  { id: 'account.remove', family: 'F10', mcp: ['project_config:remove_account'], ui: [del('/workspace/agent-profiles/:id')] },
  // #819 PR 9: the copy of the machine-wide accounts into this project. Owner, 2026-09-21: "Allow
  // both, people and MCP (leader) to use the import my accounts functionality" — so it is an
  // ordinary row naming both doors, and a person's click and a leader's call land on one id.
  { id: 'account.importGlobal', family: 'F10', mcp: ['project_config:import_global_accounts'], ui: [post('/workspace/agent-profiles/import-global')] },
];

/**
 * § 6.3: MCP actions that change no state a person set. No record from either door. A `*` action
 * covers every action of a read-only tool.
 */
export const AUDIT_MCP_READS: readonly string[] = [
  'health',
  'discover_project',
  'task_read:*',
  'read_results_evidence:*',
  'organise_work:list_queue',
  'handoff_git:repo',
  'handoff_git:merge_state',
  'local_handoff:list_apps',
  'leader_events:read',
  'leader_events:status',
  'task_create:plan',
  'project_config:get_config',
  'project_config:get_project',
  'project_config:get_prompt_templates',
  'project_config:get_limits',
  // The read half of `workspace.uiState.set` (#753 review, Major 1): a leader must read the
  // preference bag before it can send an object-valued key back whole. A read writes no audit
  // row, exactly like `get_limits` beside `set_workspace_config`.
  'project_config:get_workspace_ui_state',
  'project_config:get_capabilities',
  // #819 item 4: the model catalog read. `GET /api/v1/models` records no audit row at the cockpit
  // door either.
  'project_config:list_models',
  'project_config:get_account',
  'project_config:read_quota',
  'project_config:list_agent_config',
  'project_config:read_agent_config',
  'project_config:list_workflows',
  'project_config:parse_workflow',
  'project_config:list_skills',
  'project_config:get_skill',
  'project_config:list_importable_skills',
  'project_config:check_skill_updates',
  'project_config:list_automations',
  'project_config:get_automation',
  'project_config:get_automation_check',
  'project_config:get_automation_log',
  'project_config:list_worktrees',
  // The two account GETs (#677 B5). They were "refused reads" here while the whole account family
  // was refused; they are SERVED reads now, and the entry is unchanged because the reason never
  // was the refusal: their cockpit counterparts are `GET` routes that carry no audit descriptor,
  // so a probe and an identity read record nothing at either door. Moving either to a mutation
  // row would claim a cockpit record that is not written.
  'project_config:check_account_status',
  'project_config:get_account_details',
  // Refused reads: their cockpit counterparts are reads.
  'project_config:browse_folders',
  'project_config:get_launch_key',
];

/** § 6.3: the non-GET routes that are previews or parses. No record. */
export const AUDIT_HTTP_READS: readonly (AuditHttpRoute & { readonly reason: string })[] = [
  { ...post('/plan'), reason: 'preview: plans a task without starting it' },
  { ...post('/workflows/parse'), reason: 'preview: parses a workflow without saving it' },
  { ...post('/workspace/skills-update/check'), reason: 'preview: checks for skill updates without applying them' },
];

const byId = new Map(AUDIT_ACTIONS.map((row) => [row.id, row]));

/** The row for an action id, or `undefined` for an id that is not in the inventory. */
export function auditAction(id: string): AuditActionRow | undefined {
  return byId.get(id);
}

/** `execution_control` + `send_message` → `execution_control:send_message`; a tool without an action is its bare name. */
export function mcpActionKey(toolName: string, action: unknown): string {
  return typeof action === 'string' ? `${toolName}:${action}` : toolName;
}

function isMcpRead(key: string): boolean {
  const tool = key.split(':')[0]!;
  return AUDIT_MCP_READS.includes(key) || AUDIT_MCP_READS.includes(`${tool}:*`);
}

/**
 * The MCP classification of one call, decided from the parsed arguments before the tool runs.
 * `mutation.resolve` names the action id once the result is known, because two keys reach two
 * routes (`send_message` and `answer_question` reach `/messages` or `/continue`) and one key is a
 * read in one mode (`check_automation` `mode: preview`). `unclassified` is a key in neither list —
 * the parity test makes that impossible for the current tools, and the door records nothing for it.
 */
export type McpAuditClass =
  | { readonly kind: 'read' }
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'mutation'; resolve(result: McpResultShape | undefined): string };

/** The part of a tool result the classifier reads. */
export interface McpResultShape {
  readonly structuredContent?: Record<string, unknown>;
}

/**
 * Refusals a route answers with a SUCCESS status: the answer says nothing was written. Both doors
 * read the same table, so the cockpit and MCP record the same outcome for the same answer. Recording
 * such an answer as `applied` would put a change that never happened into the trail.
 */
const ANSWER_REFUSALS: Readonly<Record<string, (answer: Record<string, unknown>) => string | undefined>> = {
  // "Later" on the setup offer for an identity that moved on: `conflict`, nothing recorded.
  'onboarding.dismissOffer': (answer) => (answer.status === 'conflict' ? 'conflict' : undefined),
};

/** The refusal reason a successful answer carries for `actionId`, if it is one. */
export function answerRefusal(actionId: string, answer: unknown): string | undefined {
  const read = ANSWER_REFUSALS[actionId];
  return read && answer !== null && typeof answer === 'object' ? read(answer as Record<string, unknown>) : undefined;
}

/** `delivery` values that mean the call reached `/runs/:id/continue` rather than `/runs/:id/messages`. */
const CONTINUE_DELIVERIES = new Set(['continued', 'resumed']);

export function classifyMcpCall(toolName: string, args: Readonly<Record<string, unknown>>): McpAuditClass {
  const key = mcpActionKey(toolName, args.action);
  if (key === 'project_config:check_automation') {
    return args.mode === 'execute' ? { kind: 'mutation', resolve: () => 'automation.checkExecute' } : { kind: 'read' };
  }
  if (key === 'execution_control:send_message' || key === 'execution_control:answer_question') {
    return {
      kind: 'mutation',
      // Without a `delivery` (a refusal) the call never reached a route that says which one; the
      // message route is the one both actions try first for a live session.
      resolve: (result) =>
        CONTINUE_DELIVERIES.has(String(result?.structuredContent?.delivery)) ? 'run.continue' : 'run.message',
    };
  }
  if (isMcpRead(key)) return { kind: 'read' };
  const rows = AUDIT_ACTIONS.filter((row) => row.mcp.includes(key));
  if (rows.length !== 1) return { kind: 'unclassified' };
  const id = rows[0]!.id;
  return { kind: 'mutation', resolve: () => id };
}
