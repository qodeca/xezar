import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROJECT_A,
  PROJECT_B,
  assertIsolated,
  auditFile,
  createAbWorld,
  leaked,
  resultText,
  type AbWorld,
  type AbWorldOptions,
} from '../../test/helpers/ab-fixture.ts';
import { BUNDLED_TEMPLATES_DIGEST, ONBOARDING_WORKFLOW_ID } from '../onboarding/status.ts';
import type { RunRecord } from '../runs/store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { globalStateLayout, projectStateLayout, setActiveStateLayout } from '../state-layout.ts';
import { runBridge, type ServiceTarget } from './bridge.ts';
import { startMcpService } from './index.ts';
import { LineFramer, encodeFrame } from './ipc.ts';
import type { ServiceDispatch } from './service-adapter.ts';
import { runVersion } from './stale-write.ts';
import { toolListing, type McpToolContext, type McpToolResult } from './tool.ts';
import { handoffGitTool, QUALITY_BLOCKER_NEXT_ACTION } from './tools/handoff-git.ts';
import { tools } from './tools/index.ts';
import { withOperationId } from './tools/operation-id.testkit.ts';

/**
 * #116 — the PARITY AND COLLABORATION half of the whole-feature acceptance suite (requirements § 9):
 * A-05, A-06, A-07, A-08, A-09, A-10 and A-11, at the route level. The isolation half (A-02, A-03,
 * A-04, A-12) is `acceptance-isolation.test.ts`; both run in the shared A/B world
 * (`test/helpers/ab-fixture.ts`, #115), where the leader is bound to A over A's real MCP socket and
 * the human's cockpit is the same app, reached as a same-origin request.
 *
 * THE MEASURE (Definition of Done clause 1). Coverage is judged against THE CLOSED INVENTORY
 * (`docs/features/mcp-server/mcp-ui-action-inventory.md`), never against tool or endpoint counts.
 * Every case below is registered with the inventory records it proves (`parity(...)`), and the
 * last block (A-05) holds the registry to the inventory BOTH ways: every `covered` record has at
 * least one case, and every case names at least one record. The mapping is published in
 * `docs/features/mcp-server/mcp-parity-coverage-map.md`, and the same block fails when that
 * document and this file disagree in either direction.
 *
 * THE BAR FOR EACH CASE (§ 9, A-05). A case drives the UI counterpart (the cockpit's own route)
 * and the MCP counterpart from EQUIVALENT STARTING STATES and asserts the BUSINESS OUTCOME — the
 * record, the file, the branch, the transcript — never a status code alone. Start or status
 * success alone is not a pass. Where an outcome would reach project B, `world.observe` records B
 * before and after and `assertIsolated` holds it to N-01.
 *
 * BLOCKED IS NOT PASSING. A record whose acceptance cannot be exercised because the service is not
 * wired for it yet is registered with `blocked(...)`: it appears in the matrix, runs as a vitest
 * `todo` (never a pass), and names exactly what is missing.
 */

// ---- the coverage registry -------------------------------------------------------------------

/** One acceptance case: what it proves (the § 9 criteria) and against which inventory records. */
interface ParityCase {
  readonly id: string;
  readonly title: string;
  readonly acceptance: readonly string[];
  readonly records: readonly string[];
  /** Set when the case cannot run yet: exactly what is missing. Never counted as passing. */
  readonly blocker?: string;
}

const CASES: ParityCase[] = [];

function register(entry: ParityCase): void {
  if (CASES.some((c) => c.id === entry.id)) throw new Error(`duplicate case id ${entry.id}`);
  CASES.push(entry);
}

/** A runnable acceptance case. The vitest title carries the case id and the records it proves. */
function parity(
  id: string,
  acceptance: readonly string[],
  records: readonly string[],
  title: string,
  fn: () => Promise<void>,
  timeout = 90_000,
): void {
  register({ id, title, acceptance, records });
  it(`${id} [${records.join(' ')}] ${title}`, fn, timeout);
}

/** A case that cannot run until the named wiring exists: listed, never passing. */
function blocked(id: string, acceptance: readonly string[], records: readonly string[], title: string, blocker: string): void {
  register({ id, title, acceptance, records, blocker });
  it.todo(`${id} BLOCKED [${records.join(' ')}] ${title} — ${blocker}`);
}

// ---- helpers ---------------------------------------------------------------------------------

const A_API = `/api/v1/p/${PROJECT_A}`;
const OK_COMMAND = `node -e "process.stdout.write('ok')"`;
const HOLD_COMMAND = `node -e "setTimeout(() => {}, 30000)"`;
// A four-variant group used to carry its own 75 s budget here, because every variant creates a
// worktree and a child process and a loaded machine made that slower than the wait helper's 30 s
// default (#630). Both budgets are gone: `until` awaits the store's change signal now, so no inner
// clock can pre-empt the case's own (#671 row F-26).
const AGENT_STEPS = [{ id: 'task', name: 'Task', prompt: '{{task}}' }];
const DRY_HEAD = '0123456789abcdef0123456789abcdef01234567';
const GITHUB_REMOTE = 'https://github.com/acme/demo.git';

let opSeq = 0;
/** D-06 § 5.2: a fresh client-generated key per mutating operation. */
const op = (): string => `op-parity-${String(++opSeq).padStart(4, '0')}`;

/** The authoritative text block, parsed. Every tool in the registry answers compact JSON there,
 *  except `discover_project`, whose text is prose and whose structured content is the discovery. */
function body(result: McpToolResult): Record<string, any> {
  const text = resultText(result);
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return (result.structuredContent ?? { text }) as Record<string, any>;
  }
}

/** A result the leader can use (not an argument error or a failure), parsed. */
function ok(result: McpToolResult): Record<string, any> {
  expect(result.isError, resultText(result)).toBeFalsy();
  return body(result);
}

async function mcp(w: AbWorld, tool: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return ok(await w.call('a', tool, withVersion(w, tool, args)));
}

/** The tool actions that change one task, and so require its version (#250, N-03). */
const VERSIONED: Record<string, ReadonlySet<string> | 'all'> = {
  organise_work: new Set(['set_title', 'edit_brief', 'edit_queued_message', 'remove_queued_message', 'pin', 'unpin', 'archive', 'restore', 'delete', 'pick_variant']),
  execution_control: 'all',
  handoff_git: new Set(['commit', 'push', 'create_pr']),
  project_config: new Set(['remove_worktree']),
};

/**
 * A leader reads a task right before it changes it (#250): the version is the task's CURRENT one,
 * computed from A's own store with the same function the read route uses, so it adds no dispatch
 * to any observation. A task A does not have gets a well-formed version that matches nothing, and
 * the tool's own refusal for that id is what the case then sees. Stale writes are proved in
 * `composition.test.ts` (A-13) and `tools/stale-write-tools.test.ts`, not here.
 */
function withVersion(w: AbWorld, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const actions = VERSIONED[tool];
  if (!actions || 'expectedVersion' in args || (actions !== 'all' && !actions.has(String(args.action)))) return args;
  const id = typeof args.runId === 'string' ? args.runId : typeof args.taskId === 'string' ? args.taskId : undefined;
  return { ...args, expectedVersion: (id !== undefined ? runVersion(w.a.store, id) : undefined) ?? 'rev1:run:none:0:000000000000' };
}

/** The real stdio bridge (`runBridge`) in front of a given socket, with a minimal JSON-RPC client. */
function bridgeLeader(target: ServiceTarget): { request(method: string, params?: unknown): Promise<any>; close(): Promise<void> } {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  const framer = new LineFramer(
    (line) => {
      const message = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    },
    () => {},
  );
  output.on('data', (chunk: Buffer) => framer.push(chunk));
  const done = runBridge({ input, output, version: 'parity', tools, resolveTarget: async () => target });
  let next = 1;
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
        input.write(encodeFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
      }),
    close: async () => {
      input.end();
      await done;
    },
  };
}

/** One `leader_events` call through a bridge, answered as its structured content. */
async function leaderEvents(leader: ReturnType<typeof bridgeLeader>, args: Record<string, unknown>): Promise<Record<string, any>> {
  // `ack` writes the leader's position, so it takes a fresh operation key (#264); `read` refuses one.
  const result = (await leader.request('tools/call', {
    name: 'leader_events',
    arguments: withOperationId('leader_events', args),
  })) as McpToolResult;
  expect(result.isError, resultText(result)).toBeFalsy();
  return result.structuredContent as Record<string, any>;
}

/** The human's door: a same-origin cockpit request, answered as status and parsed JSON. */
async function ui(w: AbWorld, path: string, method = 'GET', payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await w.cockpit(path.startsWith('/api/') ? path : `${A_API}${path}`, method, payload);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — kept as text for the assertion message.
  }
  return { status: res.status, body: parsed };
}

/**
 * Await the world's OWN change signal instead of a fixed budget (#671 row F-26; the pattern #749
 * set for `engine-leader-incidents.test.ts`).
 *
 * Every condition these cases wait for is a fact about A's run store, and `RunStore` extends
 * `EventEmitter`: it emits `run` on every record mutation and `event` on every appended event. So
 * the chain these waits were guessing at — cockpit or MCP call → run manager → agent session →
 * events → run record — ends on a signal, and a 30 s inner deadline was only ever a guess at when
 * it had finished. Under gate load that guess was the flake: P-14 died at 30 468 ms inside a case
 * whose OWN budget is 90 s (gate attempt `f33a31c7`, run `44cca504`), and P-15 died the same way.
 * The case's `it(…, timeout)` is the only clock now — not widened, just no longer pre-empted by a
 * smaller one.
 *
 * `predicate` must be a function of the store's state (a status, a record field, a path the store
 * stamped before it published the record), because a signal is what re-reads it. A wait that never
 * resolves fails as the case's own timeout; the `afterEach` below then names `what`, so the
 * failure still says which condition was outstanding.
 */
async function until(w: AbWorld, predicate: () => boolean, what: string): Promise<void> {
  if (predicate()) return;
  const store = w.a.store;
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (!predicate()) return;
      release();
      resolve();
    };
    const release = (): void => {
      store.off('run', check);
      store.off('event', check);
      parked = null;
    };
    parked = { what, release };
    store.on('run', check);
    store.on('event', check);
  });
}

/** The wait a case is currently parked on, so a case that ends while parked can name it. */
let parked: { what: string; release: () => void } | null = null;

// A case can only end with a wait still parked by running out of its own time, and vitest's
// `Test timed out in 90000ms` does not say WHAT it was waiting for. This says it, and detaches
// the store listeners the abandoned wait left behind (review of PR #765, Minor 4). No clock: the
// case's own timeout is still the only one.
afterEach(() => {
  const abandoned = parked;
  if (!abandoned) return;
  abandoned.release();
  expect.fail(`the case ended while still waiting for ${abandoned.what}`);
});

const run = (w: AbWorld, id: string): RunRecord | undefined => w.a.store.getRun(id);

/** Start a task through the cockpit (the human's door) and answer its ids. */
async function uiStart(w: AbWorld, payload: Record<string, unknown>): Promise<string[]> {
  const res = await ui(w, '/runs', 'POST', payload);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return 'runs' in res.body ? (res.body.runs as Array<{ id: string }>).map((r) => r.id) : [res.body.id as string];
}

/** Occupy both of the world's slots (maxParallel 2) so the next start stays genuinely queued. */
async function holdBothSlots(w: AbWorld): Promise<string[]> {
  const ids = [
    ...(await uiStart(w, { task: 'hold one', steps: [{ id: 'hold', name: 'Hold', command: HOLD_COMMAND }] })),
    ...(await uiStart(w, { task: 'hold two', steps: [{ id: 'hold', name: 'Hold', command: HOLD_COMMAND }] })),
  ];
  await until(w, () => ids.every((id) => run(w, id)?.status === 'running'), 'both holds to take the two slots');
  return ids;
}

/** A finished task with its own worktree and branch, started the way the cockpit starts one. */
async function finishedWithWorktree(w: AbWorld, task: string): Promise<RunRecord> {
  const [id] = await uiStart(w, { task, steps: [{ id: 'ok', name: 'Ok', command: OK_COMMAND }] });
  await until(w, () => run(w, id!)?.status === 'done' && Boolean(run(w, id!)?.worktreePath && existsSync(run(w, id!)!.worktreePath!)), `${task} to finish`);
  return run(w, id!)!;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branchExists = (root: string, branch: string): boolean => git(root, 'branch', '--list', branch) !== '';
const userMessages = (w: AbWorld, id: string): string[] =>
  w.a.store.readEvents(id).filter((e) => e.type === 'user-message').map((e) => String((e as { text?: unknown }).text));
const asks = (w: AbWorld, id: string) => w.a.store.readEvents(id).filter((e) => e.type === 'ask.requested');

/** The facts of a task record that a start decides — the fields compared across the two doors. */
const startFacts = (r: RunRecord | undefined) => ({
  workflow: r?.workflow,
  task: r?.task,
  runner: r?.runner,
  model: r?.model,
  agentProfile: r?.agentProfile,
  autonomous: r?.autonomous,
  generateFollowups: r?.generateFollowups,
  worktree: r?.worktree,
  steps: r?.workflowDef?.steps,
});

/** The flags the organising actions change — compared across the two doors. */
const flags = (r: RunRecord | undefined) => ({
  title: r?.titleSummary ?? r?.title,
  pinned: r?.pinned === true,
  archived: r?.archived === true,
  unread: r?.seenAt === undefined,
});

/** Every file under a directory, relative, sorted — for "no MCP-only duplicate" comparisons. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

/** A tool bound to A exactly as the world wires it, but whose FORGE answers are replaced where
 *  `override` says so — the controlled backend a quality-blocked pull request needs, since the
 *  dry-run forge only ever reports a mergeable one. Everything else is the world's own service. */
function withForge(w: AbWorld, override: (pathname: string) => Response | undefined): { call: (args: Record<string, unknown>) => Promise<McpToolResult>; dispatched: string[] } {
  const dispatched: string[] = [];
  const service: ServiceDispatch = {
    request: (input, init) => {
      const url = new URL(input);
      dispatched.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return override(url.pathname) ?? w.service.request(input, init);
    },
  };
  const ctx = { project: { id: PROJECT_A, name: w.a.name, root: w.a.root }, xezarVersion: '0.0.0-ab', service } as McpToolContext;
  return {
    dispatched,
    call: async (args) => {
      const parsed = handoffGitTool.inputSchema.safeParse(withOperationId(handoffGitTool, args));
      if (!parsed.success) return { content: [{ type: 'text', text: `Invalid arguments for handoff_git: ${parsed.error.message}` }], isError: true };
      return handoffGitTool.call(parsed.data, ctx);
    },
  };
}

// ---- world lifecycle and environment hygiene --------------------------------------------------

/** A mock agent spawned here inherits the process env; a xezar task running this suite has its OWN
 *  handoff file, inbox and task id there, which the mock must never write into. Git runs hermetic:
 *  no developer identity, hooks path or signing config reaches a commit this suite makes. */
const SCRUBBED_ENV = ['XEZ_HANDOFF_FILE', 'XEZ_TODOS_FILE', 'XEZ_TASK_ID', 'XEZ_AGENT_MODELS_LOCKED', 'XEZ_REMOTE'] as const;
const PINNED_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'parity',
  GIT_AUTHOR_EMAIL: 'parity@example.invalid',
  GIT_COMMITTER_NAME: 'parity',
  GIT_COMMITTER_EMAIL: 'parity@example.invalid',
};
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [...SCRUBBED_ENV, ...Object.keys(PINNED_ENV), 'XEZ_FOLLOWUPS']) savedEnv[key] = process.env[key];
  for (const key of SCRUBBED_ENV) delete process.env[key];
  Object.assign(process.env, PINNED_ENV);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withWorld(options: AbWorldOptions = {}, prepare?: (w: AbWorld) => void): () => AbWorld {
  let world: AbWorld | undefined;
  beforeEach(async () => {
    world = await createAbWorld(options);
    prepare?.(world);
  }, 60_000);
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
  }, 60_000);
  return () => world!;
}

