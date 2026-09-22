import * as fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { __internals as piExtension } from '../scripts/pi-leader-extension.ts';
import { SCAN_UNRESOLVED_ONLY_NAMES, STATE_NAME_ENTRIES } from './local-xezar-top-level-names.ts';
import { stripComments } from './release/instruction-hygiene.testkit.ts';

// Every export stays the real one; only `renameSync` becomes observable, so the C1 control below
// can see the staging name the pi extension renames from.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

/**
 * #838 item C3 — nothing stops a new top-level file appearing under `.local/xezar/`.
 *
 * At least one external consumer checks the files at the TOP LEVEL of a project's
 * `.local/xezar/` against the names xezar writes today, and fails a gate in every project
 * that uses it when an unexpected name appears (AGENTS.md § CLI entry;
 * `BACKWARD_COMPATIBILITY.md` §3). That contract is a SHAPE — a base name, optionally
 * suffixed with `.lock`, `.lock.takeover`, `.tmp`, a `.<pid>.<hex>.tmp` staging form, or a
 * `.1`–`.4` rotation number — not an enumerable set of exact strings; two exact-match lists
 * built against this surface were already wrong for that reason (see the two routing-map C1
 * items this same issue fixes). This test does not repeat that mistake: it enumerates the
 * ALLOWED BASE NAMES below, checks every suffix against the documented shape, and fails when
 * shipped source constructs anything else, rather than asserting on directory contents at runtime.
 *
 * WHY A SOURCE SCAN. `.local/xezar/`'s top-level entries are built by many independent
 * modules (the run store, the MCP audit trail, automations, onboarding, …) and by the shipped pi
 * extension in `scripts/`. A runtime probe can only observe the writers a test happens to drive;
 * the writer that matters is by definition the one nobody remembered to add a fixture for.
 * Reading the source instead means a new name fails this test the moment it is written. This
 * mirrors `state-path-scan.test.ts`'s DC-1 scan (same technique, a different surface).
 *
 * THE FORMS THAT NAME A TOP-LEVEL ENTRY — each has a control test below that goes red on it:
 *   1. `join(<data dir>, NAME, …)`, where the data dir is a parameter spelled `dataDir` (bare or
 *      behind member accesses: `this.dataDir`, `opts.dataDir`), `projectDataDir(…)`, or any
 *      identifier ASSIGNED from one of those (`const data = projectDataDir(repoRoot)`).
 *   2. `join(<anything>, <data-dir marker>, NAME, …)`, where the marker is the literal
 *      `'.local/xezar'`, the pair `'.local', 'xezar'`, or a constant holding either
 *      (`PROJECT_DATA_DIR` in `state-layout.ts`, `XEZAR_DATA_DIR` in the pi extension). A join
 *      that ENDS at the marker is itself a data dir, so the identifier it is assigned to becomes
 *      a head for form 1 (`const candidate = join(dir, XEZAR_DATA_DIR)`).
 *   3. A string literal that starts with, or has a `/` before, `.local/xezar/NAME` — which covers
 *      `join(repoRoot, '.local/xezar/kit')` and constants such as `WORKTREES_DIR`.
 *   4. A template whose name is `${CONST}<suffix>`: the suffix must be a documented one, so
 *      `${AUDIT_TRAIL_FILE}-shadow.json` is a NEW name, not `audit.ndjson`.
 *   5. Any `${…}<suffix>` template whose suffix mentions `tmp`, `lock` or `takeover`, anywhere in
 *      shipped source — a staging or lock name must use the documented shape (`.tmp`,
 *      `.<pid>.<hex>.tmp`, `.lock`, `.lock.takeover`). Where the file is written cannot be read
 *      statically, so the rule applies everywhere and a name that provably lives OUTSIDE
 *      `.local/xezar/` is named in `SUFFIX_EXCEPTIONS` with its reason. The old C1 shape
 *      `${path}.tmp-${process.pid}` is exactly what this catches.
 *
 * WHAT IT STILL CANNOT SEE: a name concatenated with `+`, or a data dir that reaches a join
 * through a function parameter spelled something other than `dataDir`. Neither shape exists in
 * shipped source today; a new one needs its own form here and its own control test.
 *
 * WHAT THE SCAN CANNOT RESOLVE STATICALLY. A handful of call sites pass a runtime variable
 * (`filename`) rather than a literal or a same-file constant — `automations/store.ts`'s shared
 * read/write helpers. Those are named individually in `UNRESOLVED_CALLS` below, rather than
 * silently passing (a scan that skips what it cannot parse is not a guard). One call site's
 * `dataDir` name is a false friend — `server.ts`'s `PUT /config` route — and is named in
 * `SHADOWED_CALLS` with the reason, rather than added to `ALLOWED_NAMES`.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Shipped source roots. `scripts/` holds the pi extension, which writes `pi-leader.json` here. */
