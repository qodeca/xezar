import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 06 — Skills (docs/guide/06-skills.md): browsing the catalog, opening a skill's own
 * detail, and the global auto-update switch.
 *
 * `settings-skills.e2e.ts`, `skill-search-ranking.e2e.ts` and `skills-update.e2e.ts` already
 * cover, with `data-slot`/`data-action` CSS selectors: seeded-skill ordering and scroll position,
 * the #484 search-ranking regression, and the auto-update override round trip plus the dry-run
 * apply/upgrade-notes flow. This file re-asserts the catalog's own browse-and-open journey and
 * the auto-update switch's presence through role/label/text locators, without repeating any of
 * those three regressions. It seeds only its OWN project skill — the wider default team-skills
 * catalog depends on a machine-local cache this suite's isolated `HOME`/`XEZ_HOME` may or may not
 * carry, so nothing here depends on any `xez-*` skill being present.
 *
 * The "Manage skills" catalog-selection panel and the old `open-mercato/skills` migration notice
 * are not exercised: both depend on the default team-skills source resolving over the network,
 * which a dry-run, `XEZ_SKILLS_AUTO_UPDATE=0` fixture must not require.
 */

const SKILL = 'guide-06-skill'

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
  throw new Error(`xezar e2e: the guide-06 fixture server never answered at ${url}`)
}

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-06-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'guide-06@xezar.test')
  git('config', 'user.name', 'xezar guide-06')
  mkdirSync(join(dataRoot, '.xezar/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, `.xezar/skills/${SKILL}.md`),
    `---\nname: ${SKILL}\ndescription: A project skill for the guide-06 catalog probe.\n---\n\n# ${SKILL}\n\nFollow the steps.\n`,
  )
  git('add', '.')
  git('commit', '-q', '-m', 'seed')

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = GuideBrowser.open(`e2e-guide-06-${process.pid}`)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 06 — skills', () => {
  it('the catalog opens a project skill\'s own markdown detail, and Refresh leaves it intact', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/skills`)
    await browser.waitForRole('heading', 'Skills')
    await browser.waitForRole('link', SKILL)
    expect(browser.hasRole('textbox', 'Filter skills')).toBe(true)

    browser.clickRole('link', SKILL, { exact: false })
    await browser.waitForRole('heading', SKILL)

    browser.clickRole('button', 'Refresh')
    await browser.waitForRole('link', SKILL)
  })

  it('Global settings names the tracked auto-update switch', async () => {
    browser.goto(`${baseUrl}/settings/global/skills`)
    await browser.waitForRole('heading', 'Update xezar-skills automatically')
    expect(browser.hasRole('switch', 'Update xezar-skills automatically')).toBe(true)
  })
})
