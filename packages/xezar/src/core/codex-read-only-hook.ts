import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { decideReadOnlyShellCall, type ReadOnlyCommandDecision } from './read-only-lock.ts';

/** Internal child-only transport; the leading underscores keep it outside host env passthrough. */
export const CODEX_READ_ONLY_ALLOWLIST_ENV = '__XEZAR_CODEX_READ_ONLY_ALLOWLIST';
/** Separates an ordinary session from a locked xezar run whose allowlist may have been stripped. */
export const CODEX_READ_ONLY_RUN_ENV = '__XEZAR_CODEX_READ_ONLY_RUN';
export const CODEX_READ_ONLY_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface CodexPreToolUsePayload {
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: { readonly command?: unknown } | unknown;
}

export interface CodexReadOnlyLockRecord {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function codexReadOnlyLockPath(hookScript: string, sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex');
  return join(dirname(hookScript), 'locks', `${key}.json`);
}

export type CodexReadOnlyLockState = 'active' | 'live-mismatch' | 'expired-or-malformed';

export function codexReadOnlyLockState(
  payload: unknown,
  record: unknown,
  now = Date.now(),
): CodexReadOnlyLockState {
  const input = payload && typeof payload === 'object' ? payload as CodexPreToolUsePayload : {};
  if (!record || typeof record !== 'object') return 'expired-or-malformed';
  const lock = record as Partial<CodexReadOnlyLockRecord>;
  const validRecord = lock.version === 1
    && typeof lock.sessionId === 'string'
    && typeof lock.cwd === 'string'
    && typeof lock.createdAt === 'number'
    && Number.isFinite(lock.createdAt)
    && typeof lock.expiresAt === 'number'
    && Number.isFinite(lock.expiresAt)
    && lock.createdAt <= now
    && lock.expiresAt > now
    && lock.expiresAt - lock.createdAt <= CODEX_READ_ONLY_LOCK_MAX_AGE_MS;
  if (!validRecord) return 'expired-or-malformed';
  return typeof input.session_id === 'string'
    && lock.sessionId === input.session_id
    && typeof input.cwd === 'string'
    && lock.cwd === input.cwd
    ? 'active'
    : 'live-mismatch';
}

export function activeCodexReadOnlyLock(payload: unknown, record: unknown, now = Date.now()): boolean {
  return codexReadOnlyLockState(payload, record, now) === 'active';
}

export interface CodexHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'deny';
    readonly permissionDecisionReason: string;
  };
}

/** Codex-only shape adaptation. The shared module makes every allow/deny decision. */
export function decideCodexPreToolUse(
  payload: unknown,
  entries: readonly string[],
): ReadOnlyCommandDecision {
  const record = payload && typeof payload === 'object' ? payload as CodexPreToolUsePayload : {};
  const toolInput = record.tool_input && typeof record.tool_input === 'object'
    ? record.tool_input as { readonly command?: unknown }
    : {};
  return decideReadOnlyShellCall({ toolName: record.tool_name, command: toolInput.command }, entries);
}

/** No stdout means allow; a denial uses Codex's documented PreToolUse response shape. */
export function codexHookOutput(decision: ReadOnlyCommandDecision): CodexHookOutput | undefined {
  if (decision.allowed) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
}
