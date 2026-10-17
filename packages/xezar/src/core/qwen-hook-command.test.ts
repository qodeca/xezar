/**
 * #1076, Qwen Code's half: the read-only lock hook must START on every platform, because Qwen Code
 * 0.25.2 lets a call through when its hook cannot run.
 *
 * On Windows Qwen Code's default hook shell is `cmd.exe /d /s /c`, and it passes the command line
 * through Node's argument quoting, which turns each `"` into `\"`. cmd.exe does not treat `\` as an
 * escape, so the double-quoted line named a program that does not exist and the hook never ran –
 * the same class as the Codex hook's POSIX quoting. These cases pin the line and the shell Qwen Code
 * is told to use, and that a refusal still blocks when something else printed first.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { qwenHookCommand, qwenSystemSettings } from './qwen-run-config.ts';
import { QWEN_TOOL_POLICY_ENV, qwenToolPolicy } from './qwen-tool-policy.ts';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'qwen-pre-tool-hook.mjs');

describe('qwenHookCommand (#1076)', () => {
  it('on Windows asks for the PowerShell hook shell and makes a call with no double quote for Node to escape', () => {
    const hook = qwenHookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Jo O\'Neil\\x\\qwen-pre-tool-hook.mjs', 'win32');
    expect(hook).toEqual({
      command: "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Jo O''Neil\\x\\qwen-pre-tool-hook.mjs'",
      shell: 'powershell',
    });
    expect(hook?.command).not.toContain('"');
  });

  it('keeps the double-quoted line for bash on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(qwenHookCommand('/usr/local/bin/node', '/opt/x y/qwen-pre-tool-hook.mjs', platform)).toEqual({
        command: '"/usr/local/bin/node" "/opt/x y/qwen-pre-tool-hook.mjs"',
      });
    }
  });

  it('refuses a path with a double quote on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(qwenHookCommand('/a"b/node', '/hook.mjs', platform)).toBeUndefined();
    }
  });

  it('writes the shell into the run settings only when it has one', () => {
    const settingsFor = (platform: NodeJS.Platform) => {
      const hookCommand = qwenHookCommand('node', 'hook.mjs', platform)!;
      const { settings } = qwenSystemSettings({ basePath: join('no', 'such', 'settings.json'), excludedEnvNames: [], hookCommand, usageStatistics: false });
      return (settings.hooks as { PreToolUse: { hooks: Record<string, unknown>[] }[] }).PreToolUse.at(-1)!.hooks[0];
    };
    expect(settingsFor('win32')).toEqual({ type: 'command', command: "& 'node' 'hook.mjs'", shell: 'powershell' });
    expect(settingsFor('linux')).toEqual({ type: 'command', command: '"node" "hook.mjs"' });
  });
});

describe('the bundled hook program (#1076)', () => {
  const runHook = (payload: unknown) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, [QWEN_TOOL_POLICY_ENV]: JSON.stringify(qwenToolPolicy(['Read', 'Bash'], ['git status'], 'linux')) },
  });

  it('refuses with exit 2 and the answer on stderr, so text printed before it cannot turn it into "allow"', () => {
    const result = runHook({ tool_name: 'write_file', tool_input: { file_path: 'leak.txt', content: 'x' } });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  // Guard that passes both ways: an allowed call stays a silent exit 0.
  it('allows an allowlisted command with exit 0 and no output', () => {
    const result = runHook({ tool_name: 'run_shell_command', tool_input: { command: 'git status' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
