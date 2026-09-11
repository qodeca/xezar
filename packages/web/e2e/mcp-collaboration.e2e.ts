import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv, getJson, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'

/**
 * The cockpit half of A-08 (#116): a human in the open cockpit and a leader over MCP work on the same
 * project, and each sees the other's effects WITHOUT a reload. The route-level half — each side reading,
 * changing and taking over the other's task, and no MCP-only history or configuration — is proven by
 * P-19, P-20 and P-21 in `packages/xezar/src/mcp/acceptance-parity.test.ts`. What only a browser can
 * show is the rendered cockpit following the leader live, and that is what this spec asserts.
 *
 * Both doors are the real ones. The server is `xezar serve` over a throwaway git repository, so the MCP
 * service is the one `src/index.ts` composes over the running cockpit (#247), not a test wiring. The
 * leader is the real `xezar mcp` stdio bridge a coding agent spawns, speaking JSON-RPC; it finds the
 * project's socket through the registry in the pinned `XEZ_HOME`, as a real client does.
 *
 * Every case title starts `B-nn (acceptance) [records]`. The parity suite reads those titles and holds
 * `docs/features/mcp-server/mcp-parity-coverage-map.md` to them, so a case added, removed or re-pointed
 * here without updating the map fails `npm test`.
 *
 * Why the data root is under `/tmp` rather than `os.tmpdir()`: the MCP socket lives at
 * `<XEZ_HOME>/ipc/<projectId>.sock`, and a Unix socket path has a hard limit of 104 bytes on macOS
 * (D-01 § 1.4). A task or CI `TMPDIR` can already be longer than that, and a boot whose socket cannot
 * open still serves the cockpit — so every leader call here would answer "not running" instead of
 * failing for the real reason. The bridge is unsupported on Windows (D-01 § 10.2), so that platform
 * keeps `os.tmpdir()` and the suite skips.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.local/qa/artifacts_e2e')
const session = `e2e-mcp-collaboration-${process.pid}`
const onWindows = process.platform === 'win32'

/** The protocol revision the bridge echoes (`SUPPORTED_PROTOCOL_VERSIONS`, D-01 § 1.6). */
const PROTOCOL_VERSION = '2025-11-25'
/** One interactive agent step: under `XEZ_DRY_RUN=1` the bundled mock answers and the task waits. */
const AGENT_STEPS = [{ id: 'task', name: 'Task', prompt: '{{task}}' }]

const ROW = '[data-slot="task-row"]'
/** Set once on the page after the first load. A reload or a hard navigation drops it, so every live
 *  assertion below also proves the cockpit got there WITHOUT one. */
const SAME_PAGE = `window.__xzSamePage === true`

type RpcMessage = { id?: number; result?: unknown; error?: { code: number; message: string } }
type ToolResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }

