import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunIndexFromDisk, readRunIndexFromDiskChecked } from './run-index.ts';
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

  it('one unreadable row drops that row alone and marks the file not fully readable', () => {
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify([GOOD('a'), { ...GOOD('bad'), status: 'from-a-newer-build' }, GOOD('b')]),
      'utf8',
    );
    // The workspace index reads through this: before per-record reading it answered [].
    expect(readRunIndexFromDisk(dataDir).map((r) => r.id)).toEqual(['a', 'b']);
    const read = readRunIndexFromDiskChecked(dataDir);
    expect(read.runs.map((r) => r.id)).toEqual(['a', 'b']);
    expect(read.readable).toBe(false);
  });

  it('a clean file drops nothing; a missing or non-array file contributes nothing', () => {
    // No file: a project nobody has run a task in yet, which is readable and empty.
    expect(readRunIndexFromDiskChecked(dataDir)).toEqual({ runs: [], readable: true });
    writeFileSync(join(dataDir, 'runs.json'), '{"not": "a list"}', 'utf8');
    expect(readRunIndexFromDiskChecked(dataDir)).toEqual({ runs: [], readable: false });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify([GOOD('a')]), 'utf8');
    expect(readRunIndexFromDiskChecked(dataDir).readable).toBe(true);
    expect(readRunIndexFromDiskChecked(dataDir).runs).toHaveLength(1);
  });
});
