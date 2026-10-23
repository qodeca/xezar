import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One synchronous agent-browser CLI call, with its output read from FILES, never from a pipe.
 *
 * The first command of a session starts agent-browser's long-lived background daemon (and Chrome).
 * On Windows that daemon inherits the CLI's stdout/stderr handles. When those handles are pipes —
 * which is what `execFileSync`/`spawnSync` give a child by default — the caller waits for
 * end-of-file on a pipe the daemon keeps open for the rest of the session, so a command that
 * printed its answer and exited 0 still "times out" (`spawnSync … ETIMEDOUT`). Measured with
 * agent-browser 0.39.1 on Windows 11: `open about:blank` through a pipe hit its full 20 s timeout
 * with `status: 0` and the JSON answer already on stdout; the same call with files returned in
 * 1.5 s. A daemon that inherits a FILE handle holds nothing the caller waits on: `spawnSync`
 * returns when the CLI process itself exits, and the answer is read from the file afterwards.
 *
 * One code path on every platform, so CI (Linux) exercises the same mechanism a Windows run uses.
 *
 * The failure shape matches `execFileSync`'s on purpose: a non-zero exit, a signal or a timeout
 * throws an Error carrying `stdout`, `stderr`, `status` and `signal`, because callers read the
 * CLI's own `{"success":false,…}` payload off `cause.stdout` (`guide-browser.ts`
 * `cliFailureDetail`).
 */
export type CliFailure = Error & {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
}

export function runAgentBrowserCli(
  command: string,
  args: readonly string[],
  { timeout = 60_000 }: { timeout?: number } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'xezar-agent-browser-'))
  const outPath = join(dir, 'stdout')
  const errPath = join(dir, 'stderr')
  const out = openSync(outPath, 'w')
  const err = openSync(errPath, 'w')
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(command, args, { stdio: ['ignore', out, err], timeout, windowsHide: true })
  } finally {
    closeSync(out)
    closeSync(err)
  }
  const stdout = readFileSync(outPath, 'utf8')
  const stderr = readFileSync(errPath, 'utf8')
  // Best effort: on Windows a daemon this call started may still hold the handles open, and a
  // leftover pair of small files in the OS temp folder must never fail a browser command.
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* left for the OS temp cleanup */
  }

  if (result.error !== undefined || result.status !== 0) {
    const reason =
      result.error !== undefined
        ? result.error.message
        : result.signal !== null
          ? `killed by ${result.signal}`
          : `exit code ${result.status}`
    const failure = new Error(
      `Command failed: ${command} ${args.join(' ')} (${reason})${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
      { cause: result.error },
    ) as CliFailure
    failure.stdout = stdout
    failure.stderr = stderr
    failure.status = result.status
    failure.signal = result.signal
    throw failure
  }
  return stdout
}
