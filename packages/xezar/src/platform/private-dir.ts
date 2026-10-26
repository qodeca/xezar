/**
 * A folder only the current user can reach – the MCP rendezvous folder (#963).
 *
 * Linux and macOS: `mkdir 0700`, then `chmod 0700` (mkdir leaves an existing folder's mode
 * alone) – exactly what `mcp/service.ts` did before this module.
 *
 * Windows has no mode bits. One PowerShell run (System32, hidden, bounded):
 *   1. reads the current user's SID, whether this process is elevated, and the volume's kind;
 *   2. in `ensure` mode, replaces the folder's access list with Full Control for the user,
 *      SYSTEM and Administrators only, inheritance from the parent cut;
 *   3. reads every given path's owner and access list back as SDDL.
 * The answer is judged by SIDs only, never by account names, which Windows translates. The
 * folder and every file in it must be OWNED by the current user, and no access entry may name
 * anyone but the user, SYSTEM or Administrators. A folder that is a link or junction, on a network
 * share, or on a file system without access lists is refused. A lookup that fails, or answers
 * nothing, is "not private".
 *
 * An elevated process (#980) uses its own folder, private to ADMINISTRATORS rather than to the user
 * (`elevated: true`; the caller picks the folder with `platform/elevation.ts`). In `ensure` mode the
 * folder gets Full Control for SYSTEM and Administrators only, plus an OWNER RIGHTS entry that
 * leaves an owner nothing but reading the access list, and Administrators as its owner. A
 * non-elevated process holds Administrators for deny only, so it can neither write there nor own
 * what it plants: the folder must be owned by Administrators, and a file by Administrators – or by
 * the user (the built-in Administrator, or a policy that makes the creator the owner) only while the
 * OWNER RIGHTS entry takes away an owner's right to change its access list. No access entry may name
 * the user. A folder that was not yet Administrators-owned is emptied before it is taken over, so
 * nothing planted earlier survives into it. The elevation the check reads must match the folder's
 * kind, or the folder is refused. The standard folder's rules did not change.
 *
 * Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { Buffer } from 'node:buffer';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { defaultTableRunner, fileTimeToMs, powershellArgs, type TableRunner } from './process-table.ts';
import { powershellPath } from './system-programs.ts';

/** Why a folder is not private enough for a rendezvous. */
export type PrivateDirReason =
  | 'reparse-point'
  | 'network-drive'
  | 'not-ntfs'
  | 'sid-lookup-failed'
  | 'elevated'
  | 'not-elevated'
  | 'foreign-owner'
  | 'not-private';

/** `startedAt`: when asked (`startTimeOf`), that process's start time in ms since the epoch, or
 *  null when it is not running. */
export type PrivateDirResult =
  | { ok: true; startedAt?: number | null }
  | { ok: false; reason: PrivateDirReason; message: string };

/** What else the same PowerShell run reads. */
export interface PrivateDirOptions {
  /** Windows: also read this process's start time (one run instead of two). */
  startTimeOf?: number;
  /**
   * Windows (#980): the folder is the administrators-only one an elevated process uses. Default
   * false: the user's own folder, judged exactly as before #980. The check refuses a process whose
   * elevation does not match.
   */
  elevated?: boolean;
}

/** Test seams. Production passes none. */
export interface PrivateDirDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: TableRunner;
  /** Is this path a symbolic link or junction? Default: `lstat`. */
  isLink?: (path: string) => Promise<boolean>;
}

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
/** OWNER RIGHTS: present in an access list, it replaces what an owner may do implicitly. */
const OWNER_RIGHTS = 'S-1-3-4';
/** SDDL's own short names for the well-known SIDs. */
const ALIASES: Readonly<Record<string, string>> = { SY: SYSTEM, BA: ADMINISTRATORS, OW: OWNER_RIGHTS };
/**
 * The only rights an OWNER RIGHTS entry may grant in the administrators-only folder: reading the
 * access list (READ_CONTROL, with the SYNCHRONIZE .NET adds to every allow entry). Never WRITE_DAC.
 */
