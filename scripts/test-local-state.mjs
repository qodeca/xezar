// Shared test-only bootstrap. os.tmpdir() and child tools inherit the same project-local
// scratch root; individual fixtures keep owning their unique directories and cleanup.
import { mkdirSync, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
const scratch = resolve(import.meta.dirname, '../.local/test-tmp');
mkdirSync(scratch, { recursive: true, mode: 0o700 });
process.env.TMPDIR = scratch;
process.env.TMP = scratch;
process.env.TEMP = scratch;

// A non-repository fixture must not discover the real checkout above .local and operate on
// its Git index. Repositories explicitly initialized inside a fixture still resolve normally.
process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, realpathSync(scratch)]
  .filter(Boolean).join(delimiter);
