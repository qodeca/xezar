import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../mcp/audit-source-scan.testkit.ts';
import { stripComments } from '../release/instruction-hygiene.testkit.ts';

/**
 * Every platform skip in the test code says why, and which open issue owns it.
 *
 * Windows runs the full suite. A test that still cannot run on one operating system carries a
 * marker – the word `win32-skip`, then `(#<issue>): <reason>` – on the line of the skip or in the
 * comment block directly above it, so the remaining gaps stay searchable and each one points at an
 * issue that is still open. The scan fails on:
 *  - unmarked: a platform-conditioned skip with no marker. A platform-conditioned skip is a vitest
 *    `it`/`test`/`describe` (`.concurrent`) `.skipIf(…)`/`.runIf(…)`, a node:test `{ skip: … }`
 *    option, or, in a test file, an `if (…)` that guards a bare `return` or a `ctx.skip()` – each
 *    only when its condition names the platform (`onWindows`, `win32`, `process.platform`,
 *    `isWindows`, `os.platform()`, `platform ===`), directly or through a `const` in the same file
 *    whose initializer tests it. For such a `const`, a marker at its definition counts too.
 *  - closed: a marker that names #963, the umbrella issue this scheme replaced.
 *  - retired: the old `win32-r9(` marker for a known Windows failure – none may remain.
 *  - unknown: a marker naming an issue outside ALLOWED_ISSUES, or a malformed one.
 *
 * Markers are read from the raw source; skips from comment-free source, so prose about a skip is
 * never a finding. No process is started.
 */
export const ALLOWED_ISSUES: readonly number[] = [972, 973, 974, 975, 976, 977, 978];

const ROOTS = ['packages/xezar/src', 'packages/xezar/test', 'packages/contract/src', 'packages/api-client/src', 'packages/web/src', 'packages/web/e2e', 'scripts'];
/** Whole trees of test code: every script file under them is a test or a test helper. */
const TEST_TREES = /^(?:packages\/[^/]+\/test|packages\/web\/e2e)\//;
const TEST_NAME = /\.(?:test|e2e|testkit)\.(?:ts|tsx|mjs|js|cjs)$/;
const SCRIPT_EXT = /\.(?:ts|tsx|mjs|js|cjs)$/;
const SELF = 'packages/xezar/src/platform/skip-marker-scan.test.ts';

export type SkipRule = 'unmarked' | 'closed' | 'retired' | 'unknown';

export interface SkipFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: SkipRule;
  readonly code: string;
}

const FIX: Readonly<Record<SkipRule, string>> = {
  unmarked: 'add a win32-skip marker naming the open issue and what the platform lacks',
  closed: '#963 is closed – name the open issue that owns this gap',
  retired: 'the win32-r9 marker is retired – fix the failure or skip it with a win32-skip marker',
  unknown: `name one of ${ALLOWED_ISSUES.map((n) => `#${n}`).join(', ')}`,
};

