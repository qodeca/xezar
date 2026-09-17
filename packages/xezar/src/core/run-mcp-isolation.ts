/**
 * What MCP servers a task run xezar starts may reach (#342), for the three backends the Codex
 * seam does not cover.
 *
 * `codex-run-isolation.ts` (#324, #323) already answers this for Codex: a run gets the project's
 * own MCP servers, never xezar's leader bridge, never the account's. The other three runners
 * passed nothing at all, so a task client loaded whatever the person's and the project's config
 * declared — including a `xezar` bridge entry.
 *
 * That is not only a tool-surface question. xezar's bridge takes the PROJECT OWNER slot when it
 * connects, and a `keep-alive` entry connects at start-up with no prompt and no tool call. A task
 * run started in the project root (`worktree: false`) therefore held the slot for its whole
 * lifetime and the person's own leader session was refused with `-32080 project occupied`
 * (observed with pi, #342). The `--tools` / `--allowedTools` allowlists do not help: they hide the
 * tools from the model, they do not stop the client connecting.
 *
 * Worktree ON is treated identically. A linked worktree is a checkout of the same commit, so it
 * carries the same committed `.mcp.json` / `.pi/mcp.json` / `opencode.json`; the reason the
 * observed pi worktree run bound no project is that the bridge binds by repository root and task
 * worktrees are never registered. That is a property of the registry, not of the runner, so this
 * seam does not lean on it.
 *
 * ## One mechanism per client, because each CLI offers exactly one that works
 *
 * | Backend  | Lever                                        | Why not the obvious one |
 * | -------- | -------------------------------------------- | ----------------------- |
 * | claude   | `--strict-mcp-config` + `--mcp-config <json>` | Without `--strict-…` claude merges `.mcp.json` and `~/.claude.json` on top and the bridge returns. |
 * | pi       | `--mcp-config <file>` carrying `disabled: true` | The flag substitutes for ONE slot of the adapter's six-file chain (the pi agent dir), so an exclusive overlay is impossible — but the chain merges server entries FIELD BY FIELD, so a `disabled` flag set in a lower slot survives the project files layered over it. |
 * | opencode | `OPENCODE_CONFIG_CONTENT` carrying `enabled: false` | `OPENCODE_CONFIG` is loaded BELOW the project `opencode.json`, so the project's own entry wins over it. `OPENCODE_CONFIG_CONTENT` is loaded above. |
 *
 * ## The reserved name is a floor, not a guess
 *
 * pi and opencode are told to switch off every bridge xezar can SEE in the project's files, plus
 * the reserved name `xezar` whether or not it was seen. Discovery reads project files only, so a
 * bridge declared in the person's own global config would otherwise still connect — and that one
 * would contend in every project. The cost is one inert, disabled entry in a client's server list
 * when nobody declared a bridge; both clients treat an unknown name marked off as nothing to
 * connect to. Claude needs no floor: its overlay is exclusive.
 *
 * ## Fail-open, and the difference between "absent" and "unreadable"
 *
 * The Codex seam fails the run CLOSED when it cannot read the config, because there it asks the
 * live process and an unanswerable question means the run would start with servers nobody saw.
 * Here xezar reads files it can name, and a malformed file is the user's own state — so the run
 * still starts (§ Zero config: a read-only or broken file degrades, never fails the boot).
 *
 * "I found no servers" and "I could not read the file" must never collapse into the same answer,
 * or this fail-open helper quietly lies about an empty list. They are separated here: `unreadable`
 * names every file that existed and did not parse, and only that list produces the second sentence
 * of the note.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHomePaths } from '../paths.ts';
import { isXezarBridge } from './codex-run-isolation.ts';

/** The server name the cockpit's setup card registers xezar's bridge under (see `isXezarBridge`). */
const RESERVED_BRIDGE_NAME = 'xezar';

/** What one scan of a client's project-scope MCP files found. */
export interface McpScan {
  /** Every server the scanned files declare, merged in the client's own precedence order. */
  readonly servers: Record<string, unknown>;
  /** The names among them that are xezar's bridge, sorted. */
  readonly bridges: readonly string[];
  /** Files that existed and did not parse, sorted — never silently an empty list. */
  readonly unreadable: readonly string[];
}

/** How one config file names its MCP servers, and where it sits under the run's root. */
interface McpConfigFile {
  /** Path segments under the root, joined for the label the note prints. */
  readonly segments: readonly string[];
  /** The object key holding `{ <name>: <server> }`. */
  readonly key: string;
}

/**
 * Claude Code's project-scoped MCP file. User and local scope live in `~/.claude.json`, which
 * xezar neither reads nor edits — `--strict-mcp-config` is what keeps them out of a run.
 */
const CLAUDE_FILES: readonly McpConfigFile[] = [{ segments: ['.mcp.json'], key: 'mcpServers' }];

/**
 * The two PROJECT-scoped files of the six the `pi-mcp-adapter` extension reads, in its own
 * precedence order (later wins). The four home-scoped ones are the person's own; the reserved-name
 * floor covers a bridge hiding in one of them.
 */