/** A coding agent's side of `xezar mcp`: newline-delimited JSON-RPC over the bridge's stdio. */
class Leader {
  private next = 1
  private buffer = ''
  private stderr = ''
  private readonly pending = new Map<number, (message: RpcMessage) => void>()

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4_000)
    })
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        const message = JSON.parse(line) as RpcMessage
        if (typeof message.id !== 'number') continue
        this.pending.get(message.id)?.(message)
        this.pending.delete(message.id)
      }
    })
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.next++
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`xezar e2e: the MCP bridge did not answer ${method} in 30s. Bridge stderr:\n${this.stderr}`))
      }, 30_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        done(message)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    })
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  /** One `tools/call`, answered as the tool's raw MCP result. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const message = await this.request('tools/call', { name, arguments: args })
    if (message.error) throw new Error(`xezar e2e: ${name} → JSON-RPC error ${message.error.code}: ${message.error.message}`)
    return message.result as ToolResult
  }

  /** A tool result the leader can use, parsed from the authoritative text block (D-05). */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await this.call(name, args)
    const text = (result.content ?? []).map((block) => block.text ?? '').join('')
    if (result.isError) throw new Error(`xezar e2e: ${name}(${JSON.stringify(args)}) failed: ${text}`)
    try {
      return JSON.parse(text) as Record<string, any>
    } catch {
      return result.structuredContent ?? { text }
    }
  }
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

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`xezar e2e: timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** A hermetic repository: no developer identity, signing or hooks decide whether the fixture commits. */
function makeRepo(root: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=e2e@example.invalid', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      stdio: 'ignore',
    })
  writeFileSync(join(root, 'README.md'), '# mcp collaboration fixture\n', 'utf8')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
}

let browser: AgentBrowser | undefined
let server: ChildProcess | undefined
let leader: Leader | undefined
let dataRoot: string | undefined
let serverLog = ''
let baseUrl = ''
let project = ''
/** The task the leader creates in B-01; B-02 and B-03 continue on it. */
let taskId = ''

const api = (path: string) => `${baseUrl}/api/v1/p/${project}${path}`
const run = (id: string) => getJson<Record<string, any>>(api(`/runs/${id}`))
const waitForStatus = (id: string, status: string) =>
  until(async () => ((await run(id)).status === status ? true : undefined), `task ${id} to be ${status}`)
const bubbles = () =>
  browser!.evaluate(`[...document.querySelectorAll('[data-slot="user-bubble"]')].map((el) => el.textContent.trim())`) as string[]

beforeAll(async () => {
  dataRoot = realpathSync(mkdtempSync(join(onWindows ? tmpdir() : '/tmp', 'xz-mcp-')))
  makeRepo(dataRoot)
  const env = fixtureServeEnv(dataRoot)

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [xezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  server.stderr?.setEncoding('utf8')
  server.stderr?.on('data', (chunk: string) => {
    serverLog = (serverLog + chunk).slice(-8_000)
  })
  await until(async () => {
    try {
      return (await fetch(`${baseUrl}/api/v1/health`)).ok ? true : undefined
    } catch {
      return undefined
    }
  }, `the fixture server at ${baseUrl}`)
  project = await bootProjectId(baseUrl)

  // The leader: the stdio bridge a coding agent spawns, in the project directory, under the same home.
  const bridge = spawn(process.execPath, [xezarCli, 'mcp', '--repo', dataRoot], { cwd: dataRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
  leader = new Leader(bridge)
  const init = await leader.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'xezar-e2e-leader', version: '0' },
  })
  expect(init.error, JSON.stringify(init.error)).toBeUndefined()
  leader.notify('notifications/initialized')
  // The socket opens after the server listens (fire-and-forget, N-07), so health is the readiness
  // probe. It must name THIS project: a leader bound anywhere else would make every case below vacuous.
  const health = await until(async () => {
    const result = await leader!.call('health')
    return result.isError ? undefined : result
  }, `the MCP service for ${project}. Server stderr:\n${serverLog}`)
  expect(health.structuredContent).toMatchObject({ status: 'running', project: { id: project } })

  browser = AgentBrowser.open(session)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${project}/`)
  browser.waitForFunction(`document.querySelector('[data-slot="quick-list"]') !== null`)
  browser.evaluate(`window.__xzSamePage = true`)
}, 120_000)

afterAll(async () => {
  browser?.close()
  if (leader) {
    leader.child.stdin.end()
    await stopFixtureServer(leader.child)
  }
  await stopFixtureServer(server)
  await removeDataRoot(dataRoot)
})

