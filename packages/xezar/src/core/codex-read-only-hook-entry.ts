import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CODEX_READ_ONLY_ALLOWLIST_ENV,
  CODEX_READ_ONLY_RUN_ENV,
  codexReadOnlyLockPath,
  codexReadOnlyLockState,
  codexHookOutput,
  decideCodexPreToolUse,
} from './codex-read-only-hook.ts';

async function main(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = undefined;
  }

  // The environment is the fast path; the bounded session record keeps a xezar run fail-closed
  // if Codex stops forwarding that environment to hook processes. Other sessions stay inert.
  const marked = process.env[CODEX_READ_ONLY_RUN_ENV] === 'locked';
  if (!marked) {
    const sessionId = payload && typeof payload === 'object'
      ? (payload as { session_id?: unknown }).session_id
      : undefined;
    if (typeof sessionId !== 'string') return;
    const lockPath = codexReadOnlyLockPath(fileURLToPath(import.meta.url), sessionId);
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      return;
    }
    const normalizedPayload = payload && typeof payload === 'object' && typeof (payload as { cwd?: unknown }).cwd === 'string'
      ? { ...payload, cwd: realpathSync((payload as { cwd: string }).cwd) }
      : payload;
    const lockState = codexReadOnlyLockState(normalizedPayload, record);
    if (lockState === 'expired-or-malformed') {
      try {
        unlinkSync(lockPath);
      } catch {
        // An expired record is already inert; cleanup is best effort.
      }
      return;
    }
    // A live record belongs to a locked xezar run. If its payload no longer matches, keep the
    // record and fail closed below rather than turning every later hook call into an inert one.
  }

  let entries: string[] = [];
  try {
    const encoded = process.env[CODEX_READ_ONLY_ALLOWLIST_ENV];
    const parsed: unknown = encoded === undefined ? undefined : JSON.parse(encoded);
    if (marked && Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) entries = parsed;
  } catch {
    // A locked xezar run with a stripped or malformed allowlist fails closed: the shared policy
    // receives an empty list, which cannot allow a shell command.
  }

  const output = codexHookOutput(decideCodexPreToolUse(payload, entries));
  if (output) process.stdout.write(JSON.stringify(output));
}

main().catch((error: unknown) => {
  // Codex hooks otherwise fail open on an adapter crash. Emit a valid denial instead.
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Rule hook.adapter refused the command: the read-only hook could not start (${reason}).`,
    },
  }));
});
