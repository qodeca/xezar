import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { McpJournalRow } from '@qodeca/xezar-contract';

import { AutomationStore } from '../../src/automations/store.ts';
import { branchFor, worktreePathFor } from '../../src/git-worktree.ts';
import { handoffPath } from '../../src/handoff.ts';
import { AuditTrail, auditTrailPath } from '../../src/mcp/audit-trail.ts';
import { runBridge } from '../../src/mcp/bridge.ts';
import { EventJournal } from '../../src/mcp/event-journal.ts';
import { IPC_PROTOCOL_VERSION, LineFramer, encodeFrame, type McpToolResult } from '../../src/mcp/ipc.ts';
import type { ServiceDispatch } from '../../src/mcp/service-adapter.ts';
import { listenMcpSocket, type McpServiceHandle } from '../../src/mcp/service.ts';
import { defineTool, type McpTool, type McpToolContext } from '../../src/mcp/tool.ts';
import { tools as registry } from '../../src/mcp/tools/index.ts';
import { projectDataDir } from '../../src/project-data-paths.ts';
import { RunStore, type RunRecord } from '../../src/runs/store.ts';
import { ProjectContexts, type ProjectContext, type ProjectContextSource } from '../../src/server/project-context.ts';
import { connectedProviderAuth } from '../../src/server/provider-auth.testkit.ts';
import { createApp } from '../../src/server/server.ts';
import type { RunManager } from '../../src/workflows/run.ts';
import { WorkspaceSemaphore } from '../../src/workspace/semaphore.ts';

/**
 * THE SHARED A/B ACCEPTANCE WORLD (#115; requirements § 9, epic #67 phase 8).
 *
 * One world, used by all four acceptance issues (#115 isolation, #116, #117, #118), so every
 * whole-feature criterion is judged against the same two projects. It is framework-neutral: it
 * imports neither vitest nor node:test, so `test/unit/*.test.ts` (node:test, `npm run test:unit`)
 * and `src/**\/*.test.ts` (vitest, `npm test`) both build it. Its only assertion helper,
 * `assertIsolated`, uses `node:assert`, which both runners report.
 *
 * WHAT § 9 ASKS FOR, AND WHERE IT IS
 *   - Projects A and B, each a real git repository with its OWN tasks (a finished task with a
 *     transcript, a handoff journal and a real git worktree holding a file; two queued tasks, one
 *     carrying a queued message; a finished two-variant group), an automation and one automation
 *     result (a launch receipt), an Inbox item, a project workflow, an MCP event journal with rows
 *     and an MCP audit trail with an entry. Every identifying string of a side is in `side.names`.
 *   - The leader is bound to A: `world.leader('a')` is the real `xez mcp` bridge (`runBridge`)
 *     over in-memory stdio, and `world.call('a', …)` / `world.frame('a', …)` are a CUSTOM client
 *     writing raw frames to A's socket. Both reach the real service loop (`listenMcpSocket`).
 *   - The human UI is the same app: `world.cockpit(path)` is a same-origin cockpit request.
 *   - Controlled backends: `XEZ_DRY_RUN=1`, provider auth stubbed as connected, no personal
 *     account, no secret. `XEZ_HOME` is a fixture directory (inside vitest it replaces the
 *     per-worker sandbox `vitest.setup.ts` pins, and is restored on dispose), so nothing writes the
 *     developer's `~/.xezar` — and `assertXezarHomeWriteIsSandboxed` still guards every write.
 *   - "Record B's state and external effects before; afterwards inspect responses, events,
 *     leader-visible logs and B's unchanged state": `world.observe(fn)` does exactly that, and
 *     `assertIsolated(world, observation)` holds it to N-01's six dimensions (below).
 *
 * B IS THE BOOT PROJECT, ON PURPOSE. `/api/v1/p/default/…` and the unscoped `/api/v1/runs` both
 * resolve to the boot project, so if anything bound to A ever reached for "the default project",
 * it would land on B and the B snapshot would catch it. A is a secondary context built by
 * `ProjectContexts` with its own real `RunManager`; B runs no manager (its tasks are seeded state).
 *
 * THE LEADER-VISIBLE LOG. Everything a leader could see: every frame the bridge wrote to the client
 * or read from it, every raw frame a custom client exchanged, and every tool result. `observe`
 * also captures the cockpit's own console output, which is not leader-visible but must not name B
 * either. The six N-01 dimensions map onto an observation like this:
 *   responses  → `response` and `leaderLog`          errors     → the same, for refusals
 *   events     → `events` (both RunStores' buses) and `journal` (both MCP journals)
 *   pagination → cursors travel in responses, so they are checked there too
 *   search     → responses                            file paths → responses and `dispatched`
 *   side effects → B's byte-level snapshot `before` vs `after`, `events.b`, `journal.b`, and every
 *                  in-process request the tools made (`dispatched`), which must stay inside A.
 *
 * WHAT IS NOT PRODUCTION WIRING (scoped to the files examined for #115)
 *   - `McpToolContext` does not carry the service entry yet, so every registry tool is wrapped to
 *     receive `service` — the same one hop `task-reads.test.ts` and its siblings take.
 *   - D-04's connection file has no writer in `src/` yet. `connection: true` plants the file D-04.2
 *     specifies, with a credential, and hands its secrets to A's journal and audit trail exactly as
 *     D-04 and `audit-trail.ts` say the MCP door must.
 *   - No MCP door records to the audit trail yet. The wrapper records one `mcp.<tool>` entry per
 *     tool call on the called side's trail (payload digest only), which is what D-06 § 10 asks of it.
 *
 * USAGE
 *   const world = await createAbWorld({ hostile: true });
 *   try {
 *     const seen = await world.observe(() => world.call('a', 'task_read', { view: 'task', taskId: world.b.ids.done }));
 *     assertIsolated(world, seen);                     // N-01, all six dimensions
 *     // …then assert the response itself: an error code alone is not enough (§ 9).
 *   } finally {
 *     await world.dispose();
 *   }
 *
 * Options: `hostile` adds A records that reach INTO B (see `HostileRecords`); `connection` plants
 * D-04's connection file with a credential in A; `sockets: false` skips the MCP sockets for suites
 * that only need the services (the socket path needs a short `XEZ_HOME`, which the world creates
 * under `/tmp` when sockets are on).
 */

