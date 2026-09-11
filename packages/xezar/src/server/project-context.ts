import { projectDataDir } from '../project-data-paths.ts';
import { join } from 'node:path';
import { AutomationStore } from '../automations/store.ts';
import { reconcileAutomationReceipts } from '../automations/task-template.ts';
import { DEFAULT_WORKTREE_RETENTION, resolveWorktreeRetention } from '../config.ts';
import { pruneOrphans } from '../git-worktree.ts';
import { armRepoHandle } from '../runs/arm-repo-handle.ts';
import { reclaimWorktrees } from '../runs/retention.ts';
import { RunStore } from '../runs/store.ts';
import { ownProjectData } from '../runs/project-writer.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from '../workflows/run.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { getRepoInfo } from './git.ts';

/**
 * Per-project server context (spec 2026-07-20-multi-project-workspace,
 * "Project contexts" + "Boot flow"): one `{store, manager, dataDir,
 * launchKey}` bundle per registered project, built lazily on first access.
 *
 * Building a context mirrors what `serveCommand` does for the boot project
 * today — `RunStore.open(dataDir, { keepLive: true })`, `new RunManager`,
 * orphan-worktree prune + count-based retention when the root is a git repo,
 * then `manager.recover()` — so a project opened from the sidebar gets the
 * exact same crash recovery the boot project gets. A registry entry whose
 * root is gone (`status: 'missing'`) is never instantiated; `context()`
 * throws a typed `ProjectContextError` the route layer maps to 409 (and
 * `unknown-project` to 404).
 */

/** The per-project bundle the routes operate on. */
export interface ProjectContext {
  /** Registry project id (slug). */
  id: string;
  /** Realpath'd repo root the registry holds for this project. */
  root: string;
  /** `<root>/.local/xezar` — all of this project's on-disk state. */
  dataDir: string;
  store: RunStore;
  manager: RunManager;
  automationStore: AutomationStore;
  /** Bookmarklet auto-start secret (spec 011), ensured at context build. */
  launchKey: string;
}

/** Minimal registry shape the context map needs — matches
 *  `workspace/projects.ts` `ProjectListEntry` structurally, but injected so
 *  tests stay hermetic (no `~/.xezar` reads). */
export interface ProjectContextSource {
  id: string;
  root: string;
  /** `missing` roots are never instantiated; `ok`/`not-git` both build. */
  status: 'ok' | 'missing' | 'not-git';
}

export interface ProjectContextDeps {
  /** Registry lookup — the workspace `listProjects()` in production. */
  listProjects: () => Promise<readonly ProjectContextSource[]>;
  /** Resolve the one automation store owned by this project. Production
   *  injects the workspace automation coordinator's cached store so API
   *  mutations and scheduler reads share the same in-memory state. */
  automationStore?: (projectId: string, root: string) => AutomationStore;
  /** Workspace-wide parallel-cap semaphore (spec 2026-07-20, step 2.5). Boot
   *  passes the ONE instance it already gave the boot manager, so every
   *  project's RunManager counts against the same `resources.maxParallel`.
   *  When omitted, the map still shares one private instance across the
   *  managers it builds (workspace defaults, never refreshed). */
  semaphore?: WorkspaceSemaphore;
}

export type ProjectContextFailure = 'unknown-project' | 'missing-root';

/** Typed failure so the route layer can map reasons to statuses (404/409)
 *  without string matching. */
export class ProjectContextError extends Error {
  constructor(
    readonly reason: ProjectContextFailure,
    readonly projectId: string,
  ) {
    super(
      reason === 'unknown-project'
        ? `unknown project: ${projectId}`
        : `project root is missing: ${projectId}`,
    );
    this.name = 'ProjectContextError';
  }
}

/**
 * Lazy `Map<projectId, ProjectContext>`. Nothing is instantiated at
 * construction — the boot project is built eagerly by the caller via
 * `context(bootId)`; every other project on first API touch. Concurrent
 * `context()` calls for the same id share one build (the in-flight promise is
 * cached), so recovery never runs twice for a project — unless the project was
 * removed in between, which ends that build's claim on the id (`generations`).
 */
