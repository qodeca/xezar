/**
 * The program behind a Qwen Code run's `PreToolUse` hook (#1044), bundled into
 * `scripts/qwen-pre-tool-hook.mjs` by `scripts/bundle-qwen-hook.mjs`. Qwen Code starts it once per
 * tool call with the hook payload on stdin; it answers on stdout. All policy lives in
 * `qwen-tool-policy.ts`; this file only moves bytes.
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
  if (output) process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch (error: unknown) {
  // A crash must not read as "allow": answer with a denial instead.
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${QWEN_HOOK_REFUSAL_PREFIX} the tool policy hook failed (${reason}).`,
    },
  }));
}
