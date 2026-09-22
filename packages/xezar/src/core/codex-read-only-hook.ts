import { decideReadOnlyShellCall, type ReadOnlyCommandDecision } from './read-only-lock.ts';

/** Internal child-only transport; the leading underscores keep it outside host env passthrough. */
export const CODEX_READ_ONLY_ALLOWLIST_ENV = '__XEZAR_CODEX_READ_ONLY_ALLOWLIST';
/** Separates an ordinary session from a locked xezar run whose allowlist may have been stripped. */
export const CODEX_READ_ONLY_RUN_ENV = '__XEZAR_CODEX_READ_ONLY_RUN';

export interface CodexPreToolUsePayload {
  readonly tool_name?: unknown;
  readonly tool_input?: { readonly command?: unknown } | unknown;
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
