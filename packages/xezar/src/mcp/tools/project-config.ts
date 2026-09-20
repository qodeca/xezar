import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import {
  automationCheckInputSchema,
  automationEventSchema,
  automationLogResultSchema,
  mcpExpectedVersionSchema,
  onboardingIdentitySchema,
  onboardingStatusSchema,
  operationIdSchema,
  runIdParamSchema,
  saveWorkflowInputSchema,
  setAgentConfigInputSchema,
  setConfigInputSchema,
  setWorkspaceConfigInputSchema,
  uiStateSchema,
  updateAutomationInputSchema,
  updateProjectInputSchema,
  workflowStepDefSchema,
  workspaceUiStateSchema,
  type AgentConfigFileContent,
  type AgentConfigListing,
  type AgentProfilesResponse,
  type AutomationCheck,
  type AutomationDefinition,
  type ConfigResponse,
  type HealthResponse,
  type ProjectListEntry,
  type ProjectsResponse,
  type ProviderStatusResponse,
  type Skill,
  type SkillsUpdateState,
  type UiState,
  type UpdateProjectResponse,
  type WorkflowsResponse,
  type WorkspaceConfigResponse,
  type WorkspaceUiState,
} from '@qodeca/xezar-contract';
import { hc } from 'hono/client';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { findConfigFile, type ConfigFileDef } from '../../agent-config/catalog.ts';
import { stripJsonComments } from '../../agent-config/validate.ts';
import { agentHomePaths } from '../../paths.ts';
import { slugify } from '../../planner.ts';
import { projectWorkflowsDir } from '../../workflows/load.ts';
import { singleProjectNarrowing } from '../../workspace/projects.ts';
import type { AppType } from '../../server/app-type.ts';
import { MCP_ORIGIN, type ServiceDispatch } from '../service-adapter.ts';
import { staleRejectionIn } from '../stale-write.ts';
import { defineTool, errorResult, textResult, type McpToolContext, type McpToolResult } from '../tool.ts';

/**
 * Project configuration for the bound project (#97, F-05, F-12, F-16; D-03 in
 * `docs/features/mcp-server/mcp-settings-classification.md`, which this module implements and
 * does not re-decide).
 *
 * THE BOUNDARY. A leader reads and writes THIS project's own settings, workflows, skills,
 * automations and worktrees. Shared (workspace, machine, home) settings are served only as the
 * effective capability or limit the classification names, with what it withholds withheld.
 * Everything the classification marks `excluded` is an explicit action here that answers a
 * refusal naming its boundary and dispatches NOTHING — so a leader asking for it learns why, and
 * no argument can route around it. SOME of those exclusions have been reversed by the owner's
 * rule of 2026-09-20 (#677): the workspace SETTINGS write is `set_workspace_config`, a real write
 * through the cockpit's own route, and since slice B2 that includes the two workspace folder
 * paths — the route's own write probe is what keeps them honest, not a second check here. Slice
 * B3 adds the shared PRESENTATION preferences, `set_workspace_ui_state` and `import_skills`,
 * through `PUT /workspace/ui-state`; the colour theme is not among them, because it is not a
 * stored setting at all (the browser keeps it) rather than because it is refused.
 * There is no project id argument anywhere: the project is the connection's (D-01 § 1.5), and a
 * call that names one is refused rather than silently redirected.
 *
 * THE SAME RULES AS THE COCKPIT. Every effect is one of the cockpit's own routes, dispatched
 * in-process under `/api/v1/p/<bound project>/…` through the same validators, 400/404/409
 * answers and stores (N-02). Two of those guarantees are load-bearing and are deliberately NOT
 * re-implemented here, because a second copy is how they would drift:
 *   - `PUT /agent-config/:id` answers 409 whenever `capabilities().localHandoff` is false (it
 *     closes a hooks-based remote-code-execution path). A write goes THROUGH that route, so the
 *     409 applies to MCP exactly as to the cockpit;
 *   - built-in workflows answer 400 on delete, `stepsIssue` refuses a bad chain, and a
 *     `.xezar/workflows` file is written with `wx` unless `overwrite` says otherwise.
 *
 * WHAT THIS MODULE ADDS, all of it narrowing (the classification's § 7):
 *   - E-SCOPE-USER: a catalog file whose `scope` is `'user'` is refused, read and write alike,
 *     keyed off the CATALOG FIELD and never off a path. The refusal is identical whether or not
 *     the file exists, so it is not an existence oracle;
 *   - a catalog file that resolves OUTSIDE the project (an in-repo symlink into a home folder) is
 *     refused too — the route writes through a symlink, and a project write must stay local in
 *     effect (requirements § 8);
 *   - an MCP-holding project file is read as STRUCTURE only (§ 4.2, ruling 12): key names and
 *     value kinds, never a value;
 *   - E-NARROW: the registry, the workspace settings, the account listing and the skills-update
 *     state are reduced to the bound project's own facts before anything is returned;
 *   - no action takes a command. A workflow is saved with agent steps only: a check step's
 *     `command` is a shell command the service runs later, and F-08 / § 3 keep arbitrary
 *     operating-system processes out of this surface (`execution-control.test.ts` pins it for
 *     the whole registry). The cockpit's Import → Save can store one; through MCP it is refused,
 *     never stripped;
 *   - and the other half of that rule (F-22, #262): no action REMOVES a check step either. A
 *     save that would overwrite or shadow an on-disk workflow holding one, and a delete of such a
 *     workflow, are refused as a quality-gate blocker before anything is dispatched — refusing to
 *     add a gate while allowing its removal would protect nothing;
 *   - automations match the cockpit FORM, not the wider route contract (D-97, I-097, I-098):
 *     create takes `name`, `prompt` and `enable` plus the form's fixed values, and update edits
 *     `name` and `prompt` and carries everything else through, exactly as the edit form does.
 *
 * WHAT IS NEVER RETURNED: an account identity (email, organisation, plan — F-12, N-01), the
 * launch key or any credential (F-15), another project's row, or an absolute path outside the
 * project. Paths inside the project are reported relative to its root.
 *
 * WHERE THE SERVICE COMES FROM. `McpToolContext` does not carry the service's in-process entry
 * yet (#86 shipped it without one). Like the sibling tools, this one reads it from an optional
 * `service` field on the context and answers an honest tool error when it is absent.
 */

export type ProjectConfigContext = McpToolContext & { readonly service?: ServiceDispatch };

/** Every action a leader may take. Each is one cockpit route (or a narrowed read of one). */
export const PROJECT_CONFIG_ACTIONS = [
  'get_config',
  'set_config',
  'get_project',
  'set_project',
  'get_prompt_templates',
  'set_prompt_templates',
  'get_limits',
  'set_workspace_config',
  'set_workspace_ui_state',
  'get_capabilities',
  'get_account',
  'list_agent_config',
  'read_agent_config',
  'write_agent_config',
  'list_workflows',
  'parse_workflow',
  'save_workflow',
  'delete_workflow',
  'list_skills',
  'get_skill',
  'list_importable_skills',
  'import_skills',
  'refresh_skills',
  'check_skill_updates',
  'list_automations',
  'get_automation',
  'create_automation',
  'update_automation',
  'delete_automation',
  'enable_automation',
  'pause_automation',
  'check_automation',
  'get_automation_check',
  'get_automation_log',
  'retry_automation_receipt',
  'list_worktrees',
  'reclaim_worktrees',
  'remove_worktree',
  'dismiss_onboarding_offer',
] as const;
export type ProjectConfigAction = (typeof PROJECT_CONFIG_ACTIONS)[number];

/** The boundaries a refusal can name. Stable identifiers — the refusal's structured content
 *  carries one, and the text names it. */
export type ConfigBoundary =
  | 'project-binding'
  | 'workspace-settings'
  | 'agent-accounts'
  | 'account-identity'
  | 'home-file'
  | 'outside-project'
  | 'host-filesystem'
  | 'host-process'
  | 'project-registry'
  | 'quality-gate'
  | 'secret';

const BOUNDARY_LABEL: Record<ConfigBoundary, string> = {
  'project-binding': 'project binding',
  'workspace-settings': 'workspace-wide setting',
  'agent-accounts': 'global agent accounts',
  'account-identity': 'account identity',
  'home-file': 'home file shared by every project',
  'outside-project': 'file outside this project',
  'host-filesystem': 'host filesystem',
  'host-process': 'host process',
  'project-registry': 'project registry',
  'quality-gate': 'quality gate',
  secret: 'secret',
};

