import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runAgentBrowserCli, type CliFailure } from '../e2e/agent-browser-cli'

/**
 * `runAgentBrowserCli` returns when the CLI exits, even while a background process it started
 * still holds the CLI's stdout and stderr.
 *
 * That is agent-browser's own shape: the first command of a session starts a long-lived daemon,
 * and on Windows the daemon inherits the CLI's output handles. Read through a pipe
 * (`execFileSync`), every first command of every spec waited for an end-of-file the daemon never
 * sent and failed with `spawnSync … ETIMEDOUT` after its full timeout — the whole browser suite
 * failed that way on Windows. The fake CLI here reproduces the mechanism on any platform: it
 * starts a detached child with INHERITED stdio that outlives it, prints its answer and exits 0.
 *
 * The fake runs under `process.execPath` rather than as a shebang script, so this holds on
 * Windows too, where the bug lives.
 *
 * Lives in `src/` because the web unit project collects `src/**` only, and this must hold on the
 * fast gate (`npm test`), not only under `npm run test:e2e`.
 */
describe('runAgentBrowserCli', () => {
  let dir: string
  let lingeringPid: number | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xezar-agent-browser-cli-'))
    lingeringPid = undefined
  })

  afterEach(() => {
    // Stop only the one process this test's fake started, by the PID it recorded.
    if (lingeringPid !== undefined) {
      try {
        process.kill(lingeringPid)
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function fakeCli(body: string): string {
    const script = join(dir, 'fake-agent-browser.mjs')
    writeFileSync(script, body, 'utf8')
    return script
  }

  it('returns as soon as the CLI exits, while a daemon it started still holds its output', () => {
    const pidFile = join(dir, 'daemon.pid')
    const script = fakeCli(
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        // The "daemon": detached, inheriting this process's stdout/stderr, alive for 60 s.
        "const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'inherit' })",
        `writeFileSync(${JSON.stringify(pidFile)}, String(daemon.pid))`,
        'daemon.unref()',
        "process.stdout.write(JSON.stringify({ success: true, data: { url: 'about:blank' } }) + '\\n')",
      ].join('\n'),
    )

    const started = Date.now()
    let stdout: string
    try {
      stdout = runAgentBrowserCli(process.execPath, [script, '--session', 's', 'open', 'about:blank', '--json'], {
        timeout: 15_000,
      })
    } finally {
      try {
        lingeringPid = Number(readFileSync(pidFile, 'utf8'))
      } catch {
        /* the fake never got that far */
      }
    }
    const elapsed = Date.now() - started

    expect(JSON.parse(stdout)).toEqual({ success: true, data: { url: 'about:blank' } })
    // Through a pipe this call would block until the 15 s timeout; through files it returns
    // when the fake exits.
    expect(elapsed).toBeLessThan(10_000)
  }, 30_000)

  it('throws a non-zero exit with the CLI payload on `stdout`, the shape `execFileSync` threw', () => {
    const payload = { success: false, data: null, error: "Element '@e13' is covered by <a> at its click point" }
    const script = fakeCli(
      [
        `process.stdout.write(${JSON.stringify(JSON.stringify(payload))} + '\\n')`,
        "process.stderr.write('boom\\n')",
        'process.exit(1)',
      ].join('\n'),
    )

    let thrown: CliFailure | undefined
    try {
      runAgentBrowserCli(process.execPath, [script, 'click', '@e13'])
    } catch (error) {
      thrown = error as CliFailure
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.status).toBe(1)
    expect(JSON.parse(thrown?.stdout ?? '')).toEqual(payload)
    expect(thrown?.stderr).toContain('boom')
    expect(thrown?.message).toContain('Command failed')
  }, 30_000)

  it('still fails a CLI that itself hangs, after its timeout', () => {
    const script = fakeCli('setTimeout(() => {}, 60_000)')

    const started = Date.now()
    expect(() => runAgentBrowserCli(process.execPath, [script, 'wait'], { timeout: 1_000 })).toThrow(/Command failed/)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})

/**
 * Guard: every e2e call of the agent-browser binary goes through `runAgentBrowserCli`.
 *
 * Six specs used to call `execFileSync(readTestEnv().browser.command, …)` inline, and a new spec
 * copying that recipe would bring the Windows hang back for itself alone.
 */
describe('e2e agent-browser calls', () => {
  it('never read the browser CLI through a pipe outside agent-browser-cli.ts', () => {
    const e2eDir = resolve(import.meta.dirname, '../e2e')
    const offenders: string[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.ts$/.test(entry.name) && entry.name !== 'agent-browser-cli.ts') {
          const source = readFileSync(path, 'utf8')
          if (/\b(?:execFileSync|execSync|spawnSync|execFile|spawn)\(\s*(?:readTestEnv\(\)\.browser\.command|this\.bin|env\.browser\.command)/.test(source)) {
            offenders.push(path)
          }
        }
      }
    }
    walk(e2eDir)

    expect(offenders).toEqual([])
  })
})
