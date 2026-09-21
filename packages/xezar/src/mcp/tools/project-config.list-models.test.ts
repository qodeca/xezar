// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './mcp-test-home.testkit.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listModelsResultSchema, runnerSchema } from '@qodeca/xezar-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerModelCatalog, type ModelOption } from '../../core/runner-model-catalog.ts';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import type { McpToolResult } from '../tool.ts';
import { projectConfigTool, type ProjectConfigContext } from './project-config.ts';

/**
 * `project_config list_models` (#819 item 4): the models each agent tool can be dispatched to,
 * read through the cockpit's own `GET /api/v1/models`, so a leader can route "tool + model"
 * without reading the tools' config files by hand.
 *
 * The fixture drives the REAL app with an injected `RunnerModelCatalog` whose adapters are fakes:
 * the catalog's own cache and its unavailable-with-reason degradation run for real, and no vendor
 * CLI is ever spawned.
 */

const COCKPIT_HOST = '127.0.0.1:4321';
const dirs: string[] = [];
const stores: RunStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CLAUDE_MODELS: ModelOption[] = [
  { id: 'opus[1m]', label: 'Opus', description: 'most capable' },
  { id: 'sonnet', label: 'Sonnet', description: 'everyday' },
];
const PI_MODELS: ModelOption[] = [
  { id: 'dgx-spark/deepseek-v4-flash-vision', label: 'dgx-spark/deepseek-v4-flash-vision', description: 'via DGX', local: true, vision: true },
  { id: 'deepseek-api/deepseek-flash', label: 'deepseek-api/deepseek-flash', description: 'via DeepSeek API', vision: true },
];
const CODEX_MODELS: ModelOption[] = [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: '', vision: true }];

/** Claude, Codex and pi answer; OpenCode's discovery fails, so its row is the unavailable one. */
function catalog(): RunnerModelCatalog {
  return new RunnerModelCatalog({
    adapters: {
      claude: { discover: async () => CLAUDE_MODELS },
      codex: { discover: async () => CODEX_MODELS },
      opencode: { discover: async () => { throw new Error('opencode: command not found'); } },
      pi: { discover: async () => PI_MODELS },
    },
  });
}

function app(opts: { bindHost?: string } = {}): { app: ReturnType<typeof createApp>; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xez-list-models-')));
  dirs.push(root);
  const store = RunStore.open(join(root, '.local/xezar'), { keepLive: true });
  stores.push(store);
  const semaphore = new WorkspaceSemaphore();
  const projects: ProjectContextSource[] = [{ id: 'proj-a', root, status: 'ok' }];
  const built = createApp({
    repoRoot: root,
    store,
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'proj-a',
    contexts: new ProjectContexts({ listProjects: async () => projects, semaphore }),
    semaphore,
    providerAuth: connectedProviderAuth(),
    modelCatalog: catalog(),
    ...(opts.bindHost === undefined ? {} : { bindHost: opts.bindHost }),
  });
  return { app: built, root };
}

interface Called {
  result: McpToolResult;
  text: string;
  structured: any;
}

