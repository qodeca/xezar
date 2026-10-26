/**
 * Does this process run as administrator (an elevated Windows token)? (#980)
 *
 * The MCP rendezvous folder depends on the answer: an elevated cockpit and an elevated leader meet
 * in their own administrators-only folder (`ipc-admin`), never in the user's `ipc`. The folder is
 * chosen before anything is read from it, so the answer is needed before the access-list check –
 * which reads elevation once more and refuses when the two disagree (`private-dir.ts`).
 *
 * One `whoami /groups` from System32, read once per process (a token's elevation never changes):
 * the High (S-1-16-12288) or System (S-1-16-16384) integrity label is what an elevated token
 * carries. SIDs only, never group names, which Windows translates. Linux and macOS: always false –
 * the rendezvous there is a 0700 folder and a 0600 socket, whoever runs it. A probe that fails is
 * "not elevated": the access-list check then refuses an elevated process in the user's folder.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { launchFileSync } from './process-launch.ts';
import { system32Program } from './system-programs.ts';

const PROBE_TIMEOUT_MS = 5_000;
const ELEVATED_LABELS = ['S-1-16-12288', 'S-1-16-16384'];

/** Test seams. Production passes none. */
export interface ElevationDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `whoami /groups /fo csv /nh`'s output, or null when it could not run. */
  whoami?: (path: string) => string | null;
}

/** Is an elevated integrity label in this `whoami /groups /fo csv /nh` output? */
export function whoamiSaysElevated(output: string): boolean {
  return output.split(/\r?\n/).some((line) => ELEVATED_LABELS.some((label) => line.includes(`"${label}"`)));
}

function runWhoami(path: string): string | null {
  try {
    return launchFileSync(path, ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** The uncached answer. */
export function probeElevation(deps: ElevationDeps = {}): boolean {
  if ((deps.platform ?? process.platform) !== 'win32') return false;
  const whoami = system32Program('whoami.exe', deps.env ?? process.env);
  if (whoami === null) return false;
  const output = (deps.whoami ?? runWhoami)(whoami);
  return output !== null && whoamiSaysElevated(output);
}

let cached: boolean | undefined;

/** This process's answer, probed on first use. */
export function processIsElevated(): boolean {
  cached ??= probeElevation();
  return cached;
}