const OWNER_RIGHTS_MASKS: ReadonlySet<string> = new Set(['RC', '0x20000', '0x120000']);
const ACL_TIMEOUT_MS = 15_000;
/** Tests only: the second read on a loaded CI runner (`PATIENT_ACL_READ_FOR_TESTS`). */
const ACL_TEST_RETRY_TIMEOUT_MS = 60_000;
const ACL_MAX_BUFFER = 1024 * 1024;

const MESSAGES: Readonly<Record<PrivateDirReason, string>> = {
  'reparse-point': 'is a link or junction',
  'network-drive': 'is on a network drive',
  'not-ntfs': 'is on a file system without access lists (NTFS or ReFS is needed)',
  'sid-lookup-failed': "could not be checked: the current user's identity could not be read",
  elevated: 'is for xezar without administrator rights, and this process runs as administrator',
  'not-elevated': 'is for xezar running as administrator, and this process runs without administrator rights',
  'foreign-owner': 'is owned by another account',
  'not-private': 'is not private to the current user',
};

function refuse(reason: PrivateDirReason, path: string): PrivateDirResult {
  return { ok: false, reason, message: `The private folder ${path} ${MESSAGES[reason]}.` };
}

/** The environment variable that carries one run's input to `ACL_SCRIPT`. */
export const ACL_INPUT_ENV = 'PRIVATE_DIR_INPUT';

/**
 * The one script, FIXED text: its input comes through `ACL_INPUT_ENV` as base64 JSON
 * `{ paths, ensure, pid }` (plus `admin: true` for the administrators-only folder, #980), so no
 * path can break out of a string – and a script whose text never
 * changes is scanned once, not on every run (a new script text measured about 4 s on first run
 * here, the same text 0.6 s). The first path is the folder, the rest are files in it. One line
 * per fact: `sid`, `elevated`, `drive`, `started` (when a pid is asked), then `sddl <i>`.
 */
export const ACL_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  `$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PRIVATE_DIR_INPUT)) | ConvertFrom-Json`,
  '$paths = @($in.paths | ForEach-Object { [string]$_ })',
  '$id = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '"sid $($id.User.Value)"',
  '$elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  '"elevated $elevated"',
  'try { $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($paths[0])); "drive $($drive.DriveType) $($drive.DriveFormat)" } catch { "drive Unknown -" }',
  // The process API, not WMI: a second faster, and the same clock on both sides.
  'if ([int]$in.pid -gt 0) { try { "started $([Diagnostics.Process]::GetProcessById([int]$in.pid).StartTime.ToFileTimeUtc())" } catch { "started -" } }',
  // #980: the administrators-only folder, set only by an elevated process. The access list first –
  // it locks a non-elevated owner out – then a folder not yet owned by Administrators is emptied
  // and taken over; one that cannot be emptied keeps its owner, which the check refuses.
  'if ($in.ensure -eq $true -and $in.admin -eq $true) {',
  '  if ($elevated) {',
  '    $dir = New-Object IO.DirectoryInfo($paths[0])',
  '    $acl = New-Object Security.AccessControl.DirectorySecurity',
  '    $acl.SetAccessRuleProtection($true, $false)',
  `    foreach ($sid in @('${SYSTEM}', '${ADMINISTRATORS}')) {`,
  "      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  '    }',
  `    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('${OWNER_RIGHTS}')), 'ReadPermissions', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))`,
  '    $dir.SetAccessControl($acl)',
  `    if ($dir.GetAccessControl('Owner').GetOwner([Security.Principal.SecurityIdentifier]).Value -ne '${ADMINISTRATORS}') {`,
  '      foreach ($child in @($dir.GetFileSystemInfos())) { try { if ($child -is [IO.DirectoryInfo]) { $child.Delete($true) } else { $child.Delete() } } catch { } }',
  '      if (@($dir.GetFileSystemInfos()).Count -eq 0) {',
  '        $own = New-Object Security.AccessControl.DirectorySecurity',
  `        $own.SetOwner((New-Object Security.Principal.SecurityIdentifier('${ADMINISTRATORS}')))`,
  '        $dir.SetAccessControl($own)',
  '      }',
  '    }',
  '  }',
  '} elseif ($in.ensure -eq $true) {',
  '  $acl = New-Object Security.AccessControl.DirectorySecurity',
  '  $acl.SetAccessRuleProtection($true, $false)',
  `  foreach ($sid in @($id.User.Value, '${SYSTEM}', '${ADMINISTRATORS}')) {`,
  "    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  '  }',
  '  (New-Object IO.DirectoryInfo($paths[0])).SetAccessControl($acl)',
  '}',
  'for ($i = 0; $i -lt $paths.Count; $i++) {',
  "  $sections = [Security.AccessControl.AccessControlSections]'Access,Owner'",
  '  if ($i -eq 0) { $s = New-Object Security.AccessControl.DirectorySecurity($paths[$i], $sections) } else { $s = New-Object Security.AccessControl.FileSecurity($paths[$i], $sections) }',
  '  "sddl $i $($s.GetSecurityDescriptorSddlForm($sections))"',
  '}',
].join('\n');

