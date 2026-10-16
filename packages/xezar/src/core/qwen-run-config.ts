/**
 * The run-scoped Qwen Code configuration for one xezar run (#1044): what xezar adds without
 * touching any file the person owns.
 *
 * Qwen Code reads a "system" settings file with the highest precedence, and lets
 * `QWEN_CODE_SYSTEM_SETTINGS_PATH` move it. xezar points that variable at a private per-run file
 * that carries the machine's own system settings forward and adds:
 *
 * - `tools.todoWrite.enabled: true` — Qwen Code ships its plan tool off; a run's plan is a parity
 *   capability (`plan.updated`, AGENT_PROTOCOL.md § 6);
 * - the `PreToolUse` hook, when the step's tool policy needs one (`qwen-tool-policy.ts`), with
 *   `disableAllHooks: false` so a person's own setting cannot switch the lock off;
 * - `advanced.excludedEnvVars`: the NAMES of the keys in every project `.env` file Qwen Code
 *   would load (#1041: xezar never auto-loads `.env`). Only names are kept, never values.
 *
 * A project `.qwen/.env` cannot be excluded that way: Qwen Code applies a `.qwen/.env` key even
 * when the name is excluded (`canApplyParsedEnvKey`, 0.25.2). A run whose folder chain holds one
 * is therefore refused with the file named and the fix, rather than started with values xezar
 * promised not to load. The person's own `~/.qwen/.env` stays: it is where Qwen Code keeps model
 * keys, and it is the person's home, not the project's.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseJsonc } from './qwen-settings.ts';
import { writeMcpOverlay, type McpOverlayFile } from './run-mcp-isolation.ts';
import type { QwenToolPolicy } from './qwen-tool-policy.ts';

/** The env var Qwen Code reads its system settings path from. */
export const QWEN_SYSTEM_SETTINGS_ENV = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';

/** Qwen Code's own default excluded names (`DEFAULT_EXCLUDED_ENV_VARS`), kept when xezar adds its own. */
const QWEN_DEFAULT_EXCLUDED_ENV_VARS = ['DEBUG', 'DEBUG_MODE'] as const;

/** Where Qwen Code looks for system settings when the variable is unset (0.25.2). */
export function qwenDefaultSystemSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return join('/Library', 'Application Support', 'QwenCode', 'settings.json');
  if (platform === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  return join('/etc', 'qwen-code', 'settings.json');
}

export interface QwenEnvScan {
  /** Every key name in the project `.env` Qwen Code would load, sorted. */
  readonly excludedNames: readonly string[];
  /** A project `.qwen/.env` Qwen Code would load, which cannot be excluded: the run refuses to start. */
  readonly unblockable: readonly string[];
}

/**
 * The project `.env` file Qwen Code would load for a run in `cwd`, mirroring its `findEnvFiles`
 * (0.25.2): walk from the real `cwd` up, stop at the home folder (the person's own files), and in
 * each folder take `.qwen/.env`, else `.env` — the FIRST one found ends the walk. A linked
 * worktree sits inside the repository, so for a task the walk normally ends at the repository
 * root's `.env`, which is exactly the file this exists for.
 */
export function scanQwenProjectEnv(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string | undefined = readIfPresent,
): QwenEnvScan {
  // Compared as a real path, like `dir`: a home reached through a link (`/home` -> `/var/home`)
  // would otherwise never match, and the person's own `~/.qwen/.env` would read as a project file.
  const home = realDir(resolve(env.HOME || env.USERPROFILE || homedir()));
  let dir = realDir(cwd);
  for (;;) {
    if (dir === home) return { excludedNames: [], unblockable: [] };
    const scoped = join(dir, '.qwen', '.env');
    if (readFile(scoped) !== undefined) return { excludedNames: [], unblockable: [scoped] };
    const plain = readFile(join(dir, '.env'));
    if (plain !== undefined) return { excludedNames: [...new Set(dotenvNames(plain))].sort(), unblockable: [] };
    const parent = dirname(dir);
    if (parent === dir) return { excludedNames: [], unblockable: [] };
    dir = parent;
  }
}

