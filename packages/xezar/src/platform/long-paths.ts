/**
 * Are long file paths turned on? (#963) Windows only.
 *
 * Windows refuses paths longer than 260 characters unless the LongPathsEnabled setting is on, and
 * Git for Windows refuses them unless `core.longpaths` is on – and the working copies xezar makes for
 * tasks sit several folders deep. Node's own file calls are not affected (they use the `\\?\`
 * form), so the risk is Git. This module reads both settings once, off the start-up path, and turns
 * "off" into one plain sentence with the fix. "Unknown" (a missing program, a refusal, a timeout)
 * is never reported: only a setting known to be off is.
 *
 * Nothing here starts a process on Linux or macOS.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { isDrivePath } from './path-syntax.ts';

export type LongPathState = 'on' | 'off' | 'unknown';
/** A finished probe. `exitCode` null = it did not finish (not found, timed out, killed). */
export interface ProbeOutcome {
  exitCode: number | null;
  stdout: string;
}
/** Runs one program without a shell. Never rejects. */
export type ProbeRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<ProbeOutcome>;

export const LONG_PATH_PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BUFFER = 256 * 1024;
const FILESYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';
/** reg.exe prints the key as `HKEY_LOCAL_MACHINE\SYSTEM\…`: match the part after the hive. */
const FILESYSTEM_KEY_HEADER = 'system\\currentcontrolset\\control\\filesystem';
const GIT_TURN_ON = 'git config --global core.longpaths true';

/** The fix, shared by the start-up line and a task's failure reason. */
export const LONG_PATHS_FIX =
  `An administrator can turn on the Windows setting LongPathsEnabled (${FILESYSTEM_KEY}), ` +
  `and "${GIT_TURN_ON}" turns long paths on for Git.`;

/**
 * `%SystemRoot%\System32\reg.exe`, or null unless SystemRoot is a drive path (`C:\Windows`). A
 * relative, UNC or device root would let the environment pick which program runs.
 */
export function regExePath(env: NodeJS.ProcessEnv): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root || !isDrivePath(root)) return null;
  return win32.join(root, 'System32', 'reg.exe');
}

/** `reg query <FileSystem key>`: the whole key, so "value absent" (off) and "key unreadable"
 *  (unknown) stay distinct. Value names and types are never translated, so this is language-safe. */
export function parseLongPathsRegistry(outcome: ProbeOutcome): LongPathState {
  if (outcome.exitCode !== 0) return 'unknown';
  if (!outcome.stdout.toLowerCase().includes(FILESYSTEM_KEY_HEADER)) return 'unknown';
  const match = /^\s*LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(outcome.stdout);
  if (!match) return 'off';
  return Number.parseInt(match[1]!, 16) === 0 ? 'off' : 'on';
}

/** `git config --type=bool --get core.longpaths`: exit 1 means unset, which Git treats as off. */
export function parseGitLongPaths(outcome: ProbeOutcome): LongPathState {
  if (outcome.exitCode === 1) return 'off';
  if (outcome.exitCode !== 0) return 'unknown';
  const value = outcome.stdout.trim();
  if (value === 'true') return 'on';
  if (value === 'false') return 'off';
  return 'unknown';
}

/** The one warning, or null when nothing is KNOWN to be off. */
export function longPathNoticeText(windows: LongPathState, git: LongPathState): string | null {
  const opening = (where: string): string =>
    `Long file paths are off ${where}, so deep folders, such as the working copies xezar makes for tasks, ` +
    'can fail with "Filename too long".';
  if (windows === 'off' && git === 'off') return `${opening('on this computer')} ${LONG_PATHS_FIX}`;
  if (windows === 'off') {
    return `${opening('in Windows')} An administrator can turn on the Windows setting LongPathsEnabled (${FILESYSTEM_KEY}).`;
  }
  if (git === 'off') return `${opening('in Git')} Run "${GIT_TURN_ON}".`;
  return null;
}

export interface LongPathNotice {
  message: string;
  windows: LongPathState;
  git: LongPathState;
}

/** The runner `probeLongPathNotice` uses unless a test passes its own: execFile without a shell,
 *  hidden window, 256 KiB cap; no error → 0, a numeric exit code → that code, anything else
 *  (not found, timed out, killed) → null. Never rejects. */
