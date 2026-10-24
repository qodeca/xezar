/**
 * What a Codex run xezar starts may reach besides Codex itself (#324, #323, #1007).
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
 *   once the person has trusted the project), with the project's settings only. That file is
 *   reviewed with the code, so it is how a project opts a server in — no xezar setting. When the
 *   home config names the same server, the run gets the project layer's definition in place of the
 *   merged one (#1007); when that cannot be done without a home key reaching the run, the server
 *   stays off and the run's note names the keys. See `projectOnlyDefinition`.
 * - Never xezar's own bridge, even when the project declares it: that is how the person's leader
 *   session reaches xezar, and a task run is not the leader (#323). See `isXezarBridge`.
 * - No plugins and no apps. Both hang off the account, not the project.
 *
 * The server list comes from the app-server (`config/read`), never from xezar reading a file. The
 * process may not use the home xezar thinks it does — a wrapper on PATH can pin its own
 * `CODEX_HOME` — and a list xezar never loaded must not read as "nothing to switch off". So an
 * answer without a config fails the run closed instead of starting it with servers nobody saw.
 */
import { asRecord } from './records.ts';

export interface CodexRunIsolation {
  /** The `config` override `thread/start` and `thread/resume` carry. */
  readonly config: Record<string, unknown>;
  /** Servers this run does not get, sorted — named in the run's note. */
  readonly disabledServers: readonly string[];
  /** Project servers the home config also names, run with the project layer's definition only, sorted. */
  readonly projectOnlyServers: readonly string[];
  /** Project servers kept off because no override can leave the home config's keys out, and why. */
  readonly keptOff: readonly { readonly name: string; readonly reason: string }[];
}

/** The config layer that may contribute a server to a run: the project's own `.codex/`. */
const PROJECT_LAYER = 'project';

/** Account-level features whose tools are the person's own, never the project's. */
const ACCOUNT_FEATURES = ['plugins', 'apps'] as const;

/**
 * Turn a `config/read` answer (asked with `includeLayers: true`) into the run's overrides. Throws
 * when the answer carries no config: the caller must not start a thread it cannot isolate.
 */
export function codexRunIsolation(configRead: unknown): CodexRunIsolation {
  const read = asRecord(configRead);
  const config = asRecord(read?.config);
  if (!config) throw new Error('codex app-server answered config/read without a config');
  const servers = asRecord(config.mcp_servers) ?? {};
  const origins = asRecord(read?.origins) ?? {};
  const layers = Array.isArray(read?.layers) ? (read.layers as unknown[]) : undefined;

  const disabledServers: string[] = [];
  const projectOnly: [string, Record<string, unknown>][] = [];
  const keptOff: { name: string; reason: string }[] = [];
  for (const name of Object.keys(servers).sort()) {
    if (isXezarBridge(name, asRecord(servers[name]) ?? {})) {
      disabledServers.push(name);
      continue;
    }
    const owner = serverOwner(name, origins);
    if (owner === 'project') continue;
    if (owner === 'shared') {
      const built = projectOnlyDefinition(name, origins, layers);
      if ('definition' in built) {
        if (!isXezarBridge(name, built.definition)) {
          projectOnly.push([name, built.definition]);
          continue;
        }
      } else {
        keptOff.push({ name, reason: built.reason });
      }
    }
    disabledServers.push(name);
  }

  // Built with `Object.fromEntries`, never by assignment into `{}`: a server may be named
  // `__proto__` (TOML allows it, and Codex reports it as an own key), and `obj[name] = …` would call
  // the prototype setter instead of creating a key — the run would say the server is off while the
  // override on the wire carried nothing for it.
  const mcpServers = Object.fromEntries([
    ...disabledServers.map((name) => [name, { enabled: false }] as const),
    ...projectOnly,
  ]);
  const features = Object.fromEntries(ACCOUNT_FEATURES.map((feature) => [feature, false]));

  return {
    config: Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers, features } : { features },
    disabledServers,
    projectOnlyServers: projectOnly.map(([name]) => name),
    keptOff,
  };
}

