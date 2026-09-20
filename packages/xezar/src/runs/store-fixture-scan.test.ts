import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of the store-teardown fix (#631, #671 rows F-26 and F-29; review of PR
 * #765, Minor 2).
 *
 * `RunStore` itself now survives a fixture that removes the directory it writes into, so this
 * scan is not what keeps the suite green — `store-teardown.test.ts` is. What it keeps out is the
 * NEXT fixture written in the shape that produced the flake: open a store over a `mkdtemp`
 * directory, remove that directory in teardown, and never tell the store to stop writing first.
 * That shape leaves a 300 ms debounced save armed against a directory that is going away, which
 * is a race whose outcome depends on machine load, and "the store handles it" is a weaker answer
 * than "the fixture closed first".
 *
 * It is a text scan on purpose, for the same reason `state-path-scan.test.ts` is one: a runtime
 * assertion can only observe the fixtures a test happens to drive, and the fixture that matters
 * is the one nobody has written yet.
 *
 * ## The grandfather list, and why it is not an allowlist
 *
 * 69 existing files already carry this shape and are NOT routed through the helper. Routing them
 * is a mechanical change across most of the server and workflow suites, not part of a review
 * round, and it is genuinely optional: every one of them is covered by the store's own vanished-
 * directory branch, which is the fix. They are listed below so the rule can hold for everything
 * ELSE from today. One collective reason applies to the whole list — they pre-date
 * `closeStoreAndRemove` — and an entry that stops matching must be deleted, so the list can only
 * shrink.
 */

const XEZAR = fileURLToPath(new URL('../..', import.meta.url));

/** A store opened over a directory the file names: `RunStore.open(dir)`, `new RunStore(join(dir, …))`. */
const STORE_OPEN = /\b(?:RunStore\.open|new RunStore)\s*\(\s*(?:join\s*\(\s*)?([A-Za-z_$][\w$]*)/g;

/** That same directory being removed: `rmSync(dir, …)`, `rmSync(join(dir, …))`, `rmdirSync(dir)`. */
const DIR_REMOVAL = /\brm(?:Sync|dirSync)\s*\(\s*(?:join\s*\(\s*)?([A-Za-z_$][\w$]*)/;

/**
 * The variable a `RunStore` open bound: the assignment target of `RunStore.open(dir)` or
 * `new RunStore(dir)`, so `const store = …`, `let store = …` and a bare `store = …` all count. A
 * call with no binding (`RunStore.open(dir).getRun(…)`) binds nothing and contributes none.
 */
const STORE_BINDING = /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:RunStore\.open|new RunStore)\s*\(/g;

/** A regex-safe copy of a source identifier (identifiers are `\w`, but `$` is not). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The file tells THAT store to stop writing — `store.close()`, or `closeStoreAndRemove(store, …)`
 * on the same variable the open bound. `flush()` deliberately does NOT: it writes the index out
 * and leaves the store armed for the next `touch()`, which is exactly the gap `close()` exists to
 * fill.
 *
 * A `.close()` on ANYTHING ELSE — an http server, a watcher, a service handle — is not the store
 * letting go. The original rule cleared a file on any `.close()` at all, which is how seven
 * fixtures with a genuinely unclosed store stayed invisible to this scan (#765 re-check, Minor 2),
 * so the exemption is scoped to the store's own variable rather than to the file.
 */
function letsGo(source: string, storeVars: readonly string[]): boolean {
  return storeVars.some((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\.close\\s*\\(`).test(source)
    || new RegExp(`closeStoreAndRemove\\s*\\(\\s*${escapeRegExp(name)}\\b`).test(source));
}

/** This file: every `RunStore.open(` and `rmSync(` below is a synthetic probe, not a fixture. */
const SELF = 'src/runs/store-fixture-scan.test.ts';

export type Finding = { file: string; line: number; code: string };

/**
 * Run the rule over one file's source text.
 *
 * Exported so the probes below feed synthetic sources through the REAL rule rather than
 * re-testing a regex the scan might stop applying.
 */
export function findingsIn(file: string, source: string): Finding[] {
  if (file === SELF) return [];
  const dirs = new Set<string>();
  STORE_OPEN.lastIndex = 0;
  for (let m = STORE_OPEN.exec(source); m; m = STORE_OPEN.exec(source)) dirs.add(m[1]!);
  if (dirs.size === 0) return [];

  const storeVars = new Set<string>();
  STORE_BINDING.lastIndex = 0;
  for (let m = STORE_BINDING.exec(source); m; m = STORE_BINDING.exec(source)) storeVars.add(m[1]!);
  if (letsGo(source, [...storeVars])) return [];

  const findings: Finding[] = [];
  source.split('\n').forEach((raw, index) => {
    const code = raw.trim();
    if (code.startsWith('//') || code.startsWith('*')) return;
    const removal = code.match(DIR_REMOVAL);
    if (removal && dirs.has(removal[1]!)) findings.push({ file, line: index + 1, code });
  });
  return findings;
}

const GRANDFATHERED = [
  'src/mcp/audit-inventory.test.ts',
  'src/mcp/stall-monitor.test.ts',
  'src/mcp/tools/stale-write-tools.test.ts',
  'src/onboarding/watch.test.ts',
  'src/runs/decision-projection.test.ts',
  'src/runs/store.test.ts',
  'src/runs/task-verdicts.test.ts',
  'src/server/agent-config-api.test.ts',
  'src/server/attachments-api.test.ts',
  'src/server/auto-resume-api.test.ts',
  'src/server/automations-api.test.ts',
  'src/server/config-api.test.ts',
  'src/server/git-changes.test.ts',
  'src/server/github-checks-api.test.ts',
  'src/server/github-comments-api.test.ts',
  'src/server/github-merge-api.test.ts',
  'src/server/github-pr-changes-api.test.ts',
  'src/server/github-ref-status-api.test.ts',
  'src/server/github-search-api.test.ts',
  'src/server/group-pick.test.ts',
  'src/server/health-forge.test.ts',
  'src/server/health-topic.test.ts',
  'src/server/http-diagnostics-api.test.ts',
  'src/server/local-handoff-routes.test.ts',
  'src/server/models-api.test.ts',
  'src/server/onboarding-api.test.ts',
  'src/server/open-in-file.test.ts',
  'src/server/open-in-project.test.ts',
  'src/server/origin-guard.test.ts',
  'src/server/patch-run.test.ts',
  'src/server/plan-api.test.ts',
  'src/server/project-kit-api.test.ts',
  'src/server/provider-action-gating.test.ts',
  'src/server/provider-auth-runtime.test.ts',
  'src/server/providers-api.test.ts',
  'src/server/queued-messages.test.ts',
  'src/server/read-run.test.ts',
  'src/server/ref-status-invalidation.test.ts',
  'src/server/request-validation.test.ts',
  'src/server/single-project-doors.test.ts',
  'src/server/skills-api.test.ts',
  'src/server/skills-update-api.test.ts',
  'src/server/sse-headers.test.ts',
  'src/server/stale-write-routes.test.ts',
  'src/server/start-run.test.ts',
  'src/server/typed-client.test.ts',
  'src/server/ui-state-api.test.ts',
  'src/server/versioned-surface.test.ts',
  'src/server/worktrees-api.test.ts',
  'src/workflows/auto-resume.test.ts',
  'src/workflows/autosave-gate.test.ts',
  'src/workflows/continuation-tools.test.ts',
  'src/workflows/memory-limit-pause.test.ts',
  'src/workflows/model-identity-wiring.test.ts',
  'src/workflows/recover-autonomous.test.ts',
  'src/workflows/recover-followups.test.ts',
  'src/workflows/recover-session-failure.test.ts',
  'src/workflows/retention-wiring.test.ts',
  'src/workflows/review-accept-race.test.ts',
  'src/workflows/run-autonomous-nudge.test.ts',
  'src/workflows/run-continue-check-failure.test.ts',
  'src/workflows/run-continue-nudge-cap.test.ts',
  'src/workflows/run-quota-timer-default.test.ts',
  'src/workflows/run-repair-regression.test.ts',
  'src/workflows/run-unfinished-step.test.ts',
  'src/workflows/run.test.ts',
  'src/workflows/step-timeout-wiring.test.ts',
  'src/workflows/system-prompt.test.ts',
  'src/workflows/workspace-semaphore.test.ts',
];

/**
 * Pre-existing fixtures the ORIGINAL rule hid behind an unrelated `.close()`.
 *
 * `LETS_GO` used to clear a file on ANY `.close()` — an http server, a watcher, a service handle —
 * so a fixture whose store was never closed still read as clean because it closed something else
 * (#765 re-check, Minor 2). Scoping the exemption to the store variable surfaced these seven. They
 * carry exactly the shape the 69 above carry — a store opened over a directory the fixture removes,
 * never closed — and the same store-side vanished-directory branch covers them. They are listed
 * rather than routed for the same reason the 69 are: routing is a mechanical change across whole
 * suites, and it is optional. Like the list above, this one only shrinks: an entry that stops
 * matching must be deleted.
 */
const SURFACED_BY_SCOPING = [
  'src/mcp/acceptance-durability.test.ts',
  'src/mcp/event-catalog.test.ts',
  'src/mcp/leader-delivery-regressions.test.ts',
  'src/mcp/leader-delivery.testkit.ts',
  'src/mcp/tools/task-reads.test.ts',
  'src/server/mcp-leader-topic.test.ts',
  'test/unit/mcp-durability.test.ts',
];

/** Every known fixture of the shape: the original 69 plus the seven the scoped exemption surfaced. */
const KNOWN = [...GRANDFATHERED, ...SURFACED_BY_SCOPING];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'web') continue;
      sourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function scan(): { scanned: number; findings: Finding[] } {
  const files = sourceFiles(XEZAR);
  const findings: Finding[] = [];
  for (const path of files) {
    const file = relative(XEZAR, path).split(sep).join('/');
    findings.push(...findingsIn(file, readFileSync(path, 'utf8')));
  }
  return { scanned: files.length, findings };
}

describe('no NEW fixture removes a run store’s directory without letting the store go', () => {
  it('finds nothing the grandfather list does not already carry', () => {
    const known = new Set(KNOWN);
    const fresh = scan().findings.filter((f) => !known.has(f.file));
    expect(
      fresh.map((f) => `packages/xezar/${f.file}:${f.line}  ${f.code}`),
      'This fixture opens a RunStore over a directory it then removes, without closing the store ' +
        'first. Use closeStoreAndRemove(store, dir) from runs/store.testkit.ts — it closes, then ' +
        'removes. Do not add an entry to GRANDFATHERED or SURFACED_BY_SCOPING: those lists hold ' +
        'pre-existing fixtures and only shrink.',
    ).toEqual([]);
  });

  it('really read the suite — an empty scan is not a pass', () => {
    // The fail-open shape this pins: against an empty file list, "nothing matched" and "we never
    // loaded anything" are the same branch. They must not read the same, so the scan has to say
    // how much it read, and the grandfather list has to be reachable from what it read.
    const { scanned, findings } = scan();
    expect(scanned).toBeGreaterThan(400);
    expect(new Set(findings.map((f) => f.file)).size).toBeGreaterThan(0);
    expect(findingsIn('probe.ts', '')).toEqual([]);
  });

  it('has no stale grandfather entry', () => {
    const matched = new Set(scan().findings.map((f) => f.file));
    expect(
      KNOWN.filter((file) => !matched.has(file)),
      'A grandfathered fixture no longer matches — it was routed or deleted. Remove its entry.',
    ).toEqual([]);
  });

  it('the shared helper clears a file', () => {
    const source = [
      "const store = RunStore.open(dataDir);",
      'closeStoreAndRemove(store, dataDir);',
    ].join('\n');
    expect(findingsIn('probe.test.ts', source)).toEqual([]);
  });

  it('a direct close() of the store clears a file, and flush() does not', () => {
    const closed = ['const store = RunStore.open(dataDir);', 'store.close();', 'rmSync(dataDir, { recursive: true });'].join('\n');
    expect(findingsIn('probe.test.ts', closed)).toEqual([]);

    // The variable the open bound, not the literal name `store`: this is the same fact.
    const named = ['const opened = RunStore.open(dataDir);', 'opened.close();', 'rmSync(dataDir, { recursive: true });'].join('\n');
    expect(findingsIn('probe.test.ts', named)).toEqual([]);

    const flushed = ['const store = RunStore.open(dataDir);', 'store.flush();', 'rmSync(dataDir, { recursive: true });'].join('\n');
    expect(findingsIn('probe.test.ts', flushed).map((f) => f.line)).toEqual([3]);
  });

  // BREAK-671-SCAN-ANY-CLOSE. Before the exemption was scoped, this probe was GREEN: `srv.close()`
  // matched the old `LETS_GO` and the scan stopped looking, so a fixture that never closed its
  // store read as clean. An unrelated handle closing is not the store letting go.
  it('an unrelated close() does not clear a file — only the store’s own close does', () => {
    const unrelated = ['const store = RunStore.open(dataDir);', 'srv.close();', 'rmSync(dataDir, { recursive: true });'].join('\n');
    expect(findingsIn('probe.test.ts', unrelated).map((f) => f.line)).toEqual([3]);

    // The helper on a DIFFERENT variable is not this store letting go either.
    const otherStore = ['const store = RunStore.open(dataDir);', 'closeStoreAndRemove(other, dataDir);', 'rmSync(dataDir, { recursive: true });'].join('\n');
    expect(findingsIn('probe.test.ts', otherStore).map((f) => f.line)).toEqual([3]);
  });

  it('flags the shape the flake came from, and only that shape', () => {
    const racing = ['const store = RunStore.open(join(base, ".local"));', 'rmSync(base, { recursive: true, force: true });'].join('\n');
    expect(findingsIn('probe.test.ts', racing).map((f) => f.line)).toEqual([2]);

    // A store with no removal, and a removal of a directory no store was opened over, are both fine.
    expect(findingsIn('probe.test.ts', 'const store = RunStore.open(dataDir);\n')).toEqual([]);
    expect(findingsIn('probe.test.ts', 'rmSync(someOtherDir, { recursive: true });\n')).toEqual([]);
  });
});
