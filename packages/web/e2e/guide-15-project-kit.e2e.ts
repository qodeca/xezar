import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, readTestEnv } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 15 — Project kit (docs/guide/15-project-kit.md). Its one cockpit surface is Settings →
 * Project setup: guided setup's not-yet-run state, and the same `skillsRepos`-absent default the
 * guide's own table promises ("qodeca/xezar-skills", subject to personal skill selection).
 *
 * Dry-run exception register: writing `.xezar/workflows/fix-and-verify.yaml` and
 * `.xezar/skills/project-conventions.md`, and the collision guard when the kit path would be the
 * workspace home, are covered by `packages/xezar/src/init-kit.test.ts:12-52` and
 * `packages/xezar/src/project-kit-cli.test.ts:8-29` (`docs/testing/browser-dry-run-exceptions.md`, guide-15 row); running
 * the actual `xez-onboard-opinionated` guided-setup skill end to end is manual with a dated record, since it
 * depends on a real team-skills network fetch this dry-run fixture does not perform.
 *
 * The boot project is this repository's own checkout, which the 3.0.3 onboarding set up and whose
 * committed `.xezar/onboarding.json` therefore reads as a finished setup. The "not set up yet" case
 * runs against a throwaway empty repository registered through `POST /api/v1/projects` (and
 * removed through the real route after, as `project-switching.e2e.ts` does), so it keeps proving
 * what a genuinely unconfigured project sees.
 */

let browser: GuideBrowser
let baseUrl: string
let bootProject: string
let scratchDir: string
let unconfigured: string

/** An empty git repository with no `.xezar/` at all, registered through the product's own door. */
async function registerUnconfiguredProject(): Promise<string> {
  const root = join(scratchDir, 'unconfigured')
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=xezar e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed'],
    { stdio: 'ignore' },
  )
  const response = await fetch(`${baseUrl}/api/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  })
  if (response.status !== 200) throw new Error(`xezar e2e: POST /api/v1/projects for ${root} answered ${response.status}`)
  return ((await response.json()) as { project: { id: string } }).project.id
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  scratchDir = mkdtempSync(join(tmpdir(), 'xez-e2e-guide-15-'))
  unconfigured = await registerUnconfiguredProject()
  browser = GuideBrowser.open(`e2e-guide-15-${process.pid}`)
}, 60_000)

afterAll(async () => {
  browser?.close()
  if (unconfigured) await fetch(`${baseUrl}/api/v1/projects/${unconfigured}`, { method: 'DELETE' })
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true })
})

describe('guide 15 — project kit', () => {
  it('an unconfigured project offers guided setup rather than assuming one already ran', async () => {
    browser.goto(`${baseUrl}/p/${unconfigured}/settings/project-setup`)
    await browser.waitForRole('heading', 'Project setup')
    await browser.waitForRole('heading', 'Guided setup')

    expect(browser.hasRole('heading', 'Guided setup')).toBe(true)
    expect(browser.hasRole('heading', 'Not set up yet')).toBe(true)
    expect(browser.hasRole('button', 'Set up this project')).toBe(true)
  })

  it('a project the 3.0.3 onboarding finished reads as set up, without offering first-time setup', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/project-setup`)
    await browser.waitForRole('heading', 'Guided setup')
    await browser.waitForRole('button', 'Re-check now')

    expect(browser.hasRole('heading', 'Set up', { exact: true })).toBe(true)
    expect(browser.hasRole('heading', 'Not set up yet')).toBe(false)
    expect(browser.hasRole('button', 'Set up this project')).toBe(false)
    expect(browser.hasText('This project records a finished setup in its own files.')).toBe(true)
  })

  it('an absent skillsRepos keeps the default team-skills catalog visible on the Agents page', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/agents`)
    await browser.waitForRole('heading', 'Team skill repositories')
    expect(browser.valueOfRole('textbox', 'Team skill repositories')).toBe('qodeca/xezar-skills')
    // Guide 15's own table: an explicit list "hides Manage skills" — since nothing is explicit
    // here, the shared-catalog affordance stays.
    expect(browser.hasRole('button', 'Use the shared catalog')).toBe(true)
  })
})
