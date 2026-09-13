import type { McpLeaderActionInput, McpLeaderStatus } from '@qodeca/xezar-contract';

/**
 * The per-project lookup `GET/POST /api/v1/mcp/leader` uses to reach the push-delivery path (#309).
 * A route knows only its project, while the delivery path lives inside the MCP composition
 * (`startMcpService`); this map joins the two, keyed by registry project id — the same shape as
 * `project-catalogs.ts`, and for the same reason it imports types only: `server.ts` imports it
 * statically, and the MCP module otherwise stays a lazy import (N-07).
 *
 * It also carries the announcements the cockpit's `mcp-leader` topic re-derives on (#374, round 5 on
 * #403): a registration, its release, and every change the delivery path reports through
 * `projectLeaderChanged`. An announcement says only WHICH project may have changed; the topic reads
 * the status itself, through the same `status()` the GET calls.
 */

export type LeaderActResult = { ok: true; status: McpLeaderStatus } | { ok: false; error: string };

export interface ProjectLeaderPort {
  status(): McpLeaderStatus;
  act(input: McpLeaderActionInput): Promise<LeaderActResult>;
}

const leaders = new Map<string, ProjectLeaderPort>();
const watchers = new Set<(projectId: string) => void>();

/**
 * Make `port` the project's delivery path until the returned release runs. The release removes only
 * this registration, so a late release from an older composition never evicts a newer one.
 */
export function registerProjectLeader(projectId: string, port: ProjectLeaderPort): () => void {
  leaders.set(projectId, port);
  projectLeaderChanged(projectId);
  return () => {
    if (leaders.get(projectId) !== port) return;
    leaders.delete(projectId);
    projectLeaderChanged(projectId);
  };
}

/** The project's delivery path, when its MCP service is running. */
export function projectLeader(projectId: string): ProjectLeaderPort | undefined {
  return leaders.get(projectId);
}

/** Every project whose MCP service is running now. */
export function projectLeaderIds(): string[] {
  return [...leaders.keys()];
}

/**
 * `projectId`'s leader status may have changed. Never throws into the caller: it is called from the
 * delivery path, and a broken watcher must not reach the transport or the other watchers.
 */
export function projectLeaderChanged(projectId: string): void {
  for (const watcher of [...watchers]) {
    try {
      watcher(projectId);
    } catch {
      // A watcher's own failure is its own; the next announcement or its backstop re-reads.
    }
  }
}

/** Hear every announcement until the returned stop runs. */
export function watchProjectLeaders(watcher: (projectId: string) => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}
