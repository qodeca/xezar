/**
 * The MCP door of every project a running cockpit builds AFTER boot (#557).
 *
 * `serve` opens the boot project's socket itself, once, before any other project exists. A project
 * registered later gets its store, manager and routes from the project-context map when it is first
 * touched — and, until this module, nothing else: `xez mcp` in that project's folder answered
 * "xezar is not running" while the same process was serving its routes. This follows the map's
 * two lifecycle hooks instead: a door opens when a context is BUILT and closes when it is DISPOSED
 * (a removal, or the drift rebuild #591 routes through the same seam).
 *
 * Why the build and not the registration: a door composes over the project's own store (its event
 * catalog listens to it), and the store exists only once the context does. The build is also where
 * this process takes the project's writer claim (`ownProjectData`), so a door opens exactly where
 * the process became the project's one writer — a folder served by its own cockpit fails that
 * build and gets no second door here.
 *
 * Type-only imports on purpose: `src/index.ts` imports this statically, and the MCP module itself
 * stays a lazy import there, so a broken MCP part can never stop the cockpit booting (N-07).
 */

/** What an open door gives back: the one thing needed to release it. */
export interface ProjectDoorHandle {
  close(): void;
}

/** The two lifecycle hooks of the project-context map, plus what is already built. */
export interface ProjectDoorContexts<C extends { readonly id: string }> {
  ids(): string[];
  peek(projectId: string): C | undefined;
  onContextBuilt(listener: (ctx: C) => void): () => void;
  onContextDisposed(listener: (projectId: string) => void): () => void;
}

export interface ProjectDoorsOptions<C extends { readonly id: string }> {
  /**
   * The project whose door the caller opens itself — the boot project. Never handled here, so the
   * boot door stays exactly the one `serve` opens, and a second listen on its path never happens.
   */
  readonly bootProjectId?: string;
  /** Open one project's door; `undefined` means it could not open (the caller already said why). */
  readonly open: (ctx: C) => Promise<ProjectDoorHandle | undefined>;
  /**
   * Fires exactly when an opened handle is kept as the project's door — never when the project was
   * disposed while its open was still in flight (the handle is closed instead, silently). The one
   * safe place to announce a door as ready: `open`'s own return does not tell the caller whether the
   * handle it just got back is still current.
   */
  readonly onOpened?: (ctx: C) => void;
}

interface Door {
  closed: boolean;
  handle?: ProjectDoorHandle;
  /** Settles once the open has finished AND, if the door closed first, its late handle is released. */
  settled: Promise<void>;
}

/**
 * Follow `contexts` and keep one door per built non-boot project. Returns the release: it stops
 * following and closes every door, including one still opening (released when its open lands).
 */
export function followProjectDoors<C extends { readonly id: string }>(
  contexts: ProjectDoorContexts<C>,
  options: ProjectDoorsOptions<C>,
): { close(): void } {
  const doors = new Map<string, Door>();
  /** A door that closed while its open was in flight: the next door for that id waits for it, so a
   *  late listen from the old one can never race the new one for the same socket path. */
  const retiring = new Map<string, Promise<void>>();
  let stopped = false;

  const opened = (ctx: C): void => {
    if (stopped || ctx.id === options.bootProjectId || doors.has(ctx.id)) return;
    const door: Door = { closed: false, settled: Promise.resolve() };
    const before = retiring.get(ctx.id) ?? Promise.resolve();
    door.settled = before
      .then(() => (door.closed ? undefined : options.open(ctx)))
      .then(
        (handle) => {
          if (!handle) return;
          if (door.closed) {
            handle.close();
          } else {
            door.handle = handle;
            options.onOpened?.(ctx);
          }
        },
        // `open` reports its own failure; a throw past it is still one project without a door.
        () => undefined,
      );
    doors.set(ctx.id, door);
  };

  const disposed = (projectId: string): void => {
    const door = doors.get(projectId);
    if (!door) return;
    doors.delete(projectId);
    door.closed = true;
    door.handle?.close();
    door.handle = undefined;
    const settled = door.settled;
    retiring.set(projectId, settled);
    void settled.then(() => {
      if (retiring.get(projectId) === settled) retiring.delete(projectId);
    });
  };

  const offBuilt = contexts.onContextBuilt(opened);
  const offDisposed = contexts.onContextDisposed(disposed);
  // Contexts built before this attached still get their door.
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) opened(ctx);
  }

  return {
    close() {
      if (stopped) return;
      stopped = true;
      offBuilt();
      offDisposed();
      for (const id of [...doors.keys()]) disposed(id);
    },
  };
}
