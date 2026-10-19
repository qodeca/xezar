import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunIndexFromDisk, readRunIndexReport } from './run-index.ts';
import { TEST_DIR_RM_OPTIONS } from '../../test/helpers/platform.ts';

const GOOD = (id: string) => ({
  id,
  title: 't',
  workflow: 'quick-task',
  task: 't',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
});

describe('the read-only run index keeps every record that parses', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xez-run-index-'));
  });
  afterEach(() => rmSync(dataDir, TEST_DIR_RM_OPTIONS));

  it('one unreadable row drops that row alone and is counted', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([GOOD('a'), { ...GOOD('bad'), status: 'from-a-newer-build' }, GOOD('b')]),
      'utf8',
    );
    // The workspace index reads through this: before per-record reading it answered [].
    expect(readRunIndexFromDisk(dataDir).map((r) => r.id)).toEqual(['a', 'b']);
    const read = readRunIndexReport(dataDir);
    expect(read.runs.map((r) => r.id)).toEqual(['a', 'b']);
    expect(read.dropped).toBe(1);
  });

  it('a clean file drops nothing; a missing or non-array file contributes nothing', () => {
    expect(readRunIndexReport(dataDir)).toEqual({ runs: [], dropped: 0 });
    writeFileSync(join(dataDir, 'runs.json'), '{"not": "a list"}', 'utf8');
    expect(readRunIndexReport(dataDir)).toEqual({ runs: [], dropped: 0 });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([GOOD('a')]), 'utf8');
    expect(readRunIndexReport(dataDir).dropped).toBe(0);
    expect(readRunIndexReport(dataDir).runs).toHaveLength(1);
  });
});
