import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 07 — GitHub and automations (docs/guide/07-github-and-automations.md): handing an issue
 * to an agent, drafting a new issue, and an automation's create → enable → log lifecycle.
 *
 * `github.e2e.ts` and `automations.e2e.ts` already cover this ground over the shared server with
 * `AgentBrowser`'s CSS/`data-slot` selectors — nav gating, the issue/PR lists, the merge box, the
 * PR diff, and the full automation preview/enable/log round trip. This file re-asserts the same
 * two headline flows through role/label/text locators only, plus one flow neither existing file
 * drives: the New-issue draft dialog's own submit-readiness gate. `settings-bookmarklets.e2e.ts`
 * covers the bookmarklet launcher separately.
 *
 * Dry-run exception register (browser-test-spec.md § Dry-run exception register, row "07"): real
 * GitHub authentication, remote issue/PR mutation and bookmarklet execution on github.com are out
 * of scope — `packages/xezar/src/server/forge/github.test.ts` covers the request seam this file's
 * fixture reuses (the bundled dry-run mock issues/PRs). This file starts no draft and creates no
 * real GitHub content; it asserts only the scripted forge seam's own visible UI.
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
  throw new Error(`xezar e2e: the guide-07 fixture server never answered at ${url}`)
}

async function api<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`)
  if (!response.ok) throw new Error(`xezar e2e: GET ${path} answered ${response.status}`)
  return (await response.json()) as T
}

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
let issueNumber: number
let issueTitle: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-07-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'guide-07@xezar.test')
  git('config', 'user.name', 'xezar guide-07')
  git('commit', '-q', '--allow-empty', '-m', 'seed')

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot, { XEZ_AUTOMATIONS: '1' }), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  const gh = await api<{ available: boolean; issues: Array<{ number: number; title: string }> }>(
    baseUrl,
    `/api/v1/p/${bootProject}/github`,
  )
  if (!gh.available || !gh.issues[0]) throw new Error('xezar e2e: the dry-run forge served no issues')
  issueNumber = gh.issues[0].number
  issueTitle = gh.issues[0].title

  browser = GuideBrowser.open(`e2e-guide-07-${process.pid}`)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 07 — GitHub and automations', () => {
  it('an issue\'s hand-off panel is pre-filled and names the agent action', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/github/issues/${issueNumber}`)
    await browser.waitForRole('heading', issueTitle)
    await browser.waitForRole('heading', 'HAND THIS TO THE AGENT')
    expect(browser.textOfRole('textbox', 'Custom prompt')).toContain(`Fix GitHub issue #${issueNumber}`)
    expect(browser.hasRole('button', 'Run agent on this issue')).toBe(true)
  })

  it('New issue only allows drafting once the problem is described', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/github`)
    await browser.waitForRole('button', 'New issue')
    browser.clickRole('button', 'New issue')
    await browser.waitForRole('heading', 'New issue')
    expect(browser.isDisabled('button', 'Start drafting')).toBe(true)

    browser.fillLabel('What is the problem or the request?', 'The release notes mention a removed flag')
    expect(browser.isDisabled('button', 'Start drafting')).toBe(false)
    browser.clickRole('button', 'Cancel')
    await browser.waitForRoleGone('heading', 'New issue')
  })

  it('an automation goes from Paused to Enabled and exposes its own execution log', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    await browser.waitForRole('heading', 'New automation')
    browser.fillLabel('Name', 'Guide 07 triage')
    browser.clickRole('button', 'Save automation')

    await browser.waitForRole('heading', 'Guide 07 triage')
    expect(browser.hasText('Paused')).toBe(true)
    browser.clickRole('button', 'Enable')
    await browser.waitForText('Enabled')

    browser.clickRole('link', 'View log')
    await browser.waitForRole('heading', 'Execution log')
    expect(browser.hasRole('link', 'Back to automations')).toBe(true)
  })
})
