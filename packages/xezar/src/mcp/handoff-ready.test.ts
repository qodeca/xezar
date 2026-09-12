import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { projectDataDir } from '../project-data-paths.ts';
import { RunStore } from '../runs/store.ts';
import { connectedProviderAuth } from '../server/provider-auth.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { WorkspaceEventBus, createApp } from '../server/server.ts';
import { RunManager } from '../workflows/run.ts';
import { registerProject } from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { runBridge } from './bridge.ts';
import { resolveMcpTarget, startMcpService } from './index.ts';
import { LineFramer, encodeFrame, type McpToolResult } from './ipc.ts';
import { runVersion } from './stale-write.ts';
import { QUALITY_BLOCKER_NEXT_ACTION } from './tools/handoff-git.ts';
import { tools } from './tools/index.ts';
import { withOperationId } from './tools/operation-id.testkit.ts';

/**
 * #262 — a leader marks its own draft pull request ready, through the REAL composed service: the
 * real stdio bridge, the socket `startMcpService` opens, the cockpit's own `createApp`, real git
 * with a bare repository standing in for the remote, and a `gh` on PATH that keeps the forge's
 * state in a file (test/helpers/fake-gh.mjs). `XEZ_DRY_RUN` is OFF: the dry-run forge reports every
 * pull request as already ready, so it could not show a draft becoming ready.
 */

