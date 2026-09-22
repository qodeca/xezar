import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { stripComments } from './state-path-scan.test.ts';

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
 * ALLOWED BASE NAMES below and fails when production source constructs a name outside them,
 * rather than asserting on directory contents at runtime.
 *
 * WHY A SOURCE SCAN. `.local/xezar/`'s top-level entries are built by many independent
 * modules (the run store, the MCP audit trail, automations, onboarding, …), each calling
 * `join(dataDir, …)` (or the equivalent `projectDataDir(repoRoot)` construction) with its own
 * literal or constant. A runtime probe can only observe the writers a test happens to drive;
 * the writer that matters is by definition the one nobody remembered to add a fixture for.
 * Reading the source instead means a NEW `join(dataDir, 'something-new')` call fails this test
 * the moment it is written, before it ships. This mirrors `state-path-scan.test.ts`'s DC-1
 * scan (same technique, a different surface): strip comments, find the call shape, and refuse
 * anything the allowlist does not explain.
 *
 * WHAT COUNTS AS "dataDir". The project's per-repo runtime directory is always
 * `<repo>/.local/xezar` (`project-data-paths.ts`'s `projectDataDir`), threaded through the
 * codebase as a parameter almost always spelled `dataDir` — bare, or qualified through one
 * member access (`this.dataDir`, `opts.dataDir`, `layout.dataDir`, `options.dataDir`,
 * `scope.dataDir`) — or passed as `projectDataDir(<repoRoot expression>)` directly. Both forms
 * are matched as the first argument of a `join(…)` call. `~/.xezar` (or `<project>/.xezar`,
 * the committed kit) is a DIFFERENT directory and out of scope here — `state-path-scan.test.ts`
 * already guards the home/`.xezar` boundary; this file only cares about `.local/xezar`.
 *
 * WHAT THE SCAN CANNOT RESOLVE STATICALLY. A handful of call sites pass a runtime variable
 * (`filename`) rather than a literal or a same-file constant — `automations/store.ts`'s shared
 * read/write helpers, called elsewhere in the same file with one of four constants. Those are
 * named individually in `UNRESOLVED_CALLS` below, with the constant values verified by reading
 * the file, rather than silently passing (a scan that skips what it cannot parse is not a
 * guard). One call site's `dataDir` name is a false friend — `server.ts`'s `PUT /config` route
 * names its local variable `dataDir` for a DIFFERENT directory (`projectKitDir`, the committed
 * `.xezar` kit) — and is named in `SHADOWED_CALLS` with the reason, rather than added to
 * `ALLOWED_NAMES` where it would wrongly widen what a REAL `.local/xezar` entry may be called.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The project's runtime data directory, named as the first argument of a `join(…)` call. */
const DATA_DIR_HEAD = /^(?:[\w$]+\.)*dataDir$/;

function isDataDirHead(arg: string): boolean {
  if (DATA_DIR_HEAD.test(arg)) return true;
  return arg.startsWith('projectDataDir(') && arg.endsWith(')');
}

/**
 * The allowed top-level base names, read from production source at `8dc97f3c` and verified
 * individually (not copied from a report — see the file header). A name may appear suffixed
 * with `.lock`, `.lock.takeover`, `.tmp`, a `.<pid>.<hex>.tmp` staging form, or `.1`–`.4`
 * rotation; this scan resolves to the BASE name and never constructs the suffixed form, so it
 * does not need to enumerate suffixes here — `AGENTS.md` and `BACKWARD_COMPATIBILITY.md` §3 own
 * that shape.
 */
interface AllowedName {
  readonly reason: string;
  /** Set when this name is never a resolvable `join(dataDir, …)` literal/constant itself —
   *  only reachable through an entry in `UNRESOLVED_CALLS` — so the "no stale ALLOWED_NAMES
   *  entry" check must not expect the scan to find it directly. */
  readonly reachedOnlyThroughUnresolvedCall?: true;
}

const ALLOWED_NAMES: Readonly<Record<string, AllowedName>> = {
  'runs.json': { reason: 'The run index (runs/store.ts, runs/run-index.ts).' },
  runs: { reason: 'The per-run event NDJSON / handoff / images directory (runs/store.ts, workflows/run.ts).' },
  worktrees: { reason: 'Task git worktrees (git-worktree.ts, mcp/resource-ownership.ts).' },
  tmp: { reason: 'Per-run agent scratch directories (runs/agent-tmpdir.ts).' },
  'writer-claims': { reason: 'Cross-process writer-instance claims (runs/project-writer.ts).' },
  'ui-state.json': { reason: 'Per-repo GUI state, direct write (ui-state.ts).' },
  'launch-key': { reason: 'The `/new` prefill key, direct write, mode 0600 (server/launch-key.ts).' },
  'todos.json': { reason: 'The follow-up inbox (todos.ts).' },
  'onboarding-state.json': { reason: 'Onboarding progress (onboarding/state.ts).' },
  'audit.ndjson': { reason: 'The MCP audit trail, with `.1`–`.4` rotation and `.lock` (mcp/audit-trail.ts, AUDIT_TRAIL_FILE).' },
  'mcp-audit.ndjson': { reason: 'The legacy audit trail name, read-only, never written (mcp/audit-trail.ts, LEGACY_AUDIT_TRAIL_FILE).' },
  'mcp-connection.json': { reason: 'The MCP bridge connection descriptor (mcp/connection-file.ts, MCP_CONNECTION_FILE).' },
  mcp: { reason: 'The MCP subdirectory (leader cursors, …) (mcp/event-journal.ts, mcp/reconnect.ts).' },
  'mcp-owner-claims': { reason: 'Cross-process MCP ownership claims (workspace/project-owner.ts, OWNER_CLAIM_DIR).' },
  'mcp-operations.ndjson': { reason: 'The MCP operation-receipt journal (mcp/operation-receipts.ts, RECEIPT_JOURNAL_FILE).' },
  'mcp-operations.json': { reason: 'The MCP operation-receipt snapshot (mcp/operation-receipts.ts, RECEIPT_SNAPSHOT_FILE).' },
  'automations.json': { reason: 'Automation definitions (automations/store.ts DEFINITIONS, automations/coordinator.ts).' },
  'automation-state.json': {
    reason: 'Automation runtime state (automations/store.ts STATE).',
    reachedOnlyThroughUnresolvedCall: true,
  },
  'automation-receipts.ndjson': {
    reason: 'Automation receipts (automations/store.ts RECEIPTS).',
    reachedOnlyThroughUnresolvedCall: true,
  },
  'automation-log.ndjson': {
    reason: 'Automation log (automations/store.ts LOG).',
    reachedOnlyThroughUnresolvedCall: true,
  },
  'automation-poll.lock': { reason: 'The automation poller’s cross-process lock (automations/store.ts, POLL_LOCK).' },
  'pi-leader.json': { reason: 'The pi leader socket descriptor (mcp/adapters/pi-link.ts, PI_LEADER_FILE).' },
  tasks: { reason: 'Task evidence directories — written by the kit, read here for evidence-root resolution (core/run-evidence-roots.ts).' },
  // ---- single-project mode only ----
  'machine-state.json': {
    reason: 'Per-machine facts of a single-project root — single-project mode only (workspace/project-machine-state.ts).',
  },
  cache: { reason: 'The project layout’s skills cache — single-project mode only (state-layout.ts).' },
  ipc: { reason: 'The project layout’s IPC directory — single-project mode only (state-layout.ts).' },
};

/**
 * Call sites whose second argument is a runtime variable this scan cannot resolve statically.
 * Each is named by its exact (comment-stripped) source line, with a written reason — the same
 * discipline `state-path-scan.test.ts`'s `ALLOWED` list applies to `homedir()`/`.xezar` findings.
 */
interface UnresolvedAllowance {
  readonly file: string;
  readonly code: string;
  readonly count?: number;
  readonly reason: string;
}

const UNRESOLVED_CALLS: readonly UnresolvedAllowance[] = [
  {
    file: 'automations/store.ts',
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
const SHADOWED_CALLS: readonly UnresolvedAllowance[] = [
  {
    file: 'server/server.ts',
    code: "const configPath = join(dataDir, 'config.json');",
    reason:
      "This route's local `dataDir` is `projectKitDir(repoRoot)` (the committed `.xezar` kit " +
      'config), not the runtime `.local/xezar` this test scans — verified at the `PUT /config` ' +
      'handler, `const dataDir = projectKitDir(repoRoot);`, a few lines above this call.',
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

/** Resolve a `join(dataDir, ARG)` second argument to a literal base name, when possible. */
function resolveName(arg: string, constants: Map<string, string>): string | null {
  const quoted = arg.match(/^'([^']*)'$/) ?? arg.match(/^"([^"]*)"$/);
  if (quoted) return quoted[1]!;
  const plainTemplate = arg.match(/^`([^`$]*)`$/);
  if (plainTemplate) return plainTemplate[1]!;
  // A template that starts with a single `${IDENT}` — e.g. `${AUDIT_TRAIL_FILE}.${generation}`
  // (rotation) or `${AUDIT_TRAIL_FILE}.lock`. Only the leading identifier decides the base name;
  // whatever follows is a documented suffix shape, not a new name.
  const templateHead = arg.match(/^`\$\{(\w+)\}/);
  if (templateHead) return constants.get(templateHead[1]!) ?? null;
  const ident = arg.match(/^([A-Za-z_$][\w$]*)$/);
  if (ident) return constants.get(ident[1]!) ?? null;
  return null;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly resolvedName: string | null;
}

/** Every `join(<dataDir-like>, …)` call in one file's (comment-stripped) source. */
function findingsIn(file: string, source: string): Finding[] {
  const stripped = stripComments(source);
  const findings: Finding[] = [];
  const callRe = /\bjoin\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(stripped)) !== null) {
    const openIndex = m.index + m[0].length;
    const { args } = splitCallArgs(stripped, openIndex);
    if (args.length < 2 || !isDataDirHead(args[0]!)) continue;
    const line = stripped.slice(0, m.index).split('\n').length;
    const lineText = stripped.split('\n')[line - 1]!.trim();
    const constants = collectConstants(stripped);
    findings.push({ file, line, code: lineText, resolvedName: resolveName(args[1]!, constants) });
  }
  return findings;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { found.push(...sourceFiles(path)); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|testkit)\.tsx?$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    findings.push(...findingsIn(file, readFileSync(path, 'utf8')));
  }
  return findings;
}

