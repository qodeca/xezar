import type { GithubPrMergeState } from '@qodeca/xezar-contract';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../../git-worktree.ts';
import { RunStore } from '../../runs/store.ts';
import { ProjectContexts, type ProjectContextSource } from '../../server/project-context.ts';
import { connectedProviderAuth } from '../../server/provider-auth.testkit.ts';
import { createApp } from '../../server/server.ts';
import { versionForTest } from './version.testkit.ts';
import type { RunManager } from '../../workflows/run.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { IPC_PROTOCOL_VERSION, LineFramer, encodeFrame, type McpToolResult } from '../ipc.ts';
import type { ServiceDispatch } from '../service-adapter.ts';
import { listenMcpSocket, type McpServiceHandle } from '../service.ts';
import { defineTool, toolListing, type McpTool, type McpToolContext } from '../tool.ts';
import { QUALITY_BLOCKER_NEXT_ACTION, handoffGitTool, qualityBlockers, readyBlockers } from './handoff-git.ts';
import { tools } from './index.ts';

/**
 * `handoff_git` (#96) driven the way a leader drives it: a `tools/call` frame over the project's own
 * MCP socket, answered by the real service loop and the real `createApp`, against real git
 * repositories (a bare repository stands in for the remote through `pushInsteadOf`, and
 * `XEZ_DRY_RUN=1` fakes only the PR URL and the forge's merge state). The one hop that is not
 * production is `wired()`: `McpToolContext` does not carry the service entry yet, so the test hands
 * it over the way the service will.
 */

const isWindows = process.platform === 'win32';
const COCKPIT_HOST = '127.0.0.1:4321';
const REMOTE_URL = 'https://github.com/acme/demo.git';
/** The head sha the dry-run forge reports for every pull request (`fetchPrMergeState`). */
const DRY_HEAD = '0123456789abcdef0123456789abcdef01234567';

