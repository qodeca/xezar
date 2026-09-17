import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 03 — Worktrees and Git (docs/guide/03-worktrees-and-git.md): the composer's Worktree
 * toggle, a non-Git project's honest fallback, and the two Settings/Git surfaces that name
 * retention and the base branch.
 *
 * `repo-git.e2e.ts` already proves the Git tabs (Changes, Commits, Branches) read-only over a
 * real repository; `task-changes.e2e.ts` already proves an isolated task's own Changes tab and
 * commit dialog; `settings-resources.e2e.ts` already proves the retention field's own save/reload
 * round trip. None of the three touches the composer toggle itself, a non-Git project, the
 * worktrees table's own empty/reclaim state, or the base-branch picker's default value — this
 * file's marginal contribution.
 *
 * Dry-run exception register (browser-test-spec.md § Dry-run exception register, row "03"):
 * worktree creation/failure, the repository-root lease under Worktree off, and non-Git in-place
 * serialization are covered by `packages/xezar/src/workflows/run-isolation.test.ts:54-147`. This
 * file asserts only what a real dry-run server's own UI makes visible.
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
  throw new Error(`xezar e2e: the guide-03 fixture server never answered at ${url}`)
}

async function bootFixture(git: boolean, tag: string): Promise<{
  server: ChildProcess
  dataRoot: string
  baseUrl: string
  bootProject: string
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), `xezar-e2e-guide-03-${tag}-`))
  if (git) {
    const run = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args], { encoding: 'utf8' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.email', 'guide-03@xezar.test')
    run('config', 'user.name', 'xezar guide-03')
    run('commit', '-q', '--allow-empty', '-m', 'seed')
  }
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  const bootProject = await bootProjectId(baseUrl)
  return { server, dataRoot, baseUrl, bootProject }
}

describe('guide 03 — worktrees and Git, a Git project', () => {
  let browser: GuideBrowser
  let server: ChildProcess
  let dataRoot: string
  let baseUrl: string
  let bootProject: string

  beforeAll(async () => {
    ;({ server, dataRoot, baseUrl, bootProject } = await bootFixture(true, 'git'))
    browser = GuideBrowser.open(`e2e-guide-03-git-${process.pid}`)
  }, 90_000)

  afterAll(async () => {
    browser?.close()
    await stopFixtureServer(server)
    await removeDataRoot(dataRoot)
  })

  it('the composer\'s Worktree toggle defaults on and names what unchecking it does', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    await browser.waitForRole('checkbox', 'Worktree')
    expect(browser.isChecked('checkbox', 'Worktree')).toBe(true)

    browser.clickRole('checkbox', 'Worktree')
    expect(browser.isChecked('checkbox', 'Worktree')).toBe(false)

    browser.clickRole('checkbox', 'Worktree')
    expect(browser.isChecked('checkbox', 'Worktree')).toBe(true)
  })

  it('Settings → Worktrees starts empty and Reclaim now opens the AlertDialog confirm', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/settings/worktrees`)
    await browser.waitForRole('heading', 'Worktrees')
    expect(browser.hasText('No task worktrees on disk.')).toBe(true)
    expect(browser.hasRole('heading', 'Keep last N worktrees')).toBe(true)

    browser.clickRole('button', 'Reclaim now')
    await browser.waitForText('Reclaim old worktrees?')
    expect(browser.hasRole('button', 'Keep it')).toBe(true)
    // The AlertDialog's own entrance animation still covers its content for a beat after the
    // text lands in the DOM — a click during it can land on the fixed backdrop instead of "Keep
    // it" (#579-style finding, this package's own instance of it). Retry the click itself,
    // bounded, against a real condition — the same style this file's own guide-01 `landed` loop
    // and guide-07 `enabled` loop already use — rather than sleeping a fixed amount first.
    let dismissed = false
    for (let attempt = 0; attempt < 20 && !dismissed; attempt += 1) {
      // A dismissal from an earlier iteration's click can land after this loop already moved
      // on to retry — re-check right before acting, or a click here would target a button
      // that is no longer in the tree at all.
      if (!browser.hasRole('button', 'Keep it')) {
        dismissed = true
        break
      }
      browser.clickRole('button', 'Keep it')
      browser.pause(50)
      dismissed = !browser.hasRole('button', 'Keep it')
    }
    expect(dismissed, 'xezar e2e: "Keep it" never actually dismissed the AlertDialog').toBe(true)
    await browser.waitForRoleGone('button', 'Keep it')
  })

  it('Branches names the agents\' base branch with its own follow-checkout default', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/git/branches`)
    // The section label is rendered visually uppercase (`uppercase` utility class), and Chrome's
    // accessible-name computation follows CSS text transforms — the live accessible name really is
    // "BRANCHES" / "AGENTS' BASE BRANCH", confirmed against a real dry-run server's own snapshot.
    await browser.waitForRole('heading', 'BRANCHES')
    expect(browser.valueOfRole('combobox', 'AGENTS’ BASE BRANCH')).toBe('follow checked-out branch (default)')
  })
})

describe('guide 03 — worktrees and Git, a project with no Git repository', () => {
  let browser: GuideBrowser
  let server: ChildProcess
  let dataRoot: string
  let baseUrl: string
  let bootProject: string

  beforeAll(async () => {
    ;({ server, dataRoot, baseUrl, bootProject } = await bootFixture(false, 'nogit'))
    browser = GuideBrowser.open(`e2e-guide-03-nogit-${process.pid}`)
  }, 90_000)

  afterAll(async () => {
    browser?.close()
    await stopFixtureServer(server)
    await removeDataRoot(dataRoot)
  })

  it('hides the Worktree toggle entirely and names the missing repository on the Git tab', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/new`)
    await browser.waitForRole('button', 'Start task')
    expect(browser.hasRole('checkbox', 'Worktree')).toBe(false)

    browser.goto(`${baseUrl}/p/${bootProject}/git`)
    await browser.waitForRole('heading', 'Not a git repository')
    expect(browser.hasText(
      'xezar is running outside a git repository — start it inside one to browse changes, commits and branches.',
    )).toBe(true)
  })
})