describe.skipIf(onWindows)('MCP collaboration — the human’s cockpit and the leader on one project (A-08)', () => {
  it('B-01 (A-08, A-05) [I-001 I-015 I-018] a task the leader creates, and then renames, appears and renames live in the open cockpit, with no reload', async () => {
    const started = await leader!.tool('task_create', {
      operationId: `op-e2e-${process.pid}-1`,
      prompt: 'say hello from the leader',
      steps: AGENT_STEPS,
    })
    expect(started).toMatchObject({ accepted: true })
    taskId = started.subject.id as string
    expect(taskId).toBeTruthy()

    // The row arrives over the cockpit's own live stream — the page that was already open.
    browser!.waitForFunction(`${SAME_PAGE} && document.querySelector('${ROW}[data-run-id="${taskId}"]') !== null`)
    await waitForStatus(taskId, 'waiting')

    // The leader renames it; the human's row follows, still without a reload.
    const renamed = await leader!.tool('organise_work', { action: 'set_title', runId: taskId, title: 'Renamed by the leader' })
    expect(renamed).toMatchObject({ status: 'done' })
    browser!.waitForFunction(
      `${SAME_PAGE} && document.querySelector('${ROW}[data-run-id="${taskId}"]')?.textContent.includes('Renamed by the leader')`,
    )
    // One task, one record: the cockpit's API and the leader's read agree on what the human now sees.
    const cockpit = await run(taskId)
    const read = await leader!.tool('task_read', { view: 'task', taskId })
    expect(cockpit.title).toBe('Renamed by the leader')
    expect({ id: read.task.id, title: read.task.title, status: read.task.status }).toEqual({
      id: cockpit.id,
      title: cockpit.title,
      status: cockpit.status,
    })
    browser!.screenshot(`${artifactsDir}/mcp-collaboration-leader-task.png`, { viewport: true })
  })

  it('B-02 (A-08, A-07) [I-033 I-034] the human takes over in the thread, the leader reads that reply in the one shared history, and the leader’s reply appears live in the human’s thread', async () => {
    expect(taskId, 'B-01 creates the task this case continues').toBeTruthy()
    // Client-side navigation from the row, so the same page carries on. The row's TASK link by its
    // href: a row can also carry a PR chip, which is an anchor too and leaves the cockpit.
    browser!.click(`${ROW}[data-run-id="${taskId}"] a[href="/p/${project}/tasks/${taskId}"]`)
    browser!.waitForFunction(`${SAME_PAGE} && location.pathname === '/p/${project}/tasks/${taskId}'`)
    browser!.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
    expect(browser!.evaluate(`document.querySelector('[data-slot="run-header"] h1')?.textContent`)).toBe('Renamed by the leader')

    // The human replies through the thread's composer.
    browser!.click('[data-slot="composer"] textarea')
    browser!.fill('[data-slot="composer"] textarea', 'the human takes over here')
    browser!.click('[data-slot="composer"] [aria-label="Send"]')
    browser!.waitForFunction(
      `[...document.querySelectorAll('[data-slot="user-bubble"]')].some((el) => el.textContent.includes('the human takes over here'))`,
    )
    await waitForStatus(taskId, 'waiting')

    // The leader reads the human's reply in the SAME transcript the cockpit replays — same events.
    const history = await leader!.tool('task_read', { view: 'history', taskId })
    expect(JSON.stringify(history.events)).toContain('the human takes over here')
    const cockpitHistory = await getJson<{ events: Array<{ seq: number }> }>(api(`/runs/${taskId}/history`))
    const seqs = (events: Array<{ seq: number }>) => events.map((event) => event.seq).sort((x, y) => x - y)
    expect(seqs(history.events as Array<{ seq: number }>)).toEqual(seqs(cockpitHistory.events))

    // The leader replies; the human's open thread shows it without a reload.
    const sent = await leader!.tool('execution_control', { action: 'send_message', runId: taskId, text: 'the leader answers back' })
    expect(sent).toMatchObject({ accepted: true })
    browser!.waitForFunction(
      `${SAME_PAGE} && [...document.querySelectorAll('[data-slot="user-bubble"]')].some((el) => el.textContent.includes('the leader answers back'))`,
    )
    const order = bubbles().filter((text) => /the human takes over here|the leader answers back/.test(text))
    expect(order).toEqual(['the human takes over here', 'the leader answers back'])
    await waitForStatus(taskId, 'waiting')

    // No MCP-only history: the task has ONE event transcript on disk, the cockpit's, and nothing the
    // MCP door filed beside it. (Its images folder and handoff file are the task's own, either door.)
    const files = readdirSync(join(dataRoot!, '.local', 'xezar', 'runs')).filter((file) => file.startsWith(taskId))
    expect(files.filter((file) => file.endsWith('.ndjson'))).toEqual([`${taskId}.ndjson`])
    expect(files.filter((file) => /mcp|leader/i.test(file))).toEqual([])
    browser!.screenshot(`${artifactsDir}/mcp-collaboration-shared-thread.png`, { viewport: true })
  })

  it('B-03 (A-08, A-06) [I-019] a pin the human sets is the pin the leader reads, and the leader’s unpin shows live in the human’s header', async () => {
    expect(taskId, 'B-01 creates the task this case continues').toBeTruthy()
    const PIN = '[data-slot="run-actions"] [data-slot="pin-run"]'
    browser!.waitForFunction(`document.querySelector('${PIN}')?.getAttribute('aria-pressed') === 'false'`)

    // The human pins in the header.
    browser!.click(PIN)
    browser!.waitForFunction(`document.querySelector('${PIN}')?.getAttribute('aria-pressed') === 'true'`)
    await until(async () => ((await run(taskId)).pinned === true ? true : undefined), 'the pin to be recorded')
    expect((await leader!.tool('task_read', { view: 'task', taskId })).task.pinned).toBe(true)

    // The leader unpins; the human's header follows without a reload.
    expect(await leader!.tool('organise_work', { action: 'unpin', runId: taskId })).toMatchObject({ status: 'done' })
    browser!.waitForFunction(`${SAME_PAGE} && document.querySelector('${PIN}')?.getAttribute('aria-pressed') === 'false'`)
    expect((await run(taskId)).pinned).toBeFalsy()
  })
})
