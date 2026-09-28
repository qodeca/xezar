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
  readonly pattern: RegExp;
  readonly fix: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'starts-with-slash',
    pattern: /\.startsWith\(\s*(['"`])\/\1\s*\)/,
    fix: 'use isAbsolutePath / isFullyQualifiedPath from platform/path-syntax.ts',
  },
  {
    id: 'tmp-literal',
    pattern: /(['"`])\/tmp(?:\/|\1)/,
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
        if (rule.pattern.test(raw)) found.push({ file, line: index + 1, rule: rule.id, code: raw.trim() });
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
});
