import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEST_DIR_RM_OPTIONS } from '../test/helpers/platform.ts';
import { launchFileAsync } from './platform/process-launch.ts';

const readSetup = (): string =>
  readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'vitest.setup.ts'), 'utf8');

/**
 * The suite runs with no ambient agent-model pin (#644).
 *
 * `ANTHROPIC_MODEL` outranks every Claude settings file — `agent-config/model-settings/claude.ts`
 * reads it before any file, on purpose, because Claude Code does. xezar's own gates are run BY a
 * coding agent, and that agent's process has the variable set to whichever model it happens to be.
 * So a case that asks the host for its agent defaults answers that model instead of its fixture's,
 * and the suite's verdict depends on who ran it. That is not theory: `server/config-api.test.ts`
 * was red in 16 sealed gate attempts, 11 of them the only red gate in the run, for this reason
 * alone, and a whole-suite scan with the variable set reproduced exactly those four cases.
 *
 * `vitest.setup.ts` scrubs the variable for every worker. The first case below pins the invariant
 * that matters; the second pins the mechanism, in the shape `web/src/e2e-file-parallelism.test.ts`
 * already uses for the browser suite's worker pin — because the first case can only be red on a
 * host that actually has the variable set, which is every gate run inside an agent and no run on
 * a clean laptop. Together they fail whether or not the ambient value happens to be there.
 *
 * Scrubbing costs the product path no coverage: the case that exercises the environment branch
 * passes an explicit env OBJECT rather than touching the process (`agent-config/models.test.ts`).
 */
describe('the server suite runs with no ambient agent-model pin', () => {
  it('does not see the host ANTHROPIC_MODEL', () => {
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it('gets that from the shared setup, so a new test file inherits it', () => {
    expect(readSetup()).toMatch(/^delete process\.env\.ANTHROPIC_MODEL$/m);
  });
});

/**
 * No case starts a developer's real agent CLI by its bare name on Windows (#963).
 *
 * The platform layer finds npm's `.cmd` shims – how codex, opencode and pi install – so a case
 * reaching a default agent name used to start the real CLI in its own folder, where it outlived
 * the case and the folder could not be deleted (EPERM). `vitest.setup.ts` keeps `.cmd`/`.bat` out
 * of PATHEXT for the whole suite. The first case pins the behaviour, the second the mechanism.
 */
describe('the server suite finds no command shim by bare name on Windows', () => {
  it.runIf(process.platform === 'win32')('reports a shim on PATH as missing (ENOENT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xez-no-shim-'));
    try {
      writeFileSync(join(dir, 'xez-guard-agent.cmd'), '@echo off\r\necho started\r\n');
      const env = { ...process.env, PATH: dir };

      await expect(launchFileAsync('xez-guard-agent', [], { encoding: 'utf8', env })).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      rmSync(dir, TEST_DIR_RM_OPTIONS);
    }
  });

  it('gets that from the shared setup, so a new test file inherits it', () => {
    expect(readSetup()).toMatch(/^if \(process\.platform === 'win32'\) process\.env\.PATHEXT = '\.COM;\.EXE'$/m);
  });
});
