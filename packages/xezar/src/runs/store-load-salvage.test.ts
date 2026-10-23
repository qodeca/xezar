import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, runIndexBackupPath } from './store.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

const GOOD = (id: string) => ({
  id,
  title: 'fix the login bug',
  workflow: 'quick-task',
  task: 'fix the login bug',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
});

describe('RunStore.open tells "loaded" from "could not load"', () => {
  let dataDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xez-store-salvage-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(dataDir, TEST_DIR_RM_OPTIONS);
  });

  it('salvages the readable rows one by one when a single row is unreadable', () => {
    const original = JSON.stringify([GOOD('a'), { ...GOOD('bad'), status: 'from-a-newer-build' }, GOOD('b')]);
    writeFileSync(join(dataDir, 'runs.json'), original, 'utf8');

    const store = RunStore.open(dataDir);

    expect(store.listRuns().map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(store.loadedCleanly).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 unreadable run record(s)'));
    // The unreadable original is kept byte-for-byte before any save replaces runs.json.
    expect(readFileSync(runIndexBackupPath(dataDir), 'utf8')).toBe(original);
    store.close();
  });

  it('keeps a copy of a runs.json that is not JSON at all and reports it as not loaded', () => {
    writeFileSync(join(dataDir, 'runs.json'), '[{"id": "a", trunc', 'utf8');

    const store = RunStore.open(dataDir);

    expect(store.listRuns()).toEqual([]);
    expect(store.loadedCleanly).toBe(false);
    expect(readFileSync(runIndexBackupPath(dataDir), 'utf8')).toBe('[{"id": "a", trunc');
    store.close();
  });

  it('a clean file and a missing file both load cleanly and write no backup', () => {
    expect(RunStore.open(dataDir).loadedCleanly).toBe(true);
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([GOOD('a')]), 'utf8');
    const store = RunStore.open(dataDir);
    expect(store.loadedCleanly).toBe(true);
    expect(store.getRun('a')?.status).toBe('done');
    expect(existsSync(runIndexBackupPath(dataDir))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    store.close();
  });
});
