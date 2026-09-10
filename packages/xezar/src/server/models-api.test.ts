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

describe('workspace model catalog API', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-models-api-'));
    store = RunStore.open(join(root, '.local/xezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  type Discover = () => Promise<Array<{ id: string; label: string; description: string }>>;

  /** Claude and Codex share one adapter here — the route contract is what is under test, and each
   *  adapter's own wire handling lives in its `*-model-catalog.test.ts`. OpenCode and pi each take
   *  their own so a per-runner assertion can tell the answers apart. */
  const app = (discover: Discover, opencodeDiscover: Discover = discover, piDiscover: Discover = discover) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          claude: { discover },
          codex: { discover },
          opencode: { discover: opencodeDiscover },
          pi: { discover: piDiscover },
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

  it('GUARD — answers the OpenCode catalog too — the runner that used to have no discovery path (#794)', async () => {
    const server = app(
      async () => [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }],
      async () => [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'opencode',
      models: [{ id: 'openai/gpt-5.4', description: 'via openai' }],
      source: 'live',
    });
  });

  it('GUARD — degrades an OpenCode discovery failure the same way', async () => {
    const server = app(async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'opencode', models: [], source: 'unavailable', stale: false,
      reason: 'OpenCode model discovery is temporarily unavailable',
    });
  });

  it('answers the pi catalog — the last runner that had no discovery path (#152)', async () => {
    // Before this, `?runner=pi` 400d, so the cockpit fell back to three hard-coded vendor ids the
    // host had no provider for. The route now answers with what pi is actually configured with.
    const server = app(
      async () => [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }],
      async () => [],
      async () => [{
        id: 'dgx-spark/deepseek-v4-flash-vision',
        label: 'dgx-spark/deepseek-v4-flash-vision',
        description: 'via DGX Spark',
      }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'pi',
      models: [{ id: 'dgx-spark/deepseek-v4-flash-vision', description: 'via DGX Spark' }],
      source: 'live',
    });
  });

  it('degrades a pi discovery failure the same way, under its own name', async () => {
    // The reason must name pi. The chained ternary this replaced fell through to "OpenCode" for
    // any unrecognized runner, so pi's first failure would have blamed another backend.
    const server = app(async () => [], async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'pi', models: [], source: 'unavailable', stale: false,
      reason: 'pi model discovery is temporarily unavailable',
    });
  });

  it('a host with no pi config is an empty catalog, not an error', async () => {
    const server = app(async () => [], async () => [], async () => []);
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runner: 'pi', models: [], source: 'live' });
  });

  // Every runner xezar ships now discovers, so only a MISSING or unknown `runner` is rejected.
  it.each(['/api/v1/models', '/api/v1/models?runner=nope'])('rejects invalid query %s', async (path) => {
    const response = await apiRequest(app(async () => []), path);
    expect(response.status).toBe(400);
    // Derived from the contract's own list, never spelled out: the literal message this replaced
    // named three runners and went stale the moment pi gained a catalog (#152).
    expect(await response.json()).toEqual({
      error: `runner must be one of: ${MODEL_DISCOVERY_RUNNERS.join(', ')}`,
    });
    expect(MODEL_DISCOVERY_RUNNERS).toContain('pi');
  });

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });
});
