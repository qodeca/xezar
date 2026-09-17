import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 13 — MCP project leader (docs/guide/13-mcp-leader.md): the Settings → MCP connection page
 * read in its "not connected yet" state — itself one of the guide's own named states (§ "To choose
 * the leader's role": Files prepared / Connected / Attached / Delivery verified — none implies the
 * next).
 *
 * This needs its OWN spec-owned server rather than the shared suite instance: `mcp-live-sync.e2e.ts`
 * and `mcp-collaboration.e2e.ts` attach a real leader to the shared project, and once one of them
 * has run, the shared server is no longer in the unattached state this file reads — a real
 * isolation bug this file itself shipped with, caught by running the whole suite in shuffled order
 * (browser-test-spec.md § Isolation rule, Proof 2) rather than only in the suite's default,
 * alphabetical one.
 *
 * Dry-run exception register: an actual client attaching, receiving a push and acknowledging it is
 * manual with a dated record (browser-test-spec.md's guide-13 row); this file asserts only the
 * page's own unattached-state text and the setup commands it prints for every client.
 */

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`xezar e2e: the guide-13 fixture server never answered at ${url}`)
}

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-13-'))
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = GuideBrowser.open(`e2e-guide-13-${process.pid}`)
  browser.goto(`${baseUrl}/p/${bootProject}/settings/mcp-connection`)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 13 — MCP project leader', () => {
  it('names local-only scope and every client\'s one-time setup section', async () => {
    await browser.waitForRole('heading', 'Bound project')
    expect(browser.hasRole('heading', 'Local-only scope')).toBe(true)
    expect(browser.hasText('This xezar is running locally, so the MCP connection is available for this project.')).toBe(true)

    expect(browser.hasRole('heading', 'One-time setup')).toBe(true)
    for (const client of ['Claude Code', 'Codex', 'OpenCode', 'pi']) {
      expect(browser.hasRole('heading', client)).toBe(true)
    }
    // The exact one-time commands guide 13 itself gives per client.
    expect(browser.hasText('claude mcp add --scope local xezar -- npx -y @qodeca/xezar mcp')).toBe(true)
    expect(browser.hasText('codex app-server --listen unix://')).toBe(true)
    expect(browser.hasText('pi install npm:pi-mcp-adapter@2.32.1')).toBe(true)
  })

  it('reports the unattached state honestly — a real "no leader connected" reading, not a faked one', async () => {
    await browser.waitForRole('heading', 'Connection status')
    expect(browser.hasRole('heading', 'Connection status')).toBe(true)
    expect(browser.hasText('The MCP service is not running for this project, so there is no event delivery to report.')).toBe(true)
    expect(browser.hasRole('button', 'Refresh')).toBe(true)
  })

  it('"What the leader can do" reflects this server\'s own reported capabilities, including the two that are off', async () => {
    const health = (await (
      await fetch(`${baseUrl}/api/v1/health`)
    ).json()) as { capabilities: { automations: boolean; followups: boolean } }
    expect(health.capabilities.automations).toBe(false)
    expect(health.capabilities.followups).toBe(false)

    await browser.waitForRole('heading', 'What the leader can do')
    expect(browser.hasRole('heading', 'What the leader can do')).toBe(true)
    expect(browser.hasText('GitHub automations')).toBe(true)
    expect(browser.hasText('Why: GitHub automations are off on this xezar.')).toBe(true)
    expect(browser.hasText('Follow-up inbox')).toBe(true)
    expect(browser.hasText('Why: The follow-up inbox is off for this workspace.')).toBe(true)
  })

  it('"Shared limits" repeats the same workspace resource defaults guide 11 verifies', async () => {
    await browser.waitForRole('heading', 'Shared limits')
    expect(browser.hasRole('heading', 'Shared limits')).toBe(true)
    expect(browser.hasText('2 across all projects')).toBe(true)
    expect(browser.hasText('8192 MiB')).toBe(true)
    expect(browser.hasRole('link', 'See every tool this server exposes')).toBe(true)
  })
})