const isWindows = process.platform === 'win32';
const VERSION = '9.9.9-ready';
const REPO = 'acme/demo';
const REMOTE_URL = `https://github.com/${REPO}.git`;
const FAKE_GH = fileURLToPath(new URL('../../test/helpers/fake-gh.mjs', import.meta.url));
const ENV_KEYS = ['XEZ_HOME', 'XEZ_DRY_RUN', 'PATH', 'FAKE_GH_STATE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const tempDirs: string[] = [];
const closers: Array<() => unknown> = [];

const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  tempDirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

interface ForgeState {
  repo: string;
  calls: string[];
  prs: Array<{ number: number; isDraft: boolean; headSha: string }>;
  checks?: Array<{ name: string; conclusion: string }>;
}
let statePath: string;
const forge = (): ForgeState => JSON.parse(readFileSync(statePath, 'utf8')) as ForgeState;
// Only called while no `gh` call is in flight, so it needs none of fake-gh's locking.
const setForge = (patch: Partial<ForgeState>): void => writeFileSync(statePath, JSON.stringify({ ...forge(), ...patch }));

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const home = tmp('xzr-');
  process.env.XEZ_HOME = home;
  delete process.env.XEZ_DRY_RUN;
  writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n', 'utf8');
  process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // `gh` is the fake, first on PATH; it runs under this very node.
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`, 'utf8');
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  statePath = join(home, 'forge.json');
  process.env.FAKE_GH_STATE = statePath;
  writeFileSync(statePath, JSON.stringify({ repo: REPO, calls: [], prs: [] }));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await Promise.resolve(close()).catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A registered GitHub project with the cockpit's own app, store and manager, and one finished
 *  task whose worktree holds unpublished work. */
async function cockpit() {
  const bare = tmp('xzr-remote-');
  git(bare, 'init', '-q', '--bare');
  const root = tmp('xzr-p-');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.local/\n.xezar/\n', 'utf8');
  writeFileSync(join(root, 'README.md'), 'demo\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', REMOTE_URL);
  git(root, 'config', `url.${bare}.pushInsteadOf`, REMOTE_URL);
  git(root, 'push', '-q', 'origin', 'main');
  mkdirSync(join(root, '.xezar'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');

  const { id } = await registerProject(root);
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2 }, load: async () => ({ maxParallel: 2, memoryLimitMb: null }) });
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
  const handle = await startMcpService({ projectId: id, version: VERSION, service: app, store });
  closers.push(() => handle.close());

  const run = store.createRun({ title: 'Ship the widget', workflow: 'quick-task', task: 'ship the widget', steps: [] });
  const wt = await createWorktree(root, run.id, 'main');
  store.updateRun(run.id, { status: 'review', worktreePath: wt.path, branch: wt.branch, baseBranch: 'main' });
  writeFileSync(join(wt.path, 'widget.txt'), 'widget\n', 'utf8');
  return { root, id, store, taskId: run.id };
}

/** The real stdio bridge with a tiny JSON-RPC client in front of it — the leader's side. */
function leader(root: string) {
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
  const call = (args: Record<string, unknown>): Promise<McpToolResult> => {
    const id = next++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      input.write(
        encodeFrame({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          // Every action but the two reads takes a fresh operation key (#264).
          params: { name: 'handoff_git', arguments: withOperationId('handoff_git', args) },
        }),
      );
    });
  };
  /** A business answer: compact JSON in the text block. */
  const act = async (args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await call(args);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    return JSON.parse(result.content[0]!.text) as Record<string, any>;
  };
  return { call, act };
}

describe.skipIf(isWindows)('handoff_git ready — a leader moves its own draft pull request forward (#262)', () => {
  it('opens a draft PR through MCP, marks it ready through MCP, and the forge reports it ready', async () => {
    const c = await cockpit();
    const mcp = leader(c.root);

    const opened = await mcp.act({ action: 'create_pr', taskId: c.taskId, expectedVersion: runVersion(c.store, c.taskId) });
    expect(opened).toMatchObject({ action: 'create_pr', status: 'done', url: `https://github.com/${REPO}/pull/1`, dryRun: false });
    expect(forge().prs).toMatchObject([{ number: 1, isDraft: true }]);

    const before = await mcp.act({ action: 'merge_state', number: 1 });
    expect(before.mergeState).toMatchObject({ isDraft: true, eligibility: 'blocked', canMerge: false });
    expect(before.mergeState.blockers).toContainEqual({ code: 'draft', message: 'Mark the pull request ready for review before merging.' });

    const readied = await mcp.act({ action: 'ready', number: 1, expectedHeadSha: before.mergeState.headSha });
    expect(readied).toEqual({ action: 'ready', status: 'done', number: 1, url: `https://github.com/${REPO}/pull/1`, ready: true });

    // The forge itself says so — its own state, and the fresh read the leader makes next.
    expect(forge().prs).toMatchObject([{ number: 1, isDraft: false }]);
    expect(forge().calls).toContain('pr ready 1');
    const after = await mcp.act({ action: 'merge_state', number: 1 });
    expect(after.mergeState).toMatchObject({ isDraft: false, eligibility: 'ready', canMerge: true });

    // Refused in the service's own words once it is ready, and nothing more reaches the forge.
    const again = await mcp.act({ action: 'ready', number: 1, expectedHeadSha: before.mergeState.headSha });
    expect(again).toEqual({
      action: 'ready',
      status: 'failed',
      refusedBy: 'service',
      httpStatus: 409,
      error: 'This pull request is already ready for review.',
      code: 'already-ready',
    });
    expect(forge().calls.filter((call) => call.startsWith('pr ready'))).toEqual(['pr ready 1']);
  });

  it('refuses a moved head, a failing required check, and an argument that looks like a waiver', async () => {
    const c = await cockpit();
    const mcp = leader(c.root);
    await mcp.act({ action: 'create_pr', taskId: c.taskId, expectedVersion: runVersion(c.store, c.taskId) });
    const { headSha } = forge().prs[0]!;

    const stale = await mcp.act({ action: 'ready', number: 1, expectedHeadSha: 'f'.repeat(40) });
    expect(stale).toMatchObject({
      action: 'ready',
      status: 'conflict',
      code: 'stale-head',
      error: 'The pull request head changed. Review the new commits before marking it ready.',
    });

    setForge({ prs: forge().prs.map((pr) => ({ ...pr, checks: [{ name: 'test', conclusion: 'FAILURE' }] })) });
    const failing = await mcp.act({ action: 'ready', number: 1, expectedHeadSha: headSha });
    expect(failing).toMatchObject({
      action: 'ready',
      status: 'failed',
      refusedBy: 'quality',
      blocker: true,
      blockers: [{ code: 'check-failing', message: 'Required check "test" is failing.' }],
      nextAction: QUALITY_BLOCKER_NEXT_ACTION,
    });
    for (const waiver of [{ force: true }, { qualityException: true }, { overrideRules: true }]) {
      const refused = await mcp.call({ action: 'ready', number: 1, expectedHeadSha: headSha, ...waiver });
      expect(refused.isError, JSON.stringify(waiver)).toBe(true);
    }
    expect(forge().prs[0]!.isDraft, 'still a draft').toBe(true);
    expect(forge().calls.some((call) => call.startsWith('pr ready'))).toBe(false);
  });
});
