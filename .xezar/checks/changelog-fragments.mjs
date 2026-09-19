#!/usr/bin/env node
// Changelog fragments (issue #668).
//
// `CHANGELOG.md` is append-only at the top, so every open pull request edits the same lines of
// its one `# Unreleased` section and the first merge makes every other pull request conflict —
// and a content conflict stops GitHub from running CI on it at all. A pull request now writes its
// own small file under `changelog.d/` instead, and the `changelog` step of the `release` workflow
// folds the fragments into the new `# <version> (<date>)` section it was already assembling.
//
// This module owns the fragment GRAMMAR, because the checker and the fold must agree on it:
//
//   node .xezar/checks/changelog-fragments.mjs --check <dir>
//   node .xezar/checks/changelog-fragments.mjs --fold --version <semver> --date <YYYY-MM-DD>
//        [--file <CHANGELOG.md>] [--fragments <dir>]
//
// A fragment carries only bullets (`- …`) under a `## <heading>` drawn from CHANGELOG.md's own
// house set, exactly the shape the file already uses — including the indented continuation lines
// a wrapped bullet has. `README.md` is documentation, not a fragment, and is skipped.
//
// The refusal of a direct `# Unreleased` edit lives in `changelog-check.sh`, which owns the
// changelog's heading rules; this script never edits `# Unreleased`.

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** CHANGELOG.md's own group headings, in the order a release section emits them. */
export const HOUSE_HEADINGS = [
  '## Highlights',
  '## 💥 Breaking',
  '## 🔒 Security',
  '## ✨ Features',
  '## 🐛 Fixes',
  '## 🔧 Changed',
  '## 📝 Specs & Documentation',
  '## 🚀 CI/CD & Infrastructure',
  '## 👥 Contributors',
];

const IGNORED = new Set(['README.md']);

/**
 * The fence marker (``` or ~~~) a line opens or closes a fenced code block with, or `null`.
 * `changelog-check.sh` walks the same file with this rule, so the check and the fold cannot
 * disagree about which `# ` lines are section boundaries (issue #684).
 */
const fenceMarker = (line) => /^(`{3,}|~{3,})/.exec(line)?.[1][0] ?? null;

/**
 * `true` for each line that sits inside a fenced code block. A fence toggles on a line starting
 * with its own marker — a `~~~` line inside a ``` block is content, not a closer — and a fence
 * that opens and never closes runs to the end of the file, exactly as in `changelog-check.sh`.
 */
function fenceLines(lines) {
  const inside = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = fenceMarker(lines[i]);
    if (marker !== null && (open === null || open === marker)) {
      open = open === null ? marker : null;
      continue;
    }
    inside[i] = open !== null;
  }
  return inside;
}

/** A top-level `# ` heading, unless the line is content inside a fenced code block. */
const isTopHeading = (line, inFence) => !inFence && /^# /.test(line);

/**
 * Every fragment file in `dir`, sorted by name so the fold is deterministic.
 * A missing directory is not an error here — the caller decides that.
 */
export function fragmentFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !IGNORED.has(name))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Parse one fragment. Returns `{ errors, groups, bullets }` where `groups` is an ordered
 * `Map<heading, string[]>` of bullet lines (continuations included).
 *
 * Grammar, and why it is this loose: a bullet in CHANGELOG.md wraps onto indented continuation
 * lines, so "bullets only" cannot mean "every line starts with `- `". What it does mean is that
 * nothing may appear before the first bullet of a group but a `## ` heading, so a fragment of
 * prose, or one with a stray `# ` heading, is refused.
 */
