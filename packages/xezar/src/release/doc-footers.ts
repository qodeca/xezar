/** The "Describes xezar X." documentation footers — which pages carry one, and how a release
 *  restamps them.
 *
 *  The user documentation ends each page with a footer naming the release whose behaviour the page
 *  was checked against. The version moves at release time, so the footers move in the same commit:
 *  `scripts/release.mjs` restamps them with `stampDocFooters` right after it stamps the manifests,
 *  and `guide-footer-version.test.ts` holds every footer to the service manifest's version. Both
 *  read the page set and the footer pattern from this one module, so they cannot disagree about
 *  which pages count or what a footer looks like.
 *
 *  Scope: every Markdown file under `docs/`, except the dated engineering records (the top-level
 *  `features/`, `research/`, `releases/` and `lessons/` folders), which describe the release they
 *  were written for and are never restamped.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The documentation root, relative to the repository root. */
export const DOCS_DIR = 'docs';

/** Top-level folders under the documentation root that hold dated records, never restamped. */
export const DATED_RECORD_DIRS: ReadonlySet<string> = new Set(['features', 'research', 'releases', 'lessons']);

/** A footer is a whole line of its own; the capture is the version it names. A fresh instance per
 *  use, because a global regex carries `lastIndex` state between calls. */
const footerPattern = (): RegExp => /^Describes xezar (\S+)\.$/gm;

/** One footer found on one page. `file` is repository-relative, with forward slashes. */
export interface DocFooter {
  file: string;
  version: string;
}

/** Every in-scope Markdown page under `<repoRoot>/docs`, repository-relative with forward slashes,
 *  sorted. Throws when the documentation root is missing, so a release cannot skip it silently. */
export function footerPages(repoRoot: string): string[] {
  const walk = (relDir: string, top: boolean): string[] =>
    readdirSync(join(repoRoot, relDir)).flatMap((name) => {
      const rel = `${relDir}/${name}`;
      if (statSync(join(repoRoot, rel)).isDirectory()) {
        return top && DATED_RECORD_DIRS.has(name) ? [] : walk(rel, false);
      }
      return name.endsWith('.md') ? [rel] : [];
    });
  return walk(DOCS_DIR, true).sort();
}

/** The version each footer line in `text` names, in order. */
export function footerVersions(text: string): string[] {
  return [...text.matchAll(footerPattern())].map((match) => match[1]!);
}

/** `text` with every footer line naming `version`. Everything else, line endings included, is
 *  left byte for byte. Refuses a version a footer could not read back. */
export function stampFooterText(text: string, version: string): string {
  if (!/^\S+$/.test(version)) {
    throw new Error(`cannot stamp documentation footers with version "${version}"`);
  }
  // A replacer function, not a string: a replacement string would expand `$&`-style patterns.
  return text.replace(footerPattern(), () => `Describes xezar ${version}.`);
}

/** Every footer on every in-scope page under `repoRoot`. */
export function readDocFooters(repoRoot: string): DocFooter[] {
  return footerPages(repoRoot).flatMap((file) =>
    footerVersions(readFileSync(join(repoRoot, file), 'utf8')).map((version) => ({ file, version })),
  );
}

/** Restamp every footer under `repoRoot` to `version`, in place. Returns the pages whose content
 *  changed (repository-relative, forward slashes, sorted); a page already at `version` is left
 *  untouched and not listed. */
export function stampDocFooters(repoRoot: string, version: string): string[] {
  return footerPages(repoRoot).filter((file) => {
    const path = join(repoRoot, file);
    const before = readFileSync(path, 'utf8');
    const after = stampFooterText(before, version);
    if (after === before) return false;
    writeFileSync(path, after, 'utf8');
    return true;
  });
}
