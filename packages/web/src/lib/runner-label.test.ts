import { describe, expect, it } from 'vitest'

import { RUNNER_LABEL, runnerLabel, stepBackendCount, taskRunner } from './runner-label'

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
    expect(runnerLabel('opencode')).toBe('OpenCode')
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
    expect(taskRunner('codex', 'claude')).toEqual({ runner: 'codex', inherited: false })
  })

  it('falls back to the project default and says nobody chose it', () => {
    expect(taskRunner(undefined, 'opencode')).toEqual({ runner: 'opencode', inherited: true })
  })

  it("uses 'claude' only while the project config is in flight", () => {
    // The same last resort the run header's AgentBadge uses, and the same default the config
    // schema itself carries — never a guess this file invented.
    expect(taskRunner(undefined, undefined)).toEqual({ runner: 'claude', inherited: true })
  })
})
