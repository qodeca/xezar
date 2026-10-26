import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import type { ElevatedIpc } from '../platform/elevated-ipc.ts';
import type { TableRunner } from '../platform/process-table.ts';
import { ACL_INPUT_ENV } from '../platform/private-dir.ts';
import {
  newPipeKey,
  newPipeName,
  openPipeEndpoint,
  PIPE_NAME_PATTERN,
  pipeFiles,
  pipeFilesFor,
  readPipeEndpoint,
  readPipeMarker,
  removePipeFilesIfOurs,
  writePipeFiles,
  type PipeEndpoint,
  type PipeFiles,
} from './pipe-endpoint.ts';

/** #963: the endpoint and marker files of the Windows pipe, and the bridge's check before it dials. */

let dir = '';
let files: PipeFiles;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xez-pipe-ep-'));
  files = pipeFiles(dir, 'alpha');
});
afterEach(() => {
  rmSync(dir, TEST_DIR_RM_OPTIONS);
});

const STARTED = 1_800_000_000_123;
const endpoint = (over: Partial<PipeEndpoint> = {}): PipeEndpoint => ({
  v: 1,
  pipeName: newPipeName(),
  key: newPipeKey(),
  pid: 4242,
  processStartTime: STARTED,
  ...over,
});

describe('pipe names (#963)', () => {
  it("follow the launcher's contract, fresh every time", () => {
    const a = newPipeName();
    expect(a).toMatch(PIPE_NAME_PATTERN);
    expect(a.startsWith('\\\\.\\pipe\\xezar-mcp-')).toBe(true);
    expect(newPipeName()).not.toBe(a);
    for (const bad of ['\\\\.\\pipe\\xezar-mcp-ABCDEF0123456789abcdef0123456789', '\\\\.\\pipe\\xezar-mcp-123', '\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef']) {
      expect(bad).not.toMatch(PIPE_NAME_PATTERN);
    }
  });
});

describe('readPipeEndpoint and readPipeMarker (#963)', () => {
  it('round-trip what writePipeFiles wrote, endpoint and marker naming one pipe', () => {
    const value = endpoint();
    writePipeFiles(files, value);
    expect(readPipeEndpoint(files.endpoint)).toEqual(value);
    expect(readPipeMarker(files.marker)).toBe(value.pipeName);
  });

  it('answer missing for no file, and invalid for anything not exactly the shape', () => {
    expect(readPipeEndpoint(files.endpoint)).toBe('missing');
    expect(readPipeMarker(files.marker)).toBe('missing');
    const cases: Array<[string, string]> = [
      ['garbage', 'not json'],
      ['extra key', JSON.stringify({ ...endpoint(), extra: 1 })],
      ['other version', JSON.stringify({ ...endpoint(), v: 2 })],
      ['bad name', JSON.stringify({ ...endpoint(), pipeName: '\\\\.\\pipe\\evil' })],
      ['short key', JSON.stringify({ ...endpoint(), key: 'ab' })],
      ['oversize', `${JSON.stringify(endpoint())}${' '.repeat(5_000)}`],
    ];
    for (const [name, text] of cases) {
      writeFileSync(files.endpoint, text);
      expect(readPipeEndpoint(files.endpoint), name).toBe('invalid');
    }
    mkdirSync(join(dir, 'beta.key'));
    expect(readPipeEndpoint(join(dir, 'beta.key'))).toBe('invalid');
    for (const text of ['\\\\.\\pipe\\evil\n', `${newPipeName()}\n\n`, `${newPipeName()} `, 'x'.repeat(300)]) {
      writeFileSync(files.marker, text);
      expect(readPipeMarker(files.marker), JSON.stringify(text)).toBe('invalid');
    }
    const name = newPipeName();
    writeFileSync(files.marker, `${name}\r\n`);
    expect(readPipeMarker(files.marker)).toBe(name);
  });
});

