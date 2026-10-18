import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, type ServerDeps } from './server.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { saveServerState } from '../server-install/state.ts';
import { freshServerState, type ServerState } from '../server-install/types.ts';

/**
 * DNS-rebinding guard: in local mode (loopback bind, no `XEZ_REMOTE`) every
 * legitimate caller addresses the cockpit as `localhost` / `127.x` / `[::1]`,
 * so a request whose Host header names anything else can only be a browser
 * that was rebound to 127.0.0.1 by an attacker-controlled DNS name — its
 * requests are same-origin to the attacker's page, and the Host header is the
 * one tell left. The guard turns those into a 403 before any route runs.
 *
 * Hosted mode (`XEZ_REMOTE=1` or a non-loopback bind) also serves IP literals,
 * the public names the server install recorded on this machine and the names
 * in `XEZ_ALLOWED_HOSTS`, and refuses every other name, recorded or not — the
 * installers keep the listener on loopback behind a local proxy, so a browser
 * on the same machine can still reach it. A missing Host header fails closed;
 * real HTTP/1.1 clients always send one, while the in-process test harness
 * must add it.
 */
describe('host-header guard (DNS rebinding)', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  const savedAllowed = process.env.XEZ_ALLOWED_HOSTS;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-hostguard-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-hostguard-repo-'));
    process.env.XEZ_HOME = home;
    delete process.env.XEZ_REMOTE;
    delete process.env.XEZ_ALLOWED_HOSTS;
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, TEST_DIR_RM_OPTIONS);
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = savedRemote;
    if (savedAllowed === undefined) delete process.env.XEZ_ALLOWED_HOSTS;
    else process.env.XEZ_ALLOWED_HOSTS = savedAllowed;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const request = (host: string | null, path = '/api/v1/health', over: Partial<ServerDeps> = {}) =>
    makeApp(over).request(path, host === null ? {} : { headers: { host } });

  it.each(['localhost', 'localhost:4321', '127.0.0.1', '127.0.0.1:4321', '[::1]', '[::1]:4321'])(
    'allows the loopback spelling %s',
    async (host) => {
      const res = await request(host);
      expect(res.status).toBe(200);
    },
  );

  it('rejects a request without a Host header in local mode', async () => {
    const res = await request(null);
    expect(res.status).toBe(403);
  });

  it.each(['attacker.example', 'attacker.example:4321', 'xezar.attacker.example', '192.168.1.10:4321'])(
    'rejects the rebound host %s with 403 on every route',
    async (host) => {
      for (const path of ['/api/v1/health', '/api/v1/projects', '/api/v1/fs/browse?path=', '/api/v1/runs']) {
        const res = await request(host, path);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: 'forbidden: unexpected Host header — this request did not originate from this machine (see #426)',
        });
      }
    },
  );

  it('rejects a rebound POST before the handler can act', async () => {
    const res = await makeApp().request('/api/v1/projects', {
      method: 'POST',
      headers: { host: 'attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ root: repoRoot }),
    });
    expect(res.status).toBe(403);
  });

  describe('hosted mode', () => {
    const record = (state: Partial<ServerState>, instance = 'default') =>
      saveServerState({ ...freshServerState(), installed: true, ...state }, instance);

    it('serves the public domain an install recorded, under any case and with a port', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com' });
      for (const host of ['cockpit.example.com', 'Cockpit.Example.COM', 'cockpit.example.com:443']) {
        const res = await request(host, '/api/v1/projects');
        expect(res.status).toBe(200);
      }
    });

    it('serves the host named by a recorded public URL and a named instance', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'macosx-ngrok', publicUrl: 'https://tunnel.example.org' });
      record({ platform: 'ubuntu-vps', domain: 'second.example.net' }, 'second-example-net');
      expect((await request('tunnel.example.org', '/api/v1/projects')).status).toBe(200);
      expect((await request('second.example.net', '/api/v1/projects')).status).toBe(200);
    });

    it('refuses a name the install did not record, on reads and writes', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'macosx-ngrok', domain: 'tunnel.example.org', publicUrl: 'https://tunnel.example.org' });
      for (const host of ['other.example', 'tunnel.example.org.other.example', 'other.example:4321']) {
        for (const path of ['/api/v1/health', '/api/v1/projects', '/api/v1/runs']) {
          const res = await request(host, path);
          expect(res.status).toBe(403);
        }
      }
      const post = await makeApp().request('/api/v1/projects', {
        method: 'POST',
        headers: { host: 'other.example', origin: 'http://other.example', 'content-type': 'application/json' },
        body: JSON.stringify({ root: repoRoot }),
      });
      expect(post.status).toBe(403);
    });

    it('serves an ngrok-assigned hostname when an ngrok install recorded no domain', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'macosx-ngrok', ephemeral: true });
      expect((await request('abc-123.ngrok-free.app', '/api/v1/projects')).status).toBe(200);
      expect((await request('other.example', '/api/v1/projects')).status).toBe(403);
      expect((await request('ngrok-free.app.other.example', '/api/v1/projects')).status).toBe(403);
    });

    it('does not widen ngrok zones for an install on another platform', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com' });
      expect((await request('abc-123.ngrok-free.app', '/api/v1/projects')).status).toBe(403);
    });

    it('still serves loopback and IP-literal hosts when names are recorded', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com' });
      for (const host of ['127.0.0.1:4321', 'localhost', '[::1]:4321', '203.0.113.7', '[2001:db8::1]:443']) {
        expect((await request(host, '/api/v1/projects')).status).toBe(200);
      }
    });

    it('refuses an unrecorded name for a non-loopback bind once a name is recorded', async () => {
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com', bindHost: '172.17.0.1', externalProxy: true });
      expect((await request('cockpit.example.com', '/api/v1/projects', { bindHost: '0.0.0.0' })).status).toBe(200);
      expect((await request('other.example', '/api/v1/projects', { bindHost: '0.0.0.0' })).status).toBe(403);
    });

    it('refuses an unknown name when no install records a public name, and says how to allow it', async () => {
      process.env.XEZ_REMOTE = '1';
      for (const over of [{}, { bindHost: '0.0.0.0' }]) {
        const res = await request('cockpit.example.com', '/api/v1/projects', over);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toContain('XEZ_ALLOWED_HOSTS');
      }
    });

    it('refuses a missing Host in hosted mode', async () => {
      process.env.XEZ_REMOTE = '1';
      expect((await request(null, '/api/v1/projects')).status).toBe(403);
    });

    it('serves loopback and IP-literal hosts when no install records a public name', async () => {
      process.env.XEZ_REMOTE = '1';
      for (const host of ['127.0.0.1:4321', 'localhost', '203.0.113.7:443', '[2001:db8::1]']) {
        expect((await request(host, '/api/v1/projects')).status).toBe(200);
      }
    });

    it('serves names listed in XEZ_ALLOWED_HOSTS — exact, case-insensitive, port ignored', async () => {
      process.env.XEZ_REMOTE = '1';
      process.env.XEZ_ALLOWED_HOSTS = ' Cockpit.Example.com , other.example:8443,,';
      for (const host of ['cockpit.example.com', 'COCKPIT.example.com:443', 'other.example']) {
        expect((await request(host, '/api/v1/projects')).status).toBe(200);
      }
      for (const host of ['sub.cockpit.example.com', 'cockpit.example.com.other.example', 'example.com']) {
        expect((await request(host, '/api/v1/projects')).status).toBe(403);
      }
    });

    it('serves an allowlisted second name next to a recorded one', async () => {
      process.env.XEZ_REMOTE = '1';
      process.env.XEZ_ALLOWED_HOSTS = 'alias.example.net';
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com' });
      expect((await request('cockpit.example.com', '/api/v1/projects')).status).toBe(200);
      expect((await request('alias.example.net', '/api/v1/projects')).status).toBe(200);
      expect((await request('other.example', '/api/v1/projects')).status).toBe(403);
    });

    it('ignores a dry-run record and a record without a platform', async () => {
      process.env.XEZ_REMOTE = '1';
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com', dryRun: true });
      record({ domain: 'stale.example.com' }, 'stale-example-com');
      expect((await request('cockpit.example.com')).status).toBe(403);
      expect((await request('stale.example.com')).status).toBe(403);
    });

    it('keeps XEZ_ALLOWED_HOSTS out of local mode', async () => {
      process.env.XEZ_ALLOWED_HOSTS = 'cockpit.example.com';
      expect((await request('cockpit.example.com')).status).toBe(403);
    });

    it('keeps local mode strict even when a public name is recorded', async () => {
      record({ platform: 'ubuntu-vps', domain: 'cockpit.example.com' });
      expect((await request('cockpit.example.com')).status).toBe(403);
    });
  });
});
