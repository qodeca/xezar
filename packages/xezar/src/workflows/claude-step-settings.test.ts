import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeStepSettingsError,
  claudeSettingsFieldSchema,
  isRepoRelativePath,
  pinClaudeStepSettings,
  rewriteHookCommand,
  validateClaudeSettingsDoc,
  type HookCommandContext,
} from './claude-step-settings.ts';
import { skillStackOf, workflowStepSchema } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const HOOKS = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash .xezar/hooks/guard.sh', timeout: 10 }] },
    ],
  },
};

describe('claudeSettings file validation (#1001 / #936)', () => {
  it('accepts a hooks-only document', () => {
    expect(validateClaudeSettingsDoc(HOOKS, 'kit.json')).toEqual(HOOKS.hooks);
  });

  it.each(['permissions', 'sandbox', 'env', 'mcpServers', 'enabledMcpjsonServers', 'apiKeyHelper', 'disableAllHooks'])(
    'refuses a top-level "%s" key, naming it',
    (key) => {
      const doc = { ...HOOKS, [key]: key === 'permissions' ? { allow: ['Bash'] } : {} };
      expect(() => validateClaudeSettingsDoc(doc, 'kit.json')).toThrow(ClaudeStepSettingsError);
      expect(() => validateClaudeSettingsDoc(doc, 'kit.json')).toThrow(`key "${key}" is not allowed`);
      expect(() => validateClaudeSettingsDoc(doc, 'kit.json')).toThrow('"kit.json"');
    },
  );

  it('refuses unknown keys inside a hook, naming the key path', () => {
    const doc = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true', env: { A: '1' } }] }] },
    };
    expect(() => validateClaudeSettingsDoc(doc, 'kit.json')).toThrow('key "hooks.PreToolUse[0].hooks[0].env" is not allowed');
  });

  it('refuses a hook that is not a command hook', () => {
    const doc = { hooks: { Stop: [{ hooks: [{ type: 'prompt', command: 'x' }] }] } };
    expect(() => validateClaudeSettingsDoc(doc, 'kit.json')).toThrow('"hooks.Stop[0].hooks[0].type" must be "command"');
  });

  it('refuses a document that is not an object', () => {
    expect(() => validateClaudeSettingsDoc([], 'kit.json')).toThrow('must be a JSON object');
  });
});

describe('hook command pinning is strict (#1001)', () => {
  const ctx = (exists: string[] = []): HookCommandContext => ({
    scripts: new Map([['.xezar/hooks/guard.sh', '/pin/abc/scripts/.xezar/hooks/guard.sh']]),
    existsInRepo: (rel) => exists.includes(rel),
    protectedRoots: ['/repo', '/repo/.local/xezar/worktrees/run-1'],
  });

  it('rewrites a listed script to its pinned copy', () => {
    expect(rewriteHookCommand('bash .xezar/hooks/guard.sh --strict', 'h', ctx())).toBe(
      "bash '/pin/abc/scripts/.xezar/hooks/guard.sh' --strict",
    );
    expect(rewriteHookCommand('./.xezar/hooks/guard.sh', 'h', ctx())).toBe("'/pin/abc/scripts/.xezar/hooks/guard.sh'");
    expect(rewriteHookCommand('"$CLAUDE_PROJECT_DIR"/.xezar/hooks/guard.sh', 'h', ctx())).toBe(
      "'/pin/abc/scripts/.xezar/hooks/guard.sh'",
    );
  });

  it('keeps a redirect to an absolute path outside the checkout', () => {
    expect(rewriteHookCommand('bash .xezar/hooks/guard.sh 2>/dev/null', 'h', ctx())).toBe(
      "bash '/pin/abc/scripts/.xezar/hooks/guard.sh' 2>/dev/null",
    );
    expect(rewriteHookCommand('cat|.xezar/hooks/guard.sh', 'h', ctx())).toBe("cat|'/pin/abc/scripts/.xezar/hooks/guard.sh'");
  });

  it.each([
    ['an unlisted repo path', 'bash .xezar/hooks/other.sh'],
    ['an unlisted $CLAUDE_PROJECT_DIR path', '$CLAUDE_PROJECT_DIR/.xezar/hooks/other.sh'],
    ['an absolute path inside the checkout', 'bash /repo/.xezar/hooks/guard.sh'],
    ['a parent-directory escape', 'bash ..'],
    ['a repo path glued to an absolute path with an operator', 'bash /bin/true;.xezar/hooks/other.sh'],
    ['a repo path behind a pipe with no spaces', 'echo x|.xezar/hooks/other.sh'],
  ])('refuses %s', (_label, command) => {
    expect(() => rewriteHookCommand(command, 'h', ctx())).toThrow('not listed in claudeSettings.scripts');
  });

  it('refuses a bare name that exists in the repository', () => {
    expect(() => rewriteHookCommand('bash guard.sh', 'h', ctx(['guard.sh']))).toThrow('"guard.sh" names a repository file');
    expect(rewriteHookCommand('bash guard.sh', 'h', ctx())).toBe('bash guard.sh');
  });

  it('refuses shell expansion other than the project-dir prefix', () => {
    expect(() => rewriteHookCommand('bash $HOME/x.sh', 'h', ctx())).toThrow('uses shell expansion');
    expect(() => rewriteHookCommand('bash `which guard`', 'h', ctx())).toThrow('uses shell expansion');
    expect(() => rewriteHookCommand('bash $(cat x)', 'h', ctx())).toThrow('uses shell expansion');
  });
});

