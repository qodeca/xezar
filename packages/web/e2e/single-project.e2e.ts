import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { unavailableAgentAccountReason, unavailableAgentAccountRefusal } from '@qodeca/xezar-api-client'

import { bootProjectId, fixtureServeEnv, getJson, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { GuideBrowser } from './guide-browser'

/**
 * Single-project mode from a FRESH CLONE (#600 AC-3, AC-6, AC-12 → SP-5.4, SP-5.5, SP-5.6).
 *
 * An "origin" repository commits its xezar setup — `.xezar/workspace.json` with limits and agent
 * defaults, `.xezar/agent-accounts.json` naming a second login — and the spec `git clone`s it into
 * a new folder and boots xezar there with NO flag and NO host setup step. The folder decides.
 *
 * The shared suite server cannot prove any of this: it is booted by `scripts/test-env-up.sh` from
 * the repository checkout (a linked task worktree, which is never a single-project root) in the
 * GLOBAL layout. So this spec owns its server, like `guide-14-local-hosted.e2e.ts`, and the
 * shared env's third reuse dimension (`environment.singleProjectRoot`) keeps the two from ever
 * being mistaken for one another in the other direction.
 *
 * `HOME` and `XEZ_HOME` are pinned inside the data root by `fixtureServeEnv`, so the committed
 * account's `~/.claude-work` resolves to a folder that does not exist here — which is exactly the
 * clone-on-another-machine case SP-5.5 is about — and the assertion that the per-user home was
 * never written is made against a real directory.
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`xezar e2e: the single-project fixture server never answered at ${url}`)
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Xezar e2e', '-c', 'user.email=e2e@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  })

/** What the origin repository commits. Values chosen to differ from every shipped default. */
const COMMITTED_WORKSPACE = {
  resources: { maxParallel: 3, memoryLimitMb: 2048, maxMonitoringSessions: 1 },
  agentDefaults: { runner: 'claude' },
}
const WORK_ACCOUNT = {
  id: 'work',
  provider: 'claude',
  label: 'Work account',
  configDir: '~/.claude-work',
  addedAt: '2026-09-18T00:00:00.000Z',
}
const COMMITTED_ACCOUNTS = { accounts: [WORK_ACCOUNT], defaults: {}, selections: {} }

let browser: GuideBrowser
let server: ChildProcess
let dataRoot: string
let clone: string
let baseUrl: string
let bootProject: string

type WorkspaceConfig = {
  resources: { maxParallel: number; memoryLimitMb: number | null; maxMonitoringSessions?: number }
  agentDefaults: { runner?: string }
}
type Run = { id: string; status: string; error?: string; steps?: Array<{ error?: string }> }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = (await response.json()) as T
  if (!response.ok) throw new Error(`xezar e2e: ${init?.method ?? 'GET'} ${path} → ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function settle(runId: string): Promise<Run> {
  let run: Run = { id: runId, status: 'queued' }
  for (let attempt = 0; attempt < 160 && !['done', 'review', 'failed', 'stopped'].includes(run.status); attempt += 1) {
    await new Promise((r) => setTimeout(r, 250))
    run = await api<Run>(`/api/v1/p/${bootProject}/runs/${runId}`)
  }
  return run
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'xezar-e2e-single-project-'))
  mkdirSync(join(dataRoot, 'home'), { recursive: true })

  // The origin: a repository that carries its own xezar setup, committed.
  const origin = join(dataRoot, 'origin')
  mkdirSync(join(origin, '.xezar'), { recursive: true })
  git(dataRoot, 'init', '--initial-branch=main', origin)
  writeFileSync(join(origin, 'README.md'), '# single-project fixture\n')
  writeFileSync(join(origin, '.xezar', 'config.json'), '{}\n')
  writeFileSync(join(origin, '.xezar', 'workspace.json'), `${JSON.stringify(COMMITTED_WORKSPACE, null, 2)}\n`)
  writeFileSync(join(origin, '.xezar', 'agent-accounts.json'), `${JSON.stringify(COMMITTED_ACCOUNTS, null, 2)}\n`)
  writeFileSync(join(origin, '.xezar', 'workspace-ui.json'), '{}\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-m', 'commit the xezar setup')

  // The fresh clone, somewhere else, booted with no flag and no setup step.
  clone = join(dataRoot, 'clone')
  git(dataRoot, 'clone', '--quiet', origin, clone)

  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', clone, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = GuideBrowser.open(`e2e-single-project-${process.pid}`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('single-project mode from a fresh clone', () => {
  it('boots in the mode because the folder carries its state — no flag, no host setup (SP-5.4)', async () => {
    const health = await getJson<{ capabilities: { singleProjectRoot?: boolean } }>(`${baseUrl}/api/v1/health`)
    expect(health.capabilities.singleProjectRoot).toBe(true)

    // The resolved settings ARE the committed ones, value for value.
    const config = await api<WorkspaceConfig>('/api/v1/workspace/config')
    expect(config.resources.maxParallel).toBe(COMMITTED_WORKSPACE.resources.maxParallel)
    expect(config.resources.memoryLimitMb).toBe(COMMITTED_WORKSPACE.resources.memoryLimitMb)
    expect(config.resources.maxMonitoringSessions).toBe(COMMITTED_WORKSPACE.resources.maxMonitoringSessions)
    expect(config.agentDefaults.runner).toBe(COMMITTED_WORKSPACE.agentDefaults.runner)

    // And the committed account is there — its folder simply does not exist on this machine.
    const accounts = await api<{ profiles: Array<{ id: string; configDir: string; exists: boolean }> }>(
      '/api/v1/workspace/agent-profiles',
    )
    expect(accounts.profiles.find((p) => p.id === 'work')).toMatchObject({ configDir: '~/.claude-work', exists: false })

    // Neither per-user home was created or written: the clone ran off its own files.
    expect(existsSync(join(dataRoot, '.xez-home'))).toBe(false)
    expect(existsSync(join(dataRoot, 'home', '.xezar'))).toBe(false)
  })

  it('completes settings: the page names the project file, and a change lands in that file', async () => {
    browser.goto(`${baseUrl}/settings/global/resources`)
    await browser.waitForText('.xezar/workspace.json')
    expect(browser.hasText('Single project')).toBe(true)
    expect(browser.hasText('How many tasks run at once in this project.')).toBe(true)
    // The per-project limits page does not exist in the mode, so nothing links to it.
    expect(browser.hasRole('link', 'Configure per-project limits')).toBe(false)

    await api('/api/v1/workspace/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resources: { maxParallel: 4 } }),
    })
    const onDisk = JSON.parse(readFileSync(join(clone, '.xezar', 'workspace.json'), 'utf8')) as WorkspaceConfig
    expect(onDisk.resources.maxParallel).toBe(4)
    expect(existsSync(join(dataRoot, '.xez-home'))).toBe(false)
  })

  it('completes accounts: the committed account the machine lacks reads Unavailable, path named (SP-5.5)', async () => {
    browser.goto(`${baseUrl}/settings/global/accounts`)
    await browser.waitForText('Work account')
    expect(browser.hasText('Unavailable')).toBe(true)
    expect(browser.hasText(unavailableAgentAccountReason('~/.claude-work'))).toBe(true)
    expect(browser.hasText('Defaults for this project')).toBe(true)
  })

  it('refuses a task that asks for the unavailable account with that same sentence — no fallback (SP-5.5)', async () => {
    const created = await api<{ id: string }>(`/api/v1/p/${bootProject}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'mock:done must not run on another login', autonomous: true, workflow: 'quick-task', agentProfile: 'work' }),
    })
    const run = await settle(created.id)
    expect(run.status).toBe('failed')
    const refusal = unavailableAgentAccountRefusal('Work account', '~/.claude-work')
    expect([run.error, ...(run.steps ?? []).map((step) => step.error)]).toContain(refusal)
  })

  it('completes one whole task on this machine\'s own login (SP-5.6)', async () => {
    const created = await api<{ id: string }>(`/api/v1/p/${bootProject}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'mock:done the single-project clone probe', autonomous: true, workflow: 'quick-task' }),
    })
    const run = await settle(created.id)
    expect(['done', 'review']).toContain(run.status)

    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${created.id}`)
    await browser.waitForText('the single-project clone probe')
    // The task's working files stay in the project's own .local/xezar, never in a home.
    expect(existsSync(join(clone, '.local', 'xezar', 'runs.json'))).toBe(true)
    expect(existsSync(join(dataRoot, '.xez-home'))).toBe(false)
  })
})
