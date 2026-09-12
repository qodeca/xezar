import type { McpLeaderActionInput, McpLeaderStatus } from '@qodeca/xezar-contract';

/**
 * The per-project lookup `GET/POST /api/v1/mcp/leader` uses to reach the push-delivery path (#309).
 * A route knows only its project, while the delivery path lives inside the MCP composition
 * (`startMcpService`); this map joins the two, keyed by registry project id — the same shape as
 * `project-catalogs.ts`, and for the same reason it imports types only: `server.ts` imports it
 * statically, and the MCP module otherwise stays a lazy import (N-07).
 */

export type LeaderActResult = { ok: true; status: McpLeaderStatus } | { ok: false; error: string };

export interface ProjectLeaderPort {
  status(): McpLeaderStatus;
  act(input: McpLeaderActionInput): Promise<LeaderActResult>;
}

const leaders = new Map<string, ProjectLeaderPort>();

/**
 * Make `port` the project's delivery path until the returned release runs. The release removes only
 * this registration, so a late release from an older composition never evicts a newer one.
 */
export function registerProjectLeader(projectId: string, port: ProjectLeaderPort): () => void {
  leaders.set(projectId, port);
  return () => {
    if (leaders.get(projectId) === port) leaders.delete(projectId);
  };
}

/** The project's delivery path, when its MCP service is running. */
export function projectLeader(projectId: string): ProjectLeaderPort | undefined {
  return leaders.get(projectId);
}
