import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 01 — Getting started (docs/guide/01-getting-started.md): the guided-setup entry a
 * first-time reader sees before their first task, on a project nothing has checked yet.
 *
 * `new-task.e2e.ts` already proves the composer-to-thread journey (§ "To start your first task")
 * and `empty-states.e2e.ts` already proves the plain "No tasks yet" hero. This file's marginal
 * value is the guided-setup surfaces those two do not touch: the Tasks-page setup aside and the
 * Settings → Project setup card, both in their "never checked" state, plus the one live click that
 * proves the button really does start an ordinary task rather than only rendering a label.
 *
 * Dry-run exception register (browser-test-spec.md § Dry-run exception register, row "01"):
 * package installation, upgrade, reset, and a real binary launch are covered by
 * `packages/xezar/test/e2e/package-cli.test.ts` and `packages/xezar/src/pack-check.test.ts`. This
 * file asserts only the resulting cockpit state over the bundled dry-run agent.
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
  throw new Error(`xezar e2e: the guide-01 fixture server never answered at ${url}`)
}

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-01-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'guide-01@xezar.test')
  git('config', 'user.name', 'xezar guide-01')
  git('commit', '-q', '--allow-empty', '-m', 'seed')

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = GuideBrowser.open(`e2e-guide-01-${process.pid}`)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 01 — getting started', () => {
  it('a project nothing has checked offers guided setup on the empty Tasks hero', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    await browser.waitForRole('heading', 'No tasks yet')
    // The setup aside renders only once `useOnboarding` resolves — a separate, later fetch from
    // the one the empty-hero heading itself waits on.
    await browser.waitForRole('button', 'Set up this project')
    expect(browser.hasText(
      'New to this project? An agent can look at it and prepare the files it needs, and it shows you every change before anything is written.',
    )).toBe(true)
    expect(browser.hasRole('link', 'New task')).toBe(true)
  })

  it('Settings → Project setup names the same never-checked state with its own identities', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/project-setup`)
    await browser.waitForRole('heading', 'Not set up yet')
    expect(browser.hasText(
      'No setup has been recorded for this project. You can still create ordinary tasks — setup is optional, and it is never required to start work.',
    )).toBe(true)
    expect(browser.hasRole('button', 'Set up this project')).toBe(true)
    expect(browser.hasText('Last observed')).toBe(true)
    expect(browser.hasText('Last offered')).toBe(true)
    expect(browser.hasText('Last successfully checked')).toBe(true)
  })

  it('choosing Set up this project starts an ordinary task and lands in its own thread', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/project-setup`)
    await browser.waitForRole('button', 'Set up this project')
    browser.clickRole('button', 'Set up this project')

    let landed = false
    for (let attempt = 0; attempt < 40 && !landed; attempt += 1) {
      landed = /\/tasks\/[^/]+$/.test(browser.url())
      if (!landed) browser.pause(250)
    }
    expect(landed, `xezar e2e: expected a task thread URL, got ${browser.url()}`).toBe(true)

    // The started task is an ordinary run: it appears back on the Tasks list like any other,
    // which replaces the empty hero this same file asserted in the first test.
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    await browser.waitForRoleGone('heading', 'No tasks yet')
  })
})
