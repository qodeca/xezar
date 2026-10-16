/**
 * The boot check for removed backends (#1046).
 *
 * xezar used to run pi and OpenCode. They are gone, and a saved value that still names one would
 * fail later, far from its cause: a task that cannot resume, a workflow step that cannot start, a
 * default that silently falls back. So `serve` and `run` look first, and refuse to start while any
 * saved setting or task record still names one. The answer lists every file and field, so the
 * person can fix them all in one pass.
 *
 * This is a stated exception to "degrade, never fail the boot" (AGENTS.md § Zero config,
 * BACKWARD_COMPATIBILITY.md § 8), and it is narrow on purpose:
 *
 * - READ-ONLY. It never writes, moves or rewrites a file. Changing a person's settings or history
 *   on their behalf is the one thing worse than refusing.
 * - No schema. The real loaders drop or default a value they do not know, which is exactly what
 *   would hide the old value; this reads the raw JSON or YAML and walks it.
 * - Missing or unreadable files are skipped: their own loaders already say what is wrong.
 *
 * What counts as a finding: a string `pi` or `opencode` under a key that names an agent
 * (`runner`, `backend`, `defaultRunner`, `provider`, `client`), and a `pi` or `opencode` key inside
 * a per-agent map (`models`, `defaultModels`, `selections`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { projectDataDir } from './project-data-paths.ts';
import { projectStateLayout, type StateLayout } from './state-layout.ts';
import { projectWorkflowsDir } from './workflows/load.ts';

/** The ids that no longer exist. */
export const REMOVED_BACKENDS: readonly string[] = ['pi', 'opencode'];

/** Keys whose string value names an agent. */
const AGENT_VALUE_KEYS = new Set(['runner', 'backend', 'defaultRunner', 'provider', 'client']);
/** Keys whose object value is a map keyed by agent. */
const AGENT_MAP_KEYS = new Set(['models', 'defaultModels', 'selections']);

export interface LegacyBackendFinding {
  /** The file, as given to the scan. */
  file: string;
  /** Where in the file, e.g. `runs[3].steps[0].backend` or `defaultModels.pi`. */
  field: string;
  /** The removed id it names. */
  value: string;
  /** `value` is the field's value, or (`key`) the field is a per-agent map key named after it. */
  kind: 'value' | 'key';
  /** The `id` of the outermost list item that holds the field (a task, an account), when it has one. */
  itemId?: string;
}

const isRemoved = (value: unknown): value is string =>
  typeof value === 'string' && REMOVED_BACKENDS.includes(value);

/** Every finding inside one parsed document, with JSONPath-like field names. */
export function findLegacyBackendValues(document: unknown, file: string): LegacyBackendFinding[] {
  const found: LegacyBackendFinding[] = [];
  const walk = (node: unknown, path: string, itemId: string | undefined): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        const id = item !== null && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
        walk(item, `${path}[${index}]`, itemId ?? (typeof id === 'string' && id !== '' ? id : undefined));
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const at = itemId === undefined ? {} : { itemId };
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const field = path === '' ? key : `${path}.${key}`;
      if (AGENT_VALUE_KEYS.has(key) && isRemoved(value)) found.push({ file, field, value, kind: 'value', ...at });
      if (AGENT_MAP_KEYS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const id of Object.keys(value)) {
          if (isRemoved(id)) found.push({ file, field: `${field}.${id}`, value: id, kind: 'key', ...at });
        }
      }
      walk(value, field, itemId);
    }
  };
  walk(document, '', undefined);
  return found;
}

function readDocument(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The files in one folder whose names match, sorted; none when the folder is absent. */
function filesIn(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The files one project keeps settings and task records in, resolved through the project's own
 * state layout (`projectStateLayout`): its config, workspace, UI and accounts files. Paths that do
 * not exist are fine.
 */
export function projectLegacyBackendFiles(projectRoot: string, dataDir: string = projectDataDir(projectRoot)): string[] {
  const layout = projectStateLayout(projectRoot);
  const files = [layout.configPath ?? '', layout.workspacePath, layout.uiStatePath, layout.accountsPath].filter((file) => file !== '');
  // Every JSON state file the project's data folder keeps at its top level and under `mcp/`
  // (`runs.json`, `automations.json`, `ui-state.json`, `todos.json`, the leader records, …), so a
  // state file added later is covered without a second list. Per-run event logs are not read.
  files.push(...filesIn(dataDir, /\.json$/i), ...filesIn(join(dataDir, 'mcp'), /\.json$/i));
  files.push(...filesIn(projectWorkflowsDir(projectRoot), /\.ya?ml$/i));
  return files;
}

/** Scan the files, read-only. Duplicated paths are read once. */
export function scanLegacyBackends(files: readonly string[]): LegacyBackendFinding[] {
  const found: LegacyBackendFinding[] = [];
  for (const file of new Set(files)) {
    if (!existsSync(file)) continue;
    const document = readDocument(file);
    if (document !== undefined) found.push(...findLegacyBackendValues(document, file));
  }
  return found;
}

/**
 * Every file a boot of `repoRoot` under `layout` reads settings or task records from: the layout's
 * own state files, the project's files, and — because one `serve` hosts them all — every project
 * the workspace registry names. The registry is read raw, so a row its schema would drop is still
 * scanned.
 */
export function bootLegacyBackendFiles(layout: StateLayout, repoRoot: string): string[] {
  const files = [layout.workspacePath, layout.accountsPath, layout.uiStatePath];
  if (layout.configPath !== null) files.push(layout.configPath);
  files.push(...projectLegacyBackendFiles(repoRoot, layout.dataDir ?? undefined));
  const registry = readDocument(layout.workspacePath);
  const projects = registry !== null && typeof registry === 'object' ? (registry as { projects?: unknown }).projects : undefined;
  if (Array.isArray(projects)) {
    for (const project of projects) {
      const root = project !== null && typeof project === 'object' ? (project as { root?: unknown }).root : undefined;
      if (typeof root === 'string' && root !== '' && root !== repoRoot) files.push(...projectLegacyBackendFiles(root));
    }
  }
  return files;
}

/** One finding as the message line says it: the field, what it holds, and the item it is in. */
function describe(finding: LegacyBackendFinding): string {
  const what = finding.kind === 'key' ? `${finding.field} (a "${finding.value}" entry)` : `${finding.field} = "${finding.value}"`;
  return finding.itemId === undefined ? what : `${what}, in the item with id "${finding.itemId}"`;
}

/** The refusal, as the lines `serve` and `run` print. */
export function legacyBackendMessage(findings: readonly LegacyBackendFinding[]): string {
  const files = new Set(findings.map((finding) => finding.file)).size;
  return [
    'xezar did not start: saved settings or task records still name an agent that xezar no longer runs (pi or OpenCode).',
    `Found ${findings.length} ${findings.length === 1 ? 'value' : 'values'} in ${files} ${files === 1 ? 'file' : 'files'}:`,
    ...findings.map((finding) => `  ${finding.file}: ${describe(finding)}`),
    'Fix: change each value to qwen, claude or codex, or remove it. Then start xezar again.',
    'xezar changed nothing. The xezar guide page "Moving from pi or OpenCode to Qwen Code" shows each step.',
  ].join('\n');
}