const SCAN_ROOTS = ['src', 'scripts'] as const;

/** A parameter or member spelled `dataDir`, or `projectDataDir(…)`. */
const DATA_DIR_HEAD = /^(?:[\w$#]+\.)*dataDir$/;

/** The documented suffixes after a base name (AGENTS.md § CLI entry, BACKWARD_COMPATIBILITY.md §3). */
const DOCUMENTED_SUFFIX = /^(?:\.lock(?:\.takeover)?|\.takeover|\.tmp|\.\$\{[^}]*\}\.\$\{[^}]*\}\.tmp|\.\$\{[^}]*\}|\.[1-4])$/;

/**
 * The allowed top-level base names, read from production source and verified individually (not
 * copied from a report — see the file header). The suffix is checked separately against
 * `DOCUMENTED_SUFFIX`; this map holds base names only.
 *
 * Derived from `STATE_NAME_ENTRIES` in `local-xezar-top-level-names.ts` — that module, not this
 * test, is the one source of truth for the list (#838 item C3, follow-up: it is also what a
 * future `xezar state-names --json` prints). `reachedOnlyThroughUnresolvedCall` is a scan-only
 * annotation with no equivalent in the published contract, so it is layered on here from
 * `SCAN_UNRESOLVED_ONLY_NAMES` rather than carried by the module.
 */
interface AllowedName {
  readonly reason: string;
  /** Set when this name is never a resolvable name itself — only reachable through an entry in
   *  `UNRESOLVED_CALLS` — so the "no stale ALLOWED_NAMES entry" check must not expect the scan
   *  to find it directly. */
  readonly reachedOnlyThroughUnresolvedCall?: true;
}

const ALLOWED_NAMES: Readonly<Record<string, AllowedName>> = Object.fromEntries(
  STATE_NAME_ENTRIES.map((entry) => [
    entry.name,
    {
      reason: entry.reason,
      ...(SCAN_UNRESOLVED_ONLY_NAMES.has(entry.name) ? { reachedOnlyThroughUnresolvedCall: true as const } : {}),
    },
  ]),
);

/**
 * Call sites whose name argument is a runtime variable this scan cannot resolve statically.
 * Each is named by its exact (comment-stripped) source line, with a written reason — the same
 * discipline `state-path-scan.test.ts`'s `ALLOWED` list applies to `homedir()`/`.xezar` findings.
 */
interface Allowance {
  readonly file: string;
  readonly code: string;
  readonly count?: number;
  readonly reason: string;
}

const UNRESOLVED_CALLS: readonly Allowance[] = [
  {
    file: 'src/automations/store.ts',
    code: 'const path = join(this.dataDir, filename);',
    count: 5,
    reason:
      "`filename` is one of this file's own DEFINITIONS ('automations.json'), STATE " +
      "('automation-state.json'), RECEIPTS ('automation-receipts.ndjson') or LOG " +
      "('automation-log.ndjson') constants, passed in by each call site's caller — verified by " +
      'reading the four `const` declarations at the top of the file. All four base names are in ALLOWED_NAMES.',
  },
];

/**
 * Call sites that superficially match (a variable literally named `dataDir` fed to `join(…)`)
 * but do not name a `.local/xezar` entry at all — excluded before the name check runs, so they
 * are never used to justify widening `ALLOWED_NAMES`.
 */
const SHADOWED_CALLS: readonly Allowance[] = [
  {
    file: 'src/server/server.ts',
    code: "const configPath = join(dataDir, 'config.json');",
    reason:
      "This route's local `dataDir` is `projectKitDir(repoRoot)` (the committed `.xezar` kit " +
      'config), not the runtime `.local/xezar` this test scans — verified at the `PUT /config` ' +
      'handler, `const dataDir = projectKitDir(repoRoot);`, a few lines above this call.',
  },
];

