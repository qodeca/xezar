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
    // "Connection status" (`SettingsField title="Connection status"`,
    // packages/web/src/routes/settings/mcp-connection-section.tsx) is a STATIC heading rendered
    // regardless of query state — waiting on it says nothing about whether the panel underneath
    // has settled (#579 round 3 re-read of the component: rounds 1-2 treated it as the thing to
    // wait for, but it was never the gate). The real gate is `McpLeaderControl`'s own loading
    // state (packages/web/src/routes/settings/mcp-leader-control.tsx): it renders
    // "Loading the leader connection…" (`role="status"`) until `useMcpLeader`'s `GET
    // /api/v1/mcp/leader` settles, then either the error branch or this panel. Waiting for that
    // role to clear — rather than jumping straight to the final sentence — turns "never appeared"
    // into two distinguishable failures: still loading (a real timeout) vs. loaded into a
    // different state (a real bug this suite would then have evidence for, not a wait-budget
    // question). #579 rounds 1-2 only ever saw the undifferentiated failure.
    await browser.waitForRole('heading', 'Connection status')
    await browser.waitForRoleGone('status', 'Loading the leader connection…', { attempts: 80 })
    // #579 round 3: the loading indicator clearing means `useMcpLeader`'s query left `isPending`,
    // not that it settled with data — a slow/loaded CI runner can flip it straight into
    // `isError && !leader.data` (McpLeaderControl's "Could not load the leader connection." branch)
    // on a first fetch, then resolve on react-query's background retry a few seconds later. Every
    // other data-dependent read below in this same file already carries the `{ attempts: 80 }`
    // (20s) CI-runner budget for exactly this reason (round 2 evidence); this read never got it.
    try {
      await browser.waitForText(
        'The MCP service is not running for this project, so there is no event delivery to report.',
        { attempts: 80 },
      )
    } catch (cause) {
      // Anchor the capture on the "Connection status" section itself, not the top of the page:
      // round 2's bare `bodyText().slice(0, 2000)` never reached this far down — the nav plus the
      // four full "One-time setup" client sections above it already exceed 2000 characters, so
      // every round-2 capture only ever showed page furniture, never the panel actually being read.
      const body = browser.bodyText()
      const anchor = body.indexOf('Connection status')
      const near = anchor === -1 ? body.slice(0, 2000) : body.slice(anchor, anchor + 2000)
      throw new Error(`xezar e2e: unattached-state text missing; page text near "Connection status" was: ${near}`, {
        cause,
      })
    }
    expect(browser.hasRole('button', 'Refresh')).toBe(true)
  })

  it('"What the leader can do" reflects this server\'s own reported capabilities, including the two that are off', async () => {
    const health = (await (
      await fetch(`${baseUrl}/api/v1/health`)
    ).json()) as { capabilities: { automations: boolean; followups: boolean } }
    expect(health.capabilities.automations).toBe(false)
    expect(health.capabilities.followups).toBe(false)

    await browser.waitForRole('heading', 'What the leader can do')
    await browser.waitForText('Why: GitHub automations are off on this xezar.', { attempts: 80 })
    expect(browser.hasText('GitHub automations')).toBe(true)
    await browser.waitForText('Why: The follow-up inbox is off for this workspace.', { attempts: 80 })
    expect(browser.hasText('Follow-up inbox')).toBe(true)
  })

  it('"Shared limits" repeats the same workspace resource defaults guide 11 verifies', async () => {
    // `useWorkspaceConfig` (`GET /api/workspace/config`, a plain config read) — cheap, but the
    // same loaded-CI-runner evidence as above applies (#579 round 2).
    //
    // The memory ceiling is read from the SAME live endpoint the page itself reads, never a
    // literal: `resources.memoryLimitMb` is `deriveDefaultMemoryLimitMb()`
    // (packages/xezar/src/workspace/config.ts), `floor(totalMiB * 0.6 / 2)` clamped to
    // `[1024, 8192]` off THIS HOST's own RAM — a hardcoded "8192 MiB" only matched a developer
    // machine with >= ~27 GB and was structurally unreachable on a 16 GB CI runner (#579 round 3
    // finding 2: `4915 MiB` there, never `8192 MiB`).
    const workspaceConfig = (await (
      await fetch(`${baseUrl}/api/v1/workspace/config`)
    ).json()) as { resources: { memoryLimitMb: number | null } }
    const memoryLimitMb = workspaceConfig.resources.memoryLimitMb
    if (typeof memoryLimitMb !== 'number' || memoryLimitMb <= 0) {
      throw new Error(`xezar e2e: expected a positive live memoryLimitMb, got ${String(memoryLimitMb)}`)
    }

    await browser.waitForRole('heading', 'Shared limits')
    await browser.waitForText('2 across all projects', { attempts: 80 })
    await browser.waitForText(`${memoryLimitMb} MiB`, { attempts: 80 })
    expect(browser.hasRole('link', 'See every tool this server exposes')).toBe(true)
  })
})
