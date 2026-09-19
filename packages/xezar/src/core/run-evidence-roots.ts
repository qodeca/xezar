import { existsSync } from 'node:fs';
import path from 'node:path';

import { projectDataDir } from '../project-data-paths.ts';

/**
 * The task-evidence directories of ONE run, under the PRIMARY checkout.
 *
 * One producer, two consumers, and that is the point of the module: the pi
 * worktree guard's `--xezar-allowed-roots` (#652) and the OpenCode runner's
 * `external_directory` policy (#686) must agree on the same two paths, or a
 * backend silently loses a directory another backend can reach. It lives here
 * rather than beside the OpenCode policy because it is not OpenCode's — it is
 * the answer to "where does the kit write this run's evidence", asked by every
 * backend that needs an explicit grant.
 *
 * The two roots:
 *
 * - `<project>/.local/xezar/tasks/<runId>/`, where the kit writes evidence
 *   today (`.xezar/checks/lib/common.sh`, `task_evidence_dir`). Granted
 *   unconditionally: it is where the run's evidence must be creatable.
 * - the frozen historical root `<project>/.local/xezar-tasks/<runId>/`, which a
 *   run that ALREADY has a directory there keeps writing to for its whole life
 *   during the dual-read window of #665. Granted only while that directory
 *   exists (`existsSync`), matching the kit's own dual-read — `task_evidence_dir_of`
 *   uses the old root only when it is there — so a run that never had one
 *   cannot have it created through an agent's write (#690).
 *
 * Both are built from segments rather than one literal, because a packed
 * release may not carry the kit's evidence path as a shipped string
 * (`own-local-path` in the archive guard; `.local/xezar` alone is the engine's
 * own state directory and is fine).
 *
 * Exactly one run id and only these two roots: a sibling run's evidence, the
 * rest of `.local/xezar/` (worktrees, tmp, cache, runs) and the project root
 * stay outside, so a grant is never wider than the run that earned it.
 */

/** Run ids are uuids; nothing else may become a path segment of an allowed
 *  root. The run store creates a run's id with `randomUUID()` (`runs/store.ts`),
 *  so the guard accepts exactly that shape. A broad identifier class instead
 *  admits a bare name such as `README` — a directory the engine could not have
 *  named itself — and `.`/`..` are then refused only by a separate check; the
 *  uuid shape refuses every dot segment, every separator and every wildcard by
 *  construction. An absent id is refused too, so a caller that cannot name the
 *  run grants nothing instead of something wider. */
function safeRunId(id: string | undefined): id is string {
  return (
    id !== undefined &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)
  );
}

export function runEvidenceRoots(projectRoot: string, runId: string | undefined): string[] {
  if (!safeRunId(runId)) return [];
  const frozen = path.join(projectRoot, '.local', 'xezar-tasks', runId);
  return [
    path.join(projectDataDir(projectRoot), 'tasks', runId),
    ...(existsSync(frozen) ? [frozen] : []),
  ];
}
