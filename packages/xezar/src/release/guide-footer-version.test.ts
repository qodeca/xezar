import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_DIR, readDocFooters } from './doc-footers.ts';

/**
 * The user documentation ends each page with a "Describes xezar X." footer: the release whose
 * behaviour the page was checked against. Those footers used to be bumped by hand after each
 * release, and nothing noticed when one was missed. This ties every footer to the version in
 * `packages/xezar/package.json`, so a version change and the footers move in the same change. The
 * Release workflow's version bump restamps them with the manifests (`scripts/release.mjs`).
 *
 * Which pages count and what a footer looks like live in `doc-footers.ts`, shared with the
 * release script: every Markdown file under `docs/` except the dated engineering records.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const guideDir = `${DOCS_DIR}/guide`;

const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'packages/xezar/package.json'), 'utf8')) as { version: string }
).version;

const footers = readDocFooters(repoRoot);

describe('"Describes xezar X." documentation footers', () => {
  it('finds a footer on every user-guide part, so an empty scan cannot pass', () => {
    const guide = readdirSync(join(repoRoot, guideDir)).filter((name) => name.endsWith('.md'));
    expect(guide.length).toBeGreaterThan(0);
    const withFooter = new Set(footers.map((footer) => footer.file));
    const missing = guide.map((name) => `${guideDir}/${name}`).filter((file) => !withFooter.has(file));
    expect(missing, 'these guide parts have no "Describes xezar X." footer').toEqual([]);
  });

  it(`names ${packageVersion}, the version in packages/xezar/package.json, in every footer`, () => {
    const stale = footers.filter((footer) => footer.version !== packageVersion);
    expect(
      stale.map((footer) => `${footer.file}: Describes xezar ${footer.version}.`),
      `Each footer must read "Describes xezar ${packageVersion}." – update these in the same change as the version`,
    ).toEqual([]);
  });
});