/**
 * The `excluded` rows of the classification a leader might plausibly ask for, each answered with
 * its boundary. None of them dispatches anything. Listed as actions (rather than left out of the
 * enum) so the answer is an understandable reason, not a schema error.
 */
export const REFUSED_ACTIONS = {
  set_provider_enabled: {
    boundary: 'workspace-settings',
    reason:
      'turning a provider on or off changes it for every project on this machine. Read provider status with get_capabilities; a person changes it in the cockpit.',
  },
  connect_provider: {
    boundary: 'host-process',
    reason: 'connecting a provider opens a login terminal on the host machine. A person does this in the cockpit.',
  },
  retry_provider: {
    boundary: 'workspace-settings',
    reason:
      'clearing a provider authentication incident clears it for every project. Report the blocker instead; a person clears it in the cockpit.',
  },
  create_account: {
    boundary: 'agent-accounts',
    reason: 'agent accounts are global and administered by a person, not by a project leader.',
  },
  update_account: {
    boundary: 'agent-accounts',
    reason: 'agent accounts are global and administered by a person, not by a project leader.',
  },
  remove_account: {
    boundary: 'agent-accounts',
    reason: 'agent accounts are global and administered by a person, not by a project leader.',
  },
  select_account: {
    boundary: 'agent-accounts',
    reason:
      'the account a project uses is stored with the global accounts. Read the effective account with get_account; a person changes it in the cockpit.',
  },
  check_account_status: {
    boundary: 'agent-accounts',
    reason: 'probing one named account is global account administration. Provider status is in get_capabilities.',
  },
  get_account_details: {
    boundary: 'account-identity',
    reason: 'account identity is never served to a project leader.',
  },
  open_account_file: {
    boundary: 'host-process',
    reason: 'opening an account folder launches an application on the host machine.',
  },
  browse_folders: {
    boundary: 'host-filesystem',
    reason: 'browsing folders lists host directories outside this project.',
  },
  add_project: {
    boundary: 'project-registry',
    reason: 'registering projects manages the workspace, not this project.',
  },
  clone_project: {
    boundary: 'project-registry',
    reason: 'cloning creates and registers a checkout outside this project.',
  },
  remove_project: {
    boundary: 'project-registry',
    reason: 'removing a project deregisters it from the workspace and ends this connection’s binding.',
  },
  apply_skill_updates: {
    boundary: 'workspace-settings',
    reason:
      'applying skill updates rewrites globally installed skills every project reads. check_skill_updates reports what is available.',
  },
  get_launch_key: {
    boundary: 'secret',
    reason: 'the launch key is a credential and never enters a tool response.',
  },
  open_in_app: {
    boundary: 'host-process',
    reason: 'opening the project launches a desktop application on the host machine.',
  },
} as const satisfies Record<string, { boundary: ConfigBoundary; reason: string }>;
export type RefusedAction = keyof typeof REFUSED_ACTIONS;
const REFUSED_ACTION_NAMES = Object.keys(REFUSED_ACTIONS) as [RefusedAction, ...RefusedAction[]];

type Field =
  | 'config'
  | 'workspaceConfig'
  | 'uiState'
  | 'importedSkills'
  | 'project'
  | 'promptTemplates'
  | 'fileId'
  | 'content'
  | 'version'
  | 'yaml'
  | 'workflow'
  | 'name'
  | 'wait'
  | 'refresh'
  | 'automationId'
  | 'automation'
  | 'update'
  | 'mode'
  | 'checkId'
  | 'receiptId'
  | 'logQuery'
  | 'runId'
  | 'onboardingIdentity'
  | 'expectedVersion'
  | 'operationId';

const FIELDS: readonly Field[] = [
  'config',
  'workspaceConfig',
  'uiState',
  'importedSkills',
  'project',
  'promptTemplates',
  'fileId',
  'content',
  'version',
  'yaml',
  'workflow',
  'name',
  'wait',
  'refresh',
  'automationId',
  'automation',
  'update',
  'mode',
  'checkId',
  'receiptId',
  'logQuery',
  'runId',
  'onboardingIdentity',
  'expectedVersion',
  'operationId',
];

const none = { required: [], optional: [] } as const;
/**
 * Which arguments each action takes. Anything else is refused rather than silently dropped.
 *
 * `operationId` (D-06 § 5.2, #264) is required by every action that CHANGES something and refused by
 * every action that only reads: a read has no effect to deduplicate, and a receipt over one would
 * answer the next identical read with the receipt instead of the settings, the skill or the log.
 * Two entries are worth their own sentence:
 *   - `refresh_skills` applies the pending skill updates, so it is a change, not a read;
 *   - `check_automation` takes one for BOTH modes. `execute` launches tasks, and `preview` is only a
 *     count — but a mode is not a second identity, and one rule per action is what keeps the
 *     published guard table honest. A leader that wants a fresh preview sends a fresh key, which is
 *     exactly D-06's "deliberately new identical work uses a new identity".
 * The refusal-only actions (`REFUSED_ACTIONS`) dispatch nothing and are checked by neither branch:
 * the refinement returns before it reaches this table.
 *
 * Exported for `project-config.request-parity.test.ts` (#677 wave 1), which reads the `operationId`
 * rule above as the definition of "a write action" and refuses to leave a new one unclassified.
 */
export const ACTION_FIELDS: Record<ProjectConfigAction, { required: readonly Field[]; optional: readonly Field[] }> = {
  get_config: none,
  set_config: { required: ['config', 'operationId'], optional: [] },
  get_project: none,
  set_project: { required: ['project', 'operationId'], optional: [] },
  get_prompt_templates: none,
  set_prompt_templates: { required: ['promptTemplates', 'operationId'], optional: [] },
  get_limits: none,
  set_workspace_config: { required: ['workspaceConfig', 'operationId'], optional: [] },
  set_workspace_ui_state: { required: ['uiState', 'operationId'], optional: [] },
  get_capabilities: { required: [], optional: ['refresh'] },
  get_account: none,
  list_agent_config: none,
  read_agent_config: { required: ['fileId'], optional: [] },
  // `version` is required but may be `null` ("I expect no file yet"), so presence is checked.
  write_agent_config: { required: ['fileId', 'content', 'version', 'operationId'], optional: [] },
  list_workflows: none,
  parse_workflow: { required: ['yaml'], optional: [] },
  save_workflow: { required: ['workflow', 'operationId'], optional: [] },
  delete_workflow: { required: ['name', 'operationId'], optional: [] },
  list_skills: { required: [], optional: ['wait'] },
  get_skill: { required: ['name'], optional: ['wait'] },
  list_importable_skills: { required: [], optional: ['wait'] },
  import_skills: { required: ['importedSkills', 'operationId'], optional: [] },
  refresh_skills: { required: ['operationId'], optional: [] },
  check_skill_updates: none,
  list_automations: none,
  get_automation: { required: ['automationId'], optional: [] },
  create_automation: { required: ['automation', 'operationId'], optional: [] },
  update_automation: { required: ['automationId', 'update', 'operationId'], optional: [] },
  delete_automation: { required: ['automationId', 'operationId'], optional: [] },
  enable_automation: { required: ['automationId', 'operationId'], optional: [] },
  pause_automation: { required: ['automationId', 'operationId'], optional: [] },
  check_automation: { required: ['automationId', 'mode', 'operationId'], optional: [] },
  get_automation_check: { required: ['checkId'], optional: [] },
  get_automation_log: { required: [], optional: ['logQuery'] },
  retry_automation_receipt: { required: ['receiptId', 'operationId'], optional: [] },
  list_worktrees: none,
  reclaim_worktrees: { required: ['operationId'], optional: [] },
  // Removing a task's worktree changes that task, so it needs its version (#250, N-03).
  remove_worktree: { required: ['runId', 'expectedVersion', 'operationId'], optional: [] },
  // Recording an offer changes project scratch, so it needs an operation key. `expectedVersion`
  // would be wrong here: it touches no task, and there is no task version to be stale against
  // (#464 P2). `onboardingIdentity` is the optional stale guard instead — see its description.
  dismiss_onboarding_offer: { required: ['operationId'], optional: ['onboardingIdentity'] },
};

const isRefused = (action: string): action is RefusedAction => Object.hasOwn(REFUSED_ACTIONS, action);

/**
 * The four actions whose refusal reads differently once the registry is narrowed
 * to one project (#600 SP-3.2, SP-3.3): the three registry mutations and the
 * host-folder browse Add project reaches the filesystem through.
 */
const NARROWED_ACTIONS: ReadonlySet<string> = new Set([
  'add_project',
  'clone_project',
  'remove_project',
  'browse_folders',
]);

