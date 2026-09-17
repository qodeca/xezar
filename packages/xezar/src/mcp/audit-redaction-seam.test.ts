import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationAudit } from '../automations/audit.ts';
import type { AutomationDefinition } from '../automations/types.ts';
import { cliAudit } from '../cli-audit.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { createUiAuditDoor } from '../server/audit-ui.ts';
import { registerProject } from '../workspace/projects.ts';
import { AUDIT_TRAIL_FILE, AuditTrail, resetAuditWarningsForTests } from './audit-trail.ts';
import { REPO_ROOT, SCAN_ROOTS, sourceFiles, withoutComments } from './audit-source-scan.testkit.ts';

/**
 * #306 part 4 — THE SEAM GUARD (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md`
 * § 9 and § 11, "Seam guard"): a writer cannot reach `audit.ndjson` around `redactAuditInput`.
 *
 * Two nets, and neither is a spelling of the other:
 *
 *   RUNTIME — every record a door writes came back from the seam. The seam module is wrapped in a
 *   spy, each door adapter is driven once, and the line on disk is compared with what the seam
 *   returned for it. `B-SEAM-BYPASS`: build the candidate inside `AuditTrail.write` instead of
 *   calling `redactAuditInput` — the spy sees no call and every case fails.
 *
 *   SOURCE, BY TYPE — the writers are found by the audit TYPES they name (`AuditTrail`,
 *   `AuditChannel`), never by a field name, because a door that skipped the seam would not spell any
 *   particular field. No file but `audit-trail.ts` may name the trail's files or a filesystem write
 *   at all, and `appendAuditRecord` is module-private with exactly one call site. The set of files
 *   that name the types is pinned separately, by `audit-origin-wiring.test.ts` net 1.
 *
 * The `mcp` door writes through the same `AuditChannel.record`; its own end-to-end proof, through the
 * real bridge and tools, is the six `mcp` cases of `audit-redaction.test.ts`, each of which can only
 * pass if the seam ran.
 */

const dirs: string[] = [];
const savedHome = process.env.XEZ_HOME;

beforeEach(() => {
  process.env.XEZ_HOME = temp('xsh-');
  resetAuditWarningsForTests();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = savedHome;
  vi.restoreAllMocks();
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
}

const lines = (dataDir: string): Record<string, unknown>[] => {
  const path = join(dataDir, AUDIT_TRAIL_FILE);
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
};

// The real seam, wrapped: every call and every returned input is recorded.
const seamCalls: { origin: string; input: Record<string, unknown> }[] = [];
vi.mock(import('./audit-redaction.ts'), async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    redactAuditInput: (...args: Parameters<typeof real.redactAuditInput>) => {
      const answer = real.redactAuditInput(...args);
      if (answer.ok) seamCalls.push({ origin: args[0], input: answer.input as unknown as Record<string, unknown> });
      return answer;
    },
  };
});

/** What the seam returned for the door's one record, plus the line that reached the file. */
const proveOneRecord = (dataDir: string, origin: string): void => {
  const written = lines(dataDir);
  expect(written, `${origin}: exactly one record`).toHaveLength(1);
  const fromSeam = seamCalls.filter((call) => call.origin === origin);
  expect(fromSeam, `${origin}: the record came from the seam`).toHaveLength(1);
  const { v: _v, seq: _seq, ts: _ts, ...persisted } = written[0]!;
  expect(persisted, `${origin}: the persisted record is the seam's own input`).toEqual(fromSeam[0]!.input);
};

