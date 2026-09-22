import { parseArgs } from 'node:util';
import type { McpDiscoveryCockpit } from '@qodeca/xezar-contract';
import { resolveBindHost, resolveCapabilities } from '../server/capabilities.ts';
import { ownCockpitOrigin } from '../server/instance-liveness.ts';

/**
 * `--bind-host` of THIS process. The MCP socket lives inside `xezar serve`, and a non-loopback
 * bind is half of what makes the cockpit hosted; `McpToolContext` does not carry it yet (#89
 * widens that context), and reporting `localHandoff: true` on a hosted box would promise actions
 * the routes refuse.
 *
 * The rule for a REPEATED flag is last-wins, because that is what `node:util`'s `parseArgs`
 * already does for every other flag on this same argv, in the same process, in `index.ts`'s own
 * CLI parse (#838 item H). This reader used to be a hand-written first-match scanner, which
 * quietly disagreed with that parse on `--bind-host a --bind-host b`: the server bound `b` while
 * this told an MCP caller `a`, with no error either side. Going through `parseArgs` here too — the
 * same function, not a second hand-rolled rule kept in step by a comment — makes the two parses of
 * one argv agree by construction. `strict: false` lets this scan ignore every flag except
 * `bind-host`, since this reader has no need to know the rest of the CLI's option table.
 */
export function bindHostFromArgv(argv: readonly string[] = process.argv): string | undefined {
  const { values } = parseArgs({
    args: [...argv],
    options: { 'bind-host': { type: 'string' } },
    allowPositionals: true,
    strict: false,
  });
  // `@types/node` widens every declared option's value to `string | boolean` once `strict: false`
  // is set (it stops narrowing by `type` at that point) — a typings limitation, not a runtime one:
  // `type: 'string'` still makes `parseArgs` itself only ever put a string here. `resolveBindHost`:
  // an empty value means the flag was absent, as it does for the CLI (#838 item A).
  return resolveBindHost(values['bind-host'] as string | undefined);
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
