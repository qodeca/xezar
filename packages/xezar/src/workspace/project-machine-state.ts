import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeStateLayout, type StateLayout } from '../state-layout.ts';
import { atomicWriteJsonSync } from './config.ts';

/**
 * The per-machine facts of a single-project root (#600 defect A).
 *
 * In the PROJECT layout `<project>/.xezar/workspace.json` is the file the guide
 * tells users to COMMIT, so it must hold only what a teammate should inherit:
 * the folder's identity, the settings someone chose. Facts that describe THIS
 * MACHINE — when this clone was last opened here, which port this clone's
 * cockpit last held here — were written into that same file by every launch,
 * which left `git status` dirty after every start and turned the file into a
 * conflict between teammates.
 *
 * So they live here instead, beside the other working files the layout already
 * puts under `<project>/.local/xezar` (`dataDir`), which is gitignored by the
 * blanket `.local/.gitignore` and never committed. Two facts, one file:
 *
 * - `lastOpenedAt` — the boot registration stamp. Read by `listProjects` (so
 *   Settings → General's "Last opened" and the MCP's `project_facts` keep a real
 *   answer instead of the process start time) and, in the cockpit, by the
 *   project switcher's ordering (`project-groups.tsx`, `command-palette.tsx`),
 *   which has one row to order in this mode.
 * - `lastListen` — the port hint (#467). Read by `readStoredCliSettings`, so a
 *   plain `xez` in this folder comes back to the same port across restarts.
 *
 * The GLOBAL layout never touches this file: `projectMachineStatePath` answers
 * `null` there, every reader answers "nothing recorded", and every writer is a
 * no-op. The default path keeps writing both facts into `~/.xezar/config.json`,
 * byte for byte as before — `projects.test.ts` pins that as a control.
 *
 * Best-effort by construction: a missing, unreadable or corrupt file answers
 * "nothing recorded" (never throws), and `registerProject` treats a failed
 * write as "this launch will not remember" rather than a failed boot, which is
 * the same contract the port memory has always had.
 */

/** The one file, under the project layout's `dataDir`. */
const MACHINE_STATE_FILE = 'machine-state.json';

/**
 * The address hint (#467), structurally the registry's `lastListen`.
 *
 * A type alias rather than an interface on purpose, the same reason
 * `port-memory.ts` spells its `LastListen` this way: the row it is overlaid
 * onto is the registry's `.passthrough()` entry, whose `lastListen` carries an
 * index signature, and only an alias of an object literal gets the implicit
 * one TypeScript needs to accept the assignment.
 */
export type MachineLastListen = {
  port: number;
  host: string;
  observedAt: string;
};

export interface ProjectMachineState {
  lastOpenedAt?: string;
  lastListen?: MachineLastListen;
}

/**
 * Where the facts live, or `null` in the global layout — where there is no
 * single project to describe and the per-user config is already the right home.
 */
export function projectMachineStatePath(layout: StateLayout = activeStateLayout()): string | null {
  if (layout.mode !== 'project' || layout.dataDir === null) return null;
  return join(layout.dataDir, MACHINE_STATE_FILE);
}

/** The recorded facts, or `{}` when there is no file, no layout, or no readable JSON object. */
export function readProjectMachineState(layout: StateLayout = activeStateLayout()): ProjectMachineState {
  const path = projectMachineStatePath(layout);
  if (path === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const state: ProjectMachineState = {};
  if (typeof record.lastOpenedAt === 'string' && record.lastOpenedAt !== '') {
    state.lastOpenedAt = record.lastOpenedAt;
  }
  const listen = record.lastListen;
  if (listen !== null && typeof listen === 'object' && !Array.isArray(listen)) {
    const { port, host, observedAt } = listen as Record<string, unknown>;
    if (typeof port === 'number') {
      state.lastListen = {
        port,
        host: typeof host === 'string' ? host : '',
        observedAt: typeof observedAt === 'string' ? observedAt : '',
      };
    }
  }
  return state;
}

/** Write the facts. Throws on write failure — best-effort is the caller's policy. */
export function writeProjectMachineState(
  state: ProjectMachineState,
  layout: StateLayout = activeStateLayout(),
): void {
  const path = projectMachineStatePath(layout);
  if (path === null) return;
  atomicWriteJsonSync(path, state);
}

/** Record the launch stamp, keeping whatever else the file holds. */
export function recordProjectOpened(
  openedAt: string,
  layout: StateLayout = activeStateLayout(),
): void {
  const state = readProjectMachineState(layout);
  state.lastOpenedAt = openedAt;
  writeProjectMachineState(state, layout);
}

/** Record the bound address, keeping whatever else the file holds. */
export function recordLastListen(
  entry: MachineLastListen,
  layout: StateLayout = activeStateLayout(),
): void {
  const state = readProjectMachineState(layout);
  state.lastListen = entry;
  writeProjectMachineState(state, layout);
}
