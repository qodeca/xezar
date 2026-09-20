/**
 * Doc-check for `docs/testing/multi-project-harness.md` (#548 AC-5).
 *
 * #548 AC-5 asks for two facts to live in the tracked tree rather than only in PR
 * bodies: the harness's runtime stated against an agreed ceiling, and the named
 * breaks the harness was red-proved against. This test pins both.
 *
 * `BREAK-MP-RUNTIME-UNSTATED` removes the ceiling line and expects the
 * `states the runtime ceiling` case to fail; `BREAK-MP-CI-MISSING` is proved by the
 * harness itself, not here (the CI job runs `npm run test:multi-project`, and the
 * recorded `unstamped-b-event` break makes that command exit non-zero).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativeToRepoRoot: string): string =>
  readFileSync(new URL(`../../../../${relativeToRepoRoot}`, import.meta.url), 'utf8');

const HARNESS_DOC = 'docs/testing/multi-project-harness.md';

describe('docs/testing/multi-project-harness.md', () => {
  it('states the measured runtime and the runtime ceiling', () => {
    const doc = read(HARNESS_DOC);
    expect(doc).toMatch(/1 minute 44 seconds\s*\(104 s\)/);
    expect(doc).toMatch(/Runtime ceiling: 5 minutes \(300 s\)/);
  });

  it('records every named break the harness was red-proved against', () => {
    const doc = read(HARNESS_DOC);
    for (const namedBreak of ['shared-home-split', 'unstamped-b-event', 'patternless-cleanup', 'disposed-b-still-attached']) {
      expect(doc, `${namedBreak} is not recorded`).toContain(namedBreak);
    }
  });

  it('reproduces one named break in-tree with its failing line', () => {
    const doc = read(HARNESS_DOC);
    expect(doc).toMatch(/In-tree reproduction: `unstamped-b-event`/);
    expect(doc).toContain('Error: workspace SSE stamps both projects');
  });
});
