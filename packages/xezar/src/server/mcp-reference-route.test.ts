import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpApiReferenceSchema } from '@qodeca/xezar-contract';
import { REFUSED_ARGUMENTS } from '../mcp/api-reference.ts';
import { HEALTH_TOOL, runBridge } from '../mcp/bridge.ts';
import { LineFramer, encodeFrame } from '../mcp/ipc.ts';
import { toolListing } from '../mcp/tool.ts';
import { tools } from '../mcp/tools/index.ts';
import { REFUSED_ACTIONS } from '../mcp/tools/project-config.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';

/**
 * #284 — `GET /api/v1/mcp/reference`, the one route behind Settings → MCP API.
 *
 * The page must never disagree with the wire, so the route's `tools` is held to the live
 * `[HEALTH_TOOL, ...tools.map(toolListing)]`, to what a real in-process bridge answers to
 * `tools/list`, and to the committed `mcp-api.json` — three ways (spec DR-04). No MCP service is
 * started anywhere in this file: the app below has none, which is exactly the "MCP did not start"
 * machine the reference must still serve (N-07).
 */

const API_JSON = join(import.meta.dirname, '../../../../docs/features/mcp-server/mcp-api.json');
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** What a real bridge answers to `tools/list`, driven in process over two in-memory pipes. */
async function bridgeToolsList(): Promise<unknown> {
  const input = new PassThrough();
  const output = new PassThrough();
  const answer = new Promise<unknown>((resolve) => {
    const framer = new LineFramer(
      (line) => resolve((JSON.parse(line) as { result: { tools: unknown } }).result.tools),
      () => {},
    );
    output.on('data', (chunk: Buffer) => framer.push(chunk));
  });
  const done = runBridge({
    input,
    output,
    version: '0.0.0-test',
    tools,
    resolveTarget: async () => ({ kind: 'unavailable', status: 'not-registered', message: 'no service in this test' }),
  });
  input.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  const tools_ = await answer;
  input.end();
  await done;
  return tools_;
}

describe('GET /api/v1/mcp/reference (#284)', () => {
  const saved = { home: process.env.XEZ_HOME, remote: process.env.XEZ_REMOTE };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let bootId: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'xez-mcp-ref-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-mcp-ref-boot-'));
    process.env.XEZ_HOME = home;
    delete process.env.XEZ_REMOTE;
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    contexts = new ProjectContexts({ listProjects });
    bootId = (await registerProject(repoRoot)).id;
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', contexts });
  });

  afterEach(async () => {
    await contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = saved.home;
    if (saved.remote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = saved.remote;
  });

  const read = async (path = '/api/v1/mcp/reference') => {
    const res = await apiRequest(app as never, path);
    return { status: res.status, text: await res.text() };
  };

  it('answers exactly the tools/list the bridge sends, with no MCP service running', async () => {
    const { status, text } = await read();
    expect(status).toBe(200);
    const body = mcpApiReferenceSchema.parse(JSON.parse(text));
    if (!body.available) throw new Error(`unavailable: ${body.reason}`);
    const live = json([HEALTH_TOOL, ...tools.map(toolListing)]);
    expect(body.tools).toEqual(live);
    // Key order too: the page shows the tool the way the wire and the JSON diff show it.
    expect(JSON.stringify(body.tools)).toBe(JSON.stringify(live));
    expect(body.tools).toEqual(await bridgeToolsList());
    expect(body.tools).toEqual(JSON.parse(readFileSync(API_JSON, 'utf8')));
    expect(body.xezarVersion).toBe('0.0.0-test');
    expect(body.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('carries every refusal-only action and every declared refused argument, from the live tools', async () => {
    const body = mcpApiReferenceSchema.parse(JSON.parse((await read()).text));
    if (!body.available) throw new Error('unavailable');
    expect(body.refusedActions.map((r) => r.action).sort()).toEqual(Object.keys(REFUSED_ACTIONS).sort());
    for (const r of body.refusedActions) {
      expect(r.tool).toBe('project_config');
      expect(r.reason).toBe(REFUSED_ACTIONS[r.action as keyof typeof REFUSED_ACTIONS].reason);
    }
    // A declared refused argument that vanished from the listing would drop off the page silently.
    expect(body.refusedArguments.map((r) => `${r.tool}.${r.argument}`)).toEqual(
      REFUSED_ARGUMENTS.map((r) => `${r.tool}.${r.argument}`),
    );
    expect(body.refusedArguments[0]?.reason).toMatch(/^Never accepted/);
    expect(body.notExposed.length).toBeGreaterThan(0);
  });

  it('answers byte-identically under the project-scoped spellings', async () => {
    const plain = await read();
    for (const path of [`/api/v1/p/${bootId}/mcp/reference`, '/api/v1/p/default/mcp/reference']) {
      expect(await read(path)).toEqual(plain);
    }
  });

  it('answers in hosted mode too: it carries no path, project, account identity or secret', async () => {
    process.env.XEZ_REMOTE = '1';
    const { status, text } = await read();
    expect(status).toBe(200);
    expect(JSON.parse(text).available).toBe(true);
    expect(text).not.toContain(repoRoot);
    expect(text).not.toContain(home);
    expect(text).not.toContain(`"${bootId}"`);
    expect(text).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/\b(ghp_|gho_|github_pat_|sk-ant-|xox[abp]-)/);
  });

  it('is a read and nothing else: the same answer every time, and no verb that could run a tool', async () => {
    expect(await read()).toEqual(await read());
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await apiRequest(app as never, '/api/v1/mcp/reference', {
        method,
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
        body: method === 'DELETE' ? null : '{}',
      });
      expect(res.status, method).toBe(404);
    }
  });
});