describe('B-SEAM-BYPASS: every door writes what the seam returned', () => {
  beforeEach(() => {
    seamCalls.length = 0;
  });

  it('ui — the route decorator', async () => {
    const dataDir = join(temp('xsu-'), '.local', 'xezar');
    mkdirSync(dataDir, { recursive: true });
    const scope = { projectId: 'seam-ui', dataDir };
    const door = createUiAuditDoor({
      hosted: () => false,
      requestScope: async () => scope,
      bootScope: async () => scope,
      projectScope: async () => undefined,
      warn: () => {},
    });
    const app = new Hono().post('/x', door.route('run.markAllRead'), (c) => c.json({ read: 1 }));
    await app.request('/x', { method: 'POST' }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    proveOneRecord(dataDir, 'ui');
  });

  it('mcp — the channel the MCP door holds', async () => {
    const dataDir = join(temp('xsm-'), '.local', 'xezar');
    mkdirSync(dataDir, { recursive: true });
    await new AuditTrail({ projectId: 'seam-mcp', dataDir }, { warn: () => {} })
      .channel('mcp')
      .record({ action: 'run.pin', payload: { pinned: true }, operationId: 'op-seam-0001' }, { outcome: 'applied' });
    proveOneRecord(dataDir, 'mcp');
  });

  it('automation — the runner’s recorder', async () => {
    const dataDir = join(temp('xsa-'), '.local', 'xezar');
    mkdirSync(dataDir, { recursive: true });
    await automationAudit({ projectId: 'seam-automation', dataDir }, () => {}).launched(
      { id: 'nightly', revision: 1 } as AutomationDefinition,
      'issue.opened',
      'receipt-1',
      'run-1',
    );
    proveOneRecord(dataDir, 'automation');
  });

  it('cli — the command recorder', async () => {
    const root = temp('xsc-');
    const { id } = await registerProject(root);
    await cliAudit('projects.list', root, { warn: () => {} }).applied({ resource: { kind: 'project', id } });
    proveOneRecord(projectDataDir(root), 'cli');
  });
});

describe('the source, found by the audit types rather than by a field name', () => {
  const production = SCAN_ROOTS.flatMap((root) => sourceFiles(root)).map((file) => ({
    path: relative(REPO_ROOT, file).split('\\').join('/'),
    code: withoutComments(readFileSync(file, 'utf8')),
  }));
  const named = production.filter((file) => /\b(AuditTrail|AuditChannel)\b/.test(file.code));
  const trail = production.find((file) => file.path === 'packages/xezar/src/mcp/audit-trail.ts')!;

  it('scanned a populated tree — the control that proves an empty scan cannot pass', () => {
    expect(production.length).toBeGreaterThan(300);
    expect(named.map((file) => file.path)).toContain('packages/xezar/src/mcp/audit-trail.ts');
    expect(named.length).toBeGreaterThanOrEqual(5);
  });

  it('no writer but the trail itself names the audit files or a filesystem write', () => {
    const offenders = named
      .filter((file) => file.path !== 'packages/xezar/src/mcp/audit-trail.ts')
      .filter((file) => /\b(appendFile|appendFileSync|writeFile|writeFileSync|writeSync|createWriteStream|openSync)\s*\(/.test(file.code) || /audit\.ndjson/.test(file.code));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('`appendAuditRecord` is module-private, has one call site, and that call takes the seam’s input', () => {
    expect(trail.code).not.toMatch(/export\s+(async\s+)?function\s+appendAuditRecord/);
    // Its declaration, and exactly one call.
    expect(trail.code.match(/function appendAuditRecord\(/g)).toHaveLength(1);
    expect(trail.code.match(/(?<!function )appendAuditRecord\(/g)).toHaveLength(1);
    expect(trail.code).toMatch(/const candidate = redaction\.input;/);
    expect(trail.code).toMatch(/appendAuditRecord\(this\.scope\.dataDir, candidate,/);
    // And the seam is what produced `redaction`.
    expect(trail.code).toMatch(/const redaction = redactAuditInput\(/);
  });

  it('only the trail calls the seam, and only the seam module defines it', () => {
    const callers = production.filter((file) => /\bredactAuditInput\b/.test(file.code)).map((file) => file.path);
    expect(callers.sort()).toEqual(['packages/xezar/src/mcp/audit-redaction.ts', 'packages/xezar/src/mcp/audit-trail.ts']);
  });
});
