/**
 * The shell a workflow check step runs in (#963).
 *
 * Linux and macOS: `bash -lc <command>`, through `launch`, exactly as the call site did before.
 * Windows: Git for Windows' own `usr\bin\bash.exe -c <command>` (`gitRoot`, `launchMsys`), never
 * the first `bash.exe` on PATH – on a stock Windows that is WSL's, which runs the step in Linux
 * against a Windows working folder. `-c`, not `-lc`: a login shell there rebuilds PATH from the
 * user's profile, sets `TMP=/tmp` and runs profile scripts; `gitBashEnv` adds what the step needs
 * instead. Without Git Bash the start throws `CheckShellMissingError`, whose message names Git for
 * Windows, and nothing runs.
 *
 * `MSYS=noglob` is for that `bash.exe` alone: it stops the MSYS runtime globbing the step's own
 * command line. The step's command starts by putting `MSYS` back to the caller's value, so every program
 * the step starts runs as it would in a normal Git Bash – with `noglob` inherited, Git's `sh` stops
 * reading quotes, and a credential helper such as `"C:\Program Files\GitHub CLI\gh.exe"` splits at
 * its space (#1023).
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { win32 } from 'node:path';
import { GIT_BASH_MISSING, gitBashEnv, gitRoot, type GitBashDeps } from './git-bash.ts';
import { envValue } from './path-search.ts';
import { launch, launchMsys } from './process-launch.ts';

export class CheckShellMissingError extends Error {
  constructor() {
    super(GIT_BASH_MISSING);
    this.name = 'CheckShellMissingError';
  }
}

export interface CheckStepShellDeps extends GitBashDeps {
  platform?: NodeJS.Platform;
}

export function launchCheckStep(
  command: string,
  options: SpawnOptionsWithoutStdio & { env: NodeJS.ProcessEnv },
  deps: CheckStepShellDeps = {},
): ChildProcessWithoutNullStreams {
  if ((deps.platform ?? process.platform) !== 'win32') return launch('bash', ['-lc', command], options);
  const root = gitRoot(options.env, deps);
  if (root === null) throw new CheckShellMissingError();
  return launchMsys(win32.join(root, 'usr', 'bin', 'bash.exe'), `${restoreMsys(options.env)}${command}`, {
    ...options,
    env: gitBashEnv(root, options.env),
  });
}

/** The check step's first command: `MSYS` exactly as the caller had it, or unset (#1023). */
export function restoreMsys(env: NodeJS.ProcessEnv): string {
  const msys = envValue(env, 'MSYS', { platform: 'win32' });
  return msys === undefined ? 'unset MSYS; ' : `export MSYS='${msys.replaceAll("'", "'\\''")}'; `;
}
