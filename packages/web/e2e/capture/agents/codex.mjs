// The capture harness's Codex: just enough `codex app-server` JSON-RPC (the shape of the test
// fixture `packages/xezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs`) to play the
// scripted turns in `scenarios.mjs`. `--version` answers like the real CLI, so backend detection
// lists Codex as installed.

import { createInterface } from 'node:readline'

import { GENERIC_TURN, applyEdits, followupFor, logProgress, scenarioFor, sleep } from './scenarios.mjs'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.154.0\n')
  process.exit(0)
}

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const THREAD = 'th_capture_1'

let scenario
let turnNumber = 0
const total = { inputTokens: 0, outputTokens: 0 }

async function play(turn) {
  turnNumber += 1
  const turnId = `turn_${turnNumber}`
  emit({ method: 'turn/started', params: { turn: { id: turnId, status: 'inProgress', items: [] } } })
  await sleep(150)
  if (turn.fail) {
    emit({ method: 'turn/failed', params: { turn: { id: turnId, status: 'failed' }, error: { message: turn.fail } } })
    return
  }
  applyEdits(turn)
  logProgress(turn)
  const message = (id, text) => {
    emit({ method: 'item/started', params: { threadId: THREAD, turnId, item: { type: 'agentMessage', id, text: '' } } })
    emit({ method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId, itemId: id, delta: text } })
    emit({ method: 'item/completed', params: { threadId: THREAD, turnId, item: { type: 'agentMessage', id, text } } })
  }
  if (turn.text) message(`msg_${turnNumber}_text`, turn.text)
  for (const [index, tool] of (turn.tools ?? []).entries()) {
    const id = `cmd_${turnNumber}_${index}`
    const command = ['bash', '-lc', tool.input.command ?? `cat ${tool.input.file_path ?? ''}`]
    emit({ method: 'item/started', params: { threadId: THREAD, turnId, item: { type: 'commandExecution', id, command, cwd: process.cwd(), status: 'inProgress' } } })
    await sleep(150)
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: THREAD, turnId, itemId: id, delta: `${tool.result}\n` } })
    emit({ method: 'item/completed', params: { threadId: THREAD, turnId, item: { type: 'commandExecution', id, command, cwd: process.cwd(), status: 'completed', exitCode: 0 } } })
  }
  if (turn.usage) {
    total.inputTokens += turn.usage.input
    total.outputTokens += turn.usage.output
    const totalTokens = total.inputTokens + total.outputTokens
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: THREAD, tokenUsage: { total: { ...total, totalTokens }, last: { ...total, totalTokens } } } })
  }
  if (turn.hold) await new Promise(() => {})
  message(`msg_${turnNumber}_reply`, [turn.reply ?? '', turn.refs].filter(Boolean).join('\n\n'))
  emit({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } })
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    emit({ id: message.id, result: { userAgent: 'codex-cli/0.154.0' } })
  } else if (message.method === 'config/read') {
    emit({ id: message.id, result: { config: { mcp_servers: {} }, origins: {} } })
  } else if (message.method === 'model/list') {
    emit({ id: message.id, result: { data: [], nextCursor: null } })
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.method === 'thread/start') emit({ method: 'thread/started', params: { thread: { id: THREAD } } })
    emit({ id: message.id, result: { thread: { id: THREAD } } })
  } else if (message.method === 'turn/start') {
    emit({ id: message.id, result: { turn: { id: `turn_${turnNumber + 1}` } } })
    const text = message.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? ''
    if (turnNumber === 0) scenario = scenarioFor(text)
    void play(turnNumber === 0 ? (scenario?.turn ?? GENERIC_TURN) : (followupFor(scenario, text) ?? GENERIC_TURN))
  } else if (message.id !== undefined && message.method) {
    emit({ id: message.id, result: {} })
  }
})
input.on('close', () => process.exit(0))
