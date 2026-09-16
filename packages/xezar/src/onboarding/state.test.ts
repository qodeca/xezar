import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  carriedCheck,
  onboardingStatePath,
  readOnboardingRecord,
  recordChecked,
  recordOffered,
  resetOnboardingWarnings,
  type OnboardingRecord,
} from './state.ts';

/**
 * The onboarding record (#464 P2).
 *
 * Every case here pins something the design says out loud, and each one is the difference between
 * a surface that tells the truth and one that quietly claims a check nobody ran:
 *
 *  - absent is NOT corrupt — a fresh project and an unreadable file must not read the same;
 *  - a reset on an identity change must not carry a previous successful check into a version
 *    nothing has looked at;
 *  - the pair a check covered must survive that reset, or the card cannot say what was checked;
 *  - and none of missing, corrupt or read-only may throw.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'xez-onboarding-')), '.local/xezar');
  mkdirSync(dataDir, { recursive: true });
  resetOnboardingWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const write = (value: unknown) =>
  writeFileSync(
    onboardingStatePath(dataDir),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );

const read = (): OnboardingRecord =>
  JSON.parse(readFileSync(onboardingStatePath(dataDir), 'utf8')) as OnboardingRecord;

const V1 = { engineVersion: '0.14.0', kitDigest: '2c20c60' };
const V2 = { engineVersion: '0.15.0', kitDigest: '2c20c60' };

describe('readOnboardingRecord', () => {
  it('tells an absent record apart from a corrupt one', async () => {
    // The whole point. Both produce `record: null`, but they are different sentences on screen —
    // "Not set up yet" for a project nothing has looked at, "Provenance unknown" for one whose
    // history exists and cannot be trusted — and collapsing them is the fail-open branch.
    expect(await readOnboardingRecord(dataDir)).toEqual({ status: 'absent', record: null });

    write('{ not json');
    expect(await readOnboardingRecord(dataDir)).toEqual({ status: 'corrupt', record: null });

    write('');
    expect(await readOnboardingRecord(dataDir)).toEqual({ status: 'corrupt', record: null });

    write({ engineVersion: '', kitDigest: '2c20c60', lastOfferedAt: null, lastCheckedAt: null });
    expect((await readOnboardingRecord(dataDir)).status).toBe('corrupt');
  });

  it('degrades one bad key without evicting the record, and keeps unknown keys', async () => {
    write({ ...V1, lastOfferedAt: 17, lastCheckedAt: null, writtenByANewerXezar: 'keep me' });
    const { status, record } = await readOnboardingRecord(dataDir);
    expect(status).toBe('ok');
    expect(record?.lastOfferedAt).toBeNull();
    expect(record).toMatchObject({ writtenByANewerXezar: 'keep me' });
  });

  it('warns at most once per path, so a corrupt file cannot spam a cockpit’s log', async () => {
    write('nonsense');
    await readOnboardingRecord(dataDir);
    await readOnboardingRecord(dataDir);
    await readOnboardingRecord(dataDir);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('recordOffered', () => {
  it('creates the record on first use and is idempotent for the same pair', async () => {
    const first = await recordOffered(dataDir, V1, () => '2026-09-16T08:00:00.000Z');
    expect(first.status).toBe('written');
    expect(read()).toMatchObject({ ...V1, lastOfferedAt: '2026-09-16T08:00:00.000Z' });

    // A retried click and a repeated MCP call must not move the moment the offer was made.
    const again = await recordOffered(dataDir, V1, () => '2026-09-16T09:00:00.000Z');
    expect(again.record.lastOfferedAt).toBe('2026-09-16T08:00:00.000Z');
    expect(read().lastOfferedAt).toBe('2026-09-16T08:00:00.000Z');
  });

  it('does not carry an offer across an identity change', async () => {
    await recordOffered(dataDir, V1, () => '2026-09-16T08:00:00.000Z');
    const moved = await recordOffered(dataDir, V2, () => '2026-09-16T10:00:00.000Z');
    // Were the old timestamp carried, the NEW version would read as already offered and the
    // person would never be shown the one notice the design promises them.
    expect(moved.record.lastOfferedAt).toBe('2026-09-16T10:00:00.000Z');
    expect(moved.record.engineVersion).toBe('0.15.0');
  });

  it('answers `unwritable` on a read-only directory instead of throwing', async () => {
    chmodSync(dataDir, 0o500);
    try {
      const result = await recordOffered(dataDir, V1);
      expect(result.status).toBe('unwritable');
      // The caller still gets a usable record: the cockpit degrades, it never fails to render.
      expect(result.record).toMatchObject({ ...V1 });
    } finally {
      chmodSync(dataDir, 0o700);
    }
  });
});

describe('recordChecked', () => {
  it('records the pair a check covered, and keeps it across an identity change', async () => {
    await recordChecked(dataDir, V1, () => '2026-09-02T16:40:00.000Z');
    expect(read()).toMatchObject({
      ...V1,
      lastCheckedAt: '2026-09-02T16:40:00.000Z',
      checked: { ...V1, at: '2026-09-02T16:40:00.000Z' },
    });

    // xezar moves on; the person presses Later. The contract's `lastCheckedAt` must go null for
    // the new pair, and the pair the check DID cover must survive — the Settings card says both.
    await recordOffered(dataDir, V2, () => '2026-09-16T08:02:00.000Z');
    const after = read();
    expect(after.lastCheckedAt).toBeNull();
    expect(after.checked).toEqual({ ...V1, at: '2026-09-02T16:40:00.000Z' });
    expect(after.lastOfferedAt).toBe('2026-09-16T08:02:00.000Z');
  });

  it('serialises concurrent writes rather than losing one', async () => {
    await Promise.all([
      recordChecked(dataDir, V1, () => '2026-09-02T16:40:00.000Z'),
      recordOffered(dataDir, V1, () => '2026-09-02T16:00:00.000Z'),
    ]);
    const after = read();
    expect(after.lastCheckedAt).toBe('2026-09-02T16:40:00.000Z');
    expect(after.lastOfferedAt).toBe('2026-09-02T16:00:00.000Z');
  });
});

describe('carriedCheck', () => {
  it('reads a record written before `checked` existed', () => {
    // Backward compatibility with the contract note's four fields: a non-null `lastCheckedAt`
    // there can only mean the record's own pair.
    expect(carriedCheck({ ...V1, lastOfferedAt: null, lastCheckedAt: '2026-09-02T16:40:00.000Z' })).toEqual(
      { ...V1, at: '2026-09-02T16:40:00.000Z' },
    );
    expect(carriedCheck({ ...V1, lastOfferedAt: null, lastCheckedAt: null })).toBeNull();
    expect(carriedCheck(null)).toBeNull();
  });
});
