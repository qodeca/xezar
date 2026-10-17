/**
 * How a step's `allowedTools` / `bashAllowlist` reach Qwen Code (#1044), and the decision the
 * run's `PreToolUse` hook makes.
 *
 * Qwen Code's headless mode under `--approval-mode default` only offers the tools that need no
 * approval (reading, searching) plus what `--allowed-tools` names, and runs those without asking –
 * the same contract as Claude Code's `dontAsk` with `--allowedTools`. Two gaps remain, and the
 * hook closes them:
 *
 * - Qwen Code auto-approves a shell command it classifies as read-only, so
 *   `run_shell_command(git status)` still let `ls` run (measured on 0.25.2). A `bashAllowlist`
 *   therefore cannot be expressed as a Qwen permission rule; the hook applies the shared
 *   `read-only-lock.ts` decision instead, the one Codex already uses.
 * - A read-only step must not edit a file whatever a project's own settings allow. The runner
 *   removes the writers with `--exclude-tools`, and the hook refuses them again, so a project
 *   permission rule cannot bring them back.
 *
 * The hook is a plain program Qwen Code starts per tool call (`scripts/qwen-pre-tool-hook.mjs`,
 * bundled from `qwen-pre-tool-hook-entry.ts`). It reads the policy from
 * {@link QWEN_TOOL_POLICY_ENV}, which only the run's own environment carries, and fails closed
 * when that is missing or malformed.
 */

import { decideReadOnlyShellCall, isReadOnlyStep, normalizeBashAllowlist } from './read-only-lock.ts';

/** Internal child-only transport for the policy; underscores keep it out of host passthrough. */
export const QWEN_TOOL_POLICY_ENV = '__XEZAR_QWEN_TOOL_POLICY';

/** The text every refusal from xezar's hook starts with — how the mapper tells it from a tool error. */
export const QWEN_HOOK_REFUSAL_PREFIX = 'xezar refused this tool call:';

/** xezar's tool names (Claude Code's) → Qwen Code's built-in names (`ToolNames`, 0.25.2). */
const QWEN_TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write_file',
  NotebookEdit: 'notebook_edit',
  Bash: 'run_shell_command',
  Grep: 'grep_search',
  Glob: 'glob',
  LS: 'list_directory',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  Task: 'agent',
  Agent: 'agent',
  Skill: 'skill',
};

/** The Qwen tools that write files. Removed from, and refused on, a read-only step. */
export const QWEN_FILE_WRITERS = ['edit', 'write_file', 'notebook_edit'] as const;

/**
 * What a read-only step may still call: the reading, searching and planning tools. Anything not
 * listed — a writer, `exec` (code execution), cron, worktree, team and memory-writing tools, a
 * tool a later Qwen Code version adds — is refused on a read-only step, so the list fails closed
 * as Qwen Code grows. The shell is decided separately (`bash`), and MCP tools by name.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'zoom_image',
  'grep_search',
  'glob',
  'list_directory',
  'lsp',
  'web_fetch',
  'web_search',
  'todo_write',
  'search_memory',
  'skill',
  'agent',
  'tool_search',
  'read_mcp_resource',
  'ask_user_question',
  'enter_plan_mode',
  'exit_plan_mode',
  'get_goal',
  'structured_output',
  'list_agents',
]);

/** The shell tools: `run_shell_command`, and `exec` (runs code), which no allowlist can describe. */
const SHELL_TOOL = 'run_shell_command';
const CODE_TOOL = 'exec';
/** The deferred-tool bridge: `{ name, arguments }` calls another tool by name. */
const BRIDGE_TOOL = 'tool_call';

export interface QwenToolPolicy {
  readonly version: 1;
  /** A read-only step (`isReadOnlyStep`): only {@link READ_ONLY_TOOLS}, MCP tools and the shell. */
  readonly readOnly: boolean;
  /** The shell: off, any command, or only commands the shared lock accepts. */
  readonly bash: { readonly mode: 'off' } | { readonly mode: 'any' } | { readonly mode: 'allowlist'; readonly entries: readonly string[] };
  /** MCP tool names the step lists (`mcp__<server>__<tool>`), in every spelling Qwen may use. */
  readonly mcpTools: readonly string[];
  /** The shell the platform runs a command in; decides the shared lock's reading. */
  readonly dialect: 'posix' | 'powershell';
}

/** The policy for one step. `undefined` means the step needs no hook at all. */
export function qwenToolPolicy(
  allowedTools: readonly string[] | undefined,
  bashAllowlist: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): QwenToolPolicy | undefined {
  const tools = allowedTools ?? [];
  const readOnly = isReadOnlyStep(allowedTools);
  // No list grants no shell, as on Claude Code: `dontAsk` with no `--allowedTools` denies Bash.
  const bashListed = tools.includes('Bash');
  const entries = bashAllowlist === undefined ? undefined : normalizeBashAllowlist(bashAllowlist);
  const bash: QwenToolPolicy['bash'] = !bashListed
    ? { mode: 'off' }
    : entries === undefined
      ? { mode: 'any' }
      : { mode: 'allowlist', entries };
  // A writing step with an unrestricted shell has nothing for the hook to add: Qwen Code's own
  // offer list already matches `allowedTools`, and a hook per tool call would only cost time.
  if (!readOnly && bash.mode === 'any') return undefined;
  return {
    version: 1,
    readOnly,
    bash,
    mcpTools: mcpSpellings(tools),
    // Qwen Code runs a shell command through PowerShell on Windows; the PowerShell reading is the
    // stricter of the two, as for Codex (#963).
    dialect: platform === 'win32' ? 'powershell' : 'posix',
  };
}

