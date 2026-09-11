import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

// Nothing in this suite may write to the developer's own `~/.xezar`. Most cases pin
// `XEZ_HOME` themselves, but the pin is one global for the whole worker and their
// `afterEach` deletes it — so a write that outlives its test (a timeout is enough)
// used to resolve the real home and replace the project registry with the fixture's.
//
// This file removes the unpinned state entirely: every worker gets a sandbox home,
// and the pin is restored around every test, so a case that drops it can only leave
// the NEXT write pointed at the sandbox. A test that wants the unpinned default
// deletes the variable inside its own body (see `src/paths.test.ts`) — that still
// works, because this hook runs after the test, not during it. The write guard in
// `assertXezarHomeWriteIsSandboxed` catches whatever still slips through.
const sandboxHome = mkdtempSync(join(realpathSync(tmpdir()), 'xez-vitest-home-'))

const pinSandboxHome = (): void => {
  if (!process.env.XEZ_HOME) process.env.XEZ_HOME = sandboxHome
}

// `gh` 2.100 records a telemetry `device-id` under `$HOME/.local/state/gh` on EVERY
// invocation, `gh --version` included. The app starts `gh repo view` and `gh auth token`
// as background probes no test awaits, so a probe outliving its test recreated the
// test's temporary HOME just as `afterEach` removed it: `ENOTEMPTY` on one run in ten,
// and a leaked HOME on most of the rest (#260). With telemetry off `gh` writes nothing
// there, and a test run sends no telemetry from a fixture home either. Forced, not
// defaulted: `GH_TELEMETRY=log` still records the id.
process.env.GH_TELEMETRY = '0'

pinSandboxHome()
beforeEach(pinSandboxHome)
// Registered before any suite's own hooks, so vitest runs it last on the way out —
// after a case's `afterEach` has deleted the pin.
afterEach(pinSandboxHome)
afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})
