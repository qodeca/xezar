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
 * (`elevated: true`; the caller picks the folder with `platform/elevated-ipc.ts`, under a
 * machine-owned `%ProgramData%` parent a normal process cannot rename or swap). In `ensure` mode the
 * whole chain `…\xezar\ipc-admin\<SID>` is created and repaired IN THIS SCRIPT: each directory is
 * created with its access list already set (`[IO.Directory]::CreateDirectory(path, security)`), owned
 * by Administrators and private to SYSTEM and Administrators only — never by a Node `mkdir` that would
 * leave an inherited, user-reachable window first. The machine-owned ancestor (`%ProgramData%`) is
 * verified, never created, and must be owned by SYSTEM, Administrators or TrustedInstaller; a level a
 * normal user pre-created (owned by anyone else) or a reparse point planted at any level STOPS the
 * walk — nothing is created inside it and nothing is ever deleted or taken over, it is simply
 * refused. No access entry may name the user, and every file this check judges (the endpoint, which
 * holds the key, and the marker) must be owned by Administrators or SYSTEM: there is no user-owned-file
 * exception, because a non-elevated process of the same user could otherwise rewrite the access list
 * of a file it owns. The engine never lets Node create either of them – `createAdminFiles` makes each
 * one owned by Administrators and private from the moment it exists, whatever owner the elevated token
 * would give a new file (the built-in Administrator's token gives the user). The one exception is the
 * pipe lock (`<id>.lock` and its `.lock.takeover` guard, `core/file-lock.ts`): Node creates them, so
 * they can take the user as owner, and this check does not judge them. They hold no secret – a pid, a
 * time and a random token – and live only while a start or close holds them, so the most a
 * non-elevated process could do through them is delay or block that start or close. The elevation the check reads must match the folder's kind,
 * or the folder is refused. The standard folder's rules did not change.
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
  | 'untrusted-parent'
  | 'not-private';

/**
 * Windows (#980): the directories `private-dir.ts` creates and verifies for the administrators-only
 * folder. `create` — the directories xezar owns (`…\xezar`, `…\ipc-admin`, the leaf), created with
 * their access list already set, outermost first. `ancestors` — the machine-owned directories only
 * verified, never created (`%ProgramData%`).
 */
export interface AdminChain {
  readonly create: readonly string[];
  readonly ancestors: readonly string[];
}

/** `startedAt`: when asked (`startTimeOf`), that process's start time in ms since the epoch, or
 *  null when it is not running. */
export type PrivateDirResult =
  | { ok: true; startedAt?: number | null }
  | { ok: false; reason: PrivateDirReason; message: string };

/** What else the same PowerShell run reads. */
interface PrivateDirCommon {
  /** Windows: also read this process's start time (one run instead of two). */
  startTimeOf?: number;
}

/** The user's own folder, judged exactly as before #980 – or a folder another program keeps private to the user. */
interface UserFolderOptions extends PrivateDirCommon {
  elevated?: false;
  adminChain?: undefined;
  /**
   * Windows (#977, #980): a folder another program keeps private to this user – the Codex control
   * folder – judged as the user's own whatever this process's elevation, so an elevated xezar can
   * attach to Codex as one without administrator rights does. Owned by the user, or (elevated only)
   * by Administrators, which an elevated Codex leaves; an unknown elevation still refuses.
   */
  anyElevation?: boolean;
}

/**
 * Windows (#980): the administrators-only folder an elevated process uses, with the chain to create
 * and verify (resolved by `platform/elevated-ipc.ts`). The check refuses a process whose elevation
 * does not match, and a chain that is empty or does not end at this folder.
 */
interface AdminFolderOptions extends PrivateDirCommon {
  elevated: true;
  adminChain: AdminChain;
  anyElevation?: false;
}

/** The two kinds exclude each other: `elevated` with `anyElevation` is refused (a TypeError). */
export type PrivateDirOptions = UserFolderOptions | AdminFolderOptions;

/** How a folder is judged: the user's own; the administrators-only one (#980); a user-private folder at any elevation. */
export type PrivateDirKind = 'user' | 'admin' | 'any-elevation';

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
/** TrustedInstaller: the owner Windows gives its own machine-wide folders such as `%ProgramData%`. */
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
/** SDDL's own short names for the well-known SIDs. */
const ALIASES: Readonly<Record<string, string>> = { SY: SYSTEM, BA: ADMINISTRATORS };
/** The owners a machine-owned ancestor of the administrators-only folder may have (#980). */
const TRUSTED_ANCESTOR_OWNERS: ReadonlySet<string> = new Set([SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER]);
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
  'untrusted-parent': 'sits under a folder that is not owned by Windows itself (SYSTEM, Administrators or TrustedInstaller), or under a link, so it cannot be trusted',
  'not-private': 'is not private to the current user',
};

