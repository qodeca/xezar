/**
 * An empty PATH for every test of a file that mocks `node:child_process` (#963). Windows only.
 *
 * On Windows `platform/process-launch.ts` looks a bare program name up on PATH before it starts
 * anything, and turns an npm shim or a script into `node <script>`. Against the machine's real
 * PATH, a mocked `spawn` would then see whatever this machine has installed (`claude.cmd`
 * unwrapped here, a plain `claude` there). With PATH empty nothing is found, every name reaches
 * the mock exactly as the code under test wrote it, and the results are the same on every
 * machine.
 *
 * Linux and macOS never search, so there is nothing to pin – and PATH is left alone there on
 * purpose: several of these files also start real `#!/usr/bin/env node` stubs, which need PATH to
 * find node. On Windows those stubs start through `process.execPath` and need no PATH.
 *
 * Call once at the top of the file. The value is put back after each test.
 */
import { afterEach, beforeEach } from 'vitest';

export function useEmptyPath(): void {
  if (process.platform !== 'win32') return;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PATH;
    // One assignment is enough: process.env on Windows ignores the name's case.
    process.env.PATH = '';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  });
}
