/**
 * Where an ELEVATED xezar and leader meet on Windows (#980).
 *
 * The rendezvous folder of an elevated cockpit and leader must sit under a parent a NORMAL
 * (non-elevated) process of the same user cannot change — otherwise that process could rename the
 * folder aside and swap in one of its own between the elevated side's check and its use, steering an
 * elevated leader to a fake engine or making elevated xezar act on a folder of its choice. The
 * per-user `~/.xezar`/`.local/xezar` tree is user-owned, so it is the wrong place. `%ProgramData%`
 * is owned by SYSTEM with a protected access list; a normal user may CREATE a subfolder there but
 * cannot delete or rename one it does not own, and cannot touch an Administrators-owned, protected
 * folder at all. So the folder is:
 *
 *   `<SystemDrive>\ProgramData\xezar\ipc-admin\<userSID>\<scopeHash>`
 *
 * — created and owned by Administrators, private to SYSTEM and Administrators (`private-dir.ts`
 * verifies the whole chain and refuses a level a user pre-created or a reparse point planted). The
 * per-user-SID folder keeps two accounts' elevated engines apart while the machine-owned parents
 * keep a normal process out; the `<scopeHash>` leaf (a hash of the state scope, e.g. the user IPC
 * directory) keeps two homes or two single-project checkouts of the same user apart under the one
 * machine-wide tree, the way `ipcDir` already separates them in the per-user layout.
 *
 * The system drive is resolved WITHOUT the environment: `\\?\GLOBALROOT\SystemRoot` is the kernel's
 * own object path for the Windows directory, so an attacker cannot redirect it with `%SystemRoot%`.
 * Its real path's drive root gives `<SystemDrive>`. When any of this cannot be resolved the elevated
 * rendezvous is simply unavailable — the feature degrades, it never guesses.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { processUserSid } from './elevation.ts';
import { isDrivePath } from './path-syntax.ts';

/** The kernel object path for the Windows directory — resolvable with no environment. */
const GLOBALROOT_SYSTEMROOT = '\\\\?\\GLOBALROOT\\SystemRoot';
const PROGRAMDATA = 'ProgramData';
const XEZAR = 'xezar';
const IPC_ADMIN = 'ipc-admin';
/** A user SID, the only name trusted into a folder path. */
const SID_PATTERN = /^S-1-[\d-]+$/;
/** How many hex characters of the scope hash name the per-scope leaf. */
const SCOPE_HASH_LENGTH = 16;

/** Test seams. Production passes none. */
export interface ElevatedIpcDeps {
  platform?: NodeJS.Platform;
  /** Resolve the kernel's SystemRoot object to a real path, or null. Default: `realpathSync.native`. */
  realpath?: (path: string) => string | null;
  /** This process's user SID. Default: `processUserSid`. */
  sid?: string | null;
}

/**
 * The elevated rendezvous folder and the directories `private-dir.ts` must verify and create for it.
 *
 * - `dir`: the per-scope leaf the pipe files live in.
 * - `create`: the directories xezar owns and creates with its own access list, outermost first
 *   (`…\xezar`, `…\ipc-admin`, `…\<SID>`, the leaf). Each must end up owned by Administrators and private.
 * - `ancestors`: the machine-owned directories xezar only verifies (`%ProgramData%`): they must
 *   exist, be no reparse point, and be owned by SYSTEM, Administrators or TrustedInstaller.
 */
export interface ElevatedIpc {
  readonly dir: string;
  readonly create: readonly string[];
  readonly ancestors: readonly string[];
}

/** `<SystemDrive>\` resolved without the environment, or null when the kernel path cannot be read. */
export function systemDriveRoot(deps: ElevatedIpcDeps = {}): string | null {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const resolved = (deps.realpath ?? realGlobalRoot)(GLOBALROOT_SYSTEMROOT);
  if (resolved === null) return null;
  const root = win32.parse(resolved).root;
  return isDrivePath(root) ? root : null;
}

function realGlobalRoot(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The elevated rendezvous for this process and state `scope` (the user IPC directory, so two homes
 * or two single-project checkouts of the same user never share a folder), or null when it cannot be
 * located (not Windows, the system drive or the user SID could not be read). Null means the elevated
 * MCP is unavailable.
 */
export function resolveElevatedIpc(scope: string, deps: ElevatedIpcDeps = {}): ElevatedIpc | null {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const drive = systemDriveRoot(deps);
  if (drive === null) return null;
  const sid = deps.sid === undefined ? processUserSid() : deps.sid;
  if (sid === null || !SID_PATTERN.test(sid)) return null;
  const programData = win32.join(drive, PROGRAMDATA);
  const xezar = win32.join(programData, XEZAR);
  const ipcAdmin = win32.join(xezar, IPC_ADMIN);
  const perUser = win32.join(ipcAdmin, sid);
  const leaf = win32.join(perUser, scopeHash(scope));
  return { dir: leaf, create: [xezar, ipcAdmin, perUser, leaf], ancestors: [programData] };
}

/** A stable short name for a state scope, so the leaf never carries a raw path. */
function scopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, SCOPE_HASH_LENGTH);
}