/**
 * A mode-aware sentence appended to those four refusals, or `''`.
 *
 * NOTHING NARROWS HERE. `REFUSED_ACTIONS` already refuses all four
 * UNCONDITIONALLY — a project leader has never been able to manage the registry
 * or browse the host, in any mode — and the boundary, the answer shape and the
 * audit settlement (`boundaryRefusalOf` in `mcp/index.ts`, reason
 * `project_registry` / `host_filesystem`) are untouched. What #600 adds is that
 * the leader is TOLD why there is nothing to manage, instead of reading a
 * sentence about a workspace this folder does not have.
 *
 * Appended at call time rather than stored in the table, so
 * `GET /api/v1/mcp/reference` and the generated tool reference keep answering the
 * table's own text and the two cannot drift.
 */
function singleProjectNote(action: string): string {
  if (!NARROWED_ACTIONS.has(action)) return '';
  const narrowing = singleProjectNarrowing();
  if (!narrowing) return '';
  return narrowing === 'project-root'
    ? ' This project owns its xezar state, so its registry holds this project alone.'
    : ' This workspace is narrowed to one project, so its registry holds this project alone.';
}

/** A path segment the cockpit's routes would read as ONE segment: no slash, no dot segment. */
const PATH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const validPathId = (id: string): boolean => id !== '.' && id !== '..' && PATH_ID_RE.test(id);

// The repo config's own `maxParallel` is INERT (§ 4.14): the scheduler reads the registry entry,
// which is `set_project`. Accepting it here would report a change that never happens.
const projectConfigWriteSchema = setConfigInputSchema.omit({ maxParallel: true }).strict();

/**
 * The workspace-settings write (#677 wave 2, slices B1 and B2). Owner rule 2026-09-20 ("every
 * key") reverses the D-03 § 4.9 boundary that made this a refusal: a leader now writes the same
 * workspace keys the cockpit's own Settings panes write, through the same route.
 *
 * SLICE B2 REMOVED THE LAST NARROWING. `browseRoot` (the folder browser's confinement root) and
 * `projectsDir` (where a cockpit clone lands) are the two filesystem boundaries B1 held back for
 * their own review; the same owner rule covers them, so the argument is now the contract schema
 * itself with nothing omitted. They are NOT validated here and must not be: the route runs a real
 * write probe on each — an absolute path, an existing directory for the browse root, `mkdir -p`
 * for the checkout root — and answers 400 with its reason BEFORE `mergeWriteWorkspaceConfig`, so
 * a `resources` key sent in the same body does not half-apply. Re-implementing that check at this
 * door would be a second opinion about the filesystem, which is exactly how the two doors drift.
 *
 * An unknown key is refused rather than silently dropped, at EVERY level, and that strictness
 * lives in the contract (`packages/contract/src/workspace.ts`) rather than here — the route
 * validates with the same schema this one re-declares, so both doors refuse the same body with
 * the same reason. It used to live only here, and the asymmetry was the bug: the route answered
 * 200 for `{ nonsenseKey: 123 }` (QA case H) and both doors answered 200 for a misspelt nested
 * key (review m1) — success for a change that never happened. The `.strict()` below is kept even
 * though the contract shape already carries it: this is the door a leader reads, and the guarantee
 * it states must not depend on a schema somewhere else keeping a modifier.
 */
const workspaceConfigWriteSchema = setWorkspaceConfigInputSchema.strict();

/**
 * The workspace PREFERENCE-BAG write (#677 wave 2, slice B3). The same owner rule of 2026-09-20
 * ("every key") reverses the refusal that used to answer `set_workspace_ui_state`, with two
 * exclusions the owner named at 07:41 the same day: the THEME, which is not a stored setting at
 * all (it lives in the browser's own `localStorage`, `packages/web/src/lib/theme.ts`, and has no
 * server route to dispatch), and the per-repo composer memory, which is machine memory rather
 * than a setting and is not a key of this bag anyway.
 *
 * THE DOOR DECIDES THE KEY SET; THE ROUTE DECIDES THE VALUES. The five keys below are exactly
 * what the owner opened, and the strict object is what keeps the two LEGACY keys of the same bag
 * out of a leader's reach: `sidebar` (which groups are folded) and `lastLocation` (where the last
 * browser navigated) describe one person's WINDOW, and the current cockpit keeps both in
 * `localStorage` — a leader writing them would move a screen for whoever opens an older cockpit
 * against this home. Each value schema is the contract's own (`workspaceUiStateSchema.shape`),
 * never a hand-written copy, and each is deliberately the TOLERANT read-side one: the bounds
 * (`importedSkills` at most 200 names, `taskTable.expandedColumns` at most 50 columns, an
 * incident id at most 128 characters) and the 128 KiB body cap belong to
 * `PUT /workspace/ui-state`, which this dispatches, so a body the cockpit's own route refuses is
 * refused here by that route and with its reason — one opinion about a value, not two.
 */
const workspaceUiStateWriteSchema = z
  .strictObject({
    appearance: workspaceUiStateSchema.shape.appearance,
    notifications: workspaceUiStateSchema.shape.notifications,
    taskTable: workspaceUiStateSchema.shape.taskTable,
    importedSkills: workspaceUiStateSchema.shape.importedSkills,
    dismissedProviderAuthFailures: workspaceUiStateSchema.shape.dismissedProviderAuthFailures,
  })
  .refine((bag) => Object.keys(bag).length > 0, { message: 'send at least one preference to change' });

const projectRegistryWriteSchema = z.strictObject(updateProjectInputSchema.shape);
const promptTemplatesSchema = uiStateSchema.shape.promptTemplates.unwrap();

// Agent steps only — `command`, `resultScope` and the check step's `onFail` are not keys here, and the object is
// strict, so a check step is refused rather than silently turned into something else.
const { command: _command, resultScope: _resultScope, onFail: _onFail, ...agentStepShape } = workflowStepDefSchema.shape;
const agentStepSchema = z.strictObject(agentStepShape).refine((step) => Boolean(step.prompt ?? step.skill), {
  message: 'a step needs a prompt or a skill; check steps (shell commands) cannot be saved through MCP',
});
const { steps: _steps, ...saveWorkflowShape } = saveWorkflowInputSchema.shape;
const agentWorkflowSchema = z
  .strictObject({ ...saveWorkflowShape, steps: z.array(agentStepSchema).min(1).max(8).optional() })
  .refine((body) => Boolean(body.steps) !== Boolean(body.skills), { message: 'provide either "steps" or "skills", not both' });

/** The cockpit form's fixed values (`automations.tsx` `AutomationEditor`, create). D-97: matched, never widened. */
const AUTOMATION_FORM_FIXED = {
  events: ['issue.opened'],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  workflow: 'quick-task',
} as const;
const automationCreateFormSchema = z.strictObject({
  name: z.string().min(1),
  prompt: z.string().min(1),
  enable: z.boolean().optional().describe('Enable from a current-time baseline (existing matches will not launch). Default false.'),
});
const automationEditFormSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    expectedRevision: updateAutomationInputSchema.shape.expectedRevision,
  })
  .refine((edit) => edit.name !== undefined || edit.prompt !== undefined, { message: 'change name, prompt or both' });

const automationLogQueryInputSchema = z.strictObject({
  automationId: z.string().min(1).max(128).optional(),
  result: automationLogResultSchema.optional(),
  event: automationEventSchema.optional(),
  since: z.string().datetime().optional().describe('ISO timestamp; only newer rows.'),
  cursor: z.number().int().positive().optional().describe('Row sequence to continue from.'),
  limit: z.number().int().min(1).max(100).optional(),
});

