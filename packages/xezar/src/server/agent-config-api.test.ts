import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listConfigFiles } from '../agent-config/catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `GET/PUT /api/v1/agent-config` (spec #404). The contract under test: files are
 * addressed by catalog id (unknown → 404); reads work in every mode; and the
 * load-bearing security property — EVERY write 409s in hosted mode
 * (`XEZ_REMOTE`), including a repo-LOCAL file whose hooks would otherwise be a
 * remote code-execution primitive.
 */
describe('the agent-config API', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const prevRemote = process.env.XEZ_REMOTE;

  beforeEach(() => {
    delete process.env.XEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-agentcfg-'));
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
    });
  });
  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (prevRemote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = prevRemote;
  });

  const put = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/agent-config/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET lists the catalog with editable:true locally', async () => {
    const res = await apiRequest(app, '/api/v1/agent-config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      editable: boolean;
      files: unknown[];
      userMcp: unknown;
    };
    expect(body.editable).toBe(true);
    expect(body.files.length).toBeGreaterThan(10);
    expect(body.userMcp).not.toBeNull();
  });

  it('GET :id → 404 for an unknown id', async () => {
    expect((await apiRequest(app, '/api/v1/agent-config/nope')).status).toBe(404);
  });

  it('GET :id reads an absent file as exists:false', async () => {
    const res = await apiRequest(app, '/api/v1/agent-config/claude.project.settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exists: false, version: null });
  });

  it('PUT creates a file, then a correct-version PUT updates it', async () => {
    const created = await put('claude.project.settings', {
      content: '{"a":1}',
      version: null,
    });
    expect(created.status).toBe(200);
    const { version } = (await created.json()) as { version: string };
    expect(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')).toBe('{"a":1}');
    const updated = await put('claude.project.settings', {
      content: '{"a":2}',
      version,
    });
    expect(updated.status).toBe(200);
  });

  it('PUT rejects invalid JSON with 400', async () => {
    expect((await put('claude.project.settings', { content: '{bad', version: null })).status).toBe(400);
  });

  it('PUT rejects a stale version with 409', async () => {
    await put('claude.project.settings', { content: '{"a":1}', version: null });
    expect(
      (
        await put('claude.project.settings', {
          content: '{"a":2}',
          version: null,
        })
      ).status,
    ).toBe(409);
  });

  it('PUT :id → 404 for an unknown id', async () => {
    expect((await put('nope', { content: 'x', version: null })).status).toBe(404);
  });

  // The regression test for the hooks RCE hole: a repo-LOCAL file must 409 in
  // hosted mode, not just a user-scope one. settings.json defines hooks.
  it('hosted mode: EVERY write 409s — including a repo-local settings file', async () => {
    process.env.XEZ_REMOTE = '1';
    const local = await put('claude.project.settings', {
      content: '{"hooks":{}}',
      version: null,
    });
    expect(local.status).toBe(409);
    const userScope = await put('claude.user.settings', {
      content: '{}',
      version: null,
    });
    expect(userScope.status).toBe(409);
  });

  /**
   * #330 WP4. pi's entries are new WRITABLE files, so each is a new way to reach the hooks RCE
   * path the 409 above closes. Enumerated from the catalog rather than listed by hand, so a pi
   * entry added later cannot slip in without a gate.
   */
  it('hosted mode: every pi entry 409s on write, and none is skipped', async () => {
    process.env.XEZ_REMOTE = '1';
    const piIds = listConfigFiles()
      .filter((f) => f.runners.includes('pi'))
      .map((f) => f.id);
    // The populated-input control: an empty id list would make the loop below vacuously green.
    expect(piIds.length).toBeGreaterThan(0);
    for (const id of piIds) {
      expect((await put(id, { content: '{}', version: null })).status, id).toBe(409);
    }
  });

  it('locally: every pi entry is an id the route answers, not a 404', async () => {
    // The control for the hosted test above — the 409s there are the GUARD refusing, not the ids
    // being unknown. Also the "built and connected" check: these ids answer on the real route.
    // An unknown id answers `{error}`, so the `id` key is what separates the two.
    const piIds = listConfigFiles().filter((f) => f.runners.includes('pi')).map((f) => f.id);
    expect(piIds.length).toBeGreaterThan(0); // populated-input control: an empty list proves nothing
    for (const id of piIds) {
      const res = await apiRequest(app, `/api/v1/agent-config/${id}`);
      expect(res.status, id).toBe(200);
      expect(await res.json(), id).toMatchObject({ id });
    }
  });

  /**
   * F-15: no secret in a tool response. pi keeps `auth.json` (credentials) and `models.json` (an
   * `apiKey` per custom provider) in the SAME directory as the settings and MCP files catalogued
   * here, so this walks every id — not just pi's — reads it, and greps for a canary planted in
   * both. The error branches are forced too: a read error surfaces `err.message`, and a message
   * that embeds the file it failed on is the classic leak a happy-path read never shows.
   */
  describe('no catalogued id can serve a pi credential (F-15)', () => {
    const CANARY = 'sk-CANARY-DO-NOT-LEAK';
    const SENTINEL = '{"theme":"dark"}';
    let fakeHome: string;
    let piHome: string;
    /**
     * Every home the catalog resolves through, pinned. Two reasons, and the second is the whole
     * point of the case: a sweep that reaches the developer's real `~` would grep unrelated bytes
     * for a canary that is not there and pass for the wrong reason — and it would pull that
     * person's real API keys into the test process. (Unpinned, this suite does exactly that
     * today: `codex.user.memory` and `opencode.user.config` serve the real files.)
     */
    const PINS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'] as const;
    const saved = new Map<string, string | undefined>();

    const writePiHome = () => {
      writeFileSync(join(piHome, 'auth.json'), JSON.stringify({ anthropic: { apiKey: CANARY } }), 'utf8');
      writeFileSync(
        join(piHome, 'models.json'),
        JSON.stringify({ providers: { local: { name: 'Local', apiKey: CANARY, models: [{ id: 'm' }] } } }),
        'utf8',
      );
      // …and the catalogued neighbours DO exist, so "no canary" is not "nothing was read".
      writeFileSync(join(piHome, 'settings.json'), SENTINEL, 'utf8');
      writeFileSync(join(piHome, 'mcp.json'), '{"mcpServers":{}}', 'utf8');
    };

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'xez-agentcfg-home-'));
      piHome = join(fakeHome, '.pi', 'agent');
      mkdirSync(piHome, { recursive: true });
      for (const key of PINS) saved.set(key, process.env[key]);
      process.env.HOME = fakeHome;
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude');
      process.env.CODEX_HOME = join(fakeHome, '.codex');
      process.env.OPENCODE_CONFIG_DIR = join(fakeHome, '.config', 'opencode');
      process.env.PI_CODING_AGENT_DIR = piHome;
      writePiHome();
    });
    afterEach(() => {
      rmSync(fakeHome, { recursive: true, force: true });
      for (const key of PINS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    /** Every id on the listing AND on the per-id route, as one blob to grep. */
    const readEveryId = async (): Promise<string> => {
      const ids = listConfigFiles().map((f) => f.id);
      expect(ids.length).toBeGreaterThan(0);
      const listing = await (await apiRequest(app, '/api/v1/agent-config')).text();
      const bodies = await Promise.all(
        ids.map(async (id) => (await apiRequest(app, `/api/v1/agent-config/${id}`)).text()),
      );
      return [listing, ...bodies].join('\n');
    };

    it('reads every catalogued id and none carries the canary', async () => {
      const all = await readEveryId();
      // The control: the settings file next door to the canary IS being served (JSON-escaped in
      // the response body), so a clean grep means "the secret is not catalogued", not "the pi
      // home was never touched".
      expect(all).toContain(JSON.stringify(SENTINEL).slice(1, -1));
      expect(all).not.toContain(CANARY);
    });

    it('the error branches do not carry it either — absent, unreadable and malformed', async () => {
      // Absent: delete the two catalogued files, leaving the credential files in place.
      rmSync(join(piHome, 'settings.json'));
      rmSync(join(piHome, 'mcp.json'));
      expect(await readEveryId()).not.toContain(CANARY);
      writePiHome();

      // Malformed: bytes that are not JSON. The route serves content verbatim and never parses,
      // but a future parse would report the value it choked on.
      writeFileSync(join(piHome, 'settings.json'), '{ broken', 'utf8');
      const malformed = await (await apiRequest(app, '/api/v1/agent-config/pi.user.settings')).text();
      expect(malformed).toContain('broken');
      expect(malformed).not.toContain(CANARY);
      expect(await readEveryId()).not.toContain(CANARY);
      writeFileSync(join(piHome, 'settings.json'), SENTINEL, 'utf8');

      // Unreadable: EACCES on the file itself. `readConfigFile` surfaces `err.message`, which is
      // the branch a leak would hide in and which a happy-path read never reaches.
      chmodSync(join(piHome, 'mcp.json'), 0o000);
      try {
        const text = await (await apiRequest(app, '/api/v1/agent-config/pi.user.mcp')).text();
        // Running as root defeats the chmod, so assert only the leak property — true either way.
        expect(text).not.toContain(CANARY);
        expect(await readEveryId()).not.toContain(CANARY);
      } finally {
        chmodSync(join(piHome, 'mcp.json'), 0o600);
      }
    });
  });

  it('hosted mode: repo-file reads work, home-dir file reads are withheld, userMcp is null', async () => {
    process.env.XEZ_REMOTE = '1';
    const res = await apiRequest(app, '/api/v1/agent-config');
    const body = (await res.json()) as {
      editable: boolean;
      userMcp: unknown;
      files: { writable: boolean }[];
    };
    expect(body.editable).toBe(false);
    expect(body.userMcp).toBeNull();
    expect(body.files.every((f) => f.writable === false)).toBe(true);
    // a repo-local file read still works (the cockpit already serves repo contents)
    expect((await apiRequest(app, '/api/v1/agent-config/claude.project.settings')).status).toBe(200);
    // but an OUTSIDE-REPO ($HOME) file's contents are NOT served — they can hold secrets
    expect((await apiRequest(app, '/api/v1/agent-config/claude.user.settings')).status).toBe(409);
    expect((await apiRequest(app, '/api/v1/agent-config/codex.user.config')).status).toBe(409);
  });
});
