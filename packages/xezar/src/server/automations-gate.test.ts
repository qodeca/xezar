import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { AutomationStore } from '../automations/store.ts';
import { WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { RunStore } from '../runs/store.ts';
import { SkillsUpdateCoordinator } from '../skills-update.ts';
import { clearProjectProbeCache, listProjects, registerProject, removeProject } from '../workspace/projects.ts';
import { RunManager } from '../workflows/run.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp, startServer, type ServerDeps } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * GitHub automations are opt-in (#801): `XEZ_AUTOMATIONS=1` turns them on, off is the default.
 * Off, every route of the family answers `409` naming the flag — defense in depth behind the
 * cockpit's nav gate, so a bookmarked deep link or a script cannot drive a feature the operator
 * switched off.
 *
 * The twin of `inbox-gate.test.ts`, with one deliberate difference. The inbox READER degrades to
 * `200 []` because an inbox that is off is honestly empty; an automations reader cannot say the
 * same — `{automations: []}` would read as "you have configured none", and the cockpit would then
 * offer to create one against a `409`ing POST. Off means refused, uniformly, for reads too.
 *
 * The definitions on disk are never touched: the gate hides the feature, it does not delete it.
 */

const DEFINITION = {
  name: 'Review new issues',
  enabled: false as const,
  events: ['issue.opened' as const],
  intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
};

describe('automations gate (#801)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let automationId: string;
  const savedAutomations = process.env.XEZ_AUTOMATIONS;
  const savedFollowups = process.env.XEZ_FOLLOWUPS;
  const savedRemote = process.env.XEZ_REMOTE;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-automations-gate-'));
    dataDir = join(repoRoot, '.local/xezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    // A pre-existing definition, written while the feature was on: the gate must hide it and
    // must never destroy it.
    const seed = AutomationStore.open(dataDir);
    automationId = seed.create(DEFINITION).id;
    delete process.env.XEZ_AUTOMATIONS;
    delete process.env.XEZ_FOLLOWUPS;
    delete process.env.XEZ_REMOTE;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedAutomations === undefined) delete process.env.XEZ_AUTOMATIONS;
    else process.env.XEZ_AUTOMATIONS = savedAutomations;
    if (savedFollowups === undefined) delete process.env.XEZ_FOLLOWUPS;
    else process.env.XEZ_FOLLOWUPS = savedFollowups;
    if (savedRemote === undefined) delete process.env.XEZ_REMOTE;
    else process.env.XEZ_REMOTE = savedRemote;
  });

  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  describe('off (the default)', () => {
    /** Every route of the feature, in the spelling BACKWARD_COMPATIBILITY.md §2 inventories. */
    const routes = (id: string): Array<[label: string, path: string, init?: RequestInit]> => [
      ['GET /automations', '/api/v1/automations'],
      ['POST /automations', '/api/v1/automations', json(DEFINITION)],
      ['GET /automations/:id', `/api/v1/automations/${id}`],
      ['PUT /automations/:id', `/api/v1/automations/${id}`, json({ ...DEFINITION, revision: 1 }, 'PUT')],
      ['DELETE /automations/:id', `/api/v1/automations/${id}`, { method: 'DELETE' }],
      ['POST /automations/:id/enable', `/api/v1/automations/${id}/enable`, json({ revision: 1 })],
      ['POST /automations/:id/pause', `/api/v1/automations/${id}/pause`, json({ revision: 1 })],
      ['POST /automations/:id/check', `/api/v1/automations/${id}/check`, json({ mode: 'preview' })],
      ['GET /automation-log', '/api/v1/automation-log'],
      ['POST /automation-log/:receiptId/retry', '/api/v1/automation-log/no-such-receipt/retry', { method: 'POST' }],
      ['GET /automation-checks/:checkId', '/api/v1/automation-checks/no-such-check'],
    ];

    it.each(routes('will-be-replaced').map(([label]) => label))(
      '%s answers 409 with a reason naming the flag',
      async (label) => {
        const [, path, init] = routes(automationId).find(([name]) => name === label)!;
        const res = await apiRequest(app(), path, init);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toContain('XEZ_AUTOMATIONS');
      },
    );

    // The regression this file exists for. Both automation families are mounted with
    // `.route('/', …)` alongside a dozen unrelated sub-apps, so a guard registered as `use('*')`
    // instead of on explicit paths would 409 the ENTIRE `/api/v1` surface — including the
    // CORS-open discovery route the cockpit boots from.
    it('gates only its own family — health and its neighbours are untouched', async () => {
      const built = app();
      expect((await apiRequest(built, '/api/v1/health')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/runs')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/todos')).status).toBe(200);
      expect((await apiRequest(built, '/api/v1/workflows')).status).toBe(200);
    });

    it('gates the project-scoped mirror too, not just the boot alias', async () => {
      const res = await apiRequest(app(), '/api/v1/p/default/automations');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('XEZ_AUTOMATIONS');
    });

    it('hides definitions without destroying them — flipping the flag brings them back', async () => {
      await apiRequest(app(), '/api/v1/automations');
      await apiRequest(app(), `/api/v1/automations/${automationId}`, { method: 'DELETE' });
      process.env.XEZ_AUTOMATIONS = '1';
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automations: Array<{ id: string; name: string }> };
      expect(body.automations).toHaveLength(1);
      expect(body.automations[0]).toMatchObject({ id: automationId, name: DEFINITION.name });
    });

    it('reports the capability as off on health, which is what the nav gate reads', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { automations: boolean } }).capabilities.automations)
        .toBe(false);
    });
  });

  describe('on (XEZ_AUTOMATIONS=1)', () => {
    beforeEach(() => {
      process.env.XEZ_AUTOMATIONS = '1';
    });

    it('serves the real definitions', async () => {
      const res = await apiRequest(app(), '/api/v1/automations');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { automations: Array<{ id: string }> };
      expect(body.automations.map((item) => item.id)).toEqual([automationId]);
    });

    it('an unknown id still 404s — the gate is not swallowing it', async () => {
      const res = await apiRequest(app(), '/api/v1/automations/nope');
      expect(res.status).toBe(404);
    });

    it('a malformed body still 400s ahead of the 404 — validator order is unchanged', async () => {
      const res = await apiRequest(app(), '/api/v1/automations/nope/check', json({ mode: 'nonsense' }));
      expect(res.status).toBe(400);
    });

    it('reports the capability as on', async () => {
      const res = await apiRequest(app(), '/api/v1/health');
      expect(((await res.json()) as { capabilities: { automations: boolean } }).capabilities.automations)
        .toBe(true);
    });
  });

  /**
   * The flag has to remove the BEHAVIOR, not only the UI and the API: `WorkspaceAutomationScheduler`
   * is what polls GitHub on a timer and launches runs off what it finds, and a cockpit whose
   * operator switched automations off must make no GitHub requests on their behalf.
   *
   * Asserted at `startServer`, because that is where the scheduler is wired — `createApp` never
   * constructs one. The server binds an ephemeral loopback port and is closed immediately; nothing
   * here talks to the network (`XEZ_DRY_RUN=1`) or to a real agent CLI.
   */
  describe('background scheduler', () => {
    const savedHome = process.env.XEZ_HOME;
    const savedDryRun = process.env.XEZ_DRY_RUN;
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'xez-automations-gate-home-'));
      process.env.XEZ_HOME = home;
      process.env.XEZ_DRY_RUN = '1';
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env.XEZ_HOME;
      else process.env.XEZ_HOME = savedHome;
      if (savedDryRun === undefined) delete process.env.XEZ_DRY_RUN;
      else process.env.XEZ_DRY_RUN = savedDryRun;
      vi.restoreAllMocks();
    });

    /**
     * Boot on an ephemeral port, wait for the `listening` warm-up to reach the automations gate
     * (and, with the flag on, to get past it), then close.
     *
     * Both waits are on a real signal, never a fixed delay (#212). With the flag on, the warm-up
     * runs `git` subprocesses per project before it starts the scheduler, which a loaded CI runner
     * held past the 50 ms this used to wait. With it off, "never started" must not read the same
     * as "the warm-up never got that far": the skills-update coordinator starts in the same
     * callback, just before the gate, so its start is the proof the gate was reached.
     */
    const boot = async (): Promise<void> => {
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      const on = process.env.XEZ_AUTOMATIONS === '1';
      const server = startServer(
        { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        if (on) await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      } finally {
        server.close();
      }
      expect(started).toHaveBeenCalledTimes(on ? 1 : 0);
    };

    it('never starts polling while the flag is off', async () => {
      await boot();
    });

    it('starts once the flag is on, so the gate is the only thing holding it back', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      await boot();
    });

    /**
     * #678, the defect this group's hot-capability cases exist for.
     *
     * `XEZ_AUTOMATIONS` is resolved per call, so flipping it to `1` on a server that is already
     * listening opened every automations route — a definition could be created and saved — while
     * `WorkspaceAutomationScheduler.start()` had already been skipped at boot and was never called
     * again. `rescheduleAutomations()` forwards to `reschedule()`, which returns immediately while
     * the scheduler is `stopped`, so the feature answered "enabled" and polled nothing, with no
     * error anywhere.
     *
     * The proof is the poller, not the routes: `start()` called exactly once after the flip.
     * Against the pre-fix `server.ts` this waits out its timeout at zero calls.
     */
    it('a flip to on after boot starts the poller, not only the routes (#678)', async () => {
      delete process.env.XEZ_AUTOMATIONS;
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        expect(started).toHaveBeenCalledTimes(0);

        // The user's step 2: the flag turns on in the environment the running process reads.
        process.env.XEZ_AUTOMATIONS = '1';

        // Step 3: the routes are open and a definition is accepted — the half that already worked.
        const res = await apiRequest(app!, '/api/v1/automations', json(DEFINITION));
        expect(res.status).toBe(201);

        // Step 4, the half that did not: the poller is running, exactly once.
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });
      } finally {
        server.close();
      }
      expect(started).toHaveBeenCalledTimes(1);
    });

    /**
     * Guard, passing both ways: the property the boot-only start was load-bearing FOR — ONE start,
     * so never a second poller — survives the resolve becoming hot. Every later resolve (each
     * saved definition consults the flag through `rescheduleAutomations`) must be a no-op.
     */
    it('a flag already on at boot is not double-started by later resolves (#678)', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        for (const name of ['one', 'two', 'three']) {
          const res = await apiRequest(app!, '/api/v1/automations', json({ ...DEFINITION, name }));
          expect(res.status).toBe(201);
        }
        expect(started).toHaveBeenCalledTimes(1);
      } finally {
        server.close();
      }
      expect(started).toHaveBeenCalledTimes(1);
    });

    /**
     * Guard, passing both ways: the DEFAULT path. With the flag never set, no resolve may start
     * the poller and the routes stay closed — the hot capability must not become a door of its own.
     */
    it('the flag never set still starts nothing and refuses the routes (#678)', async () => {
      delete process.env.XEZ_AUTOMATIONS;
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        const res = await apiRequest(app!, '/api/v1/automations', json(DEFINITION));
        expect(res.status).toBe(409);
        expect(started).toHaveBeenCalledTimes(0);
      } finally {
        server.close();
      }
      expect(started).toHaveBeenCalledTimes(0);
    });

    /**
     * The off-transition (#678). `stop()` is the scheduler's own clean exit, so a flag switched
     * back off stops polling instead of leaving a poller behind a closed door — and releasing the
     * started-once latch is what makes a flip back on start it again rather than never.
     *
     * The consult is deliberately a project REMOVAL and not an automations route: with the flag
     * off those routes answer 409 ahead of any handler, so they never reach the one place the
     * scheduler's flag is resolved. That is the honest shape of the hot capability — the change
     * is observed at the next consult, not at the instant the variable changes — and it is what
     * the README and `.env.example` now say.
     */
    it('a flip back to off stops the poller, and on again restarts it (#678)', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      clearProjectProbeCache();
      const otherRoot = mkdtempSync(join(tmpdir(), 'xez-automations-gate-hot-'));
      const other = await registerProject(otherRoot);
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');
      const stopped = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'stop');
      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        expect(stopped).toHaveBeenCalledTimes(0);

        // Off, then a consult: removing a project emits `project-removed` unconditionally and
        // that handler is one of the callers that resolves the flag.
        delete process.env.XEZ_AUTOMATIONS;
        expect((await apiRequest(app!, `/api/v1/projects/${other.id}`, { method: 'DELETE' })).status)
          .toBe(200);
        await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1), { timeout: 4_000 });

        // On again: the routes reopen AND the poller comes back, exactly once more.
        process.env.XEZ_AUTOMATIONS = '1';
        expect((await apiRequest(app!, '/api/v1/automations', json(DEFINITION))).status).toBe(201);
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2), { timeout: 4_000 });
      } finally {
        server.close();
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    /**
     * #592 review round 2, Major 1: round 1 moved the skills-update/automation cleanup onto
     * `ProjectContexts.onContextDisposed`, but `dispose()` only notifies that hook when the id
     * had a built or in-flight context (`project-context.test.ts`, "dispose() of a never-built
     * project is a no-op returning false"). A project registered this session but never routed
     * to — its context never built — hit exactly that gap: `DELETE /projects/:id` still removed
     * it from the registry, but nothing told the skills-update coordinator or the automation
     * coordinator, so a poll already scheduled for it kept firing.
     *
     * The restored `project-removed` branch in `startServer`'s `workspaceEvents.on(...)` handler
     * covers this: it reads the event the removal route emits UNCONDITIONALLY, independent of
     * whether `dispose()` had anything to notify.
     */
    it('removing a project whose context was never built still reaches the skills-update and automation coordinators', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      clearProjectProbeCache();
      const untouchedRoot = mkdtempSync(join(tmpdir(), 'xez-automations-gate-untouched-'));
      const untouched = await registerProject(untouchedRoot);

      const contexts = new ProjectContexts({ listProjects });
      const removeSkillsSpy = vi.spyOn(SkillsUpdateCoordinator.prototype, 'remove');
      const removeAutomationSpy = vi.spyOn(AutomationCoordinator.prototype, 'remove');
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');

      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          contexts,
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });

        // The regression's precondition: no route ever touched this project, so its context was
        // never built — `dispose()` below is a no-op as far as `onContextDisposed` is concerned.
        expect(contexts.peek(untouched.id)).toBeUndefined();

        const res = await apiRequest(app!, `/api/v1/projects/${untouched.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);

        expect(removeSkillsSpy).toHaveBeenCalledWith(untouched.id);
        expect(removeAutomationSpy).toHaveBeenCalledWith(untouched.id);
      } finally {
        server.close();
        rmSync(untouchedRoot, { recursive: true, force: true });
      }
    });

    /**
     * RP-5 (#647), the other side of the test above.
     *
     * That one is about a dispose that never fires; this one is about a dispose that fires too
     * LATE. `ProjectContexts.dispose()` drops the context and ends the registration
     * synchronously, but notifies only once `teardown` has finished — and that teardown can
     * outlive a re-add and a rebuild of the same project. Keyed on the id alone, this listener
     * then dropped the LIVE project from the skills-update coordinator and the automation
     * scheduler's project map on behalf of the dead registration, and nothing put it back: the
     * `project-added` re-registration had already been and gone, so its polls and audits stopped
     * for the rest of the session.
     *
     * Modelled on the out-of-band drift rebuild (#591), which is the shape that needs no
     * `project-removed` at all: the registry still names the project, so touching a scoped route
     * inside the window rebuilds it at the next generation. The late dispose then arrives
     * `superseded`, which is the one question this listener can answer — it holds no
     * per-registration state of its own to compare against, because the bus event that
     * re-populates it carries no generation.
     */
    it('a project rebuilt inside its previous context\'s teardown window stays in both coordinators', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      clearProjectProbeCache();
      const liveRoot = mkdtempSync(join(tmpdir(), 'xez-automations-gate-live-'));
      const live = await registerProject(liveRoot);

      const contexts = new ProjectContexts({ listProjects });
      const removeSkillsSpy = vi.spyOn(SkillsUpdateCoordinator.prototype, 'remove');
      const addSkillsSpy = vi.spyOn(SkillsUpdateCoordinator.prototype, 'add');
      const removeAutomationSpy = vi.spyOn(AutomationCoordinator.prototype, 'remove');
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');

      let release!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realDispose = RunManager.prototype.dispose;
      const parkedDispose = vi
        .spyOn(RunManager.prototype, 'dispose')
        .mockImplementation(async function (this: RunManager) {
          await parked;
          await realDispose.call(this);
        });

      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          contexts,
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });

        expect((await apiRequest(app!, `/api/v1/p/${live.id}/runs`)).status).toBe(200);
        expect(contexts.peek(live.id)?.generation).toBe(0);
        removeSkillsSpy.mockClear();
        removeAutomationSpy.mockClear();
        addSkillsSpy.mockClear();

        // The teardown window: the context is out of the map, the notification is not out yet.
        const disposing = contexts.dispose(live.id);
        await vi.waitFor(() => expect(parkedDispose).toHaveBeenCalled());
        expect((await apiRequest(app!, `/api/v1/p/${live.id}/runs`)).status).toBe(200);
        expect(contexts.peek(live.id)?.generation).toBe(1);

        release();
        await disposing;

        // #707 review round 1, Major 1: what this pins is the NET state — the live project is
        // still in both coordinators — not the absence of a `remove` call. A superseded dispose
        // refreshes from the registry rather than skipping, so the removal does run and the
        // re-add that follows names the row the registry holds NOW, which for a plain re-add is
        // the same root it already had. (Skipping the removal instead is what left a DRIFT
        // rebuild pinned to the OLD root forever — the test below.)
        await vi.waitFor(() => expect(addSkillsSpy).toHaveBeenCalledWith(live.id, liveRoot));
        expect(removeSkillsSpy).toHaveBeenCalledWith(live.id);
      } finally {
        release();
        parkedDispose.mockRestore();
        server.close();
        await contexts.disposeAll().catch(() => undefined);
        rmSync(liveRoot, { recursive: true, force: true });
      }
    });

    /**
     * #707 review round 1, Major 1 — the drift shape the `superseded` early return lost.
     *
     * The reviewer's throwaway, made permanent. `ProjectContexts.dispose()` deletes its map entry
     * synchronously and notifies only after the teardown, so ONE overlapping request for the same
     * project inside that window starts its own build at the next generation — and that build,
     * in flight at notify time, is what stamps the dispose `superseded`. A cockpit project page
     * issues several requests, so an out-of-band drift (#591) with that page open lands in this
     * shape rather than the sequential one.
     *
     * Nothing else re-populates the coordinators after a drift: the only other `add`/`set` sites
     * are `project-added` (which a drift never emits — only the root moved) and boot. So skipping
     * the removal kept the OLD root: the skills-update coordinator would keep updating the old
     * path and the scheduler keep polling the old `owner/repo` and auditing under the old
     * `projectDataDir`, while `launch` resolves through the new context. Removing and re-adding
     * from the CURRENT `listProjects()` row is the only answer that is right here and idempotent
     * for the plain re-add above.
     */
    it('a drift whose teardown overlapped a second request re-registers the NEW root, not the old one', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      clearProjectProbeCache();
      const base = mkdtempSync(join(tmpdir(), 'xez-automations-gate-drift-'));
      const rootOld = join(base, 'run-1', 'shared');
      const rootNew = join(base, 'run-2', 'shared');
      for (const root of [rootOld, rootNew]) mkdirSync(root, { recursive: true });
      const first = await registerProject(rootOld);

      const contexts = new ProjectContexts({ listProjects });
      const removeSkillsSpy = vi.spyOn(SkillsUpdateCoordinator.prototype, 'remove');
      const addSkillsSpy = vi.spyOn(SkillsUpdateCoordinator.prototype, 'add');
      const removeAutomationSpy = vi.spyOn(AutomationCoordinator.prototype, 'remove');
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');

      let release!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realDispose = RunManager.prototype.dispose;
      const parkedDispose = vi
        .spyOn(RunManager.prototype, 'dispose')
        .mockImplementation(async function (this: RunManager) {
          await parked;
          await realDispose.call(this);
        });

      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          contexts,
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });

        expect((await apiRequest(app!, `/api/v1/p/${first.id}/runs`)).status).toBe(200);
        expect(contexts.peek(first.id)?.root).toBe(rootOld);
        removeSkillsSpy.mockClear();
        removeAutomationSpy.mockClear();
        addSkillsSpy.mockClear();

        // The out-of-band drift (#591): the same slug re-pointed to a different root, with no bus
        // event at all — exactly as `workspace-events.test.ts` models it.
        await removeProject(first.id);
        const second = await registerProject(rootNew);
        expect(second.id).toBe(first.id);

        // The rebuild disposes the stale context and parks in the teardown…
        const drift = contexts.context(first.id);
        await vi.waitFor(() => expect(parkedDispose).toHaveBeenCalled());
        expect(contexts.peek(first.id)).toBeUndefined();
        // …and the overlapping request builds at the next generation, which is what makes the
        // dispose that follows `superseded`.
        const concurrent = contexts.context(first.id);
        expect(contexts.pending(first.id)).toBeDefined();

        release();
        await Promise.all([drift, concurrent]);
        expect(contexts.peek(first.id)?.root).toBe(rootNew);

        expect(removeSkillsSpy).toHaveBeenCalledWith(first.id);
        expect(removeAutomationSpy).toHaveBeenCalledWith(first.id);
        await vi.waitFor(() => expect(addSkillsSpy).toHaveBeenCalledWith(first.id, rootNew));
        expect(addSkillsSpy).not.toHaveBeenCalledWith(first.id, rootOld);
      } finally {
        release();
        parkedDispose.mockRestore();
        server.close();
        await contexts.disposeAll().catch(() => undefined);
        rmSync(base, { recursive: true, force: true });
      }
    });

    /**
     * #707 review round 1, Minor 1 (b): the SEQUENTIAL drift — the same rebuild with no
     * overlapping request, so the dispose is NOT superseded and the plain removal is the whole
     * answer. Probe B of the review (the listener body replaced by `return;`) left the suite
     * green, so nothing pinned that this listener removes anything at all; this does.
     */
    it('a drift with no overlapping request still drops the stale registration', async () => {
      process.env.XEZ_AUTOMATIONS = '1';
      clearProjectProbeCache();
      const base = mkdtempSync(join(tmpdir(), 'xez-automations-gate-seq-'));
      const rootOld = join(base, 'run-1', 'shared');
      const rootNew = join(base, 'run-2', 'shared');
      for (const root of [rootOld, rootNew]) mkdirSync(root, { recursive: true });
      const first = await registerProject(rootOld);

      const contexts = new ProjectContexts({ listProjects });
      const removeSkillsSpy = vi.spyOn(SkillsUpdateCoordinator.prototype, 'remove');
      const removeAutomationSpy = vi.spyOn(AutomationCoordinator.prototype, 'remove');
      const reachedGate = vi.spyOn(SkillsUpdateCoordinator.prototype, 'start');
      const started = vi.spyOn(WorkspaceAutomationScheduler.prototype, 'start');

      let app: ReturnType<typeof createApp> | undefined;
      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
          contexts,
          onApp: (built) => { app = built; },
        },
        0,
      );
      try {
        await vi.waitFor(() => expect(reachedGate).toHaveBeenCalledTimes(1), { timeout: 4_000 });
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 4_000 });

        expect((await apiRequest(app!, `/api/v1/p/${first.id}/runs`)).status).toBe(200);
        expect(contexts.peek(first.id)?.root).toBe(rootOld);
        removeSkillsSpy.mockClear();
        removeAutomationSpy.mockClear();

        await removeProject(first.id);
        expect((await registerProject(rootNew)).id).toBe(first.id);

        await contexts.context(first.id);
        expect(contexts.peek(first.id)?.root).toBe(rootNew);

        expect(removeSkillsSpy).toHaveBeenCalledWith(first.id);
        expect(removeAutomationSpy).toHaveBeenCalledWith(first.id);
      } finally {
        server.close();
        await contexts.disposeAll().catch(() => undefined);
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