const PI_PROJECT_FILES: readonly McpConfigFile[] = [
  { segments: ['.mcp.json'], key: 'mcpServers' },
  { segments: ['.pi', 'mcp.json'], key: 'mcpServers' },
];

/**
 * OpenCode's project config, in the order its loader searches (`opencode.jsonc` then
 * `opencode.json`, plus the `.opencode` directory the website does not name).
 */
const OPENCODE_FILES: readonly McpConfigFile[] = [
  { segments: ['opencode.jsonc'], key: 'mcp' },
  { segments: ['opencode.json'], key: 'mcp' },
  { segments: ['.opencode', 'opencode.jsonc'], key: 'mcp' },
  { segments: ['.opencode', 'opencode.json'], key: 'mcp' },
];

// ---- Claude Code ----------------------------------------------------------

/** The exclusive `mcpServers` overlay a claude run gets: the project's servers, minus the bridge. */
export interface ClaudeMcpIsolation extends McpScan {
  /** What `--mcp-config` carries. Authoritative only together with `--strict-mcp-config`. */
  readonly overlay: { mcpServers: Record<string, unknown> };
}

export function claudeMcpIsolation(cwd: string, readFile: ReadConfigFile = readConfigFile): ClaudeMcpIsolation {
  const scan = scanMcpFiles(cwd, CLAUDE_FILES, readFile);
  const kept = Object.entries(scan.servers).filter(([name]) => !scan.bridges.includes(name));
  // `Object.fromEntries`, never assignment into `{}`: a server may be named `__proto__`, and
  // `obj[name] = …` would call the prototype setter instead of creating a key — the same trap
  // `codexRunIsolation` documents.
  return { ...scan, overlay: { mcpServers: Object.fromEntries(kept) } };
}

// ---- pi -------------------------------------------------------------------

/** The overlay file a pi run is pointed at, and the names it switches off. */
export interface PiMcpIsolation extends McpScan {
  /** The JSON written to the run's private overlay file. */
  readonly overlay: Record<string, unknown>;
  /** Names the client is told to switch off: every bridge seen, plus the reserved-name floor. */
  readonly disabled: readonly string[];
}

/**
 * pi's overlay takes the place of the pi agent directory's own `mcp.json` in the adapter's chain,
 * so it CARRIES that file forward rather than replacing it: dropping the person's global servers
 * is not what #342 asks for. On top of it go `disabled: true` markers, which survive the project
 * files merged above because the adapter merges a server entry field by field.
 */
export function piMcpIsolation(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadConfigFile = readConfigFile,
): PiMcpIsolation {
  const scan = scanMcpFiles(cwd, PI_PROJECT_FILES, readFile);
  const agentDir = agentHomePaths(env).pi;
  const inherited = readFile(join(agentDir, 'mcp.json'));
  const base = inherited.status === 'ok' ? inherited.value : {};
  const inheritedServers = asRecord(base.mcpServers ?? base['mcp-servers']) ?? {};

  const off = offNames(scan, inheritedServers);
  const servers = Object.fromEntries([
    ...Object.entries(inheritedServers).filter(([name]) => !off.includes(name)),
    // A partial entry is the documented way to switch one server off without redefining it; only
    // the literal `true` disables, so the value is spelled out rather than computed.
    ...off.map((name) => [name, { ...asRecord(inheritedServers[name]), disabled: true }] as const),
  ]);

  return {
    ...scan,
    // `bridges` stays what xezar actually SAW, so the run note never claims it switched off a
    // bridge nobody declared; `disabled` is what the client is told, floor included.
    bridges: sorted(new Set([...scan.bridges, ...extraBridges(inheritedServers)])),
    disabled: off,
    unreadable: sorted([
      ...scan.unreadable,
      ...(inherited.status === 'unreadable' ? [join(agentDir, 'mcp.json')] : []),
    ]),
    // `mcp-servers` is the adapter's accepted alias for the same map. Carrying the inherited file's
    // alias key forward alongside the rewritten `mcpServers` would leave a second, un-disabled copy
    // of the servers in the overlay, so it is dropped rather than merged.
    overlay: { ...base, 'mcp-servers': undefined, mcpServers: servers },
  };
}

// ---- OpenCode -------------------------------------------------------------

/** The inline config an opencode run is started with, and the names it switches off. */
export interface OpencodeMcpIsolation extends McpScan {
  /** The JSON `OPENCODE_CONFIG_CONTENT` carries — the highest layer OpenCode merges. */
  readonly overlay: { mcp: Record<string, { enabled: false }> };
  /** Names the client is told to switch off: every bridge seen, plus the reserved-name floor. */
  readonly disabled: readonly string[];
}