/** Staging/lock names outside the documented shape that provably never live in `.local/xezar/`. */
const SUFFIX_EXCEPTIONS: readonly Allowance[] = [
  {
    file: 'src/paths.ts',
    code: 'return join(serverInstancesDir(), `${instance}.install.lock`);',
    reason: "The installer's per-instance lock under the per-user home's server instances directory (serverInstancesDir), never a project's `.local/xezar`.",
  },
  {
    file: 'src/agent-config/files.ts',
    code: 'tmp = `${target}.xez-tmp-${process.pid}-${randomUUID()}`;',
    reason: "Stages an edit to a coding agent's OWN config file (checkedConfigPath, beside that file), never a `.local/xezar` entry.",
  },
];

/** Split the arguments of a call whose `(` is just before `openIndex`, honouring nested
 *  parens/brackets and treating quoted strings (including backtick templates) as opaque. */
function splitCallArgs(source: string, openIndex: number): { args: string[]; end: number } {
  let depth = 0;
  let quote: '' | "'" | '"' | '`' = '';
  let current = '';
  const args: string[] = [];
  let i = openIndex;
  for (; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\') { current += source[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        if (current.trim().length > 0) args.push(current.trim());
        return { args, end: i + 1 };
      }
      depth--;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current.trim());
  return { args, end: source.length };
}

/** `const NAME = 'value';` / `export const NAME = 'value';`, collected per file. */
function collectConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const re = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*'([^']*)'\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) constants.set(m[1]!, m[2]!);
  return constants;
}

const unquote = (arg: string): string | null => (arg.match(/^'([^']*)'$/) ?? arg.match(/^"([^"]*)"$/) ?? arg.match(/^`([^`$]*)`$/))?.[1] ?? null;

/** The identifiers and constants that name the data dir itself in one file. */
interface DataDirContext {
  readonly constants: Map<string, string>;
  /** Constants whose value is `.local/xezar` (literal or `join('.local', 'xezar')`). */
  readonly markers: Set<string>;
  /** Identifiers assigned from a data-dir expression. */
  readonly aliases: Set<string>;
}

/** Index of the last argument that names the data dir itself, or -1. */
function dataDirEnd(args: readonly string[], ctx: DataDirContext): number {
  let end = -1;
  args.forEach((arg, i) => {
    const literal = unquote(arg);
    if (i === 0 && (DATA_DIR_HEAD.test(arg) || ctx.aliases.has(arg) || /^projectDataDir\(.*\)$/s.test(arg))) end = i;
    if (literal === '.local/xezar' || ctx.markers.has(arg)) end = i;
    if (literal === 'xezar' && i > 0 && unquote(args[i - 1]!) === '.local') end = i;
  });
  return end;
}

function isDataDirExpr(expr: string, ctx: DataDirContext): boolean {
  const e = expr.trim();
  if (DATA_DIR_HEAD.test(e) || ctx.aliases.has(e) || /^projectDataDir\(.*\)$/s.test(e)) return true;
  if (!e.startsWith('join(')) return false;
  const { args, end } = splitCallArgs(e, 'join('.length);
  return end === e.length && dataDirEnd(args, ctx) === args.length - 1;
}

function dataDirContext(source: string): DataDirContext {
  const constants = collectConstants(source);
  const markers = new Set<string>();
  const aliases = new Set<string>();
  const ctx = { constants, markers, aliases };
  for (const [name, value] of constants) if (value === '.local/xezar') markers.add(name);
  const assign = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*([^;\n]+)/g;
  // To a fixed point: an alias may be built from an alias.
  for (let changed = true; changed;) {
    changed = false;
    for (const m of source.matchAll(assign)) {
      const [, name, rhs] = m;
      if (markers.has(name!) || aliases.has(name!)) continue;
      const bare = rhs!.trim();
      if (/^join\(\s*'\.local'\s*,\s*'xezar'\s*\)$/.test(bare) || unquote(bare) === '.local/xezar') { markers.add(name!); changed = true; continue; }
      if (isDataDirExpr(bare, ctx)) { aliases.add(name!); changed = true; }
    }
  }
  return ctx;
}

/** A top-level name, or a problem with it. `resolvedName` null means "not statically known". */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly resolvedName: string | null;
  /** Set when the name's SHAPE is wrong regardless of its base. */
  readonly problem?: string;
}

