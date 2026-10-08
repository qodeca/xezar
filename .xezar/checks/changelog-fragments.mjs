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
//   node .xezar/checks/changelog-fragments.mjs --check <dir> [--format <format>] [--file <CHANGELOG.md>]
//   node .xezar/checks/changelog-fragments.mjs --fold --version <semver> --date <YYYY-MM-DD>
//        [--file <CHANGELOG.md>] [--fragments <dir>] [--format <format>]
//   node .xezar/checks/changelog-fragments.mjs --verify --version <semver> --before <git-ref>
//        [--file <CHANGELOG.md>] [--fragments <dir>]
//   node .xezar/checks/changelog-fragments.mjs --format-of [--file <CHANGELOG.md>] [--format <format>]
//
// A fragment carries only bullets (`- …`) under a `## <heading>` drawn from CHANGELOG.md's own
// house set, exactly the shape the file already uses — including the indented continuation lines
// a wrapped bullet has. `README.md` is documentation, not a fragment, and is skipped.
//
// TWO CHANGELOG FORMATS (issue #57). `house` is the file this kit grew up with: a top-level
// `# Unreleased` and dated `# <semver> (<date>)` sections. `keep-a-changelog` is the common
// public convention: `## [Unreleased]`, `## [<semver>] - <date>` and `### Added|Changed|…`
// groups. The format is `--format`, else `changelog.format` in `.xezar/pipeline/config.json`
// beside the changelog, else detected from the file (`auto`, the default). In keep-a-changelog
// mode a fragment may use that format's group names, or the house names, which map onto them.
//
// The refusal of a direct `# Unreleased` / `## [Unreleased]` edit lives in `changelog-check.sh`,
// which owns the changelog's heading rules. In house mode this script never edits `# Unreleased`;
// in keep-a-changelog mode the fold IS the release of `## [Unreleased]` (see `foldKeepAChangelog`).

import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, sep } from 'node:path';
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

/** Keep a Changelog's own groups, in the order that format lists them. */
export const KAC_GROUPS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const KAC_HEADINGS = KAC_GROUPS.map((group) => `### ${group}`);

/**
 * A house heading in a keep-a-changelog project lands in the group that format has for it.
 * `## Highlights` and `## 👥 Contributors` are prose with no such group, so they are refused there
 * rather than guessed into one.
 */
export const HOUSE_TO_KAC = {
  '## 💥 Breaking': 'Changed',
  '## 🔒 Security': 'Security',
  '## ✨ Features': 'Added',
  '## 🐛 Fixes': 'Fixed',
  '## 🔧 Changed': 'Changed',
  '## 📝 Specs & Documentation': 'Changed',
  '## 🚀 CI/CD & Infrastructure': 'Changed',
};

export const FORMATS = ['house', 'keep-a-changelog'];

const SEMVER = '[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?';
const KAC_UNRELEASED = /^## \[?Unreleased\]?\s*$/;
const KAC_RELEASE = new RegExp(`^## \\[?(${SEMVER})\\]?\\s+[-–]\\s+[0-9]{4}-[0-9]{2}-[0-9]{2}`);
const HOUSE_UNRELEASED = /^# Unreleased\s*$/;
const HOUSE_RELEASE = new RegExp(`^# ${SEMVER} \\(`);

const IGNORED = new Set(['README.md']);

/**
 * The fence marker (``` or ~~~) a line opens or closes a fenced code block with, or `null`.
 * `changelog-check.sh` walks the same file with this rule, so the check and the fold cannot
 * disagree about which `# ` lines are section boundaries (issue #684).
 */