/** The refusal for a run whose folders hold a project `.qwen/.env`. */
export function qwenUnblockableEnvMessage(files: readonly string[]): string {
  return `Qwen Code would load ${files.join(', ')} into this run, and xezar cannot stop it: Qwen Code applies a project's .qwen/.env even to names xezar excludes, and xezar never loads a project .env file into an agent. Move what the file holds to your own Qwen home (~/.qwen/.env) or remove it, then start the task again.`;
}

/** The key names of a dotenv file: `NAME=…` and `export NAME=…`. Values are never kept. */
export function dotenvNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

export interface QwenSystemSettingsInput {
  /** The machine's own system settings path (the variable, else the platform default). */
  readonly basePath: string;
  readonly excludedEnvNames: readonly string[];
  /** The hook command, when the step's policy needs one. */
  readonly hookCommand?: string;
  /** The person opted in to Qwen Code's usage statistics (`XEZ_QWEN_USAGE_STATISTICS`). */
  readonly usageStatistics?: boolean;
}

/**
 * The run's system settings: the machine's own file carried forward, xezar's keys on top. A base
 * file that does not parse is dropped with a note rather than stopping the run; its keys are
 * the machine owner's, and the run still gets xezar's.
 */
export function qwenSystemSettings(
  input: QwenSystemSettingsInput,
  readFile: (path: string) => string | undefined = readIfPresent,
): { settings: Record<string, unknown>; note?: string } {
  const text = readFile(input.basePath);
  const base = text === undefined ? {} : parseJsonc(text);
  const note = text !== undefined && base === undefined
    ? `qwen: could not read the system settings file ${input.basePath}; this run starts without it`
    : undefined;
  const settings: Record<string, unknown> = { ...(base ?? {}) };

  const tools = asRecord(settings.tools) ?? {};
  settings.tools = { ...tools, todoWrite: { ...asRecord(tools.todoWrite), enabled: true } };

  // Managed auto-memory and auto-dream off (#1042, owner decision): Qwen Code keys that memory by
  // folder, and every task runs in a new worktree, so it only left one more model call at the end
  // of each turn and a memory folder per task in the person's Qwen home. Their own sessions keep it.
  const memory = asRecord(settings.memory) ?? {};
  settings.memory = { ...memory, enableManagedAutoMemory: false, enableManagedAutoDream: false };

  // Usage statistics off unless the person opted in (#1041 decision 8). Qwen Code 0.25.2 reads
  // `QWEN_USAGE_STATISTICS_ENABLED` first, which the runner sets; the setting is the same answer
  // for any reader that consults the settings alone.
  if (input.usageStatistics !== true) {
    settings.privacy = { ...asRecord(settings.privacy), usageStatisticsEnabled: false };
  }

  const advanced = asRecord(settings.advanced) ?? {};
  const excluded = new Set<string>([
    ...QWEN_DEFAULT_EXCLUDED_ENV_VARS,
    ...stringList(advanced.excludedEnvVars),
    ...input.excludedEnvNames,
  ]);
  settings.advanced = { ...advanced, excludedEnvVars: [...excluded].sort() };

  if (input.hookCommand !== undefined) {
    const hooks = asRecord(settings.hooks) ?? {};
    const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
    settings.hooks = {
      ...hooks,
      PreToolUse: [...pre, { matcher: '*', hooks: [{ type: 'command', command: input.hookCommand }] }],
    };
    settings.disableAllHooks = false;
  }
  return note ? { settings, note } : { settings };
}

/**
 * The shell command Qwen Code runs for the hook: Node itself on the bundled program, both quoted.
 * `undefined` when a path holds a double quote, which no quoting here could carry safely.
 */
export function qwenHookCommand(nodePath: string, hookPath: string): string | undefined {
  if (nodePath.includes('"') || hookPath.includes('"')) return undefined;
  return `"${nodePath}" "${hookPath}"`;
}

/** The env the policy and the settings file reach Qwen Code through. */
export function qwenRunEnv(settingsPath: string, policy: QwenToolPolicy | undefined, policyEnv: string): Record<string, string> {
  return {
    [QWEN_SYSTEM_SETTINGS_ENV]: settingsPath,
    ...(policy ? { [policyEnv]: JSON.stringify(policy) } : {}),
  };
}

/** Write the run's settings file privately (mode 0600, own temp folder). Null when it cannot. */
export function writeQwenSystemSettings(settings: Record<string, unknown>): McpOverlayFile | null {
  return writeMcpOverlay('settings.json', settings);
}

function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
