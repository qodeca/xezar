import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { ProjectContexts } from './project-context.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const ORPHAN = '0a1b2c3d-1111-4222-8333-444455556666';
const GOOD = {
  id: 'kept-run',
  title: 't',
  workflow: 'quick-task',
  task: 't',
  status: 'done',
  createdAt: '2026-01-01T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
};

/** The boot path: opening a project sweeps orphaned task folders only from a store that loaded
 *  every record. */
describe('opening a project skips the orphan sweep after a partial runs.json load', () => {
  let root: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'xez-ctx-prune-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.local/\n');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function openWith(runs: unknown[]): Promise<string> {
    const wt = await createWorktree(root, ORPHAN, 'main'); // clean, on its branch: reclaimable
    const dataDir = join(root, '.local', 'xezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify(runs), 'utf8');
    const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] });
    await contexts.context('p');
    await contexts.disposeAll();
    return wt.path;
  }

  it('leaves the folder alone when a record could not be read (the orphan may be that record)', async () => {
    const path = await openWith([GOOD, { ...GOOD, id: ORPHAN, status: 'unknown-status' }]);
    expect(existsSync(path)).toBe(true);
  });

  it('control: with a cleanly loaded store the same clean orphan folder is reclaimed', async () => {
    const path = await openWith([GOOD]);
    expect(existsSync(path)).toBe(false);
  });
});
