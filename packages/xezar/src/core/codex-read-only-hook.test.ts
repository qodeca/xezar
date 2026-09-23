import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_READ_ONLY_RUN_ENV,
  codexHookOutput,
  decideCodexPreToolUse,
} from './codex-read-only-hook.ts';
import { CODEX_READ_ONLY_HOOK_FIXTURES } from './codex-read-only-hook.testkit.ts';
import { READ_ONLY_LOCK_FIXTURES } from './read-only-lock.testkit.ts';

describe('Codex PreToolUse adapter for the shared read-only lock (#863 S2)', () => {
  const sourceHook = fileURLToPath(new URL('../../scripts/codex-read-only-hook.mjs', import.meta.url));
  let hookDir: string;
  let hook: string;

  beforeEach(() => {
    hookDir = mkdtempSync(join(tmpdir(), 'xez-codex-hook-test-'));
    hook = join(hookDir, 'codex-read-only-hook.mjs');
    copyFileSync(sourceHook, hook);
  });

  afterEach(() => {
    rmSync(hookDir, { recursive: true, force: true });
  });

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

  it('is inert outside xezar but fails closed when a matching locked run loses its environment', () => {
    const sessionId = 'th_locked_without_environment';
    const cwd = process.cwd();
    const locks = join(dirname(hook), 'locks');
    const lock = join(locks, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    const payload = JSON.stringify({
      session_id: sessionId,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    const outside = spawnSync(process.execPath, [hook, '--xezar-read-only-hook'], {
      input: JSON.stringify({ ...JSON.parse(payload), session_id: 'th_interactive' }),
      encoding: 'utf8',
      env: {},
    });
    expect(outside).toMatchObject({ status: 0, stdout: '', stderr: '' });

    mkdirSync(locks, { recursive: true });
    const createdAt = Date.now();
    writeFileSync(lock, `${JSON.stringify({ version: 1, sessionId, cwd, createdAt, expiresAt: createdAt + 60_000 })}\n`);
    try {
      const stripped = spawnSync(process.execPath, [hook, '--xezar-read-only-hook'], {
        input: payload,
        encoding: 'utf8',
        env: {},
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
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it('ignores and removes an expired lock record', () => {
    const sessionId = 'th_expired_lock';
    const cwd = process.cwd();
    const locks = join(dirname(hook), 'locks');
    const lock = join(locks, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    mkdirSync(locks, { recursive: true });
    writeFileSync(lock, `${JSON.stringify({
      version: 1,
      sessionId,
      cwd,
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    })}\n`);

    const expired = spawnSync(process.execPath, [hook, '--xezar-read-only-hook'], {
      input: JSON.stringify({ session_id: sessionId, cwd, tool_name: 'Bash', tool_input: { command: 'git status' } }),
      encoding: 'utf8',
      env: {},
    });
    expect(expired).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(() => readFileSync(lock)).toThrow();
  });

  it('denies on a live mismatched lock record without deleting it', () => {
    const sessionId = 'th_live_mismatch';
    const cwd = process.cwd();
    const locks = join(dirname(hook), 'locks');
    const lock = join(locks, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    mkdirSync(locks, { recursive: true });
    const createdAt = Date.now();
    writeFileSync(lock, `${JSON.stringify({
      version: 1,
      sessionId,
      cwd,
      createdAt,
      expiresAt: createdAt + 60_000,
    })}\n`);

    const mismatched = spawnSync(process.execPath, [hook, '--xezar-read-only-hook'], {
      input: JSON.stringify({
        session_id: sessionId,
        cwd: dirname(cwd),
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      }),
      encoding: 'utf8',
      env: {},
    });
    expect(mismatched.status).toBe(0);
    expect(mismatched.stderr).toBe('');
    expect(JSON.parse(mismatched.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('Rule prefix.entry'),
      },
    });
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ sessionId, cwd });
  });
});
