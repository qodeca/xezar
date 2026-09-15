// The capture harness's pi: the RPC contract of the bundled dry-run mock
// (`packages/xezar/scripts/mock-pi-rpc.mjs`), playing the scripted turns in `scenarios.mjs`.

import { createInterface } from 'node:readline'

import { GENERIC_TURN, applyEdits, followupFor, logProgress, scenarioFor, sleep } from './scenarios.mjs'

if (process.argv.includes('--version')) {
  process.stdout.write('0.72.1\n')
  process.exit(0)
}

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const sessionId = '6c1f2e84-3b5a-4d9e-8f07-2a1b3c4d5e6f'

let scenario
let turnNumber = 0

function text(content) {
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} } })
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: content, partial: {} } })
  send({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content, partial: {} } })
}

async function play(turn) {
  turnNumber += 1
  send({ type: 'agent_start' })
  send({ type: 'turn_start' })
  await sleep(150)
  applyEdits(turn)
  logProgress(turn)
  if (turn.text) text(turn.text)
  for (const [index, tool] of (turn.tools ?? []).entries()) {
    const toolCallId = `tool-${turnNumber}-${index}`
    const toolName = tool.name.toLowerCase() === 'grep' ? 'grep' : tool.name.toLowerCase()
    const args = tool.input.command !== undefined ? { command: tool.input.command } : { path: tool.input.file_path ?? tool.input.path }
    send({ type: 'tool_execution_start', toolCallId, toolName, args })
    await sleep(150)
    send({ type: 'tool_execution_end', toolCallId, toolName, result: { content: [{ type: 'text', text: tool.result }] }, isError: false })
  }
  if (turn.hold) await new Promise(() => {})
  text([turn.reply ?? '', turn.refs].filter(Boolean).join('\n\n'))
  const usage = turn.usage ?? GENERIC_TURN.usage
  send({
    type: 'message_end',
    message: { role: 'assistant', usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
  })
  send({ type: 'turn_end', message: {}, toolResults: [] })
  send({ type: 'agent_end', messages: [], willRetry: false })
  send({ type: 'agent_settled' })
}

for await (const line of createInterface({ input: process.stdin })) {
  let command
  try {
    command = JSON.parse(line)
  } catch {
    continue
  }
  if (command.type === 'get_state') {
    send({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId, thinkingLevel: 'medium', isStreaming: false, isCompacting: false, steeringMode: 'all', followUpMode: 'one-at-a-time', autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 },
    })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    if (turnNumber === 0) scenario = scenarioFor(command.message ?? '')
    void play(turnNumber === 0 ? (scenario?.turn ?? GENERIC_TURN) : (followupFor(scenario, command.message ?? '') ?? GENERIC_TURN))
  } else {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
}
