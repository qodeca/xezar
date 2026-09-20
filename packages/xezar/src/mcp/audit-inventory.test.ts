// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditActionRecordSchema } from '@qodeca/xezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { auditRouteDescriptor } from '../server/audit-ui.ts';
import { createApp } from '../server/server.ts';
import {
  AUDIT_ACTIONS,
  AUDIT_HTTP_READS,
  AUDIT_MCP_READS,
  auditAction,
  classifyMcpCall,
  mcpActionKey,
} from './audit-inventory.ts';
import { TOOL_ACTION_COVERAGE } from './tools/api-coverage.testkit.ts';

/**
 * #306 part 2 — THE PARITY TEST (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md`
 * § 6.5). The shared inventory is the authority for what `ui` and `mcp` record, so it must cover
 * the real surfaces exactly:
 *
 *   1. every `TOOL_ACTION_COVERAGE` entry has exactly one inventory class;
 *   2. every non-GET route in the BUILT app's route table has a mutation descriptor or a read reason;
 *   3. every mutation row maps to MCP, and to an HTTP route or an explicit `ui: 'none'`;
 *   4. an empty inventory, route table or coverage map fails — it never reads as "nothing to audit".
 *
 * Named break `B-INVENTORY-OMIT`: delete one row (e.g. `automation.create`) — rules 1 and 2 fail.
 * Named break `B-UI-FAMILY`: remove one family's `ui.route(…)` decorators — rule 2 fails.
 */

const V1 = '/api/v1';
const SCOPED = '/api/v1/p/:projectId';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const root = mkdtempSync(join(tmpdir(), 'xez-audit-inventory-'));
const store = RunStore.open(join(root, '.local/xezar'));
const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: '0.0.0-test' });
afterAll(() => {
  store.flush();
  rmSync(root, { recursive: true, force: true });
});

interface RouteRow {
  method: string;
  path: string;
  ids: string[];
  descriptors: number;
}

/** Every non-GET route under `/api/v1`, keyed by method + template, with the audit ids its handlers carry. */
function mutatingRoutes(prefix: string): Map<string, RouteRow> {
  const rows = new Map<string, RouteRow>();
  for (const route of app.routes) {
    if (!MUTATING.has(route.method)) continue;
    if (!route.path.startsWith(`${prefix}/`)) continue;
    if (prefix === V1 && route.path.startsWith(`${V1}/p/`)) continue;
    const path = route.path.slice(prefix.length);
    const key = `${route.method} ${path}`;
    const row = rows.get(key) ?? { method: route.method, path, ids: [], descriptors: 0 };
    const descriptor = auditRouteDescriptor(route.handler);
    if (descriptor) {
      row.descriptors += 1;
      row.ids.push(...descriptor.ids);
    }
    rows.set(key, row);
  }
  return rows;
}

