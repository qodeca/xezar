import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { auditActionRecordSchema, type AuditActionRecord } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationLaunchRefusal, automationAudit } from '../automations/audit.ts';
import { ProjectAutomationScheduler } from '../automations/scheduler.ts';
import { AutomationStore } from '../automations/store.ts';
import type { GithubPoller } from '../automations/github-poller.ts';
import { cliAudit } from '../cli-audit.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { auditAction, type AuditFamily } from './audit-inventory.ts';
import { AUDIT_TRAIL_FILE } from './audit-trail.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { tools } from './tools/index.ts';

/**
 * #306 part 2 — THE SAVED FOUR-DOOR HARNESS (spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 11, "Saved four-door harness").
 *
 * One real cockpit — `createApp` over a real store and run manager, the MCP service over its real
 * socket, the real stdio bridge (`XEZ_DRY_RUN=1` mocks only the agent CLI; opening an app is an
 * injected fake, so nothing leaves the machine) — and every door writing into the same project's
 * `audit.ndjson`:
 *
 *   - `ui` and `mcp`: one applied and one refused record for every family F1–F10 the door can
 *     produce, each case asserting that it added EXACTLY ONE record, with the inventory's action id,
 *     the door's origin and actor, and the expected outcome. F9 and F10 are refused-only for `mcp`
 *     (§ 6.2). The ids are then compared across the doors, family by family (`B-DOOR-NAME-SPLIT`).
 *   - `automation`: a launched run linked to its receipt, a pre-launch refusal, and a duplicate
 *     receipt that writes nothing.
 *   - `cli`: one applied and one refused command record (every § 5 subcommand is exercised against
 *     the packed tarball in `test/e2e/package-cli.test.ts`).
 *
 * Reads between the cases (task_read, leader_events read) are part of the proof: they would add a
 * record and break the "exactly one" assertion if a read were audited (`B-MCP-MIXED-READ`).
 * QA reuses this file: `npm test -- packages/xezar/src/mcp/audit-four-doors.test.ts`.
 */

const VERSION = '9.9.9-audit-doors';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN, automations: process.env.XEZ_AUTOMATIONS };

// Under /tmp, not the per-worker sandbox: the MCP socket path must stay under 104 bytes on macOS.
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};

beforeEach(() => {
  process.env.XEZ_HOME = tmp('xah-');
  process.env.XEZ_DRY_RUN = '1';
  process.env.XEZ_AUTOMATIONS = '1';
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['XEZ_HOME', saved.home],
    ['XEZ_DRY_RUN', saved.dryRun],
    ['XEZ_AUTOMATIONS', saved.automations],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function cockpit() {
  const root = tmp('xap-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
  const store = RunStore.open(projectDataDir(root), { keepLive: true });
  const manager = new RunManager(store, root, { semaphore });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id, root, status: 'ok' }], semaphore });
  const opened: string[] = [];
  const open = async (what: string) => {
    opened.push(what);
    return true;
  };
  const app = createApp({
    repoRoot: root,
    store,
    manager,
    version: VERSION,
    bootProjectId: id,
    contexts,
    semaphore,
    workspaceEvents: new WorkspaceEventBus(),
    providerAuth: connectedProviderAuth(),
    openTerminal: open,
    openFile: open,
    openApp: open,
  });
  closers.push(() => {
    manager.dispose();
    store.flush();
    contexts.disposeAll();
  });
  return { root, id, store, app, dataDir: store.dataDir, opened };
}

/** The real stdio bridge with a small JSON-RPC client in front of it. */
function agent(root: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (result: McpToolResult) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id: number; result: McpToolResult };
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const done = runBridge({ input, output, version: VERSION, tools, resolveTarget: () => resolveMcpTarget(root) });
  closers.push(() => {
    input.end();
    return done;
  });
  let next = 1;
  return {
    call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        input.write(encodeFrame({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
      });
    },
  };
}

const records = (dataDir: string): AuditActionRecord[] => {
  const path = join(dataDir, AUDIT_TRAIL_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => auditActionRecordSchema.parse(JSON.parse(line)));
};

let op = 0;
const operationId = (): string => `op-audit-doors-${String(++op).padStart(4, '0')}`;

/** A request that arrived over a real connection from this machine — what the cockpit's browser sends. */
const CONNECTION = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

interface Expected {
  family: AuditFamily;
  action: string;
  outcome: 'applied' | 'refused';
  reason?: string;
}

