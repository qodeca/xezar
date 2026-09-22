import { describe, expect, it } from 'vitest';
import { codexHookOutput, decideCodexPreToolUse } from './codex-read-only-hook.ts';
import { CODEX_READ_ONLY_HOOK_FIXTURES } from './codex-read-only-hook.testkit.ts';
import { READ_ONLY_LOCK_FIXTURES } from './read-only-lock.testkit.ts';

describe('Codex PreToolUse adapter for the shared read-only lock (#863 S2)', () => {
  it.each(CODEX_READ_ONLY_HOOK_FIXTURES)('matches the shared fixture: $name', ({ payload, entries, rule }) => {
    const decision = decideCodexPreToolUse(payload, entries);
    if (rule === undefined) {
      expect(decision).toEqual({ allowed: true });
      expect(codexHookOutput(decision)).toBeUndefined();
    } else {
      expect(decision).toMatchObject({ allowed: false, rule });
      expect(codexHookOutput(decision)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining(`Rule ${rule}`),
        },
      });
    }
  });

  it('has a Codex payload fixture for every shared refusal reason code', () => {
    const sharedRules = new Set(READ_ONLY_LOCK_FIXTURES.flatMap((fixture) => fixture.rule ? [fixture.rule] : []));
    const codexRules = new Set(CODEX_READ_ONLY_HOOK_FIXTURES.flatMap((fixture) => fixture.rule ? [fixture.rule] : []));
    expect([...sharedRules].filter((rule) => !codexRules.has(rule))).toEqual([]);
  });
});
