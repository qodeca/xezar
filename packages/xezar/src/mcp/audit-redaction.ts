import { createHash } from 'node:crypto';
import {
  auditActionRecordSchema,
  type AuditActionRecord,
  type AuditOrigin,
  type AuditProxyUser,
  type AuditResource,
} from '@qodeca/xezar-contract';
import { redactSecrets } from '../core/secret-redaction.ts';
import type { AuditedOperation, AuditSettlement } from './audit-trail.ts';

/**
 * THE redaction seam of the audit trail (#306 part 4) — spec
 * `docs/features/mcp-server/audit-trail-origins-2026-09-17.md` § 9 and § 11 ("Redaction per field
 * class, per door", "Seam guard").
 *
 * ONE FUNCTION, EVERY DOOR. `redactAuditInput` is the only code that turns what a door said about an
 * operation into something the append path accepts: `AuditTrail.write` calls it, and
 * `appendAuditRecord` takes only its `RedactedAuditInput`. A door cannot append JSON itself, and it
 * cannot skip a rule by building the record some other way (`audit-redaction-seam.test.ts`).
 *
 * A FIELD LIST PER DOOR. `AUDIT_DOOR_POLICIES` says, for each door, which operation fields it may
 * supply at all and, for each of six field classes, the door's own rule. The seam applies exactly
 * those rules; a field a door is not allowed to supply is dropped before anything else happens.
 *
 *   - `identifier-secret` — every listed identifier (resource, operation key, version token, field
 *     names, refusal reason, action, actor details) is checked against the host's secret env
 *     values and the well-known token shapes; a match DROPS the field (a required one refuses the
 *     record). The payload's string leaves are masked with the same list before hashing.
 *   - `free-text` — prompts, messages, titles, briefs and bodies: the listed payload keys are
 *     removed, at any depth, before hashing. Changing the text cannot change the digest.
 *   - `path-url` — the listed payload keys are removed, and any string leaf shaped like an absolute
 *     path, a URL or an scp-style remote is replaced, before hashing.
 *   - `control-text` — C0/C1 controls and DEL are stripped from the asserted proxy user and from
 *     every payload string before hashing. (Persisted identifiers never carry them: the contract's
 *     own patterns refuse them, and a refused identifier is dropped, never repaired.)
 *   - `config-value` — for a configuration write, the stored `fieldNames` are the body's key names
 *     and EVERY value is replaced before hashing: key names and a digest, never a value, and never a
 *     digest of one either (a port or a tag list is small enough to guess from its hash). The
 *     automation door has no configuration writes; its rule removes a definition's own
 *     configuration keys (task, filters, events, workflow) before hashing.
 *   - `door-specific` — what only this door holds: the listed keys (request headers, a caller's
 *     origin, a candidate's author, `argv`) are removed, and the secrets the door knows beyond the
 *     environment (a request's credentials, the MCP service's own env) are masked like env secrets.
 *
 * The digest is SHA-256 over D-06 § 5.4's canonical JSON of what is left. Nothing here throws: a
 * candidate that cannot be made valid is `{ ok: false }`, and the trail turns that into its one
 * warning.
 */

export const AUDIT_FIELD_CLASSES = [
  'identifier-secret',
  'free-text',
  'path-url',
  'control-text',
  'config-value',
  'door-specific',
] as const;
export type AuditFieldClass = (typeof AUDIT_FIELD_CLASSES)[number];

/** The operation fields a door may supply. Anything else it passes is dropped by the seam. */
export type AuditOperationField =
  | 'resource'
  | 'payload'
  | 'fieldNames'
  | 'expectedVersion'
  | 'operationId'
  | 'ownerGeneration'
  | 'actor'
  | 'secrets';

/** Identifiers the `identifier-secret` rule can check. */
export type AuditIdentifierField =
  | 'action'
  | 'reason'
  | 'resource'
  | 'operationKey'
  | 'versionToken'
  | 'fieldNames'
  | 'actor.receiptId'
  | 'actor.proxyUser';

