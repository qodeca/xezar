import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Guide 05 — Workflows (docs/guide/05-workflows.md): the deep-linked builder view of a saved
 * multi-step file, and a real run against it proving the chain actually advances step to step.
 *
 * `workflows.e2e.ts` already proves the builder end to end — building a flow from the palette,
 * saving it, importing YAML with a check step and `onFail.retry`, and the 8-step refusal — over
 * the shared server with CSS/`data-slot` selectors. This file adds only what that one does not:
 * opening a saved workflow by its own `/workflows/:name` URL (rather than building one live), and
 * a scripted end-to-end run that proves the step rail really advances rather than only rendering a
 * static mock. `plan-mode.e2e.ts` covers the separate Auto-plan chain-building flow.
 *
 * Dry-run exception register (browser-test-spec.md § Dry-run exception register, row "05"):
 * `onFail.retry`, `timeout` and the `XEZ:DONE` completion-marker semantics themselves are covered
 * by `packages/xezar/src/workflows/run.test.ts:792-910` and
 * `packages/xezar/src/workflows/step-timeout-wiring.test.ts:54-164`. This file only proves the
 * two are wired together: that a saved file with two agent steps really executes both and the
 * cockpit's own step rail reflects it, over the bundled `mock:done` seam
 * (`packages/xezar/scripts/mock-claude.mjs`).
 */

const FLOW = 'guide-05-probe'
const SKILL = 'guide-05-skill'

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
  throw new Error(`xezar e2e: the guide-05 fixture server never answered at ${url}`)
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`xezar e2e: ${init?.method ?? 'GET'} ${path} answered ${response.status}`)
  return (await response.json()) as T
}

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-guide-05-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'guide-05@xezar.test')
  git('config', 'user.name', 'xezar guide-05')
  mkdirSync(join(dataRoot, '.xezar/skills'), { recursive: true })
  mkdirSync(join(dataRoot, '.xezar/workflows'), { recursive: true })
  writeFileSync(
    join(dataRoot, `.xezar/skills/${SKILL}.md`),
    `---\nname: ${SKILL}\ndescription: A project skill for the guide-05 probe.\n---\n\n# ${SKILL}\n\nFollow the steps.\n`,
  )
  writeFileSync(
    join(dataRoot, `.xezar/workflows/${FLOW}.yaml`),
    `name: ${FLOW}\ndescription: A two-step guide-05 chain.\nsteps:\n  - id: implement\n    prompt: "{{task}}"\n  - id: verify\n    prompt: "{{task}}"\n`,
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

  browser = GuideBrowser.open(`e2e-guide-05-${process.pid}`)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('guide 05 — workflows', () => {
  it('opening a saved workflow by its own URL loads its name, steps and export actions', async () => {
    browser.goto(`${baseUrl}/p/${bootProject}/workflows/${FLOW}`)
    await browser.waitForRole('heading', 'Workflows')
    // The named file loads asynchronously after the shell itself — wait on a fact only the
    // loaded file provides before reading the name field's value.
    await browser.waitForRole('button', 'Reorder step 1: implement')
    expect(browser.valueOfRole('textbox', 'Workflow name')).toBe(FLOW)
    expect(browser.hasRole('button', 'Reorder step 1: implement')).toBe(true)
    expect(browser.hasRole('button', 'Reorder step 2: verify')).toBe(true)
    expect(browser.hasRole('button', 'Export')).toBe(true)
    expect(browser.hasRole('button', 'Copy')).toBe(true)
  })

  it('a real run against the saved chain advances through both agent steps to done', async () => {
    const created = await api<{ id: string }>(baseUrl, `/api/v1/p/${bootProject}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'mock:done the guide-05 two-step probe',
        worktree: false,
        autonomous: true,
        workflow: FLOW,
      }),
    })

    let status = 'queued'
    for (let attempt = 0; attempt < 60 && !['done', 'review', 'failed'].includes(status); attempt += 1) {
      await new Promise((r) => setTimeout(r, 250))
      status = (await api<{ status: string }>(baseUrl, `/api/v1/p/${bootProject}/runs/${created.id}`)).status
    }
    expect(status).toBe('done')

    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${created.id}`)
    await browser.waitForRole('button', 'Workflow: verify, step 2 of 2')
  })
})
