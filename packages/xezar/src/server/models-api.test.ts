import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_DISCOVERY_RUNNERS } from '@qodeca/xezar-contract';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

describe('workspace model catalog API', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-models-api-'));
    store = RunStore.open(join(root, '.local/xezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(root, TEST_DIR_RM_OPTIONS);
  });

  type Discover = () => Promise<Array<{ id: string; label: string; description: string }>>;

  /** Claude and Codex share one adapter here — the route contract is what is under test, and each
   *  adapter's own wire handling lives in its `*-model-catalog.test.ts`. Qwen Code takes its
   *  own so a per-runner assertion can tell the answers apart. */
  const app = (discover: Discover, qwenDiscover: Discover = discover) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          claude: { discover },
          codex: { discover },
          qwen: { discover: qwenDiscover },
        },
      }),
    });

  it.each([
    ['codex', 'gpt-future'],
    ['claude', 'opus[1m]'],
  ])('GUARD — returns %s\'s discovered catalog and reuses its cache', async (runner, id) => {
    let calls = 0;
    const server = app(async () => {
      calls += 1;
      return [{ id, label: 'Newest', description: 'Newly available' }];
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await apiRequest(server, `/api/v1/models?runner=${runner}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runner,
        models: [{ id }],
        source: i === 0 ? 'live' : 'cache',
        stale: false,
      });
    }
    expect(calls).toBe(1);
  });

  it('GUARD — caches each runner separately', async () => {
    const seen: string[] = [];
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          claude: { discover: async () => (seen.push('claude'), [{ id: 'sonnet', label: 'Sonnet', description: '' }]) },
          codex: { discover: async () => (seen.push('codex'), [{ id: 'gpt-future', label: 'GPT', description: '' }]) },
        },
      }),
    });
    const claude = await (await apiRequest(server, '/api/v1/models?runner=claude')).json();
    const codex = await (await apiRequest(server, '/api/v1/models?runner=codex')).json();
    expect(claude).toMatchObject({ runner: 'claude', models: [{ id: 'sonnet' }] });
    expect(codex).toMatchObject({ runner: 'codex', models: [{ id: 'gpt-future' }] });
    expect(seen).toEqual(['claude', 'codex']);
  });

  it.each([
    ['codex', 'Codex model discovery is temporarily unavailable'],
    ['claude', 'Claude model discovery is temporarily unavailable'],
  ])('GUARD — degrades %s discovery failures to an unavailable 200 response', async (runner, reason) => {
    const response = await apiRequest(
      app(async () => { throw new Error('secret detail'); }),
      `/api/v1/models?runner=${runner}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner, models: [], source: 'unavailable', stale: false, reason,
    });
  });

  it('GUARD — answers the Qwen Code catalog too, from its own adapter', async () => {
    const server = app(
      async () => [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }],
      async () => [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=qwen');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'qwen',
      models: [{ id: 'openai/gpt-5.4', description: 'via openai' }],
      source: 'live',
    });
  });

  it('GUARD — degrades a Qwen Code discovery failure the same way, under its own name', async () => {
    const server = app(async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=qwen');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'qwen', models: [], source: 'unavailable', stale: false,
      reason: 'Qwen Code model discovery is temporarily unavailable',
    });
  });

  it('a host with no Qwen Code model config is an empty catalog, not an error', async () => {
    const server = app(async () => [], async () => []);
    const response = await apiRequest(server, '/api/v1/models?runner=qwen');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runner: 'qwen', models: [], source: 'live' });
  });

  // Every runner xezar ships now discovers, so only a MISSING or unknown `runner` is rejected.
  it.each(['/api/v1/models', '/api/v1/models?runner=nope'])('rejects invalid query %s', async (path) => {
    const response = await apiRequest(app(async () => []), path);
    expect(response.status).toBe(400);
    // Derived from the contract's own list, never spelled out: the literal message this replaced
    // named three runners and went stale the moment a runner gained a catalog (#152).
    expect(await response.json()).toEqual({
      error: `runner must be one of: ${MODEL_DISCOVERY_RUNNERS.join(', ')}`,
    });
    expect(MODEL_DISCOVERY_RUNNERS).toContain('qwen');
  });

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });
});
