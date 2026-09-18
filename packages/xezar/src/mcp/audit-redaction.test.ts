import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { auditActionRecordSchema, type AuditActionRecord } from '@qodeca/xezar-contract';
import { Hono } from 'hono';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { automationAudit } from '../automations/audit.ts';
import type { AutomationDefinition } from '../automations/types.ts';
import { cliAudit } from '../cli-audit.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { createUiAuditDoor } from '../server/audit-ui.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { jsonZodValidator } from '../server/validators.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { AUDIT_REDACTED_VALUE, payloadDigest } from './audit-redaction.ts';
import { AUDIT_TRAIL_FILE, AuditTrail, resetAuditWarningsForTests } from './audit-trail.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { tools } from './tools/index.ts';

/**
 * #306 part 4 — REDACTION PER FIELD CLASS, PER DOOR (spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 9 and § 11).
 *
 * Six classes × four doors, one test each. Every test plants a value of its class through that
 * door's own adapter — the cockpit route decorator, the real MCP bridge and tools, the automation
 * runner's recorder and the command-line recorder — and proves two things about what reached
 * `audit.ndjson`: the planted value is not there as plaintext, and the digest is the digest of the
 * payload WITH the class's rule already applied (so the value was removed or replaced BEFORE hashing,
 * not merely left out of the file).
 *
 * NAMED BREAKS. `B-REDACT-<DOOR>-<CLASS>`: turn that one class off in that one door's row of
 * `AUDIT_DOOR_POLICIES` (`audit-redaction.ts`) — `identifier-secret` → `{ identifiers: [], payload:
 * false }`, `free-text` → `{ keys: [] }`, `path-url` → `{ keys: [], shapes: false }`, `control-text`
 * → `{ proxyUser: false, payload: false }`, `config-value` → `{ actions: [], body: 'payload' }` (for
 * the automation door `{ keys: [] }`), `door-specific` → `{ keys: [], secrets: false }`. The test with
 * the same name must then fail. The runs are recorded in the task evidence.
 */

