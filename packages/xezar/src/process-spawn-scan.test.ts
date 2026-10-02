import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFiles } from './mcp/audit-source-scan.testkit.ts';
import { stripComments } from './release/instruction-hygiene.testkit.ts';

/**
 * Processes start and stop only through the platform layer (#963 AC-10).
 *
 * `platform/process-launch.ts` is the one place a program starts – on Windows it is also where a
 * bare name is searched without the working folder, an npm shim runs without cmd.exe and a batch
 * file meets the strict cmd.exe rule – and `platform/process-tree.ts` is the one place a child is
 * stopped, so a Windows stop reaches what the child started. A direct `node:child_process` import
 * or a raw `.kill(` elsewhere quietly skips all of that on Windows while Linux and macOS keep
 * working, which is why a test has to notice it.
 *
 * Four rules over comment-free source (tests and testkits are not scanned):
 *  - child-process-ref: any `'child_process'` / `'node:child_process'` string literal outside
 *    `platform/` – static and multi-line imports, `require`, `createRequire(…)(…)`, `import()`.
 *    A statement that starts with `import type` or `export type` is fine: it starts nothing.
 *  - raw-kill: every `.kill(` outside `platform/`, except the liveness probe `process.kill(x, 0)`.
 *  - shell-option: a `shell` option that is not literally `false`, everywhere.
 *  - platform-leaf: an import in `platform/` other than `node:*` or a sibling `./x.ts`.
 *
 * An allowance names a file, a rule, the exact number of findings and a reason; the scan fails
 * when that number moves in EITHER direction, so a new call in an allowed file is caught too.
 */
const SCAN_ROOT = 'packages/xezar/src';

export type SpawnRule = 'child-process-ref' | 'raw-kill' | 'shell-option' | 'platform-leaf';

export interface SpawnFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: SpawnRule;
  readonly code: string;
}

interface Allowance {
  readonly file: string;
  readonly rule: SpawnRule;
  readonly count: number;
  readonly reason: string;
}

const FIX: Readonly<Record<SpawnRule, string>> = {
  'child-process-ref': 'start it through platform/process-launch.ts',
  'raw-kill': 'stop it through platform/process-tree.ts (stopChildTree / signalProcessGroup)',
  'shell-option': 'never start a program through a shell; pass a fixed argument vector',
  'platform-leaf': 'platform/ imports only node:* and its own siblings',
};

const ALLOWED: readonly Allowance[] = [
  {
    file: 'server/wsl.ts',
    rule: 'child-process-ref',
    count: 1,
    reason:
      'Runs `wslpath` only inside WSL (`isWsl()` is false on win32), so none of the Windows start ' +
      'rules can apply; a Linux program with a fixed argument vector.',
  },
  {
    file: 'server-install/steps.ts',
    rule: 'child-process-ref',
    count: 1,
    reason:
      'The systemd server install is Linux only and feeds secrets to its programs on stdin with ' +
      'inherited stdio; it never runs on Windows.',
  },
];

