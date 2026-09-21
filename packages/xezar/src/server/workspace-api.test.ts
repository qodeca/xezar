import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceConfigPath, workspaceUiStatePath } from '../paths.ts';
import { DEFAULT_MEMORY_LIMIT_MB } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type WorkspaceConfigResponse } from './server.ts';
import { cliColorModeSchema, cliLogLevelSchema, cliOutputModeSchema } from '@qodeca/xezar-contract';
import { COLOR_MODES, LOG_LEVELS, OUTPUT_MODES } from '../cli-settings.ts';

/** What `cli` answers with nothing stored, no variable set and no narrowing (#467, PR 5). */
const DEFAULT_CLI: WorkspaceConfigResponse['cli'] = {
  instance: null,
  effectiveInstance: 'workspace',
  instanceSource: 'default',
  inForce: 'workspace',
  narrowing: null,
  output: null,
  effectiveOutput: 'auto',
  outputSource: 'default',
  color: null,
  effectiveColor: 'auto',
  colorSource: 'default',
  logLevel: null,
  effectiveLogLevel: 'info',
  logLevelSource: 'default',
};

/**
 * The workspace settings API (multi-project spec, step 2.7):
 * `GET/PUT /api/v1/workspace/config` — the settings slice of `~/.xezar/config.json`
 * with the `projectsDir` writability probe and the semaphore `refresh()` hook —
 * and `GET/PUT /api/v1/workspace/ui-state`, the global GUI state with the same
 * merge/key-cap semantics as the per-repo ui-state route. All workspace-level:
 * single-mount, never under `/api/v1/p/`.
 */