const IDENTIFIER_SECRET = 'plantedIdentifierSecret0001';
const DOOR_SECRET = 'plantedDoorOnlySecret00001';
const FREE_TEXT = 'PLANTED free text: ship it tonight';
const PATH = '/Users/planted/private/repository';
const URL_VALUE = 'https://planted.example/private?token=1';
const CONFIG_VALUE = 'planted-config-value';
/** Each character of `value` written as a literal `\uXXXX` escape (m3, #586 follow-up). */
const asUnicodeEscapes = (value: string): string =>
  [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

const dirs: string[] = [];
const closers: Array<() => unknown> = [];
const saved = { home: process.env.XEZ_HOME, dryRun: process.env.XEZ_DRY_RUN, followups: process.env.XEZ_FOLLOWUPS, token: process.env.AUDIT_PLANTED_TOKEN };

beforeEach(() => {
  process.env.XEZ_HOME = temp('xrh-');
  // A host env secret: its name is credential-shaped, so every door must treat its value as one.
  process.env.AUDIT_PLANTED_TOKEN = IDENTIFIER_SECRET;
  resetAuditWarningsForTests();
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['XEZ_HOME', saved.home],
    ['XEZ_DRY_RUN', saved.dryRun],
    ['XEZ_FOLLOWUPS', saved.followups],
    ['AUDIT_PLANTED_TOKEN', saved.token],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Under /tmp: the MCP socket path must stay under 104 bytes on macOS.
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  dirs.push(dir);
  return dir;
}

const fileText = (dataDir: string): string => {
  const path = join(dataDir, AUDIT_TRAIL_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const records = (dataDir: string): AuditActionRecord[] =>
  fileText(dataDir)
    .split('\n')
    .filter(Boolean)
    .map((line) => auditActionRecordSchema.parse(JSON.parse(line)));
const only = (dataDir: string): AuditActionRecord => {
  const all = records(dataDir);
  expect(all, fileText(dataDir)).toHaveLength(1);
  return all[0]!;
};

/** The planted values must not be in the file's bytes, in any case. */
const expectAbsent = (dataDir: string, ...values: string[]): void => {
  const text = fileText(dataDir).toLowerCase();
  for (const value of values) expect(text, value).not.toContain(value.toLowerCase());
};

// ---- ui: the route decorator on a bare app with a real validator ------------------------------

function uiFixture(options: { hosted?: boolean } = {}) {
  const dataDir = join(temp('xru-'), '.local', 'xezar');
  mkdirSync(dataDir, { recursive: true });
  const scope = { projectId: 'redaction-ui', dataDir };
  const door = createUiAuditDoor({
    hosted: () => options.hosted === true,
    requestScope: async () => scope,
    bootScope: async () => scope,
    projectScope: async () => undefined,
    warn: () => {},
  });
  const body = jsonZodValidator(z.looseObject({}));
  const send = (app: { request: Hono['request'] }, path: string, json: unknown, headers: Record<string, string> = {}) =>
    app.request(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(json) },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );
  return { dataDir, door, body, send };
}

describe('ui door', () => {
  it('B-REDACT-UI-IDENTIFIER-SECRET: a host secret in a route id is dropped, never written', async () => {
    const f = uiFixture();
    const app = new Hono().post('/runs/:id/cancel', f.body, f.door.route('run.cancel', { resource: { kind: 'run', param: 'id' } }), (c) => c.json({}));
    await f.send(app, `/runs/${IDENTIFIER_SECRET}/cancel`, { keep: 'x' });
    const record = only(f.dataDir);
    expect(record.resource).toBeUndefined();
    expectAbsent(f.dataDir, IDENTIFIER_SECRET);
  });

  it('B-REDACT-UI-FREE-TEXT: a message is removed before hashing', async () => {
    const f = uiFixture();
    const app = new Hono().post('/m', f.body, f.door.route('run.message'), (c) => c.json({}));
    await f.send(app, '/m', { text: FREE_TEXT, delivery: 'queue' });
    expect(only(f.dataDir).payloadDigest).toBe(payloadDigest({ delivery: 'queue' }));
    expectAbsent(f.dataDir, FREE_TEXT);
  });

  it('B-REDACT-UI-PATH-URL: a path and a URL are replaced before hashing', async () => {
    const f = uiFixture();
    const app = new Hono().post('/open', f.body, f.door.route('project.openInApp'), (c) => c.json({}));
    await f.send(app, '/open', { target: PATH, fallback: URL_VALUE, root: 'x' });
    expect(only(f.dataDir).payloadDigest).toBe(payloadDigest({ target: AUDIT_REDACTED_VALUE, fallback: AUDIT_REDACTED_VALUE }));
    expectAbsent(f.dataDir, PATH, URL_VALUE);
  });

  it('B-REDACT-UI-CONTROL-TEXT: controls are stripped from the asserted user and from the body before hashing', async () => {
    const f = uiFixture({ hosted: true });
    const app = new Hono().post('/open', f.body, f.door.route('project.openInApp'), (c) => c.json({}));
    // A tab is the one C0 control an HTTP header may carry.
    await f.send(app, '/open', { target: 'finder' }, { 'x-xezar-user': 'ali\tce' });
    const record = only(f.dataDir);
    expect(record.actor).toEqual({ type: 'ui', proxyUser: { value: 'alice', trust: 'asserted-by-proxy' } });
    expect(record.payloadDigest).toBe(payloadDigest({ target: 'finder' }));
  });

  it('B-REDACT-UI-CONFIG-VALUE: a configuration write keeps key names and a digest of no value', async () => {
    const f = uiFixture();
    const app = new Hono().post('/config', f.body, f.door.route('project.config.set', { fieldNames: true }), (c) => c.json({}));
    await f.send(app, '/config', { baseBranch: CONFIG_VALUE, maxParallel: 3 });
    const record = only(f.dataDir);
    expect(record.fieldNames).toEqual(['baseBranch', 'maxParallel']);
    expect(record.payloadDigest).toBe(payloadDigest({ baseBranch: AUDIT_REDACTED_VALUE, maxParallel: AUDIT_REDACTED_VALUE }));
    expectAbsent(f.dataDir, CONFIG_VALUE);
  });

  it('B-REDACT-UI-DOOR-SPECIFIC: the request credentials are masked and headers never hashed', async () => {
    const f = uiFixture();
    const app = new Hono().post('/open', f.body, f.door.route('project.openInApp'), (c) => c.json({}));
    await f.send(app, '/open', { target: DOOR_SECRET, headers: { cookie: 'session' } }, { authorization: `Basic ${Buffer.from(`alice:${DOOR_SECRET}`).toString('base64')}` });
    expect(only(f.dataDir).payloadDigest).toBe(payloadDigest({ target: '[REDACTED]' }));
    expectAbsent(f.dataDir, DOOR_SECRET);
  });
});

// ---- mcp: the real bridge, service and tools ---------------------------------------------------

const VERSION = '9.9.9-audit-redaction';
const GHOST = 'no-such-run-0000';
const REV = 'rev1:run:no-such-run-0000:1:0123456789ab';
let op = 0;
const operationId = (): string => `op-audit-redaction-${String(++op).padStart(4, '0')}`;

async function mcpFixture(env: NodeJS.ProcessEnv = process.env) {
  process.env.XEZ_DRY_RUN = '1';
  process.env.XEZ_FOLLOWUPS = '1';
  const root = temp('xrm-');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
  const store = RunStore.open(projectDataDir(root), { keepLive: true });
  const manager = new RunManager(store, root, { semaphore });
  const contexts = new ProjectContexts({ listProjects: async () => [{ id, root, status: 'ok' }], semaphore });
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
  });
  closers.push(() => {
    manager.dispose();
    store.flush();
    contexts.disposeAll();
  });
  const handle = await startMcpService({ projectId: id, version: VERSION, service: app, store, env, warn: () => {} });
  closers.push(() => handle.close());

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
  const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    const rpc = next++;
    return new Promise((resolve) => {
      pending.set(rpc, resolve);
      input.write(encodeFrame({ jsonrpc: '2.0', id: rpc, method: 'tools/call', params: { name, arguments: args } }));
    });
  };
  return { dataDir: store.dataDir, call };
}