const CHILD_PROCESS_LITERAL = /(['"`])(?:node:)?child_process\1/g;
/** `.kill(`, an optional call `.kill?.(`, and `.kill.bind/call/apply` (T-07). */
const KILL_CALL = /\.kill\s*(?:\?\.\s*)?\(|\.kill\s*\.\s*(?:bind|call|apply)\b/g;
/** `child['kill'](` and `child?.["kill"]?.(`. */
const KILL_KEY_CALL = /\[\s*(['"`])kill\1\s*\]\s*(?:\?\.\s*)?\(/g;
const LIVENESS_PROBE = /\bprocess\.kill\([^()]*,\s*0\s*\)/g;
// The lookahead carries its own `\s*`: `shell\s*:\s*(?!false)` would back off one space and match
// `shell: false` after all. The key may be quoted (T-07), and an assignment counts as well.
const SHELL_OPTIONS = [
  /(['"`]?)\bshell\1\s*:(?!\s*false\b)/g,
  /[{,]\s*shell\s*[,}]/g,
  /\.shell\s*=(?![=>])(?!\s*false\b)/g,
  /\[\s*(['"`])shell\1\s*\]\s*=(?![=>])(?!\s*false\b)/g,
];
const MODULE_SPECIFIERS = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];
const LEAF_SPECIFIER = /^(?:node:.+|\.\/[^/\\]+\.ts)$/;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function codeAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/**
 * Is the literal the source of an `import type … from` / `export type … from` statement? Only
 * those name a module without loading it. The statement starts after the previous `;` or at the
 * last line that opens with `import`/`export`, whichever is later – so in a file without
 * semicolons a type import on an earlier line cannot exempt a value import after it (T-07).
 */
function isTypeOnlyStatement(text: string, index: number): boolean {
  const before = text.slice(0, index);
  if (!/\bfrom\s*$/.test(before)) return false;
  const afterSemicolon = before.lastIndexOf(';') + 1;
  const statementLines = [...before.matchAll(/^[ \t]*(?:import|export)\b/gm)];
  const start = Math.max(afterSemicolon, statementLines.at(-1)?.index ?? 0);
  return /^(?:import|export)\s+type\b/.test(text.slice(start, index).trimStart());
}

function matchIndexes(pattern: RegExp, text: string): number[] {
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].map((match) => match.index);
}

/** Every rule hit in one file's source, by its path relative to `src/`. */
export function spawnFindings(file: string, source: string): SpawnFinding[] {
  const text = stripComments(source);
  const inPlatform = file.startsWith('platform/');
  const found: SpawnFinding[] = [];
  const add = (rule: SpawnRule, index: number): void => {
    found.push({ file, line: lineOf(text, index), rule, code: codeAt(text, index) });
  };
  if (!inPlatform) {
    for (const index of matchIndexes(CHILD_PROCESS_LITERAL, text)) {
      if (!isTypeOnlyStatement(text, index)) add('child-process-ref', index);
    }
    const probes = new Set(matchIndexes(LIVENESS_PROBE, text).map((index) => index + 'process'.length));
    for (const index of matchIndexes(KILL_CALL, text)) if (!probes.has(index)) add('raw-kill', index);
    for (const index of matchIndexes(KILL_KEY_CALL, text)) add('raw-kill', index);
  }
  for (const pattern of SHELL_OPTIONS) for (const index of matchIndexes(pattern, text)) add('shell-option', index);
  if (inPlatform) {
    for (const pattern of MODULE_SPECIFIERS) {
      for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
        if (!LEAF_SPECIFIER.test(match[2]!)) add('platform-leaf', match.index);
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function scan(): SpawnFinding[] {
  const root = `${REPO_ROOT}${SCAN_ROOT}`;
  return sourceFiles(SCAN_ROOT).flatMap((path) =>
    spawnFindings(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')),
  );
}

/** Findings against allowances: every mismatch, in either direction, as one line. */
export function allowanceProblems(findings: readonly SpawnFinding[], allowed: readonly Allowance[]): string[] {
  const counts = new Map<string, SpawnFinding[]>();
  for (const finding of findings) {
    const key = `${finding.file}\u0000${finding.rule}`;
    counts.set(key, [...(counts.get(key) ?? []), finding]);
  }
  const problems: string[] = [];
  for (const [key, hits] of counts) {
    const [file, rule] = key.split('\u0000') as [string, SpawnRule];
    const allowance = allowed.find((a) => a.file === file && a.rule === rule);
    if (!allowance) {
      for (const hit of hits) problems.push(`${hit.file}:${hit.line}: ${hit.code} – ${FIX[rule]}`);
    } else if (allowance.count !== hits.length) {
      problems.push(`${file}: ${rule} allows ${allowance.count}, found ${hits.length}`);
    }
  }
  for (const allowance of allowed) {
    if (!counts.has(`${allowance.file}\u0000${allowance.rule}`)) {
      problems.push(`stale allowance: ${allowance.file}: ${allowance.rule} (allows ${allowance.count}, found 0)`);
    }
  }
  return problems;
}

describe('processes start and stop only through the platform layer (#963)', () => {
  it('finds nothing outside the allowances, and every allowance count is exact', () => {
    expect(allowanceProblems(scan(), ALLOWED).join('\n')).toBe('');
  });

  it('gives every allowance a reason', () => {
    for (const allowance of ALLOWED) expect(allowance.reason.length, allowance.file).toBeGreaterThan(40);
  });
});

describe('the rules fire on every spelling, so a green scan is not a dropped rule', () => {
  const rulesIn = (file: string, source: string): SpawnRule[] => spawnFindings(file, source).map((f) => f.rule);
  // Spelled in pieces, so this file itself never looks like a finding to a reader grepping.
  const cp = ['child', 'process'].join('_');
  const kill = ['.ki', 'll'].join('');

  it.each([
    ['a static import', `import { spawn } from 'node:${cp}';`],
    ['a bare-name import', `import { spawn } from '${cp}';`],
    ['a multi-line import', `import {\n  spawn,\n} from 'node:${cp}';`],
    ['a require', `const cp = require('${cp}');`],
    ['a createRequire', `const cp = createRequire(import.meta.url)('${cp}');`],
    ['a dynamic import', `const cp = await import('node:${cp}');`],
    ['an inline type modifier, which still names the module for a value import', `import { type ChildProcess, spawn } from "node:${cp}";`],
  ])('child-process-ref: %s', (_label, source) => {
    expect(rulesIn('core/probe.ts', source)).toEqual(['child-process-ref']);
  });

  it('child-process-ref: allows type-only statements, also multi-line, and anything inside platform/', () => {
    expect(rulesIn('core/probe.ts', `import type { ChildProcess } from 'node:${cp}';`)).toEqual([]);
    expect(rulesIn('core/probe.ts', `import x from './x.ts';\nimport type {\n  ChildProcess,\n} from 'node:${cp}';`)).toEqual([]);
    expect(rulesIn('core/probe.ts', `export type { ChildProcess } from 'node:${cp}';`)).toEqual([]);
    expect(rulesIn('platform/probe.ts', `import { spawn } from 'node:${cp}';`)).toEqual([]);
    expect(rulesIn('core/probe.ts', `// import { spawn } from 'node:${cp}';`)).toEqual([]);
    expect(rulesIn('core/probe.ts', `import x from './x.ts'\nimport type { ChildProcess } from 'node:${cp}'`)).toEqual([]);
  });

  // T-07: without semicolons, a type import on an earlier line must not exempt what follows it.
  it.each([
    ['a value import', `import type { X } from './x.ts'\nimport { spawn } from 'node:${cp}'`],
    ['a require', `import type { X } from './x.ts'\nconst cp = require('${cp}')`],
    ['a dynamic import', `export type { X } from './x.ts'\nconst cp = await import('node:${cp}')`],
  ])('child-process-ref: %s after a type import, without semicolons', (_label, source) => {
    expect(rulesIn('core/probe.ts', source)).toEqual(['child-process-ref']);
  });

  it.each([
    ['a plain call', `child${kill}('SIGTERM');`],
    ['an optional call', `child?${kill}();`],
    ['a non-null call with a space', `this.child!${kill} ('SIGTERM');`],
    ['a group signal', `process${kill}(-pid, 'SIGTERM');`],
    ['a signal by pid', `process${kill}(pid, 'SIGKILL');`],
    ['an optional call (T-07)', `child${kill}?.('SIGTERM');`],
    ['an optional receiver and call', `child?${kill}?.();`],
    ['a bracketed key (T-07)', `child['${kill.slice(1)}']('SIGTERM');`],
    ['an optional bracketed key', `child?.["${kill.slice(1)}"]?.();`],
    ['a bound kill (T-07)', `const stop = child${kill}.bind(child);`],
    ['a kill called through call()', `child${kill}.call(child, 'SIGTERM');`],
  ])('raw-kill: %s', (_label, source) => {
    expect(rulesIn('core/probe.ts', source)).toEqual(['raw-kill']);
  });

  it('raw-kill: allows the liveness probe, comments and platform/', () => {
    expect(rulesIn('core/probe.ts', `if (process${kill}(pid, 0)) return;`)).toEqual([]);
    expect(rulesIn('core/probe.ts', `try { process${kill}(entry.pid,  0); } catch {}`)).toEqual([]);
    expect(rulesIn('core/probe.ts', `/* child${kill}() */ // child${kill}()`)).toEqual([]);
    expect(rulesIn('platform/probe.ts', `child${kill}(signal);`)).toEqual([]);
  });

  it.each([
    ['true', '{ shell: true }'],
    ['a variable', '{ shell: opts.shell }'],
    ['a program', "{ shell: 'cmd' }"],
    ['the shorthand', '{ cwd, shell }'],
    ['the shorthand first', '{ shell, cwd }'],
    ['a single-quoted key (T-07)', "{ 'shell': true }"],
    ['a double-quoted key', '{ "shell": opts.shell }'],
  ])('shell-option: %s, also inside platform/', (_label, source) => {
    expect(rulesIn('core/probe.ts', `spawn(f, a, ${source});`)).toEqual(['shell-option']);
    expect(rulesIn('platform/probe.ts', `spawn(f, a, ${source});`)).toEqual(['shell-option']);
  });

  it.each([
    ['a property', 'opts.shell = true;'],
    ['a property set to a variable', 'options.shell = wanted;'],
    ['a bracketed property', "opts['shell'] = 'cmd';"],
  ])('shell-option: an assignment – %s (T-07)', (_label, source) => {
    expect(rulesIn('core/probe.ts', source)).toEqual(['shell-option']);
  });

  it('shell-option: allows false, other names, comparisons and comments', () => {
    expect(rulesIn('core/probe.ts', 'spawn(f, a, { cwd, shell: false });')).toEqual([]);
    expect(rulesIn('core/probe.ts', "spawn(f, a, { cwd, 'shell': false });")).toEqual([]);
    expect(rulesIn('core/probe.ts', "opts.shell = false; opts['shell'] = false;")).toEqual([]);
    expect(rulesIn('core/probe.ts', 'if (opts.shell === true || opts.shell == null) return;')).toEqual([]);
    expect(rulesIn('core/probe.ts', 'const loginShell = x; const o = { shellPath: y }; o.shellPath = z;')).toEqual([]);
    expect(rulesIn('core/probe.ts', '// { shell: true }')).toEqual([]);
  });

  it('platform-leaf: only node:* and siblings inside platform/', () => {
    expect(rulesIn('platform/probe.ts', "import { x } from '../core/x.ts';")).toEqual(['platform-leaf']);
    expect(rulesIn('platform/probe.ts', "import { z } from 'zod';")).toEqual(['platform-leaf']);
    expect(rulesIn('platform/probe.ts', "import './sub/y.ts';")).toEqual(['platform-leaf']);
    expect(rulesIn('platform/probe.ts', "const m = await import('../x.ts');")).toEqual(['platform-leaf']);
    expect(rulesIn('platform/probe.ts', "import type { T } from '../core/t.ts';")).toEqual(['platform-leaf']);
    expect(rulesIn('platform/probe.ts', "import { y } from './y.ts';\nimport './exe-search.ts';\nimport { a } from 'node:fs';")).toEqual([]);
    expect(rulesIn('core/probe.ts', "import { x } from '../core/x.ts';")).toEqual([]);
  });

  it('counts an allowance exactly, in both directions', () => {
    const hit = (line: number): SpawnFinding => ({ file: 'a.ts', line, rule: 'raw-kill', code: 'x' });
    const allowed = [{ file: 'a.ts', rule: 'raw-kill' as const, count: 2, reason: 'r' }];
    expect(allowanceProblems([hit(1), hit(2)], allowed)).toEqual([]);
    expect(allowanceProblems([hit(1)], allowed)).toEqual(['a.ts: raw-kill allows 2, found 1']);
    expect(allowanceProblems([hit(1), hit(2), hit(3)], allowed)).toEqual(['a.ts: raw-kill allows 2, found 3']);
    expect(allowanceProblems([], allowed)).toEqual(['stale allowance: a.ts: raw-kill (allows 2, found 0)']);
    expect(allowanceProblems([hit(4)], [])).toEqual([`a.ts:4: x – ${FIX['raw-kill']}`]);
  });
});
