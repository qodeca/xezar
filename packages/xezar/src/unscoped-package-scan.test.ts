import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFiles, withoutComments } from './mcp/audit-source-scan.testkit.ts';

/**
 * The unscoped npm name is a supply-chain hole, not a typo (#819 F1).
 *
 * The bare unscoped name asks the registry for a package nobody here publishes, so anyone could
 * publish it and a person following our own printed line would run their code. The fix routed
 * every shipped command line through `npxCommand()` in `own-package.ts`, and this guard is what
 * keeps a bare name from coming back the next time somebody adds a closing line.
 *
 * It is a SOURCE SCAN over `packages/xezar/src` and not a runtime assertion because the call site
 * that matters is the one nobody thought of: a unit test can only exercise the strings its own
 * code path reaches, and there are four such surfaces today (the `run` tail twice, the `projects`
 * empty state and the `init` closing lines). Comments are blanked out first, so prose ABOUT the
 * defect — of which this repository has plenty — is never a finding, while a string literal is
 * exactly what is left to catch.
 *
 * The scan is deliberately scoped to the CLI package. `packages/web` carries the same string in
 * one piece of cockpit copy; that surface is UI under the design gate and is tracked as its own
 * follow-up rather than widened into this fix.
 */

/** The only tree whose strings this guard reads — the published CLI's own source. */
const SCAN_ROOT = 'packages/xezar/src';

/**
 * A bare unscoped command on one line. `\s+` rather than a literal space so this file's own source
 * does not carry the string it bans; `\b` at both ends so a longer package name that merely
 * contains these words is not a finding.
 */
const BARE_UNSCOPED = /\bnpx\s+xezar\b/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

/** Every line of one source text that still prints the bare unscoped command. */
export function bareCommandLines(source: string): number[] {
  const lines: number[] = [];
  withoutComments(source)
    .split('\n')
    .forEach((raw, index) => {
      if (BARE_UNSCOPED.test(raw.trim())) lines.push(index + 1);
    });
  return lines;
}

function findings(): Finding[] {
  const found: Finding[] = [];
  for (const path of sourceFiles(SCAN_ROOT)) {
    const text = readFileSync(path, 'utf8');
    for (const line of bareCommandLines(text)) {
      found.push({
        file: relative(REPO_ROOT, path),
        line,
        code: text.split('\n')[line - 1]!.trim(),
      });
    }
  }
  return found;
}

describe('shipped strings name the scoped package (#819 F1)', () => {
  it('no shipped string prints a bare unscoped npx command', () => {
    const found = findings();
    expect(found.map((f) => `${f.file}:${f.line}: ${f.code}`).join('\n')).toBe('');
  });

  it('the rule fires on a synthetic line, so a green scan is not a dropped rule', () => {
    // Built from parts so this probe's own source does not carry the banned literal.
    const bare = ['npx', 'xezar'].join(' ');
    expect(bareCommandLines(`io.log('start the cockpit with ${bare}');`)).toEqual([1]);
    // The scoped form is the one that is allowed, and must not be a finding.
    expect(bareCommandLines("io.log('start the cockpit with npx @qodeca/xezar');")).toEqual([]);
  });
});