export function opencodeMcpIsolation(
  cwd: string,
  readFile: ReadConfigFile = readConfigFile,
): OpencodeMcpIsolation {
  const scan = scanMcpFiles(cwd, OPENCODE_FILES, readFile);
  const off = offNames(scan, {});
  return {
    ...scan,
    disabled: off,
    overlay: { mcp: Object.fromEntries(off.map((name) => [name, { enabled: false } as const])) },
  };
}

// ---- shared ---------------------------------------------------------------

/**
 * What the client is told to switch off: every bridge seen — in the scan and in any extra server
 * map — plus the reserved name whether or not anything declared it. See the header's floor note.
 */
function offNames(scan: McpScan, alsoConsider: Record<string, unknown>): string[] {
  return sorted(new Set([...scan.bridges, ...extraBridges(alsoConsider), RESERVED_BRIDGE_NAME]));
}

/** The bridges in a server map outside the scan (pi's agent-directory file). */
function extraBridges(servers: Record<string, unknown>): string[] {
  return Object.entries(servers)
    .filter(([name, server]) => isXezarBridge(name, asRecord(server) ?? {}))
    .map(([name]) => name);
}

/** Merge the named files in the client's own order (later wins) and mark the bridges. */
function scanMcpFiles(root: string, files: readonly McpConfigFile[], readFile: ReadConfigFile): McpScan {
  const merged = new Map<string, unknown>();
  const unreadable: string[] = [];

  for (const file of files) {
    const parsed = readFile(join(root, ...file.segments));
    if (parsed.status === 'absent') continue;
    if (parsed.status === 'unreadable') {
      unreadable.push(file.segments.join('/'));
      continue;
    }
    const servers = asRecord(parsed.value[file.key]) ?? {};
    for (const [name, server] of Object.entries(servers)) merged.set(name, server);
  }

  const bridges: string[] = [];
  for (const [name, server] of merged) {
    if (isXezarBridge(name, asRecord(server) ?? {})) bridges.push(name);
  }

  return { servers: Object.fromEntries(merged), bridges: sorted(bridges), unreadable: sorted(unreadable) };
}

/** What reading one config file can produce. `absent` is not `unreadable`; see the header. */
export type ConfigFileRead =
  | { status: 'absent' }
  | { status: 'unreadable' }
  | { status: 'ok'; value: Record<string, unknown> };

export type ReadConfigFile = (path: string) => ConfigFileRead;

/**
 * Read one JSON config file. A missing file is `absent`; anything else that stops xezar from
 * getting an object out of it — a permission error, a syntax error, a JSON array, `null` — is
 * `unreadable`, and the run still starts.
 */
export function readConfigFile(path: string): ConfigFileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'absent' } : { status: 'unreadable' };
  }
  try {
    const value = asRecord(JSON.parse(text));
    return value ? { status: 'ok', value } : { status: 'unreadable' };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * The run note that says what this run does not load, or null when there is nothing to say.
 *
 * `client` names the backend so the note reads the way `codexIsolationNote` does. The second
 * sentence appears only for files that existed and did not parse — that is the populated-input
 * guarantee in the one place a reader sees it: with no second sentence, an empty result means
 * "nothing to switch off", never "nothing was read".
 */
export function runMcpIsolationNote(client: string, isolation: McpScan): string | null {
  const parts: string[] = [];
  if (isolation.bridges.length > 0) {
    parts.push(
      `${client}: this run does not load xezar's own leader MCP bridge `
      + `(off: ${isolation.bridges.join(', ')}) — a task run is not the project's leader (#342).`,
    );
  }
  if (isolation.unreadable.length > 0) {
    parts.push(
      `${client}: could not read ${isolation.unreadable.join(', ')}, so this run may start without `
      + `MCP servers that file declares; fix the file to give the run its servers back (#342).`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** A per-run overlay file plus the way to take it away again. */
export interface McpOverlayFile {
  /** Absolute path the CLI is pointed at. */
  readonly path: string;
  /** Best-effort removal of the private directory; safe to call more than once. */
  readonly cleanup: () => void;
}

/**
 * Write one run's MCP overlay where only this user can read it.
 *
 * Claude Code takes its overlay as an argv JSON string and OpenCode as an env var, so only pi
 * needs a file. It goes into a private `mkdtemp` directory under the OS temp dir, mode 0600, and
 * is removed when the session settles. Never into the project: a run must not leave a config file
 * behind in the user's checkout, and two concurrent runs in one root must not share one.
 *
 * Returns null when the temp directory cannot be written — a read-only or full `$TMPDIR` degrades
 * to a run with no overlay and one note, it never stops the run (§ Zero config).
 */
export function writeMcpOverlay(name: string, content: unknown): McpOverlayFile | null {
  let dir: string;
  let path: string;
  try {
    dir = mkdtempSync(join(tmpdir(), 'xez-mcp-'));
    path = join(dir, name);
    writeFileSync(path, JSON.stringify(content), { encoding: 'utf8', mode: 0o600 });
  } catch {
    return null;
  }
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The overlay is a temp file; failing to remove it never concerns the run.
      }
    },
  };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
