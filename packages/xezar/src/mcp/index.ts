import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { runBridge, type ServiceTarget } from './bridge.ts';
import { mcpSocketLocation } from './ipc.ts';
import { listenMcpSocket, type McpServiceHandle } from './service.ts';
import { tools } from './tools/index.ts';

/**
 * The MCP module's public surface (#86, D-01). `packages/xezar/src/index.ts` imports
 * it LAZILY from both sides, so an ordinary `serve` that never meets an MCP client
 * pays nothing for it and cannot be broken by it (N-07).
 */

export { runBridge, HEALTH_TOOL, type BridgeOptions, type ServiceTarget } from './bridge.ts';
export { listenMcpSocket, type McpServiceHandle, type McpServiceOptions } from './service.ts';
export { mcpSocketLocation, IPC_PROTOCOL_VERSION } from './ipc.ts';
export { SUPPORTED_PROTOCOL_VERSIONS, SERVER_CAPABILITIES, negotiateProtocolVersion } from './protocol.ts';
export { defineTool, textResult, errorResult, type McpTool, type McpToolContext, type McpToolResult } from './tool.ts';

/**
 * Service side: open the socket for a registered project. Throws a one-line error
 * when it cannot; the cockpit turns that into one warning and keeps booting.
 */
export async function startMcpService(opts: { projectId: string; version: string }): Promise<McpServiceHandle> {
  const project = (await loadWorkspaceConfig()).projects.find((p) => p.id === opts.projectId);
  if (!project) throw new Error(`project ${opts.projectId} is not in the workspace registry`);
  return listenMcpSocket({
    project: { id: project.id, name: projectName(project), root: project.root },
    version: opts.version,
    tools,
  });
}

/**
 * `xez mcp` — spawned by an MCP client with the session's project as its working
 * directory (D-01 § 4). Serves MCP on stdio until the client closes stdin.
 */
export async function runMcpCommand(opts: { repoRoot: string; version: string }): Promise<void> {
  // stdout carries JSON-RPC and nothing else: one stray log line from any module
  // would corrupt the client's stream. Diagnostics go to stderr, which clients log.
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  await runBridge({
    input: process.stdin,
    output: process.stdout,
    version: opts.version,
    tools,
    resolveTarget: () => resolveMcpTarget(opts.repoRoot),
  });
}

/**
 * The cwd only FINDS the socket; it never becomes the authority (D-01 § 4). A read of
 * the registry: the bridge registers nothing, so a directory xezar has never served
 * finds no project and answers with how to fix that.
 */
export async function resolveMcpTarget(repoRoot: string): Promise<ServiceTarget> {
  const root = await realpath(repoRoot).catch(() => resolve(repoRoot));
  const project = (await loadWorkspaceConfig()).projects.find((p) => p.root === root);
  if (!project) {
    return {
      kind: 'unavailable',
      status: 'not-registered',
      message:
        'This directory is not a xezar project yet. Start the cockpit here once with `xez` (or `npx @qodeca/xezar`) so it is registered, then call this tool again.',
    };
  }
  const location = mcpSocketLocation(project);
  if (location.kind === 'unavailable') return { kind: 'unavailable', status: 'unsupported', message: location.reason };
  return { kind: 'socket', path: location.path, project: { id: project.id, name: projectName(project) } };
}

function projectName(project: { name: string; root: string }): string {
  return project.name || basename(project.root);
}
