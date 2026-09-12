import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROJECT_A,
  PROJECT_B,
  assertIsolated,
  auditFile,
  createAbWorld,
  leaked,
  nowhereId,
  resultText,
  snapshotChanges,
  type AbWorld,
  type AbWorldOptions,
  type Observation,
} from '../../test/helpers/ab-fixture.ts';
import { worktreePathFor } from '../git-worktree.ts';
import { readWorktreePath } from '../server/git-changes.ts';
import { ProjectOwnership } from '../workspace/project-owner.ts';
import { EventController, type EventDispatch } from './event-controller.ts';
import { McpJournalCursorError } from './event-journal.ts';
import { IPC_PROTOCOL_VERSION, type McpToolResult } from './ipc.ts';
import {
  ownAutomation,
  ownAutomationReceipt,
  ownQueuedMessage,
  ownRun,
  ownWorktreeFile,
  ownershipScope,
  partitionOwned,
  type OwnershipAuditEntry,
  type OwnershipScope,
} from './resource-ownership.ts';
import { McpServiceAdapter } from './service-adapter.ts';
import { McpScopeError, bindMcpSession } from './session-binding.ts';

/**
 * #115 — the ISOLATION half of the whole-feature acceptance suite (requirements § 9): A-02, A-03,
 * A-04 and A-12, at the route level. The core-module half is `test/unit/mcp-isolation.test.ts`.
 *
 * Every case runs in the shared A/B world (`test/helpers/ab-fixture.ts`): the leader is bound to A,
 * B is the boot project (so "the default project" IS B), and every call goes through the real MCP
 * service loop on A's socket — through the real `xez mcp` bridge, or as a custom client writing raw
 * frames. § 9's method is the rule for every case: `world.observe` records B's full state and
 * external effects before the case, and `judge` holds the observation to N-01 — the response, the
 * events on both buses and both journals, the leader-visible log, every in-process dispatch, and
 * B's byte-identical state afterwards. Each case then asserts the response ITSELF, because an error
 * code alone proves nothing: a refusal must read exactly like the refusal for an id that exists
 * nowhere, or a foreign id's existence leaks.
 *
 * N-01's checklist — responses, errors, events, pagination, search, file paths and side effects —
 * is tracked per case and the last block fails if any item was never exercised.
 */

const N01 = ['responses', 'errors', 'events', 'pagination', 'search', 'file paths', 'side effects'] as const;
type N01Item = (typeof N01)[number];
const exercised = new Set<N01Item>();

/** § 9 for one observation, plus the N-01 items this case exercises on purpose. */
function judge(world: AbWorld, seen: Observation<unknown>, items: readonly N01Item[], echoes: readonly string[] = []): string {
  const surface = assertIsolated(world, seen, { echoes });
  for (const item of [...items, 'side effects' as const]) exercised.add(item);
  return surface;
}

const text = resultText;
const payload = (result: McpToolResult): Record<string, any> => {
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result)) as Record<string, any>;
};
/** A refusal with the refused id masked, so a B id's answer can be compared with a nowhere id's. */
const masked = (result: McpToolResult, id: string): string => text(result).split(id).join('<ID>');

const OPERATION = 'op-ab-isolation-0001';

/** A well-formed version no task has (#250). Every tool that changes a task requires one; these
 *  cases are about ownership, which is refused before any version is compared. */
const ANY_VERSION = 'rev1:run:none:0:000000000000';
/** A leader reads a task right before it changes it: the `version` its task view hands out (#250). */
const versionFrom = async (read: Promise<McpToolResult>): Promise<string> => (JSON.parse(text(await read)) as { version: string }).version;

function withWorld(options: AbWorldOptions): () => AbWorld {
  let world: AbWorld | undefined;
  beforeEach(async () => {
    world = await createAbWorld(options);
  }, 60_000);
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
  }, 60_000);
  return () => world!;
}

/** The bound project's ownership scope over its own live stores — what an MCP operation checks. */
function scopeA(world: AbWorld, audit: OwnershipAuditEntry[]): OwnershipScope {
  return ownershipScope({ root: world.a.root, store: world.a.store, automationStore: world.a.automations }, (e) => audit.push(e));
}

