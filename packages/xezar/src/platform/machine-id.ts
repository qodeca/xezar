/**
 * The platform's own machine id (#199, moved here for #963): `IOPlatformUUID` on macOS,
 * `MachineGuid` on Windows, `/etc/machine-id` (then the older D-Bus one) on Linux and the BSDs.
 * `machine-identity.ts` hashes it into the opaque id a writer claim carries.
 *
 * Every probe degrades to `null`: a missing `ioreg`, an unreadable file, a host that cannot name
 * itself. Leaf layer: this folder imports only `node:*` and its own siblings.
 */
import { readFileSync } from 'node:fs';
import { launchFileSync } from './process-launch.ts';
import { system32Program } from './system-programs.ts';

const PROBE_TIMEOUT_MS = 2000;

export function readPlatformMachineId(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') {
    // `"IOPlatformUUID" = "..."`, stable across reboots and OS upgrades, tied to the hardware.
    const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(probe('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']) ?? '');
    return uuid?.[1] ?? null;
  }
  if (platform === 'win32') {
    // reg.exe from System32, never whichever `reg` the PATH offers first (#963).
    const reg = system32Program('reg.exe') ?? 'reg';
    const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(probe(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']) ?? '');
    return guid?.[1] ?? null;
  }
  // Linux and the BSDs: systemd's id first, then the older D-Bus one it usually symlinks to.
  // Both are absent on minimal images, and `/etc/machine-id` is EMPTY on a systemd first boot.
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value) return value;
    } catch { /* try the next one; absence is normal here, not an error */ }
  }
  return null;
}

/** A fixed argument vector, no shell, bounded time, stderr discarded, or `null`. */
function probe(command: string, args: readonly string[]): string | null {
  try {
    return launchFileSync(command, [...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