export class ProjectContexts {
  private readonly contexts = new Map<string, ProjectContext>();
  /** In-flight builds, each tagged with the REGISTRATION it was started for. See `generations`. */
  private readonly building = new Map<string, { generation: number; promise: Promise<ProjectContext> }>();
  /**
   * How many times each id's registration has ended in this process — bumped by `dispose()`,
   * which is the only event that ends one.
   *
   * A build crosses several awaits (store open, orphan prune, retention sweep, `recover()`), and
   * a removal can land inside any of them. Before this counter, `dispose()` read `contexts` only,
   * so a removal mid-build tore down nothing and the build then published itself into the map
   * AFTERWARDS — `context()` reads `contexts` first, so every scoped route for a removed project
   * went on being served from a context holding an open store and this process's writer claim.
   *
   * A generation, rather than re-reading the registry once the build finishes: re-adding a folder
   * hands back the same slug for the same root, so a registry re-read cannot tell "still the
   * registration I started for" from "removed and re-added while I was building" — and it would
   * add another await between the check and the publish for a removal to slip into. The counter
   * answers exactly that question, and it is compared SYNCHRONOUSLY with the `contexts.set` that
   * publishes, so nothing can come between them. Ids that were never disposed are absent and read
   * as 0; the map only grows by one small entry per project actually removed.
   */
  private readonly generations = new Map<string, number>();
  /** Live store-created subscribers; invoked before RunManager recovery. */
  private readonly storeListeners = new Set<(store: RunStore) => void>();
  /** Live `onContextBuilt` subscribers (workspace SSE, step 2.8). */
  private readonly builtListeners = new Set<(ctx: ProjectContext) => void>();
  /** One semaphore for every manager this map builds — injected by boot,
   *  private-but-shared otherwise. */
  private readonly semaphore: WorkspaceSemaphore;

  constructor(private readonly deps: ProjectContextDeps) {
    this.semaphore = deps.semaphore ?? new WorkspaceSemaphore();
  }

  /** The built context for `projectId`, building it on first access.
   *  Throws `ProjectContextError` for unknown ids and missing roots — including for a build the
   *  project's removal outlived, which reports the id as `unknown-project` (a 404) because by the
   *  time that build finished, that is what it was. */
  async context(projectId: string): Promise<ProjectContext> {
    const existing = this.contexts.get(projectId);
    if (existing) return existing;
    const generation = this.generation(projectId);
    const inFlight = this.building.get(projectId);
    // A build started for an EARLIER registration is never adopted: it is going to tear itself
    // down rather than publish, so handing it to a caller asking about the current registration
    // would answer "unknown project" for a project that exists. The re-added project gets its own
    // build, running beside the one it superseded.
    if (inFlight && inFlight.generation === generation) return inFlight.promise;
    const entry = { generation, promise: this.buildAndPublish(projectId, generation) };
    this.building.set(projectId, entry);
    try {
      return await entry.promise;
    } finally {
      // Identity-guarded: a superseded build must not evict the entry of the build that replaced
      // it, and `dispose()` may already have cleared this one.
      if (this.building.get(projectId) === entry) this.building.delete(projectId);
    }
  }

  /** The registration counter for `projectId`; 0 until its first `dispose()`. */
  private generation(projectId: string): number {
    return this.generations.get(projectId) ?? 0;
  }

  /**
   * Build, then publish only if the registration this build was started for is still the current
   * one. The check and the `contexts.set` are one synchronous block on purpose: an await between
   * them is a window for the removal this whole method exists to catch.
   *
   * A build that lost is torn down HERE, inside the promise `building` holds, so there is exactly
   * one place a losing context is released and `dispose()` gets that teardown simply by awaiting
   * the same promise.
   */
  private async buildAndPublish(projectId: string, generation: number): Promise<ProjectContext> {
    const ctx = await this.build(projectId);
    if (this.generation(projectId) !== generation) {
      await teardown(ctx);
      throw new ProjectContextError('unknown-project', projectId);
    }
    this.contexts.set(projectId, ctx);
    // Armed only once the context is PUBLISHED, for the reason spelled out in `build()`: the
    // lookup outlives the call, and a handle landing on a store whose lifecycle has ended would
    // `touch()` its healed records — scheduling a debounced `runs.json` write from a context
    // nobody owns. A build that loses its generation therefore never arms one at all, which is
    // the only way to release something `armRepoHandle` gives no handle to cancel.
    armRepoHandle(ctx.store, ctx.root);
    this.notifyBuilt(ctx);
    return ctx;
  }

