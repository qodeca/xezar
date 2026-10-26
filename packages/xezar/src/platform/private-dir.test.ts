import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { processIsElevated } from './elevation.ts';
import { launchFileAsync } from './process-launch.ts';
import {
  ACL_SCRIPT,
  aclInput,
  checkPrivateDir,
  ensurePrivateDir,
  judgeAclReport,
  judgeSddl,
  parseAclReport,
} from './private-dir.ts';

const ME = 'S-1-5-21-1-2-3-1001';
const OTHER = 'S-1-5-21-1-2-3-1002';
const PRIVATE = `O:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;
/** #980: the administrators-only folder exactly as the elevated `ensure` leaves it (measured SDDL shape). */
const ADMIN_FOLDER = 'O:BAD:PAI(A;OICI;0x120000;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';
/** A file an elevated process wrote there: owned by Administrators, every entry inherited. */
const ADMIN_FILE = 'O:BAD:AI(A;ID;0x120000;;;OW)(A;ID;FA;;;SY)(A;ID;FA;;;BA)';

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
  it('accepts the folder the elevated ensure leaves, and files owned by Administrators', () => {
    expect(judgeSddl(ADMIN_FOLDER, ME, true, 'admin')).toBeNull();
    expect(judgeSddl('O:S-1-5-32-544D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)', ME, true, 'admin')).toBeNull();
    expect(judgeSddl(ADMIN_FILE, ME, false, 'admin')).toBeNull();
    // A deny entry grants nothing.
    expect(judgeSddl(`${ADMIN_FOLDER}(D;;FA;;;${ME})`, ME, true, 'admin')).toBeNull();
  });

  it('accepts a file owned by the user only while OWNER RIGHTS takes away its right to change the list', () => {
    // The built-in Administrator, or a policy that makes the creator the owner.
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', `O:${ME}`), ME, false, 'admin')).toBeNull();
    const builtIn = 'S-1-5-21-1-2-3-500';
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', 'O:LA'), builtIn, false, 'admin')).toBeNull();
    // Without the OWNER RIGHTS entry, a non-elevated process of the same user could rewrite the list.
    expect(judgeSddl(`O:${ME}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)`, ME, false, 'admin')).toBe('not-private');
    // `LA` is the user only when the user is the built-in Administrator.
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', 'O:LA'), ME, false, 'admin')).toBe('foreign-owner');
  });

  it('refuses a folder not owned by Administrators – what a process without administrator rights could plant', () => {
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', `O:${ME}`), ME, true, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', 'O:SY'), ME, true, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', `O:${OTHER}`), ME, true, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FILE.replace('O:BA', `O:${OTHER}`), ME, false, 'admin')).toBe('foreign-owner');
    expect(judgeSddl(ADMIN_FOLDER.replace('O:BA', ''), ME, true, 'admin')).toBe('foreign-owner');
  });

  it('refuses an entry for the user or anyone else, OWNER RIGHTS with more than reading the list, and an inherited folder list', () => {
    for (const sddl of [
      `${ADMIN_FOLDER}(A;OICI;FA;;;${ME})`, // the user's own entry: a non-elevated process could write
      `${ADMIN_FOLDER}(A;;FR;;;WD)`,
      `${ADMIN_FOLDER}(A;;FA;;;${OTHER})`,
      ADMIN_FOLDER.replace('0x120000;;;OW', 'FA;;;OW'),
      ADMIN_FOLDER.replace('0x120000;;;OW', 'WD;;;OW'), // WRITE_DAC
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
  // the folder of its own elevation; the elevation the check reads must be that folder's kind.
  describe('the three elevation combinations (#980)', () => {
    const elevated = [`sid ${ME}`, 'elevated True', 'drive Fixed NTFS', `sddl 0 ${ADMIN_FOLDER}`, `sddl 1 ${ADMIN_FILE}`, `sddl 2 ${ADMIN_FILE}`];
    const paths = ['C:\\h\\ipc-admin', 'C:\\h\\ipc-admin\\a.key', 'C:\\h\\ipc-admin\\a.pipe'];

    it('(b) elevated cockpit and elevated leader: the administrators-only folder passes for both', () => {
      expect(judgeAclReport(report(elevated.slice(0, 4)), paths.slice(0, 1), true)).toEqual({ ok: true });
      expect(judgeAclReport(report(elevated), paths, true)).toEqual({ ok: true });
    });

    it('(a) elevated cockpit, leader without administrator rights: the leader may not use the administrators-only folder', () => {
      // What the non-elevated leader's own check reads there, were it to try.
      const normal = elevated.map((l) => l.replace('elevated True', 'elevated False'));
      expect(judgeAclReport(report(normal), paths, true)).toMatchObject({ ok: false, reason: 'not-elevated', message: expect.stringContaining('runs without administrator rights') });
      // And judged as its own (user) folder, the administrators-owned files are someone else's.
      expect(judgeAclReport(report(normal), paths)).toMatchObject({ ok: false, reason: 'foreign-owner' });
    });

    it('(c) cockpit without administrator rights, elevated leader: the user folder refuses an elevated check', () => {
      const userFolder = [`sid ${ME}`, 'elevated True', 'drive Fixed NTFS', `sddl 0 ${PRIVATE}`];
      expect(judgeAclReport(report(userFolder), ['C:\\h\\ipc'])).toMatchObject({ ok: false, reason: 'elevated', message: expect.stringContaining('runs as administrator') });
      // An unknown elevation is refused in either folder.
      const unknown = elevated.filter((l) => !l.startsWith('elevated'));
      expect(judgeAclReport(report(unknown), paths, true)).toMatchObject({ ok: false, reason: 'not-elevated' });
    });

    it('the administrators-only folder keeps every other rule: volume, owner, entries, every file', () => {
      expect(judgeAclReport(report(elevated.map((l) => l.replace('Fixed NTFS', 'Network NTFS'))), paths, true)).toMatchObject({ reason: 'network-drive' });
      expect(judgeAclReport(report(elevated.map((l) => l.replace(`sddl 0 ${ADMIN_FOLDER}`, `sddl 0 ${ADMIN_FOLDER.replace('O:BA', `O:${ME}`)}`))), paths, true)).toMatchObject({ reason: 'foreign-owner' });
      expect(judgeAclReport(report([...elevated.slice(0, 5), `sddl 2 ${ADMIN_FILE}(A;ID;FA;;;${ME})`]), paths, true)).toMatchObject({ reason: 'not-private', message: expect.stringContaining('a.pipe') });
      expect(judgeAclReport(report(elevated.slice(0, 5)), paths, true)).toMatchObject({ reason: 'not-private' });
    });
  });
});

describe('the ACL script and its input (#963)', () => {
  it('is fixed text: paths and the pid arrive only in the base64 JSON input, never in the script', () => {
    const evil = "C:\\a'; Remove-Item C:\\ -Recurse; '";
    expect(ACL_SCRIPT).not.toContain('Remove-Item');
    expect(ACL_SCRIPT).toContain('SetAccessControl');
    expect(ACL_SCRIPT).toContain("'S-1-5-18', 'S-1-5-32-544'");
    expect(JSON.parse(Buffer.from(aclInput([evil], true, 42), 'base64').toString('utf8'))).toEqual({ paths: [evil], ensure: true, pid: 42 });
    // #980: the administrators-only folder is asked for in the input; the standard input is unchanged.
    expect(Buffer.from(aclInput(['C:\\x'], true, 42), 'base64').toString('utf8')).toBe('{"paths":["C:\\\\x"],"ensure":true,"pid":42}');
    expect(JSON.parse(Buffer.from(aclInput([evil], true, 42, true), 'base64').toString('utf8'))).toEqual({ paths: [evil], ensure: true, pid: 42, admin: true });
    for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(JSON.parse(Buffer.from(aclInput(['C:\\x'], false, pid), 'base64').toString('utf8')).pid).toBe(0);
    }
  });

  it('sets the administrators-only list only when asked and only when elevated, owner rights limited, Administrators taking over (#980)', () => {
    expect(ACL_SCRIPT).toContain('if ($in.ensure -eq $true -and $in.admin -eq $true) {\n  if ($elevated) {');
    expect(ACL_SCRIPT).toContain("@('S-1-5-18', 'S-1-5-32-544')");
    expect(ACL_SCRIPT).toContain("SecurityIdentifier('S-1-3-4')), 'ReadPermissions'");
    expect(ACL_SCRIPT).toContain("SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))");
    // The takeover empties the folder first, and never takes over one it could not empty.
    expect(ACL_SCRIPT.indexOf('$child.Delete')).toBeLessThan(ACL_SCRIPT.indexOf('SetOwner('));
    expect(ACL_SCRIPT).toContain('if (@($dir.GetFileSystemInfos()).Count -eq 0) {');
    // The standard branch is the one before #980.
    expect(ACL_SCRIPT).toContain("} elseif ($in.ensure -eq $true) {\n  $acl = New-Object Security.AccessControl.DirectorySecurity\n  $acl.SetAccessRuleProtection($true, $false)\n  foreach ($sid in @($id.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {");
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
});

// win32-skip(#976): Windows access lists exist on Windows only; the rules above run everywhere
describe.skipIf(!onWindows)('ensurePrivateDir on Windows (#963)', () => {
  // The folder of this process's own elevation: an elevated runner (every GitHub step) checks the
  // administrators-only folder, as an elevated xezar would (#980).
  const own = processIsElevated() ? { elevated: true } : {};
  let base = '';
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'xez-private-'));
  });
  afterEach(() => {
    rmSync(base, TEST_DIR_RM_OPTIONS);
  });

  it('makes a folder private, and files created in it pass the check', async () => {
    const dir = join(base, 'ipc');
    expect(await ensurePrivateDir(dir, {}, own)).toEqual({ ok: true });
    writeFileSync(join(dir, 'a.key'), 'x');
    expect(await checkPrivateDir(dir, [join(dir, 'a.key')], {}, own)).toEqual({ ok: true });
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
    expect(await ensurePrivateDir(dir, {}, own)).toEqual({ ok: true });
    const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    await launchFileAsync(icacls, [dir, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
    expect(await checkPrivateDir(dir, [], {}, own)).toMatchObject({ ok: false, reason: 'not-private' });
    // ensure repairs it
    expect(await ensurePrivateDir(dir, {}, own)).toEqual({ ok: true });
  }, 60_000);

  it('refuses a junction', async () => {
    const target = join(base, 'target');
    mkdirSync(target);
    const link = join(base, 'link');
    symlinkSync(target, link, 'junction');
    expect(await ensurePrivateDir(link, {}, own)).toMatchObject({ ok: false, reason: 'reparse-point' });
  });

  it('refuses the folder of the other elevation, and changes nothing there (#980)', async () => {
    const dir = join(base, 'other');
    const other = processIsElevated() ? {} : { elevated: true };
    expect(await ensurePrivateDir(dir, {}, other)).toMatchObject({ ok: false, reason: processIsElevated() ? 'elevated' : 'not-elevated' });
    if (!processIsElevated()) {
      // The administrators-only list is set only by an elevated process: the folder is still ours to fix.
      expect(await ensurePrivateDir(dir)).toEqual({ ok: true });
    }
  }, 60_000);
});
