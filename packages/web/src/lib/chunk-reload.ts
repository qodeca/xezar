/**
 * Recovery for a tab that outlived an upgrade.
 *
 * Every lazy route (`routes.tsx`) is a separate, content-hashed file. After xezar is upgraded the
 * server serves the NEW build, so a tab opened before the upgrade asks for a file name that no
 * longer exists and the dynamic import fails. `React.lazy` caches that rejection, so the route
 * error boundary's Retry re-renders the same failure forever: only a fresh document, which reads
 * the new `index.html` and its new file names, recovers.
 *
 * Two pieces, both here so they share one guard:
 * - `installChunkReloadGuard` listens for Vite's `vite:preloadError` (dispatched for a failed
 *   preload AND a failed dynamic import) and reloads the page once.
 * - `isChunkLoadError` lets the error boundary tell the same failure apart, so its Retry reloads
 *   instead of re-rendering a cached rejection.
 *
 * The guard is a timestamp in `sessionStorage`: a second failure within `RELOAD_GUARD_MS` of the
 * last automatic reload is a real outage (the server is down, the file is genuinely missing), and
 * reloading again would loop. Storage can throw (a sandboxed frame, a privacy mode); without it no
 * guard can be kept, so no automatic reload happens and the boundary's Retry stays the way out.
 */

/** sessionStorage key holding the epoch-ms time of the last automatic reload. */
export const CHUNK_RELOAD_KEY = 'xez-chunk-reload-at'

/** A second automatic reload inside this window is refused – the first one did not help. */
export const RELOAD_GUARD_MS = 30_000

/** Message fragments the browsers use for a module file that could not be fetched or evaluated. */
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's own CSS preload rejection
]

/**
 * Whether an error is a failed lazy-chunk load rather than a bug in the page.
 *
 * @param error - Whatever the error boundary caught; non-errors are never chunk failures.
 * @returns `true` when the message matches a known chunk-load failure.
 *
 * @example
 * ```ts
 * isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/a.js')) // true
 * isChunkLoadError(new Error('Cannot read properties of undefined')) // false
 * ```
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))
}

/** The browser surface the guard touches; injectable so tests need not reload jsdom. */
export interface ChunkReloadEnv {
  /** Where `vite:preloadError` is dispatched. Default: `window`. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  /** Storage for the guard timestamp; a getter so a throwing `sessionStorage` access is caught. */
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
  /** Reloads the document. Default: `window.location.reload()`. */
  reload?: () => void
  /** Clock. Default: `Date.now`. */
  now?: () => number
}

/**
 * Reloads the page once when it is still within the guard, and records the attempt.
 *
 * @param env - Storage, reload and clock overrides (tests).
 * @returns `true` when a reload was started; `false` when the guard refused or storage is unusable.
 *
 * @example
 * ```ts
 * if (!reloadOnceForStaleChunk()) showTheErrorInstead()
 * ```
 */
export function reloadOnceForStaleChunk(env: ChunkReloadEnv = {}): boolean {
  const now = (env.now ?? Date.now)()
  try {
    const storage = (env.storage ?? (() => window.sessionStorage))()
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false
    storage.setItem(CHUNK_RELOAD_KEY, String(now))
  } catch {
    // No storage, no guard: an unguarded reload could loop, so leave recovery to Retry.
    return false
  }
  ;(env.reload ?? (() => window.location.reload()))()
  return true
}

/**
 * Installs the `vite:preloadError` listener that reloads a stale tab once.
 *
 * The event is not cancelled: the original error still reaches the route error boundary, which
 * shows the page-crashed state for the instant before the reload lands, or for good when the
 * guard refuses.
 *
 * @param env - Target, storage, reload and clock overrides (tests).
 * @returns A function that removes the listener.
 *
 * @example
 * ```ts
 * // main.tsx, before the first render
 * installChunkReloadGuard()
 * ```
 */
export function installChunkReloadGuard(env: ChunkReloadEnv = {}): () => void {
  const target = env.target ?? window
  const onPreloadError = () => {
    reloadOnceForStaleChunk(env)
  }
  target.addEventListener('vite:preloadError', onPreloadError)
  return () => target.removeEventListener('vite:preloadError', onPreloadError)
}