  /**
   * Subscribe to future context builds (multi-project spec, step 2.8): the
   * workspace SSE stream attaches to every already-built context at connect
   * and uses this hook to pick up contexts built LATER — so subscribing never
   * force-instantiates a project, yet a project's first API touch makes its
   * events flow to already-open workspace streams. Returns an unsubscribe.
   */
  onContextBuilt(listener: (ctx: ProjectContext) => void): () => void {
    this.builtListeners.add(listener);
    return () => this.builtListeners.delete(listener);
  }

  /**
   * Subscribe at the earliest RunStore lifecycle point: immediately after a
   * lazy project's store opens and before its manager can recover runs. This
   * stays generic so backend-specific observers do not leak into the context
   * map. Returns an unsubscribe.
   */
  onStoreCreated(listener: (store: RunStore) => void): () => void {
    this.storeListeners.add(listener);
    return () => this.storeListeners.delete(listener);
  }

  /** A listener throwing must never fail the build (its store is usable). */
  private notifyStoreCreated(store: RunStore): void {
    for (const listener of [...this.storeListeners]) {
      try {
        listener(store);
      } catch {
        // subscriber's problem — context construction can continue
      }
    }
  }

  /** A listener throwing must never fail the build (its context is fine). */
  private notifyBuilt(ctx: ProjectContext): void {
    for (const listener of [...this.builtListeners]) {
      try {
        listener(ctx);
      } catch {
        // subscriber's problem — the build succeeded
      }
    }
  }

  /**
   * Already-built context, without triggering a build.
   *
   * Deliberately still `contexts`-only, and it has to be: this is synchronous, and an in-flight
   * build has no context to return yet. What that costs the ONE caller which reads it as a
   * question about the project rather than about the map — `activeRunCount`, behind
   * `DELETE /projects/:id`'s running-tasks guard — is covered by `pending()` instead: a project
   * mid-build is not a project with no runs, because its store opens with `keepLive` and
   * `manager.recover()` re-queues or resumes every live-looking row.
   */
  peek(projectId: string): ProjectContext | undefined {
    return this.contexts.get(projectId);
  }

  /**
   * The in-flight build for `projectId`, if one is running — never starts one.
   *
   * For callers that must not decide anything about a project while it is still opening. The
   * promise rejects for a failed or superseded build, so await it defensively; the caller owns
   * the deadline, because how long a request may wait is a property of the request and not of
   * this map (`PROJECT_TEARDOWN_WAIT_MS` in server.ts).
   */
  pending(projectId: string): Promise<ProjectContext> | undefined {
    return this.building.get(projectId)?.promise;
  }

  /** Ids of every built context (dispose bookkeeping, shutdown flush). */
  ids(): string[] {
    return [...this.contexts.keys()];
  }

