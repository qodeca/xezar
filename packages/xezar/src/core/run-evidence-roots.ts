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
 *   today (`.xezar/checks/lib/common.sh`, `task_evidence_dir`).
 * - the frozen historical root `<project>/.local/xezar-tasks/<runId>/`, which a
 *   run that already has a directory there keeps writing to for its whole life
 *   during the dual-read window of #665.
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
 *  root. `.` and `..` are refused explicitly, not as pedantry: they match the
 *  character class, and `join(root, '..')` would resolve the root to its own
 *  parent — the one input that turns a per-run grant into a grant on the tree.
 *  An absent id is refused for the same reason, so a caller that cannot name the
 *  run grants nothing instead of something wider. */
function safeRunId(id: string | undefined): id is string {
  return id !== undefined && id !== '.' && id !== '..' && /^[A-Za-z0-9._-]+$/.test(id);
}

export function runEvidenceRoots(projectRoot: string, runId: string | undefined): string[] {
  if (!safeRunId(runId)) return [];
  return [
    path.join(projectDataDir(projectRoot), 'tasks', runId),
    path.join(projectRoot, '.local', 'xezar-tasks', runId),
  ];
}
