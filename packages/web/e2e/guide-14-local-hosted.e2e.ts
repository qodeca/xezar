import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'
import { freePort, waitForHealth } from './fixture-server'

/**
 * Guide 14 — Remote access (docs/guide/14-remote-access.md), § "To choose local or hosted mode".
 * The shared suite server always runs local (`capabilities.localHandoff: true`), so hosted mode's
 * own visible behaviour — Agent config turning read-only — needs a second, spec-owned server
 * booted with `XEZ_REMOTE=1`, same per-spec boot pattern as `empty-states.e2e.ts`.
 *
 * Dry-run exception register: a real reverse proxy, TLS, non-loopback bind, service-manager
 * install/redeploy/uninstall and the request-origin guard's DNS-rebinding/CSRF checks are covered
 * by `packages/xezar/src/server/host-guard.test.ts`, `origin-guard.test.ts` and the
 * `server-install/platforms/*.test.ts` suite (`docs/testing/browser-dry-run-exceptions.md`, guide-14 row); a real hosted
 * installation lifecycle is manual with a dated record. This file asserts only the one
 * capability-driven UI difference a dry-run browser can honestly show.
 */

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-14-'))
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot, { XEZ_REMOTE: '1' }), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl, { label: 'hosted-mode fixture server' })
  bootProject = await bootProjectId(baseUrl)

  browser = GuideBrowser.open(`e2e-guide-14-${process.pid}`)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 14 — remote access', () => {
  it('XEZ_REMOTE=1 reports localHandoff:false, and Agent config visibly becomes read-only', async () => {
    const health = (await (await fetch(`${baseUrl}/api/v1/health`)).json()) as {
      capabilities: { localHandoff: boolean }
    }
    expect(health.capabilities.localHandoff).toBe(false)

    browser.goto(`${baseUrl}/p/${bootProject}/settings/agent-config`)
    await browser.waitForRole('heading', 'Agent config')
    expect(
      browser.hasText(
        'Read-only: agent config is edited from the machine that owns the checkout (this cockpit runs in hosted mode). You can still see every file and which one wins.',
      ),
    ).toBe(true)
    // The per-client tabs and files are still readable in hosted mode — only editing is refused.
    for (const tab of ['Claude', 'Codex', 'Qwen Code']) {
      expect(browser.hasRole('tab', tab)).toBe(true)
    }
  })

  it('has no built-in authentication banner and no GitHub tab without a real repository', async () => {
    // guide 14 § "To protect the public endpoint": "xezar has no built-in authentication." The
    // dataRoot here is not a Git repository, so the forge tab that guide 07 covers is absent —
    // the same "outside Git" degradation guide 01/03 describe, now observed under hosted mode.
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    await browser.waitForRole('link', 'Tasks')
    expect(browser.hasRole('link', 'GitHub')).toBe(false)
  })
})
