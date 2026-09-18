import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliAudit, CliAuditScope } from '../cli-audit.ts';
import { auditAction, classifyMcpCall } from '../mcp/audit-inventory.ts';
import { projectConfigTool, type ProjectConfigContext } from '../mcp/tools/project-config.ts';
import { RunStore } from '../runs/store.ts';
import { resolveStateLayout, setActiveStateLayout } from '../state-layout.ts';
import type { RunManager } from '../workflows/run.ts';
import { allocateProjectSlug, registerProject } from '../workspace/projects.ts';
import { runProjectsCommand, type ProjectsCommandIo } from '../workspace/projects-cli.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * ONE table across the THREE doors a project registry has (#600 PR3, criteria
 * SP-3.1 to SP-3.4).
 *
 * It is one file on purpose. The failure this feature is most likely to ship is
 * BR-6's — a refusal in one door and a silent no-op in another — and three
 * separate per-door suites are exactly how a door gets missed. Every row below
 * names its door, its action and the narrowing that produced it, so a reverted
 * guard fails on that row and says which one.
 *
 * Two narrowings run through the same table:
 *
 * - `env-flag` — `XEZ_SINGLE_PROJECT=1`, which is the SHIPPED behaviour and is
 *   pinned here byte for byte because `BACKWARD_COMPATIBILITY.md` § Single-project
 *   workspace mode promises those exact statuses, sentences and exit codes.
 *   Those rows are GUARD tests: they pass with and without this change, and that
 *   is the point of them.
 * - `project-root` — the folder owns its xezar state (#600). Those rows are the
 *   REGRESSION tests and go red without the widened condition.
 */

/** A `CliAudit` that records what the command settled on, and nothing else. */
function auditSpy(): CliAudit & { readonly refusals: string[] } {
  const refusals: string[] = [];
  const scope = async (): Promise<CliAuditScope | undefined> => undefined;
  return {
    refusals,
    command: 'projects.add',
    applied: async () => {},
    refused: async (reason: string) => {
      refusals.push(reason);
    },
    scope,
    projectScope: scope,
  };
}

function io(): ProjectsCommandIo & { readonly lines: string[]; readonly errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (line) => lines.push(line), error: (line) => errors.push(line) };
}

/** A fixed timestamp: nothing here depends on when it ran. */
const STAMP = '2026-01-01T00:00:00.000Z';

