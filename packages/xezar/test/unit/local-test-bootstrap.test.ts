import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
const root = resolve(import.meta.dirname, '../../../..');
test('project-local temporary fixtures cannot discover or mutate their parent Git repository', () => {
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const result = JSON.parse(execFileSync(process.execPath, [
    '--import', resolve(root, 'scripts/test-local-state.mjs'), '--input-type=module', '-e', `
      import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { execFileSync, spawnSync } from 'node:child_process';
      const fixture = mkdtempSync(join(tmpdir(), 'git-boundary-'));
      try {
        const absent = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: fixture });
        execFileSync('git', ['init', '-q'], { cwd: fixture });
        const present = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fixture, encoding: 'utf8' }).trim();
        console.log(JSON.stringify({ scratch: tmpdir(), absent: absent.status, ownRepo: present === realpathSync(fixture) }));
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    `,
  ], { cwd: root, encoding: 'utf8' }));
  assert.equal(result.scratch, resolve(root, '.local/test-tmp'));
  assert.notEqual(result.absent, 0, 'a non-repository fixture must not discover the parent checkout');
  assert.equal(result.ownRepo, true);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }), before);
});
