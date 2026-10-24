import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The user documentation ends each page with a "Describes xezar X." footer: the release whose
 * behaviour the page was checked against. Those footers were bumped by hand after each release,
 * and nothing noticed when one was missed. This ties every footer to the version in
 * `packages/xezar/package.json`, so a version change and the footers move in the same change.
 *
 * Scope: every Markdown file under `docs/`, except the dated engineering records (`features/`,
 * `research/`, `releases/`, `lessons/`), which describe the release they were written for and are
 * never re-stamped.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const docsRoot = join(repoRoot, 'docs');
const DATED_RECORDS = new Set(['features', 'research', 'releases', 'lessons']);
const FOOTER = /^Describes xezar (\S+)\.$/gm;

const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'packages/xezar/package.json'), 'utf8')) as { version: string }
).version;

function markdownFiles(dir: string, top = true): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return top && DATED_RECORDS.has(name) ? [] : markdownFiles(path, false);
    }
    return name.endsWith('.md') ? [path] : [];
  });
}

const footers = markdownFiles(docsRoot).flatMap((path) =>
  [...readFileSync(path, 'utf8').matchAll(FOOTER)].map((match) => ({
    file: relative(repoRoot, path).split('\\').join('/'),
    version: match[1]!,
  })),
);

describe('"Describes xezar X." documentation footers', () => {
  it('finds a footer on every user-guide part, so an empty scan cannot pass', () => {
    const guide = readdirSync(join(docsRoot, 'guide')).filter((name) => name.endsWith('.md'));
    expect(guide.length).toBeGreaterThan(0);
    const withFooter = new Set(footers.map((footer) => footer.file));
    const missing = guide.map((name) => `docs/guide/${name}`).filter((file) => !withFooter.has(file));
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
