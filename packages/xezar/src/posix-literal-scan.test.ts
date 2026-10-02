import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFiles } from './mcp/audit-source-scan.testkit.ts';
import { stripComments } from './release/instruction-hygiene.testkit.ts';

/**
 * Two POSIX-only spellings that silently break Windows (#963 AC-1, AC-5).
 *
 * - `.startsWith('/')` as an "is absolute" test refuses every `C:\…` path: it is how saved Windows
 *   projects vanished from the registry and why Add project refused them. Use `isAbsolutePath` or
 *   `isFullyQualifiedPath` from `platform/path-syntax.ts`.
 * - A runtime `/tmp` literal does not exist on Windows. Use `os.tmpdir()`.
 *
 * Exactly these two patterns and nothing more: this is not the general platform lint rule, which
 * comes later. Comments are blanked first, so prose about the defect is never a finding; tests and
 * testkits are not scanned. An exception names its exact comment-free source line and a reason.
 */
const SCAN_ROOT = 'packages/xezar/src';

interface Rule {
  readonly id: string;
  /** A line is a finding when ANY of these matches – one rule, several spellings. */
  readonly patterns: readonly RegExp[];
  readonly fix: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'starts-with-slash',
    patterns: [
      /\.startsWith\(\s*(['"`])\/\1\s*\)/,
      // The same test spelled by its first character – `[0]`, `charAt(0)` or `at(0)`, with `===`,
      // `==`, `!==` or `!=`, either operand first (T-12) – or as a regex anchored at `/` alone (#963).
      /(?:\[0\]|\.charAt\(\s*0\s*\)|\.at\(\s*0\s*\))\s*[!=]==?\s*(['"`])\/\1/,
      /(['"`])\/\1\s*[!=]==?\s*[\w$.?!]*(?:\[0\]|\.charAt\(\s*0\s*\)|\.at\(\s*0\s*\))/,
      /\/\^\\\/\/[a-z]*\.test\(/,
    ],
    fix: 'use isAbsolutePath / isFullyQualifiedPath from platform/path-syntax.ts',
  },
  {
    id: 'tmp-literal',
    patterns: [/(['"`])\/tmp(?:\/|\1)/],
    fix: 'use os.tmpdir()',
  },
];

interface Allowance {
  readonly file: string;
  readonly rule: Rule['id'];
  /** The source line, trimmed, exactly as it reads after comments are removed. */
  readonly code: string;
  readonly reason: string;
}

const ALLOWED: readonly Allowance[] = [
  {
    file: 'mcp/resource-ownership.ts',
    rule: 'starts-with-slash',
    code: "if (raw.includes('\\0') || raw.includes('\\\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {",
    reason:
      'A REFUSAL of anything that is not a plain relative name: it refuses a leading `/`, a backslash ' +
      'and a drive letter together, so it already covers the Windows spellings.',
  },
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule['id'];
  readonly code: string;
}

/** Every rule hit in one source text, comments removed, line numbers kept. */
export function literalFindings(file: string, source: string): Finding[] {
  const found: Finding[] = [];
  stripComments(source)
    .split('\n')
    .forEach((raw, index) => {
      for (const rule of RULES) {
        if (rule.patterns.some((pattern) => pattern.test(raw))) {
          found.push({ file, line: index + 1, rule: rule.id, code: raw.trim() });
        }
      }
    });
  return found;
}

function scan(): Finding[] {
  const root = `${REPO_ROOT}${SCAN_ROOT}`;
  return sourceFiles(SCAN_ROOT).flatMap((path) =>
    literalFindings(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')),
  );
}

const isAllowed = (finding: Finding): boolean =>
  ALLOWED.some((a) => a.file === finding.file && a.rule === finding.rule && a.code === finding.code);

describe('POSIX-only path literals (#963)', () => {
  it('no runtime source tests "absolute" with startsWith(\'/\') or names /tmp', () => {
    const offenders = scan().filter((finding) => !isAllowed(finding));
    const fixFor = (id: string) => RULES.find((rule) => rule.id === id)!.fix;
    expect(offenders.map((f) => `${f.file}:${f.line}: ${f.code} – ${fixFor(f.rule)}`).join('\n')).toBe('');
  });

  it('every exception still matches a line and carries a reason', () => {
    const found = scan();
    for (const allowance of ALLOWED) {
      expect(allowance.reason.length, allowance.file).toBeGreaterThan(20);
      const matched = found.some(
        (f) => f.file === allowance.file && f.rule === allowance.rule && f.code === allowance.code,
      );
      expect(matched, `stale exception: ${allowance.file}: ${allowance.code}`).toBe(true);
    }
  });

  it('the rules fire on synthetic lines and ignore comments, so a green scan is not a dropped rule', () => {
    const slash = ['p.startsWith(', "'/'", ')'].join('');
    const tmp = ["const dir = '", '/tmp', "/x';"].join('');
    expect(literalFindings('probe.ts', `if (${slash}) return;`).map((f) => f.rule)).toEqual(['starts-with-slash']);
    expect(literalFindings('probe.ts', tmp).map((f) => f.rule)).toEqual(['tmp-literal']);
    expect(literalFindings('probe.ts', `// ${slash} and ${tmp}`)).toEqual([]);
    expect(literalFindings('probe.ts', "const dir = tmpdir(); const url = p.startsWith('/api');")).toEqual([]);
  });

  it.each([
    ['the first character', ['if (p[0] ', '=== ', "'/'", ') return;'].join('')],
    ['the first character, double-quoted', ['if (value[0]===', '"/"', ') return;'].join('')],
    ['charAt(0)', ['if (p.charAt(0) ', '=== ', "'/'", ') return;'].join('')],
    ['a negated first character (T-12)', ['if (p[0] ', '!== ', "'/'", ') return;'].join('')],
    ['a loose comparison', ['if (p.charAt(0) ', '== ', "'/'", ') return;'].join('')],
    ['a loose negated comparison', ['if (p.charAt(0) ', '!= ', "'/'", ') return;'].join('')],
    ['at(0)', ['if (p.at(0) ', '=== ', "'/'", ') return;'].join('')],
    ['the operands reversed', ['if (', "'/'", ' === ', 'p[0]) return;'].join('')],
    ['the operands reversed, with at(0)', ['if (', '"/"', ' !== ', 'value.at(0)) return;'].join('')],
    ['a regex anchored at a slash', ['if (', '/^', '\\/', '/', '.test(p)) return;'].join('')],
    ['a regex anchored at a slash, with a flag', ['if (', '/^', '\\/', '/u', '.test(p)) return;'].join('')],
  ])('starts-with-slash also fires on %s (#963)', (_label, line) => {
    expect(literalFindings('probe.ts', line).map((f) => f.rule)).toEqual(['starts-with-slash']);
  });

  it('starts-with-slash leaves a regex for a longer prefix, another first character and comments alone', () => {
    expect(literalFindings('probe.ts', ['if (', '/^', '\\/qodeca\\/', '/', '.test(p)) return;'].join(''))).toEqual([]);
    expect(literalFindings('probe.ts', ['if (p[0] ', '=== ', "'.'", ') return;'].join(''))).toEqual([]);
    expect(literalFindings('probe.ts', ['if (', "'/'", ' === ', 'p[1]) return;'].join(''))).toEqual([]);
    expect(literalFindings('probe.ts', ['if (p.at(-1) ', '=== ', "'/'", ') return;'].join(''))).toEqual([]);
    expect(literalFindings('probe.ts', ['// p.charAt(0) ', '=== ', "'/'"].join(''))).toEqual([]);
  });
});
