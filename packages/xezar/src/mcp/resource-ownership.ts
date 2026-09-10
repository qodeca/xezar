import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import type { AutomationStore } from '../automations/store.ts';
import type { AutomationDefinition, AutomationReceipt } from '../automations/types.ts';
import { projectDataDir } from '../project-data-paths.ts';
import type { QueuedMessage, RunRecord, RunStore } from '../runs/store.ts';
import { loadWorkflows } from '../workflows/load.ts';
import type { WorkflowDef } from '../workflows/types.ts';

/**
 * Per-resource ownership validation for the MCP project leader (#88).
 *
 * F-02: every identifier a leader supplies — a task, a message nested inside a task, a variant
 * group and every run in it, a file path, a worktree, a workflow, an automation and its results,
 * a pagination cursor, and every element of a bulk list — is proved to belong to the BOUND
 * project before anything reads or changes it. A foreign identifier causes no read and no side
 * effect.
 *
 * How ownership is proved. Each project has its own `RunStore` and `AutomationStore`, opened on
 * its own `.local/xezar`, and the scope below holds exactly one project's pair. So "is this id
 * A's?" is answered by A's own services (N-02: no JSON or NDJSON is read here, and nothing is
 * written), and B's stores are simply not reachable from A's scope. Three things a store lookup
 * alone does NOT prove, and which this module checks explicitly:
 *
 *  - A record's FILESYSTEM reach. A run record carries an absolute `worktreePath`; the pick and
 *    reclaim flows delete that directory and the file and diff reads open it. The only path xezar
 *    ever creates for a run is `<root>/.local/xezar/worktrees/<runId>` (`worktreePathFor`,
 *    `createWorktree`), so a record naming anything else — another project's worktree, a moved
 *    root, a hand-edited index — is refused, and a worktree directory that is itself a symlink is
 *    refused too.
 *  - A manual automation check (`GET /automation-checks/:checkId`) lives in a WORKSPACE-level map
 *    that records no project (M-18). Its owner is stamped beside it with `stampOwner`; an
 *    unstamped check has no provable owner and is refused.
 *  - A cursor carries no project. MCP cursors are sealed with `sealCursor`, which binds them to
 *    the project AND the resource they page; any other cursor is refused.
 *
 * Refusals never name the resource (N-01). A foreign id and an id that does not exist anywhere
 * answer the same `not_found`, with one fixed message that never interpolates caller input — an
 * error that echoed an absolute path or an id would name the other project's resource back.
 * Every refusal is also reported to the optional `audit` sink, the leader-visible log, as
 * `{ check, code, index? }` only: the entry type has no field that could carry an identifier.
 *
 * Degradation is the caller's policy only for git/worktree HELPERS (AGENTS.md); an ownership
 * check never inherits one. Every check here fails CLOSED: anything that cannot be proved —
 * an unreadable directory, a missing owner stamp, a malformed id — is a refusal, never a pass.
 *
 * ## Partial-success policy (A-03)
 *
 * This is the documented outcome of a list that mixes this project's resources with foreign or
 * unknown ones. It is a deliverable, not an implementation detail; the tests assert it exactly.
 *
 * 1. **Caller-supplied id lists** (`partitionOwned`). Every element is validated before ANY side
 *    effect, and the caller acts only afterwards, and only on `allowed`.
 *    - Owned elements PROCEED — this is a partial success, not an all-or-nothing batch.
 *    - Refused elements are reported by their input POSITION (`index`) with a code. The id itself
 *      is never echoed, and a foreign id is indistinguishable from a nonexistent one.
 *    - `outcome` states the case: `all` (every element owned), `partial` (some owned, some
 *      refused), `none` (elements were supplied and every one was refused — the caller performs
 *      no side effect and reports a refusal) and `empty` (nothing was supplied — which must not
 *      read the same as "every element was refused").
 *    - A repeated element is acted on once: its later positions are refused with `duplicate`
 *      when the first was allowed, and with the first position's own code when it was refused.
 * 2. **A variant group is ONE resource, not a bulk list** (M-07). If any run in the group fails
 *    ownership, the whole group is refused — reading or picking a group means reading or
 *    changing every member, so a group with one foreign member is not this project's group.
 * 3. **Server-computed sweeps** (`ownSweep`: archive-finished, read-all, reclaim). The candidate
 *    set comes only from the bound project's own store, so no caller id is involved. Archive and
 *    read-all change only store records and are owned by construction. Reclaim DELETES worktree
 *    directories and its service cannot be told to skip one element, so every worktree-bearing
 *    record must be contained, or the whole sweep is refused before it starts.
 */

