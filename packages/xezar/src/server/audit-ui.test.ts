import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_TRAIL_FILE } from '../mcp/audit-trail.ts';
import { AUDIT_ROUTE, auditRouteDescriptor, createUiAuditDoor, isLoopbackPeer, sanitizeProxyUser, type UiAuditDeps } from './audit-ui.ts';

/**
 * #306 part 2 — the cockpit door's own rules, on a bare Hono app so each rule is isolated. The
 * real routes, the real inventory and the other three doors are `mcp/audit-four-doors.test.ts`.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fixture(options: { hosted?: boolean } = {}) {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'xez-audit-ui-')), '.local', 'xezar');
  dirs.push(join(dataDir, '..', '..'));
  mkdirSync(dataDir, { recursive: true });
  const warnings: string[] = [];
  const scope = { projectId: 'audit-ui', dataDir };
  const deps: UiAuditDeps = {
    hosted: () => options.hosted === true,
    requestScope: async () => scope,
    bootScope: async () => scope,
    projectScope: async () => undefined,
    warn: (message) => warnings.push(message),
  };
  const door = createUiAuditDoor(deps);
  const lines = () =>
    existsSync(join(dataDir, AUDIT_TRAIL_FILE))
      ? readFileSync(join(dataDir, AUDIT_TRAIL_FILE), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { door, dataDir, warnings, lines };
}

const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

describe('the ui audit door (#306 part 2)', () => {
  it('records nothing for a request that did not arrive over a connection — the in-process MCP calls', async () => {
    const f = fixture();
    const app = new Hono().post('/x', f.door.route('run.markAllRead'), (c) => c.json({ ok: true }));
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
    expect(f.lines()).toEqual([]);
    expect((await app.request('/x', { method: 'POST' }, peer('127.0.0.1'))).status).toBe(200);
    expect(f.lines()).toMatchObject([{ origin: 'ui', actor: { type: 'ui' }, action: 'run.markAllRead', outcome: { status: 'applied' } }]);
  });

  it('a 4xx is refused with the route status, a 5xx or a throw is not recorded and warns once', async () => {
    // The stale-version 409 (`stale_version`) is proven against a real route in audit-four-doors.test.ts.
    const f = fixture();
    const app = new Hono()
      .post('/404/:id', f.door.route('run.cancel', { resource: { kind: 'run', param: 'id' } }), (c) => c.json({ error: 'not found' }, 404))
      .post('/409', f.door.route('run.cancel'), (c) => c.json({ error: 'busy' }, 409))
      .post('/500', f.door.route('run.cancel'), (c) => c.json({ error: 'boom' }, 500))
      .post('/throw', f.door.route('run.cancel'), () => {
        throw new Error('after the effect');
      });
    for (const path of ['/404/r1', '/409', '/500', '/throw']) await app.request(path, { method: 'POST' }, peer('127.0.0.1'));
    expect(f.lines().map((line) => [line.resource, line.outcome])).toEqual([
      [{ kind: 'run', id: 'r1' }, { status: 'refused', reason: 'http_404' }],
      [undefined, { status: 'refused', reason: 'http_409' }],
    ]);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toMatch(/the action continued without an audit record\.$/);
  });

  it('a failed audit write never changes the response, and warns once', async () => {
    const f = fixture();
    // A directory where the file should be: every append fails.
    mkdirSync(join(f.dataDir, AUDIT_TRAIL_FILE));
    const app = new Hono().post('/x', f.door.route('run.markAllRead'), (c) => c.json({ read: 3 }, 200));
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request('/x', { method: 'POST' }, peer('127.0.0.1'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ read: 3 });
    }
    expect(f.warnings).toHaveLength(1);
  });

  it('a body selector picks the action, and a preview (undefined) records nothing', async () => {
    const f = fixture();
    const app = new Hono().post(
      '/check',
      f.door.route('automation.checkExecute', { select: (body) => (body?.mode === 'execute' ? 'automation.checkExecute' : undefined) }),
      (c) => c.json({}, 202),
    );
    const withBody = (mode: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    // No validator in this bare app, so the selector sees no validated body: nothing is recorded.
    await app.request('/check', withBody('execute'), peer('127.0.0.1'));
    expect(f.lines()).toEqual([]);
  });

  it('refuses to build a decorator for an action outside the inventory, or several actions without a selector', () => {
    const f = fixture();
    expect(() => f.door.route('no.such.action')).toThrow(/outside the inventory/);
    expect(() => f.door.route(['run.pin', 'run.unpin'])).toThrow(/needs a selector/);
    const handler = f.door.route(['run.pin', 'run.unpin'], { select: () => 'run.pin' });
    expect(auditRouteDescriptor(handler)).toEqual({ ids: ['run.pin', 'run.unpin'] });
    expect((handler as unknown as Record<symbol, unknown>)[AUDIT_ROUTE]).toBeDefined();
    expect(auditRouteDescriptor(() => undefined)).toBeUndefined();
    expect(auditRouteDescriptor('not a function')).toBeUndefined();
  });

  describe('the proxy user (spec § 9)', () => {
    const send = async (hosted: boolean, address: string, user: string | undefined) => {
      const f = fixture({ hosted });
      const app = new Hono().post('/x', f.door.route('run.markAllRead'), (c) => c.json({}));
      await app.request('/x', { method: 'POST', headers: user === undefined ? {} : { 'X-Xezar-User': user } }, peer(address));
      return f.lines()[0]!.actor;
    };

    it('hosted mode and a loopback peer: kept, sanitized and labelled asserted-by-proxy', async () => {
      expect(await send(true, '127.0.0.1', '  alice  ')).toEqual({ type: 'ui', proxyUser: { value: 'alice', trust: 'asserted-by-proxy' } });
      expect(await send(true, '::1', 'bob')).toEqual({ type: 'ui', proxyUser: { value: 'bob', trust: 'asserted-by-proxy' } });
      expect(await send(true, '::ffff:127.0.0.1', 'carol')).toEqual({ type: 'ui', proxyUser: { value: 'carol', trust: 'asserted-by-proxy' } });
    });

    it('B-UI-HEADER: a non-loopback peer (a direct forgery around the proxy) is ignored', async () => {
      expect(await send(true, '10.0.0.5', 'mallory')).toEqual({ type: 'ui' });
      expect(await send(true, '192.168.1.20', 'mallory')).toEqual({ type: 'ui' });
    });

    it('local mode ignores the header even from loopback', async () => {
      expect(await send(false, '127.0.0.1', 'mallory')).toEqual({ type: 'ui' });
    });

    it('an absent or empty header adds nothing', async () => {
      expect(await send(true, '127.0.0.1', undefined)).toEqual({ type: 'ui' });
      expect(await send(true, '127.0.0.1', '   ')).toEqual({ type: 'ui' });
    });

    it('sanitizes: control characters stripped, 128 UTF-16 code units, never half a surrogate pair', () => {
      expect(sanitizeProxyUser('a\u0000b\u001fc\u007fd\u0085e')).toEqual({ value: 'abcde', trust: 'asserted-by-proxy' });
      expect(sanitizeProxyUser('x'.repeat(200))?.value).toHaveLength(128);
      const emoji = `${'x'.repeat(127)}\u{1F600}`;
      expect(sanitizeProxyUser(emoji)?.value).toBe('x'.repeat(127));
      expect(sanitizeProxyUser('\u0001\u0002')).toBeUndefined();
      expect(sanitizeProxyUser(undefined)).toBeUndefined();
    });

    it('isLoopbackPeer accepts only loopback address forms', () => {
      expect(isLoopbackPeer('127.0.0.1')).toBe(true);
      expect(isLoopbackPeer('127.1.2.3')).toBe(true);
      expect(isLoopbackPeer('::1')).toBe(true);
      expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
      expect(isLoopbackPeer('10.0.0.1')).toBe(false);
      expect(isLoopbackPeer('127.0.0.1.evil')).toBe(false);
      expect(isLoopbackPeer('localhost')).toBe(false);
      expect(isLoopbackPeer(undefined)).toBe(false);
    });
  });
});