describe('single-project mode — one registry, refused in all three doors (#600)', () => {
  let projectRoot: string;
  let otherRoot: string;
  let foreignParent: string | undefined;
  let store: RunStore;
  const savedFlag = process.env.XEZ_SINGLE_PROJECT;

  beforeEach(async () => {
    // realpath'd: the registry dedupes by realpath, and on macOS `/var` is a
    // symlink, so an un-resolved temp path would not match its own stored row.
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'xez-sp-doors-')));
    otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'xez-sp-other-')));
    store = RunStore.open(join(projectRoot, '.local/xezar'));
    delete process.env.XEZ_SINGLE_PROJECT;
    // A registry with TWO rows is what makes SP-3.1 falsifiable: without the
    // narrowing every door lists both.
    await registerProject(projectRoot);
    await registerProject(otherRoot);
  });

  afterEach(() => {
    setActiveStateLayout(null);
    store.flush();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
    if (foreignParent !== undefined) rmSync(foreignParent, { recursive: true, force: true });
    foreignParent = undefined;
    if (savedFlag === undefined) delete process.env.XEZ_SINGLE_PROJECT;
    else process.env.XEZ_SINGLE_PROJECT = savedFlag;
  });

  /** Put one narrowing in force. Neither is a mode the other can see. */
  const narrow = (narrowing: 'env-flag' | 'project-root' | 'none'): void => {
    if (narrowing === 'env-flag') process.env.XEZ_SINGLE_PROJECT = '1';
    if (narrowing === 'project-root') {
      setActiveStateLayout(resolveStateLayout(projectRoot, ['--single-project'], {}));
    }
  };

  const app = () =>
    createApp({ repoRoot: projectRoot, store, manager: {} as RunManager, version: '0.0.0-test' });

  /** The `project_config` tool called straight, the way the MCP door calls it. */
  const mcp = async (action: string) => {
    const ctx: ProjectConfigContext = {
      project: { id: 'boot', name: 'boot', root: projectRoot },
      xezarVersion: '0.0.0-test',
    };
    const args = projectConfigTool.inputSchema.parse({ action });
    const result = await projectConfigTool.call(args, ctx);
    return {
      isError: result.isError === true,
      structured: result.structuredContent as { refused?: boolean; boundary?: string } | undefined,
      text: result.content[0]?.type === 'text' ? result.content[0].text : '',
    };
  };

  // ---- SP-3.1: the registry holds exactly one entry ------------------------

  it('control: with no narrowing both doors list BOTH registered projects', async () => {
    const res = await apiRequest(app(), '/api/v1/projects');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { projects: unknown[] }).projects).toHaveLength(2);

    const out = io();
    expect(await runProjectsCommand(['list'], { defaultRoot: projectRoot, env: {}, io: out })).toBe(0);
    expect(out.lines.join('\n')).toContain('2 project(s)');
  });

  it('SP-3.1: the project layout answers exactly ONE row, through the API and the CLI', async () => {
    narrow('project-root');

    const res = await apiRequest(app(), '/api/v1/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { root: string }[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.root).toBe(projectRoot);

    const out = io();
    expect(await runProjectsCommand(['list'], { defaultRoot: projectRoot, env: {}, io: out })).toBe(0);
    expect(out.lines.join('\n')).toContain('1 project(s)');
    expect(out.lines.join('\n')).not.toContain(otherRoot);
  });

  it('SP-3.1: a committed workspace.json carrying TWO rows still answers exactly one — the folder', async () => {
    // The case the mode really meets: `workspace.json` travels with a clone, so
    // it can arrive holding rows written on another machine, whose absolute
    // paths mean nothing here. Exactly one row comes back, it is this folder,
    // and its STORED identity (id, name) survives rather than being re-derived.
    mkdirSync(join(projectRoot, '.xezar'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.xezar', 'workspace.json'),
      JSON.stringify({
        projects: [
          { id: 'from-the-clone', root: projectRoot, name: 'From the clone', addedAt: STAMP, lastOpenedAt: STAMP, source: 'local' },
          { id: 'another-machine', root: '/somewhere/else', name: 'Another machine', addedAt: STAMP, lastOpenedAt: STAMP, source: 'local' },
        ],
      }),
    );
    narrow('project-root');

    const res = await apiRequest(app(), '/api/v1/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { id: string; name: string; root: string }[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({ id: 'from-the-clone', name: 'From the clone', root: projectRoot });
  });

  it('SP-3.1/B: a foreign row holding this folder’s slug never drops the only row, and health names the same id', async () => {
    // A committed `workspace.json` that travelled with a clone (#600 defect B):
    // ONE row, for a DIFFERENT folder that happens to share this folder's
    // basename, and none for this folder. The derived row and the boot identity
    // allocate against the STORED ids, so both land on the same suffixed slug —
    // otherwise the derived row is dropped by the boot-id filter and the route
    // answers `projects: []`.
    foreignParent = realpathSync(mkdtempSync(join(tmpdir(), 'xez-sp-slug-')));
    const foreign = join(foreignParent, basename(projectRoot));
    mkdirSync(foreign, { recursive: true });
    mkdirSync(join(projectRoot, '.xezar'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.xezar', 'workspace.json'),
      JSON.stringify({
        projects: [
          {
            id: allocateProjectSlug(projectRoot, []),
            root: foreign,
            name: 'Another machine',
            addedAt: STAMP,
            lastOpenedAt: STAMP,
            source: 'local',
          },
        ],
      }),
    );
    narrow('project-root');

    const res = await apiRequest(app(), '/api/v1/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { id: string; root: string }[]; bootProject: string };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]!.root).toBe(projectRoot);
    expect(body.projects[0]!.id).toBe(body.bootProject);

    // Health reads the same derived row, so the two doors can never name
    // different ids (#600 defect B).
    const health = (await (await apiRequest(app(), '/api/v1/health')).json()) as {
      projects: { id: string }[];
      bootProject: string;
    };
    expect(health.bootProject).toBe(body.bootProject);
    expect(health.projects.map((project) => project.id)).toEqual([body.bootProject]);
  });

  it('SP-3.1: a scoped request for the project this folder is NOT still resolves to nothing', async () => {
    narrow('project-root');
    // The narrowing must not turn every id into the boot project: a
    // `/p/<other>/…` request has to stay the 404 it is in the global layout.
    const res = await apiRequest(app(), '/api/v1/p/xez-sp-other/config');
    expect(res.status).toBe(404);
  });

  // ---- SP-3.2 and SP-3.3: refused in all three doors -----------------------

  /** One HTTP row: the request, and the action word its sentence must name. */
  const HTTP_DOORS = [
    { action: 'adding projects', request: ['/api/v1/projects', { method: 'POST', body: { root: '/tmp' } }] },
    {
      action: 'adding projects',
      request: ['/api/v1/projects/checkout', { method: 'POST', body: { url: 'https://github.com/o/r' } }],
    },
    { action: 'editing projects', request: ['/api/v1/projects/default', { method: 'PATCH', body: { maxParallel: 2 } }] },
    { action: 'removing projects', request: ['/api/v1/projects/default', { method: 'DELETE' }] },
    // SP-3.3: browsing is how Add project reaches the host filesystem, so it is
    // part of the same refusal rather than a separate feature.
    { action: 'folder browsing', request: ['/api/v1/fs/browse?path=/tmp', { method: 'GET' }] },
  ] as const;

  const CLI_DOORS = [
    { words: ['add', '/tmp'], action: 'adding projects' },
    { words: ['remove', 'x'], action: 'removing projects' },
    { words: ['tag', 'x', 'y'], action: 'editing projects' },
    { words: ['port', 'x', '4321'], action: 'editing projects' },
  ] as const;

  const MCP_DOORS = [
    { action: 'add_project', boundary: 'project-registry' },
    { action: 'clone_project', boundary: 'project-registry' },
    { action: 'remove_project', boundary: 'project-registry' },
    // SP-3.3's MCP half.
    { action: 'browse_folders', boundary: 'host-filesystem' },
  ] as const;

  /** The sentence each narrowing refuses with. The `env-flag` half is the promised text. */
  const SENTENCE = {
    'env-flag': (action: string) => `single-project mode is enabled; ${action} is disabled`,
    'project-root': (action: string) => `this project owns its xezar state; ${action} is disabled`,
  } as const;

  describe.each(['env-flag', 'project-root'] as const)('narrowed by %s', (narrowing) => {
    it.each(HTTP_DOORS.map((row) => [row.request[0], row.action] as const))(
      'the HTTP door refuses %s with 409 and nothing else',
      async (path, action) => {
        narrow(narrowing);
        const row = HTTP_DOORS.find((candidate) => candidate.request[0] === path && candidate.action === action)!;
        const [, init] = row.request;
        const res = await apiRequest(app(), path, {
          method: init.method,
          ...('body' in init && init.body
            ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
            : {}),
        });

        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: SENTENCE[narrowing](action) });
      },
    );

    it.each(CLI_DOORS.map((row) => [row.words.join(' '), row.action] as const))(
      'the CLI door refuses `xezar projects %s` with exit 1 and a settled audit reason',
      async (spelling, action) => {
        narrow(narrowing);
        const row = CLI_DOORS.find((candidate) => candidate.words.join(' ') === spelling)!;
        const out = io();
        const audit = auditSpy();

        const code = await runProjectsCommand([...row.words], {
          defaultRoot: projectRoot,
          env: process.env,
          io: out,
          audit,
        });

        expect(code).toBe(1);
        expect(out.errors).toEqual([SENTENCE[narrowing](action)]);
        // SP-3.4 at this door: settled, never silent, and the reason says WHICH
        // narrowing refused. `single_project_mode` is the promised spelling.
        expect(audit.refusals).toEqual([
          narrowing === 'env-flag' ? 'single_project_mode' : 'single_project_root',
        ]);
      },
    );

    it.each(MCP_DOORS.map((row) => [row.action, row.boundary] as const))(
      'the MCP door refuses %s at its boundary and names the mode',
      async (action, boundary) => {
        narrow(narrowing);
        const called = await mcp(action);

        // Unchanged and unconditional: the MCP has never let a project leader
        // manage the registry or browse the host, and PR3 narrows nothing here.
        expect(called.isError).toBe(true);
        expect(called.structured).toMatchObject({ refused: true, boundary });
        // What PR3 adds: the leader is told why there is nothing to manage.
        expect(called.text).toContain('holds this project alone');
      },
    );
  });

  it('control: outside both narrowings the MCP reason says nothing about a mode', async () => {
    const called = await mcp('add_project');
    expect(called.isError).toBe(true);
    expect(called.text).not.toContain('holds this project alone');
  });

  it('control: outside both narrowings the four CLI words are not refused for a mode', async () => {
    const out = io();
    const audit = auditSpy();
    // An unknown project, not a mode — the pre-existing refusal, untouched.
    expect(await runProjectsCommand(['remove', 'no-such-project'], {
      defaultRoot: projectRoot,
      env: {},
      io: out,
      audit,
    })).toBe(1);
    expect(audit.refusals).toEqual(['unknown_project']);
  });

  // ---- SP-3.4: every refusal is classified by the audit inventory ----------

  it('SP-3.4: each refusing door reaches an inventoried action, never an unclassified one', () => {
    // The HTTP routes: the ui door records a 409 as `refused` / `http_409`
    // automatically, but only for a route the shared inventory names. An
    // uninventoried route settles nothing.
    for (const id of ['project.registry.add', 'project.registry.clone', 'project.registry.remove']) {
      expect(auditAction(id)).toBeDefined();
    }

    // The MCP keys the same three actions arrive on. `unclassified` is the
    // falsifier: the door records nothing for it.
    for (const action of ['add_project', 'clone_project', 'remove_project']) {
      expect(classifyMcpCall('project_config', { action }).kind).toBe('mutation');
    }
    // `browse_folders` is deliberately a READ in the inventory — its cockpit
    // counterpart is `GET /api/v1/fs/browse` — so neither door records it, and
    // that stays true in the mode. It is settled, not unclassified.
    expect(classifyMcpCall('project_config', { action: 'browse_folders' }).kind).toBe('read');
  });
});
