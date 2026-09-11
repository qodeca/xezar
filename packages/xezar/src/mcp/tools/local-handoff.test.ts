import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { defineTool, toolListing, type McpTool, type McpToolContext, type McpToolResult } from '../tool.ts';
import { tools } from './index.ts';
import {
  HOSTED_MODE_REASON,
  LOCAL_HANDOFF_ACTIONS,
  XEZAR_HOST_NOTICE,
  localHandoffResultSchema,
  localHandoffTool,
  type LocalHandoffInput,
  type LocalHandoffResult,
} from './local-handoff.ts';

/**
 * `local_handoff` (#98). The service side is the REAL app `createApp` builds, dispatched
 * in-process exactly as the MCP service will, so the capability this tool reads is the one the
 * routes enforce. Nothing here may launch an app on the machine running the suite: the local-mode
 * cases only reach refusals and the read-only app list, and the "no terminal emulator" 409 — which
 * on a developer's Mac would otherwise open Terminal.app — is served by a stub that sends the
 * route's own body shape.
 */

const PROJECT = 'proj-a';
const tempDirs: string[] = [];
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

const saved = { remote: process.env.XEZ_REMOTE, home: process.env.XEZ_HOME, dry: process.env.XEZ_DRY_RUN };
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeEach(() => {
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_REMOTE;
});

