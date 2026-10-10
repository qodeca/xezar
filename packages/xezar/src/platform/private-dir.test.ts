import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWindows, TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
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
});

describe('the ACL script and its input (#963)', () => {
  it('is fixed text: paths and the pid arrive only in the base64 JSON input, never in the script', () => {
    const evil = "C:\\a'; Remove-Item C:\\ -Recurse; '";
    expect(ACL_SCRIPT).not.toContain('Remove-Item');
    expect(ACL_SCRIPT).toContain('SetAccessControl');
    expect(ACL_SCRIPT).toContain("'S-1-5-18', 'S-1-5-32-544'");
    expect(JSON.parse(Buffer.from(aclInput([evil], true, 42), 'base64').toString('utf8'))).toEqual({ paths: [evil], ensure: true, pid: 42 });
    for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(JSON.parse(Buffer.from(aclInput(['C:\\x'], false, pid), 'base64').toString('utf8')).pid).toBe(0);
    }
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
      // win32-skip(#963): Windows reports no POSIX mode bits
      if (!onWindows) expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(await checkPrivateDir(dir, [], { platform, run })).toEqual({ ok: true });
    });
  }
});

// win32-skip(#963): Windows access lists exist on Windows only; the rules above run everywhere
describe.skipIf(!onWindows)('ensurePrivateDir on Windows (#963)', () => {
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
});
