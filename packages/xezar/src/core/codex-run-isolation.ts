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
 * - MCP servers the PROJECT alone declares in its own `.codex/config.toml` (a layer Codex reads
 *   only once the person has trusted the project). That file is reviewed with the code, so it is
 *   how a project opts a server in — no xezar setting.
 * - Never xezar's own bridge, even when the project declares it: that is how the person's leader
 *   session reaches xezar, and a task run is not the leader (#323). See `isXezarBridge`.
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

  // Built with `Object.fromEntries`, never by assignment into `{}`: a server may be named
  // `__proto__` (TOML allows it, and Codex reports it as an own key), and `obj[name] = …` would call
  // the prototype setter instead of creating a key — the run would say the server is off while the
  // override on the wire carried nothing for it.
  const mcpServers = Object.fromEntries(disabledServers.map((name) => [name, { enabled: false }]));
  const features = Object.fromEntries(ACCOUNT_FEATURES.map((feature) => [feature, false]));

  return {
    config: disabledServers.length > 0 ? { mcp_servers: mcpServers, features } : { features },
    disabledServers,
  };
}

/**
 * True only when every key Codex reports for the server came from a project layer. A server with
 * no recorded origin, or one the home config merely tweaks (an `env` added to a project server),
 * is not the project's alone and stays off — the safe direction for a mixed answer.
 *
 * This reads the origins Codex reports; it does not require one for every key of the server. It
 * cannot: codex-cli 0.154.0 fills defaults (`enabled`, `environment_id`, `tool_timeout_sec`, an
 * empty `args`) into the answer with no origin at all, so "every key has an origin" would switch
 * off every project server. It therefore relies on Codex reporting an origin for every key a
 * config file set, which is what 0.154.0 was observed to do.
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

/** The server name the cockpit's setup card registers xezar's bridge under. Reserved: see below. */
const BRIDGE_NAME = 'xezar';

/** Where a launch line is split into words: whitespace, quotes, shell punctuation and `=`. */
const WORD_SEPARATORS = /[\s"'`;&|()<>=]+/;
/** The published package, bare or pinned: `@qodeca/xezar`, `@qodeca/xezar@0.14.0`. */
const PACKAGE_SPEC = /^@qodeca\/xezar(@[^/]*)?$/;
/** A path inside an installed or `npx`-cached copy: `…/node_modules/@qodeca/xezar/dist/index.js`. */
const PACKAGE_PATH = /(^|\/)@qodeca\/xezar\//;
/** The CLI's entry point in a checkout or copy: `…/packages/xezar/dist/index.js`, `…/src/index.ts`. */
const ENTRY_POINT = /(^|\/)xezar\/(dist\/index\.js|src\/index\.ts)$/;
/** What a launcher adds to a binary's name on disk (`xezar.cmd`, `xez.exe`, `xezar.js`). */
const LAUNCHER_EXTENSION = /\.(cmd|exe|bat|ps1|js|mjs|cjs)$/;

/**
 * xezar's own MCP bridge. The rule is explicit so "never the bridge" means something:
 *
 * 1. **The reserved name.** A server named `xezar` (any case) is always treated as the bridge —
 *    the name the setup card uses. That catches a bridge behind a wrapper script whose launch
 *    line says nothing about xezar. The cost is that an unrelated project server named `xezar`
 *    is switched off too; renaming it is the remedy (README, "Codex runs and MCP servers").
 * 2. **A launch line that runs xezar**, whatever wraps it. The command and every argument are
 *    split into words — so `sh -c "npx -y @qodeca/xezar mcp"`, `/usr/bin/env xezar mcp` and
 *    `npx --package=@qodeca/xezar …` are all seen through — and the server is the bridge when a
 *    word is the package (`@qodeca/xezar[@version]`), a path inside an installed copy of it, the
 *    CLI's entry point (`…/xezar/dist/index.js`, `…/xezar/src/index.ts`: the package `bin`, or a
 *    checkout), or a `xezar` / `xez` executable while the line also names `mcp`.
 *
 * The first three launch forms need no `mcp`: xezar's only MCP server is the bridge, so a server
 * that runs xezar any other way is not a working MCP server and switching it off costs nothing.
 * A bare `xezar` word does need `mcp`, so a path argument that merely ends in a directory called
 * `xezar` (`--root /src/xezar`) does not switch a server off.
 *
 * What it cannot see: a wrapper script (`command = "./bin/leader.sh"`) whose own launch line never
 * mentions xezar. Register the bridge under the name `xezar` to be sure it stays out of task runs.
 */
export function isXezarBridge(name: string, server: Record<string, unknown>): boolean {
  if (name.toLowerCase() === BRIDGE_NAME) return true;
  const words = launchWords(server);
  if (words.some((word) => PACKAGE_SPEC.test(word) || PACKAGE_PATH.test(word) || ENTRY_POINT.test(word))) return true;
  const runsXezarBinary = words.some((word) => {
    const bin = word.slice(word.lastIndexOf('/') + 1).replace(LAUNCHER_EXTENSION, '');
    return bin === 'xezar' || bin === 'xez';
  });
  return runsXezarBinary && words.includes('mcp');
}

/** A stdio server's command and arguments as lower-case words, with `\` read as `/` (Windows). */
function launchWords(server: Record<string, unknown>): string[] {
  const args = Array.isArray(server.args) ? server.args : [];
  return [server.command, ...args]
    .filter((part): part is string => typeof part === 'string')
    .flatMap((part) => part.replaceAll('\\', '/').toLowerCase().split(WORD_SEPARATORS))
    .filter((word) => word.length > 0);
}

/** The run note that says what the person's own config did not contribute, or null. */
export function codexIsolationNote(isolation: CodexRunIsolation): string | null {
  if (isolation.disabledServers.length === 0) return null;
  return (
    `codex: this run does not load MCP servers from your own Codex config or xezar's leader bridge ` +
    `(off: ${isolation.disabledServers.join(', ')}); Codex plugins and apps are off too. ` +
    `A server that only the project's trusted .codex/config.toml declares still loads (#324).`
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