function budgetOf(list: readonly UnresolvedAllowance[]): Map<string, number> {
  const budget = new Map<string, number>();
  for (const entry of list) {
    const key = `${entry.file} ${entry.code}`;
    budget.set(key, (budget.get(key) ?? 0) + (entry.count ?? 1));
  }
  return budget;
}

describe('.local/xezar/ gets no new top-level entry unnoticed (#838 item C3)', () => {
  it('finds only allowed top-level names, or an explicitly explained call site', () => {
    const shadowBudget = budgetOf(SHADOWED_CALLS);
    const unresolvedBudget = budgetOf(UNRESOLVED_CALLS);
    const unexplained: string[] = [];
    const seenNames = new Set<string>();

    for (const finding of scan()) {
      const key = `${finding.file} ${finding.code}`;

      const shadowLeft = shadowBudget.get(key) ?? 0;
      if (shadowLeft > 0) { shadowBudget.set(key, shadowLeft - 1); continue; }

      if (finding.resolvedName === null) {
        const left = unresolvedBudget.get(key) ?? 0;
        if (left > 0) { unresolvedBudget.set(key, left - 1); continue; }
        unexplained.push(`${finding.file}:${finding.line}  UNRESOLVED, not in UNRESOLVED_CALLS  ${finding.code}`);
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(ALLOWED_NAMES, finding.resolvedName)) {
        seenNames.add(finding.resolvedName);
        continue;
      }
      unexplained.push(`${finding.file}:${finding.line}  name '${finding.resolvedName}' not in ALLOWED_NAMES  ${finding.code}`);
    }

    expect(
      unexplained,
      'A .local/xezar/ top-level entry is being constructed outside the documented shape. Add the ' +
        'name to ALLOWED_NAMES with a reason if it genuinely belongs (and update AGENTS.md / ' +
        'BACKWARD_COMPATIBILITY.md §3), or fix the call site if it does not.',
    ).toEqual([]);
  });

  it('has no stale SHADOWED_CALLS or UNRESOLVED_CALLS entry', () => {
    const shadowBudget = budgetOf(SHADOWED_CALLS);
    const unresolvedBudget = budgetOf(UNRESOLVED_CALLS);
    for (const finding of scan()) {
      const key = `${finding.file} ${finding.code}`;
      if (finding.resolvedName === null) {
        const left = unresolvedBudget.get(key);
        if (left) unresolvedBudget.set(key, left - 1);
      } else {
        const left = shadowBudget.get(key);
        if (left) shadowBudget.set(key, left - 1);
      }
    }
    const stale = [
      ...[...shadowBudget].filter(([, left]) => left > 0).map(([key, left]) => `SHADOWED_CALLS: ${key}  (${left} unused)`),
      ...[...unresolvedBudget].filter(([, left]) => left > 0).map(([key, left]) => `UNRESOLVED_CALLS: ${key}  (${left} unused)`),
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
      'A name in ALLOWED_NAMES is never produced by a resolvable join(dataDir, …) call — ' +
        'delete it, or mark it reachedOnlyThroughUnresolvedCall if UNRESOLVED_CALLS is the only ' +
        'reason it is here.',
    ).toEqual([]);
  });

  it('splits nested-paren call arguments correctly (control)', () => {
    const source = "join(projectDataDir(repoRoot), 'ui-state.json')";
    const { args } = splitCallArgs(source, 'join('.length);
    expect(args).toEqual(["projectDataDir(repoRoot)", "'ui-state.json'"]);
  });

  it('resolves a same-file constant and a leading-identifier template (control)', () => {
    const constants = collectConstants("export const AUDIT_TRAIL_FILE = 'audit.ndjson';\n");
    expect(resolveName('AUDIT_TRAIL_FILE', constants)).toBe('audit.ndjson');
    expect(resolveName('`${AUDIT_TRAIL_FILE}.lock`', constants)).toBe('audit.ndjson');
    expect(resolveName('`${AUDIT_TRAIL_FILE}.${generation}`', constants)).toBe('audit.ndjson');
    expect(resolveName('filename', constants)).toBeNull();
  });

  it('reads code and not prose — a comment mentioning join(dataDir, …) is not a finding (control)', () => {
    const source = [
      '/**',
      " *  character class, and `join(dataDir, 'tmp', '..')` resolves to `<dataDir>`",
      ' */',
      "const real = join(dataDir, 'runs');",
    ].join('\n');
    const findings = findingsIn('probe.ts', source);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.resolvedName).toBe('runs');
  });
});
