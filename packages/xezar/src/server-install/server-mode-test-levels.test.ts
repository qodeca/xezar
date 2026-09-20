/**
 * Doc-check for `docs/testing/server-mode-test-levels.md` (#547 AC-1).
 *
 * The table recovered from the frozen evidence file is only useful if it stays
 * true: every row must still name a committed level and a suite that exists. A
 * row silently dropped, or a cited suite deleted/renamed, turns this red —
 * `BREAK-SM-MATRIX-ROW-DROPPED` deletes one row's cited suite and expects the
 * `cites at least one committed suite that still exists` case to fail.
 *
 * It parses the markdown rather than restating the table, so the document is
 * the single source of truth and the two cannot drift.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativeToRepoRoot: string): string =>
  readFileSync(new URL(`../../../../${relativeToRepoRoot}`, import.meta.url), 'utf8');

const TABLE_DOC = 'docs/testing/server-mode-test-levels.md';
const LEVELS = new Set(['unit', 'in-process route', 'packaged CLI', 'browser', 'one-off live proof']);

interface Row {
  risk: string;
  level: string;
  suites: string[];
}

function parseRows(): Row[] {
  const rows: Row[] = [];
  for (const line of read(TABLE_DOC).split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4) continue;
    const [risk, level, , guard] = cells;
    if (!risk || !level || !guard || risk === 'Risk' || risk.startsWith('---')) continue;
    rows.push({
      risk,
      level: level.replace(/`/g, ''),
      suites: [...guard.matchAll(/`([A-Za-z0-9_./-]+\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs))`/g)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined),
    });
  }
  return rows;
}

const rows = parseRows();

describe('docs/testing/server-mode-test-levels.md', () => {
  it('keeps all 14 recovered rows, each with a unique risk', () => {
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((row) => row.risk)).size).toBe(14);
  });

  it.each(rows)('$risk names one of the five levels', ({ level }) => {
    expect(LEVELS.has(level), `unknown level "${level}"`).toBe(true);
  });

  it.each(rows)('$risk cites at least one committed suite that still exists', ({ risk, suites }) => {
    expect(suites.length, `${risk} cites no suite`).toBeGreaterThan(0);
    for (const suite of suites) {
      expect(existsSync(new URL(`../../../../${suite}`, import.meta.url)), `${risk}: ${suite} is missing`).toBe(true);
    }
  });
});