/** Why a resource was refused. Deliberately coarse: a finer code would be an existence oracle. */
export type OwnershipCode = 'not_found' | 'forbidden_path' | 'invalid_cursor' | 'duplicate';

/** Which check refused — the only other thing the leader-visible log learns about a refusal. */
export type OwnershipCheck =
  | 'run'
  | 'queued-message'
  | 'group'
  | 'group-member'
  | 'worktree'
  | 'file'
  | 'automation'
  | 'automation-receipt'
  | 'automation-check'
  | 'workflow'
  | 'cursor'
  | 'sweep';

/** One leader-visible log entry. No field can hold an identifier, a path or a name, by type. */
export interface OwnershipAuditEntry {
  check: OwnershipCheck;
  code: OwnershipCode;
  /** Position in a caller-supplied list, for bulk refusals only. */
  index?: number;
}

export interface OwnershipRefusal {
  ok: false;
  code: OwnershipCode;
  /** One fixed sentence per code. Never built from caller input or from a resource. */
  message: string;
}

export type Owned<T> = { ok: true; value: T } | OwnershipRefusal;

const MESSAGES: Record<OwnershipCode, string> = {
  not_found: 'not found in this project',
  forbidden_path:
    'path not allowed — use a relative path inside the task worktree, without "..", symlinks or .git',
  invalid_cursor: 'invalid cursor — request the first page again',
  duplicate: 'listed more than once — acted on once',
};

/**
 * The bound project, as far as ownership needs it. Built from the project's context
 * (`ProjectContext` in `server/project-context.ts` satisfies it structurally) — never from a
 * caller-supplied project id, which E-BIND forbids.
 */
export interface OwnershipProject {
  root: string;
  store: Pick<RunStore, 'getRun' | 'listRuns'>;
  automationStore: Pick<AutomationStore, 'get' | 'latestReceipts'>;
}

export interface OwnershipScope {
  /** Canonical (realpath'd) project root — the project's identity, free of the `default` alias. */
  readonly root: string;
  readonly store: OwnershipProject['store'];
  readonly automationStore: OwnershipProject['automationStore'];
  readonly audit: (entry: OwnershipAuditEntry) => void;
}

export function ownershipScope(
  project: OwnershipProject,
  audit?: (entry: OwnershipAuditEntry) => void,
): OwnershipScope {
  return {
    root: canonical(project.root),
    store: project.store,
    automationStore: project.automationStore,
    audit: audit ?? (() => {}),
  };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A root that cannot be resolved stays lexical; every containment check below then compares
    // realpaths against it and fails closed, which is the right answer for a vanished project.
    return resolve(path);
  }
}

function refuse(scope: OwnershipScope, check: OwnershipCheck, code: OwnershipCode, index?: number): OwnershipRefusal {
  try {
    scope.audit(index === undefined ? { check, code } : { check, code, index });
  } catch {
    // The log is the sink's problem; a throwing sink must not turn a refusal into a pass.
  }
  return { ok: false, code, message: MESSAGES[code] };
}

const MAX_ID_LENGTH = 256;

/** A caller-supplied id worth looking up at all. Anything else is simply not found. */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0');
}

