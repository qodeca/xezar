import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { emitUsageForTest } from '../core/process-usage.ts';
import type { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import {
  ProjectContextError,
  ProjectContexts,
  type ContextDisposal,
  type ProjectContextSource,
} from './project-context.ts';

/**
 * Lazy per-project context map (spec 2026-07-20-multi-project-workspace,
 * step 2.1): nothing instantiated until first access, one instance per id,
 * missing roots never built, and a disposed context's manager stops
 * receiving usage-sampler ticks. The registry is injected as a plain
 * `listProjects` resolver so nothing here touches `~/.xezar`.
 */
describe('ProjectContexts', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'xez-ctx-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'xez-ctx-b-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectContextSource[]): ProjectContexts {
    return new ProjectContexts({ listProjects: async () => projects });
  }

  /**
   * A context map whose builds can be parked one at a time, so a removal can be landed at the
   * one moment that used to be invisible: after the build read the registry, before it published.
   *
   * `listProjects` SNAPSHOTS the registry before parking on purpose — a build that started before
   * a removal keeps the view it read, which is what makes the race a race. Resolve `gates[n]` to
   * let build n finish; the gate is registered synchronously, so `gates.length` is also the count
   * of builds that were actually started.
   */
  function gatedContexts(registry: () => ProjectContextSource[]): {
    contexts: ProjectContexts;
    gates: (() => void)[];
    /** Every store a build opened, in order, each carrying a subscriber of the kind the workspace
     *  SSE and the provider watcher attach through `onStoreCreated` — so "the store was closed"
     *  is an assertion with something to lose. */
    stores: RunStore[];
    built: string[];
  } {
    const gates: (() => void)[] = [];
    const contexts = new ProjectContexts({
      listProjects: async () => {
        const snapshot = registry();
        await new Promise<void>((resolve) => gates.push(resolve));
        return snapshot;
      },
    });
    const stores: RunStore[] = [];
    contexts.onStoreCreated((store) => {
      stores.push(store);
      store.on('event', () => {});
    });
    const built: string[] = [];
    contexts.onContextBuilt((ctx) => built.push(ctx.id));
    return { contexts, gates, stores, built };
  }

  it('builds lazily: nothing on construction, first access builds, second returns the same instance', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);

    // Construction instantiated nothing — no store dir, no launch-key.
    expect(existsSync(join(rootA, '.local/xezar'))).toBe(false);
    expect(existsSync(join(rootB, '.local/xezar'))).toBe(false);
    expect(contexts.ids()).toEqual([]);

    const first = await contexts.context('a');
    expect(first.id).toBe('a');
    expect(first.dataDir).toBe(join(rootA, '.local/xezar'));
    expect(first.launchKey).not.toBe('');
    expect(existsSync(join(rootA, '.local/xezar', 'launch-key'))).toBe(true);
    // Only the accessed project was built.
    expect(existsSync(join(rootB, '.local/xezar'))).toBe(false);
    expect(contexts.ids()).toEqual(['a']);

    const second = await contexts.context('a');
    expect(second).toBe(first);
  });

  it('dedupes concurrent builds of the same project into one instance', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const [one, two] = await Promise.all([contexts.context('a'), contexts.context('a')]);
    expect(one).toBe(two);
  });

  it('uses the injected coordinator-owned automation store', async () => {
    const automationStore = AutomationStore.open(join(rootA, '.local/xezar'));
    const resolveAutomationStore = vi.fn(() => automationStore);
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }],
      automationStore: resolveAutomationStore,
    });
    const context = await contexts.context('a');
    expect(context.automationStore).toBe(automationStore);
    expect(resolveAutomationStore).toHaveBeenCalledWith('a', rootA);
    await contexts.disposeAll();
  });

  it('never instantiates a missing-root project (even when the directory happens to exist)', async () => {
    const contexts = makeContexts([{ id: 'gone', root: rootA, status: 'missing' }]);
    await expect(contexts.context('gone')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'missing-root',
      projectId: 'gone',
    });
    // Not built, and nothing written under the root.
    expect(contexts.peek('gone')).toBeUndefined();
    expect(existsSync(join(rootA, '.local/xezar'))).toBe(false);
  });

  it('throws unknown-project for an id the registry does not hold', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    await expect(contexts.context('nope')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'unknown-project',
      projectId: 'nope',
    });
    expect(contexts.ids()).toEqual([]);
  });

  it('exposes the failure as a typed error instance', async () => {
    const contexts = makeContexts([]);
    const err = await contexts.context('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectContextError);
  });

  it('dispose(): the manager receives no further usage ticks and the index is flushed', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const ctx = await contexts.context('a');
    // The constructor's onUsage listener calls `this.enforceMemoryLimit` —
    // spy on the instance and drive the fan-out directly, the way the shared
    // `ps` sampler would. An empty snapshot keeps the real method a sync no-op.
    const spy = vi.spyOn(
      ctx.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );

    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1);

    await expect(contexts.dispose('a')).resolves.toBe(true);
    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed — no further ticks
    // Store closed: the index landed on disk despite the debounced save.
    expect(existsSync(join(rootA, '.local/xezar', 'runs.json'))).toBe(true);
    expect(ctx.store.listenerCount('event')).toBe(0);

    // Disposed id is gone from the map; the next access builds a fresh context.
    expect(contexts.peek('a')).toBeUndefined();
    const rebuilt = await contexts.context('a');
    expect(rebuilt).not.toBe(ctx);
    await contexts.dispose('a');
  });

  it('onContextBuilt: fires once per build (not cached hits), unsubscribes cleanly, and a throwing listener never fails the build', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const built: string[] = [];
    const off = contexts.onContextBuilt((ctx) => built.push(ctx.id));
    contexts.onContextBuilt(() => {
      throw new Error('subscriber boom');
    });

    await contexts.context('a');
    expect(built).toEqual(['a']); // the throwing listener didn't fail the build
    await contexts.context('a');
    expect(built).toEqual(['a']); // cached hit — no re-notify

    off();
    const b = await contexts.context('b');
    expect(b.id).toBe('b'); // built fine with only the throwing listener left
    expect(built).toEqual(['a']); // unsubscribed — not notified for b
    await contexts.disposeAll();
  });

  /**
   * #647, AC-9 fan-out guard. The dispose payload is an ADDITIVE second parameter, which is
   * exactly the "a replacement that ships OFF" trap AGENTS.md names: a listener that ignores it
   * keeps the bug and still compiles. This pins that `notifyDisposed` is the one publisher and
   * that every registered listener — migrated or not — is reached through it.
   *
   * A guard, deliberately: it asserts the payload's SHAPE, not its values, so it says nothing
   * about whether the generations in it are right. RP-1 owns that.
   */
  it('onContextDisposed: every registered listener gets the payload, and a one-argument listener still works (guard)', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const migrated: Array<[string, ContextDisposal]> = [];
    const alsoMigrated: Array<[string, ContextDisposal]> = [];
    const unmigrated: string[] = [];
    contexts.onContextDisposed((id, disposal) => migrated.push([id, disposal]));
    contexts.onContextDisposed((id, disposal) => alsoMigrated.push([id, disposal]));
    contexts.onContextDisposed((id) => unmigrated.push(id));
    const off = contexts.onContextDisposed(() => {
      throw new Error('subscriber boom');
    });

    await contexts.context('a');
    await expect(contexts.dispose('a')).resolves.toBe(true);

    for (const seen of [migrated, alsoMigrated]) {
      expect(seen).toHaveLength(1);
      const [id, disposal] = seen[0]!;
      expect(id).toBe('a');
      expect(typeof disposal.generation).toBe('number');
      expect(typeof disposal.superseded).toBe('boolean');
    }
    expect(unmigrated).toEqual(['a']); // a listener that ignores the payload is unaffected
    off();
  });

  /**
   * #647, AC-8 and the § 2(5) fail-open rule. `generations` holds no entry until a project's
   * first removal, so that first dispose carries generation 0 — a real value, not an absent one.
   * A guard written as `if (!generation) return` would make the FIRST removal of every project a
   * no-op for every listener, which is the exact lie the rule names.
   */
  it('a project\'s first dispose is a real dispose: generation 0, not superseded, still a full teardown', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const disposals: Array<[string, ContextDisposal]> = [];
    contexts.onContextDisposed((id, disposal) => disposals.push([id, disposal]));

    const ctx = await contexts.context('a');
    expect(ctx.generation).toBe(0);
    await expect(contexts.dispose('a')).resolves.toBe(true);

    expect(disposals).toEqual([['a', { generation: 0, superseded: false }]]);
    // …and the terminal states it exists to reach were reached, first removal or not.
    expect(contexts.peek('a')).toBeUndefined();
    expect(ctx.store.listenerCount('event')).toBe(0);
  });

  it('dispose() of a never-built project is a no-op returning false', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    await expect(contexts.dispose('a')).resolves.toBe(false);
  });

  /**
   * #592 review round 1, Blocker 1: `registeredAt()` (now `driftFor()`) used to ask
   * `projects.some(p => p.id === id && p.root === cachedRoot)` — against an EMPTY list, "the
   * registry says this id moved" and "we could not read the registry at all" were the same branch.
   * AGENTS.md names this outright: "a fail-open helper needs a populated-input guarantee … against
   * empty input, 'we never loaded the list' and 'no match' are the same branch and must not read
   * the same." `loadWorkspaceConfig` is DESIGNED to answer zero projects when the registry can't be
   * read, so a transient failure (permissions, a dropped network mount, fd exhaustion) used to
   * dispose every non-boot project's live context on its very next request.
   */
  it('a registry read with no information (empty result, or a rejection) never disposes the cached context', async () => {
    let projects: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
    let fail: 'reject' | 'empty' | undefined;
    const contexts = new ProjectContexts({
      listProjects: async () => {
        if (fail === 'reject') throw new Error('registry unreadable');
        if (fail === 'empty') return [];
        return projects;
      },
    });
    const first = await contexts.context('a');

    // `listProjects()` rejects outright (e.g. `$XEZ_HOME` briefly unreadable).
    fail = 'reject';
    await expect(contexts.context('a')).resolves.toBe(first);

    // The selector-scoped read finds nothing for this id at all — still no information, never
    // "removed": the explicit removal route is what disposes on an actual removal.
    fail = 'empty';
    await expect(contexts.context('a')).resolves.toBe(first);

    // A normal, positive re-read (same root) still just confirms the cache — no dispose fired in
    // between, so this is still the SAME context instance throughout.
    fail = undefined;
    await expect(contexts.context('a')).resolves.toBe(first);
    expect(contexts.peek('a')).toBe(first);

    await contexts.dispose('a');
  });

  /**
   * #592 review round 1, Major 2: the removal route refuses to dispose a project with running
   * tasks (409). The on-access drift check had no equivalent guard, so a benign out-of-band
   * re-point (a moved and re-registered repo) while runs were live would tear down the manager
   * those runs depend on — leaving them running but unreachable by `cancel()` forever
   * (`workflows/run.ts`'s "dispose() is not a run-stopper" doc). The fix keeps serving the cached
   * context while any run is active, logs exactly ONE warning, and only rebuilds once nothing is.
   */
  it('does not dispose a cached context with active runs when the registry root drifts; warns once, rebuilds once idle', async () => {
    const registry: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
    const contexts = new ProjectContexts({ listProjects: async () => registry });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const ctx = await contexts.context('a');
    const run = ctx.store.createRun({ title: 'live', workflow: 'quick-task', task: 'x', steps: [] });
    expect(run.status).toBe('queued'); // one of the three statuses the engine still owns

    registry[0] = { id: 'a', root: rootB, status: 'not-git' };

    const stillCached = await contexts.context('a');
    expect(stillCached).toBe(ctx); // kept serving the cache — the run was never stranded
    expect(stillCached.root).toBe(rootA);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('a');
    expect(message).toContain(rootA);
    expect(message).toContain(rootB);

    // A second access while the run is still active must not warn again.
    await contexts.context('a');
    expect(warn).toHaveBeenCalledTimes(1);

    // The manager backing the served context is untouched (not disposed): calling into it is safe
    // and does not throw, unlike a manager whose store has already been closed.
    expect(() => ctx.manager.cancel(run.id)).not.toThrow();

    // Once the run finishes, the SAME drift is now safe to act on.
    ctx.store.updateRun(run.id, { status: 'done' });
    const rebuilt = await contexts.context('a');
    expect(rebuilt).not.toBe(ctx);
    expect(rebuilt.root).toBe(rootB);

    await contexts.dispose('a');
  });

  /**
   * #592 review round 1, Minor 1: several requests landing on a stale cache hit together (the
   * cockpit fires scoped requests in parallel) each used to read the registry independently, each
   * conclude "moved" and each call `dispose()` — bumping `generations` again out from under
   * whichever one started first, so its build lost its publish check (`buildAndPublish`) and
   * rejected `unknown-project` for a project that exists. The fix single-flights the dispose+
   * rebuild itself: exactly one caller's `RunManager.dispose()` should fire for the OLD context,
   * and every concurrent caller should resolve to the SAME rebuilt one — never a rejection.
   */
  it('several concurrent drift detections share ONE dispose+rebuild, never a spurious 404', async () => {
    let registry: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
    const gates: (() => void)[] = [];
    const contexts = new ProjectContexts({
      listProjects: async (selector) => {
        if (selector) {
          // The drift check's own selector-scoped read — parked so several concurrent context()
          // calls can all observe "stale" before any of them acts on it.
          await new Promise<void>((resolve) => gates.push(resolve));
          return registry.filter((p) => p.id === selector.projectId);
        }
        return registry; // build()'s unselected read resolves immediately.
      },
    });
    const managerDispose = vi.spyOn(RunManager.prototype, 'dispose');

    const first = await contexts.context('a');
    registry = [{ id: 'a', root: rootB, status: 'not-git' }];

    const calls = [contexts.context('a'), contexts.context('a'), contexts.context('a')];
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    for (const gate of gates.splice(0)) gate();

    const results = await Promise.all(calls);
    for (const result of results) {
      expect(result.root).toBe(rootB); // none 404s — the pre-fix symptom
      expect(result).toBe(results[0]); // all three share the SAME rebuilt context
    }
    expect(results[0]).not.toBe(first);
    expect(managerDispose).toHaveBeenCalledTimes(1); // the old context's manager, exactly once

    await contexts.dispose('a');
  });

  /**
   * The two removal-versus-build races (#199/#200 follow-up). Both were reachable for as long as
   * `dispose()` read `contexts` only: a build that was still in flight was invisible to it, so
   * the build published itself into the map AFTERWARDS and `context()` — which reads `contexts`
   * first — went on serving every scoped route of a removed project from a context holding an
   * open store, a live manager and this process's writer claim.
   */
  describe('a removal that races a build', () => {
    it('never lets the finished build publish itself: it is torn down, and context() refuses it', async () => {
      let registry: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
      const { contexts, gates, stores, built } = gatedContexts(() => registry);
      const managerDispose = vi.spyOn(RunManager.prototype, 'dispose');

      const inFlight = contexts.context('a');
      expect(gates).toHaveLength(1); // parked mid-build, registry already read

      // The user removes the project from the sidebar while that build is still running.
      registry = [];
      const removed = contexts.dispose('a');
      gates[0]!();

      // The build finished into a registration that no longer exists, and says so: by the time
      // it had a context to hand out, `a` was an unknown project — a 404 at the route layer.
      await expect(inFlight).rejects.toMatchObject({
        name: 'ProjectContextError',
        reason: 'unknown-project',
        projectId: 'a',
      });
      await expect(removed).resolves.toBe(true);

      // Unreachable: nothing in the map, and no route can be bound to what the build produced.
      expect(contexts.peek('a')).toBeUndefined();
      expect(contexts.ids()).toEqual([]);
      // Never announced either — the workspace SSE and the provider watcher subscribe through
      // `onContextBuilt`, and attaching them to a store that is about to close is the same leak
      // one step removed.
      expect(built).toEqual([]);

      // Released, not merely orphaned: manager disposed, index flushed, subscribers detached.
      expect(stores).toHaveLength(1);
      expect(managerDispose).toHaveBeenCalledTimes(1);
      expect(stores[0]!.listenerCount('event')).toBe(0);
      expect(existsSync(join(rootA, '.local/xezar', 'runs.json'))).toBe(true);
    });

    it('gives a project re-added mid-build its own context, and releases the build the removal orphaned', async () => {
      // Same id, same root, before and after: re-adding a folder hands back the same slug, which
      // is exactly the case a post-build registry re-check cannot tell from "never removed".
      const registry: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
      const { contexts, gates, stores, built } = gatedContexts(() => registry);
      const managerDispose = vi.spyOn(RunManager.prototype, 'dispose');

      const stale = contexts.context('a');
      stale.catch(() => undefined); // asserted below; never an unhandled rejection meanwhile
      expect(gates).toHaveLength(1);

      const removed = contexts.dispose('a');
      // Re-added while the first build is still parked — its first API touch must not be handed
      // the build that belongs to the registration the user just deleted.
      const fresh = contexts.context('a');
      expect(gates).toHaveLength(2);

      gates[0]!(); // the orphaned build finishes first, the way a slow recover() would
      await expect(stale).rejects.toMatchObject({ reason: 'unknown-project' });
      await expect(removed).resolves.toBe(true);
      expect(managerDispose).toHaveBeenCalledTimes(1); // the loser's manager, and only it
      expect(stores[0]!.listenerCount('event')).toBe(0);
      expect(built).toEqual([]); // the loser was never announced to anyone

      gates[1]!();
      const ctx = await fresh;
      expect(stores).toHaveLength(2);
      expect(contexts.peek('a')).toBe(ctx);
      expect(ctx.store).toBe(stores[1]);
      expect(ctx.store).not.toBe(stores[0]); // no route is served off the orphaned store
      expect(stores[1]!.listenerCount('event')).toBe(1); // …and the live one is untouched
      expect(built).toEqual(['a']);

      await expect(contexts.dispose('a')).resolves.toBe(true);
      expect(managerDispose).toHaveBeenCalledTimes(2);
    });

    /**
     * #647 (RP-1) — the seam this whole change exists for. `dispose()` ends the registration and
     * drops the context synchronously but notifies only AFTER `teardown` (#467's guarantee that
     * no listener sees a half-released context), and that teardown awaits `RunManager.dispose()`.
     * So a project re-added and REBUILT inside that window is already live when the removal's
     * notification lands, and a listener told only the id releases the live project's state.
     *
     * What the payload has to say, then: which registration this dispose is about — captured
     * before the bump — and whether that id has already moved past it.
     */
    it('tells a dispose listener WHICH registration went away, and that a rebuild already replaced it', async () => {
      const registry: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
      const { contexts, gates } = gatedContexts(() => registry);
      const disposals: Array<[string, ContextDisposal]> = [];
      contexts.onContextDisposed((id, disposal) => disposals.push([id, disposal]));
      const builtGenerations: number[] = [];
      contexts.onContextBuilt((ctx) => builtGenerations.push(ctx.generation));

      // Park the FIRST teardown only — the one the rebuild has to outrun.
      const realDispose = RunManager.prototype.dispose;
      let releaseTeardown!: () => void;
      const parked = new Promise<void>((resolve) => {
        releaseTeardown = resolve;
      });
      let teardowns = 0;
      vi.spyOn(RunManager.prototype, 'dispose').mockImplementation(async function (this: RunManager) {
        if (teardowns++ === 0) await parked;
        return realDispose.call(this);
      });

      const first = contexts.context('a');
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates[0]!();
      const original = await first;
      expect(original.generation).toBe(0);

      // The user removes the project; its teardown parks.
      const removed = contexts.dispose('a');
      expect(contexts.peek('a')).toBeUndefined();
      expect(disposals).toEqual([]); // not notified yet — the teardown is still running

      // Re-added, and its first API touch rebuilds it while that teardown is still parked.
      const rebuilding = contexts.context('a');
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]!();
      const rebuilt = await rebuilding;
      expect(rebuilt.generation).toBe(1);
      expect(contexts.peek('a')).toBe(rebuilt);

      releaseTeardown();
      await expect(removed).resolves.toBe(true);

      // The dispose names the registration it is about, and says the id has moved past it.
      expect(disposals).toEqual([['a', { generation: 0, superseded: true }]]);
      expect(builtGenerations).toEqual([0, 1]);
      // The rebuilt context is untouched by that dispose: still published, still open.
      expect(contexts.peek('a')).toBe(rebuilt);
      expect(rebuilt.store.listenerCount('event')).toBe(1);

      await expect(contexts.dispose('a')).resolves.toBe(true);
      expect(disposals[1]).toEqual(['a', { generation: 1, superseded: false }]);
    });

    it('disposeAll() covers a build in flight, so shutdown leaves no store open behind it', async () => {
      const registry: ProjectContextSource[] = [{ id: 'a', root: rootA, status: 'not-git' }];
      const { contexts, gates, stores } = gatedContexts(() => registry);
      const managerDispose = vi.spyOn(RunManager.prototype, 'dispose');

      const inFlight = contexts.context('a');
      inFlight.catch(() => undefined);
      expect(gates).toHaveLength(1);

      const closed = contexts.disposeAll();
      gates[0]!();
      await closed;

      await expect(inFlight).rejects.toBeInstanceOf(ProjectContextError);
      expect(contexts.ids()).toEqual([]);
      expect(managerDispose).toHaveBeenCalledTimes(1);
      expect(stores[0]!.listenerCount('event')).toBe(0);
    });
  });

  it('disposeAll() tears down every built context', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const a = await contexts.context('a');
    const b = await contexts.context('b');
    const spyA = vi.spyOn(
      a.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );
    const spyB = vi.spyOn(
      b.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );

    await contexts.disposeAll();
    expect(contexts.ids()).toEqual([]);
    emitUsageForTest({});
    expect(spyA).not.toHaveBeenCalled();
    expect(spyB).not.toHaveBeenCalled();
  });

  /**
   * AC-9 (#647): the fan-out guard.
   *
   * The second argument is ADDITIVE, which is exactly the trap AGENTS.md § Changing a mechanism
   * that already works names: a listener that ignores it keeps the bug and still compiles, so the
   * seam can ship complete while half its consumers behave as before. Nothing in the type system
   * can fail for that, so this reads the source text instead — one missed listener is half a fix.
   *
   * Deliberately over the SHIPPED source only, never the tests: `project-context.test.ts` above
   * subscribes a one-argument listener ON PURPOSE, to pin that an unmigrated third-party listener
   * still compiles and still fires.
   */
  it('every onContextDisposed listener in the shipped source takes the disposal payload', () => {
    const srcRoot = resolve(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.name.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(item.name)) files.push(full);
      }
    };
    walk(srcRoot);

    /**
     * An inline arrow — `(a, b) => …`, `async (a, b) => …`, or the one-parameter `id => …` and
     * `async id => …` spellings — or an identifier naming a listener declared in the file.
     *
     * #707 review round 1, Minor 2: the two `async`/bare-identifier-arrow forms used to match
     * NEITHER branch, so a listener spelled that way was skipped silently — and a scan that skips
     * the listener it cannot read is the fail-open helper AGENTS.md § Changing a mechanism that
     * already works warns about. The count check below is the guarantee that does not depend on
     * this regex being complete: every `onContextDisposed(` in the file must end up classified,
     * so the NEXT unrecognised spelling fails this test loudly instead of passing unseen.
     */
    const CALL = /onContextDisposed\(\s*(?:async\s*)?(?:\(([^)]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*(\)|=>))/g;
    const ALL = /onContextDisposed\(/g;
    /** The hook's own TYPE signature (`onContextDisposed(listener: (…) => void)`), not a call. */
    const SIGNATURE = /onContextDisposed\(\s*[A-Za-z_$][\w$]*\s*:/g;
    const sites: Array<{ where: string; params: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const classified = [...text.matchAll(CALL)];
      const calls = [...text.matchAll(ALL)].length - [...text.matchAll(SIGNATURE)].length;
      expect(calls, `${file}: an onContextDisposed call this scan cannot classify`)
        .toBe(classified.length);
      for (const match of classified) {
        // A bare identifier followed by `=>` is a one-parameter arrow, not a named listener.
        const named = match[3] === '=>' ? undefined : match[2];
        if (named === undefined) {
          sites.push({ where: `${file}: inline`, params: match[1] ?? match[2] ?? '' });
          continue;
        }
        const declaration = text.match(
          new RegExp(`(?:const\\s+${named}\\s*=\\s*|function\\s+${named}\\s*)\\(([^)]*)\\)`),
        );
        expect(declaration, `${file}: ${named} is passed to onContextDisposed but declared nowhere here`)
          .not.toBeNull();
        sites.push({ where: `${file}: ${named}`, params: declaration?.[1] ?? '' });
      }
    }

    // The four consumers of the hook: MCP doors, the workspace SSE stream, the terminal and the
    // automations/skills coordinators. A fifth is welcome — a fourth is a listener that went away.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    for (const site of sites) {
      expect(site.params.split(',').filter((part) => part.trim() !== ''), site.where).toHaveLength(2);
    }
  });
});
