import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('init uses the project kit directory', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xez-kit-init-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  function init() {
    execFileSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./index.ts', import.meta.url)), 'init',
    ], { cwd: root, env: { ...process.env, XEZ_HOME: join(root, '.local/home') }, stdio: 'pipe' });
  }
  it('creates a new .xezar kit and never overwrites a customized scaffold on repeated init', () => {
    init();
    const path = join(root, '.xezar/workflows/fix-and-verify.yaml');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, '.ai/xezar/workflows'))).toBe(false);
    writeFileSync(path, 'custom workflow');
    init();
    expect(readFileSync(path, 'utf8')).toBe('custom workflow');
  });
  it('ignores a pre-.xezar directory and scaffolds the canonical kit instead', () => {
    mkdirSync(join(root, '.ai/xezar'), { recursive: true });
    writeFileSync(join(root, '.ai/xezar/config.json'), '{"custom":"preserve"}');
    init();
    expect(existsSync(join(root, '.xezar/workflows/fix-and-verify.yaml'))).toBe(true);
    expect(existsSync(join(root, '.ai/xezar/workflows'))).toBe(false);
    expect(readFileSync(join(root, '.ai/xezar/config.json'), 'utf8')).toBe('{"custom":"preserve"}');
  });
});