describe('the workspace settings API (step 2.7)', () => {
  const savedHome = process.env.XEZ_HOME;
  const savedBrowseRoot = process.env.XEZ_BROWSE_ROOT;
  const savedProjectsDir = process.env.XEZ_PROJECTS_DIR;
  const savedSkillsAutoUpdate = process.env.XEZ_SKILLS_AUTO_UPDATE;
  const savedAutonomousDefault = process.env.XEZ_AUTONOMOUS_DEFAULT;
  const savedWorktreeDefault = process.env.XEZ_WORKTREE_DEFAULT;
  const savedInstance = process.env.XEZ_INSTANCE;
  // #467 PR 5: every variable the `cli` answer reads. A developer's shell or a CI runner may set
  // any of them (`NO_COLOR` especially), and the default-state assertions below must not see it.
  const CLI_ENV = ['XEZ_OUTPUT', 'XEZ_COLOR', 'XEZ_LOG_LEVEL', 'NO_COLOR', 'XEZ_SINGLE_PROJECT'] as const;
  const savedCliEnv = Object.fromEntries(CLI_ENV.map((name) => [name, process.env[name]]));
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let semaphore: WorkspaceSemaphore;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'xez-workspace-api-'));
    process.env.XEZ_HOME = home; // paths.ts sends all workspace paths here
    delete process.env.XEZ_BROWSE_ROOT;
    delete process.env.XEZ_PROJECTS_DIR;
    delete process.env.XEZ_SKILLS_AUTO_UPDATE;
    delete process.env.XEZ_AUTONOMOUS_DEFAULT;
    delete process.env.XEZ_WORKTREE_DEFAULT;
    delete process.env.XEZ_FOLLOWUPS;
    delete process.env.XEZ_ENV_PASSTHROUGH;
    delete process.env.XEZ_INSTANCE;
    for (const name of CLI_ENV) delete process.env[name];
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-workspace-api-repo-'));
    mkdirSync(join(repoRoot, '.local/xezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.local/xezar'));
    // The REAL semaphore with its production loader (which reads the XEZ_HOME
    // config), so the PUT → refresh() → cached-limits chain is observed end to
    // end. The routes never touch the manager — an empty stub is honest.
    semaphore = new WorkspaceSemaphore();
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      semaphore,
    });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.XEZ_HOME;
    else process.env.XEZ_HOME = savedHome;
    if (savedBrowseRoot === undefined) delete process.env.XEZ_BROWSE_ROOT;
    else process.env.XEZ_BROWSE_ROOT = savedBrowseRoot;
    if (savedProjectsDir === undefined) delete process.env.XEZ_PROJECTS_DIR;
    else process.env.XEZ_PROJECTS_DIR = savedProjectsDir;
    if (savedSkillsAutoUpdate === undefined) delete process.env.XEZ_SKILLS_AUTO_UPDATE;
    else process.env.XEZ_SKILLS_AUTO_UPDATE = savedSkillsAutoUpdate;
    if (savedAutonomousDefault === undefined) delete process.env.XEZ_AUTONOMOUS_DEFAULT;
    else process.env.XEZ_AUTONOMOUS_DEFAULT = savedAutonomousDefault;
    if (savedWorktreeDefault === undefined) delete process.env.XEZ_WORKTREE_DEFAULT;
    else process.env.XEZ_WORKTREE_DEFAULT = savedWorktreeDefault;
    if (savedInstance === undefined) delete process.env.XEZ_INSTANCE;
    else process.env.XEZ_INSTANCE = savedInstance;
    for (const name of CLI_ENV) {
      if (savedCliEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedCliEnv[name];
    }
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const rawConfig = () => JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;

  const getConfig = () => apiRequest(app, '/api/v1/workspace/config');
  const putConfig = (body: unknown) =>
    apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ---- GET/PUT /api/v1/workspace/config ---------------------------------------

  it('GET answers the zero-config defaults when no file exists — and never the registry', async () => {
    const res = await getConfig();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceConfigResponse & Record<string, unknown>;
    expect(body).toEqual({
      browseRoot: '~/',
      projectsDir: '~/xezar/projects',
      skillsAutoUpdate: null,
      effectiveSkillsAutoUpdate: true,
      // F — the two boot-time env switches became stored settings. `null` = no stored key,
      // so the env still decides; the `effective*` twin is what the cockpit renders.
      followups: null,
      effectiveFollowups: false,
      agentEnvPassthrough: null,
      effectiveAgentEnvPassthrough: [],
      composerDefaults: {
        autonomous: null,
        worktree: null,
        inheritedAutonomous: 'source-dependent',
        inheritedWorktree: true,
      },
      resources: {
        maxParallel: 2,
        maxMonitoringSessions: 2,
        monitoringWakeIntervalMinutes: 5,
        autoResumeOnUsageLimit: true,
        idleTimeoutMinutes: 15,
        memoryLimitMb: DEFAULT_MEMORY_LIMIT_MB,
        memoryLimitDefaultMb: DEFAULT_MEMORY_LIMIT_MB,
        worktreeRetentionDefault: 10,
      },
      // Machine-wide agent defaults (spec 2026-07-29-agent-profiles). EMPTY, not populated: absent
      // keys mean "this machine has no opinion", which is what makes them defaults a repo can be
      // silent about rather than settings every checkout inherits a value from.
      agentDefaults: {},
      // #467 PR 5. Nothing stored, no variable, and this app was built without an `instanceMode`
      // dep — the defaults every xezar has always had, each key spelled as stored / next start /
      // source because the three answer three different questions.
      cli: DEFAULT_CLI,
    });
    // Absolute project roots belong on /api/v1/projects; schemaVersion is a
    // migration cursor, not a setting.
    expect(body.projects).toBeUndefined();
    expect(body.schemaVersion).toBeUndefined();
  });

  it('GET resolves both zero-config roots from the environment', async () => {
    process.env.XEZ_BROWSE_ROOT = '~/source';
    process.env.XEZ_PROJECTS_DIR = '~/clones';
    const body = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(body).toMatchObject({ browseRoot: '~/source', projectsDir: '~/clones' });
  });

  it('PUT resources round-trips, persists to disk, and refreshes the semaphore cache', async () => {
    expect(semaphore.maxParallel()).toBe(2); // the pre-PUT snapshot
    const res = await putConfig({
      resources: {
        maxParallel: 5,
        maxMonitoringSessions: 3,
        monitoringWakeIntervalMinutes: 5,
        autoResumeOnUsageLimit: false,
        memoryLimitMb: 2048,
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as WorkspaceConfigResponse).toEqual({
      browseRoot: '~/',
      projectsDir: '~/xezar/projects',
      skillsAutoUpdate: null,
      effectiveSkillsAutoUpdate: true,
      // F — the two boot-time env switches became stored settings. `null` = no stored key,
      // so the env still decides; the `effective*` twin is what the cockpit renders.
      followups: null,
      effectiveFollowups: false,
      agentEnvPassthrough: null,
      effectiveAgentEnvPassthrough: [],
      composerDefaults: {
        autonomous: null,
        worktree: null,
        inheritedAutonomous: 'source-dependent',
        inheritedWorktree: true,
      },
      resources: {
        maxParallel: 5,
        maxMonitoringSessions: 3,
        monitoringWakeIntervalMinutes: 5,
        autoResumeOnUsageLimit: false,
        idleTimeoutMinutes: 15,
        memoryLimitMb: 2048,
        memoryLimitDefaultMb: DEFAULT_MEMORY_LIMIT_MB,
        worktreeRetentionDefault: 10,
      },
      // Untouched by a resources write, and still empty — the two live in the same file but answer
      // unrelated questions, so one must never materialize the other.
      agentDefaults: {},
      cli: DEFAULT_CLI,
    });
    // Round-trip through GET and the raw file.
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.maxParallel).toBe(5);
    expect((rawConfig().resources as Record<string, unknown>).maxParallel).toBe(5);
    // The step-2.5 hook fired: the new cap applies WITHOUT a restart.
    expect(semaphore.maxParallel()).toBe(5);
    expect(semaphore.maxMonitoringSessions()).toBe(3);
    expect(semaphore.monitoringWakeIntervalMinutes()).toBe(5);
    // Default-ON, so the write worth pinning is the one that turns it OFF (spec
    // 2026-08-03-auto-resume-after-usage-limit) — and it reaches the shared cache the engine
    // asks, not just the file.
    expect(semaphore.autoResumeOnUsageLimit()).toBe(false);
    expect(semaphore.memoryLimitMb()).toBe(2048);
  });

  /** #810 — the cadence now ships ON, so the write worth pinning is the one that turns it
   *  OFF. `null` must survive the round-trip and reach the semaphore as `null`; re-defaulting
   *  it to 5 would silently overrule an operator who chose "Park until resumed". */
  it('PUT null parks monitoring and is never re-defaulted back to the shipped cadence', async () => {
    expect(semaphore.monitoringWakeIntervalMinutes()).toBe(5); // the zero-config default
    const res = await putConfig({ resources: { monitoringWakeIntervalMinutes: null } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).resources.monitoringWakeIntervalMinutes).toBeNull();
    expect(
      ((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.monitoringWakeIntervalMinutes,
    ).toBeNull();
    expect((rawConfig().resources as Record<string, unknown>).monitoringWakeIntervalMinutes).toBeNull();
    expect(semaphore.monitoringWakeIntervalMinutes()).toBeNull();
  });

  it('partial updates leave the other keys untouched', async () => {
    await putConfig({ resources: { maxParallel: 5 } });
    await putConfig({ resources: { worktreeRetentionDefault: 3 } });
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources).toEqual({
      maxParallel: 5,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: 5,
      autoResumeOnUsageLimit: true,
      idleTimeoutMinutes: 15,
      memoryLimitMb: DEFAULT_MEMORY_LIMIT_MB,
      memoryLimitDefaultMb: DEFAULT_MEMORY_LIMIT_MB,
      worktreeRetentionDefault: 3,
    });
  });

  /**
   * A — the idle timeout round-trips through the API and reaches the shared cache the engine
   * actually asks, not just the file. `null` is the "never close on idle" choice and, like
   * `monitoringWakeIntervalMinutes`, must never be re-defaulted away.
   */
  it('PUT idleTimeoutMinutes round-trips and refreshes the semaphore cache', async () => {
    expect(semaphore.idleTimeoutMinutes()).toBe(15); // the zero-config default
    const res = await putConfig({ resources: { idleTimeoutMinutes: 120 } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).resources.idleTimeoutMinutes).toBe(120);
    expect((rawConfig().resources as Record<string, unknown>).idleTimeoutMinutes).toBe(120);
    expect(semaphore.idleTimeoutMinutes()).toBe(120);

    await putConfig({ resources: { idleTimeoutMinutes: null } });
    expect(
      ((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.idleTimeoutMinutes,
    ).toBeNull();
    expect(semaphore.idleTimeoutMinutes()).toBeNull();
  });

  it('rejects an out-of-bounds idle timeout with 400 and writes nothing', async () => {
    for (const body of [{ idleTimeoutMinutes: 0 }, { idleTimeoutMinutes: 1441 }]) {
      const res = await putConfig({ resources: body as never });
      expect(res.status).toBe(400);
    }
    expect(semaphore.idleTimeoutMinutes()).toBe(15);
  });

  /**
   * F — the two boot-time env switches are stored settings, and they refresh through the same
   * `semaphore.refresh()` hook a `resources` write already fires, rather than a second reload
   * path. `null` clears each key back to its env-decided default.
   */
  it('PUT followups round-trips, wins over the env, and null clears back to it', async () => {
    process.env.XEZ_FOLLOWUPS = '1';
    // Nothing stored: the env still decides, read live rather than from the cache.
    expect(semaphore.storedFollowups()).toBeUndefined();
    expect(semaphore.followupsEnabled()).toBe(true);

    const on = (await (await putConfig({ followups: false })).json()) as WorkspaceConfigResponse;
    expect(on.followups).toBe(false);
    expect(on.effectiveFollowups).toBe(false); // the stored `false` beats XEZ_FOLLOWUPS=1
    expect(rawConfig().followups).toBe(false);
    expect(semaphore.storedFollowups()).toBe(false);
    expect(semaphore.followupsEnabled()).toBe(false);

    const cleared = (await (await putConfig({ followups: null })).json()) as WorkspaceConfigResponse;
    expect(cleared.followups).toBeNull();
    expect(cleared.effectiveFollowups).toBe(true); // back to the env
    expect(rawConfig().followups).toBeUndefined();
    expect(semaphore.storedFollowups()).toBeUndefined();
    expect(semaphore.followupsEnabled()).toBe(true);
  });

  it('PUT agentEnvPassthrough round-trips, and an empty list is a real stored choice', async () => {
    process.env.XEZ_ENV_PASSTHROUGH = 'FROM_ENV';
    const set = (await (
      await putConfig({ agentEnvPassthrough: ['VITEST_MAX_WORKERS'] })
    ).json()) as WorkspaceConfigResponse;
    expect(set.agentEnvPassthrough).toEqual(['VITEST_MAX_WORKERS']);
    expect(set.effectiveAgentEnvPassthrough).toEqual(['VITEST_MAX_WORKERS']);
    expect(semaphore.agentEnvPassthrough()).toEqual(['VITEST_MAX_WORKERS']);

    const emptied = (await (await putConfig({ agentEnvPassthrough: [] })).json()) as WorkspaceConfigResponse;
    expect(emptied.agentEnvPassthrough).toEqual([]);
    // NOT the env: an empty stored list means "forward nothing", not "no opinion".
    expect(emptied.effectiveAgentEnvPassthrough).toEqual([]);
    expect(semaphore.agentEnvPassthrough()).toEqual([]);

    const cleared = (await (
      await putConfig({ agentEnvPassthrough: null })
    ).json()) as WorkspaceConfigResponse;
    expect(cleared.agentEnvPassthrough).toBeNull();
    expect(cleared.effectiveAgentEnvPassthrough).toEqual(['FROM_ENV']);
    expect(rawConfig().agentEnvPassthrough).toBeUndefined();
    expect(semaphore.agentEnvPassthrough()).toEqual(['FROM_ENV']);
  });

  /**
   * #467 PR 5 — `cli.instance`, the one stored key of this route that is a BOOT decision.
   *
   * Named break `null-does-not-clear`: make the `null` branch store `'workspace'` instead of
   * removing the key and the third block goes red — the file keeps a stored `workspace` that
   * would outrank `XEZ_INSTANCE` forever, which is the opposite of what clearing means.
   */
  it('PUT cli.instance round-trips, wins over the env, and null clears back to it', async () => {
    process.env.XEZ_INSTANCE = 'project';
    // Nothing stored: `XEZ_INSTANCE` decides what the next start resolves.
    expect((await (await getConfig()).json()) as WorkspaceConfigResponse).toMatchObject({
      cli: { instance: null, effectiveInstance: 'project', instanceSource: 'env', inForce: 'workspace' },
    });

    const stored = (await (await putConfig({ cli: { instance: 'workspace' } })).json()) as WorkspaceConfigResponse;
    // The stored value beats the variable, the way `cli.output` and `cli.logLevel` already do.
    expect(stored.cli).toEqual({
      ...DEFAULT_CLI,
      instance: 'workspace',
      effectiveInstance: 'workspace',
      instanceSource: 'stored',
    });
    expect(rawConfig().cli).toEqual({ instance: 'workspace' });

    const cleared = (await (await putConfig({ cli: { instance: null } })).json()) as WorkspaceConfigResponse;
    expect(cleared.cli).toEqual({ ...DEFAULT_CLI, effectiveInstance: 'project', instanceSource: 'env' });
    // The KEY is gone, and so is the object it was the only tenant of — `{}` would persist a
    // key that says nothing, and an absent `cli` is what "never chosen" has always looked like.
    expect(rawConfig().cli).toBeUndefined();
  });

  /**
   * Named break `cli-key-cleared-by-unrelated-write` (AC-5.4): materialize `cli` on every write
   * — `config.cli = { ...(config.cli ?? {}), ...}` outside the `cli !== undefined` guard — and
   * this goes red. It is the same absent-vs-explicit discipline `memoryLimitMb` and `followups`
   * carry, and the cheapest way to lose a stored setting is a write that never mentioned it.
   */
  it('a PUT that does not name cli leaves the stored key byte-identical on disk', async () => {
    await putConfig({ cli: { instance: 'project' } });
    const before = readFileSync(workspaceConfigPath(), 'utf8');
    expect(JSON.stringify(rawConfig().cli)).toBe('{"instance":"project"}');

    for (const unrelated of [
      { resources: { maxParallel: 6 } },
      { followups: true },
      { agentDefaults: { runner: 'codex' } },
    ]) {
      const res = await putConfig(unrelated);
      expect(res.status, JSON.stringify(unrelated)).toBe(200);
      expect(((await res.json()) as WorkspaceConfigResponse).cli.instance).toBe('project');
      expect(JSON.stringify(rawConfig().cli), JSON.stringify(unrelated)).toBe('{"instance":"project"}');
    }
    expect(before).not.toBe(readFileSync(workspaceConfigPath(), 'utf8')); // the writes DID land
  });

  /** A sibling nobody wrote through this route keeps the object alive when `instance` clears. */
  it('clearing cli.instance keeps a stored presentation sibling and never re-serializes it', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({ cli: { output: 'rich', logLevel: 'debug', instance: 'project' } }),
      'utf8',
    );
    await putConfig({ cli: { instance: null } });
    expect(rawConfig().cli).toEqual({ output: 'rich', logLevel: 'debug' });
  });

  /**
   * Named break `inForce-mirrors-stored`: answer `inForce` from the stored value (or from
   * `effectiveInstance`) instead of `deps.instanceMode` and this goes red. A cockpit narrowed by
   * `XEZ_SINGLE_PROJECT` or by a folder that owns its xezar state serves ONE project whatever the
   * file says, and a Settings pane that echoed `workspace` back would be describing the file
   * while claiming to describe the cockpit.
   */
  it('inForce reports what THIS process does, not what the file stores', async () => {
    await putConfig({ cli: { instance: 'workspace' } });
    for (const mode of ['narrowed', 'project', 'workspace'] as const) {
      const narrowedApp = createApp({
        repoRoot,
        store,
        manager: {} as RunManager,
        version: '0.0.0-test',
        semaphore,
        instanceMode: mode,
      });
      const body = (await (await apiRequest(narrowedApp, '/api/v1/workspace/config')).json()) as WorkspaceConfigResponse;
      expect(body.cli, mode).toEqual({
        ...DEFAULT_CLI,
        instance: 'workspace',
        effectiveInstance: 'workspace',
        instanceSource: 'stored',
        inForce: mode,
        // The env-flag answer: this app has no `instanceNarrowing` dep and the test home is the
        // global layout, so `singleProjectNarrowing()` has nothing but the fallback to say.
        narrowing: mode === 'narrowed' ? 'env-flag' : null,
      });
    }
  });

  it('refuses a mode this vocabulary does not know, and an unknown cli key, without writing', async () => {
    await putConfig({ cli: { instance: 'project' } });
    for (const bad of [
      { cli: { instance: 'both' } },
      { cli: { output: 'plain' } },
      { cli: { color: 'yes' } },
      { cli: { logLevel: 'verbose' } },
      { cli: { port: 4321 } },
      { cli: 'project' },
    ]) {
      const res = await putConfig(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(Object.keys((await res.json()) as object)).toEqual(['error']);
    }
    expect(rawConfig().cli).toEqual({ instance: 'project' });
  });

  /**
   * Design review B-2 on PR #798: WHICH narrowing is in force, because the pane treats them
   * differently — a folder that owns its state can never be widened by a stored mode, while
   * `XEZ_SINGLE_PROJECT` writes to this machine's file that a start elsewhere reads.
   */
  it('narrowing names the narrowing in force, and is null without one', async () => {
    for (const [instanceMode, instanceNarrowing, expected] of [
      ['narrowed', 'project-root', 'project-root'],
      ['narrowed', 'env-flag', 'env-flag'],
      ['workspace', undefined, null],
      ['project', undefined, null],
    ] as const) {
      const narrowedApp = createApp({
        repoRoot,
        store,
        manager: {} as RunManager,
        version: '0.0.0-test',
        semaphore,
        instanceMode,
        ...(instanceNarrowing !== undefined ? { instanceNarrowing } : {}),
      });
      const body = (await (await apiRequest(narrowedApp, '/api/v1/workspace/config')).json()) as WorkspaceConfigResponse;
      expect(body.cli.narrowing, `${instanceMode}/${instanceNarrowing}`).toBe(expected);
    }
  });

  /**
   * The owner's D-5 (2026-09-20): the three presentation keys through the same door, each with the
   * same absent-vs-explicit discipline as `instance`. Named break `sibling-null-does-not-clear`:
   * make the `null` branch store the default instead of deleting the key and the cleared block goes
   * red — a stored `auto` would outrank `XEZ_OUTPUT` for good.
   */
  it('PUT cli.output, cli.color and cli.logLevel round-trip, beat the env, and null clears each', async () => {
    process.env.XEZ_OUTPUT = 'lines';
    process.env.XEZ_LOG_LEVEL = 'warn';
    const before = ((await (await getConfig()).json()) as WorkspaceConfigResponse).cli;
    expect(before).toMatchObject({
      output: null,
      effectiveOutput: 'lines',
      outputSource: 'env',
      logLevel: null,
      effectiveLogLevel: 'warn',
      logLevelSource: 'env',
      color: null,
      effectiveColor: 'auto',
      colorSource: 'default',
    });

    const stored = (await (await putConfig({ cli: { output: 'rich', color: 'never', logLevel: 'debug' } })).json()) as WorkspaceConfigResponse;
    expect(stored.cli).toMatchObject({
      output: 'rich',
      effectiveOutput: 'rich',
      outputSource: 'stored',
      color: 'never',
      effectiveColor: 'never',
      colorSource: 'stored',
      logLevel: 'debug',
      effectiveLogLevel: 'debug',
      logLevelSource: 'stored',
      instance: null,
    });
    expect(rawConfig().cli).toEqual({ output: 'rich', color: 'never', logLevel: 'debug' });

    // One key cleared: the other two are untouched on disk.
    const cleared = (await (await putConfig({ cli: { output: null } })).json()) as WorkspaceConfigResponse;
    expect(cleared.cli).toMatchObject({ output: null, effectiveOutput: 'lines', outputSource: 'env' });
    expect(JSON.stringify(rawConfig().cli)).toBe('{"color":"never","logLevel":"debug"}');

    await putConfig({ cli: { color: null, logLevel: null } });
    expect(rawConfig().cli).toBeUndefined();
  });

  /** `NO_COLOR` outranks a stored colour at a real start, so the answer says so rather than lying. */
  it('reports NO_COLOR as the source of the colour it forces', async () => {
    await putConfig({ cli: { color: 'always' } });
    process.env.NO_COLOR = '1';
    const body = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(body.cli).toMatchObject({ color: 'always', effectiveColor: 'never', colorSource: 'no-color' });
  });

  /** AC-5.4 for the siblings: a write that names one `cli` key never touches another. */
  it('a PUT naming one cli key leaves every other stored cli key untouched', async () => {
    const baseline = { instance: 'project', output: 'lines', color: 'always', logLevel: 'error' };
    for (const [key, value] of [
      ['instance', 'workspace'],
      ['output', 'rich'],
      ['color', 'never'],
      ['logLevel', 'info'],
    ] as const) {
      writeFileSync(workspaceConfigPath(), JSON.stringify({ cli: baseline }), 'utf8');
      expect((await putConfig({ cli: { [key]: value } })).status, key).toBe(200);
      // Same keys, one value changed. (Key ORDER is the workspace schema's on every write, which
      // is why this compares values; the byte-identical promise is for a write that names no
      // `cli` key at all, pinned above.)
      expect(rawConfig().cli, key).toEqual({ ...baseline, [key]: value });
    }
    writeFileSync(workspaceConfigPath(), JSON.stringify({ cli: baseline }), 'utf8');
    await putConfig({ cli: {} });
    expect(rawConfig().cli).toEqual(baseline);
  });

  /** The contract spells the vocabularies for the browser; `cli-settings.ts` owns them at runtime. */
  it('the contract vocabularies are the runtime vocabularies', () => {
    expect(cliOutputModeSchema.options).toEqual([...OUTPUT_MODES]);
    expect(cliColorModeSchema.options).toEqual([...COLOR_MODES]);
    expect(cliLogLevelSchema.options).toEqual([...LOG_LEVELS]);
  });

  it('PUT stores explicit auto-update values and null clears back to the inherited env value', async () => {
    process.env.XEZ_SKILLS_AUTO_UPDATE = '0';
    expect((await (await getConfig()).json()) as WorkspaceConfigResponse).toMatchObject({
      skillsAutoUpdate: null,
      effectiveSkillsAutoUpdate: false,
    });

    const explicit = (await (await putConfig({ skillsAutoUpdate: true })).json()) as WorkspaceConfigResponse;
    expect(explicit).toMatchObject({ skillsAutoUpdate: true, effectiveSkillsAutoUpdate: true });
    expect(rawConfig().skillsAutoUpdate).toBe(true);

    const inherited = (await (await putConfig({ skillsAutoUpdate: null })).json()) as WorkspaceConfigResponse;
    expect(inherited).toMatchObject({ skillsAutoUpdate: null, effectiveSkillsAutoUpdate: false });
    expect(rawConfig().skillsAutoUpdate).toBeUndefined();
  });

  it('PUT stores and independently clears composer defaults while exposing env inheritance', async () => {
    process.env.XEZ_AUTONOMOUS_DEFAULT = '1';
    process.env.XEZ_WORKTREE_DEFAULT = '0';
    const inherited = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(inherited.composerDefaults).toEqual({
      autonomous: null,
      worktree: null,
      inheritedAutonomous: true,
      inheritedWorktree: false,
    });

    const explicit = (await (await putConfig({
      composerDefaults: { autonomous: false, worktree: true },
    })).json()) as WorkspaceConfigResponse;
    expect(explicit.composerDefaults).toMatchObject({ autonomous: false, worktree: true });
    expect(rawConfig().composerDefaults).toMatchObject({ autonomous: false, worktree: true });

    await putConfig({ composerDefaults: { worktree: null } });
    expect(rawConfig().composerDefaults).toEqual({ autonomous: false });
  });

  it('rejects invalid auto-update values without writing', async () => {
    expect((await putConfig({ skillsAutoUpdate: 'false' })).status).toBe(400);
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow();
  });

  it('rejects out-of-bounds resources with 400 and writes nothing', async () => {
    for (const resources of [{ maxParallel: 0 }, { maxParallel: 17 }, { memoryLimitMb: -1 }]) {
      const res = await putConfig({ resources });
      expect(res.status, JSON.stringify(resources)).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty('error');
    }
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow(); // never created
    expect(semaphore.maxParallel()).toBe(2);
  });

  it('a merge-written PUT never clobbers the registry or unknown keys (passthrough)', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({
        projects: [{ id: 'xezar', root: '/tmp/projects/xezar' }],
        futureKey: true,
      }),
      'utf8',
    );
    await putConfig({ resources: { maxParallel: 4 } });
    const raw = rawConfig();
    // The merge-write materializes the entry's schema defaults (name, dates…) —
    // what matters is the registration itself survives a settings PUT.
    expect(raw.projects).toMatchObject([{ id: 'xezar', root: '/tmp/projects/xezar' }]);
    expect(raw.futureKey).toBe(true);
    expect((raw.resources as Record<string, unknown>).maxParallel).toBe(4);
  });

  it('PUT projectsDir creates the directory, probes it, and stores the path as written', async () => {
    const dir = join(home, 'checkouts');
    const res = await putConfig({ projectsDir: dir });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).projectsDir).toBe(dir);
    expect(rawConfig().projectsDir).toBe(dir);
    // mkdir -p happened; the probe file was cleaned up.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('PUT browseRoot accepts and persists an existing independent browse directory', async () => {
    const browseRoot = join(home, 'source', 'repos');
    mkdirSync(browseRoot, { recursive: true });
    const res = await putConfig({ browseRoot });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).browseRoot).toBe(browseRoot);
    expect(rawConfig().browseRoot).toBe(browseRoot);
    expect(readdirSync(browseRoot)).toEqual([]);
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).projectsDir).toBe(
      '~/xezar/projects',
    );
  });

  it('PUT browseRoot warns for a missing directory without creating or persisting it', async () => {
    const existing = join(home, 'existing-source');
    mkdirSync(existing);
    expect((await putConfig({ browseRoot: existing })).status).toBe(200);

    const missing = join(home, 'missing', 'source');
    const res = await putConfig({ browseRoot: missing });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: `browse folder does not exist: ${missing}`,
    });
    expect(existsSync(missing)).toBe(false);
    expect(rawConfig().browseRoot).toBe(existing);
  });

  it('an unwritable projectsDir answers 400 "not writable: …" and persists NO change', async () => {
    await putConfig({ projectsDir: join(home, 'checkouts') }); // a known-good value first
    // A path under a regular file can never be created — fails on every
    // platform and uid (unlike a chmod 0500 dir, which root would ignore).
    writeFileSync(join(home, 'blocker'), 'not a directory', 'utf8');
    const res = await putConfig({ projectsDir: join(home, 'blocker', 'sub') });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^not writable: /);
    // The config on disk still holds the previous value.
    expect(rawConfig().projectsDir).toBe(join(home, 'checkouts'));
  });

  it('a relative projectsDir is refused before any probe touches the filesystem', async () => {
    const res = await putConfig({ projectsDir: 'relative/path' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^not writable: /);
  });

  it('a relative browseRoot is refused before any probe touches the filesystem', async () => {
    const res = await putConfig({ browseRoot: 'relative/path' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^not writable: /);
  });

  it('a malformed body answers 400 {error}', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      body: 'nonsense',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  // ---- GET/PUT /api/v1/workspace/ui-state -------------------------------------

  const getUiState = () => apiRequest(app, '/api/v1/workspace/ui-state');
  const putUiState = (body: unknown) =>
    apiRequest(app, '/api/v1/workspace/ui-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawUiState = () => JSON.parse(readFileSync(workspaceUiStatePath(), 'utf8')) as Record<string, unknown>;

  it('GET answers {} when no file exists yet', async () => {
    const res = await getUiState();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('PUT merges shallowly into ~/.xezar/ui-state.json — later keys never drop earlier ones', async () => {
    expect((await putUiState({ appearance: { accent: 'violet' } })).status).toBe(200);
    const res = await putUiState({ sidebar: { collapsed: { xezar: true } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appearance: { accent: 'violet' },
      sidebar: { collapsed: { xezar: true } },
    });
    expect(rawUiState()).toEqual({
      appearance: { accent: 'violet' },
      sidebar: { collapsed: { xezar: true } },
    });
    // The workspace file, not the boot repo's — the per-repo twin stays empty.
    expect(await (await apiRequest(app, '/api/v1/ui-state')).json()).toEqual({});
  });

  it('round-trips task-table choices and preserves unknown nested siblings', async () => {
    const res = await putUiState({
      taskTable: {
        expandedColumns: { branch: false, workflow: true, futureColumn: false },
        futurePreference: { compact: true },
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      taskTable: {
        expandedColumns: { branch: false, workflow: true, futureColumn: false },
        futurePreference: { compact: true },
      },
    });
    expect(rawUiState()).toEqual({
      taskTable: {
        expandedColumns: { branch: false, workflow: true, futureColumn: false },
        futurePreference: { compact: true },
      },
    });
  });

  it.each([
    ['a non-boolean value', { branch: 'yes' }],
    ['an empty id', { '': true }],
    ['an overlong id', { ['x'.repeat(65)]: true }],
    [
      'more than 50 entries',
      Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`column-${index}`, true])),
    ],
  ])('rejects task-table expanded columns with %s without writing state', async (_case, expandedColumns) => {
    const res = await putUiState({ taskTable: { expandedColumns } });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('round-trips a bounded last project location including query and hash', async () => {
    const lastLocation = {
      projectId: 'storefront',
      pathname: '/p/storefront/runs/run-123',
      search: '?tab=events',
      hash: '#tool-call-9',
    };

    const res = await putUiState({ lastLocation });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lastLocation });
    expect(await (await getUiState()).json()).toMatchObject({ lastLocation });
    expect(rawUiState()).toMatchObject({ lastLocation });
  });

  it.each([
    ['an empty project id', { projectId: '', pathname: '/p/storefront/' }],
    ['an overlong project id', { projectId: 'p'.repeat(65), pathname: '/p/storefront/' }],
    ['a non-project pathname', { projectId: 'storefront', pathname: '/settings/global' }],
    ['an overlong pathname', { projectId: 'storefront', pathname: `/p/storefront/${'x'.repeat(2035)}` }],
    ['a search without its prefix', { projectId: 'storefront', pathname: '/p/storefront/', search: 'tab=runs' }],
    [
      'an overlong search',
      { projectId: 'storefront', pathname: '/p/storefront/', search: `?${'x'.repeat(4096)}` },
    ],
    ['a hash without its prefix', { projectId: 'storefront', pathname: '/p/storefront/', hash: 'run-1' }],
    [
      'an overlong hash',
      { projectId: 'storefront', pathname: '/p/storefront/', hash: `#${'x'.repeat(2048)}` },
    ],
    ['a non-string field', { projectId: 'storefront', pathname: 42 }],
    ['an unknown field', { projectId: 'storefront', pathname: '/p/storefront/', extra: true }],
  ])('rejects lastLocation with %s without writing state', async (_case, lastLocation) => {
    const res = await putUiState({ lastLocation });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  // Every Settings → Appearance preference has to be listed in `appearanceSchema`: the top-level
  // `.passthrough()` does NOT reach inside `appearance`, so an unlisted key is stripped here and
  // then wiped from the file by the shallow merge. The cockpit adopts this response as
  // authoritative, so a stripped key visibly reverts the control the user just touched — which is
  // exactly what happened to `width` before it was added. The client-side settings test stubs
  // `fetch` with an echo, so this route-level round-trip is the only place that can catch it.
  it('round-trips every appearance preference — accent, density AND reading width', async () => {
    const res = await putUiState({ appearance: { accent: 'violet', density: 'compact', width: 'wide' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
    });
    expect(rawUiState()).toEqual({
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
    });
  });

  it('round-trips the roomy density (#424 step 4)', async () => {
    const res = await putUiState({ appearance: { density: 'roomy' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appearance: { density: 'roomy' } });
    expect(rawUiState()).toEqual({ appearance: { density: 'roomy' } });
  });

  it('rejects an unknown density without writing state', async () => {
    const res = await putUiState({ appearance: { density: 'spacious' } });
    expect(res.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('rejects an out-of-enum reading width instead of silently dropping it', async () => {
    const res = await putUiState({ appearance: { width: 'ultrawide' } });
    expect(res.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('accepts bounded provider auth failure dismissals', async () => {
    const response = await putUiState({
      dismissedProviderAuthFailures: {
        claude: 'incident-1',
        opencode: 'incident-9',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dismissedProviderAuthFailures: {
        claude: 'incident-1',
        opencode: 'incident-9',
      },
    });
  });

  it.each([
    ['an unknown provider', { future: 'incident-1' }],
    ['an empty incident ID', { claude: '' }],
    ['a non-string incident ID', { claude: 1 }],
    ['an overlong incident ID', { claude: 'a'.repeat(129) }],
  ])('rejects provider auth failure dismissals with %s without writing state', async (_case, dismissals) => {
    const response = await putUiState({ dismissedProviderAuthFailures: dismissals });
    expect(response.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('unknown keys pass through and survive later PUTs (additive, like the per-repo route)', async () => {
    await putUiState({ futurePref: { nested: 1 } });
    await putUiState({ notifications: { enabled: true } });
    expect(rawUiState()).toEqual({
      futurePref: { nested: 1 },
      notifications: { enabled: true },
    });
  });

  it('rejects a malformed known key instead of writing garbage', async () => {
    const res = await putUiState({ sidebar: { collapsed: { xezar: 'yes' } } });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow(); // nothing written
  });

  it('caps the top-level key count at 200, same as the per-repo route', async () => {
    const keysOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pref-${i}`, true]));
    expect((await putUiState(keysOf(200))).status).toBe(200);
    const over = await putUiState(keysOf(201));
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toContain('too many keys');
    // The at-cap state from the previous PUT still stands.
    expect(Object.keys(rawUiState())).toHaveLength(200);
  });
});