export const projectConfigInputSchema = z
  .object({
    action: z
      .enum([...PROJECT_CONFIG_ACTIONS, ...REFUSED_ACTION_NAMES])
      .describe(
        'What to do in the project this connection is bound to, plus the shared settings set_workspace_config changes and the shared presentation preferences set_workspace_ui_state and import_skills change, for every project on this machine. Actions outside that boundary (accounts, the project registry, host folders) are answered with a refusal that names the boundary.',
      ),
    projectId: z
      .unknown()
      .optional()
      .describe('Never accepted: the project is the one this connection is bound to, and a call that names one is refused.'),
    config: projectConfigWriteSchema
      .optional()
      .describe("set_config: the project's own settings to change. null clears a key back to its default."),
    workspaceConfig: workspaceConfigWriteSchema
      .optional()
      .describe(
        'set_workspace_config: the workspace-wide settings to change — they apply to every project on this machine. Only the keys you send are touched; null clears a key back to its default. The two workspace folder paths are included: the folder the file picker may browse, and the folder new checkouts land in. Both are checked for real: a path that is not absolute, is not a folder, or cannot be written to is answered with the reason and nothing is saved, the other keys in the same call included.',
      ),
    uiState: workspaceUiStateWriteSchema
      .optional()
      .describe(
        'set_workspace_ui_state: the shared presentation preferences to change — they apply to every project on this machine. Only the keys you send are touched: appearance (accent, density, width), notifications.enabled, taskTable.expandedColumns, importedSkills (the whole curated list) and dismissedProviderAuthFailures. The colour theme is not here: it is stored by the browser itself, not by the server.',
      ),
    importedSkills: workspaceUiStateSchema.shape.importedSkills
      .describe(
        'import_skills: the WHOLE curated list of default skill names to show, replacing the previous one; [] shows none of them. Read the names with list_importable_skills.',
      ),
    project: projectRegistryWriteSchema
      .optional()
      .describe("set_project: this project's concurrency cap (maxParallel, null inherits the workspace cap) and/or its tags (whole list)."),
    promptTemplates: promptTemplatesSchema
      .optional()
      .describe('set_prompt_templates: the WHOLE list of follow-up prompt templates; [] is an empty list.'),
    fileId: z.string().min(1).max(128).optional().describe('An agent config file id from list_agent_config — never a path.'),
    content: setAgentConfigInputSchema.shape.content.optional().describe('write_agent_config: the full new file content.'),
    version: setAgentConfigInputSchema.shape.version
      .optional()
      .describe('write_agent_config: the version from the read you based the edit on; null when the file does not exist yet.'),
    yaml: z.string().min(1).max(100_000).optional().describe('parse_workflow: workflow YAML to validate and normalise.'),
    workflow: agentWorkflowSchema
      .optional()
      .describe(
        'save_workflow: name plus exactly one of steps (agent steps: prompt or skill) or skills. Check steps (shell commands) are not accepted. An existing file is refused unless overwrite is true.',
      ),
    name: z.string().min(1).max(200).optional().describe('delete_workflow / get_skill: the workflow or skill name.'),
    wait: z.boolean().optional().describe('Skill reads: wait for a cold team-skill cache to load first.'),
    refresh: z.boolean().optional().describe('get_capabilities: probe provider status now instead of serving the cached answer.'),
    automationId: z.string().min(1).max(128).optional(),
    automation: automationCreateFormSchema
      .optional()
      .describe('create_automation: the cockpit form — name, prompt template, enable. Trigger: new issue, every 5 minutes, last 7 days, at most 25 records; task workflow quick-task.'),
    update: automationEditFormSchema
      .optional()
      .describe('update_automation: a new name and/or prompt plus expectedRevision from your last read; everything else is kept.'),
    mode: automationCheckInputSchema.shape.mode.optional().describe('check_automation: preview counts matches; execute launches them.'),
    checkId: z.string().min(1).max(128).optional(),
    receiptId: z.string().min(1).max(128).optional(),
    logQuery: automationLogQueryInputSchema.optional(),
    runId: z.string().min(1).max(128).optional().describe("remove_worktree: the task's run id."),
    expectedVersion: mcpExpectedVersionSchema
      .optional()
      .describe('remove_worktree: the `version` task_read returned for the task. If the task changed since, nothing is removed.'),
    onboardingIdentity: onboardingIdentitySchema
      .optional()
      .describe(
        'dismiss_onboarding_offer: the `onboarding.observed` pair discover_project returned to you. If the running identity has moved on since that read, the answer is a conflict and nothing is written. Omit it to dismiss whatever is running now.',
      ),
    operationId: operationIdSchema
      .optional()
      .describe(
        'Client-generated key for this operation (8–128 chars). Required by every action that changes something and refused by every action that only reads. Reuse it only to repeat the same operation: a repeat returns the first answer and changes nothing twice.',
      ),
  })
  .strict()
  .superRefine((args, ctx) => {
    // A refusal is answered whatever else was sent — it must never become a schema essay.
    if (isRefused(args.action)) return;
    const allowed = ACTION_FIELDS[args.action];
    for (const field of allowed.required) {
      if (args[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${args.action} needs ${field}` });
    }
    for (const field of FIELDS) {
      if (args[field] !== undefined && !allowed.required.includes(field) && !allowed.optional.includes(field)) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is not used by ${args.action}` });
      }
    }
  });
export type ProjectConfigInput = z.output<typeof projectConfigInputSchema>;

// ---- the in-process client ----------------------------------------------------------------------

const IN_PROCESS_BASE = 'http://127.0.0.1';
const IN_PROCESS_HOST = '127.0.0.1';

/** The same in-process client the shared adapter builds (`service-adapter.ts`): loopback host, no
 *  Origin — the request never leaves the process. */
const buildClient = (service: ServiceDispatch) =>
  hc<AppType>(IN_PROCESS_BASE, {
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('host', IN_PROCESS_HOST);
      headers.delete('origin');
      const url = input instanceof Request ? input.url : String(input);
      return service.request(url, { ...init, headers });
    },
  }).api.v1;

type Answer<T> = { ok: true; status: number; value: T } | { ok: false; status: number; error: string; body: unknown };

/** Map a service answer. A success without a JSON body is an error, never an empty value — except
 *  a 204, whose whole meaning is "done, nothing to say". */
async function settle<T>(pending: Promise<Response>, success: readonly number[]): Promise<Answer<T>> {
  const res = await pending;
  const body: unknown = await res.json().catch(() => undefined);
  if (success.includes(res.status)) {
    if (res.status === 204) return { ok: true, status: 204, value: undefined as T };
    if (body === undefined) return { ok: false, status: 502, error: `service answered ${res.status} without a body`, body };
    return { ok: true, status: res.status, value: body as T };
  }
  const error =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `service answered ${res.status}`;
  return { ok: false, status: res.status, error, body };
}

// ---- results ------------------------------------------------------------------------------------

type Result = McpToolResult;

function ok(action: string, result: unknown): Result {
  const payload = { action, origin: MCP_ORIGIN, result: result ?? null };
  return textResult(JSON.stringify(payload, null, 2), payload);
}

function failed(action: string, answer: Extract<Answer<unknown>, { ok: false }>, root: string): Result {
  // The task changed after the leader read it (#250): an ordinary conflict, nothing applied — D-06
  // § 4.4's rejection verbatim, not an error the leader must correct.
  const stale = staleRejectionIn(answer.body);
  if (stale) {
    const payload = { action, origin: MCP_ORIGIN, ...stale };
    return textResult(JSON.stringify(payload, null, 2), payload);
  }
  const error = scrubPaths(answer.error, root);
  const exists = answer.body && typeof answer.body === 'object' && (answer.body as { exists?: unknown }).exists === true;
  return errorResult(`${action} was refused by xezar (${answer.status}): ${error}`, {
    action,
    origin: MCP_ORIGIN,
    status: answer.status,
    error,
    ...(exists ? { exists: true } : {}),
  });
}

function refused(action: string, boundary: ConfigBoundary, reason: string): Result {
  return errorResult(`Refused (${BOUNDARY_LABEL[boundary]}): ${action} — ${reason} Nothing was changed.`, {
    action,
    origin: MCP_ORIGIN,
    refused: true,
    boundary,
  });
}

/** The next legitimate action after a quality-gate refusal. It offers no waiver, to anyone (A-22). */
export const QUALITY_GATE_NEXT_ACTION =
  'This is a blocker. A check step is a quality gate and cannot be removed or weakened from MCP. Keep the step, ' +
  'save the workflow under a new name, or report this blocker so a person can change the gate in the cockpit.';

/** One check step of an on-disk workflow — named, never its command. */
interface GateStep {
  file: string;
  id: string;
  name?: string;
}

/**
 * The check steps a workflow save or delete would take away (F-22, #262), read from the FILES on
 * disk — never from what the caller says is there. A file is at risk when it is the one the save
 * route writes (`<slug>.yaml`, only when `overwrite` lets the route replace it) or when it carries
 * the same workflow `name` (a save would shadow it, a delete removes it). The replacement can
 * carry no check step at all (the MCP step schema is agent-only), so every check step of an
 * at-risk file is lost — deleting it, emptying its command and turning it into an agent step are
 * all the same loss here. A target file that cannot be parsed cannot be shown to hold no check
 * step, so it is reported too: unknown evidence is never a pass.
 */
