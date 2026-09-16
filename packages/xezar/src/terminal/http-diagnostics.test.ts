/**
 * AC-07 — a returned 4xx and a thrown 5xx each produce ONE safe diagnostic at the right level,
 * and nothing about the request that should stay private reaches the terminal.
 *
 * Named breaks proven here: `returned-error-invisible` (a handler that returns a 409 is not an
 * exception and used to leave no trace at all) and `double-error-log`.
 */

import { describe, expect, it } from 'vitest';

import {
  FOLD_WINDOW_MS,
  HttpDiagnostics,
  httpDiagnosticsMiddleware,
  levelForStatus,
  maskPath,
  routeTemplateFor,
} from './http-diagnostics.ts';
import { UTF8_GLYPHS } from './format.ts';

import type { ActivityEntry } from './activity.ts';

function harness() {
  const entries: ActivityEntry[] = [];
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const http = new HttpDiagnostics({
    emit: (e) => entries.push(e),
    glyphs: UTF8_GLYPHS,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  return {
    http,
    entries,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    fields(index: number) {
      return Object.fromEntries((entries[index]?.fields ?? []).map((f) => [f[0], f[1]]));
    },
  };
}

describe('levels', () => {
  it('follows the design table exactly', () => {
    expect(levelForStatus(500)).toBe('error');
    expect(levelForStatus(503)).toBe('error');
    for (const status of [400, 401, 403, 409, 413, 422]) {
      expect(levelForStatus(status), String(status)).toBe('warn');
    }
    // A cockpit asking for a task that has been deleted is routine, not something to shout.
    expect(levelForStatus(404)).toBe('debug');
    expect(levelForStatus(418)).toBe('debug');
  });
});

describe('one line per failure', () => {
  it('reports a RETURNED 409 with the method, the template and the server’s own message', () => {
    // `returned-error-invisible`.
    const h = harness();
    h.http.record({
      method: 'POST',
      route: '/api/v1/p/:projectId/runs/:id/finish',
      status: 409,
      message: 'no open session',
    });
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.subject).toBe('http');
    expect(h.entries[0]?.level).toBe('warn');
    expect(h.entries[0]?.message).toBe('409 POST /api/v1/p/:projectId/runs/:id/finish');
    expect(h.entries[0]?.continuation).toEqual(['“no open session”']);
    expect(h.entries[0]?.event).toBe('http.refused');
  });

  it('reports a 500 as an error under its own event name', () => {
    const h = harness();
    h.http.record({ method: 'GET', route: '/api/v1/p/:projectId/runs/:id/diff', status: 500, message: 'internal error' });
    expect(h.entries[0]?.level).toBe('error');
    expect(h.entries[0]?.event).toBe('http.error');
  });

  it('marks an origin-guard refusal with its reason', () => {
    const h = harness();
    h.http.record({
      method: 'POST',
      route: '/api/v1/p/:projectId/runs',
      status: 403,
      message: 'forbidden: cross-origin request rejected (same-origin only)',
      reason: 'origin',
    });
    expect(h.fields(0).reason).toBe('origin');
  });

  it('cleans a server message before it is quoted', () => {
    const h = harness();
    h.http.record({ method: 'GET', route: '/api/v1/health', status: 500, message: 'bad \u001b[2Jthing\nsecond line' });
    expect(h.entries[0]?.continuation?.[0]).toBe('“bad thing second line”');
  });

  it('carries a correlation id in the machine fields and never in the human line', () => {
    const h = harness();
    h.http.record({ method: 'GET', route: '/api/v1/models', status: 500 });
    expect(String(h.fields(0).request_id)).toMatch(/^[0-9a-f]{8}$/);
    expect(h.entries[0]?.message).not.toContain(String(h.fields(0).request_id));
  });
});

describe('repeat folding', () => {
  it('prints the first, counts the rest, and reports the count when the window closes', () => {
    const h = harness();
    const failure = { method: 'POST', route: '/api/v1/p/:projectId/runs/:id/finish', status: 409, message: 'no open session' };
    h.http.record(failure);
    for (let i = 0; i < 14; i++) h.http.record(failure);
    expect(h.entries).toHaveLength(1);
    h.advance(FOLD_WINDOW_MS);
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1]?.continuation).toEqual(['repeated 14 times in 10s']);
    expect(h.entries[1]?.event).toBe('http.repeated');
    expect(h.fields(1)).toMatchObject({ count: 14, window_ms: FOLD_WINDOW_MS });
  });

  it('keeps the same level for the fold line as for the failure it counts', () => {
    const h = harness();
    const failure = { method: 'GET', route: '/api/v1/x', status: 500 };
    h.http.record(failure);
    h.http.record(failure);
    h.advance(FOLD_WINDOW_MS);
    expect(h.entries[1]?.level).toBe('error');
  });

  it('folds only the SAME method, route and status together', () => {
    const h = harness();
    h.http.record({ method: 'POST', route: '/a', status: 409 });
    h.http.record({ method: 'GET', route: '/a', status: 409 });
    h.http.record({ method: 'POST', route: '/b', status: 409 });
    h.http.record({ method: 'POST', route: '/a', status: 500 });
    expect(h.entries).toHaveLength(4);
  });

  it('starts a new window after the old one closed, printing the first again', () => {
    const h = harness();
    const failure = { method: 'POST', route: '/a', status: 409 };
    h.http.record(failure);
    h.advance(FOLD_WINDOW_MS + 1);
    h.http.record(failure);
    expect(h.entries.filter((e) => e.event === 'http.refused')).toHaveLength(2);
  });

  it('flushes a pending count at shutdown, so no repeat is ever lost', () => {
    const h = harness();
    const failure = { method: 'POST', route: '/a', status: 409 };
    h.http.record(failure);
    h.http.record(failure);
    h.http.record(failure);
    h.http.stop();
    expect(h.entries.at(-1)?.event).toBe('http.repeated');
    expect(h.fields(h.entries.length - 1).count).toBe(2);
  });

  it('records nothing after stop', () => {
    const h = harness();
    h.http.stop();
    h.http.record({ method: 'GET', route: '/a', status: 500 });
    expect(h.entries).toHaveLength(0);
  });
});