function refuse(reason: PrivateDirReason, path: string): PrivateDirResult {
  return { ok: false, reason, message: `The private folder ${path} ${MESSAGES[reason]}.` };
}

/**
 * #980: a level of the administrators-only chain that exists but cannot be trusted – most often a
 * folder another account made first (any local user may create folders in `%ProgramData%`). xezar
 * never deletes or takes it over; the message names the path and the one remedy.
 */
function refuseChainDir(reason: PrivateDirReason, path: string): PrivateDirResult {
  const refused = refuse(reason, path);
  if (refused.ok) return refused;
  return { ...refused, message: `${refused.message} An administrator can delete ${path}; xezar creates it again, private to Administrators, the next time it starts.` };
}

/** #980: a machine-owned ancestor (`%ProgramData%`) that cannot be trusted. Windows' own folder: named, never "delete it". */
function refuseAncestor(ancestor: string, folder: string): PrivateDirResult {
  return {
    ok: false,
    reason: 'untrusted-parent',
    message: `The private folder ${folder} sits under ${ancestor}, which is missing, a link, or not owned by Windows itself (SYSTEM, Administrators or TrustedInstaller), so it cannot be trusted.`,
  };
}

/** The environment variable that carries one run's input to `ACL_SCRIPT`. */
export const ACL_INPUT_ENV = 'PRIVATE_DIR_INPUT';

/**
 * The one script, FIXED text: its input comes through `ACL_INPUT_ENV` as base64 JSON
 * `{ paths, ensure, pid }` (plus `admin: true`, `create` and `ancestors` for the administrators-only
 * folder, #980), so no path can break out of a string – and a script whose text never changes is
 * scanned once, not on every run (a new script text measured about 4 s on first run here, the same
 * text 0.6 s). The first path is the folder, the rest are files in it. One line per fact: `sid`,
 * `la` (the SID SDDL's `LA` alias stands for on this machine – the built-in Administrator), `elevated`,
 * `drive`, `started` (when a pid is asked), then `sddl <i>`; for the administrators-only folder also
 * `rp <i>` (whether a path is a reparse point), `anc <i>` (each verified ancestor) and `dir <i>` (each
 * created/verified chain directory). A path the administrators-only run cannot read gets no `sddl`
 * line instead of ending the run, so the chain facts that explain why still arrive; the user folder's
 * run still ends on the first unreadable path, as it always did.
 *
 * #980, the administrators-only folder (`admin: true`, elevated only): the chain is CREATED here with
 * its access list set at creation, never by a Node `mkdir` first. The machine-owned ancestors
 * (`%ProgramData%`) are only verified; each `create` directory is made with Full Control for SYSTEM
 * and Administrators, protected from inheritance, owned by Administrators. A reparse point at any
 * level, or a level a normal user pre-created (owned by anyone but Administrators), STOPS the walk –
 * nothing is created inside it, nothing is deleted and nothing is taken over. The facts are emitted
 * for every level so the verdict is re-made in TypeScript (`judgeAclReport`).
 */