async function checkStepsAtRisk(
  root: string,
  name: string,
  target: { file: string } | null,
): Promise<{ steps: GateStep[]; unreadable: string[] }> {
  const dir = projectWorkflowsDir(root);
  const steps: GateStep[] = [];
  const unreadable: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return { steps, unreadable };
  }
  for (const entry of entries.sort()) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const file = projectRelative(root, join(dir, entry)) ?? entry;
    // Lower-cased: on a case-insensitive disk the route's `gated.yaml` write replaces `Gated.yaml`.
    const isTarget = target?.file === entry.toLowerCase();
    let doc: unknown;
    try {
      doc = parseYaml(await readFile(join(dir, entry), 'utf8'));
    } catch {
      if (isTarget) unreadable.push(file);
      continue;
    }
    const record = doc && typeof doc === 'object' ? (doc as { name?: unknown; steps?: unknown }) : {};
    if (!isTarget && (typeof record.name !== 'string' || record.name.trim() !== name.trim())) continue;
    for (const step of Array.isArray(record.steps) ? record.steps : []) {
      if (!step || typeof step !== 'object' || !('command' in step)) continue;
      const { id, name: label } = step as { id?: unknown; name?: unknown };
      steps.push({ file, id: typeof id === 'string' ? id : '(no id)', ...(typeof label === 'string' ? { name: label } : {}) });
    }
  }
  return { steps, unreadable };
}

function qualityGateRefusal(action: string, risk: { steps: GateStep[]; unreadable: string[] }): Result {
  const named = risk.steps.map((step) => `"${step.id}"${step.name ? ` (${step.name})` : ''} in ${step.file}`);
  const reason =
    risk.steps.length > 0
      ? `it would remove the check step ${named.join(', ')}. A check step is a quality gate, and MCP neither adds nor removes one.`
      : `${risk.unreadable.join(', ')} could not be read, so it cannot be shown to hold no check step.`;
  return errorResult(`Refused (${BOUNDARY_LABEL['quality-gate']}): ${action} — ${reason} ${QUALITY_GATE_NEXT_ACTION} Nothing was changed.`, {
    action,
    origin: MCP_ORIGIN,
    refused: true,
    blocker: true,
    boundary: 'quality-gate',
    checkSteps: risk.steps,
    ...(risk.unreadable.length > 0 ? { unreadable: risk.unreadable } : {}),
    nextAction: QUALITY_GATE_NEXT_ACTION,
  });
}

function invalid(action: string, message: string): Result {
  return errorResult(`${action}: ${message}`, { action, origin: MCP_ORIGIN, status: 400, error: message });
}

// ---- paths --------------------------------------------------------------------------------------

/** A path inside the project, relative to its root; anything else is not reported at all. */
function projectRelative(root: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel;
}

/** Error text is the service's own, but it can quote an absolute path: report the project's as
 *  `.`, and never name the home directory. */
function scrubPaths(text: string, root: string): string {
  let out = text.split(root).join('.');
  const home = process.env.HOME;
  if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}

/**
 * Whether `path` really lands inside `root` once every symlink on the way is followed. The
 * cockpit's writer goes THROUGH a symlink (`files.ts`), so an in-repo `.claude/settings.json`
 * linked into a home folder would turn a project write into a home write. A path that does not
 * exist yet is judged by its nearest existing ancestor — the directory the write would create it in.
 */
export function resolvesInside(root: string, path: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = join(realpathSync(existing), ...rest);
  } catch {
    return false;
  }
  return real === realRoot || real.startsWith(realRoot + sep);
}

// ---- agent config -------------------------------------------------------------------------------

/**
 * The gate every agent-config action passes BEFORE anything is dispatched: a known catalog id,
 * not a `scope: 'user'` file (keyed off the catalog field — D-03-1), and a file that stays inside
 * the project. The user-scope refusal names no path and never looks at the disk, so it reads the
 * same whether or not the file exists.
 */
function agentConfigGate(action: string, fileId: string, root: string): { def: ConfigFileDef } | { result: Result } {
  const def = findConfigFile(fileId);
  if (!def) return { result: invalid(action, `unknown agent config file id: ${JSON.stringify(fileId)} — list_agent_config names them`) };
  if (def.scope === 'user') {
    return {
      result: refused(
        action,
        'home-file',
        `${fileId} is a user-scope file in a home folder, shared by every project on this machine. Only this project’s own files are served.`,
      ),
    };
  }
  if (!resolvesInside(root, def.resolve(root, agentHomePaths(process.env)))) {
    return {
      result: refused(action, 'outside-project', `${fileId} resolves outside this project folder, so it is not served here.`),
    };
  }
  return { def };
}

/** Deep enough to show server names and their fields, never deep enough to show a value. */
const STRUCTURE_DEPTH = 3;
const STRUCTURE_MAX_KEYS = 200;

type Shape = string | { [key: string]: Shape };

/** The kind of a value, never the value itself. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value).length})`;
  return typeof value;
}

/** Key names and value kinds down to `STRUCTURE_DEPTH`. Every scalar — command strings, args,
 *  env values, headers, URLs, tokens — is reported as its kind (ruling 12, F-15). */
