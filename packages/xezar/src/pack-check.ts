/** Tarball bundle check — the pure half of `scripts/check-pack.mjs`.
 *
 *  Phase R1 of the cockpit redesign shipped an npm tarball with no UI in it
 *  (`files` listed the sources, not the Vite build). This module pins that bug
 *  class: given the file list `npm pack --dry-run --json` reports, decide
 *  whether the package would ship a working cockpit. Kept dependency-free and
 *  side-effect-free so the decision is unit-testable; the script owns the
 *  `npm pack` invocation and the exit code.
 */

/** Human-readable problems with a would-be tarball; empty array = publishable.
 *
 *  Requirements:
 *  - `web/dist/index.html` — the built shell every GET serves.
 *  - at least one `web/dist/assets/*` file — the hashed JS/CSS bundles; an
 *    index.html alone renders a blank page.
 *  - NO `src/index.ts` — its presence is how a running xezar decides it is a
 *    development build (`install-channel.ts`, #442). A tarball carrying it would
 *    put the red "D" badge on every user's cockpit.
 */
export function findPackGaps(packedFiles: readonly string[]): string[] {
  const gaps: string[] = [];
  if (!packedFiles.includes('web/dist/index.html')) {
    gaps.push('web/dist/index.html is missing — the tarball would ship no UI shell (run `npm run build:web`)');
  }
  if (!packedFiles.some((f) => f.startsWith('web/dist/assets/') && f.length > 'web/dist/assets/'.length)) {
    gaps.push('no web/dist/assets/* bundle in the tarball — the shell would load with no JS/CSS');
  }
  if (packedFiles.includes('src/index.ts')) {
    gaps.push('src/index.ts is in the tarball — every installed cockpit would report channel "dev" and show the development-build badge (keep src out of `files`)');
  }
  return gaps;
}
