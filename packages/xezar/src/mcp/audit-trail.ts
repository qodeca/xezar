import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  auditEntrySchema,
  type AuditEntry,
  type AuditOrigin,
  type AuditOutcome,
  type AuditResource,
} from '@qodeca/xezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { PROJECT_ID_RE } from '../workspace/config.ts';

/**
 * The audit trail for MCP and cockpit operations (#102) — D-06 § 10, requirement N-04.
 *
 * WHAT. One append-only NDJSON file per project, `<project>/.local/xezar/mcp-audit.ndjson`, one
 * `AuditEntry` (packages/contract/src/mcp-audit.ts) per settled operation: action, time, project,
 * resource, outcome and ORIGIN, plus D-06's join fields. It is written, never required: a missing
 * file reads as an empty trail, and deleting it discards history and nothing else. It lives under
 * `.local/`, which `ensureProjectDataIgnored` already blanket-ignores (D-06 § 13.2).
 *
 * THE SHARED PATH. Both doors stamp the origin through the same `AuditChannel`: the entry point
 * that owns a door (the MCP service adapter, the cockpit's HTTP routes, the automation scheduler,
 * headless `xezar run`) asks `trail.channel(origin)` ONCE and hands operations to it. The origin is
 * therefore derived from which door the call came through — an operation object has no origin and
 * no project field, and a stray `origin` or `projectId` key on one is ignored (D-06 § 10.4 rule 1).
 * That is also the marker #106 reads to tell the leader's own echoes from new events.
 *
 * MUST vs SHOULD (D-06 § 10.2, N-04 "should"):
 *   - MUST: the project id comes from the trusted scope, the origin from the door, and no secret,
 *     free text, path or foreign identifier is written (§ 10.3, F-15, F-12, N-01).
 *   - MUST: the record grants nothing (§ 10.4 rule 3). Nothing here answers "may X do Y", and no
 *     method consults the trail before an effect — a caller's own permission check runs first and
 *     a refusal is simply recorded as `rejected`. An `origin: 'ui'` entry never widens MCP.
 *   - SHOULD: the entry itself. Recording is best-effort by design: a write that fails is warned
 *     about once and never fails the operation, which is the opposite of the receipt journal's
 *     refuse-before-effect rule (D-06 § 7.5) and deliberately so — idempotency is mandatory, audit
 *     is not.
 *
 * NO SECRETS, TWICE. First by construction: the schema has no free-text field, and payloads enter
 * only as a SHA-256 digest (D-06 § 5.4). Second by value: every client-influenced identifier
 * (`resource.id`, the operation id, the version token) is checked against the host's secret env
 * values, the caller's known secrets (the MCP connection token, D-04) and the well-known token
 * shapes, and a field that matches is DROPPED rather than masked. The check deliberately ignores
 * `XEZ_REDACT_SECRETS=0`: that opt-out exists because masking can corrupt a transcript, and
 * dropping an audit field corrupts nothing.
 *
 * RETENTION IS OPEN. N-04 keeps it open, D-06 § 10.5 does not close it, and D-09 B-23 fixes only
 * the mechanism (count-based, never evicting an entry whose run is still kept) with the count
 * UNRESOLVED (U-2). So nothing here evicts, and no period or count is asserted.
 */

/** File name under the project's data dir (`.local/xezar/`). D-06 § 10.5 puts it beside the receipts. */
export const AUDIT_TRAIL_FILE = 'mcp-audit.ndjson';

export const auditTrailPath = (dataDir: string): string => join(dataDir, AUDIT_TRAIL_FILE);

/** The same floor `secret-redaction.ts` applies to env values: below it a value is a common word. */
const MIN_KNOWN_SECRET_LEN = 12;

/** The trusted scope a trail is bound to — a project context's own id and data dir. */
export interface AuditScope {
  /** The resolved registry id. Never the `default` boot alias, which would split one history in two. */
  projectId: string;
  dataDir: string;
}