export const PROJECT_A = 'alpha-proj';
export const PROJECT_B = 'bravo-proj';
export const XEZAR_VERSION = '0.0.0-ab';

export type Side = 'a' | 'b';

export interface AbWorldOptions {
  /** Open one real MCP socket per project and serve the registry tools on it. Default true. */
  sockets?: boolean;
  /** Seed A with the records a copied or hand-edited `.local/xezar` produces. Default false. */
  hostile?: boolean;
  /** Plant D-04's connection file, with a credential, in A's data directory. Default false. */
  connection?: boolean;
  /**
   * Turn GitHub automations on (`XEZ_AUTOMATIONS=1`) for the life of the world, so automation
   * routes answer about the automation instead of "disabled". No scheduler starts: `createApp`
   * serves the routes, and the scheduler is `startServer`'s. Default false (the shipped default).
   */
  automations?: boolean;
}

export interface SideIds {
  /** A finished task: three history notes, a handoff journal, a git worktree with `notes.txt`. */
  done: string;
  /** A queued task carrying one queued message (`message`). */
  queued: string;
  /** A second queued task, so a queue page of one has a next page. */
  queued2: string;
  /** The queued message inside `queued`. */
  message: string;
  /** The variant group's id, and its two finished members (variant `a`, then `b`). */
  group: string;
  variants: [string, string];
  automation: string;
  /** An automation RESULT: the automation's launch receipt id. */
  receipt: string;
  /** The Inbox item's id (`todos.json`). */
  todo: string;
  /** The project workflow's name (`.xezar/workflows/<name>.yaml`). */
  workflow: string;
}

export interface ProjectSide {
  readonly side: Side;
  readonly id: string;
  readonly name: string;
  /** Realpath'd repository root. */
  readonly root: string;
  readonly dataDir: string;
  readonly store: RunStore;
  readonly automations: AutomationStore;
  readonly journal: EventJournal;
  readonly audit: AuditTrail;
  readonly ids: SideIds;
  /** `done`'s worktree directory. */
  readonly worktree: string;
  /** The words only this side's files hold: `notes.txt` in its worktree. */
  readonly fileContent: string;
  /** Every string that identifies this side. None of B's may reach A's leader. */
  readonly names: readonly string[];
}

/**
 * A's hostile records (`hostile: true`). Each is the shape a copied or hand-edited `.local/xezar`
 * produces, and each would drive a real service into B without the ownership checks:
 *   - `stray`: an A task whose `worktreePath` names B's `done` worktree (cancelled, so terminal).
 *     It sits in A's group `mixedGroup` beside `legit`. Delete and pick `rm -rf` that path.
 *   - `linked`: an A task whose worktree, at A's OWN expected path, is a symlink to B's worktree.
 *   - `leakLink` / `rootLink`: symlinks inside A's `done` worktree to B's `notes.txt` and B's root.
 */
export interface HostileRecords {
  stray: string;
  legit: string;
  mixedGroup: string;
  linked: string;
  leakLink: string;
  rootLink: string;
}

/** D-04.2's connection file, as `connection: true` plants it. */
export interface PlantedConnection {
  path: string;
  /** The opaque capability token D-04.2 generates with `randomUUID()`. */
  token: string;
  /** A credential in a well-known token shape, the "any credential" of A-12. */
  credential: string;
}

export interface Emission {
  kind: 'run' | 'event' | 'deleted';
  payload: unknown;
}

export interface Observation<T> {
  response: T;
  /** Every in-process request a tool made, as `METHOD /path?query`, in order. */
  dispatched: string[];
  /** What each project's RunStore bus broadcast (the SSE source). */
  events: Record<Side, Emission[]>;
  /** What each project's MCP event journal appended. */
  journal: Record<Side, McpJournalRow[]>;
  /** Frames the leader and custom clients exchanged. */
  leaderLog: string[];
  /** The cockpit's console, and every journal and audit-trail warning. */
  log: string[];
  /** B's recorded state and external effects, before and after. */
  before: string;
  after: string;
}

