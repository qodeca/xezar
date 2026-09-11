import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchKeyResponseSchema } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `GET /api/v1/launch-key` — the VALUE the route answers with (gap R14, #53).
 *
 * The bookmarklet auto-start secret (spec 011) is per-project state that
 * `BACKWARD_COMPATIBILITY.md` §3 protects: every bookmarklet the user ever
 * saved carries the key of the project it was generated in. Three ways to
 * break it are silent — returning the wrong project's key, returning an empty
 * string, or minting a fresh one per request — and all three leave a saved
 * bookmarklet opening a page that simply refuses to launch. Route-parity only
 * proves the three spellings AGREE; agreeing on a wrong value passes it.
 *
 * The key itself is a secret, so nothing here puts one in a test name or an
 * assertion message: every fixture key is a fresh `randomUUID()` in a temp
 * directory, and assertions compare the response against the file rather than
 * against a literal.
 */
describe('GET /launch-key (value contract, #53)', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedRemote = process.env.XEZ_REMOTE;
  const savedSingleProject = process.env.XEZ_SINGLE_PROJECT;
  const savedDryRun = process.env.XEZ_DRY_RUN;
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;

  /** `<root>/.local/xezar/launch-key` — where `ensureLaunchKey` persists it. */
  const keyFile = (root: string): string => join(root, '.local/xezar', 'launch-key');

  /** Pre-seed a project's persisted key, the way an earlier boot would have.
   *  Returns the value the route must hand back verbatim. */
  const seedKey = (root: string): string => {
    const key = randomUUID();
    mkdirSync(join(root, '.local/xezar'), { recursive: true });
    // Trailing newline on purpose: that is exactly how `ensureLaunchKey` writes
    // it, so a route that forgot to trim would be caught here.
    writeFileSync(keyFile(root), `${key}\n`, { encoding: 'utf8', mode: 0o600 });
    return key;
  };

  /** The key as it currently sits on disk for `root`. */
  const persistedKey = (root: string): string => readFileSync(keyFile(root), 'utf8').trim();

  /** Read `/launch-key` (any spelling) and validate against the contract. */
  const fetchKey = async (path: string): Promise<string> => {
    const res = await apiRequest(app, path);
    expect(res.status, path).toBe(200);
    return launchKeyResponseSchema.parse(await res.json()).key;
  };

  /** Build the app. Deferred to each test so a case can decide whether the key
   *  file exists BEFORE the boot context is constructed. */
  const buildApp = async (): Promise<string> => {
    store = RunStore.open(join(bootRoot, '.local/xezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    const bootId = (await registerProject(bootRoot)).id;
    app = createApp({
      bootProjectId: bootId,
      repoRoot: bootRoot,
      store,
      // No launch-key path reaches the manager; the stub keeps this hermetic.
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
    return bootId;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-lk-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'xez-lk-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'xez-lk-other-'));
    // Every workspace path (the project registry included) resolves here — the
    // developer's own `~/.xezar` is never read and never written.
    process.env.XEZ_HOME = home;
    delete process.env.XEZ_REMOTE;
    delete process.env.XEZ_SINGLE_PROJECT;
    process.env.XEZ_DRY_RUN = '1'; // no real agent CLIs, no network
    clearProjectProbeCache();
  });

  afterEach(async () => {
    await contexts?.disposeAll();
    store?.flush();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedRemote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = savedRemote;
    if (savedSingleProject === undefined) delete process.env.XEZ_SINGLE_PROJECT;
    else process.env.XEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
    else process.env.XEZ_DRY_RUN = savedDryRun;
  });

  it('answers with the exact key persisted in that project’s .local/xezar/launch-key', async () => {
    const seeded = seedKey(bootRoot);
    await buildApp();

    const answered = await fetchKey('/api/v1/launch-key');
    // Verbatim, trimmed, and not a fresh secret that ignored the file.
    expect(answered).toBe(seeded);
    expect(answered).not.toBe('');
    // The route read the file; it did not overwrite it.
    expect(persistedKey(bootRoot)).toBe(seeded);
  });

  it('returns the SAME key on two consecutive calls — it is read, never regenerated', async () => {
    seedKey(bootRoot);
    await buildApp();

    const first = await fetchKey('/api/v1/launch-key');
    const second = await fetchKey('/api/v1/launch-key');
    const third = await fetchKey('/api/v1/launch-key');
    // A handler that minted a key per request would break every saved
    // bookmarklet without failing anything else.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(persistedKey(bootRoot)).toBe(first);
  });

  it('with no key file present: serves a key, persists it, and repeats it next call', async () => {
    // Nothing on disk yet — the very first boot of a brand-new project.
    expect(existsSync(keyFile(bootRoot))).toBe(false);
    await buildApp();

    const first = await fetchKey('/api/v1/launch-key');
    expect(first).not.toBe('');
    // Persisted, so the key survives this process rather than living only in
    // memory for one run.
    expect(existsSync(keyFile(bootRoot))).toBe(true);
    expect(persistedKey(bootRoot)).toBe(first);
    // And it is stable from then on.
    expect(await fetchKey('/api/v1/launch-key')).toBe(first);
  });

  it('scoped spelling: two registered projects answer with two different keys, each its own', async () => {
    const bootSeed = seedKey(bootRoot);
    const otherSeed = seedKey(otherRoot);
    expect(otherSeed).not.toBe(bootSeed); // fixture sanity, not a behaviour claim
    const bootId = await buildApp();
    const other = await registerProject(otherRoot);

    const bootKey = await fetchKey(`/api/v1/p/${bootId}/launch-key`);
    const otherKey = await fetchKey(`/api/v1/p/${other.id}/launch-key`);

    // Each project's own secret — never the boot project's, whatever the scope.
    expect(bootKey).toBe(bootSeed);
    expect(otherKey).toBe(otherSeed);
    expect(otherKey).not.toBe(bootKey);
    // The unprefixed legacy spelling stays bound to the boot project.
    expect(await fetchKey('/api/v1/launch-key')).toBe(bootSeed);
    // Neither read disturbed the other project's file.
    expect(persistedKey(bootRoot)).toBe(bootSeed);
    expect(persistedKey(otherRoot)).toBe(otherSeed);
  });

  it('is subject to the same Host/Origin guard as the rest of /api/*', async () => {
    seedKey(bootRoot);
    await buildApp();
    // `app.request` directly, not the testkit: this case controls Host itself.

    // DNS rebinding — a foreign Host must not exfiltrate the secret.
    const foreignHost = await app.request('/api/v1/launch-key', { headers: { host: 'evil.tld' } });
    expect(foreignHost.status).toBe(403);
    // The anchored allowlist, not a `127.` prefix match.
    const rebinding = await app.request('/api/v1/launch-key', {
      headers: { host: '127.0.0.1.evil.com:4321' },
    });
    expect(rebinding.status).toBe(403);
    // Absent Host is unproven, not "probably local".
    const noHost = await app.request('/api/v1/launch-key', { headers: {} });
    expect(noHost.status).toBe(403);
    // No refused response leaked the key.
    for (const refused of [foreignHost, rebinding, noHost]) {
      expect(await refused.text()).not.toContain(persistedKey(bootRoot));
    }
    // The cockpit's own same-origin read still passes.
    const allowed = await app.request('/api/v1/launch-key', {
      headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' },
    });
    expect(allowed.status).toBe(200);
  });
});