/** Give A a GitHub remote whose pushes land in a local bare repository — the controlled forge. */
function addForgeRemote(w: AbWorld): void {
  const bare = join(w.home, 'remote.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare');
  git(w.a.root, 'remote', 'add', 'origin', GITHUB_REMOTE);
  git(w.a.root, 'config', `url.${bare}.pushInsteadOf`, GITHUB_REMOTE);
}

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('#116 parity and collaboration acceptance — A/B world', { timeout: 180_000 }, () => {
  // =============================================================================================
  // A-06 — choose workflow, runner and model; create; edit a queued brief; organise; variants.
  // =============================================================================================
  describe('A-06 — creating, planning and organising work', () => {
    const world = withWorld();

    parity('P-01', ['A-06', 'A-05'], ['I-001', 'I-007', 'I-009', 'I-080'], 'a start with the form’s values lands the same record through either door, with the same refusals', async () => {
      const w = world();
      const prompt = 'Fix #142: Login form drops session on refresh — https://github.com/mock/repo/issues/142';
      const form = { runner: 'claude', worktree: true, autonomous: false, generateFollowups: false } as const;
      const seen = await w.observe(async () => {
        // The model picker at "auto" (''): the composer then sends no `model` key at all.
        const viaMcp = await mcp(w, 'task_create', { operationId: op(), prompt, source: { source: 'workflow', ref: w.a.ids.workflow }, model: '', ...form });
        const [viaUi] = await uiStart(w, { task: prompt, workflow: w.a.ids.workflow, ...form });
        return { viaMcp, viaUi };
      });
      assertIsolated(w, seen, { echoes: [prompt] });
      const { viaMcp, viaUi } = seen.response;
      expect(viaMcp).toMatchObject({ accepted: true, status: 'accepted', subject: { type: 'run' } });
      const mcpId = viaMcp.subject.id as string;
      // The business outcome: one record each, and the start decided the same facts in both.
      expect(startFacts(run(w, mcpId))).toEqual(startFacts(run(w, viaUi!)));
      expect(run(w, mcpId)).toMatchObject({ workflow: w.a.ids.workflow, task: prompt, runner: 'claude' });
      // The effective values the leader is told are the ones the record carries.
      expect(viaMcp.effective).toMatchObject({ runner: 'claude', worktree: true, autonomous: false, generateFollowups: false });

      // The same validation: a value the form cannot express is refused by both doors, and
      // neither refusal creates a task.
      const before = w.a.store.listRuns().length;
      const badMcp = await w.call('a', 'task_create', { operationId: op(), prompt: 'x', variants: 4 });
      const badUi = await ui(w, '/runs', 'POST', { task: 'x', workflow: 'quick-task', variants: 4 });
      expect(badMcp.isError).toBe(true);
      expect(badUi.status).toBe(400);
      const unknownMcp = await w.call('a', 'task_create', { operationId: op(), prompt: 'x', source: { source: 'workflow', ref: 'no-such-flow' } });
      const unknownUi = await ui(w, '/runs', 'POST', { task: 'x', workflow: 'no-such-flow' });
      expect(unknownMcp.isError).toBe(true);
      expect(resultText(unknownMcp)).toMatch(/unknown workflow/);
      expect(unknownUi.status).toBeGreaterThanOrEqual(400);
      expect(w.a.store.listRuns().length).toBe(before);
    });

    parity('P-02', ['A-06'], ['I-094', 'I-147'], 'a start from a project skill runs that skill, as the skills panel’s and the GitHub tab’s New issue start do', async () => {
      const w = world();
      mkdirSync(join(w.a.root, '.xezar', 'skills'), { recursive: true });
      writeFileSync(join(w.a.root, '.xezar', 'skills', 'parity-notes.md'), '---\nname: parity-notes\ndescription: parity skill\n---\nApply the notes.\n', 'utf8');
      const started = await mcp(w, 'task_create', { operationId: op(), prompt: 'apply the upgrade notes', source: { source: 'skill', ref: 'parity-notes' } });
      expect(started).toMatchObject({ accepted: true, effective: { source: { source: 'skill', ref: 'parity-notes' } } });
      const record = run(w, started.subject.id)!;
      expect(JSON.stringify(record.workflowDef ?? record.steps)).toContain('parity-notes');
      // An unknown skill is refused, never replaced by the default.
      const unknown = await w.call('a', 'task_create', { operationId: op(), prompt: 'x', source: { source: 'skill', ref: 'no-such-skill' } });
      expect(unknown.isError).toBe(true);
      expect(resultText(unknown)).toMatch(/unknown skill/);
    });

    parity('P-03', ['A-06', 'A-05'], ['I-002', 'I-085'], 'a plan request answers the steps, rationale and fallback the cockpit’s planner answers', async () => {
      const w = world();
      const viaMcp = await mcp(w, 'task_create', { action: 'plan', operationId: op(), prompt: 'add a login page' });
      const viaUi = await ui(w, '/plan', 'POST', { task: 'add a login page' });
      expect(viaUi.status).toBe(200);
      expect({ steps: viaMcp.steps, rationale: viaMcp.rationale, fallback: viaMcp.fallback }).toEqual({
        steps: viaUi.body.steps,
        rationale: viaUi.body.rationale,
        fallback: viaUi.body.fallback,
      });
      expect(viaMcp.steps.length).toBeGreaterThan(0);
    });

    parity('P-04', ['A-06', 'A-05'], ['I-003'], 'a start from an edited step list runs exactly that list, as the plan review’s start does', async () => {
      const w = world();
      const steps = [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        { id: 'review', name: 'Review', prompt: 'Review {{task}}' },
      ];
      const viaMcp = await mcp(w, 'task_create', { operationId: op(), prompt: 'planned work', steps });
      const [viaUi] = await uiStart(w, { task: 'planned work', steps });
      expect(run(w, viaMcp.subject.id)?.workflowDef?.steps).toEqual(run(w, viaUi!)?.workflowDef?.steps);
      expect(run(w, viaMcp.subject.id)?.workflowDef?.steps?.map((s) => s.id)).toEqual(['implement', 'review']);
      // No workflow file was written for either: an edited plan runs without being saved.
      expect(readdirSync(join(w.a.root, '.xezar', 'workflows'))).toEqual([`${w.a.ids.workflow}.yaml`]);
    });

    parity('P-05', ['A-06', 'A-05'], ['I-005'], 'saving a step list asks the same overwrite decision and writes the same workflow file', async () => {
      const w = world();
      const steps = [{ id: 'only', name: 'Only', prompt: '{{task}}' }];
      const file = (name: string) => join(w.a.root, '.xezar', 'workflows', `${name}.yaml`);
      const first = await mcp(w, 'task_create', { action: 'save_plan', operationId: op(), name: 'mcp-chain', steps });
      expect(first).toMatchObject({ status: 'done' });
      const firstUi = await ui(w, '/workflows', 'POST', { name: 'ui-chain', steps });
      expect(firstUi.status).toBeLessThan(300);
      // The same bytes, modulo the name: one serializer, two doors.
      expect(readFileSync(file('mcp-chain'), 'utf8').replaceAll('mcp-chain', 'X')).toBe(readFileSync(file('ui-chain'), 'utf8').replaceAll('ui-chain', 'X'));

      // An existing name is a decision, not a silent overwrite — for both doors.
      const changed = [{ id: 'only', name: 'Only', prompt: 'changed {{task}}' }];
      const again = await w.call('a', 'task_create', { action: 'save_plan', operationId: op(), name: 'mcp-chain', steps: changed });
      const againUi = await ui(w, '/workflows', 'POST', { name: 'ui-chain', steps: changed });
      expect(againUi.status).toBe(409);
      expect(body(again)).toMatchObject({ accepted: false, status: 'conflict' });
      expect(readFileSync(file('mcp-chain'), 'utf8')).not.toContain('changed');
      // The explicit decision replaces it.
      expect(await mcp(w, 'task_create', { action: 'save_plan', operationId: op(), name: 'mcp-chain', steps: changed, overwrite: true })).toMatchObject({ status: 'done' });
      expect((await ui(w, '/workflows', 'POST', { name: 'ui-chain', steps: changed, overwrite: true })).status).toBeLessThan(300);
      expect(readFileSync(file('mcp-chain'), 'utf8').replaceAll('mcp-chain', 'X')).toBe(readFileSync(file('ui-chain'), 'utf8').replaceAll('ui-chain', 'X'));
      expect(readFileSync(file('mcp-chain'), 'utf8')).toContain('changed');
    });

    parity('P-06', ['A-06', 'A-05'], ['I-008'], 'N variants start as one group of isolated tasks through either door', async () => {
      const w = world();
      const steps = [{ id: 'ok', name: 'Ok', command: OK_COMMAND }];
      const viaMcp = await mcp(w, 'task_create', { operationId: op(), prompt: 'two ways', steps, variants: 2 });
      const uiIds = await uiStart(w, { task: 'two ways', steps, variants: 2 });
      const groupOf = (ids: string[]) => new Set(ids.map((id) => run(w, id)?.groupId));
      const mcpGroup = w.a.store.listRuns().filter((r) => r.groupId && r.groupId === run(w, viaMcp.subject.id)?.groupId);
      expect(mcpGroup.map((r) => r.variant).sort()).toEqual(['A', 'B']);
      expect(uiIds.map((id) => run(w, id)?.variant).sort()).toEqual(['A', 'B']);
      expect(groupOf(uiIds).size).toBe(1);
      // Both groups run isolated: every member gets its own worktree.
      const all = [...mcpGroup.map((r) => r.id), ...uiIds];
      await until(w, () => all.every((id) => run(w, id)?.status === 'done'), 'all variants to finish');
      for (const id of all) expect(run(w, id)?.worktreePath && existsSync(run(w, id)!.worktreePath!)).toBeTruthy();
      // The availability condition is reported, not discovered by failure.
      const discovery = await mcp(w, 'discover_project');
      expect(discovery.actions.find((a: { id: string }) => a.id === 'parallel_variants')).toMatchObject({ status: 'available' });
    });

    parity('P-07', ['A-06', 'A-05', 'A-08'], ['I-015', 'I-016', 'I-018', 'I-019', 'I-020'], 'rename, pin, archive, restore and read state end the same through either door, and each door sees the other’s', async () => {
      const w = world();
      const [viaMcp, viaUi] = w.a.ids.variants; // two finished tasks in identical starting states
      const { title: _t1, ...startMcp } = flags(run(w, viaMcp));
      const { title: _t2, ...startUi } = flags(run(w, viaUi));
      expect(startMcp).toEqual(startUi);

      await mcp(w, 'organise_work', { action: 'set_title', runId: viaMcp, title: 'renamed' });
      expect((await ui(w, `/runs/${viaUi}`, 'PATCH', { title: 'renamed' })).status).toBe(200);
      await mcp(w, 'organise_work', { action: 'pin', runId: viaMcp });
      expect((await ui(w, `/runs/${viaUi}/pin`, 'POST', { pinned: true })).status).toBe(200);
      await mcp(w, 'organise_work', { action: 'mark_read', runId: viaMcp });
      expect((await ui(w, `/runs/${viaUi}/read`, 'POST')).status).toBe(200);
      expect(flags(run(w, viaMcp))).toEqual({ title: 'renamed', pinned: true, archived: false, unread: false });
      expect(flags(run(w, viaMcp))).toEqual(flags(run(w, viaUi)));
      // Archiving follows the store's own rule for the pin, whichever door archives.
      await mcp(w, 'organise_work', { action: 'archive', runId: viaMcp });
      expect((await ui(w, `/runs/${viaUi}/archive`, 'POST', { archived: true })).status).toBe(200);
      expect(flags(run(w, viaMcp))).toMatchObject({ title: 'renamed', archived: true, unread: false });
      expect(flags(run(w, viaMcp))).toEqual(flags(run(w, viaUi)));

      await mcp(w, 'organise_work', { action: 'restore', runId: viaMcp });
      expect((await ui(w, `/runs/${viaUi}/archive`, 'POST', { archived: false })).status).toBe(200);
      await mcp(w, 'organise_work', { action: 'unpin', runId: viaMcp });
      expect((await ui(w, `/runs/${viaUi}/pin`, 'POST', { pinned: false })).status).toBe(200);
      await mcp(w, 'organise_work', { action: 'mark_unread', runId: viaMcp });
      expect((await ui(w, `/runs/${viaUi}/unread`, 'POST')).status).toBe(200);
      expect(flags(run(w, viaMcp))).toEqual({ title: 'renamed', pinned: false, archived: false, unread: true });
      expect(flags(run(w, viaMcp))).toEqual(flags(run(w, viaUi)));

      // I-015: the leader's list is the cockpit's list, including what the human just changed.
      const listed = await mcp(w, 'task_read', { view: 'list', archived: 'include' });
      const cockpitList = await ui(w, '/runs');
      expect((listed.tasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual((cockpitList.body as Array<{ id: string }>).map((r) => r.id).sort());
      expect(listed.tasks.find((t: { id: string }) => t.id === viaUi)).toMatchObject({ title: 'renamed' });

      // Availability: the cockpit offers Archive only for a task that is not active, and so does MCP.
      const queuedBefore = JSON.stringify(run(w, w.a.ids.queued));
      expect(await mcp(w, 'organise_work', { action: 'archive', runId: w.a.ids.queued })).toMatchObject({ status: 'conflict' });
      expect(JSON.stringify(run(w, w.a.ids.queued))).toBe(queuedBefore);
    });

    parity('P-08', ['A-06', 'A-05'], ['I-017'], 'the bulk archive sweeps exactly the project’s own finished tasks', async () => {
      const w = world();
      const terminal = w.a.store.listRuns().filter((r) => ['done', 'failed', 'cancelled', 'review'].includes(r.status) && !r.archived).map((r) => r.id).sort();
      const active = w.a.store.listRuns().filter((r) => r.status === 'queued').map((r) => r.id);
      const seen = await w.observe(() => mcp(w, 'organise_work', { action: 'archive_finished' }));
      assertIsolated(w, seen);
      expect(seen.response).toMatchObject({ status: 'done' });
      expect(JSON.stringify(seen.response)).toContain(String(terminal.length));
      for (const id of terminal) expect(run(w, id)?.archived).toBe(true);
      for (const id of active) expect(run(w, id)?.archived).toBeFalsy();
      // The cockpit's own sweep, run afterwards, finds nothing left: the same candidate set.
      const again = await ui(w, '/runs/archive-finished', 'POST');
      expect(again.status).toBe(200);
      expect(JSON.stringify(again.body)).toMatch(/"archived":\s*0|"count":\s*0|\[\]/);
    });

    parity('P-09', ['A-06', 'A-11', 'A-05'], ['I-021'], 'delete runs without a confirmation parameter and removes the task, transcript, worktree and branch exactly as the cockpit does', async () => {
      const w = world();
      const one = await finishedWithWorktree(w, 'delete me via mcp');
      const two = await finishedWithWorktree(w, 'delete me via ui');
      const transcript = (id: string) => join(w.a.dataDir, 'runs', `${id}.ndjson`);
      for (const r of [one, two]) {
        expect(existsSync(transcript(r.id))).toBe(true);
        expect(branchExists(w.a.root, r.branch!)).toBe(true);
      }
      const seen = await w.observe(() => mcp(w, 'organise_work', { action: 'delete', runId: one.id }));
      assertIsolated(w, seen);
      expect(seen.response).toMatchObject({ status: 'done', deleted: true });
      expect((await ui(w, `/runs/${two.id}`, 'DELETE')).status).toBe(200);
      for (const r of [one, two]) {
        expect(run(w, r.id)).toBeUndefined();
        expect(existsSync(transcript(r.id))).toBe(false);
        expect(existsSync(r.worktreePath!)).toBe(false);
        expect(branchExists(w.a.root, r.branch!)).toBe(false);
      }
      // F-04: the confirmation is a click, not a rule — no parameter reproduces it.
      expect(JSON.stringify(toolListing(tools.find((t) => t.name === 'organise_work')!).inputSchema)).not.toMatch(/confirm|force|approv|bypass|override/i);
      // A rule still applies: an active task is refused, as the cockpit hides Delete for it.
      const [active] = await holdBothSlots(w);
      expect(await mcp(w, 'organise_work', { action: 'delete', runId: active })).toMatchObject({ status: 'conflict' });
      expect(run(w, active!)?.status).toBe('running');
    });

    parity('P-10', ['A-06', 'A-11', 'A-05'], ['I-029', 'I-030'], 'variants are compared from the group read, the pick waits for every variant, and winner and others end as the cockpit leaves them', async () => {
      const w = world();
      const hold = [{ id: 'hold', name: 'Hold', command: HOLD_COMMAND }];
      const [early1, early2] = await uiStart(w, { task: 'still running', steps: hold, variants: 2 });
      await until(w, () => [early1, early2].every((id) => run(w, id!)?.status === 'running'), 'both variants to run');
      const earlyGroup = run(w, early1!)!.groupId!;
      // Refused while any variant is active — the cockpit disables Pick until all are terminal.
      expect(await mcp(w, 'organise_work', { action: 'pick_variant', groupId: earlyGroup, runId: early1 })).toMatchObject({ status: 'conflict' });
      expect(run(w, early2!)?.status).toBe('running');
      for (const id of [early1, early2]) await ui(w, `/runs/${id}/cancel`, 'POST');
      await until(w, () => [early1, early2].every((id) => run(w, id!)?.status === 'cancelled'), 'the early variants to stop');

      const ok = [{ id: 'ok', name: 'Ok', command: OK_COMMAND }];
      const mcpGroup = await uiStart(w, { task: 'pick via mcp', steps: ok, variants: 2 });
      const uiGroup = await uiStart(w, { task: 'pick via ui', steps: ok, variants: 2 });
      await until(w, () => [...mcpGroup, ...uiGroup].every((id) => run(w, id)?.status === 'done' && existsSync(run(w, id)!.worktreePath ?? '/nowhere')), 'all four variants to finish');
      const before = (id: string) => ({ tree: run(w, id)!.worktreePath!, branch: run(w, id)!.branch! });
      const m = { winner: before(mcpGroup[0]!), loser: before(mcpGroup[1]!) };
      const u = { winner: before(uiGroup[0]!), loser: before(uiGroup[1]!) };

      // I-029: the group read is the comparison the cockpit renders.
      const compared = await mcp(w, 'task_read', { view: 'group', groupId: run(w, mcpGroup[0]!)!.groupId });
      expect((compared.group.runs as Array<{ id: string }>).map((r) => r.id).sort()).toEqual([...mcpGroup].sort());
      const cockpitGroup = await ui(w, `/groups/${run(w, mcpGroup[0]!)!.groupId}`);
      expect(cockpitGroup.status).toBe(200);

      expect(await mcp(w, 'organise_work', { action: 'pick_variant', groupId: run(w, mcpGroup[0]!)!.groupId, runId: mcpGroup[0] })).toMatchObject({ status: 'done' });
      expect((await ui(w, `/groups/${run(w, uiGroup[0]!)!.groupId}/pick`, 'POST', { runId: uiGroup[0] })).status).toBe(200);
      for (const [ids, paths] of [
        [mcpGroup, m],
        [uiGroup, u],
      ] as const) {
        expect(run(w, ids[0]!)?.archived).toBeFalsy();
        expect(existsSync(paths.winner.tree)).toBe(true);
        expect(branchExists(w.a.root, paths.winner.branch)).toBe(true);
        expect(run(w, ids[1]!)).toMatchObject({ archived: true });
        expect(existsSync(paths.loser.tree)).toBe(false);
        expect(branchExists(w.a.root, paths.loser.branch)).toBe(false);
      }
    });

    parity('P-11', ['A-06', 'A-07', 'A-05'], ['I-035'], 'a queued brief and its queued messages are edited and removed with the same effect through either door', async () => {
      const w = world();
      await holdBothSlots(w);
      const [q1] = await uiStart(w, { task: 'original brief', steps: AGENT_STEPS });
      const [q2] = await uiStart(w, { task: 'original brief', steps: AGENT_STEPS });
      expect([run(w, q1!)?.status, run(w, q2!)?.status]).toEqual(['queued', 'queued']);
      const stack = async (id: string) => {
        const a = await ui(w, `/runs/${id}/messages`, 'POST', { text: 'first note' });
        const b = await ui(w, `/runs/${id}/messages`, 'POST', { text: 'second note' });
        return [a.body.message.id as string, b.body.message.id as string];
      };
      const [m1a, m1b] = await stack(q1!);
      const [m2a, m2b] = await stack(q2!);

      // The leader sees the queue in start order, with the ids its edits need.
      const queue = await mcp(w, 'organise_work', { action: 'list_queue' });
      const order = (queue.items as Array<{ id: string }>).map((i) => i.id);
      expect(order.filter((id) => id === q1 || id === q2)).toEqual([q1, q2]);
      expect(order.indexOf(q1!)).toBeGreaterThan(order.indexOf(w.a.ids.queued)); // oldest first

      expect(await mcp(w, 'organise_work', { action: 'edit_brief', runId: q1, task: 'edited brief' })).toMatchObject({ status: 'done' });
      expect((await ui(w, `/runs/${q2}`, 'PATCH', { task: 'edited brief' })).status).toBe(200);
      expect(await mcp(w, 'execution_control', { action: 'edit_queued_message', runId: q1, messageId: m1a, text: 'edited note' })).toMatchObject({ accepted: true });
      expect((await ui(w, `/runs/${q2}/queued-messages/${m2a}`, 'PATCH', { text: 'edited note' })).status).toBe(200);
      expect(await mcp(w, 'organise_work', { action: 'remove_queued_message', runId: q1, messageId: m1b })).toMatchObject({ status: 'done' });
      expect((await ui(w, `/runs/${q2}/queued-messages/${m2b}`, 'DELETE')).status).toBe(200);

      const queued = (id: string) => ({ task: run(w, id)?.task, messages: run(w, id)?.queuedMessages?.map((m) => m.text) });
      expect(queued(q1!)).toEqual({ task: 'edited brief', messages: ['edited note'] });
      expect(queued(q1!)).toEqual(queued(q2!));
    });

    parity('P-12', ['A-06', 'A-05'], ['I-042'], 'a task read answers the runner, model, account handle and label, and the models lock — never the identity behind the account', async () => {
      const w = world();
      const started = await mcp(w, 'task_create', { operationId: op(), prompt: 'who runs me', runner: 'claude', model: 'sonnet', agentProfile: 'default' });
      const read = await mcp(w, 'task_read', { view: 'task', taskId: started.subject.id });
      const cockpit = await ui(w, `/runs/${started.subject.id}`);
      expect(read.task).toMatchObject({ runner: 'claude', model: 'sonnet', agentProfile: 'default' });
      expect({ runner: read.task.runner, model: read.task.model, agentProfile: read.task.agentProfile }).toEqual({
        runner: cockpit.body.runner,
        model: cockpit.body.model,
        agentProfile: cockpit.body.agentProfile,
      });
      // The account's label is readable by its handle (D-42), and the lock is a project fact.
      const account = await mcp(w, 'project_config', { action: 'get_account' });
      expect(account.result.accounts).toContainEqual({ provider: 'claude', handle: 'default', label: 'Default' });
      const discovery = await mcp(w, 'discover_project');
      expect(discovery.settings).toMatchObject({ modelsLocked: false });
      // F-12 / N-01: nothing on the way names an email, an organisation or a plan.
      const surface = JSON.stringify({ read, account, discovery });
      expect(surface).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}|"(email|organization|organisation|org|plan)"\s*:/i);
    });
  });

  // =============================================================================================
  // A-07 — every control, an answered question, an edited message, a continued closed session,
  // an invalid transition; A's controls never reach B, and no host-process control exists.
  // =============================================================================================
  describe('A-07 — execution control and session messaging', () => {
    const world = withWorld();

    parity('P-13', ['A-07', 'A-05'], ['I-037'], 'cancel stops exactly the named task, keeps its worktree as the cockpit does, and never reaches another task or B', async () => {
      const w = world();
      const [one, two] = await holdBothSlots(w);
      const seen = await w.observe(async () => {
        // A RUNNING task's version moves with every event its agent records (#250), so a cancel can
        // meet a newer version than the one read. The leader does what the refusal says — read
        // again and decide again — and each refusal applied nothing.
        let answer = await mcp(w, 'execution_control', { action: 'cancel', runId: one });
        for (let tries = 0; answer.error === 'stale_version' && tries < 50; tries += 1) {
          expect(answer).toMatchObject({ status: 'conflict', applied: false });
          answer = await mcp(w, 'execution_control', { action: 'cancel', runId: one });
        }
        await until(w, () => run(w, one!)?.status === 'cancelled', 'the MCP-cancelled task to stop');
        return answer;
      });
      assertIsolated(w, seen);
      expect(seen.response).toMatchObject({ accepted: true, subject: { type: 'run', id: one } });
      // Only the named task: its sibling in the same project keeps running.
      expect(run(w, two!)?.status).toBe('running');
      expect(w.contextA.manager.isActive(two!)).toBe(true);
      expect((await ui(w, `/runs/${two}/cancel`, 'POST')).status).toBe(200);
      await until(w, () => run(w, two!)?.status === 'cancelled', 'the cockpit-cancelled task to stop');
      for (const id of [one!, two!]) expect(existsSync(run(w, id)!.worktreePath!)).toBe(true);

      // No tool takes a process id, a signal, a command or a host path (F-08, M-04).
      const forbiddenWord = /^(pids?|signals?|process(es)?|kill|cwd|exec|pgid)$/;
      const names: string[] = [];
      const walk = (node: unknown, prefix: string): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as { properties?: Record<string, unknown>; items?: unknown };
        for (const [key, child] of Object.entries(n.properties ?? {})) {
          names.push(`${prefix}${key}`);
          walk(child, `${prefix}${key}.`);
        }
        walk(n.items, `${prefix}[].`);
      };
      for (const tool of tools) walk(toolListing(tool).inputSchema, `${tool.name}.`);
      const offending = names.filter((name) => name.split(/\.|\[\]/).filter(Boolean).pop()!.split(/(?=[A-Z])|[_-]/).some((word) => forbiddenWord.test(word.toLowerCase())));
      expect(offending).toEqual([]);
    });

    parity('P-14', ['A-07', 'A-05'], ['I-034', 'I-038', 'I-039', 'I-032'], 'messages, finish and continue follow the session state through either door, and an invalid transition changes nothing', async () => {
      const w = world();
      const [t1, t2] = [...(await uiStart(w, { task: 'say hello', steps: AGENT_STEPS })), ...(await uiStart(w, { task: 'say hello', steps: AGENT_STEPS }))];
      await until(w, () => run(w, t1!)?.status === 'waiting' && run(w, t2!)?.status === 'waiting', 'both sessions to wait for a reply');

      // I-034 on an open session: delivered live, recorded as the same user message.
      expect(await mcp(w, 'execution_control', { action: 'send_message', runId: t1, text: 'and goodbye' })).toMatchObject({ accepted: true, delivery: 'live' });
      expect((await ui(w, `/runs/${t2}/messages`, 'POST', { text: 'and goodbye' })).status).toBeLessThan(300);
      await until(w, () => run(w, t1!)?.status === 'waiting' && run(w, t2!)?.status === 'waiting', 'both replies to settle');
      expect(userMessages(w, t1!)).toEqual(userMessages(w, t2!));

      // I-032: the resolve-conflicts button sends a fixed instruction; the leader sends the same text.
      const resolve = 'Resolve the merge conflicts on PR #128 and push the result.';
      expect(await mcp(w, 'execution_control', { action: 'send_message', runId: t1, text: resolve })).toMatchObject({ accepted: true });
      expect(userMessages(w, t1!).at(-1)).toBe(resolve);
      await until(w, () => run(w, t1!)?.status === 'waiting', 'the instruction to settle');

      // Invalid transition: finish with the review meaning on a waiting task is refused, unchanged.
      const frozen = JSON.stringify({ r: run(w, t1!), n: w.a.store.readEvents(t1!).length });
      expect(await mcp(w, 'execution_control', { action: 'finish', runId: t1, finishAs: 'accept_review' })).toMatchObject({ accepted: false, status: 'conflict' });
      expect(JSON.stringify({ r: run(w, t1!), n: w.a.store.readEvents(t1!).length })).toBe(frozen);

      // I-038: finish closes the session through either door.
      expect(await mcp(w, 'execution_control', { action: 'finish', runId: t1, finishAs: 'close_session' })).toMatchObject({ accepted: true });
      expect((await ui(w, `/runs/${t2}/finish`, 'POST')).status).toBe(200);
      await until(w, () => run(w, t1!)?.status === 'done' && run(w, t2!)?.status === 'done', 'both sessions to close');
      const closed = (id: string) => w.a.store.readEvents(id).some((e) => e.type === 'lifecycle' && (e as { message?: string }).message === 'session closed by user');
      expect([closed(t1!), closed(t2!)]).toEqual([true, true]);

      // I-039: a closed session continues with accompanying text through either door.
      expect(await mcp(w, 'execution_control', { action: 'continue', runId: t1, text: 'one more thing' })).toMatchObject({ accepted: true, delivery: 'continued' });
      expect((await ui(w, `/runs/${t2}/continue`, 'POST', { text: 'one more thing' })).status).toBeLessThan(300);
      await until(w, () => run(w, t1!)?.status === 'waiting' && run(w, t2!)?.status === 'waiting', 'both sessions to reopen');
      expect(userMessages(w, t1!).at(-1)).toBe('one more thing');
      expect(userMessages(w, t2!).at(-1)).toBe('one more thing');

      // Invalid transition on a finished check task: cancel and continue are refused, unchanged.
      const done = await finishedWithWorktree(w, 'no session here');
      const doneBefore = JSON.stringify(run(w, done.id));
      for (const args of [{ action: 'cancel' }, { action: 'continue' }, { action: 'finish', finishAs: 'close_session' }]) {
        expect(await mcp(w, 'execution_control', { ...args, runId: done.id }), JSON.stringify(args)).toMatchObject({ accepted: false, status: 'conflict' });
      }
      expect(JSON.stringify(run(w, done.id))).toBe(doneBefore);
    });

    parity('P-15', ['A-07', 'A-05'], ['I-036'], 'an answer reaches the question it names and is delivered as the ask card delivers it', async () => {
      const w = world();
      const [t1, t2] = [...(await uiStart(w, { task: 'mock:ask which library?', steps: AGENT_STEPS })), ...(await uiStart(w, { task: 'mock:ask which library?', steps: AGENT_STEPS }))];
      await until(w, () => run(w, t1!)?.status === 'waiting' && run(w, t2!)?.status === 'waiting', 'both tasks to park at their questions');
      const q1 = String((asks(w, t1!)[0] as { requestId?: unknown }).requestId);
      const q2 = String((asks(w, t2!)[0] as { requestId?: unknown }).requestId);
      // The other task's question, named against this task, is refused: nothing is sent.
      const before = userMessages(w, t1!);
      expect(await mcp(w, 'execution_control', { action: 'answer_question', runId: t1, questionId: q2, answers: [{ choices: ['date-fns'] }] })).toMatchObject({ accepted: false, status: 'conflict' });
      expect(userMessages(w, t1!)).toEqual(before);
      // The right pairing: the leader's answer and the ask card's are the same message.
      expect(await mcp(w, 'execution_control', { action: 'answer_question', runId: t1, questionId: q1, answers: [{ choices: ['date-fns'] }] })).toMatchObject({ accepted: true, delivery: 'live', questionId: q1 });
      expect((await ui(w, `/runs/${t2}/messages`, 'POST', { text: 'Library: date-fns' })).status).toBeLessThan(300);
      expect(userMessages(w, t1!).at(-1)).toBe('Library: date-fns');
      expect(userMessages(w, t1!).at(-1)).toBe(userMessages(w, t2!).at(-1));
    });

    parity('P-16', ['A-07', 'A-05'], ['I-040'], 'a scheduled automatic resume is inspected and cancelled with the same effect through either door', async () => {
      const w = world();
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const [t1, t2] = w.a.ids.variants;
      w.a.store.updateRun(t1, { autoResumeAt: at });
      w.a.store.updateRun(t2, { autoResumeAt: at });
      const read = await mcp(w, 'task_read', { view: 'task', taskId: t1 });
      expect(read.task.autoResumeAt).toBe(at);
      expect(await mcp(w, 'execution_control', { action: 'cancel_auto_resume', runId: t1 })).toMatchObject({ accepted: true, hadPendingAutoResume: true });
      expect((await ui(w, `/runs/${t2}/auto-resume`, 'DELETE')).status).toBe(200);
      expect([run(w, t1)?.autoResumeAt, run(w, t2)?.autoResumeAt]).toEqual([undefined, undefined]);
    });

    parity('P-17', ['A-07', 'A-10', 'A-05'], ['I-051'], 'at review, accept and send back behave as the review panel’s buttons', async () => {
      const w = world();
      const [t1, t2] = [...(await uiStart(w, { task: 'say hello', steps: AGENT_STEPS })), ...(await uiStart(w, { task: 'say hello', steps: AGENT_STEPS }))];
      await until(w, () => run(w, t1!)?.status === 'waiting' && run(w, t2!)?.status === 'waiting', 'both sessions to wait');
      for (const id of [t1!, t2!]) await ui(w, `/runs/${id}/finish`, 'POST');
      await until(w, () => run(w, t1!)?.status === 'done' && run(w, t2!)?.status === 'done', 'both sessions to close');
      for (const id of [t1!, t2!]) w.a.store.updateRun(id, { status: 'review' });

      // Send back: the notes travel with the panel's prefix, through either door.
      expect(await mcp(w, 'execution_control', { action: 'continue', runId: t1, text: 'tighten the wording' })).toMatchObject({ accepted: true, delivery: 'continued' });
      expect((await ui(w, `/runs/${t2}/continue`, 'POST', { text: 'Review feedback:\ntighten the wording' })).status).toBeLessThan(300);
      expect(userMessages(w, t1!).at(-1)).toBe('Review feedback:\ntighten the wording');
      expect(userMessages(w, t1!).at(-1)).toBe(userMessages(w, t2!).at(-1));
      await until(w, () => run(w, t1!)?.status === 'waiting' && run(w, t2!)?.status === 'waiting', 'both sent-back sessions to reply');
      for (const id of [t1!, t2!]) await ui(w, `/runs/${id}/finish`, 'POST');
      await until(w, () => run(w, t1!)?.status === 'done' && run(w, t2!)?.status === 'done', 'both sessions to close again');
      for (const id of [t1!, t2!]) w.a.store.updateRun(id, { status: 'review' });

      // Accept without a PR: the same terminal state and the same journal line.
      expect(await mcp(w, 'execution_control', { action: 'finish', runId: t1, finishAs: 'accept_review' })).toMatchObject({ accepted: true, runStatus: 'done' });
      expect((await ui(w, `/runs/${t2}/finish`, 'POST')).status).toBe(200);
      const last = (id: string) => w.a.store.readEvents(id).filter((e) => e.type === 'lifecycle').at(-1);
      expect([run(w, t1!)?.status, run(w, t2!)?.status]).toEqual(['done', 'done']);
      expect((last(t1!) as { message?: string }).message).toBe((last(t2!) as { message?: string }).message);
    });

    parity('P-18', ['A-07', 'A-05'], ['I-044', 'I-114'], 'launching a desktop app is reported as a host capability, never promised on the client’s machine', async () => {
      const w = world();
      const discovery = await mcp(w, 'discover_project');
      expect(discovery.actions.find((a: { id: string }) => a.id === 'open_in_app')).toMatchObject({ status: 'available' });
      // The apps that can open things are the cockpit's list, and the answer names the HOST machine.
      // (Nothing is opened here: an open in local mode would launch an app on the test machine.)
      const apps = await mcp(w, 'local_handoff', { action: 'list_apps' });
      const cockpitApps = await ui(w, '/open-targets');
      expect(cockpitApps.status).toBe(200);
      expect(apps).toMatchObject({ status: 'done', outcome: 'listed', affects: 'xezar-host' });
      expect(apps.targets).toEqual(cockpitApps.body.targets);
      expect(apps.notice).toMatch(/not on the machine your MCP client runs on/);

      // Hosted: no desktop on the host. The cockpit's routes 409; the leader is told why, and
      // nothing is dispatched to try.
      process.env.XEZ_REMOTE = '1';
      const task = w.a.ids.done;
      const projectUi = await ui(w, '/open-in', 'POST', { target: 'finder' });
      const terminalUi = await ui(w, `/runs/${task}/open-in-cli`, 'POST');
      expect([projectUi.status, terminalUi.status]).toEqual([409, 409]);
      const before = w.dispatched.length;
      const project = await w.call('a', 'local_handoff', { action: 'open_project_in_app', target: 'finder' });
      const terminal = await w.call('a', 'local_handoff', { action: 'open_task_in_terminal', runId: task });
      for (const answer of [project, terminal]) {
        expect(body(answer)).toMatchObject({ outcome: 'unavailable', affects: 'nothing' });
        expect(resultText(answer)).toMatch(/hosted mode/);
      }
      expect(w.dispatched.slice(before).filter((d) => d.startsWith('POST'))).toEqual([]);
      expect((await mcp(w, 'discover_project')).actions.find((a: { id: string }) => a.id === 'open_in_app')).toMatchObject({ status: 'unavailable' });
    });
  });

  // =============================================================================================
  // A-08 — a human and a leader on the same project see each other's effects and can take over;
  // no MCP-only duplicate history or configuration exists.
  // =============================================================================================
  describe('A-08 — a human and a leader on the same project', () => {
    const world = withWorld();

    parity('P-19', ['A-08', 'A-05'], ['I-033', 'I-140'], 'the leader reads the human’s task, history and handoff as the cockpit does, and the human’s bus carries the leader’s change', async () => {
      const w = world();
      const [human] = await uiStart(w, { task: 'say hello', steps: AGENT_STEPS });
      await until(w, () => run(w, human!)?.status === 'waiting', 'the human’s task to wait');

      const listed = await mcp(w, 'task_read', { view: 'list' });
      expect((listed.tasks as Array<{ id: string }>).map((t) => t.id)).toContain(human);
      const read = await mcp(w, 'task_read', { view: 'task', taskId: human });
      const cockpit = await ui(w, `/runs/${human}`);
      const core = (r: Record<string, unknown>) => ({ id: r.id, status: r.status, workflow: r.workflow, task: r.task, branch: r.branch, runner: r.runner });
      expect(core(read.task)).toEqual(core(cockpit.body));

      // I-140: the leader's history replay is the transcript the cockpit replays — same events, same order.
      const history = await mcp(w, 'task_read', { view: 'history', taskId: human });
      const cockpitHistory = await ui(w, `/runs/${human}/history`);
      expect(cockpitHistory.status).toBe(200);
      const seqs = (events: Array<{ seq: number }>) => events.map((e) => e.seq).sort((x, y) => x - y);
      expect(seqs(history.events)).toEqual(seqs(cockpitHistory.body.events));
      expect(seqs(history.events)).toEqual(w.a.store.readEvents(human!).map((e) => e.seq).slice(-seqs(history.events).length));

      // The leader's change travels on the SAME bus the cockpit's SSE stream relays.
      const seen = await w.observe(() => mcp(w, 'organise_work', { action: 'set_title', runId: human, title: 'leader renamed' }));
      assertIsolated(w, seen, { echoes: ['leader renamed'] });
      expect(seen.events.a.some((e) => e.kind === 'run' && JSON.stringify(e.payload).includes('leader renamed'))).toBe(true);
      expect((await ui(w, `/runs/${human}`)).body.titleSummary ?? (await ui(w, `/runs/${human}`)).body.title).toBe('leader renamed');
    });

    parity('P-20', ['A-08', 'A-07'], ['I-033', 'I-034', 'I-038', 'I-039'], 'either side takes over the other’s task, and one transcript records both', async () => {
      const w = world();
      const started = await mcp(w, 'task_create', { operationId: op(), prompt: 'say hello', steps: AGENT_STEPS });
      const leaderTask = started.subject.id as string;
      await until(w, () => run(w, leaderTask)?.status === 'waiting', 'the leader’s task to wait');
      // The human takes over the leader's task: a message, then a close.
      expect((await ui(w, `/runs/${leaderTask}/messages`, 'POST', { text: 'human here' })).status).toBeLessThan(300);
      await until(w, () => run(w, leaderTask)?.status === 'waiting', 'the human’s message to settle');
      expect((await ui(w, `/runs/${leaderTask}/finish`, 'POST')).status).toBe(200);
      await until(w, () => run(w, leaderTask)?.status === 'done', 'the human to close it');
      // The leader takes it back: continue the session the human closed.
      expect(await mcp(w, 'execution_control', { action: 'continue', runId: leaderTask, text: 'leader again' })).toMatchObject({ accepted: true, delivery: 'continued' });
      await until(w, () => run(w, leaderTask)?.status === 'waiting', 'the reopened session to reply');
      expect(userMessages(w, leaderTask).slice(-2)).toEqual(['human here', 'leader again']);
      // The leader's read of it shows the human's message — no separate MCP transcript exists.
      const history = await mcp(w, 'task_read', { view: 'history', taskId: leaderTask });
      expect(JSON.stringify(history.events)).toContain('human here');
      expect(readdirSync(join(w.a.dataDir, 'runs')).filter((f) => f.startsWith(leaderTask))).toEqual(readdirSync(join(w.a.dataDir, 'runs')).filter((f) => f.startsWith(leaderTask) && !f.includes('mcp')));
    });

    parity('P-21', ['A-08', 'A-05'], ['I-001', 'I-018', 'I-010', 'I-110'], 'the same work through either door leaves the same files: no MCP-only history or configuration', async () => {
      const outer = world();
      const templates = [{ id: 'review', label: 'Review', text: 'Review {{task}}' }];
      const steps = [{ id: 'ok', name: 'Ok', command: OK_COMMAND }];
      const hashFiles = (w: AbWorld): Map<string, string> => {
        const out = new Map<string, string>();
        for (const dir of ['.local/xezar', '.xezar']) {
          for (const file of filesUnder(join(w.a.root, dir))) out.set(`${dir}/${file}`, readFileSync(join(w.a.root, dir, file)).toString('base64'));
        }
        return out;
      };
      /** What the work added or changed under A's own state, with run ids made comparable. The
       *  MCP door's OWN records — D-06's audit trail and D-05's journal — are the only files it may
       *  add, by decision; they are neither task history nor configuration. */
      const delta = (w: AbWorld, before: Map<string, string>, runsBefore: Set<string>): string[] => {
        const fresh = w.a.store.listRuns().filter((r) => !runsBefore.has(r.id)).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
        // Run ids and the fixture's randomly tagged workflow name differ between the two worlds.
        const norm = (path: string) =>
          fresh.reduce((p, r, i) => p.split(r.id).join(`<RUN${i}>`).split(r.id.slice(0, 8)).join(`<R${i}>`), path).split(w.a.ids.workflow).join('<FLOW>');
        return [...hashFiles(w)]
          .filter(([path, hash]) => before.get(path) !== hash)
          .map(([path]) => norm(path))
          .filter((path) => !/\/audit\.ndjson|event-journal/.test(path))
          .sort();
      };
      const act = async (w: AbWorld, door: 'mcp' | 'ui'): Promise<{ delta: string[]; config: string; uiState: string; transcript: string[] }> => {
        const before = hashFiles(w);
        const runsBefore = new Set(w.a.store.listRuns().map((r) => r.id));
        let id: string;
        if (door === 'mcp') {
          id = (await mcp(w, 'task_create', { operationId: op(), prompt: 'same work', steps })).subject.id;
          await until(w, () => run(w, id)?.status === 'done', 'the task to finish');
          await mcp(w, 'organise_work', { action: 'set_title', runId: id, title: 'same title' });
          await mcp(w, 'project_config', { action: 'set_config', config: { baseBranch: 'main' } });
          await mcp(w, 'project_config', { action: 'set_prompt_templates', promptTemplates: templates });
        } else {
          [id] = (await uiStart(w, { task: 'same work', steps })) as [string];
          await until(w, () => run(w, id)?.status === 'done', 'the task to finish');
          expect((await ui(w, `/runs/${id}`, 'PATCH', { title: 'same title' })).status).toBe(200);
          expect((await ui(w, '/config', 'PUT', { baseBranch: 'main' })).status).toBe(200);
          expect((await ui(w, '/ui-state', 'PUT', { promptTemplates: templates })).status).toBe(200);
        }
        w.a.store.flush();
        return {
          delta: delta(w, before, runsBefore),
          config: readFileSync(join(w.a.root, '.xezar', 'config.json'), 'utf8'),
          uiState: readFileSync(join(w.a.dataDir, 'ui-state.json'), 'utf8'),
          transcript: w.a.store.readEvents(id).map((e) => e.type),
        };
      };
      const viaMcp = await act(outer, 'mcp');
      const inner = await createAbWorld();
      try {
        const viaUi = await act(inner, 'ui');
        expect(viaMcp.delta).toEqual(viaUi.delta);
        expect(viaMcp.config).toBe(viaUi.config);
        expect(viaMcp.uiState).toBe(viaUi.uiState);
        expect(viaMcp.transcript).toEqual(viaUi.transcript);
      } finally {
        await inner.dispose();
      }
    }, 120_000);

    parity('P-22', ['A-08'], ['I-138', 'I-139'], 'the leader is told about the human’s changes through its own project’s journal: what changed, in order, with the current state, and nothing of B or the workspace', async () => {
      const w = world();
      // The MCP service exactly as `serve` composes it over A (#247, #251): its own journal, catalog,
      // cursors and `leader_events` port, over A's store and the cockpit's own routes. An event journal
      // keeps ONE live instance per project file (gapless numbering, `EventJournal.open`), so the
      // fixture's standalone journal hands A's file over first and the composed service owns it, as it
      // does in production. The socket gets its own short home, beside the fixture's own A socket.
      w.a.journal.close();
      // `startMcpService` binds only a REGISTERED project (D-02), and the fixture's contexts list A
      // without writing the registry — so A is registered here under its own id, as `serve` does at boot.
      await mergeWriteWorkspaceConfig((config) => {
        const now = new Date().toISOString();
        config.projects.push({ id: PROJECT_A, root: w.a.root, name: w.a.name, addedAt: now, lastOpenedAt: now, source: 'local' });
      });
      const home = realpathSync(mkdtempSync('/tmp/xzp22-'));
      const service = await startMcpService({ projectId: PROJECT_A, version: 'parity', service: w.service, store: w.a.store, env: { ...process.env, XEZ_HOME: home } });
      const leader = bridgeLeader({ kind: 'socket', path: service.path, project: { id: PROJECT_A, name: w.a.name } });
      try {
        // Connect: whatever is outstanding is read, then acknowledged — the leader starts current.
        const first = await leaderEvents(leader, { action: 'read' });
        expect(first.status).toBe('ok');
        await leaderEvents(leader, { action: 'ack', cursor: first.nextCursor });
        expect((await leaderEvents(leader, { action: 'read' })).events).toEqual([]);

        // The leader is away. The human works in the cockpit: a setting, then a task that finishes.
        const seen = await w.observe(async () => {
          expect((await ui(w, '/config', 'PUT', { baseBranch: 'develop' })).status).toBe(200);
          const [id] = await uiStart(w, { task: 'human work', steps: [{ id: 'ok', name: 'Ok', command: OK_COMMAND }] });
          await until(w, () => run(w, id!)?.status === 'done', 'the human’s task to finish');
          return id!;
        });
        const humanTask = seen.response;
        const back = await leaderEvents(leader, { action: 'read' });
        const rows = back.events as Array<Record<string, any>>;
        // In journal order, and every row is A's own.
        expect(rows.map((r) => r.journalSeq)).toEqual([...rows.map((r) => r.journalSeq as number)].sort((x, y) => x - y));
        expect(rows.every((r) => r.projectId === PROJECT_A)).toBe(true);
        // The human's setting: one E-05 row, the human's, naming the key and never its value (F-15).
        const settings = rows.filter((r) => r.category === 'E-05');
        expect(settings).toHaveLength(1);
        expect(settings[0]).toMatchObject({ origin: 'human' });
        expect(JSON.stringify(settings[0])).toContain('baseBranch');
        expect(JSON.stringify(settings[0])).not.toContain('develop');
        // The human's task: its outcome, and its CURRENT state beside it — the cockpit's own answer.
        expect(rows.some((r) => r.subject?.id === humanTask)).toBe(true);
        const state = (back.state.tasks as Array<{ id: string; status: string | null }>).find((t) => t.id === humanTask);
        expect(state?.status).toBe((await ui(w, `/runs/${humanTask}`)).body.status);
        // Project-filtered (I-138): nothing of B, and none of the workspace-only stream names.
        expect(leaked(JSON.stringify(back), w.b.names)).toEqual([]);
        expect(JSON.stringify(rows)).not.toMatch(/project-added|project-removed|checkout-progress|automation-change/);
        assertIsolated(w, seen);
        // Acknowledged, nothing is read again. B's own setting change after that reaches A's leader
        // not at all. (B has no composed service in this world, so this shows no cross-project
        // reporter — B's own feed is `leader-feed.test.ts`'s two-project proof.)
        await leaderEvents(leader, { action: 'ack', cursor: back.nextCursor });
        expect((await ui(w, `/api/v1/p/${PROJECT_B}/config`, 'PUT', { baseBranch: 'bravo-only' })).status).toBe(200);
        expect((await leaderEvents(leader, { action: 'read' })).events).toEqual([]);
        // I-139 — the pattern, not a new socket or topic: this project tool is the leader's ONLY event
        // door. Narrower than "no tool matches /event/" on purpose, because `leader_events` must; and
        // stronger, because it pins the one allowed name and still refuses any workspace feed.
        const names = ((await leader.request('tools/list')).tools as Array<{ name: string }>).map((t) => t.name);
        expect(names.filter((n) => /event/i.test(n))).toEqual(['leader_events']);
        expect(names.filter((n) => /workspace|subscribe|stream/i.test(n))).toEqual([]);
      } finally {
        await leader.close();
        service.close();
        rmSync(home, { recursive: true, force: true });
      }
    });

    parity('P-43', ['A-08', 'A-05'], ['I-141', 'I-142'], 'a Claude Code leader attaches, reads and stops its own delivery over MCP, and the cockpit’s connection status and Attach leader see the same leader', async () => {
      const w = world();
      // Composed exactly as P-22 composes it: the delivery path the route and the tool both reach.
      w.a.journal.close();
      await mergeWriteWorkspaceConfig((config) => {
        const now = new Date().toISOString();
        if (!config.projects.some((p) => p.id === PROJECT_A)) config.projects.push({ id: PROJECT_A, root: w.a.root, name: w.a.name, addedAt: now, lastOpenedAt: now, source: 'local' });
      });
      const home = realpathSync(mkdtempSync('/tmp/xzp43-'));
      const service = await startMcpService({ projectId: PROJECT_A, version: 'parity', service: w.service, store: w.a.store, env: { ...process.env, XEZ_HOME: home } });
      const leader = bridgeLeader({ kind: 'socket', path: service.path, project: { id: PROJECT_A, name: w.a.name } });
      const door = async (args: Record<string, unknown>): Promise<Record<string, any>> =>
        ((await leader.request('tools/call', { name: 'leader_events', arguments: withOperationId('leader_events', args) })) as McpToolResult).structuredContent as Record<string, any>;
      const shared = (status: Record<string, any>) => ({ owner: status.owner, leader: status.leader, blocker: status.blocker?.code ?? null });
      try {
        // Claude Code opens the session: the bridge announces it, and it owns A.
        await leader.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code' } });
        // I-141: the leader's status is the cockpit's connection status, plus what is true for it.
        const before = await door({ action: 'status' });
        expect(before).toMatchObject({ available: true, canPush: true, self: { client: 'claude-code', isOwner: true, attached: false } });
        expect(shared(before)).toEqual(shared((await ui(w, '/mcp/leader')).body));
        // I-142: the leader attaches ITSELF, and the cockpit sees the leader it attached.
        expect(await door({ action: 'attach' })).toMatchObject({ ok: true, outcome: 'attached' });
        expect((await ui(w, '/mcp/leader')).body).toMatchObject({ leader: { client: 'claude-code', state: 'attached' } });
        expect(shared(await door({ action: 'status' }))).toEqual(shared((await ui(w, '/mcp/leader')).body));
        // Stop through MCP, attach through the cockpit: each door sees the other's change.
        expect(await door({ action: 'stop' })).toMatchObject({ ok: true, outcome: 'stopped' });
        expect((await ui(w, '/mcp/leader')).body).toMatchObject({ leader: null });
        expect((await ui(w, '/mcp/leader', 'POST', { action: 'attach', client: 'claude-code' })).status).toBe(200);
        expect(await door({ action: 'status' })).toMatchObject({ leader: { client: 'claude-code' }, self: { attached: true } });
        // Nothing of B reaches A's leader.
        expect(leaked(JSON.stringify(await door({ action: 'status' })), w.b.names)).toEqual([]);
      } finally {
        await leader.close();
        service.close();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // =============================================================================================
  // A-09 — an authorized setting change appears in the cockpit and B is unchanged; global, home,
  // shared-account and limit changes are refused or need a separate human action.
  // =============================================================================================
  describe('A-09 — project settings behind the settings boundary', () => {
    const world = withWorld({}, (w) => {
      // The workspace registry lists both projects, as a cockpit that registered them would.
      writeFileSync(
        join(w.home, 'config.json'),
        `${JSON.stringify({ projects: [{ id: PROJECT_A, root: w.a.root, name: 'alpha project' }, { id: PROJECT_B, root: w.b.root, name: 'bravo project' }] }, null, 2)}\n`,
        'utf8',
      );
    });

    parity('P-23', ['A-09', 'A-05'], ['I-010', 'I-065', 'I-103', 'I-105', 'I-106', 'I-107', 'I-108', 'I-109'], 'a project setting written by the leader is the cockpit’s setting, byte for byte, B is untouched, and the system prompt never reaches a log', async () => {
      const w = world();
      const configPath = join(w.a.root, '.xezar', 'config.json');
      const original = readFileSync(configPath, 'utf8');
      const secretish = 'house style; token ghp_parityParityParityParity0123456789';
      const change = { baseBranch: 'main', defaultRunner: 'codex', systemPrompt: secretish, liveTitleUpdates: false, reviewGate: true, worktreeRetention: 3 };
      const seen = await w.observe(() => mcp(w, 'project_config', { action: 'set_config', config: change }));
      assertIsolated(w, seen, { echoes: [secretish] });
      const cockpit = await ui(w, '/config');
      expect(cockpit.body).toMatchObject(change);
      const afterMcp = readFileSync(configPath, 'utf8');
      // The same bytes the cockpit's own form writes from the same starting file.
      writeFileSync(configPath, original, 'utf8');
      expect((await ui(w, '/config', 'PUT', change)).status).toBe(200);
      expect(readFileSync(configPath, 'utf8')).toBe(afterMcp);

      // F-15 / N-04: the audit trail and the journal never echo the prompt a person may paste a secret into.
      const audit = existsSync(auditFile(w.a)) ? readFileSync(auditFile(w.a), 'utf8') : '';
      expect(audit).toContain('mcp.project-config');
      expect(leaked(audit, [secretish, 'ghp_parity'])).toEqual([]);
      expect(leaked(JSON.stringify(w.a.journal.read({})), [secretish, 'ghp_parity'])).toEqual([]);

      // The same validation: out of range is refused by both doors and changes nothing.
      const bad = await w.call('a', 'project_config', { action: 'set_config', config: { worktreeRetention: 1001 } });
      expect(bad.isError).toBe(true);
      expect((await ui(w, '/config', 'PUT', { worktreeRetention: 1001 })).status).toBe(400);
      expect(readFileSync(configPath, 'utf8')).toBe(afterMcp);
      // The repo config's own maxParallel is inert (the scheduler reads the registry): not offered.
      expect((await w.call('a', 'project_config', { action: 'set_config', config: { maxParallel: 1 } })).isError).toBe(true);
    });

    parity('P-24', ['A-09', 'A-05'], ['I-104', 'I-007'], 'locked models are reported as a reason and refuse a model choice exactly as the cockpit does', async () => {
      const w = world();
      process.env.XEZ_AGENT_MODELS_LOCKED = '1';
      const discovery = await mcp(w, 'discover_project');
      expect(discovery.settings.modelsLocked).toBe(true);
      expect(discovery.actions.find((a: { id: string }) => a.id === 'model_selection')).toMatchObject({ status: 'read-only' });
      expect(discovery.actions.find((a: { id: string }) => a.id === 'model_selection').reason).toMatch(/locked/i);
      expect((await mcp(w, 'project_config', { action: 'get_config' })).result.modelsLocked).toBe(true);
      const before = w.a.store.listRuns().length;
      const viaMcp = await w.call('a', 'task_create', { operationId: op(), prompt: 'pinned model', model: 'sonnet' });
      const viaUi = await ui(w, '/runs', 'POST', { task: 'pinned model', workflow: 'quick-task', model: 'sonnet' });
      expect(viaUi.status).toBe(409);
      expect(body(viaMcp)).toMatchObject({ accepted: false });
      expect(resultText(viaMcp)).toContain(viaUi.body.error);
      expect(w.a.store.listRuns().length).toBe(before);
    });

    parity('P-25', ['A-09', 'A-08', 'A-05'], ['I-110'], 'the prompt-template list is read and replaced whole, and each door sees the other’s list', async () => {
      const w = world();
      const templates = [
        { id: 'review', label: 'Review', text: 'Review {{task}} for regressions.' },
        { id: 'tests', label: 'Tests', text: 'Add tests for {{task}}.' },
      ];
      expect((await mcp(w, 'project_config', { action: 'set_prompt_templates', promptTemplates: templates })).result.promptTemplates).toEqual(templates);
      expect((await ui(w, '/ui-state')).body.promptTemplates).toEqual(templates);
      expect((await ui(w, '/ui-state', 'PUT', { promptTemplates: [templates[1]] })).status).toBe(200);
      expect((await mcp(w, 'project_config', { action: 'get_prompt_templates' })).result.promptTemplates).toEqual([templates[1]]);
      expect((await mcp(w, 'project_config', { action: 'set_prompt_templates', promptTemplates: [] })).result.promptTemplates).toEqual([]);
      expect((await ui(w, '/ui-state')).body.promptTemplates).toEqual([]);
    });

    parity('P-26', ['A-09', 'A-05'], ['I-111', 'I-113'], 'an agent config file is written through the cockpit’s own route, a stale write is refused, and an MCP-carrying file is read as structure only', async () => {
      const w = world();
      const content = '{\n  "permissions": { "allow": ["Read"] }\n}\n';
      expect(await mcp(w, 'project_config', { action: 'write_agent_config', fileId: 'claude.project.settings', content, version: null })).toMatchObject({ result: expect.anything() });
      expect(readFileSync(join(w.a.root, '.claude', 'settings.json'), 'utf8')).toBe(content);
      const cockpit = await ui(w, '/agent-config/claude.project.settings');
      expect(cockpit.body.content).toBe(content);
      // A write based on an out-of-date read is refused by both doors (the optimistic lock).
      const staleMcp = await w.call('a', 'project_config', { action: 'write_agent_config', fileId: 'claude.project.settings', content: '{}\n', version: null });
      const staleUi = await ui(w, '/agent-config/claude.project.settings', 'PUT', { content: '{}\n', version: null });
      expect(staleUi.status).toBe(409);
      expect(staleMcp.isError).toBe(true);
      expect(resultText(staleMcp)).toMatch(/409/);
      expect(readFileSync(join(w.a.root, '.claude', 'settings.json'), 'utf8')).toBe(content);

      // D-113: a holdsMcp file is written in full, and read back as structure only.
      const secret = 'sk-parity-secret-value-0123456789';
      const toml = `[mcp_servers.demo]\ncommand = "demo-server"\nargs = ["--port", "4000"]\n\n[mcp_servers.demo.env]\nAPI_KEY = "${secret}"\n`;
      expect(await mcp(w, 'project_config', { action: 'write_agent_config', fileId: 'codex.project.config', content: toml, version: null })).toBeTruthy();
      expect(readFileSync(join(w.a.root, '.codex', 'config.toml'), 'utf8')).toBe(toml);
      const structural = await w.call('a', 'project_config', { action: 'read_agent_config', fileId: 'codex.project.config' });
      expect(structural.isError).toBeFalsy();
      expect(resultText(structural)).toContain('demo');
      expect(leaked(JSON.stringify(structural), [secret, 'demo-server', '4000'])).toEqual([]);
      const listed = await mcp(w, 'project_config', { action: 'list_agent_config' });
      expect(listed.result.files.find((f: { id: string }) => f.id === 'codex.project.config')).toMatchObject({ holdsMcp: true });
    });

    parity('P-27', ['A-09', 'A-11'], ['I-111', 'I-113'], 'in hosted mode an agent config write is refused with the cockpit’s own 409, through MCP too', async () => {
      const w = world();
      process.env.XEZ_REMOTE = '1';
      const viaUi = await ui(w, '/agent-config/claude.project.settings', 'PUT', { content: '{}\n', version: null });
      expect(viaUi.status).toBe(409);
      const viaMcp = await w.call('a', 'project_config', { action: 'write_agent_config', fileId: 'claude.project.settings', content: '{}\n', version: null });
      expect(viaMcp.isError).toBe(true);
      expect(resultText(viaMcp)).toMatch(/409/);
      expect(existsSync(join(w.a.root, '.claude', 'settings.json'))).toBe(false);
      const discovery = await mcp(w, 'discover_project');
      expect(discovery.actions.find((a: { id: string }) => a.id === 'agent_config_write')).toMatchObject({ status: 'unavailable' });
    });

    parity('P-28', ['A-09', 'A-08', 'A-05'], ['I-128', 'I-129'], 'the bound project’s own cap and tags are written to its registry entry only, and each door sees the other’s', async () => {
      const w = world();
      const registry = () => JSON.parse(readFileSync(join(w.home, 'config.json'), 'utf8')) as { projects: Array<Record<string, unknown>> };
      // B's row by what it MEANS: a registry write re-serializes every row with its parsed
      // defaults (`addedAt: ''` …), through the cockpit's PATCH exactly as through MCP.
      const entry = (id: string) => {
        const row = registry().projects.find((p) => p.id === id);
        return row && { id: row.id, root: row.root, name: row.name, maxParallel: row.maxParallel, tags: row.tags };
      };
      const bBefore = JSON.stringify(entry(PROJECT_B));
      const set = await mcp(w, 'project_config', { action: 'set_project', project: { maxParallel: 1, tags: ['alpha-tag'] } });
      expect(JSON.stringify(set)).toContain('alpha-tag');
      expect(entry(PROJECT_A)).toMatchObject({ maxParallel: 1, tags: ['alpha-tag'] });
      expect(JSON.stringify(entry(PROJECT_B))).toBe(bBefore);
      expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.project.maxParallel).toBe(1);
      const listed = await ui(w, '/api/v1/projects');
      expect(JSON.stringify(listed.body)).toContain('alpha-tag');
      // The human changes it back in the cockpit; the leader reads the human's value.
      expect((await ui(w, `/api/v1/projects/${PROJECT_A}`, 'PATCH', { maxParallel: null, tags: [] })).status).toBe(200);
      expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.project.maxParallel).toBeNull();
      expect(JSON.stringify(entry(PROJECT_B))).toBe(bBefore);
    });

    parity(
      'P-45',
      ['A-09', 'A-08', 'A-05'],
      ['I-117', 'I-118', 'I-119', 'I-120', 'I-121', 'I-127', 'I-148', 'I-149', 'I-150', 'I-151'],
      'the workspace limits, composer defaults, skills auto-update, agent defaults, the two workspace folder paths and the terminal settings are written through either door with the same effect, the same bound on a bad value and the same narrowed answer',
      async () => {
        const w = world();
        // Every key of the write, in one body, as the owner's 2026-09-20 rule allows (#677 B1).
        const change = {
          resources: { maxParallel: 5, maxMonitoringSessions: 3, monitoringWakeIntervalMinutes: null, autoResumeOnUsageLimit: false, idleTimeoutMinutes: 30, memoryLimitMb: 4096, worktreeRetentionDefault: 7, gateSlots: 4 },
          followups: false,
          agentEnvPassthrough: ['CI'],
          composerDefaults: { autonomous: true, worktree: false },
          skillsAutoUpdate: false,
          agentDefaults: { runner: 'codex', models: { codex: 'gpt-5.6-sol' } },
        } as const;
        const seen = await w.observe(() => mcp(w, 'project_config', { action: 'set_workspace_config', workspaceConfig: change }));
        // NOT `assertIsolated`: this write is workspace-wide BY DESIGN — that is the whole of the
        // owner's 2026-09-20 decision — so its one dispatch is deliberately outside A's scope and
        // the helper's project-scoped rule does not apply. What must still hold is the rest of
        // N-01: exactly the cockpit's own workspace route, once; project B's own recorded state
        // byte-identical; and nothing of B or any secret on the leader-visible surface.
        expect(seen.dispatched).toEqual(['PUT /api/v1/workspace/config']);
        expect(seen.after, 'B unchanged').toBe(seen.before);
        const surface = JSON.stringify({ response: seen.response, leaderLog: seen.leaderLog, journalA: seen.journal.a, log: seen.log });
        expect(leaked(surface, w.b.names), 'nothing of B').toEqual([]);
        expect(leaked(surface, w.secrets), 'no secret').toEqual([]);

        // The leader reads its own write in the SAME words `get_limits` answers in.
        const written = seen.response.result as { workspace: Record<string, any> };
        const limits = (await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace;
        expect(written.workspace).toEqual(limits);
        expect(limits.resources).toMatchObject({ maxParallel: 5, maxMonitoringSessions: 3, monitoringWakeIntervalMinutes: null, autoResumeOnUsageLimit: false, idleTimeoutMinutes: 30, memoryLimitMb: 4096, worktreeRetentionDefault: 7, gateSlots: 4 });
        expect(limits.followups).toEqual({ effective: false, inherited: false });
        expect(limits.agentEnvPassthrough.effectiveNames).toContain('CI');
        expect(limits.composerDefaults).toMatchObject({ autonomous: true, worktree: false });
        expect(limits.skillsAutoUpdate).toEqual({ effective: false, inherited: false });
        // The narrowing § 4.9 set survives the reversal: the answer carries no folder path and no
        // machine-wide agent default, even though the write accepted the defaults.
        expect(JSON.stringify(written.workspace)).not.toMatch(/browseRoot|projectsDir|agentDefaults/);

        // The cockpit's own pane sees exactly the leader's values, agent defaults included.
        const cockpit = await ui(w, '/api/v1/workspace/config');
        expect(cockpit.body).toMatchObject({ resources: { maxParallel: 5, memoryLimitMb: 4096 }, skillsAutoUpdate: false, followups: false, agentDefaults: { runner: 'codex', models: { codex: 'gpt-5.6-sol' } } });

        // The human changes it back in the cockpit; the leader reads the human's value.
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { resources: { maxParallel: 2 }, followups: null })).status).toBe(200);
        const after = (await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace;
        expect(after.resources.maxParallel).toBe(2);
        expect(after.followups.inherited).toBe(true);

        // Out of range is refused by the SAME BOUND through either door — both validate with the
        // contract's `setWorkspaceConfigInputSchema` — and nothing is written. Not the same 400
        // STRING: the tool's copy runs as argument validation, so the leader reads the zod issue
        // and the cockpit reads the route's `{ error }` line. Same schema, same answer, no write.
        const badUi = await ui(w, '/api/v1/workspace/config', 'PUT', { resources: { maxParallel: 99 } });
        expect(badUi.status).toBe(400);
        expect(badUi.body.error).toContain('<=16');
        const badMcp = await w.call('a', 'project_config', { action: 'set_workspace_config', operationId: op(), workspaceConfig: { resources: { maxParallel: 99 } } });
        expect(badMcp.isError).toBe(true);
        expect(resultText(badMcp)).toContain('<=16');
        expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace.resources.maxParallel).toBe(2);

        // AN UNKNOWN KEY, AT EITHER LEVEL, is refused by both doors (review m1 and QA case H on
        // #735). Each used to be answered 200 — success for a change that never happened: the
        // top-level one by the route alone, because only the tool's copy carried `.strict()`;
        // the nested one by both, because `.strict()` narrows one object and says nothing about
        // the ones inside it. The whole shape is strict in the contract now, and the contract is
        // what BOTH doors validate with, so the two answers are identical rather than similar.
        for (const typo of [{ resources: { maxParalel: 9 } }, { nonsenseKey: 123 }]) {
          const typoUi = await ui(w, '/api/v1/workspace/config', 'PUT', typo);
          expect(typoUi.status, JSON.stringify(typo)).toBe(400);
          const typoMcp = await w.call('a', 'project_config', { action: 'set_workspace_config', operationId: op(), workspaceConfig: typo });
          expect(typoMcp.isError, JSON.stringify(typo)).toBe(true);
        }
        expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace.resources.maxParallel).toBe(2);


        // I-148 — THE INSTANCE MODE (#467 PR 5). The one workspace key that is a BOOT decision,
        // and the two things that makes different.
        //
        // AC-5.1: the two doors produce the IDENTICAL `~/.xezar/config.json`. Not "an equivalent
        // one" — the same bytes, which is what makes the cockpit and the leader one setting
        // rather than two that happen to agree today.
        const configPath = join(w.home, 'config.json');
        const afterMcpInstance = await mcp(w, 'project_config', { action: 'set_workspace_config', workspaceConfig: { cli: { instance: 'project' } } });
        const mcpBytes = readFileSync(configPath, 'utf8');
        expect(afterMcpInstance.result.workspace.cli.instance).toEqual({ effective: 'project', inherited: false, inForce: 'workspace' });
        // Clear it, then make the same change through the cockpit's own door.
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { cli: { instance: null } })).status).toBe(200);
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { cli: { instance: 'project' } })).status).toBe(200);
        expect(readFileSync(configPath, 'utf8'), 'AC-5.1: byte-identical through either door').toBe(mcpBytes);

        // AC-5.4 / the named break `cli-key-cleared-by-unrelated-write`: a write that does not
        // name `cli` leaves the stored key exactly where it was, through either door.
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { resources: { maxParallel: 3 } })).status).toBe(200);
        await mcp(w, 'project_config', { action: 'set_workspace_config', workspaceConfig: { followups: true } });
        expect(JSON.parse(readFileSync(configPath, 'utf8')).cli).toEqual({ instance: 'project' });
        expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace.cli.instance.effective).toBe('project');

        // A word the vocabulary does not know is refused by the same contract enum at both doors,
        // and nothing is written.
        const badMode = await w.call('a', 'project_config', { action: 'set_workspace_config', operationId: op(), workspaceConfig: { cli: { instance: 'both' } } });
        expect(badMode.isError).toBe(true);
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { cli: { instance: 'both' } })).status).toBe(400);
        expect(JSON.parse(readFileSync(configPath, 'utf8')).cli).toEqual({ instance: 'project' });

        // I-149 … I-151 — the three presentation keys beside it (the owner's D-5, 2026-09-20): the same pair of
        // doors, the same bytes, and the same contract enum refusing a bad word at both.
        const presentation = { output: 'rich', color: 'never', logLevel: 'debug' } as const;
        const afterMcpPresentation = await mcp(w, 'project_config', { action: 'set_workspace_config', workspaceConfig: { cli: presentation } });
        expect(afterMcpPresentation.result.workspace.cli).toMatchObject({
          output: { effective: 'rich', inherited: false },
          color: { effective: 'never', inherited: false },
          logLevel: { effective: 'debug', inherited: false },
        });
        const mcpPresentationBytes = readFileSync(configPath, 'utf8');
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { cli: { output: null, color: null, logLevel: null } })).status).toBe(200);
        expect(JSON.parse(readFileSync(configPath, 'utf8')).cli, 'a cleared sibling leaves the instance alone').toEqual({ instance: 'project' });
        expect((await ui(w, '/api/v1/workspace/config', 'PUT', { cli: presentation })).status).toBe(200);
        expect(readFileSync(configPath, 'utf8'), 'D-5: byte-identical through either door').toBe(mcpPresentationBytes);
        for (const bad of [{ output: 'plain' }, { color: 'yes' }, { logLevel: 'verbose' }]) {
          const refused = await w.call('a', 'project_config', { action: 'set_workspace_config', operationId: op(), workspaceConfig: { cli: bad } });
          expect(refused.isError, JSON.stringify(bad)).toBe(true);
          expect((await ui(w, '/api/v1/workspace/config', 'PUT', { cli: bad })).status, JSON.stringify(bad)).toBe(400);
        }
        expect(readFileSync(configPath, 'utf8'), 'nothing written by a refusal').toBe(mcpPresentationBytes);

        // Back to the state the rest of this case left behind, so the folder-path half below
        // still starts from the human's cap of 2.
        expect(
          (await ui(w, '/api/v1/workspace/config', 'PUT', {
            cli: { instance: null, output: null, color: null, logLevel: null },
            resources: { maxParallel: 2 },
          })).status,
        ).toBe(200);

        // I-127 — THE TWO WORKSPACE FOLDER PATHS (#677 B2). The same owner rule, the last two keys
        // the write held back. They are the one pair whose validity is a fact about the FILESYSTEM
        // rather than a bound in a schema, so the route probes them for real and the MCP door adds
        // no opinion of its own.
        const browseRoot = join(w.home, 'b2-browse');
        const projectsDir = join(w.home, 'b2-clones');
        mkdirSync(browseRoot, { recursive: true });
        const roots = await mcp(w, 'project_config', { action: 'set_workspace_config', workspaceConfig: { browseRoot, projectsDir } });
        expect(roots.result.workspace).toEqual((await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace);
        // The checkout root did not have to exist: the route's probe is `mkdir -p`, so the write
        // CREATES it — a real filesystem side effect of a settings write, named in the spec's § 3.
        expect(existsSync(projectsDir), 'the checkout root the probe created').toBe(true);
        expect((await ui(w, '/api/v1/workspace/config')).body).toMatchObject({ browseRoot, projectsDir });
        // Written, and still not read back: the answer is the narrowed `get_limits` vocabulary.
        expect(JSON.stringify(roots.result)).not.toContain(browseRoot);

        // NAMED BREAK 5 OF THE SPEC. A root that does not exist is refused by the ROUTE's own write
        // probe — not by a bound, not by a second check at the MCP door — and the probe runs BEFORE
        // `mergeWriteWorkspaceConfig`, so the `resources` key travelling in the same body does not
        // half-apply. Remove the probe and this case goes RED; without it a broken browse root is
        // stored silently.
        const missingRoot = join(w.home, 'b2-does-not-exist');
        const badRoots = await w.call('a', 'project_config', {
          action: 'set_workspace_config',
          operationId: op(),
          workspaceConfig: { browseRoot: missingRoot, resources: { maxParallel: 11 } },
        });
        expect(badRoots.isError).toBe(true);
        expect(resultText(badRoots)).toContain('browse folder does not exist');
        // The cockpit's own door answers the same 400, with the same reason.
        const badUiRoot = await ui(w, '/api/v1/workspace/config', 'PUT', { browseRoot: missingRoot, resources: { maxParallel: 11 } });
        expect(badUiRoot.status).toBe(400);
        expect(badUiRoot.body.error).toContain('browse folder does not exist');
        // Nothing of that body was written, through either door: the root is the old one and the
        // cap is still the human's 2.
        const afterBad = (await ui(w, '/api/v1/workspace/config')).body;
        expect(afterBad.browseRoot).toBe(browseRoot);
        expect(afterBad.resources.maxParallel).toBe(2);
        expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace.resources.maxParallel).toBe(2);

        // "Repeating one key changes nothing twice" is NOT assertable here: this world wires the
        // tools directly, and the operation receipt belongs to the generic door. It is pinned
        // where the door really runs — `composition.test.ts`, "a workspace write replayed under
        // the same operation key" (review M2).
      },
    );

    parity(
      'P-46',
      ['A-09', 'A-08', 'A-05'],
      ['I-024', 'I-092', 'I-132'],
      'the shared presentation preferences — appearance, notifications, folded columns and the curated skills list — are read and written through either door with the same effect, the route’s own bound on a bad value, and an answer that carries no incident id; an object-valued preference is sent whole, after the read, the way the panes send it',
      async () => {
        const w = world();
        // Something of the person's already in the bag, including the two LEGACY keys the leader
        // may not write: what survives the leader's write is the point.
        expect(
          (await ui(w, '/api/v1/workspace/ui-state', 'PUT', {
            sidebar: { collapsed: { group: true } },
            lastLocation: { projectId: 'proj-a', pathname: '/p/proj-a/tasks' },
            importedSkills: ['the-person-picked-this'],
          })).status,
        ).toBe(200);

        const change = {
          appearance: { accent: 'violet', density: 'compact', width: 'wide' },
          notifications: { enabled: false },
          taskTable: { expandedColumns: { title: true, runner: false } },
          importedSkills: ['review', 'qa'],
          dismissedProviderAuthFailures: { claude: 'incident-9f3a-SECRET-ID' },
        } as const;
        const seen = await w.observe(() => mcp(w, 'project_config', { action: 'set_workspace_ui_state', uiState: change }));
        // NOT `assertIsolated`: this bag is workspace-wide BY DESIGN, so its one dispatch is
        // deliberately outside A's scope. The rest of N-01 still holds — the cockpit's own route,
        // once; project B's recorded state byte-identical; nothing of B and no secret on the
        // leader-visible surface.
        expect(seen.dispatched).toEqual(['PUT /api/v1/workspace/ui-state']);
        expect(seen.after, 'B unchanged').toBe(seen.before);
        const surface = JSON.stringify({ response: seen.response, leaderLog: seen.leaderLog, journalA: seen.journal.a, log: seen.log });
        expect(leaked(surface, w.b.names), 'nothing of B').toEqual([]);
        expect(leaked(surface, w.secrets), 'no secret').toEqual([]);

        // The answer is narrowed: no incident ID (F-03 withholds one from get_capabilities, and a
        // write is no reason to hand one back), and neither legacy window key.
        const written = (seen.response.result as { uiState: Record<string, any> }).uiState;
        expect(written.appearance).toEqual({ accent: 'violet', density: 'compact', width: 'wide' });
        expect(written.notifications).toEqual({ enabled: false });
        expect(written.taskTable.expandedColumns).toEqual({ title: true, runner: false });
        expect(written.importedSkills).toEqual(['review', 'qa']);
        expect(written.dismissedProviderAuthFailures, 'the provider NAME, not the incident').toEqual(['claude']);
        expect(JSON.stringify(written)).not.toMatch(/incident-9f3a-SECRET-ID|sidebar|lastLocation/);

        // The cockpit's own pane sees exactly the leader's values — and the person's two legacy
        // keys are still there, because the route merges shallowly and the leader sent neither.
        const cockpit = (await ui(w, '/api/v1/workspace/ui-state')).body;
        expect(cockpit).toMatchObject({ ...change, sidebar: { collapsed: { group: true } } });
        expect(cockpit.lastLocation.pathname).toBe('/p/proj-a/tasks');

        // The human changes the accent back in the cockpit; the leader's next write of ANOTHER key
        // leaves it alone.
        expect((await ui(w, '/api/v1/workspace/ui-state', 'PUT', { appearance: { accent: 'lime' } })).status).toBe(200);
        const afterImport = (await mcp(w, 'project_config', { action: 'import_skills', importedSkills: [] })).result.uiState;
        expect(afterImport.importedSkills, 'a curated EMPTY list, not "never curated"').toEqual([]);
        expect(afterImport.appearance.accent, 'the human’s accent survived').toBe('lime');

        // The READ half, and the recipe it exists for (#753 review, Major 1). The route replaces
        // an object-valued key whole, so the leader reads the bag through its own door, spreads
        // the object and writes it back — and the person's density and width survive an accent
        // change. Drop `get_workspace_ui_state` and this block goes RED at the read.
        expect((await ui(w, '/api/v1/workspace/ui-state', 'PUT', { appearance: { accent: 'lime', density: 'compact', width: 'wide' } })).status).toBe(200);
        const readBack = await w.observe(() => mcp(w, 'project_config', { action: 'get_workspace_ui_state' }));
        expect(readBack.dispatched, 'the cockpit’s own route, read side').toEqual(['GET /api/v1/workspace/ui-state']);
        const bag = (readBack.response.result as { uiState: Record<string, any> }).uiState;
        expect(bag.appearance).toEqual({ accent: 'lime', density: 'compact', width: 'wide' });
        expect(JSON.stringify(bag), 'the read is narrowed exactly like the write’s answer').not.toMatch(/incident-9f3a-SECRET-ID|sidebar|lastLocation/);
        const spread = await mcp(w, 'project_config', {
          action: 'set_workspace_ui_state',
          uiState: { appearance: { ...bag.appearance, accent: 'violet' } },
        });
        expect(spread.result.uiState.appearance).toEqual({ accent: 'violet', density: 'compact', width: 'wide' });
        expect((await ui(w, '/api/v1/workspace/ui-state')).body.appearance).toEqual({ accent: 'violet', density: 'compact', width: 'wide' });

        // A value the ROUTE refuses: 201 skill names, one past the contract's bound. The door
        // dispatches — it holds no second opinion about a value — and the route answers 400 with
        // its own reason, through both doors, writing nothing.
        const tooMany = Array.from({ length: 201 }, (_, i) => `skill-${i}`);
        const badUi = await ui(w, '/api/v1/workspace/ui-state', 'PUT', { importedSkills: tooMany });
        expect(badUi.status).toBe(400);
        const badMcp = await w.observe(() => w.call('a', 'project_config', { action: 'import_skills', operationId: op(), importedSkills: tooMany }));
        expect(badMcp.response.isError).toBe(true);
        expect(badMcp.dispatched, 'it really was the route that refused').toEqual(['PUT /api/v1/workspace/ui-state']);
        expect((await ui(w, '/api/v1/workspace/ui-state')).body.importedSkills, 'nothing was written').toEqual([]);

        // The THEME is not a key of this write and never will be: the browser stores it, so there
        // is no route to dispatch (spec § 4 Q1, owner 2026-09-20 07:41). An argument refusal,
        // before any dispatch — not a boundary refusal, because there is no setting to refuse.
        const theme = await w.observe(() => w.call('a', 'project_config', { action: 'set_workspace_ui_state', operationId: op(), uiState: { theme: 'dark' } }));
        expect(theme.response.isError).toBe(true);
        expect(resultText(theme.response)).toMatch(/Invalid arguments for project_config: .*Unrecognized key/);
        expect(theme.dispatched).toEqual([]);
      },
    );

    parity(
      'P-47',
      ['A-09', 'A-08', 'A-05'],
      ['I-115'],
      'a provider is switched off and on through either door with the same effect, the cockpit’s own status answers both, and the leader is never handed an incident id',
      async () => {
        const w = world();
        // Everything connected and offered to start with — the state the leader reads.
        const before = (await mcp(w, 'project_config', { action: 'get_capabilities' })).result.providers;
        expect(before.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ enabled: true });

        const seen = await w.observe(() => mcp(w, 'project_config', { action: 'set_provider_enabled', provider: 'claude', enabled: false }));
        // NOT `assertIsolated`: `disabledProviders` is ONE workspace key, so switching a provider
        // off is machine-wide by design — that is the risk the owner accepted on 2026-09-20, not
        // an isolation break. The rest of N-01 still holds: the cockpit's own route, once; B's
        // recorded state byte-identical; nothing of B and no secret on the leader's surface.
        expect(seen.dispatched).toEqual(['PUT /api/v1/providers/claude/enabled']);
        expect(seen.after, 'B unchanged').toBe(seen.before);
        const surface = JSON.stringify({ response: seen.response, leaderLog: seen.leaderLog, journalA: seen.journal.a, log: seen.log });
        expect(leaked(surface, w.b.names), 'nothing of B').toEqual([]);
        expect(leaked(surface, w.secrets), 'no secret').toEqual([]);

        // The leader reads its own write in the words `get_capabilities` answers in, with no
        // incident id anywhere in it (F-03 withholds one, and a write is no reason to hand it back).
        const written = (seen.response.result as { providers: Array<Record<string, unknown>> }).providers;
        expect(written.find((row) => row.provider === 'claude')).toMatchObject({ provider: 'claude', enabled: false });
        expect(JSON.stringify(written)).not.toMatch(/authFailureId|profileId/);
        expect((await mcp(w, 'project_config', { action: 'get_capabilities' })).result.providers).toEqual(written);

        // The cockpit's own Providers card sees the leader's switch, through the route it reads.
        const card = await ui(w, '/api/v1/providers/status');
        expect(card.body.providers.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ enabled: false });

        // The person switches it back on in the cockpit; the leader reads the person's value.
        expect((await ui(w, '/api/v1/providers/claude/enabled', 'PUT', { enabled: true })).status).toBe(200);
        const after = (await mcp(w, 'project_config', { action: 'get_capabilities' })).result.providers;
        expect(after.find((row: { provider: string }) => row.provider === 'claude')).toMatchObject({ enabled: true });

        // A value the ROUTE refuses, through both doors: the enum is the route's param validator,
        // and the MCP argument is the contract's own provider id, so an unknown backend never
        // reaches a merge-write from either side.
        expect((await ui(w, '/api/v1/providers/gemini/enabled', 'PUT', { enabled: false })).status).toBe(400);
        const bad = await w.observe(() => w.call('a', 'project_config', { action: 'set_provider_enabled', operationId: op(), provider: 'gemini', enabled: false }));
        expect(bad.response.isError).toBe(true);
        expect(bad.dispatched, 'refused as an argument, so nothing was dispatched').toEqual([]);

        // Connect is the half of this record that did NOT move (spec § 4 Q2): it opens a login
        // terminal on the host, which is a boundary rather than a setting.
        const connect = await w.observe(() => w.call('a', 'project_config', { action: 'connect_provider', operationId: op() }));
        expect(connect.response.isError).toBe(true);
        expect(resultText(connect.response)).toMatch(/^Refused \(host process\)/);
        expect(connect.dispatched).toEqual([]);
      },
    );

    parity(
      'P-48',
      ['A-09', 'A-08', 'A-05'],
      ['I-122', 'I-123', 'I-124'],
      'an agent account is added, selected, probed, read, edited and removed through the cockpit’s own routes, the accounts pane sees every one of them, and the leader’s answer names no other checkout',
      async () => {
        const w = world();
        const accountDir = join(w.a.root, 'second-claude-home');
        const pane = async () => (await ui(w, '/api/v1/workspace/agent-profiles')).body;
        expect((await pane()).profiles.filter((row: { isDefault: boolean }) => !row.isDefault), 'no stored account yet').toEqual([]);

        // ---- add, through the route and nothing else -------------------------------------------
        const added = await w.observe(() =>
          w.call('a', 'project_config', { action: 'create_account', operationId: op(), account: { provider: 'claude', label: 'Second Claude', configDir: accountDir } }),
        );
        // NOT `assertIsolated`: the accounts file is ONE machine-wide file, which is the exposure
        // the owner accepted on 2026-09-20. The rest of N-01 still holds, and is checked here.
        expect(added.dispatched).toEqual(['POST /api/v1/workspace/agent-profiles']);
        expect(added.after, 'B unchanged').toBe(added.before);
        const account = ok(added.response).result.account as Record<string, unknown>;
        const surface = JSON.stringify({ response: added.response, leaderLog: added.leaderLog, journalA: added.journal.a, log: added.log });
        expect(leaked(surface, w.b.names), 'nothing of B').toEqual([]);
        expect(leaked(surface, w.secrets), 'no secret').toEqual([]);
        // The row is narrowed: the folder the leader itself sent comes back, the EXPANDED absolute
        // home and the file paths inside it do not. Return the route's `profile` unchanged and
        // this goes red (`BREAK-B5-ROW-WIDE`).
        expect(account).toMatchObject({ provider: 'claude', configDir: accountDir, isDefault: false });
        expect(account).not.toHaveProperty('path');
        expect(account).not.toHaveProperty('files');
        // The person's pane sees the leader's account, by the id the leader was handed.
        const paneRow = (await pane()).profiles.find((row: { id: string }) => row.id === account.id);
        expect(paneRow).toMatchObject({ provider: 'claude', configDir: accountDir });

        // ---- select it for THIS project, and only this project ---------------------------------
        const selected = await w.observe(() =>
          w.call('a', 'project_config', { action: 'select_account', operationId: op(), provider: 'claude', accountId: account.id as string }),
        );
        expect(selected.dispatched).toEqual(['PUT /api/v1/workspace/agent-profiles/selection']);
        expect(ok(selected.response).result.selection).toEqual({ provider: 'claude', accountId: account.id });
        // The route answers `selections` keyed by every repo root on the machine; the door answers
        // this project's own. Hand the route's body back unnarrowed and the leader learns where B
        // lives (`BREAK-B5-SELECTIONS-WIDE`).
        expect(leaked(JSON.stringify(selected.response), w.b.names), 'the other checkout is not in the answer').toEqual([]);
        expect(ok(await w.call('a', 'project_config', { action: 'get_account' })).result.accounts).toContainEqual(
          expect.objectContaining({ provider: 'claude', handle: account.id }),
        );
        // The cockpit reads the same selection, keyed by A's own root.
        expect((await pane()).selections[w.a.root]).toMatchObject({ claude: account.id });

        // ---- the two reads ---------------------------------------------------------------------
        const status = await mcp(w, 'project_config', { action: 'check_account_status', provider: 'claude', accountId: account.id as string });
        expect(status.result).toMatchObject({ account: { provider: 'claude', accountId: account.id } });
        expect(typeof status.result.status).toBe('string');
        // F-03 holds for an ACCOUNT row exactly as it does for a provider row.
        expect(JSON.stringify(status)).not.toMatch(/authFailureId|profileId/);
        // The identity read the owner opened on 2026-09-20, and the whole claim about it: it is the
        // cockpit's own answer, not a second one assembled here.
        const details = await mcp(w, 'project_config', { action: 'get_account_details', provider: 'claude', accountId: account.id as string });
        const paneDetails = (await ui(w, `/api/v1/workspace/agent-profiles/${account.id as string}/details`)).body;
        expect(details.result).toEqual(paneDetails);

        // ---- edit and remove -------------------------------------------------------------------
        const edited = await w.observe(() =>
          w.call('a', 'project_config', { action: 'update_account', operationId: op(), accountId: account.id as string, accountUpdate: { label: 'Renamed' } }),
        );
        expect(edited.dispatched).toEqual([`PATCH /api/v1/workspace/agent-profiles/${account.id as string}`]);
        expect(ok(edited.response).result.account).toMatchObject({ id: account.id, label: 'Renamed' });
        const removed = await w.observe(() =>
          w.call('a', 'project_config', { action: 'remove_account', operationId: op(), accountId: account.id as string }),
        );
        expect(removed.dispatched).toEqual([`DELETE /api/v1/workspace/agent-profiles/${account.id as string}`]);
        expect(ok(removed.response).result).toEqual({ removed: true, id: account.id });
        // Deregistered, and the selection that named it scrubbed in the same write — the route's
        // own atomic behaviour, inherited rather than repeated at this door.
        expect((await pane()).profiles.filter((row: { isDefault: boolean }) => !row.isDefault)).toEqual([]);
        expect((await pane()).selections[w.a.root]?.claude).toBeUndefined();

        // ---- the one that did NOT move ---------------------------------------------------------
        // Opening an account's folder starts an application on the person's machine, which is the
        // boundary Connect names too (spec § 4 Q3; owner 2026-09-20 07:41). Let it reach a route
        // and this goes red (`BREAK-B5-OPEN-FILE-LEAKS`).
        const open = await w.observe(() => w.call('a', 'project_config', { action: 'open_account_file', operationId: op() }));
        expect(open.response.isError).toBe(true);
        expect(resultText(open.response)).toMatch(/^Refused \(host process\)/);
        expect(open.dispatched).toEqual([]);
      },
    );

    parity(
      'P-49',
      ['A-09', 'A-08', 'A-05'],
      ['I-152'],
      'the leader copies the machine-wide accounts through the cockpit’s own route, the accounts pane sees the copy, and both doors refuse it the same way where there is nothing to import into',
      async () => {
        const w = world();
        const globalAccounts = globalStateLayout().accountsPath;
        mkdirSync(join(globalAccounts, '..'), { recursive: true });
        writeFileSync(globalAccounts, JSON.stringify({
          accounts: [{ id: 'parity-work', provider: 'claude', configDir: '~/.claude-parity-work', label: 'someone@example.com' }],
        }));
        try {
          // ---- the global layout: nothing to import into, the same 409 at both doors ------------
          const refusedUi = await ui(w, '/api/v1/workspace/agent-profiles/import-global', 'POST');
          const refused = await w.observe(() => w.call('a', 'project_config', { action: 'import_global_accounts', operationId: op() }));
          expect(refused.dispatched).toEqual(['POST /api/v1/workspace/agent-profiles/import-global']);
          expect(refusedUi.status).toBe(409);
          expect(refused.response.isError).toBe(true);
          expect(resultText(refused.response)).toContain(refusedUi.body.error as string);

          // ---- single-project mode: the leader's call is the CLI's merge ------------------------
          setActiveStateLayout(projectStateLayout(w.a.root));
          const before = (await ui(w, '/api/v1/workspace/agent-profiles')).body;
          expect(before.globalImport).toEqual({ state: 'unknown', importable: 1 });
          expect(ok(await w.call('a', 'project_config', { action: 'get_account' })).result.globalImport).toEqual(before.globalImport);
          const copied = await w.observe(() =>
            w.call('a', 'project_config', { action: 'import_global_accounts', operationId: op() }),
          );
          // Through the route and nothing else — the route the cockpit's button posts.
          expect(copied.dispatched).toEqual(['POST /api/v1/workspace/agent-profiles/import-global']);
          expect(ok(copied.response).result).toEqual({ added: 1, kept: 0, globalImport: { state: 'done', importable: 0 } });
          // Counts only: no id, label or folder of the machine-wide file comes back to the leader.
          const surface = JSON.stringify({ response: copied.response, leaderLog: copied.leaderLog, journalA: copied.journal.a });
          expect(surface).not.toMatch(/parity-work|someone@example|claude-parity/);
          expect(leaked(surface, w.b.names), 'nothing of B').toEqual([]);
          // The person's pane sees the copied row and the new state.
          const after = (await ui(w, '/api/v1/workspace/agent-profiles')).body;
          expect(after.profiles.map((row: { id: string }) => row.id)).toContain('parity-work');
          expect(after.globalImport).toEqual({ state: 'done', importable: 0 });
        } finally {
          setActiveStateLayout(null);
          rmSync(globalAccounts, { force: true });
        }
      },
    );

    parity('P-44', ['A-09', 'A-08', 'A-05'], ['I-143', 'I-144', 'I-145', 'I-146'], 'the leader reads this project’s setup state, dispatches the bundled setup task and records the offer, and the cockpit sees the same thing', async () => {
      const w = world();
      const stateFile = join(w.a.root, '.local/xezar/onboarding-state.json');
      // A project a check once covered, on a xezar that has moved on since. This is the ONLY
      // state that produces an offer, and the whole point of the case is that both doors agree
      // on it — a leader and a person must not be told different things about what was checked.
      writeFileSync(
        stateFile,
        `${JSON.stringify({
          engineVersion: 'parity',
          kitDigest: BUNDLED_TEMPLATES_DIGEST,
          lastOfferedAt: null,
          lastCheckedAt: null,
          checked: { engineVersion: 'older', kitDigest: BUNDLED_TEMPLATES_DIGEST, at: '2026-09-02T16:40:00.000Z' },
        })}\n`,
        'utf8',
      );

      // I-143 + I-146: the pull. `discover_project` carries the same answer the cockpit's read gives.
      const discovery = await mcp(w, 'discover_project', {});
      const uiRead = await ui(w, '/onboarding');
      expect(uiRead.status).toBe(200);
      expect(discovery.onboarding).toEqual(uiRead.body);
      expect(discovery.onboarding).toMatchObject({
        state: 'changed',
        offerPending: true,
        lastChecked: { engineVersion: 'older' },
        launch: { workflowId: ONBOARDING_WORKFLOW_ID },
      });

      // I-145: the dismissal. It records the offer and nothing else, and the cockpit's own read
      // agrees that the row is gone for this identity.
      const bBefore = existsSync(join(w.b.root, '.local/xezar/onboarding-state.json'));
      const dismissed = await mcp(w, 'project_config', { action: 'dismiss_onboarding_offer', operationId: op() });
      expect(dismissed.result).toMatchObject({ status: 'recorded', onboarding: { offerPending: false, dismissed: true } });
      expect((await ui(w, '/onboarding')).body).toMatchObject({ offerPending: false, dismissed: true });
      // B never had a record and still does not: a project-scoped write stays in its project.
      expect(existsSync(join(w.b.root, '.local/xezar/onboarding-state.json'))).toBe(bBefore);

      // I-144: the leader dispatches the SAME launch definition the cockpit's button names, by the
      // id the read just gave it — no guessing, and no second definition to drift.
      const workflowId = discovery.onboarding.launch.workflowId as string;
      expect(((await mcp(w, 'project_config', { action: 'list_workflows' })).result.workflows as Array<{ name: string }>).map((wf) => wf.name)).toContain(workflowId);
      const created = await mcp(w, 'task_create', { operationId: op(), prompt: 'set this project up', source: { source: 'workflow', ref: workflowId } });
      expect(created).toMatchObject({ accepted: true, subject: { type: 'run' } });
      expect(run(w, created.subject.id as string)).toMatchObject({ workflow: workflowId });
      // And while it runs, both doors say so instead of offering a second one (`AC-13`).
      expect((await ui(w, '/onboarding')).body).toMatchObject({ state: 'checking', checkingRunId: created.subject.id });
      expect((await mcp(w, 'discover_project', {})).onboarding).toMatchObject({ state: 'checking' });

      // `AC-13` is a rule about TASKS, not about clicks, so the MCP door is held to it too, and
      // with a FRESH `operationId`: the receipt layer's replay would otherwise answer this without
      // the guard ever running, which would prove nothing about a leader that simply asks twice.
      const setupRuns = () => w.a.store.listRuns().filter((r) => r.workflow === workflowId);
      expect(setupRuns()).toHaveLength(1);
      const again = await mcp(w, 'task_create', { operationId: op(), prompt: 'set this project up', source: { source: 'workflow', ref: workflowId } });
      expect(again).toMatchObject({ accepted: true, subject: { id: created.subject.id } });
      expect(setupRuns()).toHaveLength(1);
    });

    parity(
      'P-29',
      ['A-09', 'A-11'],
      // I-117 … I-121 left this case with #677 B1 and I-127 with B2: the workspace SETTINGS write
      // is no longer a refusal and the two folder paths are keys of it, both proved by P-45. What
      // is still here is every boundary the owner's rule did NOT name — the home files, the
      // accounts, the project registry and the host filesystem.
      // I-024, I-092 and I-132 left with #677 B3, under the same rule plus the owner's 07:41
      // exclusions: the shared PRESENTATION bag is a write now, which P-46 proves.
      // I-122, I-123 and I-124 left with B5 — the account writes and the identity read — which
      // P-48 proves the same way. I-125 stays: opening an account's folder in an application is
      // the host process, not the account.
      ['I-012', 'I-093', 'I-112', 'I-115', 'I-125', 'I-126', 'I-130', 'I-131'],
      'every global-source, home-file, shared-account and host-folder write is refused with its boundary, dispatches nothing, and no approval parameter changes that',
      async () => {
        const w = world();
        const workspaceFile = join(w.home, 'config.json');
        const workspaceBefore = readFileSync(workspaceFile, 'utf8');
        const refusals = [
          // The account WRITES and both account reads left this list with #677 B5, under the
          // owner's decision of 2026-09-20 07:41 ("Writes and identity read"); P-48 proves them
          // against the cockpit's own routes. `open_account_file` did not: it starts an
          // application on the person's machine, the boundary Connect names too.
          'open_account_file',
          // `set_provider_enabled` and `retry_provider` left this list with #677 B4 (writes now);
          // Connect did not, because it starts a login terminal on the host.
          'connect_provider',
          'apply_skill_updates',
          'browse_folders',
          'add_project',
          'clone_project',
          'remove_project',
          'get_launch_key',
        ];
        const seen = await w.observe(async () => {
          const answers: Array<[string, McpToolResult]> = [];
          for (const action of refusals) answers.push([action, await w.call('a', 'project_config', { action })]);
          for (const fileId of ['claude.user.settings', 'codex.user.config', 'opencode.user.memory']) {
            answers.push([`read ${fileId}`, await w.call('a', 'project_config', { action: 'read_agent_config', fileId })]);
            answers.push([`write ${fileId}`, await w.call('a', 'project_config', { action: 'write_agent_config', fileId, content: '{}', version: null })]);
          }
          // No approval, confirmation or override parameter exists to turn a refusal into a write.
          for (const extra of [{ approvedBy: 'the human' }, { humanApproval: true }, { confirm: true }, { override: true }]) {
            answers.push([`approval ${JSON.stringify(extra)}`, await w.call('a', 'project_config', { action: 'connect_provider', ...extra })]);
          }
          return answers;
        });
        assertIsolated(w, seen);
        // Refused before anything reached the services.
        expect(seen.dispatched).toEqual([]);
        for (const [what, result] of seen.response) {
          expect(result.isError, what).toBe(true);
          if (/^(read|write) /.test(what)) {
            // I-112 / M-16: refused by the catalog's `scope`, as a HOME file — not merely because the
            // path happens to resolve outside the project, which a relocated agent home would defeat.
            expect(resultText(result), what).toMatch(/^Refused \(home file shared by every project\)/);
          } else if (what.startsWith('approval')) {
            // #819 item 6 (deliberate change): the refusal now outranks the unknown key, so the
            // approval key gets the boundary refusal rather than `Unrecognized key`. What this case
            // protects is unchanged: it dispatched nothing (`dispatched` above), it never offers an
            // approval route or echoes the key it was sent, and it still says nothing changed.
            expect(resultText(result), what).toMatch(/^Refused \(host process\): connect_provider — /);
            expect(resultText(result), what).not.toMatch(/approv|humanApproval|confirm|override/i);
            expect(resultText(result), what).toMatch(/Nothing was changed\.$/);
          } else {
            expect(resultText(result), what).toMatch(/Refused \(|user-scope|home/);
            // A refusal names its boundary and never offers an approval route (F-22, A-22).
            expect(resultText(result), what).not.toMatch(/approv/i);
          }
        }
        expect(resultText(seen.response.find(([what]) => what === 'apply_skill_updates')![1])).toMatch(/workspace-wide setting|every project/);
        expect(resultText(seen.response.find(([what]) => what === 'connect_provider')![1])).toMatch(/host process|login terminal/);
        expect(resultText(seen.response.find(([what]) => what === 'open_account_file')![1])).toMatch(/host process|application on the host/);
        expect(readFileSync(workspaceFile, 'utf8')).toBe(workspaceBefore);
        expect(existsSync(join(w.home, 'agent-accounts.json'))).toBe(false);
        // The safe effective READS those rows allow are served (D-03).
        expect((await mcp(w, 'project_config', { action: 'get_limits' })).result.workspace.resources.maxParallel).toBe(2);
        expect(await mcp(w, 'project_config', { action: 'check_skill_updates' })).toMatchObject({ action: 'check_skill_updates' });
      },
    );
  });

  // =============================================================================================
  // A-10 — read a result, files, diff, commits and PR/CI; send feedback; create a next-stage
  // task; repeat after a SHA change and with evidence missing. `done` alone is not proof.
  // =============================================================================================
  describe('A-10 — results, evidence and hand-off', () => {
    const world = withWorld({}, addForgeRemote);

    parity('P-30', ['A-10', 'A-05'], ['I-033', 'I-041', 'I-045', 'I-049', 'I-052', 'I-053', 'I-054'], 'a result, its files, diff, commits and handoff read the same as the cockpit’s, with references and origin as fields, and `done` is not proof', async () => {
      const w = world();
      const id = w.a.ids.done;
      w.a.store.updateRun(id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/128',
        prNumber: 128,
        issueNumber: 142,
        automation: { automationId: w.a.ids.automation, automationRevision: 1, receiptId: w.a.ids.receipt, event: 'pull_request.opened', githubUrl: 'https://github.com/acme/demo/pull/128' },
      });
      const summary = await mcp(w, 'read_results_evidence', { read: 'summary', runId: id });
      expect(summary.evidence).toBe('available');
      expect(summary.notes.join(' ')).toMatch(/not proof that checks passed/);
      const task = await mcp(w, 'task_read', { view: 'task', taskId: id });
      expect(task.task).toMatchObject({ pullRequestUrl: 'https://github.com/acme/demo/pull/128', prNumber: 128, issueNumber: 142, automation: { automationId: w.a.ids.automation } });

      const changes = await mcp(w, 'read_results_evidence', { read: 'changes', runId: id });
      const cockpitChanges = await ui(w, `/runs/${id}/changes`);
      expect(changes.data.files.map((f: { path: string }) => f.path)).toEqual(cockpitChanges.body.files.map((f: { path: string }) => f.path));
      expect(changes.data.stat).toEqual(cockpitChanges.body.stat);
      expect(changes.revision.headSha).toMatch(/^[0-9a-f]{40}$/);

      const files = await mcp(w, 'read_results_evidence', { read: 'files', runId: id });
      const cockpitFiles = await ui(w, `/runs/${id}/files`);
      expect(files.data.entries.map((e: { name: string }) => e.name).sort()).toEqual(cockpitFiles.body.entries.map((e: { name: string }) => e.name).sort());
      const file = await mcp(w, 'read_results_evidence', { read: 'files', runId: id, path: 'notes.txt' });
      const cockpitFile = await ui(w, `/runs/${id}/files?path=notes.txt`);
      expect(file.data.content).toBe(cockpitFile.body.content);
      expect(file.data.content).toBe(`${w.a.fileContent}\n`);

      const commits = await mcp(w, 'read_results_evidence', { read: 'commits', runId: id });
      const cockpitCommits = await ui(w, `/runs/${id}/commits`);
      expect(commits.data.commits).toEqual(cockpitCommits.body.commits);

      const handoff = await mcp(w, 'task_read', { view: 'handoff', taskId: id });
      const cockpitHandoff = await ui(w, `/runs/${id}/handoff`);
      expect(handoff.markdown).toBe(cockpitHandoff.body);
      expect(handoff.markdown).toContain('ALPHA handoff');

      // A next-stage task, created from what was read — the cockpit lists it like its own.
      const next = await mcp(w, 'task_create', { operationId: op(), prompt: `Next stage after ${id}: add tests for notes.txt` });
      expect((await ui(w, `/runs/${next.subject.id}`)).body.task).toContain(id);
    });

    parity('P-31', ['A-10', 'A-05'], ['I-055', 'I-054', 'I-052'], 'after a commit moves the SHA, earlier evidence reads as stale, and the commit is the one the cockpit makes', async () => {
      const w = world();
      const one = await finishedWithWorktree(w, 'commit via mcp');
      const two = await finishedWithWorktree(w, 'commit via ui');
      for (const r of [one, two]) writeFileSync(join(r.worktreePath!, 'result.txt'), 'the same result\n', 'utf8');
      const first = await mcp(w, 'read_results_evidence', { read: 'changes', runId: one.id });
      const h1 = first.revision.headSha as string;

      const committed = await mcp(w, 'handoff_git', { action: 'commit', taskId: one.id, message: 'record the result' });
      expect(committed).toMatchObject({ action: 'commit', status: 'done' });
      expect((await ui(w, `/runs/${two.id}/git/commit`, 'POST', { message: 'record the result' })).status).toBe(200);
      const commitOf = (r: RunRecord) => git(r.worktreePath!, 'show', '-s', '--format=%s%n%T', 'HEAD');
      expect(commitOf(one)).toBe(commitOf(two));
      expect(git(one.worktreePath!, 'rev-parse', 'HEAD')).toBe(committed.sha);

      // Repeat after the SHA change: the earlier read is reported stale, the new one names the commit.
      const again = await mcp(w, 'read_results_evidence', { read: 'changes', runId: one.id, expectedHeadSha: h1 });
      expect(again).toMatchObject({ evidence: 'available', freshness: 'stale', revision: { headSha: committed.sha } });
      const commit = await mcp(w, 'read_results_evidence', { read: 'commit', runId: one.id, sha: committed.sha });
      expect(commit.revision).toMatchObject({ commitSha: committed.sha, reachableFromHead: true });
      const cockpitCommit = await ui(w, `/runs/${one.id}/commit/${committed.sha}`);
      expect(JSON.stringify(commit.data)).toContain('result.txt');
      expect(JSON.stringify(cockpitCommit.body)).toContain('result.txt');

      // A clean tree: both doors refuse, and nothing is committed.
      const head = git(one.worktreePath!, 'rev-parse', 'HEAD');
      expect(await mcp(w, 'handoff_git', { action: 'commit', taskId: one.id, message: 'nothing' })).toMatchObject({ status: 'failed' });
      expect((await ui(w, `/runs/${two.id}/git/commit`, 'POST', { message: 'nothing' })).status).toBe(409);
      expect(git(one.worktreePath!, 'rev-parse', 'HEAD')).toBe(head);
    });

    parity('P-32', ['A-10', 'A-11', 'A-05'], ['I-068', 'I-052', 'I-053'], 'with the working tree gone, evidence reads as unavailable rather than empty, and worktree clean-up matches the cockpit’s', async () => {
      const w = world();
      const one = await finishedWithWorktree(w, 'remove via mcp');
      const two = await finishedWithWorktree(w, 'remove via ui');
      expect((await mcp(w, 'project_config', { action: 'list_worktrees' })).result.worktrees.map((t: { runId: string }) => t.runId)).toEqual(
        expect.arrayContaining([one.id, two.id]),
      );
      expect(await mcp(w, 'project_config', { action: 'remove_worktree', runId: one.id })).toBeTruthy();
      expect((await ui(w, `/runs/${two.id}/remove-worktree`, 'POST')).status).toBe(200);
      for (const r of [one, two]) {
        expect(existsSync(r.worktreePath!)).toBe(false);
        expect(run(w, r.id)?.worktreePath).toBeUndefined();
        expect(branchExists(w.a.root, r.branch!)).toBe(false);
      }
      // Evidence missing: an answer, never `{files: []}`.
      const changes = await mcp(w, 'read_results_evidence', { read: 'changes', runId: one.id });
      expect(changes).toMatchObject({ evidence: 'unavailable', status: 409 });
      expect(changes.data).toBeUndefined();
      expect((await ui(w, `/runs/${one.id}/changes`)).status).toBe(409);
      const files = await mcp(w, 'read_results_evidence', { read: 'files', runId: one.id });
      expect(files.evidence).toBe('unavailable');
      const summary = await mcp(w, 'read_results_evidence', { read: 'summary', runId: one.id });
      expect(summary.notes.join(' ')).toMatch(/not proof that checks passed/);

      // Reclaim follows the retention the project set, and keeps branches — as the cockpit's does.
      const old = run(w, w.a.ids.done)!; // finished long ago, so past any reclaim grace
      const listedOld = (await mcp(w, 'project_config', { action: 'list_worktrees' })).result.worktrees.find((t: { runId: string }) => t.runId === old.id);
      expect(listedOld).toMatchObject({ reclaimable: true });
      const recent = await finishedWithWorktree(w, 'keep me');
      // Keep one: the most recently finished worktree stays, the older one is reclaimed.
      await mcp(w, 'project_config', { action: 'set_config', config: { worktreeRetention: 1 } });
      const reclaimed = await mcp(w, 'project_config', { action: 'reclaim_worktrees' });
      expect(reclaimed.result.reclaimed).toEqual([old.id]);
      expect(existsSync(old.worktreePath!)).toBe(false);
      expect(branchExists(w.a.root, old.branch!)).toBe(true);
      expect(existsSync(recent.worktreePath!)).toBe(true);
      // The cockpit's own reclaim, run next, applies the same rule and finds that one already gone.
      const again = await ui(w, '/worktrees/reclaim', 'POST', {});
      expect(again.status).toBe(200);
      expect(JSON.stringify(again.body)).not.toContain(old.id);
    });

    parity('P-33', ['A-10', 'A-05'], ['I-061', 'I-062', 'I-063', 'I-064'], 'the repository reads and branch switch/create match the cockpit’s, refusals verbatim', async () => {
      const w = world();
      writeFileSync(join(w.a.root, 'README.md'), '# ALPHA readme, edited\n', 'utf8');
      const changes = await mcp(w, 'read_results_evidence', { read: 'repo_changes' });
      const cockpitChanges = await ui(w, '/repo/changes');
      expect(changes.data.files.map((f: { path: string }) => f.path)).toEqual(cockpitChanges.body.files.map((f: { path: string }) => f.path));
      git(w.a.root, 'checkout', '-q', '--', 'README.md');
      const head = git(w.a.root, 'rev-parse', 'HEAD');
      const commit = await mcp(w, 'read_results_evidence', { read: 'repo_commit', sha: head });
      const cockpitCommit = await ui(w, `/repo/commit/${head}?structured=1`);
      expect(commit.revision.commitSha).toBe(head);
      expect(cockpitCommit.status).toBe(200);

      expect(await mcp(w, 'handoff_git', { action: 'branch', name: 'feat/parity' })).toMatchObject({ status: 'done' });
      expect(git(w.a.root, 'branch', '--show-current')).toBe('feat/parity');
      expect((await ui(w, '/repo/branch', 'POST', { name: 'main' })).status).toBe(200);
      expect(git(w.a.root, 'branch', '--show-current')).toBe('main');
      expect(await mcp(w, 'handoff_git', { action: 'branch', name: 'feat/parity' })).toMatchObject({ status: 'done' });
      expect((await ui(w, '/repo')).body.info.branch).toBe('feat/parity');
      const badMcp = await mcp(w, 'handoff_git', { action: 'branch', name: 'bad..name' });
      const badUi = await ui(w, '/repo/branch', 'POST', { name: 'bad..name' });
      expect(badUi.status).toBe(409);
      expect(badMcp).toMatchObject({ status: 'failed', error: badUi.body.error });
    });

    parity('P-34', ['A-10', 'A-05'], ['I-069', 'I-070', 'I-071', 'I-072', 'I-073', 'I-074', 'I-075'], 'issues, pull requests, comments, checks, search, PR changes and merge state read as the cockpit reads them, from the bound project’s repository', async () => {
      const w = world();
      const seen = await w.observe(async () => ({
        list: await mcp(w, 'read_results_evidence', { read: 'github', limit: 20 }),
        refreshed: await mcp(w, 'read_results_evidence', { read: 'github', limit: 20, refresh: true }),
        comments: await mcp(w, 'read_results_evidence', { read: 'github_comments', kind: 'issue', number: 142 }),
        checks: await mcp(w, 'read_results_evidence', { read: 'github_checks', prs: [128, 124] }),
        search: await mcp(w, 'read_results_evidence', { read: 'github_search', kind: 'pr', query: 'auth' }),
        changes: await mcp(w, 'read_results_evidence', { read: 'pr_changes', number: 128 }),
        merge: await mcp(w, 'read_results_evidence', { read: 'pr_merge_state', number: 128 }),
      }));
      assertIsolated(w, seen);
      const r = seen.response;
      const numbers = (items: Array<{ number: number }>) => items.map((i) => i.number);
      const cockpitList = await ui(w, '/github?limit=20');
      expect(numbers(r.list.data.issues)).toEqual(numbers(cockpitList.body.issues));
      expect(numbers(r.list.data.prs)).toEqual(numbers(cockpitList.body.prs));
      expect(numbers(r.refreshed.data.prs)).toEqual(numbers(cockpitList.body.prs));
      // The dry-run forge stamps its fixture times from the clock at each read; everything else must match.
      const timeless = (value: unknown) => JSON.parse(JSON.stringify(value, (key, v) => (key === 'createdAt' || key === 'syncedAt' ? undefined : v)));
      expect(timeless(r.comments.data)).toEqual(timeless((await ui(w, '/github/comments/issue/142')).body));
      expect(r.checks.data).toEqual((await ui(w, '/github/checks?prs=128,124')).body);
      expect(r.checks.data.checks).toMatchObject({ 128: 'passing', 124: 'failing' });
      expect(numbers(r.search.data.items)).toEqual(numbers((await ui(w, '/github/search?kind=pr&q=auth')).body.items));
      expect(r.changes.data).toEqual((await ui(w, '/github/prs/128/changes')).body);
      // Truncation and per-file unavailability survive as recognisable states (F-10, N-06).
      expect(r.changes.data).toMatchObject({ truncated: true, reason: expect.any(String) });
      expect(r.changes.data.files.find((f: { path: string }) => f.path === 'assets/logo.png')).toMatchObject({ patchUnavailableReason: 'binary' });
      expect(r.merge.data).toEqual((await ui(w, '/github/prs/128/merge-state')).body);
      // Read-only on the forge, as in the cockpit: no comment-posting or CI re-run anywhere.
      const listing = JSON.stringify(tools.map((t) => toolListing(t)));
      expect(listing).not.toMatch(/post_comment|add_comment|rerun|re_run|re-run/i);
      // The capability is the bound project's: A has a GitHub remote, so GitHub is available.
      const discovery = await mcp(w, 'discover_project');
      expect(discovery.actions.find((a: { id: string }) => a.id === 'github')).toMatchObject({ status: 'available' });
    });

    parity('P-35', ['A-10', 'A-11', 'A-05'], ['I-076', 'I-075'], 'the existing merge is invoked without the confirmation click, re-validating the reviewed head exactly as the cockpit’s merge', async () => {
      const w = world();
      const state = await mcp(w, 'handoff_git', { action: 'merge_state', number: 128 });
      expect(state).toMatchObject({ status: 'done', qualityBlockers: [], mergeState: { headSha: DRY_HEAD, canMerge: true } });
      const stale = 'f'.repeat(40);
      const staleMcp = await mcp(w, 'handoff_git', { action: 'merge', number: 128, expectedHeadSha: stale });
      const staleUi = await ui(w, '/github/prs/128/merge', 'POST', { method: 'squash', expectedHeadSha: stale });
      expect(staleUi.status).toBe(409);
      expect(staleMcp).toMatchObject({ action: 'merge', status: 'conflict' });
      expect(staleMcp.error).toBe(staleUi.body.error);
      expect(await mcp(w, 'handoff_git', { action: 'merge', number: 128, expectedHeadSha: DRY_HEAD })).toMatchObject({ status: 'done', merged: true, number: 128 });
      const merged = await ui(w, '/github/prs/124/merge', 'POST', { method: 'squash', expectedHeadSha: DRY_HEAD });
      expect(merged.status).toBe(200);
      // F-04: no confirmation parameter exists to send.
      expect(JSON.stringify(toolListing(handoffGitTool).inputSchema)).not.toMatch(/confirm/i);
    });

    parity('P-36', ['A-10', 'A-05'], ['I-056', 'I-057'], 'a task branch is pushed and its draft PR created with the same effect through either door', async () => {
      const w = world();
      const bare = join(w.home, 'remote.git');
      const one = await finishedWithWorktree(w, 'publish via mcp');
      const two = await finishedWithWorktree(w, 'publish via ui');
      for (const r of [one, two]) {
        writeFileSync(join(r.worktreePath!, 'result.txt'), `${r.id}\n`, 'utf8');
        expect((await ui(w, `/runs/${r.id}/git/commit`, 'POST', { message: 'publish' })).status).toBe(200);
      }
      expect(await mcp(w, 'handoff_git', { action: 'push', taskId: one.id })).toMatchObject({ status: 'done' });
      expect((await ui(w, `/runs/${two.id}/git/push`, 'POST')).status).toBe(200);
      const remoteHead = (r: RunRecord) => git(bare, 'rev-parse', `refs/heads/${r.branch}`);
      expect(remoteHead(one)).toBe(git(one.worktreePath!, 'rev-parse', 'HEAD'));
      expect(remoteHead(two)).toBe(git(two.worktreePath!, 'rev-parse', 'HEAD'));

      const pr = await mcp(w, 'handoff_git', { action: 'create_pr', taskId: one.id });
      expect(pr).toMatchObject({ status: 'done' });
      expect((await ui(w, `/runs/${two.id}/pr`, 'POST')).status).toBeLessThan(300);
      expect(run(w, one.id)?.pullRequestUrl).toBe(pr.url);
      expect(run(w, two.id)?.pullRequestUrl).toMatch(/^https:\/\//);
    });

    parity('P-37', ['A-10', 'A-06', 'A-05'], ['I-025', 'I-026', 'I-027'], 'the Inbox is reported off with a reason, then read, started from and cleared as in the cockpit', async () => {
      const w = world();
      const off = await mcp(w, 'task_read', { view: 'inbox' });
      expect(off).toMatchObject({ available: false });
      expect(off.reason).toMatch(/XEZ_FOLLOWUPS|Settings/);
      process.env.XEZ_FOLLOWUPS = '1';
      const todos = [
        { id: 'alpha-todo-note', ts: '2026-09-03T00:00:00.000Z', summary: 'ALPHA inbox item', runnable: false },
        { id: 'alpha-run-1', ts: '2026-09-03T01:00:00.000Z', summary: 'Tighten notes', suggestedPrompt: 'tighten notes.txt', runnable: true },
        { id: 'alpha-run-2', ts: '2026-09-03T02:00:00.000Z', summary: 'Tighten notes', suggestedPrompt: 'tighten notes.txt', runnable: true },
        { id: 'alpha-note-2', ts: '2026-09-03T03:00:00.000Z', summary: 'Another note', runnable: false },
      ];
      writeFileSync(join(w.a.dataDir, 'todos.json'), JSON.stringify(todos), 'utf8');
      const inbox = await mcp(w, 'task_read', { view: 'inbox' });
      const cockpit = await ui(w, '/todos');
      expect((inbox.items ?? inbox.todos).map((t: { id: string }) => t.id).sort()).toEqual((cockpit.body as Array<{ id: string }>).map((t) => t.id).sort());

      const viaMcp = await mcp(w, 'organise_work', { action: 'start_inbox_item', todoId: 'alpha-run-1', runner: 'claude' });
      expect(viaMcp).toMatchObject({ accepted: true });
      const viaUi = await ui(w, '/todos/alpha-run-2/start', 'POST', { runner: 'claude' });
      expect(viaUi.status).toBe(201);
      const mcpRun = run(w, viaMcp.subject.id)!;
      const uiRun = run(w, viaUi.body.run.id)!;
      expect({ task: mcpRun.task, runner: mcpRun.runner, workflow: mcpRun.workflow }).toEqual({ task: uiRun.task, runner: uiRun.runner, workflow: uiRun.workflow });
      // The narrower option set: no agent account on an Inbox start.
      const withAccount = await w.call('a', 'task_create', { action: 'start_from_inbox', operationId: op(), todoId: 'alpha-note-2', agentProfile: 'default' });
      expect(withAccount.isError).toBe(true);
      expect(resultText(withAccount)).toMatch(/does not take: agentProfile/);

      expect(await mcp(w, 'organise_work', { action: 'remove_inbox_item', todoId: 'alpha-todo-note' })).toMatchObject({ status: 'done' });
      expect((await ui(w, '/todos/alpha-note-2', 'DELETE')).status).toBe(200);
      const left = JSON.parse(readFileSync(join(w.a.dataDir, 'todos.json'), 'utf8')) as Array<{ id: string; startedTaskId?: string }>;
      expect(left.map((t) => t.id)).not.toContain('alpha-todo-note');
      expect(left.map((t) => t.id)).not.toContain('alpha-note-2');
    });
  });

  // =============================================================================================
  // A-11 — deletion and the existing merge run despite the UI confirmation (P-09, P-10, P-35);
  // global writes (P-29) and quality weakening FAIL.
  // =============================================================================================
  describe('A-11 — a mandatory gate cannot be weakened', () => {
    const world = withWorld({}, addForgeRemote);

    parity('P-38', ['A-11'], ['I-076', 'I-107'], 'a merge past a failing required check fails as a reported blocker, and no approval parameter makes it succeed', async () => {
      const w = world();
      const failing = {
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
        // The repository WOULD let an administrator merge past it — the trap F-22 closes.
        canOverride: true,
      };
      const forge = withForge(w, (pathname) =>
        pathname.endsWith('/merge-state') ? new Response(JSON.stringify({ available: true, mergeState: failing }), { headers: { 'content-type': 'application/json' } }) : undefined,
      );
      const result = body(await forge.call({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD }));
      expect(result).toMatchObject({ action: 'merge', status: 'failed', refusedBy: 'quality', blocker: true, nextAction: QUALITY_BLOCKER_NEXT_ACTION });
      expect(result.blockers).toEqual([{ code: 'check-failing', message: 'Required check "test" is failing.' }]);
      for (const exception of [
        { overrideRules: true },
        { approvedBy: 'the human' },
        { humanApproval: true },
        { qualityException: true },
        { bypassChecks: true },
        { waiver: 'accepted risk' },
        { force: true },
        { confirm: true },
      ]) {
        const refused = await forge.call({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD, ...exception });
        expect(refused.isError, JSON.stringify(exception)).toBe(true);
        // The real socket answers the same: the key is an argument error, never an ignored field.
        const viaSocket = await w.call('a', 'handoff_git', { action: 'merge', number: 128, expectedHeadSha: DRY_HEAD, ...exception });
        expect(viaSocket.isError, JSON.stringify(exception)).toBe(true);
        expect(resultText(viaSocket)).toMatch(/^Invalid arguments for handoff_git/);
      }
      // Nothing was merged: no merge request reached the service on the quality-blocked path.
      expect(forge.dispatched.filter((d) => d.startsWith('POST') && d.endsWith('/merge'))).toEqual([]);

      // No tool anywhere in the registry offers a waiver, approval, bypass or override.
      const names: string[] = [];
      const values: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const n = node as { properties?: Record<string, unknown>; enum?: unknown[] };
        names.push(...Object.keys(n.properties ?? {}));
        for (const v of n.enum ?? []) if (typeof v === 'string') values.push(v);
        Object.values(node).forEach(walk);
      };
      for (const tool of tools) walk(toolListing(tool).inputSchema);
      expect([...names, ...values].filter((n) => /approv|waive|bypass|override|exception|skip_?check/i.test(n))).toEqual([]);

      // I-107: the optional review gate is a runtime status, not the mandatory gate — turning it off
      // is an ordinary project setting and leaves the merge refusal exactly where it was.
      await mcp(w, 'project_config', { action: 'set_config', config: { reviewGate: false } });
      expect(body(await forge.call({ action: 'merge', number: 128, expectedHeadSha: DRY_HEAD }))).toMatchObject({ refusedBy: 'quality', blocker: true });
    });
  });

  // =============================================================================================
  // F-05 — the project's own workflows, skills and automations: exactly the cockpit's set.
  // =============================================================================================
  describe('workflows and skills (F-05)', () => {
    const world = withWorld();

    parity('P-39', ['A-06', 'A-11', 'A-05'], ['I-083', 'I-086', 'I-087', 'I-088'], 'the workflow catalog, validation, save and delete match the cockpit’s, built-ins stay protected, and a check step is refused', async () => {
      const w = world();
      const listed = await mcp(w, 'project_config', { action: 'list_workflows' });
      const cockpit = await ui(w, '/workflows');
      const catalog = (items: Array<{ name: string; source: string }>) => items.map((i) => `${i.name}:${i.source}`).sort();
      expect(catalog(listed.result.workflows)).toEqual(catalog(cockpit.body.workflows));

      const yaml = 'name: parsed\nsteps:\n  - id: one\n    prompt: "{{task}}"\n';
      const parsed = await mcp(w, 'project_config', { action: 'parse_workflow', yaml });
      const cockpitParsed = await ui(w, '/workflows/parse', 'POST', { yaml });
      expect(parsed.result).toEqual(cockpitParsed.body);
      const badYaml = 'name: bad\nsteps:\n  - id: one\n    onFail: { retry: later }\n';
      expect((await w.call('a', 'project_config', { action: 'parse_workflow', yaml: badYaml })).isError).toBe(true);
      expect((await ui(w, '/workflows/parse', 'POST', { yaml: badYaml })).status).toBeGreaterThanOrEqual(400);

      const steps = [{ id: 'one', name: 'One', prompt: '{{task}}' }];
      await mcp(w, 'project_config', { action: 'save_workflow', workflow: { name: 'mcp-flow', steps } });
      expect((await ui(w, '/workflows', 'POST', { name: 'ui-flow', steps })).status).toBeLessThan(300);
      const file = (name: string) => join(w.a.root, '.xezar', 'workflows', `${name}.yaml`);
      expect(readFileSync(file('mcp-flow'), 'utf8').replaceAll('mcp-flow', 'X')).toBe(readFileSync(file('ui-flow'), 'utf8').replaceAll('ui-flow', 'X'));
      // A check step is a shell command the service would run later: refused through MCP (F-08).
      const check = await w.call('a', 'project_config', { action: 'save_workflow', workflow: { name: 'with-check', steps: [{ id: 'c', command: 'echo hi' }] } });
      expect(check.isError).toBe(true);
      expect(existsSync(file('with-check'))).toBe(false);

      await mcp(w, 'project_config', { action: 'delete_workflow', name: 'mcp-flow' });
      expect((await ui(w, '/workflows/ui-flow', 'DELETE')).status).toBeLessThan(300);
      expect([existsSync(file('mcp-flow')), existsSync(file('ui-flow'))]).toEqual([false, false]);
      const builtInMcp = await w.call('a', 'project_config', { action: 'delete_workflow', name: 'quick-task' });
      const builtInUi = await ui(w, '/workflows/quick-task', 'DELETE');
      expect(builtInUi.status).toBe(400);
      expect(builtInMcp.isError).toBe(true);
      expect(resultText(builtInMcp)).toContain(builtInUi.body.error);
      expect(catalog((await mcp(w, 'project_config', { action: 'list_workflows' })).result.workflows)).toContain('quick-task:built-in');
    });

    parity('P-40', ['A-06', 'A-05'], ['I-090', 'I-091'], 'the skill catalog, a skill’s body and a team-skill refresh read as the cockpit’s', async () => {
      const w = world();
      mkdirSync(join(w.a.root, '.xezar', 'skills'), { recursive: true });
      writeFileSync(join(w.a.root, '.xezar', 'skills', 'parity-notes.md'), '---\nname: parity-notes\ndescription: parity skill\n---\nApply the notes carefully.\n', 'utf8');
      const listed = await mcp(w, 'project_config', { action: 'list_skills', wait: true });
      const cockpit = await ui(w, '/skills?wait=1');
      const names = (value: unknown): string[] => {
        const items = Array.isArray(value) ? value : ((value as { skills?: unknown[] }).skills ?? []);
        return (items as Array<{ name: string }>).map((s) => s.name).sort();
      };
      expect(names(listed.result)).toEqual(names(cockpit.body));
      expect(names(listed.result)).toContain('parity-notes');
      const skill = await mcp(w, 'project_config', { action: 'get_skill', name: 'parity-notes', wait: true });
      expect(JSON.stringify(skill.result)).toContain('Apply the notes carefully.');
      expect(await mcp(w, 'project_config', { action: 'refresh_skills' })).toMatchObject({ action: 'refresh_skills' });
      expect((await ui(w, '/skills/refresh', 'POST')).status).toBe(200);
      // F-05: no skill CRUD the cockpit does not offer.
      expect(JSON.stringify(toolListing(tools.find((t) => t.name === 'project_config')!).inputSchema)).not.toMatch(/"(create|delete|update|write)_skill"/);
    });
  });

  describe('automations (F-05, D-97, D-102)', () => {
    const world = withWorld({ automations: true }, addForgeRemote);

    parity('P-41', ['A-06', 'A-05'], ['I-096', 'I-097', 'I-098', 'I-099', 'I-100', 'I-101', 'I-102'], 'automations are listed, created from the form’s values, edited under a revision, toggled, checked, logged, retried and deleted as the cockpit’s', async () => {
      const w = world();
      const listed = await mcp(w, 'project_config', { action: 'list_automations' });
      const cockpit = await ui(w, '/automations');
      expect(listed.result.automations.map((a: { id: string }) => a.id)).toEqual(cockpit.body.automations.map((a: { id: string }) => a.id));

      // D-97: the form's options, and the form's fixed values for everything else.
      const created = await mcp(w, 'project_config', { action: 'create_automation', automation: { name: 'Review new issues', prompt: 'Review {{github.url}}' } });
      const form = { events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review {{github.url}}', workflow: 'quick-task' } };
      const viaUi = await ui(w, '/automations', 'POST', { name: 'Review new issues', ...form });
      expect(viaUi.status).toBeLessThan(300);
      const shape = (a: Record<string, any>) => ({ name: a.name, enabled: a.enabled, events: a.events, intervalSeconds: a.intervalSeconds, filters: a.filters, task: a.task, revision: a.revision });
      const mcpAuto = (created.result.automation ?? created.result) as Record<string, any>;
      const uiAuto = (viaUi.body.automation ?? viaUi.body) as Record<string, any>;
      expect(shape(mcpAuto)).toEqual(shape(uiAuto));
      // Do not widen: a field the form does not expose is an argument error.
      expect((await w.call('a', 'project_config', { action: 'create_automation', automation: { name: 'x', prompt: 'y', intervalSeconds: 60 } })).isError).toBe(true);

      // Edit under the revision that was read; a stale revision is refused by both doors.
      const edited = await mcp(w, 'project_config', { action: 'update_automation', automationId: mcpAuto.id, update: { name: 'Renamed', expectedRevision: mcpAuto.revision } });
      expect(JSON.stringify(edited)).toContain('Renamed');
      const staleMcp = await w.call('a', 'project_config', { action: 'update_automation', automationId: mcpAuto.id, update: { name: 'Again', expectedRevision: mcpAuto.revision } });
      const staleUi = await ui(w, `/automations/${uiAuto.id}`, 'PUT', { name: 'Again', ...form, enabled: false, expectedRevision: uiAuto.revision + 5 });
      expect(staleUi.status).toBe(409);
      expect(staleMcp.isError).toBe(true);
      expect(resultText(staleMcp)).toMatch(/409/);

      // Enable and pause: two routes, the same state through either door.
      await mcp(w, 'project_config', { action: 'enable_automation', automationId: mcpAuto.id });
      expect((await ui(w, `/automations/${uiAuto.id}/enable`, 'POST')).status).toBe(200);
      const enabled = (id: string) => w.a.automations.list().find((a) => a.id === id)?.enabled;
      expect([enabled(mcpAuto.id), enabled(uiAuto.id)]).toEqual([true, true]);
      await mcp(w, 'project_config', { action: 'pause_automation', automationId: mcpAuto.id });
      expect((await ui(w, `/automations/${uiAuto.id}/pause`, 'POST')).status).toBe(200);
      expect([enabled(mcpAuto.id), enabled(uiAuto.id)]).toEqual([false, false]);

      // A preview check launches nothing; its result is read back by the check id the project owns.
      const runsBefore = w.a.store.listRuns().length;
      const check = await mcp(w, 'project_config', { action: 'check_automation', automationId: mcpAuto.id, mode: 'preview' });
      const checkId = (check.result.checkId ?? check.result.check?.id) as string;
      expect(checkId).toBeTruthy();
      let state: Record<string, any> = {};
      for (let i = 0; i < 100; i += 1) {
        state = await mcp(w, 'project_config', { action: 'get_automation_check', checkId });
        if (!/"(running|pending|queued)"/.test(JSON.stringify(state.result))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await ui(w, `/api/v1/automation-checks/${checkId}`)).body).toEqual(state.result);
      expect(w.a.store.listRuns().length).toBe(runsBefore);

      const log = await mcp(w, 'project_config', { action: 'get_automation_log', logQuery: { automationId: w.a.ids.automation } });
      expect(log.result).toEqual((await ui(w, `/automation-log?automationId=${w.a.ids.automation}`)).body);

      // D-102: retry only a failed launch — the seeded receipt is not one, so both doors refuse it.
      const retryMcp = await w.call('a', 'project_config', { action: 'retry_automation_receipt', receiptId: w.a.ids.receipt });
      const retryUi = await ui(w, `/automation-log/${w.a.ids.receipt}/retry`, 'POST');
      expect(retryUi.status).toBe(409);
      expect(retryMcp.isError).toBe(true);
      expect(resultText(retryMcp)).toContain(retryUi.body.error);

      await mcp(w, 'project_config', { action: 'delete_automation', automationId: mcpAuto.id });
      expect((await ui(w, `/automations/${uiAuto.id}`, 'DELETE')).status).toBeLessThan(300);
      expect(w.a.automations.list().map((a) => a.id)).toEqual([w.a.ids.automation]);
    });
  });

  describe('capabilities and discovery (F-03)', () => {
    const world = withWorld();

    parity('P-42', ['A-05'], ['I-133', 'I-136'], 'discovery answers the cockpit’s capability and tool facts for the bound project, with reasons, and nothing about other projects', async () => {
      const w = world();
      const discovery = await mcp(w, 'discover_project');
      const health = await ui(w, '/api/v1/health');
      expect(discovery.capabilities).toEqual({
        localHandoff: health.body.capabilities.localHandoff,
        followups: health.body.capabilities.followups,
        automations: health.body.capabilities.automations,
      });
      for (const check of health.body.checks as Array<{ name: string; available: boolean }>) {
        const agent = discovery.agents.find((a: { runner: string }) => a.runner === check.name);
        const tool = discovery.tools.find((t: { name: string }) => t.name === check.name);
        expect((agent?.installed ?? tool?.available) as boolean, check.name).toBe(check.available);
      }
      expect(discovery.project).toMatchObject({ id: PROJECT_A, name: 'alpha project' });
      // Every closed action says why (F-03).
      for (const action of discovery.actions as Array<{ status: string; reason?: string }>) {
        if (action.status !== 'available') expect(action.reason).toBeTruthy();
      }
      expect(discovery.actions.find((a: { id: string }) => a.id === 'inbox').reason).toMatch(/XEZ_FOLLOWUPS/);
      // B1 (#677 wave 2): the shared limits became writable, so the row is available and carries
      // no reason. It was `read-only` with "only a person can change them" until 2026-09-20.
      expect(discovery.actions.find((a: { id: string }) => a.id === 'workspace_limits')).toEqual({
        id: 'workspace_limits',
        label: 'Change workspace-wide limits',
        status: 'available',
      });
      // The health read is FILTERED: the project list and the boot project never reach the leader.
      expect(JSON.stringify(discovery)).not.toMatch(/"projects"|"bootProject"/);
      expect(leaked(JSON.stringify(discovery), w.b.names)).toEqual([]);
    });
  });
});

