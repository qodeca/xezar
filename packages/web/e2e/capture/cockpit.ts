import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fixtureServeEnv, xezarCli } from '../agent-browser'
import { createFixtureRepo } from './fixture-repo'

/**
 * The capture harness's own xezar: a `serve` over a throwaway workspace, with every opt-in
 * surface the screenshots need switched on — the follow-up Inbox, Automations and the review
 * gate — and nothing read from the developer's machine.
 *
 * Why not the shared test env: that instance boots with every opt-in OFF (the browser suite
 * exercises the default route), and its registry and run list are shared with 41 specs. The
 * captures need a fixed, rich state that nothing else touches.
 */

export const DEMO_PROJECT = 'demo-shop'
export const DOCS_PROJECT = 'docs-site'

export interface Cockpit {
  baseUrl: string
  dataRoot: string
  demoRoot: string
  docsRoot: string
  /** The sandboxed HOME the server runs with. */
  home: string
  server: ChildProcess
}

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

export async function bootCockpit(): Promise<Cockpit> {
  // `/tmp`, not `os.tmpdir()`: inside a xezar task TMPDIR sits under the repository, and the
  // realpath keeps `/private/tmp` and `/tmp` from reading as two different roots on macOS.
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const dataRoot = realpathSync(mkdtempSync(join(base, 'xezar-capture-')))
  const demoRoot = join(dataRoot, DEMO_PROJECT)
  const docsRoot = join(dataRoot, DOCS_PROJECT)
  createFixtureRepo(demoRoot, DEMO_PROJECT)
  createFixtureRepo(docsRoot, DOCS_PROJECT)

  // A sandboxed HOME as well as XEZ_HOME: global skills are discovered from `~/.agents/skills`
  // and `~/.claude/skills`, which XEZ_HOME does not move, and the agents' own user-scope config
  // would otherwise seed model pickers from the developer's settings.
  const home = join(dataRoot, 'home')
  // The default Claude login folder exists, as it would on a machine with Claude Code installed.
  mkdirSync(join(home, '.claude'), { recursive: true })
  const xezHome = join(dataRoot, '.xez-home')
  mkdirSync(xezHome, { recursive: true })
  writeFileSync(join(xezHome, 'config.json'), `${JSON.stringify({ resources: { maxParallel: 2 } }, null, 2)}\n`)

  const port = await freePort()
  const baseUrl = `http://localhost:${port}`
  const env = fixtureServeEnv(dataRoot, {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    XEZ_FOLLOWUPS: '1',
    XEZ_AUTOMATIONS: '1',
    XEZ_REVIEW_GATE: '1',
    XEZ_NO_BANNER: '1',
  })
  delete env.ANTHROPIC_MODEL
  const server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', demoRoot, '--port', String(port), '--no-open'],
    { env, stdio: 'ignore' },
  )
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) break
    } catch {
      /* not up yet */
    }
    if (attempt > 120) throw new Error(`xezar capture: the fixture server never answered at ${baseUrl}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  return { baseUrl, dataRoot, demoRoot, docsRoot, home, server }
}

// ---- API helpers ----------------------------------------------------------------------------

export type Json = Record<string, unknown>

export async function api<T = Json>(
  cockpit: Cockpit,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${cockpit.baseUrl}/api/v1${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`xezar capture: ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`)
      return (text === '' ? {} : JSON.parse(text)) as T
    } catch (error) {
      // A reset pooled connection is not a dead server — see `getJson` in ../agent-browser.ts.
      if (attempt >= 2 || (error as Error).message.startsWith('xezar capture:')) throw error
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

export async function waitForStatus(
  cockpit: Cockpit,
  runPath: string,
  wanted: string[],
  timeoutMs = 90_000,
): Promise<Json> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = await api(cockpit, 'GET', runPath)
    if (wanted.includes(String(run.status))) return run
    if (Date.now() > deadline) {
      throw new Error(`xezar capture: ${runPath} is "${String(run.status)}", never reached ${wanted.join('/')}`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
}