export interface AuditDoorPolicy {
  /** The operation fields this door may supply. */
  readonly operation: readonly AuditOperationField[];
  /** The actor detail keys this door may supply (`type` is always the door's). */
  readonly actor: readonly string[];
  readonly redact: {
    readonly 'identifier-secret': { readonly identifiers: readonly AuditIdentifierField[]; readonly payload: boolean };
    readonly 'free-text': { readonly keys: readonly string[] };
    readonly 'path-url': { readonly keys: readonly string[]; readonly shapes: boolean };
    readonly 'control-text': { readonly proxyUser: boolean; readonly payload: boolean };
    readonly 'config-value':
      | { readonly actions: readonly string[]; readonly body: 'payload' | readonly string[] }
      | { readonly keys: readonly string[] };
    readonly 'door-specific': { readonly keys: readonly string[]; readonly secrets: boolean };
  };
}

/** Every configuration write, by action id, whichever door carries it (spec § 6.1, § 6.2 and § 5). */
export const AUDIT_CONFIG_WRITES: readonly string[] = [
  'project.config.set',
  'project.registry.update',
  'project.uiState.set',
  'agentConfig.write',
  'workspace.config.set',
  'workspace.uiState.set',
  'cli.projects.tag',
  'cli.projects.port',
];

/** Free text any door's body or arguments can carry. Removed before hashing. */
const FREE_TEXT_KEYS = [
  'task',
  'prompt',
  'text',
  'message',
  'feedback',
  'answer',
  'title',
  'brief',
  'body',
  'description',
  'name',
  'label',
  'steps',
  'yaml',
  // Per-run system-prompt override and pasted attachments: both can carry the same free text (or
  // its bytes) as `task`/`prompt` but were missing from this list, so two `POST /runs` (or message)
  // bodies differing only in one of them still hashed to different digests.
  'systemPrompt',
  'images',
];
/** Keys that hold a path or a location. Removed before hashing. */
const PATH_KEYS = ['root', 'path', 'dir', 'folder', 'cwd', 'file', 'url', 'remote', 'cloneUrl', 'worktreePath', 'dataDir'];

/**
 * The field list per door (§ 9). Each door applies every class; what differs is the door's own
 * inventory — what it may supply, which identifiers it fills, which keys it can be handed.
 */
export const AUDIT_DOOR_POLICIES: Readonly<Record<AuditOrigin, AuditDoorPolicy>> = {
  ui: {
    operation: ['resource', 'payload', 'fieldNames', 'actor', 'secrets'],
    actor: ['proxyUser'],
    redact: {
      'identifier-secret': { identifiers: ['action', 'reason', 'resource', 'fieldNames', 'actor.proxyUser'], payload: true },
      'free-text': { keys: FREE_TEXT_KEYS },
      'path-url': { keys: PATH_KEYS, shapes: true },
      'control-text': { proxyUser: true, payload: true },
      'config-value': { actions: AUDIT_CONFIG_WRITES, body: 'payload' },
      'door-specific': { keys: ['headers', 'authorization', 'cookie'], secrets: true },
    },
  },
  mcp: {
    operation: ['resource', 'payload', 'fieldNames', 'expectedVersion', 'operationId', 'ownerGeneration', 'secrets'],
    actor: [],
    redact: {
      'identifier-secret': { identifiers: ['action', 'reason', 'resource', 'operationKey', 'versionToken', 'fieldNames'], payload: true },
      'free-text': { keys: [...FREE_TEXT_KEYS, 'automation', 'workflow'] },
      'path-url': { keys: PATH_KEYS, shapes: true },
      'control-text': { proxyUser: false, payload: true },
      // The tool arguments hold the route body under one key per action.
      'config-value': { actions: AUDIT_CONFIG_WRITES, body: ['config', 'project', 'promptTemplates', 'content'] },
      'door-specific': { keys: ['origin', 'actor', 'projectId', 'connectionToken'], secrets: true },
    },
  },
  automation: {
    operation: ['resource', 'payload', 'actor'],
    actor: ['receiptId'],
    redact: {
      'identifier-secret': { identifiers: ['action', 'reason', 'resource', 'actor.receiptId'], payload: true },
      'free-text': { keys: ['title', 'body', 'prompt', 'task', 'text'] },
      'path-url': { keys: ['url', 'htmlUrl', 'path'], shapes: true },
      'control-text': { proxyUser: false, payload: true },
      // No configuration writes: what it can be handed is a definition's own configuration.
      'config-value': { keys: ['task', 'filters', 'events', 'intervalSeconds', 'enabled', 'workflow', 'definition'] },
      'door-specific': { keys: ['author', 'labels', 'assignees', 'repo', 'repository', 'nodeId', 'candidate'], secrets: false },
    },
  },
  cli: {
    operation: ['resource', 'payload', 'fieldNames', 'actor'],
    actor: ['command'],
    redact: {
      'identifier-secret': { identifiers: ['action', 'reason', 'resource', 'fieldNames'], payload: true },
      'free-text': { keys: ['task', 'prompt', 'text', 'message'] },
      'path-url': { keys: ['root', 'path', 'dir', 'cwd', 'url'], shapes: true },
      'control-text': { proxyUser: false, payload: true },
      'config-value': { actions: AUDIT_CONFIG_WRITES, body: 'payload' },
      'door-specific': { keys: ['argv', 'env', 'stdout', 'stderr', 'domain', 'model', 'workflow'], secrets: false },
    },
  },
};

