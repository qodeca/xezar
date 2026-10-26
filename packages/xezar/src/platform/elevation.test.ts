import { describe, expect, it, vi } from 'vitest';
import { probeElevation, probeUserSid, sidFromWhoamiUser, whoamiSaysElevated } from './elevation.ts';

/** #980: which MCP folder a process uses depends on whether it runs as administrator. */

const row = (label: string, sid: string, attributes = '') => `"${label}","Label","${sid}","${attributes}"`;
const ADMINS_DENY_ONLY = '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"';

describe('whoamiSaysElevated (#980)', () => {
  it('reads the integrity label by SID: High or System is elevated, Medium is not', () => {
    expect(whoamiSaysElevated([row('Mandatory Label\\High Mandatory Level', 'S-1-16-12288'), ADMINS_DENY_ONLY].join('\r\n'))).toBe(true);
    expect(whoamiSaysElevated(row('Mandatory Label\\System Mandatory Level', 'S-1-16-16384'))).toBe(true);
    expect(whoamiSaysElevated([row('Mandatory Label\\Medium Mandatory Level', 'S-1-16-8192'), ADMINS_DENY_ONLY].join('\r\n'))).toBe(false);
    // Translated names do not matter, and a SID that only starts the same is not the label.
    expect(whoamiSaysElevated(row('Etykieta obowiązkowa\\Wysoki poziom', 'S-1-16-12288'))).toBe(true);
    expect(whoamiSaysElevated(row('x', 'S-1-16-122880'))).toBe(false);
    expect(whoamiSaysElevated('')).toBe(false);
  });
});

describe('probeElevation (#980)', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  it('asks whoami from System32 on Windows only', () => {
    const whoami = vi.fn(() => row('High', 'S-1-16-12288'));
    expect(probeElevation({ platform: 'win32', env, whoami })).toBe(true);
    expect(whoami).toHaveBeenCalledWith('C:\\Windows\\System32\\whoami.exe');
    for (const platform of ['linux', 'darwin'] as const) {
      const never = vi.fn(() => row('High', 'S-1-16-12288'));
      expect(probeElevation({ platform, env, whoami: never })).toBe(false);
      expect(never).not.toHaveBeenCalled();
    }
  });

  it('reads "not elevated" when whoami cannot run or SystemRoot is not a drive path', () => {
    expect(probeElevation({ platform: 'win32', env, whoami: () => null })).toBe(false);
    const whoami = vi.fn(() => row('High', 'S-1-16-12288'));
    expect(probeElevation({ platform: 'win32', env: { SystemRoot: '\\\\server\\share' }, whoami })).toBe(false);
    expect(whoami).not.toHaveBeenCalled();
  });
});

describe('the user SID probe (#980)', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const userRow = '"example-pc\\someone","S-1-5-21-1000000001-2000000002-3000000003-1001","High Mandatory Level"';

  it('reads the current user SID from a whoami /user CSV line', () => {
    expect(sidFromWhoamiUser(userRow)).toBe('S-1-5-21-1000000001-2000000002-3000000003-1001');
    expect(sidFromWhoamiUser('')).toBeNull();
  });

  it('asks whoami /user from System32 on Windows only', () => {
    const whoamiUser = vi.fn(() => userRow);
    expect(probeUserSid({ platform: 'win32', env, whoamiUser })).toBe('S-1-5-21-1000000001-2000000002-3000000003-1001');
    expect(whoamiUser).toHaveBeenCalledWith('C:\\Windows\\System32\\whoami.exe');
    for (const platform of ['linux', 'darwin'] as const) {
      const never = vi.fn(() => userRow);
      expect(probeUserSid({ platform, env, whoamiUser: never })).toBeNull();
      expect(never).not.toHaveBeenCalled();
    }
    expect(probeUserSid({ platform: 'win32', env, whoamiUser: () => null })).toBeNull();
  });
});