describe('the middleware', () => {
  function ctx(over: Partial<{ method: string; path: string; routePath: string }> = {}) {
    return {
      req: { method: 'GET', path: '/api/v1/runs/0f8a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b', ...over },
      res: undefined as Response | undefined,
    };
  }

  const settle = () => new Promise((r) => setImmediate(r));

  it('reports a THROWN error as a 500 and re-throws it, so hono still handles it', async () => {
    const seen: unknown[] = [];
    const mw = httpDiagnosticsMiddleware((f) => seen.push(f));
    const boom = new Error('deliberate');
    await expect(
      mw(ctx({ routePath: '/api/v1/runs/:id/cancel', method: 'POST' }), () => Promise.reject(boom)),
    ).rejects.toBe(boom);
    expect(seen).toEqual([
      { method: 'POST', route: '/api/v1/runs/:id/cancel', status: 500, message: 'deliberate' },
    ]);
  });

  it('reports a THROWN error ONCE — the status check never sees it', async () => {
    // `double-error-log`: the throw and the 500 response it becomes are the same event.
    const seen: unknown[] = [];
    const mw = httpDiagnosticsMiddleware((f) => seen.push(f));
    const c = ctx();
    await mw(c, () => Promise.reject(new Error('x'))).catch(() => undefined);
    await settle();
    expect(seen).toHaveLength(1);
  });

  it('never reports a request that succeeded', async () => {
    const seen: unknown[] = [];
    const mw = httpDiagnosticsMiddleware((f) => seen.push(f));
    const c = ctx();
    await mw(c, async () => {
      c.res = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await settle();
    expect(seen).toEqual([]);
  });

  it('reads the server’s own message from a clone, leaving the response readable', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const mw = httpDiagnosticsMiddleware((f) => seen.push(f as unknown as Record<string, unknown>));
    const c = ctx({ routePath: '/api/v1/p/:projectId/runs/:id/finish', method: 'POST' });
    await mw(c, async () => {
      c.res = new Response(JSON.stringify({ error: 'no open session' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    });
    await settle();
    expect(seen[0]).toMatchObject({ status: 409, message: 'no open session' });
    // The caller's own response is still unread and still readable — that is what a clone buys.
    expect(await c.res?.json()).toEqual({ error: 'no open session' });
  });

  it('reads nothing but the status when the failing response is not JSON', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const mw = httpDiagnosticsMiddleware((f) => seen.push(f as unknown as Record<string, unknown>));
    const c = ctx();
    await mw(c, async () => {
      c.res = new Response('nope', { status: 503, headers: { 'content-type': 'text/plain' } });
    });
    await settle();
    expect(seen[0]).toEqual({ method: 'GET', route: '/api/v1/runs/:id', status: 503 });
  });

  it('marks the origin guard’s own refusal', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const mw = httpDiagnosticsMiddleware((f) => seen.push(f as unknown as Record<string, unknown>));
    const c = ctx({ method: 'POST', path: '/api/v1/runs' });
    await mw(c, async () => {
      c.res = new Response(JSON.stringify({ error: 'forbidden: cross-origin request rejected (same-origin only)' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    await settle();
    expect(seen[0]?.reason).toBe('origin');
  });

  it('never lets a broken reporter break a request', async () => {
    const mw = httpDiagnosticsMiddleware(() => {
      throw new Error('reporter is broken');
    });
    const c = ctx();
    await expect(
      mw(c, async () => {
        c.res = new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
      }),
    ).resolves.toBeUndefined();
  });
});

describe('route templates', () => {
  it('uses the router’s own template when there is one', () => {
    expect(routeTemplateFor('/api/v1/p/:projectId/runs/:id/finish', '/api/v1/p/oko/runs/abc/finish')).toBe(
      '/api/v1/p/:projectId/runs/:id/finish',
    );
  });

  it('masks the path when the router matched nothing — a 404 or an origin refusal', () => {
    expect(routeTemplateFor('/api/*', '/api/v1/p/oko/runs/8f3a1b2c4d5e/diff')).toBe(
      '/api/v1/p/:projectId/runs/:id/diff',
    );
    expect(routeTemplateFor(undefined, '/api/v1/p/beta/runs')).toBe('/api/v1/p/:projectId/runs');
  });

  it('never lets a real identifier through the mask', () => {
    expect(maskPath('/api/v1/p/my-secret-project/runs/1234')).toBe('/api/v1/p/:projectId/runs/:id');
    expect(maskPath('/api/v1/runs/0f8a1b2c-3d4e-5f60-8a9b-0c1d2e3f4a5b/events')).toBe(
      '/api/v1/runs/:id/events',
    );
    expect(maskPath('/assets/index-9f8e7d6c.js')).toBe('/assets/:value');
  });

  it('leaves a path made only of route literals alone', () => {
    expect(maskPath('/api/v1/health')).toBe('/api/v1/health');
    expect(maskPath('/api/v1/workspace/runs-index')).toBe('/api/v1/workspace/runs-index');
  });
});
