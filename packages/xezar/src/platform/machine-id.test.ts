import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPlatformMachineId } from './machine-id.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn() };
});

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

describe('readPlatformMachineId (#199, #963)', () => {
  it('reads IOPlatformUUID on macOS', () => {
    vi.mocked(execFileSync).mockReturnValue('  "IOPlatformUUID" = "ABC-123"\n' as never);
    expect(readPlatformMachineId('darwin')).toBe('ABC-123');
    expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe('ioreg');
  });

  it('reads MachineGuid from the registry on Windows', () => {
    vi.mocked(execFileSync).mockReturnValue('    MachineGuid    REG_SZ    1111-2222\r\n' as never);
    expect(readPlatformMachineId('win32')).toBe('1111-2222');
    const args = vi.mocked(execFileSync).mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
  });

  it('reads /etc/machine-id on Linux, skipping an empty one for the D-Bus id', () => {
    vi.mocked(readFileSync).mockImplementation(((path: string) => (path === '/etc/machine-id' ? '\n' : 'dbus-id\n')) as never);
    expect(readPlatformMachineId('linux')).toBe('dbus-id');
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('degrades to null when the probe fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });
    expect(readPlatformMachineId('darwin')).toBeNull();
    expect(readPlatformMachineId('win32')).toBeNull();
  });
});
