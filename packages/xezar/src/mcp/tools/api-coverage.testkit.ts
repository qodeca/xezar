/**
 * #261 — WHICH TOOL ACTION SERVES WHICH INVENTORY RECORD, declared once, as data.
 *
 * The closed inventory (`docs/features/mcp-server/mcp-ui-action-inventory.md`) states every record as
 * an OUTCOME and deliberately names no tool. This table is the missing half: one entry per tool
 * action in the registry (`tool:action`, or the bare tool name for a tool with no action argument),
 * naming the inventory records it answers for. `mcp-api-doc.test.ts` holds it to the real registry
 * and to the inventory in BOTH directions, and publishes it in `docs/features/mcp-server/mcp-api.md`:
 *
 *   - every `covered` record is served by at least one action that really exists, or is listed in
 *     `COVERAGE_GAPS` (named, never passing);
 *   - every action the registry exposes has an entry here, and every entry names at least one record
 *     or says, in `unrecorded`, why the action exists without one.
 *
 * The three roles an action can play for a record:
 *   - `serves`: the action performs or reads the record's outcome. Only `covered` records.
 *   - `reads`: the action is the SAFE EFFECTIVE READ a `global` record allows (section 3, D-03).
 *   - `refuses`: the action exists so a leader asking for it gets its boundary as a reason instead
 *     of a schema error, and dispatches nothing (`REFUSED_ACTIONS` in `project-config.ts`).
 *
 * Test-only (`.testkit.ts`): it describes the tools and never ships in `dist`.
 */

export interface ActionCoverage {
  readonly serves?: readonly string[];
  readonly reads?: readonly string[];
  readonly refuses?: readonly string[];
  /** Why an action with no inventory record exists at all. */
  readonly unrecorded?: string;
}

