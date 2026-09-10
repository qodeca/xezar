import { z } from 'zod';

/**
 * Per-project MCP ownership (#99, decision D-02 in
 * `docs/features/mcp-server/mcp-d02-session-binding-decision.md` § 4).
 *
 * Exactly one logical MCP session owns a project. A second one is refused with the
 * *project-occupied* error, and an owner whose lease was lost or fenced is refused with the
 * *session-expired* error on every later call.
 *
 * Neither error is standard MCP. The MCP specification publishes no error registry and no
 * "project busy" code in the pages D-02 examined; both numbers are xezar's own, chosen inside the
 * JSON-RPC 2.0 range reserved for implementation-defined server errors (`-32000` to `-32099`) and
 * clear of every code the TypeScript SDK already claims. A future SDK release could still claim
 * them, which is why **`data.reason` is the authoritative discriminator, not `code`**.
 */

/** JSON-RPC `code` of the project-occupied error. Implementation-defined, not standard. */
export const MCP_PROJECT_OCCUPIED_CODE = -32080;
/** JSON-RPC `code` of the session-expired error. Implementation-defined, not standard. */
export const MCP_SESSION_EXPIRED_CODE = -32081;

/** The namespaced discriminators. A consumer branches on these, never on the number. */
export const MCP_PROJECT_OCCUPIED_REASON = 'com.qodeca.xezar/project-occupied';
export const MCP_SESSION_EXPIRED_REASON = 'com.qodeca.xezar/session-expired';

/**
 * The JSON-RPC `error` object a second logical client receives from `initialize` while the
 * project has a live owner. On Streamable HTTP it travels in a 200 response; on stdio it is the
 * ordinary JSON-RPC error response.
 *
 * `.strict()` at both levels is the N-01 guarantee made structural: the refusal carries the
 * project's own id, a human sentence and `retryable`, and NOTHING about the competing owner — no
 * session id, fencing token, pid, client name or version, and no "occupied since" timestamp. A
 * field added here is a field that can fingerprint another client, so adding one is a review
 * question, not a convenience.
 */
export const mcpProjectOccupiedErrorSchema = z
  .object({
    code: z.literal(MCP_PROJECT_OCCUPIED_CODE),
    message: z.string().min(1),
    data: z
      .object({
        reason: z.literal(MCP_PROJECT_OCCUPIED_REASON),
        projectId: z.string().min(1),
        retryable: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type McpProjectOccupiedError = z.infer<typeof mcpProjectOccupiedErrorSchema>;

/**
 * The JSON-RPC `error` object a fenced or expired owner receives on any later call. On Streamable
 * HTTP the transport answers 404 for that `MCP-Session-Id` instead, which every conforming client
 * already treats as "start a new session"; on stdio this error is sent and the server then closes
 * its output stream. Either way the exit is an automatic reconnect by the bridge — never the model
 * and never a person.
 */
export const mcpSessionExpiredErrorSchema = z
  .object({
    code: z.literal(MCP_SESSION_EXPIRED_CODE),
    message: z.string().min(1),
    data: z
      .object({
        reason: z.literal(MCP_SESSION_EXPIRED_REASON),
        projectId: z.string().min(1),
        retryable: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type McpSessionExpiredError = z.infer<typeof mcpSessionExpiredErrorSchema>;

/**
 * A project's occupancy as the cockpit renders it. Derived at READ time by the same classifier
 * acquisition runs — never a stored flag, because a dead owner's claim can sit on disk until the
 * next acquirer reaps it, and a stored flag would render "occupied" for a project nobody owns.
 *
 * - `unowned` — no claim, or none that is live. The resting state; nothing is blocked.
 * - `owned` — one live owner. A second client would be refused.
 * - `expired` — an owner's claim outlived its lease or its process. The next acquirer reclaims it.
 *
 * Deliberately no owner detail: the cockpit offers no control that changes this state (F-18 — no
 * manual disconnect, no forced takeover), so it needs nothing to act on.
 */
export const projectOwnerStateSchema = z.enum(['unowned', 'owned', 'expired']);
export type ProjectOwnerState = z.infer<typeof projectOwnerStateSchema>;
