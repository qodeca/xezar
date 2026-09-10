import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { readRunHistoryPage } from '../runs/event-history.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xez-history-http-'));
  roots.push(root);
  const dataDir = join(root, '.local/xezar');
  const store = RunStore.open(dataDir);
  const run = store.createRun({ title: 'history', task: 'history', workflow: 'quick-task', steps: [] });
  store.appendEvent(run.id, { type: 'note', message: 'genuine' });
  store.appendEvent(run.id, { type: 'note', message: 'mock' });
  store.flush();
  const path = join(dataDir, 'runs', `${run.id}.ndjson`);
  const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: '0.0.0-test' });
  return { app, path, run };
}

it.each(['/api/v1', '/api/v1/p/default'])('returns structured 409 for malformed correction evidence in already built %s contexts', async (prefix) => {
  const { app, path, run } = fixture();
  const base = `${prefix}/runs/${run.id}`;
  expect((await apiRequest(app, `${base}/history`)).status).toBe(200);
  const cursor = (await readRunHistoryPage(path)).liveCursor;
  writeFileSync(`${path}.corrections.json`, '{invalid');
  for (const suffix of ['/history', '/history-context', '/events', '/events?afterSeq=1', `/events?cursor=${cursor}`]) {
    const response = await apiRequest(app, base + suffix);
    expect(response.status, suffix).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringContaining('history correction cannot be verified') });
  }
});

it('rejects stale legacy/header resumes and replays only genuine records through a fresh SSE connection', async () => {
  const { app, path, run } = fixture();
  const raw = readFileSync(path);
  const excludedOffset = raw.indexOf(0x0a) + 1;
  const excluded = raw.subarray(excludedOffset);
  writeFileSync(`${path}.corrections.json`, JSON.stringify({
    version: 1, incident: 'http-test', prefixBytes: raw.length, prefixSha256: hash(raw),
    exclusions: [{ offset: excludedOffset, length: excluded.length, sha256: hash(excluded) }],
  }));
  const base = `/api/v1/runs/${run.id}/events`;
  expect((await apiRequest(app, `${base}?afterSeq=2`)).status).toBe(409);
  expect((await apiRequest(app, base, { headers: { 'Last-Event-ID': '2' } })).status).toBe(409);
  const response = await apiRequest(app, base);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing SSE body');
  let text = '';
  try {
    while (!text.includes('event: run\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
  } finally { await reader.cancel(); }
  expect(text).toContain('genuine');
  expect(text).not.toContain('mock');
  expect(readFileSync(path)).toEqual(raw);
});
