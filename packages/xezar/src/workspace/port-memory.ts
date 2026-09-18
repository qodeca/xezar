import { parsePortValue, PORT_MAX } from '../cli-settings.ts';
import { activeStateLayout } from '../state-layout.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig, type WorkspaceConfig } from './config.ts';
import {
  readProjectMachineState,
  recordLastListen,
} from './project-machine-state.ts';

/**
 * Per-project port memory (#467; `designs/cli-terminal/multi-instance.md` § 3–4).
 *
 * Two jobs, both small, both best-effort:
 *
 * 1. **Remember.** After `listen` really succeeded, write `projects[].lastListen` so the next
 *    plain `xez` in this repo comes back to the same address. Never before the bind, never
 *    the port that was ASKED for, and never for a `--port 0` start.
 * 2. **Skip.** When the start port came from memory or from the 4321 default, step over ports
 *    OTHER registered projects hold or remember. Without this, alpha stopped and beta started
 *    take 4321, alpha then finds it busy and moves to 4322, and the two swap ports on every
 *    restart — taking every saved bookmark with them.
 *
 * Nothing here may block a start. A missing, read-only or corrupt home costs one warning and
 * the cockpit carries on with the port it already holds (AC-04, `error-cases.txt` A11).
 */

/** A type alias rather than an interface on purpose: the registry entry it is written into is
 *  `.passthrough()`, so its `lastListen` carries an index signature, and only an alias of an
 *  object literal gets the implicit one TypeScript needs to accept the assignment. */
export type LastListen = {
  port: number;
  host: string;
  observedAt: string;
};

/**
 * The ports other projects have spoken for — their chosen `cli.port` and their remembered
 * `lastListen.port`. `selfId` is excluded: a project must never step over its own memory,
 * which is the value it is trying to return to.
 *
 * Port `0` is never reserved. It means "any", so it names no address to avoid.
 */
export function portsReservedByOtherProjects(
  config: Pick<WorkspaceConfig, 'projects'>,
  selfId: string | undefined,
): Set<number> {
  const reserved = new Set<number>();
  for (const project of config.projects) {
    if (selfId !== undefined && project.id === selfId) continue;
    for (const raw of [project.cli?.port, project.lastListen?.port]) {
      const port = parsePortValue(raw);
      if (port !== null && port > 0) reserved.add(port);
    }
  }
  return reserved;
}

/**
 * The first port at or after `from` that no other project holds. Used for the FIRST bind
 * attempt, so the skipping rule already applies to the port `startServer` is handed.
 *
 * Returns `from` unchanged when `reserved` is empty, and gives up at 65535 rather than
 * wrapping — running off the top of the range is the caller's "no free port" case
 * (`error-cases.txt` A7), not something to paper over by starting again at 1024.
 */
export function firstUnreservedPort(from: number, reserved: ReadonlySet<number>): number {
  let port = from;
  while (port <= PORT_MAX && reserved.has(port)) port += 1;
  return port;
}

/**
 * Persist `lastListen` for `projectId`. Call this ONLY after the server is really listening,
 * and with the port the server actually holds — the value the `address()` of a bound listener
 * reported, never the one that was requested (`remember-before-listen`, `false-ready`).
 *
 * Returns the entry that was written, or `null` when nothing could be written. Never throws:
 * a read-only home, a registry that has no row for this project, or a lock that could not be
 * taken all mean "the cockpit runs, it just will not remember" (`error-cases.txt` A11).
 *
 * In the PROJECT layout the hint goes to the per-machine working file instead of the committed
 * `<project>/.xezar/workspace.json` (#600 defect A) — the port is a fact about THIS machine's
 * clone, and writing it into the committed file left `git status` dirty after every start.
 * The hint still works across restarts, which is the whole point of it.
 */
export async function rememberLastListen(
  projectId: string,
  port: number,
  host: string,
  now: () => Date = () => new Date(),
): Promise<LastListen | null> {
  const entry: LastListen = { port, host, observedAt: now().toISOString() };
  if (activeStateLayout().mode === 'project') {
    try {
      recordLastListen(entry);
    } catch {
      return null;
    }
    return entry;
  }
  let written = false;
  try {
    await mergeWriteWorkspaceConfig((config) => {
      const project = config.projects.find((p) => p.id === projectId);
      if (!project) return;
      // Mutated in place so `.passthrough()` keys on the entry survive the round-trip.
      project.lastListen = entry;
      written = true;
    });
  } catch {
    return null;
  }
  return written ? entry : null;
}

/**
 * This project's stored CLI inputs, in the shape `resolveCliSettings` takes. Raw and
 * unvalidated on purpose: `cli-settings.ts` owns the vocabulary and owns the one warning a
 * bad stored value earns.
 *
 * An unreadable workspace answers "nothing stored" rather than failing — the caller is always
 * a start that has to keep going.
 */
export async function readStoredCliSettings(projectId: string | undefined): Promise<{
  workspace?: { output?: unknown; color?: unknown; logLevel?: unknown };
  projectPort?: unknown;
  rememberedPort?: unknown;
  config?: WorkspaceConfig;
}> {
  let config: WorkspaceConfig;
  try {
    config = await loadWorkspaceConfig();
  } catch {
    return {};
  }
  const project = projectId ? config.projects.find((p) => p.id === projectId) : undefined;
  // The remembered port is a per-machine fact, so in the project layout it comes from the
  // working file rather than the committed one (#600 defect A). `cli.port` — a preference a
  // person set — stays in the workspace config in both layouts.
  const rememberedPort = activeStateLayout().mode === 'project'
    ? readProjectMachineState().lastListen?.port
    : project?.lastListen?.port;
  return {
    config,
    ...(config.cli ? { workspace: config.cli } : {}),
    ...(project?.cli?.port !== undefined ? { projectPort: project.cli.port } : {}),
    ...(rememberedPort !== undefined ? { rememberedPort } : {}),
  };
}