describe('claudeSettings step field', () => {
  it('accepts repo-relative paths on an agent step', () => {
    const step = workflowStepSchema.parse({
      id: 'review',
      prompt: '{{task}}',
      claudeSettings: { files: ['.xezar/claude/hooks.json'], scripts: ['.xezar/hooks/guard.sh'] },
    });
    expect(step.claudeSettings?.files).toEqual(['.xezar/claude/hooks.json']);
    expect(skillStackOf([{ ...step, skill: 'x', prompt: '{{task}}', name: 'x' }])).toBeNull();
  });

  it.each(['/etc/hooks.json', '../hooks.json', 'a/../b.json', './hooks.json', 'C:/hooks.json', 'a\\b.json', '', '-x'])(
    'refuses the path %j',
    (path) => {
      expect(isRepoRelativePath(path)).toBe(false);
      expect(claudeSettingsFieldSchema.safeParse({ files: [path] }).success).toBe(false);
    },
  );

  it('refuses unknown keys and an empty file list', () => {
    expect(claudeSettingsFieldSchema.safeParse({ files: [] }).success).toBe(false);
    expect(claudeSettingsFieldSchema.safeParse({ files: ['a.json'], inline: {} }).success).toBe(false);
  });

  it('refuses claudeSettings on a check step', () => {
    const parsed = workflowStepSchema.safeParse({ id: 'c', command: 'true', claudeSettings: { files: ['a.json'] } });
    expect(parsed.success).toBe(false);
  });
});