export const ACL_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  `$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PRIVATE_DIR_INPUT)) | ConvertFrom-Json`,
  '$paths = @($in.paths | ForEach-Object { [string]$_ })',
  '$id = [Security.Principal.WindowsIdentity]::GetCurrent()',
  '"sid $($id.User.Value)"',
  // SDDL spells this machine's built-in Administrator (RID 500) `LA`: resolved here, exactly, so the
  // verdict compares SIDs and never guesses from a RID suffix (a domain account can end in -500 too).
  "try { \"la $((New-Object Security.Principal.SecurityIdentifier('LA')).Value)\" } catch { }",
  '$elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  '"elevated $elevated"',
  'try { $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($paths[0])); "drive $($drive.DriveType) $($drive.DriveFormat)" } catch { "drive Unknown -" }',
  // The process API, not WMI: a second faster, and the same clock on both sides.
  'if ([int]$in.pid -gt 0) { try { "started $([Diagnostics.Process]::GetProcessById([int]$in.pid).StartTime.ToFileTimeUtc())" } catch { "started -" } }',
  // Facts the administrators-only path reads: a path's owner SID, whether it is a reparse point, and
  // its reparse-flag-plus-SDDL as one string ("missing -" when it is absent or unreadable).
  'function OwnerOf($p) { try { (New-Object IO.DirectoryInfo($p)).GetAccessControl("Owner").GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $null } }',
  'function IsReparse($p) { try { if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { "True" } else { "False" } } catch { "True" } }',
  'function Fact($p) { try { $i = Get-Item -LiteralPath $p -Force; $rp = if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { "True" } else { "False" }; $sec = [Security.AccessControl.AccessControlSections]"Access,Owner"; if ($i -is [IO.DirectoryInfo]) { $s = New-Object Security.AccessControl.DirectorySecurity($p, $sec) } else { $s = New-Object Security.AccessControl.FileSecurity($p, $sec) }; "$rp $($s.GetSecurityDescriptorSddlForm($sec))" } catch { "missing -" } }',
  // #980: the administrators-only chain, created and repaired only by an elevated process. Each
  // directory is made with its access list already set; a reparse point or a level owned by anyone
  // but Administrators stops the walk, so nothing is ever created inside, deleted or taken over.
  'if ($in.ensure -eq $true -and $in.admin -eq $true) {',
  '  if ($elevated) {',
  '    $adminAcl = {',
  '      $acl = New-Object Security.AccessControl.DirectorySecurity',
  '      $acl.SetAccessRuleProtection($true, $false)',
  `      $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('${ADMINISTRATORS}')))`,
  `      foreach ($sid in @('${SYSTEM}', '${ADMINISTRATORS}')) {`,
  "        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  '      }',
  '      $acl',
  '    }',
  '    $safe = $true',
  '    foreach ($a in @($in.ancestors | ForEach-Object { [string]$_ })) {',
  '      if ($safe) {',
  '        if (-not (Test-Path -LiteralPath $a)) { $safe = $false }',
  '        elseif ((IsReparse $a) -ne "False") { $safe = $false }',
  `        elseif (@('${SYSTEM}', '${ADMINISTRATORS}', '${TRUSTED_INSTALLER}') -notcontains (OwnerOf $a)) { $safe = $false }`,
  '      }',
  '    }',
  '    foreach ($d in @($in.create | ForEach-Object { [string]$_ })) {',
  '      if ($safe) {',
  '        if (Test-Path -LiteralPath $d) {',
  '          if ((IsReparse $d) -ne "False") { $safe = $false }',
  `          elseif ((OwnerOf $d) -ne '${ADMINISTRATORS}') { $safe = $false }`,
  '          else { (New-Object IO.DirectoryInfo($d)).SetAccessControl((& $adminAcl)) }',
  '        } else {',
  // .NET Framework hands back a folder that already exists WITHOUT applying the list. One that
  // appeared since Test-Path – a link, or a folder another account made – is judged like any existing
  // level and never rewritten: nothing here ever changes a folder it did not just create.
  '          [IO.Directory]::CreateDirectory($d, (& $adminAcl)) | Out-Null',
  '          if ((IsReparse $d) -ne "False") { $safe = $false }',
  `          elseif ((OwnerOf $d) -ne '${ADMINISTRATORS}') { $safe = $false }`,
  '        }',
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
  '  try {',
  '    if ($i -eq 0) { $s = New-Object Security.AccessControl.DirectorySecurity($paths[$i], $sections) } else { $s = New-Object Security.AccessControl.FileSecurity($paths[$i], $sections) }',
  '    "sddl $i $($s.GetSecurityDescriptorSddlForm($sections))"',
  // The user folder's run ends here exactly as before; the administrators-only run goes on to the
  // chain facts, which say WHY the folder is missing (a level the walk refused).
  '  } catch { if ($in.admin -ne $true) { throw } }',
  '}',
  'if ($in.admin -eq $true) {',
  '  for ($i = 0; $i -lt $paths.Count; $i++) { "rp $i $(IsReparse $paths[$i])" }',
  '  $anc = @($in.ancestors | ForEach-Object { [string]$_ })',
  '  for ($i = 0; $i -lt $anc.Count; $i++) { "anc $i $(Fact $anc[$i])" }',
  '  $cre = @($in.create | ForEach-Object { [string]$_ })',
  '  for ($i = 0; $i -lt $cre.Count; $i++) { "dir $i $(Fact $cre[$i])" }',
  '}',
].join('\n');