describe('mcp door', () => {
  it('B-REDACT-MCP-IDENTIFIER-SECRET: a host secret as a task id and an operation id is dropped, never written', async () => {
    const m = await mcpFixture();
    await m.call('organise_work', { action: 'pin', runId: IDENTIFIER_SECRET, expectedVersion: REV, operationId: `op-${IDENTIFIER_SECRET}` });
    const record = only(m.dataDir);
    expect(record.outcome).toEqual({ status: 'refused', reason: 'not_found' });
    expect(record.resource).toBeUndefined();
    expect(record.operationKey).toBeUndefined();
    expectAbsent(m.dataDir, IDENTIFIER_SECRET);
  }, 60_000);

  it('B-REDACT-MCP-FREE-TEXT: a title is removed before hashing', async () => {
    const m = await mcpFixture();
    const args = { action: 'set_title', runId: GHOST, expectedVersion: REV, operationId: operationId() };
    await m.call('organise_work', { ...args, title: FREE_TEXT });
    expect(only(m.dataDir).payloadDigest).toBe(payloadDigest(args));
    expectAbsent(m.dataDir, FREE_TEXT);
  }, 60_000);

  it('B-REDACT-MCP-PATH-URL: a path-shaped argument is replaced before hashing', async () => {
    const m = await mcpFixture();
    const args = { action: 'start_inbox_item', todoId: 'no-such-todo', operationId: operationId() };
    await m.call('organise_work', { ...args, model: PATH });
    expect(only(m.dataDir).payloadDigest).toBe(payloadDigest({ ...args, model: AUDIT_REDACTED_VALUE }));
    expectAbsent(m.dataDir, PATH);
  }, 60_000);

  it('B-REDACT-MCP-CONTROL-TEXT: controls in an argument are stripped before hashing', async () => {
    const m = await mcpFixture();
    const args = { action: 'start_inbox_item', todoId: 'no-such-todo', operationId: operationId() };
    await m.call('organise_work', { ...args, model: 'claude-planted' });
    expect(only(m.dataDir).payloadDigest).toBe(payloadDigest({ ...args, model: 'claude-planted' }));
  }, 60_000);

  it('B-REDACT-MCP-CONFIG-VALUE: set_config keeps the key names and a digest of no value', async () => {
    const m = await mcpFixture();
    const args = { action: 'set_config', operationId: operationId() };
    await m.call('project_config', { ...args, config: { baseBranch: CONFIG_VALUE } });
    const record = only(m.dataDir);
    expect(record.action).toBe('project.config.set');
    expect(record.fieldNames).toEqual(['baseBranch']);
    expect(record.payloadDigest).toBe(payloadDigest({ ...args, config: { baseBranch: AUDIT_REDACTED_VALUE } }));
    expectAbsent(m.dataDir, CONFIG_VALUE);
  }, 60_000);

  it('B-REDACT-MCP-DOOR-SPECIFIC: a secret only the MCP service env holds is masked before hashing', async () => {
    // Not in this process's env: only the service's own env names it.
    const m = await mcpFixture({ ...process.env, AUDIT_SERVICE_ONLY_TOKEN: DOOR_SECRET });
    const args = { action: 'start_inbox_item', todoId: 'no-such-todo', operationId: operationId() };
    await m.call('organise_work', { ...args, model: DOOR_SECRET });
    expect(only(m.dataDir).payloadDigest).toBe(payloadDigest({ ...args, model: '[REDACTED]' }));
    expectAbsent(m.dataDir, DOOR_SECRET);
  }, 60_000);

  it('B-REDACT-MCP-IDENTIFIER-SECRET-ESCAPED: a host secret written as \\u escapes in an argument is still masked before hashing (m3)', async () => {
    const m = await mcpFixture();
    const args = { action: 'start_inbox_item', todoId: 'no-such-todo', operationId: operationId() };
    const escaped = asUnicodeEscapes(IDENTIFIER_SECRET);
    await m.call('organise_work', { ...args, model: escaped });
    expect(only(m.dataDir).payloadDigest).toBe(payloadDigest({ ...args, model: AUDIT_REDACTED_VALUE }));
  }, 60_000);

  it('B-REDACT-MCP-DOOR-SPECIFIC-ESCAPED: an escaped door secret in an argument is still masked before hashing (m3)', async () => {
    const m = await mcpFixture({ ...process.env, AUDIT_SERVICE_ONLY_TOKEN: DOOR_SECRET });
    const args = { action: 'start_inbox_item', todoId: 'no-such-todo', operationId: operationId() };
    const escaped = asUnicodeEscapes(DOOR_SECRET);
    await m.call('organise_work', { ...args, model: escaped });
    expect(only(m.dataDir).payloadDigest).toBe(payloadDigest({ ...args, model: AUDIT_REDACTED_VALUE }));
  }, 60_000);

  it('B-REDACT-MCP-CONFIG-VALUE guard: every MCP config-write action keeps its body key out of the digest (m2)', async () => {
    const project = await mcpFixture();
    const projectArgs = { action: 'set_project', operationId: operationId() };
    await project.call('project_config', { ...projectArgs, project: { tags: [CONFIG_VALUE] } });
    const projectRecord = only(project.dataDir);
    expect(projectRecord.action).toBe('project.registry.update');
    expect(projectRecord.fieldNames).toEqual(['tags']);
    expect(projectRecord.payloadDigest).toBe(payloadDigest({ ...projectArgs, project: { tags: AUDIT_REDACTED_VALUE } }));
    expectAbsent(project.dataDir, CONFIG_VALUE);

    const templates = await mcpFixture();
    const templatesArgs = { action: 'set_prompt_templates', operationId: operationId() };
    await templates.call('project_config', {
      ...templatesArgs,
      promptTemplates: [{ id: 'x', label: 'y', text: CONFIG_VALUE }],
    });
    const templatesRecord = only(templates.dataDir);
    expect(templatesRecord.action).toBe('project.uiState.set');
    expect(templatesRecord.fieldNames).toEqual(['promptTemplates']);
    expect(templatesRecord.payloadDigest).toBe(payloadDigest({ ...templatesArgs, promptTemplates: AUDIT_REDACTED_VALUE }));
    expectAbsent(templates.dataDir, CONFIG_VALUE);

    const agentConfig = await mcpFixture();
    const agentConfigArgs = { action: 'write_agent_config', operationId: operationId(), fileId: 'claude.project.settings', version: null };
    await agentConfig.call('project_config', { ...agentConfigArgs, content: CONFIG_VALUE });
    const agentConfigRecord = only(agentConfig.dataDir);
    expect(agentConfigRecord.action).toBe('agentConfig.write');
    expect(agentConfigRecord.fieldNames).toEqual(['content']);
    expect(agentConfigRecord.payloadDigest).toBe(payloadDigest({ ...agentConfigArgs, content: AUDIT_REDACTED_VALUE }));
    expectAbsent(agentConfig.dataDir, CONFIG_VALUE);
  }, 60_000);
});