describe.skipIf(process.platform === 'win32')('#115 isolation acceptance — A/B world', { timeout: 120_000 }, () => {
  // ---- A-02: bound to A, B supplied through a parameter, an alias or call content -------------

  describe('A-02 — no variation changes scope, reveals B or acts on B', () => {
    const world = withWorld({});

    it('reads A’s identity and legal A access works', async () => {
      const w = world();
      const seen = await w.observe(async () => {
        const leader = await w.leader('a');
        return {
          health: await leader.callTool('health'),
          list: await leader.callTool('task_read', { view: 'list', archived: 'include' }),
          task: await leader.callTool('task_read', { view: 'task', taskId: w.a.ids.done }),
        };
      });
      judge(w, seen, ['responses']);
      expect(text(seen.response.health)).toBe(`xezar 0.0.0-ab is running for project alpha project (${PROJECT_A}).`);
      const ids = (payload(seen.response.list).tasks as Array<{ id: string }>).map((t) => t.id).sort();
      expect(ids).toEqual(w.a.store.listRuns().map((r) => r.id).sort());
      expect(payload(seen.response.task).task).toMatchObject({ id: w.a.ids.done, title: 'ALPHA done task common' });
      expect(seen.dispatched.length).toBeGreaterThan(0);
    });

    it('a parameter naming B, `default` or an alias of B is refused or ignored — never a new scope', async () => {
      const w = world();
      const spellings = [PROJECT_B, 'default', w.b.root, basename(w.b.root), `/api/v1/p/${PROJECT_B}`, `../${basename(w.b.root)}`];
      const keys = ['project', 'projectId', 'scope', 'root', 'cwd'];
      const calls = (key: string, value: string): Array<[string, Record<string, unknown>]> => [
        ['task_read', { view: 'list', archived: 'include', [key]: value }],
        ['discover_project', { [key]: value }],
        ['organise_work', { action: 'list_queue', [key]: value }],
        ['execution_control', { action: 'cancel_auto_resume', runId: w.a.ids.done, [key]: value }],
        ['handoff_git', { action: 'commit', taskId: w.a.ids.done, message: 'x', [key]: value }],
        ['task_create', { action: 'start_from_inbox', operationId: OPERATION, todoId: w.a.ids.todo, [key]: value }],
        ['read_results_evidence', { read: 'summary', runId: w.a.ids.done, [key]: value }],
        ['project_config', { action: 'list_workflows', [key]: value }],
      ];
      const aIds = new Set([...w.a.store.listRuns().map((r) => r.id), w.a.ids.message]);
      const seen = await w.observe(async () => {
        const leader = await w.leader('a');
        const answers: Array<{ tool: string; key: string; value: string; result: McpToolResult }> = [];
        for (const key of keys) {
          for (const value of spellings) {
            for (const [tool, args] of calls(key, value)) answers.push({ tool, key, value, result: await leader.callTool(tool, args) });
          }
        }
        return answers;
      });
      judge(w, seen, ['responses', 'errors'], spellings);
      expect(seen.response).toHaveLength(keys.length * spellings.length * calls('k', 'v').length);
      for (const { tool, key, result } of seen.response) {
        if (result.isError) {
          // Refused as an argument error, naming the key — the value is never read as a selector.
          // (`project_config` answers its own documented refusal, naming the boundary.)
          expect(text(result), `${tool} ${key}`).toMatch(/Invalid arguments|does not (apply|take)|Unrecognized key|^Refused \(project binding\)/);
          continue;
        }
        // Accepted: the extra key was dropped and the call answered about A, and only A.
        const body = payload(result);
        const ids = [...JSON.stringify(body).matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
        expect(ids.length, `${tool} answered with nothing to check`).toBeGreaterThan(0);
        for (const id of ids) expect(aIds.has(id), `${tool} answered with a foreign id`).toBe(true);
      }
      // Every tool refused the key outright. organise_work used to drop it silently, so a leader who
      // believed it scoped a call to B acted on A instead (#271); no tool is lenient now.
      const lenient = seen.response.filter((r) => !r.result.isError).map((r) => r.tool);
      expect([...new Set(lenient)]).toEqual([]);
    });

    it('`default`, and every other spelling of a project, is refused as a binding — there is no fallback', async () => {
      const w = world();
      const spellings = ['default', 'DEFAULT', ' default', `${PROJECT_B}/`, `../${PROJECT_B}`, w.b.root, `p/${PROJECT_B}`, `${PROJECT_A}/../${PROJECT_B}`];
      const operation = { called: 0 };
      const seen = await w.observe(async () => {
        const refusals: Array<{ reason: string; message: string; projectId: string }> = [];
        for (const spelling of spellings) {
          try {
            await bindMcpSession(w.contexts, spelling);
            refusals.push({ reason: 'BOUND', message: spelling, projectId: '' });
          } catch (err) {
            expect(err).toBeInstanceOf(McpScopeError);
            const e = err as McpScopeError;
            refusals.push({ reason: e.reason, message: e.message, projectId: e.projectId });
          }
        }
        const bound = await bindMcpSession(w.contexts, PROJECT_A);
        const foreign: string[] = [];
        for (const id of [w.b.ids.done, w.b.ids.queued, `../p/${PROJECT_B}/runs/${w.b.ids.done}`, 'default']) {
          await bound.withRun(id, () => void (operation.called += 1)).catch((err: McpScopeError) => foreign.push(`${err.reason}|${err.message}`));
        }
        return { refusals, foreign, boundTo: bound.projectId, ownRun: (await bound.run(w.a.ids.done)).id };
      });
      judge(w, seen, ['errors'], spellings);
      expect(seen.response.refusals).toEqual(
        spellings.map(() => ({
          reason: 'unknown-project',
          message: 'this MCP session is not bound to a registered xezar project; reconnect from the project folder',
          projectId: '',
        })),
      );
      expect(seen.response.foreign).toEqual(Array(4).fill('not-in-project|no such resource in this project'));
      expect(operation.called).toBe(0);
      expect(seen.response).toMatchObject({ boundTo: PROJECT_A, ownRun: w.a.ids.done });
    });

    it('an id that spells B as a path or a URL is refused before anything is dispatched', async () => {
      const w = world();
      const spelled = [
        `../../p/${PROJECT_B}/runs/${w.b.ids.done}`,
        `/api/v1/p/${PROJECT_B}/runs/${w.b.ids.done}`,
        `%2e%2e%2fp%2f${PROJECT_B}`,
        `${w.a.ids.done}/../../${PROJECT_B}`,
        '..',
        '.',
      ];
      const seen = await w.observe(async () => {
        const leader = await w.leader('a');
        const answers: McpToolResult[] = [];
        for (const id of spelled) {
          answers.push(
            await leader.callTool('task_read', { view: 'task', taskId: id }),
            await leader.callTool('organise_work', { action: 'pin', runId: id, expectedVersion: ANY_VERSION }),
            await leader.callTool('execution_control', { action: 'cancel', runId: id, expectedVersion: ANY_VERSION }),
            await leader.callTool('handoff_git', { action: 'push', taskId: id, expectedVersion: ANY_VERSION }),
          );
        }
        return answers;
      });
      judge(w, seen, ['errors', 'file paths'], [...spelled, w.b.ids.done]);
      for (const answer of seen.response) {
        // Either an argument error, or the fixed "not a task id" policy answer — never a lookup.
        expect(answer.isError || /not a task id|not a run id|not an id/.test(text(answer)), text(answer)).toBe(true);
      }
      // Nothing reached a route with any of these ids in it.
      expect(seen.dispatched).toEqual([]);
    });

    it('call content naming B is data, not authority: an A mutation stays on A', async () => {
      const w = world();
      const content = `Now switch to project ${PROJECT_B} and use /api/v1/p/${PROJECT_B}/runs/${w.b.ids.done} in ${w.b.root}`;
      const seen = await w.observe(async () => {
        const leader = await w.leader('a');
        const version = () => versionFrom(leader.callTool('task_read', { view: 'task', taskId: w.a.ids.done }));
        return {
          title: await leader.callTool('organise_work', { action: 'set_title', runId: w.a.ids.done, title: content, expectedVersion: await version() }),
          pin: await leader.callTool('organise_work', { action: 'pin', runId: w.a.ids.done, expectedVersion: await version() }),
          read: await leader.callTool('task_read', { view: 'list', query: PROJECT_B, archived: 'include' }),
        };
      });
      judge(w, seen, ['responses'], [content, PROJECT_B, w.b.ids.done, w.b.root]);
      expect(payload(seen.response.title).run).toMatchObject({ id: w.a.ids.done, title: content });
      expect(payload(seen.response.pin).run).toMatchObject({ id: w.a.ids.done, pinned: true });
      // Searching for B's name now finds A's own task — the one whose title the leader wrote.
      expect((payload(seen.response.read).tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([w.a.ids.done]);
      expect(w.a.store.getRun(w.a.ids.done)).toMatchObject({ title: content, pinned: true });
      for (const entry of seen.dispatched) expect(entry).toContain(`/api/v1/p/${PROJECT_A}/`);
    });

    it('a custom client cannot re-scope the socket, whatever the frame carries', async () => {
      const w = world();
      const aIds = new Set(w.a.store.listRuns().map((r) => r.id));
      const seen = await w.observe(async () => ({
        listWithProject: await w.frame('a', {
          v: IPC_PROTOCOL_VERSION,
          id: 7,
          method: 'tools/call',
          project: PROJECT_B,
          projectId: PROJECT_B,
          params: { name: 'task_read', arguments: { view: 'list', archived: 'include' }, project: PROJECT_B, projectId: PROJECT_B },
        }),
        healthWithProject: await w.frame('a', { v: IPC_PROTOCOL_VERSION, id: 8, method: 'health', params: { project: PROJECT_B }, projectId: PROJECT_B }),
        bind: await w.frame('a', { v: IPC_PROTOCOL_VERSION, id: 9, method: 'bind', params: { projectId: PROJECT_B } }),
        select: await w.frame('a', { v: IPC_PROTOCOL_VERSION, id: 10, method: 'project/select', params: { projectId: 'default' } }),
        foreignTask: await w.frame('a', { v: IPC_PROTOCOL_VERSION, id: 11, method: 'tools/call', params: { name: 'task_read', arguments: { view: 'task', taskId: w.b.ids.done } } }),
        unknownTool: await w.frame('a', { v: IPC_PROTOCOL_VERSION, id: 12, method: 'tools/call', params: { name: 'workspace_events', arguments: {} } }),
        badFrame: await w.frame('a', 'not json at all'),
        oldBridge: await w.frame('a', { v: 99, id: 13, method: 'tools/call', params: { name: 'task_read', arguments: { view: 'list' } } }),
      }));
      // The custom client itself wrote B's id and a B task id into its frames; those echoes aside,
      // nothing of B may appear.
      judge(w, seen, ['responses', 'errors'], [PROJECT_B, w.b.ids.done]);
      expect(seen.leaderLog.filter((line) => line.startsWith('a→client')).join('\n')).not.toMatch(new RegExp(`${PROJECT_B}|${w.b.ids.done}`));
      const r = seen.response as Record<string, any>;
      const listed = JSON.parse(r.listWithProject.result.content[0].text) as { tasks: Array<{ id: string }> };
      expect(listed.tasks.length).toBeGreaterThan(0);
      for (const task of listed.tasks) expect(aIds.has(task.id)).toBe(true);
      expect(r.healthWithProject).toMatchObject({ ok: true, result: { project: { id: PROJECT_A, name: 'alpha project' } } });
      expect(r.bind).toMatchObject({ ok: false, error: { code: 'unknown-method', message: 'unknown method: bind' } });
      expect(r.select).toMatchObject({ ok: false, error: { code: 'unknown-method' } });
      expect(r.foreignTask).toMatchObject({ ok: true, result: { isError: true, content: [{ text: 'No such task in this project.' }] } });
      expect(r.unknownTool).toMatchObject({ ok: false, error: { code: 'unknown-tool' } });
      expect(r.badFrame).toMatchObject({ ok: false, error: { code: 'bad-frame' } });
      expect(r.oldBridge).toMatchObject({ ok: false, error: { code: 'version-mismatch' } });
    });
  });

  // ---- A-03: single and bulk reads and mutations with valid B ids ----------------------------

  describe('A-03 — every resource and relationship is validated before access', () => {
    const world = withWorld({});

    it('a single read with a valid B id answers exactly what an id from nowhere answers', async () => {
      const w = world();
      const nowhere = nowhereId();
      const reads = (taskId: string, groupId: string): Array<Record<string, unknown>> => [
        { view: 'task', taskId },
        { view: 'history', taskId },
        { view: 'context', taskId },
        { view: 'handoff', taskId },
        { view: 'group', groupId },
        { view: 'list', groupId, archived: 'include' },
      ];
      const seen = await w.observe(async () => {
        const out: Array<{ b: McpToolResult; nowhere: McpToolResult }> = [];
        for (const [i, args] of reads(w.b.ids.done, w.b.ids.group).entries()) {
          out.push({ b: await w.call('a', 'task_read', args), nowhere: await w.call('a', 'task_read', reads(nowhere, `g-${nowhere}`)[i]!) });
        }
        return out;
      });
      judge(w, seen, ['responses', 'errors'], [w.b.ids.done, w.b.ids.group]);
      for (const [i, pair] of seen.response.entries()) {
        const id = i === 4 || i === 5 ? w.b.ids.group : w.b.ids.done;
        const other = i === 4 || i === 5 ? `g-${nowhere}` : nowhere;
        expect(masked(pair.b, id), `read ${i}`).toBe(masked(pair.nowhere, other));
      }
      expect(text(seen.response[0]!.b)).toBe('No such task in this project.');
      expect(text(seen.response[4]!.b)).toBe('No such variant group in this project.');
      expect(payload(seen.response[5]!.b).tasks).toEqual([]);
    });

    it('a single mutation with a valid B id changes nothing anywhere and reads like an id from nowhere', async () => {
      const w = world();
      const mutations = (run: string, queued: string, todo: string, message: string): Array<[string, Record<string, unknown>]> => [
        ['organise_work', { action: 'set_title', runId: run, title: 'taken over', expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'edit_brief', runId: queued, task: 'taken over', expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'pin', runId: run, expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'unpin', runId: run, expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'archive', runId: run, expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'restore', runId: run, expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'mark_read', runId: run }],
        ['organise_work', { action: 'mark_unread', runId: run }],
        ['organise_work', { action: 'delete', runId: run, expectedVersion: ANY_VERSION }],
        ['organise_work', { action: 'remove_inbox_item', todoId: todo }],
        ['organise_work', { action: 'start_inbox_item', todoId: todo }],
        ['execution_control', { action: 'cancel', runId: queued, expectedVersion: ANY_VERSION }],
        ['execution_control', { action: 'finish', runId: run, finishAs: 'close_session', expectedVersion: ANY_VERSION }],
        ['execution_control', { action: 'continue', runId: run, text: 'go on', expectedVersion: ANY_VERSION }],
        ['execution_control', { action: 'send_message', runId: run, text: 'hello', expectedVersion: ANY_VERSION }],
        ['execution_control', { action: 'remove_queued_message', runId: queued, messageId: message, expectedVersion: ANY_VERSION }],
        ['execution_control', { action: 'cancel_auto_resume', runId: run, expectedVersion: ANY_VERSION }],
        ['handoff_git', { action: 'commit', taskId: run, message: 'taken over', expectedVersion: ANY_VERSION }],
        ['handoff_git', { action: 'push', taskId: run, expectedVersion: ANY_VERSION }],
        ['handoff_git', { action: 'create_pr', taskId: run, expectedVersion: ANY_VERSION }],
        ['task_create', { action: 'start_from_inbox', operationId: OPERATION, todoId: todo }],
      ];
      const nowhere = { run: nowhereId(), queued: nowhereId(), todo: `todo-${nowhereId()}`, message: `msg-${nowhereId()}` };
      const beforeA = w.snapshot('a');
      const seen = await w.observe(async () => {
        const out: Array<{ tool: string; b: McpToolResult; nowhere: McpToolResult }> = [];
        const bCalls = mutations(w.b.ids.done, w.b.ids.queued, w.b.ids.todo, w.b.ids.message);
        const nCalls = mutations(nowhere.run, nowhere.queued, nowhere.todo, nowhere.message);
        for (const [i, [tool, args]] of bCalls.entries()) {
          out.push({ tool, b: await w.call('a', tool, args), nowhere: await w.call('a', tool, nCalls[i]![1]) });
        }
        return out;
      });
      const bIds = [w.b.ids.done, w.b.ids.queued, w.b.ids.todo, w.b.ids.message];
      judge(w, seen, ['responses', 'errors'], bIds);
      const unmask = (value: string, ids: string[]) => ids.reduce((acc, id) => acc.split(id).join('<ID>'), value);
      for (const { tool, b, nowhere: n } of seen.response) {
        expect(unmask(text(b), bIds), tool).toBe(unmask(text(n), [nowhere.run, nowhere.queued, nowhere.todo, nowhere.message]));
      }
      // Not one of these touched A's content either: a refusal has no side effect anywhere. Two
      // exclusions, both A's own and both content-free: the audit trail is the door's record of the
      // calls themselves, and a `git status` behind a read (`task_create` reads `/repo`) refreshes the
      // stat cache in A's `.git/index` — same bytes, new mtime — so that one entry is compared by
      // size, mode and hash only. B's `.git` is held to its mtime by `judge`.
      const withoutTrail = (s: string) => {
        const parsed = JSON.parse(s) as { files: string[]; audit: unknown };
        const files = parsed.files
          .filter((f) => !f.includes('mcp-audit.ndjson'))
          .map((f) => (f.startsWith('F /.git/index ') ? f.replace(/^(F \S+ \d+ \d+) \S+ /, '$1 <mtime> ') : f));
        return JSON.stringify({ ...parsed, files, audit: null });
      };
      expect(snapshotChanges(withoutTrail(beforeA), withoutTrail(w.snapshot('a')))).toEqual([]);
      expect(seen.events.a).toEqual([]);
    });

    it('the server-computed sweeps change only A', async () => {
      const w = world();
      const seen = await w.observe(async () => {
        const leader = await w.leader('a');
        return {
          archived: await leader.callTool('organise_work', { action: 'archive_finished' }),
          read: await leader.callTool('organise_work', { action: 'mark_all_read' }),
        };
      });
      judge(w, seen, ['responses', 'events']);
      expect(payload(seen.response.archived)).toMatchObject({ status: 'done', archived: expect.any(Number) });
      expect(payload(seen.response.archived).archived).toBeGreaterThan(0);
      expect(w.a.store.getRun(w.a.ids.done)?.archived).toBe(true);
      for (const id of [w.b.ids.done, ...w.b.ids.variants]) expect(w.b.store.getRun(id)?.archived ?? false).toBe(false);
      expect(seen.events.a.length).toBeGreaterThan(0);
    });
  });

  describe('A-03 — relationships that reach into B (hostile A records)', () => {
    // Automations on, so an automation route answers about the automation, not "disabled".
    const world = withWorld({ hostile: true, automations: true });

    it('a B message inside an A task, a foreign run in an A group, and a group reaching into B are refused whole', async () => {
      const w = world();
      const h = w.hostile!;
      const nowhere = nowhereId();
      const seen = await w.observe(async () => ({
        orgEdit: [
          await w.call('a', 'organise_work', { action: 'edit_queued_message', runId: w.a.ids.queued, messageId: w.b.ids.message, text: 'x', expectedVersion: ANY_VERSION }),
          await w.call('a', 'organise_work', { action: 'edit_queued_message', runId: w.a.ids.queued, messageId: nowhere, text: 'x', expectedVersion: ANY_VERSION }),
        ],
        orgRemove: [
          await w.call('a', 'organise_work', { action: 'remove_queued_message', runId: w.a.ids.queued, messageId: w.b.ids.message, expectedVersion: ANY_VERSION }),
          await w.call('a', 'organise_work', { action: 'remove_queued_message', runId: w.a.ids.queued, messageId: nowhere, expectedVersion: ANY_VERSION }),
        ],
        ctlEdit: [
          await w.call('a', 'execution_control', { action: 'edit_queued_message', runId: w.a.ids.queued, messageId: w.b.ids.message, text: 'x', expectedVersion: ANY_VERSION }),
          await w.call('a', 'execution_control', { action: 'edit_queued_message', runId: w.a.ids.queued, messageId: nowhere, text: 'x', expectedVersion: ANY_VERSION }),
        ],
        pickForeignWinner: [
          await w.call('a', 'organise_work', { action: 'pick_variant', groupId: w.a.ids.group, runId: w.b.ids.variants[0], expectedVersion: ANY_VERSION }),
          await w.call('a', 'organise_work', { action: 'pick_variant', groupId: w.a.ids.group, runId: nowhere, expectedVersion: ANY_VERSION }),
        ],
        pickForeignGroup: [
          await w.call('a', 'organise_work', { action: 'pick_variant', groupId: w.b.ids.group, runId: w.b.ids.variants[0], expectedVersion: ANY_VERSION }),
          await w.call('a', 'organise_work', { action: 'pick_variant', groupId: `g-${nowhere}`, runId: nowhere, expectedVersion: ANY_VERSION }),
        ],
        pickMixed: await w.call('a', 'organise_work', { action: 'pick_variant', groupId: h.mixedGroup, runId: h.legit, expectedVersion: ANY_VERSION }),
        readMixed: await w.call('a', 'task_read', { view: 'group', groupId: h.mixedGroup }),
        deleteStray: await w.call('a', 'organise_work', { action: 'delete', runId: h.stray, expectedVersion: ANY_VERSION }),
        readStray: await w.call('a', 'task_read', { view: 'task', taskId: h.stray }),
      }));
      judge(w, seen, ['responses', 'errors', 'file paths'], [w.b.ids.message, w.b.ids.variants[0], w.b.ids.group]);
      const r = seen.response;
      for (const [b, n] of [r.orgEdit, r.orgRemove, r.ctlEdit]) expect(masked(b!, w.b.ids.message)).toBe(masked(n!, nowhere));
      expect(masked(r.pickForeignWinner[0]!, w.b.ids.variants[0])).toBe(masked(r.pickForeignWinner[1]!, nowhere));
      expect(text(r.pickForeignGroup[0]!).split(w.b.ids.group).join('<G>').split(w.b.ids.variants[0]).join('<ID>')).toBe(
        text(r.pickForeignGroup[1]!).split(`g-${nowhere}`).join('<G>').split(nowhere).join('<ID>'),
      );
      expect(text(r.orgEdit[0]!)).toBe('edit_queued_message: not found in this project');
      expect(text(r.pickMixed)).toBe('pick_variant: not found in this project');
      expect(text(r.readMixed)).toBe('No such variant group in this project.');
      expect(text(r.deleteStray)).toBe('delete: not found in this project');
      expect(text(r.readStray)).toBe('No such task in this project.');
      // A's own members are untouched too: nothing was picked, archived or deleted.
      expect(w.a.store.getRun(w.a.ids.queued)?.queuedMessages?.map((m) => m.id)).toEqual([w.a.ids.message]);
      for (const id of [...w.a.ids.variants, h.legit, h.stray]) expect(w.a.store.getRun(id)?.archived ?? false).toBe(false);
      expect(seen.events.a).toEqual([]);
    });

    it('a B automation, and a B automation result, are refused through project_config and by the ownership check', async () => {
      const w = world();
      const audit: OwnershipAuditEntry[] = [];
      const nowhere = { automation: nowhereId(), receipt: nowhereId(), run: nowhereId() };
      const actions = (automationId: string, receiptId: string, runId: string): Array<Record<string, unknown>> => [
        { action: 'get_automation', automationId },
        { action: 'update_automation', automationId, automation: { name: 'taken over' } },
        { action: 'enable_automation', automationId },
        { action: 'pause_automation', automationId },
        { action: 'delete_automation', automationId },
        { action: 'get_automation_log', automationId },
        { action: 'retry_automation_receipt', receiptId },
        { action: 'remove_worktree', runId },
      ];
      const seen = await w.observe(async () => {
        const out: Array<{ b: McpToolResult; nowhere: McpToolResult }> = [];
        const bCalls = actions(w.b.ids.automation, w.b.ids.receipt, w.b.ids.done);
        const nCalls = actions(nowhere.automation, nowhere.receipt, nowhere.run);
        for (const [i, args] of bCalls.entries()) {
          out.push({ b: await w.call('a', 'project_config', args), nowhere: await w.call('a', 'project_config', nCalls[i]!) });
        }
        const scope = scopeA(w, audit);
        return {
          tool: out,
          receipt: [ownAutomationReceipt(scope, w.b.ids.receipt), ownAutomationReceipt(scope, nowhere.receipt)],
          automation: [ownAutomation(scope, w.b.ids.automation), ownAutomation(scope, nowhere.automation)],
          control: [ownAutomationReceipt(scope, w.a.ids.receipt).ok, ownAutomation(scope, w.a.ids.automation).ok],
          ownTool: await w.call('a', 'project_config', { action: 'get_automation', automationId: w.a.ids.automation }),
        };
      });
      const bIds = [w.b.ids.automation, w.b.ids.receipt, w.b.ids.done];
      judge(w, seen, ['responses', 'errors'], bIds);
      const unmask = (value: string, ids: string[]) => ids.reduce((acc, id) => acc.split(id).join('<ID>'), value);
      for (const [i, { b, nowhere: n }] of seen.response.tool.entries()) {
        expect(unmask(text(b), bIds), `project_config action ${i}`).toBe(unmask(text(n), Object.values(nowhere)));
      }
      // The control: A's own automation reads, so the refusals above are not a closed door.
      expect(seen.response.ownTool.isError, text(seen.response.ownTool)).toBeFalsy();
      expect(text(seen.response.ownTool)).toContain('ALPHA automation');
      const refused = { ok: false, code: 'not_found', message: 'not found in this project' };
      expect(seen.response.receipt).toEqual([refused, refused]);
      expect(seen.response.automation).toEqual([refused, refused]);
      expect(seen.response.control).toEqual([true, true]);
      expect(audit).toEqual([
        { check: 'automation-receipt', code: 'not_found' },
        { check: 'automation-receipt', code: 'not_found' },
        { check: 'automation', code: 'not_found' },
        { check: 'automation', code: 'not_found' },
      ]);
      expect(seen.events.a).toEqual([]);
    });

    it('the partial-success policy: a mixed A/B list proceeds for owned items only, reported by position', async () => {
      const w = world();
      const audit: OwnershipAuditEntry[] = [];
      const nowhere = nowhereId();
      const runs = [w.a.ids.done, w.b.ids.done, nowhere, w.a.ids.variants[0], w.a.ids.done, w.b.ids.queued];
      const adapter = new McpServiceAdapter({ projectId: PROJECT_A, service: w.service });
      const seen = await w.observe(async () => {
        const scope = scopeA(w, audit);
        const bulk = await partitionOwned(scope, 'run', runs, ownRun);
        // The caller acts only after every element was validated, and only on `allowed`.
        const acted = [];
        for (const { value } of bulk.allowed) acted.push(await adapter.pinRun(value.id));
        const messages = await partitionOwned(scope, 'queued-message', [w.a.ids.message, w.b.ids.message, nowhere], (s, id) =>
          ownQueuedMessage(s, w.a.ids.queued, id),
        );
        const receipts = await partitionOwned(scope, 'automation-receipt', [w.b.ids.receipt, w.a.ids.receipt], ownAutomationReceipt);
        const none = await partitionOwned(scope, 'run', [w.b.ids.done, nowhere], ownRun);
        const empty = await partitionOwned(scope, 'run', [], ownRun);
        const all = await partitionOwned(scope, 'run', [w.a.ids.done, w.a.ids.queued], ownRun);
        const view = (b: typeof bulk | typeof messages | typeof receipts) => ({
          outcome: b.outcome,
          allowed: b.allowed.map((a) => a.index),
          refused: b.refused,
        });
        return {
          runs: view(bulk),
          acted: acted.map((a) => ({ ok: a.ok, status: a.status, id: a.ok ? a.value.id : undefined, pinned: a.ok ? a.value.pinned : undefined })),
          messages: view(messages),
          receipts: view(receipts),
          none: view(none),
          empty: view(empty),
          all: view(all),
        };
      });
      judge(w, seen, ['responses', 'errors', 'events']);
      // The documented outcome (resource-ownership.ts, "Partial-success policy (A-03)"), exactly.
      expect(seen.response.runs).toEqual({
        outcome: 'partial',
        allowed: [0, 3],
        refused: [
          { index: 1, code: 'not_found' },
          { index: 2, code: 'not_found' },
          { index: 4, code: 'duplicate' },
          { index: 5, code: 'not_found' },
        ],
      });
      expect(seen.response.acted).toEqual([
        { ok: true, status: 200, id: w.a.ids.done, pinned: true },
        { ok: true, status: 200, id: w.a.ids.variants[0], pinned: true },
      ]);
      expect(seen.response.messages).toEqual({ outcome: 'partial', allowed: [0], refused: [{ index: 1, code: 'not_found' }, { index: 2, code: 'not_found' }] });
      expect(seen.response.receipts).toEqual({ outcome: 'partial', allowed: [1], refused: [{ index: 0, code: 'not_found' }] });
      expect(seen.response.none).toEqual({ outcome: 'none', allowed: [], refused: [{ index: 0, code: 'not_found' }, { index: 1, code: 'not_found' }] });
      expect(seen.response.empty).toEqual({ outcome: 'empty', allowed: [], refused: [] });
      expect(seen.response.all.outcome).toBe('all');
      // The refusal log carries positions and codes — never an id.
      expect(audit.filter((e) => e.check === 'run')).toEqual([
        { check: 'run', code: 'not_found', index: 1 },
        { check: 'run', code: 'not_found', index: 2 },
        { check: 'run', code: 'duplicate', index: 4 },
        { check: 'run', code: 'not_found', index: 5 },
        { check: 'run', code: 'not_found', index: 0 },
        { check: 'run', code: 'not_found', index: 1 },
      ]);
      // Exactly the two owned runs changed, each once, through A's own route.
      const changed = seen.events.a.filter((e) => e.kind === 'run').map((e) => (e.payload as { id: string }).id);
      expect(changed).toEqual([w.a.ids.done, w.a.ids.variants[0]]);
      expect(seen.dispatched).toEqual([
        `POST /api/v1/p/${PROJECT_A}/runs/${w.a.ids.done}/pin`,
        `POST /api/v1/p/${PROJECT_A}/runs/${w.a.ids.variants[0]}/pin`,
      ]);
    });
  });

  // ---- A-04: search, pagination, cursors, paths, workspace events -----------------------------

  describe('A-04 — every returned item belongs to A', () => {
    const world = withWorld({});

    it('search finds A only: a word only B holds finds nothing, a shared word finds only A', async () => {
      const w = world();
      const seen = await w.observe(async () => ({
        bravo: await w.call('a', 'task_read', { view: 'list', query: 'BRAVO', archived: 'include' }),
        bravoBranch: await w.call('a', 'task_read', { view: 'list', query: w.b.ids.done.slice(0, 8), archived: 'include' }),
        common: await w.call('a', 'task_read', { view: 'list', query: 'common', archived: 'include' }),
        queue: await w.call('a', 'organise_work', { action: 'list_queue' }),
      }));
      judge(w, seen, ['search', 'responses'], [w.b.ids.done.slice(0, 8)]);
      expect(payload(seen.response.bravo)).toMatchObject({ total: 0, tasks: [] });
      expect(payload(seen.response.bravoBranch)).toMatchObject({ total: 0, tasks: [] });
      expect((payload(seen.response.common).tasks as Array<{ id: string }>).map((t) => t.id).sort()).toEqual(
        [w.a.ids.done, w.a.ids.queued].sort(),
      );
      expect((payload(seen.response.queue).items as Array<{ id: string }>).map((t) => t.id)).toEqual([w.a.ids.queued, w.a.ids.queued2]);
    });

    it('pagination walks A only, one item per page, and no cursor names anything', async () => {
      const w = world();
      const walk = async (tool: string, args: Record<string, unknown>, cursorKey: 'cursor', nextKey: 'nextCursor' | 'next') => {
        const pages: Array<Record<string, any>> = [];
        let cursor: string | undefined;
        do {
          const page = payload(await w.call('a', tool, { ...args, ...(cursor ? { [cursorKey]: cursor } : {}) }));
          pages.push(page);
          cursor = page[nextKey] as string | undefined;
        } while (cursor && pages.length < 50);
        return pages;
      };
      const seen = await w.observe(async () => ({
        list: await walk('task_read', { view: 'list', limit: 1, archived: 'include' }, 'cursor', 'nextCursor'),
        history: await walk('task_read', { view: 'history', taskId: w.a.ids.done, limit: 1 }, 'cursor', 'nextCursor'),
        queue: await walk('organise_work', { action: 'list_queue', limit: 1 }, 'cursor', 'next'),
      }));
      judge(w, seen, ['pagination', 'responses']);
      const listed = seen.response.list.flatMap((p) => (p.tasks as Array<{ id: string }>).map((t) => t.id));
      expect(listed.sort()).toEqual(w.a.store.listRuns().map((r) => r.id).sort());
      expect(seen.response.list.every((p) => (p.tasks as unknown[]).length === 1)).toBe(true);
      const notes = seen.response.history.flatMap((p) => (p.events as Array<{ text?: string }>).map((e) => e.text));
      expect(notes).toEqual(['ALPHA history note 3', 'ALPHA history note 2', 'ALPHA history note 1']);
      expect(seen.response.queue.flatMap((p) => (p.items as Array<{ id: string }>).map((i) => i.id))).toEqual([w.a.ids.queued, w.a.ids.queued2]);
      // A cursor is opaque and sealed: decoded, it names neither project, nor any root.
      const cursors = [...seen.response.list, ...seen.response.history].map((p) => p.nextCursor as string | undefined).filter(Boolean);
      expect(cursors.length).toBeGreaterThan(2);
      for (const cursor of cursors) {
        const decoded = Buffer.from(cursor!, 'base64url').toString('utf8');
        expect(leaked(decoded, [...w.b.names, PROJECT_A, w.a.root])).toEqual([]);
      }
    });

    it('a cursor issued to B is refused by A exactly as a garbage cursor is', async () => {
      const w = world();
      // B's leader pages its own project first — outside the observed case, because B's door
      // legitimately records its own calls on B's audit trail.
      const b = {
        list: payload(await w.call('b', 'task_read', { view: 'list', limit: 1 })).nextCursor as string,
        history: payload(await w.call('b', 'task_read', { view: 'history', taskId: w.b.ids.done, limit: 1 })).nextCursor as string,
        queue: payload(await w.call('b', 'organise_work', { action: 'list_queue', limit: 1 })).next as string,
        journal: w.b.journal.headCursor(),
      };
      for (const cursor of [b.list, b.history, b.queue]) expect(cursor).toEqual(expect.any(String));
      const garbage = Buffer.from(JSON.stringify({ v: 1, c: 'x', t: 'AAAAAAAAAAAAAAAAAAAAAA' })).toString('base64url');
      const seen = await w.observe(async () => {
        let journal: unknown;
        try {
          journal = w.a.journal.read({ cursor: b.journal });
        } catch (err) {
          journal = err instanceof McpJournalCursorError ? err.rejection : String(err);
        }
        return {
          list: [await w.call('a', 'task_read', { view: 'list', cursor: b.list }), await w.call('a', 'task_read', { view: 'list', cursor: garbage })],
          history: [
            await w.call('a', 'task_read', { view: 'history', taskId: w.a.ids.done, cursor: b.history }),
            await w.call('a', 'task_read', { view: 'history', taskId: w.a.ids.done, cursor: garbage }),
          ],
          foreignTaskHistory: await w.call('a', 'task_read', { view: 'history', taskId: w.b.ids.done, cursor: b.history }),
          queue: [
            await w.call('a', 'organise_work', { action: 'list_queue', cursor: b.queue }),
            await w.call('a', 'organise_work', { action: 'list_queue', cursor: garbage }),
          ],
          journal,
        };
      });
      judge(w, seen, ['pagination', 'errors'], [w.b.ids.done]);
      const r = seen.response;
      for (const [foreign, junk] of [r.list, r.history, r.queue]) {
        expect(foreign!.isError).toBe(true);
        expect(text(foreign!)).toBe(text(junk!));
      }
      expect(text(r.list[0]!)).toMatch(/^Invalid cursor: it was not issued for this read/);
      expect(text(r.queue[0]!)).toBe('list_queue: invalid cursor — request the first page again');
      expect(text(r.foreignTaskHistory)).toMatch(/Invalid cursor|No such task/);
      expect(r.journal).toEqual({ error: 'cursor_project_mismatch', message: 'this cursor belongs to another project' });
    });

    it('no tool serves workspace events, and A’s event controller follows A’s journal only', async () => {
      const w = world();
      // The controller's own owner slot, apart from A's socket: the leader below holds A's real one
      // (#302), and two owners of A is exactly what that refuses. What is under test here is which
      // journal the controller follows; its ownership gate is pinned in event-controller.test.ts.
      const owner = new ProjectOwnership({ dataDir: join(w.home, 'controller-owner'), projectId: PROJECT_A, autoRenew: false });
      const acquired = await owner.acquire('ab-leader-session');
      expect(acquired.outcome).toBe('owner');
      const delivered: EventDispatch[] = [];
      const started = EventController.start({
        journal: w.a.journal,
        ownership: owner,
        sessionKey: 'ab-leader-session',
        adapter: { deliver: async (dispatch) => void delivered.push(dispatch) },
        heartbeatMs: 3_600_000,
      });
      expect(started.outcome).toBe('started');
      const controller = started.outcome === 'started' ? started.controller : undefined;
      try {
        // B keeps producing events while A's session is live. They are B's, and stay B's.
        for (let i = 0; i < 3; i += 1) {
          w.b.journal.append({ category: 'E-01', kind: 'task.terminal', subject: { type: 'run', id: w.b.ids.done, version: null }, origin: 'human', causedBy: null, summary: `BRAVO journal row live ${i}` });
        }
        const seen = await w.observe(async () => {
          const leader = await w.leader('a');
          const listed = (await leader.request('tools/list')).result as { tools: Array<{ name: string }> };
          const asked = [
            await leader.callTool('task_read', { view: 'events' }),
            await leader.callTool('task_read', { view: 'workspace' }),
            await leader.callTool('task_read', { view: 'list', scope: 'workspace' }),
          ];
          const unknown = await leader.request('tools/call', { name: 'workspace_events', arguments: {} });
          w.a.journal.append({ category: 'E-01', kind: 'task.terminal', subject: { type: 'run', id: w.a.ids.done, version: null }, origin: 'human', causedBy: null, summary: 'ALPHA journal row live' });
          for (let i = 0; i < 50 && delivered.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
          return { names: listed.tools.map((t) => t.name), asked, unknown };
        });
        judge(w, seen, ['events', 'errors']);
        // `leader_events` (#251) is the one event tool, and it is PROJECT-scoped: it reads the bound
        // project's own journal and refuses another project's cursor — proven against two composed
        // projects in `leader-feed.test.ts`. Anything else matching here would be a workspace feed.
        expect(seen.response.names.filter((n) => n !== 'leader_events' && /workspace|event|subscribe|stream/i.test(n))).toEqual([]);
        for (const answer of seen.response.asked) expect(text(answer)).toMatch(/^Invalid arguments for task_read/);
        expect(seen.response.unknown).toMatchObject({ error: { message: 'Unknown tool: workspace_events' } });
        expect(seen.dispatched.filter((d) => /workspace|\/events/.test(d))).toEqual([]);
        // The controller handed the leader A's row, and nothing of B's.
        const rows = delivered.flatMap((d) => d.events);
        expect(delivered.every((d) => d.projectId === PROJECT_A)).toBe(true);
        expect(rows.map((row) => row.summary)).toEqual(['ALPHA journal row live']);
        expect(leaked(JSON.stringify(delivered), w.b.names)).toEqual([]);
        expect(seen.journal.a.map((row) => row.summary)).toEqual(['ALPHA journal row live']);
      } finally {
        controller?.close();
        owner.dispose();
      }
    });
  });

  describe('A-04 — absolute, `..` and symlink paths', () => {
    const world = withWorld({ hostile: true });

    it('are refused before anything is read, and A’s own file still reads', async () => {
      const w = world();
      const h = w.hostile!;
      const audit: OwnershipAuditEntry[] = [];
      const paths = [
        join(w.b.worktree, 'notes.txt'),
        `../../../../${basename(w.b.root)}/.local/xezar/worktrees/${w.b.ids.done}/notes.txt`,
        `sub/../../${basename(w.b.root)}`,
        h.leakLink,
        `${h.rootLink}/README.md`,
        '.git/config',
        '.local/xezar/launch-key',
        'sub\\..\\..\\x',
      ];
      const seen = await w.observe(async () => {
        const scope = scopeA(w, audit);
        const refused = [];
        for (const path of paths) refused.push(await ownWorktreeFile(scope, w.a.ids.done, path));
        const linked = await ownWorktreeFile(scope, h.linked, 'notes.txt');
        const own = await ownWorktreeFile(scope, w.a.ids.done, 'notes.txt');
        const read = own.ok ? await readWorktreePath(own.value.directory, own.value.path) : own;
        // The same paths through the one tool that takes a path: read_results_evidence `files`.
        const viaTool = [];
        for (const path of paths) viaTool.push(await w.call('a', 'read_results_evidence', { read: 'files', runId: w.a.ids.done, path }));
        const linkedTool = await w.call('a', 'read_results_evidence', { read: 'files', runId: h.linked, path: 'notes.txt' });
        const ownTool = await w.call('a', 'read_results_evidence', { read: 'files', runId: w.a.ids.done, path: 'notes.txt' });
        return { refused, linked, read, viaTool, linkedTool, ownTool };
      });
      judge(w, seen, ['file paths', 'errors'], [w.b.worktree, basename(w.b.root), w.b.ids.done]);
      for (const answer of seen.response.refused) expect(answer).toMatchObject({ ok: false, code: 'forbidden_path' });
      expect(seen.response.linked).toEqual({ ok: false, code: 'not_found', message: 'not found in this project' });
      expect(seen.response.read).toMatchObject({ kind: 'file', content: `${w.a.fileContent}\n` });
      // The tool refuses every one of them, and still reads A's own file.
      for (const [i, answer] of seen.response.viaTool.entries()) {
        expect(answer.isError || /unavailable|not allowed|forbidden|not found/i.test(text(answer)), `path ${paths[i]}`).toBe(true);
        expect(text(answer)).not.toContain(w.b.fileContent);
      }
      expect(text(seen.response.linkedTool)).not.toContain(w.b.fileContent);
      expect(seen.response.linkedTool.isError || /unavailable|not found/i.test(text(seen.response.linkedTool))).toBe(true);
      expect(seen.response.ownTool.isError, text(seen.response.ownTool)).toBeFalsy();
      expect(text(seen.response.ownTool)).toContain(w.a.fileContent);
      // The direct checks' refusal log names the check and the code — never the path.
      expect(audit).toEqual([...paths.map(() => ({ check: 'file', code: 'forbidden_path' })), { check: 'worktree', code: 'not_found' }]);
    });

    // #240, found by this suite: the single-task view refused an A record whose worktree is B's,
    // but the list view did not filter it, so that record's `branch` — B's branch name — reached
    // the leader. A row is now held to the single read's rule: out of the rows, the total, the
    // search and every page, with pagination still walking every owned row to its end.
    it('the task list leaves out an A record that reaches into B, in its rows, total, search and pages', async () => {
      const w = world();
      const stray = w.hostile!.stray;
      const bBranch = w.a.store.getRun(stray)!.branch!;
      const ids = (result: McpToolResult) => (payload(result).tasks as Array<{ id: string }>).map((t) => t.id);
      const seen = await w.observe(async () => {
        const list = await w.call('a', 'task_read', { view: 'list', archived: 'include' });
        const search = await w.call('a', 'task_read', { view: 'list', archived: 'include', query: bBranch });
        const pages: McpToolResult[] = [];
        let cursor: string | undefined;
        do {
          pages.push(await w.call('a', 'task_read', { view: 'list', archived: 'include', limit: 1, ...(cursor ? { cursor } : {}) }));
          cursor = payload(pages.at(-1)!).nextCursor as string | undefined;
        } while (cursor !== undefined && pages.length < 100);
        return { list, search, pages };
      });
      // The search text is B's branch, typed by the leader itself, so its own request log carries it.
      // That echo is excused; the answers are held to "nothing of B" below and by the rest of judge.
      judge(w, seen, ['responses', 'search', 'pagination'], [bBranch]);
      const owned = w.a.store
        .listRuns()
        .map((r) => r.id)
        .filter((id) => id !== stray);
      const listed = ids(seen.response.list);
      expect(listed).not.toContain(stray);
      expect([...listed].sort()).toEqual([...owned].sort());
      expect(payload(seen.response.list).total).toBe(owned.length);
      expect(payload(seen.response.search)).toMatchObject({ total: 0, tasks: [] });
      // One row a page, never a short page: the walk sees every owned row once, and then ends.
      expect(seen.response.pages.map((page) => ids(page).length)).toEqual(owned.map(() => 1));
      expect(seen.response.pages.flatMap(ids)).toEqual(listed);
    });
  });

  // ---- A-12: connection configuration with a credential --------------------------------------

  describe('A-12 — no connection data or secret reaches chat, history, responses, logs or Git', () => {
    const world = withWorld({ connection: true });

    it('exercises startup, errors, tools, events and history, then finds the credential nowhere', async () => {
      const w = world();
      const c = w.connection!;
      // An agent that echoed the credential into A's transcript while `XEZ_REDACT_SECRETS=0` was set,
      // so the store wrote it raw: the history read is then the only scrub left, and must hold.
      const optOut = process.env.XEZ_REDACT_SECRETS;
      process.env.XEZ_REDACT_SECRETS = '0';
      try {
        w.a.store.appendEvent(w.a.ids.done, { type: 'note', text: `ALPHA used ${c.credential} to push` });
      } finally {
        if (optOut === undefined) delete process.env.XEZ_REDACT_SECRETS;
        else process.env.XEZ_REDACT_SECRETS = optOut;
      }
      expect(JSON.stringify(w.a.store.readEvents(w.a.ids.done))).toContain(c.credential);
      const seen = await w.observe(async () => {
        const leader = await w.leader('a');
        const startup = [await leader.request('tools/list'), await leader.callTool('health')];
        const errors = [
          await leader.request('tools/call', { name: 'no_such_tool', arguments: {} }),
          await leader.callTool('task_read', { view: 'nope' }),
          await leader.callTool('task_read', { view: 'task', taskId: w.b.ids.done }),
          await leader.callTool('task_read', { view: 'list', cursor: 'garbage-cursor' }),
          await w.frame('a', 'not json'),
          await w.frame('a', { v: 99, id: 1, method: 'health' }),
          await w.frame('a', { v: IPC_PROTOCOL_VERSION, id: 2, method: 'connection', params: { file: c.path } }),
        ];
        const reads = [];
        for (const view of ['list', 'inbox'] as const) reads.push(await leader.callTool('task_read', { view }));
        for (const view of ['task', 'history', 'context', 'handoff'] as const) reads.push(await leader.callTool('task_read', { view, taskId: w.a.ids.done }));
        reads.push(await leader.callTool('task_read', { view: 'group', groupId: w.a.ids.group }));
        const actions = [
          await leader.callTool('organise_work', { action: 'list_queue' }),
          await leader.callTool('organise_work', {
            action: 'set_title',
            runId: w.a.ids.done,
            title: 'ALPHA renamed',
            expectedVersion: await versionFrom(leader.callTool('task_read', { view: 'task', taskId: w.a.ids.done })),
          }),
          await leader.callTool('execution_control', {
            action: 'cancel_auto_resume',
            runId: w.a.ids.done,
            expectedVersion: await versionFrom(leader.callTool('task_read', { view: 'task', taskId: w.a.ids.done })),
          }),
          await leader.callTool('handoff_git', { action: 'repo' }),
          // A leader that echoes the credential back as its operation key: the trail must drop it.
          await leader.callTool('task_create', { action: 'start_from_inbox', operationId: c.credential, todoId: `todo-${nowhereId()}` }),
          await leader.callTool('task_create', { action: 'start_from_inbox', operationId: c.token, todoId: `todo-${nowhereId()}` }),
        ];
        w.a.journal.append({
          category: 'E-02',
          kind: 'task.attention',
          subject: { type: 'run', id: w.a.ids.done, version: null },
          origin: 'system',
          causedBy: null,
          summary: `ALPHA needs attention: ${c.credential} / ${c.token}`,
        });
        return { startup, errors, reads, actions };
      });
      // The leader itself sent both secrets as operation ids, and D-06 echoes an operation id back
      // in its answer. That echo is the one place they may appear — so it is pinned exactly: two
      // request frames, their two answers, and in each answer the secret only as `operationId`.
      const echoIds = seen.leaderLog
        .filter((line) => line.startsWith('leader→bridge') && (line.includes(c.credential) || line.includes(c.token)))
        .map((line) => (JSON.parse(line.slice(line.indexOf(' ') + 1)) as { id: number; params: { name: string } }));
      expect(echoIds.map((m) => m.params.name)).toEqual(['task_create', 'task_create']);
      const own = new Set(echoIds.map((m) => m.id));
      const isOwn = (line: string) => {
        const message = JSON.parse(line.slice(line.indexOf(' ') + 1)) as { id?: number };
        return typeof message.id === 'number' && own.has(message.id);
      };
      const echoes = seen.response.actions.slice(4);
      for (const [i, answer] of echoes.entries()) {
        const secret = i === 0 ? c.credential : c.token;
        const rest = JSON.stringify(answer).split(`\\"operationId\\":\\"${secret}\\"`).join('').split(`"operationId":"${secret}"`).join('');
        expect(rest).not.toContain(secret);
      }
      const scrubbed = {
        ...seen,
        response: { ...seen.response, actions: seen.response.actions.slice(0, 4) },
        leaderLog: seen.leaderLog.filter((line) => !(line.startsWith('leader→') || line.startsWith('bridge:')) || !isOwn(line)),
      };
      // The leader's own request for a B task id is its echo; the answer must not repeat it.
      const surface = judge(w, scrubbed, ['responses', 'errors', 'events'], [w.b.ids.done]);
      expect(seen.leaderLog.filter((line) => !line.startsWith('leader→') && !line.startsWith('client→')).join('\n')).not.toContain(
        w.b.ids.done,
      );
      // Populated-input guarantees: the case really produced output, and the secrets are really there.
      expect(own.size).toBe(2);
      expect(surface.length).toBeGreaterThan(5_000);
      expect(readFileSync(c.path, 'utf8')).toContain(c.credential);
      expect(statSync(c.path).mode & 0o777).toBe(0o600);
      const history = text(seen.response.reads[3]!);
      expect(history).toContain('ALPHA used [REDACTED] to push');

      // The journal and the audit trail, raw, on both sides.
      const trail = readFileSync(auditFile(w.a), 'utf8');
      expect(trail.trim().split('\n').length).toBeGreaterThanOrEqual(15);
      const journalRaw = readFileSync(w.a.journal.rowsPath, 'utf8');
      expect(journalRaw).toContain('ALPHA needs attention: [REDACTED] / [REDACTED]');
      for (const raw of [trail, journalRaw, readFileSync(auditFile(w.b), 'utf8'), readFileSync(w.b.journal.rowsPath, 'utf8')]) {
        expect(leaked(raw, [c.credential, c.token, w.a.root, 'mcp-connection'])).toEqual([]);
      }
      // #264: every mutating call carries the leader's own operation key, so the trail records one.
      // What it records is `<projectId>/<the client's opaque id>` and nothing else — the project half
      // comes from the trusted binding, and no credential, token or host path is in either half.
      const operationKeys = trail
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { operationKey?: string }).operationKey)
        .filter((operationKey): operationKey is string => operationKey !== undefined);
      expect(operationKeys.length).toBeGreaterThan(0);
      for (const operationKey of operationKeys) {
        expect(operationKey.startsWith(`${w.a.id}/`), operationKey).toBe(true);
        expect(leaked(operationKey, [c.credential, c.token, w.a.root, 'mcp-connection'])).toEqual([]);
      }

      // Git: the file is ignored, nothing stages it, and no history holds a secret.
      const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      expect(git(w.a.root, 'check-ignore', '.local/xezar/mcp-connection.json').trim()).toBe('.local/xezar/mcp-connection.json');
      for (const root of [w.a.root, w.b.root]) {
        const status = git(root, 'status', '--porcelain', '--untracked-files=all');
        const staged = git(root, 'add', '-A', '--dry-run');
        const history = git(root, 'log', '--all', '-p');
        expect(status).toBe('');
        expect(staged).toBe('');
        for (const out of [status, staged, history]) expect(leaked(out, [c.credential, c.token, 'mcp-connection'])).toEqual([]);
      }
    });
  });

  // ---- controls ------------------------------------------------------------------------------

  describe('controls — the world is not inert', () => {
    const world = withWorld({ hostile: true });

    it('without the MCP scope, the same app hands out B: `default`, the workspace index, a linked worktree', async () => {
      const w = world();
      const byDefault = await (await w.cockpit('/api/v1/p/default/runs')).text();
      const index = await (await w.cockpit('/api/v1/runs')).text();
      const linked = await readWorktreePath(worktreePathFor(w.a.root, w.hostile!.linked), 'notes.txt');
      expect(byDefault).toContain(w.b.ids.done);
      expect(index).toContain(w.b.ids.done);
      expect(linked).toMatchObject({ kind: 'file', content: `${w.b.fileContent}\n` });
      // And the B snapshot does move when B really changes, so "unchanged" is a real claim.
      const before = w.snapshot('b');
      w.b.store.setPinned(w.b.ids.done, true);
      expect(w.snapshot('b')).not.toBe(before);
      w.b.store.setPinned(w.b.ids.done, false);
      w.b.store.flush();
    });
  });

  // Last in the file, so it runs after every case above; a `-t` filter skips it with them.
  it('N-01: every case above together exercised responses, errors, events, pagination, search, file paths and side effects', () => {
    expect([...exercised].sort()).toEqual([...N01].sort());
  });
});
