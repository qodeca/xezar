/**
 * What MCP servers a task run xezar starts may reach (#342), for the backends the Codex seam does
 * not cover.
 *
 * `codex-run-isolation.ts` (#324, #323) already answers this for Codex: a run gets the project's
 * own MCP servers, never xezar's leader bridge, never the account's. Without this seam a task client
 * would load whatever the person's and the project's config declared — including a `xezar` bridge
 * entry.
 *
 * That is not only a tool-surface question. xezar's bridge takes the PROJECT OWNER slot when it
 * connects, and a `keep-alive` entry connects at start-up with no prompt and no tool call. A task
 * run started in the project root (`worktree: false`) therefore held the slot for its whole
 * lifetime and the person's own leader session was refused with `-32080 project occupied` (#342).
 * A tool allowlist does not help: it hides the tools from the model, it does not stop the client
 * connecting.
 *
 * Worktree ON is treated identically. A linked worktree is a checkout of the same commit, so it
 * carries the same committed `.mcp.json`; the bridge binds by repository root and task worktrees
 * are never registered, but that is a property of the registry, not of the runner, so this seam
 * does not lean on it.
 *
 * ## One mechanism per client, because each CLI offers exactly one that works
 *
 * | Backend  | Lever                                        | Why not the obvious one |
 * | -------- | -------------------------------------------- | ----------------------- |
 * | claude   | `--strict-mcp-config` + `--mcp-config <json>` | Without `--strict-…` claude merges `.mcp.json` and `~/.claude.json` on top and the bridge returns. |
 * | qwen     | `--allowed-mcp-server-names <names>`         | Qwen Code merges the person's and the project's `mcpServers`; the name allowlist is the lever that leaves the person's own servers, extensions and the bridge out. An empty list means "no filter", so the empty case names one server that does not exist. |
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
import { isXezarBridge } from './codex-run-isolation.ts';
import { parseJsonc } from './qwen-settings.ts';
import { asRecord } from './records.ts';

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

// ---- Qwen Code ------------------------------------------------------------

/**
 * The project-scoped files Qwen Code reads MCP servers from, in its own order (later wins):
 * `.mcp.json` and the project `.qwen/settings.json` (JSONC). The person's `~/.qwen/settings.json`
 * and Qwen Code extensions are the person's own and stay out of a run.
 */
const QWEN_FILES: readonly McpConfigFile[] = [
  { segments: ['.mcp.json'], key: 'mcpServers' },
  { segments: ['.qwen', 'settings.json'], key: 'mcpServers' },
];

/**
 * A name no server carries, for a run with no project server: `--allowed-mcp-server-names` with
 * no name at all means "no filter" to Qwen Code, so the empty case needs one name that matches
 * nothing (measured on 0.25.2: the run then lists no MCP server).
 */
export const QWEN_NO_MCP_SERVER = '__xezar_none__';

/** The servers a Qwen Code run may start, and the names it was told to keep. */
export interface QwenMcpIsolation extends McpScan {
  /** What `--allowed-mcp-server-names` carries: the project's servers minus the bridge. */
  readonly allowed: readonly string[];
  /**
   * What `--mcp-config` carries: the project's own definition of each allowed server, or
   * undefined when there is none. Qwen Code ranks these above its settings files, so a server the
   * person's home settings also name runs on the project's definition, never the home one.
   */
  readonly mcpConfig?: { readonly mcpServers: Record<string, unknown> };
}

/**
 * Qwen Code's lever is `--allowed-mcp-server-names`, an exclusive allowlist by name: every
 * server it does not name — the person's own, an extension's, xezar's bridge — is not started.
 * The project's own servers are named, as for Claude Code, and their definitions also ride in
 * `--mcp-config`, so the name always starts the project's server.
 */
export function qwenMcpIsolation(cwd: string, readFile: ReadConfigFile = readJsoncConfigFile): QwenMcpIsolation {
  const scan = scanMcpFiles(cwd, QWEN_FILES, readFile);
  const kept = Object.keys(scan.servers).filter((name) => !scan.bridges.includes(name)).sort();
  if (kept.length === 0) return { ...scan, allowed: [QWEN_NO_MCP_SERVER] };
  const mcpServers = Object.fromEntries(kept.map((name) => [name, scan.servers[name]]));
  return { ...scan, allowed: kept, mcpConfig: { mcpServers } };
}

/** {@link readConfigFile} for a JSONC file (comments and trailing commas allowed). */
export function readJsoncConfigFile(path: string): ConfigFileRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { status: 'absent' } : { status: 'unreadable' };
  }
  const value = parseJsonc(text);
  return value ? { status: 'ok', value } : { status: 'unreadable' };
}

// ---- shared ---------------------------------------------------------------

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
 * Claude Code takes its overlay as an argv JSON string; Qwen Code's `--mcp-config` takes a file. It
 * goes into a private `mkdtemp` directory under the OS temp dir, mode 0600, and
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
