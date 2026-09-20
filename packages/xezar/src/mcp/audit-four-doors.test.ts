// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './tools/mcp-test-home.testkit.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
 * #573: a target the bound project does not have is an ordinary MCP refusal too. Each mutating
 * action that looks its target up before any effect writes one `refused` / `not_found` record for an
 * unknown id — see `mcp: a target this project does not have` below, one case per action.
 *
 * Reads between the cases (task_read, leader_events read) are part of the proof: they would add a
 * record and break the "exactly one" assertion if a read were audited (`B-MCP-MIXED-READ`).
 * QA reuses this file: `npm test -- packages/xezar/src/mcp/audit-four-doors.test.ts`.
 */

const VERSION = '9.9.9-audit-doors';
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = {
  home: process.env.XEZ_HOME,
  dryRun: process.env.XEZ_DRY_RUN,
  automations: process.env.XEZ_AUTOMATIONS,
  followups: process.env.XEZ_FOLLOWUPS,
};

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
    ['XEZ_FOLLOWUPS', saved.followups],
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
    // #573: a task this project does not have — refused before any effect, like the cockpit's 404.
    await once('mcp', { family: 'F1', action: 'run.cancel', outcome: 'refused', reason: 'not_found' }, () =>
      mcp('execution_control', { action: 'cancel', runId: 'no-such-run-0000', expectedVersion: stale, operationId: operationId() }));
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

    // F10 — workspace: MCP refuses the global skills-update apply, and APPLIES every write the
    // owner's 2026-09-20 rule opened — the settings (#677 B1/B2), the shared preference bag (B3)
    // and the provider switch (B4). Both outcomes, through the same audit action ids the cockpit
    // door uses.
    await once('mcp', { family: 'F10', action: 'skills.applyUpdates', outcome: 'refused', reason: 'workspace_settings' }, () =>
      mcp('project_config', { action: 'apply_skill_updates', operationId: operationId() }));
    await once('mcp', { family: 'F10', action: 'provider.setEnabled', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'set_provider_enabled', operationId: operationId(), provider: 'claude', enabled: false }));
    await once('mcp', { family: 'F10', action: 'workspace.uiState.set', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'set_workspace_ui_state', operationId: operationId(), uiState: { appearance: { accent: 'violet' } } }));
    // A REAL host path through the leader's door, so the next assertion has a needle to look for
    // (independent review of #748, Minor 4): a folder inside this cockpit's own, which exists and
    // is writable, so the route's probe accepts it. Its own named segment rather than `c.root`
    // itself (#677 B4): the project ID is a SLUG of the root's basename, so whenever `mkdtemp`
    // happened to draw an all-lowercase suffix the two were equal and the "nor its last segment"
    // assertion failed on every record's `projectId` — a real flake, roughly one run in thirty.
    const auditedBrowseRoot = join(c.root, 'AuditedBrowseRoot');
    mkdirSync(auditedBrowseRoot, { recursive: true });
    await once('mcp', { family: 'F10', action: 'workspace.config.set', outcome: 'applied' }, () =>
      mcp('project_config', {
        action: 'set_workspace_config',
        operationId: operationId(),
        workspaceConfig: { resources: { maxParallel: 3 }, browseRoot: auditedBrowseRoot },
      }));
    // The record the MCP door writes for this write is its OWN, not the route middleware's: one
    // row, origin `mcp`, the inventory's action id, the operation key and a payload DIGEST. The
    // route's `fieldNames: true` belongs to the `ui` door and is not inherited — the door that
    // settles the call is the door that records it — so the MCP trail carries neither the field
    // names nor any value. Nothing new was needed for the reversal (#677 B1).
    const configSet = records(c.dataDir).filter((row) => row.action === 'workspace.config.set');
    expect(configSet).toHaveLength(1);
    expect(configSet[0], JSON.stringify(configSet[0])).toMatchObject({ origin: 'mcp', actor: { type: 'mcp' }, outcome: { status: 'applied' } });
    expect(configSet[0]!.payloadDigest, 'the payload is a digest, never the params').toMatch(/^[0-9a-f]{64}$/);
    expect(configSet[0], 'the MCP door records no field names').not.toHaveProperty('fieldNames');
    expect(JSON.stringify(configSet[0]), 'no key and no value of the body in the record').not.toMatch(/maxParallel|resources/);
    // A PATH value next to the trail, which no case had before (#748 review, Minor 4). The digest
    // makes this true by construction — which is exactly why it is worth pinning: the day a record
    // carries the params, a leader-supplied host path is in the trail in clear, and this is the
    // case that notices. Read over the whole file, not one row, so a second row would fail too.
    const trail = readFileSync(join(c.dataDir, AUDIT_TRAIL_FILE), 'utf8');
    expect(trail, 'the browse root’s VALUE is never in the audit trail').not.toContain(auditedBrowseRoot);
    expect(trail, 'nor its last segment').not.toContain(basename(auditedBrowseRoot));
    // The control: the path really was written, so the assertion above is about a record that has
    // something to hide rather than about a write that never happened.
    expect(JSON.parse((await http('GET', '/workspace/config')).body).browseRoot).toBe(auditedBrowseRoot);
    // The same action through the COCKPIT door, and the one difference between the two records
    // (#677 B4): the route carries `fieldNames: true`, so the cockpit's row names the body's keys
    // and still never a value, while the MCP row above carries neither. Drop that option from
    // `ui.route('provider.setEnabled', …)` and the `fieldNames` assertion goes red.
    await once('ui', { family: 'F10', action: 'provider.setEnabled', outcome: 'applied' }, () =>
      http('PUT', '/providers/claude/enabled', { enabled: true }));
    const setEnabled = records(c.dataDir).filter((row) => row.action === 'provider.setEnabled');
    expect(setEnabled.map((row) => row.origin)).toEqual(['mcp', 'ui']);
    expect(setEnabled[1]!.fieldNames, 'the cockpit door names the fields').toEqual(['enabled']);
    expect(setEnabled[1]!.payloadDigest, 'the value itself is a digest').toMatch(/^[0-9a-f]{64}$/);
    expect(setEnabled[1], 'and never the value').not.toHaveProperty('payload');
    expect(setEnabled[0], 'the MCP door records no field names').not.toHaveProperty('fieldNames');
    await once('ui', { family: 'F10', action: 'workspace.uiState.set', outcome: 'applied' }, () => http('PUT', '/workspace/ui-state', {}));
    await once('ui', { family: 'F10', action: 'account.update', outcome: 'refused', reason: 'http_404' }, () =>
      http('PATCH', '/workspace/agent-profiles/no-such-account', { label: 'x' }));

    // `provider.retry` was the one F10 row no case reached through EITHER door (#760 review,
    // Minor 1). Both doors now: the cockpit's is an incident id the service does not hold, which
    // `clearRuntimeAuthFailure` refuses with the route's own 409, and the leader's is the
    // argument-level refusal it answers when there is no incident to clear at all — it never
    // names one, because F-03 keeps an incident id out of every answer it gets.
    await once('ui', { family: 'F10', action: 'provider.retry', outcome: 'refused', reason: 'http_409' }, () =>
      http('POST', '/providers/claude/retry', { authFailureId: 'incident-the-card-remembered' }));
    const retried = records(c.dataDir).filter((row) => row.action === 'provider.retry');
    expect(retried[0]!.fieldNames, 'the cockpit door names the field').toEqual(['authFailureId']);
    expect(JSON.stringify(retried[0]), 'and never the incident id itself').not.toContain('incident-the-card-remembered');
    await once('mcp', { family: 'F10', action: 'provider.retry', outcome: 'refused', reason: 'http_400' }, () =>
      mcp('project_config', { action: 'retry_provider', operationId: operationId(), provider: 'claude' }));

    // THE AGENT ACCOUNTS (#677 B5), every row through BOTH doors. The leader adds, selects,
    // renames and removes an account through the cockpit's own routes; the person does the same
    // through the routes themselves; one action id each, from the same inventory row.
    const leaderAccountDir = join(c.root, 'LeaderAccountHome');
    await once('mcp', { family: 'F10', action: 'account.create', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'create_account', operationId: operationId(), account: { provider: 'claude', configDir: leaderAccountDir } }));
    // Read back through the listing — a GET, so it adds no record and the "exactly one" rule above
    // still means what it says.
    const storedAccountId = async (): Promise<string> => {
      const listing = JSON.parse((await http('GET', '/workspace/agent-profiles')).body) as { profiles: Array<{ id: string; isDefault: boolean }> };
      const stored = listing.profiles.filter((row) => !row.isDefault);
      expect(stored, 'exactly one stored account at a time in this case').toHaveLength(1);
      return stored[0]!.id;
    };
    const leaderAccount = await storedAccountId();
    await once('mcp', { family: 'F10', action: 'account.select', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'select_account', operationId: operationId(), provider: 'claude', accountId: leaderAccount }));
    await once('mcp', { family: 'F10', action: 'account.update', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'update_account', operationId: operationId(), accountId: leaderAccount, accountUpdate: { label: 'Renamed by the leader' } }));
    await once('mcp', { family: 'F10', action: 'account.remove', outcome: 'applied' }, () =>
      mcp('project_config', { action: 'remove_account', operationId: operationId(), accountId: leaderAccount }));

    const personAccountDir = join(c.root, 'PersonAccountHome');
    await once('ui', { family: 'F10', action: 'account.create', outcome: 'applied' }, () =>
      http('POST', '/workspace/agent-profiles', { provider: 'claude', configDir: personAccountDir }));
    const personAccount = await storedAccountId();
    await once('ui', { family: 'F10', action: 'account.select', outcome: 'applied' }, () =>
      http('PUT', '/workspace/agent-profiles/selection', { projectId: c.id, provider: 'claude', profileId: personAccount }));
    await once('ui', { family: 'F10', action: 'account.remove', outcome: 'applied' }, () =>
      http('DELETE', `/workspace/agent-profiles/${personAccount}`));

    // The same difference between the doors as `provider.setEnabled` above, on a body whose value
    // is a HOST PATH: the cockpit's row names `configDir` and the MCP's row names nothing, and
    // neither carries the path. Drop `fieldNames: true` from `ui.route('account.create', …)` and
    // the first assertion goes red; let either door record its params and the last one does.
    const createdAccounts = records(c.dataDir).filter((row) => row.action === 'account.create');
    expect(createdAccounts.map((row) => row.origin)).toEqual(['mcp', 'ui']);
    expect(createdAccounts[1]!.fieldNames, 'the cockpit door names the fields').toEqual(['configDir', 'provider']);
    expect(createdAccounts[0], 'the MCP door records no field names').not.toHaveProperty('fieldNames');
    for (const row of createdAccounts) expect(row.payloadDigest, 'the body is a digest').toMatch(/^[0-9a-f]{64}$/);
    // `account.select` carries the same new `fieldNames: true` and had no pin of its own (#764
    // review, Minor 3): which account a project runs under is a choice about whose quota is spent,
    // so the cockpit's row names the body's keys and never the account id itself. Drop
    // `fieldNames: true` from `ui.route('account.select', …)` and the first assertion goes red.
    const selectedAccounts = records(c.dataDir).filter((row) => row.action === 'account.select');
    expect(selectedAccounts.map((row) => row.origin)).toEqual(['mcp', 'ui']);
    expect(selectedAccounts[1]!.fieldNames, 'the cockpit door names the fields').toEqual(['profileId', 'projectId', 'provider']);
    expect(selectedAccounts[0], 'the MCP door records no field names').not.toHaveProperty('fieldNames');
    for (const row of selectedAccounts) {
      expect(row.payloadDigest, 'the body is a digest').toMatch(/^[0-9a-f]{64}$/);
      for (const id of [leaderAccount, personAccount]) expect(JSON.stringify(row), 'and the account id is never in the record').not.toContain(id);
    }

    const accountTrail = readFileSync(join(c.dataDir, AUDIT_TRAIL_FILE), 'utf8');
    for (const dir of [leaderAccountDir, personAccountDir]) {
      expect(accountTrail, 'an account folder’s VALUE is never in the audit trail').not.toContain(dir);
      expect(accountTrail, 'nor its last segment').not.toContain(basename(dir));
    }

    // The matrix itself — every family, both doors, both outcomes where the door can produce them.
    const families: AuditFamily[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];
    for (const family of families) {
      for (const door of ['ui', 'mcp'] as const) {
        const outcomes = new Set(matrix.filter((row) => row.family === family && row.door === door).map((row) => row.outcome));
        // F10 stopped being refusal-only for MCP with #677 B1 (`workspace.config.set` applies).
        const mcpRefusedOnly = door === 'mcp' && family === 'F9';
        expect([...outcomes].sort(), `${door} ${family}`).toEqual(mcpRefusedOnly ? ['refused'] : ['applied', 'refused']);
      }
    }
    // B-DOOR-NAME-SPLIT: where both doors reached the same effect, they named it the same way.
    for (const shared of ['run.pin', 'run.cancel', 'worktree.reclaim', 'run.worktree.remove', 'run.openInTerminal', 'project.openInApp', 'project.uiState.set', 'workflow.save', 'automation.enable', 'skills.refresh', 'onboarding.dismissOffer']) {
      expect(new Set(matrix.filter((row) => row.action === shared).map((row) => row.door)), shared).toEqual(new Set(['ui', 'mcp']));
    }
  }, 120_000);

  /**
   * #573 — one case per mutating MCP action whose target lookup precedes every effect. Before the
   * fix each wrote nothing (an MCP error the door could not tell from a post-effect failure) or, for
   * `handoff_git`, `applied` (its refusal is not an MCP error). Named break `B-573-NOT-FOUND`:
   * remove `notFoundRefusalOf` from the door and every case fails.
   */
  describe('mcp: a target this project does not have is refused as not_found (#573)', () => {
    const ghost = 'no-such-run-0000';
    const version = 'rev1:run:no-such-run-0000:1:0123456789ab';
    const cases: Array<[tool: string, args: Record<string, unknown>, action: string]> = [
      ['execution_control', { action: 'cancel', runId: ghost, expectedVersion: version }, 'run.cancel'],
      ['execution_control', { action: 'finish', runId: ghost, finishAs: 'close_session', expectedVersion: version }, 'run.finish'],
      ['execution_control', { action: 'continue', runId: ghost, text: 'go on', expectedVersion: version }, 'run.continue'],
      ['execution_control', { action: 'send_message', runId: ghost, text: 'hello', expectedVersion: version }, 'run.message'],
      ['execution_control', { action: 'answer_question', runId: ghost, questionId: 'q-1', text: 'yes', expectedVersion: version }, 'run.message'],
      ['execution_control', { action: 'edit_queued_message', runId: ghost, messageId: 'm-1', text: 'x', expectedVersion: version }, 'run.queuedMessage.edit'],
      ['execution_control', { action: 'remove_queued_message', runId: ghost, messageId: 'm-1', expectedVersion: version }, 'run.queuedMessage.remove'],
      ['execution_control', { action: 'cancel_auto_resume', runId: ghost, expectedVersion: version }, 'run.autoResume.cancel'],
      ['organise_work', { action: 'set_title', runId: ghost, title: 'x', expectedVersion: version }, 'run.update'],
      ['organise_work', { action: 'edit_brief', runId: ghost, task: 'x', expectedVersion: version }, 'run.update'],
      ['organise_work', { action: 'edit_queued_message', runId: ghost, messageId: 'm-1', text: 'x', expectedVersion: version }, 'run.queuedMessage.edit'],
      ['organise_work', { action: 'remove_queued_message', runId: ghost, messageId: 'm-1', expectedVersion: version }, 'run.queuedMessage.remove'],
      ['organise_work', { action: 'pin', runId: ghost, expectedVersion: version }, 'run.pin'],
      ['organise_work', { action: 'unpin', runId: ghost, expectedVersion: version }, 'run.unpin'],
      ['organise_work', { action: 'archive', runId: ghost, expectedVersion: version }, 'run.archive'],
      ['organise_work', { action: 'restore', runId: ghost, expectedVersion: version }, 'run.restore'],
      ['organise_work', { action: 'mark_read', runId: ghost }, 'run.markRead'],
      ['organise_work', { action: 'mark_unread', runId: ghost }, 'run.markUnread'],
      ['organise_work', { action: 'delete', runId: ghost, expectedVersion: version }, 'run.delete'],
      ['organise_work', { action: 'pick_variant', groupId: 'no-such-group', runId: ghost, expectedVersion: version }, 'group.pickVariant'],
      ['organise_work', { action: 'start_inbox_item', todoId: 'no-such-todo' }, 'run.startFromInbox'],
      ['organise_work', { action: 'remove_inbox_item', todoId: 'no-such-todo' }, 'inbox.remove'],
      ['task_create', { action: 'start_from_inbox', todoId: 'no-such-todo' }, 'run.startFromInbox'],
      ['handoff_git', { action: 'commit', taskId: ghost, message: 'x', expectedVersion: version }, 'run.git.commit'],
      ['handoff_git', { action: 'push', taskId: ghost, expectedVersion: version }, 'run.git.push'],
      ['handoff_git', { action: 'create_pr', taskId: ghost, expectedVersion: version }, 'run.pr.create'],
    ];

    it.each(cases)('%s %o → %s', async (tool, args, action) => {
      // The inbox is opt-in; with it off, its routes answer a conflict instead of looking the entry up.
      process.env.XEZ_FOLLOWUPS = '1';
      const c = await cockpit();
      const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
      closers.push(() => handle.close());
      const leader = agent(c.root);
      const answer = await leader.call(tool, { ...args, operationId: operationId() });
      const all = records(c.dataDir);
      expect(all, JSON.stringify(answer).slice(0, 400)).toHaveLength(1);
      expect(all[0]).toMatchObject({
        origin: 'mcp',
        actor: { type: 'mcp' },
        projectId: c.id,
        action,
        outcome: { status: 'refused', reason: 'not_found' },
      });
      // Nothing about the unknown id leaks beyond the bounded resource the door already keeps.
      expect(JSON.stringify(all[0])).not.toContain('no-such-todo');
    });
  });

  /**
   * #577 — an ordinary answer that says nothing was applied. Before the fix each of these was
   * recorded as `applied`: `execution_control`'s and `organise_work`'s conflicts and `task_create`'s
   * (the Inbox is off, so its routes answer 409 before looking anything up), and every `handoff_git`
   * refusal that is not an MCP error. Named break `B-577-OUTCOME`: remove `conflictRefusalOf` and
   * `handoffGitRefusalOf` from the door (`mcp/index.ts`) and every case fails.
   */
  describe('mcp: an answer that applied nothing is refused, never applied (#577)', () => {
    /** The Inbox is OFF for these: its routes answer 409 without reaching an entry. */
    const inboxOff: Array<[tool: string, args: Record<string, unknown>, action: string, reason: string]> = [
      ['organise_work', { action: 'start_inbox_item', todoId: 'any-inbox-item' }, 'run.startFromInbox', 'conflict'],
      ['organise_work', { action: 'remove_inbox_item', todoId: 'any-inbox-item' }, 'inbox.remove', 'conflict'],
      ['task_create', { action: 'start_from_inbox', todoId: 'any-inbox-item' }, 'run.startFromInbox', 'conflict'],
    ];

    it.each(inboxOff)('inbox off: %s %o → %s', async (tool, args, action, reason) => {
      process.env.XEZ_FOLLOWUPS = '0';
      const c = await cockpit();
      const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
      closers.push(() => handle.close());
      const leader = agent(c.root);
      const answer = await leader.call(tool, { ...args, operationId: operationId() });
      const all = records(c.dataDir);
      expect(all, JSON.stringify(answer).slice(0, 400)).toHaveLength(1);
      expect(all[0]).toMatchObject({ origin: 'mcp', action, outcome: { status: 'refused', reason } });
    });

    it('execution_control: a state the action does not allow, and a hand-off refused by policy', async () => {
      const c = await cockpit();
      const handle = await startMcpService({ projectId: c.id, version: VERSION, service: c.app, store: c.store });
      closers.push(() => handle.close());
      const leader = agent(c.root);
      const mcp = (tool: string, args: Record<string, unknown>) => leader.call(tool, { ...args, operationId: operationId() });
      const started = await mcp('task_create', { action: 'start', prompt: 'wait' });
      const runId = (started.structuredContent as { subject: { id: string } }).subject.id;
      const read = await leader.call('task_read', { view: 'task', taskId: runId });
      const version = (JSON.parse((read.content[0] as { text: string }).text) as { version: string }).version;

      const before = records(c.dataDir).length;
      // A queued task is still active, so `continue` is refused with nothing changed.
      const answer = await mcp('execution_control', { action: 'continue', runId, text: 'go on', expectedVersion: version });
      // The three hand-off actions this task cannot do: it has no worktree, no remote, no forge.
      for (const action of ['commit', 'push', 'create_pr'] as const) {
        await mcp('handoff_git', { action, taskId: runId, expectedVersion: version, ...(action === 'commit' ? { message: 'x' } : {}) });
      }
      const added = records(c.dataDir).slice(before);
      expect(added.map((record) => [record.action, record.outcome]), JSON.stringify(answer).slice(0, 300)).toEqual([
        ['run.continue', { status: 'refused', reason: 'conflict' }],
        ['run.git.commit', { status: 'refused', reason: 'policy' }],
        ['run.git.push', { status: 'refused', reason: 'policy' }],
        ['run.pr.create', { status: 'refused', reason: 'policy' }],
      ]);
    }, 120_000);

    it('ui: the same Inbox refusal through the cockpit is the route 409 it always was', async () => {
      // The control for the door pair: the cockpit door already recorded this as refused.
      process.env.XEZ_FOLLOWUPS = '0';
      const c = await cockpit();
      const res = await c.app.request(
        '/api/v1/todos/any-inbox-item/start',
        { method: 'POST', headers: { host: '127.0.0.1:4321', 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' }, body: '{}' },
        CONNECTION,
      );
      expect(res.status).toBe(409);
      expect(records(c.dataDir)).toMatchObject([{ origin: 'ui', action: 'run.startFromInbox', outcome: { status: 'refused', reason: 'http_409' } }]);
    });
  });

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