describe('the saved four-door audit harness (#306 part 2)', () => {
  it('ui and mcp write one applied and one refused record per family, with the same action ids', async () => {
    const c = await cockpit();
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const leader = agent(c.root);
    const matrix: Array<Expected & { door: 'ui' | 'mcp' }> = [];

    /** Runs `act`, then proves it added exactly one record from `door` saying `expected`. */
    const once = async (door: 'ui' | 'mcp', expected: Expected, act: () => Promise<unknown>): Promise<void> => {
      const before = records(c.dataDir).length;
      const answer = await act();
      const added = records(c.dataDir).slice(before);
      const label = `${door} ${expected.family} ${expected.action} ${expected.outcome}: ${JSON.stringify(answer).slice(0, 300)}`;
      expect(added, label).toHaveLength(1);
      expect(added[0], label).toMatchObject({
        origin: door,
        actor: { type: door },
        projectId: c.id,
        action: expected.action,
        outcome: expected.outcome === 'applied' ? { status: 'applied' } : { status: 'refused', ...(expected.reason ? { reason: expected.reason } : {}) },
      });
      expect(auditAction(expected.action)?.family, label).toBe(expected.family);
      matrix.push({ ...expected, door });
    };

    const http = async (method: string, path: string, body?: unknown) => {
      const res = await c.app.request(
        `/api/v1${path}`,
        {
          method,
          headers: { host: '127.0.0.1:4321', 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        CONNECTION,
      );
      return { status: res.status, body: await res.text() };
    };
    const mcp = (tool: string, args: Record<string, unknown>) => leader.call(tool, args);
    const version = async (runId: string): Promise<string> => {
      const read = await mcp('task_read', { view: 'task', taskId: runId });
      return (JSON.parse((read.content[0] as { text: string }).text) as { version: string }).version;
    };

    // A queued task both doors can act on (no worker slot, so it never runs).
    const started = await mcp('task_create', { action: 'start', operationId: operationId(), prompt: 'wait' });
    const runId = (started.structuredContent as { subject: { id: string } }).subject.id;
    const stale = await version(runId);

    // F1 — run
    await once('mcp', { family: 'F1', action: 'run.pin', outcome: 'applied' }, () =>
      mcp('organise_work', { action: 'pin', runId, expectedVersion: stale, operationId: operationId() }));
    await once('mcp', { family: 'F1', action: 'run.cancel', outcome: 'refused', reason: 'stale_version' }, () =>
      mcp('execution_control', { action: 'cancel', runId, expectedVersion: stale, operationId: operationId() }));
    await once('ui', { family: 'F1', action: 'run.pin', outcome: 'applied' }, () => http('POST', `/runs/${runId}/pin`, {}));
    await once('ui', { family: 'F1', action: 'run.cancel', outcome: 'refused', reason: 'stale_version' }, () =>
      http('POST', `/runs/${runId}/cancel`, { expectedVersion: stale }));

    // F2 — Git, pull requests, worktrees
    await once('mcp', { family: 'F2', action: 'worktree.reclaim', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'reclaim_worktrees', operationId: operationId() }));
    await once('mcp', { family: 'F2', action: 'run.worktree.remove', outcome: 'refused' }, () =>
      mcp('project_config', { action: 'remove_worktree', runId, expectedVersion: stale, operationId: operationId() }));
    await once('ui', { family: 'F2', action: 'worktree.reclaim', outcome: 'applied' }, () => http('POST', '/worktrees/reclaim', {}));
    await once('ui', { family: 'F2', action: 'run.worktree.remove', outcome: 'refused' }, () =>
      http('POST', `/runs/${runId}/remove-worktree`, { expectedVersion: stale }));

    // F3 — local handoff (the opener is a fake; nothing is launched)
    // `finder` (the file manager) is the one target every host lists.
    await once('mcp', { family: 'F3', action: 'project.openInApp', outcome: 'applied' }, () =>
      mcp('local_handoff', { action: 'open_project_in_app', target: 'finder', operationId: operationId() }));
    // A queued task has no agent session to resume: the route refuses, and the tool's non-error
    // `performed: false` answer is still a refusal, never `applied`.
    await once('mcp', { family: 'F3', action: 'run.openInTerminal', outcome: 'refused', reason: 'http_409' }, () =>
      mcp('local_handoff', { action: 'open_task_in_terminal', runId, operationId: operationId() }));
    await once('mcp', { family: 'F3', action: 'project.openInApp', outcome: 'refused', reason: 'host_process' }, () =>
      mcp('project_config', { action: 'open_in_app', operationId: operationId() }));
    await once('ui', { family: 'F3', action: 'project.openInApp', outcome: 'applied' }, () => http('POST', '/open-in', { target: 'finder' }));
    await once('ui', { family: 'F3', action: 'run.openInTerminal', outcome: 'refused', reason: 'http_409' }, () =>
      http('POST', `/runs/${runId}/open-in-cli`));
    expect(c.opened.length).toBe(2);

    // F4 — project configuration
    const templates = [{ id: 'tpl', label: 'Template', text: 'Do {{task}}' }];
    await once('mcp', { family: 'F4', action: 'project.uiState.set', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'set_prompt_templates', promptTemplates: templates, operationId: operationId() }));
    await once('mcp', { family: 'F4', action: 'agentConfig.write', outcome: 'refused' }, () =>
      mcp('project_config', { action: 'write_agent_config', fileId: 'claude-settings-user', content: '{}', version: 'x', operationId: operationId() }));
    await once('ui', { family: 'F4', action: 'project.uiState.set', outcome: 'applied' }, () => http('PUT', '/ui-state', { promptTemplates: templates }));
    await once('ui', { family: 'F4', action: 'project.registry.update', outcome: 'refused', reason: 'http_404' }, () =>
      http('PATCH', '/projects/no-such-project', { tags: ['x'] }));

    // F5 — workflow files
    const workflow = { name: 'Audit chain', steps: [{ id: 'review', prompt: 'Review {{task}}' }] };
    await once('mcp', { family: 'F5', action: 'workflow.save', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'save_workflow', workflow, operationId: operationId() }));
    await once('mcp', { family: 'F5', action: 'workflow.save', outcome: 'refused', reason: 'http_409' }, () =>
      mcp('project_config', { action: 'save_workflow', workflow, operationId: operationId() }));
    await once('ui', { family: 'F5', action: 'workflow.save', outcome: 'applied' }, () =>
      http('POST', '/workflows', { ...workflow, name: 'Audit chain two' }));
    await once('ui', { family: 'F5', action: 'workflow.delete', outcome: 'refused', reason: 'http_404' }, () =>
      http('DELETE', '/workflows/no-such-workflow'));

    // F6 — automations
    const created = await (async () => {
      let answer: McpToolResult | undefined;
      await once('mcp', { family: 'F6', action: 'automation.create', outcome: 'applied' }, async () => {
        answer = await mcp('project_config', {
          action: 'create_automation',
          automation: { name: 'Review new issues', prompt: 'Review {{github.url}}' },
          operationId: operationId(),
        });
        return answer;
      });
      return ((answer!.structuredContent as { result: { automation: { id: string } } }).result.automation.id);
    })();
    await once('mcp', { family: 'F6', action: 'automation.enable', outcome: 'refused', reason: 'http_404' }, () =>
      mcp('project_config', { action: 'enable_automation', automationId: 'no-such-automation', operationId: operationId() }));
    await once('ui', { family: 'F6', action: 'automation.pause', outcome: 'applied' }, () => http('POST', `/automations/${created}/pause`));
    await once('ui', { family: 'F6', action: 'automation.enable', outcome: 'refused', reason: 'http_404' }, () =>
      http('POST', '/automations/no-such-automation/enable'));
    // A preview check is a read through both doors.
    const beforePreview = records(c.dataDir).length;
    await http('POST', `/automations/${created}/check`, { mode: 'preview' });
    await mcp('project_config', { action: 'check_automation', automationId: created, mode: 'preview', operationId: operationId() });
    expect(records(c.dataDir).slice(beforePreview)).toEqual([]);

    // F7 — skills and onboarding
    await once('mcp', { family: 'F7', action: 'skills.refresh', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'refresh_skills', operationId: operationId() }));
    await once('mcp', { family: 'F7', action: 'onboarding.dismissOffer', outcome: 'refused', reason: 'conflict' }, () =>
      mcp('project_config', {
        action: 'dismiss_onboarding_offer',
        onboardingIdentity: { engineVersion: '0.0.0-not-running', kitDigest: 'not-running' },
        operationId: operationId(),
      }));
    await once('ui', { family: 'F7', action: 'skills.refresh', outcome: 'applied' }, () => http('POST', '/skills/refresh'));
    await once('ui', { family: 'F7', action: 'onboarding.dismissOffer', outcome: 'refused', reason: 'conflict' }, () =>
      http('POST', '/onboarding/offered', { engineVersion: '0.0.0-not-running', kitDigest: 'not-running' }));

    // F8 — leader session
    const read = await mcp('leader_events', { action: 'read' });
    const cursor = (read.structuredContent as { nextCursor?: string; resumeCursor?: string }).nextCursor
      ?? (read.structuredContent as { gap?: { resumeCursor: string } }).gap?.resumeCursor;
    expect(typeof cursor, JSON.stringify(read)).toBe('string');
    await once('mcp', { family: 'F8', action: 'leader.ack', outcome: 'applied' }, () =>
      mcp('leader_events', { action: 'ack', cursor, operationId: operationId() }));
    await once('mcp', { family: 'F8', action: 'leader.ack', outcome: 'refused', reason: 'invalid_cursor' }, () =>
      mcp('leader_events', { action: 'ack', cursor: 'not-a-cursor', operationId: operationId() }));
    await once('ui', { family: 'F8', action: 'leader.stop', outcome: 'applied' }, () => http('POST', '/mcp/leader', { action: 'stop' }));
    await once('ui', { family: 'F8', action: 'leader.attach', outcome: 'refused', reason: 'http_409' }, () =>
      http('POST', '/mcp/leader', { action: 'attach', client: 'codex' }));

    // F9 — project registry: MCP can only refuse (§ 6.2)
    await once('mcp', { family: 'F9', action: 'project.registry.add', outcome: 'refused', reason: 'project_registry' }, () =>
      mcp('project_config', { action: 'add_project', operationId: operationId() }));
    await once('ui', { family: 'F9', action: 'project.registry.remove', outcome: 'refused', reason: 'http_404' }, () =>
      http('DELETE', '/projects/no-such-project'));
    // The applied registration writes to the project it registered (§ 4), not to this one.
    const other = tmp('xao-');
    const beforeAdd = records(c.dataDir).length;
    const added = await http('POST', '/projects', { root: other });
    expect(added.status, added.body).toBe(200);
    expect(records(c.dataDir)).toHaveLength(beforeAdd);
    const otherRecords = records(projectDataDir(other));
    expect(otherRecords).toHaveLength(1);
    expect(otherRecords[0]).toMatchObject({ origin: 'ui', action: 'project.registry.add', outcome: { status: 'applied' } });
    matrix.push({ door: 'ui', family: 'F9', action: 'project.registry.add', outcome: 'applied' });

    // F10 — workspace: MCP can only refuse (§ 6.2)
    await once('mcp', { family: 'F10', action: 'workspace.config.set', outcome: 'refused', reason: 'workspace_settings' }, () =>
      mcp('project_config', { action: 'set_workspace_config', operationId: operationId() }));
    await once('ui', { family: 'F10', action: 'workspace.uiState.set', outcome: 'applied' }, () => http('PUT', '/workspace/ui-state', {}));
    await once('ui', { family: 'F10', action: 'account.update', outcome: 'refused', reason: 'http_404' }, () =>
      http('PATCH', '/workspace/agent-profiles/no-such-account', { label: 'x' }));

    // The matrix itself — every family, both doors, both outcomes where the door can produce them.
    const families: AuditFamily[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];
    for (const family of families) {
      for (const door of ['ui', 'mcp'] as const) {
        const outcomes = new Set(matrix.filter((row) => row.family === family && row.door === door).map((row) => row.outcome));
        const mcpRefusedOnly = door === 'mcp' && (family === 'F9' || family === 'F10');
        expect([...outcomes].sort(), `${door} ${family}`).toEqual(mcpRefusedOnly ? ['refused'] : ['applied', 'refused']);
      }
    }
    // B-DOOR-NAME-SPLIT: where both doors reached the same effect, they named it the same way.
    for (const shared of ['run.pin', 'run.cancel', 'worktree.reclaim', 'run.worktree.remove', 'run.openInTerminal', 'project.openInApp', 'project.uiState.set', 'workflow.save', 'automation.enable', 'skills.refresh', 'onboarding.dismissOffer']) {
      expect(new Set(matrix.filter((row) => row.action === shared).map((row) => row.door)), shared).toEqual(new Set(['ui', 'mcp']));
    }
  }, 120_000);

  it('a caller-supplied origin or actor never changes a record', async () => {
    const c = await cockpit();
    const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
    closers.push(() => handle.close());
    const leader = agent(c.root);
    // Unknown keys are refused by the tool's own schema, so the forgery goes where a caller CAN put
    // free data: an HTTP header and a body field the route ignores.
    await leader.call('organise_work', { action: 'mark_all_read', operationId: operationId() });
    const res = await c.app.request(
      '/api/v1/runs/read-all',
      { method: 'POST', headers: { host: '127.0.0.1:4321', 'x-xezar-origin': 'cli', 'x-xezar-user': 'mallory' } },
      CONNECTION,
    );
    expect(res.status).toBe(200);
    const all = records(c.dataDir);
    expect(all.map((record) => [record.origin, record.actor])).toEqual([
      ['mcp', { type: 'mcp' }],
      ['ui', { type: 'ui' }],
    ]);
  });

  it('automation: a launched run links to its receipt; a pre-launch refusal is refused; a duplicate writes nothing', async () => {
    const root = tmp('xaa-');
    const dataDir = projectDataDir(root);
    mkdirSync(dataDir, { recursive: true });
    const store = AutomationStore.open(dataDir);
    const base = { enabled: true, events: ['issue.opened' as const], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 } };
    const launching = store.create({ ...base, name: 'Launches', task: { prompt: 'Review' } }, 'launches');
    const refusing = store.create({ ...base, name: 'Refuses', task: { prompt: 'Review', workflow: 'no-such-workflow' } }, 'refuses');
    const candidate = { eventId: 'event-1', event: 'issue.opened' as const, timestamp: '2026-09-17T02:00:00.000Z', tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'SECRET TITLE', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] };
    const poller = { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as unknown as GithubPoller;
    const scope = { projectId: 'audit-automation', dataDir };
    const receiptsSeen: string[] = [];
    const scheduler = new ProjectAutomationScheduler({
      projectId: scope.projectId,
      owner: 'acme',
      repo: 'demo',
      store,
      poller,
      launch: async (definition, _candidate, receiptId) => {
        receiptsSeen.push(receiptId);
        if (definition.task.workflow) throw new AutomationLaunchRefusal('unknown_workflow', `unknown workflow: ${definition.task.workflow}`);
        return { runId: 'run-from-automation' };
      },
      audit: automationAudit(scope),
    });
    await scheduler.check(launching, 'execute');
    await scheduler.check(launching, 'execute').catch(() => undefined); // the same event: a duplicate receipt
    await scheduler.check(refusing, 'execute').catch(() => undefined);

    const all = records(dataDir);
    expect(all, JSON.stringify(all)).toHaveLength(2);
    expect(all[0]).toMatchObject({
      origin: 'automation',
      actor: { type: 'automation', receiptId: receiptsSeen[0] },
      action: 'automation.launch',
      resource: { kind: 'run', id: 'run-from-automation' },
      outcome: { status: 'applied' },
    });
    expect(all[1]).toMatchObject({
      origin: 'automation',
      actor: { type: 'automation', receiptId: receiptsSeen[1] },
      action: 'automation.launch',
      resource: { kind: 'automation', id: 'refuses' },
      outcome: { status: 'refused', reason: 'unknown_workflow' },
    });
    // B-AUTO-RECEIPT: each record names the receipt that was reserved for THAT launch.
    const receiptIds = store.receipts().map((receipt) => receipt.receiptId);
    expect(receiptIds).toEqual(expect.arrayContaining(receiptsSeen));
    expect(receiptsSeen).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain('SECRET TITLE');
  });

  it('cli: one applied and one refused command record, into the registered project', async () => {
    const root = tmp('xac-');
    const { id } = await registerProject(root);
    await cliAudit('projects.list', root).applied({ resource: { kind: 'project', id } });
    await cliAudit('run', root).refused('unknown_workflow');
    const all = records(projectDataDir(root));
    expect(all.map((record) => [record.origin, record.actor, record.action, record.outcome])).toEqual([
      ['cli', { type: 'cli', command: 'projects.list' }, 'cli.projects.list', { status: 'applied' }],
      ['cli', { type: 'cli', command: 'run' }, 'cli.run', { status: 'refused', reason: 'unknown_workflow' }],
    ]);
    expect(all.every((record) => record.projectId === id)).toBe(true);
  });
});
