/**
 * Durable operation-key idempotency for MCP mutations (issue #101).
 *
 * Implements decision D-06 (`docs/features/mcp-server/mcp-d06-versioning-idempotency-audit-decision.md`,
 * cited below as "D-06 § n"). Every mutating MCP tool carries a client-generated `operationId`; this
 * store keys a receipt on `<projectId>/<operationId>`, verifies the stored action AND payload digest
 * on every retry, and answers each call with exactly one of the § 6 results:
 *
 *   miss                                → execute: `intent` line, effect, `settled` line
 *   settled, same action + digest       → replay the stored outcome; no effect
 *   intent, live in this process        → `in-progress`; no effect
 *   intent, not live (a crash happened) → reconcile; `unverified` unless a read settles it; no effect
 *   different action or digest          → `operation_key_conflict`; no effect, no stored result
 *
 * Three traps this module exists to avoid, all named by the requirements:
 * - deduplicating by TEXT: the digest is taken over the zod-PARSED payload, canonicalised
 *   (`payloadDigest`), never over raw JSON-RPC params or a prompt string;
 * - trusting the JSON-RPC request id: it never reaches this module — identity is the
 *   application-level `operationId`, which survives reconnects and restarts;
 * - repeating blindly after a crash: the `intent` line is appended SYNCHRONOUSLY before the
 *   effect, so a crash between effect and receipt leaves a dangling intent that reads as
 *   `unverified` — the effect is never run a second time for that key.
 *
 * Storage is two files in the project's data directory, both deletable state: deleting them
 * discards idempotency history and nothing else, and xezar keeps working. They are written, never
 * required. Nothing here runs at boot unless a caller opens the store, and opening never throws.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  UNVERIFIED_GUIDANCE,
  operationIdSchema,
  operationOutcomeSchema,
  operationReasonSchema,
  operationResultRefSchema,
  reconcilePredicateSchema,
  type OperationAnswer,
  type OperationResultRef,
  type ReconcileKind,
  type ReconcilePredicate,
} from '@qodeca/xezar-contract';
import { atomicTmpPath } from '../workspace/config.ts';
import { AUTO_RESUME_MISSED_WINDOW_MS, MAX_AUTO_RESUMES } from '../workflows/run.ts';

/** The append-only journal: one line per phase transition. The durable record (D-06 § 7.2). */
export const RECEIPT_JOURNAL_FILE = 'mcp-operations.ndjson';
/** The compacted snapshot: a load-time shortcut, never the source of truth (D-06 § 7.2). */
export const RECEIPT_SNAPSHOT_FILE = 'mcp-operations.json';

/**
 * The provider usage window each automatic resume waits out. Read from `run.ts`'s own comments
 * ("a couple of days of five-hour windows"), not from a provider contract — D-06 § 8.2 records
 * that limit. If it moves, the retention floor below moves with it.
 */
const PROVIDER_WINDOW_MS = 5 * 60 * 60_000;

/**
 * Receipt age floor: 12 resumes × 5 h + the 24 h missed-deadline tolerance = 84 h (D-06 § 8.2) —
 * the longest span over which the engine itself may still resurrect a run one MCP mutation
 * started. Derived from the live constants, so the derivation IS the decision.
 */
export const RECEIPT_MAX_AGE_MS = MAX_AUTO_RESUMES * PROVIDER_WINDOW_MS + AUTO_RESUME_MISSED_WINDOW_MS;
/** Receipt count floor per project: a measured 40.6 ms cold scan against a 300 ms budget (D-06 § 8.3). */
export const RECEIPT_MAX_KEPT = 50_000;
/** Snapshot cadence: a 1 000-line journal scans in 0.7 ms, so compacting sooner does not pay (D-06 § 7.2). */
export const RECEIPT_SNAPSHOT_EVERY_LINES = 1_000;

/**
 * The UUIDv5 namespace MCP-created run ids are derived in (D-06 § 12.1). A constant, never
 * regenerated: changing it would make every recorded prediction point at an id nobody creates.
 */
export const XEZAR_MCP_NAMESPACE = 'a3c1e7d2-5b4f-4e8a-9c61-2f0d8b7e4a15';

