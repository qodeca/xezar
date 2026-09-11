import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

/**
 * #118 — the COCKPIT half of A-20 (requirements § 9): with the cockpit open, a leader mutates
 * through MCP and the open page shows it WITHOUT A RELOAD; the cockpit then loses its server and
 * reconnects, and a change made across that gap still appears on the same page. The leader half —
 * human changes reaching the leader, the echo precondition, reconnect through a fresh MCP session —
 * is `packages/xezar/test/integration/mcp-real-clients.test.ts`; the per-case results are in
 * `docs/features/mcp-server/mcp-client-acceptance-record.md`.
 *
 * The same page also carries two UI clauses that belong to A-01, A-17 and A-23: the MCP connection
 * screen separates the one-time user step from what xezar does automatically and says per client
 * that the generated file is NOT discovered (U-M01), and it offers no manual disconnect, forced
 * takeover or kick control (F-18).
 *
 * Reachability: fully reachable — `XEZ_DRY_RUN=1` mocks every agent, and the leader is the REAL
 * `xez mcp` bridge (the built CLI) speaking JSON-RPC on stdio, exactly what Claude Code, Codex or
 * OpenCode would spawn; no model, account or network is involved.
 *
 * WHY ITS OWN SERVER, UNDER /tmp. The shared env serves this checkout, and the MCP socket lives at
 * `<XEZ_HOME>/ipc/<projectId>.sock` with a ~104-byte limit (D-01 E5): a data root under a task
 * worktree's TMPDIR is long enough to lose the socket. So this spec boots its own server over a
 * throwaway repository in `/tmp`, pinned by `fixtureServeEnv`, and tears it down through the shared
 * helpers.
 */

const sessionId = `e2e-mcp-live-sync-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess | undefined
let dataRoot: string
let repo: string
let port: number
let baseUrl: string
let projectId: string
let runId: string
/** A value planted in the page: still there means the page never reloaded. */
const MARKER = `a20-${process.pid}-${Date.now()}`

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const found = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(found))
    })
  })
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`xezar e2e: timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

function startServer(): void {
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', repo, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
}

const healthy = () =>
  waitFor('the fixture server', async () => ((await fetch(`${baseUrl}/api/v1/health`)).ok ? true : undefined), 60_000)

/** A same-origin write through the cockpit's own door — the human's. */
async function cockpit(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { origin: baseUrl, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return res.json()
}

/** The real `xez mcp` bridge, spawned the way a client spawns it: in the project folder. */
class Leader {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (message: any) => void>()

  constructor() {
    this.child = spawn(process.execPath, [xezarCli, 'mcp'], { cwd: repo, env: fixtureServeEnv(dataRoot), stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let index: number
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        const message = JSON.parse(line) as { id?: number }
        if (typeof message.id === 'number') {
          this.pending.get(message.id)?.(message)
          this.pending.delete(message.id)
        }
      }
    })
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`xezar e2e: the bridge did not answer ${method}`)), 30_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        done(message)
      })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    })
  }

  static async open(): Promise<Leader> {
    const leader = new Leader()
    const init = await leader.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-a20-leader', version: '0' } })
    if (init.error) throw new Error(`xezar e2e: the bridge refused initialize: ${JSON.stringify(init.error)}`)
    return leader
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const answer = await this.request('tools/call', { name, arguments: args })
    if (answer.error) throw new Error(`xezar e2e: tools/call ${name} → ${JSON.stringify(answer.error)}`)
    const text = (answer.result.content as Array<{ text: string }>).map((block) => block.text).join('\n')
    if (answer.result.isError) throw new Error(`xezar e2e: ${name} refused: ${text}`)
    return text
  }

  async close(): Promise<void> {
    const exited = new Promise<void>((done) => this.child.once('exit', () => done()))
    this.child.stdin!.end()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))])
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }
}

const rowText = (id: string) =>
  `document.querySelector('[data-slot="task-table-row"][data-run-id="${id}"]')?.textContent ?? ''`

