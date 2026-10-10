import { describe, expect, it, vi } from 'vitest';
import { CLAIM_START_SLACK_MS, claimProcess, claimStartedAt } from './claim-start.ts';

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

  it('GUARD: Linux and macOS never look and never answer other', () => {
    const createdAt = vi.fn(() => STARTED + 60_000);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(claimProcess(42, STARTED, { platform, createdAt })).toBe('unknown');
    }
    expect(createdAt).not.toHaveBeenCalled();
  });
});