export interface AuditTrailOptions {
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Secrets the caller knows about that are not in the env — the MCP connection token (D-04). */
  secretValues?: () => readonly string[];
  /** Where the one-time write/read warning goes. */
  warn?: (message: string) => void;
}

/**
 * What an entry point may say about an operation. Deliberately no `origin` and no `projectId`:
 * both are properties of the door and the scope, never of the operation.
 */
export interface AuditedOperation {
  /** Dotted action id, e.g. `runs.create`. */
  action: string;
  /** The resource acted on, when known before the effect. */
  resource?: AuditResource;
  /** The zod-PARSED payload. Only its digest is kept; never the raw params (D-06 § 5.4 step 1). */
  payload?: unknown;
  /** The `expectedVersion` the caller sent (D-06 § 4.2). Kept only when it has the `rev1` shape. */
  expectedVersion?: string;
  /** MCP only — the client's `operationId` (D-06 § 5.2). */
  operationId?: string;
  /** MCP only — D-02's session fencing generation. */
  ownerGeneration?: number;
}

export interface AuditSettlement {
  outcome: AuditOutcome;
  /** Short machine code for a non-`ok` outcome, e.g. `stale_version`. Never an error message. */
  errorCode?: string;
  /** The resource the effect produced (a created run), when it was unknown before. */
  resource?: AuditResource;
}

/** Thrown by an effect to refuse BEFORE anything happened: validation, permission, stale version. */
export class AuditRejection extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AuditRejection';
  }
}

/**
 * The outcome an HTTP status stands for, for callers that settle through a route (the cockpit's
 * handlers, and the MCP adapter, which dispatches into the same routes). The routes validate as
 * middleware and answer 4xx before any effect, so a 4xx is a refusal; a 5xx may have come after
 * the effect started, so it is `unverified`, never `rejected`.
 */
export function settlementForStatus(status: number): AuditSettlement {
  if (status >= 200 && status < 300) return { outcome: 'ok' };
  if (status >= 400 && status < 500) return { outcome: 'rejected', errorCode: `http_${status}` };
  return { outcome: 'unverified', errorCode: `http_${status}` };
}