export const defaultProbeRunner: ProbeRunner = (file, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    try {
      execFile(
        file,
        [...args],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: PROBE_MAX_BUFFER },
        (error, stdout) => {
          const out = typeof stdout === 'string' ? stdout : '';
          if (!error) return resolvePromise({ exitCode: 0, stdout: out });
          const code = (error as { code?: unknown }).code;
          const killed = (error as { killed?: boolean }).killed === true;
          resolvePromise({ exitCode: typeof code === 'number' && !killed ? code : null, stdout: out });
        },
      );
    } catch {
      resolvePromise({ exitCode: null, stdout: '' });
    }
  });

/** Test seams for the probe. Production passes none. */
export interface LongPathProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ProbeRunner;
  timeoutMs?: number;
}

/**
 * Read both settings for `repoRoot` and answer the warning to print, if any. Off Windows: null at
 * once, without starting any process. Never rejects.
 */
export async function probeLongPathNotice(
  repoRoot: string,
  deps: LongPathProbeDeps = {},
): Promise<LongPathNotice | null> {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const run = deps.run ?? defaultProbeRunner;
  const timeoutMs = deps.timeoutMs ?? LONG_PATH_PROBE_TIMEOUT_MS;
  const safely = async (file: string, args: readonly string[]): Promise<ProbeOutcome> => {
    try {
      return await run(file, args, timeoutMs);
    } catch {
      return { exitCode: null, stdout: '' };
    }
  };
  const reg = regExePath(deps.env ?? process.env);
  const [windowsOutcome, gitOutcome] = await Promise.all([
    reg ? safely(reg, ['query', FILESYSTEM_KEY]) : Promise.resolve<ProbeOutcome>({ exitCode: null, stdout: '' }),
    safely('git', ['-C', repoRoot, 'config', '--type=bool', '--get', 'core.longpaths']),
  ]);
  const windows = parseLongPathsRegistry(windowsOutcome);
  const git = parseGitLongPaths(gitOutcome);
  const message = longPathNoticeText(windows, git);
  return message ? { message, windows, git } : null;
}

/** The start-up line for a notice, in the shape the terminal log takes (`event=windows.longpaths
 *  windows=<state> git=<state>`). */
export interface LongPathNoticeLine {
  level: 'warn';
  subject: 'windows';
  message: string;
  event: 'windows.longpaths';
  fields: [readonly ['windows', LongPathState], readonly ['git', LongPathState]];
}

/**
 * The `xezar serve` start-up check: returns at once and, on Windows, probes on the next turn of the
 * event loop – after the boot code that called it – and hands `report` one line when a setting is
 * known to be off. Never awaited, so it cannot delay start-up. Off Windows nothing is scheduled and
 * nothing starts. Never throws; a `report` that throws is swallowed, so it cannot become an
 * unhandled rejection.
 */
export function startLongPathNotice(
  repoRoot: string,
  report: (line: LongPathNoticeLine) => void,
  deps: LongPathProbeDeps = {},
): void {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  setImmediate(() => {
    void probeLongPathNotice(repoRoot, deps)
      .then((notice) => {
        if (!notice) return;
        report({
          level: 'warn',
          subject: 'windows',
          message: notice.message,
          event: 'windows.longpaths',
          fields: [['windows', notice.windows], ['git', notice.git]],
        });
      })
      .catch(() => {});
  });
}

/** Git's "Filename too long". Git for Windows prints it when a path passes the 260-character limit
 *  and `core.longpaths` or the Windows setting is off. */
const GIT_TOO_LONG = /\bFilename too long\b/i;
/** Node's ENAMETOOLONG. Node's own file calls already pass the 260-character limit (the `\\?\`
 *  form), so this is a limit the long-path settings do not lift, such as a name over 255 characters. */
const NODE_TOO_LONG = /\bENAMETOOLONG\b/i;

/** Git's "Filename too long" or Node's ENAMETOOLONG. */
export function isPathTooLong(text: string): boolean {
  return GIT_TOO_LONG.test(text) || NODE_TOO_LONG.test(text);
}

/**
 * win32: append a hint to a failure detail that says a path was too long. Git's "Filename too long"
 * gets the long-path fix; a bare ENAMETOOLONG gets only "shorten it", because turning long file paths
 * on does not lift that limit. Otherwise, and on every other platform, the detail is unchanged.
 */
export function withLongPathHint(detail: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return detail;
  if (GIT_TOO_LONG.test(detail)) {
    return `${detail}. This path is too long for Windows; long file paths may be off. ${LONG_PATHS_FIX}`;
  }
  if (NODE_TOO_LONG.test(detail)) {
    return `${detail}. This path, or a name in it, is too long for Windows; a shorter folder or file name avoids it.`;
  }
  return detail;
}