/** Resolve a name argument to `{ name }`, `{ problem }`, or null (a runtime value). */
function resolveName(arg: string, constants: Map<string, string>): { name: string } | { problem: string } | null {
  const literal = unquote(arg);
  if (literal !== null) return { name: literal.split('/')[0]! };
  // A template that starts with `${IDENT}`: the constant decides the base name, and the rest must
  // be a documented suffix. `${AUDIT_TRAIL_FILE}-shadow.json` is a new name, not `audit.ndjson`.
  const template = arg.match(/^`\$\{(\w+)\}([^`]*)`$/);
  if (template) {
    const base = constants.get(template[1]!);
    if (base === undefined) return null;
    if (template[2] === '' || DOCUMENTED_SUFFIX.test(template[2]!)) return { name: base };
    return { problem: `suffix '${template[2]}' on '${base}' is not a documented shape` };
  }
  const ident = arg.match(/^([A-Za-z_$][\w$]*)$/);
  if (ident) {
    const value = constants.get(ident[1]!);
    return value === undefined ? null : { name: value.split('/')[0]! };
  }
  return null;
}

function toFinding(file: string, stripped: string, index: number, resolved: ReturnType<typeof resolveName>): Finding {
  const line = stripped.slice(0, index).split('\n').length;
  const code = stripped.split('\n')[line - 1]!.trim();
  if (resolved === null) return { file, line, code, resolvedName: null };
  if ('problem' in resolved) return { file, line, code, resolvedName: null, problem: resolved.problem };
  return { file, line, code, resolvedName: resolved.name };
}

/** Every construction of a `.local/xezar` top-level name in one file (forms 1–5, file header). */
function findingsIn(file: string, source: string): Finding[] {
  const stripped = stripComments(source);
  const ctx = dataDirContext(stripped);
  const findings: Finding[] = [];

  // Forms 1, 2 and 4: a join that continues past the data dir.
  for (const m of stripped.matchAll(/\bjoin\(/g)) {
    const { args } = splitCallArgs(stripped, m.index + m[0].length);
    const end = dataDirEnd(args, ctx);
    if (end === -1 || end + 1 >= args.length) continue;
    findings.push(toFinding(file, stripped, m.index, resolveName(args[end + 1]!, ctx.constants)));
  }

  // Form 3: a path literal naming `.local/xezar/<name>`.
  for (const m of stripped.matchAll(/['"`](?:[^'"`\n]*\/)?\.local\/xezar\/([^/'"`\s]*)/g)) {
    const raw = m[1]!;
    if (raw === '') continue;
    findings.push(toFinding(file, stripped, m.index, raw.startsWith('$') ? null : { name: raw }));
  }

  // Form 5: a staging or lock name outside the documented shape.
  for (const m of stripped.matchAll(/`\$\{[^}]+\}([^`]*)`/g)) {
    const suffix = m[1]!;
    // Only the literal text decides (`${blocker.fix}` is not a lock); whole words only.
    if (!/\b(?:tmp|lock|takeover)\b/i.test(suffix.replace(/\$\{[^}]*\}/g, ' ')) || DOCUMENTED_SUFFIX.test(suffix)) continue;
    findings.push(toFinding(file, stripped, m.index, { problem: `staging/lock suffix '${suffix}' is not a documented shape` }));
  }
  return findings;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...sourceFiles(path)); continue; }
    if (!/\.(?:tsx?|mjs|js)$/.test(entry.name)) continue;
    if (/\.(test|testkit)\.tsx?$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

function scannedFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) => sourceFiles(join(PACKAGE_ROOT, root)))
    .map((path) => relative(PACKAGE_ROOT, path).split(sep).join('/'));
}

function scan(): Finding[] {
  return scannedFiles().flatMap((file) => findingsIn(file, readFileSync(join(PACKAGE_ROOT, file), 'utf8')));
}

function budgetOf(list: readonly Allowance[]): Map<string, number> {
  const budget = new Map<string, number>();
  for (const entry of list) {
    const key = `${entry.file} ${entry.code}`;
    budget.set(key, (budget.get(key) ?? 0) + (entry.count ?? 1));
  }
  return budget;
}

/** The findings no allowance explains, one line each. */
function unexplained(findings: readonly Finding[]): string[] {
  const shadowBudget = budgetOf(SHADOWED_CALLS);
  const unresolvedBudget = budgetOf(UNRESOLVED_CALLS);
  const suffixBudget = budgetOf(SUFFIX_EXCEPTIONS);
  const out: string[] = [];
  const take = (budget: Map<string, number>, key: string): boolean => {
    const left = budget.get(key) ?? 0;
    if (left > 0) budget.set(key, left - 1);
    return left > 0;
  };
  for (const finding of findings) {
    const key = `${finding.file} ${finding.code}`;
    const at = `${finding.file}:${finding.line}`;
    if (finding.problem !== undefined) {
      if (!take(suffixBudget, key)) out.push(`${at}  ${finding.problem}  ${finding.code}`);
      continue;
    }
    if (take(shadowBudget, key)) continue;
    if (finding.resolvedName === null) {
      if (!take(unresolvedBudget, key)) out.push(`${at}  UNRESOLVED, not in UNRESOLVED_CALLS  ${finding.code}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_NAMES, finding.resolvedName)) {
      out.push(`${at}  name '${finding.resolvedName}' not in ALLOWED_NAMES  ${finding.code}`);
    }
  }
  return out;
}

