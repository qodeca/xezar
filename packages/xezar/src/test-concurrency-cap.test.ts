import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TEST_MAX_WORKERS, vitestMaxWorkers } from '../../../scripts/test-concurrency.mjs';
import { REPO_ROOT } from './mcp/audit-source-scan.testkit.ts';

/**
 * The repository's test parallelism cap, `min(4, availableParallelism() - 1)`, is a guarantee, not
 * a tuning knob (AGENTS.md § Validation): without it several concurrent gate runs starved each
 * other. It is also a deliberate no-op on CI's small runners, so removing it is green on every CI
 * run – which is why these cases pin the wiring itself rather than any timing. One case per place
 * the cap must reach: every vitest config (root and per package) and both node:test suites.
 */
describe('the test parallelism cap', () => {
  it('is min(4, availableParallelism() - 1), never below one', () => {
    expect(TEST_MAX_WORKERS).toBe(Math.max(1, Math.min(4, availableParallelism() - 1)));
  });

  it('steps aside in a vitest config when the command line names --maxWorkers, in every spelling', () => {
    expect(vitestMaxWorkers([])).toBe(TEST_MAX_WORKERS);
    expect(vitestMaxWorkers(['node', 'vitest', 'run', 'src/x.test.ts'])).toBe(TEST_MAX_WORKERS);
    for (const flag of [['--maxWorkers=8'], ['--maxWorkers', '8'], ['--max-workers=8'], ['--max-workers', '8']]) {
      expect(vitestMaxWorkers(['node', 'vitest', 'run', ...flag])).toBeUndefined();
    }
  });

  // Every vitest config the root names as a project, plus the root itself. A package config is ALSO
  // a root config for `npm test -w <pkg>`, which the root cap never reaches.
  const configs = [
    'vitest.config.ts',
    'packages/xezar/vitest.config.ts',
    'packages/contract/vitest.config.ts',
    'packages/api-client/vitest.config.ts',
    'packages/web/vitest.config.ts',
  ];
  it.each(configs)('is declared by %s', async (file) => {
    const config = (await import(pathToFileURL(join(REPO_ROOT, file)).href)).default as {
      test?: { maxWorkers?: unknown };
    };
    expect(config.test?.maxWorkers).toBe(file === 'vitest.config.ts' ? TEST_MAX_WORKERS : vitestMaxWorkers());
    expect(config.test?.maxWorkers).toBeDefined();
  });

  it('reaches both node:test suites through the launcher', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/xezar/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['test:unit', 'test:package']) {
      expect(pkg.scripts[script]).toMatch(/^node \.\.\/\.\.\/scripts\/node-test\.mjs .*--test\b/);
    }
  });

  describe('the node:test launcher', () => {
    const launcher = join(REPO_ROOT, 'scripts/node-test.mjs');
    const launch = (...args: string[]) =>
      spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8' });

    it('adds --test-concurrency=<cap> in front of the caller arguments', () => {
      const run = launch('-e', 'console.log(JSON.stringify(process.execArgv))');
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual([`--test-concurrency=${TEST_MAX_WORKERS}`, '-e', expect.any(String)]);
    });

    it('leaves an explicit --test-concurrency to the caller', () => {
      const run = launch('--test-concurrency=7', '-e', 'console.log(JSON.stringify(process.execArgv))');
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(['--test-concurrency=7', '-e', expect.any(String)]);
    });

    it('exits with the run status, so a failing suite fails the script', () => {
      expect(launch('-e', 'process.exit(3)').status).toBe(3);
    });
  });
});