/** What replaces a removed value inside the digested summary. */
export const AUDIT_REDACTED_VALUE = '[redacted]';

/** Below this length a caller-known secret is a common word (the floor `secret-redaction.ts` uses). */
const MIN_DOOR_SECRET_LEN = 12;
/** The bound the contract puts on `proxyUser.value`. */
const PROXY_USER_MAX = 128;
/** The reason a refusal gets when its own code cannot be kept (malformed, or secret-shaped). */
const UNSPECIFIED_REASON = 'unspecified';

declare const redacted: unique symbol;
/** A record without `v`, `seq` and `ts` that went through the seam. Only `redactAuditInput` mints one. */
export type RedactedAuditInput = Omit<AuditActionRecord, 'v' | 'seq' | 'ts'> & { readonly [redacted]: true };

export interface AuditRedactionContext {
  readonly projectId: string;
  /** The host's secret env values, every door. */
  readonly envSecrets: readonly string[];
  /** Secrets this door knows beyond the env (the MCP service's own env). */
  readonly doorSecrets: readonly string[];
}

export type AuditRedaction = { readonly ok: true; readonly input: RedactedAuditInput } | { readonly ok: false; readonly code: string };

const C0_C1 = /[ --]/gu;
const PATH_OR_URL = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\|file:)|[a-z][a-z0-9+.-]*:\/\/|^[\w.-]+@[\w.-]+:[\w./-]/i;

/**
 * Decode literal `\uXXXX` escapes before the secret check (#586 follow-up, m3): a secret typed or
 * copied as JS/JSON unicode escapes contains none of its own literal bytes, so the plain substring
 * match in `secret-redaction.ts` never sees it. Only engaged when the text actually contains `\u`,
 * so a value without one is byte-identical to what the seam already checked.
 */
