import { describe, expect, it, vi } from 'vitest'

import {
  CHUNK_RELOAD_KEY,
  RELOAD_GUARD_MS,
  installChunkReloadGuard,
  isChunkLoadError,
  reloadOnceForStaleChunk,
} from './chunk-reload'

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  }
}

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: http://x/assets/task-thread-abc.js',
    'error loading dynamically imported module: http://x/assets/a.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/a.css',
  ])('recognises %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true)
  })

  it('leaves ordinary page bugs and non-errors alone', () => {
    expect(isChunkLoadError(new Error('route failed'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('reloadOnceForStaleChunk', () => {
  it('reloads once and records the time', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    expect(reloadOnceForStaleChunk({ storage: () => storage, reload, now: () => 1_000_000 })).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.map.get(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('refuses a second reload inside the guard window, so a real outage cannot loop', () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: '1000000' })
    const reload = vi.fn()
    expect(
      reloadOnceForStaleChunk({ storage: () => storage, reload, now: () => 1_000_000 + RELOAD_GUARD_MS - 1 }),
    ).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads again for a later upgrade once the window has passed', () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: '1000000' })
    const reload = vi.fn()
    expect(
      reloadOnceForStaleChunk({ storage: () => storage, reload, now: () => 1_000_000 + RELOAD_GUARD_MS }),
    ).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when storage throws: without a guard a reload could loop', () => {
    const reload = vi.fn()
    const blocked = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(reloadOnceForStaleChunk({ storage: blocked, reload })).toBe(false)
    const setThrows = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(reloadOnceForStaleChunk({ storage: () => setThrows, reload })).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('installChunkReloadGuard', () => {
  it('reloads on vite:preloadError without cancelling it, and uninstalls cleanly', () => {
    const target = new EventTarget()
    const storage = memoryStorage()
    const reload = vi.fn()
    const uninstall = installChunkReloadGuard({
      target: target as unknown as Window,
      storage: () => storage,
      reload,
      now: () => 5_000_000,
    })
    const event = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(event)
    expect(reload).toHaveBeenCalledTimes(1)
    // The original error still reaches the route boundary.
    expect(event.defaultPrevented).toBe(false)
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    expect(reload).toHaveBeenCalledTimes(1) // guarded
    uninstall()
    storage.map.clear()
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
