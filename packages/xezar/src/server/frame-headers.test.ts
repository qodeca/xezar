import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { HTML_FRAME_HEADERS } from './static-ui.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

/**
 * Every HTML page the service sends refuses framing by other sites
 * (`Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY`).
 * The shell answers every non-API GET — the built cockpit when `web/dist` exists, the
 * built-in recovery page when it does not — so each shell route is checked in whichever
 * of the two states this checkout is in, and both responses share one header set.
 * JSON API answers never render as a page and are left exactly as they were.
 */
describe('HTML responses refuse framing by other sites', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'xez-frame-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'xez-frame-repo-'));
    process.env.XEZ_HOME = home;
    delete process.env.XEZ_REMOTE;
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
  });

  const makeApp = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });

  it('the shared header set is exactly frame-ancestors none plus X-Frame-Options DENY', () => {
    expect(HTML_FRAME_HEADERS).toEqual({
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
  });

  it.each(['/', '/new', '/new?ref=example&skill=example', '/tasks/abc/changes', '/settings/skills', '/p/demo/new'])(
    'the HTML page at %s carries both headers',
    async (path) => {
      const res = await makeApp().request(path, { headers: { host: '127.0.0.1:4321' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    },
  );

  it('hosted mode behind a proxy hostname still serves the page, with both headers', async () => {
    process.env.XEZ_REMOTE = '1';
    const res = await makeApp().request('/new', {
      headers: { host: 'cockpit.example.test', 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('a JSON API answer is unchanged — no frame headers on data', async () => {
    const res = await makeApp().request('/api/v1/health', { headers: { host: '127.0.0.1:4321' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  });
});