/** A run id that is safe as ONE path segment — the precondition for deriving its worktree path. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The one worktree path xezar creates for a run of this project. */
function expectedWorktreePath(scope: OwnershipScope, runId: string): string | null {
  if (!SAFE_SEGMENT.test(runId) || runId.length > MAX_ID_LENGTH) return null;
  return join(projectDataDir(scope.root), 'worktrees', runId);
}

/** Lexical half of worktree containment: synchronous, touches no filesystem. */
function worktreePathIsOurs(scope: OwnershipScope, run: RunRecord): boolean {
  if (run.worktreePath === undefined) return true;
  const expected = expectedWorktreePath(scope, run.id);
  return expected !== null && resolve(run.worktreePath) === expected;
}

/**
 * Filesystem half: an EXISTING worktree directory must be a real directory at exactly the
 * expected path — not a symlink, and with no symlinked component between the root and it
 * (`realpath` would differ). An absent directory (reclaimed) has nothing to reach and passes.
 * Only `lstat`/`realpath` of this project's own paths run here: no content is read.
 */
async function worktreeDirIsOurs(scope: OwnershipScope, run: RunRecord): Promise<boolean> {
  if (!worktreePathIsOurs(scope, run)) return false;
  if (run.worktreePath === undefined) return true;
  const expected = resolve(run.worktreePath);
  let info;
  try {
    info = await lstat(expected);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  try {
    return (await realpath(expected)) === expected;
  } catch {
    return false;
  }
}

/**
 * A run of the bound project. Refused as `not_found` when the id is not in this project's store
 * OR when the record's worktree path is not this project's — such a record would name another
 * tree in every response and drive deletes into it.
 */
export function ownRun(scope: OwnershipScope, runId: unknown): Owned<RunRecord> {
  if (!isId(runId)) return refuse(scope, 'run', 'not_found');
  const run = scope.store.getRun(runId);
  if (!run || run.id !== runId || !worktreePathIsOurs(scope, run)) return refuse(scope, 'run', 'not_found');
  return { ok: true, value: run };
}

/** A queued message (#472), proved to sit in the stack of a run of this project. */
export function ownQueuedMessage(
  scope: OwnershipScope,
  runId: unknown,
  msgId: unknown,
): Owned<{ run: RunRecord; message: QueuedMessage }> {
  const run = ownRun(scope, runId);
  if (!run.ok) return run;
  const message = isId(msgId) ? (run.value.queuedMessages ?? []).find((m) => m.id === msgId) : undefined;
  if (!message) return refuse(scope, 'queued-message', 'not_found');
  return { ok: true, value: { run: run.value, message } };
}

/**
 * A variant group, with EVERY member proved to belong (M-07) — the same members, in the same
 * order, `groupRuns` in `server.ts` feeds the read and the pick.
 */
export async function ownGroup(
  scope: OwnershipScope,
  groupId: unknown,
): Promise<Owned<{ groupId: string; runs: RunRecord[] }>> {
  if (!isId(groupId)) return refuse(scope, 'group', 'not_found');
  const runs = scope.store
    .listRuns()
    .filter((r) => r.groupId === groupId)
    .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));
  if (runs.length === 0) return refuse(scope, 'group', 'not_found');
  for (const run of runs) {
    if (scope.store.getRun(run.id) !== run || !(await worktreeDirIsOurs(scope, run))) {
      return refuse(scope, 'group', 'not_found');
    }
  }
  return { ok: true, value: { groupId, runs } };
}

/** The pick's winner: the group is owned as a whole AND the named run is one of its members. */
export async function ownGroupMember(
  scope: OwnershipScope,
  groupId: unknown,
  runId: unknown,
): Promise<Owned<{ groupId: string; runs: RunRecord[]; run: RunRecord }>> {
  const group = await ownGroup(scope, groupId);
  if (!group.ok) return group;
  const run = isId(runId) ? group.value.runs.find((r) => r.id === runId) : undefined;
  if (!run) return refuse(scope, 'group-member', 'not_found');
  return { ok: true, value: { ...group.value, run } };
}