/**
 * The environment variable that carries `CREATE_FILES_SCRIPT`'s input (#980): base64 JSON `{ paths }`.
 */
export const CREATE_INPUT_ENV = 'PRIVATE_DIR_CREATE_INPUT';

/**
 * #980: makes each path a NEW, empty file owned by Administrators with a protected list of SYSTEM and
 * Administrators only – all set in the one `CreateFile` call that makes it, so the file never exists
 * with the owner the elevated token would give it. That owner is the user for the built-in
 * Administrator (RID 500), or under the "object creator" owner policy, and an owner always keeps the
 * right to read and rewrite the access list: a non-elevated process of the same user could open the
 * key through it. `CreateNew` refuses a name that already exists, a link included. Prints `created`
 * only when every file was made; a token that may not name Administrators as owner fails instead.
 */
export const CREATE_FILES_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  `$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${CREATE_INPUT_ENV})) | ConvertFrom-Json`,
  '$s = New-Object Security.AccessControl.FileSecurity',
  '$s.SetAccessRuleProtection($true, $false)',
  `$s.SetOwner((New-Object Security.Principal.SecurityIdentifier('${ADMINISTRATORS}')))`,
  `foreach ($sid in @('${SYSTEM}', '${ADMINISTRATORS}')) {`,
  "  $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'Allow')))",
  '}',
  'foreach ($p in @($in.paths | ForEach-Object { [string]$_ })) {',
  '  $f = New-Object IO.FileStream($p, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $s)',
  '  $f.Dispose()',
  '}',
  '"created"',
].join('\n');

/** One run's input for `ACL_SCRIPT`: base64 of JSON. Only a positive safe integer is a pid. */
export function aclInput(paths: readonly string[], ensure: boolean, startTimeOf?: number, admin = false, chain?: AdminChain): string {
  const pid = startTimeOf !== undefined && Number.isSafeInteger(startTimeOf) && startTimeOf > 0 ? startTimeOf : 0;
  const input = admin
    ? { paths, ensure, pid, admin, create: chain?.create ?? [], ancestors: chain?.ancestors ?? [] }
    : { paths, ensure, pid };
  return Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
}

/** A directory level's facts: its reparse flag and SDDL, or that it was absent / unreadable. */
export type DirFact = { readonly reparse: boolean; readonly sddl: string } | 'missing';

/** What one run of the script said. */
export interface AclReport {
  sid?: string;
  elevated?: boolean;
  driveType?: string;
  driveFormat?: string;
  sddl: Map<number, string>;
  /** Administrators-only folder (#980): whether each `paths` entry is a reparse point. */
  reparse: Map<number, boolean>;
  /** Administrators-only folder (#980): each verified machine-owned ancestor. */
  ancestors: Map<number, DirFact>;
  /** Administrators-only folder (#980): each created/verified chain directory. */
  dirs: Map<number, DirFact>;
  /** Absent: not asked; null: not running. */
  startedAt?: number | null;
  /** The SID SDDL's `LA` alias stands for here (the built-in Administrator). Absent: unresolved. */
  localAdmin?: string;
}

function parseDirFact(flag: string, sddl: string): DirFact {
  return flag === 'missing' ? 'missing' : { reparse: flag === 'True', sddl };
}

