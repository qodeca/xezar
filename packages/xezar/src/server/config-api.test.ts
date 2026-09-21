import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * `GET/PUT /api/v1/config` (R6 Step 1.5 — Settings → Agents). The contract under
 * test: GET answers every Settings-editable knob in one shape; PUT merges into
 * the RAW config.json (user keys survive, defaults never materialize); the R6
 * keys (`systemPrompt`, `defaultModels`) are additive — `null`/`''` clears,
 * per-runner model writes merge instead of clobbering; and the pre-R6 answer
 * fields (`baseBranch`, `defaultRunner`) stay exactly as they were
 * (BACKWARD_COMPATIBILITY.md §2 — additive only).
 */
describe('the config API', () => {
  let repoRoot: string;
  let homeRoot: string;
  const savedHome = process.env.HOME;
  const savedXezHome = process.env.XEZ_HOME;
  const savedCodexHome = process.env.CODEX_HOME;
  const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const savedModelsLocked = process.env.XEZ_AGENT_MODELS_LOCKED;
  const savedAnthropicModel = process.env.ANTHROPIC_MODEL;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-configapi-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'xez-configapi-home-'));
    process.env.HOME = homeRoot;
    process.env.XEZ_HOME = join(homeRoot, '.xezar');
    process.env.CODEX_HOME = join(homeRoot, '.codex');
    // The fourth agent home, pinned for the same reason as the other three.
    // `agentHomePaths` reads `CLAUDE_CONFIG_DIR` BEFORE falling back to
    // `<HOME>/.claude`, so pinning HOME alone leaves this file reading the
    // developer's — or a coding agent's own — real Claude settings, and a model
    // pinned there becomes a `defaultModels.claude` the cases below never wrote.
    // On a host with the variable unset this is exactly today's value.
    process.env.CLAUDE_CONFIG_DIR = join(homeRoot, '.claude');
    process.env.XDG_CONFIG_HOME = join(homeRoot, '.config');
    // The fifth pin, and the only one no directory can stand in for: `ANTHROPIC_MODEL` is read
    // BEFORE any settings file, so with it set the four `defaultModels` cases below answer the
    // model of whatever agent started `npm test` instead of the fixture's. `vitest.setup.ts`
    // already scrubs it for every worker; this repeats it locally so the file states its own
    // dependence and holds even when a case above it puts the variable back.
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.XEZ_AGENT_MODELS_LOCKED;
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });
    mkdirSync(join(homeRoot, '.xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    // The config routes never touch the manager — an empty stub is honest.
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXezHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedXezHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    if (savedModelsLocked === undefined) delete process.env.XEZ_AGENT_MODELS_LOCKED;
    else process.env.XEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
    if (savedAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = savedAnthropicModel;
  });

  const configPath = () => join(repoRoot, '.xezar', 'config.json');
  const rawFile = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

  const get = () => apiRequest(app, '/api/v1/config');
  const getBody = async () => (await (await get()).json()) as Record<string, unknown>;
  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET answers the zero-config defaults when no file exists', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      baseBranch: null,
      defaultRunner: 'claude',
      systemPrompt: null,
      defaultModels: {},
      modelsLocked: false,
      projectModelsLocked: false,
      maxParallel: 2,
      memoryLimitMb: null,
      worktreeRetention: 10,
      liveTitleUpdates: null,
      reviewGate: null,
      // E — declared in the file schema since spec 008 but absent from this answer until
      // now, so the only way to change them was to hand-edit `.xezar/config.json`. All three
      // are `.default()`ed by the schema, hence materialized rather than tri-state.
      plannerModel: 'sonnet',
      namerModel: 'haiku',
      skillsRepos: [{ repo: 'qodeca/xezar-skills', ref: 'main' }],
    });
  });

  it("uses the coding agents' native model settings as the initial defaults", async () => {
    mkdirSync(join(homeRoot, '.claude'), { recursive: true });
    mkdirSync(join(homeRoot, '.codex'), { recursive: true });
    mkdirSync(join(homeRoot, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(homeRoot, '.claude', 'settings.json'), '{"model":"sonnet"}');
    writeFileSync(join(homeRoot, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
    writeFileSync(join(homeRoot, '.config', 'opencode', 'opencode.json'), '{"model":"openai/gpt-5.1"}');

    expect((await getBody()).defaultModels).toEqual({
      claude: 'sonnet',
      codex: 'gpt-5-codex',
      opencode: 'openai/gpt-5.1',
    });
    expect((await getBody()).modelsLocked).toBe(false);
  });

  it('locks native defaults and rejects Xezar model overrides', async () => {
    process.env.XEZ_AGENT_MODELS_LOCKED = '1';
    mkdirSync(join(homeRoot, '.codex'), { recursive: true });
    writeFileSync(join(homeRoot, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n');
    writeFileSync(configPath(), JSON.stringify({ defaultModels: { codex: 'xezar-codex' } }), 'utf8');

    const body = await getBody();
    expect(body.modelsLocked).toBe(true);
    expect(body.defaultModels).toEqual({ codex: 'gpt-5-codex' });

    const res = await put({ defaultModels: { codex: 'other-model' } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('models are locked');
    expect(rawFile().defaultModels).toEqual({ codex: 'xezar-codex' });
  });

  it('supports the same lock through the optional repository config key', async () => {
    mkdirSync(join(homeRoot, '.codex'), { recursive: true });
    writeFileSync(join(homeRoot, '.codex', 'config.toml'), 'model = "native-codex"\n');
    writeFileSync(
      configPath(),
      JSON.stringify({ modelsLocked: true, defaultModels: { codex: 'xezar-codex' } }),
      'utf8',
    );

    const body = await getBody();
    expect(body.modelsLocked).toBe(true);
    expect(body.defaultModels).toEqual({ codex: 'native-codex' });
    expect((await put({ defaultModels: { codex: 'other-model' } })).status).toBe(409);
  });

  it('supports a global workspace config lock across repositories', async () => {
    writeFileSync(
      join(homeRoot, '.xezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );

    expect((await getBody()).modelsLocked).toBe(true);
    expect((await put({ defaultModels: { claude: 'opus' } })).status).toBe(409);
  });

  // #677 C2: the project's own key is written through PUT /config (and so through the MCP's
  // `set_config`, which is this route). Owner, 2026-09-20: "Both doors, like every key".
  it('PUT modelsLocked true locks the NEXT write without a restart (#677 C2)', async () => {
    expect((await put({ defaultModels: { claude: 'opus' } })).status).toBe(200);

    const res = await put({ modelsLocked: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ modelsLocked: true, projectModelsLocked: true });
    expect(rawFile().modelsLocked).toBe(true);

    // Same app, same process: the very next model write is refused.
    const refused = await put({ defaultModels: { claude: 'sonnet' } });
    expect(refused.status).toBe(409);
    expect(rawFile().defaultModels).toEqual({ claude: 'opus' });

    // And clearing it lifts the lock just as live.
    expect((await put({ modelsLocked: false })).status).toBe(200);
    expect((await put({ defaultModels: { claude: 'sonnet' } })).status).toBe(200);
  });

  it('PUT modelsLocked false or null DELETES the key; the environment still locks (#677 C2)', async () => {
    writeFileSync(configPath(), JSON.stringify({ modelsLocked: true, systemPrompt: 'keep me' }), 'utf8');

    expect((await put({ modelsLocked: false })).status).toBe(200);
    expect(rawFile()).toEqual({ systemPrompt: 'keep me' });
    expect(await getBody()).toMatchObject({ modelsLocked: false, projectModelsLocked: false });

    writeFileSync(configPath(), JSON.stringify({ modelsLocked: true }), 'utf8');
    expect((await put({ modelsLocked: null })).status).toBe(200);
    expect('modelsLocked' in rawFile()).toBe(false);

    // With the key gone the environment decides — and it still locks.
    process.env.XEZ_AGENT_MODELS_LOCKED = '1';
    const body = await getBody();
    expect(body).toMatchObject({ modelsLocked: true, projectModelsLocked: false });
    expect((await put({ defaultModels: { claude: 'opus' } })).status).toBe(409);
    // Clearing the project key again cannot disarm the environment's lock.
    expect((await put({ modelsLocked: false })).status).toBe(200);
    expect((await put({ defaultModels: { claude: 'opus' } })).status).toBe(409);
  });

  it('a workspace-config lock is reported apart from the project key (#677 C2)', async () => {
    writeFileSync(join(homeRoot, '.xezar', 'config.json'), JSON.stringify({ modelsLocked: true }), 'utf8');
    expect(await getBody()).toMatchObject({ modelsLocked: true, projectModelsLocked: false });
    expect((await put({ modelsLocked: false })).status).toBe(200);
    expect((await put({ defaultModels: { claude: 'opus' } })).status).toBe(409);
  });

  it('PUT modelsLocked refuses a non-boolean (#677 C2)', async () => {
    const res = await put({ modelsLocked: 'yes' });
    expect(res.status).toBe(400);
    expect(existsSync(configPath())).toBe(false);
  });

  it('PUT systemPrompt trims, persists, and round-trips through GET', async () => {
    const res = await put({ systemPrompt: '  Answer in bullet points.  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ systemPrompt: 'Answer in bullet points.' });
    expect((await getBody()).systemPrompt).toBe('Answer in bullet points.');
  });

  it('PUT systemPrompt null and "" both clear the raw key', async () => {
    await put({ systemPrompt: 'Be brief.' });
    expect(rawFile().systemPrompt).toBe('Be brief.');
    await put({ systemPrompt: null });
    expect(rawFile().systemPrompt).toBeUndefined();
    await put({ systemPrompt: 'Be brief.' });
    await put({ systemPrompt: '' });
    expect(rawFile().systemPrompt).toBeUndefined();
    expect((await getBody()).systemPrompt).toBeNull();
  });

  it('PUT defaultModels merges per runner instead of clobbering', async () => {
    await put({ defaultModels: { claude: 'opus' } });
    await put({ defaultModels: { codex: 'gpt-5.1-codex' } });
    expect((await getBody()).defaultModels).toEqual({
      claude: 'opus',
      codex: 'gpt-5.1-codex',
    });
    // Clearing one runner leaves the other; clearing the last drops the key.
    await put({ defaultModels: { codex: null } });
    expect(rawFile().defaultModels).toEqual({ claude: 'opus' });
    await put({ defaultModels: { claude: '' } });
    expect(rawFile().defaultModels).toBeUndefined();
  });

  /**
   * E — `plannerModel`, `namerModel` and `skillsRepos` were declared in the file schema but
   * absent from both the answer and `setConfigSchema`, so the only way to change them was to
   * hand-edit `.xezar/config.json`. Same clear-on-null shape as every other knob here, with
   * one deliberate exception: `skillsRepos: []` is stored, because an empty list is how a
   * repo turns team skills OFF and `gatedSkillsRepos` reads the key's PRESENCE.
   */
  it('plannerModel and namerModel round-trip, and null clears each back to its default', async () => {
    await put({ plannerModel: 'opus', namerModel: 'sonnet' });
    expect(rawFile().plannerModel).toBe('opus');
    expect(rawFile().namerModel).toBe('sonnet');
    let body = await getBody();
    expect(body.plannerModel).toBe('opus');
    expect(body.namerModel).toBe('sonnet');

    await put({ plannerModel: null, namerModel: null });
    expect(rawFile().plannerModel).toBeUndefined();
    expect(rawFile().namerModel).toBeUndefined();
    body = await getBody();
    expect(body.plannerModel).toBe('sonnet');
    expect(body.namerModel).toBe('haiku');
  });

  it('skillsRepos round-trips, stores [] as a real value, and null clears to the catalog', async () => {
    await put({ skillsRepos: [{ repo: 'acme/skills', ref: 'trunk' }] });
    expect(rawFile().skillsRepos).toEqual([{ repo: 'acme/skills', ref: 'trunk' }]);
    expect((await getBody()).skillsRepos).toEqual([{ repo: 'acme/skills', ref: 'trunk' }]);

    // Stored, NOT treated as a clear: `[]` is the documented "no team skills" spelling.
    await put({ skillsRepos: [] });
    expect(rawFile().skillsRepos).toEqual([]);
    expect((await getBody()).skillsRepos).toEqual([]);

    await put({ skillsRepos: null });
    expect(rawFile().skillsRepos).toBeUndefined();
    expect((await getBody()).skillsRepos).toEqual([{ repo: 'qodeca/xezar-skills', ref: 'main' }]);
  });

  it('PUT merges into the raw file — user keys survive, defaults never materialize', async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ skillsRepos: [{ repo: 'me/skills' }], maxParallel: 5 }),
      'utf8',
    );
    await put({ systemPrompt: 'Be brief.', defaultModels: { claude: 'opus' }, baseBranch: 'develop' });
    const raw = rawFile();
    expect(raw.skillsRepos).toEqual([{ repo: 'me/skills' }]);
    expect(raw.maxParallel).toBe(5);
    // No schema defaults leaked into the user's file.
    expect(raw.defaultRunner).toBeUndefined();
    expect(raw.plannerModel).toBeUndefined();
    expect(await (await get()).json()).toEqual({
      baseBranch: 'develop',
      defaultRunner: 'claude',
      systemPrompt: 'Be brief.',
      defaultModels: { claude: 'opus' },
      modelsLocked: false,
      projectModelsLocked: false,
      maxParallel: 5,
      memoryLimitMb: null,
      worktreeRetention: 10,
      liveTitleUpdates: null,
      reviewGate: null,
      // E — declared in the file schema since spec 008 but absent from this answer until
      // now, so the only way to change them was to hand-edit `.xezar/config.json`. All three
      // are `.default()`ed by the schema, hence materialized rather than tri-state.
      plannerModel: 'sonnet',
      namerModel: 'haiku',
      skillsRepos: [{ repo: 'me/skills', ref: 'main' }],
    });
  });

  it('PUT worktreeRetention persists, keeps 0 (unlimited), and null clears back to the default', async () => {
    const res = await put({ worktreeRetention: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ worktreeRetention: 3 });
    expect(rawFile().worktreeRetention).toBe(3);
    // 0 is a meaningful value (unlimited) — stored, not treated as "clear".
    await put({ worktreeRetention: 0 });
    expect(rawFile().worktreeRetention).toBe(0);
    expect((await getBody()).worktreeRetention).toBe(0);
    // null drops the key so it degrades to the schema default (10).
    await put({ worktreeRetention: null });
    expect(rawFile().worktreeRetention).toBeUndefined();
    expect((await getBody()).worktreeRetention).toBe(10);
  });

  it('rejects a negative or over-limit worktreeRetention with 400', async () => {
    expect((await put({ worktreeRetention: -1 })).status).toBe(400);
    expect((await put({ worktreeRetention: 1001 })).status).toBe(400);
  });

  it('PUT keeps the pre-R6 answer fields (protected shape) alongside the additive ones', async () => {
    const res = await put({ baseBranch: 'develop', defaultRunner: 'codex' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.baseBranch).toBe('develop');
    expect(body.defaultRunner).toBe('codex');
  });

  it('rejects an over-limit systemPrompt and a malformed defaultModels with 400 + reason', async () => {
    const tooLong = await put({ systemPrompt: 'x'.repeat(20_001) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toContain('20000');
    const badModels = await put({ defaultModels: { claude: 42 } });
    expect(badModels.status).toBe(400);
  });
});

describe('liveTitleUpdates round-trip (task auto-naming spec)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-configapi-title-'));
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawFile = () =>
    JSON.parse(readFileSync(join(repoRoot, '.xezar', 'config.json'), 'utf8')) as Record<string, unknown>;

  it('sets, answers and clears the key (null → env default decides)', async () => {
    const off = (await (await put({ liveTitleUpdates: false })).json()) as Record<string, unknown>;
    expect(off.liveTitleUpdates).toBe(false);
    expect(rawFile().liveTitleUpdates).toBe(false);

    const cleared = (await (await put({ liveTitleUpdates: null })).json()) as Record<string, unknown>;
    expect(cleared.liveTitleUpdates).toBeNull();
    expect(rawFile().liveTitleUpdates).toBeUndefined();
  });
});

describe('reviewGate round-trip (optional review gate, #489)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-configapi-gate-'));
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawFile = () =>
    JSON.parse(readFileSync(join(repoRoot, '.xezar', 'config.json'), 'utf8')) as Record<string, unknown>;

  it('GET exposes reviewGate; PUT true/false/null round-trips and clears the raw key', async () => {
    // Default (no config key) is null — the XEZ_REVIEW_GATE env (OFF) decides.
    expect(((await (await apiRequest(app, '/api/v1/config')).json()) as Record<string, unknown>).reviewGate).toBeNull();

    const on = (await (await put({ reviewGate: true })).json()) as Record<string, unknown>;
    expect(on.reviewGate).toBe(true);
    expect(rawFile().reviewGate).toBe(true);

    const off = (await (await put({ reviewGate: false })).json()) as Record<string, unknown>;
    expect(off.reviewGate).toBe(false);
    expect(rawFile().reviewGate).toBe(false);

    const cleared = (await (await put({ reviewGate: null })).json()) as Record<string, unknown>;
    expect(cleared.reviewGate).toBeNull();
    expect(rawFile().reviewGate).toBeUndefined();
  });
});

/**
 * #677 C1 — the cockpit's project-level memory ceiling writes `PUT /config {memoryLimitMb}`, and
 * enforcement reads the semaphore's cached snapshot, never the file. So the write is only worth
 * anything if the route refreshes that snapshot: these cases drive the REAL semaphore with its
 * production loader and read `projectMemoryLimitMb` straight after the PUT, with no restart in
 * between. Remove the route's `semaphore.refresh()` and the first case goes red.
 */
describe('the project memoryLimitMb write reaches enforcement without a restart (#677 C1)', () => {
  let repoRoot: string;
  let homeRoot: string;
  let store: RunStore;
  let semaphore: WorkspaceSemaphore;
  let app: Hono;
  const savedXezHome = process.env.XEZ_HOME;

  beforeEach(async () => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'xez-configapi-mem-')));
    homeRoot = mkdtempSync(join(tmpdir(), 'xez-configapi-mem-home-'));
    process.env.XEZ_HOME = homeRoot;
    mkdirSync(join(repoRoot, '.xezar'), { recursive: true });
    // The workspace ceiling, and this repo registered so the loader reads its own config.json.
    writeFileSync(
      join(homeRoot, 'config.json'),
      JSON.stringify({
        resources: { memoryLimitMb: 4096 },
        projects: [{ id: 'mem', root: repoRoot, name: 'mem', addedAt: '2026-09-21T00:00:00.000Z' }],
      }),
    );
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    semaphore = new WorkspaceSemaphore();
    await semaphore.refresh();
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', semaphore });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
    if (savedXezHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedXezHome;
  });

  const put = (body: unknown) =>
    apiRequest(app, '/api/v1/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawFile = () =>
    JSON.parse(readFileSync(join(repoRoot, '.xezar', 'config.json'), 'utf8')) as Record<string, unknown>;

  it('a project ceiling below the workspace one takes effect without a restart', async () => {
    expect(semaphore.projectMemoryLimitMb(repoRoot)).toBe(4096); // inherits before the write

    const res = await put({ memoryLimitMb: 1024 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).memoryLimitMb).toBe(1024);
    expect(rawFile().memoryLimitMb).toBe(1024);
    expect(semaphore.projectMemoryLimitMb(repoRoot)).toBe(1024);
    // The workspace ceiling itself is untouched — the project value is an override, not a rewrite.
    expect(semaphore.memoryLimitMb()).toBe(4096);
  });

  it.each([null, 0])('clearing with %s deletes the key and the project inherits again', async (clear) => {
    await put({ memoryLimitMb: 1024 });
    expect(semaphore.projectMemoryLimitMb(repoRoot)).toBe(1024);

    const res = await put({ memoryLimitMb: clear });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).memoryLimitMb).toBeNull();
    expect('memoryLimitMb' in rawFile()).toBe(false);
    expect(semaphore.projectMemoryLimitMb(repoRoot)).toBe(4096);
  });
});