/** A run's existing worktree directory, proved to be this project's (delete one worktree, diffs). */
export async function ownWorktree(scope: OwnershipScope, runId: unknown): Promise<Owned<{ run: RunRecord; path: string }>> {
  const run = ownRun(scope, runId);
  if (!run.ok) return run;
  const path = run.value.worktreePath;
  if (path === undefined || !(await worktreeDirIsOurs(scope, run.value))) return refuse(scope, 'worktree', 'not_found');
  try {
    if (!(await lstat(path)).isDirectory()) return refuse(scope, 'worktree', 'not_found');
  } catch {
    return refuse(scope, 'worktree', 'not_found');
  }
  return { ok: true, value: { run: run.value, path: resolve(path) } };
}

/**
 * The directory a run's files are read from — its worktree, or the project root for a
 * `worktree: false` run — mirroring `workingDirectoryOf` in `server.ts`.
 */
export async function ownWorkingDirectory(
  scope: OwnershipScope,
  runId: unknown,
): Promise<Owned<{ run: RunRecord; directory: string }>> {
  const run = ownRun(scope, runId);
  if (!run.ok) return run;
  if (run.value.worktree === false) return { ok: true, value: { run: run.value, directory: scope.root } };
  const worktree = await ownWorktree(scope, runId);
  if (!worktree.ok) return worktree;
  return { ok: true, value: { run: run.value, directory: worktree.value.path } };
}

const MAX_PATH_LENGTH = 4_096;

/**
 * A path inside a run's working directory (A-04). Refused BEFORE any content is read when it is
 * absolute, contains a `..` segment, a backslash, a NUL or a `.git` segment, or when ANY
 * component on the way to it is a symlink — each component is `lstat`ed in order, so the walk
 * never follows a link into another tree. A missing component is `not_found`.
 *
 * This runs IN FRONT of `readWorktreePath`, never instead of it: that reader keeps its own
 * traversal, symlink, size-cap and `.git` checks, and the raw route keeps its image allowlist,
 * so the file surface is checked twice and weakened nowhere. The returned `path` is normalized
 * (`/`-separated, no empty or `.` segments) and is what the caller passes on.
 */
export async function ownWorktreeFile(
  scope: OwnershipScope,
  runId: unknown,
  relPath: unknown,
): Promise<Owned<{ run: RunRecord; directory: string; path: string }>> {
  const dir = await ownWorkingDirectory(scope, runId);
  if (!dir.ok) return dir;
  const raw = relPath ?? '';
  if (typeof raw !== 'string' || raw.length > MAX_PATH_LENGTH) return refuse(scope, 'file', 'forbidden_path');
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return refuse(scope, 'file', 'forbidden_path');
  }
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  // `.git` compared case-insensitively: on a case-insensitive filesystem `.GIT` IS `.git`.
  if (segments.some((s) => s === '..' || s.toLowerCase() === '.git')) return refuse(scope, 'file', 'forbidden_path');

  let current = dir.value.directory;
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR'
        ? refuse(scope, 'file', 'not_found')
        : refuse(scope, 'file', 'forbidden_path');
    }
    if (info.isSymbolicLink()) return refuse(scope, 'file', 'forbidden_path');
    if (i < segments.length - 1 && !info.isDirectory()) return refuse(scope, 'file', 'not_found');
  }
  // No component is a link, so the realpath can only differ through something else entirely
  // (a bind mount, a race): fail closed rather than reason about it.
  try {
    if ((await realpath(current)) !== current) return refuse(scope, 'file', 'forbidden_path');
  } catch {
    return refuse(scope, 'file', 'not_found');
  }
  return { ok: true, value: { run: dir.value.run, directory: dir.value.directory, path: segments.join('/') } };
}

/** An automation of this project. */
export function ownAutomation(scope: OwnershipScope, automationId: unknown): Owned<AutomationDefinition> {
  const automation = isId(automationId) ? scope.automationStore.get(automationId) : undefined;
  if (!automation || automation.id !== automationId) return refuse(scope, 'automation', 'not_found');
  return { ok: true, value: automation };
}