describe('removePipeFilesIfOurs (#963)', () => {
  it('removes both files only while they still name this pipe', () => {
    const ours = endpoint();
    writePipeFiles(files, ours);
    removePipeFilesIfOurs(files, newPipeName());
    expect([existsSync(files.endpoint), existsSync(files.marker)]).toEqual([true, true]);
    removePipeFilesIfOurs(files, ours.pipeName);
    expect([existsSync(files.endpoint), existsSync(files.marker)]).toEqual([false, false]);
    // A newer engine's files survive an older one's close.
    const newer = endpoint();
    writePipeFiles(files, newer);
    removePipeFilesIfOurs(files, ours.pipeName);
    expect(readPipeEndpoint(files.endpoint)).toEqual(newer);
  });
});

describe('openPipeEndpoint (#963)', () => {
  const ME = 'S-1-5-21-1-2-3-1001';
  const PRIVATE = `O:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;
  const FILE = `O:${ME}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${ME})`;
  /** A PowerShell stand-in answering the folder check, with `started` for the endpoint's pid. */
  function report(started: string, fileSddl = FILE): { run: TableRunner; asked: string[] } {
    const asked: string[] = [];
    const run: TableRunner = async (_file, _args, options) => {
      asked.push(Buffer.from(options.env?.[ACL_INPUT_ENV] ?? '', 'base64').toString('utf8'));
      return [`sid ${ME}`, 'elevated False', 'drive Fixed NTFS', `started ${started}`, `sddl 0 ${PRIVATE}`, `sddl 1 ${fileSddl}`, `sddl 2 ${fileSddl}`].join('\r\n');
    };
    return { run, asked };
  }
  const deps = (run: TableRunner, alive = true) => ({
    platform: 'win32' as const,
    env: { SystemRoot: 'C:\\Windows' },
    run,
    isLink: async () => false,
    pidExists: () => alive,
  });
  // FILETIME of STARTED: (ms + 11644473600000) * 10000
  const filetime = (ms: number) => String((BigInt(ms) + 11644473600000n) * 10000n);

  it('dials a live engine: same pid, the start time it wrote, private files', async () => {
    const value = endpoint();
    writePipeFiles(files, value);
    const { run, asked } = report(filetime(STARTED));
    expect(await openPipeEndpoint(files, deps(run))).toEqual({ ok: true, pipeName: value.pipeName, key: Buffer.from(value.key, 'hex') });
    expect(asked).toHaveLength(1); // one PowerShell run for privacy and liveness together
    expect(JSON.parse(asked[0]!)).toMatchObject({ pid: 4242, ensure: false });
  });

  it('never dials a stale name: the pid is gone, or now names a process started at another time', async () => {
    writePipeFiles(files, endpoint());
    expect(await openPipeEndpoint(files, deps(report('-').run))).toEqual({ ok: false, kind: 'not-running' });
    expect(await openPipeEndpoint(files, deps(report(filetime(STARTED + 5_000)).run))).toEqual({ ok: false, kind: 'not-running' });
  });

  it('answers a gone engine without the folder check: nothing is dialled, and no PowerShell starts', async () => {
    writePipeFiles(files, endpoint());
    const { run, asked } = report(filetime(STARTED));
    expect(await openPipeEndpoint(files, deps(run, false))).toEqual({ ok: false, kind: 'not-running' });
    expect(asked).toEqual([]);
  });

  it('refuses files that disagree, are unreadable, or are not private, and reads nothing for a missing endpoint', async () => {
    const { run, asked } = report(filetime(STARTED));
    expect(await openPipeEndpoint(files, deps(run))).toEqual({ ok: false, kind: 'not-running' });
    writePipeFiles(files, endpoint());
    writeFileSync(files.marker, `${newPipeName()}\n`);
    expect(await openPipeEndpoint(files, deps(run))).toEqual({ ok: false, kind: 'invalid' });
    writeFileSync(files.endpoint, 'garbage');
    expect(await openPipeEndpoint(files, deps(run))).toEqual({ ok: false, kind: 'invalid' });
    expect(asked).toEqual([]);

    writePipeFiles(files, endpoint());
    const foreign = report(filetime(STARTED), FILE.replace(`O:${ME}`, 'O:S-1-5-21-9-9-9-500'));
    expect(await openPipeEndpoint(files, deps(foreign.run))).toMatchObject({ ok: false, kind: 'not-private', message: expect.stringContaining('owned by another account') });
  });
});

// #980, the owner's decision: an elevated cockpit serves an elevated leader, in the
// administrators-only folder under %ProgramData% a normal process cannot swap; a cockpit and a
// leader that differ in elevation are refused with a sentence that says so.
describe('the administrators-only folder and differing elevation (#980)', () => {
  const ME = 'S-1-5-21-1-2-3-1001';
  const PRIVATE = `O:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${ME})`;
  // The administrators-only shapes after #980: no OWNER RIGHTS, folders and files Administrators-owned.
  const ADMIN_FOLDER = 'O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';
  const ADMIN_FILE = 'O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)';
  const PROGRAMDATA = 'O:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)';
  const filetime = (ms: number) => String((BigInt(ms) + 11644473600000n) * 10000n);
  const adminIpc = (): ElevatedIpc => {
    const pd = join(dir, 'pd');
    const xezar = join(pd, 'xezar');
    const ipcAdmin = join(xezar, 'ipc-admin');
    const perUser = join(ipcAdmin, 'sid');
    const leaf = join(perUser, 'hash');
    return { dir: leaf, create: [xezar, ipcAdmin, perUser, leaf], ancestors: [pd] };
  };
  const dirs = () => ({ user: join(dir, 'ipc'), admin: adminIpc() });
  /** A PowerShell stand-in: what this process's own folder check reads, with a healthy chain. */
  function report(elevated: boolean, folder: string, file: string): { run: TableRunner; asked: string[] } {
    const asked: string[] = [];
    const chain = adminIpc();
    const run: TableRunner = async (_file, _args, options) => {
      asked.push(Buffer.from(options.env?.[ACL_INPUT_ENV] ?? '', 'base64').toString('utf8'));
      const lines = [`sid ${ME}`, `elevated ${elevated ? 'True' : 'False'}`, 'drive Fixed NTFS', `started ${filetime(STARTED)}`, `sddl 0 ${folder}`, `sddl 1 ${file}`, `sddl 2 ${file}`, 'rp 0 False', 'rp 1 False', 'rp 2 False'];
      chain.ancestors.forEach((_a, i) => lines.push(`anc ${i} False ${PROGRAMDATA}`));
      chain.create.forEach((_c, i) => lines.push(`dir ${i} False ${ADMIN_FOLDER}`));
      return lines.join('\r\n');
    };
    return { run, asked };
  }
  const deps = (run: TableRunner, alive: (pid: number) => boolean = () => true) => ({
    platform: 'win32' as const,
    env: { SystemRoot: 'C:\\Windows' },
    run,
    isLink: async () => false,
    pidExists: alive,
  });
  const write = (target: PipeFiles, value: PipeEndpoint) => {
    mkdirSync(target.dir, { recursive: true });
    writePipeFiles(target, value);
  };

  it('picks the folder by elevation, with the other folder as the counterpart and its chain', () => {
    const chain = adminIpc();
    const adminFiles = pipeFiles(chain.dir, 'alpha', true, { create: chain.create, ancestors: chain.ancestors });
    const user = pipeFilesFor(dirs(), 'alpha', false);
    const admin = pipeFilesFor(dirs(), 'alpha', true);
    expect(user).toEqual({ ...pipeFiles(dirs().user, 'alpha'), counterpart: adminFiles });
    expect(admin).toEqual({ ...adminFiles, counterpart: pipeFiles(dirs().user, 'alpha') });
    expect(admin).toMatchObject({ admin: true, endpoint: join(chain.dir, 'alpha.key'), adminChain: { create: chain.create, ancestors: chain.ancestors } });
    // The user's folder carries no admin flag: its files are exactly what #963 named.
    expect('admin' in user).toBe(false);
  });

  it('a process whose administrators-only folder could not be located has no rendezvous, no counterpart', () => {
    // #980: `%ProgramData%` could not be resolved (`resolveElevatedIpc` answered null).
    expect(pipeFilesFor({ user: join(dir, 'ipc'), admin: null }, 'alpha', false)).toEqual(pipeFiles(join(dir, 'ipc'), 'alpha'));
    expect(pipeFilesFor({ user: join(dir, 'ipc'), admin: null }, 'alpha', true)).toEqual(pipeFiles(join(dir, 'ipc'), 'alpha'));
  });

  it('(b) an elevated leader dials an elevated engine: the administrators-only folder is checked as such, with its chain', async () => {
    const admin = pipeFilesFor(dirs(), 'alpha', true);
    const value = endpoint();
    write(admin, value);
    const { run, asked } = report(true, ADMIN_FOLDER, ADMIN_FILE);
    expect(await openPipeEndpoint(admin, deps(run))).toEqual({ ok: true, pipeName: value.pipeName, key: Buffer.from(value.key, 'hex') });
    expect(JSON.parse(asked[0]!)).toMatchObject({ ensure: false, admin: true, pid: 4242, create: admin.adminChain!.create, ancestors: admin.adminChain!.ancestors });
  });

  it('(b) never trusts the administrators-only folder when the check reads another elevation or a planted owner', async () => {
    const admin = pipeFilesFor(dirs(), 'alpha', true);
    write(admin, endpoint());
    expect(await openPipeEndpoint(admin, deps(report(false, ADMIN_FOLDER, ADMIN_FILE).run))).toMatchObject({ ok: false, kind: 'not-private', message: expect.stringContaining('without administrator rights') });
    const planted = report(true, ADMIN_FOLDER.replace('O:BA', `O:${ME}`), ADMIN_FILE);
    expect(await openPipeEndpoint(admin, deps(planted.run))).toMatchObject({ ok: false, kind: 'not-private', message: expect.stringContaining('owned by another account') });
    // A file the account still owns (the owner-claim did not run) is refused too: no user-owned exception.
    const userFile = report(true, ADMIN_FOLDER, ADMIN_FILE.replace('O:BA', `O:${ME}`));
    expect(await openPipeEndpoint(admin, deps(userFile.run))).toMatchObject({ ok: false, kind: 'not-private' });
  });

  it('(a) elevated engine, leader without administrator rights: "differ in elevation", nothing dialled, no PowerShell', async () => {
    const user = pipeFilesFor(dirs(), 'alpha', false);
    // The leader cannot read the administrators-only folder: its endpoint reads as unreadable.
    mkdirSync(user.counterpart!.dir, { recursive: true });
    writeFileSync(user.counterpart!.endpoint, 'not readable to this user');
    const { run, asked } = report(false, PRIVATE, PRIVATE);
    expect(await openPipeEndpoint(user, deps(run))).toEqual({ ok: false, kind: 'elevation-differs', engineElevated: true });
    // A readable one counts while its process runs.
    write(user.counterpart!, endpoint());
    expect(await openPipeEndpoint(user, deps(run))).toEqual({ ok: false, kind: 'elevation-differs', engineElevated: true });
    expect(asked).toEqual([]);
  });

  it('(c) engine without administrator rights, elevated leader: "differ in elevation" while that engine runs', async () => {
    const admin = pipeFilesFor(dirs(), 'alpha', true);
    write(admin.counterpart!, endpoint({ pid: 777 }));
    const { run, asked } = report(true, ADMIN_FOLDER, ADMIN_FILE);
    expect(await openPipeEndpoint(admin, deps(run, (pid) => pid === 777))).toEqual({ ok: false, kind: 'elevation-differs', engineElevated: false });
    // Its process is gone: simply not running.
    expect(await openPipeEndpoint(admin, deps(run, () => false))).toEqual({ ok: false, kind: 'not-running' });
    // An unreadable endpoint in the user's folder is not an elevated leader's business.
    writeFileSync(admin.counterpart!.endpoint, 'garbage');
    expect(await openPipeEndpoint(admin, deps(run))).toEqual({ ok: false, kind: 'not-running' });
    expect(asked).toEqual([]);
  });

  it('the same elevation on both sides with nothing in the other folder is plainly not running', async () => {
    for (const elevated of [false, true]) {
      const files = pipeFilesFor(dirs(), 'alpha', elevated);
      const { run } = report(elevated, elevated ? ADMIN_FOLDER : PRIVATE, elevated ? ADMIN_FILE : PRIVATE);
      expect(await openPipeEndpoint(files, deps(run))).toEqual({ ok: false, kind: 'not-running' });
    }
  });
});
