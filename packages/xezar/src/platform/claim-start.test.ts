import { describe, expect, it, vi } from 'vitest';
import {
  __forgetClaimProcessesForTests,
  CLAIM_START_SLACK_MS,
  claimProcess,
  claimStartedAt,
  CREATED_AT_SCRIPT,
  createdAtFrom,
  primeClaimProcess,
  SAME_PROCESS_REMEMBERED_MS,
} from './claim-start.ts';
import type { TableRunner } from './process-table.ts';

/** `ms` as the Windows FILETIME text PowerShell prints. */
const fileTime = (ms: number): string => String(BigInt(ms) * 10000n + 116444736000000000n);

describe('claimStartedAt (#963)', () => {
  it('records a start time on Windows only', () => {
    expect(claimStartedAt('win32')).toBeTypeOf('number');
    expect(claimStartedAt('win32')).toBeLessThanOrEqual(Date.now());
    expect(claimStartedAt('linux')).toBeUndefined();
    expect(claimStartedAt('darwin')).toBeUndefined();
  });
});

describe('claimProcess (#963)', () => {
  const STARTED = 1_800_000_000_000;

  it('calls a pid created after the claim another process, and one created before it the same', () => {
    expect(claimProcess(42, STARTED, { platform: 'win32', createdAt: () => STARTED - 300 })).toBe('same');
    expect(claimProcess(42, STARTED, { platform: 'win32', createdAt: () => STARTED + CLAIM_START_SLACK_MS })).toBe('same');
    expect(claimProcess(42, STARTED, { platform: 'win32', createdAt: () => STARTED + CLAIM_START_SLACK_MS + 1 })).toBe('other');
  });

  it('answers unknown, and keeps the pid answer, whenever it lacks evidence', () => {
    expect(claimProcess(42, STARTED, { platform: 'win32', createdAt: () => null })).toBe('unknown');
    for (const started of [undefined, null, '1800000000000', 1.5, Number.NaN]) {
      expect(claimProcess(42, started, { platform: 'win32', createdAt: () => STARTED + 60_000 })).toBe('unknown');
    }
    expect(claimProcess(0, STARTED, { platform: 'win32', createdAt: () => STARTED + 60_000 })).toBe('unknown');
  });

  // CI run 39216917631 (Windows): a dead writer's pid answered alive to the signal-0 probe, the
  // look then found no process with that pid, and the claim was kept as live – "live writer PID
  // 6640" refused the next start. A look that finds no process is proof the writer is gone.
  it('calls a pid with no process behind it at look time another process, never unknown', async () => {
    expect(claimProcess(42, STARTED, { platform: 'win32', createdAt: () => 'gone' })).toBe('other');
    __forgetClaimProcessesForTests();
    await primeClaimProcess(43, STARTED, { platform: 'win32', run: async () => 'gone\r\n', powershell: 'powershell.exe' });
    expect(claimProcess(43, STARTED, { platform: 'win32', mode: 'remembered' })).toBe('other');
    __forgetClaimProcessesForTests();
  });

  it('GUARD: a start time it cannot read stays unknown, so a live writer is never reaped on a refusal', async () => {
    expect(createdAtFrom('-')).toBeNull();
    expect(createdAtFrom('')).toBeNull();
    expect(createdAtFrom(`${fileTime(STARTED)}\r\n`)).toBe(STARTED);
    __forgetClaimProcessesForTests();
    await primeClaimProcess(44, STARTED, { platform: 'win32', run: async () => '-', powershell: 'powershell.exe' });
    expect(claimProcess(44, STARTED, { platform: 'win32', mode: 'remembered' })).toBe('unknown');
    __forgetClaimProcessesForTests();
  });

  it('GUARD: the look says gone only where no process has the pid, and - where it cannot read one', () => {
    // The two answers come from different statements: a lookup that throws, and a start-time read
    // that throws on a process that does exist.
    expect(CREATED_AT_SCRIPT).toMatch(/GetProcessById\([^)]*\)\s*\}\s*catch\s*\{\s*'gone'/);
    expect(CREATED_AT_SCRIPT).toMatch(/StartTime\.ToFileTimeUtc\(\)\s*\}\s*catch\s*\{\s*'-'\s*\}$/);
  });

  it('GUARD: a remembered check never looks on the calling thread: a miss keeps the pid answer and looks in the background', async () => {
    __forgetClaimProcessesForTests();
    const run = vi.fn<TableRunner>(async () => fileTime(STARTED + 60_000));
    // 'remembered' with nothing remembered: unknown at once – the look runs in the background.
    expect(claimProcess(42, STARTED, { platform: 'win32', mode: 'remembered', run, powershell: 'powershell.exe' })).toBe('unknown');
    await primeClaimProcess(42, STARTED, { platform: 'win32', run, powershell: 'powershell.exe' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![2]).toMatchObject({ env: expect.objectContaining({ CLAIM_START_PID: '42' }) });
    // The background look's answer is what the next call gets, and a second prime starts nothing.
    expect(claimProcess(42, STARTED, { platform: 'win32', mode: 'remembered' })).toBe('other');
    await primeClaimProcess(42, STARTED, { platform: 'win32', run, powershell: 'powershell.exe' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('trusts a remembered same only briefly, because that writer can die and its pid be reused', async () => {
    __forgetClaimProcessesForTests();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(STARTED + 1_000);
      await primeClaimProcess(7, STARTED, { platform: 'win32', run: async () => fileTime(STARTED - 50), powershell: 'powershell.exe' });
      expect(claimProcess(7, STARTED, { platform: 'win32', mode: 'remembered' })).toBe('same');
      now.mockReturnValue(STARTED + 1_000 + SAME_PROCESS_REMEMBERED_MS + 1);
      expect(claimProcess(7, STARTED, { platform: 'win32', mode: 'remembered' })).toBe('unknown');
    } finally {
      now.mockRestore();
      __forgetClaimProcessesForTests();
    }
  });

  it('remembers nothing it could not read', async () => {
    __forgetClaimProcessesForTests();
    await primeClaimProcess(9, STARTED, { platform: 'win32', run: async () => null, powershell: 'powershell.exe' });
    expect(claimProcess(9, STARTED, { platform: 'win32', mode: 'remembered' })).toBe('unknown');
    __forgetClaimProcessesForTests();
  });

  it('GUARD: Linux and macOS never look and never answer other', () => {
    const createdAt = vi.fn(() => STARTED + 60_000);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(claimProcess(42, STARTED, { platform, createdAt })).toBe('unknown');
    }
    expect(createdAt).not.toHaveBeenCalled();
  });
});