export function structureOf(value: unknown, depth = 1): Shape {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || depth > STRUCTURE_DEPTH) return kindOf(value);
  const out: { [key: string]: Shape } = {};
  for (const key of Object.keys(value).slice(0, STRUCTURE_MAX_KEYS)) {
    out[key] = structureOf((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

function parseForStructure(content: string, format: ConfigFileDef['format']): unknown {
  if (format === 'json') return JSON.parse(content);
  if (format === 'jsonc') return JSON.parse(stripJsonComments(content));
  if (format === 'toml') return parseToml(content);
  throw new Error('no structure for this format');
}

// ---- the tool -----------------------------------------------------------------------------------

type Client = ReturnType<typeof buildClient>;

interface Session {
  api: Client;
  projectId: string;
  root: string;
}

/** The bound project's registry row, never another — or null when the registry does not list it. */
async function boundEntry(s: Session): Promise<Answer<ProjectListEntry | null>> {
  const answer = await settle<ProjectsResponse>(s.api.projects.$get(), [200]);
  if (!answer.ok) return answer;
  return { ok: true, status: 200, value: answer.value.projects.find((p) => p.id === s.projectId) ?? null };
}

/** Hosted mode trims the root to a basename, the rule `/health` already follows (§ 4.6). */
async function localHandoff(s: Session): Promise<boolean> {
  const health = await settle<HealthResponse>(s.api.health.$get(), [200]);
  return health.ok ? health.value.capabilities.localHandoff : false;
}

async function projectFacts(s: Session, entry: ProjectListEntry) {
  const local = await localHandoff(s);
  return {
    id: entry.id,
    name: entry.name,
    root: local ? entry.root : basename(entry.root),
    status: entry.status,
    ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
    source: entry.source,
    addedAt: entry.addedAt,
    lastOpenedAt: entry.lastOpenedAt,
    ...(entry.forge !== undefined ? { forge: entry.forge } : {}),
    ...(entry.repoUrl !== undefined ? { repoUrl: entry.repoUrl } : {}),
    /** null = inherits the workspace cap. */
    maxParallel: entry.maxParallel ?? null,
    tags: entry.tags ?? [],
  };
}

/** The repo config minus the inert per-repo `maxParallel` (§ 4.14). */
function projectConfig(config: ConfigResponse) {
  const { maxParallel: _inert, ...rest } = config;
  return rest;
}

function skillEntry(root: string, skill: Skill, withBody: boolean) {
  const path = projectRelative(root, skill.path);
  return {
    name: skill.name,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    ...(skill.interactive ? { interactive: true } : {}),
    source: skill.source,
    ...(path !== undefined ? { path } : {}),
    ...(skill.team
      ? {
          team: {
            repo: skill.team.repo,
            ref: skill.team.ref,
            path: skill.team.path,
            ...(skill.team.commit !== undefined ? { commit: skill.team.commit } : {}),
          },
        }
      : {}),
    ...(withBody ? { body: skill.body } : {}),
  };
}

/**
 * The workspace half of `get_limits`, and the answer `set_workspace_config` gives back (#677 B1):
 * ONE vocabulary in both directions, so a leader reads its own write in the words it read the
 * settings in. § 4.9's narrowing survives the reversal — the two workspace folder paths and the
 * machine-wide agent defaults stay out of the ANSWER even though the write accepts both (the
 * defaults since B1, the folder paths since B2), because what may be CHANGED and what may be READ
 * were decided separately (I-121's and I-127's reads are still the cockpit's). A leader that
 * writes a folder path therefore gets the acknowledgement without the path echoed back.
 */
function workspaceLimits(w: WorkspaceConfigResponse) {
  return {
    resources: { ...w.resources },
    followups: { effective: w.effectiveFollowups, inherited: w.followups === null },
    agentEnvPassthrough: { effectiveNames: w.effectiveAgentEnvPassthrough, inherited: w.agentEnvPassthrough === null },
    composerDefaults: {
      autonomous: w.composerDefaults.autonomous ?? w.composerDefaults.inheritedAutonomous,
      autonomousInherited: w.composerDefaults.autonomous === null,
      worktree: w.composerDefaults.worktree ?? w.composerDefaults.inheritedWorktree,
      worktreeInherited: w.composerDefaults.worktree === null,
    },
    skillsAutoUpdate: { effective: w.effectiveSkillsAutoUpdate, inherited: w.skillsAutoUpdate === null },
  };
}

/**
 * The answer BOTH preference writes give back (#677 B3) — `set_workspace_ui_state` and
 * `import_skills` — so a leader reads either write in one vocabulary, the way
 * `set_workspace_config` answers in `get_limits`'s words.
 *
 * NARROWED, like every other answer here, and the narrowing is not cosmetic:
 *   - `sidebar` and `lastLocation` are in the same file and are not part of the answer. They are
 *     one person's window state, and this bag is not the leader's to read either.
 *   - a DISMISSED incident is reported as the provider's NAME, never the incident id the cockpit
 *     stores. An incident id is exactly what `get_capabilities` withholds (F-03), and a write is
 *     no reason to hand one back.
 *   - `importedSkills` keeps its tri-state honestly: `null` is "never curated, every default
 *     skill shows", and `[]` is the real, curated empty list.
 * Unknown keys a newer cockpit stored round-trip in the FILE untouched (the bag is open by
 * design); they are simply not part of what a leader is told.
 */
function workspacePreferences(state: WorkspaceUiState) {
  return {
    appearance: {
      accent: state.appearance?.accent ?? null,
      density: state.appearance?.density ?? null,
      width: state.appearance?.width ?? null,
    },
    notifications: { enabled: state.notifications?.enabled ?? null },
    taskTable: { expandedColumns: state.taskTable?.expandedColumns ?? {} },
    importedSkills: state.importedSkills ?? null,
    dismissedProviderAuthFailures: Object.entries(state.dismissedProviderAuthFailures ?? {})
      .filter(([, incident]) => incident !== undefined)
      .map(([provider]) => provider),
  };
}

/** An account label is user text; one that looks like an email is an identity and is withheld. */
const looksLikeIdentity = (label: string): boolean => label.includes('@');

async function run(args: ProjectConfigInput & { action: ProjectConfigAction }, s: Session): Promise<Result> {
  const { action } = args;
  const scope = { projectId: s.projectId };
  const fail = (answer: Extract<Answer<unknown>, { ok: false }>) => failed(action, answer, s.root);

  switch (action) {
    case 'get_config': {
      const answer = await settle<ConfigResponse>(s.api.p[':projectId'].config.$get({ param: scope }), [200]);
      return answer.ok ? ok(action, projectConfig(answer.value)) : fail(answer);
    }
    case 'set_config': {
      const answer = await settle<ConfigResponse>(
        s.api.p[':projectId'].config.$put({ param: scope, json: args.config! }),
        [200],
      );
      return answer.ok ? ok(action, projectConfig(answer.value)) : fail(answer);
    }

    case 'get_project': {
      const entry = await boundEntry(s);
      if (!entry.ok) return fail(entry);
      if (!entry.value) return invalid(action, 'this project is not in the workspace registry listing');
      return ok(action, await projectFacts(s, entry.value));
    }
    case 'set_project': {
      // The registry family is workspace-level and single-mount, so its `:projectId` carries no
      // binding of its own: the BOUND id is substituted here and nothing a client sends reaches it.
      const answer = await settle<UpdateProjectResponse>(
        s.api.projects[':projectId'].$patch({ param: scope, json: args.project! }),
        [200],
      );
      return answer.ok ? ok(action, await projectFacts(s, answer.value.project)) : fail(answer);
    }

    case 'get_prompt_templates': {
      const answer = await settle<UiState>(s.api.p[':projectId']['ui-state'].$get({ param: scope }), [200]);
      // null = never edited here: the cockpit's built-in defaults apply.
      return answer.ok ? ok(action, { promptTemplates: answer.value.promptTemplates ?? null }) : fail(answer);
    }
    case 'set_prompt_templates': {
      // Whole-list replace (§ 4.5): the route merges shallowly at the top level, so the one key
      // sent is the only key touched, and a per-item write would clobber the rest of the list.
      const answer = await settle<UiState>(
        s.api.p[':projectId']['ui-state'].$put({ param: scope, json: { promptTemplates: args.promptTemplates! } }),
        [200],
      );
      return answer.ok ? ok(action, { promptTemplates: answer.value.promptTemplates ?? null }) : fail(answer);
    }

    case 'get_limits': {
      const [workspace, entry, config] = await Promise.all([
        settle<WorkspaceConfigResponse>(s.api.workspace.config.$get(), [200]),
        boundEntry(s),
        settle<ConfigResponse>(s.api.p[':projectId'].config.$get({ param: scope }), [200]),
      ]);
      if (!workspace.ok) return fail(workspace);
      if (!entry.ok) return fail(entry);
      if (!config.ok) return fail(config);
      // Nothing about another project, the host's environment, its folders or its machine-wide
      // agent defaults is part of the answer.
      return ok(action, {
        workspace: workspaceLimits(workspace.value),
        project: {
          /** null = this project inherits the workspace cap. */
          maxParallel: entry.value?.maxParallel ?? null,
          memoryLimitMb: config.value.memoryLimitMb,
          worktreeRetention: config.value.worktreeRetention,
        },
      });
    }
    case 'set_workspace_config': {
      // The cockpit's own route: its validator, its 400s, its `mergeWriteWorkspaceConfig` and its
      // `semaphore.refresh()`, so a leader's change takes effect without a restart exactly as a
      // person's does. The answer is the `get_limits` vocabulary, never the raw route body.
      const answer = await settle<WorkspaceConfigResponse>(
        s.api.workspace.config.$put({ json: args.workspaceConfig! }),
        [200],
      );
      return answer.ok ? ok(action, { workspace: workspaceLimits(answer.value) }) : fail(answer);
    }
    case 'set_workspace_ui_state': {
      // The cockpit's own route again: its schema bounds, its 128 KiB body cap, its shallow
      // merge over `~/.xezar/ui-state.json`. Only the keys sent are touched, so a leader
      // changing the accent does not erase the person's imported-skills list.
      const answer = await settle<WorkspaceUiState>(s.api.workspace['ui-state'].$put({ json: args.uiState! }), [200]);
      return answer.ok ? ok(action, { uiState: workspacePreferences(answer.value) }) : fail(answer);
    }

    case 'get_capabilities': {
      const [health, providers] = await Promise.all([
        settle<HealthResponse>(s.api.health.$get(), [200]),
        settle<ProviderStatusResponse>(
          s.api.providers.status.$get({ query: args.refresh ? { refresh: '1' } : {} }),
          [200],
        ),
      ]);
      if (!health.ok) return fail(health);
      if (!providers.ok) return fail(providers);
      return ok(action, {
        capabilities: health.value.capabilities,
        // Availability and version only: never an install path, a home folder or raw CLI output.
        tools: health.value.checks.map((check) => ({
          name: check.name,
          available: check.available,
          ...(check.version !== undefined ? { version: check.version } : {}),
        })),
        // Coarse state and the understandable reason (F-03); never a credential, an account, a
        // login command or an incident id.
        providers: providers.value.providers.map((row) => ({
          provider: row.provider,
          status: row.status,
          ...(row.enabled !== undefined ? { enabled: row.enabled } : {}),
          ...(row.hint !== undefined ? { hint: row.hint } : {}),
        })),
      });
    }

    case 'get_account': {
      const answer = await settle<AgentProfilesResponse>(s.api.workspace['agent-profiles'].$get(), [200]);
      if (!answer.ok) return fail(answer);
      const listing = answer.value;
      if (!listing.editable) {
        return ok(action, { available: false, reason: 'account information is not served in hosted mode' });
      }
      // D-03-3: the effective handle and display label for THIS project only — the selection
      // rule `selectionFor` applies (repo first, then the machine default), and nothing else.
      const selection = listing.selections[s.root] ?? {};
      const providers = [...new Set(listing.profiles.map((p) => p.provider))];
      return ok(action, {
        available: true,
        accounts: providers.map((provider) => {
          const handle = selection[provider] ?? listing.defaults[provider] ?? 'default';
          const profile = listing.profiles.find((p) => p.provider === provider && p.id === handle);
          const label = profile?.label;
          return {
            provider,
            handle,
            ...(label && !looksLikeIdentity(label) ? { label } : {}),
          };
        }),
      });
    }

    case 'list_agent_config': {
      const answer = await settle<AgentConfigListing>(s.api.p[':projectId']['agent-config'].$get({ param: scope }), [200]);
      if (!answer.ok) return fail(answer);
      const files = answer.value.files.flatMap((file) => {
        const def = findConfigFile(file.id);
        // Keyed off the CATALOG's scope, never the row's or a path (E-SCOPE-USER).
        if (!def || def.scope === 'user') return [];
        const inside = resolvesInside(s.root, def.resolve(s.root, agentHomePaths(process.env)));
        return [
          {
            id: file.id,
            runners: file.runners,
            kind: file.kind,
            scope: file.scope,
            label: file.label,
            format: file.format,
            tracked: file.tracked,
            seeded: file.seeded,
            holdsMcp: file.holdsMcp,
            precedence: file.precedence,
            ...(file.hotReload !== undefined ? { hotReload: file.hotReload } : {}),
            docsUrl: file.docsUrl,
            ...(inside
              ? { exists: file.exists, size: file.size, version: file.version }
              : { withheld: 'resolves outside this project folder' }),
            writable: file.writable && inside,
            ...(file.readOnlyReason !== undefined ? { readOnlyReason: file.readOnlyReason } : {}),
          },
        ];
      });
      // `userMcp` (the names in ~/.claude.json) is a home file: never part of this answer.
      return ok(action, { editable: answer.value.editable, files });
    }
    case 'read_agent_config': {
      const gate = agentConfigGate(action, args.fileId!, s.root);
      if ('result' in gate) return gate.result;
      const { def } = gate;
      const answer = await settle<AgentConfigFileContent>(
        s.api.p[':projectId']['agent-config'][':id'].$get({ param: { ...scope, id: def.id } }),
        [200],
      );
      if (!answer.ok) return fail(answer);
      const file = answer.value;
      const head = { id: def.id, label: def.label, format: def.format, exists: file.exists, version: file.version };
      if (!def.holdsMcp) return ok(action, { ...head, content: file.content });
      // Ruling 12: an MCP-holding file is read as STRUCTURE, built from the parsed file and
      // never from its bytes — every value (command, args, env, headers, URLs, tokens) withheld.
      let structure: Shape | null = null;
      if (file.exists) {
        try {
          structure = structureOf(parseForStructure(file.content, def.format));
        } catch {
          return ok(action, { ...head, contentWithheld: true, structure: null, parseError: `the file does not parse as ${def.format}` });
        }
      }
      return ok(action, { ...head, contentWithheld: true, structure });
    }
    case 'write_agent_config': {
      const gate = agentConfigGate(action, args.fileId!, s.root);
      if ('result' in gate) return gate.result;
      const { def } = gate;
      // Through the cockpit's own route, so its hosted-mode 409 (E-409-LOCAL), its format check,
      // its stale-version 409 and its byte-exact write all apply unchanged.
      const answer = await settle<AgentConfigFileContent>(
        s.api.p[':projectId']['agent-config'][':id'].$put({
          param: { ...scope, id: def.id },
          json: { content: args.content!, version: args.version ?? null },
        }),
        [200],
      );
      if (!answer.ok) return fail(answer);
      // The echo carries the content; the leader already has it, and an MCP file's must not travel.
      return ok(action, { id: def.id, label: def.label, exists: answer.value.exists, version: answer.value.version });
    }

    case 'list_workflows': {
      const answer = await settle<WorkflowsResponse>(s.api.p[':projectId'].workflows.$get({ param: scope }), [200]);
      if (!answer.ok) return fail(answer);
      return ok(action, {
        workflows: answer.value.workflows.map(({ path, ...workflow }) => {
          const rel = projectRelative(s.root, path);
          return { ...workflow, ...(rel !== undefined ? { path: rel } : {}) };
        }),
        issues: answer.value.issues.map((issue) => ({
          path: projectRelative(s.root, issue.path) ?? basename(issue.path),
          message: scrubPaths(issue.message, s.root),
        })),
      });
    }
    case 'parse_workflow': {
      const answer = await settle<unknown>(
        s.api.p[':projectId'].workflows.parse.$post({ param: scope, json: { yaml: args.yaml! } }),
        [200],
      );
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'save_workflow': {
      const workflow = args.workflow!;
      // The file the route writes is `<slug>.yaml`, replaced only under `overwrite` (server.ts).
      const target = workflow.overwrite ? { file: `${slugify(workflow.name) || 'chain'}.yaml` } : null;
      const risk = await checkStepsAtRisk(s.root, workflow.name, target);
      if (risk.steps.length > 0 || risk.unreadable.length > 0) return qualityGateRefusal(action, risk);
      const answer = await settle<{ path: string; name: string }>(
        s.api.p[':projectId'].workflows.$post({ param: scope, json: args.workflow! }),
        [201],
      );
      if (!answer.ok) return fail(answer);
      return ok(action, { name: answer.value.name, path: projectRelative(s.root, answer.value.path) ?? null });
    }
    case 'delete_workflow': {
      const name = args.name!;
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        return invalid(action, `not a workflow name: ${JSON.stringify(name)}`);
      }
      const risk = await checkStepsAtRisk(s.root, name, null);
      if (risk.steps.length > 0) return qualityGateRefusal(action, risk);
      const answer = await settle<{ ok: true; path: string }>(
        s.api.p[':projectId'].workflows[':name'].$delete({ param: { ...scope, name } }),
        [200],
      );
      if (!answer.ok) return fail(answer);
      return ok(action, { deleted: true, name, path: projectRelative(s.root, answer.value.path) ?? null });
    }

    case 'list_skills':
    case 'get_skill':
    case 'refresh_skills': {
      const query = args.wait ? { wait: '1' } : {};
      const answer =
        action === 'refresh_skills'
          ? await settle<Skill[]>(s.api.p[':projectId'].skills.refresh.$post({ param: scope }), [200])
          : await settle<Skill[]>(s.api.p[':projectId'].skills.$get({ param: scope, query }), [200]);
      if (!answer.ok) return fail(answer);
      if (action === 'get_skill') {
        const skill = answer.value.find((entry) => entry.name === args.name);
        if (!skill) return invalid(action, `no skill named ${JSON.stringify(args.name)} in this project's catalog`);
        return ok(action, skillEntry(s.root, skill, true));
      }
      return ok(action, { skills: answer.value.map((skill) => skillEntry(s.root, skill, false)) });
    }
    case 'list_importable_skills': {
      const query = args.wait ? { wait: '1' } : {};
      const answer = await settle<unknown>(s.api.p[':projectId'].skills.importable.$get({ param: scope, query }), [200]);
      return answer.ok ? ok(action, { skills: answer.value }) : fail(answer);
    }
    case 'import_skills': {
      // The Import-skills panel's own write (I-092), which is one key of the workspace
      // preference bag — so it is the same route and the same answer as the write above, not a
      // second path to the same file. Whole-list replace, exactly as the panel does it: the
      // route merges shallowly at the top level, so the list sent IS the list.
      const answer = await settle<WorkspaceUiState>(
        s.api.workspace['ui-state'].$put({ json: { importedSkills: args.importedSkills! } }),
        [200],
      );
      return answer.ok ? ok(action, { uiState: workspacePreferences(answer.value) }) : fail(answer);
    }
    case 'check_skill_updates': {
      // The family is workspace-level and takes a project id in the body: the BOUND id is
      // substituted (E-BIND), and the answer is narrowed to this project's scope plus the
      // global availability flag and its reason (§ 4.10, ruling 6).
      const answer = await settle<SkillsUpdateState>(
        s.api.workspace['skills-update'].check.$post({ json: { projectId: s.projectId } }),
        [200],
      );
      if (!answer.ok) return fail(answer);
      const state = answer.value;
      const project = state.scopes.find((entry) => entry.scope === 'project');
      const global = state.scopes.find((entry) => entry.scope === 'global');
      return ok(action, {
        status: state.status,
        available: state.available,
        autoUpdateEnabled: state.autoUpdateEnabled,
        autoUpdateInherited: state.inherited,
        checkedAt: state.checkedAt,
        ...(project
          ? {
              project: {
                status: project.status,
                available: project.available,
                skills: project.skills,
                checkedAt: project.checkedAt,
                ...(project.reason !== undefined ? { reason: scrubPaths(project.reason, s.root) } : {}),
              },
            }
          : {}),
        ...(global
          ? {
              global: {
                available: global.available,
                ...(global.reason !== undefined ? { reason: scrubPaths(global.reason, s.root) } : {}),
              },
            }
          : {}),
      });
    }

    case 'list_automations': {
      const answer = await settle<unknown>(s.api.p[':projectId'].automations.$get({ param: scope }), [200]);
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'create_automation': {
      const { name, prompt, enable } = args.automation!;
      const { workflow, ...trigger } = AUTOMATION_FORM_FIXED;
      const json = { name, ...trigger, events: [...trigger.events], filters: { ...trigger.filters }, task: { prompt, workflow }, enable: enable ?? false };
      const answer = await settle<unknown>(s.api.p[':projectId'].automations.$post({ param: scope, json }), [201]);
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'update_automation': {
      const id = args.automationId!;
      if (!validPathId(id)) return invalid(action, `not an automation id: ${JSON.stringify(id)}`);
      const param = { ...scope, id };
      const one = s.api.p[':projectId'].automations[':id'];
      const current = await settle<{ automation: AutomationDefinition }>(one.$get({ param }), [200]);
      if (!current.ok) return fail(current);
      // The edit form's body: name and prompt change, everything else is the stored value. The
      // revision is the CALLER's, so an edit based on a stale read still answers the route's 409.
      const a = current.value.automation;
      const edit = args.update!;
      const json = {
        name: edit.name ?? a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        events: a.events,
        intervalSeconds: a.intervalSeconds,
        filters: a.filters,
        task: { ...a.task, prompt: edit.prompt ?? a.task.prompt },
        enabled: a.enabled,
        expectedRevision: edit.expectedRevision,
      };
      const answer = await settle<unknown>(one.$put({ param, json: json as never }), [200]);
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'get_automation':
    case 'delete_automation':
    case 'enable_automation':
    case 'pause_automation':
    case 'check_automation': {
      const id = args.automationId!;
      if (!validPathId(id)) return invalid(action, `not an automation id: ${JSON.stringify(id)}`);
      const param = { ...scope, id };
      const one = s.api.p[':projectId'].automations[':id'];
      const answer =
        action === 'get_automation'
          ? await settle<unknown>(one.$get({ param }), [200])
          : action === 'delete_automation'
            ? await settle<unknown>(one.$delete({ param }), [204])
            : action === 'enable_automation'
              ? await settle<unknown>(one.enable.$post({ param }), [200])
              : action === 'pause_automation'
                ? await settle<unknown>(one.pause.$post({ param }), [200])
                : await settle<unknown>(one.check.$post({ param, json: { mode: args.mode! } }), [202]);
      if (!answer.ok) return fail(answer);
      return ok(action, action === 'delete_automation' ? { deleted: true, automationId: id } : answer.value);
    }
    case 'get_automation_check': {
      const checkId = args.checkId!;
      if (!validPathId(checkId)) return invalid(action, `not a check id: ${JSON.stringify(checkId)}`);
      const check = await settle<AutomationCheck>(s.api['automation-checks'][':checkId'].$get({ param: { checkId } }), [200]);
      if (!check.ok) return fail(check);
      // The check family is workspace-level (a server-memory map). M-18: it is served only when
      // its automation belongs to THIS project — otherwise it is exactly as unknown as a bad id.
      const owner = await settle<unknown>(
        s.api.p[':projectId'].automations[':id'].$get({ param: { ...scope, id: check.value.automationId } }),
        [200],
      );
      if (!owner.ok) return failed(action, { ok: false, status: 404, error: 'not found', body: undefined }, s.root);
      return ok(action, check.value);
    }
    case 'get_automation_log': {
      const q = args.logQuery ?? {};
      const query = Object.fromEntries(
        Object.entries(q)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      );
      const answer = await settle<unknown>(
        s.api.p[':projectId']['automation-log'].$get({ param: scope, query: query as never }),
        [200],
      );
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'retry_automation_receipt': {
      const receiptId = args.receiptId!;
      if (!validPathId(receiptId)) return invalid(action, `not a receipt id: ${JSON.stringify(receiptId)}`);
      const answer = await settle<unknown>(
        s.api.p[':projectId']['automation-log'][':receiptId'].retry.$post({ param: { ...scope, receiptId } }),
        [202],
      );
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }

    case 'list_worktrees': {
      const answer = await settle<unknown>(s.api.p[':projectId'].worktrees.$get({ param: scope }), [200]);
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'reclaim_worktrees': {
      const answer = await settle<unknown>(s.api.p[':projectId'].worktrees.reclaim.$post({ param: scope, json: {} }), [200]);
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
    case 'remove_worktree': {
      const id = args.runId!;
      if (id === '.' || id === '..' || !runIdParamSchema.safeParse({ id }).success) {
        return invalid(action, `not a run id: ${JSON.stringify(id)}`);
      }
      const answer = await settle<unknown>(
        s.api.p[':projectId'].runs[':id']['remove-worktree'].$post({ param: { ...scope, id }, json: { expectedVersion: args.expectedVersion! } }),
        [200],
      );
      return answer.ok ? ok(action, { ...(answer.value as object), runId: id }) : fail(answer);
    }

    /**
     * Record that the post-update offer was made for this project (#464 P2, OQ-9).
     *
     * It writes DISPOSABLE RUNTIME SCRATCH, not configuration: `.local/xezar/onboarding-state.json`
     * only remembers that the offer happened, so the same identity does not offer twice. Deleting
     * the file loses that memory and nothing else. It is here rather than on `organise_work`
     * because it touches no task at all.
     *
     * It starts nothing and authorises nothing. A re-check is an ordinary task, dispatched with
     * `task_create` naming `discover_project.onboarding.launch.workflowId`.
     */
    case 'dismiss_onboarding_offer': {
      const identity = args.onboardingIdentity ?? (await observedOnboardingIdentity(s));
      if (!identity) return invalid(action, 'this project\'s setup state could not be read, so there is no offer to record.');
      const answer = await settle<unknown>(
        s.api.p[':projectId'].onboarding.offered.$post({ param: scope, json: identity }),
        [200],
      );
      return answer.ok ? ok(action, answer.value) : fail(answer);
    }
  }
}

/** The identity the service says is running, for a leader that did not pin one. */
async function observedOnboardingIdentity(
  s: Session,
): Promise<{ engineVersion: string; kitDigest: string } | null> {
  const answer = await settle<unknown>(
    s.api.p[':projectId'].onboarding.$get({ param: { projectId: s.projectId } }),
    [200],
  );
  if (!answer.ok) return null;
  const parsed = onboardingStatusSchema.safeParse(answer.value);
  return parsed.success ? parsed.data.observed : null;
}

export const projectConfigTool = defineTool({
  name: 'project_config',
  title: 'Project configuration',
  description:
    "Read and change THIS project's own configuration: its settings (agent, models, system prompt, review gate, base branch, worktree retention, memory limit), its registry entry (concurrency cap and tags), prompt templates, in-repo agent config files, workflows, skills, GitHub automations and worktrees. It also reads the shared settings as effective limits and capabilities (get_limits, get_capabilities, get_account) and CHANGES them with set_workspace_config — the shared limits, composer defaults, follow-up inbox and environment passthrough, skills auto-update and the machine-wide agent defaults, which apply to every project on this machine, and the two workspace folder paths — the folder the file picker may browse and the folder new checkouts land in, each checked for real before anything is saved. The shared presentation preferences change too: set_workspace_ui_state (appearance, notifications, task-table columns, dismissed provider incidents) and import_skills (the curated list of default skills). The colour theme is not among them — the browser stores that itself. Agent accounts, account identity, home files, the project registry and host folders are outside this boundary and are refused with the reason.",
  inputSchema: projectConfigInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async call(args, ctx: ProjectConfigContext) {
    if (args.projectId !== undefined) {
      return refused(
        args.action,
        'project-binding',
        `this connection is bound to project ${ctx.project.name} and acts on it alone; a project cannot be named.`,
      );
    }
    if (isRefused(args.action)) {
      const { boundary, reason } = REFUSED_ACTIONS[args.action];
      return refused(args.action, boundary, `${reason}${singleProjectNote(args.action)}`);
    }
    if (!ctx.service) {
      return errorResult('project_config is unavailable: this xezar service did not hand the tool its in-process entry.');
    }
    return run({ ...args, action: args.action }, { api: buildClient(ctx.service), projectId: ctx.project.id, root: ctx.project.root });
  },
});
