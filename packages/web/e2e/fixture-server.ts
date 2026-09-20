import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bootProjectId, fixtureServeEnv, removeDataRoot, stopFixtureServer, xezarCli } from './agent-browser'
import { createFixtureRepo } from './capture/fixture-repo'

/**
 * A spec-owned xezar over a fixture repository — the one shared helper for browser specs that
 * need a git checkout whose refs, history and working tree the SPEC owns.
 *
 * Why this exists (#671, F-05): `repo-git.e2e.ts` and `settings-agents.e2e.ts` attached to the
 * shared test env, which serves the checkout the suite runs in, and asserted on THAT checkout's
 * branch list. `getBranches` (`src/server/git.ts`) filters every `xez/*` name out, so on a task
 * branch — the one branch name under which xezar's own suite runs on CI — the endpoint honestly
 * answers `[]` and both specs failed deterministically: `expected 0 to be greater than 0`, and a
 * 25 s wait for a base-branch option that could never arrive. Eleven CI runs; the leader guide
 * filed the pair as a load flake a re-run could clear. A spec must not assert on state it does
 * not own, so both now boot the checkout they assert on.
 *
 * `createFixtureRepo` (`capture/fixture-repo.ts`) builds that checkout: `main` as a real,
 * non-`xez/*` branch, a fixed five-commit history and a github.com origin the dry-run forge
 * mocks. `fixtureServeEnv` pins `XEZ_HOME` and `HOME` inside `dataRoot`, so the boot registers
 * nothing in the developer's workspace and `stop()` leaves nothing behind.
 */
export interface FixtureServer {
  /** The fixture server's own base URL — never the shared `.local/qa/test-env.json` instance. */
  baseUrl: string
  /** The throwaway root holding the checkout, the pinned home and the workspace state. */
  dataRoot: string
  /** The fixture repository itself. */
  root: string
  /** The fixture project's slug, as the server allocated it. */
  projectId: string
  /** Stop the server and delete `dataRoot`. Safe to call once from `afterAll`. */
  stop(): Promise<void>
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

/** Boot `xezar serve` over a fresh `createFixtureRepo` checkout and wait until it answers. */
export async function bootFixtureServer(): Promise<FixtureServer> {
  // `/tmp`, not `os.tmpdir()`: inside a xezar task TMPDIR sits under the repository, and the
  // realpath keeps `/private/tmp` and `/tmp` from reading as two different roots on macOS.
  const base = process.platform === 'win32' ? tmpdir() : '/tmp'
  const dataRoot = realpathSync(mkdtempSync(join(base, 'xezar-e2e-fixture-')))
  // The checkout lives INSIDE `dataRoot` while the pinned HOME and XEZ_HOME stay BESIDE it,
  // never in it: a home inside the repo would show up as untracked files in the very Changes
  // view `repo-git.e2e.ts` asserts on.
  const root = join(dataRoot, 'fixture-shop')
  createFixtureRepo(root, 'fixture-shop')

  const port = await freePort()
  const baseUrl = `http://localhost:${port}`
  const server = spawn(
    process.execPath,
    [xezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) break
    } catch {
      /* not up yet */
    }
    if (attempt > 120) {
      await stopFixtureServer(server)
      await removeDataRoot(dataRoot)
      throw new Error(`xezar e2e: the fixture server never answered at ${baseUrl}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const projectId = await bootProjectId(baseUrl)
  return {
    baseUrl,
    dataRoot,
    root,
    projectId,
    stop: async () => {
      await stopFixtureServer(server)
      await removeDataRoot(dataRoot)
    },
  }
}
