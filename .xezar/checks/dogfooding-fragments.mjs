#!/usr/bin/env node
// Dogfooding fragments (issue #668).
//
// `.xezar/docs/dogfooding.md` is a real-task ledger that every writing task appends to at the top,
// so two open pull requests conflict on it for the same reason they conflict on `CHANGELOG.md` —
// and a content conflict stops GitHub from running CI. A task now writes
// `.xezar/docs/dogfooding.d/<runId8>.md` instead, and the `changelog` step of the `release`
// workflow folds the fragments, newest first, above the entries already in the ledger.
//
//   node .xezar/checks/dogfooding-fragments.mjs --check <dir>
//   node .xezar/checks/dogfooding-fragments.mjs --fold [--file <dogfooding.md>] [--fragments <dir>]
//
// A fragment is one complete dated entry — a `### <YYYY-MM-DD> — …` heading and its bullets,
// the same record template the ledger uses. The fold only INSERTS: every existing dated entry is
// a record and is never rewritten, moved or reformatted. `README.md` is skipped.

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IGNORED = new Set(['README.md']);
const MARKER = '## Real-task entries';
const ENTRY = /^### ([0-9]{4}-[0-9]{2}-[0-9]{2})\b/;

/** Every fragment file in `dir`, sorted by name so ties are deterministic. */
export function fragmentFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !IGNORED.has(name))
    .sort()
    .map((name) => join(dir, name));
}

/** Parse one entry: a `### <date> — …` heading, at least one bullet, nothing else at top level. */
export function parseFragment(text, file) {
  const errors = [];
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return { errors: [`${file}: is empty`], date: '', body: [] };
  if (!ENTRY.test(lines[first])) {
    errors.push(`${file}:${first + 1}: a dogfooding fragment starts with "### <YYYY-MM-DD> — …", got "${lines[first]}"`);
  }
  let bullets = 0;
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') continue;
    if (/^#{1,3} /.test(line)) {
      errors.push(`${file}:${i + 1}: an entry carries one "### " heading, got "${line}"`);
      continue;
    }
    if (line.startsWith('- ')) bullets += 1;
  }
  if (bullets === 0) errors.push(`${file}: has no "- " line; an entry records what was observed`);
  const date = ENTRY.exec(lines[first])?.[1] ?? '';
  return { errors, date, body: lines.slice(first) };
}

/** Fold every fragment above the newest existing entry, then delete the folded files. */
export function foldDogfooding({ file, dir }) {
  const files = fragmentFiles(dir);
  const parsed = files.map((path) => ({ path, ...parseFragment(readFileSync(path, 'utf8'), path) }));
  const errors = parsed.flatMap((entry) => entry.errors);
  if (errors.length > 0) return { errors, folded: 0 };
  if (parsed.length === 0) return { errors: [], folded: 0 };

  const lines = readFileSync(file, 'utf8').split('\n');
  const marker = lines.findIndex((line) => line.trim() === MARKER);
  if (marker === -1) return { errors: [`${file}: has no "${MARKER}" heading to fold into`], folded: 0 };

  let insertAt = marker + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt += 1;

  const ordered = parsed
    .slice()
    .sort((a, b) => (a.date === b.date ? a.path.localeCompare(b.path) : b.date.localeCompare(a.date)));

  const block = [];
  for (const entry of ordered) {
    const body = entry.body.slice();
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    block.push(...body, '');
  }

  const out = lines.slice();
  out.splice(insertAt, 0, ...block);
  writeFileSync(file, out.join('\n'));
  for (const entry of parsed) rmSync(entry.path);
  return { errors: [], folded: parsed.length };
}

// --- CLI ---------------------------------------------------------------------------------------
function usage(stream) {
  stream.write('usage: dogfooding-fragments.mjs --check <dir>\n');
  stream.write('       dogfooding-fragments.mjs --fold [--file <path>] [--fragments <dir>]\n');
}

function main(argv) {
  let mode = '';
  let dir = '';
  let file = '.xezar/docs/dogfooding.md';
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--check':
        mode = 'check';
        dir = argv[++i] ?? '';
        break;
      case '--fold':
        mode = 'fold';
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
        process.stderr.write(`dogfooding-fragments: unknown argument "${argv[i]}"\n`);
        usage(process.stderr);
        return 2;
    }
  }

  if (mode === 'check') {
    if (!dir) {
      process.stderr.write('dogfooding-fragments: --check needs a directory\n');
      return 2;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      process.stderr.write(`dogfooding-fragments: ${dir} is not a directory\n`);
      return 2;
    }
    const errors = fragmentFiles(dir).flatMap((path) => parseFragment(readFileSync(path, 'utf8'), path).errors);
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`dogfooding-fragments: ${error}\n`);
      return 1;
    }
    process.stdout.write(`dogfooding-fragments: OK — ${fragmentFiles(dir).length} fragment(s) parsed\n`);
    return 0;
  }

  if (mode === 'fold') {
    if (!dir) {
      process.stderr.write('dogfooding-fragments: --fold needs --fragments <dir>\n');
      return 2;
    }
    if (!existsSync(file)) {
      process.stderr.write(`dogfooding-fragments: ${file} does not exist\n`);
      return 2;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      process.stderr.write(`dogfooding-fragments: ${dir} is not a directory\n`);
      return 2;
    }
    const { errors, folded } = foldDogfooding({ file, dir });
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`dogfooding-fragments: ${error}\n`);
      return 1;
    }
    if (folded === 0) {
      process.stdout.write('dogfooding-fragments: no fragments to fold\n');
      return 0;
    }
    process.stdout.write(`dogfooding-fragments: folded ${folded} fragment(s) into "${file}"\n`);
    return 0;
  }

  usage(process.stderr);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