beforeAll(async () => {
  dataRoot = realpathSync(mkdtempSync('/tmp/xez-e2e-a20-'))
  repo = join(dataRoot, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# A-20 fixture\n', 'utf8')
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')

  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  startServer()
  await healthy()
  projectId = await bootProjectId(baseUrl)
  // The socket opens fire-and-forget after boot (N-07); the leader needs it.
  const socket = join(dataRoot, '.xez-home', 'ipc', `${projectId}.sock`)
  await waitFor('the MCP socket', () => (existsSync(socket) ? true : undefined), 20_000)

  const created = await cockpit('/api/v1/runs', 'POST', { workflow: 'quick-task', task: 'mock:done a finished task for A-20', autonomous: true })
  runId = created.id
  await waitFor('the fixture task to finish', async () => {
    const run = await (await fetch(`${baseUrl}/api/v1/runs/${runId}`)).json()
    return (run.status ?? run.run?.status) === 'done' ? true : undefined
  })

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${projectId}/`)
  browser.waitForFunction(`${rowText(runId)}.length > 0`)
  browser.evaluate(`window.__xezA20Marker = ${JSON.stringify(MARKER)}`)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe('A-20 — the open cockpit follows MCP changes without a reload', () => {
  it('a leader’s MCP rename appears in the open task list, and the page never reloaded', async () => {
    const title = `Renamed by the leader ${Date.now()}`
    const leader = await Leader.open()
    try {
      await leader.call('organise_work', { action: 'set_title', runId, title })
    } finally {
      await leader.close()
    }
    browser.waitForFunction(`(${rowText(runId)}).includes(${JSON.stringify(title)})`)
    expect(browser.evaluate('window.__xezA20Marker')).toBe(MARKER)
  }, 90_000)

  it('after the cockpit loses its server and reconnects, a change made across the gap appears on the same page', async () => {
    await stopFixtureServer(server)
    // Give the page's stream time to notice it is gone before the server comes back.
    await new Promise((r) => setTimeout(r, 2_000))
    startServer()
    await healthy()
    await waitFor('the MCP socket after the restart', () =>
      existsSync(join(dataRoot, '.xez-home', 'ipc', `${projectId}.sock`)) ? true : undefined,
    )
    const title = `Renamed across a reconnect ${Date.now()}`
    const leader = await Leader.open()
    try {
      await leader.call('organise_work', { action: 'set_title', runId, title })
    } finally {
      await leader.close()
    }
    browser.waitForFunction(`(${rowText(runId)}).includes(${JSON.stringify(title)})`)
    expect(browser.evaluate('window.__xezA20Marker')).toBe(MARKER)
  }, 120_000)
})

describe('A-01 / A-17 / A-23 — the MCP connection screen', () => {
  it('separates the one-time user step from what xezar does, per client, and never claims autodiscovery', () => {
    browser.goto(`${baseUrl}/p/${projectId}/settings/mcp-connection`)
    browser.waitForFunction(`document.querySelector('[data-slot="mcp-connection-section"]') !== null`)
    const cards = browser.evaluate(`JSON.stringify(['claude-code', 'codex', 'opencode'].map((name) => {
      const card = document.querySelector('[data-slot="mcp-client-' + name + '"]')
      return {
        name,
        automatic: card?.querySelector('[data-slot="mcp-client-automatic"]')?.textContent ?? null,
        user: card?.querySelector('[data-slot="mcp-client-user"]')?.textContent ?? null,
        notAutomatic: card?.querySelector('[data-slot="mcp-client-not-automatic"]')?.textContent ?? null,
      }
    }))`)
    const parsed = JSON.parse(String(cards)) as Array<{ name: string; automatic: string | null; user: string | null; notAutomatic: string | null }>
    for (const card of parsed) {
      expect(card.automatic, card.name).toMatch(/Automatic/)
      expect(card.user, card.name).toMatch(/One-time/)
      expect(card.notAutomatic, card.name).toMatch(/does not discover `?\.local\/xezar\/mcp-connection\.json/)
    }
  })

  it('offers no manual disconnect, forced takeover or kick control', () => {
    browser.goto(`${baseUrl}/p/${projectId}/settings/mcp-connection`)
    browser.waitForFunction(`document.querySelector('[data-slot="mcp-connection-section"]') !== null`)
    const controls = JSON.parse(
      String(
        browser.evaluate(`JSON.stringify([...document.querySelectorAll('[data-slot="mcp-connection-section"] button, [data-slot="mcp-connection-section"] a, [data-slot="mcp-connection-section"] [role="button"]')].map((el) => (el.textContent ?? '').trim() + ' ' + (el.getAttribute('aria-label') ?? '')))`),
      ),
    ) as string[]
    expect(controls.filter((text) => /disconnect|take ?over|force|kick|evict|release/i.test(text))).toEqual([])
    // Populated-input guard: the section really rendered its content, so an empty control list is
    // a finding about the screen, not about a screen that never loaded.
    expect(browser.count('[data-slot="mcp-client-claude-code"]')).toBe(1)
  })
})