// =================================================================================================
// A-05 — the matrix. Every `covered` record of the closed inventory maps to at least one case, every
// case names a record, and the published coverage map says exactly the same, both ways.
// =================================================================================================

const REPO_ROOT = new URL('../../../../', import.meta.url);
const INVENTORY = new URL('docs/features/mcp-server/mcp-ui-action-inventory.md', REPO_ROOT);
const COVERAGE_MAP = new URL('docs/features/mcp-server/mcp-parity-coverage-map.md', REPO_ROOT);
/** The browser half of A-08. It runs only under `npm run test:e2e`; here it is only READ, for its case titles. */
const BROWSER_SPEC = new URL('packages/web/e2e/mcp-collaboration.e2e.ts', REPO_ROOT);

interface BrowserCase {
  readonly id: string;
  readonly acceptance: readonly string[];
  readonly records: readonly string[];
  readonly title: string;
}

/** The browser cases, from their titles: `it('B-nn (A-xx, A-yy) [I-nnn I-mmm] what it proves'`. */
function browserCases(): BrowserCase[] {
  const source = readFileSync(BROWSER_SPEC, 'utf8');
  return [...source.matchAll(/\bit\(\s*'(B-\d{2}) \(([^)]*)\) \[([^\]]*)\] ([^']+)'/g)].map((m) => ({
    id: m[1]!,
    acceptance: m[2]!.split(', ').filter(Boolean),
    records: m[3]!.split(' ').filter(Boolean),
    title: m[4]!,
  }));
}