/** What the scan reports for one probe file — the control tests' single entry point. */
const probe = (file: string, lines: readonly string[]): string[] => unexplained(findingsIn(file, lines.join('\n')));

describe('.local/xezar/ gets no new top-level entry unnoticed (#838 item C3)', () => {
  it('finds only allowed top-level names, or an explicitly explained call site', () => {
    expect(
      unexplained(scan()),
      'A .local/xezar/ top-level entry is being constructed outside the documented shape. Add the ' +
        'name to ALLOWED_NAMES with a reason if it genuinely belongs (and update AGENTS.md / ' +
        'BACKWARD_COMPATIBILITY.md §3), or fix the call site if it does not.',
    ).toEqual([]);
  });

  it('scans the shipped scripts as well as src (control)', () => {
    const files = scannedFiles();
    expect(files).toContain('scripts/pi-leader-extension.ts');
    expect(files).toContain('src/project-kit-paths.ts');
    // The extension's own descriptor is found through XEZAR_DATA_DIR → findProjectDataDir → dataDir.
    const names = scan().filter((f) => f.file === 'scripts/pi-leader-extension.ts').map((f) => f.resolvedName);
    expect(names).toContain('pi-leader.json');
  });

  it('has no stale SHADOWED_CALLS, UNRESOLVED_CALLS or SUFFIX_EXCEPTIONS entry', () => {
    const findings = scan();
    const keys = (select: (f: Finding) => boolean) => findings.filter(select).map((f) => `${f.file} ${f.code}`);
    const check = (label: string, list: readonly Allowance[], found: string[]) => {
      const budget = budgetOf(list);
      for (const key of found) if (budget.get(key)) budget.set(key, budget.get(key)! - 1);
      return [...budget].filter(([, left]) => left > 0).map(([key, left]) => `${label}: ${key}  (${left} unused)`);
    };
    const stale = [
      ...check('SHADOWED_CALLS', SHADOWED_CALLS, keys((f) => f.resolvedName !== null)),
      ...check('UNRESOLVED_CALLS', UNRESOLVED_CALLS, keys((f) => f.resolvedName === null && f.problem === undefined)),
      ...check('SUFFIX_EXCEPTIONS', SUFFIX_EXCEPTIONS, keys((f) => f.problem !== undefined)),
    ];
    expect(stale, 'An allowance matches nothing any more — delete it.').toEqual([]);
  });

  it('has no stale ALLOWED_NAMES entry never produced by a resolvable call site', () => {
    const seen = new Set<string>();
    for (const finding of scan()) if (finding.resolvedName !== null) seen.add(finding.resolvedName);
    const stale = Object.entries(ALLOWED_NAMES)
      .filter(([, allowed]) => !allowed.reachedOnlyThroughUnresolvedCall)
      .map(([name]) => name)
      .filter((name) => !seen.has(name));
    expect(
      stale,
      'A name in ALLOWED_NAMES is never produced by a resolvable call — delete it, or mark it ' +
        'reachedOnlyThroughUnresolvedCall if UNRESOLVED_CALLS is the only reason it is here.',
    ).toEqual([]);
  });

  describe('each construction form goes red on a new name (controls, review round 1 E1–E6)', () => {
    it('E1 — join(dataDir, NAME)', () => {
      expect(probe('src/probe.ts', ["const p = join(dataDir, 'new-thing.json');"])).toEqual([
        "src/probe.ts:1  name 'new-thing.json' not in ALLOWED_NAMES  const p = join(dataDir, 'new-thing.json');",
      ]);
    });

    it("E2 — a '.local/xezar/<name>' literal, in a join or in a constant", () => {
      expect(probe('src/probe.ts', ["const p = join(repoRoot, '.local/xezar/new-thing.json');"])).toHaveLength(1);
      expect(probe('src/probe.ts', ["export const NEW_DIR = '.local/xezar/new-thing';"])).toHaveLength(1);
      expect(probe('src/probe.ts', ["const p = join(repoRoot, '.local', 'xezar', 'new-thing.json');"])).toHaveLength(1);
      expect(probe('src/probe.ts', ["const D = join('.local', 'xezar');", "const p = join(root, D, 'new-thing.json');"])).toHaveLength(1);
      // Prose that merely mentions the folder is not a path.
      expect(probe('src/probe.ts', ["const fix = 'Make the project’s .local/xezar/mcp folder writable';"])).toEqual([]);
      expect(probe('src/probe.ts', ["const p = join(repoRoot, '.local/xezar/kit');"])).toEqual([]);
    });

    it('E3 — join(dataDir, NAME) in the shipped scripts/ extension', () => {
      expect(probe('scripts/pi-leader-extension.ts', [
        "const XEZAR_DATA_DIR = join('.local', 'xezar');",
        'const candidate = join(dir, XEZAR_DATA_DIR);',
        "const a = join(candidate, 'new-thing.json');",
        "const b = join(dataDir, 'other-thing.json');",
      ])).toHaveLength(2);
    });

    it('E4 — a known constant with an undocumented suffix is a new name', () => {
      const source = ["export const AUDIT_TRAIL_FILE = 'audit.ndjson';"];
      expect(probe('src/probe.ts', [...source, 'const p = join(dataDir, `${AUDIT_TRAIL_FILE}-shadow.json`);'])).toHaveLength(1);
      for (const ok of ['.lock', '.lock.takeover', '.tmp', '.${generation}', '.${process.pid}.${hex}.tmp']) {
        expect(probe('src/probe.ts', [...source, `const p = join(dataDir, \`\${AUDIT_TRAIL_FILE}${ok}\`);`]), ok).toEqual([]);
      }
    });

    it('E5 — an identifier assigned from projectDataDir(…) or ….dataDir is a data-dir head', () => {
      expect(probe('src/probe.ts', ['const data = projectDataDir(repoRoot);', "const p = join(data, 'new-thing.json');"])).toHaveLength(1);
      expect(probe('src/probe.ts', ['const boot = deps.store.dataDir;', "const p = join(boot, 'new-thing.json');"])).toHaveLength(1);
      expect(probe('src/probe.ts', ['const a = projectDataDir(r);', 'const b = a;', "const p = join(b, 'new-thing.json');"])).toHaveLength(1);
    });

    it('E6 — a staging name outside the documented shape (the old C1 form)', () => {
      expect(probe('src/probe.ts', ['const tmp = `${p}.tmp-${process.pid}`;'])).toHaveLength(1);
      expect(probe('src/probe.ts', ['const tmp = `${p}.${process.pid}.${randomBytes(4).toString(\'hex\')}.tmp`;'])).toEqual([]);
      expect(probe('src/probe.ts', ['const tmp = `${p}.tmp`;'])).toEqual([]);
    });
  });

  it('reads code and not prose — a comment mentioning join(dataDir, …) is not a finding (control)', () => {
    const findings = findingsIn('probe.ts', [
      '/**',
      " *  character class, and `join(dataDir, 'tmp', '..')` resolves to `<dataDir>`",
      " *  and '.local/xezar/secret' is only a comment",
      ' */',
      "const real = join(dataDir, 'runs');",
    ].join('\n'));
    expect(findings.map((f) => f.resolvedName)).toEqual(['runs']);
  });
});

describe('the pi extension stages pi-leader.json in the documented shape (#838 item C1)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('renames from `pi-leader.json.<pid>.<8 hex>.tmp`', () => {
    dir = mkdtempSync(join(tmpdir(), 'xez-c1-'));
    const rename = vi.mocked(fs.renameSync);
    rename.mockClear();
    piExtension.writeDescriptor(join(dir, 'pi-leader.json'), { socket: '/tmp/x.sock', sessionId: 's' });
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0]!;
    expect(to).toBe(join(dir, 'pi-leader.json'));
    expect(String(from).slice(dir.length + 1)).toMatch(/^pi-leader\.json\.\d+\.[0-9a-f]{8}\.tmp$/);
    expect(readdirSync(dir)).toEqual(['pi-leader.json']);
  });
});