/**
 * `--allowed-tools` for a step: each xezar name mapped to Qwen Code's, de-duplicated. `Bash` stays
 * `run_shell_command` with or without an allowlist – the hook narrows it – and an allowlist with
 * no usable entry drops the shell entirely, as Claude Code's `buildAllowedTools` does. On a
 * read-only step the writers are never listed, whatever `allowedTools` says.
 */
export function qwenAllowedTools(allowedTools: readonly string[], bashAllowlist?: readonly string[]): string[] {
  const readOnly = isReadOnlyStep(allowedTools);
  const out = new Set<string>();
  for (const tool of allowedTools) {
    if (tool === 'Bash' && bashAllowlist !== undefined) {
      // The second lock (#1067 review): one `run_shell_command(<entry>)` rule per entry, never the
      // bare name. Qwen Code lets a call through when the PreToolUse hook cannot run, and a bare
      // name allows every command; with only these rules, Qwen Code's own permission check refuses
      // a command no entry starts (each part of a compound command is checked). An entry holding
      // `(`, `)` or `*` is left out: it would not parse as a rule or would widen into a glob, and
      // the shared lock refuses every command such an entry could match anyway.
      for (const entry of normalizeBashAllowlist(bashAllowlist)) {
        if (!/[()*]/.test(entry)) out.add(`run_shell_command(${entry})`);
      }
      continue;
    }
    const name = QWEN_TOOL_NAMES[tool] ?? tool;
    if (readOnly && (QWEN_FILE_WRITERS as readonly string[]).includes(name)) continue;
    out.add(name);
  }
  return [...out];
}

export type QwenHookDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Decide one `PreToolUse` payload. The payload is untrusted input from Qwen Code; a shape this
 * function does not understand is refused, never allowed. Never throws.
 */
export function decideQwenPreToolUse(payload: unknown, policy: QwenToolPolicy | undefined, platform: NodeJS.Platform = process.platform): QwenHookDecision {
  if (!policy) return refuse('the run did not pass its tool policy to the hook, so every tool call is refused');
  const record = asRecord(payload);
  let name = typeof record?.tool_name === 'string' ? record.tool_name : undefined;
  let input = record?.tool_input;
  if (name === BRIDGE_TOOL) {
    // A deferred tool runs through the bridge; decide the tool it names, never the bridge itself.
    const bridged = asRecord(input);
    name = typeof bridged?.name === 'string' ? bridged.name : undefined;
    input = bridged?.arguments;
  }
  if (name === undefined) return refuse('the hook payload names no tool');

  if (name === SHELL_TOOL) {
    if (policy.bash.mode === 'off') return refuse('this step does not allow the shell (Bash is not in its allowed tools)');
    if (policy.bash.mode === 'any') return { allowed: true };
    const command = asRecord(input)?.command;
    const decision = decideReadOnlyShellCall({ toolName: 'Bash', command }, policy.bash.entries, policy.dialect, platform);
    return decision.allowed ? { allowed: true } : refuse(`${decision.reason.replace(/\.$/, '')}. Do not retry this command or a variant of it; report that it was refused.`);
  }
  if (name === CODE_TOOL) {
    if (policy.bash.mode !== 'any' || policy.readOnly) return refuse('this step does not allow running code (the exec tool)');
    return { allowed: true };
  }
  if (!policy.readOnly) return { allowed: true };
  // Before the MCP names: a bare MCP spelling must never re-admit a built-in writer.
  if ((QWEN_FILE_WRITERS as readonly string[]).includes(name)) {
    return refuse(`this is a read-only step, so ${name} is not available. Do not retry; report what you would have changed.`);
  }
  if (READ_ONLY_TOOLS.has(name) || policy.mcpTools.includes(name)) return { allowed: true };
  return refuse(`this is a read-only step, and ${name} is not one of the reading tools it may use`);
}

/** The PreToolUse answer Qwen Code reads from the hook's stdout. No output means "allow". */
export function qwenHookOutput(decision: QwenHookDecision): Record<string, unknown> | undefined {
  if (decision.allowed) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
}

/** Parse the policy env value. `undefined` for anything that is not a version-1 policy. */
export function parseQwenToolPolicy(encoded: string | undefined): QwenToolPolicy | undefined {
  if (encoded === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  if (!record || record.version !== 1 || typeof record.readOnly !== 'boolean') return undefined;
  const bash = asRecord(record.bash);
  const dialect = record.dialect === 'powershell' ? 'powershell' : record.dialect === 'posix' ? 'posix' : undefined;
  if (!bash || dialect === undefined || !isStringArray(record.mcpTools)) return undefined;
  let parsedBash: QwenToolPolicy['bash'];
  if (bash.mode === 'off' || bash.mode === 'any') parsedBash = { mode: bash.mode };
  else if (bash.mode === 'allowlist' && isStringArray(bash.entries)) parsedBash = { mode: 'allowlist', entries: bash.entries };
  else return undefined;
  return { version: 1, readOnly: record.readOnly, bash: parsedBash, mcpTools: record.mcpTools, dialect };
}

/**
 * Every name an `mcp__<server>__<tool>` entry may reach the hook under. Qwen Code registers an
 * MCP tool under its bare name and switches to `<server>__<tool>` only on a name collision, so
 * all three spellings are accepted for a tool the step names.
 */
function mcpSpellings(tools: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tool of tools) {
    const match = /^mcp__(.+?)__(.+)$/.exec(tool);
    if (!match) continue;
    const [, server, name] = match as unknown as [string, string, string];
    out.add(tool).add(`${server}__${name}`).add(name);
  }
  return [...out].sort();
}

function refuse(reason: string): QwenHookDecision {
  return { allowed: false, reason: `${QWEN_HOOK_REFUSAL_PREFIX} ${reason}` };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