/**
 * An automation RESULT — a launch receipt (`POST /automation-log/:receiptId/retry`) — from this
 * project's own receipt journal, whose automation is still this project's.
 */
export function ownAutomationReceipt(scope: OwnershipScope, receiptId: unknown): Owned<AutomationReceipt> {
  if (!isId(receiptId)) return refuse(scope, 'automation-receipt', 'not_found');
  const receipt = [...scope.automationStore.latestReceipts().values()].find((row) => row.receiptId === receiptId);
  if (!receipt || scope.automationStore.get(receipt.automationId) === undefined) {
    return refuse(scope, 'automation-receipt', 'not_found');
  }
  return { ok: true, value: receipt };
}

/**
 * Owners of records that live OUTSIDE any project's store — today the manual automation checks,
 * which sit in one workspace-level map. Held beside the record rather than on it, so the record's
 * wire shape (`automationCheckSchema`) is unchanged and no project identity is ever serialized.
 * Weak, so an evicted check takes its owner with it.
 */
const owners = new WeakMap<object, string>();

/** Record which project created `record`. Called where the record is created. */
export function stampOwner(record: object, project: Pick<OwnershipProject, 'root'>): void {
  owners.set(record, canonical(project.root));
}

/**
 * A manual automation check (M-18: "checks and logs need a project owner even behind an
 * unscoped endpoint"). The check must carry this project's owner stamp AND name an automation
 * this project still has. An unstamped check has no provable owner and is refused.
 */
export function ownAutomationCheck<T extends { automationId: string }>(
  scope: OwnershipScope,
  checkId: unknown,
  checks: ReadonlyMap<string, T>,
): Owned<T> {
  const check = isId(checkId) ? checks.get(checkId) : undefined;
  if (!check || owners.get(check) !== scope.root || scope.automationStore.get(check.automationId) === undefined) {
    return refuse(scope, 'automation-check', 'not_found');
  }
  return { ok: true, value: check };
}

/** A workflow from this project's own catalog (built-ins plus `.xezar/workflows`), by name. */
export async function ownWorkflow(scope: OwnershipScope, name: unknown): Promise<Owned<WorkflowDef>> {
  if (!isId(name)) return refuse(scope, 'workflow', 'not_found');
  const { workflows } = await loadWorkflows(scope.root);
  const workflow = workflows.find((w) => w.name === name);
  if (!workflow) return refuse(scope, 'workflow', 'not_found');
  return { ok: true, value: workflow };
}

// ---- cursors ---------------------------------------------------------------

/** D-09 B-04: every MCP cursor is at most 2 048 bytes — `MAX_CURSOR_BYTES` in
 *  `runs/event-history.ts`, which that module does not export. */
export const MCP_CURSOR_MAX_BYTES = 2_048;

/**
 * Per-process key. Zero config: nothing to store or rotate. The cost is that a cursor does not
 * survive a service restart — it then answers `invalid_cursor`, and the leader re-reads the first
 * page, the same recovery an expired history cursor already asks for.
 */
const CURSOR_KEY = randomBytes(32);

const sealedCursorSchema = z.object({ v: z.literal(1), c: z.string(), t: z.string() }).strict();

function cursorTag(scope: OwnershipScope, resource: string, inner: string): Buffer {
  return createHmac('sha256', CURSOR_KEY).update(`${scope.root}\0${resource}\0${inner}`).digest().subarray(0, 16);
}

/**
 * Wrap a page cursor so it is valid only for this project AND this resource (`resource` is the
 * caller's own stable key, e.g. `run:<id>:history`). The project is bound through the tag, never
 * written into the cursor, so a cursor names nothing. Throws when the result would exceed
 * B-04 — a server-produced inner cursor that large is a bug, and B-03 forbids cutting it.
 */
