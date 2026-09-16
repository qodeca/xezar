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
    gaps.push('web/dist/index.html is missing — the tarball would ship no UI shell (build the cockpit before packing)');
  }
  if (!packedFiles.some((f) => f.startsWith('web/dist/assets/') && f.length > 'web/dist/assets/'.length)) {
    gaps.push('no web/dist/assets/* bundle in the tarball — the shell would load with no JS/CSS');
  }
  if (packedFiles.includes('src/index.ts')) {
    gaps.push('src/index.ts is in the tarball — every installed cockpit would report channel "dev" and show the development-build badge (keep src out of `files`)');
  }
  return gaps;
}

/* ------------------------------------------------------------------------------------------------
 * Release content check (#466).
 *
 * The file list above proves the tarball can serve a cockpit. It says nothing about what the
 * bytes TELL a user: a released xezar must carry no instructions specific to the project xezar is
 * developed in (its source paths, its process documents, its kit scripts, its people). So
 * `check:pack` also packs a real archive into scratch, reads every entry out of it here, and
 * scans the decoded text against a rule list. The rule list is deliberately NOT in this module:
 * this file ships in `dist`, and a list of banned project names inside the package would be a
 * leak of its own — the rules live in a test-only module the build excludes.
 * ---------------------------------------------------------------------------------------------- */

/** One file read out of the packed archive, path as npm writes it (`package/…`). */
export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
}

/** A pattern the released text must not contain. Matched per line, case-insensitively. */
export interface ContentRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

/** One reviewed, still-present exception: this rule, in this exact file, on a line containing
 *  this fragment. Never a whole file, never a whole rule. */
export interface ContentException {
  rule: string;
  file: string;
  fragment: string;
  reason: string;
  ref: string;
}

export interface ContentLeak {
  rule: string;
  file: string;
  line: number;
  fragment: string;
}

/**
 * Parse an uncompressed tar (what `gunzip` of an npm `.tgz` yields). Throws on a malformed
 * header, a truncated entry or an archive with no end, so an unreadable archive can never read as
 * "no leaks found". Regular files only; directories and links carry no text to scan.
 */
export function readTarEntries(tar: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const decoder = new TextDecoder();
  const field = (block: Uint8Array, start: number, length: number) => {
    const bytes = block.subarray(start, start + length);
    const nul = bytes.indexOf(0);
    return decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
  };
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) return entries;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    const recorded = parseInt(field(header, 148, 8).trim() || 'NaN', 8);
    if (recorded !== checksum) throw new Error(`malformed tar header at byte ${offset}`);
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw new Error(`truncated tar entry ${name}`);
    const data = tar.subarray(dataStart, dataStart + size);
    if (type === 'L') longName = field(data, 0, size);
    else if (type === '0' || type === '\0') entries.push({ path: name, data });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error('tar archive has no end-of-archive marker — truncated');
}

/** What every release archive must contain for the content scan to mean anything. */
export const REQUIRED_ARCHIVE_ENTRIES = [
  'package/package.json',
  'package/README.md',
  'package/dist/index.js',
  'package/web/dist/index.html',
  'package/scripts/mock-claude.mjs',
];

/** Problems that make the archive itself unfit to judge: empty, or missing what it must ship. */
export function findArchiveGaps(entries: readonly ArchiveEntry[]): string[] {
  if (entries.length === 0) return ['the packed archive has no files — nothing could be checked'];
  const paths = new Set(entries.map((e) => e.path));
  const gaps = REQUIRED_ARCHIVE_ENTRIES.filter((p) => !paths.has(p)).map((p) => `${p} is missing from the packed archive`);
  if (!entries.some((e) => e.path.startsWith('package/dist/') && e.path.endsWith('.js') && e.data.length > 0)) {
    gaps.push('the packed archive has no non-empty dist/*.js — nothing executable could be checked');
  }
  return gaps;
}

const TEXT_FILE = /\.(?:[cm]?js|[cm]?ts|map|json|md|html?|css|txt|ya?ml|svg)$|(?:^|\/)(?:LICENSE|README|CHANGELOG)[^/]*$/i;

/** Every text entry of the archive, decoded — binaries (fonts, images) carry no instructions. */
export function isTextEntry(path: string): boolean {
  return TEXT_FILE.test(path);
}

/**
 * The line as a reader would see it: JSON/JS escapes of `/` and `\` undone, and backslash path
 * separators turned into slashes, so `packages\\xezar\\src` and `packages\/xezar\/src` match the
 * same rule as the plain spelling.
 */
export function normalizeForScan(line: string): string {
  return line
    .replace(/\\u002f/gi, '/')
    .replace(/\\u005c/gi, '/')
    .replace(/\\+\//g, '/')
    .replace(/\\+/g, '/');
}

/** Scan decoded text. `file` is a label for the report; an exception must name it exactly. */
export function scanText(
  file: string,
  text: string,
  rules: readonly ContentRule[],
  exceptions: readonly ContentException[],
  used?: Set<ContentException>,
): ContentLeak[] {
  const leaks: ContentLeak[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = normalizeForScan(raw);
    for (const rule of rules) {
      for (const match of line.matchAll(new RegExp(rule.pattern.source, 'gi'))) {
        const at = match.index ?? 0;
        const fragment = line.slice(Math.max(0, at - 40), at + match[0].length + 40).trim();
        const exception = exceptions.find((e) => e.rule === rule.id && e.file === file && line.includes(e.fragment));
        if (exception) {
          used?.add(exception);
          continue;
        }
        leaks.push({ rule: rule.id, file, line: index + 1, fragment });
      }
    }
  }
  return leaks;
}

/**
 * Every leak in the archive's text entries, plus every exception that no longer matches anything
 * — a stale exception is reported too, so the allowlist can only shrink.
 */
export function findContentLeaks(
  entries: readonly ArchiveEntry[],
  rules: readonly ContentRule[],
  exceptions: readonly ContentException[],
): { leaks: ContentLeak[]; staleExceptions: ContentException[]; scannedFiles: number } {
  if (rules.length === 0) throw new Error('no content rules — refusing to report a clean archive');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const used = new Set<ContentException>();
  const leaks: ContentLeak[] = [];
  let scannedFiles = 0;
  for (const entry of entries) {
    if (!isTextEntry(entry.path)) continue;
    scannedFiles++;
    const file = entry.path.replace(/^package\//, '');
    leaks.push(...scanText(file, decoder.decode(entry.data), rules, exceptions, used));
  }
  return { leaks, staleExceptions: exceptions.filter((e) => !used.has(e)), scannedFiles };
}

/** One line per leak: where, which rule, and a short fragment. */
export function formatLeak(leak: ContentLeak): string {
  return `${leak.file}:${leak.line} [${leak.rule}] …${leak.fragment}…`;
}