/** The real `xez mcp` bridge a client spawns, bound by its socket to one project. */
export interface Leader {
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface AbWorld {
  readonly a: ProjectSide;
  readonly b: ProjectSide;
  readonly home: string;
  readonly app: ReturnType<typeof createApp>;
  readonly contexts: ProjectContexts;
  /** A's live project context (its store, manager and automation store are `a.*`). */
  readonly contextA: ProjectContext;
  /** The in-process service entry every wired tool dispatches through. Records `dispatched`. */
  readonly service: ServiceDispatch;
  /** The tool registry, each tool handed `service` (see "What is not production wiring"). */
  readonly tools: readonly McpTool[];
  readonly hostile: HostileRecords | undefined;
  readonly connection: PlantedConnection | undefined;
  /** Every secret value in the world: launch keys, and the planted token and credential. */
  readonly secrets: readonly string[];
  /** Everything the leader side saw, cumulatively. `observe` slices it per case. */
  readonly leaderLog: string[];
  readonly dispatched: string[];
  socketPath(side: Side): string;
  /** Custom client: one `tools/call` frame on a side's socket, answered by the service loop. */
  call(side: Side, tool: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  /** Custom client: ANY frame on a side's socket; answers the parsed response line. */
  frame(side: Side, frame: unknown): Promise<unknown>;
  /** The real bridge, bound to a side's socket. Closed by `dispose` if the caller does not. */
  leader(side: Side): Promise<Leader>;
  /** A same-origin cockpit request (the human UI's door) to the same app. */
  cockpit(path: string, method?: string, body?: unknown): Promise<Response>;
  /** A side's complete recorded state and external effects, as one comparable string. */
  snapshot(side?: Side): string;
  /** Record B, run `fn`, record B again, and collect everything observable on the way. */
  observe<T>(fn: () => T | Promise<T>): Promise<Observation<Awaited<T>>>;
  dispose(): Promise<void>;
}

// ---- building ------------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=ab@example.invalid', '-c', 'user.name=ab', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const tag = (): string => randomBytes(3).toString('hex');

/** A repository whose tracked files (config, workflow) are committed, so `git status` starts clean. */
function makeRepo(base: string, side: Side, workflow: string): string {
  const root = join(base, `project-${side === 'a' ? 'alpha' : 'bravo'}`);
  mkdirSync(join(root, '.xezar', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.xezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
  writeFileSync(
    join(root, '.xezar', 'workflows', `${workflow}.yaml`),
    `name: ${workflow}\ndescription: ${side === 'a' ? 'ALPHA' : 'BRAVO'} project workflow\nsteps:\n  - id: only\n    prompt: "{{task}}"\n`,
    'utf8',
  );
  writeFileSync(join(root, 'README.md'), `# ${side === 'a' ? 'ALPHA' : 'BRAVO'} readme\n`, 'utf8');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return realpathSync(root);
}

interface SeedInput {
  side: Side;
  id: string;
  root: string;
  store: RunStore;
  automations: AutomationStore;
  workflow: string;
}

function seedSide(input: SeedInput): Omit<ProjectSide, 'journal' | 'audit' | 'names' | 'name'> & { extraNames: string[] } {
  const { side, root, store, automations } = input;
  const P = side === 'a' ? 'ALPHA' : 'BRAVO';
  const p = side === 'a' ? 'alpha' : 'bravo';
  const dataDir = projectDataDir(root);
  const finished = (id: string, at: string, extra: Partial<RunRecord> = {}) =>
    store.updateRun(id, { status: 'done', startedAt: at, finishedAt: at, ...extra });
  // Fixed creation times: list and queue order are by `createdAt`, and two runs created in the same
  // millisecond would order by random id.
  const created = (id: string, minute: number) =>
    store.updateRun(id, { createdAt: `2026-09-01T0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00.000Z` });

  const done = store.createRun({ title: `${P} done task common`, workflow: 'quick-task', task: `${P} done brief`, steps: [] });
  created(done.id, 1);
  finished(done.id, '2026-09-01T10:00:00.000Z');
  for (let i = 1; i <= 3; i += 1) store.appendEvent(done.id, { type: 'note', text: `${P} history note ${i}` });
  mkdirSync(join(dataDir, 'runs'), { recursive: true });
  writeFileSync(handoffPath(dataDir, done.id), `# ${P} handoff\n\n## Progress log\n\n- ${P} progress\n`, 'utf8');
  const worktree = worktreePathFor(root, done.id);
  git(root, 'worktree', 'add', '-q', '-b', branchFor(done.id), worktree);
  const fileContent = `${P}-FILE-CONTENT`;
  writeFileSync(join(worktree, 'notes.txt'), `${fileContent}\n`, 'utf8');
  store.updateRun(done.id, { worktreePath: worktree, branch: branchFor(done.id) });

  const message = `${p}-msg-${tag()}`;
  const queued = store.createRun({ title: `${P} queued one common`, workflow: 'quick-task', task: `${P} queued brief`, steps: [] });
  store.updateRun(queued.id, {
    status: 'queued',
    queuedMessages: [{ id: message, text: `${P} queued words`, createdAt: '2026-09-02T09:00:00.000Z' }],
  });
  const queued2 = store.createRun({ title: `${P} queued two`, workflow: 'quick-task', task: `${P} second queued brief`, steps: [] });
  store.updateRun(queued2.id, { status: 'queued' });
  created(queued.id, 2);
  created(queued2.id, 3);

  const group = `${p}-group-${tag()}`;
  const va = store.createRun({ title: `${P} variant a`, workflow: 'quick-task', task: `${P} variant brief`, steps: [], groupId: group, variant: 'a' });
  const vb = store.createRun({ title: `${P} variant b`, workflow: 'quick-task', task: `${P} variant brief`, steps: [], groupId: group, variant: 'b' });
  created(va.id, 4);
  created(vb.id, 5);
  finished(va.id, '2026-09-02T12:00:00.000Z');
  finished(vb.id, '2026-09-02T12:00:00.000Z');

  const automation = automations.create({
    name: `${P} automation`,
    enabled: false,
    events: ['pull_request.opened'],
    intervalSeconds: 300,
    filters: { lookbackDays: 7, maxRecords: 25 },
    task: { prompt: `${P} automation prompt` },
  });
  const receipt = automations.reserveReceipt({ automationId: automation.id, revision: 1, eventId: `evt-${p}-${tag()}` });
  assert.ok(receipt, 'the fixture could not reserve an automation receipt');

  const todo = `${p}-todo-${tag()}`;
  writeFileSync(
    join(dataDir, 'todos.json'),
    JSON.stringify([{ id: todo, ts: '2026-09-03T00:00:00.000Z', summary: `${P} inbox item`, runnable: false }]),
    'utf8',
  );

  const ids: SideIds = {
    done: done.id,
    queued: queued.id,
    queued2: queued2.id,
    message,
    group,
    variants: [va.id, vb.id],
    automation: automation.id,
    receipt: receipt.receiptId,
    todo,
    workflow: input.workflow,
  };
  const extraNames = [
    ...[done.id, queued.id, queued2.id, va.id, vb.id].flatMap((id) => [id, branchFor(id)]),
    message,
    group,
    automation.id,
    receipt.receiptId,
    receipt.receiptKey,
    todo,
    input.workflow,
    fileContent,
    `${P} done task`,
    `${P} queued`,
    `${P} variant`,
    `${P} history note`,
    `${P} handoff`,
    `${P} inbox item`,
    `${P} automation`,
    `${P} journal row`,
    `${P} project workflow`,
    `${P} readme`,
  ];
  return { side, id: input.id, root, dataDir, store, automations, ids, worktree, fileContent, extraNames };
}

function seedHostile(a: ProjectSide, b: ProjectSide): HostileRecords {
  const store = a.store;
  const mixedGroup = `alpha-mixed-${tag()}`;
  const legit = store.createRun({ title: 'ALPHA mixed legit', workflow: 'quick-task', task: 'ALPHA mixed', steps: [], groupId: mixedGroup, variant: 'a' });
  store.updateRun(legit.id, { status: 'done', finishedAt: '2026-09-02T13:00:00.000Z' });
  const stray = store.createRun({ title: 'ALPHA mixed stray', workflow: 'quick-task', task: 'ALPHA stray', steps: [], groupId: mixedGroup, variant: 'b' });
  // Terminal, unarchived: delete and the variant pick would both reach it.
  store.updateRun(stray.id, { status: 'cancelled', finishedAt: '2026-08-01T10:00:00.000Z', worktreePath: b.worktree, branch: branchFor(b.ids.done) });

  const linked = store.createRun({ title: 'ALPHA linked', workflow: 'quick-task', task: 'ALPHA linked', steps: [] });
  const linkedPath = worktreePathFor(a.root, linked.id);
  symlinkSync(b.worktree, linkedPath);
  store.updateRun(linked.id, { status: 'done', finishedAt: '2026-09-02T14:00:00.000Z', worktreePath: linkedPath });

  const leakLink = 'leak.txt';
  const rootLink = 'bravo';
  symlinkSync(join(b.worktree, 'notes.txt'), join(a.worktree, leakLink));
  symlinkSync(b.root, join(a.worktree, rootLink));
  return { stray: stray.id, legit: legit.id, mixedGroup, linked: linked.id, leakLink, rootLink };
}

function plantConnection(a: Pick<ProjectSide, 'id' | 'root' | 'dataDir'>, socket: string): PlantedConnection {
  const token = randomUUID();
  // A GitHub-PAT shape: the well-known credential form the transcript scrub also recognises.
  const credential = `ghp_${randomBytes(18).toString('hex')}`;
  const path = join(a.dataDir, 'mcp-connection.json');
  const body = {
    schemaVersion: 1,
    project: { id: a.id, root: a.root, dataDir: a.dataDir },
    service: { pid: process.pid, startedAt: new Date().toISOString() },
    endpoint: { socket },
    token,
    credential,
  };
  writeFileSync(path, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { path, token, credential };
}

// ---- snapshots -----------------------------------------------------------------------------

/**
 * A side's complete state and external effects: every file under its root (the working tree, its
 * `.git`, `.local/xezar` with every store, transcript, journal, trail and worktree) by type, size,
 * mode, mtime and SHA-256 content, every symlink target, its git refs and worktree registrations,
 * and the in-memory view of its stores and journal. Byte-identical before and after is the bar.
 */
function snapshotSide(side: ProjectSide): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const info = lstatSync(path);
      const rel = path.slice(side.root.length);
      if (info.isSymbolicLink()) files.push(`L ${rel} -> ${readlinkSync(path)}`);
      else if (info.isDirectory()) {
        files.push(`D ${rel} ${info.mode}`);
        walk(path);
      } else {
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
        files.push(`F ${rel} ${info.size} ${info.mode} ${info.mtimeMs} ${hash}`);
      }
    }
  };
  walk(side.root);
  const runs = side.store.listRuns();
  return JSON.stringify({
    files,
    // Read-only plumbing: neither command refreshes the index or writes a ref.
    refs: git(side.root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: git(side.root, 'worktree', 'list', '--porcelain'),
    runs,
    // A debounced index save still waiting means something touched the store in memory — a side
    // effect even before it reaches the disk. The flag is private; reading it is the fixture's only
    // reach past a public API, and it writes nothing.
    pendingSave: (side.store as unknown as { saveTimer: unknown }).saveTimer != null,
    events: runs.map((run) => [run.id, side.store.readEvents(run.id)]),
    automations: side.automations.list(),
    receipts: side.automations.receipts(),
    journal: side.journal.read({}),
    journalHead: side.journal.latestSeq,
    audit: side.audit.read(),
  });
}

// ---- the world -----------------------------------------------------------------------------

export async function createAbWorld(options: AbWorldOptions = {}): Promise<AbWorld> {
  const withSockets = options.sockets ?? true;
  const saved = {
    home: process.env.XEZ_HOME,
    dryRun: process.env.XEZ_DRY_RUN,
    followups: process.env.XEZ_FOLLOWUPS,
    remote: process.env.XEZ_REMOTE,
    automations: process.env.XEZ_AUTOMATIONS,
  };
  if (options.automations) process.env.XEZ_AUTOMATIONS = '1';
  else delete process.env.XEZ_AUTOMATIONS;
  // The socket lives under XEZ_HOME and a Unix socket path has a hard ~104-byte limit, which a
  // task's TMPDIR can exceed — so the home is short, under /tmp, whenever sockets are on.
  const home = mkdtempSync(join(withSockets ? realpathSync('/tmp') : realpathSync(tmpdir()), 'xez-ab-home-'));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xez-ab-')));
  process.env.XEZ_HOME = home;
  process.env.XEZ_DRY_RUN = '1';
  delete process.env.XEZ_FOLLOWUPS;
  delete process.env.XEZ_REMOTE;

  const log: string[] = [];
  const warn = (message: string): void => {
    log.push(message);
  };
  const workflowA = `alpha-flow-${tag()}`;
  const workflowB = `bravo-flow-${tag()}`;
  const rootA = makeRepo(base, 'a', workflowA);
  const rootB = makeRepo(base, 'b', workflowB);

  const sources: ProjectContextSource[] = [
    { id: PROJECT_A, root: rootA, status: 'ok' },
    { id: PROJECT_B, root: rootB, status: 'ok' },
  ];
  const semaphore = new WorkspaceSemaphore({
    initial: { maxParallel: 2 },
    load: async () => ({ maxParallel: 2, memoryLimitMb: null }),
  });
  const contexts = new ProjectContexts({ listProjects: async () => sources, semaphore });
  const storeB = RunStore.open(projectDataDir(rootB), { keepLive: true });
  const automationsB = AutomationStore.open(projectDataDir(rootB));
  const app = createApp({
    repoRoot: rootB,
    store: storeB,
    // B runs nothing: its tasks are seeded state. A has a real manager, built by its context.
    manager: { isActive: () => false } as unknown as RunManager,
    version: XEZAR_VERSION,
    bootProjectId: PROJECT_B,
    contexts,
    semaphore,
    automationStore: automationsB,
    providerAuth: connectedProviderAuth(),
  });
  const contextA = await contexts.context(PROJECT_A);

  const seededA = seedSide({ side: 'a', id: PROJECT_A, root: rootA, store: contextA.store, automations: contextA.automationStore, workflow: workflowA });
  const seededB = seedSide({ side: 'b', id: PROJECT_B, root: rootB, store: storeB, automations: automationsB, workflow: workflowB });

  const sockets: Partial<Record<Side, McpServiceHandle>> = {};
  const socketPath = (side: Side): string => {
    const handle = sockets[side];
    if (!handle) throw new Error('this world was built with sockets: false');
    return handle.path;
  };

  // A's secrets are known before its journal and trail open, as the MCP door would know them.
  let connection: PlantedConnection | undefined;
  const connectionSecrets = (): string[] => (connection ? [connection.token, connection.credential] : []);

  const openJournal = (seeded: typeof seededA, extra: string[]): EventJournal =>
    EventJournal.open({ dataDir: seeded.dataDir, projectId: seeded.id, warn, ...(extra.length > 0 ? { secretValues: extra } : {}) });

  const recordingService: { dispatched: string[]; entry: ServiceDispatch } = {
    dispatched: [],
    entry: {
      request: (input, init) => {
        const url = new URL(input);
        recordingService.dispatched.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        return app.request(input, init);
      },
    },
  };

  // Sides are completed after the sockets exist, because the connection file names A's socket.
  let sideA: ProjectSide | undefined;
  let sideB: ProjectSide | undefined;
  const sideOf = (project: McpToolContext['project']): ProjectSide | undefined =>
    project.id === PROJECT_A ? sideA : project.id === PROJECT_B ? sideB : undefined;

  const wired: McpTool[] = registry.map((tool) =>
    defineTool({
      ...tool,
      call: async (args, ctx) => {
        const result = await tool.call(args, { ...ctx, service: recordingService.entry } as McpToolContext);
        // The door's audit record (D-06 § 10): who, what, how it settled — a digest, never the args.
        sideOf(ctx.project)
          ?.audit.channel('mcp')
          .record(
            {
              action: `mcp.${tool.name.replaceAll('_', '-')}`,
              payload: args,
              ...(typeof (args as { operationId?: unknown }).operationId === 'string'
                ? { operationId: (args as { operationId: string }).operationId }
                : {}),
            },
            { outcome: result.isError ? 'rejected' : 'ok', ...(result.isError ? { errorCode: 'tool_error' } : {}) },
          );
        return result;
      },
    }),
  );

  if (withSockets) {
    sockets.a = await listenMcpSocket({ project: { id: PROJECT_A, name: 'alpha project', root: rootA }, version: XEZAR_VERSION, tools: wired });
    sockets.b = await listenMcpSocket({ project: { id: PROJECT_B, name: 'bravo project', root: rootB }, version: XEZAR_VERSION, tools: wired });
  }
  // Planted before A's journal and trail open: its endpoint names A's socket, known only now, and
  // its secrets are what the MCP door hands both of them.
  if (options.connection) connection = plantConnection(seededA, sockets.a?.path ?? join(home, 'ipc', 'alpha.sock'));

  const journalA = openJournal(seededA, connectionSecrets());
  const journalB = openJournal(seededB, []);
  const auditA = new AuditTrail({ projectId: PROJECT_A, dataDir: seededA.dataDir }, { warn, secretValues: connectionSecrets });
  const auditB = new AuditTrail({ projectId: PROJECT_B, dataDir: seededB.dataDir }, { warn });
  for (const [journal, seeded, P] of [
    [journalA, seededA, 'ALPHA'],
    [journalB, seededB, 'BRAVO'],
  ] as const) {
    for (let i = 1; i <= 2; i += 1) {
      journal.append({
        category: 'E-01',
        kind: 'task.terminal',
        subject: { type: 'run', id: seeded.ids.done, version: null },
        origin: 'human',
        causedBy: null,
        summary: `${P} journal row ${i}`,
      });
    }
  }
  auditB.channel('ui').record({ action: 'runs.pin', resource: { kind: 'run', id: seededB.ids.done }, payload: { pinned: true } }, { outcome: 'ok' });

  const finish = (seeded: typeof seededA, journal: EventJournal, audit: AuditTrail, name: string): ProjectSide => {
    const { extraNames, ...rest } = seeded;
    return {
      ...rest,
      name,
      journal,
      audit,
      names: [seeded.id, name, seeded.root, basename(seeded.root), ...extraNames],
    };
  };
  sideA = finish(seededA, journalA, auditA, 'alpha project');
  sideB = finish(seededB, journalB, auditB, 'bravo project');
  const a = sideA;
  const b = sideB;
  const hostile = options.hostile ? seedHostile(a, b) : undefined;

  contextA.store.flush();
  storeB.flush();

  const launchKey = (side: ProjectSide): string[] => {
    try {
      const key = readFileSync(join(side.dataDir, 'launch-key'), 'utf8').trim();
      return key ? [key] : [];
    } catch {
      return [];
    }
  };
  const secrets = [...launchKey(a), ...launchKey(b), ...connectionSecrets()];
  // B's launch key identifies B's data as surely as its name does.
  (b.names as string[]).push(...launchKey(b));

  const leaderLog: string[] = [];
  const leaders = new Set<Leader>();

  /**
   * One connection per frame. A request that needs an MCP session (`health`, `tools/call`) opens
   * one first on the same connection, as the bridge does (#302) — so a custom client competes for
   * the project like any other, and is refused while a leader owns it. Closing the connection
   * ends that session.
   */
  const needsSession = (payload: unknown): boolean =>
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { v?: unknown }).v === IPC_PROTOCOL_VERSION &&
    ['health', 'tools/call'].includes(String((payload as { method?: unknown }).method));

  const frame = (side: Side, payload: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = createConnection(socketPath(side));
      const line = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const answers: string[] = [];
      let opening = needsSession(payload);
      const framer = new LineFramer(
        (answer) => {
          answers.push(answer);
          if (opening) {
            opening = false;
            if ((JSON.parse(answer) as { ok?: unknown }).ok === true) {
              leaderLog.push(`client→${side} ${line}`);
              socket.write(`${line}\n`);
              return;
            }
          }
          leaderLog.push(`${side}→client ${answer}`);
          // Answered only once the connection is fully closed and the service has handled that
          // close, so the session this frame opened has released the project before the caller
          // looks at the project's files again.
          socket.once('close', () => setImmediate(() => resolve(JSON.parse(answer) as unknown)));
          socket.end();
        },
        () => reject(new Error('oversized frame')),
      );
      socket.on('data', (chunk: Buffer) => framer.push(chunk));
      socket.on('error', reject);
      socket.on('connect', () => {
        if (opening) socket.write(encodeFrame({ v: IPC_PROTOCOL_VERSION, id: 0, method: 'session/open' }));
        else {
          leaderLog.push(`client→${side} ${line}`);
          socket.write(`${line}\n`);
        }
      });
    });

  const call = async (side: Side, tool: string, args: Record<string, unknown> = {}): Promise<McpToolResult> => {
    const answer = (await frame(side, { v: IPC_PROTOCOL_VERSION, id: 1, method: 'tools/call', params: { name: tool, arguments: args } })) as {
      ok: boolean;
      result?: McpToolResult;
      error?: { message: string };
    };
    if (!answer.ok) throw new Error(`the service refused the frame: ${answer.error?.message ?? 'no message'}`);
    return answer.result!;
  };

  const leader = async (side: Side): Promise<Leader> => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = new Map<number, (message: { result?: unknown; error?: { code: number; message: string } }) => void>();
    let nextId = 1;
    const framer = new LineFramer(
      (line) => {
        leaderLog.push(`bridge:${side}→leader ${line}`);
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string } };
        if (typeof message.id === 'number') {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      },
      () => leaderLog.push(`bridge:${side}→leader <oversized>`),
    );
    output.on('data', (chunk: Buffer) => framer.push(chunk));
    const project = side === 'a' ? a : b;
    const done = runBridge({
      input,
      output,
      version: XEZAR_VERSION,
      tools: registry,
      resolveTarget: async () => ({ kind: 'socket', path: socketPath(side), project: { id: project.id, name: project.name } }),
    });
    const handle: Leader = {
      request(method, params) {
        const id = nextId++;
        const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
        const line = JSON.stringify(message);
        leaderLog.push(`leader→bridge:${side} ${line}`);
        return new Promise((resolve) => {
          pending.set(id, resolve);
          input.write(encodeFrame(message));
        });
      },
      async callTool(name, args = {}) {
        const answer = await handle.request('tools/call', { name, arguments: args });
        if (answer.error) throw new Error(`the bridge refused tools/call: ${answer.error.message}`);
        return answer.result as McpToolResult;
      },
      async close() {
        if (!leaders.delete(handle)) return;
        input.end();
        await done;
      },
    };
    leaders.add(handle);
    await handle.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ab-leader', version: '0' } });
    return handle;
  };

  const cockpit = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        method,
        headers: {
          host: '127.0.0.1:4321',
          origin: 'http://127.0.0.1:4321',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const snapshot = (side: Side = 'b'): string => {
    // No flush here: `RunStore.flush` rewrites the index even when nothing changed, which would be
    // the snapshot's own side effect. The in-memory records are part of the snapshot instead.
    return snapshotSide(side === 'a' ? a : b);
  };

  const observe = async <T>(fn: () => T | Promise<T>): Promise<Observation<Awaited<T>>> => {
    const events: Record<Side, Emission[]> = { a: [], b: [] };
    const journal: Record<Side, McpJournalRow[]> = { a: [], b: [] };
    const off: Array<() => void> = [];
    for (const [side, target] of [
      ['a', a],
      ['b', b],
    ] as const) {
      for (const kind of ['run', 'event', 'deleted'] as const) {
        const listener = (payload: unknown): void => {
          events[side].push({ kind, payload });
        };
        target.store.on(kind, listener);
        off.push(() => target.store.off(kind, listener));
      }
      off.push(target.journal.subscribe((row) => journal[side].push(row)));
    }
    const consoleLog: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((m) => console[m]);
    for (const method of methods) {
      console[method] = (...args: unknown[]): void => {
        consoleLog.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '));
      };
    }
    const leaderStart = leaderLog.length;
    const dispatchStart = recordingService.dispatched.length;
    const logStart = log.length;
    const before = snapshot('b');
    let response: Awaited<T>;
    try {
      response = await fn();
    } finally {
      methods.forEach((method, i) => {
        console[method] = originals[i]!;
      });
      for (const stop of off) stop();
    }
    const after = snapshot('b');
    return {
      response,
      dispatched: recordingService.dispatched.slice(dispatchStart),
      events,
      journal,
      leaderLog: leaderLog.slice(leaderStart),
      log: [...log.slice(logStart), ...consoleLog],
      before,
      after,
    };
  };

  const dispose = async (): Promise<void> => {
    for (const handle of [...leaders]) await handle.close();
    for (const handle of Object.values(sockets)) handle?.close();
    for (const id of contexts.ids()) {
      const ctx = contexts.peek(id);
      if (!ctx) continue;
      const runs = ctx.store.listRuns().map((run) => run.id);
      for (const runId of runs) ctx.manager.cancel(runId);
      const deadline = Date.now() + 20_000;
      while (runs.some((runId) => ctx.manager.isActive(runId)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await ctx.manager.dispose();
    }
    contexts.disposeAll();
    journalA.close();
    journalB.close();
    storeB.flush();
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of [
      ['XEZ_HOME', saved.home],
      ['XEZ_DRY_RUN', saved.dryRun],
      ['XEZ_FOLLOWUPS', saved.followups],
      ['XEZ_REMOTE', saved.remote],
      ['XEZ_AUTOMATIONS', saved.automations],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  return {
    a,
    b,
    home,
    app,
    contexts,
    contextA,
    service: recordingService.entry,
    tools: wired,
    hostile,
    connection,
    secrets,
    leaderLog,
    dispatched: recordingService.dispatched,
    socketPath,
    call,
    frame,
    leader,
    cockpit,
    snapshot,
    observe,
    dispose,
  };
}

// ---- judging an observation (N-01) ---------------------------------------------------------

/**
 * The workspace-level routes a tool bound to A may READ, and only read. Each answers host-wide
 * settings and holds no project's data — checked against their contract shapes for #115:
 * `/health` for capabilities (`task_read`'s Inbox switch, `task_create`), `/providers/status` for
 * which agent CLIs are connected (no account identity), `/workspace/config` for the composer's
 * workspace defaults (`workspaceConfigResponseSchema`: roots for the folder browser, defaults and
 * resource limits — no project list). Anything else outside `/api/v1/p/<A>/` is a violation,
 * including `/p/default/` (which is B here), the unscoped `/runs`, and the workspace runs index.
 */
export const WORKSPACE_READS: readonly string[] = ['/api/v1/health', '/api/v1/providers/status', '/api/v1/workspace/config'];

/** Whether one `dispatched` entry stayed inside A (or was one of the global reads above). */
export function dispatchIsInsideA(entry: string): boolean {
  const space = entry.indexOf(' ');
  const method = entry.slice(0, space);
  const path = entry.slice(space + 1).split('?')[0]!;
  if (path.startsWith(`/api/v1/p/${PROJECT_A}/`) || path === `/api/v1/p/${PROJECT_A}`) return true;
  return method === 'GET' && WORKSPACE_READS.includes(path);
}

/** Every string of `needles` found in `haystack`. */
export function leaked(haystack: string, needles: readonly string[]): string[] {
  return needles.filter((needle) => needle.length > 0 && haystack.includes(needle));
}

export interface IsolationOptions {
  /** Strings the leader itself supplied in this case, stripped before the search (an echo is not a leak). */
  echoes?: readonly string[];
}

/**
 * Hold one observation to N-01 — responses, errors, events, pagination, search, file paths and side
 * effects — for B. Throws (node:assert) on the first violation. Returns the text it searched, so a
 * caller can make further assertions over exactly the same surface.
 */
export function assertIsolated(world: AbWorld, seen: Observation<unknown>, options: IsolationOptions = {}): string {
  // Side effects: B's recorded state and external effects are byte-identical.
  if (seen.after !== seen.before) {
    assert.fail(`B changed — its recorded state and external effects differ after the case:\n${snapshotChanges(seen.before, seen.after).join('\n')}`);
  }
  // Events: B's bus broadcast nothing and B's journal appended nothing.
  assert.deepEqual(seen.events.b, [], 'B broadcast events during the case');
  assert.deepEqual(seen.journal.b, [], "B's MCP journal appended rows during the case");
  // Side effects outside the stores: every in-process request stayed inside A.
  const outside = seen.dispatched.filter((entry) => !dispatchIsInsideA(entry));
  assert.deepEqual(outside, [], 'a tool bound to A dispatched outside A');
  // Responses, errors, cursors, search results, paths, A's events and every log: nothing names B.
  let surface = JSON.stringify({
    response: seen.response,
    leaderLog: seen.leaderLog,
    eventsA: seen.events.a,
    journalA: seen.journal.a,
    log: seen.log,
    dispatched: seen.dispatched,
  });
  for (const echo of options.echoes ?? []) surface = surface.split(echo).join('');
  assert.deepEqual(leaked(surface, world.b.names), [], "B's identifying data reached the leader-visible surface");
  assert.deepEqual(leaked(surface, world.secrets), [], 'a secret reached the leader-visible surface');
  return surface;
}

/**
 * What differs between two `snapshot()` strings, one line per change: `- file`/`+ file` for the
 * file entries, and `~ key` for every other part (runs, events, journal, trail, refs, …).
 */
export function snapshotChanges(before: string, after: string): string[] {
  const a = JSON.parse(before) as Record<string, unknown> & { files: string[] };
  const b = JSON.parse(after) as Record<string, unknown> & { files: string[] };
  const out: string[] = [];
  const was = new Set(a.files);
  const now = new Set(b.files);
  for (const entry of a.files) if (!now.has(entry)) out.push(`- ${entry}`);
  for (const entry of b.files) if (!was.has(entry)) out.push(`+ ${entry}`);
  for (const key of Object.keys(a)) {
    if (key !== 'files' && JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(`~ ${key}`);
  }
  return out;
}

/** The authoritative text block of a tool result. */
export const resultText = (result: McpToolResult): string => result.content.map((block) => block.text).join('\n');

/** An id with the shape of a real run id that exists in neither project — the "nowhere" control. */
export const nowhereId = (): string => randomUUID();

/** Where a side's audit trail lives, for greps over the raw file. */
export const auditFile = (side: ProjectSide): string => auditTrailPath(side.dataDir);
