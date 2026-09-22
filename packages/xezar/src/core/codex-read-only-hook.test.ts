import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_READ_ONLY_RUN_ENV,
  codexHookOutput,
  decideCodexPreToolUse,
} from './codex-read-only-hook.ts';
import { CODEX_READ_ONLY_HOOK_FIXTURES } from './codex-read-only-hook.testkit.ts';
import { READ_ONLY_LOCK_FIXTURES } from './read-only-lock.testkit.ts';

describe('Codex PreToolUse adapter for the shared read-only lock (#863 S2)', () => {
  const hook = fileURLToPath(new URL('../../scripts/codex-read-only-hook.mjs', import.meta.url));

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

  it('is inert outside xezar but fails closed when a locked run loses its allowlist', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    const outside = spawnSync(process.execPath, [hook, '--xezar-read-only-hook'], {
      input: payload,
      encoding: 'utf8',
      env: {},
    });
    expect(outside).toMatchObject({ status: 0, stdout: '', stderr: '' });

    const stripped = spawnSync(process.execPath, [hook, '--xezar-read-only-hook'], {
      input: payload,
      encoding: 'utf8',
      env: { [CODEX_READ_ONLY_RUN_ENV]: 'locked' },
    });
    expect(stripped.status).toBe(0);
    expect(stripped.stderr).toBe('');
    expect(JSON.parse(stripped.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Rule prefix.entry'),
      },
    });
  });
});
