// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalStateLayout, projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { createProjectStateFiles } from '../workspace/config.ts';
import { findRegistryProject, registerProject } from '../workspace/projects.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { tools } from './tools/index.ts';

/**
 * #819 item 5 — a client session started BEFORE the engine recovers by itself, with no `/mcp`
 * reconnect.
 *
 * The bridge already re-resolves its target on every call made without a live session. What it
 * did not re-resolve was its STATE LAYOUT: that was decided once, at bridge start, like every
 * other command (`index.ts`). A bridge started in a folder with no `.xezar/workspace.json` booted
 * in the GLOBAL layout and kept reading the global registry and `~/.xezar/ipc` for its whole life,
 * so once `xezar --single-project` had created the marker and opened its socket under
 * `<project>/.local/xezar/ipc`, every call still answered "not a xezar project yet" until the
 * client restarted the bridge.
 *
 * T5.1 is the regression (RED on the pre-fix source). T5.2 and T5.3 are guards on what the fix
 * must NOT do: an explicit global request never flips, and the flip is per resolution and per
 * folder — never a process-wide switch that could point a leader at another project's socket.
 */

const VERSION = '9.9.9-layout-follow';
const dirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = {
  home: process.env.XEZ_HOME,
  dryRun: process.env.XEZ_DRY_RUN,
  globalLayout: process.env.XEZ_GLOBAL_LAYOUT,
};

/** Short paths under /tmp: the per-worker sandbox is past the 104-byte socket limit on macOS. */
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xzlf-h-');
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_GLOBAL_LAYOUT;
  // The bridge process: booted in the GLOBAL layout, because the folder had no marker yet.
  setActiveStateLayout(null);
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  setActiveStateLayout(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['XEZ_HOME', saved.home],
    ['XEZ_DRY_RUN', saved.dryRun],
    ['XEZ_GLOBAL_LAYOUT', saved.globalLayout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * What `xezar --single-project` does to a folder, as far as the bridge can see: the marker, the
 * derived registry row and the project-layout socket. The engine runs in its own process, so the
 * layout is installed only for the duration of the start and the bridge's global layout restored.
 */
async function startSingleProjectEngine(root: string): Promise<{ id: string; path: string }> {
  const layout = projectStateLayout(root);
  setActiveStateLayout(layout);
  try {
    createProjectStateFiles(layout);
    const row = await findRegistryProject({ root });
    if (!row) throw new Error('the project layout derives no row');
    const handle = await startMcpService({ projectId: row.id, version: VERSION });
    closers.push(() => handle.close());
    return { id: row.id, path: handle.path };
  } finally {
    setActiveStateLayout(null);
  }
}

/** One bridge that stays up across calls, the way a client keeps its MCP server process. */
function openBridge(root: string, argv?: readonly string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const answers = new Map<number, McpToolResult>();
  const waiters = new Map<number, (result: McpToolResult) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id?: number; result?: McpToolResult };
      if (typeof message.id !== 'number' || !message.result) return;
      answers.set(message.id, message.result);
      waiters.get(message.id)?.(message.result);
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const done = runBridge({
    input,
    output,
    version: VERSION,
    tools,
    resolveTarget: () => resolveMcpTarget(root, argv === undefined ? {} : { argv }),
  });
  closers.push(async () => {
    input.end();
    await done;
  });
  let next = 1;
  return {
    async health(): Promise<McpToolResult> {
      const id = next++;
      const answer = new Promise<McpToolResult>((resolve) => {
        const known = answers.get(id);
        if (known) resolve(known);
        else waiters.set(id, resolve);
      });
      input.write(encodeFrame({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'health', arguments: {} } }));
      return answer;
    },
  };
}

const text = (result: McpToolResult): string => result.content.map((part) => part.text).join('\n');

describe('the bridge follows the folder\'s state layout on each session open (#819 item 5)', () => {
  it('T5.1: a bridge started before workspace.json exists reaches the single-project engine on the next call, no restart', async () => {
    const root = tmp('xzlf-p-');
    const bridge = openBridge(root);

    // Before the engine: the folder is nobody's project yet, and the bridge says so.
    const before = await bridge.health();
    expect(before.isError).toBe(true);
    expect(text(before)).toContain('This directory is not a xezar project yet');

    const engine = await startSingleProjectEngine(root);
    expect(engine.path.startsWith(join(root, '.local', 'xezar', 'ipc'))).toBe(true);

    // The SAME bridge — no reconnect — now reaches the engine for this folder.
    const after = await bridge.health();
    expect(text(after)).toContain(`(${engine.id})`);
    expect(after.isError).toBeFalsy();
  }, 30_000);

  it('T5.2: an explicit global layout never flips — neither the flag nor XEZ_GLOBAL_LAYOUT=1', async () => {
    const root = tmp('xzlf-g-');
    // An earlier GLOBAL cockpit registered the folder, so the global lookup has a row to find.
    const globalRow = await registerProject(root);
    await startSingleProjectEngine(root);
    const globalSocketDir = globalStateLayout().ipcDir;

    const byFlag = await resolveMcpTarget(root, { argv: ['mcp', '--global-layout'] });
    expect(byFlag).toMatchObject({ kind: 'socket', project: { id: globalRow.id } });
    expect((byFlag as { path: string }).path.startsWith(globalSocketDir)).toBe(true);

    process.env.XEZ_GLOBAL_LAYOUT = '1';
    const byEnv = await resolveMcpTarget(root, { argv: ['mcp'] });
    expect((byEnv as { path: string }).path.startsWith(globalSocketDir)).toBe(true);

    // Guard on the positive side: without the explicit ask the same folder follows its marker.
    delete process.env.XEZ_GLOBAL_LAYOUT;
    const followed = await resolveMcpTarget(root, { argv: ['mcp'] });
    expect((followed as { path: string }).path.startsWith(join(root, '.local', 'xezar', 'ipc'))).toBe(true);
  }, 30_000);

  it('T5.3: a bridge in folder A is never pointed at folder B\'s socket, even when both derive the same id', async () => {
    // Same basename, so both folders derive the same project id: only the folder tells them apart.
    const a = join(tmp('xzlf-a-'), 'app');
    const b = join(tmp('xzlf-b-'), 'app');
    mkdirSync(a);
    mkdirSync(b);
    const engineB = await startSingleProjectEngine(b);

    // B flipped first. If that flip leaked into the process, A would now read B's layout.
    const targetB = await resolveMcpTarget(b, { argv: ['mcp'] });
    expect(targetB).toMatchObject({ kind: 'socket', path: engineB.path });

    // A has no marker: it is nobody's project, and certainly not B's.
    const bareA = await resolveMcpTarget(a, { argv: ['mcp'] });
    expect(bareA).toMatchObject({ kind: 'unavailable', status: 'not-registered' });

    // A gets its own marker: its door is under A, never B's, although the ids are equal.
    createProjectStateFiles(projectStateLayout(a));
    const ownA = await resolveMcpTarget(a, { argv: ['mcp'] });
    expect(ownA).toMatchObject({ kind: 'socket', project: { id: engineB.id } });
    const pathA = (ownA as { path: string }).path;
    expect(pathA).not.toBe(engineB.path);
    expect(pathA.startsWith(join(a, '.local', 'xezar', 'ipc'))).toBe(true);
  }, 30_000);
});
