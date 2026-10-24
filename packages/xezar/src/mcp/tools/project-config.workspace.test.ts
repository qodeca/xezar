// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './mcp-test-home.testkit.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_FILES } from '../../agent-config/catalog.ts';
import { loadConfig, resolveWorktreeRetention } from '../../config.ts';
import {
  useProjectConfigWorkspace,
  COCKPIT_HOST,
  ws,
  cockpit,
  spyService,
  invoke,
  value,
  startViaTaskCreate,
  hotCockpit,
} from './project-config.testkit.ts';

/**
 * Project configuration tools (#97): the workspace-settings write (#677 B1) and the shared
 * preference write (#677 B3).
 * The fixture — a real app over a real two-project registry in a sandboxed `XEZ_HOME`, with agent
 * homes seeded with an account identity — and its helpers live in `project-config.testkit.ts`.
 */

useProjectConfigWorkspace();

// ---- the workspace-settings write ----------------------------------------------------------------

/**
 * #677 wave 2 slice B1 — `set_workspace_config`.
 *
 * The owner's rule of 2026-09-20 ("every key") reverses D-03 § 4.9's "never from MCP" for the
 * workspace SETTINGS. What this block proves is that the reversal is a DISPATCH and not a second
 * write path: the same route, the same validator, the same 400, the same `semaphore.refresh()`.
 * The two workspace folder paths are still not keys of it (slice B2), and an unknown key is
 * refused rather than dropped — a dropped key would answer 200 for a change that never happened.
 *
 * The hot-apply cases use their OWN app over the same sandboxed `XEZ_HOME`, because the shared
 * fixture pins the semaphore's loader at a constant. Here the semaphore loads for real, so
 * "applies without a restart" is observed rather than asserted.
 */
