import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 08 — Inbox, notifications and templates (docs/guide/08-inbox-notifications-templates.md):
 * the disabled-by-default message, and — once opted in — a runnable follow-up's own Run/Dismiss
 * actions beside a note-only item's Acknowledge, plus the per-item instructions box.
 *
 * `inbox.e2e.ts` already covers this ground against the SHARED server with `data-action` CSS
 * selectors, conditionally skipping its enabled-path cases unless that shared instance opted in.
 * This file boots its own always-on fixture instead, so both the disabled and the enabled states
 * run unconditionally, through role/label/text locators only.
 *
 * Dry-run exception register (browser-test-spec.md § Dry-run exception register, row "08"):
 * browser/OS notification permission and delivery are manual with a dated record, paired with
 * `packages/web/src/components/run-notifications.test.tsx` and
 * `packages/web/src/lib/notifications.test.ts`. This file never requests real notification
 * permission — only the dry-run-honest inbox list itself.
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
  throw new Error(`xezar e2e: the guide-08 fixture server never answered at ${url}`)
}

async function bootFixture(followups: boolean, tag: string): Promise<{
  server: ChildProcess
  dataRoot: string
  baseUrl: string
  bootProject: string
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), `xezar-e2e-guide-08-${tag}-`))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'guide-08@xezar.test')
  git('config', 'user.name', 'xezar guide-08')
  if (followups) {
    mkdirSync(join(dataRoot, '.local/xezar'), { recursive: true })
    writeFileSync(
      join(dataRoot, '.local/xezar/todos.json'),
      JSON.stringify(
        [
          { id: 'guide-08-run', summary: 'Add a regression test for the flaky parser', action: 'follow-up' },
          { id: 'guide-08-note', summary: 'The release notes mention a removed flag', action: 'note' },
        ],
        null,
        2,
      ),
    )
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot, followups ? { XEZ_FOLLOWUPS: '1' } : {}), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  const bootProject = await bootProjectId(baseUrl)
  return { server, dataRoot, baseUrl, bootProject }
}

describe('guide 08 — inbox, disabled by default', () => {
  let browser: GuideBrowser
  let server: ChildProcess
  let dataRoot: string
  let baseUrl: string
  let bootProject: string

  beforeAll(async () => {
    ;({ server, dataRoot, baseUrl, bootProject } = await bootFixture(false, 'off'))
    browser = GuideBrowser.open(`e2e-guide-08-off-${process.pid}`)
  }, 90_000)

  afterAll(async () => {
    browser?.close()
    await stopFixtureServer(server)
    await removeDataRoot(dataRoot)
  })

  it('names the off state and that per-task Notes still run', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/inbox`)
    await browser.waitForRole('heading', 'The follow-up inbox is off')
    expect(browser.hasText('Disabled for this server; per-task Notes still run.')).toBe(true)
  })
})

describe('guide 08 — inbox, opted in', () => {
  let browser: GuideBrowser
  let server: ChildProcess
  let dataRoot: string
  let baseUrl: string
  let bootProject: string

  beforeAll(async () => {
    ;({ server, dataRoot, baseUrl, bootProject } = await bootFixture(true, 'on'))
    browser = GuideBrowser.open(`e2e-guide-08-on-${process.pid}`)
  }, 90_000)

  afterAll(async () => {
    browser?.close()
    await stopFixtureServer(server)
    await removeDataRoot(dataRoot)
  })

  it('a runnable follow-up offers Run/Dismiss and its own instructions box, beside a note-only Acknowledge', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/inbox`)
    await browser.waitForRole('heading', 'Inbox')
    expect(browser.hasText('Add a regression test for the flaky parser')).toBe(true)
    expect(browser.hasRole('button', 'Run')).toBe(true)
    expect(browser.hasRole('button', 'Dismiss')).toBe(true)
    expect(browser.hasText('The release notes mention a removed flag')).toBe(true)
    expect(browser.hasRole('button', 'Acknowledge')).toBe(true)

    browser.clickRole('button', '+ Add instructions')
    await browser.waitForRole('textbox', 'Extra instructions for this follow-up')
  })

  it('Dismiss and Acknowledge each remove their own item, down to nothing left', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/inbox`)
    await browser.waitForRole('button', 'Dismiss')
    browser.clickRole('button', 'Dismiss')
    await browser.waitForRoleGone('button', 'Dismiss')
    expect(browser.hasRole('button', 'Acknowledge')).toBe(true)

    browser.clickRole('button', 'Acknowledge')
    await browser.waitForRoleGone('button', 'Acknowledge')
  })
})
