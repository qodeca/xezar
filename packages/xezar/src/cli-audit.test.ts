import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditActionRecordSchema, auditCliCommandSchema, type AuditActionRecord } from '@qodeca/xezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_AUDIT_ACTIONS, PROJECTS_SUBCOMMANDS, cliAudit, invocationScope, type CliCommandId } from './cli-audit.ts';
import { AUDIT_TRAIL_FILE } from './mcp/audit-trail.ts';
import { projectDataDir } from './project-data-paths.ts';
import { clearProjectProbeCache, registerProject } from './workspace/projects.ts';
import { runProjectsCommand, type ProjectsCommandIo } from './workspace/projects-cli.ts';

/**
 * #306 part 2 — the command-line door (spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md`
 * § 5). In process, against a sandboxed registry; the same rows against the packed tarball are
 * `test/e2e/package-cli.test.ts`.
 */

const dirs: string[] = [];
const savedHome = process.env.XEZ_HOME;
let io: ProjectsCommandIo;

beforeEach(() => {
  process.env.XEZ_HOME = temp('xez-cli-audit-home-');
  clearProjectProbeCache();
  io = { log: () => {}, error: () => {} };
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.XEZ_HOME;
  else process.env.XEZ_HOME = savedHome;
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

const records = (root: string): AuditActionRecord[] => {
  const path = join(projectDataDir(root), AUDIT_TRAIL_FILE);
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => auditActionRecordSchema.parse(JSON.parse(line)))
    : [];
};

/** What `main` does for `xezar projects <args>`: a door only for a valid word. */
const projects = (invocation: string, ...args: string[]) => {
  const command = PROJECTS_SUBCOMMANDS[args[0] ?? 'list'];
  return runProjectsCommand(args, { defaultRoot: invocation, env: {}, io, ...(command ? { audit: cliAudit(command, invocation) } : {}) });
};

const summary = (record: AuditActionRecord) => [record.actor, record.action, record.outcome];

describe('the cli audit door (#306 part 2)', () => {
  it('maps every command id in the contract to one canonical action, and `rm` to projects.remove', () => {
    expect(Object.keys(CLI_AUDIT_ACTIONS).sort()).toEqual([...auditCliCommandSchema.options].sort());
    for (const action of Object.values(CLI_AUDIT_ACTIONS)) {
      expect(auditActionRecordSchema.shape.action.safeParse(action).success, action).toBe(true);
    }
    expect(PROJECTS_SUBCOMMANDS.rm).toBe('projects.remove');
    expect(PROJECTS_SUBCOMMANDS.tag).toBe('projects.tag'); // B-CLI-PROJECTS-TAG
    expect(PROJECTS_SUBCOMMANDS.bogus).toBeUndefined();
  });

  it('projects list, add, tag, port and remove each write one record to the project they acted on', async () => {
    const invocation = temp('xez-cli-audit-invocation-');
    const target = temp('xez-cli-audit-target-');
    const { id: invocationId } = await registerProject(invocation);

    expect(await projects(invocation)).toBe(0); // bare `projects` is `projects list`
    expect(await projects(invocation, 'add', target)).toBe(0);
    const targetId = (await invocationScope(target))!.projectId;
    expect(await projects(invocation, 'tag', targetId, 'Alpha', 'beta')).toBe(0);
    expect(await projects(invocation, 'port', targetId, '4999')).toBe(0);
    expect(await projects(invocation, 'rm', targetId)).toBe(0);

    expect(records(invocation).map(summary)).toEqual([
      [{ type: 'cli', command: 'projects.list' }, 'cli.projects.list', { status: 'applied' }],
    ]);
    expect(records(invocation)[0]).toMatchObject({ projectId: invocationId, resource: { kind: 'project', id: invocationId } });
    expect(records(target).map(summary)).toEqual([
      [{ type: 'cli', command: 'projects.add' }, 'cli.projects.add', { status: 'applied' }],
      [{ type: 'cli', command: 'projects.tag' }, 'cli.projects.tag', { status: 'applied' }],
      [{ type: 'cli', command: 'projects.port' }, 'cli.projects.port', { status: 'applied' }],
      [{ type: 'cli', command: 'projects.remove' }, 'cli.projects.remove', { status: 'applied' }],
    ]);
    const [, tag, port] = records(target);
    expect(tag).toMatchObject({ fieldNames: ['tags'], payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(port).toMatchObject({ fieldNames: ['port'], payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Names and digests only: no tag, no port, no path.
    const raw = readFileSync(join(projectDataDir(target), AUDIT_TRAIL_FILE), 'utf8');
    for (const value of ['alpha', 'beta', '4999', target]) expect(raw).not.toContain(value);
  });

  it('a refusal before any effect is refused with its reason, in the invocation project', async () => {
    const invocation = temp('xez-cli-audit-refusals-');
    await registerProject(invocation);
    expect(await projects(invocation, 'rm')).toBe(1);
    expect(await projects(invocation, 'remove', 'no-such-project')).toBe(1);
    expect(await projects(invocation, 'tag', 'no-such-project', 'x')).toBe(1);
    expect(await projects(invocation, 'port', 'no-such-project', 'not-a-port')).toBe(1);
    expect(await projects(invocation, 'port', 'no-such-project', '4999')).toBe(1);
    expect(await projects(invocation, 'add', join(invocation, 'missing'))).toBe(1);
    expect(records(invocation).map((record) => [record.action, record.outcome])).toEqual([
      ['cli.projects.remove', { status: 'refused', reason: 'missing_argument' }],
      ['cli.projects.remove', { status: 'refused', reason: 'unknown_project' }],
      ['cli.projects.tag', { status: 'refused', reason: 'unknown_project' }],
      ['cli.projects.port', { status: 'refused', reason: 'invalid_port' }],
      ['cli.projects.port', { status: 'refused', reason: 'unknown_project' }],
      ['cli.projects.add', { status: 'refused', reason: 'not_a_directory' }],
    ]);
  });

  it('single-project mode refuses the registry edits', async () => {
    const invocation = temp('xez-cli-audit-single-');
    await registerProject(invocation);
    for (const word of ['add', 'remove', 'tag', 'port'] as const) {
      const command = PROJECTS_SUBCOMMANDS[word] as CliCommandId;
      expect(await runProjectsCommand([word, 'x'], { defaultRoot: invocation, env: { XEZ_SINGLE_PROJECT: '1' }, io, audit: cliAudit(command, invocation) })).toBe(1);
    }
    expect(records(invocation).map((record) => record.outcome)).toEqual(
      Array.from({ length: 4 }, () => ({ status: 'refused', reason: 'single_project_mode' })),
    );
  });

  it('an unknown projects word writes nothing', async () => {
    const invocation = temp('xez-cli-audit-unknown-');
    await registerProject(invocation);
    expect(await projects(invocation, 'bogus')).toBe(1);
    expect(records(invocation)).toEqual([]);
  });

  it('an ordinary folder with no prior xezar state still gets its one record (M1)', async () => {
    // A folder `shouldRegisterProject` would accept is a project even before anything ever ran
    // there — `xezar init` in a brand-new `git init` folder is the case M1 found silent.
    const plain = temp('xez-cli-audit-plain-');
    expect(existsSync(projectDataDir(plain))).toBe(false);
    await cliAudit('init', plain).applied();
    expect(records(plain).map((record) => record.action)).toEqual(['cli.init']);
    expect(records(plain)[0]!.projectId).toBe((await invocationScope(plain))!.projectId);
    expect(readFileSync(join(plain, '.local', '.gitignore'), 'utf8')).toContain('*');
  });

  it('a task worktree path gets no record and no new .local/xezar — it is not a project', async () => {
    const host = temp('xez-cli-audit-worktree-host-');
    const nested = join(host, '.local', 'xezar', 'worktrees', 'fake-run-id');
    await cliAudit('projects.list', nested).applied();
    await cliAudit('init', nested).refused('anything');
    expect(existsSync(projectDataDir(nested))).toBe(false);
  });

  it('a registered project that was never served gets its data folder created for the record', async () => {
    const root = temp('xez-cli-audit-unserved-');
    await registerProject(root);
    await cliAudit('mcp', root).refused('project_occupied');
    expect(records(root).map((record) => [record.action, record.outcome])).toEqual([
      ['cli.mcp', { status: 'refused', reason: 'project_occupied' }],
    ]);
    expect(readFileSync(join(root, '.local', '.gitignore'), 'utf8')).toContain('*');
  });

  it('a registered project whose data folder cannot be created warns once and never throws', async () => {
    const root = temp('xez-cli-audit-nofolder-');
    await registerProject(root);
    // A file where `.local` should be: the data folder can never be created.
    writeFileSync(join(root, '.local'), 'not a folder');
    const warnings: string[] = [];
    const audit = cliAudit('serve', root, { warn: (m) => warnings.push(m) });
    await expect(audit.applied()).resolves.toBeUndefined();
    await expect(audit.refused('listen_failed')).resolves.toBeUndefined();
    expect(warnings).toEqual(['xezar: audit trail write failed (ENOTDIR); the action continued without an audit record.']);
  });

  it('a record that cannot be written never throws into the command', async () => {
    const root = temp('xez-cli-audit-broken-');
    await registerProject(root);
    mkdirSync(join(projectDataDir(root), AUDIT_TRAIL_FILE), { recursive: true });
    const warnings: string[] = [];
    await expect(cliAudit('serve', root, { warn: (m) => warnings.push(m) }).applied()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