export function sealCursor(scope: OwnershipScope, resource: string, inner: string): string {
  const cursor = Buffer.from(
    JSON.stringify({ v: 1, c: inner, t: cursorTag(scope, resource, inner).toString('base64url') }),
    'utf8',
  ).toString('base64url');
  if (cursor.length > MCP_CURSOR_MAX_BYTES) throw new RangeError(`sealed cursor exceeds ${MCP_CURSOR_MAX_BYTES} bytes`);
  return cursor;
}

/**
 * The inner cursor, when `cursor` was sealed for this project and this resource. A cursor from
 * another project, for another resource, tampered with, malformed or oversized is one answer:
 * `invalid_cursor`.
 */
export function openCursor(scope: OwnershipScope, resource: string, cursor: unknown): Owned<string> {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MCP_CURSOR_MAX_BYTES) {
    return refuse(scope, 'cursor', 'invalid_cursor');
  }
  let parsed;
  try {
    parsed = sealedCursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    return refuse(scope, 'cursor', 'invalid_cursor');
  }
  if (!parsed.success) return refuse(scope, 'cursor', 'invalid_cursor');
  const expected = cursorTag(scope, resource, parsed.data.c);
  const given = Buffer.from(parsed.data.t, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refuse(scope, 'cursor', 'invalid_cursor');
  }
  return { ok: true, value: parsed.data.c };
}

// ---- bulk ------------------------------------------------------------------

export interface BulkOwnership<T> {
  /** See "Partial-success policy" in the module comment. */
  outcome: 'all' | 'partial' | 'none' | 'empty';
  allowed: Array<{ index: number; value: T }>;
  refused: Array<{ index: number; code: OwnershipCode }>;
}

/**
 * Validate EVERY element of a caller-supplied list before any side effect, and partition it per
 * the documented policy. `own` is one of the single-resource checks above; its own refusal audit
 * is replaced by one entry per refused position, so the log carries the index and no id.
 */
export async function partitionOwned<T>(
  scope: OwnershipScope,
  check: OwnershipCheck,
  ids: readonly unknown[],
  own: (scope: OwnershipScope, id: unknown) => Owned<T> | Promise<Owned<T>>,
): Promise<BulkOwnership<T>> {
  const quiet: OwnershipScope = { ...scope, audit: () => {} };
  const allowed: BulkOwnership<T>['allowed'] = [];
  const refused: BulkOwnership<T>['refused'] = [];
  const firstSeen = new Map<unknown, { index: number; code?: OwnershipCode }>();
  for (const [index, id] of ids.entries()) {
    const seen = firstSeen.get(id);
    if (seen) {
      const code = seen.code ?? 'duplicate';
      refused.push({ index, code });
      refuse(scope, check, code, index);
      continue;
    }
    const result = await own(quiet, id);
    if (result.ok) {
      allowed.push({ index, value: result.value });
      firstSeen.set(id, { index });
    } else {
      refused.push({ index, code: result.code });
      firstSeen.set(id, { index, code: result.code });
      refuse(scope, check, result.code, index);
    }
  }
  const outcome =
    ids.length === 0 ? 'empty' : refused.length === 0 ? 'all' : allowed.length === 0 ? 'none' : 'partial';
  return { outcome, allowed, refused };
}

export type SweepKind = 'archive-finished' | 'read-all' | 'reclaim-worktrees';

/**
 * A server-computed sweep over the bound project's own store (policy point 3). Reclaim is refused
 * as a whole when any record's worktree cannot be proved this project's, because its service
 * deletes every candidate directory and cannot be told to skip one.
 */
export async function ownSweep(scope: OwnershipScope, kind: SweepKind): Promise<Owned<SweepKind>> {
  if (kind === 'reclaim-worktrees') {
    for (const run of scope.store.listRuns()) {
      if (run.worktreePath !== undefined && !(await worktreeDirIsOurs(scope, run))) {
        return refuse(scope, 'sweep', 'not_found');
      }
    }
  }
  return { ok: true, value: kind };
}
