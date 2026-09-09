// Shared test-only bootstrap. os.tmpdir() and child tools inherit the same project-local
// scratch root; individual fixtures keep owning their unique directories and cleanup.
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
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
process.env.TMPDIR = scratch;
process.env.TMP = scratch;
process.env.TEMP = scratch;

// A non-repository fixture must not discover the real checkout above .local and operate on
// its Git index. Repositories explicitly initialized inside a fixture still resolve normally.
const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean);
const realScratch = realpathSync(scratch);
if (!ceilings.includes(realScratch)) ceilings.push(realScratch);
process.env.GIT_CEILING_DIRECTORIES = ceilings.join(delimiter);
