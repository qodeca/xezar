import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureProjectDataIgnored } from '../project-data-paths.ts';

/**
 * D-04's connection descriptor (docs/features/mcp-server/mcp-d04-connection-file-decision.md):
 * `<project root>/.local/xezar/mcp-connection.json`, written by the running service so nobody
 * hand-authors connection data (F-14, A-01).
 *
 * The shape is D-04.2's with ONE deliberate omission: there is no `token`. D-04.5 put a token in
 * the file only because the transport was still open; D-01 then chose a per-project Unix socket
 * and made WHICH SOCKET the peer connected to the binding (D-01 § 6), so a token would be a
 * secret nothing checks. F-15 is simplest to keep with no secret in the file at all. `endpoint`
 * is D-01's socket, the one field the bridge could use; `project` and `service` are labels a
 * human reads (D-04.5: never the identity the server trusts).
 */

/** Additive changes keep version 1 (N-08); an incompatible one bumps it. */
export const MCP_CONNECTION_SCHEMA_VERSION = 1;

export const MCP_CONNECTION_FILE = 'mcp-connection.json';

export const mcpConnectionDescriptorSchema = z.object({
  schemaVersion: z.literal(MCP_CONNECTION_SCHEMA_VERSION),
  project: z.object({ id: z.string(), root: z.string(), dataDir: z.string() }),
  service: z.object({ pid: z.number().int().positive(), startedAt: z.string() }),
  endpoint: z.object({ socket: z.string() }),
});
export type McpConnectionDescriptor = z.infer<typeof mcpConnectionDescriptorSchema>;

export function mcpConnectionPath(dataDir: string): string {
  return join(dataDir, MCP_CONNECTION_FILE);
}

/**
 * Write the descriptor atomically (tmp + rename) at mode 0600, overwriting whatever a previous
 * service left: every field describes THIS process (D-04.3). The ignore file is ensured first, so
 * there is no moment the descriptor is visible to `git add -A` (D-04.4). Throws on failure — the
 * caller turns that into one warning (N-07).
 */
export function writeMcpConnectionFile(input: {
  project: { id: string; root: string };
  dataDir: string;
  socket: string;
  pid?: number;
  startedAt?: Date;
}): string {
  const descriptor: McpConnectionDescriptor = {
    schemaVersion: MCP_CONNECTION_SCHEMA_VERSION,
    project: { id: input.project.id, root: input.project.root, dataDir: input.dataDir },
    service: { pid: input.pid ?? process.pid, startedAt: (input.startedAt ?? new Date()).toISOString() },
    endpoint: { socket: input.socket },
  };
  ensureProjectDataIgnored(input.dataDir);
  mkdirSync(input.dataDir, { recursive: true });
  const path = mcpConnectionPath(input.dataDir);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // The mode is ignored when a stale tmp already existed; the rename carries the tmp's mode.
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the write's own error is the one worth reporting */
    }
    throw err;
  }
  return path;
}