function unescapeUnicodeEscapes(text: string): string {
  if (!text.includes('\\u')) return text;
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The seam. Never throws. */
export function redactAuditInput<O extends AuditOrigin>(
  origin: O,
  op: AuditedOperation<O>,
  settlement: AuditSettlement,
  context: AuditRedactionContext,
): AuditRedaction {
  try {
    return redact(origin, op, settlement, context);
  } catch {
    return { ok: false, code: 'redaction_failed' };
  }
}

function redact<O extends AuditOrigin>(
  origin: O,
  rawOp: AuditedOperation<O>,
  settlement: AuditSettlement,
  context: AuditRedactionContext,
): AuditRedaction {
  const policy = AUDIT_DOOR_POLICIES[origin];
  const rules = policy.redact;
  const op = allowedFields(rawOp, policy);
  const doorRule = rules['door-specific'];
  const doorSecrets = doorRule.secrets ? [...context.doorSecrets, ...(op.secrets ?? [])].filter((value) => value.length >= MIN_DOOR_SECRET_LEN) : [];
  const identifierRule = rules['identifier-secret'];
  // Longest first, so a value that contains another is replaced whole.
  const secrets = [...new Set([...context.envSecrets, ...doorSecrets])].sort((a, b) => b.length - a.length);
  const checked = new Set(identifierRule.identifiers);
  const clean = (field: AuditIdentifierField, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (!checked.has(field)) return value;
    if (redactSecrets(value, secrets) !== value) return undefined;
    const unescaped = unescapeUnicodeEscapes(value);
    return unescaped === value || redactSecrets(unescaped, secrets) === unescaped ? value : undefined;
  };
  const field = <K extends keyof AuditActionRecord>(key: K, value: unknown): AuditActionRecord[K] | undefined => {
    const parsed = auditActionRecordSchema.shape[key].safeParse(value);
    return parsed.success ? (parsed.data as AuditActionRecord[K]) : undefined;
  };
  const resourceOf = (resource: AuditResource | undefined): AuditResource | undefined => {
    if (!resource || clean('resource', resource.id) === undefined || clean('resource', resource.kind) === undefined) return undefined;
    return field('resource', { kind: resource.kind, id: resource.id });
  };

  const actor = actorOf(origin, op, policy, clean);
  if (!actor) return { ok: false, code: 'invalid_actor' };
  const action = clean('action', op.action);
  if (action === undefined) return { ok: false, code: 'invalid_record' };

  const config = configOf(action, op, rules['config-value']);
  const payload = op.payload === undefined ? undefined : summaryOf(op.payload, config, rules, secrets);
  const candidate: Record<string, unknown> = {
    kind: 'action',
    projectId: context.projectId,
    origin,
    actor,
    action,
    outcome:
      settlement.outcome === 'applied'
        ? { status: 'applied' }
        : {
            status: 'refused',
            reason: field('outcome', { status: 'refused', reason: clean('reason', settlement.reason) }) ? settlement.reason : UNSPECIFIED_REASON,
          },
  };
  const names = config?.fieldNames ?? op.fieldNames;
  const optional: Partial<AuditActionRecord> = {
    resource: resourceOf(settlement.resource) ?? resourceOf(op.resource),
    ownerGeneration: origin === 'mcp' ? field('ownerGeneration', fencingTokenMs(op.ownerGeneration)) : undefined,
    operationKey:
      origin === 'mcp' && op.operationId !== undefined
        ? field('operationKey', clean('operationKey', `${context.projectId}/${op.operationId}`))
        : undefined,
    versionToken: field('versionToken', clean('versionToken', op.expectedVersion)),
    fieldNames: names === undefined ? undefined : field('fieldNames', fieldNamesOf(names, (name) => clean('fieldNames', name))),
    payloadDigest: payload === undefined ? undefined : field('payloadDigest', safeDigest(payload)),
  };
  // Spread only what is present: an `undefined` key would be typed as present and dropped by
  // JSON.stringify anyway, and the read path must see exactly what was written.
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) candidate[key] = value;

  // Validated with a placeholder sequence and time, so a malformed operation is refused BEFORE the
  // lock is taken. The append path validates again with the allocated values.
  const parsed = auditActionRecordSchema.safeParse({ v: 2, seq: 1, ts: new Date(0).toISOString(), ...candidate });
  if (!parsed.success) return { ok: false, code: 'invalid_record' };
  const { v: _v, seq: _seq, ts: _ts, ...record } = parsed.data;
  return { ok: true, input: record as RedactedAuditInput };
}

/** The operation with only the fields this door may supply. */
function allowedFields<O extends AuditOrigin>(op: AuditedOperation<O>, policy: AuditDoorPolicy): AuditedOperation<O> {
  const kept: Record<string, unknown> = { action: op.action };
  for (const key of policy.operation) if (op[key] !== undefined) kept[key] = op[key];
  return kept as unknown as AuditedOperation<O>;
}

/** The actor: the door's own details from its list, then its type, which no detail can change. */
function actorOf<O extends AuditOrigin>(
  origin: O,
  op: AuditedOperation<O>,
  policy: AuditDoorPolicy,
  clean: (field: AuditIdentifierField, value: string | undefined) => string | undefined,
): Record<string, unknown> | undefined {
  const details = (op.actor ?? {}) as Record<string, unknown>;
  const actor: Record<string, unknown> = {};
  for (const key of policy.actor) {
    const value = details[key];
    if (value === undefined) continue;
    if (key === 'proxyUser') {
      const user = proxyUserOf(value, policy.redact['control-text'].proxyUser);
      const kept = user ? clean('actor.proxyUser', user.value) : undefined;
      // An asserted user that cannot be kept is omitted: the record is still the door's.
      if (user && kept !== undefined) actor.proxyUser = user;
      continue;
    }
    if (key === 'receiptId') {
      // Required for the automation actor: a receipt id that cannot be kept refuses the record.
      if (typeof value !== 'string' || clean('actor.receiptId', value) === undefined) return undefined;
    }
    actor[key] = value;
  }
  actor.type = origin;
  return actor;
}