describe('pinClaudeStepSettings reads the base commit (#936)', () => {
  let repoRoot: string;
  let dataDir: string;

  const write = (rel: string, content: string) => {
    mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
    writeFileSync(join(repoRoot, rel), content);
  };
  const commit = async (message: string) => {
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', message], { cwd: repoRoot });
  };
  const field = { files: ['.xezar/claude/hooks.json'], scripts: ['.xezar/hooks/guard.sh'] };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'xez-claude-settings-'));
    dataDir = join(repoRoot, '.local/xezar');
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    write('.xezar/claude/hooks.json', JSON.stringify(HOOKS));
    write('.xezar/hooks/guard.sh', '#!/bin/sh\necho base-guard\n');
    chmodSync(join(repoRoot, '.xezar/hooks/guard.sh'), 0o755);
    await commit('base');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('pins the hooks and scripts from the base commit and rewrites the command', async () => {
    const settings = await pinClaudeStepSettings({ field, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir });
    expect(settings.startsWith(join(dataDir, 'claude-settings'))).toBe(true);
    const doc = JSON.parse(readFileSync(settings, 'utf8')) as typeof HOOKS;
    expect(Object.keys(doc)).toEqual(['hooks']);
    const command = doc.hooks.PreToolUse[0]!.hooks[0]!.command;
    const pinnedScript = join(settings, '..', 'scripts', '.xezar', 'hooks', 'guard.sh');
    expect(command).toBe(`bash '${pinnedScript}'`);
    expect(readFileSync(pinnedScript, 'utf8')).toBe('#!/bin/sh\necho base-guard\n');
    expect(doc.hooks.PreToolUse[0]!.hooks[0]!.timeout).toBe(10);
  });

  it('a change under review to the hook file or its script does not change the pinned hook', async () => {
    // The review branch edits both files, commits, and leaves a further uncommitted edit.
    await run('git', ['checkout', '-q', '-b', 'pr'], { cwd: repoRoot });
    const widened = {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'echo allow-all' }] }] },
    };
    write('.xezar/claude/hooks.json', JSON.stringify(widened));
    write('.xezar/hooks/guard.sh', '#!/bin/sh\necho pr-guard\n');
    await commit('pr edits the guard');
    write('.xezar/hooks/guard.sh', '#!/bin/sh\necho dirty-guard\n');

    const settings = await pinClaudeStepSettings({ field, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir });
    const doc = JSON.parse(readFileSync(settings, 'utf8')) as typeof HOOKS;
    expect(doc.hooks.PreToolUse[0]!.matcher).toBe('Bash');
    expect(doc.hooks.PreToolUse[0]!.hooks[0]!.command).toContain('guard.sh');
    const pinnedScript = join(settings, '..', 'scripts', '.xezar', 'hooks', 'guard.sh');
    expect(readFileSync(pinnedScript, 'utf8')).toBe('#!/bin/sh\necho base-guard\n');
  });

  it('puts a tampered pinned copy back on the next pin', async () => {
    const settings = await pinClaudeStepSettings({ field, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir });
    const pinnedScript = join(settings, '..', 'scripts', '.xezar', 'hooks', 'guard.sh');
    writeFileSync(pinnedScript, 'tampered');
    await pinClaudeStepSettings({ field, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir });
    expect(readFileSync(pinnedScript, 'utf8')).toBe('#!/bin/sh\necho base-guard\n');
    expect(statSync(pinnedScript).isFile()).toBe(true);
  });

  it('refuses a settings file with a permission key, naming the key', async () => {
    write('.xezar/claude/hooks.json', JSON.stringify({ ...HOOKS, permissions: { allow: ['Bash(curl:*)'] } }));
    await commit('widen');
    await expect(pinClaudeStepSettings({ field, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir })).rejects.toThrow(
      'key "permissions" is not allowed',
    );
  });

  it('refuses a hook command that runs an unlisted repository script', async () => {
    await expect(
      pinClaudeStepSettings({ field: { files: field.files }, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir }),
    ).rejects.toThrow('".xezar/hooks/guard.sh" names a repository file that is not listed');
  });

  it('refuses a file that exists only in the working copy, not at the base commit', async () => {
    write('.xezar/claude/new.json', JSON.stringify(HOOKS));
    await expect(
      pinClaudeStepSettings({ field: { ...field, files: ['.xezar/claude/new.json'] }, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir }),
    ).rejects.toThrow('is not a file at the run\'s base commit');
  });

  // win32-skip(#973): creating a file symlink needs Developer Mode or elevation (EPERM)
  it.skipIf(process.platform === 'win32')('refuses a symlinked script', async () => {
    symlinkSync('guard.sh', join(repoRoot, '.xezar/hooks/link.sh'));
    await commit('link');
    await expect(
      pinClaudeStepSettings({ field: { ...field, scripts: ['.xezar/hooks/link.sh', '.xezar/hooks/guard.sh'] }, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir }),
    ).rejects.toThrow('must be a regular file');
  });

  it('refuses invalid JSON and a run with no base', async () => {
    write('.xezar/claude/hooks.json', '{ not json');
    await commit('broken');
    await expect(pinClaudeStepSettings({ field, repoRoot, baseRef: 'main', cwd: repoRoot, dataDir })).rejects.toThrow('not valid JSON');
    await expect(pinClaudeStepSettings({ field, repoRoot, baseRef: undefined, cwd: repoRoot, dataDir })).rejects.toThrow(
      'needs the run\'s Git base commit',
    );
    await expect(pinClaudeStepSettings({ field, repoRoot, baseRef: '--output=x', cwd: repoRoot, dataDir })).rejects.toThrow(
      'needs the run\'s Git base commit',
    );
  });
});