/** One run's input for `ACL_SCRIPT`: base64 of JSON. Only a positive safe integer is a pid. */
export function aclInput(paths: readonly string[], ensure: boolean, startTimeOf?: number, admin = false): string {
  const pid = startTimeOf !== undefined && Number.isSafeInteger(startTimeOf) && startTimeOf > 0 ? startTimeOf : 0;
  return Buffer.from(JSON.stringify(admin ? { paths, ensure, pid, admin } : { paths, ensure, pid }), 'utf8').toString('base64');
}

/** What one run of the script said. */
export interface AclReport {
  sid?: string;
  elevated?: boolean;
  driveType?: string;
  driveFormat?: string;
  sddl: Map<number, string>;
  /** Absent: not asked; null: not running. */
  startedAt?: number | null;
}

export function parseAclReport(text: string): AclReport {
  const report: AclReport = { sddl: new Map() };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let match: RegExpExecArray | null;
    if ((match = /^sid (S-1-[\d-]+)$/.exec(line))) report.sid = match[1];
    else if ((match = /^elevated (True|False)$/.exec(line))) report.elevated = match[1] === 'True';
    else if ((match = /^drive (\S+) (\S+)$/.exec(line))) [report.driveType, report.driveFormat] = [match[1], match[2]];
    else if ((match = /^sddl (\d+) (\S+)$/.exec(line))) report.sddl.set(Number(match[1]), match[2]!);
    else if ((match = /^started (\d+|-)$/.exec(line))) report.startedAt = match[1] === '-' ? null : (fileTimeToMs(match[1]) ?? null);
  }
  return report;
}

const sidOf = (token: string): string => ALIASES[token] ?? token;

/**
 * Whose folder is judged: `user` – the user's own (the rule since #963); `admin` – the
 * administrators-only folder of an elevated process (#980).
 */
export type PrivateDirMode = 'user' | 'admin';

/**
 * One SDDL string, judged for `user`: `owner` – owned by the user; `not-private` – an access entry
 * of a kind other than allow/deny, or one that names anyone but the user, SYSTEM or
 * Administrators, or (for the folder) a list still inheriting from its parent; null – fine.
 *
 * `admin` mode (#980): the folder must be owned by Administrators; a file by Administrators, or by
 * the user only while an OWNER RIGHTS entry is present. An allow entry may name only SYSTEM,
 * Administrators, or OWNER RIGHTS with read-the-access-list rights; never the user. The built-in
 * Administrator's own alias `LA` is the user when the user is that account (`-500`).
 */
