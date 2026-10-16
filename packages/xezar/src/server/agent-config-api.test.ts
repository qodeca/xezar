import { chmodSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentHomePaths } from '../paths.ts';
import { hashBytes } from '../agent-config/files.ts';
import { listConfigFiles } from '../agent-config/catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { FILE_SYMLINKS, linkDir, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
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
  const homePins = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QWEN_HOME'] as const;
  const savedHomes = new Map<string, string | undefined>();

  beforeEach(() => {
    delete process.env.XEZ_REMOTE;
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-agentcfg-'));
    // Pin before createApp or any request. Inherited CLI homes may contain real keys (#362).
    // Restore after the suite's work, just as vitest.setup.ts restores its XEZ_HOME pin.
    for (const key of homePins) {
      savedHomes.set(key, process.env[key]);
      process.env[key] = join(repoRoot, 'agent-home', key);
      mkdirSync(process.env[key]!, { recursive: true });
    }
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
    for (const key of homePins) {
      const value = savedHomes.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repoRoot, TEST_DIR_RM_OPTIONS);
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

  it.each(listConfigFiles().filter((def) => def.scope === 'user').map((def) => def.id))(
    'isolates %s from inherited agent homes (#362)', async (id) => {
      const res = await apiRequest(app, `/api/v1/agent-config/${id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ exists: false, content: '', version: null });
    },
  );

  // win32-skip(#973): creating a file symlink needs Developer Mode or elevation (EPERM)
  it.skipIf(!FILE_SYMLINKS).each(listConfigFiles().flatMap((def) =>
    (['read', 'write', 'list'] as const).map((operation) => [def.id, operation, def] as const),
  ))('refuses a credential symlink at %s on %s (#363)', async (id, operation, def) => {
    const target = join(repoRoot, 'sentinel-credential');
    const canary = '{"key":"FAKE-SYMLINK-CREDENTIAL"}';
    writeFileSync(target, canary);
    const path = def.resolve(repoRoot, agentHomePaths());
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    try {
      if (operation === 'read') {
        const res = await apiRequest(app, `/api/v1/agent-config/${id}`);
        const body = await res.text();
        expect(body).not.toContain('FAKE-SYMLINK-CREDENTIAL');
        expect(res.status).toBe(409);
        expect(JSON.parse(body)).toEqual({ error: expect.stringContaining('symlink') });
      } else if (operation === 'write') {
        const res = await put(id, { content: def.format === 'toml' ? 'x = 1' : '{}', version: hashBytes(canary) });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: expect.stringContaining('symlink') });
      } else {
        const listing = await (await apiRequest(app, '/api/v1/agent-config')).json() as {
          files: { id: string; writable: boolean; version: string | null; readOnlyReason?: string }[];
        };
        expect(listing.files.find((file) => file.id === id)).toMatchObject({
          writable: false, version: null, readOnlyReason: expect.stringContaining('symlink'),
        });
      }
      expect(readFileSync(target, 'utf8')).toBe(canary);
    } finally {
      rmSync(path, { force: true });
    }
  });

  // win32-skip(#973): creating a file symlink needs Developer Mode or elevation (EPERM)
  it.skipIf(!FILE_SYMLINKS)('withholds Claude MCP names when its state file is a symlink', async () => {
    const credential = join(repoRoot, 'sentinel-state');
    writeFileSync(credential, '{"mcpServers":{"FAKE-STATE-CREDENTIAL":{}}}');
    symlinkSync(credential, join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'));
    const res = await apiRequest(app, '/api/v1/agent-config');
    const body = await res.text();
    expect(body).not.toContain('FAKE-STATE-CREDENTIAL');
    expect(JSON.parse(body).userMcp).toMatchObject({ readable: false, servers: [] });
  });

  it.each(['local', 'hosted'])('refuses a project directory symlink escaping the repository in %s mode (#363)', async (mode) => {
    if (mode === 'hosted') process.env.XEZ_REMOTE = '1';
    const outside = mkdtempSync(join(tmpdir(), 'xez-outside-'));
    try {
      writeFileSync(join(outside, 'settings.json'), '{"key":"FAKE-PARENT-CREDENTIAL"}');
      linkDir(outside, join(repoRoot, '.claude'));
      const res = await apiRequest(app, '/api/v1/agent-config/claude.project.settings');
      expect(await res.text()).not.toContain('FAKE-PARENT-CREDENTIAL');
      expect(res.status).toBe(409);
      expect((await put('claude.project.settings', { content: '{}', version: null })).status).toBe(409);
    } finally {
      rmSync(outside, TEST_DIR_RM_OPTIONS);
    }
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
   * F-15: no secret in a tool response. Codex keeps `auth.json` (`OPENAI_API_KEY`, `access_token`,
   * `refresh_token`) in the SAME directory as the config and memory files catalogued here, so this
   * walks every id — not just Codex's — reads it, and greps for a canary planted there. The error
   * branches are forced too: a read error surfaces `err.message`, and a message that embeds the
   * file it failed on is the classic leak a happy-path read never shows.
   */
  describe('no catalogued id can serve a Codex credential (F-15)', () => {
    const CANARY = 'sk-CANARY-DO-NOT-LEAK';
    const SENTINEL = 'theme = "dark"';
    let fakeHome: string;
    let codexHome: string;
    /**
     * Every home the catalog resolves through, pinned. Two reasons, and the second is the whole
     * point of the case: a sweep that reaches the developer's real `~` would grep unrelated bytes
     * for a canary that is not there and pass for the wrong reason — and it would pull that
     * person's real API keys into the test process.
     */
    const PINS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QWEN_HOME'] as const;
    const saved = new Map<string, string | undefined>();

    const writeCodexHome = () => {
      writeFileSync(
        join(codexHome, 'auth.json'),
        JSON.stringify({ OPENAI_API_KEY: CANARY, tokens: { access_token: CANARY, refresh_token: CANARY } }),
        'utf8',
      );
      // …and the catalogued neighbours DO exist, so "no canary" is not "nothing was read".
      writeFileSync(join(codexHome, 'config.toml'), SENTINEL, 'utf8');
      writeFileSync(join(codexHome, 'AGENTS.md'), '# Global instructions\n', 'utf8');
    };

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'xez-agentcfg-home-'));
      codexHome = join(fakeHome, '.codex');
      mkdirSync(codexHome, { recursive: true });
      for (const key of PINS) saved.set(key, process.env[key]);
      process.env.HOME = fakeHome;
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, '.claude');
      process.env.CODEX_HOME = codexHome;
      process.env.QWEN_HOME = join(fakeHome, '.qwen');
      writeCodexHome();
    });
    afterEach(() => {
      rmSync(fakeHome, TEST_DIR_RM_OPTIONS);
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
      // The control: the config file next door to the canary IS being served (JSON-escaped in
      // the response body), so a clean grep means "the secret is not catalogued", not "the Codex
      // home was never touched".
      expect(all).toContain(JSON.stringify(SENTINEL).slice(1, -1));
      expect(all).not.toContain(CANARY);
    });

    it('the error branches do not carry it either — absent, unreadable and malformed', async () => {
      // Absent: delete the two catalogued files, leaving the credential file in place.
      rmSync(join(codexHome, 'config.toml'));
      rmSync(join(codexHome, 'AGENTS.md'));
      expect(await readEveryId()).not.toContain(CANARY);
      writeCodexHome();

      // Malformed: bytes that are not TOML. The route serves content verbatim and never parses,
      // but a future parse would report the value it choked on.
      writeFileSync(join(codexHome, 'config.toml'), '{ broken', 'utf8');
      const malformed = await (await apiRequest(app, '/api/v1/agent-config/codex.user.config')).text();
      expect(malformed).toContain('broken');
      expect(malformed).not.toContain(CANARY);
      expect(await readEveryId()).not.toContain(CANARY);
      writeFileSync(join(codexHome, 'config.toml'), SENTINEL, 'utf8');

      // Unreadable: EACCES on the file itself. `readConfigFile` surfaces `err.message`, which is
      // the branch a leak would hide in and which a happy-path read never reaches.
      chmodSync(join(codexHome, 'AGENTS.md'), 0o000);
      try {
        const text = await (await apiRequest(app, '/api/v1/agent-config/codex.user.memory')).text();
        // Running as root defeats the chmod, so assert only the leak property — true either way.
        expect(text).not.toContain(CANARY);
        expect(await readEveryId()).not.toContain(CANARY);
      } finally {
        chmodSync(join(codexHome, 'AGENTS.md'), 0o600);
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