type Body = Record<string, unknown>;

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe.skipIf(isWindows)('handoff_git — commit, push, draft PR, merge and branches (#96)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'XEZ_HOME',
    'XEZ_DRY_RUN',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'EMAIL',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ];
  let dirs: string[];
  let roots: { cockpit: string; leader: string; plain: string; boot: string };
  let bare: string;
  let contexts: ProjectContexts;
  let app: ReturnType<typeof createApp>;
  let sockets: McpServiceHandle[];
  let socketPath: Record<'leader' | 'plain', string>;
  /** Every request the tool dispatched, as `METHOD /path`, with its JSON body. */
  let dispatched: Array<{ call: string; body: unknown }>;
  /** When set, the fresh merge state the tool reads is this fixture instead of the dry-run one. */
  let mergeStateFixture: GithubPrMergeState | undefined;
  /** When set, the service's answer to the merge POST itself (the request is still recorded). */
  let mergeAnswerFixture: { status: number; body: Body } | undefined;

  const makeDir = (prefix: string, base = realpathSync(tmpdir())): string => {
    const dir = realpathSync(mkdtempSync(join(base, prefix)));
    dirs.push(dir);
    return dir;
  };

  /** A git repository with one commit; with a remote whose pushes land in `bare`. */
  const makeRepo = (prefix: string, withRemote: boolean): string => {
    const root = makeDir(prefix);
    mkdirSync(join(root, '.xezar'), { recursive: true });
    writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    mkdirSync(join(root, '.hooks'), { recursive: true });
    sh(root, 'init', '-q', '-b', 'main');
    sh(root, 'config', 'user.name', 'Test');
    sh(root, 'config', 'user.email', 'test@example.com');
    sh(root, 'config', 'commit.gpgsign', 'false');
    sh(root, 'config', 'core.hooksPath', join(root, '.hooks'));
    writeFileSync(join(root, '.gitignore'), '.local/\n.xezar/\n.hooks/\n', 'utf8');
    writeFileSync(join(root, 'README.md'), 'demo\n', 'utf8');
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'init');
    if (withRemote) {
      sh(root, 'remote', 'add', 'origin', REMOTE_URL);
      sh(root, 'config', `url.${bare}.pushInsteadOf`, REMOTE_URL);
    }
    return root;
  };

  const wired = (service: ServiceDispatch): McpTool =>
    defineTool({
      ...handoffGitTool,
      call: (args, ctx) => handoffGitTool.call(args, { ...ctx, service } as McpToolContext),
    });

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    dirs = [];
    // The socket path has a hard OS limit (~104 bytes); a task's TMPDIR can be longer than that.
    const home = makeDir('xez-hg-', realpathSync('/tmp'));
    process.env.XEZ_HOME = home;
    process.env.XEZ_DRY_RUN = '1';
    // Hermetic git: no developer identity, hooks path or signing config leaks in.
    const emptyGlobal = join(home, 'gitconfig');
    writeFileSync(emptyGlobal, '', 'utf8');
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const key of ENV_KEYS.slice(4)) delete process.env[key];

    bare = makeDir('xez-hg-remote-');
    sh(bare, 'init', '-q', '--bare');
    roots = {
      cockpit: makeRepo('xez-hg-cockpit-', true),
      leader: makeRepo('xez-hg-leader-', true),
      plain: makeRepo('xez-hg-plain-', false),
      // The boot project HAS a remote, so `/health` would say "push is possible" for any project.
      boot: makeRepo('xez-hg-boot-', true),
    };
    const projects: ProjectContextSource[] = [
      { id: 'cockpit', root: roots.cockpit, status: 'ok' },
      { id: 'leader', root: roots.leader, status: 'ok' },
      { id: 'plain', root: roots.plain, status: 'ok' },
    ];
    const semaphore = new WorkspaceSemaphore({
      initial: { maxParallel: 2 },
      load: async () => ({ maxParallel: 2, memoryLimitMb: null }),
    });
    contexts = new ProjectContexts({ listProjects: async () => projects, semaphore });
    app = createApp({
      repoRoot: roots.boot,
      store: RunStore.open(join(roots.boot, '.local/xezar'), { keepLive: true }),
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      bootProjectId: 'boot',
      contexts,
      semaphore,
      providerAuth: connectedProviderAuth(),
    });

    dispatched = [];
    mergeStateFixture = undefined;
    mergeAnswerFixture = undefined;
    const service: ServiceDispatch = {
      request: async (input, init) => {
        const url = new URL(input);
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        dispatched.push({ call: `${init?.method ?? 'GET'} ${url.pathname}`, body });
        if (mergeStateFixture && url.pathname.endsWith('/merge-state')) {
          return new Response(JSON.stringify({ available: true, mergeState: mergeStateFixture }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (mergeAnswerFixture && init?.method === 'POST' && url.pathname.endsWith('/merge')) {
          return new Response(JSON.stringify(mergeAnswerFixture.body), {
            status: mergeAnswerFixture.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return app.request(input, init);
      },
    };
    const tool = wired(service);
    sockets = [
      await listenMcpSocket({ project: { id: 'leader', name: 'Leader', root: roots.leader }, version: '0.0.0-test', tools: [tool] }),
      await listenMcpSocket({ project: { id: 'plain', name: 'Plain', root: roots.plain }, version: '0.0.0-test', tools: [tool] }),
    ];
    socketPath = { leader: sockets[0]!.path, plain: sockets[1]!.path };
  });

  afterEach(() => {
    for (const socket of sockets) socket.close();
    contexts.disposeAll();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** One `tools/call` over a project's socket, exactly as the bridge sends it. */
  /** A leader reads a task right before it commits, pushes or publishes it (#250); the version rule
   *  itself is pinned in `stale-write-tools.test.ts`. */
  async function call(args: Record<string, unknown>, project: 'leader' | 'plain' = 'leader'): Promise<McpToolResult> {
    if (['commit', 'push', 'create_pr'].includes(String(args.action)) && !('expectedVersion' in args)) {
      args = { ...args, expectedVersion: await versionForTest(app, project, args.taskId) };
    }
    return callRaw(args, project);
  }

  function callRaw(args: Record<string, unknown>, project: 'leader' | 'plain' = 'leader'): Promise<McpToolResult> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath[project]);
      // On a session, as the bridge sends it (#302): `session/open` first, then the call.
      const framer = new LineFramer(
        (line) => {
          const response = JSON.parse(line) as { id: number; ok: boolean; result?: McpToolResult; error?: { message: string } };
          if (response.id === 0 && response.ok) {
            socket.write(
              encodeFrame({ v: IPC_PROTOCOL_VERSION, id: 1, method: 'tools/call', params: { name: 'handoff_git', arguments: args } }),
            );
            return;
          }
          socket.end();
          if (response.ok) resolve(response.result!);
          else reject(new Error(response.error?.message));
        },
        () => reject(new Error('oversized frame')),
      );
      socket.on('data', (chunk: Buffer) => framer.push(chunk));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, id: 0, method: 'session/open' })));
    });
  }

  const text = (result: McpToolResult): string => result.content[0]!.text;

  /** A business answer: never a tool malfunction, always compact JSON. */
  async function act(args: Record<string, unknown>, project: 'leader' | 'plain' = 'leader'): Promise<Body> {
    const result = await call(args, project);
    expect(result.isError, text(result)).toBeFalsy();
    return JSON.parse(text(result)) as Body;
  }

  async function argumentError(args: Record<string, unknown>): Promise<string> {
    const result = await call(args);
    expect(result.isError, text(result)).toBe(true);
    return text(result);
  }

  /** The cockpit's own request: same-origin, from the loopback deployment a browser talks to. */
  async function cockpit(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: Body }> {
    const res = await app.request(path, {
      method,
      headers: {
        host: COCKPIT_HOST,
        origin: `http://${COCKPIT_HOST}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Body };
  }

  const store = async (project: 'cockpit' | 'leader' | 'plain') => (await contexts.context(project)).store;

  /** A finished task of `project` with its own worktree, and optionally one uncommitted file. */
  async function task(
    project: 'cockpit' | 'leader' | 'plain',
    options: { file?: boolean; patch?: Record<string, unknown> } = {},
  ): Promise<{ id: string; worktree: string; branch: string }> {
    const runs = await store(project);
    const run = runs.createRun({ title: 'Ship the widget', workflow: 'quick-task', task: 'ship the widget', steps: [] });
    const wt = await createWorktree(roots[project], run.id, 'main');
    runs.updateRun(run.id, {
      status: 'review',
      worktreePath: wt.path,
      branch: wt.branch,
      baseBranch: 'main',
      ...options.patch,
    });
    if (options.file !== false) writeFileSync(join(wt.path, 'widget.txt'), 'widget\n', 'utf8');
    return { id: run.id, worktree: wt.path, branch: wt.branch };
  }

  const merges = () => dispatched.filter((d) => d.call.endsWith('/merge') && d.call.startsWith('POST'));

  // ---- acceptance: the hand-onward path ----------------------------------------------------

  it('commits, pushes and opens a draft PR through MCP with no confirmation parameter, writing the cockpit’s records', async () => {
    const c = await task('cockpit');
    const l = await task('leader');
    const message = 'Add the widget';

    // The cockpit path, click by click.
    expect((await cockpit(`/api/v1/p/cockpit/runs/${c.id}/git/commit`, 'POST', { message })).status).toBe(200);
    const cockpitPush = await cockpit(`/api/v1/p/cockpit/runs/${c.id}/git/push`, 'POST');
    expect(cockpitPush.status).toBe(200);
    const cockpitPr = await cockpit(`/api/v1/p/cockpit/runs/${c.id}/pr`, 'POST');
    expect(cockpitPr.status).toBe(201);

    // The leader path: three calls, none carrying anything but the action and its subject.
    const committed = await act({ action: 'commit', taskId: l.id, message });
    expect(committed).toMatchObject({ action: 'commit', status: 'done', task: { id: l.id } });
    expect(committed.sha).toBe(sh(l.worktree, 'rev-parse', 'HEAD'));
    expect((committed.task as Body).revision).toBe(committed.sha);
    const pushed = await act({ action: 'push', taskId: l.id });
    expect(pushed).toMatchObject({
      action: 'push',
      status: 'done',
      branch: l.branch,
      remote: cockpitPush.body.remote,
      upstreamSet: cockpitPush.body.upstreamSet,
    });
    const pr = await act({ action: 'create_pr', taskId: l.id });
    expect(pr).toMatchObject({ action: 'create_pr', status: 'done', url: cockpitPr.body.url, dryRun: true });

    // The same git effects: the same commit subject and tree, and each branch really on the remote.
    for (const t of [c, l]) {
      expect(sh(t.worktree, 'log', '-1', '--format=%s')).toBe(message);
      expect(sh(bare, 'rev-parse', `refs/heads/${t.branch}`)).toBe(sh(t.worktree, 'rev-parse', 'HEAD'));
    }
    expect(sh(l.worktree, 'rev-parse', 'HEAD^{tree}')).toBe(sh(c.worktree, 'rev-parse', 'HEAD^{tree}'));

    // The same records: the run record and the event log the cockpit's click writes.
    const cockpitRun = (await store('cockpit')).getRun(c.id)!;
    const leaderRun = (await store('leader')).getRun(l.id)!;
    expect({ status: leaderRun.status, url: leaderRun.pullRequestUrl }).toEqual({
      status: cockpitRun.status,
      url: cockpitRun.pullRequestUrl,
    });
    expect(leaderRun.status).toBe('done');
    expect(leaderRun.finishedAt).toBeDefined();
    const events = (runs: RunStore, id: string) =>
      runs.readEvents(id).map((e) => `${e.type}:${String((e as { message?: unknown }).message ?? '')}`);
    expect(events(await store('leader'), l.id)).toEqual(events(await store('cockpit'), c.id));

    // Nothing to confirm: no argument of the tool is a confirmation.
    const properties = Object.keys((toolListing(handoffGitTool).inputSchema as { properties: Body }).properties);
    expect(properties.filter((p) => /confirm|approv|sure|ack/i.test(p))).toEqual([]);
    expect(tools).toContain(handoffGitTool);
  });

  // ---- commit ------------------------------------------------------------------------------

  it('applies the cockpit’s commit policy, and passes the service’s own 409 text through unchanged', async () => {
    // The cockpit's availability policy, in its own sentences, before anything is dispatched.
    const running = await task('leader', { patch: { status: 'running' } });
    expect(await act({ action: 'commit', taskId: running.id, message: 'x' })).toMatchObject({
      status: 'failed',
      refusedBy: 'policy',
      error: 'Commit unavailable — the agent is still working in this worktree',
    });
    const empty = await task('leader', { file: false });
    expect(await act({ action: 'commit', taskId: empty.id, message: 'x' })).toMatchObject({
      status: 'failed',
      refusedBy: 'policy',
      error: 'Commit unavailable — no changes to commit',
    });
    const inPlace = (await store('leader')).createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    (await store('leader')).updateRun(inPlace.id, { status: 'done' });
    expect(await act({ action: 'commit', taskId: inPlace.id, message: 'x' })).toMatchObject({
      error: 'Commit unavailable — no worktree — this task ran directly in the repo working tree',
    });
    expect(dispatched.filter((d) => d.call.endsWith('/git/commit'))).toEqual([]);

    /** The service's refusal as the cockpit receives it, then as the leader receives it. */
    const bothRefusals = async (id: string) => {
      const viaCockpit = await cockpit(`/api/v1/p/leader/runs/${id}/git/commit`, 'POST', { message: 'Add the widget' });
      expect(viaCockpit.status).toBe(409);
      const viaMcp = await act({ action: 'commit', taskId: id, message: 'Add the widget' });
      expect(viaMcp).toMatchObject({ status: 'failed', refusedBy: 'service', httpStatus: 409 });
      expect(viaMcp.error).toBe(viaCockpit.body.error);
      return viaMcp.error as string;
    };

    // A clean tree whose work is already committed: the task has changes, the tree has none.
    const clean = await task('leader');
    sh(clean.worktree, 'add', '-A');
    sh(clean.worktree, 'commit', '-q', '-m', 'by hand');
    expect(await bothRefusals(clean.id)).toBe('nothing to commit — the working tree is clean');

    // A failing hook.
    const hooked = await task('leader');
    const hook = join(roots.leader, '.hooks', 'pre-commit');
    writeFileSync(hook, "#!/bin/sh\necho 'pre-commit: lint failed on widget.txt' >&2\nexit 1\n", 'utf8');
    chmodSync(hook, 0o755);
    expect(await bothRefusals(hooked.id)).toBe('pre-commit: lint failed on widget.txt');
    rmSync(hook);

    // A missing identity.
    const anonymous = await task('leader');
    sh(roots.leader, 'config', '--unset', 'user.name');
    sh(roots.leader, 'config', '--unset', 'user.email');
    sh(roots.leader, 'config', 'user.useConfigOnly', 'true');
    expect(await bothRefusals(anonymous.id)).toMatch(/identity/i);
  });

  it('scrubs a secret out of the service’s refusal text before it reaches the leader (F-15)', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const t = await task('leader');
    const hook = join(roots.leader, '.hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho 'hook leaked ${token}' >&2\nexit 1\n`, 'utf8');
    chmodSync(hook, 0o755);
    const result = await call({ action: 'commit', taskId: t.id, message: 'x' });
    expect(text(result)).not.toContain(token);
    expect(JSON.parse(text(result))).toMatchObject({ error: 'hook leaked [REDACTED]' });
  });

  // ---- push --------------------------------------------------------------------------------

  it('reads the remote from the bound project’s /repo, not /health, and passes push refusals through', async () => {
    // `/health` describes the BOOT project, which has a remote.
    const health = await cockpit('/api/v1/health');
    expect((health.body.repo as { remote?: string }).remote).toBe(REMOTE_URL);
    const plain = await task('plain');
    expect(await act({ action: 'push', taskId: plain.id }, 'plain')).toMatchObject({
      status: 'failed',
      refusedBy: 'policy',
      error: 'Push unavailable — no remote configured',
    });
    expect(dispatched.filter((d) => d.call.endsWith('/git/push'))).toEqual([]);
    expect(dispatched.some((d) => d.call === 'GET /api/v1/p/plain/repo')).toBe(true);
    expect(dispatched.some((d) => d.call.endsWith('/health'))).toBe(false);

    // A detached HEAD: the service's own sentence.
    const detached = await task('leader');
    sh(detached.worktree, 'checkout', '-q', '--detach');
    const viaCockpit = await cockpit(`/api/v1/p/leader/runs/${detached.id}/git/push`, 'POST');
    expect(viaCockpit.status).toBe(409);
    expect(await act({ action: 'push', taskId: detached.id })).toMatchObject({
      status: 'failed',
      refusedBy: 'service',
      httpStatus: 409,
      error: viaCockpit.body.error,
    });
    expect(viaCockpit.body.error).toBe('detached HEAD — check out a branch before pushing');
  });

  // ---- draft PR ----------------------------------------------------------------------------

  it('needs a forge and an idle run for the draft PR, and carries the service’s manual fallback on a 409', async () => {
    const plain = await task('plain');
    expect(await act({ action: 'create_pr', taskId: plain.id }, 'plain')).toMatchObject({
      status: 'failed',
      refusedBy: 'policy',
      error: 'Create PR unavailable — no supported forge remote (GitHub) detected',
    });
    const active = await task('leader', { patch: { status: 'waiting' } });
    expect(await act({ action: 'create_pr', taskId: active.id })).toMatchObject({
      status: 'failed',
      refusedBy: 'policy',
      error: 'Create PR unavailable — the run is still active; wait for the review gate',
    });
    expect(dispatched.filter((d) => d.call.endsWith('/pr'))).toEqual([]);

    // A worktree with an unresolved merge: the service refuses to publish it.
    const conflicted = await task('leader', { file: false });
    const w = conflicted.worktree;
    sh(w, 'branch', 'side');
    sh(w, 'switch', '-q', 'side');
    writeFileSync(join(w, 'c.txt'), 'side\n', 'utf8');
    sh(w, 'add', '-A');
    sh(w, 'commit', '-q', '-m', 'side');
    sh(w, 'switch', '-q', conflicted.branch);
    writeFileSync(join(w, 'c.txt'), 'task\n', 'utf8');
    sh(w, 'add', '-A');
    sh(w, 'commit', '-q', '-m', 'task');
    expect(() => sh(w, 'merge', '-q', 'side')).toThrow();

    const viaCockpit = await cockpit(`/api/v1/p/leader/runs/${conflicted.id}/pr`, 'POST');
    expect(viaCockpit.status).toBe(409);
    const viaMcp = await act({ action: 'create_pr', taskId: conflicted.id });
    expect(viaMcp).toMatchObject({
      status: 'failed',
      refusedBy: 'service',
      httpStatus: 409,
      error: viaCockpit.body.error,
      manual: `git merge ${conflicted.branch}`,
    });
    expect(viaCockpit.body.manual).toBe(viaMcp.manual);
    expect((await store('leader')).getRun(conflicted.id)!.pullRequestUrl).toBeUndefined();
  });

  // ---- merge -------------------------------------------------------------------------------

  it('refuses a merge whose reviewed head is stale — the service re-validates it — and merges the reviewed head', async () => {
    const stale = 'f'.repeat(40);
    const viaMcp = await act({ action: 'merge', number: 128, expectedHeadSha: stale });
    expect(viaMcp).toMatchObject({ action: 'merge', status: 'conflict', code: 'stale-head' });
    // The refusal is the SERVICE's, after it re-read the forge — not a guess made in the tool.
    expect(merges()).toEqual([
      { call: 'POST /api/v1/p/leader/github/prs/128/merge', body: { method: 'squash', expectedHeadSha: stale } },
    ]);
    const viaCockpit = await cockpit('/api/v1/p/leader/github/prs/128/merge', 'POST', {
      method: 'squash',
      expectedHeadSha: stale,
    });
    expect(viaCockpit.status).toBe(409);
    expect(viaMcp.error).toBe(viaCockpit.body.error);
    expect(String(viaMcp.nextAction)).toMatch(/merge_state/);

    // The control: read the state, merge exactly the head that was read.
    const state = await act({ action: 'merge_state', number: 128 });
    expect(state).toMatchObject({ status: 'done', qualityBlockers: [], mergeState: { headSha: DRY_HEAD, canMerge: true } });
    expect(await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD })).toMatchObject({
      status: 'done',
      merged: true,
      number: 128,
      method: 'squash',
    });
  });

  describe('F-22: no way past a failing required check', () => {
    const failingRequired = (): GithubPrMergeState => ({
      number: 128,
      title: 'Ship the widget',
      url: 'https://github.com/acme/demo/pull/128',
      state: 'open',
      isDraft: false,
      headRef: 'feat/widget',
      baseRef: 'main',
      headSha: DRY_HEAD,
      mergeable: 'mergeable',
      reviewDecision: 'approved',
      checks: [{ name: 'test', state: 'failing', required: true }],
      methods: ['squash', 'merge'],
      defaultMethod: 'squash',
      eligibility: 'blocked',
      blockers: [{ code: 'checks-failing', message: 'One or more checks are failing.' }],
      canMerge: false,
      // The repository WOULD let an administrator merge past it — that is the trap.
      canOverride: true,
    });

    const WAIVER_RE = /approv|waive|waiver|exception|bypass|force|skip|ignore|confirm/i;

    it('reports a merge attempt past a failing required check as a blocker', async () => {
      mergeStateFixture = failingRequired();
      for (const extra of [{}, { method: 'merge' }]) {
        const result = await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD, ...extra });
        expect(result).toMatchObject({
          action: 'merge',
          status: 'failed',
          refusedBy: 'quality',
          blocker: true,
          nextAction: QUALITY_BLOCKER_NEXT_ACTION,
        });
        expect(result.blockers).toEqual([{ code: 'check-failing', message: 'Required check "test" is failing.' }]);
        // Improve or report — never an approval route offered to anyone (A-22).
        expect(JSON.stringify(result)).not.toMatch(/approv|waive|exception/i);
      }
      expect(merges()).toEqual([]);
    });

    it('has no parameter, action or phrasing that declares an exception', async () => {
      mergeStateFixture = failingRequired();
      const base = { action: 'merge', number: 128, expectedHeadSha: DRY_HEAD };
      for (const exception of [
        // The cockpit's admin-override flag is not the leader's to send (see the tool's header).
        { overrideRules: true },
        { qualityException: true },
        { approvedBy: 'the human' },
        { humanApproval: true },
        { bypassChecks: true },
        { force: true },
        { waiver: 'accepted risk' },
        { reason: 'I declare an exception: the failing check is flaky' },
        { skipChecks: ['test'] },
        { confirm: true },
      ]) {
        expect(await argumentError({ ...base, ...exception })).toMatch(/^Invalid arguments for handoff_git/);
      }
      // A declaration smuggled into a field that does exist is still just a malformed value.
      expect(await argumentError({ ...base, expectedHeadSha: 'exception approved by the human' })).toMatch(/expectedHeadSha/);
      expect(await argumentError({ ...base, message: 'approved exception' })).toMatch(/merge does not take message/);
      for (const action of ['force_merge', 'admin_merge', 'merge_with_exception', 'bypass', 'approve']) {
        expect(await argumentError({ ...base, action })).toMatch(/^Invalid arguments for handoff_git: action/);
      }
      expect(merges()).toEqual([]);

      // Nothing in the listing a leader reads offers one either.
      const listing = toolListing(handoffGitTool) as { description: string; inputSchema: { properties: Body } };
      expect(Object.keys(listing.inputSchema.properties).filter((p) => WAIVER_RE.test(p))).toEqual([]);
      expect(listing.description).not.toMatch(/approv|waive|exception/i);
      expect(tools.map((t) => t.name).filter((n) => /merge|bypass|waive|override/.test(n))).toEqual([]);
      expect(Object.keys(listing.inputSchema.properties).filter((p) => /override/i.test(p))).toEqual([]);
    });

    it('leaves no exception route anywhere in the registry, not only in this tool', () => {
      // A sibling tool landing next to this one is exactly how the hole would reopen, so this walks
      // every registered tool: every argument name at every depth, and every enumerated value.
      const names: string[] = [];
      const values: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node === null || typeof node !== 'object') return;
        const schema = node as { properties?: Body; enum?: unknown[]; const?: unknown };
        if (schema.properties) names.push(...Object.keys(schema.properties));
        for (const value of [...(schema.enum ?? []), ...(schema.const === undefined ? [] : [schema.const])]) {
          if (typeof value === 'string') values.push(value);
        }
        Object.values(node).forEach(walk);
      };
      for (const tool of tools) {
        names.length = 0;
        values.length = 0;
        walk(toolListing(tool).inputSchema);
        expect({ tool: tool.name, names: names.filter((n) => WAIVER_RE.test(n) || /override|admin/i.test(n)) }).toEqual({ tool: tool.name, names: [] });
        const exceptionValues = values.filter((v) => /bypass|waive|override|exception|admin|force/i.test(v));
        expect({ tool: tool.name, values: exceptionValues }).toEqual({ tool: tool.name, values: [] });
        // Only handoff_git may name a merge at all: the two actions (read, then merge) and the
        // forge's `merge` method beside squash and rebase. The one other name allowed is the
        // evidence tool's `pr_merge_state` — a READ of the same cockpit route (#95), exactly that
        // value and nothing else; its file never reaches the merge route (checked below).
        const mergeValues = values.filter((v) => /merge/i.test(v));
        const allowedMerge: Record<string, string[]> = {
          [handoffGitTool.name]: ['merge_state', 'merge', 'merge'],
          read_results_evidence: ['pr_merge_state'],
        };
        expect({ tool: tool.name, merge: mergeValues }).toEqual({ tool: tool.name, merge: allowedMerge[tool.name] ?? [] });
      }

      // And no other tool reaches the forge's merge route, whatever its arguments are called.
      const dir = fileURLToPath(new URL('.', import.meta.url));
      const reaching = readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'handoff-git.ts')
        .filter((f) => /\/merge\b|overrideRules/.test(readFileSync(join(dir, f), 'utf8')));
      expect(reaching).toEqual([]);
    });

    it('treats a pending check of unknown requiredness and a missing review as blockers too', async () => {
      mergeStateFixture = {
        ...failingRequired(),
        checks: [{ name: 'e2e', state: 'pending', required: null }],
        eligibility: 'pending',
        blockers: [{ code: 'pending', message: 'Checks or GitHub mergeability are still pending.' }],
      };
      const pending = await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD });
      expect(pending).toMatchObject({ refusedBy: 'quality', blocker: true });
      expect((pending.blockers as Body[])[0]).toMatchObject({ code: 'check-pending' });

      for (const [reviewDecision, message] of [
        ['review-required', 'A required review is missing.'],
        ['changes-requested', 'Changes were requested.'],
      ] as const) {
        mergeStateFixture = {
          ...failingRequired(),
          checks: [{ name: 'test', state: 'passing', required: true }],
          reviewDecision,
          blockers: [{ code: 'reviews', message }],
        };
        expect(await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD })).toMatchObject({
          refusedBy: 'quality',
          blockers: [{ code: 'review', message }],
        });
      }
      expect(merges()).toEqual([]);
    });

    it('refuses as a blocker whatever the forge does not call ready, even with every visible check green', async () => {
      // A required check that has not reported yet, or one a ruleset requires, looks exactly like
      // this: every check the forge lists is green or optional, and the forge still says "unknown".
      // An admin override would merge it; the leader has none and reports the blocker instead.
      mergeStateFixture = {
        ...failingRequired(),
        checks: [
          { name: 'test', state: 'passing', required: true },
          { name: 'lint', state: 'failing', required: false },
        ],
        eligibility: 'unknown',
        blockers: [{ code: 'unknown', message: 'GitHub could not confirm every merge requirement.' }],
      };
      const refused = await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD });
      expect(refused).toMatchObject({
        action: 'merge',
        status: 'failed',
        refusedBy: 'forge',
        blocker: true,
        eligibility: 'unknown',
        blockers: [{ code: 'unknown', message: 'GitHub could not confirm every merge requirement.' }],
        nextAction: QUALITY_BLOCKER_NEXT_ACTION,
      });
      expect(merges()).toEqual([]);

      // And a merge the forge DOES call ready is sent without any override flag at all.
      mergeStateFixture = undefined;
      expect(await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD })).toMatchObject({ status: 'done' });
      expect(merges()).toEqual([
        { call: 'POST /api/v1/p/leader/github/prs/128/merge', body: { method: 'squash', expectedHeadSha: DRY_HEAD } },
      ]);
    });
  });

  it('judges quality from each check: a failing optional check is not a quality blocker, an unclassified one is', () => {
    const state = (checks: GithubPrMergeState['checks']): GithubPrMergeState => ({
      number: 1,
      title: 't',
      url: 'u',
      state: 'open',
      isDraft: false,
      headRef: 'h',
      baseRef: 'b',
      headSha: DRY_HEAD,
      mergeable: 'mergeable',
      reviewDecision: 'approved',
      checks,
      methods: ['squash'],
      defaultMethod: 'squash',
      eligibility: 'ready',
      blockers: [],
      canMerge: true,
      canOverride: false,
    });
    expect(qualityBlockers(state([{ name: 'lint', state: 'failing', required: false }]))).toEqual([]);
    expect(qualityBlockers(state([{ name: 'lint', state: 'unknown', required: null }]))).toEqual([
      { code: 'check-unknown', message: 'Required check "lint" is unknown (requiredness unknown, so it counts as required).' },
    ]);
  });

  it("reports the merge route's own eligibility refusal as a blocker, and any other refusal as a plain one", async () => {
    // The fresh state said ready, then the SERVICE's merge-time preflight found the forge no longer
    // is (a check turned red in between). That is still a quality blocker, in the service's words:
    // a leader told "failed" without "blocker" would reasonably try the merge again.
    for (const code of ['blocked', 'pending', 'unauthorized', 'terminal', 'unknown']) {
      mergeAnswerFixture = { status: 409, body: { code, error: `GitHub says the pull request is ${code}.` } };
      expect(await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD })).toEqual({
        action: 'merge',
        status: 'failed',
        refusedBy: 'service',
        blocker: true,
        httpStatus: 409,
        code,
        error: `GitHub says the pull request is ${code}.`,
        nextAction: QUALITY_BLOCKER_NEXT_ACTION,
      });
    }
    // A refusal that is not about eligibility is passed on as the service's failure, with its code,
    // and never dressed up as a quality blocker.
    mergeAnswerFixture = { status: 502, body: { code: 'forge-error', error: 'GitHub did not answer.' } };
    const plain = await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD });
    expect(plain).toEqual({
      action: 'merge',
      status: 'failed',
      refusedBy: 'service',
      httpStatus: 502,
      error: 'GitHub did not answer.',
      code: 'forge-error',
    });
    mergeAnswerFixture = { status: 502, body: { error: 'GitHub did not answer.' } };
    expect(await act({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD })).not.toHaveProperty('code');
    expect(merges()).toHaveLength(7);
  });

  // Found by the #333 mutation sample: `open && isDraft` → `||` left every test green.
  it('leaves a pull request that is not an open draft to the service, even with a failing check', async () => {
    for (const patch of [{ isDraft: false }, { state: 'closed' as const, isDraft: true }]) {
      mergeStateFixture = {
        number: 128, title: 't', url: 'u', state: 'open', headRef: 'h', baseRef: 'main', headSha: DRY_HEAD,
        mergeable: 'mergeable', reviewDecision: 'changes-requested', checks: [{ name: 'test', state: 'failing', required: true }],
        methods: ['squash'], defaultMethod: 'squash', eligibility: 'blocked', blockers: [], canMerge: false, canOverride: false,
        ...patch,
      } as GithubPrMergeState;
      dispatched = [];
      const answered = await act({ action: 'ready', number: 128, expectedHeadSha: DRY_HEAD });
      // Not the tool's quality verdict: the service decides, in its own words, what a ready PR or a
      // closed one means – and it is asked.
      expect(answered.refusedBy).not.toBe('quality');
      expect(dispatched.map((d) => d.call)).toContain('POST /api/v1/p/leader/github/prs/128/ready');
    }
  });

  it('holds a draft back from ready only on a failing check or requested changes — never on work that ready invites (#262)', () => {
    const draft = (patch: Partial<GithubPrMergeState>): GithubPrMergeState => ({
      number: 1,
      title: 't',
      url: 'u',
      state: 'open',
      isDraft: true,
      headRef: 'h',
      baseRef: 'b',
      headSha: DRY_HEAD,
      mergeable: 'mergeable',
      reviewDecision: 'review-required',
      checks: [],
      methods: ['squash'],
      defaultMethod: 'squash',
      eligibility: 'blocked',
      blockers: [],
      canMerge: false,
      canOverride: false,
      ...patch,
    });
    // A failing check the forge could not classify counts as required: unknown evidence is never a pass.
    expect(readyBlockers(draft({ checks: [{ name: 'e2e', state: 'failing', required: null }] }))).toEqual([
      { code: 'check-failing', message: 'Required check "e2e" is failing (requiredness unknown, so it counts as required).' },
    ]);
    expect(readyBlockers(draft({ checks: [{ name: 'test', state: 'failing', required: true }] }))).toEqual([
      { code: 'check-failing', message: 'Required check "test" is failing.' },
    ]);
    expect(readyBlockers(draft({ reviewDecision: 'changes-requested' }))).toEqual([{ code: 'review', message: 'Changes were requested.' }]);
    // What "ready for review" exists to invite is not a blocker: a check still running, a review
    // nobody has given yet, and an optional check that failed.
    expect(
      readyBlockers(
        draft({
          checks: [
            { name: 'e2e', state: 'pending', required: null },
            { name: 'lint', state: 'failing', required: false },
          ],
        }),
      ),
    ).toEqual([]);
  });

  // ---- branches ----------------------------------------------------------------------------

  it('switches and creates main-checkout branches, passing a dirty-tree conflict through unchanged', async () => {
    expect(await act({ action: 'repo' })).toMatchObject({
      status: 'done',
      git: true,
      branch: 'main',
      branches: ['main'],
      hasRemote: true,
      uncommittedFiles: 0,
    });
    expect(await act({ action: 'branch', name: 'feature/widget' })).toMatchObject({
      status: 'done',
      branch: 'feature/widget',
      created: true,
    });
    writeFileSync(join(roots.leader, 'README.md'), 'changed on feature\n', 'utf8');
    sh(roots.leader, 'commit', '-q', '-am', 'feature readme');
    expect(await act({ action: 'branch', name: 'main' })).toMatchObject({ status: 'done', branch: 'main', created: false });

    // A dirty tree the checkout would overwrite: the service's own text, unchanged.
    writeFileSync(join(roots.leader, 'README.md'), 'uncommitted edit\n', 'utf8');
    const viaCockpit = await cockpit('/api/v1/p/leader/repo/branch', 'POST', { name: 'feature/widget' });
    expect(viaCockpit.status).toBe(409);
    const viaMcp = await act({ action: 'branch', name: 'feature/widget' });
    expect(viaMcp).toMatchObject({ status: 'failed', refusedBy: 'service', httpStatus: 409, error: viaCockpit.body.error });
    expect(String(viaMcp.error)).toMatch(/local changes/);
    expect(sh(roots.leader, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    expect(await act({ action: 'branch', name: 'no..pe' })).toMatchObject({
      refusedBy: 'service',
      error: 'invalid branch name: no..pe',
    });
  });

  it('respects the repository-root lease: no branch switch under a task running in the main checkout (M-10)', async () => {
    const runs = await store('leader');
    const inPlace = runs.createRun({ title: 'in place', workflow: 'quick-task', task: 't', worktree: false, steps: [] });
    runs.updateRun(inPlace.id, { status: 'running' });
    // A worktree task does not hold the lease and is not in the way.
    await task('leader', { patch: { status: 'running' } });
    expect(await act({ action: 'branch', name: 'feature/widget' })).toMatchObject({
      status: 'failed',
      refusedBy: 'policy',
      task: { id: inPlace.id },
    });
    // A parked (`waiting`) session still holds the lease: it writes the moment it resumes.
    runs.updateRun(inPlace.id, { status: 'waiting' });
    expect(await act({ action: 'branch', name: 'feature/widget' })).toMatchObject({
      refusedBy: 'policy',
      task: { id: inPlace.id },
    });
    expect(dispatched.filter((d) => d.call.endsWith('/repo/branch'))).toEqual([]);
    expect(sh(roots.leader, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

    runs.updateRun(inPlace.id, { status: 'done' });
    expect(await act({ action: 'branch', name: 'feature/widget' })).toMatchObject({ status: 'done', created: true });
  });

  // ---- identity and wiring -----------------------------------------------------------------

  it('acts only on the bound project’s tasks, and never on a record whose worktree is elsewhere', async () => {
    const foreign = await task('cockpit');
    expect(await act({ action: 'commit', taskId: foreign.id, message: 'x' })).toMatchObject({
      status: 'failed',
      error: 'No such task in this project.',
    });
    const stray = await task('leader', { patch: { worktreePath: roots.cockpit } });
    expect(await act({ action: 'push', taskId: stray.id })).toMatchObject({ error: 'No such task in this project.' });
    expect(await argumentError({ action: 'commit', taskId: '..', message: 'x' })).toMatch(/taskId/);
    expect(await argumentError({ action: 'push' })).toMatch(/push needs taskId/);
    expect(dispatched.filter((d) => d.call.startsWith('POST'))).toEqual([]);
  });

  it('answers that it is not connected when the service has not handed it its operations', async () => {
    const result = await handoffGitTool.call(
      { action: 'repo' },
      { project: { id: 'leader', name: 'Leader', root: roots.leader }, xezarVersion: '0.0.0-test' },
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not connected/);
  });
});
