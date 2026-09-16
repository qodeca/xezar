/**
 * AC-07 at the Hono boundary (#467, PR 3) — the diagnostic hook against the REAL route table.
 *
 * The unit tests beside the renderer pin what a diagnostic line says; these pin that the hook
 * fires at all, for the two cases that behave completely differently inside hono:
 *
 * - a 4xx a handler RETURNED — not an exception, nothing logged it before this change, and the
 *   only evidence a person had was a cockpit that did not do what they asked
 *   (`returned-error-invisible`);
 * - a 5xx something THREW — which hono turns into a response of its own, and which must be
 *   reported exactly once rather than twice (`double-error-log`).
 *
 * And the invariant that licenses the whole thing: with no hook, not one middleware is
 * registered and the responses are byte-identical.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

import type { Hono } from 'hono';
import type { RunManager } from '../workflows/run.js';
import type { HttpFailure } from '../terminal/http-diagnostics.js';

describe('the HTTP diagnostic hook', () => {
  let repoRoot: string;
  let store: RunStore;
  let failures: HttpFailure[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-http-diag-'));
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    failures = [];
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function build(over: Record<string, unknown> = {}): Hono {
    return createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      onHttpFailure: (failure: HttpFailure) => failures.push(failure),
      ...over,
    }) as unknown as Hono;
  }

  /** The hook is async by design (it reads a CLONE of the body), so give it a turn to land. */
  const settle = () => new Promise((r) => setImmediate(r));

  it('reports a RETURNED 404 once, with the method and a template', async () => {
    const app = build();
    const res = await apiRequest(app, '/api/v1/runs/does-not-exist');
    expect(res.status).toBe(404);
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ method: 'GET', status: 404 });
    expect(failures[0]?.route).toContain('/api/v1/runs');
  });

  it('reports a RETURNED 400 and carries the server’s own message', async () => {
    const app = build();
    const res = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ totalNonsense: 12345 }),
    });
    expect(res.status).toBe(400);
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.status).toBe(400);
    expect(typeof failures[0]?.message).toBe('string');
  });

  it('reports a request the ORIGIN GUARD refused, which never reached a route', async () => {
    const app = build();
    const res = await app.request('http://127.0.0.1:4321/api/v1/runs', {
      method: 'POST',
      headers: { host: '127.0.0.1:4321', origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('origin');
    // The template is masked from the path, because no route matched — and it carries no query
    // string and no real identifier.
    expect(failures[0]?.route).toBe('/api/v1/runs');
  });

  it('never reports a request that succeeded', async () => {
    const app = build();
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.status).toBe(200);
    await settle();
    expect(failures).toEqual([]);
  });

  it('reports a THROWN error once, not twice', async () => {
    // `double-error-log`: the throw and the 500 it becomes are the same event.
    //
    // The throw comes from a REAL route rather than one this test registers: hono dispatches in
    // registration order and the app already ends in an SPA catch-all, so a route added
    // afterwards is never reached. A manager whose `cancel` does not exist is what a handler
    // meets when its dependency is broken, which is the shape of a real 500.
    const app = createApp({
      repoRoot,
      store,
      manager: {
        cancel: () => {
          throw new Error('deliberate');
        },
      } as unknown as RunManager,
      version: '0.0.0-test',
      onHttpFailure: (failure: HttpFailure) => failures.push(failure),
    }) as unknown as Hono;
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });

    const res = await apiRequest(app, `/api/v1/runs/${run.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(500);
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: 500, method: 'POST' });
    expect(failures[0]?.route).toContain('/runs/:id/cancel');
  });

  it('leaves the response untouched — status, headers and body', async () => {
    const withHook = build();
    const hooked = await apiRequest(withHook, '/api/v1/runs/does-not-exist');
    const hookedBody = await hooked.text();

    failures = [];
    const without = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
    }) as unknown as Hono;
    const plain = await apiRequest(without, '/api/v1/runs/does-not-exist');
    const plainBody = await plain.text();

    expect(hooked.status).toBe(plain.status);
    expect(hookedBody).toBe(plainBody);
    expect(hooked.headers.get('content-type')).toBe(plain.headers.get('content-type'));
    // And with no hook, nothing was recorded — the middleware was never registered.
    expect(failures).toEqual([]);
  });

  it('never reports the same failure twice for one request', async () => {
    const app = build();
    await apiRequest(app, '/api/v1/runs/does-not-exist');
    await apiRequest(app, '/api/v1/runs/does-not-exist');
    await settle();
    // Two requests, two lines. The folding that turns a repeat into a count happens in the
    // recorder, not here: this hook reports what really happened, once each.
    expect(failures).toHaveLength(2);
  });
});
