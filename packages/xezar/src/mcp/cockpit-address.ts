import type { McpDiscoveryCockpit } from '@qodeca/xezar-contract';
import { resolveCapabilities } from '../server/capabilities.ts';
import { ownCockpitOrigin } from '../server/instance-liveness.ts';

/**
 * `--bind-host` of THIS process. The MCP socket lives inside `xezar serve`, and a non-loopback
 * bind is half of what makes the cockpit hosted; `McpToolContext` does not carry it yet (#89
 * widens that context), and reporting `localHandoff: true` on a hosted box would promise actions
 * the routes refuse.
 */
export function bindHostFromArgv(argv: readonly string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--bind-host') return argv[i + 1];
    if (arg.startsWith('--bind-host=')) return arg.slice('--bind-host='.length);
  }
  return undefined;
}

/**
 * Whether THIS process can hand off to the host's desktop right now: the same `resolveCapabilities`
 * answer `discover_project` reports, read per call because `XEZ_REMOTE` may change while the server
 * runs. The `--bind-host` half comes from this process's own argv.
 */
export function localHandoffNow(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCapabilities(env, bindHostFromArgv()).localHandoff;
}

/**
 * The recorded cockpit origin, but only while this process is NOT hosted (#838 F) — the one
 * accessor every MCP reader of the address goes through (`discover_project`, the `health` IPC
 * answer, `project_config`'s refusal next steps and `task_create`'s "no usable provider" message).
 *
 * `serve` records an address only when `localHandoff` is true, so the re-check changes nothing
 * today. It is here so a capability that turned hosted after the listen cannot hand out a loopback
 * link, and so no reader can be written that forgets the check: there is no other way in.
 */
export function cockpitOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return localHandoffNow(env) ? ownCockpitOrigin() : undefined;
}

/**
 * The cockpit's links for `projectId` (#819 item 8), built on THIS process's recorded listen origin
 * (`cockpitOrigin`, which applies the hosted check) — or `undefined` when there is none, so every
 * caller omits the link rather than guessing one. Shared by every MCP reader, so the address a
 * leader is given is the same everywhere.
 */
export function cockpitLinks(projectId: string, origin: string | undefined = cockpitOrigin()): McpDiscoveryCockpit | undefined {
  if (origin === undefined) return undefined;
  const project = `${origin}/p/${encodeURIComponent(projectId)}/`;
  return {
    url: project,
    pages: {
      // The Providers card's own anchor (`provider-settings.tsx`), the one every cockpit link uses
      // (#838 E1): without it the person lands at the top of the Agents page.
      providers: `${project}settings/agents#providers`,
      accounts: `${origin}/settings/global/accounts`,
      mcpConnection: `${project}settings/mcp-connection`,
    },
  };
}
