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
 * share, or on a file system without access lists is refused; so is an elevated process, whose
 * files other elevated programs share. A lookup that fails, or answers nothing, is "not private".
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
/** SDDL's own short names for the two well-known SIDs. */
const ALIASES: Readonly<Record<string, string>> = { SY: SYSTEM, BA: ADMINISTRATORS };
const ACL_TIMEOUT_MS = 15_000;
const ACL_MAX_BUFFER = 1024 * 1024;

const MESSAGES: Readonly<Record<PrivateDirReason, string>> = {
  'reparse-point': 'is a link or junction',
  'network-drive': 'is on a network drive',
  'not-ntfs': 'is on a file system without access lists (NTFS or ReFS is needed)',
  'sid-lookup-failed': "could not be checked: the current user's identity could not be read",
  elevated: 'cannot be used while xezar runs as administrator; start it without elevation',
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
 * `{ paths, ensure, pid }`, so no path can break out of a string – and a script whose text never
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
  '"elevated $((New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"',
  'try { $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($paths[0])); "drive $($drive.DriveType) $($drive.DriveFormat)" } catch { "drive Unknown -" }',
  // The process API, not WMI: a second faster, and the same clock on both sides.
  'if ([int]$in.pid -gt 0) { try { "started $([Diagnostics.Process]::GetProcessById([int]$in.pid).StartTime.ToFileTimeUtc())" } catch { "started -" } }',
  'if ($in.ensure -eq $true) {',
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
export function aclInput(paths: readonly string[], ensure: boolean, startTimeOf?: number): string {
  const pid = startTimeOf !== undefined && Number.isSafeInteger(startTimeOf) && startTimeOf > 0 ? startTimeOf : 0;
  return Buffer.from(JSON.stringify({ paths, ensure, pid }), 'utf8').toString('base64');
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
 * One SDDL string, judged for `user`: `owner` – owned by the user; `not-private` – an access entry
 * of a kind other than allow/deny, or one that names anyone but the user, SYSTEM or
 * Administrators, or (for the folder) a list still inheriting from its parent; null – fine.
 */
export function judgeSddl(sddl: string, user: string, isFolder: boolean): 'foreign-owner' | 'not-private' | null {
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

/** The verdict on one report for `paths` (the folder first). */
export function judgeAclReport(report: AclReport, paths: readonly string[]): PrivateDirResult {
  const folder = paths[0]!;
  if (report.sid === undefined) return refuse('sid-lookup-failed', folder);
  if (report.elevated !== false) return refuse('elevated', folder);
  if (report.driveType === 'Network') return refuse('network-drive', folder);
  if (report.driveFormat !== 'NTFS' && report.driveFormat !== 'ReFS') return refuse('not-ntfs', folder);
  for (let i = 0; i < paths.length; i++) {
    const sddl = report.sddl.get(i);
    if (sddl === undefined) return refuse('not-private', folder);
    const verdict = judgeSddl(sddl, report.sid, i === 0);
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
  const env = { ...(deps.env ?? process.env), [ACL_INPUT_ENV]: aclInput(paths, ensure, options.startTimeOf) };
  const text = await (deps.run ?? defaultTableRunner)(powershell, powershellArgs(ACL_SCRIPT), {
    maxBuffer: ACL_MAX_BUFFER,
    timeoutMs: ACL_TIMEOUT_MS,
    hide: true,
    env,
  }).catch(() => null);
  if (text === null) return refuse('not-private', folder);
  return judgeAclReport(parseAclReport(text), paths);
}

/**
 * Create `dir` if needed and make it private to the current user. POSIX: mkdir 0700 + chmod 0700,
 * throwing as `fs` does. Windows: the access list above, answered as a result, never thrown.
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
