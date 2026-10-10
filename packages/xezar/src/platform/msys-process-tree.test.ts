import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';
import { trackChild, trackedChildren } from './child-registry.ts';
import {
  msysMemberWinpids,
  msysPidPrefix,
  msysTreeTargets,
  parseMsysTable,
  readMsysPid,
  type MsysRow,
} from './msys-process-tree.ts';
import { STOP_CLOCK_SLACK_MS, type IdentifiedPid, type ProcRow, type ProcessTable } from './process-table.ts';
import { stopChildTree } from './process-tree.ts';

const row = (pid: number, ppid: number, startedAt?: number): ProcRow => ({ pid, ppid, rssKb: 0, cpuPct: 0, ...(startedAt !== undefined ? { startedAt } : {}) });

describe('parseMsysTable (#963)', () => {
  it("reads PID PPID PGID WINPID, with or without a status letter, and skips the header and torn lines", () => {
    const text = [
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
      '      866     865     865      13376  ?         197609 11:32:38 /usr/bin/sleep',
      'S     867     865     865      22308  ?         197609 11:32:38 /usr/bin/sleep',
      '      868     865',
      '',
    ].join('\r\n');
    expect(parseMsysTable(text)).toEqual([
      { pid: 866, ppid: 865, pgid: 865, winpid: 13376 },
      { pid: 867, ppid: 865, pgid: 865, winpid: 22308 },
    ]);
  });
});

describe('readMsysPid (#963)', () => {
  it('answers a positive pid, and null for a missing, empty or garbled file', () => {
    expect(readMsysPid('x', () => '865')).toBe(865);
    expect(readMsysPid('x', () => ' 865\n')).toBe(865);
    for (const text of ['', '0', '-1', '86 5', '1e3', '12345678901']) expect(readMsysPid('x', () => text)).toBeNull();
    expect(
      readMsysPid('x', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});

describe('msysMemberWinpids (#963)', () => {
  const rows: MsysRow[] = [
    { pid: 866, ppid: 1, pgid: 865, winpid: 13376 }, // reparented, still in the group
    { pid: 870, ppid: 866, pgid: 870, winpid: 13380 }, // left the group, reached through PPID
    { pid: 900, ppid: 1, pgid: 900, winpid: 14000 }, // a stranger
  ];
  it('takes the group and every PPID descendant of the shell, and nothing without its pid', () => {
    expect(msysMemberWinpids([...rows, { pid: 871, ppid: 865, pgid: 871, winpid: 13381 }], 865).sort()).toEqual([13376, 13381]);
    expect(msysMemberWinpids(rows, 866).sort()).toEqual([13380]);
    expect(msysMemberWinpids(rows, null)).toEqual([]);
  });
});

describe('msysTreeTargets (#963)', () => {
  const root = { pid: 500, spawnedAt: 10_000, readAt: 20_000 };
  it('starts inside the creation window, walks children no older than their parent, never the root or system pids', () => {
    const rows = [
      row(600, 3624, 12_000), // nohup: its parent has exited
      row(601, 600, 12_001), // the program under it
      row(602, 600, 11_000), // older than its parent: a stale parent pid
      row(700, 1, 5_000), // a start from before the shell: a reused pid
      row(701, 1, 25_000), // a start from after the stop
      row(702, 1), // no start time
      row(500, 1, 10_000),
    ];
    const targets = msysTreeTargets(rows, [600, 700, 701, 702, 500, 4, 999], root, 1);
    expect(targets.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 600, startedAt: 12_000 },
      { pid: 601, startedAt: 12_001 },
    ]);
  });

  it('keeps the 1 s spawn slack', () => {
    expect(msysTreeTargets([row(600, 1, 9_000)], [600], root, 1)).toEqual([{ pid: 600, startedAt: 9_000 }]);
    expect(msysTreeTargets([row(600, 1, 8_999)], [600], root, 1)).toEqual([]);
  });
});

describe('msysPidPrefix (#963)', () => {
  it('writes $$ on the same line, so error line numbers stay, with forward slashes', () => {
    expect(msysPidPrefix('C:\\Users\\a b\\x.pid')).toBe(`printf %s "$$" >'C:/Users/a b/x.pid' 2>/dev/null; `);
    expect(msysPidPrefix("C:\\it's\\x.pid")).toBeNull();
  });
});

describe('stopChildTree with a Git Bash shell (#963)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    expect(trackedChildren()).toEqual([]);
    for (const dir of dirs.splice(0)) rmSync(dir, TEST_DIR_RM_OPTIONS);
  });

  function shell(pidText: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'xez-msys-unit-'));
    dirs.push(dir);
    const pidFile = join(dir, 'shell.pid');
    if (pidText !== null) writeFileSync(pidFile, pidText);
    const child = Object.assign(new EventEmitter(), { pid: 500, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
    trackChild(child, { platform: 'win32', isOwnChild: () => true, now: () => 10_000, msys: { ps: 'C:\\Git\\usr\\bin\\ps.exe', pidFile } });
    const table: ProcessTable = { rows: [row(501, 500, 10_100), row(600, 3624, 12_000), row(601, 600, 12_001)], queriedAt: 20_000 };
    const killed: IdentifiedPid[][] = [];
    const readMsys = vi.fn(async () => [{ pid: 866, ppid: 1, pgid: 865, winpid: 600 }]);
    const readThenKill = vi.fn(async (choose: (table: ProcessTable) => readonly IdentifiedPid[]) => {
      killed.push([...choose(table)]);
      return null;
    });
    const deps = { platform: 'win32' as const, isOwnChild: () => true, now: () => 20_000 - STOP_CLOCK_SLACK_MS, readMsys, readThenKill };
    return { child, deps, killed, readMsys };
  }

  it('kills the shell first, then its Windows tree AND its MSYS group members, from one ps read', async () => {
    const { child, deps, killed, readMsys } = shell('865');
    await stopChildTree(child, 'SIGTERM', deps);
    expect(child.kill.mock.invocationCallOrder[0]).toBeLessThan(readMsys.mock.invocationCallOrder[0]!);
    expect(readMsys.mock.calls).toEqual([['C:\\Git\\usr\\bin\\ps.exe']]);
    expect(killed.map((targets) => targets.map(({ pid }) => pid).sort())).toEqual([[501, 600, 601]]);
    child.emit('exit');
  });

  it('without the pid file (the shell never got that far) reads no ps and stops the Windows tree only', async () => {
    const { child, deps, killed, readMsys } = shell(null);
    await stopChildTree(child, 'SIGTERM', deps);
    expect(readMsys).not.toHaveBeenCalled();
    expect(killed.map((targets) => targets.map(({ pid }) => pid))).toEqual([[501]]);
    child.emit('exit');
  });

  it.each(['linux', 'darwin'] as const)('on %s sends child.kill(signal) and reads nothing', async (platform) => {
    const { child, deps, readMsys } = shell('865');
    await stopChildTree(child, 'SIGTERM', { ...deps, platform });
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(readMsys).not.toHaveBeenCalled();
    expect(deps.readThenKill).not.toHaveBeenCalled();
    child.emit('exit');
  });
});