/**
 * Who set the keys Codex reports for the server: `project` when every one came from a project
 * layer, `shared` when a project layer and another layer both did, `other` when no project layer
 * did — or when Codex reported no origin at all, the safe reading of an answer nobody can attribute.
 *
 * This reads the origins Codex reports; it does not require one for every key of the server. It
 * cannot: codex-cli 0.154.0 fills defaults (`enabled`, `environment_id`, `tool_timeout_sec`, an
 * empty `args`) into the answer with no origin at all, so "every key has an origin" would switch
 * off every project server. It therefore relies on Codex reporting an origin for every key a
 * config file set, which is what 0.154.0 was observed to do. A `project` server is sent nothing.
 * A `shared` one gets the project's own definition or stays off (`projectOnlyDefinition`).
 */
function serverOwner(name: string, origins: Record<string, unknown>): 'project' | 'shared' | 'other' {
  const prefix = `mcp_servers.${name}.`;
  let project = false;
  let other = false;
  for (const [key, origin] of Object.entries(origins)) {
    if (!key.startsWith(prefix)) continue;
    if (layerType(origin) === PROJECT_LAYER) project = true;
    else other = true;
  }
  if (!project) return 'other';
  return other ? 'shared' : 'project';
}

/**
 * The server as the project layer alone defines it, ready to be the run's override — or why it
 * cannot be (#1007).
 *
 * Codex MERGES a per-thread override into the layered config key by key (codex-rs `config_manager`
 * turns each request key into a CLI override; `merge_toml_values` merges tables recursively and
 * lets anything else replace), and it has no way to unset a key: a JSON `null` arrives as an empty
 * string. So sending the project's table keeps out only the home keys the project table also
 * sets. Every other home key must be covered here, or the server stays off:
 *
 * - covered: the project definition sets the same key, or a value above it that is not a table
 *   (an array such as `args`, which replaces wholesale);
 * - pinned: `tools.<tool>.approval_mode` takes the project's `default_tools_approval_mode`, the
 *   value Codex resolves for that tool when only the project's config is read (per-tool mode,
 *   then the server default);
 * - anything else (an `env` entry, a `url`, `enabled`, a home approval mode with no project
 *   default) cannot be left out, so the server stays off and the reason names those key paths —
 *   never their values, which may be secrets.
 *
 * The project definition comes from the answer's `layers` (`includeLayers: true`): every project
 * layer Codex did not disable (an untrusted project is reported with a `disabledReason`), merged
 * the way Codex merges them. codex-cli 0.156.1 lists layers highest precedence first; that order
 * is observed, not documented. The home keys come from every other layer AND from `origins`, so a
 * key one of the two leaves out still counts.
 */
function projectOnlyDefinition(
  name: string,
  origins: Record<string, unknown>,
  layers: unknown[] | undefined,
): { definition: Record<string, unknown> } | { reason: string } {
  const unreadable = { reason: "Codex did not report the project's own settings for it" };
  if (!layers) return unreadable;
  const projectLayers: Record<string, unknown>[] = [];
  const homeKeys = new Map<string, string[]>();
  for (const entry of layers) {
    const layer = asRecord(entry);
    const server = asRecord(asRecord(asRecord(layer?.config)?.mcp_servers)?.[name]);
    if (layerType(layer) === PROJECT_LAYER) {
      if (server && (layer?.disabledReason === undefined || layer.disabledReason === null)) projectLayers.unshift(server);
    } else if (server) {
      for (const path of leafPaths(server)) homeKeys.set(path.join('.'), path);
    }
  }
  if (projectLayers.length === 0) return unreadable;
  const prefix = `mcp_servers.${name}.`;
  for (const [key, origin] of Object.entries(origins)) {
    if (key.startsWith(prefix) && layerType(origin) !== PROJECT_LAYER) homeKeys.set(key.slice(prefix.length), key.slice(prefix.length).split('.'));
  }

  const definition = projectLayers.reduce<Record<string, unknown>>((merged, layer) => mergeTables(merged, layer), {});
  const defaultApproval = definition.default_tools_approval_mode;
  const uncovered: string[] = [];
  for (const [key, path] of homeKeys) {
    if (covers(definition, path)) continue;
    if (path.length === 3 && path[0] === 'tools' && path[2] === 'approval_mode' && typeof defaultApproval === 'string') {
      setLeaf(definition, path, defaultApproval);
      continue;
    }
    uncovered.push(key);
  }
  if (uncovered.length > 0) {
    return { reason: `your own Codex config also sets ${uncovered.sort().join(', ')} for it, which a run cannot leave out` };
  }
  return { definition };
}

