/**
 * MP-11 / #342: a task-spawned client never sees the project's own `xezar` MCP bridge entry.
 *
 * The bug: xezar's bridge takes the project OWNER slot the moment it connects, and a
 * `keep-alive` entry connects at start-up with no prompt and no tool call. A `worktree: false`
 * run starts in the project root, so the task's own client held the slot for the run's lifetime
 * and the person's leader was refused `-32080 project occupied` (#342). The
 * `--tools` / `--allowedTools` allowlists hide the tools from the model; they do not stop the
 * client connecting.
 *
 * Named break for the red proof: `worktree-off-inherits-xezar` — revert `claude-cli-runner.ts`
 * to the state that passes no MCP isolation at all. The `the seam` case (the spawned client's
 * effective MCP config carries `xezar` again) and the `fail-open` cases that reach into the
 * runner fail.
 *
 * The rest are CONTROLS: they exercise `run-mcp-isolation.ts`, which the break does not
 * touch, so they stay green either way. They pin the behaviour this change did NOT want to alter —
 * a project's other servers survive, a broken file never stops a run, and the run note never
 * claims a bridge nobody declared.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useEmptyPath } from '../../test/helpers/empty-path.ts';

import type { AgentRunSpec } from './agent-runner.js';
import { buildClaudeArgs } from './claude-cli-runner.js';
import { buildQwenArgs } from './qwen-runner.js';
import {
  claudeMcpIsolation,
  QWEN_NO_MCP_SERVER,
  qwenMcpIsolation,
  runMcpIsolationNote,
} from './run-mcp-isolation.js';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

useEmptyPath();

/** The entry a person adds so their leader session can reach xezar (docs/guide/13-mcp-leader.md). */
const BRIDGE = { command: 'npx', args: ['-y', '@qodeca/xezar', 'mcp'], lifecycle: 'keep-alive' };
/** A server that is the PROJECT's own and must survive isolation untouched. */
const PROJECT_SERVER = { command: 'node', args: ['tools/docs-server.mjs'] };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xez-mcp-isolation-'));
});

afterEach(() => {
  rmSync(root, TEST_DIR_RM_OPTIONS);
});

function write(relative: string, value: unknown): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function spec(): AgentRunSpec {
  return { userPrompt: 'do the thing', cwd: root };
}

// ---- the seam: one red proof per backend ----------------------------------

describe('the seam keeps the project xezar bridge out of a task-spawned client', () => {
  it('claude: the argv carries a bridge-free overlay and --strict-mcp-config', () => {
    write('.mcp.json', { mcpServers: { xezar: BRIDGE, docs: PROJECT_SERVER } });

    const args = buildClaudeArgs(spec(), {});

    expect(args).toContain('--strict-mcp-config');
    const overlay = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}') as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(overlay.mcpServers)).toEqual(['docs']);
    // `--mcp-config` is variadic, so nothing may follow its JSON.
    expect(args.at(-1)).toBe(JSON.stringify(overlay));
  });

});

// ---- controls: the pure seam and the fail-open guard -----------------------

describe('the pure seam', () => {
  it('claude keeps every project server that is not the bridge', () => {
    write('.mcp.json', { mcpServers: { xezar: BRIDGE, docs: PROJECT_SERVER } });

    const isolation = claudeMcpIsolation(root);

    expect(isolation.bridges).toEqual(['xezar']);
    expect(isolation.overlay).toEqual({ mcpServers: { docs: PROJECT_SERVER } });
    expect(isolation.unreadable).toEqual([]);
  });

  it('the person\'s own bridge stays off even when the project declares no bridge at all', () => {
    write('.mcp.json', { mcpServers: { docs: PROJECT_SERVER } });

    // A bridge in the person's own global config is never in a project file, and would otherwise
    // contend in every project. Qwen Code's allowlist names only the project's servers, and
    // Claude's overlay is exclusive, so neither needs the bridge to be declared to keep it off.
    expect(qwenMcpIsolation(root).allowed).toEqual(['docs']);
    expect(claudeMcpIsolation(root).bridges).toEqual([]);
  });

  it('the note reports only bridges that were really declared, never the floor', () => {
    const isolation = qwenMcpIsolation(root);

    // The floor is in `allowed` and must NOT reach `bridges`: a run that saw no bridge would
    // otherwise tell the user it had switched one off on every single start.
    expect(isolation.allowed).toEqual([QWEN_NO_MCP_SERVER]);
    expect(isolation.bridges).toEqual([]);
    expect(runMcpIsolationNote('qwen', isolation)).toBeNull();
  });

  it('recognises a bridge under another name by its launch line, and leaves lookalikes alone', () => {
    write('.mcp.json', {
      mcpServers: {
        leader: { command: 'sh', args: ['-c', 'npx -y @qodeca/xezar mcp'] },
        elsewhere: { command: 'node', args: ['--root', '/src/xezar/server.js'] },
      },
    });

    const isolation = claudeMcpIsolation(root);

    expect(isolation.bridges).toEqual(['leader']);
    expect(Object.keys(isolation.overlay.mcpServers)).toEqual(['elsewhere']);
  });

  it('never assigns through the prototype for a server named __proto__', () => {
    write('.mcp.json', `{"mcpServers": {"__proto__": {"command": "node"}, "docs": {"command": "d"}}}`);

    const isolation = claudeMcpIsolation(root);

    expect(Object.hasOwn(isolation.overlay.mcpServers, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

describe('fail-open: a config the seam cannot read never stops the run', () => {
  it('an ABSENT config says nothing and strips nothing', () => {
    const isolation = claudeMcpIsolation(root);

    expect(isolation).toEqual({ servers: {}, bridges: [], unreadable: [], overlay: { mcpServers: {} } });
    expect(runMcpIsolationNote('claude', isolation)).toBeNull();
  });

  it('an UNREADABLE config is also empty — and says so, which is the whole difference', () => {
    write('.mcp.json', '{ this is not json');

    const isolation = claudeMcpIsolation(root);

    expect(isolation.overlay).toEqual({ mcpServers: {} });
    expect(isolation.unreadable).toEqual(['.mcp.json']);
    expect(runMcpIsolationNote('claude', isolation)).toContain('could not read .mcp.json');
  });

  it('a config that parses to a non-object is unreadable, not an empty server map', () => {
    write('.mcp.json', '[]');

    expect(claudeMcpIsolation(root).unreadable).toEqual(['.mcp.json']);
  });

  it('a config with no mcp key at all is readable and simply has no servers', () => {
    write('.qwen/settings.json', { model: { name: 'local-model' } });

    const isolation = qwenMcpIsolation(root);

    expect(isolation.servers).toEqual({});
    expect(isolation.unreadable).toEqual([]);
  });

  it('every backend still builds its launch inputs when no config exists at all', () => {
    expect(() => buildClaudeArgs(spec(), {})).not.toThrow();
    expect(() =>
      buildQwenArgs(spec(), { resume: false, mcpServerNames: qwenMcpIsolation(root).allowed, systemPromptOnArgv: true }),
    ).not.toThrow();
  });

  it('a claude run whose project file is broken starts with no project MCP servers at all', () => {
    write('.mcp.json', 'not json');

    const args = buildClaudeArgs(spec(), {});

    expect(args).toContain('--strict-mcp-config');
    expect(args.at(-1)).toBe(JSON.stringify({ mcpServers: {} }));
  });
});