export function judgeSddl(sddl: string, user: string, isFolder: boolean, mode: PrivateDirMode = 'user'): 'foreign-owner' | 'not-private' | null {
  if (mode === 'admin') return judgeAdminSddl(sddl, user, isFolder);
  const owner = /^O:(S-1-[\d-]+|[A-Z]{2})/.exec(sddl)?.[1];
  if (owner === undefined || sidOf(owner) !== user) return 'foreign-owner';
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) return 'not-private';
  if (isFolder && !dacl[1]!.includes('P')) return 'not-private';
  const aces = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.split(';'));
  if (aces.length === 0) return 'not-private';
  const allowed = new Set([user, SYSTEM, ADMINISTRATORS]);
  for (const ace of aces) {
    if (ace.length !== 6) return 'not-private';
    const [type, , , , , sid] = ace as [string, string, string, string, string, string];
    if (type === 'D') continue; // a deny entry grants nothing
    if (type !== 'A' || !allowed.has(sidOf(sid))) return 'not-private';
  }
  return null;
}

function judgeAdminSddl(sddl: string, user: string, isFolder: boolean): 'foreign-owner' | 'not-private' | null {
  const sid = (token: string): string => (token === 'LA' && user.endsWith('-500') ? user : sidOf(token));
  const ownerToken = /^O:(S-1-[\d-]+|[A-Z]{2})/.exec(sddl)?.[1];
  if (ownerToken === undefined) return 'foreign-owner';
  const owner = sid(ownerToken);
  if (owner !== ADMINISTRATORS && (isFolder || owner !== user)) return 'foreign-owner';
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) return 'not-private';
  if (isFolder && !dacl[1]!.includes('P')) return 'not-private';
  const aces = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.split(';'));
  if (aces.length === 0) return 'not-private';
  let ownerRightsLimited = false;
  for (const ace of aces) {
    if (ace.length !== 6) return 'not-private';
    const [type, , rights, , , who] = ace as [string, string, string, string, string, string];
    if (type === 'D') continue; // a deny entry grants nothing
    if (type !== 'A') return 'not-private';
    const named = sid(who);
    if (named === SYSTEM || named === ADMINISTRATORS) continue;
    if (named === OWNER_RIGHTS && OWNER_RIGHTS_MASKS.has(rights)) {
      ownerRightsLimited = true;
      continue;
    }
    return 'not-private';
  }
  // An owner may always change its access list unless OWNER RIGHTS says otherwise – and a
  // non-elevated process of the same user would hold that right over a user-owned file.
  if (owner === user && !ownerRightsLimited) return 'not-private';
  return null;
}

/**
 * The verdict on one report for `paths` (the folder first). The rules follow the elevation the
 * report read (#980); `elevated` says which kind of folder `paths[0]` is, and a report whose
 * elevation is not that kind – or is unknown – is refused.
 */
export function judgeAclReport(report: AclReport, paths: readonly string[], elevated = false): PrivateDirResult {
  const folder = paths[0]!;
  if (report.sid === undefined) return refuse('sid-lookup-failed', folder);
  if (report.elevated !== elevated) return refuse(elevated ? 'not-elevated' : 'elevated', folder);
  const mode: PrivateDirMode = report.elevated ? 'admin' : 'user';
  if (report.driveType === 'Network') return refuse('network-drive', folder);
  if (report.driveFormat !== 'NTFS' && report.driveFormat !== 'ReFS') return refuse('not-ntfs', folder);
  for (let i = 0; i < paths.length; i++) {
    const sddl = report.sddl.get(i);
    if (sddl === undefined) return refuse('not-private', folder);
    const verdict = judgeSddl(sddl, report.sid, i === 0, mode);
    if (verdict !== null) return refuse(verdict, i === 0 ? folder : paths[i]!);
  }
  return report.startedAt === undefined ? { ok: true } : { ok: true, startedAt: report.startedAt };
}

const defaultIsLink = async (path: string): Promise<boolean> => (await lstat(path)).isSymbolicLink();

function isUncPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

