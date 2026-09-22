// FIRST import on purpose: the home pin is a module-load side effect and must run before anything
// that reaches `skills.ts` (#671).
import './mcp-test-home.testkit.ts';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../../runs/store.ts';
import { recordOwnListen } from '../../server/instance-liveness.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { cockpitLinks, cockpitOrigin, localHandoffNow } from '../cockpit-address.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import type { McpTool, McpToolContext, McpToolResult } from '../tool.ts';
import { discoverProjectTool } from './discovery.ts';
import { localHandoffTool } from './local-handoff.ts';
import { NEW_OPERATION_ID, projectConfigTool } from './project-config.ts';

/**
 * #838 E3, E4 and F — a refusal's next step is only worth what its FIRST call is worth.
 *
 * E3: a next step that names a tool must carry the exact arguments, and those arguments — pasted
 * as written, with only the fresh-key and app-id placeholders filled in — must be accepted on the
 * first call. Reading "turn it on with set_workspace_config and skillsAutoUpdate true" produced a
 * refused top-level `skillsAutoUpdate`; a step that only LOOKS right is what these cases catch.
 * E4: a next step that points at `local_handoff` is offered only where `local_handoff` can work.
 * F: the refusal next steps read the cockpit address through the one hosted-checked accessor.
 */

const PROJECT = 'proj-next';
const APP_ID_PLACEHOLDER = '<app id from list_apps>';

const tempDirs: string[] = [];
const stores: RunStore[] = [];
const servers: HttpServer[] = [];
const saved = { remote: process.env.XEZ_REMOTE, home: process.env.XEZ_HOME, dry: process.env.XEZ_DRY_RUN };

const makeDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};
const makeRoot = (prefix: string): string => {
  const root = makeDir(prefix);
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  return root;
};

beforeEach(() => {
  process.env.XEZ_HOME = makeDir('xez-next-home-');
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_REMOTE;
});

