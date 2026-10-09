import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './mcp/audit-source-scan.testkit.ts';

/**
 * A test removes its scratch folder with `TEST_DIR_RM_OPTIONS` (`test/helpers/platform.ts`), never a
 * hand-written `{ recursive: true, force: true }` (#963). On Linux and macOS the two are the same
 * object; on Windows the shared one adds Node's own retry, because Windows refuses a delete with
 * EPERM or EBUSY for a moment after files were written. A raw literal there is how a passing test
 * failed in its `afterEach` in about 240 of the Windows CI failures.
 */
const SCAN_ROOTS = ['packages/xezar/src', 'packages/xezar/test'];
const HELPER = 'packages/xezar/test/helpers/platform.ts';
/** This file holds the spellings as fixtures. */
const SELF = 'packages/xezar/src/test-cleanup-scan.test.ts';
const RAW_CLEANUP = /\brm(?:Sync)?\([^;]*\{\s*recursive:\s*true,\s*force:\s*true\s*\}/;

/** Below this many scanned files the walk itself is broken: an empty scan must not read as clean. */
const MIN_SCANNED_FILES = 300;

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (/\.(test|testkit)\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

export function rawCleanups(source: string): number[] {
  return source.split('\n').flatMap((line, index) => (RAW_CLEANUP.test(line) ? [index + 1] : []));
}

describe('test scratch folders are removed with TEST_DIR_RM_OPTIONS (#963)', () => {
  it('finds no raw recursive-force removal in a test or testkit', () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    const findings = files.flatMap((file) => {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      if (rel === HELPER || rel === SELF) return [];
      return rawCleanups(readFileSync(file, 'utf8')).map((line) => `${rel}:${line}`);
    });
    expect(findings, 'use rmSync(dir, TEST_DIR_RM_OPTIONS) from test/helpers/platform.ts').toEqual([]);
  });

  it('recognises the spellings it exists to catch, and leaves the shared option alone', () => {
    expect(rawCleanups("rmSync(dir, { recursive: true, force: true });")).toEqual([1]);
    expect(rawCleanups("await rm(root, {recursive: true, force: true});")).toEqual([1]);
    expect(rawCleanups("rmSync(dir, TEST_DIR_RM_OPTIONS);")).toEqual([]);
    expect(rawCleanups("mkdirSync(dir, { recursive: true });")).toEqual([]);
  });
});