describe('the shared audit action inventory (#306 part 2, spec § 6)', () => {
  const routes = mutatingRoutes(V1);
  const coverageKeys = Object.keys(TOOL_ACTION_COVERAGE);

  it('rule 4 — the three inputs are populated, so no assertion below can pass vacuously', () => {
    expect(AUDIT_ACTIONS.length).toBeGreaterThanOrEqual(60);
    expect(coverageKeys.length).toBeGreaterThan(100);
    // Sixty mutations plus three read-like POSTs, as the spec counted them.
    expect(routes.size).toBe(63);
  });

  it('every action id is unique and a valid v2 action', () => {
    const ids = AUDIT_ACTIONS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(auditActionRecordSchema.shape.action.safeParse(id).success, id).toBe(true);
    expect(auditAction('run.cancel')?.family).toBe('F1');
    expect(auditAction('no.such')).toBeUndefined();
  });

  it('rule 1 — every MCP tool action has exactly one class, and every key the inventory names exists', () => {
    const toolOf = (key: string) => key.split(':')[0]!;
    const inRows = (key: string) => AUDIT_ACTIONS.some((row) => row.mcp.includes(key));
    const inReads = (key: string) => AUDIT_MCP_READS.includes(key) || AUDIT_MCP_READS.includes(`${toolOf(key)}:*`);
    const unclassified = coverageKeys.filter((key) => !inRows(key) && !inReads(key));
    const both = coverageKeys.filter((key) => inRows(key) && inReads(key));
    expect(unclassified, 'an MCP action with no inventory row and no read entry').toEqual([]);
    expect(both, 'an MCP action classified as both a mutation and a read').toEqual([]);
    const named = [...AUDIT_ACTIONS.flatMap((row) => row.mcp), ...AUDIT_MCP_READS.filter((key) => !key.endsWith(':*'))];
    expect(named.filter((key) => !(key in TOOL_ACTION_COVERAGE)), 'inventory names an MCP action that does not exist').toEqual([]);
  });

  it('rule 2 — every non-GET route has a mutation descriptor or a read reason, never both', () => {
    const reads = new Set(AUDIT_HTTP_READS.map((route) => `${route.method} ${route.path}`));
    const missing = [...routes.values()].filter((row) => row.descriptors === 0 && !reads.has(`${row.method} ${row.path}`));
    const doubled = [...routes.values()].filter((row) => row.descriptors > 1);
    const readWithDescriptor = [...routes.values()].filter((row) => row.descriptors > 0 && reads.has(`${row.method} ${row.path}`));
    expect(missing.map((row) => `${row.method} ${row.path}`), 'a mutating route with no audit descriptor').toEqual([]);
    expect(doubled.map((row) => `${row.method} ${row.path}`)).toEqual([]);
    expect(readWithDescriptor.map((row) => `${row.method} ${row.path}`)).toEqual([]);
    for (const read of AUDIT_HTTP_READS) expect(routes.has(`${read.method} ${read.path}`), read.path).toBe(true);
  });

  it('rule 3 — each row maps to MCP and to the route that really carries its id (or says ui: none)', () => {
    for (const row of AUDIT_ACTIONS) {
      expect(row.mcp.length, row.id).toBeGreaterThan(0);
      if (row.ui === 'none') {
        expect([...routes.values()].some((route) => route.ids.includes(row.id)), row.id).toBe(false);
        continue;
      }
      expect(row.ui.length, row.id).toBeGreaterThan(0);
      for (const route of row.ui) {
        expect(routes.get(`${route.method} ${route.path}`)?.ids ?? [], `${row.id} → ${route.method} ${route.path}`).toContain(row.id);
      }
    }
    // And the other direction: a descriptor never names an id whose row does not list that route.
    for (const route of routes.values()) {
      for (const id of route.ids) {
        const row = auditAction(id);
        expect(row && row.ui !== 'none' && row.ui.some((r) => r.method === route.method && r.path === route.path), `${route.method} ${route.path} → ${id}`).toBe(true);
      }
    }
  });

  it('the project-scoped mount carries the same descriptors as the unscoped one', () => {
    const scoped = mutatingRoutes(SCOPED);
    const projectScoped = [...routes.values()].filter((row) => scoped.has(`${row.method} ${row.path}`));
    expect(projectScoped.length).toBeGreaterThan(40);
    for (const row of projectScoped) expect(scoped.get(`${row.method} ${row.path}`)?.ids).toEqual(row.ids);
  });
});

describe('classifyMcpCall — the MCP door reads the inventory, not the tool annotation', () => {
  it('a read action inside a mutating tool is a read (B-MCP-MIXED-READ)', () => {
    expect(classifyMcpCall('organise_work', { action: 'list_queue' }).kind).toBe('read');
    expect(classifyMcpCall('leader_events', { action: 'read' }).kind).toBe('read');
    expect(classifyMcpCall('task_create', { action: 'plan' }).kind).toBe('read');
    expect(classifyMcpCall('task_read', { view: 'task' }).kind).toBe('read');
    expect(classifyMcpCall('health', {}).kind).toBe('read');
  });

  it('a mutation resolves to the id the cockpit route records', () => {
    const mutation = classifyMcpCall('organise_work', { action: 'archive' });
    expect(mutation.kind === 'mutation' && mutation.resolve(undefined)).toBe('run.archive');
    const refused = classifyMcpCall('project_config', { action: 'set_workspace_config' });
    expect(refused.kind === 'mutation' && refused.resolve(undefined)).toBe('workspace.config.set');
  });

  it('check_automation is a mutation only in execute mode', () => {
    expect(classifyMcpCall('project_config', { action: 'check_automation', mode: 'preview' }).kind).toBe('read');
    const execute = classifyMcpCall('project_config', { action: 'check_automation', mode: 'execute' });
    expect(execute.kind === 'mutation' && execute.resolve(undefined)).toBe('automation.checkExecute');
  });

  it('send_message and answer_question take the route their delivery says they reached', () => {
    for (const action of ['send_message', 'answer_question']) {
      const call = classifyMcpCall('execution_control', { action });
      expect(call.kind).toBe('mutation');
      if (call.kind !== 'mutation') continue;
      expect(call.resolve({ structuredContent: { delivery: 'live' } })).toBe('run.message');
      expect(call.resolve({ structuredContent: { delivery: 'amended' } })).toBe('run.message');
      expect(call.resolve({ structuredContent: { delivery: 'continued' } })).toBe('run.continue');
      expect(call.resolve({ structuredContent: { delivery: 'resumed' } })).toBe('run.continue');
      expect(call.resolve(undefined)).toBe('run.message');
    }
  });

  it('an action in neither list is unclassified and the door records nothing for it', () => {
    expect(classifyMcpCall('no_such_tool', { action: 'x' }).kind).toBe('unclassified');
    expect(mcpActionKey('health', undefined)).toBe('health');
  });
});