export function parseAclReport(text: string): AclReport {
  const report: AclReport = { sddl: new Map(), reparse: new Map(), ancestors: new Map(), dirs: new Map() };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let match: RegExpExecArray | null;
    if ((match = /^sid (S-1-[\d-]+)$/.exec(line))) report.sid = match[1];
    else if ((match = /^la (S-1-[\d-]+)$/.exec(line))) report.localAdmin = match[1];
    else if ((match = /^elevated (True|False)$/.exec(line))) report.elevated = match[1] === 'True';
    else if ((match = /^drive (\S+) (\S+)$/.exec(line))) [report.driveType, report.driveFormat] = [match[1], match[2]];
    else if ((match = /^sddl (\d+) (\S+)$/.exec(line))) report.sddl.set(Number(match[1]), match[2]!);
    else if ((match = /^rp (\d+) (True|False)$/.exec(line))) report.reparse.set(Number(match[1]), match[2] === 'True');
    else if ((match = /^anc (\d+) (True|False|missing) (\S+)$/.exec(line))) report.ancestors.set(Number(match[1]), parseDirFact(match[2]!, match[3]!));
    else if ((match = /^dir (\d+) (True|False|missing) (\S+)$/.exec(line))) report.dirs.set(Number(match[1]), parseDirFact(match[2]!, match[3]!));
    else if ((match = /^started (\d+|-)$/.exec(line))) report.startedAt = match[1] === '-' ? null : (fileTimeToMs(match[1]) ?? null);
  }
  return report;
}

const sidOf = (token: string): string => ALIASES[token] ?? token;

/**
 * SDDL writes this machine's built-in Administrator (RID 500) as the alias `LA`. With the SID the
 * script resolved for it, the owner and every entry naming `LA` read as that SID, so the judges
 * compare SIDs only; unresolved, `LA` stays an alias that matches no one (#980).
 */
export function withLocalAdmin(sddl: string, localAdmin: string | undefined): string {
  if (localAdmin === undefined) return sddl;
  return sddl.replace(/^O:LA/, `O:${localAdmin}`).replace(/;LA\)/g, `;${localAdmin})`);
}

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
 * `admin` mode (#980): the folder must be owned by Administrators; a file by Administrators or
 * SYSTEM, never by the user (there is no user-owned-file exception – a non-elevated process of the
 * same user could rewrite the access list of a file it owns). An allow entry may name only SYSTEM or
 * Administrators; never the user, never OWNER RIGHTS.
 */
export function judgeSddl(sddl: string, user: string, isFolder: boolean, mode: PrivateDirMode = 'user', adminOwnerToo = false): 'foreign-owner' | 'not-private' | null {
  if (mode === 'admin') return judgeAdminSddl(sddl, isFolder);
  const owner = /^O:(S-1-[\d-]+|[A-Z]{2})/.exec(sddl)?.[1];
  if (owner === undefined || (sidOf(owner) !== user && !(adminOwnerToo && sidOf(owner) === ADMINISTRATORS))) return 'foreign-owner';
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

function judgeAdminSddl(sddl: string, isFolder: boolean): 'foreign-owner' | 'not-private' | null {
  const ownerToken = /^O:(S-1-[\d-]+|[A-Z]{2})/.exec(sddl)?.[1];
  if (ownerToken === undefined) return 'foreign-owner';
  const owner = sidOf(ownerToken);
  // The folder must be Administrators-owned; a file may also be SYSTEM-owned. Never the user.
  if (owner !== ADMINISTRATORS && !(!isFolder && owner === SYSTEM)) return 'foreign-owner';
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) return 'not-private';
  if (isFolder && !dacl[1]!.includes('P')) return 'not-private';
  const aces = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.split(';'));
  if (aces.length === 0) return 'not-private';
  for (const ace of aces) {
    if (ace.length !== 6) return 'not-private';
    const [type, , , , , who] = ace as [string, string, string, string, string, string];
    if (type === 'D') continue; // a deny entry grants nothing
    if (type !== 'A') return 'not-private';
    const named = sidOf(who);
    if (named !== SYSTEM && named !== ADMINISTRATORS) return 'not-private';
  }
  return null;
}

/** A machine-owned ancestor (`%ProgramData%`): owned by SYSTEM, Administrators or TrustedInstaller. */
function judgeAncestorOwner(sddl: string): boolean {
  const ownerToken = /^O:(S-1-[\d-]+|[A-Z]{2})/.exec(sddl)?.[1];
  return ownerToken !== undefined && TRUSTED_ANCESTOR_OWNERS.has(sidOf(ownerToken));
}

/**
 * The verdict on one report for `paths` (the folder first). The rules follow the elevation the
 * report read (#980); `kind` says which kind of folder `paths[0]` is, and a report whose elevation is
 * not that kind – or is unknown – is refused.
 *
 * For the administrators-only folder (`admin`, with the caller's `chain`) the verdict also re-makes,
 * in TypeScript, everything the script did on disk: every machine-owned ANCESTOR must exist, be no
 * reparse point and be owned by SYSTEM/Administrators/TrustedInstaller; every CHAIN directory and the
 * folder and files in `paths` must exist, be no reparse point, be owned by Administrators (a file also
 * by SYSTEM) and name no one but SYSTEM and Administrators in their access list.
 */