type InventoryStatus = 'covered' | 'global' | 'presentation';

function readInventory(): Map<string, InventoryStatus> {
  const rows = new Map<string, InventoryStatus>();
  for (const line of readFileSync(INVENTORY, 'utf8').split('\n')) {
    const m = /^\| (I-\d{3}) \|.*\| (covered|global|presentation) \|$/.exec(line);
    if (m) rows.set(m[1]!, m[2] as InventoryStatus);
  }
  return rows;
}

/** The three published tables, generated from the registry and the browser spec — what the map must say verbatim. */
function expectedTables(inventory: Map<string, InventoryStatus>): { records: string; cases: string; browser: string } {
  const byRecord = new Map<string, string[]>();
  for (const c of CASES) for (const r of c.records) byRecord.set(r, [...(byRecord.get(r) ?? []), c.blocker ? `${c.id} (BLOCKED)` : c.id]);
  const browser = browserCases();
  for (const c of browser) for (const r of c.records) byRecord.set(r, [...(byRecord.get(r) ?? []), c.id]);
  const recordRows = [...inventory]
    .filter(([id, status]) => status === 'covered' || byRecord.has(id))
    .map(([id, status]) => `| ${id} | ${status} | ${(byRecord.get(id) ?? []).join(', ')} |`);
  const caseRows = CASES.map((c) => `| ${c.id} | ${c.acceptance.join(', ')} | ${c.records.join(', ')} | ${c.blocker ? `**BLOCKED** — ${c.blocker}` : c.title} |`);
  return {
    records: ['| Record | Inventory status | Cases |', '| --- | --- | --- |', ...recordRows].join('\n'),
    cases: ['| Case | Acceptance | Records | What it proves |', '| --- | --- | --- | --- |', ...caseRows].join('\n'),
    browser: [
      '| Case | Acceptance | Records | What it proves |',
      '| --- | --- | --- | --- |',
      ...browser.map((c) => `| ${c.id} | ${c.acceptance.join(', ')} | ${c.records.join(', ')} | ${c.title} |`),
    ].join('\n'),
  };
}