async function windowsCheck(paths: readonly string[], ensure: boolean, deps: PrivateDirDeps, options: PrivateDirOptions): Promise<PrivateDirResult> {
  const folder = paths[0]!;
  if (isUncPath(folder)) return refuse('network-drive', folder);
  try {
    if (await (deps.isLink ?? defaultIsLink)(folder)) return refuse('reparse-point', folder);
  } catch {
    return refuse('not-private', folder);
  }
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return refuse('not-private', folder);
  const elevated = options.elevated === true;
  const env = { ...(deps.env ?? process.env), [ACL_INPUT_ENV]: aclInput(paths, ensure, options.startTimeOf, elevated) };
  let failure: unknown = null;
  const readAcl = (timeoutMs: number): Promise<string | null> =>
    (deps.run ?? defaultTableRunner)(powershell, powershellArgs(ACL_SCRIPT), {
      maxBuffer: ACL_MAX_BUFFER,
      timeoutMs,
      hide: true,
      env,
    }).catch((error: unknown) => {
      failure = error;
      return null;
    });
  let text = await readAcl(ACL_TIMEOUT_MS);
  const testRun = deps.run === undefined && patientForTests();
  // A fully loaded CI runner can keep PowerShell past the limit: tests read once more (#963), with
  // more time – the Windows Node 22 leg kept missing 15 s twice in a row under a full suite.
  if (text === null && testRun) text = await readAcl(ACL_TEST_RETRY_TIMEOUT_MS);
  if (text === null) {
    const refused = refuse('not-private', folder);
    // On a CI runner, say why: "not private" for a PowerShell that never answered hid the cause.
    if (!patientForTests() || refused.ok) return refused;
    const why = failure instanceof Error ? failure.message : String(failure);
    return { ...refused, message: `${refused.message} [test: PowerShell gave no access list: ${why.slice(0, 300)}]` };
  }
  const report = parseAclReport(text);
  const verdict = judgeAclReport(report, paths, elevated);
  // A CI runner's account is not one we can inspect by hand: say what the check saw.
  if (testRun && !verdict.ok && report.sid !== undefined) {
    return { ...verdict, message: `${verdict.message} [test: elevated ${String(report.elevated)}; sddl ${[...report.sddl.values()].join(' | ')}; sid suffix ${report.sid.split('-').pop()}]` };
  }
  return verdict;
}

/**
 * Tests only: the unit suite's setup sets this global flag (a flag, not an import, so the setup
 * loads no module before a test mocks what it uses). A live check then reads the access list once
 * more on a loaded runner, and says what it saw when it refuses. The rules never change with it:
 * an elevated CI runner is checked as the elevated process it is (#980).
 */
export const PATIENT_ACL_READ_FOR_TESTS = Symbol.for('xezar.test.patientAclRead');

function patientForTests(): boolean {
  return (globalThis as Record<symbol, unknown>)[PATIENT_ACL_READ_FOR_TESTS] === true;
}

/**
 * Create `dir` if needed and make it private to the current user (or, with `options.elevated`, to
 * Administrators – #980). POSIX: mkdir 0700 + chmod 0700, throwing as `fs` does. Windows: the
 * access list above, answered as a result, never thrown.
 */
export async function ensurePrivateDir(dir: string, deps: PrivateDirDeps = {}, options: PrivateDirOptions = {}): Promise<PrivateDirResult> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((deps.platform ?? process.platform) !== 'win32') {
    // mkdir leaves an existing directory's mode alone; this one is ours alone.
    await chmod(dir, 0o700);
    return { ok: true };
  }
  return windowsCheck([dir], true, deps, options);
}

/**
 * Windows: is `dir` still private, and is every file in `files` owned by the user and private?
 * Changes nothing. POSIX: always ok – the socket's own 0600 and the folder's 0700 are the rule there.
 */
export async function checkPrivateDir(
  dir: string,
  files: readonly string[],
  deps: PrivateDirDeps = {},
  options: PrivateDirOptions = {},
): Promise<PrivateDirResult> {
  if ((deps.platform ?? process.platform) !== 'win32') return { ok: true };
  return windowsCheck([dir, ...files], false, deps, options);
}