describe('project_config: the workspace-settings write (#677 B1)', () => {
  /** A real file inside the sandboxed workspace home — a path that exists and is NOT a directory. */
  function writeTemp(name: string): string {
    const file = join(ws.home, name);
    writeFileSync(file, 'not a directory\n', 'utf8');
    return file;
  }


  it('writes every key it accepts and answers in the get_limits vocabulary', async () => {
    const change = {
      resources: { maxParallel: 5, maxMonitoringSessions: 3, monitoringWakeIntervalMinutes: null, autoResumeOnUsageLimit: false, idleTimeoutMinutes: 30, memoryLimitMb: 4096, worktreeRetentionDefault: 7 },
      followups: false,
      agentEnvPassthrough: ['CI'],
      composerDefaults: { autonomous: true, worktree: false },
      skillsAutoUpdate: false,
      agentDefaults: { runner: 'codex', models: { codex: 'gpt-5.6-sol' } },
    };
    const written = value(await invoke({ action: 'set_workspace_config', workspaceConfig: change }));
    const limits = value(await invoke({ action: 'get_limits' }));
    // One vocabulary in both directions: what the write answers is what the read answers.
    expect(written.workspace).toEqual(limits.workspace);
    expect(written.workspace.resources).toMatchObject(change.resources);
    expect(written.workspace.followups).toEqual({ effective: false, inherited: false });
    expect(written.workspace.agentEnvPassthrough.effectiveNames).toContain('CI');
    expect(written.workspace.composerDefaults).toMatchObject({ autonomous: true, worktree: false });
    expect(written.workspace.skillsAutoUpdate).toEqual({ effective: false, inherited: false });
    // The cockpit's own pane sees the leader's values, the agent defaults included.
    expect((await cockpit('/api/v1/workspace/config')).body).toMatchObject({
      resources: { maxParallel: 5, memoryLimitMb: 4096 },
      followups: false,
      skillsAutoUpdate: false,
      agentDefaults: { runner: 'codex', models: { codex: 'gpt-5.6-sol' } },
    });
    // § 4.9's narrowing survives the reversal: the ANSWER still carries no folder path and no
    // machine-wide agent default, even though the write accepted the defaults.
    expect(JSON.stringify(written)).not.toMatch(/browseRoot|projectsDir|agentDefaults/);
  });

  it('dispatches the cockpit’s own route, once, and nothing else', async () => {
    const spy = spyService();
    const called = await invoke({ action: 'set_workspace_config', workspaceConfig: { followups: true } }, { service: spy });
    expect(called.result.isError, called.text).toBeFalsy();
    expect(spy.requests).toEqual(['PUT /api/v1/workspace/config']);
  });

  /**
   * Out of range is refused by the SAME BOUND, not by the same 400 STRING. Both doors validate
   * with `setWorkspaceConfigInputSchema`, so the value never reaches two different opinions — but
   * the MCP's copy runs as tool-argument validation, before the dispatch, so the leader reads a
   * zod issue naming the argument path and the cockpit reads the route's `{ error }` line. There
   * is no B1 body the route rejects and the tool accepts: the route validates with the same
   * schema the tool narrows, which is what wave 1 (#729) put in the contract.
   */
  it('is refused by the same bound as the cockpit, before any dispatch, and writes nothing', async () => {
    const before = (await cockpit('/api/v1/workspace/config')).body;
    const viaUi = await cockpit('/api/v1/workspace/config', 'PUT', { resources: { maxParallel: 99 } });
    expect(viaUi.status).toBe(400);
    expect(viaUi.body.error).toContain('<=16');
    const spy = spyService();
    const called = await invoke({ action: 'set_workspace_config', workspaceConfig: { resources: { maxParallel: 99 } } }, { service: spy });
    expect(called.result.isError).toBe(true);
    expect(called.text).toContain('<=16');
    expect(called.text).toContain('maxParallel');
    expect(spy.requests).toEqual([]);
    expect((await cockpit('/api/v1/workspace/config')).body).toEqual(before);
  });

  it('an unknown key is refused rather than dropped, and nothing reaches the route', async () => {
    const spy = spyService();
    for (const bad of [{ notASetting: true }, { resources: { maxParallel: 3 }, notASetting: true }]) {
      const called = await invoke({ action: 'set_workspace_config', workspaceConfig: bad }, { service: spy });
      expect(called.result.isError, JSON.stringify(bad)).toBe(true);
    }
    // Refused as arguments: nothing reached the route, so the partial body did not half-apply.
    expect(spy.requests).toEqual([]);
    expect((await cockpit('/api/v1/workspace/config')).body.resources.maxParallel).toBe(2);
  });

  /**
   * #677 wave 2 slice B2 — the two workspace folder paths.
   *
   * B1 held `browseRoot` and `projectsDir` back because they are the one pair whose validity is a
   * fact about the FILESYSTEM rather than a bound in a schema. The same owner rule covers them, so
   * the argument is now the contract schema with nothing omitted, and what keeps them honest is the
   * route's own write probe — inherited, not re-implemented at this door.
   */
  it('writes the two workspace folder paths, creating the checkout root, without echoing them back', async () => {
    const browseRoot = join(ws.home, 'b2-browse');
    const projectsDir = join(ws.home, 'b2-clones');
    mkdirSync(browseRoot, { recursive: true });
    const spy = spyService();
    const called = await invoke({ action: 'set_workspace_config', workspaceConfig: { browseRoot, projectsDir } }, { service: spy });
    expect(called.result.isError, called.text).toBeFalsy();
    expect(spy.requests).toEqual(['PUT /api/v1/workspace/config']);
    // The checkout root did NOT have to exist: the probe is `mkdir -p`, so a settings write has a
    // real filesystem side effect. Named as accepted exposure in the spec's § 3, pinned here.
    expect(existsSync(projectsDir), 'the checkout root the probe created').toBe(true);
    expect((await cockpit('/api/v1/workspace/config')).body).toMatchObject({ browseRoot, projectsDir });
    // Writable, still not readable: the answer stays the narrowed `get_limits` vocabulary, so a
    // leader gets the acknowledgement without the host path echoed back to it.
    expect(called.json).not.toContain(browseRoot);
    expect(JSON.stringify(value(await invoke({ action: 'get_limits' })))).not.toContain(browseRoot);
  });

  /**
   * NAMED BREAK 5 OF THE SPEC, through the MCP door.
   *
   * The route probes each root for real and answers 400 with its reason BEFORE
   * `mergeWriteWorkspaceConfig` runs, so a `resources` key travelling in the same body does not
   * half-apply. The tool must SHOW that guard firing rather than assume it: a bad root and a good
   * limit in one call, then the limit read back through the route, not off the file. Remove the
   * probe and this case goes RED; without this case a broken browse root is stored silently.
   */
  it('passes the route’s write probe through: a bad root refuses the whole body, resources included', async () => {
    const before = (await cockpit('/api/v1/workspace/config')).body;
    const missing = join(ws.home, 'b2-does-not-exist');
    const spy = spyService();
    const called = await invoke(
      { action: 'set_workspace_config', workspaceConfig: { browseRoot: missing, resources: { maxParallel: 11 } } },
      { service: spy },
    );
    expect(called.result.isError).toBe(true);
    expect(called.structured.status, 'the route’s own 400, not an argument refusal').toBe(400);
    expect(called.text).toContain('browse folder does not exist');
    // It really was the ROUTE that refused: the dispatch happened, and it was the only one.
    expect(spy.requests).toEqual(['PUT /api/v1/workspace/config']);
    // Nothing of the body survived — the root is unchanged and the cap is still the human's 2.
    expect((await cockpit('/api/v1/workspace/config')).body).toEqual(before);
    expect(value(await invoke({ action: 'get_limits' })).workspace.resources.maxParallel).toBe(2);
  });

  it.each([
    ['a relative path', () => 'not/absolute', 'is not an absolute path'],
    ['a file rather than a folder', () => writeTemp('b2-a-file'), 'is not a directory'],
  ])('passes the route’s write probe through: %s is refused with the route’s own reason', async (_what, root, reason) => {
    const called = await invoke({ action: 'set_workspace_config', workspaceConfig: { browseRoot: root() } });
    expect(called.result.isError).toBe(true);
    expect(called.structured.status).toBe(400);
    expect(called.text).toContain(reason);
  });

  /**
   * An unknown key is refused by BOTH doors, at every level — review m1 and QA case H together.
   *
   * Two asymmetries used to live here, and both answered success for a change that never
   * happened. QA case H: an unknown TOP-LEVEL key (`{ nonsenseKey: 123 }`) was refused as a tool
   * argument and accepted by the route as a no-op 200, because only the tool's copy carried
   * `.strict()`. Review m1: a misspelt NESTED key was stripped by BOTH doors, because `.strict()`
   * narrows one object and says nothing about the ones inside it. The whole shape is strict in
   * the CONTRACT now — the one schema both doors validate with — so a fix at either door alone
   * would have been half a fix, and this case asserts the pair together.
   */
  it('refuses an unknown key at every level, at BOTH doors, and writes nothing', async () => {
    const before = (await cockpit('/api/v1/workspace/config')).body;
    const spy = spyService();
    const bodies = [
      // QA case H — the top level, the direction the route used to accept.
      { nonsenseKey: 123 },
      { resources: { maxParallel: 4 }, nonsenseKey: 123 },
      // Review m1 — nested, the direction both doors used to accept.
      { resources: { maxParalel: 9 } },
      { resources: { browseRoot: '/tmp' } },
      { composerDefaults: { autonomus: true } },
      { agentDefaults: { models: { gemini: 'x' } } },
      { agentDefaults: { runer: 'codex' } },
    ];
    for (const bad of bodies) {
      const called = await invoke({ action: 'set_workspace_config', workspaceConfig: bad }, { service: spy });
      expect(called.result.isError, JSON.stringify(bad)).toBe(true);
      // The cockpit's own door answers 400 for the same body — one schema, one opinion.
      const viaUi = await cockpit('/api/v1/workspace/config', 'PUT', bad);
      expect(viaUi.status, JSON.stringify(bad)).toBe(400);
    }
    expect(spy.requests).toEqual([]);
    expect((await cockpit('/api/v1/workspace/config')).body).toEqual(before);
  });

  /**
   * HOSTED MODE ALLOWS THIS WRITE, BY DECISION (QA case G on #734, issue #735; owner decision
   * 2026-09-20: "a server admin may change limits remotely").
   *
   * Independent QA found that neither door refuses in hosted mode and asked for either a
   * `localHandoff` 409 or an explicit recorded decision. The decision is the second: the write
   * stays allowed. So this case pins the ALLOWED behaviour rather than leaving it to silence —
   * adding the 409 later becomes a visible break with a named test, instead of an undocumented
   * change of mind. The contrast is asserted in the same breath: on the SAME hosted app an
   * agent-config write still 409s, so hosted gating demonstrably works here and its absence on
   * this route is a choice rather than an oversight.
   */
  it('is ALLOWED in hosted mode through both doors, while a local-handoff route on the same app still refuses', async () => {
    const { app } = hotCockpit('0.0.0.0');
    const hosted = async (path: string, method = 'GET', body?: unknown): Promise<Response> =>
      app.request(path, {
        method,
        headers: { host: COCKPIT_HOST, origin: `http://${COCKPIT_HOST}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const health = (await (await hosted('/api/v1/health')).json()) as { capabilities: { localHandoff: boolean } };
    expect(health.capabilities.localHandoff, 'the fixture really is hosted').toBe(false);

    // The cockpit's own door: this route is permitted in hosted mode, deliberately.
    expect((await hosted('/api/v1/workspace/config', 'PUT', { resources: { maxParallel: 7 } })).status).toBe(200);
    // The leader's door, dispatching into that same hosted service.
    const called = await invoke({ action: 'set_workspace_config', workspaceConfig: { resources: { maxParallel: 5 } } }, { service: app });
    expect(called.result.isError, called.text).toBeFalsy();
    expect(value(called).workspace.resources.maxParallel).toBe(5);
    const stored = (await (await hosted('/api/v1/workspace/config')).json()) as { resources: { maxParallel: number } };
    expect(stored.resources.maxParallel).toBe(5);

    // The boundary that IS a local-machine capability still holds on the same app, so this case
    // cannot pass because hosted mode was never really on.
    const agentConfig = await hosted(`/api/v1/agent-config/${CONFIG_FILES[0]!.id}`, 'PUT', { content: '{}', version: null });
    expect(agentConfig.status).toBe(409);
    expect(((await agentConfig.json()) as { error: string }).error).toContain('hosted mode');
  });

  /**
   * The key is REQUIRED — that is all this case can say. Replaying one is the generic door's
   * job (`mcp/index.ts`), which `invoke` deliberately bypasses by calling the tool directly, so
   * "repeating one changes nothing twice" is pinned where it actually happens: through the real
   * bridge, in `acceptance-parity.test.ts` P-45. The title said it here and proved it nowhere
   * (review M2).
   */
  it('needs an operation key', async () => {
    const missing = await invoke({ action: 'set_workspace_config', workspaceConfig: { resources: { maxParallel: 4 } }, operationId: undefined });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toMatch(/set_workspace_config needs operationId/);
  });

  /**
   * #672 G4 — the owner's 2026-09-19 rule, for the one key G4 adds a control for: every limit is
   * editable through BOTH the MCP and the cockpit. G1 opened the leader's door; the cockpit's
   * Settings → Resources control is the second, and this is the one case that proves the two
   * accept the SAME shape rather than two similar ones.
   *
   * Same schema is WHY they agree (`setWorkspaceConfigInputSchema` is what the route's
   * `jsonZodValidator` and `workspaceConfigWriteSchema` both validate with), but "same schema" is
   * an implementation fact that a future copy of the shape at either door would quietly end.
   * What is asserted is the observable agreement: a stored count, the `null` that DELETES the
   * key, and the same refusal on the same out-of-range values.
   */
  it('takes the gate-slot count through BOTH doors with the same shape, the same clear and the same refusal', async () => {
    const { app, semaphore } = hotCockpit();
    const viaCockpit = async (body: unknown) =>
      app.request('/api/v1/workspace/config', {
        method: 'PUT',
        headers: { host: COCKPIT_HOST, origin: `http://${COCKPIT_HOST}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const readCockpit = async () =>
      ((await (await app.request('/api/v1/workspace/config', { headers: { host: COCKPIT_HOST } })).json()) as {
        resources: { gateSlots: number };
      }).resources.gateSlots;
    const readLeader = async () =>
      (value(await invoke({ action: 'get_limits' }, { service: app })) as { workspace: { resources: { gateSlots: number } } })
        .workspace.resources.gateSlots;

    // The cockpit writes; the leader reads its number.
    expect((await viaCockpit({ resources: { gateSlots: 4 } })).status).toBe(200);
    expect(await readLeader()).toBe(4);
    expect(semaphore.gateSlots()).toBe(4);

    // The leader writes; the cockpit reads its number.
    value(await invoke({ action: 'set_workspace_config', workspaceConfig: { resources: { gateSlots: 6 } } }, { service: app }));
    expect(await readCockpit()).toBe(6);
    expect(semaphore.gateSlots()).toBe(6);

    // `null` is the CLEAR at both doors, and both fall back to the same derived 1.
    value(await invoke({ action: 'set_workspace_config', workspaceConfig: { resources: { gateSlots: null } } }, { service: app }));
    expect(await readCockpit()).toBe(1);
    expect(await readLeader()).toBe(1);
    await viaCockpit({ resources: { gateSlots: 8 } });
    expect((await viaCockpit({ resources: { gateSlots: null } })).status).toBe(200);
    expect(await readLeader()).toBe(1);
    expect(semaphore.gateSlots()).toBe(1);

    // And the same bound refuses the same values at both doors, with nothing written.
    for (const bad of [0, 17, 2.5]) {
      expect((await viaCockpit({ resources: { gateSlots: bad } })).status, `cockpit ${bad}`).toBe(400);
      const leader = await invoke(
        { action: 'set_workspace_config', workspaceConfig: { resources: { gateSlots: bad } } },
        { service: app },
      );
      expect(leader.result.isError, `leader ${bad}`).toBe(true);
      expect(leader.text, `leader ${bad}`).toMatch(/gateSlots/);
    }
    expect(await readCockpit()).toBe(1);
  });

  it('applies to the shared semaphore without a restart (the refreshed-snapshot class)', async () => {
    const { app, semaphore } = hotCockpit();
    expect(semaphore.maxParallel()).toBe(2);
    expect(semaphore.followupsEnabled({})).toBe(false);
    const called = await invoke(
      { action: 'set_workspace_config', workspaceConfig: { resources: { maxParallel: 6, memoryLimitMb: 2048 }, followups: true, agentEnvPassthrough: ['CI', 'TZ'] } },
      { service: app },
    );
    expect(called.result.isError, called.text).toBeFalsy();
    // No restart, no second call: the route's own `semaphore.refresh()` hook did it.
    expect(semaphore.maxParallel()).toBe(6);
    expect(semaphore.memoryLimitMb()).toBe(2048);
    expect(semaphore.followupsEnabled({})).toBe(true);
    expect(semaphore.agentEnvPassthrough({})).toEqual(['CI', 'TZ']);
  });

  it('applies to the next loadConfig merge without a restart (the merged-defaults class)', async () => {
    expect((await loadConfig(ws.roots.a)).defaultRunner).not.toBe('codex');
    value(await invoke({ action: 'set_workspace_config', workspaceConfig: { agentDefaults: { runner: 'codex', models: { codex: 'gpt-5.6-sol' } } } }));
    const merged = await loadConfig(ws.roots.a);
    expect(merged.defaultRunner).toBe('codex');
    expect(merged.defaultModels?.codex).toBe('gpt-5.6-sol');
  });

  /**
   * The per-call class, observed THROUGH ITS CONSUMERS (review m4). A second `GET
   * /workspace/config` only proves the answer is re-read; what matters is that the thing each key
   * decides decides it differently now, on a service that was already running when the leader
   * wrote. So each of the three keys is read where it is USED:
   *   - `composerDefaults` → `task_create`'s run mode, the composer's own resolution, with the
   *     `POST /runs` body captured on its way in (no run is started);
   *   - `skillsAutoUpdate` → the updater's next check (`GET /workspace/skills-update`, whose
   *     `autoUpdateEnabled` is `effectiveSkillsAutoUpdate` of the config as it is NOW);
   *   - `worktreeRetentionDefault` → `resolveWorktreeRetention`.
   * The already-booted cockpit's own `/workspace/config` answer is kept as the fourth reader.
   */
  it('applies to an ALREADY-RUNNING cockpit’s next read and to the consumers themselves (the per-call class)', async () => {
    // Built before the write, and never told about it: these keys are read per call, so the
    // second cockpit answers the new values rather than a boot snapshot.
    const { app } = hotCockpit();
    // What the consumers say BEFORE, so the assertions below cannot pass on a default.
    expect((await cockpit('/api/v1/workspace/skills-update?projectId=proj-a')).body).toMatchObject({ autoUpdateEnabled: true, inherited: true });
    expect(await resolveWorktreeRetention(ws.roots.b)).not.toBe(3);

    value(await invoke({ action: 'set_workspace_config', workspaceConfig: { composerDefaults: { autonomous: true, worktree: false }, skillsAutoUpdate: false, resources: { worktreeRetentionDefault: 3 } } }));

    const res = await app.request('/api/v1/workspace/config', { headers: { host: COCKPIT_HOST } });
    expect(await res.json()).toMatchObject({
      composerDefaults: { autonomous: true, worktree: false },
      skillsAutoUpdate: false,
      resources: { worktreeRetentionDefault: 3 },
    });

    // The composer defaults reach the run `task_create` would create — the same resolution the
    // New task form applies — on the service that was already running.
    const started = await startViaTaskCreate('op-b1-composer-0001', 'use the new defaults');
    expect(started.result.isError, started.text).toBeFalsy();
    expect(started.body).toMatchObject({ autonomous: true, worktree: false });

    // The updater's next check answers the leader's preference, and says it is no longer inherited.
    expect((await cockpit('/api/v1/workspace/skills-update?projectId=proj-a')).body).toMatchObject({ autoUpdateEnabled: false, inherited: false });

    expect(await resolveWorktreeRetention(ws.roots.b)).toBe(3);
  });
});

// ---- the shared preference write -----------------------------------------------------------------

/**
 * #677 wave 2 slice B3 — `set_workspace_ui_state` and `import_skills`.
 *
 * The same owner rule of 2026-09-20 ("every key"), with the exclusions the owner named at 07:41,
 * makes the shared PRESENTATION bag a leader write. The division of labour is the point of this
 * block: the DOOR decides the key set — the five keys the owner opened, and no more — while the
 * ROUTE decides every value, because a second opinion about a value at the other door is how two
 * doors drift (the lesson of B2's folder paths).
 */
describe('project_config: the shared preference write (#677 B3)', () => {
  /** The workspace bag itself: `<XEZ_HOME>/ui-state.json`, the file the cockpit's own route writes. */
  const uiStateFile = (): string => join(process.env.XEZ_HOME!, 'ui-state.json');

  it('writes every key it accepts, in one narrowed vocabulary, without disturbing the rest of the bag', async () => {
    // The person's own bag first, including the two LEGACY keys the leader may not write.
    expect(
      (await cockpit('/api/v1/workspace/ui-state', 'PUT', {
        sidebar: { collapsed: { group: true } },
        lastLocation: { projectId: 'proj-a', pathname: '/p/proj-a/tasks' },
      })).status,
    ).toBe(200);

    const change = {
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
      notifications: { enabled: false },
      taskTable: { expandedColumns: { title: true, runner: false } },
      importedSkills: ['review', 'qa'],
      dismissedProviderAuthFailures: { claude: 'incident-9f3a-SECRET-ID' },
    };
    const written = value(await invoke({ action: 'set_workspace_ui_state', uiState: change })).uiState;
    expect(written.appearance).toEqual(change.appearance);
    expect(written.notifications).toEqual({ enabled: false });
    expect(written.taskTable.expandedColumns).toEqual({ title: true, runner: false });
    expect(written.importedSkills).toEqual(['review', 'qa']);
    // A dismissed incident is answered as the PROVIDER's name. The id is what `get_capabilities`
    // withholds (F-03), and writing one is no reason to hand it back.
    expect(written.dismissedProviderAuthFailures).toEqual(['claude']);
    expect(JSON.stringify(written)).not.toContain('incident-9f3a-SECRET-ID');
    // Nor the two legacy window keys, which are in the file and are not the leader's to read.
    expect(JSON.stringify(written)).not.toMatch(/sidebar|lastLocation/);

    // The cockpit's own pane sees the leader's values, and the person's keys are untouched: the
    // route merges shallowly, so only the keys sent were written.
    const bag = (await cockpit('/api/v1/workspace/ui-state')).body;
    expect(bag).toMatchObject(change);
    expect(bag.sidebar).toEqual({ collapsed: { group: true } });
    expect(bag.lastLocation.pathname).toBe('/p/proj-a/tasks');
    // And it really is the workspace file, not some copy of it.
    expect(JSON.parse(readFileSync(uiStateFile(), 'utf8'))).toMatchObject({ appearance: change.appearance });
  });

  /**
   * THE READ HALF (#753 review, Major 1), and why it is not a convenience.
   *
   * `PUT /workspace/ui-state` merges shallowly at the TOP level, so a key that is SENT replaces
   * its whole value: `{appearance: {accent}}` over a populated appearance clears the person's
   * density and width. The cockpit's own pane never hits that because it reads the bag first and
   * sends `{...appearance, accent}` (`packages/web/src/components/appearance-provider.tsx`). Both
   * halves are pinned here: the bare partial really does clear the siblings — that is the route's
   * documented behaviour and the reason the read exists — and the documented recipe, read, spread,
   * write, really does preserve them.
   *
   * The named break: DROP `get_workspace_ui_state` (from `PROJECT_CONFIG_ACTIONS`, its
   * `ACTION_FIELDS` row, or its handler case). The recipe half then goes RED at the read, because
   * there is no supported way for a leader to learn the two values it must send back — which is
   * exactly the state this review found.
   */
  it('read, spread, write keeps the person’s other appearance values — and a bare partial does not', async () => {
    const populated = { accent: 'violet', density: 'compact', width: 'wide' } as const;
    value(await invoke({ action: 'set_workspace_ui_state', uiState: { appearance: populated } }));

    // The bare partial, first: the route replaces the whole key, and the answer says so honestly
    // rather than reporting values that are no longer in the file.
    const bare = value(await invoke({ action: 'set_workspace_ui_state', uiState: { appearance: { accent: 'lime' } } })).uiState;
    expect(bare.appearance, 'the whole key was replaced, and the answer does not pretend otherwise').toEqual({
      accent: 'lime',
      density: null,
      width: null,
    });
    expect((await cockpit('/api/v1/workspace/ui-state')).body.appearance).toEqual({ accent: 'lime' });

    // And now the recipe the argument description prescribes, from the same starting point.
    value(await invoke({ action: 'set_workspace_ui_state', uiState: { appearance: populated } }));
    const read = value(await invoke({ action: 'get_workspace_ui_state' })).uiState;
    expect(read.appearance).toEqual(populated);
    const spread = { ...read.appearance, accent: 'lime' };
    const written = value(await invoke({ action: 'set_workspace_ui_state', uiState: { appearance: spread } })).uiState;
    expect(written.appearance, 'density and width survived the accent change').toEqual({
      accent: 'lime',
      density: 'compact',
      width: 'wide',
    });
    expect((await cockpit('/api/v1/workspace/ui-state')).body.appearance).toEqual({
      accent: 'lime',
      density: 'compact',
      width: 'wide',
    });
  });

  it('the read is the same narrowed vocabulary, needs no operation key, and dispatches one GET', async () => {
    expect(
      (await cockpit('/api/v1/workspace/ui-state', 'PUT', {
        appearance: { accent: 'violet' },
        importedSkills: ['review'],
        dismissedProviderAuthFailures: { claude: 'incident-9f3a-SECRET-ID' },
        sidebar: { collapsed: { group: true } },
        lastLocation: { projectId: 'proj-a', pathname: '/p/proj-a/tasks' },
      })).status,
    ).toBe(200);

    const spy = spyService();
    const called = await invoke({ action: 'get_workspace_ui_state' }, { service: spy });
    const read = value(called).uiState;
    expect(spy.requests).toEqual(['GET /api/v1/workspace/ui-state']);
    expect(read.appearance).toEqual({ accent: 'violet', density: null, width: null });
    expect(read.importedSkills).toEqual(['review']);
    // Narrowed exactly like the write's answer: the provider's NAME, never the incident id, and
    // neither legacy window key. Return the raw response here instead of `workspacePreferences`
    // and all three of these go RED.
    expect(read.dismissedProviderAuthFailures).toEqual(['claude']);
    expect(called.json).not.toContain('incident-9f3a-SECRET-ID');
    expect(called.json).not.toMatch(/sidebar|lastLocation/);
    // A read, so no operation key — and no audit row, which `audit-inventory.test.ts` holds it to.
    const withoutKey = await invoke({ action: 'get_workspace_ui_state', operationId: undefined });
    expect(withoutKey.result.isError, withoutKey.text).toBeFalsy();
  });

  it('dispatches the cockpit’s own route, once, and nothing else — through either action', async () => {
    const spy = spyService();
    const prefs = await invoke({ action: 'set_workspace_ui_state', uiState: { notifications: { enabled: true } } }, { service: spy });
    expect(prefs.result.isError, prefs.text).toBeFalsy();
    const imported = await invoke({ action: 'import_skills', importedSkills: ['review'] }, { service: spy });
    expect(imported.result.isError, imported.text).toBeFalsy();
    expect(spy.requests).toEqual(['PUT /api/v1/workspace/ui-state', 'PUT /api/v1/workspace/ui-state']);
  });

  /**
   * THE ROUTE'S OWN BOUND, FIRING THROUGH THE LEADER'S DOOR.
   *
   * `importedSkills` is at most 200 names and `taskTable.expandedColumns` at most 50 columns, and
   * those bounds live in the contract schema `PUT /workspace/ui-state` validates with — not here.
   * So a body one past either bound PASSES the door, is dispatched, and comes back as the
   * cockpit's own 400 with nothing written. Dispatch the write anywhere but that route — straight
   * at `mergeWriteWorkspaceUiState`, say — and this case goes RED with an over-long list stored;
   * without it, the door would be free to grow the person's file past the bound the pane obeys.
   */
  it('passes the route’s own bounds through: an over-long list is the cockpit’s 400, and nothing is written', async () => {
    const before = (await cockpit('/api/v1/workspace/ui-state')).body;
    const tooMany = Array.from({ length: 201 }, (_, i) => `skill-${i}`);
    const viaUi = await cockpit('/api/v1/workspace/ui-state', 'PUT', { importedSkills: tooMany });
    expect(viaUi.status).toBe(400);

    const spy = spyService();
    const called = await invoke({ action: 'import_skills', importedSkills: tooMany }, { service: spy });
    expect(called.result.isError).toBe(true);
    expect(called.structured.status, 'the route’s own 400, not an argument refusal').toBe(400);
    // The SAME 400, which is the acceptance wording: not merely the same status, but the route's
    // own reason text, carried to the leader unrewritten (#753 review, Minor 1). Re-word the
    // reason at the MCP door instead of passing the route's through and this line goes RED.
    expect(called.text, 'the route’s own reason, not a message invented here').toContain(viaUi.body.error);
    // It really was the ROUTE that refused: the dispatch happened, and it was the only one.
    expect(spy.requests).toEqual(['PUT /api/v1/workspace/ui-state']);
    expect((await cockpit('/api/v1/workspace/ui-state')).body).toEqual(before);

    // The same for the other bounded key, through the bag action.
    const columns = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`col-${i}`, true]));
    const bag = await invoke({ action: 'set_workspace_ui_state', uiState: { taskTable: { expandedColumns: columns } } });
    expect(bag.result.isError).toBe(true);
    expect(bag.structured.status).toBe(400);
    expect((await cockpit('/api/v1/workspace/ui-state')).body).toEqual(before);
  });

  /**
   * THE ROUTE'S OWN BODY CAP, likewise inherited rather than copied. `PUT /workspace/ui-state`
   * carries a 128 KiB `bodyLimit` (`UI_STATE_BODY_LIMIT`) precisely because this bag is small GUI
   * preferences; a leader is no more entitled to a huge body than a browser is. Remove that
   * `use(…bodyLimit…)` from the route and this case goes RED: the body is accepted and a
   * multi-megabyte preference file is written.
   */
  it('passes the route’s 128 KiB body cap through: an over-sized body is refused and nothing is written', async () => {
    const before = (await cockpit('/api/v1/workspace/ui-state')).body;
    const huge = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(4, '0')}-${'s'.repeat(1000)}`);
    expect(JSON.stringify({ importedSkills: huge }).length, 'the body really is over the cap').toBeGreaterThan(128 * 1024);
    const spy = spyService();
    const called = await invoke({ action: 'import_skills', importedSkills: huge }, { service: spy });
    expect(called.result.isError).toBe(true);
    // 413, not 400: the CAP refused it, before the schema had an opinion. Pinning the status is
    // what makes this case notice the cap's removal — the over-sized body would then reach the
    // validator and be refused as a bad value instead, an error either way.
    expect(called.structured.status, 'refused by the body cap, not by a bound').toBe(413);
    expect(spy.requests, 'the route was reached — it is the route that refuses').toEqual(['PUT /api/v1/workspace/ui-state']);
    expect((await cockpit('/api/v1/workspace/ui-state')).body).toEqual(before);
  });

  it('needs an operation key, through either action', async () => {
    const bag = await invoke({ action: 'set_workspace_ui_state', uiState: { notifications: { enabled: true } }, operationId: undefined });
    expect(bag.result.isError).toBe(true);
    expect(bag.text).toMatch(/set_workspace_ui_state needs operationId/);
    const imported = await invoke({ action: 'import_skills', importedSkills: [], operationId: undefined });
    expect(imported.result.isError).toBe(true);
    expect(imported.text).toMatch(/import_skills needs operationId/);
  });

  /**
   * THE OWNER'S EXCLUSIONS, as behaviour. `theme` is not refused because it is forbidden — it is
   * refused because there is no such setting: the browser stores it in its own `localStorage` and
   * no server route carries it (spec § 4 Q1). `sidebar` and `lastLocation` are real keys of the
   * file that stay out of the leader's reach because they describe one person's window.
   */
  it('accepts exactly the five keys the owner opened: theme, the two legacy window keys and an unknown key are argument refusals', async () => {
    // A POPULATED bag, so "nothing changed" is a real assertion rather than empty-equals-empty:
    // the two dismissals below are what a stripped `dismissedProviderAuthFailures` would wipe.
    expect(
      (await cockpit('/api/v1/workspace/ui-state', 'PUT', {
        appearance: { accent: 'violet', density: 'compact', width: 'wide' },
        dismissedProviderAuthFailures: { claude: 'incident-one', codex: 'incident-two' },
      })).status,
    ).toBe(200);
    const before = (await cockpit('/api/v1/workspace/ui-state')).body;
    const spy = spyService();
    for (const bad of [
      { theme: 'dark' },
      { sidebar: { collapsed: { group: true } } },
      { lastLocation: { projectId: 'proj-a', pathname: '/p/proj-a/tasks' } },
      { notASetting: true },
      { appearance: { accent: 'violet' }, theme: 'dark' },
      // ONE LEVEL DOWN, too (#753 review, Major 2). The contract's read-side shapes are tolerant
      // in two different directions, and inheriting either one is a silent loss: `appearance` and
      // `dismissedProviderAuthFailures` STRIP an unknown key — `{appearance: {theme}}` would have
      // become `{appearance: {}}`, erasing the person's whole appearance under an `ok`, and
      // `{dismissedProviderAuthFailures: {gemini}}` would have wiped every dismissal the cockpit's
      // own route refuses with a 400 — while `notifications` and `taskTable` KEEP one and would
      // have stored it in the person's file, invisible in the answer and in the audit row. Take
      // the `z.strictObject(…)` wrappers back off `workspaceUiStateWriteSchema` and these four
      // lines go RED, each one a body the route itself would have refused or a key nobody
      // reviewed landing in `ui-state.json`.
      { appearance: { theme: 'dark', accent: 'lime' } },
      { dismissedProviderAuthFailures: { gemini: 'abc' } },
      { notifications: { enabled: true, lastTask: 'smuggled' } },
      { taskTable: { expandedColumns: { title: true }, sidebar: { collapsed: { g: true } } } },
    ]) {
      const called = await invoke({ action: 'set_workspace_ui_state', uiState: bad }, { service: spy });
      expect(called.result.isError, JSON.stringify(bad)).toBe(true);
      expect(called.text, JSON.stringify(bad)).toMatch(/Unrecognized key/);
    }
    // And an EMPTY bag is refused rather than dispatched as a no-op write: the route would
    // answer 200 for a change nobody asked for, which reads like a change that happened.
    const empty = await invoke({ action: 'set_workspace_ui_state', uiState: {} }, { service: spy });
    expect(empty.result.isError).toBe(true);
    expect(empty.text).toContain('send at least one preference to change');
    // Refused as arguments: nothing reached the route, so the valid key travelling beside a
    // rejected one did not half-apply either.
    expect(spy.requests).toEqual([]);
    expect((await cockpit('/api/v1/workspace/ui-state')).body).toEqual(before);
  });

  it('import_skills replaces the whole curated list and leaves every other preference alone', async () => {
    value(await invoke({ action: 'set_workspace_ui_state', uiState: { appearance: { accent: 'violet' }, importedSkills: ['review', 'qa'] } }));
    // A curated EMPTY list is a real answer, and is not "never curated".
    const emptied = value(await invoke({ action: 'import_skills', importedSkills: [] })).uiState;
    expect(emptied.importedSkills).toEqual([]);
    expect(emptied.appearance.accent).toBe('violet');
    const refilled = value(await invoke({ action: 'import_skills', importedSkills: ['docs'] })).uiState;
    expect(refilled.importedSkills, 'the WHOLE list, never appended to').toEqual(['docs']);
  });

  it('answers null for a preference the person has never set, rather than inventing a default', async () => {
    // A fresh bag: only the key just written is present, and the rest are honestly absent.
    const answer = value(await invoke({ action: 'import_skills', importedSkills: ['review'] })).uiState;
    expect(answer.appearance).toEqual({ accent: null, density: null, width: null });
    expect(answer.notifications).toEqual({ enabled: null });
    expect(answer.taskTable.expandedColumns).toEqual({});
    expect(answer.dismissedProviderAuthFailures).toEqual([]);
  });

  /**
   * HOSTED MODE ALLOWS THIS WRITE TOO, by the same owner decision of 2026-09-20 recorded for the
   * settings write: `PUT /workspace/ui-state` is permitted in hosted mode.
   * Pinned as ALLOWED so a later 409 is a visible break rather than a silent change of mind; the
   * agent-config contrast on the same app proves hosted mode really is on.
   */
  it('is ALLOWED in hosted mode through both doors, while a local-handoff route on the same app still refuses', async () => {
    const { app } = hotCockpit('0.0.0.0');
    const hosted = async (path: string, method = 'GET', body?: unknown): Promise<Response> =>
      app.request(path, {
        method,
        headers: { host: COCKPIT_HOST, origin: `http://${COCKPIT_HOST}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const health = (await (await hosted('/api/v1/health')).json()) as { capabilities: { localHandoff: boolean } };
    expect(health.capabilities.localHandoff, 'the fixture really is hosted').toBe(false);

    expect((await hosted('/api/v1/workspace/ui-state', 'PUT', { notifications: { enabled: false } })).status).toBe(200);
    const called = await invoke({ action: 'set_workspace_ui_state', uiState: { appearance: { accent: 'violet' } } }, { service: app });
    expect(called.result.isError, called.text).toBeFalsy();
    expect(value(called).uiState.appearance.accent).toBe('violet');

    const agentConfig = await hosted(`/api/v1/agent-config/${CONFIG_FILES[0]!.id}`, 'PUT', { content: '{}', version: null });
    expect(agentConfig.status).toBe(409);
  });
});
