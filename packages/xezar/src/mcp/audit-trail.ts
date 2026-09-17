import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  auditActionRecordSchema,
  auditEntrySchema,
  auditRecordSchema,
  type AuditActionRecord,
  type AuditActor,
  type AuditEntry,
  type AuditOrigin,
  type AuditResource,
} from '@qodeca/xezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { PROJECT_ID_RE } from '../workspace/config.ts';

/**
 * The audit trail (#102, #306) — D-06 § 10, spec `docs/features/mcp-server/audit-trail-origins-2026-09-17.md`.
 * Built for every door; written today by the MCP door only (see THE SHARED PATH below).
 *
 * WHAT. One append-only NDJSON file per project, `<project>/.local/xezar/audit.ndjson`, one v2
 * `AuditRecord` (packages/contract/src/audit.ts) per settled operation: sequence, UTC time, project,
 * origin with its actor, action, resource and an `applied`/`refused` outcome, plus D-06's join
 * fields. It is written, never required: a missing file reads as an empty trail, and deleting it
 * discards history and nothing else. It lives under `.local/`, which `ensureProjectDataIgnored`
 * already blanket-ignores (D-06 § 13.2). New files are created with mode 0600.
 *
 * THE LEGACY NAME. xezar 0.13.0–0.15.0 wrote v1 entries to `mcp-audit.ndjson`. That file is now a
 * READ-ONLY alias (spec § 8): nothing here writes, renames, chmods or trims it. `read()` uses it
 * only while `audit.ndjson` does not exist, says so once per process, and the new file wins as soon
 * as it exists, so an interrupted upgrade can never show one history twice. Both files may stay on
 * disk indefinitely; 0.15.0, after a downgrade, still reads its own file untouched. The alias is
 * removed no earlier than 0.18.0.
 *
 * THE SHARED PATH, AND THE ONE DOOR THAT USES IT. A door stamps its origin through an
 * `AuditChannel`: the entry point that owns the door asks `trail.channel(origin)` ONCE and hands
 * operations to it. The origin — and the actor's `type` — is therefore derived from which door the
 * call came through; an operation object has no origin and no project field, and a stray `origin`
 * or `projectId` key on one is ignored (D-06 § 10.4 rule 1).
 *
 * **Exactly one door does this today, and it is the MCP one:** `mcp/index.ts` builds
 * `.channel('mcp')`, and it is the only non-test construction of this class in `packages/`. The
 * cockpit's HTTP routes, the automation scheduler and the command line record NOTHING yet; wiring
 * them is the next delivery step of #306. `channel()` takes any `AuditOrigin` because those doors
 * are the point, but do not read this comment as a description of four live writers.
 *
 * OUTCOMES (spec § 3.2). `applied`: the effect took place. `refused`: the door rejected the
 * operation BEFORE any effect, with a machine reason. There is no third value, so an operation that
 * may have started its effect and then failed is not recorded at all — calling it `refused` would
 * be a lie. `skip(code)` says so explicitly, and it uses the one warning below.
 *
 * SEQUENCE. `seq` is the last valid persisted v2 record's `seq` plus one, read from the file at
 * every write — never from a cache — so a failed append allocates nothing. Two PROCESSES appending
 * at the same instant can still read the same last value; the shared lock that closes that is
 * later #306 work (spec § 7), as are rotation and repairing the mode of an existing file.
 *
 * MUST vs SHOULD (D-06 § 10.2):
 *   - MUST: the project id comes from the trusted scope, the origin and actor from the door, and no
 *     secret, free text, path or foreign identifier is written (§ 10.3, F-15, F-12, N-01).
 *   - MUST: the record grants nothing (§ 10.4 rule 3). Nothing here answers "may X do Y", and no
 *     method consults the trail before an effect.
 *   - SHOULD: the record itself. Recording is best-effort by design: a write that fails is warned
 *     about once and never fails the operation, which is the opposite of the receipt journal's
 *     refuse-before-effect rule (D-06 § 7.5) and deliberately so — idempotency is mandatory, audit
 *     is not.
 *
 * NO SECRETS, TWICE. First by construction: the schema has no free-text field, and payloads enter
 * only as a SHA-256 digest (D-06 § 5.4). Second by value: every client-influenced identifier
 * (`resource.id`, the operation id, the version token, the refusal reason) is checked against the
 * host's secret env values, the caller's known secrets (the MCP connection token, D-04) and the
 * well-known token shapes, and a field that matches is DROPPED rather than masked. The check
 * deliberately ignores `XEZ_REDACT_SECRETS=0`: that opt-out exists because masking can corrupt a
 * transcript, and dropping an audit field corrupts nothing.
 */