afterEach(() => {
  restore('XEZ_REMOTE', saved.remote);
  restore('XEZ_HOME', saved.home);
  restore('XEZ_DRY_RUN', saved.dry);
  delete process.env.XEZ_TEST_HANDOFF_TOKEN;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The real app, and every request it received — method and path, in order. */
function realService(): { service: ServiceDispatch; seen: string[]; root: string } {
  process.env.XEZ_HOME = makeDir('xez-handoff-home-');
  const boot = makeRoot('xez-handoff-boot-');
  const root = makeRoot('xez-handoff-a-');
  const projects: ProjectContextSource[] = [{ id: PROJECT, root, status: 'ok' }];
  const semaphore = new WorkspaceSemaphore({
    initial: { maxParallel: 2 },
    load: async () => ({ maxParallel: 2, memoryLimitMb: null }),
  });
  const app = createApp({
    repoRoot: boot,
    store: RunStore.open(join(boot, '.local/xezar'), { keepLive: true }),
    manager: { isActive: () => false } as unknown as RunManager,
    version: '0.0.0-test',
    bootProjectId: 'boot',
    contexts: new ProjectContexts({ listProjects: async () => projects, semaphore }),
    semaphore,
    providerAuth: connectedProviderAuth(),
  });
  const seen: string[] = [];
  const service: ServiceDispatch = {
    request: (input, init) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(input).pathname}`);
      return app.request(input, init);
    },
  };
  return { service, seen, root };
}

/** A service that answers health with the given capability and each route with a canned answer. */
function stubService(localHandoff: boolean, routes: Record<string, { status: number; body: unknown }>) {
  const seen: string[] = [];
  const service: ServiceDispatch = {
    request: (input, init) => {
      const path = new URL(input).pathname;
      seen.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/health') return Response.json({ capabilities: { localHandoff } });
      const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
      return hit ? Response.json(hit[1].body, { status: hit[1].status }) : Response.json({ error: 'not stubbed' }, { status: 500 });
    },
  };
  return { service, seen };
}

const ctx = (service?: ServiceDispatch): McpToolContext =>
  ({ project: { id: PROJECT, name: 'a', root: '/unused' }, xezarVersion: '0.0.0-test', ...(service ? { service } : {}) }) as McpToolContext;

const call = (args: unknown, service?: ServiceDispatch): Promise<McpToolResult> =>
  localHandoffTool.call(localHandoffTool.inputSchema.parse(args), ctx(service));

const text = (result: McpToolResult): string => result.content.map((c) => c.text).join('\n');
const structured = (result: McpToolResult): LocalHandoffResult => localHandoffResultSchema.parse(result.structuredContent);

/** One valid call per action — every handoff the tool offers. */
const EVERY_ACTION: Record<(typeof LOCAL_HANDOFF_ACTIONS)[number], LocalHandoffInput> = {
  list_apps: { action: 'list_apps' },
  open_task_in_terminal: { action: 'open_task_in_terminal', runId: 'r1' },
  open_task_in_app: { action: 'open_task_in_app', runId: 'r1', target: 'finder' },
  open_project_in_app: { action: 'open_project_in_app', target: 'finder' },
};

describe('local_handoff without a desktop on the xezar host (capabilities.localHandoff false)', () => {
  it('reports every handoff action unavailable with a reason and dispatches nothing but the capability read', async () => {
    process.env.XEZ_REMOTE = '1';
    const { service, seen } = realService();
    expect(Object.keys(EVERY_ACTION)).toEqual([...LOCAL_HANDOFF_ACTIONS]);
    for (const args of Object.values(EVERY_ACTION)) {
      seen.length = 0;
      const result = await call(args, service);
      // Degraded with a reason, never an error (AGENTS.md § Zero config).
      expect(result.isError, args.action).toBeUndefined();
      expect(structured(result)).toMatchObject({
        action: args.action,
        status: 'failed',
        outcome: 'unavailable',
        performed: false,
        affects: 'nothing',
        reason: HOSTED_MODE_REASON,
      });
      expect(text(result)).toContain('hosted mode');
      expect(text(result)).toContain('Nothing was opened');
      // Performs nothing: the service saw the capability read and not one handoff route.
      expect(seen, args.action).toEqual(['GET /api/v1/health']);
    }
  });

  it('fails closed when the capability cannot be read', async () => {
    const seen: string[] = [];
    const service: ServiceDispatch = {
      request: (input) => {
        seen.push(new URL(input).pathname);
        return new Response('boom', { status: 500 });
      },
    };
    const result = await call(EVERY_ACTION.open_project_in_app, service);
    expect(structured(result)).toMatchObject({ outcome: 'unavailable', performed: false, affects: 'nothing' });
    expect(seen).toEqual(['/api/v1/health']);
  });

  it('reads a route that refuses as hosted as unavailable, not as an ordinary failure', async () => {
    const { service } = stubService(true, {
      '/open-in': { status: 409, body: { error: 'local handoff is disabled — this cockpit runs in hosted mode (XEZ_REMOTE)' } },
    });
    const result = await call(EVERY_ACTION.open_project_in_app, service);
    expect(structured(result)).toMatchObject({ outcome: 'unavailable', affects: 'nothing', reason: HOSTED_MODE_REASON });
  });
});

describe('local_handoff with a desktop on the xezar host (capabilities.localHandoff true)', () => {
  it('states on every answer that the action affects the xezar host machine, not the client’s', async () => {
    const { service, seen } = realService();
    const answers = [
      await call(EVERY_ACTION.list_apps, service),
      // Refusals only — nothing below may launch an app on the machine running the suite.
      await call({ action: 'open_project_in_app', target: 'no-such-app-xyz' }, service),
      await call({ action: 'open_task_in_terminal', runId: 'no-such-run' }, service),
      await call({ action: 'open_task_in_app', runId: 'no-such-run', target: 'finder' }, service),
    ];
    for (const result of answers) {
      const s = structured(result);
      expect(s.affects).toBe('xezar-host');
      expect(s.notice).toBe(XEZAR_HOST_NOTICE);
      expect(text(result)).toContain('xezar host machine');
      expect(text(result)).toContain('not on the machine your MCP client runs on');
    }
    const [apps, project, terminal, app] = answers.map(structured);
    expect(apps).toMatchObject({ status: 'done', outcome: 'listed', performed: false });
    expect(apps!.targets!.map((t) => t.id)).toEqual(expect.arrayContaining(['finder', 'terminal']));
    expect(project).toMatchObject({ status: 'failed', outcome: 'refused', performed: false, httpStatus: 400, reason: 'no such app on this machine: no-such-app-xyz' });
    expect(terminal).toMatchObject({ status: 'failed', performed: false, httpStatus: 404 });
    expect(app).toMatchObject({ status: 'failed', performed: false, httpStatus: 404 });
    // Each call went to the bound project's own route, after the capability read.
    expect(seen).toEqual([
      'GET /api/v1/health',
      `GET /api/v1/p/${PROJECT}/open-targets`,
      'GET /api/v1/health',
      `POST /api/v1/p/${PROJECT}/open-in`,
      'GET /api/v1/health',
      `POST /api/v1/p/${PROJECT}/runs/no-such-run/open-in-cli`,
      'GET /api/v1/health',
      `POST /api/v1/p/${PROJECT}/runs/no-such-run/open-in`,
    ]);
  });

  it('reports a successful launch as performed on the xezar host', async () => {
    const { service } = stubService(true, {
      '/open-in': { status: 200, body: { opened: true, path: '/host/checkout' } },
    });
    const result = await call(EVERY_ACTION.open_project_in_app, service);
    expect(structured(result)).toMatchObject({ status: 'done', outcome: 'opened', performed: true, affects: 'xezar-host', path: '/host/checkout' });
    expect(text(result)).toContain('Opened on the xezar host: /host/checkout');
  });

  it('refuses a dot-segment run id without dispatching it', async () => {
    const { service, seen } = stubService(true, {});
    const result = await call({ action: 'open_task_in_terminal', runId: '..' }, service);
    expect(structured(result)).toMatchObject({ status: 'failed', httpStatus: 400 });
    expect(seen).toEqual(['GET /api/v1/health']);
  });
});

describe('local_handoff when the xezar host has no terminal emulator', () => {
  // The route's own 409 body (`server.ts`, `POST /runs/:id/open-in-cli` and the `cli:` branch of
  // `POST /runs/:id/open-in`): the cockpit copies `command` to the clipboard.
  const COMMAND = "cd '/host/worktrees/r1' && claude --resume 0f0e0d0c-aaaa-bbbb-cccc-000000000001";
  const noTerminal = { status: 409, body: { error: 'no terminal emulator found', command: COMMAND } };

  it('returns the open-in-cli fallback command as data, for a terminal on the xezar host', async () => {
    const { service, seen } = stubService(true, { '/open-in-cli': noTerminal });
    const result = await call(EVERY_ACTION.open_task_in_terminal, service);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({
      status: 'failed',
      outcome: 'fallback',
      performed: false,
      affects: 'xezar-host',
      httpStatus: 409,
      fallbackCommand: COMMAND,
      reason: 'no terminal emulator found',
    });
    expect(structured(result).nextAction).toMatch(/terminal on the xezar host/);
    expect(text(result)).toContain(COMMAND);
    expect(seen).toEqual(['GET /api/v1/health', `POST /api/v1/p/${PROJECT}/runs/r1/open-in-cli`]);
  });

  it('returns the same fallback for an agent-CLI target on open-in', async () => {
    const { service } = stubService(true, { '/runs/r1/open-in': noTerminal });
    const result = await call({ action: 'open_task_in_app', runId: 'r1', target: 'cli:claude' }, service);
    expect(structured(result)).toMatchObject({ outcome: 'fallback', fallbackCommand: COMMAND });
  });

  it('withholds a fallback command that names an email-shaped account folder (F-12)', async () => {
    const leaky = "cd '/w' && CLAUDE_CONFIG_DIR='/Users/me/.claude-me@example.com' claude --resume abc";
    const { service } = stubService(true, { '/open-in-cli': { status: 409, body: { error: 'no terminal emulator found', command: leaky } } });
    const result = await call(EVERY_ACTION.open_task_in_terminal, service);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({ status: 'conflict', outcome: 'refused', performed: false });
    expect(structured(result).fallbackCommand).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('me@example.com');
  });

  it('never carries a secret from the environment into the answer (F-15)', async () => {
    process.env.XEZ_TEST_HANDOFF_TOKEN = 'tok-0123456789abcdef';
    const { service } = stubService(true, {
      '/open-in': { status: 409, body: { error: 'could not open finder with tok-0123456789abcdef' } },
    });
    const result = await call(EVERY_ACTION.open_project_in_app, service);
    expect(JSON.stringify(result)).not.toContain('tok-0123456789abcdef');
  });
});

describe('local_handoff arguments and wiring', () => {
  it('answers that it is not connected, and opens nothing, when the service has not handed over its entry', async () => {
    const result = await call(EVERY_ACTION.list_apps);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not connected/);
  });

  it('takes no confirmation and no approval, and refuses fields that do not apply to the action', () => {
    const parse = (args: unknown) => localHandoffTool.inputSchema.safeParse(args).success;
    expect(parse({ action: 'list_apps', confirm: true })).toBe(false);
    expect(parse({ action: 'open_project_in_app', target: 'finder', humanApproved: true })).toBe(false);
    expect(parse({ action: 'open_task_in_terminal' })).toBe(false);
    expect(parse({ action: 'open_project_in_app', target: 'finder', runId: 'r1' })).toBe(false);
    expect(parse({ action: 'open_task_in_terminal', runId: 'r1', target: 'finder' })).toBe(false);
    // No path anywhere (#94's registry-wide guard): not even the single-image handoff.
    expect(parse({ action: 'open_task_in_app', runId: 'r1', target: 'default', path: 'a.png' })).toBe(false);
    for (const args of Object.values(EVERY_ACTION)) expect(parse(args), args.action).toBe(true);
  });

  it('says in its description where it acts and what stays with the human (M-19, D-08)', () => {
    expect(localHandoffTool.description).toContain('XEZAR HOST MACHINE');
    expect(localHandoffTool.description).toMatch(/never on the machine your MCP client runs on/);
    expect(localHandoffTool.description).toMatch(/No per-operation confirmation/);
    expect(localHandoffTool.description).toMatch(/Goal and definition-of-done decisions stay with the human/);
  });
});

// ---- A-22 / F-22 across the WHOLE registry ------------------------------------------------------

/**
 * A parameter, or an action value, that would let a human approve weakening a quality gate or an
 * acceptance criterion. Matched against every property name and every enum/const string in each
 * tool's published input schema, at any depth.
 *
 * Deliberately NOT matched: `overrideRules` on the merge tool (I-076: "a repository-permission
 * escape, not a quality waiver — F-22 still forbids weakening gates"), a composer's `reviewGate`
 * toggle, and `accept_review`, which accepts a finished review rather than waiving a failed one.
 */
const QUALITY_BYPASS_RE = new RegExp(
  [
    'bypass',
    'waive',
    'waiver',
    'exception',
    // Words may sit between the verb and the control: `ignoreFailingTests`, `skip_required_checks`.
    '(skip|ignore|override|disable|suppress)[a-z_-]*?(quality|gate|check|test|validation|acceptance|criteri)',
    'force[_-]?(merge|pass|green|done|complete|accept)',
    'admin[_-]?merge',
    '(human|user|owner)[_-]?approv',
    'approved[_-]?by',
    'no[_-]?verify',
  ].join('|'),
  'i',
);

/** Every property name and enum/const string in a JSON Schema, with the path it sits at. */
function schemaWords(schema: unknown, at = '$'): Array<{ at: string; word: string }> {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema)) return schema.flatMap((item, i) => schemaWords(item, `${at}[${i}]`));
  const node = schema as Record<string, unknown>;
  const words: Array<{ at: string; word: string }> = [];
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties as Record<string, unknown>)) {
      words.push({ at, word: key }, ...schemaWords(child, `${at}.${key}`));
    }
  }
  for (const value of [...(Array.isArray(node.enum) ? node.enum : []), node.const]) {
    if (typeof value === 'string') words.push({ at, word: value });
  }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not', 'prefixItems', '$defs', 'definitions']) {
    if (key in node) words.push(...schemaWords(node[key], `${at}.${key}`));
  }
  return words;
}

function qualityBypasses(tool: McpTool): string[] {
  return schemaWords(toolListing(tool).inputSchema)
    .filter(({ word }) => QUALITY_BYPASS_RE.test(word))
    .map(({ at, word }) => `${tool.name} ${at}: ${word}`);
}

describe('no MCP tool offers a human-approved quality bypass (A-22, F-22)', () => {
  it('walks a populated registry — an empty list would pass anything', () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain('local_handoff');
  });

  it('finds no bypass, waiver or approval-to-weaken parameter or action in any registered tool', () => {
    expect(tools.flatMap(qualityBypasses)).toEqual([]);
  });

  it('the detector catches every shape of bypass, at any depth, and passes the decided non-waivers', () => {
    const offending = defineTool({
      name: 'offending_example',
      description: 'control',
      inputSchema: z.object({
        action: z.enum(['merge', 'force_merge', 'merge_with_exception']),
        humanApprovedBypass: z.boolean().optional(),
        options: z.object({ skipQualityGate: z.boolean(), waiveChecks: z.boolean() }).optional(),
        list: z.array(z.object({ approvedBy: z.string(), ignoreFailingTests: z.boolean() })).optional(),
        either: z.union([z.object({ noVerify: z.boolean() }), z.object({ acceptanceException: z.string() })]).optional(),
      }),
      call: async () => ({ content: [] }),
    });
    const found = qualityBypasses(offending).map((line) => line.split(': ')[1]);
    expect(found).toEqual(
      expect.arrayContaining([
        'force_merge',
        'merge_with_exception',
        'humanApprovedBypass',
        'skipQualityGate',
        'waiveChecks',
        'approvedBy',
        'ignoreFailingTests',
        'noVerify',
        'acceptanceException',
      ]),
    );
    expect(found).toHaveLength(9);

    const decided = defineTool({
      name: 'decided_example',
      description: 'control',
      inputSchema: z.object({
        action: z.enum(['merge', 'accept_review', 'close_session']),
        overrideRules: z.boolean().optional(),
        reviewGate: z.boolean().optional(),
        runnerOverride: z.string().optional(),
      }),
      call: async () => ({ content: [] }),
    });
    expect(qualityBypasses(decided)).toEqual([]);
  });
});