/**
 * One persisted receipt line (D-06 § 7.1). Every line is self-contained — the `settled` line
 * repeats the identity fields — so the load-time fold is "latest line per key wins".
 *
 * `.passthrough()` so a key a NEWER xezar wrote survives this version's compaction rewrite: an
 * optional field that is stripped on load is erased on the next save, which is the trap D-06
 * § 13.3 records against `runRecordSchema`. An unknown `v` fails the literal and the line is
 * quarantined rather than guessed at — quarantine is the safe direction (§ 7.4).
 */
const receiptSchema = z
  .object({
    v: z.literal(1),
    key: z.string().min(1),
    action: z.string().min(1),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
    phase: z.enum(['intent', 'settled']),
    outcome: operationOutcomeSchema.optional(),
    resultRef: operationResultRefSchema.optional(),
    errorCode: operationReasonSchema.optional(),
    expectedVersion: z.string().optional(),
    origin: z.literal('mcp'),
    /** The D-02 session fencing token the mutation arrived under. Recorded, not interpreted here. */
    ownerGeneration: z.string().optional(),
    reconcile: reconcilePredicateSchema.optional(),
    startedAt: z.string().min(1),
    settledAt: z.string().optional(),
  })
  .passthrough()
  .refine((r) => (r.phase === 'settled') === (r.outcome !== undefined), {
    message: 'a settled receipt carries an outcome and an intent never does',
  });
type Receipt = z.infer<typeof receiptSchema>;

/** First line of a compacted journal. Its generation is what binds a snapshot to one journal. */
const headerSchema = z.object({ v: z.literal(1), journal: z.object({ generation: z.string().min(1) }) });
/** Carries a quarantine count across a compaction rewrite until the age floor has passed. */
const damageSchema = z.object({
  v: z.literal(1),
  damage: z.object({ lines: z.number().int().positive(), detectedAt: z.string().min(1) }),
});
const snapshotSchema = z.object({
  v: z.literal(1),
  generation: z.string().min(1),
  /** Journal byte offset this snapshot covers; the scan resumes from here (D-06 § 7.4). */
  offset: z.number().int().nonnegative(),
  receipts: z.array(receiptSchema),
  damage: damageSchema.shape.damage.optional(),
});

/** What an effect reports. A refusal the service makes after the intent is `rejected`. */
export type EffectOutcome =
  | { outcome: 'ok'; resultRef: OperationResultRef }
  | { outcome: 'rejected' | 'not-applied'; errorCode: string };

/** A reconciler's verdict — the answer to "did this effect happen?", from a READ (D-06 § 9.3). */
export type ReconcileVerdict =
  | { verdict: 'ok'; resultRef: OperationResultRef }
  | { verdict: 'not-applied' }
  | { verdict: 'unverified'; reason: string };

/**
 * Answers one question with an idempotent read, never a write — a reconciler that mutates to find
 * out is the blind repeat this module exists to prevent (D-06 § 9.3 rule 2). `not-applied` needs a
 * POSITIVE answer; silence, a timeout, a network error or a missing tool are `unverified` (rule 3).
 */
export type Reconciler = (
  predicate: ReconcilePredicate,
  context: { action: string; startedAt: string },
) => ReconcileVerdict | Promise<ReconcileVerdict>;

export interface OperationRequest {
  /** From the trusted connection binding — NEVER from a tool argument (D-06 § 5.2). */
  projectId: string;
  /** The client-generated operation id, as supplied. */
  operationId: string;
  /** The action id, e.g. `runs.create`. */
  action: string;
  /** The payload AFTER the action's zod schema parsed it — never raw params (D-06 § 5.4). */
  payload: unknown;
  /** Top-level keys the digest ignores. Ships empty; every addition needs a recorded reason. */
  digestExclude?: readonly string[];
  expectedVersion?: string;
  ownerGeneration?: string;
  /** The read that can later settle a dangling intent, fixed BEFORE the effect (D-06 § 9.3). */
  reconcile: ReconcilePredicate;
  /**
   * D-06 § 7.3 step 2 — the version/permission check, run synchronously in the same critical
   * section as the intent write. Return an error code to refuse; the refusal writes one `settled`
   * `rejected` line and no intent, so a retry returns the same rejection.
   */
  precheck?: () => string | undefined;
  /** D-06 § 7.3 step 4. Throwing is treated as "may have happened" and reconciled, never repeated. */
  effect: () => EffectOutcome | Promise<EffectOutcome>;
}

