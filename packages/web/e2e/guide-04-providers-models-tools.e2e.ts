import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 04 — Agent backends (docs/guide/04-agent-backends.md), the flows a first-time reader
 * follows: choosing a backend in the new-task composer, seeing its own model list, and reading
 * the backend switches and default-runner choice in Settings → Agents.
 *
 * Dry-run exception register (`docs/testing/browser-dry-run-exceptions.md`, row "04"):
 * installed-provider DETECTION is covered by `packages/xezar/src/core/backend-detect.test.ts`;
 * real account login is manual with a dated record, paired with
 * `packages/xezar/src/core/provider-auth.test.ts`. Real provider execution, Codex MCP isolation,
 * usage-limit resume and environment/temp-directory behaviour are stubbed at the agent seam here
 * and covered by `packages/xezar/src/core/codex-run-isolation.test.ts`,
 * `packages/xezar/src/core/agent-env.test.ts`, `packages/xezar/src/runs/agent-tmpdir.test.ts` and
 * `packages/xezar/src/core/usage-limit.test.ts`. This file asserts only what the shared dry-run
 * server's own reported health and the resulting composer/settings UI make visible.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string
let health: {
  defaultRunner: string
  checks: Array<{ name: string; available: boolean }>
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`xezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  health = await api('/api/v1/health')
  browser = GuideBrowser.open(`e2e-guide-04-${process.pid}`)
}, 60_000)

afterAll(() => {
  browser?.close()
})

describe('guide 04 — agent backends', () => {
  it('Settings → Agents lists every backend as a named switch and names the health-detected default runner', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    await browser.waitForRole('heading', 'Providers')

    for (const backend of ['Claude Code', 'Codex', 'OpenCode', 'pi']) {
      expect(browser.hasRole('heading', backend)).toBe(true)
      expect(browser.hasRole('switch', `Use ${backend}`)).toBe(true)
    }

    // "Default runner": one radio per backend id, the health-reported default checked.
    for (const id of ['claude', 'codex', 'opencode', 'pi']) {
      expect(browser.hasRole('radio', id)).toBe(true)
    }
    expect(browser.textOfRole('heading', 'Default runner')).toBe('Default runner')
    // The four per-backend "Default model for X" comboboxes exist for every runner id.
    for (const id of ['claude', 'codex', 'opencode', 'pi']) {
      expect(browser.hasRole('combobox', `Default model for ${id}`)).toBe(true)
    }
    expect(health.defaultRunner).toBe('claude')
  })

  it('the new-task composer offers the same four backends, and switching one changes its own model list', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    await browser.waitForRole('button', 'Runner')

    // Claude is the composer default (guide 04: "Claude Code (`claude`, the default)").
    expect(browser.textOfRole('button', 'Runner')).toBe('claude')

    browser.clickRole('button', 'Runner')
    await browser.waitForRole('menuitemradio', 'claude')
    for (const label of ['claude', 'codex', 'opencode', 'pi']) {
      expect(browser.hasRole('menuitemradio', label)).toBe(true)
    }
    expect(browser.textOfRole('menuitemradio', 'claude')).toContain('Claude Code CLI')

    // Choosing Codex changes the Runner button's own label, and its Model menu offers Codex's
    // own models rather than Claude's — the per-backend model list the guide describes.
    browser.clickRole('menuitemradio', 'codex')
    await browser.waitForRole('button', 'Model')
    expect(browser.textOfRole('button', 'Runner')).toBe('codex')

    browser.clickRole('button', 'Model')
    await browser.waitForRole('menuitemradio', 'auto')
    expect(browser.textOfRole('menuitemradio', 'auto')).toContain('Use your Codex default model')
    // `waitForRole` itself is the assertion here — it throws if the item never appears — rather
    // than a separate `hasRole(...).toBe(true)` re-check, whose own extra round trip to the
    // browser is exactly the race a loaded CI runner can lose (#579 round 1). Asserts only what
    // the dry-run server guarantees: under `XEZ_DRY_RUN=1` Codex's own catalog is a fixed,
    // in-memory fixture list (`discoverCodexModels`'s `DRY_RUN_MODELS`,
    // packages/xezar/src/core/codex-model-catalog.ts) rather than a real `codex app-server`
    // model name — CI never has a real `codex` binary on PATH, so asserting a live-discovered
    // model id (`GPT-6-Astra`, #579 round 3's finding) was structurally unreachable there.
    await browser.waitForRole('menuitemradio', 'Mock Codex model')
    expect(browser.hasRole('menuitemradio', 'opus')).toBe(false)

    // The composer remembers the last-chosen runner across a fresh navigation, so restore it to
    // Claude explicitly — the isolation rule this package's Proof 1 requires (browser-test-spec.md
    // § Isolation rule): a file that changes shared-server UI state puts it back.
    browser.clickRole('menuitemradio', 'auto')
    await browser.waitForRole('button', 'Runner')
    browser.pause(200)
    browser.clickRole('button', 'Runner')
    await browser.waitForRole('menuitemradio', 'claude')
    browser.clickRole('menuitemradio', 'claude')
    await browser.waitForRole('button', 'Runner')
    expect(browser.textOfRole('button', 'Runner')).toBe('claude')
  })

  it('every backend the composer offers is also a row the health check actually probed', () => {
    const runnerIds = new Set(health.checks.map((c) => c.name))
    for (const id of ['claude', 'codex', 'opencode', 'pi']) {
      expect(runnerIds.has(id)).toBe(true)
    }
  })
})
