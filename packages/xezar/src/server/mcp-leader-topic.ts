import type { McpLeaderStatus, McpLeaderTopic } from '@qodeca/xezar-contract';
import type { TopicPublisher } from './ws.ts';

/**
 * The `mcp-leader` topic on the WebSocket bus (#374, round 5 on #403, review major 2): the leader
 * status Settings → MCP connection shows, live. It used to be read on mount, on Refresh and on focus
 * only, so a page left open kept saying "Codex connected" after the daemon, the owner or the approval
 * state changed.
 *
 * Demand-driven like `health`: nothing runs until a cockpit holds the topic (the hub calls `start` at
 * 0→1 and its stop at 1→0). While it is held, an announcement from the delivery path
 * (`watchProjectLeaders`: attach, stop, a refusal, an owner opening, announcing itself or closing, a
 * delivery attempt, a reaction, a service starting or stopping) re-derives the status at once, and a
 * re-derive every `recheckMs` is the backstop for a change nothing announces — an app-server daemon
 * that went away between two hand-offs is only seen when the adapter next looks. Either way a frame is
 * published ONLY when the payload changed.
 *
 * The payload is `GET /api/v1/mcp/leader`'s answer for each project, from the same `status` function
 * the route calls, so the two never disagree: every project whose MCP service is running, plus any
 * project whose service stopped while the topic was held (as the route's `available: false` answer),
 * so a page that is open sees its service go. It names clients, cursors and the server's own blocker
 * words; no filesystem path, home or session id (an OpenCode blocker can repeat the address the person
 * typed). The topic keeps the hub's default trust: only the cockpit's own connection may read it.
 */

/** The backstop cadence — the same 5 s the `health` topic re-reads on. */
export const MCP_LEADER_RECHECK_MS = 5_000;

export interface McpLeaderTopicDeps {
  /** Every project whose MCP service is running now. */
  readonly ids: () => readonly string[];
  /** One project's answer, exactly as `GET /mcp/leader` gives it. */
  readonly status: (projectId: string) => McpLeaderStatus;
  /** Hear the delivery path's announcements until the returned stop runs. */
  readonly watch: (listener: (projectId: string) => void) => () => void;
  readonly recheckMs?: number;
}

export function mcpLeaderTopic(deps: McpLeaderTopicDeps): TopicPublisher {
  // Sorted, so two derivations of the same state serialize identically and "changed" means changed.
  const payload = (ids: Iterable<string>): McpLeaderTopic => {
    const projects: Record<string, McpLeaderStatus> = {};
    for (const id of [...new Set(ids)].sort()) projects[id] = deps.status(id);
    return { projects };
  };

  return {
    snapshot: async () => payload(deps.ids()),
    start(publish) {
      const held = new Set(deps.ids());
      let last = JSON.stringify(payload(held));
      let running = true;
      let queued = false;
      const recheck = (): void => {
        queued = false;
        if (!running) return;
        for (const id of deps.ids()) held.add(id);
        const next = payload(held);
        const body = JSON.stringify(next);
        if (body === last) return;
        last = body;
        publish(next);
      };
      // Announcements come from inside the delivery path, often several for one change (an attach
      // announces the refusal it replaced and the wake it caused): coalesce them into one re-derive,
      // after the caller's own work has finished.
      const unwatch = deps.watch((projectId) => {
        held.add(projectId);
        if (queued) return;
        queued = true;
        queueMicrotask(recheck);
      });
      const timer = setInterval(recheck, deps.recheckMs ?? MCP_LEADER_RECHECK_MS);
      timer.unref?.();
      return () => {
        running = false;
        unwatch();
        clearInterval(timer);
      };
    },
  };
}
