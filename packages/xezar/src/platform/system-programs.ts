/**
 * Where Windows keeps its own programs (#963).
 *
 * xezar starts a few Windows programs itself – `reg.exe`, `cmd.exe`, `powershell.exe` – and must
 * never let the environment or the PATH pick which file that is. `%SystemRoot%\System32` is the
 * one trusted place, and only when SystemRoot is a plain drive path: a relative, UNC or device
 * root would hand that choice back to whoever set the variable. The one exception is the process
 * table read, which searched PATH before #963 and still may – see `powershellPath`.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { envValue, firstOnPath } from './path-search.ts';
import { isDrivePath } from './path-syntax.ts';

/** `WindowsPowerShell\v1.0\powershell.exe`, relative to System32. */
export const POWERSHELL_IN_SYSTEM32 = 'WindowsPowerShell\\v1.0\\powershell.exe';

const POWERSHELL_EXE = 'powershell.exe';

/**
 * `%SystemRoot%\System32\<name>`, or null unless SystemRoot is a drive path (`C:\Windows`).
 * `name` is a constant chosen by xezar, never user input.
 */
export function system32Program(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !isDrivePath(root)) return null;
  return win32.join(root, 'System32', name);
}

/** Test seams for `powershellPath`. Production passes none. */
export interface PowershellPathDeps {
  exists?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Windows PowerShell, by the one policy every PowerShell start shares (#963): `%SystemRoot%\System32`
 * when SystemRoot is a drive path, and otherwise null – the identified kill and the command-line
 * reader then degrade rather than run a PowerShell someone else chose.
 *
 * `searchPath` is for the process-table read alone. It started a bare `powershell` before #963,
 * and the sampler and memory guard depend on it, so without a usable SystemRoot it still finds
 * one – but only as the first `powershell.exe` in a fully-qualified PATH entry: never a relative
 * entry and never the working folder (SEC-9), which a bare name handed to Node would still reach.
 */
export function powershellPath(
  env: NodeJS.ProcessEnv = process.env,
  opts: { searchPath?: boolean } = {},
  deps: PowershellPathDeps = {},
): string | null {
  const system = system32Program(POWERSHELL_IN_SYSTEM32, env);
  if (system !== null || opts.searchPath !== true) return system;
  const searchPath = envValue(env, 'PATH', { platform: 'win32' }) ?? '';
  const hit = firstOnPath([POWERSHELL_EXE], searchPath, {
    delimiter: ';',
    join: win32.join,
    exists: deps.exists ?? isFile,
    skipRelative: true,
    platform: 'win32',
  });
  return hit?.path ?? null;
}
