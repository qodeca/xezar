import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * What `vitest.setup.ts` promises every case in this suite, checked against the real tool.
 *
 * #260: the app starts `gh` as background probes no test waits for, with `HOME` set to the
 * test's temporary directory. `gh` 2.100 writes a telemetry `device-id` under that HOME on every
 * invocation, so a probe still running at teardown raced `rmSync` (`ENOTEMPTY`) or recreated the
 * directory after it. `gh --version` is the cheapest invocation that writes it — no network, no
 * token — and a `gh` too old to have telemetry writes nothing, so this passes either way there.
 */
const ghAvailable = spawnSync('gh', ['--version'], { stdio: 'ignore' }).error === undefined;

describe('test sandbox', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!ghAvailable)('a gh started with a test’s temporary HOME writes nothing into it', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'xez-sandbox-gh-home-')));
    dirs.push(home);

    const run = spawnSync('gh', ['--version'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

    expect(run.status).toBe(0);
    expect(readdirSync(home, { recursive: true })).toEqual([]);
  });
});