export const TOOL_ACTION_COVERAGE: Readonly<Record<string, ActionCoverage>> = {
  health: { unrecorded: 'the bridge’s own liveness check: it answers whether the cockpit runs for the bound project, and is no cockpit action' },

  'task_read:list': { serves: ['I-015'] },
  'task_read:task': { serves: ['I-015', 'I-033', 'I-040', 'I-042', 'I-045', 'I-049'] },
  'task_read:history': { serves: ['I-033'] },
  'task_read:context': { serves: ['I-033'] },
  'task_read:handoff': { serves: ['I-041'] },
  'task_read:inbox': { serves: ['I-025'] },
  'task_read:group': { serves: ['I-029'] },

  'execution_control:cancel': { serves: ['I-037'] },
  'execution_control:finish': { serves: ['I-038', 'I-051'] },
  'execution_control:continue': { serves: ['I-039', 'I-051'] },
  'execution_control:send_message': { serves: ['I-032', 'I-034'] },
  'execution_control:answer_question': { serves: ['I-036'] },
  'execution_control:edit_queued_message': { serves: ['I-035'] },
  'execution_control:remove_queued_message': { serves: ['I-035'] },
  'execution_control:cancel_auto_resume': { serves: ['I-040'] },

  discover_project: { serves: ['I-007', 'I-008', 'I-042', 'I-044', 'I-104', 'I-114', 'I-133', 'I-136', 'I-143', 'I-146'] },

  'organise_work:list_queue': { serves: ['I-035'] },
  'organise_work:set_title': { serves: ['I-018'] },
  'organise_work:edit_brief': { serves: ['I-035'] },
  'organise_work:edit_queued_message': { serves: ['I-035'] },
  'organise_work:remove_queued_message': { serves: ['I-035'] },
  'organise_work:pin': { serves: ['I-019'] },
  'organise_work:unpin': { serves: ['I-019'] },
  'organise_work:archive': { serves: ['I-020'] },
  'organise_work:restore': { serves: ['I-020'] },
  'organise_work:archive_finished': { serves: ['I-017'] },
  'organise_work:mark_read': { serves: ['I-016'] },
  'organise_work:mark_unread': { serves: ['I-016'] },
  'organise_work:mark_all_read': { serves: ['I-016'] },
  'organise_work:delete': { serves: ['I-021'] },
  'organise_work:start_inbox_item': { serves: ['I-026'] },
  'organise_work:remove_inbox_item': { serves: ['I-027'] },
  'organise_work:pick_variant': { serves: ['I-030'] },

  // I-080: the tool takes no GitHub reference; the leader writes the reference into `prompt`, as the
  // cockpit's `composeGithubTask` prepends it, and picks the workflow or skill steps itself.
  // I-147: the GitHub tab's New issue control is `task_create` with a skill source and
  // `autonomous: false` — the owner's UI↔MCP parity rule met without a new tool (#468).
  'task_create:start': { serves: ['I-001', 'I-003', 'I-007', 'I-008', 'I-009', 'I-080', 'I-094', 'I-144', 'I-147'] },
  'task_create:plan': { serves: ['I-002', 'I-085'] },
  'task_create:start_from_inbox': { serves: ['I-026'] },
  'task_create:save_plan': { serves: ['I-005'] },

  'handoff_git:repo': { serves: ['I-061', 'I-063'] },
  'handoff_git:commit': { serves: ['I-055'] },
  'handoff_git:push': { serves: ['I-056'] },
  'handoff_git:create_pr': { serves: ['I-051', 'I-057'] },
  'handoff_git:merge_state': { serves: ['I-075'] },
  'handoff_git:ready': { unrecorded: 'marks the draft pull request create_pr opened (I-057) ready for review, the step before the merge (I-076); the cockpit has no such control, so no inventory record names it (#262)' },
  'handoff_git:merge': { serves: ['I-076'] },
  'handoff_git:branch': { serves: ['I-063', 'I-064'] },

  'read_results_evidence:summary': { serves: ['I-033', 'I-045', 'I-049'] },
  'read_results_evidence:history': { serves: ['I-033'] },
  'read_results_evidence:changes': { serves: ['I-052'] },
  'read_results_evidence:files': { serves: ['I-053'] },
  'read_results_evidence:commits': { serves: ['I-054'] },
  'read_results_evidence:commit': { serves: ['I-054'] },
  'read_results_evidence:handoff': { serves: ['I-041'] },
  'read_results_evidence:repo': { serves: ['I-061', 'I-062', 'I-063'] },
  'read_results_evidence:repo_changes': { serves: ['I-061'] },
  'read_results_evidence:repo_commit': { serves: ['I-062'] },
  'read_results_evidence:github': { serves: ['I-069', 'I-070', 'I-073'] },
  'read_results_evidence:github_comments': { serves: ['I-071'] },
  'read_results_evidence:github_checks': { serves: ['I-072'] },
  'read_results_evidence:github_search': { serves: ['I-073'] },
  'read_results_evidence:github_ref_status': { serves: ['I-032', 'I-049'] },
  'read_results_evidence:pr_merge_state': { serves: ['I-075'] },
  'read_results_evidence:pr_changes': { serves: ['I-074'] },

  'project_config:get_config': { serves: ['I-007', 'I-010', 'I-065', 'I-103', 'I-104', 'I-105', 'I-106', 'I-107', 'I-108', 'I-109'] },
  'project_config:set_config': { serves: ['I-010', 'I-065', 'I-103', 'I-104', 'I-105', 'I-106', 'I-107', 'I-108', 'I-109'] },
  'project_config:get_project': { serves: ['I-128', 'I-129'] },
  'project_config:set_project': { serves: ['I-128', 'I-129'] },
  'project_config:get_prompt_templates': { serves: ['I-110'] },
  'project_config:set_prompt_templates': { serves: ['I-110'] },
  // I-117 … I-121 were this action's `reads` while the workspace settings were global-read-only.
  // The owner's 2026-09-20 rule made them writable (#677 B1), so the records are `covered` and the
  // pair of actions that serves them is this read plus `set_workspace_config`.
  'project_config:get_limits': { serves: ['I-009', 'I-117', 'I-118', 'I-119', 'I-120', 'I-121', 'I-128'] },
  // I-115 was this action's `reads` while the provider switch was global-read-only. #677 B4 made
  // the switch and the retry real writes, so the record is `covered` and the status read serves it
  // beside them — the same move I-117 … I-121 made in B1.
  'project_config:get_capabilities': { serves: ['I-115', 'I-133'] },
  // I-122 was this action's `reads` while the selection was global-read-only. #677 B5 made
  // `select_account` a real write, so the record is `covered` and this read serves it beside it —
  // the same move I-115 made in B4 and I-117 … I-121 in B1.
  'project_config:get_account': { serves: ['I-042', 'I-122'] },
  'project_config:list_agent_config': { serves: ['I-111', 'I-113'] },
  'project_config:read_agent_config': { serves: ['I-111', 'I-113'] },
  'project_config:write_agent_config': { serves: ['I-111', 'I-113'] },
  'project_config:list_workflows': { serves: ['I-083'] },
  'project_config:parse_workflow': { serves: ['I-086'] },
  'project_config:save_workflow': { serves: ['I-087'] },
  'project_config:delete_workflow': { serves: ['I-088'] },
  'project_config:list_skills': { serves: ['I-090'] },
  'project_config:get_skill': { serves: ['I-090'] },
  // I-092 was a `reads` while the imported-skills list was global-read-only. #677 B3 made the
  // list writable, so the record is `covered` and this read is one of the two actions serving it.
  'project_config:list_importable_skills': { serves: ['I-092'] },
  'project_config:refresh_skills': { serves: ['I-091'] },
  'project_config:check_skill_updates': { reads: ['I-093'] },
  'project_config:list_automations': { serves: ['I-096'] },
  'project_config:get_automation': { serves: ['I-096'] },
  'project_config:create_automation': { serves: ['I-097'] },
  'project_config:update_automation': { serves: ['I-098'] },
  'project_config:delete_automation': { serves: ['I-102'] },
  'project_config:enable_automation': { serves: ['I-099'] },
  'project_config:pause_automation': { serves: ['I-099'] },
  'project_config:check_automation': { serves: ['I-100'] },
  'project_config:get_automation_check': { serves: ['I-100'] },
  'project_config:get_automation_log': { serves: ['I-101'] },
  'project_config:retry_automation_receipt': { serves: ['I-102'] },
  'project_config:list_worktrees': { serves: ['I-068'] },
  'project_config:reclaim_worktrees': { serves: ['I-068'] },
  'project_config:dismiss_onboarding_offer': { serves: ['I-145'] },
  'project_config:remove_worktree': { serves: ['I-068'] },
  'project_config:set_provider_enabled': { serves: ['I-115'] },
  'project_config:retry_provider': { serves: ['I-115'] },
  // The half of I-115 that is still a refusal, and it is not the setting: Connect opens a login
  // terminal on the host (boundary `host-process`), which the owner kept person-only at 07:41 on
  // 2026-09-20. Its I-123 half is the same button on an account's row — the account itself is
  // served since B5, but SIGNING one in is still the host process this refuses.
  'project_config:connect_provider': { refuses: ['I-115', 'I-123'] },
  // The account family stopped refusing with #677 B5, under the owner's decision of 2026-09-20
  // 07:41 ("Writes and identity read"): I-123 (the accounts pane's own rows), I-122 (which
  // account a project uses) and I-124 (Show details) are `covered` now, served by the actions
  // below beside the `get_account` read above. I-125 — Open in an app — is the one row of the
  // pane that is still a refusal, and its boundary is the host process, not the account.
  'project_config:create_account': { serves: ['I-123'] },
  'project_config:update_account': { serves: ['I-123'] },
  'project_config:remove_account': { serves: ['I-123'] },
  'project_config:select_account': { serves: ['I-122'] },
  'project_config:check_account_status': { serves: ['I-123'] },
  'project_config:get_account_details': { serves: ['I-124'] },
  'project_config:open_account_file': { refuses: ['I-125'] },
  // I-127 (the two workspace folder paths) joined the list with #677 B2: the same owner rule made
  // them writable, and this action is the only one that serves them — `get_limits` still withholds
  // the paths themselves, so the record is served by its WRITE alone.
  'project_config:set_workspace_config': { serves: ['I-117', 'I-118', 'I-119', 'I-120', 'I-121', 'I-127'] },
  // #677 B3: the shared preference bag is a write now. I-132 is served for its ACCENT, DENSITY,
  // WIDTH and notification half; its `theme` half is served by nobody and never will be — the
  // browser stores the theme itself (`packages/web/src/lib/theme.ts`), so there is no route to
  // dispatch, which is a fact about the cockpit rather than a boundary (spec § 4 Q1).
  // The read half the three records need as much as the write (#753 review, Major 1): the route
  // merges shallowly at the top level, so `set_workspace_ui_state` can only change one key of an
  // object-valued preference after this read has handed the leader the rest of it.
  'project_config:get_workspace_ui_state': { serves: ['I-024', 'I-092', 'I-132'] },
  'project_config:set_workspace_ui_state': { serves: ['I-024', 'I-092', 'I-132'] },
  'project_config:browse_folders': { refuses: ['I-126'] },
  'project_config:add_project': { refuses: ['I-131'] },
  'project_config:clone_project': { refuses: ['I-131'] },
  'project_config:remove_project': { refuses: ['I-130'] },
  'project_config:apply_skill_updates': { refuses: ['I-093'] },
  'project_config:import_skills': { serves: ['I-092'] },
  'project_config:get_launch_key': { refuses: ['I-014', 'I-095'] },
  // Opening the project folder is served by `local_handoff:open_project_in_app`; this refusal only
  // keeps project_config from being a second, host-launching door.
  'project_config:open_in_app': { refuses: ['I-114'] },

  'local_handoff:list_apps': { serves: ['I-044', 'I-114'] },
  'local_handoff:open_task_in_terminal': { serves: ['I-044'] },
  'local_handoff:open_task_in_app': { serves: ['I-044'] },
  'local_handoff:open_project_in_app': { serves: ['I-114'] },

  'leader_events:read': { serves: ['I-138', 'I-139', 'I-140'] },
  'leader_events:ack': { serves: ['I-140'] },
  'leader_events:attach': { serves: ['I-142'] },
  'leader_events:stop': {
    unrecorded:
      'detaches the calling session’s own leader; the cockpit has no stop control, only POST /api/v1/mcp/leader {action:"stop"}, so no inventory record names it (#450)',
  },
  'leader_events:status': { serves: ['I-141'] },
};

/**
 * Covered records that NO tool action really serves, each with exactly what is missing. Listed on
 * the published page and run as a vitest `todo`: never counted as passing, and never closed by
 * inventing a mapping or changing the record's status. Empty today.
 */
export const COVERAGE_GAPS: Readonly<Record<string, string>> = {};
