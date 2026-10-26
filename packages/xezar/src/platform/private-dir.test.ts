import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { resolveElevatedIpc } from './elevated-ipc.ts';
import { processIsElevated } from './elevation.ts';
import { launchFileAsync } from './process-launch.ts';
import type { TableRunner } from './process-table.ts';
import {
  ACL_SCRIPT,
  aclInput,
  checkPrivateDir,
  claimAdminFiles,
  ensurePrivateDir,
  judgeAclReport,
  judgeSddl,
  OWNER_SCRIPT,
  parseAclReport,
  type AdminChain,
} from './private-dir.ts';

const ME = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const PRIVATE = `O:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;
/** #980: the administrators-only folder exactly as the elevated `ensure` leaves it – no OWNER RIGHTS. */
const ADMIN_FOLDER = 'O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';
/** A file the elevated engine wrote and claimed: owned by Administrators, every entry inherited. */
const ADMIN_FILE = 'O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)';
/** A machine-owned ancestor such as `%ProgramData%`: SYSTEM-owned, and users may create children. */
const PROGRAMDATA = 'O:SYD:PAI(A;OICIIO;GA;;;CO)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;CI;DCLCRPCR;;;BU)';

describe('judgeSddl (#963)', () => {
  it('accepts a protected list of the user, SYSTEM and Administrators, by alias or by SID', () => {
    expect(judgeSddl(PRIVATE, ME, true)).toBeNull();
    expect(judgeSddl(`O:${ME}D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)(A;;FA;;;${ME})`, ME, true)).toBeNull();
    // A file inherits its entries: no protection flag needed.
    expect(judgeSddl(`O:${ME}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${ME})`, ME, false)).toBeNull();
    // A deny entry grants nothing.
    expect(judgeSddl(`O:${ME}D:P(D;;FA;;;WD)(A;;FA;;;${ME})`, ME, true)).toBeNull();
  });

  it('refuses another owner, Administrators as owner, and an owner it cannot read', () => {
    expect(judgeSddl(PRIVATE.replace(`O:${ME}`, `O:${OTHER}`), ME, true)).toBe('foreign-owner');
    expect(judgeSddl(PRIVATE.replace(`O:${ME}`, 'O:BA'), ME, true)).toBe('foreign-owner');
    expect(judgeSddl(PRIVATE.replace(`O:${ME}`, ''), ME, true)).toBe('foreign-owner');
  });

  it('refuses anyone else, an inherited folder list, an empty list and odd entries', () => {
    for (const sddl of [
      `${PRIVATE}(A;;FR;;;WD)`, // Everyone, read
      `${PRIVATE}(A;;FA;;;${OTHER})`,
      `${PRIVATE}(A;;FA;;;AN)`, // ANONYMOUS LOGON
      `O:${ME}D:AI(A;OICI;FA;;;${ME})`, // still inherits
      `O:${ME}D:P`,
      `${PRIVATE}(OA;;FA;guid;;${ME})`,
      `${PRIVATE}(A;;FA;;${ME})`,
    ]) {
      expect(judgeSddl(sddl, ME, true), sddl).toBe('not-private');
    }
  });
});

describe('judgeSddl for the administrators-only folder (#980)', () => {
  it('accepts the folder the elevated ensure leaves, and files owned by Administrators or SYSTEM', () => {
    expect(judgeSddl(ADMIN_FOLDER, ME, true, 'admin')).toBeNull();
    expect(judgeSddl('O:S-1-5-32-544D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)', ME, true, 'admin')).toBeNull();
    expect(judgeSddl(ADMIN_FILE, ME, false, 'admin')).toBeNull();
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', 'O:SY'), ME, false, 'admin')).toBeNull();
    // A deny entry grants nothing.
    expect(judgeSddl(`${ADMIN_FOLDER}(D;;FA;;;${ME})`, ME, true, 'admin')).toBeNull();
  });

  it('refuses a file the user owns – there is no user-owned-file exception any more (#980)', () => {
    // The built-in Administrator (RID 500), or the account that created the file before the claim ran.
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', `O:${ME}`), ME, false, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', 'O:LA'), 'S-1-5-21-1-2-3-500', false, 'admin')).toBe('foreign-owner');
    // A folder must be Administrators-owned; SYSTEM as the folder owner is not enough.
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', 'O:SY'), ME, true, 'admin')).toBe('foreign-owner');
  });

  it('refuses a folder not owned by Administrators – what a process without administrator rights could plant', () => {
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', `O:${ME}`), ME, true, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', `O:${OTHER}`), ME, true, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', `O:${OTHER}`), ME, false, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', ''), ME, true, 'admin')).toBe('foreign-owner');
  });

  it('refuses an entry for the user or anyone else, an OWNER RIGHTS entry, and an inherited folder list', () => {
    for (const sddl of [
      `${ADMIN_FOLDER}(A;OICI;FA;;;${ME})`, // the user's own entry: a non-elevated process could write
      `${ADMIN_FOLDER}(A;;FR;;;WD)`,
      `${ADMIN_FOLDER}(A;;FA;;;${OTHER})`,
      `${ADMIN_FOLDER}(A;OICI;0x120000;;;OW)`, // OWNER RIGHTS is no longer trusted at all
      ADMIN_FOLDER.replace('D:PAI', 'D:AI'),
      'O:BAD:P',
      `${ADMIN_FOLDER}(OA;;FA;guid;;BA)`,
    ]) {
      expect(judgeSddl(sddl, ME, true, 'admin'), sddl).toBe('not-private');
    }
  });

  it('leaves the user-folder rule as it was: the administrators-only shape is refused there', () => {
    expect(judgeSddl(ADMIN_FOLDER, ME, true)).toBe('foreign-owner');
    expect(judgeSddl(PRIVATE, ME, true, 'user')).toBeNull();
    expect(judgeSddl(PRIVATE, ME, true, 'admin')).toBe('foreign-owner');
  });
});

describe('judgeAclReport (#963)', () => {
  const report = (lines: string[]) => parseAclReport(lines.join('\r\n'));
  const fine = [`sid ${ME}`, 'elevated False', 'drive Fixed NTFS', `sddl 0 ${PRIVATE}`];
  it('passes a private folder on a local NTFS or ReFS volume', () => {
    expect(judgeAclReport(report(fine), ['C:\\x'])).toEqual({ ok: true });
    expect(judgeAclReport(report(fine.map((l) => l.replace('NTFS', 'ReFS'))), ['C:\\x'])).toEqual({ ok: true });
  });
  it.each([
    ['sid-lookup-failed', fine.slice(1)],
    ['elevated', fine.map((l) => l.replace('False', 'True'))],
    ['elevated', fine.filter((l) => !l.startsWith('elevated'))],
    ['network-drive', fine.map((l) => l.replace('Fixed NTFS', 'Network NTFS'))],
    ['not-ntfs', fine.map((l) => l.replace('NTFS', 'FAT32'))],
    ['not-ntfs', fine.map((l) => l.replace('Fixed NTFS', 'Unknown -'))],
    ['not-private', fine.slice(0, 3)],
  ] as const)('answers %s', (reason, lines) => {
    expect(judgeAclReport(report([...lines]), ['C:\\x'])).toMatchObject({ ok: false, reason });
  });
  it('checks every file too, and names the one that fails', () => {
    const lines = [...fine, `sddl 1 O:${OTHER}D:AI(A;ID;FA;;;${ME})`];
    expect(judgeAclReport(report(lines), ['C:\\x', 'C:\\x\\a.key'])).toMatchObject({ ok: false, reason: 'foreign-owner', message: expect.stringContaining('a.key') });
    expect(judgeAclReport(report(fine), ['C:\\x', 'C:\\x\\a.key'])).toMatchObject({ ok: false, reason: 'not-private' });
  });

  // #980, the owner's decision: only an elevated cockpit with an elevated leader. Each side checks
  // the folder of its own elevation, under a machine-owned %ProgramData% parent.
  describe('the administrators-only folder, chain and elevation (#980)', () => {
    const paths = ['C:\\ProgramData\\xezar\\ipc-admin\\sid\\h', 'C:\\ProgramData\\xezar\\ipc-admin\\sid\\h\\a.key', 'C:\\ProgramData\\xezar\\ipc-admin\\sid\\h\\a.pipe'];
    /** A healthy elevated report: the folder + two files private, the chain owned, the ancestor machine-owned. */
    const healthy = (over: { folder?: string; file?: string; rp?: Partial<Record<number, boolean>>; anc?: string[]; dir?: string[] } = {}): string[] => {
      const folder = over.folder ?? ADMIN_FOLDER;
      const file = over.file ?? ADMIN_FILE;
      const lines = [`sid ${ME}`, 'elevated True', 'drive Fixed NTFS', `sddl 0 ${folder}`, `sddl 1 ${file}`, `sddl 2 ${file}`];
      for (let i = 0; i < 3; i++) lines.push(`rp ${i} ${over.rp?.[i] ? 'True' : 'False'}`);
      (over.anc ?? [PROGRAMDATA]).forEach((sddl, i) => lines.push(`anc ${i} ${sddl === 'missing' ? 'missing -' : `False ${sddl}`}`));
      (over.dir ?? [ADMIN_FOLDER, ADMIN_FOLDER, ADMIN_FOLDER, ADMIN_FOLDER]).forEach((sddl, i) => lines.push(`dir ${i} ${sddl === 'missing' ? 'missing -' : sddl.startsWith('rp:') ? `True ${sddl.slice(3)}` : `False ${sddl}`}`));
      return lines;
    };

    it('(b) elevated cockpit and elevated leader: a healthy chain passes for the folder alone and with files', () => {
      expect(judgeAclReport(report(healthy().filter((l) => !/^sddl [12]/.test(l) && !/^rp [12]/.test(l))), paths.slice(0, 1), true)).toEqual({ ok: true });
      expect(judgeAclReport(report(healthy()), paths, true)).toEqual({ ok: true });
    });

    it('(a) elevated cockpit, leader without administrator rights: the leader may not use the administrators-only folder', () => {
      const normal = healthy().map((l) => l.replace('elevated True', 'elevated False'));
      expect(judgeAclReport(report(normal), paths, true)).toMatchObject({ ok: false, reason: 'not-elevated', message: expect.stringContaining('runs without administrator rights') });
      // Judged as its own (user) folder, the administrators-owned files are someone else's.
      expect(judgeAclReport(report(normal), paths)).toMatchObject({ ok: false, reason: 'foreign-owner' });
    });

    it('(c) cockpit without administrator rights, elevated leader: the user folder refuses an elevated check', () => {
      const userFolder = [`sid ${ME}`, 'elevated True', 'drive Fixed NTFS', `sddl 0 ${PRIVATE}`];
      expect(judgeAclReport(report(userFolder), ['C:\\h\\ipc'])).toMatchObject({ ok: false, reason: 'elevated', message: expect.stringContaining('runs as administrator') });
    });

    it('refuses a reparse point at the leaf, a file, or a chain directory – a swapped junction (#980)', () => {
      expect(judgeAclReport(report(healthy({ rp: { 0: true } })), paths, true)).toMatchObject({ ok: false, reason: 'reparse-point', message: expect.stringContaining('ipc-admin') });
      expect(judgeAclReport(report(healthy({ rp: { 2: true } })), paths, true)).toMatchObject({ ok: false, reason: 'reparse-point', message: expect.stringContaining('a.pipe') });
      // A junction planted as one of the created chain directories.
      expect(judgeAclReport(report(healthy({ dir: [ADMIN_FOLDER, `rp:${ADMIN_FOLDER}`, ADMIN_FOLDER, ADMIN_FOLDER] })), paths, true)).toMatchObject({ ok: false, reason: 'reparse-point' });
    });

    it('refuses a chain directory a normal user pre-created and owns (#980)', () => {
      expect(judgeAclReport(report(healthy({ dir: [ADMIN_FOLDER.replace('O:BA', `O:${ME}`), ADMIN_FOLDER, ADMIN_FOLDER, ADMIN_FOLDER] })), paths, true)).toMatchObject({ ok: false, reason: 'foreign-owner' });
      // A chain directory that does not exist (the walk stopped before creating it) is refused.
      expect(judgeAclReport(report(healthy({ dir: [ADMIN_FOLDER, 'missing', 'missing', 'missing'] })), paths, true)).toMatchObject({ ok: false, reason: 'not-private' });
    });

    it('refuses an ancestor that is not owned by Windows, is a reparse point, or is missing (#980)', () => {
      expect(judgeAclReport(report(healthy({ anc: [PROGRAMDATA.replace('O:SY', `O:${ME}`)] })), paths, true)).toMatchObject({ ok: false, reason: 'untrusted-parent' });
      expect(judgeAclReport(report(healthy({ anc: ['missing'] })), paths, true)).toMatchObject({ ok: false, reason: 'untrusted-parent' });
      // TrustedInstaller (what the OS gives the volume root) is accepted.
      expect(judgeAclReport(report(healthy({ anc: [PROGRAMDATA.replace('O:SY', `O:${TRUSTED_INSTALLER}`)] })), paths, true)).toEqual({ ok: true });
    });

    it('refuses a file the account still owns, and keeps every other rule – volume and entries', () => {
      expect(judgeAclReport(report(healthy({ file: ADMIN_FILE.replace('O:BA', `O:${ME}`) })), paths, true)).toMatchObject({ ok: false, reason: 'foreign-owner', message: expect.stringContaining('a.key') });
      expect(judgeAclReport(report(healthy().map((l) => l.replace('Fixed NTFS', 'Network NTFS'))), paths, true)).toMatchObject({ reason: 'network-drive' });
      expect(judgeAclReport(report(healthy({ file: `${ADMIN_FILE}(A;ID;FA;;;${ME})` })), paths, true)).toMatchObject({ ok: false, reason: 'not-private' });
    });
  });
});

describe('the ACL script and its input (#963, #980)', () => {
  it('is fixed text: paths and the pid arrive only in the base64 JSON input, never in the script', () => {
    const evil = "C:\\a'; Remove-Item C:\\ -Recurse; '";
    expect(ACL_SCRIPT).not.toContain('Remove-Item');
    expect(ACL_SCRIPT).toContain('SetAccessControl');
    expect(JSON.parse(Buffer.from(aclInput([evil], true, 42), 'base64').toString('utf8'))).toEqual({ paths: [evil], ensure: true, pid: 42 });
    // The non-admin input is unchanged byte for byte.
    expect(Buffer.from(aclInput(['C:\\x'], true, 42), 'base64').toString('utf8')).toBe('{"paths":["C:\\\\x"],"ensure":true,"pid":42}');
    // #980: the administrators-only input carries the chain to create and verify.
    const chain: AdminChain = { create: ['C:\\ProgramData\\xezar', 'C:\\ProgramData\\xezar\\ipc-admin'], ancestors: ['C:\\ProgramData'] };
    expect(JSON.parse(Buffer.from(aclInput([evil], true, 42, true, chain), 'base64').toString('utf8'))).toEqual({ paths: [evil], ensure: true, pid: 42, admin: true, create: chain.create, ancestors: chain.ancestors });
    for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(JSON.parse(Buffer.from(aclInput(['C:\\x'], false, pid), 'base64').toString('utf8')).pid).toBe(0);
    }
  });

  it('creates the administrators-only chain with its access list at creation, never deletes or takes over (#980)', () => {
    // Created in the script, not by a Node mkdir, with the list set at creation.
    expect(ACL_SCRIPT).toContain('[IO.Directory]::CreateDirectory($d, (& $adminAcl))');
    // Owned by Administrators, protected, SYSTEM and Administrators only, no OWNER RIGHTS.
    expect(ACL_SCRIPT).toContain("SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))");
    expect(ACL_SCRIPT).toContain("@('S-1-5-18', 'S-1-5-32-544')");
    expect(ACL_SCRIPT).not.toContain('S-1-3-4'); // OWNER RIGHTS is gone
    // It never empties or takes over an unexpected folder.
    expect(ACL_SCRIPT).not.toContain('GetFileSystemInfos');
    expect(ACL_SCRIPT).not.toContain('.Delete(');
    // A reparse point or a non-Administrators owner stops the walk.
    expect(ACL_SCRIPT).toContain('ReparsePoint');
    expect(ACL_SCRIPT).toContain("@('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') -notcontains (OwnerOf $a)");
    // The standard branch is the one before #980.
    expect(ACL_SCRIPT).toContain("} elseif ($in.ensure -eq $true) {\n  $acl = New-Object Security.AccessControl.DirectorySecurity\n  $acl.SetAccessRuleProtection($true, $false)\n  foreach ($sid in @($id.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {");
  });

  it('the owner script makes Administrators own each file, nothing else', () => {
    expect(OWNER_SCRIPT).toContain("SecurityIdentifier('S-1-5-32-544')");
    expect(OWNER_SCRIPT).toContain('$s.SetOwner($admins)');
    expect(OWNER_SCRIPT).toContain('[IO.File]::SetAccessControl($p, $s)');
    expect(OWNER_SCRIPT).not.toContain('AddAccessRule');
  });
});

describe('ensurePrivateDir on Linux and macOS (#963)', () => {
  let base = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'xez-private-'));
  });
  afterEach(() => {
    rmSync(base, TEST_DIR_RM_OPTIONS);
  });
  for (const platform of ['linux', 'darwin'] as const) {
    it(`is mkdir 0700 + chmod 0700 and runs nothing on ${platform}`, async () => {
      const run = vi.fn();
      const dir = join(base, platform);
      expect(await ensurePrivateDir(dir, { platform, run })).toEqual({ ok: true });
      expect(run).not.toHaveBeenCalled();
      // win32-skip(#972): Windows reports no POSIX mode bits
      if (!onWindows) expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(await checkPrivateDir(dir, [], { platform, run })).toEqual({ ok: true });
    });
  }
  it('claimAdminFiles and checkPrivateDir are no-ops off Windows', async () => {
    const run = vi.fn();
    await claimAdminFiles([join(base, 'x.key')], { platform: 'linux', run });
    expect(run).not.toHaveBeenCalled();
  });
});

// win32-skip(#976): Windows access lists exist on Windows only; the rules above run everywhere
describe.skipIf(!onWindows || processIsElevated())('ensurePrivateDir on Windows, the user folder (#963)', () => {
  let base = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'xez-private-'));
  });
  afterEach(() => {
    rmSync(base, TEST_DIR_RM_OPTIONS);
  });

  it('makes a folder private, and files created in it pass the check', async () => {
    const dir = join(base, 'ipc');
    expect(await ensurePrivateDir(dir)).toEqual({ ok: true });
    writeFileSync(join(dir, 'a.key'), 'x');
    expect(await checkPrivateDir(dir, [join(dir, 'a.key')])).toEqual({ ok: true });
  }, 60_000);

  // Break: CI's Windows Node 22 leg failed with a bare "is not private to the current user" for a
  // PowerShell that never answered, so nobody could tell a timeout from a real access entry.
  it('says on a test run why a folder with no access list was refused', async () => {
    const dir = join(base, 'ipc');
    mkdirSync(dir);
    const result = await ensurePrivateDir(dir, {
      run: async () => {
        throw new Error('timed out after 15000 ms');
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'not-private' });
    expect(!result.ok && result.message).toContain('[test: PowerShell gave no access list: timed out after 15000 ms]');
  });

  it('notices a grant added to the folder later', async () => {
    const dir = join(base, 'ipc');
    expect(await ensurePrivateDir(dir)).toEqual({ ok: true });
    const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    await launchFileAsync(icacls, [dir, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
    expect(await checkPrivateDir(dir, [])).toMatchObject({ ok: false, reason: 'not-private' });
    // ensure repairs it
    expect(await ensurePrivateDir(dir)).toEqual({ ok: true });
  }, 60_000);

  it('refuses a junction', async () => {
    const target = join(base, 'target');
    mkdirSync(target);
    const link = join(base, 'link');
    symlinkSync(target, link, 'junction');
    expect(await ensurePrivateDir(link)).toMatchObject({ ok: false, reason: 'reparse-point' });
  });

  it('refuses the administrators-only folder for a process without administrator rights (#980)', async () => {
    // A non-elevated process may not use the administrators-only folder: the check reads its own
    // (non-elevated) token and refuses before trusting anything. The leaf is pre-created so the
    // script has a folder to read; the elevated ensure branch is skipped for a non-elevated token,
    // so the folder's own access list is never changed.
    const leaf = join(base, 'xezar', 'leaf');
    mkdirSync(leaf, { recursive: true });
    const chain: AdminChain = { create: [leaf], ancestors: [base] };
    const result = await ensurePrivateDir(leaf, {}, { elevated: true, adminChain: chain });
    expect(result).toMatchObject({ ok: false, reason: 'not-elevated' });
  }, 60_000);
});

// win32-skip(#976): the administrators-only chain is a Windows access-list test; it also needs an
// elevated token (every GitHub Windows runner step has one), which a non-elevated machine lacks.
describe.runIf(onWindows && processIsElevated())('ensurePrivateDir on Windows, the administrators-only folder (#980)', () => {
  const scope = `xez-test-${process.pid}-${Date.now()}`;
  const ipc = resolveElevatedIpc(scope);
  const chain: AdminChain | undefined = ipc ? { create: ipc.create, ancestors: ipc.ancestors } : undefined;
  afterEach(() => {
    // Remove only this scope's leaf; the shared machine chain (xezar/ipc-admin/<SID>) stays.
    if (ipc) rmSync(ipc.dir, { ...TEST_DIR_RM_OPTIONS, maxRetries: 5, retryDelay: 100 });
  });

  it('creates the %ProgramData% chain owned by Administrators, and a claimed file passes the check', async () => {
    expect(ipc).not.toBeNull();
    expect(await ensurePrivateDir(ipc!.dir, {}, { elevated: true, adminChain: chain })).toEqual({ ok: true });
    const file = join(ipc!.dir, 'a.key');
    writeFileSync(file, 'x');
    await claimAdminFiles([file]);
    expect(await checkPrivateDir(ipc!.dir, [file], {}, { elevated: true, adminChain: chain })).toEqual({ ok: true });
  }, 90_000);
});
