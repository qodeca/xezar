import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localMachineId, machineRelation, __clearMachineIdCacheForTests } from './machine-identity.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readlinkSync: vi.fn(actual.readlinkSync) };
});

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(readlinkSync).mockReset();
  __clearMachineIdCacheForTests();
});

describe('machineRelation', () => {
  it('answers same only when both sides name the identical machine', () => {
    expect(machineRelation('machine-a', 'machine-a')).toBe('same');
    expect(machineRelation('machine-b', 'machine-a')).toBe('different');
  });

  // The fail-open pin: absent input and "no match" must never take the same branch, or a host
  // that cannot identify itself would silently claim every claim as its own and reap live PIDs.
  it('answers unknown, never same, when either side has no identity to compare', () => {
    expect(machineRelation('machine-a', null)).toBe('unknown');
    expect(machineRelation(undefined, 'machine-a')).toBe('unknown');
    expect(machineRelation('', 'machine-a')).toBe('unknown');
    expect(machineRelation(null, null)).toBe('unknown');
    expect(machineRelation({ machine: 'machine-a' }, 'machine-a')).toBe('unknown');
    expect(machineRelation(12345, 'machine-a')).toBe('unknown');
  });
});

describe('localMachineId', () => {
  it('degrades to null instead of throwing when no platform probe answers', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ioreg: not found'); });
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    vi.mocked(readlinkSync).mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    expect(localMachineId()).toBeNull();
  });

  it('probes once per process and reuses the answer', () => {
    vi.mocked(execFileSync).mockReturnValue('  "IOPlatformUUID" = "3E1F0000-1111-2222-3333-444455556666"\n');
    vi.mocked(readFileSync).mockReturnValue('c1f0a9d2e3b44c5d8e6f70819a2b3c4d\n');
    vi.mocked(readlinkSync).mockReturnValue('pid:[4026531836]');
    const first = localMachineId();
    const second = localMachineId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
    // One probe for the whole process: darwin spawns `ioreg`, the others read a file.
    expect(vi.mocked(execFileSync).mock.calls.length + vi.mocked(readFileSync).mock.calls.length).toBe(1);
  });

  it('is an opaque token rather than the raw platform id', () => {
    const uuid = '3E1F0000-1111-2222-3333-444455556666';
    vi.mocked(execFileSync).mockReturnValue(`  "IOPlatformUUID" = "${uuid}"\n`);
    vi.mocked(readFileSync).mockReturnValue(`${uuid}\n`);
    vi.mocked(readlinkSync).mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    const id = localMachineId();
    expect(id).not.toBeNull();
    expect(id).not.toContain(uuid);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a platform that answers with nothing usable is not an identity', () => {
    vi.mocked(execFileSync).mockReturnValue('no platform uuid here\n');
    // A systemd first boot leaves /etc/machine-id empty; an empty id must not become an identity.
    vi.mocked(readFileSync).mockReturnValue('\n');
    vi.mocked(readlinkSync).mockReturnValue('pid:[4026531836]');
    expect(localMachineId()).toBeNull();
  });
});
