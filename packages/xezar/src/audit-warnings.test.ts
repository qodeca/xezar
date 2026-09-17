import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationAudit } from './automations/audit.ts';
import type { AutomationDefinition } from './automations/types.ts';
import { cliAudit } from './cli-audit.ts';
import { AUDIT_TRAIL_FILE, AuditTrail, resetAuditWarningsForTests } from './mcp/audit-trail.ts';
import { projectDataDir } from './project-data-paths.ts';
import { createUiAuditDoor } from './server/audit-ui.ts';

/**
 * #573 m3 — ONE AUDIT WARNING PER PROJECT PER PROCESS, and a bounded code in it.
 *
 * Spec A7 asks for "at most one audit warning for that project in that process"; before this the
 * latch was per `AuditTrail`, so a `serve` process with the cockpit door and the automation runner on
 * one project could print the line twice (PR #575 review, m3). The latch is now the project's, shared
 * by every door and every trail of it.
 *
 * The same finding named two more places: `cli-audit.ts` put the invocation PATH into its "not a
 * project folder" line, and it built its code from `err.code ?? err.name` without the bounded-code
 * filter, so an error object's own words could reach stderr.
 *
 * Named breaks: `B-WARN-PER-PROJECT` — give `AuditTrail` its own `warned` field again and warn from
 * it; `B-WARN-BOUNDED-CODE` — put `(err as Error).name` back into the command door's warning.
 */

const dirs: string[] = [];
const savedHome = process.env.XEZ_HOME;

beforeEach(() => {
  process.env.XEZ_HOME = temp('xwh-');
  resetAuditWarningsForTests();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = savedHome;
  vi.restoreAllMocks();
  vi.resetModules();
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
}

describe('B-WARN-PER-PROJECT: every door of one project shares its one warning', () => {
  it('four doors, one unwritable trail, one line', async () => {
    const root = temp('xwp-');
    const dataDir = projectDataDir(root);
    mkdirSync(dataDir, { recursive: true });
    // A directory where the file belongs: every append fails, whichever door tries it.
    mkdirSync(join(dataDir, AUDIT_TRAIL_FILE));
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const scope = { projectId: 'warn-project', dataDir };

    const ui = createUiAuditDoor({
      hosted: () => false,
      requestScope: async () => scope,
      bootScope: async () => scope,
      projectScope: async () => undefined,
      warn,
    });
    const app = new Hono().post('/x', ui.route('run.markAllRead'), (c) => c.json({ read: 1 }));
    await app.request('/x', { method: 'POST' }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    await new AuditTrail(scope, { warn }).channel('mcp').record({ action: 'run.pin' }, { outcome: 'applied' });
    await automationAudit(scope, warn).launched({ id: 'nightly', revision: 1 } as AutomationDefinition, 'issue.opened', 'receipt-1', 'run-1');
    await cliAudit('projects.list', root, { warn }).applied({ resource: { kind: 'project', id: 'warn-project' } });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^xezar: audit trail write failed \([A-Za-z_]+\); the action continued without an audit record\.$/);
    // Populated input, not an empty run: another project in the same process still warns once.
    const otherDir = projectDataDir(temp('xwo-'));
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(join(otherDir, AUDIT_TRAIL_FILE));
    await new AuditTrail({ projectId: 'other-project', dataDir: otherDir }, { warn }).channel('mcp').record({ action: 'run.pin' }, { outcome: 'applied' });
    expect(warnings).toHaveLength(2);
  });
});

describe('B-WARN-BOUNDED-CODE: the command door says a code, never a path or an error’s own words', () => {
  it('a folder that is not a project names no path', async () => {
    const host = temp('xwn-');
    const nested = join(host, '.local', 'xezar', 'worktrees', 'fake-run-id');
    const warnings: string[] = [];
    await cliAudit('init', nested, { warn: (message) => warnings.push(message) }).applied();
    expect(warnings).toEqual(['xezar: audit trail write failed (not_a_project_folder); the action continued without an audit record.']);
    expect(warnings[0]).not.toContain(host);
  });

  it('an error that carries a path in its own words reaches the line only as a bounded code', async () => {
    vi.resetModules();
    vi.doMock('./project-data-paths.ts', async (importOriginal) => {
      const real = await importOriginal<typeof import('./project-data-paths.ts')>();
      return {
        ...real,
        ensureProjectDataIgnored: () => {
          const error = new Error('EACCES: permission denied, mkdir /Users/planted/private/project/.local');
          error.name = '/Users/planted/private/project';
          throw error;
        },
      };
    });
    const { cliAudit: freshCliAudit } = await import('./cli-audit.ts');
    const root = temp('xwb-');
    const warnings: string[] = [];
    await freshCliAudit('init', root, { warn: (message) => warnings.push(message) }).applied();
    expect(warnings).toEqual(['xezar: audit trail write failed (error); the action continued without an audit record.']);
    expect(warnings[0]).not.toContain('/Users/planted');
  });
});