export interface AuditReadResult {
  entries: AuditEntry[];
  /** Lines that failed to parse or validate — skipped, never fatal (D-06 § 7.4's line-level rule). */
  quarantined: number;
}

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

  /** The recorder for one door. Call it where the door is, once; the origin is fixed from then on. */
  channel(origin: AuditOrigin): AuditChannel {
    return new AuditChannel(this, origin);
  }

  /**
   * Every entry of THIS project, oldest first. A scoped read (D-06 § 10.4 rule 2): it opens only
   * this project's file and additionally drops any line naming another project, so a reader bound
   * to B learns nothing about A — not its entries, and not how many there are (N-01).
   */
  read(): AuditReadResult {
    let raw: string;
    try {
      raw = readFileSync(auditTrailPath(this.scope.dataDir), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.warnOnce('read', err);
      return { entries: [], quarantined: 0 };
    }
    const entries: AuditEntry[] = [];
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
      const parsed = auditEntrySchema.safeParse(json);
      if (!parsed.success) {
        quarantined += 1;
        continue;
      }
      if (parsed.data.projectId !== this.scope.projectId) continue;
      entries.push(parsed.data);
    }
    return { entries, quarantined };
  }

  /** @internal — build, check and append one entry. Never throws. */
  write(origin: AuditOrigin, op: AuditedOperation, settlement: AuditSettlement): AuditEntry | null {
    try {
      const entry = this.build(origin, op, settlement);
      if (!entry) return null;
      appendFileSync(auditTrailPath(this.scope.dataDir), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      return entry;
    } catch (err) {
      this.warnOnce('write', err);
      return null;
    }
  }

  private build(origin: AuditOrigin, op: AuditedOperation, settlement: AuditSettlement): AuditEntry | null {
    const secrets = this.knownSecrets();
    const clean = (value: string | undefined): string | undefined =>
      value !== undefined && redactSecrets(value, secrets) === value ? value : undefined;
    const field = <K extends keyof AuditEntry>(key: K, value: unknown): AuditEntry[K] | undefined => {
      const parsed = auditEntrySchema.shape[key].safeParse(value);
      return parsed.success ? (parsed.data as AuditEntry[K]) : undefined;
    };
    const resourceOf = (resource: AuditResource | undefined): AuditResource | undefined => {
      if (!resource || clean(resource.id) === undefined || clean(resource.kind) === undefined) return undefined;
      return field('resource', { kind: resource.kind, id: resource.id });
    };

    const candidate: Record<string, unknown> = {
      v: 1,
      ts: this.now().toISOString(),
      projectId: this.scope.projectId,
      action: op.action,
      outcome: settlement.outcome,
      origin,
    };
    const optional: Partial<AuditEntry> = {
      resource: resourceOf(settlement.resource) ?? resourceOf(op.resource),
      ownerGeneration: origin === 'mcp' ? field('ownerGeneration', op.ownerGeneration) : undefined,
      operationKey:
        origin === 'mcp' && op.operationId !== undefined
          ? field('operationKey', clean(`${this.scope.projectId}/${op.operationId}`))
          : undefined,
      versionToken: field('versionToken', clean(op.expectedVersion)),
      payloadDigest: op.payload === undefined ? undefined : field('payloadDigest', safeDigest(op.payload)),
      errorCode: settlement.outcome === 'ok' ? undefined : field('errorCode', clean(settlement.errorCode)),
    };
    // Spread only what is present: an `undefined` key would be typed as present and dropped by
    // JSON.stringify anyway, and the read path must see exactly what was written.
    for (const [key, value] of Object.entries(optional)) if (value !== undefined) candidate[key] = value;

    const parsed = auditEntrySchema.safeParse(candidate);
    if (!parsed.success || clean(parsed.data.action) === undefined) {
      this.warnOnce('write', new Error(`not an auditable operation: ${parsed.error?.issues[0]?.message ?? 'secret-shaped action'}`));
      return null;
    }
    return parsed.data;
  }

  private knownSecrets(): string[] {
    const values = new Set(collectSecretValues());
    for (const value of this.callerSecrets()) if (value.length >= MIN_KNOWN_SECRET_LEN) values.add(value);
    return [...values].sort((a, b) => b.length - a.length);
  }

  private warnOnce(what: 'read' | 'write', err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    // The code only — an error message can carry a path, and a path is not for logs either.
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? (err as Error | undefined)?.name ?? 'error';
    this.warn(`xezar: audit trail ${what} failed (${code}); operations continue unaudited`);
  }
}

/** One door's recorder. The origin is fixed at construction and no operation can change it. */
export class AuditChannel {
  constructor(
    private readonly trail: AuditTrail,
    readonly origin: AuditOrigin,
  ) {}

  /** Record an operation that has already settled. */
  record(op: AuditedOperation, settlement: AuditSettlement): AuditEntry | null {
    return this.trail.write(this.origin, op, settlement);
  }

  /** Record an operation that settled through an HTTP route, by its status. */
  recordStatus(op: AuditedOperation, status: number): AuditEntry | null {
    return this.record(op, settlementForStatus(status));
  }

  /**
   * Run `effect` and record how it settled. An `AuditRejection` means "refused before any effect"
   * and records `rejected`; any other throw may have come after the effect began, so it records
   * `unverified`. Either error is rethrown unchanged: auditing never changes the operation's own
   * answer. `resourceOf` names a resource the effect created.
   */
  async run<T>(
    op: AuditedOperation,
    effect: () => T | Promise<T>,
    resourceOf?: (value: T) => AuditResource | undefined,
  ): Promise<T> {
    let value: T;
    try {
      value = await effect();
    } catch (err) {
      this.record(
        op,
        err instanceof AuditRejection
          ? { outcome: 'rejected', errorCode: err.code }
          : { outcome: 'unverified', errorCode: 'effect_failed' },
      );
      throw err;
    }
    this.record(op, { outcome: 'ok', resource: resourceOf?.(value) });
    return value;
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