export interface OperationReceiptStoreOptions {
  /** Clock, for tests. */
  now?: () => number;
  /** One reconciler per predicate kind. A kind with no reconciler reads as `unverified`. */
  reconcilers?: Partial<Record<ReconcileKind, Reconciler>>;
  /**
   * The structural floor (D-06 § 8.4): a receipt is never evicted while the resource its
   * `resultRef` names still exists. Absent = no resource is known live.
   */
  isResultLive?: (ref: OperationResultRef) => boolean;
  /** Bounds, for tests only — production uses the D-06 numbers above. */
  maxAgeMs?: number;
  maxKept?: number;
  snapshotEveryLines?: number;
}

/** `<projectId>/<operationId>` (D-06 § 5.2). The id alphabet has no `/`, so the split is unambiguous. */
export function operationKey(projectId: string, operationId: string): string {
  return `${projectId}/${operationId}`;
}

function projectOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf('/'));
}

/** RFC 4122 § 4.3 name-based UUID, SHA-1 variant. */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (ns.length !== 16) throw new TypeError(`not a UUID namespace: ${namespace}`);
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The run id an MCP `runs.create` must create, derived from the operation key before the effect
 * (D-06 § 12.1). A retry predicts the same id; two operations cannot share one. Reconciliation is
 * then a primary-key lookup and no new field is persisted on the run record.
 */
export function predictRunId(projectId: string, operationId: string): string {
  return uuidV5(operationKey(projectId, operationId), XEZAR_MCP_NAMESPACE);
}

/**
 * `sha256(canonical(payload))`, lowercase hex (D-06 § 5.4). The payload must already be the
 * action's zod-parsed value. Canonical form: object keys sorted by UTF-16 code unit at every level,
 * arrays in order, no whitespace, `undefined` object keys dropped, and every binary blob replaced
 * by `{ bytes, sha256 }` so the digest covers the BYTES, never a path. Non-finite numbers and
 * values JSON cannot carry are refused rather than silently coerced.
 */
