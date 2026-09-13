import { basename } from 'node:path';

/**
 * What a Codex run xezar starts may reach besides Codex itself (#324, #323).
 *
 * `codex app-server` loads every MCP server and plugin the account's own `$CODEX_HOME/config.toml`
 * names — the person's browser, their Messages app, their ChatGPT connectors — and
 * `approvalPolicy: never` does not gate an MCP tool call, so a run could drive all of it without
 * a prompt. Observed with codex-cli 0.154.0: a run offered the model `mcp__<server>` tools from the
 * home config, from an installed plugin, from the project's `.codex/config.toml` and from xezar's
 * own bridge registered there.
 *
 * A run xezar starts gets exactly this instead:
 *
 * - MCP servers the PROJECT declares in its own `.codex/config.toml` (a layer Codex reads only
 *   once the person has trusted the project). That file is reviewed with the code, so it is how a
 *   project opts a server in — no xezar setting.
 * - Never xezar's own bridge, even when the project declares it: that is how the person's leader
 *   session reaches xezar, and a task run is not the leader (#323).
 * - No plugins and no apps. Both hang off the account, not the project.
 *
 * The server list comes from the app-server (`config/read`), never from xezar reading a file. The
 * process may not use the home xezar thinks it does — a wrapper on PATH can pin its own
 * `CODEX_HOME` — and a list xezar never loaded must not read as "nothing to switch off". So an
 * answer without a config fails the run closed instead of starting it with servers nobody saw.
 */
export interface CodexRunIsolation {
  /** The `config` override `thread/start` and `thread/resume` carry. */
  readonly config: Record<string, unknown>;
  /** Servers this run does not get, sorted — named in the run's note. */
  readonly disabledServers: readonly string[];
}

/** The config layer that may contribute a server to a run: the project's own `.codex/`. */
const PROJECT_LAYER = 'project';

/** Account-level features whose tools are the person's own, never the project's. */
const ACCOUNT_FEATURES = ['plugins', 'apps'] as const;

/**
 * Turn a `config/read` answer into the run's overrides. Throws when the answer carries no config:
 * the caller must not start a thread it cannot isolate.
 */
export function codexRunIsolation(configRead: unknown): CodexRunIsolation {
  const read = asRecord(configRead);
  const config = asRecord(read?.config);
  if (!config) throw new Error('codex app-server answered config/read without a config');
  const servers = asRecord(config.mcp_servers) ?? {};
  const origins = asRecord(read?.origins) ?? {};

  const disabledServers = Object.keys(servers)
    .filter((name) => !isProjectServer(name, origins) || isXezarBridge(name, asRecord(servers[name]) ?? {}))
    .sort();

  const mcpServers: Record<string, { enabled: false }> = {};
  for (const name of disabledServers) mcpServers[name] = { enabled: false };
  const features: Record<string, false> = {};
  for (const feature of ACCOUNT_FEATURES) features[feature] = false;

  return {
    config: disabledServers.length > 0 ? { mcp_servers: mcpServers, features } : { features },
    disabledServers,
  };
}

/**
 * True only when every key Codex reports for the server came from a project layer. A server with
 * no recorded origin, or one the home config merely tweaks (an `env` added to a project server),
 * is not the project's alone and stays off — the safe direction for a mixed answer.
 */
function isProjectServer(name: string, origins: Record<string, unknown>): boolean {
  const prefix = `mcp_servers.${name}.`;
  let seen = false;
  for (const [key, origin] of Object.entries(origins)) {
    if (!key.startsWith(prefix)) continue;
    seen = true;
    if (asRecord(asRecord(origin)?.name)?.type !== PROJECT_LAYER) return false;
  }
  return seen;
}

/**
 * xezar's own MCP bridge, however the person registered it: under the name the setup card uses
 * (`xezar`), through the published package (`npx -y @qodeca/xezar mcp`), or through the installed
 * binary (`xezar mcp`, `xez mcp`).
 */
export function isXezarBridge(name: string, server: Record<string, unknown>): boolean {
  if (name.toLowerCase() === 'xezar') return true;
  const command = typeof server.command === 'string' ? server.command : '';
  const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : [];
  if ([command, ...args].some((part) => /^@qodeca\/xezar(@[^\s/]*)?$/.test(part))) return true;
  // Split on both separators: a Windows path (`C:\npm\xezar.cmd`) has no `/` for `basename` to see.
  const bin = basename(command.replaceAll('\\', '/')).replace(/\.(cmd|exe)$/i, '');
  return (bin === 'xezar' || bin === 'xez') && args.includes('mcp');
}

/** The run note that says what the person's own config did not contribute, or null. */
export function codexIsolationNote(isolation: CodexRunIsolation): string | null {
  if (isolation.disabledServers.length === 0) return null;
  return (
    `codex: this run does not load MCP servers from your own Codex config or xezar's leader bridge ` +
    `(off: ${isolation.disabledServers.join(', ')}); Codex plugins and apps are off too. ` +
    `A server the project's trusted .codex/config.toml declares still loads (#324).`
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
