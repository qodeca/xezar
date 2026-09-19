import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { activeStateLayout, type StateLayout } from '../state-layout.ts';
import { atomicWriteJsonSync } from './config.ts';
import { withWorkspaceConfigLock } from './config-lock.ts';

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
 * the same contract the port memory has always had. The fail-open read is what
 * keeps a DISPLAY fact from failing a boot: the value of this file is that the
 * cockpit remembers where it was, and nothing here is worth refusing to start
 * over.
 *
 * The read-modify-write is the one thing the file shares with
 * `~/.xezar/config.json` (and, in the project layout, with the committed
 * `workspace.json`): two xezar instances may start at the same moment, and
 * without a lock both re-read the same bytes and the later rename drops the
 * earlier fact (#649). So both writers go through the same bounded,
 * fail-open cross-process lock the registry merge already uses, and through
 * the same atomic tmp+rename write.
 */

/** The one file, under the project layout's `dataDir`. */
const MACHINE_STATE_FILE = 'machine-state.json';

/**
 * The address hint (#467), structurally the registry's `lastListen`.
 *
 * A zod schema whose type is inferred, rather than a hand-written interface, for
 * the same reason `config.ts` infers `WorkspaceProject`: one definition, and
 * `.passthrough()` at the object level so a key a newer xezar wrote survives a
 * round-trip through an older one. The inferred type is still an alias of an
 * object literal, which is what gives it the implicit index signature
 * `port-memory.ts` needs to assign its own `LastListen` here.
 *
 * `port` is required and must be a number — a `lastListen` without one names no
 * address, so the whole hint degrades to absent, exactly as the hand-rolled
 * parse did. `host` and `observedAt` degrade per-key to `''`, which is what the
 * old parse produced for a missing or non-string value.
 */
export const machineLastListenSchema = z
  .object({
    port: z.number(),
    host: z.string().catch(''),
    observedAt: z.string().catch(''),
  })
  .passthrough();

export type MachineLastListen = z.infer<typeof machineLastListenSchema>;

/**
 * The recorded facts.
 *
 * Mirrors `workspaceProjectSchema` (`config.ts`): per-field `.catch`, bounds on
 * the strings, `.passthrough()` at the object level. Two deliberate
 * differences, both to keep the file's documented "absent means nothing
 * recorded" contract rather than the registry's "always materialize the field"
 * one:
 *
 * - The fallback is `undefined`, not `''`. `projects.ts` reads
 *   `machine.addedAt ?? DERIVED_AT` and overlays `lastOpenedAt` only when it is
 *   not `undefined`, so an `''` sentinel would be written into the derived row
 *   as an empty timestamp. `''` and a missing key both mean "nothing recorded"
 *   here, and both resolve to `undefined`.
 * - `.min(1)` drops an empty string as well as an over-long one. The old parse
 *   kept a non-empty string of any length and dropped everything else.
 *
 * The bound is the behaviour change the fix carries: a hand-edited
 * `lastOpenedAt` longer than 64 characters is DROPPED on the next read, where
 * the old parse kept it. xezar's own stamps are ISO strings (~24 characters),
 * so only a hand-edited value is affected, and dropping it is what the
 * registry already does for the same field. Truncating instead would persist a
 * half-timestamp that parses as nothing.
 */
export const projectMachineStateSchema = z
  .object({
    addedAt: z.string().min(1).max(64).optional().catch(undefined),
    lastOpenedAt: z.string().min(1).max(64).optional().catch(undefined),
    lastListen: machineLastListenSchema.optional().catch(undefined),
  })
  .passthrough();

export type ProjectMachineState = z.infer<typeof projectMachineStateSchema>;

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
  return readProjectMachineStateAt(path);
}

/**
 * The path-based read, so the read-modify-write below reads the SAME path the
 * lock was taken on even if `activeStateLayout()` moves mid-flight — the same
 * one-resolution rule `mergeWriteWorkspaceConfig` follows.
 *
 * Never throws: an unreadable file, unparseable JSON, a JSON scalar/array, or a
 * file zod cannot make sense of all answer `{}`.
 */
function readProjectMachineStateAt(path: string): ProjectMachineState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  // The top-level salvage: only a JSON object is a state file. A scalar or an
  // array is not one, and zod would otherwise have to say so for every key.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = projectMachineStateSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

/**
 * Read-modify-write under the bounded cross-process lock (`config-lock.ts`),
 * then the shared atomic tmp+rename write.
 *
 * The lock is deliberately NOT a correctness barrier: a lock held past its
 * bound, or a directory that cannot hold one, degrades to exactly the unlocked
 * behaviour with one warning, because a start that cannot remember a display
 * fact must never be blocked. It closes the LOST UPDATE that re-reading
 * immediately before writing only narrows: without it, two writers that read
 * the same bytes both rename, and one fact disappears.
 */
async function mergeWriteProjectMachineState(
  path: string,
  mutator: (state: ProjectMachineState) => void,
): Promise<void> {
  await withWorkspaceConfigLock(path, async () => {
    const state = readProjectMachineStateAt(path);
    mutator(state);
    atomicWriteJsonSync(path, state);
  });
}

/**
 * Record the launch stamp, keeping whatever else the file holds. The FIRST
 * launch in this folder also records `addedAt` — and never overwrites it on a
 * later one — so the mode's derived row has a stable "Added" value across
 * starts (#600 review m1).
 */
export async function recordProjectOpened(
  openedAt: string,
  layout: StateLayout = activeStateLayout(),
): Promise<void> {
  const path = projectMachineStatePath(layout);
  if (path === null) return;
  await mergeWriteProjectMachineState(path, (state) => {
    if (state.addedAt === undefined) state.addedAt = openedAt;
    state.lastOpenedAt = openedAt;
  });
}

/** Record the bound address, keeping whatever else the file holds. */
export async function recordLastListen(
  entry: MachineLastListen,
  layout: StateLayout = activeStateLayout(),
): Promise<void> {
  const path = projectMachineStatePath(layout);
  if (path === null) return;
  await mergeWriteProjectMachineState(path, (state) => {
    state.lastListen = entry;
  });
}

/**
 * The last failed-write message this process printed, if any.
 *
 * `registerProject` is called once per launch, but a boot that resolves several
 * roots — the MCP door, a scoped request, the cockpit's own probe — may reach it
 * more than once, and a read-only `.local` would otherwise print the same line
 * several times. Only the WARNING is remembered; every call still attempts the
 * write, so nothing here can serve a stale fact.
 *
 * ONE flag for the process lifetime, deliberately coarser than `warnOncePerState`
 * (`config.ts`), which is a Map keyed by path and re-warns when the failure
 * changes: once any failure has warned here, a later and different persistent
 * failure is silent. This file describes one folder per boot, so one flag is the
 * intended granularity, not a copy of that helper.
 */
let warnedWriteFailure = false;

/** Test hook: the warning is once per process, so a suite must be able to re-arm it. */
export function resetProjectMachineStateWriteWarning(): void {
  warnedWriteFailure = false;
}

/**
 * Report a launch that could not be recorded — ONCE per process, and never as a
 * failure. The write is best-effort by contract (`projects.ts`): a read-only
 * `.local`, a missing folder or a lock that could not be taken means "this
 * launch will not remember", which is not a reason to refuse to start.
 */
export function warnProjectMachineStateWriteFailure(path: string | null, error: unknown): void {
  if (warnedWriteFailure) return;
  warnedWriteFailure = true;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[xez] could not record this launch in ${path ?? 'the project machine state'} — ` +
      `the launch works anyway (${detail})`,
  );
}
