// Shared test-only bootstrap. os.tmpdir() and child tools inherit the same project-local
// scratch root; individual fixtures keep owning their unique directories and cleanup.
import { createHash } from 'node:crypto';
import fs, { mkdirSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const marker = `${sep}.local${sep}xezar${sep}worktrees${sep}`;
const insideTaskWorktree = (path) => `${path}${sep}`.includes(marker);
let realRoot = root;
try { realRoot = realpathSync(root); } catch { /* an unresolvable root keeps its literal spelling */ }

// The workspace registry refuses every project root under `.local/xezar/worktrees/`
// (`shouldRegisterProject` in packages/xezar/src/workspace/projects.ts). When this checkout IS a
// xezar task worktree, in-repo scratch would inherit that ancestor and every temp repo the tests
// create would be refused (#19). Only then does scratch leave the checkout: one per-checkout
// directory under the OS temp dir, named by a hash of the checkout path so two worktrees never
// share it. A child spawned with the moved TMPDIR reuses the same directory instead of nesting.
const scratch = (() => {
  if (!insideTaskWorktree(root) && !insideTaskWorktree(realRoot)) return resolve(root, '.local/test-tmp');
  const name = `xezar-test-tmp-${createHash('sha256').update(realRoot).digest('hex').slice(0, 12)}`;
  const inherited = tmpdir();
  return basename(inherited) === name ? inherited : join(inherited, name);
})();
mkdirSync(scratch, { recursive: true, mode: 0o700 });
// Export the RESOLVED spelling. `os.tmpdir()` hands back the unresolved one (on macOS
// `/var/folders/…`, a symlink to `/private/var/folders/…`), while every child tool that reports a
// path back resolves it — `git rev-parse --show-toplevel` always answers the real path. A fixture
// built from the unresolved spelling can therefore never compare equal to what such a tool
// answers (#197). Resolving here once fixes that for every fixture instead of one at a time.
const realScratch = realpathSync(scratch);
process.env.TMPDIR = realScratch;
process.env.TMP = realScratch;
process.env.TEMP = realScratch;

// The wiring a parent xezar hands ITS agent (`RunManager.agentEnv`): the task's own handoff file,
// the machine's follow-up inbox, the task id, and the stored env-passthrough list. When a gate runs
// inside a xezar task, this process inherits all four, and every child a test spawns with
// `{ ...process.env }` inherits them again — so the dry-run mock agent, which writes to whatever
// XEZ_HANDOFF_FILE and XEZ_TODOS_FILE name, appended to the REAL task's handoff file and the REAL
// inbox once per gate run (#267: 124 identical "Follow up: verify the mock change" entries).
// Deleted here, once, rather than at each spawn site: this file is the one preload every vitest
// config and both node:test gates load, so a spawn site added tomorrow is covered without anyone
// remembering to copy a scrub. A test that needs one of these sets it inside its own body.
export const TASK_BOUND_ENV = ['XEZ_HANDOFF_FILE', 'XEZ_TODOS_FILE', 'XEZ_TASK_ID', 'XEZ_ENV_PASSTHROUGH'];
for (const name of TASK_BOUND_ENV) delete process.env[name];

// `xezar serve` asks the npm registry for a newer xezar and prints a long "is available" line when
// it finds one. Between a publish and the merge of its version bump, every test that boots serve
// and reads its output (the terminal width tests) failed for a reason in npm, not in the code.
// Off here, once, for every vitest config and both node:test gates; the check has its own tests.
process.env.XEZ_UPDATE_CHECK = '0';

// A non-repository fixture must not discover the real checkout above .local and operate on
// its Git index. Repositories explicitly initialized inside a fixture still resolve normally.
const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean);
if (!ceilings.includes(realScratch)) ceilings.push(realScratch);
process.env.GIT_CEILING_DIRECTORIES = ceilings.join(delimiter);

// Node 22 on Windows ignores rmSync's `maxRetries`: measured on 22.23.3, a folder a just-exiting
// child still holds fails at once with EBUSY, where Node 24 retries and removes it. Every test
// cleans up with those options (TEST_DIR_RM_OPTIONS), and on GitHub's Node 22 Windows runner that
// failed hundreds of tests that pass on Node 24 (#963). There, and only there, rmSync gets the
// retry its documentation promises: EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM, linear backoff.
// `packages/xezar/vitest.setup.ts` imports this file again so each vitest worker gets it too.
const RM_RETRY_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
if (process.platform === 'win32' && process.versions.node.split('.')[0] === '22' && !fs.rmSync.xezRetry) {
  const plainRmSync = fs.rmSync;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const rmSyncWithRetry = (path, options) => {
    const retries = options?.recursive ? (options.maxRetries ?? 0) : 0;
    for (let attempt = 1; ; attempt++) {
      try {
        return plainRmSync(path, options);
      } catch (err) {
        if (attempt > retries || !RM_RETRY_CODES.has(err?.code)) throw err;
        Atomics.wait(pause, 0, 0, (options.retryDelay ?? 100) * attempt);
      }
    }
  };
  rmSyncWithRetry.xezRetry = true;
  fs.rmSync = rmSyncWithRetry;
  syncBuiltinESMExports();
}
