import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 13 — MCP project leader (docs/guide/13-mcp-leader.md): the Settings → MCP connection page
 * this task worktree has no attached leader for, so the page is read exactly in its
 * "not connected yet" state — itself one of the guide's own named states (§ "To choose the
 * leader's role": Files prepared / Connected / Attached / Delivery verified — none implies the
 * next).
 *
 * Dry-run exception register: an actual client attaching, receiving a push and acknowledging it
 * is manual with a dated record (browser-test-spec.md's guide-13 row); this file asserts only the
 * page's own unattached-state text and the setup commands it prints for every client.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = GuideBrowser.open(`e2e-guide-13-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 13 — MCP project leader', () => {
  beforeAll(() => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/mcp-connection`)
  })

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

  it('reports the unattached state honestly — a real "no leader connected" reading, not a faked one', () => {
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

    expect(browser.hasRole('heading', 'What the leader can do')).toBe(true)
    expect(browser.hasText('GitHub automations')).toBe(true)
    expect(browser.hasText('Why: GitHub automations are off on this xezar.')).toBe(true)
    expect(browser.hasText('Follow-up inbox')).toBe(true)
    expect(browser.hasText('Why: The follow-up inbox is off for this workspace.')).toBe(true)
  })

  it('"Shared limits" repeats the same workspace resource defaults guide 11 verifies', () => {
    expect(browser.hasRole('heading', 'Shared limits')).toBe(true)
    expect(browser.hasText('2 across all projects')).toBe(true)
    expect(browser.hasText('8192 MiB')).toBe(true)
    expect(browser.hasRole('link', 'See every tool this server exposes')).toBe(true)
  })
})