const PLATFORM = /\bonWindows\b|win32|process\.platform|\bisWindows\b|\bos\.platform\(\)|platform\s*===/;
const MARKER = /win32-skip\(([^)\n]*)\)/g;
const RETIRED = /win32-r9\(/g;
const VITEST_CONDITIONAL = /\b(?:it|test|describe)(?:\.concurrent)?\.(?:skipIf|runIf)\s*\(/g;
const NODE_SKIP_OPTION = /\bskip\s*:/g;
const IF_OPEN = /\bif\s*\(/g;
const CONST_DECL = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?![=>])/g;

const lineStarts = new Map<string, number[]>();

/** 1-based line of `index`, by binary search over the text's cached line starts. */
function lineOf(text: string, index: number): number {
  let starts = lineStarts.get(text);
  if (!starts) {
    if (lineStarts.size > 8) lineStarts.clear();
    starts = [0];
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    lineStarts.set(text, starts);
  }
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** The text between the `(` that ends at `open - 1` and its matching `)`. */
function balancedArgument(text: string, open: number): { body: string; end: number } {
  let depth = 1;
  let i = open;
  for (; i < text.length && depth > 0; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return { body: text.slice(open, i - 1), end: i };
}

/** A `{ skip: … }` value: up to the first top-level `,`, `}` or `)`. */
function optionValue(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return text.slice(start, i);
      depth -= 1;
    } else if (ch === ',' && depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

/** The initializer's condition: what precedes its first ternary `?`, or the whole first statement. */
function initializerCondition(text: string, start: number): { condition: string; lastLine: number } {
  const semicolon = text.indexOf(';', start);
  let end = semicolon === -1 ? text.length : semicolon;
  // Without semicolons, a statement continues only on lines that start with an operator.
  let newline = text.indexOf('\n', start);
  while (newline !== -1 && newline < end) {
    const nextLine = text.slice(newline + 1, text.indexOf('\n', newline + 1) === -1 ? undefined : text.indexOf('\n', newline + 1));
    if (!/^\s*(?:\?|:|&&|\|\||\.)/.test(nextLine)) {
      end = newline;
      break;
    }
    newline = text.indexOf('\n', newline + 1);
  }
  const initializer = text.slice(start, end);
  const ternary = /\?(?![.?])/.exec(initializer);
  return { condition: ternary ? initializer.slice(0, ternary.index) : initializer, lastLine: lineOf(text, end) };
}

interface PlatformConst {
  readonly firstLine: number;
  readonly lastLine: number;
}

function platformConsts(code: string): Map<string, PlatformConst> {
  const found = new Map<string, PlatformConst>();
  for (const match of code.matchAll(CONST_DECL)) {
    const { condition, lastLine } = initializerCondition(code, match.index + match[0].length);
    if (PLATFORM.test(condition)) found.set(match[1]!, { firstLine: lineOf(code, match.index), lastLine });
  }
  return found;
}

/** The platform consts a condition names, or `undefined` when it names no platform at all. */
function platformReach(condition: string, consts: Map<string, PlatformConst>): PlatformConst[] | undefined {
  const named = [...condition.matchAll(/[A-Za-z_$][\w$]*/g)].flatMap((m) => {
    const hit = consts.get(m[0]);
    return hit ? [hit] : [];
  });
  if (PLATFORM.test(condition) || named.length > 0) return named;
  return undefined;
}

/** Is a marker on line `n` (1-based), on the line directly above it, or in the comment block above? */
function markedAt(lines: readonly string[], n: number): boolean {
  const has = (i: number): boolean => i >= 1 && i <= lines.length && /win32-skip\(/.test(lines[i - 1]!);
  if (has(n) || has(n - 1)) return true;
  for (let i = n - 1; i >= 1; i -= 1) {
    const trimmed = lines[i - 1]!.trim();
    if (!/^(?:\/\/|\/\*|\*)/.test(trimmed)) return false;
    if (has(i)) return true;
  }
  return false;
}

function isTestFile(file: string): boolean {
  return /\.(?:test|e2e)\.(?:ts|tsx|mjs|js|cjs)$/.test(file);
}

/** Every finding in one file, by its path relative to the repository root. */
export function skipFindings(file: string, source: string): SkipFinding[] {
  const raw = source.split('\n');
  const code = stripComments(source);
  const consts = platformConsts(code);
  const found: SkipFinding[] = [];
  const add = (rule: SkipRule, line: number): void => {
    found.push({ file, line, rule, code: (raw[line - 1] ?? '').trim().slice(0, 160) });
  };
  const requireMarker = (index: number, condition: string): void => {
    const reach = platformReach(condition, consts);
    if (reach === undefined) return;
    const line = lineOf(code, index);
    if (markedAt(raw, line)) return;
    for (const definition of reach) {
      for (let n = definition.firstLine; n <= definition.lastLine; n += 1) if (markedAt(raw, n)) return;
    }
    add('unmarked', line);
  };

  for (const match of code.matchAll(VITEST_CONDITIONAL)) {
    requireMarker(match.index, balancedArgument(code, match.index + match[0].length).body);
  }
  for (const match of code.matchAll(NODE_SKIP_OPTION)) {
    requireMarker(match.index, optionValue(code, match.index + match[0].length));
  }
  for (const match of code.matchAll(IF_OPEN)) {
    const { body, end } = balancedArgument(code, match.index + match[0].length);
    const after = code.slice(end).replace(/^\s*\{?\s*/, '');
    const bareReturn = /^return\s*(?:;|\}|\n|$)/.test(after);
    const contextSkip = /^[\w$]+\.skip\s*\(/.test(after);
    if (contextSkip || (bareReturn && isTestFile(file))) requireMarker(match.index, body);
  }

  for (const match of source.matchAll(MARKER)) {
    const issue = /^#(\d+)$/.exec(match[1]!.trim());
    if (issue && Number(issue[1]) === 963) add('closed', lineOf(source, match.index));
    else if (!issue || !ALLOWED_ISSUES.includes(Number(issue[1]))) add('unknown', lineOf(source, match.index));
  }
  for (const match of source.matchAll(RETIRED)) add('retired', lineOf(source, match.index));
  return found.sort((a, b) => a.line - b.line);
}

/** Every scanned file, relative to the repository root with `/` separators. */
function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
      } else if (SCRIPT_EXT.test(entry.name) && (TEST_NAME.test(entry.name) || TEST_TREES.test(path) || /^scripts\/test-/.test(path))) {
        if (path !== SELF) out.push(path);
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return out.sort();
}

function markerCount(files: readonly string[]): number {
  return files.reduce((sum, file) => sum + [...readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(MARKER)].length, 0);
}

describe('every platform skip names its open issue', () => {
  const files = scannedFiles();

  it('finds no unmarked skip, #963 marker, retired marker or unknown issue', () => {
    const findings = files.flatMap((file) => skipFindings(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
    expect(findings.map((f) => `${f.file}:${f.line}: ${f.rule}: ${f.code} – ${FIX[f.rule]}`).join('\n')).toBe('');
  });

  it('scans the whole test tree, so a green scan is not an empty one', () => {
    // About 10% under the 799 files seen when the scan was written.
    expect(files.length).toBeGreaterThan(720);
    expect(markerCount(files)).toBeGreaterThan(0);
  });
});

describe('the scanner fires on every kind of finding', () => {
  // Spelled in pieces, so this file itself never reads as a finding.
  const mark = (issue: string): string => `${'win32'}-skip(#${issue})`;
  const rules = (source: string, file = 'packages/xezar/src/probe.test.ts'): SkipRule[] =>
    skipFindings(file, source).map((f) => f.rule);

  it.each([
    ['a vitest skipIf', "it.skipIf(onWindows)('x', () => {});"],
    ['a describe.concurrent runIf', "describe.concurrent.runIf(process.platform !== 'win32')('x', () => {});"],
    ['a node:test skip option', "test('x', { skip: onWindows ? 'no' : false }, () => {});"],
    ['an early return', "it('x', () => {\n  if (onWindows) return;\n  expect(1).toBe(1);\n});"],
    ['an early return in a block', "it('x', () => {\n  if (os.platform() === 'win32') {\n    return;\n  }\n});"],
    ['a context skip', "it('x', (ctx) => {\n  if (isWindows) ctx.skip();\n});"],
    ['a skip through a same-file const', "const NO_PTY = onWindows ? 'no pty' : false;\n\ntest('x', { skip: NO_PTY }, () => {});"],
  ])('unmarked: %s', (_label, source) => {
    expect(rules(source)).toEqual(['unmarked']);
  });

  it('closed, retired and unknown markers fail even on a marked skip', () => {
    expect(rules(`// ${mark('963')}: old\nit.skipIf(onWindows)('x', () => {});`)).toEqual(['closed']);
    expect(rules(`// ${mark('999')}: nobody owns this\nit.skipIf(onWindows)('x', () => {});`)).toEqual(['unknown']);
    expect(rules(`// ${mark('N')}: malformed\nit.skipIf(onWindows)('x', () => {});`)).toEqual(['unknown']);
    expect(rules(`// ${'win32'}-r9(#963): a known failure\nit('x', () => {});`)).toEqual(['retired']);
  });

  it('accepts a marker on the line, the line above, a comment block above, or the const it names', () => {
    expect(rules(`it.skipIf(onWindows)('x', () => {}); // ${mark('973')}: file symlinks need elevation`)).toEqual([]);
    expect(rules(`// ${mark('972')}: no POSIX mode bits\nit.skipIf(onWindows)('x', () => {});`)).toEqual([]);
    expect(rules(`// ${mark('975')}: no pty\n// a second line of reason\nit.skipIf(onWindows)('x', () => {});`)).toEqual([]);
    expect(rules(`test('x', { skip: onWindows ? '${mark('975')}: no pty' : false }, () => {});`)).toEqual([]);
    expect(rules(`it('x', () => {\n  // ${mark('974')}: no catchable SIGTERM\n  if (onWindows) return;\n});`)).toEqual([]);
    expect(rules(`const NO_PTY = onWindows\n  ? '${mark('975')}: no pty'\n  : false;\n\ntest('x', { skip: NO_PTY }, () => {});`)).toEqual([]);
  });

  it('ignores skips that are not about the platform, comments, and returns outside test files', () => {
    expect(rules("it.skipIf(!ghAvailable)('x', () => {});")).toEqual([]);
    expect(rules("test('x', { skip: !pythonAvailable && 'no python' }, () => {});")).toEqual([]);
    expect(rules('// it.skipIf(onWindows)(\'x\', () => {});')).toEqual([]);
    expect(rules("function f() {\n  if (onWindows) return;\n}", 'packages/xezar/test/helpers/probe.ts')).toEqual([]);
    expect(rules("it('x', () => {\n  if (onWindows) return tmpdir();\n});")).toEqual([]);
  });

  it('a marker away from the skip does not count', () => {
    expect(rules(`// ${mark('972')}: no POSIX mode bits\n\nit.skipIf(onWindows)('x', () => {});`)).toEqual(['unmarked']);
  });
});