export function payloadDigest(payload: unknown, digestExclude: readonly string[] = []): string {
  let value = payload;
  if (digestExclude.length > 0 && isPlainObject(payload)) {
    value = Object.fromEntries(Object.entries(payload).filter(([key]) => !digestExclude.includes(key)));
  }
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('payload digest: non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`payload digest: unsupported ${typeof value}`);
  }
  if (value instanceof Uint8Array) {
    return canonicalJson({ bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') });
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('payload digest: unsupported object type');
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * `run-by-key` (D-06 § 9.3): the store write IS the effect, so a run under the predicted id means
 * `ok` and its absence means `not-applied` — but only while the index can still answer. The run
 * store evicts by COUNT, so a busy project may already have pruned the very run an old intent
 * names; "not there" and "the store can no longer tell" must not share a branch.
 *
 * The index can answer only if the intent is no older than the oldest run each retention pool
 * still holds (archived and live runs are pruned separately, so the newest of the two pool-oldest
 * dates is the conservative bound). An empty index cannot answer at all — it may be a deleted or
 * corrupt `runs.json` — so it is `unverified` too. Both errors fall on the safe side: a spurious
 * "check this" is recoverable, a duplicated task is not.
 */
export function runByKeyReconciler(store: {
  getRun(id: string): { id: string } | undefined;
  listRuns(): Array<{ createdAt: string; archived?: boolean }>;
}): Reconciler {
  return (predicate, context) => {
    if (predicate.kind !== 'run-by-key') return { verdict: 'unverified', reason: 'wrong predicate' };
    const found = store.getRun(predicate.predictedRunId);
    if (found) return { verdict: 'ok', resultRef: { kind: 'run', id: found.id } };
    let bound: string | undefined;
    for (const archived of [false, true]) {
      let oldest: string | undefined;
      for (const run of store.listRuns()) {
        if ((run.archived ?? false) !== archived) continue;
        if (oldest === undefined || run.createdAt < oldest) oldest = run.createdAt;
      }
      if (oldest !== undefined && (bound === undefined || oldest > bound)) bound = oldest;
    }
    if (bound === undefined || context.startedAt < bound) {
      return { verdict: 'unverified', reason: 'run index pruned' };
    }
    return { verdict: 'not-applied' };
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A reason the wire may carry. Anything else — a raw error body above all — becomes a fixed code. */
function safeReason(reason: string, fallback: string): string {
  return operationReasonSchema.safeParse(reason).success ? reason : fallback;
}

/**
 * The per-project receipt store. One instance per project data directory, owned by the process
 * `ownProjectData` admits as that project's writer — which is why no cross-process lock is needed
 * around the check-then-write (D-06 § 4.5).
 */
export class OperationReceiptStore {
  private readonly receipts = new Map<string, Receipt>();
  /** Keys whose effect (or reconciliation) is running in THIS process right now. */
  private readonly live = new Map<string, string>();
  private readonly warned = new Set<string>();
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly maxKept: number;
  private readonly snapshotEveryLines: number;
  /** Lines appended (or scanned past the snapshot) since the last compaction. */
  private linesSinceCompaction = 0;
  /** Journal lines that failed to parse. While > 0, a key miss reconciles before executing (§ 7.4). */
  private quarantined = 0;
  private damageDetectedAt: string | undefined;
  /** Whether the journal already exists with content; a fresh journal starts with a header line. */
  private journalStarted = false;
  /** The journal ends in a torn line: the next append must start on a fresh line, or the torn
   *  fragment would swallow a good receipt into the quarantine with it. */
  private needsNewline = false;

  private constructor(
    readonly dataDir: string,
    private readonly opts: OperationReceiptStoreOptions,
  ) {
    this.journalPath = join(dataDir, RECEIPT_JOURNAL_FILE);
    this.snapshotPath = join(dataDir, RECEIPT_SNAPSHOT_FILE);
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? RECEIPT_MAX_AGE_MS;
    this.maxKept = opts.maxKept ?? RECEIPT_MAX_KEPT;
    this.snapshotEveryLines = opts.snapshotEveryLines ?? RECEIPT_SNAPSHOT_EVERY_LINES;
  }

  /**
   * Open (or create on first write) the receipts for one project data directory. Never throws:
   * absent files are an empty store, an unreadable snapshot is ignored, and unreadable journal
   * lines are quarantined one by one — a torn final line costs exactly that one receipt (§ 7.4).
   */
  static open(dataDir: string, opts: OperationReceiptStoreOptions = {}): OperationReceiptStore {
    const store = new OperationReceiptStore(dataDir, opts);
    store.load();
    return store;
  }

  /** Counts for diagnostics and tests. */
  stats(): { receipts: number; quarantined: number; live: number } {
    return { receipts: this.receipts.size, quarantined: this.quarantined, live: this.live.size };
  }

  /**
   * Run one mutation under its operation key, answering with exactly one § 6 result.
   *
   * Everything up to the intent append is synchronous, so two calls with one key cannot both pass
   * the lookup: the second sees the first as live and answers `in-progress`.
   */
  async execute(request: OperationRequest): Promise<OperationAnswer> {
    const operationId = operationIdSchema.parse(request.operationId);
    if (request.projectId.length === 0) throw new TypeError('operation receipts: empty projectId');
    const key = operationKey(request.projectId, operationId);
    const digest = payloadDigest(request.payload, request.digestExclude);
    const reconcile = reconcilePredicateSchema.parse(request.reconcile);

    const stored = this.receipts.get(key);
    if (stored) {
      if (stored.action !== request.action || stored.payloadDigest !== digest) {
        return {
          error: 'operation_key_conflict',
          operationId,
          storedAction: stored.action,
          storedAt: stored.startedAt,
          mismatch: stored.action !== request.action ? 'action' : 'payload',
        };
      }
      if (stored.phase === 'settled') return this.settledAnswer(stored, operationId, true);
      const startedAt = this.live.get(key);
      if (startedAt !== undefined) {
        return { status: 'in-progress', operationId, action: stored.action, startedAt: stored.startedAt };
      }
      // A dangling intent with nothing live: the only way here is a crash between the effect and
      // its receipt. Reconcile on demand; never run the effect again (§ 6, § 9).
      return this.reconcileDangling(key, stored, operationId);
    }

    if (this.live.has(key)) {
      // A reconciliation for this key is already in flight (damaged-journal miss below).
      return { status: 'in-progress', operationId, action: request.action, startedAt: this.live.get(key)! };
    }

    const startedAt = new Date(this.now()).toISOString();
    if (this.quarantined > 0) {
      // A quarantined line may have been this very key's intent, and a miss must not become a
      // licence to execute an operation that already happened (§ 7.4). Ask the reconciler first.
      this.live.set(key, startedAt);
      let verdict: ReconcileVerdict;
      try {
        verdict = await this.runReconciler(reconcile, { action: request.action, startedAt });
      } finally {
        this.live.delete(key);
      }
      if (verdict.verdict === 'ok') {
        // It had happened: settle it as it would have been settled, and replay.
        const receipt = this.settledReceipt(key, request, digest, startedAt, {
          outcome: 'ok',
          resultRef: verdict.resultRef,
        });
        this.appendBestEffort(receipt);
        return this.settledAnswer(receipt, operationId, true);
      }
      if (verdict.verdict === 'unverified') {
        return this.unverifiedAnswer(operationId, request.action, startedAt, reconcile.kind, {
          attemptedAt: new Date(this.now()).toISOString(),
          reason: 'journal_damaged',
        });
      }
      // `not-applied`: the reconciler positively established no earlier effect, so executing now
      // cannot duplicate anything. Fall through to a normal first attempt.
    }

    // § 7.3 step 2: the version/permission check, before any intent.
    const refusal = request.precheck?.();
    if (refusal !== undefined) {
      const receipt = this.settledReceipt(key, request, digest, startedAt, {
        outcome: 'rejected',
        errorCode: safeReason(refusal, 'rejected'),
      });
      this.appendBestEffort(receipt);
      return this.settledAnswer(receipt, operationId, false);
    }

    // § 7.3 step 3: the intent, synchronously, BEFORE the effect. If it cannot be written the
    // operation cannot be made idempotent, so it is refused rather than run (§ 7.5).
    const intent: Receipt = {
      v: 1,
      key,
      action: request.action,
      payloadDigest: digest,
      phase: 'intent',
      ...(request.expectedVersion !== undefined ? { expectedVersion: request.expectedVersion } : {}),
      origin: 'mcp',
      ...(request.ownerGeneration !== undefined ? { ownerGeneration: request.ownerGeneration } : {}),
      reconcile,
      startedAt,
    };
    try {
      this.append(intent);
    } catch (err) {
      this.warnOnce('journal', `[xez] MCP operation journal unwritable (${errorMessage(err)}) — mutations are refused until it is writable`);
      return { error: 'operation_receipt_unavailable', operationId, reason: 'journal_unwritable' };
    }
    this.receipts.set(key, intent);
    this.live.set(key, startedAt);

    // § 7.3 step 4: the effect.
    let result: EffectOutcome;
    try {
      result = await request.effect();
    } catch {
      // The effect may or may not have happened before it threw. That is exactly the dangling
      // intent case, so it gets the same answer: reconcile, never repeat.
      this.live.delete(key);
      return this.reconcileDangling(key, intent, operationId);
    }
    this.live.delete(key);

    // § 7.3 step 5: the settled line.
    const settled = this.settledReceipt(
      key,
      request,
      digest,
      startedAt,
      result.outcome === 'ok'
        ? { outcome: 'ok', resultRef: operationResultRefSchema.parse(result.resultRef) }
        : { outcome: result.outcome, errorCode: safeReason(result.errorCode, result.outcome) },
    );
    // The effect already happened, so a failed receipt write must not turn success into an error.
    // Held in memory, this process still replays it; after a restart the dangling intent reads as
    // `unverified` and is reconciled — the documented cost of a journal that stopped accepting writes.
    this.appendBestEffort(settled);
    this.maybeCompact();
    return this.settledAnswer(settled, operationId, false);
  }

  /**
   * Reconcile every dangling intent once, in the background (D-06 § 9.3 rule 1). Callers start it
   * after project open and never await it: a `gh`-less or offline machine keeps working, and until
   * a receipt's reconciliation finishes it truthfully reads `unverified`.
   */
  async reconcilePending(): Promise<void> {
    for (const [key, receipt] of [...this.receipts]) {
      if (receipt.phase !== 'intent' || this.live.has(key)) continue;
      const operationId = key.slice(key.lastIndexOf('/') + 1);
      await this.reconcileDangling(key, receipt, operationId);
    }
  }

  /** Clean shutdown: compact, so the next open reads a snapshot instead of the whole journal. */
  close(): void {
    if (this.linesSinceCompaction > 0 || this.quarantined > 0) this.compact();
  }

  private async reconcileDangling(key: string, intent: Receipt, operationId: string): Promise<OperationAnswer> {
    const predicate = intent.reconcile ?? { kind: 'none' as const };
    this.live.set(key, intent.startedAt);
    let verdict: ReconcileVerdict;
    try {
      verdict = await this.runReconciler(predicate, { action: intent.action, startedAt: intent.startedAt });
    } finally {
      this.live.delete(key);
    }
    const attemptedAt = new Date(this.now()).toISOString();
    if (verdict.verdict === 'unverified') {
      // Stays unverified on disk — the intent line is left as it is and never decays with age. Every
      // retry reconciles again and returns the evidence of that attempt (§ 9.3 rule 4).
      return this.unverifiedAnswer(operationId, intent.action, intent.startedAt, predicate.kind, {
        attemptedAt,
        reason: verdict.reason,
      });
    }
    // A read established the outcome with certainty: settle it, so every later retry replays it.
    const current = this.receipts.get(key);
    if (current && current.phase === 'settled') return this.settledAnswer(current, operationId, true);
    const settled: Receipt = {
      ...intent,
      phase: 'settled',
      ...(verdict.verdict === 'ok'
        ? { outcome: 'ok' as const, resultRef: verdict.resultRef }
        : { outcome: 'not-applied' as const, errorCode: 'reconciled not applied' }),
      settledAt: attemptedAt,
    };
    delete settled.reconcile;
    this.appendBestEffort(settled);
    return this.settledAnswer(settled, operationId, true);
  }

  private async runReconciler(
    predicate: ReconcilePredicate,
    context: { action: string; startedAt: string },
  ): Promise<ReconcileVerdict> {
    const reconciler = this.opts.reconcilers?.[predicate.kind];
    if (!reconciler) return { verdict: 'unverified', reason: 'no reconciler' };
    try {
      const verdict = await reconciler(predicate, context);
      if (verdict.verdict === 'unverified') {
        return { verdict: 'unverified', reason: safeReason(verdict.reason, 'reconciler_failed') };
      }
      if (verdict.verdict === 'ok') {
        const ref = operationResultRefSchema.safeParse(verdict.resultRef);
        return ref.success ? { verdict: 'ok', resultRef: ref.data } : { verdict: 'unverified', reason: 'reconciler_failed' };
      }
      return verdict.verdict === 'not-applied' ? verdict : { verdict: 'unverified', reason: 'reconciler_failed' };
    } catch {
      // A thrown reconciler is a reconciler that could not ask — `unverified`, never `not-applied`.
      return { verdict: 'unverified', reason: 'reconciler_failed' };
    }
  }

  private settledReceipt(
    key: string,
    request: OperationRequest,
    digest: string,
    startedAt: string,
    result: { outcome: 'ok'; resultRef: OperationResultRef } | { outcome: 'rejected' | 'not-applied'; errorCode: string },
  ): Receipt {
    return {
      v: 1,
      key,
      action: request.action,
      payloadDigest: digest,
      phase: 'settled',
      ...result,
      ...(request.expectedVersion !== undefined ? { expectedVersion: request.expectedVersion } : {}),
      origin: 'mcp',
      ...(request.ownerGeneration !== undefined ? { ownerGeneration: request.ownerGeneration } : {}),
      startedAt,
      settledAt: new Date(this.now()).toISOString(),
    };
  }

  private settledAnswer(receipt: Receipt, operationId: string, replayed: boolean): OperationAnswer {
    if (receipt.outcome === 'unverified') {
      return this.unverifiedAnswer(operationId, receipt.action, receipt.startedAt, 'none', {
        reason: receipt.errorCode ?? 'unverified',
      });
    }
    return {
      status: receipt.outcome ?? 'rejected',
      operationId,
      action: receipt.action,
      replayed,
      ...(receipt.resultRef ? { resultRef: receipt.resultRef } : {}),
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    };
  }

  private unverifiedAnswer(
    operationId: string,
    action: string,
    startedAt: string,
    kind: ReconcileKind,
    evidence: { attemptedAt?: string; reason: string },
  ): OperationAnswer {
    return {
      status: 'unverified',
      operationId,
      action,
      startedAt,
      reconcile: {
        kind,
        ...(evidence.attemptedAt !== undefined ? { attemptedAt: evidence.attemptedAt } : {}),
        reason: evidence.reason,
      },
      guidance: UNVERIFIED_GUIDANCE,
    };
  }

  // ---- persistence -------------------------------------------------------------------------------

  /** Synchronous append — survives a process crash the instant it returns (D-06 § 3.3). Throws. */
  private append(receipt: Receipt): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const lead = this.needsNewline ? '\n' : '';
    const header = this.journalStarted ? '' : `${JSON.stringify({ v: 1, journal: { generation: randomUUID() } })}\n`;
    appendFileSync(this.journalPath, `${lead}${header}${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.journalStarted = true;
    this.needsNewline = false;
    this.linesSinceCompaction += 1;
  }

  /** Append where a failed write must not change the answer; the in-memory receipt still replays. */
  private appendBestEffort(receipt: Receipt): void {
    this.receipts.set(receipt.key, receipt);
    try {
      this.append(receipt);
    } catch (err) {
      this.warnOnce('journal', `[xez] MCP operation journal unwritable (${errorMessage(err)})`);
    }
  }

  private maybeCompact(): void {
    if (this.linesSinceCompaction >= this.snapshotEveryLines) this.compact();
  }

  private load(): void {
    let journal: Buffer | undefined;
    if (existsSync(this.journalPath)) {
      try {
        journal = readFileSync(this.journalPath);
      } catch (err) {
        // An unreadable journal hides receipts we cannot see — treat it as damage, never as empty.
        this.quarantined = 1;
        this.damageDetectedAt = new Date(this.now()).toISOString();
        this.warnOnce('read', `[xez] MCP operation journal unreadable (${errorMessage(err)})`);
        return;
      }
    }
    if (!journal || journal.length === 0) return;
    this.journalStarted = true;
    this.needsNewline = journal[journal.length - 1] !== 0x0a;

    const firstNewline = journal.indexOf(0x0a);
    const header = headerSchema.safeParse(safeJson(journal.subarray(0, firstNewline < 0 ? journal.length : firstNewline).toString('utf8')));
    let offset = 0;
    if (header.success) {
      const snapshot = this.readSnapshot();
      if (
        snapshot &&
        snapshot.generation === header.data.journal.generation &&
        snapshot.offset <= journal.length &&
        (snapshot.offset === 0 || journal[snapshot.offset - 1] === 0x0a)
      ) {
        for (const receipt of snapshot.receipts) this.receipts.set(receipt.key, receipt);
        if (snapshot.damage) this.noteDamage(snapshot.damage.lines, snapshot.damage.detectedAt);
        offset = snapshot.offset;
      }
    }

    const text = journal.subarray(offset).toString('utf8');
    const lines = text.split('\n');
    let scanned = 0;
    let bad = 0;
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      // The last segment without a trailing newline is a torn write — the realistic crash artefact.
      const torn = index === lines.length - 1;
      scanned += 1;
      const raw = torn ? undefined : safeJson(line);
      const receipt = raw === undefined ? undefined : receiptSchema.safeParse(raw);
      if (receipt?.success) {
        this.receipts.set(receipt.data.key, receipt.data);
        continue;
      }
      if (raw !== undefined && headerSchema.safeParse(raw).success) continue;
      const damage = raw === undefined ? undefined : damageSchema.safeParse(raw);
      if (damage?.success) {
        this.noteDamage(damage.data.damage.lines, damage.data.damage.detectedAt);
        continue;
      }
      bad += 1;
    }
    this.linesSinceCompaction = scanned;
    if (bad > 0) {
      this.noteDamage(bad, new Date(this.now()).toISOString());
      this.warnOnce('quarantine', `[xez] MCP operation journal: ${bad} unreadable line(s) quarantined`);
    }
  }

  private noteDamage(lines: number, detectedAt: string): void {
    this.quarantined += lines;
    if (this.damageDetectedAt === undefined || detectedAt < this.damageDetectedAt) this.damageDetectedAt = detectedAt;
  }

  private readSnapshot(): z.infer<typeof snapshotSchema> | undefined {
    try {
      if (!existsSync(this.snapshotPath)) return undefined;
      const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(this.snapshotPath, 'utf8')));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined; // a corrupt snapshot is ignored entirely; the journal is the truth
    }
  }

  /**
   * Retention (D-06 § 8). A receipt is evicted only when it is BOTH older than the age floor AND
   * outside the newest `maxKept` for its project. A dangling intent is never evicted — its
   * `unverified` answer must not decay into "never happened" — and neither is a receipt whose
   * result still exists (§ 8.4). Touches these files and nothing else (§ 12.2).
   */
  private evict(): void {
    const byProject = new Map<string, Receipt[]>();
    for (const receipt of this.receipts.values()) {
      const project = projectOfKey(receipt.key);
      const list = byProject.get(project) ?? [];
      list.push(receipt);
      byProject.set(project, list);
    }
    const cutoff = new Date(this.now() - this.maxAgeMs).toISOString();
    for (const list of byProject.values()) {
      if (list.length <= this.maxKept) continue;
      list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      for (const receipt of list.slice(this.maxKept)) {
        if (receipt.startedAt >= cutoff) continue;
        if (receipt.phase !== 'settled') continue;
        if (receipt.resultRef && this.opts.isResultLive?.(receipt.resultRef)) continue;
        this.receipts.delete(receipt.key);
      }
    }
  }

  /**
   * Evict, then rewrite the journal from the folded set and write an offset-anchored snapshot
   * (D-06 § 7.2, § 8.1). The quarantine count survives the rewrite as a damage marker until the
   * age floor has passed since it was detected — a torn line's operation cannot be retried later
   * than that — and then it is compacted out on its own, with no manual step.
   */
  private compact(): void {
    this.evict();
    if (this.damageDetectedAt !== undefined && this.damageDetectedAt < new Date(this.now() - this.maxAgeMs).toISOString()) {
      this.quarantined = 0;
      this.damageDetectedAt = undefined;
    }
    const generation = randomUUID();
    const damage =
      this.quarantined > 0 && this.damageDetectedAt !== undefined
        ? { lines: this.quarantined, detectedAt: this.damageDetectedAt }
        : undefined;
    const receipts = [...this.receipts.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const body = [
      JSON.stringify({ v: 1, journal: { generation } }),
      ...(damage ? [JSON.stringify({ v: 1, damage })] : []),
      ...receipts.map((receipt) => JSON.stringify(receipt)),
    ].join('\n');
    const journal = `${body}\n`;
    try {
      writeAtomic(this.journalPath, journal);
    } catch (err) {
      // The old journal is intact (the rename is atomic), so nothing is lost — only the shortcut.
      this.warnOnce('compact', `[xez] MCP operation journal compaction failed (${errorMessage(err)})`);
      return;
    }
    this.journalStarted = true;
    this.needsNewline = false;
    this.linesSinceCompaction = 0;
    try {
      writeAtomic(
        this.snapshotPath,
        JSON.stringify({ v: 1, generation, offset: Buffer.byteLength(journal, 'utf8'), receipts, ...(damage ? { damage } : {}) }),
      );
    } catch (err) {
      // A failed shortcut never turns a successful mutation into an error (§ 7.5).
      this.warnOnce('snapshot', `[xez] MCP operation snapshot write failed (${errorMessage(err)})`);
    }
  }

  private warnOnce(topic: string, message: string): void {
    if (this.warned.has(topic)) return;
    this.warned.add(topic);
    console.warn(message);
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** Per-writer tmp path + rename, `0600` — the `config.ts` discipline, not a fixed `.tmp` (D-06 § 13.1). */
function writeAtomic(path: string, content: string): void {
  const tmp = atomicTmpPath(path);
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems without modes
  }
}
