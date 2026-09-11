import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * #284, NF-02 / N-07 — a broken MCP module must never break the cockpit. The registry the
 * reference route loads lazily is made to fail here; the route answers `200 {available: false,
 * reason}` (never a 500) and the rest of the app keeps answering.
 */
vi.mock('../mcp/api-reference.ts', () => {
  throw new Error('the tool registry failed to load');
});

describe('GET /api/v1/mcp/reference when the MCP module cannot load', () => {
  let repoRoot: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-mcp-ref-broken-'));
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    app = createApp({
      repoRoot,
      store: RunStore.open(join(repoRoot, '.local/xezar')),
      manager: {} as RunManager,
      version: '0.0.0-test',
    });
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it('answers 200 {available: false, reason} with one warning, and the cockpit keeps working', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await apiRequest(app as never, '/api/v1/mcp/reference');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
      expect(body.reason).toMatch(/could not be loaded/);
      // Cached for the life of the process: a second read does not warn again.
      await apiRequest(app as never, '/api/v1/mcp/reference');
      expect(warn).toHaveBeenCalledTimes(1);
      expect((await apiRequest(app as never, '/api/v1/health')).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });
});