const fenceMarker = (line) => /^(`{3,}|~{3,})/.exec(line)?.[1][0] ?? null;

/**
 * `true` for each line that sits inside a fenced code block, plus the marker still open at the end
 * of the file (`null` when the last fence closed). A fence toggles on a line starting with its own
 * marker — a `~~~` line inside a ``` block is content, not a closer — and a fence that opens and
 * never closes runs to the end of the file, exactly as in `changelog-check.sh`.
 *
 * The open-at-EOF marker is returned rather than inferred from the last `inside` entry, because the
 * last line may BE the opening marker (`… ``` ` with no trailing newline), where no line sits
 * inside the fence yet the fence is still open.
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
  return { inside, open };
}

/** A top-level `# ` heading, unless the line is content inside a fenced code block. */
const isTopHeading = (line, inFence) => !inFence && /^# /.test(line);

/**
 * What a section is made of, per format: which lines end a section, which lines open a group, and
 * the order groups are emitted in. House sections are `# ` headings with `## ` groups; a
 * keep-a-changelog section is a `## ` heading (a `# ` title also ends one) with `### ` groups.
 */
const SHAPES = {
  house: { isTop: isTopHeading, group: '## ', order: HOUSE_HEADINGS },
  'keep-a-changelog': { isTop: (line, inFence) => !inFence && /^##? /.test(line), group: '### ', order: KAC_HEADINGS },
};

/**
 * The format a changelog is written in, read from its headings outside fenced code blocks: the
 * first house heading (`# Unreleased`, `# <semver> (`) or keep-a-changelog heading
 * (`## [Unreleased]`, `## [<semver>] - <date>`) decides. A file with neither is `house`, which is
 * what every file was before keep-a-changelog was understood — so no existing project changes.
 */
export function detectFormat(text) {
  const lines = text.split('\n');
  const { inside } = fenceLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inside[i]) continue;
    if (HOUSE_UNRELEASED.test(lines[i]) || HOUSE_RELEASE.test(lines[i])) return 'house';
    if (KAC_UNRELEASED.test(lines[i]) || KAC_RELEASE.test(lines[i])) return 'keep-a-changelog';
  }
  return 'house';
}

/**
 * The format to use: `format` (the `--format` flag) when it names one, else `changelog.format` in
 * the `.xezar/pipeline/config.json` beside the changelog (`configFile` overrides the path), else
 * detected from the file. `auto` at either level means "detect". Returns `{ format, source }` or
 * `{ error }` — an unknown value, or a config nobody can parse, is refused rather than read as
 * "detect", because a typo must not silently pick the other format.
 */
export function resolveFormat({ file, format = '', configFile }) {
  if (format && format !== 'auto') {
    if (!FORMATS.includes(format)) return { error: `--format wants auto, ${FORMATS.join(' or ')}, got "${format}"` };
    return { format, source: '--format' };
  }
  const config = configFile ?? join(dirname(file), '.xezar', 'pipeline', 'config.json');
  if (existsSync(config)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(config, 'utf8'));
    } catch {
      return { error: `${config} is not valid JSON, so changelog.format cannot be read` };
    }
    const value = parsed?.changelog?.format;
    if (value !== undefined && value !== 'auto') {
      if (!FORMATS.includes(value)) {
        return { error: `changelog.format in ${config} must be auto, ${FORMATS.join(' or ')}, got ${JSON.stringify(value)}` };
      }
      return { format: value, source: 'config' };
    }
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return { format: detectFormat(text), source: 'detected' };
}

/**
 * The group a fragment heading lands in, or `null` when the format has none for it. House mode
 * is exactly the house set, as before. Keep-a-changelog mode takes that format's own names at
 * `## ` or `### `, and the house names through `HOUSE_TO_KAC`, and keys every group as `### <name>`.
 */