/** File name under the project's data dir (`.local/xezar/`). D-06 § 10.5 puts it beside the receipts. */
export const AUDIT_TRAIL_FILE = 'audit.ndjson';
/** The name 0.13.0–0.15.0 wrote. Read-only: never written, renamed, chmodded or deleted here. */
export const LEGACY_AUDIT_TRAIL_FILE = 'mcp-audit.ndjson';

export const auditTrailPath = (dataDir: string): string => join(dataDir, AUDIT_TRAIL_FILE);
export const legacyAuditTrailPath = (dataDir: string): string => join(dataDir, LEGACY_AUDIT_TRAIL_FILE);

/** The one line a process prints the first time it reads the legacy file. */
export const LEGACY_AUDIT_DEPRECATION =
  'xezar: mcp-audit.ndjson is deprecated; reading it read-only (removal not before 0.18.0)';

/** Per process, as spec § 8 asks — not per trail and not per project. */
let legacyNoticeShown = false;

/** @internal — for tests that need to observe the once-per-process deprecation line again. */
export function resetLegacyAuditNoticeForTests(): void {
  legacyNoticeShown = false;
}

/** The same floor `secret-redaction.ts` applies to env values: below it a value is a common word. */
const MIN_KNOWN_SECRET_LEN = 12;

/** How much of the file's tail one read looks at while searching back for the last valid record. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** The trusted scope a trail is bound to — a project context's own id and data dir. */
export interface AuditScope {
  /** The resolved registry id. Never the `default` boot alias, which would split one history in two. */
  projectId: string;
  dataDir: string;
}

export interface AuditTrailOptions {
  /** Clock, injectable for tests. Its ISO string is always UTC. */
  now?: () => Date;
  /** Secrets the caller knows about that are not in the env — the MCP connection token (D-04). */
  secretValues?: () => readonly string[];
  /** Where the one-time warning and the legacy deprecation line go. */
  warn?: (message: string) => void;
}

/** The actor fields a door supplies beyond `type`, which the channel stamps itself. */
export type AuditActorDetails<O extends AuditOrigin> = Omit<Extract<AuditActor, { type: O }>, 'type'>;

/**
 * What an entry point may say about an operation. Deliberately no `origin` and no `projectId`:
 * both are properties of the door and the scope, never of the operation.
 */
export interface AuditedOperation<O extends AuditOrigin = AuditOrigin> {
  /** Dotted action id, e.g. `taskCreate.start`. */
  action: string;
  /** The resource acted on, when known before the effect. */
  resource?: AuditResource;
  /** The zod-PARSED payload. Only its digest is kept; never the raw params (D-06 § 5.4 step 1). */
  payload?: unknown;
  /** The `expectedVersion` the caller sent (D-06 § 4.2). Kept only when it has the `rev1` shape. */
  expectedVersion?: string;
  /** MCP only — the client's `operationId` (D-06 § 5.2). */
  operationId?: string;
  /**
   * MCP only — the D-02.3 fencing token the mutation arrived under, `<wall-clock ms>-<UUIDv4>`, as
   * the receipt journal records it. Only the wall-clock prefix is kept: the full token passes the
   * owner's equality fence, so it is authority and never enters the trail.
   */
  ownerGeneration?: string;
  /**
   * The door-specific actor fields (an automation's `receiptId`, a command's id). Supplied by the
   * door, never by a caller; `type` is always the channel's origin, whatever this object says.
   */
  actor?: AuditActorDetails<O>;
}

/** How an operation settled, in the two words v2 has. */
export type AuditSettlement =
  | { outcome: 'applied'; resource?: AuditResource }
  | {
      outcome: 'refused';
      /** Short machine code, e.g. `stale_version`. Never an error message. */
      reason: string;
      resource?: AuditResource;
    };

/** Thrown by an effect to refuse BEFORE anything happened: validation, permission, stale version. */
export class AuditRejection extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuditRejection';
  }
}

/** The reason a refusal gets when its own code cannot be kept (malformed, or secret-shaped). */
const UNSPECIFIED_REASON = 'unspecified';

/**
 * The settlement an HTTP status stands for, for callers that settle through a route. The routes
 * validate as middleware and answer 4xx before any effect, so a 4xx is a refusal. A 5xx may have
 * come after the effect started, so it has NO settlement (`undefined`): v2 cannot say "unknown".
 */
