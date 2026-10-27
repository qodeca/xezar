import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveElevatedIpc, systemDriveRoot } from './elevated-ipc.ts';

/**
 * #980: where an elevated xezar and leader meet on Windows – under a machine-owned %ProgramData%
 * parent a normal process cannot swap, with the system drive resolved WITHOUT the environment.
 */

const SID = 'S-1-5-21-1-2-3-1001';
const scopeHash = (scope: string) => createHash('sha256').update(scope).digest('hex').slice(0, 16);

describe('systemDriveRoot (#980)', () => {
  it('resolves the system drive from the kernel SystemRoot object, never the environment', () => {
    const realpath = vi.fn(() => 'C:\\Windows');
    expect(systemDriveRoot({ platform: 'win32', realpath })).toBe('C:\\');
    expect(realpath).toHaveBeenCalledWith('\\\\?\\GLOBALROOT\\SystemRoot');
    // A different system drive is honoured.
    expect(systemDriveRoot({ platform: 'win32', realpath: () => 'D:\\WINDOWS' })).toBe('D:\\');
  });

  it('is null off Windows, or when the kernel path cannot be read or is not a drive path', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(systemDriveRoot({ platform, realpath: () => 'C:\\Windows' })).toBeNull();
    }
    expect(systemDriveRoot({ platform: 'win32', realpath: () => null })).toBeNull();
    expect(systemDriveRoot({ platform: 'win32', realpath: () => '\\\\server\\share\\Windows' })).toBeNull();
  });
});

describe('resolveElevatedIpc (#980)', () => {
  const deps = { platform: 'win32' as const, realpath: () => 'C:\\Windows', sid: SID };

  it('builds %ProgramData%\\xezar\\ipc-admin\\<SID>\\<scopeHash>, with the chain to create and the ancestor to verify', () => {
    const scope = 'C:\\Users\\me\\.xezar\\ipc';
    const pd = 'C:\\ProgramData';
    const xezar = win32.join(pd, 'xezar');
    const ipcAdmin = win32.join(xezar, 'ipc-admin');
    const perUser = win32.join(ipcAdmin, SID);
    const leaf = win32.join(perUser, scopeHash(scope));
    expect(resolveElevatedIpc(scope, deps)).toEqual({ dir: leaf, create: [xezar, ipcAdmin, perUser, leaf], ancestors: [pd] });
  });

  it('separates two state scopes of the same user under the one machine-wide tree', () => {
    const a = resolveElevatedIpc('C:\\a\\ipc', deps);
    const b = resolveElevatedIpc('C:\\b\\ipc', deps);
    expect(a!.dir).not.toBe(b!.dir);
    // Only the leaf differs; the owned chain and the ancestor are shared.
    expect(a!.create.slice(0, 3)).toEqual(b!.create.slice(0, 3));
    expect(a!.ancestors).toEqual(b!.ancestors);
  });

  it('is null off Windows, or when the system drive or the user SID cannot be read', () => {
    expect(resolveElevatedIpc('s', { platform: 'linux', realpath: () => 'C:\\Windows', sid: SID })).toBeNull();
    expect(resolveElevatedIpc('s', { platform: 'win32', realpath: () => null, sid: SID })).toBeNull();
    expect(resolveElevatedIpc('s', { platform: 'win32', realpath: () => 'C:\\Windows', sid: null })).toBeNull();
    // A value that is not a SID is never trusted into the path.
    expect(resolveElevatedIpc('s', { platform: 'win32', realpath: () => 'C:\\Windows', sid: '..\\evil' })).toBeNull();
  });
});