function groupKey(line, format) {
  if (format !== 'keep-a-changelog') return HOUSE_HEADINGS.includes(line) ? line : null;
  const bare = /^#{2,3} (.+)$/.exec(line)?.[1];
  if (bare !== undefined && KAC_GROUPS.includes(bare)) return `### ${bare}`;
  return HOUSE_TO_KAC[line] ? `### ${HOUSE_TO_KAC[line]}` : null;
}

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
export function parseFragment(text, file, format = 'house') {
  const errors = [];
  const groups = new Map();
  let current = null;
  let bullets = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const at = `${file}:${i + 1}`;
    if (line.startsWith('## ') || (format === 'keep-a-changelog' && line.startsWith('### '))) {
      const key = groupKey(line, format);
      if (key === null) {
        errors.push(format === 'keep-a-changelog'
          ? `${at}: "${line}" is not a Keep a Changelog group (${KAC_GROUPS.join(', ')}) nor a house heading that maps onto one (${Object.keys(HOUSE_TO_KAC).join(', ')})`
          : `${at}: "${line}" is not one of the changelog's group headings (${HOUSE_HEADINGS.join(', ')})`);
        current = null;
        continue;
      }
      current = key;
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
export function readFragments(dir, format = 'house') {
  const errors = [];
  const merged = new Map();
  const files = fragmentFiles(dir);
  for (const file of files) {
    const parsed = parseFragment(readFileSync(file, 'utf8'), file, format);
    errors.push(...parsed.errors);
    for (const [heading, lines] of parsed.groups) {
      if (!merged.has(heading)) merged.set(heading, []);
      merged.get(heading).push(...lines);
    }
  }
  return { errors, groups: merged, files };
}

/**
 * Sort key for a group heading inside a release section. A heading the house list does not know
 * keeps its position relative to the other unknown headings and sorts AFTER every known one:
 * `indexOf` answers -1 for it, and -1 as a raw sort key put the unknown group above
 * `## Highlights`, so a fold reordered prose the release role had just authored (#685).
 */
const houseRank = (heading, order = HOUSE_HEADINGS) => {
  const at = order.indexOf(heading);
  return at === -1 ? order.length : at;
};

/** Index of the next section heading after `headingIndex`, or the line count. */
function sectionEnd(lines, headingIndex, inside, shape = SHAPES.house) {
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (shape.isTop(lines[i], inside[i])) return i;
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
 * order. A heading outside the house set is left where the section put it, after every known
 * heading and in the order the section has it — the fold never moves one above `## Highlights`
 * (#685). Bullets are appended to the end of their group, verbatim, and the section is re-emitted
 * with one blank line between groups so a wrapped bullet never touches the next heading.
 */
function mergeIntoSection(lines, headingIndex, groups, inside, shape = SHAPES.house) {
  const end = sectionEnd(lines, headingIndex, inside, shape);
  const sep = separatorIndex(lines, headingIndex, end);
  const body = lines.slice(headingIndex + 1, sep);
  const trailing = lines.slice(sep, end);

  const preamble = [];
  const parsed = [];
  let current = null;
  // `body` is a slice of `lines`, so `body[i]` is `lines[headingIndex + 1 + i]` — the index the
  // fence map `inside` is keyed by. A `## ` line inside a fenced code block is sample content,
  // not a group boundary: without this lookup the section is re-emitted around it and the fence
  // is torn apart (#704, the group-scan sibling of #684/#696's `# ` fix).
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (!inside[headingIndex + 1 + i] && line.startsWith(shape.group)) {
      current = { heading: line, lines: [] };
      parsed.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  for (const heading of shape.order) {
    if (!groups.has(heading)) continue;
    let group = parsed.find((entry) => entry.heading === heading);
    if (!group) {
      group = { heading, lines: [] };
      parsed.push(group);
    }
    while (group.lines.length > 0 && group.lines[group.lines.length - 1].trim() === '') group.lines.pop();
    group.lines.push(...groups.get(heading));
  }
  // `Array.prototype.sort` is stable (ES2019), so two groups with the same rank keep the order
  // the section already had them in — which is the whole point for an unknown heading.
  parsed.sort((a, b) => houseRank(a.heading, shape.order) - houseRank(b.heading, shape.order));

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

/**
 * The keep-a-changelog fold. That format releases by renaming `## [Unreleased]` to
 * `## [<version>] - <date>` and opening a fresh, empty `## [Unreleased]` above it — so the fragments
 * are merged into the Unreleased content, under `### Added|Changed|…`, and that content becomes the
 * release. A version section that already exists takes the fragments instead, and Unreleased is left
 * alone. With no Unreleased heading the new section goes above the newest release heading.
 * Returns `{ out }` or `{ errors }`.
 */
function foldKeepAChangelog(lines, inside, open, groups, version, date) {
  const shape = SHAPES['keep-a-changelog'];
  const existing = lines.findIndex((line, i) => !inside[i] && KAC_RELEASE.exec(line)?.[1] === version);
  if (existing !== -1) return { out: mergeIntoSection(lines, existing, groups, inside, shape) };
  // Match the file's own release headings: bracketed unless every one it has is bare.
  const releases = lines.filter((line, i) => !inside[i] && KAC_RELEASE.test(line));
  const bare = releases.length > 0 && releases.every((line) => !line.startsWith('## ['));
  const heading = bare ? `## ${version} - ${date}` : `## [${version}] - ${date}`;
  const unreleased = lines.findIndex((line, i) => !inside[i] && KAC_UNRELEASED.test(line));
  if (unreleased !== -1) {
    const renamed = lines.slice();
    renamed[unreleased] = heading;
    const out = mergeIntoSection(renamed, unreleased, groups, inside, shape);
    out.splice(unreleased, 0, lines[unreleased], '');
    return { out };
  }
  let insertAt = lines.findIndex((line, i) => !inside[i] && KAC_RELEASE.test(line));
  if (insertAt === -1) {
    if (open !== null) {
      return { errors: ['CHANGELOG.md ends inside an unclosed code fence; the fold has no release heading to anchor to'] };
    }
    insertAt = lines.length;
  }
  const section = [heading, ''];
  for (const group of shape.order) {
    if (groups.has(group)) section.push(group, '', ...groups.get(group), '');
  }
  if (insertAt > 0 && lines[insertAt - 1].trim() !== '') section.unshift('');
  const out = lines.slice();
  out.splice(insertAt, 0, ...section);
  return { out };
}

/** The lines of the release section for `version`, heading excluded, or `null` when there is none. */
function releaseSection(lines, version, format) {
  const { inside } = fenceLines(lines);
  const shape = SHAPES[format];
  const start = format === 'keep-a-changelog'
    ? lines.findIndex((line, i) => !inside[i] && KAC_RELEASE.exec(line)?.[1] === version)
    : lines.findIndex((line, i) => !inside[i] && line.startsWith(`# ${version} (`));
  if (start === -1) return null;
  return lines.slice(start + 1, sectionEnd(lines, start, inside, shape));
}

/**
 * Content lines of a changelog: every non-blank line except headings and `---` separators outside
 * fenced code blocks, right-trimmed. A fold (and the release role's hand fold of a legacy Unreleased
 * section after it) may move, rename or drop a heading; it may never drop one of these.
 */
function contentLines(lines) {
  const { inside } = fenceLines(lines);
  return lines
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line, i) => line !== '' && (inside[i] || (!line.startsWith('#') && line !== '---')));
}

const tally = (list) => list.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());

/**
 * The verify step of a fold (issue #57): proves, from the changelog before and after, that
 *   - every line of every fragment is in the `<version>` section after the fold;
 *   - no content line of the changelog before the fold is missing after it;
 *   - no fragment is left behind (`remaining`, the fragment files still on disk).
 * Returns a list of errors, empty when the fold is complete. Format-aware only in how it finds the
 * release section; the content rule is the same for both.
 */
export function verifyFold({ before, after, fragments, version, format, remaining = [] }) {
  const errors = [];
  const afterLines = after.split('\n');
  const section = releaseSection(afterLines, version, format);
  if (section === null) {
    errors.push(`the changelog has no ${version} release section after the fold`);
  } else {
    const have = tally(section.map((line) => line.replace(/\s+$/, '')));
    const want = new Map();
    for (const { file, text } of fragments) {
      for (const lines of parseFragment(text, file, format).groups.values()) {
        for (const line of lines) want.set(line, [...(want.get(line) ?? []), file]);
      }
    }
    for (const [line, files] of want) {
      if ((have.get(line) ?? 0) < files.length) errors.push(`a line of ${files[0]} is missing from the ${version} section: "${line}"`);
    }
  }
  const kept = tally(contentLines(afterLines));
  for (const [line, count] of tally(contentLines(before.split('\n')))) {
    if ((kept.get(line) ?? 0) < count) errors.push(`a line of the changelog before the fold is missing after it: "${line}"`);
  }
  for (const file of remaining) errors.push(`${file} is still there; a fragment left behind is a bullet nobody folded`);
  return errors;
}

/** Fold every fragment into `file`, then delete the folded files. */
export function foldChangelog({ file, dir, version, date, format = 'house' }) {
  const { errors, groups, files } = readFragments(dir, format);
  if (errors.length > 0) return { errors, folded: 0 };
  if (files.length === 0) return { errors: [], folded: 0 };

  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const { inside, open } = fenceLines(lines);
  const fragments = files.map((fragment) => ({ file: fragment, text: readFileSync(fragment, 'utf8') }));
  if (format === 'keep-a-changelog') {
    const result = foldKeepAChangelog(lines, inside, open, groups, version, date);
    if (result.errors) return { errors: result.errors, folded: 0 };
    return writeFold({ file, files, fragments, original, out: result.out, version, format });
  }
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
    // No top-level heading to anchor to, so there is nothing to insert above. When the file also
    // ENDS inside an open fence, appending would put the whole new section — heading, groups and
    // `---` separator — inside that fence, which is the defect this fix exists to close (PR #696
    // review, Major M1). Refuse through the module's own error channel instead: a fold that cannot
    // place the section safely must not rewrite the file at all, so this returns before any write.
    // The closed-fence path is unchanged — a file whose last fence closes, with no other top-level
    // heading, still gets the section appended after its final line.
    if (insertAt === -1) {
      if (open !== null) {
        return {
          errors: ['CHANGELOG.md ends inside an unclosed code fence; the fold has no top-level heading to anchor to'],
          folded: 0,
        };
      }
      insertAt = lines.length;
    }
    const section = newSection(heading, groups);
    if (insertAt > 0 && lines[insertAt - 1].trim() !== '') section.unshift('');
    out = lines.slice();
    out.splice(insertAt, 0, ...section);
  }
  return writeFold({ file, files, fragments, original, out, version, format });
}

/** Verify the fold in memory, and only then write the changelog and delete the fragments. */
function writeFold({ file, files, fragments, original, out, version, format }) {
  const after = out.join('\n');
  const errors = verifyFold({ before: original, after, fragments, version, format });
  if (errors.length > 0) return { errors, folded: 0 };
  writeFileSync(file, after);
  for (const fragment of files) rmSync(fragment);
  return { errors: [], folded: files.length };
}

/**
 * `--verify`: the changelog and the fragments as they were at `ref` (the commit before the fold),
 * against the changelog and the fragment folder now. Returns `{ errors }`.
 */
export function verifyAgainst({ file, dir, version, ref, format = '' }) {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const fileDir = dirname(file);
  let top;
  try {
    top = realpathSync(git(fileDir, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return { errors: [`--verify needs ${file} to sit inside a git repository`] };
  }
  // A repository-relative path with "/" on every OS: `git show <ref>:<path>` reads nothing else (#122).
  const rel = (path) => {
    const abs = existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
    return abs === top ? '' : abs.slice(top.length + 1).split(sep).join('/');
  };
  let before;
  try {
    before = git(top, ['show', `${ref}:${rel(file)}`]);
  } catch {
    return { errors: [`${file} does not exist at ${ref}`] };
  }
  const resolved = resolveFormat({ file, format });
  if (resolved.error) return { errors: [resolved.error] };
  const fragmentDir = rel(dir);
  let names = [];
  try {
    names = git(top, ['ls-tree', '--name-only', `${ref}`, '--', `${fragmentDir}/`]).split('\n').filter(Boolean);
  } catch {
    names = [];
  }
  const fragments = names
    .filter((name) => name.endsWith('.md') && !IGNORED.has(name.split('/').pop()))
    .map((name) => ({ file: name, text: git(top, ['show', `${ref}:${name}`]) }));
  const after = readFileSync(file, 'utf8');
  return {
    errors: verifyFold({ before, after, fragments, version, format: resolved.format, remaining: fragmentFiles(dir) }),
    format: resolved.format,
    count: fragments.length,
  };
}

// --- CLI ---------------------------------------------------------------------------------------
function usage(stream) {
  stream.write('usage: changelog-fragments.mjs --check <dir> [--format <auto|house|keep-a-changelog>] [--file <path>]\n');
  stream.write('       changelog-fragments.mjs --fold --version <semver> --date <YYYY-MM-DD> [--file <path>] [--fragments <dir>] [--format <format>]\n');
  stream.write('       changelog-fragments.mjs --verify --version <semver> --before <git-ref> [--file <path>] [--fragments <dir>] [--format <format>]\n');
  stream.write('       changelog-fragments.mjs --format-of [--file <path>] [--format <format>]\n');
}

function main(argv) {
  let mode = '';
  let dir = '';
  let file = 'CHANGELOG.md';
  let version = '';
  let date = '';
  let format = '';
  let ref = '';
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--check':
        mode = 'check';
        dir = argv[++i] ?? '';
        break;
      case '--fold':
        mode = 'fold';
        break;
      case '--verify':
        mode = 'verify';
        break;
      case '--format-of':
        mode = 'format-of';
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
      case '--format':
        format = argv[++i] ?? '';
        break;
      case '--before':
        ref = argv[++i] ?? '';
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

  // Every mode reads the format the same way, so the check, the fold and the verify step cannot
  // disagree about which one a changelog is in.
  const resolved = resolveFormat({ file, format });
  if (resolved.error) {
    process.stderr.write(`changelog-fragments: ${resolved.error}\n`);
    return 2;
  }

  if (mode === 'format-of') {
    process.stdout.write(`format=${resolved.format}\nsource=${resolved.source}\n`);
    return 0;
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
    const { errors, files } = readFragments(dir, resolved.format);
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`changelog-fragments: ${error}\n`);
      return 1;
    }
    process.stdout.write(`changelog-fragments: OK — ${files.length} fragment(s) parsed\n`);
    return 0;
  }

  if (mode === 'fold' || mode === 'verify') {
    if (!dir) {
      process.stderr.write(`changelog-fragments: --${mode} needs --fragments <dir>\n`);
      return 2;
    }
    if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
      process.stderr.write(`changelog-fragments: --version wants a semver like 0.17.0, got "${version}"\n`);
      return 2;
    }
    if (!existsSync(file)) {
      process.stderr.write(`changelog-fragments: ${file} does not exist\n`);
      return 2;
    }
  }

  if (mode === 'verify') {
    if (!ref) {
      process.stderr.write('changelog-fragments: --verify needs --before <git-ref>, the commit before the fold\n');
      return 2;
    }
    const { errors, count } = verifyAgainst({ file, dir, version, ref, format });
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`changelog-fragments: ${error}\n`);
      return 1;
    }
    process.stdout.write(`changelog-fragments: verified — ${count} fragment(s) from ${ref} are in the ${version} section, no changelog line was lost, none is left behind\n`);
    return 0;
  }

  if (mode === 'fold') {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      process.stderr.write(`changelog-fragments: --date wants YYYY-MM-DD, got "${date}"\n`);
      return 2;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      process.stderr.write(`changelog-fragments: ${dir} is not a directory\n`);
      return 2;
    }
    const { errors, folded } = foldChangelog({ file, dir, version, date, format: resolved.format });
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`changelog-fragments: ${error}\n`);
      return 1;
    }
    if (folded === 0) {
      process.stdout.write('changelog-fragments: no fragments to fold\n');
      return 0;
    }
    process.stdout.write(`changelog-fragments: folded ${folded} fragment(s) into "${file}" (${resolved.format})\n`);
    return 0;
  }

  usage(process.stderr);
  return 2;
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