export function parseFragment(text, file) {
  const errors = [];
  const groups = new Map();
  let current = null;
  let bullets = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const at = `${file}:${i + 1}`;
    if (line.startsWith('## ')) {
      if (!HOUSE_HEADINGS.includes(line)) {
        errors.push(`${at}: "${line}" is not one of the changelog's group headings (${HOUSE_HEADINGS.join(', ')})`);
        current = null;
        continue;
      }
      current = line;
      if (!groups.has(current)) groups.set(current, []);
      continue;
    }
    if (line.startsWith('#')) {
      errors.push(`${at}: a fragment carries no top-level heading, got "${line}"`);
      current = null;
      continue;
    }
    if (line.startsWith('- ')) {
      if (current === null) {
        errors.push(`${at}: a bullet must sit under a "## <heading>" line`);
        continue;
      }
      groups.get(current).push(line);
      bullets += 1;
      continue;
    }
    if (current === null || groups.get(current).length === 0) {
      errors.push(`${at}: only a "## <heading>" line and "- " bullets may appear before a fragment's first bullet, got "${line}"`);
      continue;
    }
    // A continuation line of the bullet above it. Kept verbatim.
    groups.get(current).push(line);
  }
  if (bullets === 0) errors.push(`${file}: has no bullet; a fragment that adds nothing should be deleted`);
  return { errors, groups, bullets };
}

/** Read and parse every fragment in `dir`, merging repeated headings in filename order. */
export function readFragments(dir) {
  const errors = [];
  const merged = new Map();
  const files = fragmentFiles(dir);
  for (const file of files) {
    const parsed = parseFragment(readFileSync(file, 'utf8'), file);
    errors.push(...parsed.errors);
    for (const [heading, lines] of parsed.groups) {
      if (!merged.has(heading)) merged.set(heading, []);
      merged.get(heading).push(...lines);
    }
  }
  return { errors, groups: merged, files };
}

/** Index of the next top-level heading after `headingIndex`, or the line count. */
function sectionEnd(lines, headingIndex, inside) {
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (isTopHeading(lines[i], inside[i])) return i;
  }
  return lines.length;
}

/** The trailing `---` separator of a section, or `end` when it has none. */
function separatorIndex(lines, start, end) {
  let i = end - 1;
  while (i > start && lines[i].trim() === '') i -= 1;
  return lines[i]?.trim() === '---' ? i : end;
}

/**
 * Merge fragment groups into the `# <version> (` section starting at `headingIndex`.
 * Existing groups keep their position; a group the section does not have yet is added in house
 * order. Bullets are appended to the end of their group, verbatim, and the section is re-emitted
 * with one blank line between groups so a wrapped bullet never touches the next heading.
 */
