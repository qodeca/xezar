// The capture harness's Claude Code: the stream-json session contract of the bundled dry-run mock
// (`packages/xezar/scripts/mock-claude.mjs`), playing the scripted turns in `scenarios.mjs`.

import { createInterface } from 'node:readline'

import { GENERIC_TURN, applyEdits, followupFor, logProgress, readAsset, scenarioFor, sleep } from './scenarios.mjs'

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
const assistant = (content) => emit({ type: 'assistant', message: { role: 'assistant', content } })

emit({ type: 'system', subtype: 'init' })

let scenario
let turnNumber = 0

async function play(turn) {
  turnNumber += 1
  await sleep(150)
  if (turn.fail) {
    emit({ type: 'result', subtype: 'success', is_error: true, result: turn.fail, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 })
    return
  }
  applyEdits(turn)
  logProgress(turn)
  if (turn.text) {
    assistant([{ type: 'text', text: turn.text }])
    await sleep(200)
  }
  for (const [index, tool] of (turn.tools ?? []).entries()) {
    const id = `toolu_${turnNumber}_${index}`
    assistant([{ type: 'tool_use', id, name: tool.name, input: tool.input }])
    await sleep(180)
    const image = tool.image ? readAsset(process.argv, tool.image) : undefined
    const content = image
      ? [{ type: 'text', text: tool.result }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }]
      : tool.result
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
    await sleep(120)
  }
  if (turn.after) {
    assistant([{ type: 'text', text: turn.after }])
    await sleep(150)
  }
  if (turn.running) assistant([{ type: 'tool_use', id: `toolu_${turnNumber}_running`, name: turn.running.name, input: turn.running.input }])
  if (turn.hold) {
    // A task that must still read "running": the turn never ends; the harness cancels it.
    await new Promise(() => {})
  }
  const markers = [turn.refs, turn.ask ? `XEZ:ASK ${JSON.stringify(turn.ask)}` : undefined].filter(Boolean)
  const reply = [turn.reply ?? '', ...markers].join('\n\n')
  assistant([{ type: 'text', text: reply }])
  await sleep(100)
  const usage = turn.usage ?? GENERIC_TURN.usage
  emit({
    type: 'result',
    subtype: 'success',
    result: turn.reply ?? '',
    usage: { input_tokens: usage.input, output_tokens: usage.output },
    total_cost_usd: Math.round((usage.input * 3 + usage.output * 15) / 10_000) / 100,
  })
}

async function respond(text) {
  if (text.includes('[xez-namer]')) {
    const title = scenarioFor(text)?.title ?? 'task'
    assistant([{ type: 'text', text: JSON.stringify({ title }) }])
    emit({ type: 'result', subtype: 'success', result: JSON.stringify({ title }), usage: { input_tokens: 200, output_tokens: 20 }, total_cost_usd: 0 })
    return
  }
  if (turnNumber === 0) {
    scenario = scenarioFor(text)
    await play(scenario?.turn ?? GENERIC_TURN)
    return
  }
  await play(followupFor(scenario, text) ?? GENERIC_TURN)
}

let queue = Promise.resolve()
const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  let text = ''
  try {
    const message = JSON.parse(line)
    text = (message?.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  } catch {
    return
  }
  queue = queue.then(() => respond(text))
})
input.on('close', () => {
  queue.then(() => process.exit(0))
  // A held turn never settles: stdin closing is the end of the session either way.
  setTimeout(() => process.exit(0), 5000)
})
