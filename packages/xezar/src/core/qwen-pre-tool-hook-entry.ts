/**
 * The program behind a Qwen Code run's `PreToolUse` hook (#1044), bundled into
 * `scripts/qwen-pre-tool-hook.mjs` by `scripts/bundle-qwen-hook.mjs`. Qwen Code starts it once per
 * tool call with the hook payload on stdin. All policy lives in `qwen-tool-policy.ts`; this file
 * only moves bytes.
 *
 * A refusal exits with code 2 and carries its answer on stderr (and stdout). Qwen Code 0.25.2 reads
 * exit 2 as "block" and parses stderr then; text it cannot parse still blocks. With exit 0 it parses
 * stdout, and anything printed before the answer – a PowerShell profile on Windows, where the hook
 * runs in `powershell` (#1076) – turned the refusal into plain text, which Qwen Code allows.
 */
import { readFileSync } from 'node:fs';
import { decideQwenPreToolUse, parseQwenToolPolicy, qwenHookOutput, QWEN_HOOK_REFUSAL_PREFIX, QWEN_TOOL_POLICY_ENV } from './qwen-tool-policy.ts';

function main(): void {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    payload = undefined;
  }
  const policy = parseQwenToolPolicy(process.env[QWEN_TOOL_POLICY_ENV]);
  const output = qwenHookOutput(decideQwenPreToolUse(payload, policy));
  if (output) refuse(output);
}

/** Answer a refusal so Qwen Code blocks the call whatever else reached stdout. */
function refuse(output: Record<string, unknown>): void {
  const text = JSON.stringify(output);
  process.stdout.write(text);
  process.stderr.write(text);
  process.exitCode = 2;
}

try {
  main();
} catch (error: unknown) {
  // A crash must not read as "allow": answer with a denial instead.
  const reason = error instanceof Error ? error.message : String(error);
  refuse({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${QWEN_HOOK_REFUSAL_PREFIX} the tool policy hook failed (${reason}).`,
    },
  });
}