export function judgeAclReport(report: AclReport, paths: readonly string[], kind: PrivateDirKind = 'user', chain?: AdminChain): PrivateDirResult {
  const folder = paths[0]!;
  if (report.sid === undefined) return refuse('sid-lookup-failed', folder);
  const admin = kind === 'admin';
  if (kind === 'any-elevation' ? report.elevated === undefined : report.elevated !== admin) return refuse(admin ? 'not-elevated' : 'elevated', folder);
  const mode: PrivateDirMode = admin ? 'admin' : 'user';
  const adminOwnerToo = kind === 'any-elevation' && report.elevated === true;
  if (report.driveType === 'Network') return refuse('network-drive', folder);
  if (report.driveFormat !== 'NTFS' && report.driveFormat !== 'ReFS') return refuse('not-ntfs', folder);
  if (admin) {
    const parent = judgeAdminChain(report, folder, chain);
    if (parent !== null) return parent;
  }
  for (let i = 0; i < paths.length; i++) {
    const sddl = report.sddl.get(i);
    if (sddl === undefined) return refuse('not-private', folder);
    const path = i === 0 ? folder : paths[i]!;
    if (admin && report.reparse.get(i) !== false) return refuse('reparse-point', path);
    const verdict = judgeSddl(withLocalAdmin(sddl, report.localAdmin), report.sid, i === 0, mode, adminOwnerToo);
    if (verdict !== null) return refuse(verdict, path);
  }
  return report.startedAt === undefined ? { ok: true } : { ok: true, startedAt: report.startedAt };
}

/**
 * The ancestors and chain directories of the administrators-only folder; null when all are safe.
 * Nothing is assumed: the chain must be the caller's, non-empty and end at this folder, and the
 * report must carry exactly one readable fact per level – a missing or garbled line refuses.
 */
function judgeAdminChain(report: AclReport, folder: string, chain: AdminChain | undefined): PrivateDirResult | null {
  if (chain === undefined || chain.ancestors.length === 0 || chain.create.length === 0 || chain.create[chain.create.length - 1] !== folder) {
    return refuse('untrusted-parent', folder);
  }
  if (report.ancestors.size !== chain.ancestors.length) return refuseAncestor(chain.ancestors[0]!, folder);
  for (let i = 0; i < chain.ancestors.length; i++) {
    const fact = report.ancestors.get(i);
    if (fact === undefined || fact === 'missing' || fact.reparse || !judgeAncestorOwner(fact.sddl)) return refuseAncestor(chain.ancestors[i]!, folder);
  }
  if (report.dirs.size !== chain.create.length) return refuse('not-private', folder);
  for (let i = 0; i < chain.create.length; i++) {
    const fact = report.dirs.get(i);
    const path = chain.create[i]!;
    if (fact === undefined || fact === 'missing') return refuse('not-private', path);
    const verdict = fact.reparse ? 'reparse-point' : judgeAdminSddl(withLocalAdmin(fact.sddl, report.localAdmin), true);
    if (verdict !== null) return refuseChainDir(verdict, path);
  }
  return null;
}

const defaultIsLink = async (path: string): Promise<boolean> => (await lstat(path)).isSymbolicLink();

function isUncPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

/**
 * The kind of folder `options` describe. `elevated` with `anyElevation` is a caller's mistake – one
 * would silently win – so it throws (the type already excludes it).
 */
function folderKind(options: PrivateDirOptions): PrivateDirKind {
  const loose = options as { elevated?: boolean; anyElevation?: boolean };
  if (loose.elevated === true && loose.anyElevation === true) {
    throw new TypeError('private-dir: `elevated` and `anyElevation` exclude each other');
  }
  if (loose.elevated === true) return 'admin';
  return loose.anyElevation === true ? 'any-elevation' : 'user';
}