async function invoke(service: ServiceDispatch, root: string, args: Record<string, unknown>): Promise<Called> {
  const ctx: ProjectConfigContext = {
    project: { id: 'proj-a', name: 'Project A', root },
    xezarVersion: '0.0.0-test',
    service,
  };
  const parsed = projectConfigTool.inputSchema.safeParse(args);
  const result: McpToolResult = parsed.success
    ? await projectConfigTool.call(parsed.data, ctx)
    : { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
  return { result, text, structured: result.structuredContent };
}

const value = (called: Called) => {
  expect(called.result.isError, called.text).toBeFalsy();
  return called.structured.result;
};

describe('project_config list_models (#819 item 4)', () => {
  /**
   * T4.1. Named breaks: the action does not exist (the engine before #819 PR 8 answers an invalid
   * option), an unavailable catalog is thrown or filtered out instead of answered as a row with its
   * reason, or a row stops being the route's own answer.
   */
  it('answers one row per tool — the route’s own catalog, the unavailable tool included with its reason', async () => {
    const { app: service, root } = app();
    const result = value(await invoke(service, root, { action: 'list_models' }));

    // The shape is the contract's, not a hand-written one.
    expect(listModelsResultSchema.parse(result)).toEqual(result);
    expect(result.tools.map((row: { tool: string }) => row.tool)).toEqual(runnerSchema.options);

    const byTool = Object.fromEntries(result.tools.map((row: { tool: string }) => [row.tool, row]));
    expect(byTool.claude).toEqual({ tool: 'claude', available: true, source: 'live', stale: false, models: CLAUDE_MODELS });
    expect(byTool.codex).toEqual({ tool: 'codex', available: true, source: 'live', stale: false, models: CODEX_MODELS });
    expect(byTool.pi).toEqual({ tool: 'pi', available: true, source: 'live', stale: false, models: PI_MODELS });
    // Wanted, not filtered out: the tool whose catalog cannot be read answers WHY.
    expect(byTool.opencode).toEqual({
      tool: 'opencode',
      available: false,
      source: 'unavailable',
      stale: false,
      reason: 'OpenCode model discovery is temporarily unavailable',
      models: [],
    });

    // Every row is exactly what the cockpit's own route answers for that tool. The route's second
    // answer comes from the catalog's cache, so only `source` may differ — and it says so.
    for (const row of result.tools as Array<{ tool: string }>) {
      const res = await service.request(`http://${COCKPIT_HOST}/api/v1/models?runner=${row.tool}`, { headers: { host: COCKPIT_HOST } });
      const { runner: _runner, source: routeSource, ...route } = (await res.json()) as Record<string, unknown>;
      const { tool: _tool, available: _available, source, ...mine } = row as Record<string, unknown>;
      expect(mine).toEqual(route);
      expect(routeSource).toBe(source === 'unavailable' ? 'unavailable' : 'cache');
    }
  });

  it('narrows to one tool when provider is named, and the model id stays reconstructible as <tool>/<model>', async () => {
    const { app: service, root } = app();
    const result = value(await invoke(service, root, { action: 'list_models', provider: 'pi' }));
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].tool).toBe('pi');
    // pi's own `--model` takes `provider/id`, so the id is carried whole and never split or relabelled.
    expect(result.tools[0].models.map((m: ModelOption) => `${result.tools[0].tool}/${m.id}`)).toEqual([
      'pi/dgx-spark/deepseek-v4-flash-vision',
      'pi/deepseek-api/deepseek-flash',
    ]);
  });

  /**
   * T4.2 at the door. Named break: a `false` default for an unknown `local`/`vision` (a mapping that
   * writes `local: m.local ?? false`). Claude's catalog proves neither, so neither key may appear.
   */
  it('omits local and vision where the source does not prove them — never false for unknown', async () => {
    const { app: service, root } = app();
    const result = value(await invoke(service, root, { action: 'list_models', provider: 'claude' }));
    for (const model of result.tools[0].models as Array<Record<string, unknown>>) {
      expect('local' in model, JSON.stringify(model)).toBe(false);
      expect('vision' in model, JSON.stringify(model)).toBe(false);
    }
    // And the pi row keeps exactly what its source proved: local only on the loopback provider.
    const pi = value(await invoke(service, root, { action: 'list_models', provider: 'pi' })).tools[0].models;
    expect(pi[0]).toMatchObject({ local: true, vision: true });
    expect('local' in pi[1]).toBe(false);
  });

  it('is a read: it refuses an operation key and dispatches only GET /models', async () => {
    const requests: string[] = [];
    const { app: real, root } = app();
    const spy: ServiceDispatch = {
      request(url: string, init?: RequestInit) {
        requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}${new URL(url).search}`);
        return real.request(url, init);
      },
    };
    const refused = await invoke(spy, root, { action: 'list_models', operationId: 'op-list-models-1' });
    expect(refused.result.isError).toBe(true);
    expect(requests).toEqual([]);

    value(await invoke(spy, root, { action: 'list_models', provider: 'codex' }));
    expect(requests).toEqual(['GET /api/v1/models?runner=codex']);
  });

  /**
   * P8-AC5. Named break: gating the read on `localHandoff` (a hosted cockpit answering 409 or an
   * error). The model catalog is a read like the rest of the read surface, so hosted mode answers it.
   */
  it('answers in hosted mode like the rest of the read surface', async () => {
    const { app: service, root } = app({ bindHost: '0.0.0.0' });
    const health = (await (await service.request('/api/v1/health', { headers: { host: COCKPIT_HOST } })).json()) as {
      capabilities: { localHandoff: boolean };
    };
    expect(health.capabilities.localHandoff, 'the fixture really is hosted').toBe(false);
    const result = value(await invoke(service, root, { action: 'list_models', provider: 'claude' }));
    expect(result.tools[0]).toMatchObject({ tool: 'claude', available: true, models: CLAUDE_MODELS });
  });

  /**
   * P8-AC3 guard. Named break: growing `get_capabilities` with the model catalog instead of adding
   * an action — the consumer feature-detects `list_models` and keeps `get_capabilities` cheap, so its
   * answer keeps exactly its three keys and dispatches no `/models` request.
   */
  it('leaves get_capabilities exactly as it was: three keys, no model catalog read', async () => {
    const requests: string[] = [];
    const { app: real, root } = app();
    const spy: ServiceDispatch = {
      request(url: string, init?: RequestInit) {
        requests.push(new URL(url).pathname);
        return real.request(url, init);
      },
    };
    const result = value(await invoke(spy, root, { action: 'get_capabilities' }));
    expect(Object.keys(result).sort()).toEqual(['capabilities', 'providers', 'tools']);
    expect(requests.sort()).toEqual(['/api/v1/health', '/api/v1/providers/status']);
  });
});
