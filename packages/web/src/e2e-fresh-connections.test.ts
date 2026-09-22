import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The browser suite's spec-side HTTP never reuses a socket (#671).
 *
 * Each spec process blocks its event loop in synchronous agent-browser calls between its own
 * `fetch`es, and a pooled keep-alive socket the server closed during that block was sent the
 * next request: `fetch failed` → `other side closed` (`UND_ERR_SOCKET`) across 7–15 files per CI
 * run once the runners moved to Node 24.21.0. `packages/web/e2e/fresh-connections.ts` makes
 * every request open its own connection instead. What makes that timing-free is observable
 * without any timing at all — the server sees `connection: close` on every request, and every
 * request arrive on its own socket — so that is what this pins. It lives here rather than
 * beside the specs for the reason `e2e-file-parallelism.test.ts` gives: `npm test` collects
 * `src/**` only, and the guarantee must hold in the fast gate.
 */
describe('the e2e spec process opens a fresh connection per request', () => {
  let server: Server
  let url: string
  let seen: { connection: string | undefined; port: number | undefined }[]
  let saved: Dispatcher

  beforeEach(async () => {
    saved = getGlobalDispatcher()
    seen = []
    server = createServer((request, response) => {
      seen.push({ connection: request.headers.connection, port: request.socket.remotePort })
      response.end('ok')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    vi.resetModules()
  })

  afterEach(async () => {
    setGlobalDispatcher(saved)
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })

  async function threeSequentialFetches(): Promise<void> {
    for (let n = 0; n < 3; n += 1) await (await fetch(url)).text()
  }

  it('the suite config loads the setup file that installs it', async () => {
    const config = (await import('../e2e/vitest.config')).default as { test?: { setupFiles?: string[] } }

    expect(config.test?.setupFiles).toContain('./fresh-connections.setup.ts')
  })

  it('after the setup file runs, every request asks to close and arrives on its own socket', async () => {
    await import('../e2e/fresh-connections.setup')

    await threeSequentialFetches()

    expect(seen.map((request) => request.connection)).toEqual(['close', 'close', 'close'])
    expect(new Set(seen.map((request) => request.port)).size).toBe(3)
  })
})
