import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('project kit API reads and writes the same directory', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-kit-api-'));
    store = RunStore.open(join(root, '.local/xezar'));
  });
  afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });

  it('saves and deletes workflows and merges settings in .xezar', async () => {
    const kit = '.xezar';
    mkdirSync(join(root, kit), { recursive: true });
    writeFileSync(join(root, kit, 'config.json'), '{"customKey":"preserve me"}');
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const saved = await apiRequest(app, '/api/v1/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'my chain', steps: [{ id: 'work', prompt: 'Task' }] }),
    });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ path: join(root, kit, 'workflows/my-chain.yaml') });
    const updated = await apiRequest(app, '/api/v1/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseBranch: 'develop' }),
    });
    expect(updated.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, kit, 'config.json'), 'utf8')))
      .toEqual({ customKey: 'preserve me', baseBranch: 'develop' });
    expect(existsSync(join(root, '.local/xezar/config.json'))).toBe(false);
    expect(existsSync(join(root, '.ai/xezar'))).toBe(false);
    expect((await apiRequest(app, '/api/v1/workflows/my%20chain', { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(root, kit, 'workflows/my-chain.yaml'))).toBe(false);
  });

  it('creates the first config in .xezar even when runtime has already been opened', async () => {
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const res = await apiRequest(app, '/api/v1/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'My project guidance' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, '.xezar/config.json'), 'utf8')).systemPrompt)
      .toBe('My project guidance');
    expect(existsSync(join(root, '.ai/xezar/config.json'))).toBe(false);
  });
});
