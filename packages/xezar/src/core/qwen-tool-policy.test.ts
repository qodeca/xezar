/**
 * The Qwen Code tool policy (#1044 §3): which tools a step offers, and what the `PreToolUse` hook
 * decides for each call. The shell decision itself is `read-only-lock.ts`, pinned by its own
 * tests; this file pins how Qwen's tool names and payloads reach it.
 */
import { describe, expect, it } from 'vitest';
import {
  QWEN_HOOK_REFUSAL_PREFIX,
  decideQwenPreToolUse,
  parseQwenToolPolicy,
  qwenAllowedTools,
  qwenHookOutput,
  qwenToolPolicy,
} from './qwen-tool-policy.ts';

const READ_ONLY = ['Read', 'Grep', 'Glob', 'Bash'];
const call = (tool_name: string, tool_input: unknown) => ({ tool_name, tool_input });
const shell = (command: string) => call('run_shell_command', { command });

describe('qwenToolPolicy', () => {
  it('needs no hook on a writing step with a free shell', () => {
    expect(qwenToolPolicy(['Read', 'Edit', 'Write', 'Bash'], undefined, 'linux')).toBeUndefined();
  });

  it('turns the shell off when Bash is not listed, and when no list exists', () => {
    expect(qwenToolPolicy(['Read'], undefined, 'linux')?.bash).toEqual({ mode: 'off' });
    // No list grants no shell, as on Claude Code, where `dontAsk` with no `--allowedTools` denies Bash.
    expect(qwenToolPolicy(undefined, undefined, 'linux')?.bash).toEqual({ mode: 'off' });
  });

  it('reads a shell command the PowerShell way on Windows', () => {
    expect(qwenToolPolicy(READ_ONLY, ['git status'], 'win32')?.dialect).toBe('powershell');
    expect(qwenToolPolicy(READ_ONLY, ['git status'], 'linux')?.dialect).toBe('posix');
  });

  it('survives the trip through the environment, and refuses a damaged copy', () => {
    const policy = qwenToolPolicy(READ_ONLY, ['git status'], 'linux');
    expect(parseQwenToolPolicy(JSON.stringify(policy))).toEqual(policy);
    expect(parseQwenToolPolicy('{not json')).toBeUndefined();
    expect(parseQwenToolPolicy(undefined)).toBeUndefined();
  });
});

describe('qwenAllowedTools', () => {
  it('names the tools in Qwen Code\'s own spelling', () => {
    expect(qwenAllowedTools(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'])).toEqual(
      ['read_file', 'edit', 'write_file', 'run_shell_command', 'grep_search', 'glob'],
    );
  });

  it('never offers a file writer on a read-only step, and no shell for an empty allowlist', () => {
    expect(qwenAllowedTools(READ_ONLY, ['git status'])).toEqual(['read_file', 'grep_search', 'glob', 'run_shell_command(git status)']);
    expect(qwenAllowedTools(READ_ONLY, []).some((tool) => tool.startsWith('run_shell_command'))).toBe(false);
  });

  it('gives an allowlisted shell one Qwen Code rule per entry and never the bare name, so a dead hook unlocks nothing', () => {
    // Qwen Code 0.25.2 lets a call through when its hook cannot run; a bare `run_shell_command`
    // would then allow every command. Per-entry rules are Qwen Code's own second lock.
    const tools = qwenAllowedTools(['Read', 'Edit', 'Write', 'Bash'], [' git status ', 'npm test', 'f(x)', 'ls *', '']);
    expect(tools).toEqual(['read_file', 'edit', 'write_file', 'run_shell_command(git status)', 'run_shell_command(npm test)']);
    expect(tools).not.toContain('run_shell_command');
    expect(qwenAllowedTools(['Read', 'Bash'])).toContain('run_shell_command');
  });
});

describe('decideQwenPreToolUse on a read-only step with an allowlist', () => {
  const policy = qwenToolPolicy(READ_ONLY, ['git status', 'git diff'], 'linux');

  it('allows a command inside the allowlist and a reading tool', () => {
    expect(decideQwenPreToolUse(shell('git status'), policy, 'linux')).toEqual({ allowed: true });
    expect(decideQwenPreToolUse(call('read_file', { file_path: 'a.ts' }), policy, 'linux')).toEqual({ allowed: true });
  });

  it('refuses a command outside the allowlist, a compound and a redirect, and says not to retry', () => {
    for (const command of ['touch hacked.txt', 'git status; rm -rf x', 'git diff > out.txt', 'sed -i s/a/b/ notes.txt']) {
      const decision = decideQwenPreToolUse(shell(command), policy, 'linux');
      expect(decision.allowed, command).toBe(false);
      if (!decision.allowed) expect(decision.reason).toMatch(/Do not retry/);
    }
  });

  it('refuses every file writer by name, also behind the tool_call bridge', () => {
    for (const name of ['edit', 'write_file', 'notebook_edit']) {
      expect(decideQwenPreToolUse(call(name, { file_path: 'a.ts' }), policy, 'linux').allowed).toBe(false);
      expect(decideQwenPreToolUse(call('tool_call', { name, arguments: { file_path: 'a.ts' } }), policy, 'linux').allowed).toBe(false);
    }
  });

  it('decides the command a bridged shell call carries', () => {
    expect(decideQwenPreToolUse(call('tool_call', { name: 'run_shell_command', arguments: { command: 'git status' } }), policy, 'linux')).toEqual({ allowed: true });
    expect(decideQwenPreToolUse(call('tool_call', { name: 'run_shell_command', arguments: { command: 'rm -rf .' } }), policy, 'linux').allowed).toBe(false);
  });

  it('refuses the raw code executor and an unknown tool', () => {
    expect(decideQwenPreToolUse(call('exec', { code: 'x' }), policy, 'linux').allowed).toBe(false);
    expect(decideQwenPreToolUse(call('some_new_writer', {}), policy, 'linux').allowed).toBe(false);
  });
});

describe('decideQwenPreToolUse fails closed', () => {
  it('refuses every call when the run passed no policy', () => {
    expect(decideQwenPreToolUse(shell('git status'), undefined, 'linux').allowed).toBe(false);
    expect(decideQwenPreToolUse(call('read_file', {}), undefined, 'linux').allowed).toBe(false);
  });

  it('refuses a payload that names no tool', () => {
    const policy = qwenToolPolicy(READ_ONLY, ['git status'], 'linux');
    expect(decideQwenPreToolUse({}, policy, 'linux').allowed).toBe(false);
    expect(decideQwenPreToolUse(null, policy, 'linux').allowed).toBe(false);
    expect(decideQwenPreToolUse(call('tool_call', { arguments: {} }), policy, 'linux').allowed).toBe(false);
  });

  it('refuses the shell on a step that does not list Bash', () => {
    const policy = qwenToolPolicy(['Read', 'Edit', 'Write'], undefined, 'linux');
    expect(decideQwenPreToolUse(shell('ls'), policy, 'linux').allowed).toBe(false);
    expect(decideQwenPreToolUse(call('edit', { file_path: 'a.ts' }), policy, 'linux')).toEqual({ allowed: true });
  });
});

describe('qwenHookOutput', () => {
  it('says nothing for an allowed call, and blocks a refused one with the shipped prefix', () => {
    expect(qwenHookOutput({ allowed: true })).toBeUndefined();
    const refused = decideQwenPreToolUse(call('edit', {}), qwenToolPolicy(READ_ONLY, ['git status'], 'linux'), 'linux');
    expect(qwenHookOutput(refused)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(new RegExp(`^${QWEN_HOOK_REFUSAL_PREFIX}`)) },
    });
  });
});
