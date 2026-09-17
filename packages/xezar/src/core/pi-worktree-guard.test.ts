import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import extension, { __internals } from '../../scripts/pi-worktree-guard.ts';

const roots: string[] = [];

function fixture(): { primary: string; worktree: string; outside: string } {
  const primary = mkdtempSync(join(tmpdir(), 'xez-pi-guard-primary-'));
  roots.push(primary);
  const worktree = join(primary, '.local', 'xezar', 'worktrees', 'task');
  const outside = mkdtempSync(join(tmpdir(), 'xez-pi-guard-outside-'));
  roots.push(outside);
  mkdirSync(join(primary, '.git', 'worktrees', 'task'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'task')}\n`);
  return { primary, worktree, outside };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pi linked-worktree tool guard (#537)', () => {
  it('allows relative writes inside the worktree', () => {
    const { worktree } = fixture();
    expect(__internals.guardToolCall(worktree, worktree, { toolName: 'write', input: { path: 'notes.md' } })).toBeUndefined();
  });

  it('resolves a relative linked-worktree gitdir from the worktree root', () => {
    const { primary, worktree } = fixture();
    const gitDir = join(primary, '.git', 'worktrees', 'task');
    writeFileSync(join(worktree, '.git'), `gitdir: ${relative(worktree, gitDir)}\n`);
    expect(__internals.guardToolCall(worktree, worktree, { toolName: 'write', input: { path: 'notes.md' } })).toBeUndefined();
  });

  it('blocks absolute writes into the primary checkout', () => {
    const { primary, worktree } = fixture();
    expect(__internals.guardToolCall(worktree, worktree, { toolName: 'edit', input: { path: join(primary, 'tracked.md') } }))
      .toMatchObject({ block: true });
  });

  it('blocks a relative .. escape', () => {
    const { worktree } = fixture();
    const escape = relative(worktree, join(dirname(worktree), 'peer', 'tracked.md'));
    expect(__internals.guardToolCall(worktree, worktree, { toolName: 'write', input: { path: escape } }))
      .toMatchObject({ block: true });
  });

  it('blocks a write through a symlink that escapes the worktree', () => {
    const { worktree, outside } = fixture();
    symlinkSync(outside, join(worktree, 'escape'));
    expect(__internals.guardToolCall(worktree, worktree, { toolName: 'write', input: { path: 'escape/tracked.md' } }))
      .toMatchObject({ block: true });
  });

  it.each([
    ['git -C primary', (primary: string) => `git -C ${JSON.stringify(primary)} status`],
    ['cd primary', (primary: string) => `cd ${JSON.stringify(primary)} && git status`],
  ])('blocks %s', (_name, command) => {
    const { primary, worktree } = fixture();
    expect(__internals.guardToolCall(worktree, worktree, { toolName: 'bash', input: { command: command(primary) } }))
      .toMatchObject({ block: true });
  });

  it('allows the existing absolute temp and home locations outside the primary checkout', () => {
    const { worktree } = fixture();
    for (const path of [join(tmpdir(), 'xez-allowed.txt'), join(homedir(), '.cache', 'xez-allowed.txt')]) {
      expect(__internals.guardToolCall(worktree, worktree, { toolName: 'write', input: { path } })).toBeUndefined();
    }
  });

  it('fails closed when the configured worktree root cannot be resolved', () => {
    const { worktree } = fixture();
    const missing = join(worktree, 'missing-root');
    expect(__internals.guardToolCall(missing, worktree, { toolName: 'write', input: { path: 'notes.md' } }))
      .toMatchObject({ block: true });
  });

  it('registers a blocking tool_call hook using the explicit worktree-root flag', () => {
    const { primary, worktree } = fixture();
    type GuardApi = Parameters<typeof extension>[0];
    let handler: Parameters<GuardApi['on']>[1] | undefined;
    const api: GuardApi = {
      registerFlag: () => undefined,
      getFlag: () => worktree,
      on: (_event, next) => { handler = next; },
    };
    extension(api);
    expect(handler?.({ toolName: 'write', input: { path: join(primary, 'tracked.md') } }, { cwd: worktree }))
      .toMatchObject({ block: true });
  });
});