async function windowsCheck(paths: readonly string[], ensure: boolean, deps: PrivateDirDeps, options: PrivateDirOptions): Promise<PrivateDirResult> {
  const folder = paths[0]!;
  const kind = folderKind(options);
  const elevated = kind === 'admin';
  const chain = options.elevated === true ? options.adminChain : undefined;
  if (isUncPath(folder)) return refuse('network-drive', folder);
  // The administrators-only folder (#980) judges reparse points IN the script (a junction, which
  // Node's `lstat` does NOT report as a symbolic link, would slip past the check below) and may not
  // exist yet on a first `ensure`, so its link check is the script's, never Node's.
  if (!elevated) {
    try {
      if (await (deps.isLink ?? defaultIsLink)(folder)) return refuse('reparse-point', folder);
    } catch {
      return refuse('not-private', folder);
    }
  }
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return refuse('not-private', folder);
  const env = { ...(deps.env ?? process.env), [ACL_INPUT_ENV]: aclInput(paths, ensure, options.startTimeOf, elevated, chain) };
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
  const verdict = judgeAclReport(report, paths, kind, chain);
  // A CI runner's account is not one we can inspect by hand: say what the check saw.
  if (testRun && !verdict.ok && report.sid !== undefined) {
    const dirFact = (fact: DirFact | undefined): string => (fact === undefined ? '?' : fact === 'missing' ? 'missing' : `${fact.reparse ? 'rp ' : ''}${fact.sddl}`);
    const extra = elevated
      ? `; rp ${[...report.reparse.values()].join(',')}; anc ${[...report.ancestors.values()].map(dirFact).join(' | ')}; dir ${[...report.dirs.values()].map(dirFact).join(' | ')}`
      : '';
    return { ...verdict, message: `${verdict.message} [test: elevated ${String(report.elevated)}; sddl ${[...report.sddl.values()].join(' | ')}${extra}; sid suffix ${report.sid.split('-').pop()}]` };
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
 *
 * The administrators-only folder (#980) is NOT created by this Node `mkdir` – that would leave a
 * folder with an inherited, user-reachable access list in place first. Its whole chain is created
 * inside the script, each level with its access list already set (`windowsCheck`).
 */
export async function ensurePrivateDir(dir: string, deps: PrivateDirDeps = {}, options: PrivateDirOptions = {}): Promise<PrivateDirResult> {
  const platform = deps.platform ?? process.platform;
  const kind = folderKind(options);
  if (platform === 'win32' && kind === 'admin') return windowsCheck([dir], true, deps, options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    // mkdir leaves an existing directory's mode alone; this one is ours alone.
    await chmod(dir, 0o700);
    return { ok: true };
  }
  return windowsCheck([dir], true, deps, options);
}

/**
 * Windows: is `dir` still private, and is every file in `files` owned by the user (or by
 * Administrators – #980) and private? Changes nothing. POSIX: always ok – the socket's own 0600 and
 * the folder's 0700 are the rule there.
 */
export async function checkPrivateDir(
  dir: string,
  files: readonly string[],
  deps: PrivateDirDeps = {},
  options: PrivateDirOptions = {},
): Promise<PrivateDirResult> {
  folderKind(options);
  if ((deps.platform ?? process.platform) !== 'win32') return { ok: true };
  return windowsCheck([dir, ...files], false, deps, options);
}

/**
 * Windows (#980): create each path as a new, empty file owned by Administrators and private to
 * SYSTEM and Administrators from its first moment (`CREATE_FILES_SCRIPT`), for the elevated engine to
 * write into. True only when every file was made; false off Windows, without a usable PowerShell, for
 * a token that may not name Administrators as owner, or when any name already exists. Never throws.
 */
export async function createAdminFiles(paths: readonly string[], deps: PrivateDirDeps = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'win32' || paths.length === 0) return false;
  const powershell = powershellPath(deps.env ?? process.env);
  if (powershell === null) return false;
  const env = { ...(deps.env ?? process.env), [CREATE_INPUT_ENV]: Buffer.from(JSON.stringify({ paths }), 'utf8').toString('base64') };
  const text = await (deps.run ?? defaultTableRunner)(powershell, powershellArgs(CREATE_FILES_SCRIPT), {
    maxBuffer: ACL_MAX_BUFFER,
    timeoutMs: ACL_TIMEOUT_MS,
    hide: true,
    env,
  }).catch(() => null);
  return text !== null && /^created$/m.test(text.replace(/\r/g, ''));
}