function publishedBlock(doc: string, name: string): string {
  const m = new RegExp(`<!-- parity-map:${name}:start -->\\n([\\s\\S]*?)\\n<!-- parity-map:${name}:end -->`).exec(doc);
  return m ? m[1]!.trim() : '';
}

describe('A-05 — the coverage matrix against the closed inventory', () => {
  afterAll(() => {
    // Keeps the published count honest in the run log too.
    const blockedCases = CASES.filter((c) => c.blocker).map((c) => c.id);
    if (blockedCases.length > 0) console.info(`[#116] blocked parity cases (not passing): ${blockedCases.join(', ')}`);
  });

  it('the inventory is the closed 152-record one, with 114 covered records', () => {
    const inventory = readInventory();
    expect(inventory.size).toBe(152);
    // 96 until #677 B1 moved the five workspace-settings rows (I-117 … I-121) from `global`, 101
    // until B2 moved the two workspace folder paths (I-127) and 102 until B3 moved the three
    // shared-preference rows (I-024, I-092, I-132), 105 until B4 moved the provider switch
    // (I-115) and 106 until B5 moved the accounts (I-122, I-123, I-124), all under the same
    // owner rule.
    // 109 until #467 PR 5 added I-148 … I-151, the instance mode and its three presentation
    // siblings in Settings → Terminal, covered by the same `get_limits` + `set_workspace_config` pair,
    // and 113 until #819 PR 9 added I-152, the copy of the machine-wide accounts (P-49).
    expect([...inventory.values()].filter((s) => s === 'covered')).toHaveLength(114);
  });

  it('every covered record maps to at least one case, and every case names inventory records', () => {
    const inventory = readInventory();
    const mapped = new Set(CASES.flatMap((c) => c.records));
    const unmapped = [...inventory].filter(([id, status]) => status === 'covered' && !mapped.has(id)).map(([id]) => id);
    expect(unmapped, 'covered records with no case').toEqual([]);
    for (const c of CASES) {
      expect(c.records.length, c.id).toBeGreaterThan(0);
      expect(c.acceptance.length, c.id).toBeGreaterThan(0);
      for (const r of c.records) expect(inventory.has(r), `${c.id} names ${r}, which is not in the inventory`).toBe(true);
    }
    // A presentation record needs no tool (section 3); naming one would dress up a non-action as coverage.
    const presentation = CASES.flatMap((c) => c.records.filter((r) => inventory.get(r) === 'presentation').map((r) => `${c.id}:${r}`));
    expect(presentation).toEqual([]);
  });

  it('the browser half of A-08 exists, and every one of its cases names A-08 and inventory records', () => {
    const inventory = readInventory();
    const source = readFileSync(BROWSER_SPEC, 'utf8');
    const cases = browserCases();
    // A title that misses the `B-nn (…) [ … ]` shape would silently drop out of the map; count them loosely too.
    expect(cases.length, 'browser cases the title pattern parsed').toBe([...source.matchAll(/\bit(?:\.\w+)?\(\s*['"`]B-\d/g)].length);
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.acceptance, c.id).toContain('A-08');
      expect(c.records.length, c.id).toBeGreaterThan(0);
      for (const r of c.records) expect(inventory.get(r), `${c.id} names ${r}`).toBe('covered');
    }
  });

  it('the published coverage map says exactly what this suite registers, both ways', () => {
    const doc = readFileSync(COVERAGE_MAP, 'utf8');
    const expected = expectedTables(readInventory());
    expect(publishedBlock(doc, 'records'), `regenerate the records table:\n${expected.records}`).toBe(expected.records);
    expect(publishedBlock(doc, 'cases'), `regenerate the cases table:\n${expected.cases}`).toBe(expected.cases);
    expect(publishedBlock(doc, 'browser'), `regenerate the browser table:\n${expected.browser}`).toBe(expected.browser);
  });
});