afterEach(async () => {
  recordOwnListen(null, true);
  for (const [key, value] of [['XEZ_REMOTE', saved.remote], ['XEZ_HOME', saved.home], ['XEZ_DRY_RUN', saved.dry]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The real app, except that a launch is captured instead of performed: nothing in this suite may
 * open an application on the machine running it. Everything else — the capability read, the app
 * list, the workspace-config write — is the cockpit's own route.
 */
function service(): { service: ServiceDispatch; launched: unknown[]; root: string } {
  const boot = makeRoot('xez-next-boot-');
  const root = makeRoot('xez-next-a-');
  const projects: ProjectContextSource[] = [{ id: PROJECT, root, status: 'ok' }];
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
  const store = RunStore.open(join(boot, '.local/xezar'), { keepLive: true });
  stores.push(store);
  const app = createApp({
    repoRoot: boot,
    store,
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts: new ProjectContexts({ listProjects: async () => projects, semaphore }),
    semaphore,
    providerAuth: connectedProviderAuth(),
  });
  const launched: unknown[] = [];
  return {
    launched,
    root,
    service: {
      request: (input, init) => {
        if ((init?.method ?? 'GET') === 'POST' && new URL(input).pathname === `/api/v1/p/${PROJECT}/open-in`) {
          launched.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
          return Promise.resolve(Response.json({ opened: true, path: root }));
        }
        return app.request(input, init);
      },
    },
  };
}

const ctx = (svc: ServiceDispatch | undefined, root = '/unused'): McpToolContext & { service?: ServiceDispatch } => ({
  project: { id: PROJECT, name: 'Next', root },
  xezarVersion: '0.0.0-test',
  ...(svc ? { service: svc } : {}),
});

/** Exactly what the service does with a call: validate against the tool's schema, then call. */
async function callAsWritten(tool: McpTool, args: unknown, context: McpToolContext): Promise<McpToolResult & { invalid?: string }> {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) return { content: [{ type: 'text', text: parsed.error.message }], isError: true, invalid: parsed.error.message };
  return tool.call(parsed.data, context);
}

const TOOLS: Record<string, McpTool> = { project_config: projectConfigTool, local_handoff: localHandoffTool };

/** Every copy-ready call a next step names: `<tool> with \`{…}\``, in order. */
function namedCalls(next: string): Array<{ tool: string; args: Record<string, unknown> }> {
  return [...next.matchAll(/\b([a-z_]+) with `(\{[^`]+\})`/g)].map((m) => ({ tool: m[1]!, args: JSON.parse(m[2]!) as Record<string, unknown> }));
}

/** The only edits a leader makes: a fresh operation key, and the app id `list_apps` returned. */
function fill(args: Record<string, unknown>, fresh: string, appId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = value === NEW_OPERATION_ID ? fresh : value === APP_ID_PLACEHOLDER ? appId : value;
  }
  // Nothing else in the step may be a placeholder: every other value is used exactly as written.
  expect(JSON.stringify(out)).not.toMatch(/[<>]/);
  return out;
}

async function refusal(action: string, svc?: ServiceDispatch): Promise<string> {
  const result = await callAsWritten(projectConfigTool, { action }, ctx(svc));
  expect(result.isError).toBe(true);
  const next = (result.structuredContent as { refused?: boolean; nextStep?: unknown }).nextStep;
  expect(typeof next).toBe('string');
  return next as string;
}

async function listening(): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port };
}

describe('refusal next steps are accepted on the first call (#838 E3)', () => {
  // Break: the next step naming `set_workspace_config` and `skillsAutoUpdate true` without the
  // `workspaceConfig` wrapper or the operation key — the first call is refused.
  it('apply_skill_updates: the set_workspace_config call it shows turns auto-update on, first time', async () => {
    const { service: svc } = service();
    const next = await refusal('apply_skill_updates');
    const calls = namedCalls(next);
    expect(calls.map((c) => c.tool)).toEqual(['project_config']);
    expect(calls[0]!.args).toEqual({ action: 'set_workspace_config', workspaceConfig: { skillsAutoUpdate: true }, operationId: NEW_OPERATION_ID });

    const result = await callAsWritten(projectConfigTool, fill(calls[0]!.args, 'op-838-e3-skills'), ctx(svc));
    expect(result.invalid).toBeUndefined();
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const read = await callAsWritten(projectConfigTool, { action: 'get_limits' }, ctx(svc));
    expect(JSON.stringify(read.structuredContent)).toContain('"skillsAutoUpdate":{"effective":true');
  });

  // Break: "Call local_handoff with action open_project_in_app" — no `target`, no operation key.
  it('open_in_app: list_apps, then open_project_in_app with a listed app id, each accepted first time', async () => {
    const { service: svc, launched, root } = service();
    const next = await refusal('open_in_app');
    const calls = namedCalls(next);
    expect(calls.map((c) => `${c.tool}:${String(c.args.action)}`)).toEqual(['local_handoff:list_apps', 'local_handoff:open_project_in_app']);

    const listed = await callAsWritten(TOOLS[calls[0]!.tool]!, fill(calls[0]!.args, 'unused-key'), ctx(svc, root));
    expect(listed.invalid).toBeUndefined();
    const apps = (listed.structuredContent as { outcome: string; targets: Array<{ id: string }> });
    expect(apps.outcome).toBe('listed');
    const appId = apps.targets[0]!.id;

    const opened = await callAsWritten(TOOLS[calls[1]!.tool]!, fill(calls[1]!.args, 'op-838-e3-open', appId), ctx(svc, root));
    expect(opened.invalid).toBeUndefined();
    expect(opened.structuredContent).toMatchObject({ action: 'open_project_in_app', status: 'done', outcome: 'opened', performed: true });
    expect(launched).toEqual([{ target: appId }]);
  });

  // Control: the fresh-key placeholder is deliberately not a valid key, so pasting a step without
  // filling it in is told to supply one — it can never replay an earlier operation's answer.
  it('refuses the placeholder key itself, so an unfilled paste fails loudly instead of replaying', async () => {
    const calls = namedCalls(await refusal('apply_skill_updates'));
    const result = await callAsWritten(projectConfigTool, calls[0]!.args, ctx(undefined));
    expect(result.invalid).toMatch(/operationId/);
  });
});

describe('the open_in_app next step follows localHandoff (#838 E4)', () => {
  // Break: an unconditional next step pointing a hosted leader at a tool that answers every action
  // `unavailable` there.
  it('points at local_handoff when this xezar can open applications on its host', async () => {
    expect(localHandoffNow()).toBe(true);
    expect(await refusal('open_in_app')).toContain('local_handoff');
  });

  it('points at the person instead, and never at local_handoff, in hosted mode', async () => {
    process.env.XEZ_REMOTE = '1';
    expect(localHandoffNow()).toBe(false);
    const next = await refusal('open_in_app');
    expect(next).not.toContain('local_handoff');
    expect(next).toContain('hosted mode');
    expect(next).toContain('Ask the person to open the project folder');
  });
});

describe('one hosted re-check for the recorded cockpit address (#838 F)', () => {
  // Break: any reader returning the address `serve` recorded while it was local, after XEZ_REMOTE
  // was turned on — the flip the code permits, because the capability is read per request.
  it('hands out no address from any reader once XEZ_REMOTE is set after the address was recorded', async () => {
    const { server, port } = await listening();
    recordOwnListen(server, true);
    const origin = `http://127.0.0.1:${port}`;
    // Control: while local, every reader returns it.
    expect(cockpitOrigin()).toBe(origin);
    expect(cockpitLinks(PROJECT)?.url).toBe(`${origin}/p/${PROJECT}/`);
    expect(await refusal('connect_provider')).toContain(origin);
    const root = makeRoot('xez-next-discover-');
    const before = await discoverProjectTool.call({}, ctx(undefined, root));
    expect(before.structuredContent).toHaveProperty('cockpit.url', `${origin}/p/${PROJECT}/`);

    process.env.XEZ_REMOTE = '1';
    expect(cockpitOrigin()).toBeUndefined();
    expect(cockpitLinks(PROJECT)).toBeUndefined();
    for (const action of ['connect_provider', 'open_account_file']) {
      const next = await refusal(action);
      expect(next, action).not.toMatch(/https?:\/\//);
      expect(next, action).toContain('in the running cockpit (no address is recorded here)');
    }
    const after = await discoverProjectTool.call({}, ctx(undefined, root));
    expect(after.structuredContent).not.toHaveProperty('cockpit');
    expect(after.content[0]!.text).not.toContain(origin);
  });

  // Break: the accessor ignoring the environment it is handed, so a caller's own env is not honoured.
  it('reads the environment it is given', async () => {
    const { server, port } = await listening();
    recordOwnListen(server, true);
    expect(cockpitOrigin({})).toBe(`http://127.0.0.1:${port}`);
    expect(cockpitOrigin({ XEZ_REMOTE: '1' })).toBeUndefined();
    expect(localHandoffNow({ XEZ_REMOTE: '1' })).toBe(false);
  });
});
