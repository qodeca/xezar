import { afterEach, describe, expect, it } from 'vitest'

import { fixtureServeEnv } from '../e2e/agent-browser'

// Named literally, not imported from the module under test — this guard must keep failing if
// `fixtureServeEnv`'s scrub list is ever narrowed, not just if it goes missing.
const TASK_CONTROL_ENV_VARS = ['XEZ_HANDOFF_FILE', 'XEZ_TODOS_FILE', 'XEZ_TASK_ID'] as const

/**
 * The task-control-variable leak (#554), second spawn path.
 *
 * `scripts/test-env-up.sh` unsets these before booting the *single shared* `xezar serve`
 * instance, but `fixtureServeEnv` — the helper ~25 e2e specs use to boot their OWN throwaway
 * servers, including the two that spawn `xezar mcp` directly (`mcp-live-sync.e2e.ts`,
 * `mcp-collaboration.e2e.ts`) — used to spread `process.env` unfiltered. Run from inside a
 * xezar task (the normal way this repo validates its own PRs), a fixture-owned process would
 * then inherit the CALLING task's own `XEZ_HANDOFF_FILE`/`XEZ_TODOS_FILE`/`XEZ_TASK_ID` and
 * could write mock notes into that real task's handoff/follow-up files.
 *
 * Lives in `packages/web/src` (not `e2e/`) so it runs under `npm test`, the fast unit gate —
 * no server, no browser — the same reason `e2e-file-parallelism.test.ts` sits here too.
 */
describe('fixtureServeEnv scrubs the calling task control variables', () => {
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const name of TASK_CONTROL_ENV_VARS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  it('never returns XEZ_HANDOFF_FILE, XEZ_TODOS_FILE or XEZ_TASK_ID when the parent process has them set', () => {
    for (const name of TASK_CONTROL_ENV_VARS) {
      saved[name] = process.env[name]
      process.env[name] = `/tmp/calling-task/${name}`
    }

    const env = fixtureServeEnv('/tmp/xezar-e2e-fixture')

    for (const name of TASK_CONTROL_ENV_VARS) {
      expect(env[name]).toBeUndefined()
    }
  })
})