/** § 9: trim, strip controls (the `control-text` rule), cap at 128 code units without splitting a pair, omit empty. */
export function proxyUserOf(raw: unknown, stripControls = true): AuditProxyUser | undefined {
  const value = typeof raw === 'string' ? raw : (raw as { value?: unknown } | null | undefined)?.value;
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  if (stripControls) text = text.replace(C0_C1, '').trim();
  if (text.length > PROXY_USER_MAX) {
    text = text.slice(0, PROXY_USER_MAX);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  }
  return text === '' ? undefined : { value: text, trust: 'asserted-by-proxy' };
}

interface ConfigWrite {
  readonly fieldNames: string[];
  /** Replace the body's values in the summary. */
  readonly replace: (payload: Record<string, unknown>) => Record<string, unknown>;
}

/** For a configuration write: its key names, and how to take every value out of the summary. */
function configOf(action: string, op: AuditedOperation, rule: AuditDoorPolicy['redact']['config-value']): ConfigWrite | undefined {
  if (!('actions' in rule) || !rule.actions.includes(action) || !isPlainObject(op.payload)) return undefined;
  const payload = op.payload;
  if (rule.body === 'payload') {
    return { fieldNames: Object.keys(payload), replace: (summary) => valuesOut(summary) };
  }
  const bodyKeys = rule.body.filter((key) => payload[key] !== undefined);
  if (bodyKeys.length === 0) return undefined;
  const fieldNames = bodyKeys.flatMap((key) => (isPlainObject(payload[key]) ? Object.keys(payload[key]) : [key]));
  return {
    fieldNames,
    replace: (summary) => {
      const out = { ...summary };
      for (const key of bodyKeys) out[key] = isPlainObject(payload[key]) ? valuesOut(payload[key]) : AUDIT_REDACTED_VALUE;
      return out;
    },
  };
}

/** Every value of `body` replaced; its key names kept. */
function valuesOut(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(body).map((key) => [key, AUDIT_REDACTED_VALUE]));
}

/** The payload with the door's rules applied — what the digest is taken over. */
function summaryOf(
  payload: unknown,
  config: ConfigWrite | undefined,
  rules: AuditDoorPolicy['redact'],
  secrets: readonly string[],
): unknown {
  const configRule = rules['config-value'];
  let summary = payload;
  if (config && isPlainObject(summary)) summary = config.replace(summary);
  const removed = new Set([
    ...rules['door-specific'].keys,
    ...rules['free-text'].keys,
    ...rules['path-url'].keys,
    ...('keys' in configRule ? configRule.keys : []),
  ]);
  const maskSecrets = rules['identifier-secret'].payload || rules['door-specific'].secrets;
  const leaf = (value: string): string => {
    let text = value;
    if (rules['control-text'].payload) text = text.replace(C0_C1, '');
    if (rules['path-url'].shapes && PATH_OR_URL.test(text)) return AUDIT_REDACTED_VALUE;
    if (!maskSecrets) return text;
    const masked = redactSecrets(text, secrets);
    if (masked !== text) return masked;
    // Same escape-decoding check as `clean`: a secret cannot hide from the digest as literal `\uXXXX`
    // text (m3). Once decoded there is no byte-exact substring left to mask, so the whole leaf drops.
    const unescaped = unescapeUnicodeEscapes(text);
    return unescaped !== text && redactSecrets(unescaped, secrets) !== unescaped ? AUDIT_REDACTED_VALUE : text;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return leaf(value);
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (!removed.has(key)) out[key] = walk(item);
    return out;
  };
  return walk(summary);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/**
 * The wall-clock prefix of a D-02.3 fencing token, `<ms>-<UUIDv4>` — the number D-06 § 10.2 keeps.
 * The random half is what the fence compares, so it is dropped. Anything not shaped like a token yields nothing.
 */
function fencingTokenMs(token: string | undefined): number | undefined {
  const match = token === undefined ? null : /^(\d{1,15})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(token);
  return match ? Number(match[1]) : undefined;
}

/** Plain key names only (`tags`, `maxParallel`), sorted and distinct, at most the schema's 64. */
function fieldNamesOf(names: readonly string[], clean: (value: string) => string | undefined): string[] {
  const kept = new Set<string>();
  for (const name of names) if (/^[A-Za-z_$][\w$-]{0,63}$/.test(name) && clean(name) !== undefined) kept.add(name);
  return [...kept].sort().slice(0, 64);
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
