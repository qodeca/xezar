import { readFileSync } from 'node:fs';
import {
  CODEX_READ_ONLY_ALLOWLIST_ENV,
  CODEX_READ_ONLY_RUN_ENV,
  codexHookOutput,
  decideCodexPreToolUse,
} from './codex-read-only-hook.ts';

async function main(): Promise<void> {
  // The profile entry is persistent, so an ordinary Codex session also invokes it. Only a
  // xezar-spawned locked run activates the policy; every other session gets no output (#863 S2).
  if (process.env[CODEX_READ_ONLY_RUN_ENV] !== 'locked') return;

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = undefined;
  }

  let entries: string[] = [];
  try {
    const encoded = process.env[CODEX_READ_ONLY_ALLOWLIST_ENV];
    const parsed: unknown = encoded === undefined ? undefined : JSON.parse(encoded);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) entries = parsed;
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
