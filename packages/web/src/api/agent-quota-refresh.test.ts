import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentQuotaRefreshInput } from '@qodeca/xezar-api-client'

import { ApiError, refreshAgentQuota } from './client'

/**
 * The Refresh action's request (#867 S5, review round 1 on #889, Major 3).
 *
 * The body is the contract's `AgentQuotaRefreshInput` — the strict POST selector — and not the
 * GET route's `AgentQuotaQuery`, which also permits the read-only `wait` key the refresh route
 * rejects. That half is a COMPILE-time guarantee: `npm run typecheck` runs over this file, and the
 * `@ts-expect-error` below is itself an error the day the helper widens back to the query type.
 */

const ANSWER = { schemaVersion: 1, scope: 'agent-quota', generatedAt: '2026-09-22T14:24:00Z', accounts: [] }

afterEach(() => vi.unstubAllGlobals())

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown; contentType: string | null }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://cockpit.test'), init)
      calls.push({
        url: new URL(request.url).pathname,
        method: request.method,
        body: await request.clone().json(),
        contentType: request.headers.get('content-type'),
      })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }),
  )
  return calls
}

describe('refreshAgentQuota', () => {
  it('takes the contract refresh selector and never the GET-only wait key', () => {
    const typed: (input: AgentQuotaRefreshInput) => Promise<unknown> = refreshAgentQuota
    expect(typed).toBe(refreshAgentQuota)
    // Never invoked: the assertion is the compiler's.
    const neverCalled = () =>
      // @ts-expect-error — `wait` belongs to GET /workspace/agent-quota, not to the refresh body.
      refreshAgentQuota({ wait: 'true' })
    expect(typeof neverCalled).toBe('function')
  })

  it('posts the selector as JSON to the refresh route and returns the validated answer', async () => {
    const calls = stub(200, ANSWER)
    await expect(refreshAgentQuota({ provider: 'claude', accountId: 'default' })).resolves.toEqual(ANSWER)
    expect(calls).toEqual([
      {
        url: '/api/v1/workspace/agent-quota/refresh',
        method: 'POST',
        body: { provider: 'claude', accountId: 'default' },
        contentType: expect.stringContaining('application/json'),
      },
    ])
  })

  it('surfaces the server’s refusal as an ApiError with its own words', async () => {
    stub(404, { error: 'unknown account: gone' })
    const error = await refreshAgentQuota({ provider: 'claude', accountId: 'gone' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toContain('unknown account: gone')
  })

  it('refuses an answer that is not the contract’s', async () => {
    stub(200, { ...ANSWER, schemaVersion: 2 })
    await expect(refreshAgentQuota({})).rejects.toThrow(/unexpected body/)
  })
})