  /**
   * Tear down one project's context (project removal): the manager stops
   * making moves on its own (`RunManager.dispose()` — usage-sampler
   * unsubscribe, timers, queued state) and the store is closed — index
   * flushed to disk, every event-bus subscriber detached. Returns false only
   * when this map held NOTHING for `projectId` — neither a built context nor a
   * build in flight.
   *
   * Ends the id's registration first (`generations`), which is what makes this safe to call
   * against a project whose context is still being built: that build now loses its publish check,
   * tears itself down and rejects instead of installing itself into a map the removal has already
   * been through. Awaiting it here is what lets this promise keep meaning "nothing this project
   * opened is still holding a store or writing to it" in the one case where the dangerous handle
   * is not in `contexts` yet.
   *
   * Async because `RunManager.dispose()` is: its promise settles the background writes it could
   * not stop synchronously — a queue-watchdog rescue, a worktree-retention sweep — and dropping
   * it made the guarantee inert exactly where it is worth most. The context is removed from the
   * map SYNCHRONOUSLY, before the await, so no route can resolve a context that is being torn
   * down; only the wait for its last writes is deferred. Order matters after that: the manager's
   * writes must land before `flush()` + `removeAllListeners()`, or a stamp arriving later
   * schedules a debounced `runs.json` write from a store nobody owns — the same hazard
   * `armRepoHandle` is guarded against above, and the one that lets a re-added project's stale
   * in-memory list overwrite the fresh one.
   */
  async dispose(projectId: string): Promise<boolean> {
    // Bumped BEFORE anything is awaited, so a build that has not reached its publish check yet is
    // already a loser by the time it gets there — no window, no second removal path.
    this.generations.set(projectId, this.generation(projectId) + 1);
    const pending = this.building.get(projectId);
    const ctx = this.contexts.get(projectId);
    if (ctx) this.contexts.delete(projectId); // synchronously, before any await — see below

    if (pending) {
      // It tears ITSELF down at its publish check and rejects — unless it had already published,
      // in which case it resolves to the context taken out of the map above and `teardown` below
      // is that context's one and only teardown.
      await pending.promise.catch(() => undefined);
      if (this.building.get(projectId) === pending) this.building.delete(projectId);
    }
    if (!ctx) return pending !== undefined;
    await teardown(ctx);
    return true;
  }

  /** Tear down every built context (process shutdown). Sequential rather than parallel: these
   *  are disk flushes, and the map is small. In-flight builds are included: a build that lands
   *  after shutdown would otherwise publish an open store into a map nobody disposes again. */
  async disposeAll(): Promise<void> {
    for (const id of new Set([...this.ids(), ...this.building.keys()])) await this.dispose(id);
  }

  private async build(projectId: string): Promise<ProjectContext> {
    const projects = await this.deps.listProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new ProjectContextError('unknown-project', projectId);
    if (project.status === 'missing') throw new ProjectContextError('missing-root', projectId);

    const dataDir = projectDataDir(project.root);
    ownProjectData(dataDir);
    // keepLive + recover() (#367), same as serveCommand: runs that were live
    // when this project's context last existed are re-queued or resumed.
    const store = RunStore.open(dataDir, { keepLive: true });
    const automationStore = this.deps.automationStore?.(project.id, project.root)
      ?? AutomationStore.open(dataDir);
    reconcileAutomationReceipts(automationStore, store);
    this.notifyStoreCreated(store);
    const manager = new RunManager(store, project.root, { semaphore: this.semaphore });
    try {
      const launchKey = ensureLaunchKey(dataDir);
      // Startup reconcile (spec 006) + count-based retention (#483) — the same
      // best-effort sweeps serveCommand runs for the boot project, gated on the
      // root actually being a git repo.
      if (await getRepoInfo(project.root)) {
        await pruneOrphans(project.root, new Set(store.listRuns().map((r) => r.id))).catch(
          () => [] as string[],
        );
        const keep = await resolveWorktreeRetention(project.root).catch(
          () => DEFAULT_WORKTREE_RETENTION,
        );
        await reclaimWorktrees(project.root, store, keep).catch(() => [] as string[]);
      }
      await manager.recover();
      // Which repository this project IS (#945) is armed by `buildAndPublish`, NOT here: it is a
      // fire-and-forget `gh` lookup that outlives the call, so it may only start once this
      // context is one a route can reach. Arming beside `RunStore.open` would outlive a failed
      // build, and arming on the way out of here would outlive a build the project's removal
      // outlived — both end the same way, with a healed record `touch()`ing a store whose
      // lifecycle has ended and scheduling a `runs.json` write from a context nobody owns.
      return { id: project.id, root: project.root, dataDir, store, manager, automationStore, launchKey };
    } catch (err) {
      // A failed build must not leak the half-built context's subscriptions.
      await teardown({ store, manager });
      throw err;
    }
  }
}

/** Shared teardown for built and half-built contexts. Awaits the manager BEFORE closing the
 *  store, because that promise is the only signal that its background writes are finished. */
async function teardown(ctx: { store: RunStore; manager: RunManager }): Promise<void> {
  await ctx.manager.dispose();
  ctx.store.flush();
  ctx.store.removeAllListeners();
}