export function settlementForStatus(status: number): AuditSettlement | undefined {
  if (status >= 200 && status < 300) return { outcome: 'applied' };
  if (status >= 400 && status < 500) return { outcome: 'refused', reason: `http_${status}` };
  return undefined;
}

export type AuditReadResult =
  | {
      /** `audit.ndjson` exists (or neither file does): v2 action records. */
      source: 'current';
      entries: AuditActionRecord[];
      /** Lines that failed to parse or validate — skipped, never fatal (D-06 § 7.4's line-level rule). */
      quarantined: number;
    }
  | {
      /** Only the legacy `mcp-audit.ndjson` exists: v1 entries, read-only. */
      source: 'legacy';
      entries: AuditEntry[];
      quarantined: number;
    };

export class AuditTrail {
  readonly scope: AuditScope;
  private readonly now: () => Date;
  private readonly callerSecrets: () => readonly string[];
  private readonly warn: (message: string) => void;
  private warned = false;

  constructor(scope: AuditScope, options: AuditTrailOptions = {}) {
    if (scope.projectId === 'default' || !PROJECT_ID_RE.test(scope.projectId)) {
      throw new Error(`audit trail needs a resolved project id, got ${JSON.stringify(scope.projectId)}`);
    }
    this.scope = { projectId: scope.projectId, dataDir: scope.dataDir };
    this.now = options.now ?? (() => new Date());
    this.callerSecrets = options.secretValues ?? (() => []);
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * The recorder for one door. Call it where the door is, once; the origin is fixed from then on.
   * One production caller: `mcp/index.ts`, with `'mcp'`. Every other origin is test-only for now.
   */
  channel<O extends AuditOrigin>(origin: O): AuditChannel<O> {
    return new AuditChannel(this, origin);
  }

  /**
   * Every record of THIS project, oldest first, from exactly one file (spec § 8):
   *   1. `audit.ndjson` exists → its v2 action records; the legacy file is ignored even if present;
   *   2. only `mcp-audit.ndjson` exists → its v1 entries, read-only, with one deprecation line per
   *      process;
   *   3. neither → an empty `current` trail, silently.
   * A scoped read (D-06 § 10.4 rule 2): any line naming another project is dropped too, so a reader
   * bound to B learns nothing about A — not its entries, and not how many there are (N-01).
   * Rotation markers are not actions and are skipped without counting as quarantined.
   */
  read(): AuditReadResult {
    const current = this.readFile(auditTrailPath(this.scope.dataDir));
    if (current !== 'absent') {
      const entries: AuditActionRecord[] = [];
      const quarantined = eachLine(current, (json) => {
        const parsed = auditRecordSchema.safeParse(json);
        if (!parsed.success) return false;
        if (parsed.data.kind === 'action' && parsed.data.projectId === this.scope.projectId) entries.push(parsed.data);
        return true;
      });
      return { source: 'current', entries, quarantined };
    }
    const legacy = this.readFile(legacyAuditTrailPath(this.scope.dataDir));
    if (legacy === 'absent') return { source: 'current', entries: [], quarantined: 0 };
    if (!legacyNoticeShown) {
      legacyNoticeShown = true;
      this.warn(LEGACY_AUDIT_DEPRECATION);
    }
    const entries: AuditEntry[] = [];
    const quarantined = eachLine(legacy, (json) => {
      const parsed = auditEntrySchema.safeParse(json);
      if (!parsed.success) return false;
      if (parsed.data.projectId === this.scope.projectId) entries.push(parsed.data);
      return true;
    });
    return { source: 'legacy', entries, quarantined };
  }

  /** @internal — build, check and append one record. Never throws. */
  write<O extends AuditOrigin>(origin: O, op: AuditedOperation<O>, settlement: AuditSettlement): AuditActionRecord | null {
    try {
      const candidate = this.build(origin, op, settlement);
      if (!candidate) return null;
      const path = auditTrailPath(this.scope.dataDir);
      const tail = lastPersisted(path);
      const parsed = auditActionRecordSchema.safeParse({ v: 2, seq: tail.seq + 1, ...candidate });
      if (!parsed.success) {
        this.warnOnce('write', new Error(`not an auditable operation: ${parsed.error.issues[0]?.message ?? 'invalid'}`));
        return null;
      }
      // A torn last line (a crash mid-append) must not swallow this record into itself.
      appendFileSync(path, `${tail.endsWithNewline ? '' : '\n'}${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
      return parsed.data;
    } catch (err) {
      this.warnOnce('write', err);
      return null;
    }
  }

  /** @internal — an operation that settled without an honest v2 outcome. Warns once, writes nothing. */
  skip(code: string): null {
    this.warnOnce('write', Object.assign(new Error(code), { code: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unrecordable' }));
    return null;
  }

  /** The record without `v` and `seq`, which only the append path may allocate. */
  private build<O extends AuditOrigin>(
    origin: O,
    op: AuditedOperation<O>,
    settlement: AuditSettlement,
  ): Omit<AuditActionRecord, 'v' | 'seq'> | null {
    const secrets = this.knownSecrets();
    const clean = (value: string | undefined): string | undefined =>
      value !== undefined && redactSecrets(value, secrets) === value ? value : undefined;
    const field = <K extends keyof AuditActionRecord>(key: K, value: unknown): AuditActionRecord[K] | undefined => {
      const parsed = auditActionRecordSchema.shape[key].safeParse(value);
      return parsed.success ? (parsed.data as AuditActionRecord[K]) : undefined;
    };
    const resourceOf = (resource: AuditResource | undefined): AuditResource | undefined => {
      if (!resource || clean(resource.id) === undefined || clean(resource.kind) === undefined) return undefined;
      return field('resource', { kind: resource.kind, id: resource.id });
    };

    const candidate: Record<string, unknown> = {
      kind: 'action',
      ts: this.now().toISOString(),
      projectId: this.scope.projectId,
      origin,
      // The door's details first, then its type: no details object can change which door this was.
      actor: { ...(op.actor ?? {}), type: origin },
      action: op.action,
      outcome:
        settlement.outcome === 'applied'
          ? { status: 'applied' }
          : {
              status: 'refused',
              reason: field('outcome', { status: 'refused', reason: clean(settlement.reason) })
                ? settlement.reason
                : UNSPECIFIED_REASON,
            },
    };
    const optional: Partial<AuditActionRecord> = {
      resource: resourceOf(settlement.resource) ?? resourceOf(op.resource),
      ownerGeneration: origin === 'mcp' ? field('ownerGeneration', fencingTokenMs(op.ownerGeneration)) : undefined,
      operationKey:
        origin === 'mcp' && op.operationId !== undefined
          ? field('operationKey', clean(`${this.scope.projectId}/${op.operationId}`))
          : undefined,
      versionToken: field('versionToken', clean(op.expectedVersion)),
      payloadDigest: op.payload === undefined ? undefined : field('payloadDigest', safeDigest(op.payload)),
    };
    // Spread only what is present: an `undefined` key would be typed as present and dropped by
    // JSON.stringify anyway, and the read path must see exactly what was written.
    for (const [key, value] of Object.entries(optional)) if (value !== undefined) candidate[key] = value;

    // Validated with a placeholder sequence, so a malformed operation is refused BEFORE the file is
    // read for the real one. `write` validates again with the allocated value.
    const parsed = auditActionRecordSchema.safeParse({ v: 2, seq: 1, ...candidate });
    if (!parsed.success || clean(parsed.data.action) === undefined) {
      this.warnOnce('write', new Error(`not an auditable operation: ${parsed.error?.issues[0]?.message ?? 'secret-shaped action'}`));
      return null;
    }
    const { v: _v, seq: _seq, ...record } = parsed.data;
    return record;
  }

  /** The file's text, `'absent'` when it does not exist, or `''` (after the one warning) when it cannot be read. */
  private readFile(path: string): string | 'absent' {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      this.warnOnce('read', err);
      return '';
    }
  }

  private knownSecrets(): string[] {
    const values = new Set(collectSecretValues());
    for (const value of this.callerSecrets()) if (value.length >= MIN_KNOWN_SECRET_LEN) values.add(value);
    return [...values].sort((a, b) => b.length - a.length);
  }

  /**
   * ONE warning per trail per process, shared by every read, write and skip failure (spec § 7.2).
   * The code only — an error message can carry a path, and a path is not for logs either.
   */
  private warnOnce(what: 'read' | 'write', err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? (err as Error | undefined)?.name ?? 'error';
    this.warn(
      what === 'read'
        ? `xezar: audit trail read failed (${code}); the trail reads as empty.`
        : `xezar: audit trail write failed (${code}); the action continued without an audit record.`,
    );
  }
}

/** One door's recorder. The origin is fixed at construction and no operation can change it. */
export class AuditChannel<O extends AuditOrigin = AuditOrigin> {
  constructor(
    private readonly trail: AuditTrail,
    readonly origin: O,
  ) {}

  /** Record an operation that has already settled. */
  record(op: AuditedOperation<O>, settlement: AuditSettlement): AuditActionRecord | null {
    return this.trail.write(this.origin, op, settlement);
  }

  /**
   * Say that an operation settled in a way v2 cannot record honestly — it may have started its
   * effect and then failed (spec § 3.2). Nothing is written; the trail's one warning is used.
   */
  skip(code: string): null {
    return this.trail.skip(code);
  }

  /** Record an operation that settled through an HTTP route, by its status. A 5xx is skipped. */
  recordStatus(op: AuditedOperation<O>, status: number): AuditActionRecord | null {
    const settlement = settlementForStatus(status);
    return settlement ? this.record(op, settlement) : this.skip(`http_${status}`);
  }

  /**
   * Run `effect` and record how it settled. An `AuditRejection` means "refused before any effect"
   * and records `refused`; any other throw may have come after the effect began, so it records
   * nothing and warns once. Either error is rethrown unchanged: auditing never changes the
   * operation's own answer. `resourceOf` names a resource the effect created.
   */
  async run<T>(
    op: AuditedOperation<O>,
    effect: () => T | Promise<T>,
    resourceOf?: (value: T) => AuditResource | undefined,
  ): Promise<T> {
    let value: T;
    try {
      value = await effect();
    } catch (err) {
      if (err instanceof AuditRejection) this.record(op, { outcome: 'refused', reason: err.code });
      else this.skip('effect_failed');
      throw err;
    }
    const resource = resourceOf?.(value);
    this.record(op, { outcome: 'applied', ...(resource ? { resource } : {}) });
    return value;
  }
}

/** Calls `accept` with every non-blank line's JSON; returns how many lines were quarantined. */
function eachLine(raw: string, accept: (json: unknown) => boolean): number {
  let quarantined = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      quarantined += 1;
      continue;
    }
    if (!accept(json)) quarantined += 1;
  }
  return quarantined;
}

/**
 * The last valid v2 record's `seq` (0 when there is none), read backwards from the end of the file
 * so a long trail costs one tail read, and whether the file ends in a newline. A torn or corrupt
 * tail is skipped over to the last valid record, which is how a failed append allocates nothing.
 * A missing file is `{ seq: 0, endsWithNewline: true }`; any other read error throws to the caller.
 */
function lastPersisted(path: string): { seq: number; endsWithNewline: boolean } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { seq: 0, endsWithNewline: true };
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { seq: 0, endsWithNewline: true };
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    const endsWithNewline = last[0] === 0x0a;
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk, carry]);
      let lineEnd = data.length;
      for (let i = data.length - 1; i >= 0; i -= 1) {
        if (data[i] !== 0x0a) continue;
        const seq = seqOf(data.subarray(i + 1, lineEnd));
        if (seq !== undefined) return { seq, endsWithNewline };
        lineEnd = i;
      }
      if (start === 0) {
        const seq = seqOf(data.subarray(0, lineEnd));
        return { seq: seq ?? 0, endsWithNewline };
      }
      // The first piece of this chunk may continue in the one before it.
      carry = data.subarray(0, lineEnd);
      end = start;
    }
    return { seq: 0, endsWithNewline };
  } finally {
    closeSync(fd);
  }
}

function seqOf(line: Buffer): number | undefined {
  if (line.length === 0) return undefined;
  try {
    const parsed = auditRecordSchema.safeParse(JSON.parse(line.toString('utf8')));
    return parsed.success ? parsed.data.seq : undefined;
  } catch {
    return undefined;
  }
}

/**
 * D-06 § 5.4's canonical form: object keys sorted by code unit at every level, arrays in order,
 * `undefined` keys dropped, and a byte blob replaced by `{ sha256, bytes }` so the digest covers
 * bytes, never a path. A non-finite number is refused (zod refuses it upstream).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256, lowercase hex, of `canonicalJson(payload)`. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * The wall-clock prefix of a D-02.3 fencing token, `<ms>-<UUIDv4>` — the number D-06 § 10.2 keeps.
 * D-02 names human-readable audit as the prefix's one consumer; the random half is what the fence
 * compares, so it is dropped here. Anything not shaped like a token yields nothing.
 */
function fencingTokenMs(token: string | undefined): number | undefined {
  const match = token === undefined ? null : /^(\d{1,15})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(token);
  return match ? Number(match[1]) : undefined;
}

function safeDigest(payload: unknown): string | undefined {
  try {
    return payloadDigest(payload);
  } catch {
    return undefined;
  }
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { bytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number in payload');
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${typeof value} in payload`);
  }
  if (value === null || typeof value !== 'object') return value;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === 'function') return canonicalize(withJson.toJSON());
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalize(item)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}