/** The layer type an `origins` entry or a `layers` entry names (`project`, `user`, `system`, …). */
function layerType(value: unknown): unknown {
  return asRecord(asRecord(value)?.name)?.type;
}

/** Every key path in a table that holds a value; an array is one value, an empty table none. */
function leafPaths(table: Record<string, unknown>, above: string[] = []): string[][] {
  return Object.entries(table).flatMap(([key, value]) => {
    const inner = asRecord(value);
    return inner ? leafPaths(inner, [...above, key]) : [[...above, key]];
  });
}

/** True when merging `definition` over a layer that sets `path` replaces that key. */
function covers(definition: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = definition;
  for (const key of path) {
    const table = asRecord(current);
    if (!table) return true;
    if (!Object.hasOwn(table, key)) return false;
    current = table[key];
  }
  return true;
}

/** `overlay` merged onto a copy of `base` the way Codex merges layers; own keys only, `__proto__` safe. */
function mergeTables(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged = copyTable(base);
  for (const [key, value] of Object.entries(overlay)) {
    const below = Object.hasOwn(merged, key) ? asRecord(merged[key]) : undefined;
    const above = asRecord(value);
    defineKey(merged, key, below && above ? mergeTables(below, above) : copyValue(value));
  }
  return merged;
}

function setLeaf(table: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = table;
  for (const key of path.slice(0, -1)) {
    const next = Object.hasOwn(current, key) ? asRecord(current[key]) : undefined;
    const table = next ?? {};
    if (!next) defineKey(current, key, table);
    current = table;
  }
  defineKey(current, path[path.length - 1]!, value);
}

function copyTable(table: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) defineKey(copy, key, copyValue(value));
  return copy;
}

function copyValue(value: unknown): unknown {
  const table = asRecord(value);
  if (table) return copyTable(table);
  return Array.isArray(value) ? value.map(copyValue) : value;
}

/** An own, enumerable key even when it is named `__proto__` (see the comment in `codexRunIsolation`). */
function defineKey(table: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
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
  const parts: string[] = [];
  if (isolation.disabledServers.length > 0) {
    parts.push(
      `codex: this run does not load MCP servers from your own Codex config or xezar's leader bridge ` +
        `(off: ${isolation.disabledServers.join(', ')}); Codex plugins and apps are off too. ` +
        `A server the project's trusted .codex/config.toml declares still loads, with the project's settings only (#324).`,
    );
  }
  for (const { name, reason } of isolation.keptOff) {
    parts.push(`codex: the project server ${name} stays off because ${reason} (#1007).`);
  }
  if (isolation.projectOnlyServers.length > 0) {
    const names = isolation.projectOnlyServers.join(', ');
    parts.push(
      `codex: ${names} ${isolation.projectOnlyServers.length === 1 ? 'is' : 'are'} set up with the project's own settings only; ` +
        `your own Codex config's settings for ${isolation.projectOnlyServers.length === 1 ? 'it' : 'them'} are not used (#1007).`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
