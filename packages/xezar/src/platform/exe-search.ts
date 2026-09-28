/**
 * Stop Windows from running a program found in the working folder (#963).
 *
 * Windows looks for a bare program name (`git`) in the child's working folder BEFORE the PATH, so a
 * repository that commits a `git.exe` would have it run the first time xezar called Git there.
 * libuv decides by asking `NeedCurrentDirectoryForExePathW`, which reads THIS process's environment
 * – the `env` passed to a child does not change how xezar finds the child – so the variable is set
 * here, once, for the whole process. A child inherits it only when its environment carries it:
 * `buildChildEnv` (core/agent-env.ts) builds agent environments from an allowlist, so it puts the
 * variable back with `hardenChildExecutableSearch`, or the agent and the programs it starts in the
 * task's working copy (git, rg) would search that folder first.
 *
 * Importing this module applies it: it must stay the FIRST import of `src/index.ts`, ahead of every
 * module that can start a process. POSIX: nothing happens.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */

const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

/** win32: set `NoDefaultCurrentDirectoryInExePath` unless it is already set. POSIX: no change. */
export function hardenExecutableSearch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') env.NoDefaultCurrentDirectoryInExePath ??= '1';
}

/**
 * win32: force `NoDefaultCurrentDirectoryInExePath=1` in a child's environment, under exactly one
 * spelling – Windows reads variable names without case, so any other spelling is removed first.
 * POSIX: no change, so the environment stays exactly as built.
 */
export function hardenChildExecutableSearch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return;
  const upper = VARIABLE.toUpperCase();
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === upper) delete env[name];
  }
  env[VARIABLE] = '1';
}

hardenExecutableSearch();
