import { describe, expect, it } from 'vitest'

import { modelLabel, RUNNER_LABEL, runnerLabel, stepBackendCount, taskRunner } from './runner-label'

describe('RUNNER_LABEL', () => {
  it('names every backend the contract knows, and nothing else', () => {
    // Typed `Record<Runner, string>`, so a fifth backend is a COMPILE error here rather than a
    // surface that quietly prints nothing. This asserts the runtime half of the same promise.
    expect(RUNNER_LABEL).toEqual({
      claude: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
      pi: 'pi',
    })
  })
})

describe('stepBackendCount', () => {
  it('counts distinct recorded backends and ignores steps that never ran', () => {
    expect(stepBackendCount([])).toBe(0)
    expect(stepBackendCount([{}, {}])).toBe(0)
    expect(stepBackendCount([{ backend: 'claude' }, { backend: 'claude' }])).toBe(1)
    // A step with no backend is "nothing happened here", never a second backend.
    expect(stepBackendCount([{ backend: 'claude' }, {}, { backend: 'codex' }])).toBe(2)
    expect(
      stepBackendCount([{ backend: 'claude' }, { backend: 'codex' }, { backend: 'opencode' }]),
    ).toBe(3)
  })
})

describe('taskRunner', () => {
  it('keeps a recorded runner and marks it chosen', () => {
    // `execute` writes the RESOLVED backend onto the record at run start, so this is not "what
    // the caller asked for" — it is what ran, and it outranks everything below.
    expect(taskRunner('codex', [{ backend: 'opencode' }], 'claude')).toEqual({
      runner: 'codex',
      inherited: false,
    })
  })

  it('falls back to the last step that recorded a backend, and calls that chosen too', () => {
    // A record written before run-level backend affinity. Resolving it against today's project
    // default would name a backend the run never touched, so the step wins — and the answer is
    // history, not a projection, so it is NOT inherited.
    expect(taskRunner(undefined, [{ backend: 'codex' }, { backend: 'pi' }, {}], 'claude')).toEqual({
      runner: 'pi',
      inherited: false,
    })
  })

  it('reaches the project default only with no evidence at all — a run that never started', () => {
    expect(taskRunner(undefined, [], 'opencode')).toEqual({ runner: 'opencode', inherited: true })
    expect(taskRunner(undefined, [{}, {}], 'opencode')).toEqual({
      runner: 'opencode',
      inherited: true,
    })
  })

  it("uses 'claude' only while the project config is in flight", () => {
    // The same last resort the run header's AgentBadge uses, and the same default the config
    // schema itself carries — never a guess this file invented.
    expect(taskRunner(undefined, [], undefined)).toEqual({ runner: 'claude', inherited: true })
  })
})

describe('runnerLabel', () => {
  it('adds a +N marker only when the steps used more than one backend', () => {
    expect(runnerLabel('claude')).toBe('Claude Code')
    expect(runnerLabel('claude', 1)).toBe('Claude Code')
    expect(runnerLabel('claude', 2)).toBe('Claude Code +1')
    expect(runnerLabel('opencode', 3)).toBe('OpenCode +2')
  })
})

describe('modelLabel', () => {
  it('prints a recorded id verbatim and stands in for everything else', () => {
    expect(modelLabel('local/qwen3-coder-30b')).toEqual({
      text: 'local/qwen3-coder-30b',
      auto: false,
    })
    expect(modelLabel(undefined)).toEqual({ text: 'auto', auto: true })
    // '' is the composer's own auto sentinel and the contract permits it, so it must not render
    // as a blank cell on one surface and `auto` on the other.
    expect(modelLabel('')).toEqual({ text: 'auto', auto: true })
  })
})