// ---- automation: the runner's recorder and its channel ----------------------------------------

function automationFixture() {
  const dataDir = join(temp('xra-'), '.local', 'xezar');
  mkdirSync(dataDir, { recursive: true });
  const scope = { projectId: 'redaction-automation', dataDir };
  const channel = new AuditTrail(scope, { warn: () => {} }).channel('automation');
  const base = { automationId: 'nightly', revision: 2, event: 'issue.opened' };
  const launch = (payload: Record<string, unknown>, resource = { kind: 'run', id: 'run-1' }) =>
    channel.record({ action: 'automation.launch', actor: { receiptId: 'receipt-1' }, payload }, { outcome: 'applied', resource });
  return { dataDir, scope, base, launch };
}

describe('automation door', () => {
  it('B-REDACT-AUTOMATION-IDENTIFIER-SECRET: a host secret as a run id or receipt id never reaches the file', async () => {
    const a = automationFixture();
    await a.launch(a.base, { kind: 'run', id: IDENTIFIER_SECRET });
    await automationAudit(a.scope, () => {}).launched({ id: 'nightly', revision: 2 } as AutomationDefinition, 'issue.opened', IDENTIFIER_SECRET, 'run-2');
    const record = only(a.dataDir);
    expect(record.resource).toBeUndefined();
    expectAbsent(a.dataDir, IDENTIFIER_SECRET);
  });

  it('B-REDACT-AUTOMATION-FREE-TEXT: a candidate title is removed before hashing', async () => {
    const a = automationFixture();
    await a.launch({ ...a.base, title: FREE_TEXT });
    expect(only(a.dataDir).payloadDigest).toBe(payloadDigest(a.base));
    expectAbsent(a.dataDir, FREE_TEXT);
  });

  it('B-REDACT-AUTOMATION-PATH-URL: a URL is replaced before hashing', async () => {
    const a = automationFixture();
    await a.launch({ ...a.base, source: URL_VALUE });
    expect(only(a.dataDir).payloadDigest).toBe(payloadDigest({ ...a.base, source: AUDIT_REDACTED_VALUE }));
    expectAbsent(a.dataDir, URL_VALUE);
  });

  it('B-REDACT-AUTOMATION-CONTROL-TEXT: controls are stripped before hashing', async () => {
    const a = automationFixture();
    await a.launch({ ...a.base, event: 'issue.opened[2J' });
    expect(only(a.dataDir).payloadDigest).toBe(payloadDigest({ ...a.base, event: 'issue.opened[2J' }));
  });

  it("B-REDACT-AUTOMATION-CONFIG-VALUE: a definition's configuration is removed before hashing", async () => {
    const a = automationFixture();
    await a.launch({ ...a.base, filters: { labels: [CONFIG_VALUE] }, task: { prompt: CONFIG_VALUE } });
    expect(only(a.dataDir).payloadDigest).toBe(payloadDigest(a.base));
    expectAbsent(a.dataDir, CONFIG_VALUE);
  });

  it("B-REDACT-AUTOMATION-DOOR-SPECIFIC: a candidate's author and repository are removed before hashing", async () => {
    const a = automationFixture();
    await a.launch({ ...a.base, author: 'planted-author', repository: 'planted-org/planted-repo' });
    expect(only(a.dataDir).payloadDigest).toBe(payloadDigest(a.base));
    expectAbsent(a.dataDir, 'planted-author', 'planted-org/planted-repo');
  });
});

