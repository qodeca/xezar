import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { activeStateLayout } from '../state-layout.ts';

/**
 * Hot reload for the workspace config file (#677 slice D1).
 *
 * `semaphore.refresh()` already makes every resource key live — but only when something calls it,
 * and until this module the only callers were the boot and the settings routes. Two writers never
 * reach a route: a person editing the file by hand, and a SECOND xezar process (another project's
 * `serve`, `xez projects`, a headless run) merge-writing the shared home. Both took effect only on
 * the next restart. This watches the file and calls `refresh()` when it changes, and that is the
 * whole job: nothing here needs its own error policy for the file's CONTENTS. `refresh()`'s own
 * `load()` never throws — a torn read (a hand edit caught mid-write) resolves to the
 * `config.json.bak` snapshot, or the schema defaults when that snapshot is also unusable, for one
 * debounce window, until the completing write's own event re-reads it. That is a real, if brief,
 * cache replacement, not a "keep the last good snapshot" no-op — only a THROWING `load` leaves the
 * previous cache untouched, and `loadWorkspaceConfig` is built not to throw.
 *
 * The rules it keeps, each pinned by `config-watcher.test.ts`:
 *
 * - **The path comes from the layout resolver**, never a `'.xezar'` join: `~/.xezar/config.json`
 *   (or `XEZ_HOME`) in the global layout, `<project>/.xezar/workspace.json` in single-project mode.
 * - **One write, one refresh.** A merge-write is a burst — the lock file, a per-writer tmp file
 *   renamed over the config, a `chmod`, then the same again for `config.json.bak` — and the
 *   rename plus the `chmod` alone report the config's own name twice. Events are coalesced over
 *   `CONFIG_WATCH_DEBOUNCE_MS` into one refresh.
 * - **Only the file's own name counts.** The DIRECTORY is watched (a rename replaces the inode, so
 *   a watch on the file itself goes deaf after the first atomic write), and every sibling is
 *   ignored by exact name: `config.json.lock`, its `.takeover` guard, the tmp files, the `.bak`
 *   snapshot, `agent-accounts.json`, `ui-state.json`. An event with no filename — some platforms
 *   do not report one — is treated as a possible change, because a missed reload is the failure
 *   this exists to close and a spare refresh costs one small read.
 * - **It never fails a boot and never holds a process open.** An unwatchable directory — missing,
 *   out of watch budget, `fs.watch` throwing, or a watcher that errors later — logs ONE warning
 *   and leaves the server exactly as it was before this module existed: live on the routes,
 *   restart for anything else. Both the watcher and the debounce timer are `unref`'d.
 */

/** How long a burst of events is coalesced before the one refresh. Judgement, not measurement. */
export const CONFIG_WATCH_DEBOUNCE_MS = 250;

/** The `fs.watch` seam — only the parts this module uses, so a stand-in is three methods. */
export interface ConfigDirWatcher {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  close(): void;
  unref?(): void;
}

/** Creates the watcher for one directory, calling `onEvent(filename)` per raw fs event. */
export type ConfigWatchFactory = (dir: string, onEvent: (filename: string | null) => void) => ConfigDirWatcher;

const nodeWatchFactory: ConfigWatchFactory = (dir, onEvent) =>
  watch(dir, { persistent: false }, (_event, filename) => onEvent(typeof filename === 'string' ? filename : null));

let watchFactory: ConfigWatchFactory = nodeWatchFactory;

/**
 * Test seam: replace the watcher this module creates, so a test delivers the raw fs event itself
 * instead of writing a file and waiting for the OS to report it. `fs.watch` announces nothing when
 * it is armed and macOS drops a write that lands during registration (#204), so a test awaiting a
 * real delivery can only fail on a deadline (#671). Pass `undefined` to restore `fs.watch`. Never
 * call this from product code.
 */
export function setConfigWatchFactory(factory: ConfigWatchFactory | undefined): void {
  watchFactory = factory ?? nodeWatchFactory;
}

export interface WorkspaceConfigWatcher {
  /** False when the watch degraded (the one warning was logged) or after `close()`. */
  readonly active: boolean;
  /** Stop watching and drop a pending refresh. Idempotent. */
  close(): void;
}

export interface WorkspaceConfigWatcherOptions {
  /** What a change calls. The semaphore in production — its `refresh()` and nothing else. */
  target: { refresh(): Promise<void> };
  /** The file to watch. Defaults to the active layout's workspace config, resolved once. */
  path?: string;
  debounceMs?: number;
  /** Where the one degradation warning goes. */
  warn?: (message: string) => void;
}

/** Start watching the workspace config file. Never throws. */
export function startWorkspaceConfigWatcher(options: WorkspaceConfigWatcherOptions): WorkspaceConfigWatcher {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const debounceMs = options.debounceMs ?? CONFIG_WATCH_DEBOUNCE_MS;
  let path: string;
  try {
    path = options.path ?? activeStateLayout().workspacePath;
  } catch (err) {
    warn(`[xez] workspace config watch unavailable (${describe(err)}) — config edits outside the cockpit apply on restart`);
    return { active: false, close: () => {} };
  }
  const name = basename(path);
  let watcher: ConfigDirWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const close = (): void => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const current = watcher;
    watcher = undefined;
    try {
      current?.close();
    } catch {
      // already gone
    }
  };

  const degrade = (err: unknown): void => {
    if (closed) return;
    close();
    warn(
      `[xez] workspace config watch unavailable for ${path} (${describe(err)}) — ` +
        'edits made outside the cockpit apply on restart',
    );
  };

  const onEvent = (filename: string | null): void => {
    if (closed) return;
    if (filename !== null && basename(filename) !== name) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      void options.target.refresh().catch(() => undefined);
    }, debounceMs);
    timer.unref();
  };

  try {
    watcher = watchFactory(dirname(path), onEvent);
    watcher.unref?.();
    watcher.on('error', degrade);
  } catch (err) {
    degrade(err);
  }

  return {
    get active() {
      return !closed && watcher !== undefined;
    },
    close,
  };
}

function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return err instanceof Error ? err.message : String(err);
}