function mergeIntoSection(lines, headingIndex, groups, inside) {
  const end = sectionEnd(lines, headingIndex, inside);
  const sep = separatorIndex(lines, headingIndex, end);
  const body = lines.slice(headingIndex + 1, sep);
  const trailing = lines.slice(sep, end);

  const preamble = [];
  const parsed = [];
  let current = null;
  for (const line of body) {
    if (line.startsWith('## ')) {
      current = { heading: line, lines: [] };
      parsed.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  for (const heading of HOUSE_HEADINGS) {
    if (!groups.has(heading)) continue;
    let group = parsed.find((entry) => entry.heading === heading);
    if (!group) {
      group = { heading, lines: [] };
      parsed.push(group);
    }
    while (group.lines.length > 0 && group.lines[group.lines.length - 1].trim() === '') group.lines.pop();
    group.lines.push(...groups.get(heading));
  }
  parsed.sort((a, b) => HOUSE_HEADINGS.indexOf(a.heading) - HOUSE_HEADINGS.indexOf(b.heading));

  const out = lines.slice(0, headingIndex + 1);
  const preambleLines = preamble.filter((line) => line.trim() !== '');
  if (preambleLines.length > 0) out.push('', ...preambleLines);
  for (const group of parsed) {
    const groupLines = group.lines.slice();
    while (groupLines.length > 0 && groupLines[0].trim() === '') groupLines.shift();
    while (groupLines.length > 0 && groupLines[groupLines.length - 1].trim() === '') groupLines.pop();
    out.push('', group.heading, '', ...groupLines);
  }
  if (trailing.length === 0) out.push('');
  else if (out[out.length - 1].trim() !== '') out.push('');
  out.push(...trailing);
  out.push(...lines.slice(end));
  return out;
}

/** A brand-new `# <version> (<date>)` section from the fragments, separator included. */
function newSection(heading, groups) {
  const section = [heading, ''];
  for (const group of HOUSE_HEADINGS) {
    if (!groups.has(group)) continue;
    section.push(group, '', ...groups.get(group), '');
  }
  section.push('---', '');
  return section;
}

/** Fold every fragment into `file`, then delete the folded files. */
export function foldChangelog({ file, dir, version, date }) {
  const { errors, groups, files } = readFragments(dir);
  if (errors.length > 0) return { errors, folded: 0 };
  if (files.length === 0) return { errors: [], folded: 0 };

  const lines = readFileSync(file, 'utf8').split('\n');
  const inside = fenceLines(lines);
  const heading = `# ${version} (${date})`;
  const existing = lines.findIndex((line) => line.startsWith(`# ${version} (`));
  let out;
  if (existing !== -1) {
    out = mergeIntoSection(lines, existing, groups, inside);
  } else {
    // Directly above the newest existing top-level heading, below `# Unreleased` when it is
    // there — the check requires Unreleased to stay the first section. A file with no
    // `# Unreleased` (a release already folded it) gets the new section at the very top.
    let insertAt = lines.findIndex(
      (line, i) => isTopHeading(line, inside[i]) && line.trim() !== '# Unreleased',
    );
    if (insertAt === -1) insertAt = lines.length;
    const section = newSection(heading, groups);
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') section.unshift('');
    out = lines.slice();
    out.splice(insertAt, 0, ...section);
  }
  writeFileSync(file, out.join('\n'));
  for (const fragment of files) rmSync(fragment);
  return { errors: [], folded: files.length };
}

// --- CLI ---------------------------------------------------------------------------------------
function usage(stream) {
  stream.write('usage: changelog-fragments.mjs --check <dir>\n');
  stream.write('       changelog-fragments.mjs --fold --version <semver> --date <YYYY-MM-DD> [--file <path>] [--fragments <dir>]\n');
}

function main(argv) {
  let mode = '';
  let dir = '';
  let file = 'CHANGELOG.md';
  let version = '';
  let date = '';
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--check':
        mode = 'check';
        dir = argv[++i] ?? '';
        break;
      case '--fold':
        mode = 'fold';
        break;
      case '--version':
        version = argv[++i] ?? '';
        break;
      case '--date':
        date = argv[++i] ?? '';
        break;
      case '--file':
        file = argv[++i] ?? '';
        break;
      case '--fragments':
        dir = argv[++i] ?? '';
        break;
      case '-h':
      case '--help':
        usage(process.stdout);
        return 0;
      default:
        process.stderr.write(`changelog-fragments: unknown argument "${argv[i]}"\n`);
        usage(process.stderr);
        return 2;
    }
  }

  if (mode === 'check') {
    if (!dir) {
      process.stderr.write('changelog-fragments: --check needs a directory\n');
      return 2;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      process.stderr.write(`changelog-fragments: ${dir} is not a directory\n`);
      return 2;
    }
    const { errors, files } = readFragments(dir);
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`changelog-fragments: ${error}\n`);
      return 1;
    }
    process.stdout.write(`changelog-fragments: OK — ${files.length} fragment(s) parsed\n`);
    return 0;
  }

  if (mode === 'fold') {
    if (!dir) {
      process.stderr.write('changelog-fragments: --fold needs --fragments <dir>\n');
      return 2;
    }
    if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
      process.stderr.write(`changelog-fragments: --version wants a semver like 0.17.0, got "${version}"\n`);
      return 2;
    }
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      process.stderr.write(`changelog-fragments: --date wants YYYY-MM-DD, got "${date}"\n`);
      return 2;
    }
    if (!existsSync(file)) {
      process.stderr.write(`changelog-fragments: ${file} does not exist\n`);
      return 2;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      process.stderr.write(`changelog-fragments: ${dir} is not a directory\n`);
      return 2;
    }
    const { errors, folded } = foldChangelog({ file, dir, version, date });
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`changelog-fragments: ${error}\n`);
      return 1;
    }
    if (folded === 0) {
      process.stdout.write('changelog-fragments: no fragments to fold\n');
      return 0;
    }
    process.stdout.write(`changelog-fragments: folded ${folded} fragment(s) into "${file}"\n`);
    return 0;
  }

  usage(process.stderr);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