// ---- cli: the command recorder ------------------------------------------------------------------

async function cliFixture() {
  const root = temp('xrc-');
  const { id } = await registerProject(root);
  return { root, id, dataDir: projectDataDir(root) };
}

describe('cli door', () => {
  it('B-REDACT-CLI-IDENTIFIER-SECRET: a host secret as a resource id is dropped, never written', async () => {
    const c = await cliFixture();
    await cliAudit('projects.list', c.root, { warn: () => {} }).applied({ resource: { kind: 'project', id: IDENTIFIER_SECRET } });
    expect(only(c.dataDir).resource).toBeUndefined();
    expectAbsent(c.dataDir, IDENTIFIER_SECRET);
  });

  it('B-REDACT-CLI-FREE-TEXT: a task text is removed before hashing', async () => {
    const c = await cliFixture();
    await cliAudit('run', c.root, { warn: () => {} }).applied({ payload: { task: FREE_TEXT, steps: 1 } });
    expect(only(c.dataDir).payloadDigest).toBe(payloadDigest({ steps: 1 }));
    expectAbsent(c.dataDir, FREE_TEXT);
  });

  it('B-REDACT-CLI-PATH-URL: a path is replaced before hashing', async () => {
    const c = await cliFixture();
    await cliAudit('init', c.root, { warn: () => {} }).applied({ payload: { scaffold: PATH } });
    expect(only(c.dataDir).payloadDigest).toBe(payloadDigest({ scaffold: AUDIT_REDACTED_VALUE }));
    expectAbsent(c.dataDir, PATH);
  });

  it('B-REDACT-CLI-CONTROL-TEXT: controls are stripped before hashing', async () => {
    const c = await cliFixture();
    await cliAudit('init', c.root, { warn: () => {} }).applied({ payload: { scaffold: 'kit ' } });
    expect(only(c.dataDir).payloadDigest).toBe(payloadDigest({ scaffold: 'kit' }));
  });

  it('B-REDACT-CLI-CONFIG-VALUE: projects tag keeps the field name and a digest of no tag', async () => {
    const c = await cliFixture();
    await cliAudit('projects.tag', c.root, { warn: () => {} }).applied({ payload: { tags: [CONFIG_VALUE] }, fieldNames: ['tags'] });
    const record = only(c.dataDir);
    expect(record.fieldNames).toEqual(['tags']);
    expect(record.payloadDigest).toBe(payloadDigest({ tags: AUDIT_REDACTED_VALUE }));
    expectAbsent(c.dataDir, CONFIG_VALUE);
  });

  it('B-REDACT-CLI-DOOR-SPECIFIC: argv and the model value are removed before hashing', async () => {
    const c = await cliFixture();
    await cliAudit('run', c.root, { warn: () => {} }).applied({ payload: { argv: ['--planted-flag'], model: 'planted-model', steps: 1 } });
    expect(only(c.dataDir).payloadDigest).toBe(payloadDigest({ steps: 1 }));
    expectAbsent(c.dataDir, '--planted-flag', 'planted-model');
  });
});
